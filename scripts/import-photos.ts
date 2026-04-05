/**
 * iCloud写真「領収書」アルバムからレシート画像を取り込み、
 * Receipt Scanner APIにアップロードするスクリプト。
 *
 * Mac miniでcron実行を想定。
 *
 * Usage:
 *   npx tsx scripts/import-photos.ts
 *   npx tsx scripts/import-photos.ts --dry-run
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// ── Config ──────────────────────────────────────────

const PHOTOS_DB_PATH = path.join(
  os.homedir(),
  "Pictures/Photos Library.photoslibrary/database/Photos.sqlite"
);
const PHOTOS_ORIGINALS = path.join(
  os.homedir(),
  "Pictures/Photos Library.photoslibrary/originals"
);
const TRACKING_FILE = path.join(
  os.homedir(),
  ".config/receipt-scanner/processed-photos.json"
);
const API_BASE = process.env.RECEIPT_SCANNER_URL || "http://localhost:3000";
const ALBUM_NAME = "領収書";

// macOS Core Data timestamp epoch (2001-01-01)
const MACOS_EPOCH_OFFSET = 978307200;

const DRY_RUN = process.argv.includes("--dry-run");

// ── Types ───────────────────────────────────────────

interface PhotoAsset {
  pk: number;
  uuid: string;
  filename: string;
  directory: string;
  dateCreated: number; // macOS timestamp
  kind: number;
}

interface ProcessedRecord {
  uuid: string;
  filename: string;
  processedAt: string;
  status: "success" | "error";
  transactionId?: string;
  error?: string;
}

interface TrackingData {
  lastRun: string;
  totalProcessed: number;
  photos: ProcessedRecord[];
}

// ── Tracking ────────────────────────────────────────

function loadTracking(): TrackingData {
  try {
    const raw = fs.readFileSync(TRACKING_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastRun: "", totalProcessed: 0, photos: [] };
  }
}

function saveTracking(data: TrackingData) {
  const dir = path.dirname(TRACKING_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

// ── Photos DB ───────────────────────────────────────

function getAlbumPhotos(): PhotoAsset[] {
  if (!fs.existsSync(PHOTOS_DB_PATH)) {
    console.error(`Photos DB not found: ${PHOTOS_DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(PHOTOS_DB_PATH, { readonly: true, timeout: 5000 });

  // Find the album
  const album = db
    .prepare("SELECT Z_PK FROM ZGENERICALBUM WHERE ZTITLE = ?")
    .get(ALBUM_NAME) as { Z_PK: number } | undefined;

  if (!album) {
    console.error(`Album "${ALBUM_NAME}" not found`);
    db.close();
    process.exit(1);
  }

  // Get the junction table column names dynamically
  // The junction table name follows Z_{N}ASSETS pattern where N varies
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Z_%ASSETS'"
    )
    .all() as { name: string }[];

  const junctionTable = tables.find((t) => t.name.match(/^Z_\d+ASSETS$/));
  if (!junctionTable) {
    console.error("Could not find junction table for albums/assets");
    db.close();
    process.exit(1);
  }

  // Get column names of the junction table
  const columns = db.pragma(`table_info(${junctionTable.name})`) as {
    name: string;
  }[];
  const albumCol = columns.find((c) => c.name.includes("ALBUMS"))?.name;
  const assetCol = columns.find((c) => c.name.includes("ASSETS"))?.name;

  if (!albumCol || !assetCol) {
    console.error("Could not determine junction table columns");
    db.close();
    process.exit(1);
  }

  const query = `
    SELECT
      a.Z_PK as pk,
      a.ZUUID as uuid,
      a.ZFILENAME as filename,
      a.ZDIRECTORY as directory,
      a.ZDATECREATED as dateCreated,
      a.ZKIND as kind
    FROM ZASSET a
    INNER JOIN ${junctionTable.name} rel ON a.Z_PK = rel.${assetCol}
    WHERE rel.${albumCol} = ?
    AND a.ZTRASHEDSTATE = 0
    ORDER BY a.ZDATECREATED DESC
  `;

  const photos = db.prepare(query).all(album.Z_PK) as PhotoAsset[];
  db.close();

  return photos;
}

function getFilePath(asset: PhotoAsset): string {
  return path.join(PHOTOS_ORIGINALS, asset.directory, asset.filename);
}

function macosTimestampToDate(ts: number): Date {
  return new Date((ts + MACOS_EPOCH_OFFSET) * 1000);
}

// ── Upload ──────────────────────────────────────────

async function uploadPhoto(
  filePath: string
): Promise<{ transactionId: string }> {
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBuffer], { type: "image/jpeg" }),
    filename
  );

  const res = await fetch(`${API_BASE}/api/receipts/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Upload failed (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return { transactionId: data.transaction.id };
}

// ── Main ────────────────────────────────────────────

async function main() {
  console.log(`\n📷 Receipt Scanner - iCloud Photos Import`);
  console.log(`Album: ${ALBUM_NAME}`);
  console.log(`API: ${API_BASE}`);
  if (DRY_RUN) console.log(`MODE: DRY RUN\n`);

  // Get all photos in album
  const photos = getAlbumPhotos();
  console.log(`Found ${photos.length} photos in album`);

  // Load tracking
  const tracking = loadTracking();
  const processedUuids = new Set(tracking.photos.map((p) => p.uuid));

  // Filter unprocessed
  const unprocessed = photos.filter((p) => !processedUuids.has(p.uuid));
  console.log(`Unprocessed: ${unprocessed.length}\n`);

  if (unprocessed.length === 0) {
    console.log("Nothing to process.");
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  for (const photo of unprocessed) {
    const filePath = getFilePath(photo);
    const date = macosTimestampToDate(photo.dateCreated);

    console.log(
      `Processing: ${photo.filename} (${date.toISOString().slice(0, 10)})`
    );

    // Check if file exists locally (may not be downloaded from iCloud)
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠ File not available locally (iCloud only), skipping`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would upload: ${filePath}`);
      continue;
    }

    try {
      const result = await uploadPhoto(filePath);
      tracking.photos.push({
        uuid: photo.uuid,
        filename: photo.filename,
        processedAt: new Date().toISOString(),
        status: "success",
        transactionId: result.transactionId,
      });
      successCount++;
      console.log(`  ✓ Uploaded (tx: ${result.transactionId})`);
    } catch (error) {
      tracking.photos.push({
        uuid: photo.uuid,
        filename: photo.filename,
        processedAt: new Date().toISOString(),
        status: "error",
        error: String(error),
      });
      errorCount++;
      console.log(`  ✗ Error: ${error}`);
    }
  }

  // Save tracking
  tracking.lastRun = new Date().toISOString();
  tracking.totalProcessed += successCount;
  saveTracking(tracking);

  console.log(`\nDone: ${successCount} success, ${errorCount} errors`);
}

main().catch(console.error);

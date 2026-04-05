import vendorData from "../../../vendor_db.json";

const vendorDb: Record<string, string> = vendorData;

export function lookupInvoiceNumber(vendor: string): string | null {
  // Exact match
  if (vendorDb[vendor]) return vendorDb[vendor];

  // Partial match
  const vendorLower = vendor.toLowerCase();
  for (const [key, value] of Object.entries(vendorDb)) {
    if (
      key.toLowerCase().includes(vendorLower) ||
      vendorLower.includes(key.toLowerCase())
    ) {
      return value;
    }
  }

  return null;
}

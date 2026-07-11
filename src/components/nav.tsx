"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "経費" },
  { href: "/billing", label: "請求" },
  { href: "/upload", label: "撮影" },
  { href: "/settings", label: "設定" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((l) => (
        <a
          key={l.href}
          href={l.href}
          className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
            pathname?.startsWith(l.href)
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          {l.label}
        </a>
      ))}
    </nav>
  );
}

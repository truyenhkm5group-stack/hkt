"use client";

import { useEffect } from "react";

export function PrintButton({ auto }: { auto: boolean }) {
  useEffect(() => {
    if (auto) setTimeout(() => window.print(), 400);
  }, [auto]);
  return (
    <button type="button" onClick={() => window.print()} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white print:hidden">
      In / Lưu PDF
    </button>
  );
}

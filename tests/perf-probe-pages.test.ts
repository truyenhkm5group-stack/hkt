/**
 * perf-probe đo /orders và /shipments bằng ĐÚNG tham số trang dựng (số nền Phase 3, 23/10/2026): tuỳ chọn `parseListParams` trong probe
 * phải trùng từng chữ với page.tsx (khác tên hằng `ord.` / `shp.` của import động). Lệch ⇒ probe đo một truy vấn trang không chạy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/,\s*\}/g, " }").replace(/\b(ord|shp)\./g, "").trim();

/** Đối tượng tuỳ chọn (chuỗi `{ … }`) của lời gọi `parseListParams(<đối số đầu>, { … })` đầu tiên sau `anchor`. */
function optionsAfter(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `không thấy «${anchor}»`);
  const open = src.indexOf("{", src.indexOf(",", at));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("ngoặc không khép");
}

export function testPerfProbePages() {
  const probe = readFileSync("scripts/perf-probe.ts", "utf8");
  const pages: [string, string, string][] = [
    ["app/(dashboard)/orders/page.tsx", "const orderParams = lp.parseListParams(", "/orders"],
    ["app/(dashboard)/shipments/page.tsx", "const shipmentParams = lp.parseListParams(", "/shipments"],
  ];
  for (const [file, probeAnchor, route] of pages) {
    const page = readFileSync(file, "utf8");
    assert.equal(norm(optionsAfter(probe, probeAnchor)), norm(optionsAfter(page, "const params = parseListParams(")), `${route}: probe dùng đúng tham số của ${file}`);
    assert.match(probe, new RegExp(`await timed\\("${route}", "list(Orders|Shipments)"`), `${route}: đo hàm danh sách`);
  }
  console.log("  ✓ perf-probe /orders · /shipments: tham số danh sách trùng page.tsx từng chữ");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { parseVtpOrderList, sheetMatrix } from "@/lib/integrations/viettelpost/statement";

/**
 * ═══════════ THƯ VIỆN ĐỌC EXCEL: BẢN ĐÃ VÁ, VÀ ĐƯỜNG ĐỌC THẬT VẪN ĐÚNG ═══════════
 *
 * `xlsx` trên npm dừng ở 0.18.5 — dính CVE-2023-30533 (prototype pollution khi ĐỌC tệp, vá ở
 * 0.19.3) và CVE-2024-22363 (ReDoS, vá ở 0.20.2). SheetJS không phát hành bản vá lên npm nữa, chỉ
 * trên CDN của họ, nên phụ thuộc trỏ thẳng tarball `cdn.sheetjs.com` (lockfile giữ `integrity`).
 * ERP đọc tệp từ webhook Gmail (bảng kê VTP) và tệp người dùng tải lên — đúng bề mặt của hai lỗi.
 *
 * Khoá hai điều:
 *  1. Không ai lặng lẽ kéo thư viện về bản npm cũ (một lần `npm i xlsx` là đủ).
 *  2. Đường đọc THẬT (`XLSX.read` trên BỘ ĐỆM .xlsx, không phải sheet dựng trong bộ nhớ) vẫn tính lại
 *     vùng dữ liệu khi tệp khai `<dimension>` sai (AGENTS.md mục 3.8) trên bản mới.
 */

type CfbEntry = { content: Uint8Array };
type CfbApi = {
  read(data: Buffer, opts: { type: "buffer" }): unknown;
  find(cfb: unknown, path: string): CfbEntry | null;
  write(cfb: unknown, opts: { fileType: "zip"; type: "buffer" }): Buffer;
};

function versionAtLeast(v: string, min: [number, number, number]): boolean {
  const p = v.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i];
  }
  return true;
}

export function testXlsxReader() {
  // ── 1. Bản đã vá, từ nguồn đã vá ──
  assert.ok(versionAtLeast(XLSX.version, [0, 20, 2]), `xlsx ${XLSX.version} còn dính CVE-2023-30533 / CVE-2024-22363 — cần ≥ 0.20.2 từ cdn.sheetjs.com`);
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies.xlsx, /^https:\/\/cdn\.sheetjs\.com\/xlsx-\d+\.\d+\.\d+\/xlsx-\d+\.\d+\.\d+\.tgz$/, "xlsx phải trỏ tarball chính thức của SheetJS — bản npm dừng ở 0.18.5 có lỗ hổng");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { resolved?: string; integrity?: string }> };
  const entry = lock.packages["node_modules/xlsx"];
  assert.ok(entry?.resolved?.startsWith("https://cdn.sheetjs.com/") && entry.integrity?.startsWith("sha512-"), "lockfile phải ghim tarball CDN kèm integrity — `npm ci` kiểm băm");

  // ── 2. Đọc bộ đệm .xlsx khai <dimension> sai ──
  const header = ["STT", "Mã Vận Đơn", "Mã đơn hàng", "Trạng thái", "Tiền thu hộ", "Tổng cước", "Ngày cập nhật"];
  const rows = Array.from({ length: 30 }, (_, i) => [i + 1, `PKE${1700000000 + i}`, `PKE${1700000000 + i}`, "Giao thành công", 499000, 15741, "03/09/2026"]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), "Sheet1");
  const tot = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  // Giả lập đúng lỗi của viettelpost.vn: sửa thẻ <dimension> trong XML của sheet, nén lại.
  const CFB = XLSX.CFB as CfbApi;
  const zip = CFB.read(tot, { type: "buffer" });
  const sheet = CFB.find(zip, "/xl/worksheets/sheet1.xml");
  assert.ok(sheet, "tệp .xlsx dựng thử phải có xl/worksheets/sheet1.xml");
  const xml = Buffer.from(sheet.content).toString("utf8");
  assert.match(xml, /<dimension ref="A1:G31"\/>/, "thẻ dimension gốc");
  sheet.content = Buffer.from(xml.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:G3"/>'), "utf8");
  const sai = CFB.write(zip, { fileType: "zip", type: "buffer" });

  const tin = XLSX.read(sai, { type: "buffer" });
  assert.equal(XLSX.utils.sheet_to_json(tin.Sheets[tin.SheetNames[0]], { header: 1 }).length, 3, "đọc theo khai báo sai chỉ ra 3 dòng — chứng minh tệp thử thật sự mang lỗi");
  assert.equal(sheetMatrix(sai, false, true).length, 31, "sheetMatrix (qua expandSheetRange) phải đọc đủ 31 dòng trên bản thư viện mới");
  const ds = parseVtpOrderList(sai);
  assert.equal(ds.length, 30, "parseVtpOrderList đọc đủ 30 vận đơn từ tệp khai vùng sai");

  // Đọc tệp không làm bẩn Object.prototype (lớp lỗi của CVE-2023-30533).
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "t"), false);
  console.log(`✓ xlsx ${XLSX.version} (cdn.sheetjs.com, đã vá 2 CVE) · đọc bộ đệm .xlsx khai <dimension> sai vẫn ra đủ dòng`);
}

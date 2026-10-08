/**
 * ═══════════ TRANG CHI TIẾT ERP ĐUÔI DÀI (Commercial Sweep — kiểm 26 trang động P2/P3, 09/10/2026) ═══════════
 *
 * Lượt kiểm đọc mã: 0 rò tổ chức, mọi trang qua getDb() của phiên + cổng quyền. Phần SAFE còn lại khoá ở đây:
 *  1. «%» lẻ trên đường dẫn (`/settings/pages/50%-off`) từng làm `decodeURIComponent` ném ⇒ lỗi 500 ở 4 trang cài đặt; nay
 *     `decodeRouteParam` không bao giờ ném, và không trang động nào gọi thẳng `decodeURIComponent(` trên tham số nữa.
 *  2. Hồ sơ khách sỉ in mã thô của Google (`CLOSED_TEMPORARILY`), loại thông tin (`PHONE`), khoá trường (`businessName, zaloUrl`),
 *     và «0 đánh giá» khi Google không trả số đánh giá.
 *  3. Tiền ở phiếu việc hiện trường tự định dạng thay vì `formatVND`.
 *  4. Phiếu sản xuất (màu × size) tràn ngang cả trang ở 390 px; đầu trang ý tưởng / topic sản xuất không xuống dòng.
 *  5. Lượt nhập VTP không đọc được tệp in chín ô «0» chưa từng được đo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeRouteParam } from "@/lib/route-param";
import { BUSINESS_STATUS_LABEL, ENRICHMENT_KIND_LABEL, LEAD_FIELD_LABEL } from "@/lib/wholesale/constants";

const doc = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

export function testErpDetailTail() {
  // 1. Tham số đường dẫn.
  assert.equal(decodeRouteParam("50%-off"), "50%-off", "«%» lẻ ⇒ giữ nguyên chuỗi, không ném");
  assert.equal(decodeRouteParam("%E0%A4%A"), "%E0%A4%A");
  assert.equal(decodeRouteParam("a%20b"), "a b");
  assert.equal(decodeRouteParam("don-hang"), "don-hang");
  for (const f of [
    "app/(dashboard)/settings/workflows/[id]/page.tsx",
    "app/(dashboard)/settings/pages/[id]/page.tsx",
    "app/(dashboard)/settings/pages/[id]/builder/page.tsx",
    "app/(dashboard)/settings/templates/[key]/page.tsx",
  ]) {
    const src = doc(f);
    assert.ok(!src.includes("decodeURIComponent("), `${f}: decodeURIComponent ném URIError với «%» lẻ ⇒ 500 — dùng decodeRouteParam`);
    assert.ok(src.includes("decodeRouteParam("), `${f}: phải giải mã tham số qua decodeRouteParam`);
  }

  // 2. Khách sỉ.
  for (const k of ["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"]) assert.ok(BUSINESS_STATUS_LABEL[k], `thiếu tên cho ${k}`);
  for (const k of ["PHONE", "EMAIL", "FACEBOOK", "ZALO", "CONTACT_PAGE", "DESCRIPTION"]) assert.ok(ENRICHMENT_KIND_LABEL[k], `thiếu tên cho ${k}`);
  // Mọi khoá mà lib/wholesale/leads.ts có thể ghi vào staffEditedFields đều có tên.
  const leads = readFileSync("lib/wholesale/leads.ts", "utf8");
  const khoa = [...leads.matchAll(/set\("([a-zA-Z]+)"|changed\.push\("([a-zA-Z]+)"\)/g)].map((m) => m[1] ?? m[2]);
  assert.ok(khoa.length >= 5, `bộ dò khoá trường sửa tay mù — mới thấy ${khoa.length}`);
  for (const k of khoa) assert.ok(LEAD_FIELD_LABEL[k], `LEAD_FIELD_LABEL thiếu «${k}» — trang khách sỉ sẽ in khoá thô`);
  const lead = doc("app/(dashboard)/wholesale/leads/[id]/page.tsx");
  assert.ok(!lead.includes("{e.kind}</span>"), "loại thông tin website phải qua ENRICHMENT_KIND_LABEL");
  assert.ok(!lead.includes("v.businessStatus ?? \"—\""), "trạng thái Google phải qua BUSINESS_STATUS_LABEL");
  assert.ok(lead.includes("LEAD_FIELD_LABEL[f]"), "ô nhân viên đã sửa phải in tên tiếng Việt");
  assert.ok(!lead.includes("reviewCount ?? 0"), "không có số đánh giá ⇒ không in «0 đánh giá»");

  // 3. Tiền.
  assert.ok(!doc("components/field-jobs/field-job-forms.tsx").includes('toLocaleString("vi-VN")} ₫'), "tiền phiếu việc qua formatVND");

  // 4. Bố cục hẹp.
  const sheet = doc("components/production-sheet.tsx");
  const khung = sheet.indexOf('<div className="overflow-x-auto print:overflow-visible">');
  assert.ok(khung >= 0 && khung < sheet.indexOf("<table"), "phiếu sản xuất: bảng màu × size nằm trong khung cuộn ngang");
  for (const f of ["app/(dashboard)/ideas/[id]/page.tsx", "app/(dashboard)/production/topics/[id]/page.tsx"]) {
    assert.ok(doc(f).includes('<div className="flex flex-wrap items-center gap-2">'), `${f}: cụm nút đầu trang phải xuống dòng ở 390 px`);
  }

  // 5. Lượt nhập VTP hỏng.
  const nhap = doc("app/(dashboard)/import-vtp/[batchId]/page.tsx");
  const loi = nhap.indexOf('b.kind === "ERROR" ?');
  assert.ok(loi >= 0 && loi < nhap.indexOf('nhan="Dòng đọc được"'), "tệp không đọc được ⇒ không in chín ô đếm chưa đo");

  console.log("  ✓ trang chi tiết ERP đuôi dài: «%» lẻ không còn 500 ở 4 trang cài đặt · khách sỉ không in mã Google / khoá trường / «0 đánh giá» · tiền qua formatVND · phiếu sản xuất cuộn ngang, đầu trang xuống dòng · lượt nhập VTP hỏng không in 9 ô 0");
}

/**
 * ═══════════ ĐIỀU KHIỂN CÓ TÊN, TRANG CÓ TIÊU ĐỀ, MÀN HẸP KHÔNG TRÀN (Commercial Sweep 08/10/2026, PR G) ═══════════
 *
 * Harness quét 163 route bằng trình duyệt thật (1366 px) và 23 route ở 390 px đo được:
 *  · 11 trang «thiếu h1» — gốc chung là màn «Không tìm thấy dữ liệu» của dashboard dùng `h2` (trang dành cho cửa hàng tự tạo đơn
 *    mở ở tổ chức nhà rơi vào đây), trình đọc màn hình không biết đang ở trang nào;
 *  · `/work/settings`: 24 công tắc và 19 ô số trong bảng không có tên; `/alerts`: 11 ô số có `Label` không nối `htmlFor`;
 *    `/inventory/shortage`: 7 nút sao chép chỉ có biểu tượng;
 *  · `/payroll` tràn ngang ở 390 px vì cụm nút đầu trang (418 px) không xuống dòng.
 * Khoá ở mức mã nguồn để lần sửa sau không mất lại.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(f, "utf8");

/** Mọi thẻ `<Tag …/>` tự đóng trong tệp phải mang `aria-label`. */
function selfClosingTagsHaveAriaLabel(file: string, tag: string): string[] {
  const src = read(file);
  const bad: string[] = [];
  let at = src.indexOf(`<${tag}`);
  while (at >= 0) {
    const end = src.indexOf("/>", at);
    const body = src.slice(at, end);
    if (!/aria-label=/.test(body)) bad.push(`${file}: <${tag} ở vị trí ${at} không có aria-label`);
    at = src.indexOf(`<${tag}`, end);
  }
  return bad;
}

export function testErpA11y() {
  // 1. Màn «không tìm thấy» là nội dung chính ⇒ h1.
  const nf = read("app/(dashboard)/not-found.tsx");
  assert.match(nf, /<h1[\s>]/, "màn «Không tìm thấy dữ liệu» phải có h1");
  assert.doesNotMatch(nf, /<h2[\s>]/, "màn «Không tìm thấy dữ liệu» không dùng h2 làm tiêu đề trang");

  // 2. /payroll: cụm nút đầu trang xuống dòng ở màn hẹp.
  const payroll = read("app/(dashboard)/payroll/page.tsx");
  const actions = payroll.slice(payroll.indexOf("actions={"), payroll.indexOf("actions={") + 120);
  assert.match(actions, /flex-wrap/, "/payroll: cụm nút đầu trang phải flex-wrap — 390 px từng tràn ngang 40 px");

  // 3. /alerts: mọi ô số nối với nhãn (id ↔ htmlFor), id không trùng.
  for (const f of ["app/(dashboard)/alerts/alerts-actions.tsx", "app/(dashboard)/alerts/marketing-digest-form.tsx"]) {
    const src = read(f);
    assert.doesNotMatch(src, /<Input type="number"/, `${f}: còn ô số chưa có id (chưa nối nhãn)`);
    const ids = [...src.matchAll(/<Input id="([^"]+)" type="number"/g)].map((m) => m[1]);
    assert.ok(ids.length > 0, `${f}: không thấy ô số nào đã nối nhãn`);
    assert.equal(new Set(ids).size, ids.length, `${f}: id ô nhập bị trùng`);
    for (const id of ids) assert.ok(src.includes(`htmlFor="${id}"`), `${f}: ô #${id} không có Label htmlFor tương ứng`);
  }

  // 4. /work/settings: công tắc + ô số trong bảng có tên.
  const bad = [
    ...selfClosingTagsHaveAriaLabel("app/(dashboard)/work/settings/staffing-panel.tsx", "Switch"),
    ...selfClosingTagsHaveAriaLabel("app/(dashboard)/work/settings/panels.tsx", "Switch"),
  ];
  assert.deepEqual(bad, [], `công tắc không có tên cho trình đọc màn hình: ${bad.join(" · ")}`);
  assert.match(read("app/(dashboard)/work/settings/logistics-panel.tsx"), /aria-label=\{`\$\{row\.stageLabel\} · \$\{level\} \(giờ\)`\}/, "ô ngưỡng giờ theo chặng phải có tên «chặng · mức (giờ)»");
  assert.match(read("app/(dashboard)/work/settings/targets-panel.tsx"), /htmlFor="dich-hieu-luc-tu"[\s\S]{0,80}id="dich-hieu-luc-tu"/, "ô «Có hiệu lực từ» phải nối nhãn");

  // 5. /inventory/shortage: nút sao chép chỉ có biểu tượng phải có tên.
  assert.match(read("app/(dashboard)/inventory/shortage/pending-matrix-section.tsx"), /aria-label=\{`Sao chép bảng /, "nút sao chép bảng phải có aria-label");

  console.log("  ✓ ERP a11y: màn «không tìm thấy» có h1 · /payroll không tràn 390 px · ô số /alerts nối nhãn · công tắc + ô ngưỡng /work/settings có tên · nút sao chép có tên");
}

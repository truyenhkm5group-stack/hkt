import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ═══════════ HAI KHUNG CẤU HÌNH TRÊN MỘT TRANG, HAI NÚT LƯU PHẢI KHÁC TÊN ═══════════
 *
 * Sự cố 24/09/2026: chủ shop dán webhook nhóm Kho vào khung "Cấu hình cảnh báo" rồi bấm nút
 * "Lưu cấu hình" — nút của khung "Bản tin marketing" ngay bên dưới. Nhật ký: hai lượt lưu
 * `marketing.alerts`, `alerts.config` không đổi từ 10/09, webhook mất khi trang tải lại, không
 * có gì báo. Nút của khung cảnh báo khi ấy chỉ ghi "Lưu", lẫn giữa năm nút "Gửi thử".
 *
 * Bài này canh MÃ NGUỒN (không dựng trình duyệt): mỗi nút mang tên khung của nó, và khung cảnh báo
 * phải báo thay đổi chưa lưu + hỏi lại trước khi rời trang.
 */
export function testAlertsConfigForm() {
  const goc = path.resolve(__dirname, "..");
  const canhBao = readFileSync(path.join(goc, "app/(dashboard)/alerts/alerts-actions.tsx"), "utf8");
  const marketing = readFileSync(path.join(goc, "app/(dashboard)/alerts/marketing-digest-form.tsx"), "utf8");

  assert.ok(canhBao.includes("Lưu cấu hình cảnh báo"), "nút lưu khung cảnh báo phải mang tên khung");
  assert.ok(marketing.includes("Lưu bản tin marketing"), "nút lưu khung marketing phải mang tên khung");
  assert.ok(!/>\s*Lưu cấu hình\s*</.test(marketing), "khung marketing không được còn nút trần 'Lưu cấu hình' — trùng nghĩa với khung cảnh báo");
  const dau = canhBao.indexOf("export function AlertConfigForm(");
  const khung = canhBao.slice(dau, canhBao.indexOf("\n}\n", dau));
  assert.ok(dau >= 0 && khung.length > 500, "phải cắt được thân AlertConfigForm");
  assert.ok(!/\/>\}\s*Lưu\s*\n/.test(khung), "khung cảnh báo không được còn nút trần 'Lưu'");
  assert.ok(canhBao.includes("CHƯA LƯU"), "khung cảnh báo phải báo khi có thay đổi chưa lưu");
  assert.ok(canhBao.includes('addEventListener("beforeunload"'), "rời trang khi còn thay đổi chưa lưu phải được hỏi lại");
  assert.ok(canhBao.includes("Chưa lưu — bảng thiếu hàng đang gửi vào nhóm vận đơn"), "ô webhook nhóm Kho phải nói đã lưu hay chưa");
  console.log("✓ Trang Cảnh báo: hai nút lưu mang tên khung của mình · khung cảnh báo báo thay đổi chưa lưu và hỏi lại trước khi rời trang");
}

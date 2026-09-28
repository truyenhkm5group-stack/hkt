import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ALERT_CONFIG } from "@/lib/constants/alerts";
import { normalizePhoneForPancake, parseBadReportInfo, phoneRiskReasons, type PhoneReputation } from "@/lib/constants/phone-reputation";

/**
 * "Tỷ lệ hoàn" / "Cảnh báo SĐT" theo Pancake trên danh sách chờ xuất — phần THUẦN.
 * Hình dạng lấy từ phản hồi thật của `orders/bad_report_info` (phone-probe 28/09/2026), đã thay SĐT,
 * lý do và người báo bằng chuỗi giả.
 */
export function testPhoneReputation() {
  const that = {
    reports_by_phone: { "+84900000001": { order_fail: 19, order_success: 213, warning: 2 } },
    available_for_report: ["+84900000001"],
    warning_phone_number: [
      { id: "a", reason: "Lý do một\nxuống dòng", inserted_at: "2026-04-25T09:54:54", shop_id: null, phone_number: "+84900000001", page_id: "p1", reported_by: { fb_id: "f1", fb_name: "Người Báo Một" } },
      { id: "b", reason: "Lý do hai", inserted_at: "2026-01-27T06:44:37", shop_id: null, phone_number: "+84900000001", page_id: "p2", reported_by: { fb_id: "f2", fb_name: "Người Báo Hai" } },
    ],
  };
  const r = parseBadReportInfo(that);
  assert.ok(r);
  assert.equal(r.orderSuccess, 213);
  assert.equal(r.orderFail, 19);
  assert.equal(r.returnRatePct, 8, "cùng công thức POS: round(19 / 232 × 100) = 8");
  assert.equal(r.warningCount, 2);
  assert.equal(r.warnings[0].reason, "Lý do một xuống dòng", "gộp khoảng trắng để một ô bảng không vỡ dòng");
  const json = JSON.stringify(r);
  for (const cam of ["Người Báo", "fb_id", "f1", "p1", "+84900000001", "phone_number"]) {
    assert.ok(!json.includes(cam), `KHÔNG giữ danh tính người báo / SĐT trong kết quả: thấy "${cam}"`);
  }

  // Nhiều SĐT của cùng khách: POS CỘNG trước rồi mới chia.
  const hai = parseBadReportInfo({ reports_by_phone: { a: { order_fail: 1, order_success: 1 }, b: { order_fail: 0, order_success: 2 } }, warning_phone_number: [] });
  assert.equal(hai?.returnRatePct, 25, "Σ thất bại ÷ Σ tổng = 1/4 — không phải trung bình hai tỷ lệ");

  // Chưa có đơn nào ⇒ CHƯA BIẾT (POS để trống), không phải 0%.
  const trong = parseBadReportInfo({ reports_by_phone: {}, warning_phone_number: [] });
  assert.ok(trong);
  assert.equal(trong.returnRatePct, null);
  assert.equal(trong.warningCount, 0);

  // Hình dạng lạ ⇒ null — đọc hỏng mà in 0% là nói với người đóng gói rằng khách sạch.
  for (const hong of [null, undefined, "x", 1, [], {}, { reports_by_phone: "x" }, { reports_by_phone: null }]) {
    assert.equal(parseBadReportInfo(hong), null, `hình dạng lạ phải ra null: ${JSON.stringify(hong)}`);
  }

  assert.equal(normalizePhoneForPancake("+84 912 345 678"), "0912345678");
  assert.equal(normalizePhoneForPancake("0912.345.678"), "0912345678");
  assert.equal(normalizePhoneForPancake("12345"), null, "quá ngắn ⇒ không hỏi Pancake");
  assert.equal(normalizePhoneForPancake(null), null);

  // ───────── Cảnh báo đơn chờ xuất rủi ro (chủ shop chốt 28/09/2026: > 40% hoặc > 10 lần báo) ─────────
  assert.equal(DEFAULT_ALERT_CONFIG.phoneRiskReturnRatePct, 40);
  assert.equal(DEFAULT_ALERT_CONFIG.phoneRiskWarningCount, 10);
  const t = { phoneRiskReturnRatePct: 40, phoneRiskWarningCount: 10 };
  const rep = (pct: number | null, warn: number): PhoneReputation => ({ orderSuccess: 0, orderFail: 0, returnRatePct: pct, warningCount: warn, warnings: [] });
  assert.deepEqual(phoneRiskReasons(rep(40, 10), t), [], "ĐÚNG ngưỡng chưa phải VƯỢT ngưỡng — chủ shop nói '> 40%', '> 10'");
  assert.deepEqual(phoneRiskReasons(rep(41, 10), t), ["RETURN_RATE"]);
  assert.deepEqual(phoneRiskReasons(rep(40, 11), t), ["WARNINGS"]);
  assert.deepEqual(phoneRiskReasons(rep(41, 11), t), ["RETURN_RATE", "WARNINGS"], "mỗi điều kiện tự đủ để bật cảnh báo, và lý do nêu đủ cả hai");
  assert.deepEqual(phoneRiskReasons(rep(null, 0), t), [], "chưa có đơn nào trên Pancake ⇒ không kết luận rủi ro");
  assert.deepEqual(phoneRiskReasons(null, t), [], "chưa hỏi được Pancake ⇒ không kết luận gì — CHƯA BIẾT không phải an toàn, cũng không phải rủi ro");
  // So trên ĐÚNG số màn hình in (đã làm tròn như POS): 81/200 = 40,5% in "41%" ⇒ vượt; 80/199 = 40,2% in "40%" ⇒ không.
  assert.deepEqual(phoneRiskReasons(parseBadReportInfo({ reports_by_phone: { a: { order_fail: 81, order_success: 119 } } }), t), ["RETURN_RATE"]);
  assert.deepEqual(phoneRiskReasons(parseBadReportInfo({ reports_by_phone: { a: { order_fail: 80, order_success: 119 } } }), t), [], "ô in 40% thì không được gắn cảnh báo '> 40%'");
  // Nút Lưu ở trang Cảnh báo không được làm RƠI hai ô này: z.object() cắt khoá không khai báo.
  const luoc = readFileSync(path.join(path.resolve(__dirname, ".."), "lib", "actions", "alerts.ts"), "utf8");
  for (const k of ["phoneRiskReturnRatePct", "phoneRiskWarningCount"]) {
    assert.ok(new RegExp(`\\b${k}: z\\.`).test(luoc), `lược đồ lưu cấu hình cảnh báo phải khai ${k} — thiếu thì mỗi lần bấm Lưu ngưỡng lặng lẽ về mặc định`);
  }

  console.log("✓ Uy tín SĐT theo Pancake: cùng công thức POS (Σ thất bại ÷ Σ tổng) · chưa có đơn ⇒ null · không giữ danh tính người báo · cảnh báo rủi ro khi VƯỢT ngưỡng (> 40% hoặc > 10 lần báo), so trên đúng số đang in");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { collectCandidates } from "@/lib/alerts/rules";
import { DEFAULT_ALERT_CONFIG } from "@/lib/constants/alerts";
import { clearPhoneReputationCache, primePhoneReputationForTest } from "@/lib/queries/phone-reputation";
import { compareRisk, normalizePhoneForPancake, parseBadReportInfo, phoneRiskLevel, phoneRiskReasons, type PhoneReputation } from "@/lib/constants/phone-reputation";

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
  assert.equal(DEFAULT_ALERT_CONFIG.phoneRiskMinOrders, 5);
  const t = { phoneRiskReturnRatePct: 40, phoneRiskWarningCount: 10, phoneRiskMinOrders: 5 };
  // Mặc định 100 đơn kết thúc — đủ mẫu, để các ca dưới chỉ thử NGƯỠNG %.
  const rep = (pct: number | null, warn: number, finished = 100): PhoneReputation => ({ orderSuccess: finished - Math.round((finished * (pct ?? 0)) / 100), orderFail: Math.round((finished * (pct ?? 0)) / 100), returnRatePct: pct, warningCount: warn, warnings: [] });
  assert.deepEqual(phoneRiskReasons(rep(40, 10), t), [], "ĐÚNG ngưỡng chưa phải VƯỢT ngưỡng — chủ shop nói '> 40%', '> 10'");
  assert.deepEqual(phoneRiskReasons(rep(41, 10), t), ["RETURN_RATE"]);
  assert.deepEqual(phoneRiskReasons(rep(40, 11), t), ["WARNINGS"]);
  assert.deepEqual(phoneRiskReasons(rep(41, 11), t), ["RETURN_RATE", "WARNINGS"], "mỗi điều kiện tự đủ để bật cảnh báo, và lý do nêu đủ cả hai");
  assert.deepEqual(phoneRiskReasons(rep(null, 0), t), [], "chưa có đơn nào trên Pancake ⇒ không kết luận rủi ro");
  assert.deepEqual(phoneRiskReasons(null, t), [], "chưa hỏi được Pancake ⇒ không kết luận gì — CHƯA BIẾT không phải an toàn, cũng không phải rủi ro");
  // So trên ĐÚNG số màn hình in (đã làm tròn như POS): 81/200 = 40,5% in "41%" ⇒ vượt; 80/199 = 40,2% in "40%" ⇒ không.
  assert.deepEqual(phoneRiskReasons(parseBadReportInfo({ reports_by_phone: { a: { order_fail: 81, order_success: 119 } } }), t), ["RETURN_RATE"]);
  assert.deepEqual(phoneRiskReasons(parseBadReportInfo({ reports_by_phone: { a: { order_fail: 80, order_success: 119 } } }), t), [], "ô in 40% thì không được gắn cảnh báo '> 40%'");
  // Mẫu nhỏ: 1/1 thất bại là "100%" nhưng không nói gì ⇒ chưa đủ 5 đơn thì KHÔNG xét tỷ lệ.
  assert.deepEqual(phoneRiskReasons(rep(100, 0, 1), t), [], "1/1 thất bại (100%) chưa đủ mẫu — không bật cảnh báo tỷ lệ hoàn");
  assert.deepEqual(phoneRiskReasons(rep(100, 0, 4), t), [], "4 đơn vẫn dưới ngưỡng tối thiểu 5");
  assert.deepEqual(phoneRiskReasons(rep(60, 0, 5), t), ["RETURN_RATE"], "đủ 5 đơn thì xét như thường");
  assert.deepEqual(phoneRiskReasons(rep(100, 11, 1), t), ["WARNINGS"], "ngưỡng tối thiểu CHỈ áp cho tỷ lệ hoàn — số lần bị báo vẫn tự đủ");
  // ───────── Lọc "ít rủi ro" và xếp rủi ro thấp → cao (chủ shop yêu cầu 28/09/2026) ─────────
  assert.equal(phoneRiskLevel(rep(10, 0), t), "LOW");
  assert.equal(phoneRiskLevel(rep(41, 0), t), "HIGH");
  assert.equal(phoneRiskLevel(rep(null, 0), t), "NO_HISTORY", "khách chưa có đơn nào trên Pancake KHÔNG phải ít rủi ro");
  assert.equal(phoneRiskLevel(rep(0, 0, 1), t), "NO_HISTORY", "1/1 giao thành công chưa đủ mẫu — không được gọi là ít rủi ro");
  assert.equal(phoneRiskLevel(rep(100, 0, 1), t), "NO_HISTORY", "1/1 hoàn không bật cảnh báo (mẫu nhỏ) thì cũng KHÔNG được rơi vào 'ít rủi ro'");
  assert.equal(phoneRiskLevel(rep(0, 0, 5), t), "LOW", "đủ 5 đơn, không vượt ngưỡng ⇒ ít rủi ro");
  assert.equal(phoneRiskLevel(rep(null, 11), t), "HIGH", "chưa có đơn nhưng bị báo quá ngưỡng vẫn là rủi ro cao");
  assert.equal(phoneRiskLevel(null, t), "UNKNOWN", "chưa hỏi được Pancake ⇒ chưa biết, không phải ít rủi ro");
  assert.equal(phoneRiskLevel(rep(10, 0), null), "UNKNOWN", "không đọc được ngưỡng ⇒ không khẳng định ai ít rủi ro");
  const ds: [string, PhoneReputation | null][] = [["x", null], ["cao", rep(60, 2)], ["moi", rep(null, 0)], ["thap", rep(5, 0)], ["thapBao", rep(5, 3)]];
  const xep = (dir: 1 | -1, by: "RATE" | "WARNINGS" = "RATE") => [...ds].sort((a, b) => compareRisk(a[1], b[1], dir, by)).map((x) => x[0]);
  assert.deepEqual(xep(1), ["thap", "thapBao", "cao", "moi", "x"], "thấp → cao: tỷ lệ hoàn rồi số lần bị báo; chưa có lịch sử, chưa biết đứng cuối");
  assert.deepEqual(xep(-1), ["cao", "thapBao", "thap", "moi", "x"], "đảo chiều KHÔNG đưa 'chưa biết' lên đầu danh sách rủi ro cao");
  const mauNho = rep(100, 0, 1);
  assert.ok(compareRisk(mauNho, rep(60, 0), -1, "RATE", 5) > 0, "1/1 hoàn (100%) KHÔNG đứng trên 60% của 100 đơn khi xếp rủi ro cao → thấp — mẫu nhỏ xuống cuối");
  assert.deepEqual(xep(1, "WARNINGS"), ["moi", "thap", "cao", "thapBao", "x"], "xếp theo cảnh báo: khách chưa có lịch sử vẫn có số lần báo (0) nên xếp được");
  // Nút Lưu ở trang Cảnh báo không được làm RƠI các ô này: z.object() cắt khoá không khai báo.
  const luoc = readFileSync(path.join(path.resolve(__dirname, ".."), "lib", "actions", "alerts.ts"), "utf8");
  for (const k of ["phoneRiskReturnRatePct", "phoneRiskWarningCount", "phoneRiskMinOrders"]) {
    assert.ok(new RegExp(`\\b${k}: z\\.`).test(luoc), `lược đồ lưu cấu hình cảnh báo phải khai ${k} — thiếu thì mỗi lần bấm Lưu ngưỡng lặng lẽ về mặc định`);
  }

  // Luật cảnh báo CHỈ ĐỌC ĐỆM — lượt quét 10 phút/lần không bao giờ chờ / gọi Pancake; job riêng làm ấm.
  const goc = path.resolve(__dirname, "..");
  const luat = readFileSync(path.join(goc, "lib", "alerts", "rules.ts"), "utf8");
  for (const cam of ["getPancakeClient", "warmPhoneReputations", "getPhoneReputationForOrders", "badReportInfo"]) {
    assert.ok(!luat.includes(cam), `lib/alerts/rules.ts không được gọi Pancake (${cam}) — chỉ đọc đệm bằng cachedPhoneReputations`);
  }
  const lich = readFileSync(path.join(goc, "scripts", "scheduler.mjs"), "utf8");
  assert.match(lich, /\{\s*job:\s*"phone-reputation"/, "job làm ấm uy tín SĐT phải nằm trong bộ lập lịch");

  console.log("✓ Uy tín SĐT theo Pancake: cùng công thức POS (Σ thất bại ÷ Σ tổng) · chưa có đơn ⇒ null · không giữ danh tính người báo · cảnh báo rủi ro khi VƯỢT ngưỡng (> 40% hoặc > 10 lần báo), so trên đúng số đang in · tỷ lệ chỉ xét từ 5 đơn · luật cảnh báo chỉ đọc đệm");
}

/**
 * Cảnh báo "Đơn rủi ro · xin cọc" nhận thêm lý do Pancake — chạy luật cảnh báo THẬT trên CSDL kiểm thử,
 * với đệm uy tín SĐT đặt sẵn (không gọi mạng).
 */
export async function testPhoneRiskAlert(db: Db) {
  const t0 = new Date();
  await db.insert(schema.orders).values([
    { id: "prisk-1", systemId: 990001, stage: "CONFIRMED", insertedAt: t0, billFullName: "Khách bị báo nhiều", billPhone: "0911000111" },
    { id: "prisk-2", systemId: 990002, stage: "CONFIRMED", insertedAt: t0, billFullName: "Khách mẫu nhỏ", billPhone: "0911000222" },
    { id: "prisk-3", systemId: 990003, stage: "DELIVERED", insertedAt: t0, billFullName: "Đơn đã giao", billPhone: "0911000111" },
  ]);
  const bao = (orderSuccess: number, orderFail: number, warningCount: number): PhoneReputation => ({ orderSuccess, orderFail, returnRatePct: orderSuccess + orderFail ? Math.round((orderFail / (orderSuccess + orderFail)) * 100) : null, warningCount, warnings: [] });
  await primePhoneReputationForTest("0911000111", bao(213, 19, 11));
  await primePhoneReputationForTest("0911000222", bao(0, 1, 0));
  try {
    const { candidates } = await collectCandidates();
    const mot = candidates.filter((c) => c.dedupeKey === "risky-order:prisk-1");
    assert.equal(mot.length, 1, "đơn trúng lý do Pancake ra ĐÚNG MỘT cảnh báo 'Đơn rủi ro'");
    assert.equal(mot[0].kind, "RISKY_ORDER");
    assert.match(mot[0].body, /SĐT bị báo 11 lần trên Pancake/, "tin cảnh báo phải nói lý do Pancake");
    assert.ok(!candidates.some((c) => c.dedupeKey === "risky-order:prisk-2"), "1/1 thất bại chưa đủ 5 đơn — không cảnh báo");
    assert.ok(!candidates.some((c) => c.dedupeKey === "risky-order:prisk-3"), "đơn đã giao không nằm trong tập xét (chỉ đơn chưa gửi ĐVVC)");
  } finally {
    await db.delete(schema.orders).where(inArray(schema.orders.id, ["prisk-1", "prisk-2", "prisk-3"]));
    clearPhoneReputationCache();
  }
  console.log("✓ Cảnh báo 'Đơn rủi ro' nhận lý do Pancake: một đơn một việc · mẫu nhỏ không bật · chỉ đơn chưa gửi ĐVVC");
}

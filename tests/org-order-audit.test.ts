/**
 * ═══════════ ops `org-order-audit` — hội thoại có SĐT ↔ đơn ERP của MỘT tổ chức trong MỘT ngày (scripts/org-order-audit.ts) ═══════════
 *
 *  · Thuần: cửa sổ ngày theo giờ VN; ghép hội thoại ⇒ đơn bằng khoá hội thoại TRƯỚC rồi mới SĐT; khách đã có đơn trước hôm
 *    nay KHÔNG bị đếm là thiếu; đơn không ghép được hội thoại nào đi riêng; độ trễ tính từ tin khách cuối TRƯỚC đơn.
 *  · Mã nguồn: không một câu ghi; ép chỉ đọc; không giải mã bí mật kết nối; ops-vps khai thao tác (mã hoá, đọc nặng, nhánh).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditMatch, orderLagMinutes, phonesIn, quantile, vnDayWindow, type AuditOrder, type AuditThread } from "@/scripts/org-order-audit";

export function testOrgOrderAuditPure() {
  const w = vnDayWindow("2026-10-05");
  assert.equal(w.from.toISOString(), "2026-10-04T17:00:00.000Z");
  assert.equal(w.to.toISOString(), "2026-10-05T17:00:00.000Z");
  // 23:30 UTC ngày 4 = 06:30 sáng ngày 5 giờ VN.
  assert.equal(vnDayWindow(null, new Date("2026-10-04T23:30:00Z")).day, "2026-10-05");
  assert.equal(vnDayWindow("sai", new Date("2026-10-04T10:00:00Z")).day, "2026-10-04", "ngày sai dạng ⇒ hôm nay");

  assert.deepEqual(phonesIn("sđt em 0938.885.324 nhé, hoặc +84919476079"), ["0938885324", "0919476079"]);
  assert.deepEqual(phonesIn("đơn 2 túi 0,5kg giá 280.000"), []);

  const at = (hm: string) => new Date(`2026-10-05T${hm}:00+07:00`);
  const th = (id: string, conv: string | null, phone: string, msgs: string[]): AuditThread => ({ threadId: id, convId: conv, name: id, chatPhones: [{ phone, at: at(msgs[0]) }], customerAts: msgs.map(at) });
  const ord = (id: string, hm: string, phone: string, conv: string | null = null): AuditOrder => ({ id, at: at(hm), stage: "CONFIRMED", source: "Chatbot fanpage", phones: [phone], name: "", convId: conv, total: 280_000 });
  const threads = [
    th("t-conv", "c1", "0900000001", ["09:00", "09:05"]),
    th("t-phone", null, "0900000002", ["10:00"]),
    th("t-before", "c3", "0900000003", ["11:00"]),
    th("t-none", "c4", "0900000004", ["12:00"]),
  ];
  const orders = [ord("o-conv", "09:07", "0999999999", "c1"), ord("o-phone", "10:03", "0900000002"), ord("o-lone", "13:00", "0911111111")];
  const { verdicts, unmatchedOrders } = auditMatch(threads, orders, [{ id: "o-old", at: new Date("2026-10-02T10:00:00+07:00"), phones: ["0900000003"] }]);
  assert.deepEqual(verdicts.get("t-conv"), { kind: "ORDER_TODAY", orderIds: ["o-conv"], by: "CONVERSATION" }, "khoá hội thoại thắng dù SĐT đơn khác SĐT trong chat");
  assert.deepEqual(verdicts.get("t-phone"), { kind: "ORDER_TODAY", orderIds: ["o-phone"], by: "PHONE" });
  assert.equal(verdicts.get("t-before")?.kind, "ORDER_BEFORE", "khách đã có đơn trước hôm nay — không phải thiếu");
  assert.deepEqual(verdicts.get("t-none"), { kind: "NO_ORDER" });
  assert.deepEqual(unmatchedOrders.map((o) => o.id), ["o-lone"]);

  assert.equal(orderLagMinutes(at("09:07"), [at("09:00"), at("09:05"), at("09:30")]), 2, "tin khách cuối TRƯỚC đơn, không phải tin sau");
  assert.equal(orderLagMinutes(at("08:00"), [at("09:00")]), null, "không có tin trước đơn ⇒ chưa biết, không phải 0");
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5, 1, 3], 0.5), 3);

  const src = readFileSync("scripts/org-order-audit.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.(insert|update|delete)\(/.test(code) && !/\b(insert into|update \w+ set|delete from)\b/i.test(code), "script không có câu ghi nào");
  assert.ok(!/openSecrets|secretsEnc|orgConnections/.test(code), "không giải mã bí mật kết nối");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-order-audit\s+#/, "ops-vps khai lựa chọn org-order-audit");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-order-audit\b/, "kết quả MÃ HOÁ (có tên, SĐT, chữ tin)");
  assert.match(ops, /DOC_NANG="[^"]*\borg-order-audit\b/, "là thao tác ĐỌC");
  assert.match(ops, /\n\s+org-order-audit\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/org-order-audit\.ts/, "nhánh case chạy đúng script, trong ma_hoa_ket_qua");
  console.log("✓ ops org-order-audit: cửa sổ ngày VN · khoá hội thoại trước SĐT · khách có đơn cũ không bị đếm thiếu · trễ đo từ tin trước đơn · chỉ đọc, mã hoá");
}

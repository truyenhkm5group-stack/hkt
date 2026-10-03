/**
 * CHI PHÍ AI CỦA CHATBOT THEO NGÀY (02/10/2026) — `lib/sales-chatbot/cost-report.ts`. Phần thuần: chia tiền theo kênh,
 * đơn / SĐT theo ngày, chưa biết ≠ 0, khung thử + học không chia vào đơn. Không gọi mạng, không CSDL.
 */
import assert from "node:assert/strict";
import { buildChatCostDays, lastVnDays, outcomeEventsOf, type UsageCell } from "@/lib/sales-chatbot/cost-report";
import type { ChatState } from "@/lib/sales-chatbot/tools";

export function testChatCostReport() {
  // Ngày theo giờ VN: 18:00Z ngày 1 đã là ngày 2 ở Việt Nam.
  assert.deepEqual(lastVnDays(3, new Date("2026-10-01T18:00:00Z")), ["2026-10-02", "2026-10-01", "2026-09-30"]);

  const days = ["2026-10-02", "2026-10-01", "2026-09-30"];
  const channelOf = new Map([
    ["fp1", "FANPAGE"],
    ["fp2", "FANPAGE"],
    ["web1", "WEB"],
    ["test1", "TEST"],
  ]);
  const usage: UsageCell[] = [
    { day: "2026-10-02", ref: "fp1", feature: "sales_chatbot", turns: 3, costUsd: 0.002, unknownCost: 0 },
    { day: "2026-10-02", ref: "web1", feature: "sales_chatbot", turns: 1, costUsd: 0.001, unknownCost: 0 },
    // Khung thử: tiền thật, KHÔNG chia vào đơn.
    { day: "2026-10-02", ref: "test1", feature: "sales_chatbot", turns: 5, costUsd: 0.01, unknownCost: 0 },
    // Hội thoại đã mất: vẫn là tiền bán hàng đã trả.
    { day: "2026-10-02", ref: "da-xoa", feature: "sales_chatbot", turns: 1, costUsd: 0.001, unknownCost: 0 },
    // Học hội thoại: chi phí một lần, in riêng.
    { day: "2026-10-02", ref: "playbook", feature: "sales_playbook", turns: 4, costUsd: 0.02, unknownCost: 0 },
    // Model chưa có giá: CHƯA BIẾT, không phải 0.
    { day: "2026-10-01", ref: "fp2", feature: "sales_chatbot", turns: 2, costUsd: null, unknownCost: 2 },
    // Tính năng khác của tổ chức không lọt vào.
    { day: "2026-10-02", ref: null, feature: "copilot", turns: 9, costUsd: 1, unknownCost: 0 },
    // Ngoài kỳ.
    { day: "2026-09-01", ref: "fp1", feature: "sales_chatbot", turns: 1, costUsd: 5, unknownCost: 0 },
  ];
  const r = buildChatCostDays({
    dayKeys: days,
    usage,
    channelOf,
    rate: 25_000,
    events: [
      { day: "2026-10-02", kind: "ORDER", key: "o1" },
      { day: "2026-10-02", kind: "ORDER", key: "o2" },
      { day: "2026-10-02", kind: "PHONE", key: "0912345678" },
      { day: "2026-10-02", kind: "PHONE", key: "0912345678" },
      { day: "2026-10-01", kind: "PHONE", key: "0912345678" },
      { day: "2026-10-01", kind: "PHONE", key: "0987654321" },
      { day: "2026-08-01", kind: "ORDER", key: "cu" },
    ],
  });
  const [d2, d1, d0] = r.days;
  // 0.002 + 0.001 + 0.001 = 0.004 USD × 25.000 = 100 ₫.
  assert.deepEqual([d2.turns, d2.costVnd, d2.orders, d2.costPerOrder, d2.phones, d2.costPerPhone], [5, 100, 2, 50, 1, 100], JSON.stringify(d2));
  assert.equal(d2.testCostVnd, 250, "khung thử in riêng");
  assert.equal(d2.learnCostVnd, 500, "học hội thoại in riêng");
  assert.ok(d1.costVnd === null && d1.unknownCost === 2 && d1.turns === 2, `chưa định giá ⇒ —, không 0: ${JSON.stringify(d1)}`);
  assert.ok(d1.costPerPhone === null && d1.phones === 2, "tiền chưa biết ⇒ AI / SĐT cũng chưa biết");
  assert.ok(d0.turns === 0 && d0.costVnd === null && d0.costPerOrder === null && d0.orders === 0, "ngày trống: 0 lượt, chi phí —, AI / đơn —");
  // Cả kỳ: SĐT KHÔNG cộng từng ngày (0912… để lại hai ngày vẫn là một SĐT).
  assert.deepEqual([r.total.turns, r.total.costVnd, r.total.orders, r.total.phones, r.total.costPerOrder, r.total.unknownCost], [7, 100, 2, 2, 50, 2], JSON.stringify(r.total));
  assert.equal(r.total.testCostVnd, 250);

  // Sự kiện đọc từ trạng thái hội thoại: bỏ mô phỏng, bỏ đơn chưa có mã; SĐT không mốc ⇒ đếm riêng, không đoán ngày.
  const st = (s: ChatState) => s;
  const ev = outcomeEventsOf([
    { id: "a", state: st({ confirmed: { orderId: "o1", simulated: false, total: 1, at: "2026-10-01T18:30:00Z" }, customer: { id: "c1", name: "A", phone: "0912 345 678", address: "x", province: "", simulated: false, at: "2026-10-01T16:00:00Z" } }) },
    { id: "b", state: st({ confirmed: { orderId: null, simulated: true, total: 1, at: "2026-10-02T01:00:00Z" }, customer: { id: null, name: "T", phone: "0900000000", address: "x", province: "", simulated: true, at: "2026-10-02T01:00:00Z" } }) },
    { id: "c", state: st({ customer: { id: "c2", name: "B", phone: "0987654321", address: "x", province: "", simulated: false } }) },
    { id: "d", state: st({ customer: { id: "c3", name: "C", phone: "khong-phai-so", address: "x", province: "", simulated: false, at: "2026-10-02T01:00:00Z" } }) },
    // Khách mua lại trong cùng hội thoại: đơn cũ chuyển sang pastOrders — vẫn đếm.
    { id: "e", state: st({ pastOrders: [{ orderId: "o0", simulated: false, total: 1, at: "2026-09-20T03:00:00Z" }] }) },
  ]);
  assert.deepEqual(ev.events, [
    { day: "2026-10-02", kind: "ORDER", key: "o1" },
    { day: "2026-10-01", kind: "PHONE", key: "0912345678" },
    { day: "2026-09-20", kind: "ORDER", key: "o0" },
  ]);
  assert.equal(ev.phonesWithoutDate, 1, "SĐT trước khi có mốc ⇒ đếm riêng");

  console.log("✓ Chi phí AI chatbot theo ngày: tiền bán hàng tách khung thử + học hội thoại · chưa định giá ⇒ — không 0 · AI / đơn và AI / SĐT theo ngày VN · SĐT không trùng trong kỳ · bỏ mô phỏng · SĐT cũ không đoán ngày");
}

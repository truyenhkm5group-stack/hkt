/**
 * ═══ CẦU CHÌ KÊNH API TRA CỨU VIETTEL POST (lib/constants/vtp-api-breaker.ts — vtp-direct-sync (A), 26/10/2026) ═══
 *
 * Khoá:
 *  1. Thuần: chỉ «HTTP 403 + thân HTML» là kênh bị chặn (403 JSON, 500 HTML ⇒ không) · câu lỗi đã ghi nhận ra bằng cùng luật ở TS và
 *     SQL · nhịp: đóng ⇒ chạy; mở < 6 giờ ⇒ bỏ; ≥ 6 giờ ⇒ thử một kiện · chỉ bản ghi vận đơn THẬT mới đóng cầu chì.
 *  2. Đường định kỳ thật (`syncViettelPostShipments`, client giả): gặp 403 + HTML ⇒ mở cầu chì, dừng ngay, KHÔNG ghi vtp_last_error lên
 *     kiện nào · lượt kế ⇒ không hỏi kiện nào · quá 6 giờ ⇒ thử đúng MỘT kiện; trả bản ghi thật ⇒ đóng.
 *  3. Hàng đợi đối chiếu: câu lỗi kênh cũ trên kiện KHÔNG thành SYNC_ERROR (lọc lúc đọc, dòng giữ nguyên) + băng rôn · mã vận đơn THỬ
 *     của ĐVVC (123456789101112) không vào hàng đợi.
 */
import assert from "node:assert/strict";
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { BREAKER_CLOSED, BREAKER_RETRY_HOURS, breakerDecision, channelBlockMessageSql, isChannelBlockError, isChannelBlockMessage, nextBreakerState, VTP_API_BREAKER_KEY, type VtpApiBreakerState } from "@/lib/constants/vtp-api-breaker";
import { IntegrationError } from "@/lib/integrations/http";
import { setViettelPostClientForTests, type VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import { getVtpReconcileQueue } from "@/lib/queries/vtp-reconcile-queue";
import { rowsOf } from "@/lib/sql-rows";
import { getSyncState, setSyncState } from "@/lib/sync/runner";

const HTML = "<!DOCTYPE html>\n<!--[if lt IE 7]> <html class=\"no-js ie6 oldie\" lang=\"en-US\"> <![endif]-->";
const LOI_CU = `ViettelPost: HTTP 403 ${HTML}`;
const record = (orderNumber: string): VtpTrackingRecord => ({
  orderNumber, orderReference: "", status: 500, statusName: "Giao bưu tá đi phát", statusDate: new Date(), location: "", note: "", reasonCode: null, isReturning: false,
  moneyCollection: 0, moneyCollectionOrigin: null, moneyTotal: 0, moneyTotalFee: 0, moneyFeeCod: 0, productWeight: 0, service: "", expectedDelivery: "",
  receiverName: "", receiverPhone: "", receiverAddress: "", employeeName: "", employeePhone: "", journey: [], raw: {},
});

export function testVtpApiBreakerPure() {
  assert.equal(isChannelBlockError(new IntegrationError(LOI_CU, 403, false, HTML)), true);
  assert.equal(isChannelBlockError(new IntegrationError("ViettelPost: HTTP 403 Token hết hạn", 403, false, { status: 403, message: "Token hết hạn" })), false, "403 JSON là lỗi nghiệp vụ / quyền, không phải chặn kênh");
  assert.equal(isChannelBlockError(new IntegrationError("ViettelPost: API trả về HTTP 502", 502, true, HTML)), false, "5xx HTML là sự cố tạm thời");
  assert.equal(isChannelBlockMessage(LOI_CU), true);
  assert.equal(isChannelBlockMessage("Tài khoản API Viettel Post không thấy vận đơn này"), false);
  assert.throws(() => channelBlockMessageSql("x; drop"), /tên cột/);
  const t0 = new Date("2026-10-26T12:00:00Z");
  const mo: VtpApiBreakerState = { openSince: "2026-10-26T10:00:00Z", lastProbeAt: "2026-10-26T10:00:00Z", lastProbeResult: "BLOCKED" };
  assert.equal(breakerDecision(null, t0), "RUN");
  assert.equal(breakerDecision(BREAKER_CLOSED, t0), "RUN");
  assert.equal(breakerDecision(mo, t0), "SKIP", "mở 2 giờ ⇒ không hỏi");
  assert.equal(breakerDecision(mo, new Date(Date.parse(mo.lastProbeAt!) + BREAKER_RETRY_HOURS * 3_600_000)), "PROBE_ONE", "đủ 6 giờ ⇒ thử một kiện");
  assert.deepEqual(nextBreakerState(mo, { blocked: false, gotRecord: false, probed: true }, t0), { ...mo, lastProbeAt: t0.toISOString(), lastProbeResult: "JSON_EMPTY" }, "HTTP 200 rỗng chưa phải kênh sống");
  assert.deepEqual(nextBreakerState(mo, { blocked: false, gotRecord: true, probed: true }, t0), BREAKER_CLOSED, "bản ghi thật ⇒ đóng");
  assert.equal(nextBreakerState(null, { blocked: true, gotRecord: false, probed: false }, t0).openSince, t0.toISOString(), "lần đầu chặn ⇒ mở");
  assert.equal(nextBreakerState(mo, { blocked: true, gotRecord: false, probed: true }, t0).openSince, mo.openSince, "chặn tiếp ⇒ giữ mốc mở đầu");
  console.log("  ✓ thuần: chỉ 403 + HTML là chặn kênh · nhịp chạy / bỏ / thử một · chỉ bản ghi thật mới đóng");
}

export async function testVtpApiBreaker(db: Db) {
  testVtpApiBreakerPure();
  const truoc = await getSyncState<VtpApiBreakerState>(VTP_API_BREAKER_KEY);
  const ids: string[] = [];
  const hanCu: { id: string; han: string | null }[] = [];
  let goi = 0;
  try {
    await setSyncState(VTP_API_BREAKER_KEY, BREAKER_CLOSED);
    const [a] = await db.insert(schema.shipments).values({ carrier: "Viettel Post", vtpOrderNumber: "PKE-BRK-0001", stage: "PENDING", trackingCapability: "UNKNOWN_CAPABILITY" }).returning({ id: schema.shipments.id });
    const [old] = await db.insert(schema.shipments).values({ carrier: "Viettel Post", vtpOrderNumber: "PKE-BRK-0002", stage: "IN_TRANSIT", vtpLastError: LOI_CU }).returning({ id: schema.shipments.id });
    const [test] = await db.insert(schema.shipments).values({ carrier: "Viettel Post", vtpOrderNumber: "123456789101112", stage: "PENDING", createdAt: new Date(Date.now() - 400 * 3_600_000) }).returning({ id: schema.shipments.id });
    ids.push(a.id, old.id, test.id);
    // CÔ LẬP: lượt định kỳ chọn kiện ĐẾN HẠN bất kỳ — tạm đẩy hạn của mọi kiện khác ra tương lai (trả lại nguyên giá trị ở finally),
    // để lượt thử chỉ chạm kiện của bài này, không ghi sự kiện lên vận đơn của bài khác.
    const khac = rowsOf<{ id: string; han: string | null }>(await db.execute(sql`select id, vtp_next_sync_at::text as han from shipments where id <> ${a.id}`));
    hanCu.push(...khac);
    await db.execute(sql`update shipments set vtp_next_sync_at = now() + interval '100 days' where id <> ${a.id}`);

    // SQL ≡ TS trên câu lỗi thật.
    const [sq] = rowsOf<{ a: boolean; b: boolean }>(await db.execute(sql`select ${sql.raw(channelBlockMessageSql("x.m"))} as a, ${sql.raw(channelBlockMessageSql("y.m"))} as b from (select ${LOI_CU}::text as m) x, (select ${"Tài khoản API không thấy"}::text as m) y`));
    assert.deepEqual([Boolean(sq.a), Boolean(sq.b)], [isChannelBlockMessage(LOI_CU), isChannelBlockMessage("Tài khoản API không thấy")], "SQL ≡ TS");

    // 2 · kênh bị chặn.
    setViettelPostClientForTests({ getOrderDetail: async () => { goi += 1; throw new IntegrationError(LOI_CU, 403, false, HTML); } });
    await syncViettelPostShipments({ trigger: "CRON", actor: "test" });
    assert.equal(goi, 1, "gặp chặn ⇒ dừng ngay sau MỘT lượt gọi");
    const s1 = await getSyncState<VtpApiBreakerState>(VTP_API_BREAKER_KEY);
    assert.ok(s1?.openSince && s1.lastProbeResult === "BLOCKED", `mở cầu chì: ${JSON.stringify(s1)}`);
    const [moi] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from shipments s where s.id in ${ids.slice(0, 1)} and ${sql.raw(channelBlockMessageSql("s.vtp_last_error"))}`));
    assert.equal(moi.n, 0, "KHÔNG ghi câu lỗi kênh lên kiện");
    await syncViettelPostShipments({ trigger: "CRON", actor: "test" });
    assert.equal(goi, 1, "cầu chì mở < 6 giờ ⇒ không hỏi kiện nào");
    // Quá 6 giờ ⇒ thử đúng một kiện; trả bản ghi thật ⇒ đóng.
    await setSyncState(VTP_API_BREAKER_KEY, { ...s1, lastProbeAt: new Date(Date.now() - (BREAKER_RETRY_HOURS + 1) * 3_600_000).toISOString() });
    let thu = 0;
    setViettelPostClientForTests({ getOrderDetail: async (n: string) => { thu += 1; return record(n); } });
    await syncViettelPostShipments({ trigger: "CRON", actor: "test" });
    assert.equal(thu, 1, "lượt thử: đúng MỘT kiện");
    assert.deepEqual(await getSyncState<VtpApiBreakerState>(VTP_API_BREAKER_KEY), BREAKER_CLOSED, "bản ghi thật ⇒ đóng cầu chì");

    // 3 · hàng đợi đối chiếu.
    await setSyncState(VTP_API_BREAKER_KEY, { openSince: "2026-09-23T20:00:27Z", lastProbeAt: null, lastProbeResult: "BLOCKED" });
    clearMemo();
    const q = await getVtpReconcileQueue();
    assert.ok(!q.rows.some((r) => r.id === old.id && r.reasons.includes("SYNC_ERROR")), "câu lỗi kênh cũ không thành SYNC_ERROR");
    assert.ok(q.channelBlock && q.channelBlock.kienMangLoiCu >= 1, `băng rôn kèm số kiện mang lỗi cũ: ${JSON.stringify(q.channelBlock)}`);
    assert.ok(!q.rows.some((r) => r.id === test.id), "mã vận đơn THỬ của ĐVVC không vào hàng đợi");
  } finally {
    setViettelPostClientForTests(null);
    await setSyncState(VTP_API_BREAKER_KEY, truoc ?? BREAKER_CLOSED);
    for (const h of hanCu) await db.execute(sql`update shipments set vtp_next_sync_at = ${h.han}::timestamptz where id = ${h.id}`);
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
    clearMemo();
  }
  console.log("✓ Cầu chì kênh API VTP: 403 + HTML ⇒ mở, dừng sau một lượt, không ghi lỗi lên kiện · mở ⇒ không hỏi · 6 giờ ⇒ thử một, bản ghi thật ⇒ đóng · hàng đợi lọc lỗi kênh lúc đọc + băng rôn · mã thử không vào hàng đợi");
}

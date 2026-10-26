/**
 * ═══ «ĐVVC CHƯA BÁO LẤY ĐƯỢC HÀNG» — ĐỒNG HỒ TUỔI CHẶNG, KHÔNG PHẢI ĐỒNG HỒ IM LẶNG (vtp-direct-sync (3), 25/10/2026) ═══
 *
 * Đo production 25/10/2026: 35 vận đơn tạo trên VTP chờ lấy 4–10 ngày, ĐVVC gửi 102 ↔ 104 mỗi ngày (425 + 425 sự kiện) nên đồng hồ
 * im lặng không bao giờ chạm ngưỡng, và 0 kiện vào hàng đợi đối chiếu. Khoá: chờ lấy quá mức «ngoại lệ» của DWELL_SLA.PENDING, chưa
 * bàn giao ⇒ PICKUP_STALLED kèm số lần phân công bưu tá, KHÔNG kèm STALE_NO_NEWS (ĐVVC vẫn đang nói) · còn trong hạn / đã bàn giao /
 * đã chốt ⇒ không · ngưỡng đọc từ `logistics.dwell-sla` (tắt hạn chặng chờ lấy ⇒ lý do tắt) · xếp trên «im lặng», dưới «care».
 */
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DWELL_SLA, DWELL_SLA_SETTING_KEY } from "@/lib/constants/shipment-status-age";
import { RECONCILE_REASON_RANK } from "@/lib/constants/vtp-reconcile-queue";
import { getVtpReconcileQueue } from "@/lib/queries/vtp-reconcile-queue";
import { getSettingJson, setSettingJson } from "@/lib/settings";

const H = 3_600_000;

export async function testVtpPickupStalled() {
  assert.ok(RECONCILE_REASON_RANK.CARE_WITHOUT_MOVEMENT < RECONCILE_REASON_RANK.PICKUP_STALLED && RECONCILE_REASON_RANK.PICKUP_STALLED < RECONCILE_REASON_RANK.STALE_NO_NEWS, "xếp trên «im lặng», dưới «care không nhúc nhích»");
  const db = await getDb();
  const now = Date.now();
  const nguong = DWELL_SLA.PENDING!.exception;
  const truoc = await getSettingJson<unknown>(DWELL_SLA_SETTING_KEY, null);
  const ids: string[] = [];
  const mk = async (code: string, over: Partial<typeof schema.shipments.$inferInsert>, phanCong: number) => {
    const [r] = await db.insert(schema.shipments).values({ vtpOrderNumber: code, carrier: "Viettel Post", stage: "PENDING", codAmount: 499_000, ...over }).returning({ id: schema.shipments.id });
    ids.push(r.id);
    for (let i = 0; i < phanCong; i++) {
      await db.insert(schema.shipmentEvents).values([
        { shipmentId: r.id, source: "VTP_WEBHOOK", status: "104", statusName: "Giao cho Bưu tá đi nhận", occurredAt: new Date(now - (i + 1) * 24 * H + H), normalizedStage: "PENDING" },
        { shipmentId: r.id, source: "VTP_WEBHOOK", status: "102", statusName: "Đơn hàng chờ xử lý", occurredAt: new Date(now - (i + 1) * 24 * H + 2 * H), normalizedStage: "PENDING" },
      ]);
    }
    return r.id;
  };
  try {
    const ket = await mk("155999000001", { createdAt: new Date(now - (nguong + 48) * H) }, 3);
    const moi = await mk("155999000002", { createdAt: new Date(now - (nguong - 24) * H) }, 1);
    const daLay = await mk("155999000003", { createdAt: new Date(now - (nguong + 48) * H), pickedUpAt: new Date(now - 24 * H) }, 2);
    const daHuy = await mk("155999000004", { createdAt: new Date(now - (nguong + 48) * H), stage: "CANCELLED", isFinal: true }, 2);
    // Vận đơn BỊ THAY THẾ (#1079): PKE chờ lấy quá hạn mà đơn đã đi bằng lần gửi khác ⇒ KHÔNG phải kiện chưa lấy được.
    await db.insert(schema.orders).values({ id: "pk-sup-1", status: 6, statusName: "Đã hủy", stage: "CANCELLED", insertedAt: new Date(now - 10 * 24 * H) });
    const biThay = await mk("PKEPKSUP0001", { orderId: "pk-sup-1", attemptNo: 1, createdAt: new Date(now - (nguong + 48) * H) }, 3);
    await mk("155999000005", { orderId: "pk-sup-1", attemptNo: 2, stage: "IN_TRANSIT", createdAt: new Date(now - (nguong + 24) * H), pickedUpAt: new Date(now - (nguong + 20) * H) }, 0);

    clearMemo();
    const q = await getVtpReconcileQueue();
    const dong = q.rows.find((r) => r.id === ket);
    assert.ok(dong && dong.reasons.includes("PICKUP_STALLED"), `chờ lấy quá ngưỡng, chưa bàn giao ⇒ PICKUP_STALLED: ${JSON.stringify(dong?.reasons)}`);
    assert.ok(!dong.reasons.includes("STALE_NO_NEWS"), "ĐVVC vẫn gửi 102 / 104 hằng ngày ⇒ không phải «im lặng» — đồng hồ khác");
    assert.equal(dong.pickupAssignments, 3, "số lần phân công bưu tá (104)");
    assert.ok(dong.pickupAgeHours !== null && dong.pickupAgeHours >= nguong, "tuổi chặng in ra được");
    assert.ok(q.counts.PICKUP_STALLED >= 1, "chip đếm có lý do mới");
    for (const [id, vi] of [[moi, "còn trong hạn"], [daLay, "đã bàn giao"], [daHuy, "đã chốt"], [biThay, "bị thay thế bằng lần gửi đang đi"]] as const) {
      assert.ok(!q.rows.some((r) => r.id === id && r.reasons.includes("PICKUP_STALLED")), `${vi} ⇒ không PICKUP_STALLED`);
    }

    // Ngưỡng đọc từ cấu hình đang chạy: chủ shop tắt hạn chặng chờ lấy ⇒ lý do tắt theo.
    await setSettingJson(DWELL_SLA_SETTING_KEY, { PENDING: null });
    clearMemo();
    const tat = await getVtpReconcileQueue();
    assert.ok(!tat.rows.some((r) => r.reasons.includes("PICKUP_STALLED")) && tat.counts.PICKUP_STALLED === 0, "tắt hạn chặng chờ lấy ⇒ không kiện nào mang PICKUP_STALLED");
    // Hạ ngưỡng ⇒ kiện «còn trong hạn» theo mặc định thành việc.
    await setSettingJson(DWELL_SLA_SETTING_KEY, { PENDING: { watch: 12, warning: 24, exception: nguong - 48 } }); // ba mốc tăng dần (AGENTS 54)
    clearMemo();
    const ha = await getVtpReconcileQueue();
    assert.ok(ha.rows.some((r) => r.id === moi && r.reasons.includes("PICKUP_STALLED")), "hạ mức ngoại lệ của chặng chờ lấy ⇒ kiện tuổi thấp hơn cũng vào");
  } finally {
    await setSettingJson(DWELL_SLA_SETTING_KEY, truoc ?? {});
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
    await db.delete(schema.orders).where(inArray(schema.orders.id, ["pk-sup-1"]));
    clearMemo();
  }
  console.log("✓ PICKUP_STALLED: chờ lấy quá mức ngoại lệ DWELL_SLA, chưa bàn giao ⇒ vào hàng đợi kèm số lần phân công bưu tá, không gắn «im lặng» · trong hạn / đã lấy / đã chốt ⇒ không · ngưỡng theo logistics.dwell-sla");
}

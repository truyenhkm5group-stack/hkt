import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { BACKFILL_CURSOR_KEY, backfillWarnings, runCanonicalBackfill } from "@/lib/sync/backfill";
import { getSyncState } from "@/lib/sync/runner";

/**
 * DỰNG LẠI CHÂN LÝ LỊCH SỬ.
 *
 * Ba điều phải đúng: chạy thử không ghi gì · ghi xong thì dựng lại lần nữa báo 0 thay đổi
 * (idempotent) · dữ liệu GỐC không bị đụng tới.
 */

let seq = 0;

async function driftedShipment(db: Db, stage: string, events: { status: string; stage: string; at: string }[]) {
  const code = `BF-${++seq}`;
  const orderId = `bf-order-${seq}`;
  await db.insert(schema.orders).values({ id: orderId, stage: "SHIPPED", cod: 0, prepaid: 0, insertedAt: new Date(), raw: { nguyen_ban: "pancake" } });
  const [row] = await db
    .insert(schema.shipments)
    .values({
      orderId,
      vtpOrderNumber: code,
      trackingCode: code,
      carrier: "Viettel Post",
      stage: stage as never,
      codAmount: 499_000,
      codCollected: 250_000,
      codStatus: "COLLECTED",
      returnReceivedAt: null,
      raw: { nguyen_ban: "viettelpost" },
      vtpStatusDate: new Date("2026-09-01T00:00:00Z"),
    })
    .returning({ id: schema.shipments.id });
  for (const e of events) {
    await db.insert(schema.shipmentEvents).values({
      shipmentId: row.id,
      source: "VTP_WEBHOOK",
      status: e.status,
      statusName: e.status,
      occurredAt: new Date(e.at),
      normalizedStage: e.stage as never,
      legType: "OUTBOUND",
    });
  }
  return { id: row.id, orderId, code };
}

export async function testBackfill(db: Db) {
  clearMemo();

  const drifted = await driftedShipment(db, "PENDING", [
    { status: "200", stage: "PICKED_UP", at: "2026-09-02T08:00:00Z" },
    { status: "501", stage: "DELIVERED", at: "2026-09-03T09:30:00Z" },
  ]);

  // ───────── 1. CHẠY THỬ: đếm ra thay đổi, KHÔNG ghi gì ─────────
  const dry = await runCanonicalBackfill({ apply: false });
  assert.equal(dry.applied, false);
  assert.ok(dry.changed > 0, "chạy thử phải phát hiện được vận đơn lệch");
  assert.ok(dry.total >= dry.changed + dry.unchanged - dry.noEvidence, "các con số phải cộng khớp");
  assert.ok(Object.keys(dry.stageTransitions).length > 0, "phải liệt kê ma trận chuyển trạng thái");
  assert.ok(dry.samples.length > 0, "phải có ví dụ để soi tay");
  assert.ok(dry.outcomeBefore.DELIVERED >= 0, "phải báo phân bố kết quả đơn TRƯỚC");
  // CHẠY THỬ KHÔNG ĐO ĐƯỢC tác động kết quả đơn — phải trả CHƯA BIẾT, không phải bản sao/số 0.
  assert.equal(dry.outcomeAfter, null, "chạy thử phải nói rõ chưa đo được phân bố SAU, không trả bản sao của TRƯỚC");
  assert.equal(dry.deliveredToNotDelivered, null, "chạy thử chưa đo được số đơn lật khỏi GIAO THÀNH CÔNG");
  assert.equal(dry.notDeliveredToDelivered, null);
  assert.equal(dry.returnedChanged, null);
  assert.ok(
    backfillWarnings(dry).some((w) => w.includes("KHÔNG đo được")),
    "chạy thử có thay đổi mà chưa đo được tác động thì PHẢI cảnh báo — đây là guardrail đứng trước lệnh ghi",
  );

  const [beforeWrite] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, drifted.id));
  assert.equal(beforeWrite.stage, "PENDING", "chạy thử KHÔNG được ghi vào dữ liệu");
  assert.equal(await getSyncState<{ lastId: string | null }>(BACKFILL_CURSOR_KEY), null, "chạy thử không được ghi cả con trỏ tiến độ");

  // ───────── 2. GHI THẬT: dựng lại theo lịch sử ─────────
  const applied = await runCanonicalBackfill({ apply: true, actor: "test:backfill" });
  assert.equal(applied.applied, true);
  assert.ok(applied.changed > 0);
  // Ghi thật thì mới đo được tác động — lúc đó các trường phải là SỐ, không còn null.
  assert.notEqual(applied.outcomeAfter, null, "ghi thật phải đo được phân bố kết quả đơn SAU");
  assert.equal(typeof applied.deliveredToNotDelivered, "number");
  const [afterWrite] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, drifted.id));
  assert.equal(afterWrite.stage, "DELIVERED", "ảnh chụp phải khớp lịch sử sự kiện");
  assert.equal(afterWrite.deliveredAt?.toISOString(), "2026-09-03T09:30:00.000Z", "mốc giao lấy từ chính sự kiện của ĐVVC");

  // ───────── 3. DỮ LIỆU GỐC KHÔNG BỊ ĐỤNG ─────────
  assert.deepEqual(afterWrite.raw, { nguyen_ban: "viettelpost" }, "payload gốc của vận đơn phải giữ nguyên");
  assert.equal(afterWrite.codCollected, 250_000, "tiền thực thu KHÔNG được dựng lại từ hành trình");
  assert.equal(afterWrite.codStatus, "COLLECTED", "trạng thái tiền là chiều khác, backfill không đụng tới");
  assert.equal(afterWrite.returnReceivedAt, null, "mốc kho thực nhận hàng hoàn chỉ do kho ghi");
  const [orderRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, drifted.orderId));
  assert.deepEqual(orderRow.raw, { nguyen_ban: "pancake" }, "payload gốc của đơn phải giữ nguyên");
  const events = await db.select().from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, drifted.id));
  assert.equal(events.length, 2, "backfill không được xoá hay nhân bản lịch sử sự kiện");

  // ───────── 4. IDEMPOTENT: chạy lại báo 0 thay đổi ─────────
  const second = await runCanonicalBackfill({ apply: true, actor: "test:backfill" });
  assert.equal(second.changed, 0, "dựng lại lần hai trên cùng tập sự kiện phải báo 0 thay đổi");
  const third = await runCanonicalBackfill({ apply: false });
  assert.equal(third.changed, 0, "chạy thử sau khi ghi cũng phải báo 0 thay đổi");

  // ───────── 5. CHẠY TIẾP ĐƯỢC: con trỏ tiến độ ─────────
  const batched = await runCanonicalBackfill({ apply: true, batchSize: 2, actor: "test:backfill" });
  assert.equal(batched.total, 2, "chạy theo lô phải tôn trọng kích thước lô");
  assert.ok(batched.cursor, "chạy theo lô phải ghi lại vị trí dừng");
  const resumed = await runCanonicalBackfill({ apply: true, batchSize: 2, resume: true, actor: "test:backfill" });
  assert.notEqual(resumed.cursor, batched.cursor, "lô sau phải bắt đầu từ chỗ lô trước dừng, không quét lại từ đầu");

  // ───────── 6. TRUY NGUYÊN ĐƯỢC ─────────
  const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "backfill.canonical-state"));
  assert.ok(logs.length > 0, "mỗi lần ghi thật phải để lại nhật ký");

  // ───────── 7. Cảnh báo bất thường phải chặn tay người chạy ─────────
  assert.deepEqual(backfillWarnings({ ...third, applied: true, total: 100, changed: 0, deliveredToNotDelivered: 0, conflicts: 0, unknownEvents: 0 }), []);
  const risky = backfillWarnings({ ...third, applied: true, total: 100, changed: 50, deliveredToNotDelivered: 3, conflicts: 2, unknownEvents: 1 });
  assert.equal(risky.length, 4, "phải nêu đủ bốn loại bất thường");
  assert.ok(risky.some((w) => w.includes("GIAO THÀNH CÔNG")), "lật đơn đã giao thành công phải được nêu riêng — doanh thu đã chốt sẽ giảm");

  // Dọn con trỏ để lần chạy sau của kiểm thử khác không bị lệch.
  const { setSyncState } = await import("@/lib/sync/runner");
  await setSyncState(BACKFILL_CURSOR_KEY, { lastId: null });

  console.log(
    `✓ Dựng lại chân lý lịch sử: chạy thử không ghi gì · ghi xong dựng lại báo 0 thay đổi · dữ liệu gốc & tiền không bị đụng · chạy tiếp được theo lô`,
  );
}

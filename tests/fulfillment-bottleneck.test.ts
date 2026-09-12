import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import { getFulfillmentBottleneckQueue, type FulfillmentBottleneckCase } from "@/lib/queries/fulfillment-bottleneck";
import type { OrderStage, ShipmentStage } from "@/db/schema";

/**
 * ═══════════ NÚT THẮT FULFILLMENT NỘI BỘ: confirmed → ready to fulfill → rời kho ═══════════
 *
 * Khoá bốn điều:
 *  1. Bốn lý do LOẠI TRỪ LẪN NHAU, đúng thứ tự chặn (dữ liệu sai chặn TRƯỚC thiếu vận đơn).
 *  2. KHÔNG false alert cho đơn huỷ / đơn chưa xác nhận / vận đơn đã rời kho.
 *  3. Tuổi tính từ lúc ĐỨNG Ở TRẠNG THÁI NÀY (`last_update_status_at`), KHÔNG từ lúc TẠO đơn — đây
 *     là lỗi có thật đã xảy ra với `ORDER_CONFIRMED_STALE` (xem lib/queries/stage-health.ts).
 *  4. Tiền treo lấy đúng trục: có COD khai báo thì lấy COD, không thì lấy giá trị đơn.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/fulfillment-bottleneck.test.ts
 */
export async function testFulfillmentBottleneck(db: Db) {
  const gio = (h: number) => new Date(Date.now() - h * 3_600_000);

  async function seedOrder(id: string, opts: { stage: OrderStage; phone?: string; address?: string; province?: string; insertedHoursAgo?: number; statusHoursAgo?: number; value?: number }) {
    await db
      .insert(schema.orders)
      .values({
        id,
        systemId: Math.floor(Math.random() * 1_000_000),
        billFullName: `Khách ${id}`,
        billPhone: opts.phone ?? "0900000000",
        shipAddress: opts.address ?? "123 đường ABC",
        shipProvince: opts.province ?? "Hà Nội",
        totalPriceAfterDiscount: opts.value ?? 500_000,
        stage: opts.stage,
        insertedAt: gio(opts.insertedHoursAgo ?? 240), // đơn cũ theo mặc định — bẫy nếu code lỡ dùng insertedAt để tính tuổi
        lastUpdateStatusAt: opts.statusHoursAgo === undefined ? null : gio(opts.statusHoursAgo),
      })
      .onConflictDoNothing();
  }

  async function seedShipment(id: string, orderId: string, opts: { stage: ShipmentStage; createdHoursAgo: number; pickedUpAt?: Date | null; cod?: number; direction?: string }) {
    await db
      .insert(schema.shipments)
      .values({
        id,
        orderId,
        carrier: "VTP",
        direction: opts.direction ?? "OUTBOUND",
        trackingCode: id.toUpperCase(),
        vtpOrderNumber: `V${id}`,
        stage: opts.stage,
        pickedUpAt: opts.pickedUpAt ?? null,
        codAmount: opts.cod ?? 0,
        receiverName: "Khách thử",
        receiverPhone: "0900000000",
        createdAt: gio(opts.createdHoursAgo),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  // ───────── 1. Thiếu dữ liệu chặn TRƯỚC "chưa có vận đơn" ─────────
  await seedOrder("fb-thieu-sdt", { stage: "CONFIRMED", phone: "", statusHoursAgo: 30 });
  await seedOrder("fb-dia-chi-chua-chuan", { stage: "CONFIRMED", province: "", statusHoursAgo: 30 });

  // ───────── 2. Đã chốt, đủ dữ liệu, chưa có vận đơn nào ─────────
  await seedOrder("fb-chua-gui", { stage: "READY_TO_SHIP", statusHoursAgo: 30 });

  // Vận đơn duy nhất của đơn này đã bị HUỶ ⇒ vẫn phải rơi về "chưa có vận đơn", không phải một lý do khác.
  await seedOrder("fb-vandon-da-huy", { stage: "CONFIRMED", statusHoursAgo: 30 });
  await seedShipment("fb-vandon-da-huy-s1", "fb-vandon-da-huy", { stage: "CANCELLED", createdHoursAgo: 20 });

  // ───────── 3. Có vận đơn (PENDING), CHƯA thấy sự kiện nào của ĐVVC ─────────
  await seedOrder("fb-cho-vtp-nhan", { stage: "CONFIRMED", statusHoursAgo: 5 });
  await seedShipment("fb-cho-vtp-nhan-s1", "fb-cho-vtp-nhan", { stage: "PENDING", createdHoursAgo: 30, cod: 800_000 });

  // ───────── 4. ĐVVC đã xác nhận nhận đơn, bưu tá CHƯA lấy hàng ─────────
  await seedOrder("fb-cho-lay-hang", { stage: "CONFIRMED", statusHoursAgo: 5 });
  await seedShipment("fb-cho-lay-hang-s1", "fb-cho-lay-hang", { stage: "PENDING", createdHoursAgo: 30, cod: 900_000 });
  await db
    .insert(schema.shipmentEvents)
    .values({ shipmentId: "fb-cho-lay-hang-s1", source: "VTP_WEBHOOK", status: "100", statusName: "Tiếp nhận đơn hàng", occurredAt: gio(29) })
    .onConflictDoNothing();

  // ───────── KHÔNG ĐƯỢC XUẤT HIỆN: đã rời kho ─────────
  await seedOrder("fb-da-roi-kho", { stage: "CONFIRMED", statusHoursAgo: 30 });
  await seedShipment("fb-da-roi-kho-s1", "fb-da-roi-kho", { stage: "PICKED_UP", createdHoursAgo: 40, pickedUpAt: gio(10) });

  // ───────── KHÔNG ĐƯỢC XUẤT HIỆN: đơn đã huỷ (dù còn vận đơn PENDING) ─────────
  await seedOrder("fb-da-huy", { stage: "CANCELLED", statusHoursAgo: 30 });
  await seedShipment("fb-da-huy-s1", "fb-da-huy", { stage: "PENDING", createdHoursAgo: 30 });

  // ───────── KHÔNG ĐƯỢC XUẤT HIỆN: đơn chưa xác nhận (việc của Sales Funnel/CSKH) ─────────
  await seedOrder("fb-chua-xac-nhan", { stage: "NEW", statusHoursAgo: 30 });

  // ───────── TUỔI TÍNH TỪ LÚC ĐỨNG Ở TRẠNG THÁI, KHÔNG TỪ LÚC TẠO ĐƠN ─────────
  // insertedAt mặc định 240 giờ trước (xem seedOrder) nhưng vừa được xác nhận 1 giờ trước.
  await seedOrder("fb-vua-chot", { stage: "CONFIRMED", statusHoursAgo: 1 });

  const queue = await getFulfillmentBottleneckQueue();
  assert.ok(queue.ok, "phải đọc được — nếu câu SQL lỗi thì đây phải là lỗi thật, không phải hàng đợi rỗng");

  const byId = new Map(queue.cases.map((c) => [c.orderId, c]));
  const find = (id: string): FulfillmentBottleneckCase => {
    const c = byId.get(id);
    assert.ok(c, `${id}: phải xuất hiện trong hàng đợi nút thắt fulfillment`);
    return c as FulfillmentBottleneckCase;
  };

  // 1. Dữ liệu chặn đứng TRƯỚC "chưa có vận đơn"
  assert.equal(find("fb-thieu-sdt").reason, "DATA_BLOCKED");
  assert.ok(find("fb-thieu-sdt").reasonDetail.includes("điện thoại"), "chi tiết phải nói rõ thiếu SĐT");
  assert.equal(find("fb-dia-chi-chua-chuan").reason, "DATA_BLOCKED");
  assert.ok(find("fb-dia-chi-chua-chuan").reasonDetail.includes("chuẩn hoá"), "chi tiết phải nói rõ địa chỉ chưa chuẩn hoá");
  assert.equal(find("fb-thieu-sdt").team, "CS", "thiếu dữ liệu là việc gọi khách — của CSKH, không phải kho");

  // 2. Chưa có vận đơn — kể cả khi vận đơn DUY NHẤT đã bị huỷ
  assert.equal(find("fb-chua-gui").reason, "NOT_YET_SHIPPED");
  assert.equal(find("fb-chua-gui").shipmentId, null);
  assert.equal(find("fb-vandon-da-huy").reason, "NOT_YET_SHIPPED", "vận đơn duy nhất đã huỷ thì đơn vẫn cần một vận đơn MỚI, không phải một lý do khác");
  assert.equal(find("fb-chua-gui").team, "WAREHOUSE", "chưa gửi hàng là việc của kho");

  // 3 & 4. Phân biệt "chưa thấy ĐVVC xác nhận" và "đã xác nhận, chưa lấy hàng"
  assert.equal(find("fb-cho-vtp-nhan").reason, "AWAITING_CARRIER_ACCEPT");
  assert.equal(find("fb-cho-vtp-nhan").moneyAtRisk, 800_000, "có COD khai báo thì tiền treo phải là COD, không phải giá trị đơn");
  assert.equal(find("fb-cho-lay-hang").reason, "AWAITING_PICKUP");
  assert.notEqual(find("fb-cho-vtp-nhan").reasonLabel, find("fb-cho-lay-hang").reasonLabel, "hai lý do khác nhau phải có hai nhãn khác nhau");

  // KHÔNG ĐƯỢC coi "đã tạo vận đơn" là "đã rời kho" — đây là yêu cầu tường minh của bài toán.
  for (const id of ["fb-cho-vtp-nhan", "fb-cho-lay-hang"]) {
    assert.notEqual(find(id).shipmentStage, "PICKED_UP");
  }

  // KHÔNG ĐƯỢC XUẤT HIỆN
  assert.ok(!byId.has("fb-da-roi-kho"), "vận đơn đã rời kho (PICKED_UP) thì không còn là nút thắt fulfillment");
  assert.ok(!byId.has("fb-da-huy"), "đơn đã huỷ không được tạo cảnh báo giả, kể cả khi còn vận đơn PENDING treo lại");
  assert.ok(!byId.has("fb-chua-xac-nhan"), "đơn chưa xác nhận thuộc phạm vi Sales Funnel/CSKH, không phải nút thắt này");

  // TUỔI TÍNH TỪ LÚC XÁC NHẬN, KHÔNG TỪ LÚC LÊN ĐƠN — bẫy chính của bài toán này.
  const vuaChot = find("fb-vua-chot");
  assert.ok(vuaChot.ageHours < 2, `đơn vừa chốt 1 giờ trước phải có tuổi ~1 giờ, đang là ${vuaChot.ageHours}`);
  assert.ok(!vuaChot.sla.breached, "đơn vừa chốt không thể đã trễ hạn 24 giờ");

  // Trong khi đó "fb-cho-vtp-nhan"/"fb-cho-lay-hang" đứng ở trạng thái xác nhận đã 5 giờ NHƯNG vận
  // đơn được tạo 30/29 giờ trước — tuổi của CASE phải tính theo mốc TẠO VẬN ĐƠN, không theo mốc xác
  // nhận đơn (hai mốc khác nhau một khi đã có vận đơn).
  assert.ok(find("fb-cho-vtp-nhan").ageHours >= 29, "tuổi của việc 'chờ ĐVVC nhận' phải tính từ lúc TẠO VẬN ĐƠN");
  assert.ok(find("fb-cho-vtp-nhan").sla.breached, "tạo vận đơn 30 giờ mà ĐVVC còn chưa xác nhận nhận đơn phải trễ hạn (ngưỡng 24 giờ)");

  // "fb-thieu-sdt" đứng ở CONFIRMED đã 30 giờ ⇒ phải trễ hạn (ngưỡng 24 giờ), dù đơn được TẠO 240 giờ trước.
  assert.ok(find("fb-thieu-sdt").sla.breached, "đứng ở trạng thái 30 giờ phải trễ hạn 24 giờ, bất kể đơn được tạo bao lâu trước");
  assert.ok(find("fb-thieu-sdt").ageHours < 40, `tuổi phải đo từ lúc ĐỨNG Ở TRẠNG THÁI (~30 giờ), không phải từ lúc TẠO đơn (240 giờ) — đang là ${find("fb-thieu-sdt").ageHours}`);

  // Vận đơn không có COD khai báo (cod=0, mặc định) thì tiền treo phải rơi về giá trị đơn.
  assert.equal(find("fb-chua-gui").moneyAtRisk, 500_000, "chưa có vận đơn thì tiền treo là giá trị đơn");

  // ───────── HÀNG ĐỢI ACTION-FIRST: trễ hạn đứng trước ─────────
  const cacViecCuaTest = queue.cases.filter((c) => c.orderId.startsWith("fb-"));
  const idxTre = cacViecCuaTest.findIndex((c) => c.orderId === "fb-cho-vtp-nhan");
  const idxChuaTre = cacViecCuaTest.findIndex((c) => c.orderId === "fb-vua-chot");
  assert.ok(idxTre >= 0 && idxChuaTre >= 0 && idxTre < idxChuaTre, "việc trễ hạn phải đứng trước việc chưa trễ hạn trong hàng đợi");

  // Bốn lý do đều phải có nhãn, hành động, bộ phận, hạn xử lý — không được thiếu khoá nào.
  for (const c of queue.cases) {
    assert.ok(c.reasonLabel.length > 0, `${c.orderId}: thiếu nhãn lý do`);
    assert.ok(c.nextAction.length > 10, `${c.orderId}: phải nói rõ nên làm gì`);
    assert.ok(c.teamLabel.length > 0, `${c.orderId}: phải có bộ phận chịu trách nhiệm`);
    assert.ok(c.sla.hours > 0, `${c.orderId}: phải có hạn xử lý`);
    assert.ok(c.moneyAtRisk >= 0, `${c.orderId}: tiền treo không được âm`);
    assert.ok(c.ageHours >= 0, `${c.orderId}: tuổi không được âm`);
  }

  console.log(
    `✓ Nút thắt fulfillment: ${cacViecCuaTest.length} ca kiểm thử đúng phân loại · ${queue.byReason.map((r) => `${r.label}: ${r.count}`).join(" · ")}`,
  );
}

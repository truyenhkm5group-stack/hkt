import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { ShipmentStage } from "@/db/schema";
import {
  CARRIER_HANDOFF_AT_SQL,
  CARRIER_HANDOFF_BASIS_SQL,
  CARRIER_HANDOFF_STAGES,
  carrierHandoffFrom,
  HANDOFF_BASIS_LABEL,
  type HandoffBasis,
  type HandoffEvent,
} from "@/lib/constants/carrier-handoff";
import { LEFT_WAREHOUSE_EVENT_STAGES } from "@/lib/care/entry";
import { VTP_STATUS } from "@/lib/constants/viettelpost";

/**
 * ═══════════ MỐC ĐVVC THẬT SỰ CẦM HÀNG ═══════════
 *
 * Bài kiểm này bảo vệ một câu duy nhất: **kiện chưa được ĐVVC lấy đi thì KHÔNG có mốc bàn giao.**
 *
 * Luật cũ nhận mọi sự kiện có chặng khác `NULL` làm bậc dự phòng, mà `PENDING` và `CANCELLED`
 * không phải `NULL` — nên "lấy hàng thất bại" (102) và "shop huỷ lấy" (101/107/201) vẫn được đóng
 * dấu đã bàn giao. Đo trên production 13/09/2026: 120 vận đơn, 119 đang ở `PENDING` và 1 ở
 * `CANCELLED`. Chúng đi thẳng vào lô hàng "Đã gửi" của tuần đó và làm phình mẫu số của tỷ lệ giao
 * thành công bằng những kiện chưa bao giờ rời kho.
 */

/* ───── 1 · Danh sách chặng: đúng bằng danh sách "đã rời kho", và ĐÓNG dưới phép quy đổi chiều ───── */
export function testHandoffStageSet() {
  assert.deepEqual(
    [...CARRIER_HANDOFF_STAGES].sort(),
    [...LEFT_WAREHOUSE_EVENT_STAGES].sort(),
    "chặng chứng minh bàn giao phải TRÙNG danh sách 'đã rời kho' của vòng đời care — hai danh sách cho cùng một câu hỏi thì sẽ có ngày nói khác nhau",
  );

  // Mã của Viettel Post nói "chưa lấy được / đã huỷ lấy" TUYỆT ĐỐI không được nằm trong tập chứng cứ.
  const PHAI_NGOAI: Record<number, string> = {
    100: "Tiếp nhận đơn hàng",
    102: "Lấy hàng thất bại",
    103: "Điều phối bưu cục lấy hàng",
    104: "Điều phối bưu tá lấy hàng",
    106: "Đối tác yêu cầu lấy lại hàng",
    101: "Viettel Post hủy lấy hàng",
    107: "Đối tác yêu cầu hủy qua API",
    201: "Viettel Post hủy đơn hàng",
    503: "Tiêu huỷ",
  };
  for (const [ma, ten] of Object.entries(PHAI_NGOAI)) {
    const stage = VTP_STATUS[Number(ma)]?.stage;
    assert.ok(stage, `mã ${ma} phải có trong bảng trạng thái`);
    assert.ok(
      !CARRIER_HANDOFF_STAGES.includes(stage as ShipmentStage),
      `mã ${ma} "${ten}" (chặng ${stage}) KHÔNG được tính là bàn giao — đây chính là 120 vận đơn đo được trên production`,
    );
  }

  // Và mã nói "ĐVVC đã cầm hàng" thì phải nằm trong.
  for (const ma of [105, 200, 300, 400, 500, 501, 502, 504, 506]) {
    const stage = VTP_STATUS[ma]?.stage as ShipmentStage;
    assert.ok(CARRIER_HANDOFF_STAGES.includes(stage), `mã ${ma} (${VTP_STATUS[ma]?.name}) chứng minh ĐVVC đã cầm hàng, phải nằm trong tập chứng cứ`);
  }

  /*
    ĐÓNG DƯỚI PHÉP QUY ĐỔI CHIỀU — thứ khiến việc đọc thẳng `normalized_stage` trong SQL là ĐÚNG.

    `onReturnLeg` đổi DELIVERED→RETURNED và PICKED_UP/IN_TRANSIT/OUT_FOR_DELIVERY/DELIVERY_FAILED
    →RETURNING khi sự kiện thuộc chiều hoàn. Cả hai đích đến đều đã nằm trong tập, nên câu trả lời
    "có phải bàn giao không" KHÔNG đổi sau khi quy đổi. Nhờ tính chất này, biểu thức SQL không cần
    đọc `leg_type` — nếu tính chất này mất, SQL và TypeScript sẽ lặng lẽ nói hai điều khác nhau.
  */
  const QUY_DOI: Partial<Record<ShipmentStage, ShipmentStage>> = {
    DELIVERED: "RETURNED",
    PICKED_UP: "RETURNING",
    IN_TRANSIT: "RETURNING",
    OUT_FOR_DELIVERY: "RETURNING",
    DELIVERY_FAILED: "RETURNING",
  };
  for (const s of CARRIER_HANDOFF_STAGES) {
    const sau = QUY_DOI[s] ?? s;
    assert.ok(CARRIER_HANDOFF_STAGES.includes(sau), `chặng ${s} quy đổi sang chiều hoàn thành ${sau} — phải vẫn nằm trong tập, nếu không SQL (đọc thẳng) và TypeScript (có quy đổi) sẽ lệch nhau`);
  }

  for (const b of Object.keys(HANDOFF_BASIS_LABEL) as HandoffBasis[]) assert.ok(HANDOFF_BASIS_LABEL[b], `${b}: thiếu nhãn tiếng Việt`);
  console.log("✓ Tập chứng cứ bàn giao: trùng danh sách 'đã rời kho' · loại đúng 9 mã chưa-lấy-được/huỷ-lấy · ĐÓNG dưới phép quy đổi chiều hoàn");
}

/* ───── 2 · Hàm thuần: chọn đúng chứng cứ, và không bịa khi không có gì ───── */
export function testHandoffPureFunction() {
  const t = (iso: string) => new Date(iso);
  const ev = (source: string, stage: ShipmentStage | null, iso: string): HandoffEvent => ({ source, normalizedStage: stage, occurredAt: t(iso) });

  // ── Chứng từ máy, lấy SỚM NHẤT trong các sự kiện chứng minh ──
  const a = carrierHandoffFrom(
    [ev("VTP_WEBHOOK", "OUT_FOR_DELIVERY", "2026-08-22T02:00:00Z"), ev("VTP_WEBHOOK", "PICKED_UP", "2026-08-20T02:00:00Z"), ev("VTP_WEBHOOK", "DELIVERED", "2026-08-24T02:00:00Z")],
    null,
  );
  assert.equal(a.at?.toISOString(), "2026-08-20T02:00:00.000Z", "lấy sự kiện chứng minh SỚM NHẤT");
  assert.equal(a.basis, "CARRIER_DOCUMENT");

  // ── LẤY HÀNG THẤT BẠI không phải bàn giao ──
  const b = carrierHandoffFrom([ev("VTP_WEBHOOK", "PENDING", "2026-08-19T02:00:00Z"), ev("VTP_WEBHOOK", "PICKED_UP", "2026-08-21T02:00:00Z")], null);
  assert.equal(b.at?.toISOString(), "2026-08-21T02:00:00.000Z", "sự kiện PENDING (mã 102 'lấy hàng thất bại') sớm hơn nhưng KHÔNG được chọn");

  const chuaLay = carrierHandoffFrom([ev("VTP_WEBHOOK", "PENDING", "2026-08-19T02:00:00Z")], null);
  assert.equal(chuaLay.at, null, "chỉ có sự kiện 'lấy hàng thất bại' ⇒ CHƯA có mốc bàn giao");
  assert.equal(chuaLay.basis, "NONE", "và nói rõ là chưa có chứng cứ, không phải 'chưa gửi'");

  // ── SHOP HUỶ LẤY không phải bàn giao ──
  const huy = carrierHandoffFrom([ev("VTP_WEBHOOK", "PENDING", "2026-08-19T02:00:00Z"), ev("VTP_WEBHOOK", "CANCELLED", "2026-08-19T06:00:00Z")], null);
  assert.equal(huy.at, null, "shop huỷ lấy / VTP huỷ đơn ⇒ hàng chưa bao giờ được bàn giao");
  assert.equal(huy.basis, "NONE");

  // ── CHƯA BIẾT vẫn là CHƯA BIẾT ──
  assert.deepEqual(carrierHandoffFrom([], null), { at: null, basis: "NONE" }, "không sự kiện, không mốc lấy hàng ⇒ null, KHÔNG rơi về ngày tạo vận đơn");
  assert.equal(carrierHandoffFrom([ev("PANCAKE", "PICKED_UP", "2026-08-10T02:00:00Z")], null).at, null, "sự kiện Pancake KHÔNG được kết luận — mốc của nó là giờ Pancake ghi nhận");
  assert.equal(carrierHandoffFrom([{ source: "VTP_WEBHOOK", normalizedStage: "PICKED_UP", occurredAt: new Date("khong-hop-le") }], null).at, null, "mốc thời gian hỏng bị bỏ qua, không thành NaN");
  assert.equal(carrierHandoffFrom([ev("VTP_WEBHOOK", null, "2026-08-10T02:00:00Z")], null).at, null, "sự kiện chưa dịch được chặng thì không kết luận");

  // ── SỚM NHẤT THẮNG, kể cả khi nguồn yếu hơn giữ mốc sớm hơn ──
  // Đây là hình dạng của 1.040 vận đơn dựng từ tệp nhập trên production: lịch sử sự kiện bắt đầu
  // SAU lúc lấy hàng (trung vị 88,9 giờ), nên mốc lấy hàng đã lưu mới là chứng cứ sớm nhất.
  const nhap = carrierHandoffFrom([ev("VTP_IMPORT", "IN_TRANSIT", "2026-08-24T02:00:00Z")], t("2026-08-20T02:00:00Z"));
  assert.equal(nhap.at?.toISOString(), "2026-08-20T02:00:00.000Z", "mốc lấy hàng sớm hơn sự kiện còn giữ được ⇒ nó là chứng cứ sớm nhất");
  assert.equal(nhap.basis, "PICKUP_SNAPSHOT", "và nói rõ kết luận dựa vào đâu");

  // Ngược lại: có chứng từ SỚM HƠN ảnh chụp thì chứng từ thắng (61 vận đơn trên production).
  const chungTuSom = carrierHandoffFrom([ev("VTP_WEBHOOK", "PICKED_UP", "2026-08-18T02:00:00Z")], t("2026-08-20T02:00:00Z"));
  assert.equal(chungTuSom.at?.toISOString(), "2026-08-18T02:00:00.000Z");
  assert.equal(chungTuSom.basis, "CARRIER_DOCUMENT");

  // Bằng nhau thì chứng từ máy thắng ảnh chụp — ảnh chụp không mang theo xuất xứ của chính nó.
  const hoa = carrierHandoffFrom([ev("VTP_WEBHOOK", "PICKED_UP", "2026-08-20T02:00:00Z")], t("2026-08-20T02:00:00Z"));
  assert.equal(hoa.basis, "CARRIER_DOCUMENT", "bằng mốc thì chứng từ máy thắng");

  // Bản chép tay là chứng từ ĐVVC qua tay người — đứng dưới chứng từ máy, trên ảnh chụp.
  const chepTay = carrierHandoffFrom([ev("VTP_UI_MANUAL_VERIFICATION", "PICKED_UP", "2026-08-19T02:00:00Z")], t("2026-08-21T02:00:00Z"));
  assert.equal(chepTay.basis, "MANUAL_DOCUMENT");
  assert.equal(chepTay.at?.toISOString(), "2026-08-19T02:00:00.000Z");

  // ── PHÁT LẠI KHÔNG ĐỔI KẾT QUẢ ──
  // Viettel Post thử lại tối đa 5 lần và gói tin có thể trùng/thừa. Hàm là hàm THUẦN của TẬP sự
  // kiện, nên thêm bản sao hay đảo thứ tự đều không đổi kết luận — chứng minh thay vì tin lời.
  const goc = [ev("VTP_WEBHOOK", "PICKED_UP", "2026-08-20T02:00:00Z"), ev("VTP_WEBHOOK", "IN_TRANSIT", "2026-08-21T02:00:00Z")];
  const motLan = carrierHandoffFrom(goc, null);
  const namLan = carrierHandoffFrom([...goc, ...goc, ...goc, ...goc, ...goc], null);
  const daoNguoc = carrierHandoffFrom([...goc].reverse(), null);
  assert.equal(namLan.at?.getTime(), motLan.at?.getTime(), "phát lại 5 lần vẫn ra đúng một mốc");
  assert.equal(daoNguoc.at?.getTime(), motLan.at?.getTime(), "đảo thứ tự sự kiện không đổi kết quả");
  assert.equal(namLan.basis, motLan.basis, "và không đổi cả căn cứ");

  console.log("✓ Mốc bàn giao (hàm thuần): lấy chứng cứ SỚM NHẤT · loại 'lấy hàng thất bại' và 'shop huỷ lấy' · Pancake không được kết luận · phát lại/đảo thứ tự cho cùng một kết quả");
}

/* ───── 3 · SQL và TypeScript phải nói CÙNG MỘT ĐIỀU trên cùng dữ liệu ───── */
export async function testHandoffSqlMatchesTypescript(db: Db) {
  const P = "ch-";
  type Ca = { ten: string; pickedUpAt: Date | null; events: { source: string; stage: ShipmentStage | null; at: string }[]; mong: string | null; basis: HandoffBasis };

  const CAC_CA: Ca[] = [
    { ten: "chỉ có webhook chứng minh", pickedUpAt: null, events: [{ source: "VTP_WEBHOOK", stage: "PICKED_UP", at: "2026-08-20T02:00:00Z" }], mong: "2026-08-20T02:00:00.000Z", basis: "CARRIER_DOCUMENT" },
    { ten: "lấy hàng thất bại rồi mới lấy được", pickedUpAt: null, events: [{ source: "VTP_WEBHOOK", stage: "PENDING", at: "2026-08-18T02:00:00Z" }, { source: "VTP_WEBHOOK", stage: "PICKED_UP", at: "2026-08-20T02:00:00Z" }], mong: "2026-08-20T02:00:00.000Z", basis: "CARRIER_DOCUMENT" },
    { ten: "CHỈ lấy hàng thất bại", pickedUpAt: null, events: [{ source: "VTP_WEBHOOK", stage: "PENDING", at: "2026-08-18T02:00:00Z" }], mong: null, basis: "NONE" },
    { ten: "shop huỷ lấy", pickedUpAt: null, events: [{ source: "VTP_WEBHOOK", stage: "PENDING", at: "2026-08-18T02:00:00Z" }, { source: "VTP_WEBHOOK", stage: "CANCELLED", at: "2026-08-18T09:00:00Z" }], mong: null, basis: "NONE" },
    { ten: "dựng từ tệp nhập: mốc lấy hàng sớm hơn lịch sử sự kiện", pickedUpAt: new Date("2026-08-20T02:00:00Z"), events: [{ source: "VTP_IMPORT", stage: "IN_TRANSIT", at: "2026-08-24T02:00:00Z" }], mong: "2026-08-20T02:00:00.000Z", basis: "PICKUP_SNAPSHOT" },
    { ten: "chứng từ sớm hơn ảnh chụp", pickedUpAt: new Date("2026-08-22T02:00:00Z"), events: [{ source: "VTP_WEBHOOK", stage: "PICKED_UP", at: "2026-08-19T02:00:00Z" }], mong: "2026-08-19T02:00:00.000Z", basis: "CARRIER_DOCUMENT" },
    { ten: "chỉ có mốc lấy hàng, không còn sự kiện nào", pickedUpAt: new Date("2026-08-21T02:00:00Z"), events: [], mong: "2026-08-21T02:00:00.000Z", basis: "PICKUP_SNAPSHOT" },
    { ten: "trắng trơn", pickedUpAt: null, events: [], mong: null, basis: "NONE" },
    { ten: "chỉ có bản sao Pancake", pickedUpAt: null, events: [{ source: "PANCAKE", stage: "DELIVERED", at: "2026-08-15T02:00:00Z" }], mong: null, basis: "NONE" },
    { ten: "chép tay từ trang ĐVVC", pickedUpAt: null, events: [{ source: "VTP_UI_MANUAL_VERIFICATION", stage: "PICKED_UP", at: "2026-08-17T02:00:00Z" }], mong: "2026-08-17T02:00:00.000Z", basis: "MANUAL_DOCUMENT" },
    { ten: "chỉ có sự kiện chiều hoàn", pickedUpAt: null, events: [{ source: "VTP_WEBHOOK", stage: "RETURNED", at: "2026-08-28T02:00:00Z" }], mong: "2026-08-28T02:00:00.000Z", basis: "CARRIER_DOCUMENT" },
  ];

  try {
    for (const [i, ca] of CAC_CA.entries()) {
      const sid = `${P}s${i}`;
      await db.insert(schema.shipments).values({ id: sid, vtpOrderNumber: `${P}T${i}`, trackingCode: `${P}T${i}`, stage: "PENDING", pickedUpAt: ca.pickedUpAt, createdAt: new Date("2026-08-01T00:00:00Z") }).onConflictDoNothing();
      for (const [j, e] of ca.events.entries()) {
        await db
          .insert(schema.shipmentEvents)
          .values({ id: `${P}e${i}-${j}`, shipmentId: sid, source: e.source, status: "x", statusName: "x", occurredAt: new Date(e.at), normalizedStage: e.stage })
          .onConflictDoNothing();
      }
    }

    const rows = await db
      .select({
        id: schema.shipments.id,
        at: sql<Date | null>`${sql.raw(CARRIER_HANDOFF_AT_SQL)}`,
        basis: sql<string>`${sql.raw(CARRIER_HANDOFF_BASIS_SQL)}`,
      })
      .from(schema.shipments)
      .where(sql`${schema.shipments.id} like ${`${P}%`}`);

    assert.equal(rows.length, CAC_CA.length, "đủ số vận đơn thử");
    const theoId = new Map(rows.map((r) => [r.id, r]));

    for (const [i, ca] of CAC_CA.entries()) {
      const sql_ = theoId.get(`${P}s${i}`);
      assert.ok(sql_, `${ca.ten}: thiếu dòng`);
      const sqlAt = sql_.at ? new Date(sql_.at).toISOString() : null;
      assert.equal(sqlAt, ca.mong, `SQL · ${ca.ten}`);
      assert.equal(sql_.basis, ca.basis, `SQL căn cứ · ${ca.ten}`);

      // Bản sinh đôi bằng TypeScript đọc CÙNG dữ liệu và phải ra CÙNG kết quả. Hai bản nói khác
      // nhau nghĩa là một trong hai đang chạy sai ở production mà không ai thấy.
      const ts = carrierHandoffFrom(
        ca.events.map((e) => ({ source: e.source, normalizedStage: e.stage, occurredAt: new Date(e.at) })),
        ca.pickedUpAt,
      );
      assert.equal(ts.at ? ts.at.toISOString() : null, sqlAt, `TypeScript và SQL phải khớp · ${ca.ten}`);
      assert.equal(ts.basis, sql_.basis, `căn cứ của hai bản phải khớp · ${ca.ten}`);
    }

    // PHÁT LẠI TRÊN CSDL: ghi lại đúng gói tin cũ (khoá tự nhiên chặn trùng) không đổi mốc.
    const truoc = theoId.get(`${P}s0`)?.at;
    await db.insert(schema.shipmentEvents).values({ id: `${P}e0-replay`, shipmentId: `${P}s0`, source: "VTP_WEBHOOK", status: "x", statusName: "x", occurredAt: new Date("2026-08-20T02:00:00Z"), normalizedStage: "PICKED_UP" }).onConflictDoNothing();
    const [sau] = await db.select({ at: sql<Date | null>`${sql.raw(CARRIER_HANDOFF_AT_SQL)}` }).from(schema.shipments).where(eq(schema.shipments.id, `${P}s0`));
    assert.equal(sau.at ? new Date(sau.at).toISOString() : null, truoc ? new Date(truoc).toISOString() : null, "phát lại gói tin trùng KHÔNG đổi mốc bàn giao — Viettel Post thử lại tới 5 lần");

    console.log(`✓ Mốc bàn giao (SQL): ${CAC_CA.length} ca, SQL và TypeScript ra cùng kết quả từng ca · phát lại gói tin không đổi mốc`);
  } finally {
    await db.delete(schema.shipmentEvents).where(sql`${schema.shipmentEvents.shipmentId} like ${`${P}%`}`);
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} like ${`${P}%`}`);
  }
}

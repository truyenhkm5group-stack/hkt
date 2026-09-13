import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { listProductCodes, productCodesOfShipments, variantIdsOfCodes } from "@/lib/queries/product-code";
import { listShipments } from "@/lib/queries/shipments";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { reasonFromStatusText, reasonsForShipments } from "@/lib/queries/return-reason";
import { parseListParams } from "@/lib/search-params";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════════════ MÃ HÀNG · LÝ DO HOÀN · HỢP ĐỒNG TỶ LỆ HOÀN ═══════════════
 *
 * SỰ CỐ THẬT dẫn tới bản này: `/shipments?view=all&q=Q004` không ra kết quả. Nguyên nhân KHÔNG
 * chỉ là "ô tìm kiếm chưa tìm hàng hoá" — mà là cách sửa hiển nhiên cũng sai:
 *
 *   Đo production 13/09/2026 — SKU của bốn mã hàng đang bán:
 *     Q002 → `002 DEN 2XL`   ← KHÔNG chứa "Q002"
 *     Q004 → `Q004DEN2XL`    ← viết liền
 *     Q001 → `Q001 2XL DEN`  ← đảo thứ tự thuộc tính
 *
 *   ⇒ `sku ilike '%Q002%'` trả 0 dòng cho chính mã bán chạy nhất (1.236 đơn).
 *
 * Bài kiểm này dựng đúng bốn quy ước đặt tên đó, nên một ngày ai đó "tối ưu" bằng cách khớp chuỗi
 * sẽ thấy đỏ ngay thay vì thấy một danh sách trống trên production.
 */

const ngay = (s: string) => new Date(`${s}T03:00:00Z`);
const P = "spr-";

function paramsOf(raw: Record<string, string> = {}) {
  return parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["product", "stage", "care", "carrier", "cod", "owner", "source", "final", "linked"], sortable: ["createdAt"], defaultPeriod: "all" });
}

export async function testShipmentProductReport(db: Db) {
  /* ═══ GIEO: 3 mã hàng với BA QUY ƯỚC SKU KHÁC NHAU, đúng như production ═══ */
  await db.insert(schema.products).values([
    { id: `${P}p2`, name: "Đầm Q002", customId: "SPRQ002" },
    { id: `${P}p4`, name: "Đầm Q004", customId: "SPRQ004" },
    { id: `${P}p1`, name: "Q001", customId: "SPRQ001" },
  ]).onConflictDoNothing();

  await db.insert(schema.productVariants).values([
    // Mã SPRQ002 — SKU KHÔNG chứa chuỗi mã. Đây là cái bẫy.
    { id: `${P}v2a`, productId: `${P}p2`, sku: "002 DEN 2XL", color: "Đen", size: "2XL" },
    { id: `${P}v2b`, productId: `${P}p2`, sku: "002 DO XL", color: "Đỏ", size: "XL" },
    { id: `${P}v4a`, productId: `${P}p4`, sku: "SPRQ004DEN2XL", color: "Đen", size: "2XL" },
    { id: `${P}v1a`, productId: `${P}p1`, sku: "SPRQ001 2XL DEN", color: "Đen", size: "2XL" },
  ]).onConflictDoNothing();

  const don = (id: string, day: string) => ({ id, stage: "CONFIRMED" as const, status: 2, insertedAt: ngay(day), billFullName: "Khách " + id, totalPriceAfterDiscount: 500_000 });
  await db.insert(schema.orders).values([
    don(`${P}o1`, "2026-08-01"),
    don(`${P}o2`, "2026-08-02"),
    don(`${P}o3`, "2026-08-03"),
    don(`${P}o4`, "2026-08-04"),
    { ...don(`${P}oNew`, "2026-08-05"), stage: "NEW" as const },
  ]).onConflictDoNothing();

  await db.insert(schema.orderItems).values([
    { id: `${P}i1`, orderId: `${P}o1`, variantId: `${P}v2a`, productName: "Đầm Q002", sku: "002 DEN 2XL", quantity: 1 },
    // o2 có HAI dòng CÙNG một mã — không được làm vận đơn hiện hai lần.
    { id: `${P}i2a`, orderId: `${P}o2`, variantId: `${P}v2a`, productName: "Đầm Q002", sku: "002 DEN 2XL", quantity: 1 },
    { id: `${P}i2b`, orderId: `${P}o2`, variantId: `${P}v2b`, productName: "Đầm Q002", sku: "002 DO XL", quantity: 2 },
    // o3 có HAI MÃ HÀNG khác nhau — mơ hồ khi quy lý do hoàn.
    { id: `${P}i3a`, orderId: `${P}o3`, variantId: `${P}v2a`, productName: "Đầm Q002", sku: "002 DEN 2XL", quantity: 1 },
    { id: `${P}i3b`, orderId: `${P}o3`, variantId: `${P}v4a`, productName: "Đầm Q004", sku: "SPRQ004DEN2XL", quantity: 1 },
    { id: `${P}i4`, orderId: `${P}o4`, variantId: `${P}v4a`, productName: "Đầm Q004", sku: "SPRQ004DEN2XL", quantity: 1 },
    // Hàng TẶNG: không được coi là "đơn của mã đó".
    { id: `${P}i4b`, orderId: `${P}o4`, variantId: `${P}v1a`, productName: "Q001", sku: "SPRQ001 2XL DEN", quantity: 1, isBonus: true },
    // Dòng gõ tay: không variant, không product — KHÔNG được đoán mã từ tên.
    { id: `${P}i1b`, orderId: `${P}o1`, variantId: null, productId: null, productName: "2 đầm SPRQ004 nâu + đỏ sz xl", sku: "", quantity: 2 },
  ]).onConflictDoNothing();

  await db.insert(schema.shipments).values([
    { id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: `${P}T1`, trackingCode: `${P}T1`, stage: "DELIVERED", codCollected: 500_000, deliveredAt: ngay("2026-08-10"), createdAt: ngay("2026-08-01"), isFinal: true },
    { id: `${P}s2`, orderId: `${P}o2`, vtpOrderNumber: `${P}T2`, trackingCode: `${P}T2`, stage: "RETURNED", createdAt: ngay("2026-08-02"), isFinal: true },
    { id: `${P}s3`, orderId: `${P}o3`, vtpOrderNumber: `${P}T3`, trackingCode: `${P}T3`, stage: "RETURNED", createdAt: ngay("2026-08-03"), isFinal: true },
    { id: `${P}s4`, orderId: `${P}o4`, vtpOrderNumber: `${P}T4`, trackingCode: `${P}T4`, stage: "RETURNED", createdAt: ngay("2026-08-04"), isFinal: true },
    // VẬN ĐƠN CHIỀU VỀ `…1P1`: order_id NULL. Phải nằm NGOÀI mọi KPI của đơn bán gốc.
    { id: `${P}sLeg`, orderId: null, orderReference: `${P}T2`, vtpOrderNumber: `${P}T21P1`, trackingCode: `${P}T21P1`, stage: "RETURNED", createdAt: ngay("2026-08-09"), isFinal: true },
  ]).onConflictDoNothing();

  // Sự kiện ĐVVC: chỉ MỘT kiện có lý do thật; hai kiện kia chỉ có BƯỚC ĐI, không phải lý do.
  await db.insert(schema.shipmentEvents).values([
    { id: `${P}e1`, shipmentId: `${P}s2`, source: "VTP_WEBHOOK", status: "506", statusName: "Tồn - Khách hàng nghỉ, không có nhà", occurredAt: ngay("2026-08-06") },
    { id: `${P}e2`, shipmentId: `${P}s3`, source: "VTP_WEBHOOK", status: "505", statusName: "Tồn - Thông báo chuyển hoàn bưu cục gốc", occurredAt: ngay("2026-08-07") },
    { id: `${P}e3`, shipmentId: `${P}s4`, source: "VTP_WEBHOOK", status: "502", statusName: "Chuyển hoàn bưu cục gốc", occurredAt: ngay("2026-08-08") },
  ]).onConflictDoNothing();

  clearMemo();

  /* ═══ 1 · MÃ HÀNG LẦN RA ĐÚNG VẬN ĐƠN, DÙ SKU KHÔNG CHỨA MÃ ═══ */
  const q002 = await listShipments(paramsOf({ product: "SPRQ002" }));
  const ids002 = q002.rows.map((r) => r.id).filter((x) => x.startsWith(P)).sort();
  assert.deepEqual(ids002, [`${P}s1`, `${P}s2`, `${P}s3`], "SPRQ002 phải ra 3 vận đơn — SKU của nó (`002 DEN 2XL`) KHÔNG chứa chuỗi mã, nên khớp chuỗi sẽ trượt hết");

  /* ═══ 2 · ĐƠN NHIỀU DÒNG CÙNG MÃ KHÔNG LÀM VẬN ĐƠN HIỆN HAI LẦN ═══ */
  assert.equal(ids002.filter((x) => x === `${P}s2`).length, 1, "đơn có hai dòng cùng mã vẫn chỉ là MỘT vận đơn — `EXISTS`, không `JOIN`");

  /* ═══ 3 · HÀNG TẶNG KHÔNG TÍNH LÀ ĐƠN CỦA MÃ ĐÓ ═══ */
  const q001 = await listShipments(paramsOf({ product: "SPRQ001" }));
  assert.equal(q001.rows.filter((r) => r.id === `${P}s4`).length, 0, "mã chỉ xuất hiện ở dòng hàng TẶNG thì không phải đơn của mã đó");

  /* ═══ 4 · MÃ KHÔNG TỒN TẠI ⇒ 0 DÒNG, KHÔNG PHẢI CẢ KHO ═══ */
  const khongCo = await listShipments(paramsOf({ product: "SPRKHONGCO" }));
  assert.equal(khongCo.total, 0, "mã không có trong danh mục phải ra 0 dòng — bỏ qua bộ lọc và trả cả kho là lỗ hổng, không phải tiện lợi");
  const { unknown } = await variantIdsOfCodes(["SPRKHONGCO"]);
  assert.deepEqual(unknown, ["SPRKHONGCO"], "và phải nói được mã nào không tồn tại");

  /* ═══ 5 · MÃ HÀNG + TRẠNG THÁI, MÃ HÀNG + KHOẢNG THỜI GIAN ═══ */
  const q002Hoan = await listShipments(paramsOf({ product: "SPRQ002", stage: "RETURNED" }));
  assert.deepEqual(q002Hoan.rows.map((r) => r.id).filter((x) => x.startsWith(P)).sort(), [`${P}s2`, `${P}s3`], "kết hợp mã hàng + trạng thái");

  const q002Ngay = await listShipments(paramsOf({ product: "SPRQ002", period: "custom", from: "2026-08-02", to: "2026-08-02" }));
  assert.deepEqual(q002Ngay.rows.map((r) => r.id).filter((x) => x.startsWith(P)), [`${P}s2`], "kết hợp mã hàng + khoảng thời gian");

  /* ═══ 6 · MÃ HÀNG HIỆN TRÊN DÒNG, DÒNG GÕ TAY KHÔNG BỊ ĐOÁN MÃ ═══ */
  const codes = await productCodesOfShipments([`${P}s1`, `${P}s3`]);
  assert.deepEqual(codes.get(`${P}s1`)?.codes, ["SPRQ002"], "vận đơn một mã");
  assert.equal(codes.get(`${P}s1`)?.unmapped, 1, "dòng gõ tay 'đầm SPRQ004' phải vào nhóm CHƯA GHÉP ĐƯỢC — tên có chữ mã không phải là bằng chứng");
  assert.deepEqual(codes.get(`${P}s3`)?.codes, ["SPRQ002", "SPRQ004"], "vận đơn hai mã hiện cả hai");

  /* ═══ 7 · LÝ DO HOÀN: CHỮ MANG LÝ DO vs CHỮ CHỈ LÀ BƯỚC ĐI ═══ */
  assert.equal(reasonFromStatusText("Tồn - Khách hàng nghỉ, không có nhà"), "CUSTOMER_UNREACHABLE");
  assert.equal(reasonFromStatusText("Tồn - Thông báo chuyển hoàn bưu cục gốc"), null, "'thông báo chuyển hoàn' là BƯỚC ĐI, không phải lý do — nhận nhầm sẽ tạo một nhãn chiếm 18% báo cáo mà không hành động được");
  assert.equal(reasonFromStatusText("Chuyển hoàn bưu cục gốc"), null);
  assert.equal(reasonFromStatusText("Giao thành công"), null);

  const verdicts = await reasonsForShipments([`${P}s2`, `${P}s3`, `${P}s4`]);
  assert.equal(verdicts.get(`${P}s2`)?.reason, "CUSTOMER_UNREACHABLE");
  assert.equal(verdicts.get(`${P}s2`)?.confidence, "CARRIER_TEXT", "suy từ chữ ⇒ độ tin cậy phải nói rõ là suy, không phải xác nhận");
  assert.equal(verdicts.get(`${P}s3`)?.reason, "UNKNOWN", "chỉ có bước đi ⇒ CHƯA XÁC ĐỊNH, không bịa");
  assert.equal(verdicts.get(`${P}s4`)?.confidence, "NONE");

  /* ═══ 8 · NGƯỜI XÁC NHẬN ĐÈ LÊN SUY LUẬN ═══ */
  await db.insert(schema.shipmentReturnReasons).values({
    id: `${P}r1`,
    shipmentId: `${P}s3`,
    reason: "WRONG_ADDRESS",
    note: "Gọi khách, nhà chuyển đi từ tháng trước",
    inferredReason: "UNKNOWN",
    actorEmail: "nv@t.local",
  }).onConflictDoNothing();
  const sauGhiDe = await reasonsForShipments([`${P}s3`]);
  assert.equal(sauGhiDe.get(`${P}s3`)?.reason, "WRONG_ADDRESS", "người vừa gọi cho khách biết nhiều hơn mọi suy luận");
  assert.equal(sauGhiDe.get(`${P}s3`)?.confidence, "CONFIRMED");
  assert.ok(sauGhiDe.get(`${P}s3`)?.evidence.includes("nv@t.local"), "và phải ghi rõ AI xác nhận");

  /* ═══ 9 · BÁO CÁO: MẪU SỐ ĐÚNG HỢP ĐỒNG, `1P1` VÀ ĐƠN "MỚI" NẰM NGOÀI ═══ */
  clearMemo();
  const bc = await getReturnReasonReport({ period: { key: "custom", from: ngay("2026-07-01"), to: ngay("2026-09-01"), label: "kiểm thử", fromKey: null, toKey: null } });
  const cuaTa = bc.products.filter((p) => p.code.startsWith("SPR"));
  const q002Row = cuaTa.find((p) => p.code === "SPRQ002");
  assert.ok(q002Row, "phải có dòng cho SPRQ002");
  assert.equal(q002Row!.finished, 3, "3 đơn có kết quả cuối (o1 giao, o2 + o3 hoàn) — đơn NEW và vận đơn 1P1 KHÔNG được vào mẫu số");
  assert.equal(q002Row!.delivered, 1);
  assert.equal(q002Row!.returned, 2);
  assert.equal(q002Row!.returnRate, 66.7);

  // TRÙNG KHỚP: tổng theo lý do phải bằng tổng đơn hoàn.
  const tongTheoLyDo = bc.reasons.reduce((a, r) => a + r.count, 0);
  assert.equal(tongTheoLyDo, bc.returned, "cộng các lý do phải ra đúng tổng đơn hoàn — lệch nghĩa là có đơn rơi mất hoặc bị đếm hai lần");

  /* ═══ 10 · ĐƠN NHIỀU MÃ KHÔNG BỊ GÁN LÝ DO GIẢ CHO TỪNG MÃ ═══ */
  const q004Row = cuaTa.find((p) => p.code === "SPRQ004");
  assert.ok(q004Row, "SPRQ004 phải có mặt (đơn o3 hai mã + đơn o4)");
  assert.equal(q004Row!.finished, 2, "đơn hai mã được đếm cho CẢ HAI mã — cả hai đều bị ảnh hưởng");
  assert.ok(bc.multiSkuOrders >= 1, "và số đơn nhiều mã phải hiện ra, vì tổng theo mã sẽ lớn hơn tổng thật đúng bằng phần đó");

  /* ═══ 11 · ĐỘ PHỦ LÝ DO KHÔNG ĐƯỢC GIẤU ═══ */
  assert.equal(bc.reasonCoverage.known + bc.reasonCoverage.unknown, bc.returned, "biết + chưa biết phải bằng tổng hoàn");
  assert.ok(bc.reasonCoverage.unknown > 0, "bộ dữ liệu này CÓ đơn không xác định được lý do, và báo cáo phải nói ra");

  /* ═══ 12 · DANH MỤC MÃ HÀNG ═══ */
  const danhMuc = await listProductCodes();
  assert.ok(danhMuc.some((p) => p.code === "SPRQ002" && p.variantIds.length === 2), "danh mục phải gom đủ mẫu mã của một mã hàng");

  // Dọn — kho kiểm thử dùng chung một CSDL.
  await db.execute(sql`delete from shipment_return_reasons where id like ${P + "%"}`);
  await db.execute(sql`delete from shipment_events where id like ${P + "%"}`);
  await db.execute(sql`delete from shipments where id like ${P + "%"}`);
  await db.execute(sql`delete from order_items where id like ${P + "%"}`);
  await db.execute(sql`delete from orders where id like ${P + "%"}`);
  await db.execute(sql`delete from product_variants where id like ${P + "%"}`);
  await db.execute(sql`delete from products where id like ${P + "%"}`);
  clearMemo();

  console.log(
    `✓ Mã hàng & lý do hoàn: SKU không chứa mã vẫn lần ra đúng (quan hệ, không chuỗi) · đơn nhiều dòng không nhân vận đơn · hàng tặng không tính · mã lạ ⇒ 0 dòng · dòng gõ tay KHÔNG bị đoán mã · "thông báo chuyển hoàn" không phải lý do · người xác nhận đè suy luận · mẫu số loại đơn NEW và vận đơn 1P1 · tổng theo lý do = tổng hoàn · đơn nhiều mã không bị gán lý do giả`,
  );
}

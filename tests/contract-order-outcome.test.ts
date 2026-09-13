import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { OUTCOME_LABEL, RETURN_RULE } from "@/lib/constants/returns";
import { OUTCOME_GROUP } from "@/lib/constants/truth";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED } from "@/lib/queries/return-rate";

/**
 * CONTRACT TEST — khoá các luật nghiệp vụ ở docs/business-rules/ORDER_OUTCOME.md.
 *
 * Đỏ ở đây nghĩa là CODE SAI, không phải test sai. Không được sửa giá trị kỳ vọng để CI xanh;
 * muốn đổi luật thì sửa đặc tả trước, và việc đó do chủ sở hữu kho mã quyết định.
 */

let seq = 0;
const next = () => `ct-${++seq}`;

type Setup = {
  orderStage?: string;
  shipmentStage?: string;
  codAmount?: number;
  codCollected?: number;
  codStatus?: "NOT_APPLICABLE" | "PENDING" | "COLLECTED" | "RECONCILED" | "PAID_TO_BANK" | "DISPUTED";
  statementRef?: string | null;
  prepaid?: number;
  orderCod?: number;
  /** Sự kiện Viettel Post thật — chỉ nó mới được quyền kết luận trạng thái giao hàng. */
  vtpEvents?: { status: string; stage: string; leg?: "OUTBOUND" | "RETURN" }[];
  /** Vận đơn chiều hoàn do Viettel Post tạo, trỏ về mã gốc. */
  returnLeg?: boolean;
  /** Mốc lấy hàng đã lưu trên vận đơn — một trong ba bậc chứng cứ bàn giao. */
  pickedUpAt?: Date | null;
};

async function build(db: Db, s: Setup) {
  const id = next();
  const code = `PKE-${id}`;
  await db.insert(schema.orders).values({
    id,
    stage: (s.orderStage ?? "SHIPPED") as never,
    cod: s.orderCod ?? 0,
    prepaid: s.prepaid ?? 0,
    insertedAt: new Date(),
  });
  const [ship] = await db
    .insert(schema.shipments)
    .values({
      orderId: id,
      vtpOrderNumber: code,
      trackingCode: code,
      stage: (s.shipmentStage ?? "IN_TRANSIT") as never,
      codAmount: s.codAmount ?? 0,
      codCollected: s.codCollected ?? 0,
      codStatus: (s.codStatus ?? "PENDING") as never,
      codStatementRef: s.statementRef ?? null,
      deliveredAt: s.shipmentStage === "DELIVERED" ? new Date("2026-09-01T10:00:00Z") : null,
      pickedUpAt: s.pickedUpAt ?? null,
      vtpStatusDate: new Date("2026-09-01T10:00:00Z"),
    })
    .returning({ id: schema.shipments.id });

  for (const [i, e] of (s.vtpEvents ?? []).entries()) {
    await db.insert(schema.shipmentEvents).values({
      shipmentId: ship.id,
      source: "VTP_WEBHOOK",
      status: e.status,
      statusName: e.status,
      occurredAt: new Date(2026, 8, 1, 10 + i, 0, 0),
      normalizedStage: e.stage as never,
      legType: e.leg ?? "OUTBOUND",
    });
  }
  if (s.returnLeg) {
    await db.insert(schema.shipments).values({
      vtpOrderNumber: `${code}1P1`,
      trackingCode: `${code}1P1`,
      orderReference: code,
      stage: "RETURNING",
      codAmount: 0,
    });
  }
  return id;
}

async function outcome(db: Db, id: string) {
  const [r] = await db
    .select({ v: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, id));
  return r;
}

export async function testOrderOutcomeContract(db: Db) {
  const check = async (label: string, setup: Setup, expected: string) => {
    const id = await build(db, setup);
    const r = await outcome(db, id);
    assert.equal(r?.v, expected, `${label} — xem docs/business-rules/ORDER_OUTCOME.md`);
  };

  // ───────── Tiền KHÔNG BAO GIỜ suy ra trạng thái giao hàng ─────────
  await check(
    "đang giao + đã thu 499K vẫn là ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-1", vtpEvents: [{ status: "300", stage: "IN_TRANSIT" }] },
    "IN_TRANSIT",
  );
  await check(
    "đang hoàn + đã thu 499K vẫn là HOÀN",
    { shipmentStage: "RETURNING", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-2", vtpEvents: [{ status: "505", stage: "RETURNING" }] },
    "RETURNED",
  );
  await check(
    "đã hoàn + tiền đã về ngân hàng vẫn là HOÀN",
    { shipmentStage: "RETURNED", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-3", vtpEvents: [{ status: "504", stage: "RETURNED" }] },
    "RETURNED",
  );
  // Chủ shop chốt 08/09/2026: KHÔNG có dấu vết nào của ĐVVC thì kết quả là CHƯA BIẾT, không phải
  // "đang giao" — nói "đang giao" là bịa ra một sự kiện vận chuyển chưa từng được chứng minh.
  // Đặc tả đã sửa tương ứng (mục 2 và bảng chân lý mục 6).
  await check(
    "Pancake báo đã thanh toán, không mã vận đơn, không sự kiện ĐVVC ⇒ CHƯA BIẾT",
    { orderStage: "PAID", shipmentStage: "PENDING", orderCod: 499_000, codStatus: "COLLECTED" },
    "UNKNOWN",
  );

  // ───────── Ranh giới tiền, chỉ áp dụng khi ĐÃ giao thật ─────────
  const daGiao = (collected: number): Setup => ({
    shipmentStage: "DELIVERED",
    codAmount: 499_000,
    codCollected: collected,
    statementRef: "BK-X",
    vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }],
  });
  await check("giao + xác minh 49.999 → HOÀN", daGiao(49_999), "RETURNED");
  await check("giao + xác minh 50.000 → KHÔNG THÀNH CÔNG", daGiao(50_000), "RETURNED_BY_RULE");
  await check("giao + xác minh 100.000 → KHÔNG THÀNH CÔNG", daGiao(100_000), "RETURNED_BY_RULE");
  await check("giao + xác minh 100.001 → GIAO THÀNH CÔNG", daGiao(100_001), "DELIVERED");
  assert.equal(RETURN_RULE.maxCodForReturn, 50_000, "ngưỡng hoàn phải là 50.000");
  assert.equal(RETURN_RULE.maxCodForFakeDelivery, 100_000, "ngưỡng giao thành công phải là 100.000");

  // ───────── Chiều hoàn ─────────
  await check(
    "mã 501 của CHIỀU HOÀN không phải giao thành công tới khách",
    { shipmentStage: "DELIVERED", codAmount: 499_000, vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "RETURN" }] },
    "RETURNED",
  );
  await check(
    "có vận đơn chiều hoàn thì hàng đã quay về, dù ĐVVC ghi 501",
    { shipmentStage: "DELIVERED", codAmount: 499_000, returnLeg: true, vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "RETURNED",
  );

  // ───────── HAI CA THẬT chủ shop đã chỉ ra hai lần — không được ghi nhận giống nhau ─────────
  // PKE1508909064: VTP ghi giao thành công, thu hộ 849.000, KHÔNG sửa doanh thu, KHÔNG có vận đơn
  // chiều hoàn. Vận đơn có mã bảng kê nhưng cod_collected = 0 vì bảng kê chỉ nhắc tới phần cước.
  // "Có mã bảng kê" KHÔNG phải bằng chứng "thu 0đ" — coi vậy là biến CHƯA BIẾT thành 0.
  await check(
    "ca PKE1508909064: có mã bảng kê nhưng chưa có số thực thu thì KHÔNG được kết luận hoàn",
    { shipmentStage: "DELIVERED", codAmount: 849_000, codCollected: 0, codStatus: "NOT_APPLICABLE", statementRef: "BK-FEE-ONLY",
      vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "DELIVERED",
  );
  // PKE1508909058: cùng mã 501, cùng COD khai báo, cùng cod_collected = 0 — nhưng Viettel Post đã
  // tạo vận đơn ...1P1 mang hàng về shop. Hai đơn này PHẢI cho kết quả khác nhau.
  await check(
    "ca PKE1508909058: cùng dữ liệu tiền nhưng có vận đơn chiều hoàn thì là ĐƠN HOÀN",
    { shipmentStage: "DELIVERED", codAmount: 849_000, codCollected: 0, codStatus: "NOT_APPLICABLE", statementRef: "BK-FEE-ONLY", returnLeg: true,
      vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "RETURNED",
  );

  // ───────── UNKNOWN không phải 0 ─────────
  const chuaCoChungTu = await build(db, {
    shipmentStage: "DELIVERED",
    codAmount: 499_000,
    codCollected: 0,
    statementRef: null,
    vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }],
  });
  const r = await outcome(db, chuaCoChungTu);
  assert.equal(r?.v, "DELIVERED", "logistics đã giao thì kết quả GIAO HÀNG là DELIVERED");
  assert.equal(r?.verified, "UNVERIFIED", "chưa có chứng từ tiền là CHƯA XÁC MINH, không được coi là thu 0đ");

  // ───────── Hàng hoàn không tự vào tồn ─────────
  const hoan = await build(db, { shipmentStage: "RETURNED", codAmount: 499_000, vtpEvents: [{ status: "504", stage: "RETURNED" }] });
  const [shipHoan] = await db
    .select({ nhan: schema.shipments.returnReceivedAt })
    .from(schema.shipments)
    .where(eq(schema.shipments.orderId, hoan));
  assert.equal(shipHoan.nhan, null, "đơn hoàn KHÔNG tự sinh mốc kho nhận hàng — tồn chỉ tăng khi kho xác nhận");

  /* ═══════════ ĐVVC CHƯA CẦM HÀNG THÌ KHÔNG ĐƯỢC GỌI LÀ "ĐANG GIAO" ═══════════

     Chủ shop chốt 13/09/2026. Cùng một nguyên tắc với `UNKNOWN`: "đang giao" là khẳng định về VỊ
     TRÍ gói hàng, phải có chứng từ mới nói được.

     Đo production 13/09/2026: 106 đơn mang nhãn `IN_TRANSIT` mà toàn bộ sự kiện ĐVVC của chúng là
     "phân công bưu tá", "chờ xử lý", "khách chưa chuẩn bị xong hàng" — tức bưu tá ĐANG TỚI LẤY chứ
     chưa lấy. 61.451.999đ COD nằm trên những gói hàng chủ shop tưởng đang trên đường tới khách. */

  await check(
    "chỉ có sự kiện điều phối bưu tá ⇒ CHỜ LẤY HÀNG, không phải đang giao",
    { shipmentStage: "PENDING", codAmount: 499_000, vtpEvents: [{ status: "104", stage: "PENDING" }] },
    "AWAITING_PICKUP",
  );
  await check(
    "chặng nói ĐANG GIAO nhưng không một sự kiện nào chứng minh đã cầm hàng ⇒ vẫn là CHỜ LẤY HÀNG",
    { shipmentStage: "IN_TRANSIT", codAmount: 499_000, vtpEvents: [{ status: "102", stage: "PENDING" }] },
    "AWAITING_PICKUP",
  );
  await check(
    "có MỐC LẤY HÀNG trên vận đơn ⇒ đã bàn giao, là ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codAmount: 499_000, pickedUpAt: new Date("2026-09-01T09:00:00Z"), vtpEvents: [{ status: "102", stage: "PENDING" }] },
    "IN_TRANSIT",
  );
  await check(
    "có sự kiện ĐÃ LẤY HÀNG ⇒ ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codAmount: 499_000, vtpEvents: [{ status: "103", stage: "PICKED_UP" }] },
    "IN_TRANSIT",
  );

  /* Nhánh mới phải đứng SAU mọi kết cục: một kiện đã tới tay khách thì chuyện mốc lấy hàng có được
     ghi lại hay không cũng không làm nó thành "chờ lấy". Đây là cách hỏng dễ xảy ra nhất nếu ai đó
     dời nhánh lên trên. */
  await check(
    "đã giao tới khách, thu 499K, KHÔNG có mốc lấy hàng ⇒ vẫn GIAO THÀNH CÔNG",
    { shipmentStage: "DELIVERED", codAmount: 499_000, codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-AP1", vtpEvents: [{ status: "501", stage: "DELIVERED" }] },
    "DELIVERED",
  );
  await check(
    "hàng đã quay về shop, KHÔNG có mốc lấy hàng ⇒ vẫn HOÀN",
    { shipmentStage: "RETURNED", codAmount: 499_000, vtpEvents: [{ status: "504", stage: "RETURNED" }] },
    "RETURNED",
  );
  await check(
    "đơn đã huỷ mà ĐVVC chưa lấy ⇒ HUỶ, không phải chờ lấy hàng",
    { orderStage: "CANCELLED", shipmentStage: "PENDING", codAmount: 499_000, vtpEvents: [{ status: "104", stage: "PENDING" }] },
    "CANCELLED",
  );

  /* CHỜ LẤY HÀNG KHÔNG PHẢI "ĐÃ GỬI", và cũng không phải "chưa tạo vận đơn".

     Hai điều này là toàn bộ lý do giá trị mới tồn tại. Gộp vào `NOT_SHIPPED` thì mất mã vận đơn để
     tra và mất người để giục; đếm vào "đã gửi" thì 106 kiện chưa rời kho lại vào mẫu số như cũ. */
  const choLay = await build(db, { shipmentStage: "PENDING", codAmount: 499_000, vtpEvents: [{ status: "104", stage: "PENDING" }] });
  const rChoLay = await outcome(db, choLay);
  assert.equal(rChoLay?.v, "AWAITING_PICKUP");
  assert.notEqual(rChoLay?.v, "NOT_SHIPPED", "phải tách khỏi 'chưa gửi' — kiện này CÓ mã vận đơn và CÓ người phải đi giục");
  assert.equal(OUTCOME_GROUP.AWAITING_PICKUP, "OPEN", "chưa rời kho thì CHƯA KẾT THÚC — không vào tử số lẫn mẫu số tỷ lệ giao thành công");
  assert.equal(OUTCOME_GROUP.AWAITING_PICKUP, OUTCOME_GROUP.IN_TRANSIT, "cùng nhóm với 'đang giao' nên đổi nhãn KHÔNG làm xê dịch một tỷ lệ nào");
  assert.ok(OUTCOME_LABEL.AWAITING_PICKUP, "phải có nhãn tiếng Việt");

  // Và "đã gửi" phải KHÔNG chứa nó — đọc thẳng mã nguồn, vì đây là danh sách chuỗi SQL mà trình
  // kiểm kiểu không soi được.
  const nguonRR = readFileSync("lib/queries/return-rate.ts", "utf8");
  const dongDaGui = nguonRR.split("\n").filter((l) => l.includes("IS_SHIPPED = sql") || l.includes("shipped: sql"));
  assert.ok(dongDaGui.length >= 2, "phải tìm thấy các định nghĩa 'đã gửi'");
  for (const dong of dongDaGui) {
    assert.ok(!dong.includes("AWAITING_PICKUP"), `'đã gửi' không được chứa AWAITING_PICKUP — kiện chưa rời kho thì chưa được gửi: ${dong.trim().slice(0, 90)}`);
  }

  // ───────── Chống trôi: chỉ MỘT công thức, và nguồn phải trỏ về đặc tả ─────────
  const spec = readFileSync("docs/business-rules/ORDER_OUTCOME.md", "utf8");
  assert.ok(spec.includes("ORDER_OUTCOME"), "đặc tả phải tồn tại và nêu tên công thức chuẩn");
  const nguon = readFileSync("lib/queries/return-rate.ts", "utf8");
  assert.ok(nguon.includes("docs/business-rules/ORDER_OUTCOME.md"), "nguồn chuẩn phải trỏ về đặc tả");
  const soCongThuc = (nguon.match(/export const ORDER_OUTCOME\b/g) ?? []).length;
  assert.equal(soCongThuc, 1, "chỉ được có ĐÚNG MỘT công thức ORDER_OUTCOME trong toàn kho mã");

  console.log(`✓ Contract kết quả đơn: ${seq} tình huống khoá đúng đặc tả (tiền không suy ra giao hàng · ranh giới 50K/100K · chiều hoàn · UNKNOWN≠0 · CHỜ LẤY HÀNG≠đang giao≠chưa gửi · tồn kho)`);
}

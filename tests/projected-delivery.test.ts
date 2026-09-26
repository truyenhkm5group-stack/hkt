import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  BACKTEST_CONFIDENCE,
  backtestConfidenceOf,
  calibrationSlope,
  isModelledSubstate,
  MODELLED_SUBSTATES,
  NOT_SHIPPED_STATE,
  PROJECTED_GTC_VERSION,
  projectedRateOf,
  summarizeBacktest,
  TRAINING_WINDOW,
  UNMODELLED_SHARE_MAX,
} from "@/lib/constants/projected-delivery";
import { adsRatios, DEFAULT_PROFIT_ASSUMPTIONS } from "@/lib/constants/profit";
import { SUCCESS_RATE_OK } from "@/lib/constants/returns";
import { getProbabilityLookup, getProjectedDeliveryMetrics, getProjectionBacktest, getStateDeliveryProbabilities } from "@/lib/queries/projected-delivery";

/**
 * ═══════════ HỢP ĐỒNG "TL / DT GTC ƯỚC TÍNH" PHIÊN BẢN V4 ═══════════
 *
 * Bài kiểm CÔNG THỨC cho `lib/queries/projected-delivery.ts` + các trang đọc nó. Mỗi khối gắn với một
 * lỗi đã được soát và đo trên production 13/09/2026 (xem docs/audit-metric-parity-2026-09-13.md).
 * Đây không phải contract test nghiệp vụ: đổi hợp đồng thì đổi kỳ vọng ở đây kèm phiên bản.
 */

const P = "pdv-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);
/** Tập HUẤN LUYỆN gửi 40 ngày trước — đủ chín theo mọi cửa sổ hợp lệ. */
const CHIN = 24 * 40;
/** Tập CHẤM gửi 5 ngày trước — chưa đủ chín nên KHÔNG lọt vào tập huấn luyện. */
const TUOI = 24 * 5;

type DonFixture = {
  id: string;
  productId: string;
  /** Trạng thái Pancake của đơn. */
  orderStage?: (typeof schema.orders.$inferInsert)["stage"];
  /** `null` = đơn chưa có vận đơn (NOT_SHIPPED). */
  ship: null | {
    stage: (typeof schema.shipments.$inferInsert)["stage"];
    vtpStatusName?: string;
    codCollected?: number;
    /** Sự kiện hành trình theo thứ tự thời gian: [mã, tên, chiều, chặng chuẩn hoá]. */
    events: [string, string, "OUTBOUND" | "RETURN" | null, (typeof schema.shipmentEvents.$inferInsert)["normalizedStage"]][];
    final?: "DELIVERED" | "RETURNED";
  };
  /** Mốc ĐVVC nhận (giờ trước). */
  luc: number;
  unitCost?: number;
  /**
   * ĐVVC CHƯA CẦM HÀNG: không `picked_up_at`, và mọi sự kiện đều ngoài `CARRIER_HANDOFF_STAGES`.
   * Đó đúng là điều kiện để `ORDER_OUTCOME` kết luận `AWAITING_PICKUP`.
   */
  chuaLayHang?: boolean;
};

async function gieo(db: Db, don: DonFixture[]) {
  for (const d of don) {
    const luc = gio(d.luc);
    await db.insert(schema.orders).values({ id: `${P}o-${d.id}`, stage: d.orderStage ?? "SHIPPED", status: 2, insertedAt: luc, totalPriceAfterDiscount: 500_000 }).onConflictDoNothing();
    await db
      .insert(schema.orderItems)
      .values({ id: `${P}i-${d.id}`, orderId: `${P}o-${d.id}`, variantId: `${P}v-${d.productId}`, productId: `${P}p-${d.productId}`, sku: `PDV-${d.productId}`, productName: `Hàng kiểm V3 ${d.productId}`, variationDetail: "M", quantity: 1, lineTotal: 500_000, unitCost: d.unitCost ?? 200_000, isBonus: false })
      .onConflictDoNothing();
    if (!d.ship) continue;
    const sid = `${P}s-${d.id}`;
    const cuoi = new Date(luc.getTime() + 4 * 86_400_000);
    await db
      .insert(schema.shipments)
      .values({
        id: sid,
        orderId: `${P}o-${d.id}`,
        carrier: "Viettel Post",
        vtpOrderNumber: `${P}${d.id}`.toUpperCase(),
        vtpStatusName: d.ship.vtpStatusName ?? "",
        stage: d.ship.stage,
        isFinal: d.ship.final !== undefined,
        codAmount: 500_000,
        codCollected: d.ship.codCollected ?? 0,
        pickedUpAt: d.chuaLayHang ? null : luc,
        deliveredAt: d.ship.final === "DELIVERED" ? cuoi : null,
        returnedAt: d.ship.final === "RETURNED" ? cuoi : null,
      })
      .onConflictDoNothing();
    for (const [i, [ma, ten, chieu, chang]] of d.ship.events.entries()) {
      await db
        .insert(schema.shipmentEvents)
        .values({ shipmentId: sid, source: "VTP_WEBHOOK", status: ma, statusName: ten, legType: chieu, normalizedStage: chang, occurredAt: new Date(luc.getTime() + (i + 1) * 86_400_000) })
        .onConflictDoNothing();
    }
  }
}

async function don(db: Db) {
  const ids = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(sql`${schema.shipments.id} like ${`${P}s-%`}`)).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
  }
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like ${`${P}i-%`}`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like ${`${P}v-%`}`);
  await db.delete(schema.products).where(sql`${schema.products.id} like ${`${P}p-%`}`);
}

const CHO_PHAT_LAI: DonFixture["ship"] extends infer S ? (S extends { events: infer E } ? E : never) : never = [["", "Chờ phát lại", "OUTBOUND", "DELIVERY_FAILED"]];

/* ───── 1 · Công thức thuần: tỷ lệ ước tính, ngoài ước tính, ngưỡng ───── */
export function testProjectedRateFormula() {
  assert.equal(projectedRateOf({ projectedDelivered: 1, eligibleSent: 2, active: 0, unmodelledActive: 0 }), 50);
  /*
    ĐƠN NGOÀI ƯỚC TÍNH RỜI KHỎI MẪU SỐ. Giữ chúng ở mẫu số mà không có gì ở tử số là ngầm coi P = 0
    cho đúng nhóm mà mô hình vừa thừa nhận không biết gì. Bản V2 làm thế: 8 đã giao + 2 ngoài ước
    tính ⇒ 80%, trong khi sự thật là "8/8 đã biết, 2 chưa biết".
  */
  assert.equal(projectedRateOf({ projectedDelivered: 8, eligibleSent: 10, active: 2, unmodelledActive: 2 }), null, "100% đang giao đều ngoài ước tính ⇒ vượt ngưỡng ⇒ CHƯA ĐO ĐƯỢC");
  assert.equal(projectedRateOf({ projectedDelivered: 8, eligibleSent: 10, active: 4, unmodelledActive: 1 }), Math.round((8 / 9) * 1000) / 10, "1 đơn ngoài ước tính rời khỏi mẫu số");
  assert.equal(projectedRateOf({ projectedDelivered: 0, eligibleSent: 0, active: 0, unmodelledActive: 0 }), null, "cohort rỗng ⇒ null, không phải 0%");
  assert.ok(UNMODELLED_SHARE_MAX > 0 && UNMODELLED_SHARE_MAX < 1, "ngưỡng phải là một tỷ lệ có lý do, không phải 0 hay 1");
  // Trạng thái cuối không bao giờ là trạng thái dự báo.
  for (const s of ["DELIVERED", "RETURNED", "CANCELLED", "RETURNING"]) assert.equal(isModelledSubstate(s), false, `${s} là trạng thái cuối / đã kết thúc theo ORDER_OUTCOME`);
  assert.ok(MODELLED_SUBSTATES.includes("WAITING_PROCESSING") && MODELLED_SUBSTATES.includes("WAITING_REDELIVERY"), "hai trạng thái chờ phải được mô hình hoá RIÊNG");
  assert.ok(TRAINING_WINDOW.maturityDefaultDays >= 7 && TRAINING_WINDOW.maturityCapDays >= TRAINING_WINDOW.maturityDefaultDays, "cửa sổ trưởng thành có mặc định và trần hợp lệ");
}

/* ───── 2 · Thống kê thử ngược: hàm thuần, không CSDL ───── */
export function testBacktestStatsPure() {
  const rong = summarizeBacktest([]);
  assert.equal(rong.n, 0);
  assert.equal(rong.bias, null, "không quan sát ⇒ không có lệch để báo, KHÔNG in 0");
  assert.equal(backtestConfidenceOf({ n: 0, bias: null, slope: null }), "INSUFFICIENT_DATA");

  // 10 kiện, mô hình nói 0,7 cho tất cả, 7 giao được ⇒ lệch 0, Brier = 0,7·0,09 + 0,3·0,49 = 0,21.
  const diem = Array.from({ length: 10 }, (_, i) => ({ shipmentId: `k${i}`, p: 0.7, y: (i < 7 ? 1 : 0) as 0 | 1 }));
  const t = summarizeBacktest(diem);
  assert.equal(t.n, 10);
  assert.equal(t.observations, 10);
  assert.equal(t.bias, 0);
  assert.equal(t.brier, 0.21);
  assert.equal(t.slope, null, "mọi dự báo cùng một giá trị ⇒ không đo được độ dốc hiệu chuẩn — null, không bịa 1");
  assert.equal(backtestConfidenceOf({ n: t.n, bias: t.bias, slope: t.slope }), "LOW", "10 kiện = mẫu nhỏ dù lệch bằng 0");

  // Nhiều ảnh chụp của CÙNG một kiện không được đếm như nhiều mẫu độc lập.
  const lap = summarizeBacktest([{ shipmentId: "a", p: 0.5, y: 1 }, { shipmentId: "a", p: 0.6, y: 1 }, { shipmentId: "a", p: 0.7, y: 1 }]);
  assert.equal(lap.n, 1, "ba ảnh chụp của một kiện ⇒ n = 1");
  assert.equal(lap.observations, 3);

  // Hiệu chuẩn hoàn hảo ở hai thập phân vị: độ dốc = 1; đủ 120 kiện, lệch 0 ⇒ tin cậy cao.
  const hieuChuan = [
    ...Array.from({ length: 60 }, (_, i) => ({ shipmentId: `h${i}`, p: 0.3, y: (i < 18 ? 1 : 0) as 0 | 1 })),
    ...Array.from({ length: 60 }, (_, i) => ({ shipmentId: `c${i}`, p: 0.8, y: (i < 48 ? 1 : 0) as 0 | 1 })),
  ];
  const h = summarizeBacktest(hieuChuan);
  assert.equal(h.n, 120);
  assert.equal(h.bias, 0);
  assert.equal(h.slope, 1, "quan sát đúng bằng dự báo ở mọi thập phân vị ⇒ độ dốc 1");
  assert.equal(h.calibration.length, 2);
  assert.equal(backtestConfidenceOf({ n: h.n, bias: h.bias, slope: h.slope }), "HIGH");
  // Cùng mẫu nhưng mô hình LẠC QUAN 10 điểm ⇒ không còn tin cậy cao / vừa.
  assert.equal(backtestConfidenceOf({ n: 120, bias: 0.1, slope: 1 }), "LOW");
  assert.equal(backtestConfidenceOf({ n: 120, bias: BACKTEST_CONFIDENCE.MEDIUM.maxAbsBias, slope: null }), "MEDIUM", "thiếu độ dốc thì tối đa là tin cậy vừa");
  assert.equal(calibrationSlope([{ from: 0.5, n: 10, predicted: 0.5, observed: 0.5 }]), null, "một điểm không đo được độ dốc");
}

/* ───── 3 · Nhãn huấn luyện theo ORDER_OUTCOME, kiện chưa chín ở ngoài, 503 vào mẫu số ───── */
export async function testTrainingLabelsFromOrderOutcome(db: Db) {
  /*
    V4: tập huấn luyện thuộc CHÍNH mã A — mã sẽ được chấm ở khối sau. Trước V4 nó thuộc một mã T
    riêng, và mã A được cân bằng xác suất học từ mã T: đúng điều chủ shop bác bỏ 26/09/2026.
  */
  await db.insert(schema.products).values({ id: `${P}p-A`, name: "Hàng đang giao", customId: "PDV-A" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v-A`, productId: `${P}p-A`, sku: "PDV-A", retailPrice: 500_000 }).onConflictDoNothing();
  // Mã T chỉ giữ kiện CHƯA CHÍN — nó nằm trong kỳ chấm nên không được lẫn vào số của mã A.
  await db.insert(schema.products).values({ id: `${P}p-T`, name: "Hàng chưa chín V4", customId: "PDV-T" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v-T`, productId: `${P}p-T`, sku: "PDV-T", retailPrice: 500_000 }).onConflictDoNothing();
  const huanLuyen: DonFixture[] = [];
  // 8 kiện chờ phát lại rồi GIAO ĐƯỢC thật (501 chiều đi + thu 499K).
  for (let i = 0; i < 8; i += 1) huanLuyen.push({ id: `t-g${i}`, productId: "A", luc: CHIN, ship: { stage: "DELIVERED", codCollected: 499_000, final: "DELIVERED", events: [...CHO_PHAT_LAI, ["501", "Giao thành công", "OUTBOUND", "DELIVERED"]] } });
  // 2 kiện chuyển hoàn (504).
  for (let i = 0; i < 2; i += 1) huanLuyen.push({ id: `t-h${i}`, productId: "A", luc: CHIN, ship: { stage: "RETURNED", final: "RETURNED", events: [...CHO_PHAT_LAI, ["504", "Chuyển hoàn", "RETURN", "RETURNED"]] } });
  // 1 kiện TIÊU HUỶ (503): stage = CANCELLED nhưng theo luật là ĐƠN HOÀN — V2 làm nó biến mất khỏi mẫu số.
  huanLuyen.push({ id: "t-tieuhuy", productId: "A", luc: CHIN, ship: { stage: "CANCELLED", final: "RETURNED", events: [...CHO_PHAT_LAI, ["503", "Tiêu huỷ", "OUTBOUND", "CANCELLED"]] } });
  // 1 kiện VTP ghi "giao thành công" nhưng thu 30.000đ ⇒ ĐƠN HOÀN theo luật tiền — V2 dạy mô hình là "giao được".
  huanLuyen.push({ id: "t-30k", productId: "A", luc: CHIN, ship: { stage: "DELIVERED", codCollected: 30_000, final: "DELIVERED", events: [...CHO_PHAT_LAI, ["501", "Giao thành công", "OUTBOUND", "DELIVERED"]] } });
  // 1 kiện CHƯA ĐỦ CHÍN (5 ngày) đã giao — không được vào tập huấn luyện dù đã kết thúc.
  huanLuyen.push({ id: "t-tuoi", productId: "T", luc: TUOI, ship: { stage: "DELIVERED", codCollected: 499_000, final: "DELIVERED", events: [...CHO_PHAT_LAI, ["501", "Giao thành công", "OUTBOUND", "DELIVERED"]] } });
  await gieo(db, huanLuyen);

  clearMemo();
  const { states, window } = await getStateDeliveryProbabilities();
  const cpl = states.find((s) => s.substate === "WAITING_REDELIVERY")!;
  assert.equal(cpl.sample, 12, "12 kiện đủ chín từng chờ phát lại: 8 giao + 2 hoàn 504 + 1 tiêu huỷ 503 + 1 thu 30K. Kiện 5 ngày tuổi ở NGOÀI.");
  assert.equal(cpl.delivered, 8, "kiện thu 30.000đ KHÔNG phải giao được dù VTP ghi 501 — nhãn là ORDER_OUTCOME, không phải stage");
  assert.ok(cpl.p !== null && Math.abs(cpl.p - 8 / 12) < 1e-9, "P(chờ phát lại) = 8/12");
  assert.equal(cpl.confidence, "LOW", "12 mẫu ≥ 10 ⇒ dùng được nhưng nhãn là MẪU NHỎ");
  assert.ok(window.trainedUntil.getTime() <= Date.now() - TRAINING_WINDOW.maturityDefaultDays * 86_400_000 + 1000 || window.maturitySource === "MEASURED", "cửa sổ huấn luyện phải cắt trước hôm nay ít nhất H ngày");

  /*
    ═══ V4: MÃ NÀO ƯỚC TÍNH BẰNG SỐ CỦA MÃ ĐÓ (chủ shop chốt 26/09/2026) ═══

    Một mã hoàn cao (Q002 — 62% tập học) từng kéo tụt ước tính của MỌI mã khác qua bậc toàn shop.
    Khối này khoá các nhánh của luật mới trên CÙNG một bảng tra.
  */
  const tra = await getProbabilityLookup();
  const aCpl = tra.of("WAITING_REDELIVERY", { productCode: "PDV-A", ageHours: 24 * 5 });
  assert.equal(aCpl.basis, "PRODUCT_STATE", "mã A có 12 quan sát của chính nó ở trạng thái này ⇒ dùng số của mã A");
  assert.ok(aCpl.p !== null && Math.abs(aCpl.p - 8 / 12) < 1e-9);
  const aLhtb = tra.of("PICKUP_FAILED", { productCode: "PDV-A" });
  assert.equal(aLhtb.basis, "PRODUCT_ALL", "trạng thái mã A chưa có quan sát ⇒ tỷ lệ chung của CHÍNH mã A, không xuống toàn shop");
  assert.ok(aLhtb.p !== null && Math.abs(aLhtb.p - 8 / 12) < 1e-9);
  const nCpl = tra.of("WAITING_REDELIVERY", { productCode: "PDV-N" });
  assert.equal(nCpl.p, null, "mã chưa có kết cục nào của CHÍNH nó ⇒ CHƯA ĐO ĐƯỢC — không mượn 8/12 của mã A");
  assert.equal(nCpl.basis, "NONE");
  assert.equal(tra.of("WAITING_REDELIVERY", { productCode: null }).basis, "GLOBAL_STATE", "đơn không lần được về một mã (con số toàn shop) vẫn có bậc toàn shop");
  const aChuaGui = tra.of(NOT_SHIPPED_STATE, { productCode: "PDV-A" });
  assert.equal(aChuaGui.basis, "PRODUCT_STATE", "P(chưa rời kho) học RIÊNG mã A — trước V4 là một con số chung cả shop (~25% trên production)");
  assert.ok(aChuaGui.p !== null && Math.abs(aChuaGui.p - 8 / 12) < 1e-9, "12 đơn chốt đã kết thúc của mã A, 8 giao được");
  assert.equal(tra.of(NOT_SHIPPED_STATE, { productCode: "PDV-N" }).p, null, "mã chưa có đơn chốt nào kết thúc ⇒ chưa đo được, không mượn");
}

/* ───── 4 · Chấm cohort theo ORDER_OUTCOME, không theo stage / mã thô ───── */
export async function testScoringUsesOrderOutcome(db: Db) {
  for (const [ma, ten] of [["R", "Hàng trông-như-đã-giao"], ["A", "Hàng đang giao"], ["U", "Hàng chưa đo được"], ["W", "Hàng chờ ĐVVC lấy"], ["N", "Hàng mã mới chưa kết cục"]]) {
    await db.insert(schema.products).values({ id: `${P}p-${ma}`, name: ten, customId: `PDV-${ma}` }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}v-${ma}`, productId: `${P}p-${ma}`, sku: `PDV-${ma}`, retailPrice: 500_000 }).onConflictDoNothing();
  }
  await gieo(db, [
    // ── Mã R: BỐN kiện mà `stage` / mã thô nói "đã giao" hoặc "huỷ", nhưng ORDER_OUTCOME nói HOÀN ──
    { id: "r-30k", productId: "R", luc: TUOI, ship: { stage: "DELIVERED", codCollected: 30_000, final: "DELIVERED", events: [["501", "Giao thành công", "OUTBOUND", "DELIVERED"]] } },
    { id: "r-leg", productId: "R", luc: TUOI, ship: { stage: "DELIVERED", codCollected: 0, final: "DELIVERED", events: [["501", "Giao thành công", "RETURN", "DELIVERED"]] } },
    { id: "r-60k", productId: "R", luc: TUOI, ship: { stage: "DELIVERED", codCollected: 60_000, final: "DELIVERED", events: [["501", "Giao thành công", "OUTBOUND", "DELIVERED"]] } },
    { id: "r-503", productId: "R", luc: TUOI, ship: { stage: "CANCELLED", final: "RETURNED", events: [["503", "Tiêu huỷ", "OUTBOUND", "CANCELLED"]] } },
    // ── Mã A: 1 giao thật · 1 chờ phát lại (mô hình biết) · 1 lấy hàng thất bại (chưa đủ mẫu) · 1 huỷ · 1 chưa gửi ──
    { id: "a-giao", productId: "A", luc: TUOI, ship: { stage: "DELIVERED", codCollected: 499_000, final: "DELIVERED", events: [["501", "Giao thành công", "OUTBOUND", "DELIVERED"]] } },
    { id: "a-cpl", productId: "A", luc: TUOI, ship: { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại", events: [...CHO_PHAT_LAI] } },
    { id: "a-lhtb", productId: "A", luc: TUOI, ship: { stage: "IN_TRANSIT", vtpStatusName: "Lấy hàng thất bại", events: [["", "Lấy hàng thất bại", "OUTBOUND", "IN_TRANSIT"]] } },
    { id: "a-huy", productId: "A", luc: TUOI, orderStage: "CANCELLED", ship: { stage: "CANCELLED", events: [["101", "Huỷ", "OUTBOUND", "CANCELLED"]] } },
    { id: "a-chuagui", productId: "A", luc: TUOI, orderStage: "CONFIRMED", ship: null },
    /*
      ── Mã W: CHỜ ĐVVC TỚI LẤY — hàng còn trong kho shop ──

      Ba đơn có mã vận đơn, ĐVVC đã biết tới kiện (sự kiện 104 "Giao cho Bưu tá đi nhận"), nhưng
      KHÔNG một chứng từ nào nói họ đã cầm hàng. `ORDER_OUTCOME` gọi đúng tên: `AWAITING_PICKUP`.

      Trước bản 21/09/2026, `canMotDon` bắt chúng bằng nhánh `default:` ghi "IN_TRANSIT" nên cả ba
      chui vào `eligibleSent` — mẫu số của tỷ lệ giao thành công. Mã W ở đây KHÔNG có đơn nào đã
      gửi thật, nên nếu luật hỏng thì tỷ lệ sẽ ra một con số (gần 0%) thay vì `null`; đó đúng là
      cái đã đo trên production: mã Q005 in "0,0%" trên 21 đơn còn nằm trong kho.
    */
    { id: "w-1", productId: "W", luc: TUOI, chuaLayHang: true, ship: { stage: "PENDING", vtpStatusName: "Giao cho Bưu tá đi nhận", events: [["104", "Giao cho Bưu tá đi nhận", "OUTBOUND", "PENDING"]] } },
    { id: "w-2", productId: "W", luc: TUOI, chuaLayHang: true, ship: { stage: "PENDING", vtpStatusName: "Đơn hàng chờ xử lý", events: [["102", "Đơn hàng chờ xử lý", "OUTBOUND", "PENDING"]] } },
    { id: "w-3", productId: "W", luc: TUOI, chuaLayHang: true, ship: { stage: "PENDING", vtpStatusName: "Đơn hàng chờ xử lý", events: [["102", "Đơn hàng chờ xử lý", "OUTBOUND", "PENDING"]] } },
    /*
      ── Mã N: MÃ MỚI — có đơn đang giao mà CHƯA đơn nào kết thúc ──

      Đây là hình dạng của Đầm Q005 trên production 21/09/2026: `giao thật 0 · hoàn 0 · đang giao
      62`, mà ô tỷ lệ in 37,5%. Hai đơn dưới đây ở "chờ phát lại" — trạng thái mà mô hình ĐÃ học
      được (mã A gieo tập huấn luyện), nên hợp đồng VẪN trả ra một con số. Nhưng tử số của con số
      ấy là `0 + Σ P`, toàn bộ mượn từ mã khác.
    */
    { id: "n-1", productId: "N", luc: TUOI, ship: { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại", events: [...CHO_PHAT_LAI] } },
    { id: "n-2", productId: "N", luc: TUOI, ship: { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại", events: [...CHO_PHAT_LAI] } },
    // ── Mã U: hai đơn đang giao ở trạng thái chưa đủ mẫu, và KHÔNG biết giá vốn ──
    { id: "u-1", productId: "U", luc: TUOI, unitCost: 0, ship: { stage: "IN_TRANSIT", vtpStatusName: "Lấy hàng thất bại", events: [["", "Lấy hàng thất bại", "OUTBOUND", "IN_TRANSIT"]] } },
    { id: "u-2", productId: "U", luc: TUOI, unitCost: 0, ship: { stage: "IN_TRANSIT", vtpStatusName: "Lấy hàng thất bại", events: [["", "Lấy hàng thất bại", "OUTBOUND", "IN_TRANSIT"]] } },
  ]);

  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;
  clearMemo();
  const m = await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT");
  const theoMa = new Map(m.rows.map((r) => [r.code, r]));

  const R = theoMa.get("PDV-R")!;
  assert.ok(R, "phải thấy mã R");
  assert.equal(R.deliveredActual, 0, "stage=DELIVERED + thu 30K / 501 chiều hoàn / thu 60K ⇒ KHÔNG đơn nào là giao thành công");
  assert.equal(R.failedActual, 4, "cả bốn là không thành công theo ORDER_OUTCOME — kể cả 503 tiêu huỷ có stage=CANCELLED");
  assert.equal(R.cancelled, 0, "503 KHÔNG phải huỷ: hàng bị tiêu huỷ là đơn hoàn, và nó ở trong mẫu số");
  assert.equal(R.eligibleSent, 4);
  assert.equal(R.projectedRate, 0, "0 giao / 4 đã kết thúc = 0% — đây là số đo, khác hẳn null");
  assert.equal(R.projectedDeliveredRevenue, 0);

  const A = theoMa.get("PDV-A")!;
  assert.ok(A, "phải thấy mã A");
  assert.equal(A.eligibleSent, 3, "đã gửi = 1 giao + 2 đang giao; đơn huỷ và đơn chưa gửi KHÔNG ở mẫu số");
  assert.equal(A.cancelled, 1, "huỷ theo chứng từ 101 đếm riêng");
  assert.equal(A.pending, 1, "đơn chưa gửi đếm riêng (cohort theo ngày chốt)");
  assert.equal(A.deliveredActual, 1);
  assert.equal(A.active, 2);
  assert.equal(A.activeByState.WAITING_REDELIVERY, 1);
  assert.equal(A.activeByState.PICKUP_FAILED, 1, "trạng thái con của đơn đang giao đọc từ chứng từ ĐVVC");
  /*
    V4: “lấy hàng thất bại” CHƯA có quan sát nào của mã A ⇒ lùi về tỷ lệ chung của CHÍNH mã A
    (`PRODUCT_ALL` = 8/12), không xuống bậc toàn shop. Đơn ngoài ước tính thật sự (mã không có dữ
    liệu riêng nào) được khoá ở mã U và mã N bên dưới.
  */
  assert.equal(A.unmodelledActive, 0, "trạng thái mã A chưa có mẫu ⇒ tỷ lệ chung của CHÍNH mã A, không phải ngoài ước tính");
  assert.ok(Math.abs(A.projectedDelivered - (1 + 16 / 12)) < 1e-2, "ước tính giao được = 1 đã giao + 2 × 8/12 — cả hai xác suất đều của CHÍNH mã A");
  assert.equal(A.projectedFromGlobal, 0, "mã A không mượn một chút xác suất nào của toàn shop");
  assert.equal(A.projectedRate, projectedRateOf(A), "cùng một hàm");
  assert.equal(A.projectedRate, Math.round(((1 + 16 / 12) / 3) * 1000) / 10, "mẫu số = 3 đã gửi, không đơn nào ngoài ước tính");
  assert.equal(A.unmodelledRevenue, 0);
  assert.ok(A.projectedDeliveredRevenue >= 500_000 + Math.round(500_000 * (8 / 12)) - 1, "DT GTC ƯT ≥ đơn đã giao + đơn chờ phát lại × P (chưa gửi cộng thêm nếu P(chưa gửi) đo được)");
  assert.ok(A.projectedCogs >= 200_000 + Math.round(200_000 * (8 / 12)) - 1, "giá vốn cân cùng cách với doanh thu");
  assert.equal(A.cogsUnknownQty, 0);

  const U = theoMa.get("PDV-U")!;
  assert.ok(U, "phải thấy mã U");
  assert.equal(U.unmodelledActive, 2);
  assert.equal(U.projectedRate, null, "100% đang giao ngoài ước tính ⇒ CHƯA ĐO ĐƯỢC, không phải 0% và không phải giả định");
  assert.equal(U.cogsUnknownQty, 2, "hai sản phẩm không có giá vốn ở bất kỳ nguồn nào ⇒ đếm là CHƯA BIẾT, không phải 0đ");

  /*
    ═══ KIỆN CHƯA RỜI KHO KHÔNG Ở TỬ SỐ LẪN MẪU SỐ ═══

    `ELIGIBLE_SENT_OUTCOMES` cố ý loại `AWAITING_PICKUP`, và `tests/contract-order-outcome.test.ts`
    nói thẳng "chưa rời kho thì CHƯA KẾT THÚC". Bài kiểm ấy quét mã nguồn tìm ai GÕ LẠI danh sách
    nên nó không thấy được một nhánh `default:`; khối này canh chính cái lỗ đó bằng dữ liệu.
  */
  const W = theoMa.get("PDV-W")!;
  assert.ok(W, "phải thấy mã W");
  assert.equal(W.awaitingPickup, 3, "ba đơn chờ bưu tá tới lấy phải có rổ riêng, không lẫn vào đâu");
  assert.equal(W.eligibleSent, 0, "chưa rời kho thì KHÔNG phải 'đã gửi' — mẫu số của tỷ lệ GTC phải rỗng");
  assert.equal(W.active, 0, "'đang giao' là một khẳng định về VỊ TRÍ; hàng còn trong kho thì không đang giao");
  assert.equal(W.projectedDelivered, 0, "không kiện nào rời kho thì không có gì ở tử số");
  assert.equal(W.projectedRate, null, "CHƯA ĐO ĐƯỢC — đây là ca đã in ra '0,0%' trên production 21/09/2026");
  assert.notEqual(W.projectedRate, 0, "0% là 'đã đo và bằng không'; mã này chưa đo được gì cả");
  assert.ok(W.projectedDeliveredRevenue > 0 || W.unmodelledRevenue > 0, "tiền của hàng trong kho vẫn phải được nói ra: hoặc cân theo P(chưa rời kho), hoặc nêu là ngoài ước tính");

  // Mọi mã khác KHÔNG được xê dịch vì mã W có mặt: rổ mới chỉ rút bớt, không cộng thêm vào đâu.
  assert.equal(A.awaitingPickup, 0);
  assert.equal(R.awaitingPickup, 0);

  // Grain đơn: cohort đếm đúng một lần, kể cả huỷ / chưa gửi / chờ lấy.
  const od = m.orderLevel;
  // Fixture DÙNG CHUNG nên các khối khác cũng gieo kiện chưa rời kho; chốt một con số tuyệt đối ở
  // đây là buộc mọi khối sau phải sửa nó. Điều cần khoá là rổ có THẬT và chứa đủ ba đơn của mã W.
  assert.ok(od.awaitingPickup >= 3, `rổ chờ lấy phải tồn tại ở grain đơn y như ở grain mã hàng (thấy ${od.awaitingPickup})`);
  assert.equal(
    od.eligibleSent + od.cancelled + od.unknown + od.pending + od.awaitingPickup,
    m.totalOrders,
    "mọi đơn phải nằm trong ĐÚNG MỘT rổ — thiếu một rổ trong phép cộng này là dấu hiệu có nhóm đang lẫn vào nhóm khác",
  );
  assert.equal(od.projectedRate, projectedRateOf(od));
}

/* ───── 5 · Bảng lợi nhuận: tiền cân theo đơn, chưa đo được thì in "—", tổng = hợp đồng ───── */
export async function testNominalParityWithActiveOrders() {
  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;

  /*
    ═══ HẠ NGƯỠNG CHÍN CHO ĐÚNG KHỐI NÀY, VÀ NÓI RA VÌ SAO ═══

    Bài này khoá một bất biến rất hẹp: *khi bảng lợi nhuận ĐANG chạy trên bậc `projected`, nó phải
    in ĐÚNG con số của hợp đồng, kể cả khi trong cohort có đơn đang giao*. Muốn vào được bậc ấy thì
    mã phải ĐỦ CHÍN (`rateMatureMinFinished`, chủ shop để 10 từ 23/09/2026).

    Fixture ở đây cố ý nhỏ — vài đơn mỗi mã, để mỗi mã nói được một chuyện — nên nếu giữ ngưỡng
    thật thì mọi mã rơi xuống bậc co ngót và bài kiểm thôi chạm vào thứ nó sinh ra để canh.

    Hạ ngưỡng xuống 1 chứ KHÔNG phóng to fixture, vì fixture này DÙNG CHUNG với bốn khối khác: thêm
    đơn vào đây là đổi tổng của tất cả chúng. Ngưỡng là một tham số nghiệp vụ sửa được không cần
    deploy, nên chỉnh nó trong một khối kiểm thử là dùng đúng cái cần dùng — và trả lại ngay sau đó.
  */
  const { getSettingJson, setSettingJson } = await import("@/lib/settings");
  const { PROFIT_ASSUMPTIONS_KEY } = await import("@/lib/constants/profit");
  const giaDinhCu = await getSettingJson<Record<string, unknown>>(PROFIT_ASSUMPTIONS_KEY, {});
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...giaDinhCu, rateMatureMinFinished: 1 });

  clearMemo();
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const bao = await getNominalProfitReport(ky);
  const hopDong = await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT");
  const theoMa = new Map(hopDong.rows.map((r) => [r.key, r]));

  const A = bao.rows.find((r) => r.productId === `${P}p-A`)!;
  assert.ok(A, "bảng lợi nhuận phải thấy mã A");
  const hA = theoMa.get(`${P}p-A`)!;
  assert.equal(A.returnRateSource, "projected");
  assert.equal(A.deliveryRate, hA.projectedRate, "cùng mã, cùng kỳ, cùng mốc ⇒ CÙNG MỘT SỐ — với đơn ĐANG GIAO thật trong cohort");
  assert.equal(A.revenueBasis, "ORDER_LEVEL");
  assert.equal(A.expectedRevenue, hA.projectedDeliveredRevenue, "DT GTC ƯT = doanh thu cân theo từng đơn của hợp đồng, KHÔNG phải doanh số × (1 − r)");
  assert.notEqual(A.expectedRevenue, Math.round(A.grossSales * (1 - (A.returnRate ?? 0) / 100)), "và nó KHÁC doanh số POS × tỷ lệ — nếu bằng thì bài này chưa chứng minh được gì");
  assert.equal(A.expectedCogs, hA.projectedCogs);
  assert.equal(A.unmodelledRevenue, 0, "V4: mọi đơn của A cân bằng số của chính A");
  assert.equal(A.projection?.pending, 1);
  assert.equal(A.cogsKnown, true);

  const R = bao.rows.find((r) => r.productId === `${P}p-R`)!;
  assert.ok(R);
  assert.equal(R.deliveryRate, 0, "0% là số đo trên 4 đơn hoàn — kể cả dòng RETURNED_BY_RULE (thu 60K)");
  assert.equal(R.returned, 4, "bảng lợi nhuận đếm hoàn theo ORDER_OUTCOME: 4, gồm 60K và 503");
  assert.equal(R.expectedRevenue, 0);

  /*
    ═══ CHƯA ĐO ĐƯỢC ⇒ RƠI VỀ TỶ LỆ ĐÃ KHAI, VÀ TIỀN ĐI CÙNG TỶ LỆ ẤY ═══

    Chủ shop chốt 21/09/2026. Bản trước gắn nhãn `unmeasured`: ô tỷ lệ in "—" nhưng cột tiền vẫn
    in một con số, vì tiền đi đường khác (cân từng đơn theo `P(chưa rời kho)`). Trên production mã
    Q005 ra "—" cạnh 25.687.174 ₫ = 106.287.000 × 24,2% — một dòng nói hai điều trái nhau.

    Điều bài này khoá KHÔNG phải con số 60%, mà là BA tính chất: tỷ lệ không còn `null`, nó bằng
    ĐÚNG tỷ lệ khai trong giả định, và TIỀN bằng ĐÚNG `Doanh số POS × tỷ lệ ấy` — cùng một tỷ lệ
    cho cả hai ô. Kỳ vọng dựng TỪ `bao.assumptions`, không gõ lại con số (AGENTS.md §65).
  */
  /*
    ═══ MÔ HÌNH RA ĐƯỢC SỐ ≠ MÃ NÀY ĐÃ ĐO ĐƯỢC ═══

    Mã N có 2 đơn đang giao ở "chờ phát lại" — trạng thái mô hình ĐÃ học — nên hợp đồng vẫn trả ra
    một tỷ lệ khác `null`. Nhưng 0 đơn của chính mã N có kết cục, nên tử số hoàn toàn là xác suất
    MƯỢN từ mã khác. Đây là ca Đầm Q005 trên production 21/09/2026 (giao 0 · hoàn 0 · đang giao 62
    mà in 37,5%).

    Khối này khoá CẢ HAI vế, vì chỉ một vế thì không chứng minh được gì:
      · hợp đồng VẪN đo ra một con số cho mã N  →  nếu không, điều kiện mới chưa bị thử;
      · và bảng lợi nhuận KHÔNG dùng con số đó.
  */
  const hN = theoMa.get(`${P}p-N`)!;
  assert.ok(hN, "hợp đồng phải thấy mã N");
  assert.equal(hN.deliveredActual + hN.failedActual, 0, "mã N chưa đơn nào kết thúc — đó là điều kiện của ca này");
  assert.ok(hN.active > 0, "nhưng nó CÓ đơn đang giao");
  // V4: hợp đồng KHÔNG còn mượn 8/12 của mã A cho mã N — hai đơn đang chạy của N là ngoài ước tính.
  assert.equal(hN.projectedRate, null, "mã chưa có dữ liệu riêng ⇒ CHƯA ĐO ĐƯỢC ngay ở hợp đồng, không mượn của mã khác");
  assert.equal(hN.unmodelledActive, hN.active, "mọi đơn đang chạy của N nằm ngoài ước tính");
  assert.equal(hN.projectedFromGlobal, 0);

  const N = bao.rows.find((r) => r.productId === `${P}p-N`)!;
  assert.ok(N, "bảng lợi nhuận phải thấy mã N");
  assert.notEqual(N.returnRateSource, "projected", "mã chưa có kết cục nào thì KHÔNG được mang con số mượn từ mã khác");
  assert.equal(N.returnRateSource, "default", "chưa lịch sử, chưa kết cục ⇒ tỷ lệ khai ở Giả định");
  assert.equal(N.deliveryRate, Math.round((100 - bao.assumptions.defaultReturnRate) * 10) / 10);
  assert.equal(N.expectedRevenue, Math.round(N.grossSales * (1 - bao.assumptions.defaultReturnRate / 100)), "tiền đi cùng đúng tỷ lệ đang hiện");

  // Mã A CÓ kết cục thật ⇒ vẫn dùng hợp đồng. Ranh giới nằm ở đó, không ở chỗ khác.
  assert.ok(hA.deliveredActual + hA.failedActual > 0);
  assert.equal(A.returnRateSource, "projected");
  assert.equal(A.projection?.finished, hA.deliveredActual + hA.failedActual, "màn hình phải nói ra con số này dựa trên bao nhiêu đơn đã kết thúc");

  const U = bao.rows.find((r) => r.productId === `${P}p-U`)!;
  assert.ok(U);
  const tyLeKhai = bao.assumptions.defaultReturnRate;
  assert.equal(U.returnRateSource, "default", "mã chưa đo được tỷ lệ nào ⇒ dùng tỷ lệ khai ở Giả định, không để trống");
  assert.equal(U.returnRate, Math.round(tyLeKhai * 10) / 10);
  assert.equal(U.deliveryRate, Math.round((100 - tyLeKhai) * 10) / 10, "ô tỷ lệ in con số giả định, có nhãn — không in “—”");
  assert.equal(
    U.expectedRevenue,
    Math.round(U.grossSales * (1 - tyLeKhai / 100)),
    "TIỀN phải bằng ĐÚNG Doanh số POS × tỷ lệ đang hiện; đây chính là chỗ bản cũ lệch — tiền cân theo đơn còn tỷ lệ để trống",
  );
  assert.ok(U.grossSales > 0, "mã phải có doanh số POS, nếu không phép nhân trên không chứng minh được gì");
  assert.equal(U.cogsKnown, false, "không biết giá vốn ⇒ cờ tắt, màn hình in “—” thay vì 0 ₫");
  assert.equal(U.cogsUnknownQty, 2);

  // Mã KHÔNG có đơn nào thì vẫn KHÔNG có tỷ lệ — giả định chỉ áp cho mã đang chạy thật.
  for (const x of bao.rows) {
    if (!x.orders) assert.equal(x.deliveryRate, null, `${x.code || x.productId}: không đơn nào ⇒ không áp giả định`);
  }

  // Không dòng nào có đơn mà in 100% "cho đẹp"; dòng chưa có đơn cũng không in 100%.
  for (const r of bao.rows) {
    if (!r.orders) assert.equal(r.deliveryRate, null, `${r.code || r.productId}: không có đơn ⇒ không có tỷ lệ, KHÔNG phải 100%`);
  }

  // TỔNG = hợp đồng ở grain đơn, có ĐƠN ĐANG GIAO trong cohort và một dòng RETURNED_BY_RULE.
  assert.ok(hopDong.orderLevel.active > 0, "cohort phải có đơn đang giao để bài này có nghĩa");
  assert.equal(bao.totals.weightedDeliveryRate, hopDong.orderLevel.projectedRate, "thẻ TL GTC ước tính toàn shop = orderLevel.projectedRate — cùng số với trang hiệu quả theo mã ở cùng mốc");
  assert.ok(bao.totals.projection && bao.totals.projection.version === PROJECTED_GTC_VERSION);
  assert.equal(bao.totals.projectionError, null);
  const { getReturnRateSummary } = await import("@/lib/queries/return-rate");
  const tong = await getReturnRateSummary(ky, "", "ORDERED");
  assert.equal(tong.expectedSuccessRate, bao.totals.weightedDeliveryRate, "HAI TRANG, CÙNG MỐC ⇒ CÙNG MỘT SỐ toàn shop");
  assert.ok(tong.projection && tong.projection.backtest !== undefined, "nhãn tin cậy đi kèm");

  // Ba tỷ lệ QC: một hàm; dòng tổng dùng CPQC đã quy kết, thẻ dùng tổng chi; chưa quy kết đứng riêng.
  assert.equal(bao.totals.adSpendAttributed + bao.unmatchedAdSpend, bao.totals.adSpend, "tổng chi = đã quy kết + chưa quy kết");
  assert.deepEqual(bao.totals.ads, adsRatios({ adSpend: bao.totals.adSpend, posSales: bao.totals.salesAfterDiscount, deliveredRevenueActual: bao.totals.actualRevenue, projectedDeliveredRevenue: bao.totals.expectedRevenue }));
  assert.deepEqual(bao.totals.adsAttributed, adsRatios({ adSpend: bao.totals.adSpendAttributed, posSales: bao.totals.salesAfterDiscount, deliveredRevenueActual: bao.totals.actualRevenue, projectedDeliveredRevenue: bao.totals.expectedRevenue }));
  for (const r of bao.rows) assert.deepEqual(r.ads, adsRatios({ adSpend: r.adSpend, posSales: r.salesAfterDiscount, deliveredRevenueActual: r.actualRevenue, projectedDeliveredRevenue: r.expectedRevenue }), `${r.code}: tỷ lệ QC từng dòng đi qua đúng một hàm`);

  /*
    ═══════════ ĐỔI MỐC LÀ ĐỔI COHORT, VÀ HAI TRANG PHẢI ĐỔI CÙNG NHAU ═══════════

    Trang Tỷ lệ giao thành công mặc định mốc NGÀY GỬI, bảng lợi nhuận mặc định NGÀY TẠO ĐƠN — hai
    câu trả lời đúng cho hai câu hỏi khác nhau, mà trên màn hình chúng đứng dưới CÙNG một cái tên
    "Tỷ lệ GTC ước tính". Ô chọn mốc tồn tại để đặt được cả hai về cùng một mốc; khối này khoá
    đúng lời hứa đó, và khoá luôn việc `basis` phải có mặt trong khoá cache (thiếu nó thì lượt xem
    mốc này phục vụ lại con số của mốc kia — không lỗi, không cảnh báo, chỉ là số sai).
  */
  /*
    CỐ Ý KHÔNG `clearMemo()` Ở ĐÂY.

    Lượt đọc mốc NGÀY TẠO ĐƠN phía trên vừa nạp cache. Nếu `basis` vắng mặt trong khoá, lượt này
    nhận lại ĐÚNG kết quả của mốc kia — không lỗi, không cảnh báo, chỉ là số sai. Xoá cache trước
    khi đo là tự tay gỡ mất cái bẫy: bản nháp đầu của khối này có `clearMemo()`, và kiểm đột biến
    (bỏ `basis` khỏi khoá) SỐNG SÓT. Một bài kiểm xanh cả khi lỗi còn đó thì không phải hàng rào.
  */
  const baoGui = await getNominalProfitReport(ky, "SHIPPED");
  const hopDongGui = await getProjectedDeliveryMetrics(ky, "SHIPPED", "PRODUCT");
  const guiTheoMa = new Map(hopDongGui.rows.map((r) => [r.key, r]));
  const aGui = baoGui.rows.find((r) => r.productId === `${P}p-A`)!;
  assert.ok(aGui, "đổi mốc không được làm biến mất mã đang có đơn đã gửi thật");
  assert.equal(aGui.deliveryRate, guiTheoMa.get(`${P}p-A`)!.projectedRate, "ở mốc NGÀY GỬI cũng phải là CÙNG MỘT SỐ với hợp đồng ở CÙNG mốc ấy");

  const tongGui = await getReturnRateSummary(ky, "", "SHIPPED");
  assert.equal(tongGui.expectedSuccessRate, baoGui.totals.weightedDeliveryRate, "HAI TRANG, CÙNG MỐC NGÀY GỬI ⇒ CÙNG MỘT SỐ toàn shop");
  assert.notEqual(baoGui.totals.weightedDeliveryRate, undefined);

  /*
    Mã W chỉ gồm kiện ĐVVC CHƯA CẦM HÀNG. Chúng không có `carrier_handoff_at`, nên ở mốc NGÀY GỬI
    chúng nằm NGOÀI cohort — khác hẳn "có cohort mà tỷ lệ bằng 0". Ở mốc NGÀY TẠO ĐƠN chúng có
    mặt, trong rổ riêng của mình, và vẫn không chạm vào tỷ lệ.
  */
  assert.equal(guiTheoMa.get(`${P}p-W`), undefined, "kiện chưa bàn giao không có mốc gửi ⇒ ngoài cohort mốc NGÀY GỬI");
  assert.equal(
    baoGui.rows.find((r) => r.productId === `${P}p-W`),
    undefined,
    "và bảng lợi nhuận ở mốc NGÀY GỬI cũng không được có dòng ấy — thấy nó nghĩa là lượt đọc này đang dùng lại kết quả đã nhớ của MỐC KHÁC",
  );
  assert.ok(bao.rows.some((r) => r.productId === `${P}p-W`), "trong khi ở mốc NGÀY TẠO ĐƠN thì dòng ấy PHẢI có — nếu không, hai vế trên không chứng minh được gì");
  assert.equal(theoMa.get(`${P}p-W`)!.awaitingPickup, 3, "ở mốc NGÀY TẠO ĐƠN chúng có mặt, trong rổ riêng");
  assert.equal(theoMa.get(`${P}p-W`)!.projectedRate, null, "và ở cả hai mốc đều KHÔNG sinh ra một tỷ lệ nào");

  // Trả lại đúng trạng thái cũ: khối khác đọc chung cấu hình này.
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, giaDinhCu);
  clearMemo();
}

/* ───── 6 · Thử ngược chạy trên CSDL, không lộ trạng thái cuối ───── */
export async function testBacktestRuns() {
  clearMemo();
  const b = await getProjectionBacktest();
  assert.equal(b.version, PROJECTED_GTC_VERSION);
  for (const s of b.byState) assert.ok(isModelledSubstate(s.substate), `${s.substate}: thử ngược không được chấm bằng trạng thái cuối`);
  assert.ok(["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_DATA"].includes(b.confidence));
  assert.equal(b.confidence, backtestConfidenceOf({ n: b.overall.n, bias: b.overall.bias, slope: b.overall.slope }), "nhãn tin cậy phải là ĐÚNG hàm ngưỡng");
  for (let i = 1; i < b.overall.calibration.length; i += 1) assert.ok(b.overall.calibration[i].from > b.overall.calibration[i - 1].from, "thập phân vị tăng dần");
  assert.ok(b.maturityDays >= 1);
  assert.deepEqual([...b.offsetsDays], [1, 3, 5, 7, 10]);
}

/* ───── 7 · Hàm tỷ lệ QC và các ngưỡng dùng chung ───── */
export function testAdsRatiosHelper() {
  const r = adsRatios({ adSpend: 10_000_000, posSales: 100_000_000, deliveredRevenueActual: 40_000_000, projectedDeliveredRevenue: 50_000_000 });
  assert.equal(r.overPosSales, 10);
  assert.equal(r.overDeliveredActual, 25);
  assert.equal(r.overProjectedRevenue, 20);
  const chua = adsRatios({ adSpend: 10_000_000, posSales: 0, deliveredRevenueActual: 0, projectedDeliveredRevenue: null });
  assert.equal(chua.overPosSales, null, "mẫu số 0 ⇒ N/A, không phải 0%");
  assert.equal(chua.overDeliveredActual, null);
  assert.equal(chua.overProjectedRevenue, null, "chưa đo được DT ước tính ⇒ N/A");
}

/* ───── 8 · Quét mã nguồn: một bộ ngưỡng, một mặc định, không còn hàm chết ───── */
export function testSourceHygiene() {
  const doc = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const nominalTab = doc("app/(dashboard)/reports/nominal-tab.tsx");
  assert.ok(!/deliveryRate\s*<\s*(60|75)\b/.test(nominalTab), "nominal-tab không được ghi cứng ngưỡng 60/75 — dùng successTone() của lib/constants/returns.ts");
  assert.ok(nominalTab.includes("successTone("), "màu của TL GTC trên bảng lợi nhuận phải đi qua successTone()");
  assert.ok(!nominalTab.includes("?? 10"), "mặc định rủi ro tồn kho lấy từ DEFAULT_PROFIT_ASSUMPTIONS, không gõ lại số 10");
  const ads = doc("lib/queries/ads-performance.ts");
  assert.ok(!ads.includes("0.65"), "ads-performance không được ghi cứng ngưỡng 0,65 — dùng SUCCESS_RATE_OK");
  assert.ok(ads.includes("SUCCESS_RATE_OK"));
  assert.ok(!ads.includes('"__test__"') && !ads.includes("Chi phí test (không thuộc mã)"), "tiền QC không ghép mã là “chưa quy kết”, không phải “chi phí test”");
  assert.ok(SUCCESS_RATE_OK > 0 && SUCCESS_RATE_OK < 100);
  for (const p of ["lib/queries/return-rate.ts", "lib/queries/profit-nominal.ts", "lib/queries/projected-delivery.ts"]) {
    assert.ok(!doc(p).includes("failedToReturnRate"), `${p}: hàm failedToReturnRate (ghi cứng 60%, 2,9 giây mỗi lượt) đã phải bị xoá`);
    assert.ok(!/\)\.catch\(\(\) => null\)/.test(doc(p)), `${p}: lỗi SQL không được hoá thành “chưa đủ dữ liệu”`);
  }
  const pd = doc("lib/queries/projected-delivery.ts");
  assert.ok(!/stage\s*=\s*'DELIVERED'\)\s*as\s*da_giao/.test(pd), "nhãn huấn luyện không được đọc stage");
  assert.ok(pd.includes("ORDER_OUTCOME_FAST"), "nhãn và phân loại cohort phải đi qua ORDER_OUTCOME");
  const settings = doc("lib/actions/report-settings.ts");
  assert.ok(settings.includes("default(DEFAULT_PROFIT_ASSUMPTIONS.inventoryRiskPercent)"), "mặc định rủi ro tồn kho: MỘT hằng số");
  assert.equal(DEFAULT_PROFIT_ASSUMPTIONS.inventoryRiskPercent, 10);
  const logistics = doc("lib/queries/logistics.ts");
  assert.ok(logistics.includes("SUCCESS_RATE_TERMINAL_LABEL"), "chỉ số giao vận theo sự kiện phải có tên riêng, không đội tên “tỷ lệ giao thành công”");
  const returnsPage = doc("app/(dashboard)/reports/returns/page.tsx");
  assert.ok(returnsPage.includes("SUCCESS_RATE_TERMINAL_LABEL") && returnsPage.includes("ProjectionConfidence"), "trang returns phải dùng nhãn đúng và huy hiệu tin cậy");
  assert.ok(nominalTab.includes("ProjectionConfidence"), "bảng lợi nhuận phải in huy hiệu tin cậy cạnh con số ước tính");
}

export async function testProjectedDeliveryV3(db: Db) {
  testProjectedRateFormula();
  testBacktestStatsPure();
  testAdsRatiosHelper();
  testSourceHygiene();
  try {
    await testTrainingLabelsFromOrderOutcome(db);
    await testScoringUsesOrderOutcome(db);
    await testNominalParityWithActiveOrders();
    await testBacktestRuns();
  } finally {
    await don(db);
    clearMemo();
  }
  console.log("✓ PROJECTED_GTC_V4: mã nào ước tính bằng số của mã đó (không bậc toàn shop) · nhãn và cohort theo ORDER_OUTCOME (30K / 501 chiều hoàn / 60K / 503 đều là hoàn) · kiện chưa chín ngoài tập học · ngoài ước tính rời mẫu số, quá nửa ⇒ chưa đo được · DT/giá vốn cân theo từng đơn ở bảng lợi nhuận · tổng hai trang cùng số · thử ngược tách thời gian · một hàm cho ba tỷ lệ QC · một bộ ngưỡng");
}

import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CANONICAL_OUTCOME_VERSION, COGS_TRUE_UP_ACTION, rematerializeOutcomes, rematerializeStale } from "@/lib/queries/canonical-outcome";
import { getProfitReport } from "@/lib/queries/reports";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── GIÁ VỐN CỦA KỲ ĐÃ CHỐT KHÔNG ĐƯỢC TỰ ĐỔI ─────────────
 *
 * `ORDER_COGS` lấy giá trên phiếu nhập GẦN NHẤT tính theo THỜI ĐIỂM HIỆN TẠI. Nên nhập một lô mới
 * hôm nay sẽ viết lại giá vốn — và do đó viết lại LỢI NHUẬN — của những đơn đã giao từ tháng trước.
 * Chủ shop in báo cáo tháng 8 hai lần vào hai ngày khác nhau sẽ ra hai con số khác nhau, dù không ai
 * đụng vào dữ liệu tháng 8.
 *
 * Cột `recognized_cogs` chốt giá vốn tại thời điểm ghi nhận rồi không đổi nữa. Bài kiểm thử này khoá
 * đúng bốn tình huống chủ shop nêu, cộng thêm nhãn "căn cứ suy ngược".
 */
export async function testCogsRecognition(db: Db) {
  clearMemo();

  const VARIANT = "cogs-var";
  await db.insert(schema.products).values({ id: "cogs-prod", name: "Áo kiểm giá vốn" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values({ id: VARIANT, productId: "cogs-prod", sku: "COGS-1", color: "Đen", size: "M", retailPrice: 500_000 })
    .onConflictDoNothing();

  // Phiếu nhập 01/08 giá 200.000 — TRƯỚC ngày giao.
  const [phieuThang8] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-08-01T00:00:00Z"), reference: "Lô tháng 8", totalQuantity: 10, totalCost: 2_000_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuThang8.id, variantId: VARIANT, quantity: 10, unitCost: 200_000 });

  await db.insert(schema.orders).values({ id: "cogs-o1", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-05T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "cogs-i1", orderId: "cogs-o1", variantId: VARIANT, productId: "cogs-prod", productName: "Áo kiểm giá vốn", quantity: 1, unitPrice: 500_000, lineTotal: 500_000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({
      id: "cogs-s1",
      orderId: "cogs-o1",
      vtpOrderNumber: "COGS001",
      stage: "DELIVERED",
      deliveredAt: new Date("2026-08-10T00:00:00Z"),
      codAmount: 500_000,
      codCollected: 500_000,
      codStatus: "PAID_TO_BANK",
    })
    .onConflictDoNothing();

  await rematerializeOutcomes(["cogs-o1"]);
  const doc = async () => (await db.select().from(schema.canonicalOrderOutcome).where(eq(schema.canonicalOrderOutcome.orderId, "cogs-o1")))[0];

  const banDau = await doc();
  assert.equal(banDau.outcome, "DELIVERED", "fixture: đơn phải được ghi nhận là giao thành công");
  assert.equal(Number(banDau.recognizedCogs), 200_000, "giá vốn chốt tại thời điểm giao phải là giá của lô tháng 8");
  assert.equal(banDau.cogsBasis, "RECEIPT_BEFORE", "có phiếu nhập TRƯỚC ngày giao thì căn cứ là vững");

  // ───────── CASE A: nhập lô mới giá khác, SAU khi đã giao ─────────
  const [phieuThang9] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-09-01T00:00:00Z"), reference: "Lô tháng 9", totalQuantity: 10, totalCost: 2_500_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuThang9.id, variantId: VARIANT, quantity: 10, unitCost: 250_000 });

  await rematerializeStale();
  const sauLoMoi = await doc();
  assert.equal(Number(sauLoMoi.recognizedCogs), 200_000, "CASE A: nhập lô mới 250.000 KHÔNG được đổi giá vốn đã chốt của đơn tháng 8");
  assert.equal(Number(sauLoMoi.cogs), 250_000, "giá vốn 'hiện tại' vẫn theo lô mới — đó là ước tính, không phải số của kỳ đã qua");
  assert.equal(sauLoMoi.cogsBasis, "RECEIPT_BEFORE", "căn cứ đã chốt cũng không đổi");

  // ───────── CASE D: chạy lại báo cáo sau khi nhập hàng ─────────
  await rematerializeStale();
  await rematerializeOutcomes(["cogs-o1"]);
  assert.equal(Number((await doc()).recognizedCogs), 200_000, "CASE D: dựng lại bao nhiêu lần thì giá vốn kỳ đã chốt vẫn y nguyên");

  // ───────── CASE B: đơn CHƯA giao thì chưa có giá vốn ghi nhận ─────────
  await db.insert(schema.orders).values({ id: "cogs-o2", stage: "CONFIRMED", status: 1, insertedAt: new Date() }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "cogs-i2", orderId: "cogs-o2", variantId: VARIANT, productId: "cogs-prod", productName: "Áo kiểm giá vốn", quantity: 1, unitPrice: 500_000, lineTotal: 500_000 })
    .onConflictDoNothing();
  await rematerializeOutcomes(["cogs-o2"]);
  const [chuaGiao] = await db.select().from(schema.canonicalOrderOutcome).where(eq(schema.canonicalOrderOutcome.orderId, "cogs-o2"));
  assert.notEqual(chuaGiao.outcome, "DELIVERED");
  assert.equal(chuaGiao.recognizedCogs, null, "CASE B: đơn chưa giao thì giá vốn ghi nhận là CHƯA CÓ (null), không phải 0");
  assert.equal(chuaGiao.recognizedAt, null, "chưa giao thì chưa có mốc ghi nhận");
  assert.equal(chuaGiao.cogsBasis, null, "chưa giao thì chưa có căn cứ nào để khai");

  // ───────── CĂN CỨ SUY NGƯỢC: phiếu nhập lập SAU ngày giao ─────────
  //
  // Đây đúng là tình trạng production: shop chỉ có phiếu nhập tháng 9, đơn giao từ tháng 1. Giá vốn
  // của chúng đang được suy ngược — phải gắn nhãn, không được im lặng.
  await db.insert(schema.orders).values({ id: "cogs-o3", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-07-01T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "cogs-i3", orderId: "cogs-o3", variantId: VARIANT, productId: "cogs-prod", productName: "Áo kiểm giá vốn", quantity: 1, unitPrice: 500_000, lineTotal: 500_000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({
      id: "cogs-s3",
      orderId: "cogs-o3",
      vtpOrderNumber: "COGS003",
      stage: "DELIVERED",
      deliveredAt: new Date("2026-07-05T00:00:00Z"),
      codAmount: 500_000,
      codCollected: 500_000,
      codStatus: "PAID_TO_BANK",
    })
    .onConflictDoNothing();
  await rematerializeOutcomes(["cogs-o3"]);
  const [suyNguoc] = await db.select().from(schema.canonicalOrderOutcome).where(eq(schema.canonicalOrderOutcome.orderId, "cogs-o3"));
  if (suyNguoc.outcome === "DELIVERED") {
    assert.equal(suyNguoc.cogsBasis, "RECEIPT_AFTER", "đơn giao tháng 7 mà phiếu nhập sớm nhất là tháng 8 thì giá vốn là suy ngược — phải gắn nhãn CHƯA XÁC MINH");
  }

  /**
   * ───────── DÒNG GHI TRƯỚC P0.4: CÓ KẾT QUẢ MÀ CHƯA CHỐT GIÁ VỐN ─────────
   *
   * P0.4 thêm ba cột đông cứng giá vốn nhưng cố ý KHÔNG tăng `logic_version` — tăng sẽ làm cả 2.433
   * đơn thành cũ cùng lúc và trang chủ quay lại mức 60 giây ngay sau khi deploy.
   *
   * Hệ quả không lường trước: bộ dò dòng cũ chỉ nhìn `logic_version`, nên những dòng ghi TRƯỚC P0.4
   * không bao giờ được điền `recognized_cogs`. Chúng vẫn đọc `m.cogs` — tức giá vốn HIỆN TẠI — nên
   * việc đông cứng im lặng không áp dụng cho chính những đơn lịch sử cần nó nhất.
   *
   * Dựng lại đúng ca đó: xoá ba cột như thể dòng được ghi bởi bản cũ, rồi đòi bộ dò nhặt nó lên.
   */
  await db
    .update(schema.canonicalOrderOutcome)
    .set({ recognizedCogs: null, recognizedAt: null, cogsBasis: null })
    .where(eq(schema.canonicalOrderOutcome.orderId, "cogs-o1"));
  const nhuBanCu = await doc();
  assert.equal(nhuBanCu.recognizedCogs, null, "dựng bối cảnh: dòng đang ở trạng thái 'ghi bởi bản trước P0.4'");
  assert.equal(nhuBanCu.logicVersion, CANONICAL_OUTCOME_VERSION, "và nó KHÔNG cũ về phiên bản — đó chính là chỗ bộ dò cũ mù");

  await rematerializeStale();
  const daVa = await doc();
  assert.notEqual(daVa.recognizedCogs, null, "dòng đã giao mà chưa chốt giá vốn PHẢI được bộ dò nhặt lên và điền");
  assert.notEqual(daVa.cogsBasis, null, "điền giá vốn thì phải điền cả căn cứ của nó");

  // Và không được lặp vô hạn: chạy lại lần nữa thì không còn gì để làm với đơn này.
  const truocLan2 = Number((await doc()).recognizedCogs);
  await rematerializeStale();
  assert.equal(Number((await doc()).recognizedCogs), truocLan2, "chạy lại không đổi con số đã chốt — điều kiện làm cũ phải TỰ TẮT");

  /**
   * ═══════ QUYẾT ĐỊNH CHỦ SHOP 11/09/2026: KHÔNG GIỮ 0 CHỈ VÌ PHIẾU ĐẾN SAU ═══════
   *
   * (1) Không có nguồn nào ⇒ CHƯA BIẾT (NULL), không phải 0, và không bị dựng lại vô hạn.
   * (2) Phiếu nhập xuất hiện sau ⇒ chốt lại ĐÚNG MỘT LẦN, có nhật ký, rồi đóng băng kể cả khi sau đó
   *     có chứng từ còn mạnh hơn.
   * (3) Chưa có phiếu nhưng có giá vốn Pancake ⇒ TẠM TÍNH (PROVISIONAL), và cũng chỉ được chốt lại một lần.
   * (4) Phiếu nhập CÙNG HẠNG (thêm một lô nữa sau ngày giao) không phải chứng từ mạnh hơn ⇒ không đổi.
   */
  const dongCua = async (orderId: string) => (await db.select().from(schema.canonicalOrderOutcome).where(eq(schema.canonicalOrderOutcome.orderId, orderId)))[0];
  const nhatKy = async (orderId: string) =>
    db.select().from(schema.auditLogs).where(sql`${schema.auditLogs.action} = ${COGS_TRUE_UP_ACTION} and ${schema.auditLogs.entityId} = ${orderId}`);
  const giaoThanhCong = (id: string, orderId: string, vtp: string, deliveredAt: string) =>
    db.insert(schema.shipments).values({ id, orderId, vtpOrderNumber: vtp, stage: "DELIVERED", deliveredAt: new Date(deliveredAt), codAmount: 500_000, codCollected: 500_000, codStatus: "PAID_TO_BANK" }).onConflictDoNothing();

  // (1) Mẫu mã KHÔNG có phiếu nhập, không giá Pancake, không giá nhập mẫu mã.
  await db.insert(schema.productVariants).values({ id: "cogs-var-2", productId: "cogs-prod", sku: "COGS-2", color: "Trắng", size: "L", retailPrice: 500_000 }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: "cogs-o4", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-06-05T00:00:00Z") }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: "cogs-i4", orderId: "cogs-o4", variantId: "cogs-var-2", productId: "cogs-prod", productName: "Áo trắng", quantity: 2, unitPrice: 250_000, lineTotal: 500_000 }).onConflictDoNothing();
  await giaoThanhCong("cogs-s4", "cogs-o4", "COGS004", "2026-06-10T00:00:00Z");
  await rematerializeOutcomes(["cogs-o4"]);
  const chuaBiet = await dongCua("cogs-o4");
  assert.equal(chuaBiet.outcome, "DELIVERED", "fixture: đơn phải là giao thành công");
  assert.equal(chuaBiet.recognizedCogs, null, "(1) không có nguồn giá vốn nào ⇒ CHƯA BIẾT (NULL), không phải 0");
  assert.equal(chuaBiet.cogsBasis, "NONE", "(1) căn cứ phải nói rõ là KHÔNG CÓ");
  await rematerializeStale();
  const chuaBietLan2 = await dongCua("cogs-o4");
  assert.equal(chuaBietLan2.recognizedCogs, null);
  assert.equal(chuaBietLan2.computedAt.getTime(), chuaBiet.computedAt.getTime(), "(1) 'chưa biết' là kết luận, không phải việc dở — bộ dò không được nhặt lại mãi");

  // (2) Phiếu nhập đến SAU ngày giao ⇒ chốt lại một lần, có nhật ký.
  const [phieuMuon] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-07-01T00:00:00Z"), reference: "Lô tháng 7 (áo trắng)", totalQuantity: 10, totalCost: 1_500_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuMuon.id, variantId: "cogs-var-2", quantity: 10, unitCost: 150_000 });
  await rematerializeStale();
  const daChotLai = await dongCua("cogs-o4");
  assert.equal(Number(daChotLai.recognizedCogs), 300_000, "(2) phiếu nhập đến sau ⇒ giá vốn được chốt lại (2 × 150.000), không giữ CHƯA BIẾT / 0");
  assert.equal(daChotLai.cogsBasis, "RECEIPT_AFTER", "(2) căn cứ mới là phiếu lập sau ngày giao");
  assert.ok(daChotLai.truedUpAt, "(2) phải ghi mốc chốt lại");
  assert.equal(daChotLai.truedUpFrom, null, "(2) trước đó là CHƯA BIẾT");
  assert.equal(daChotLai.truedUpFromBasis, "NONE");
  const nhatKyO4 = await nhatKy("cogs-o4");
  assert.equal(nhatKyO4.length, 1, "(2) chốt lại phải có ĐÚNG MỘT dòng nhật ký");
  const chiTiet = nhatKyO4[0].detail as { before: { recognizedCogs: number | null; cogsBasis: string }; after: { recognizedCogs: number; cogsBasis: string } };
  assert.equal(chiTiet.before.cogsBasis, "NONE");
  assert.equal(Number(chiTiet.after.recognizedCogs), 300_000);
  assert.equal(chiTiet.after.cogsBasis, "RECEIPT_AFTER");

  // …rồi đóng băng: phiếu nhập TRƯỚC ngày giao (mạnh hơn nữa) xuất hiện cũng không đổi được.
  const [phieuSom] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-06-01T00:00:00Z"), reference: "Lô tháng 6 (áo trắng)", totalQuantity: 10, totalCost: 1_200_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuSom.id, variantId: "cogs-var-2", quantity: 10, unitCost: 120_000 });
  await rematerializeStale();
  const dongBang = await dongCua("cogs-o4");
  assert.equal(Number(dongBang.recognizedCogs), 300_000, "(2) đã chốt lại một lần thì ĐÓNG BĂNG — chứng từ mạnh hơn nữa cũng không đổi");
  assert.equal(dongBang.cogsBasis, "RECEIPT_AFTER");
  assert.equal((await nhatKy("cogs-o4")).length, 1, "(2) không có dòng nhật ký thứ hai");

  // (3) Chưa có phiếu nhưng Pancake ghi giá vốn trên dòng hàng ⇒ TẠM TÍNH, rồi chốt lại một lần theo phiếu.
  await db.insert(schema.productVariants).values({ id: "cogs-var-3", productId: "cogs-prod", sku: "COGS-3", color: "Xanh", size: "S", retailPrice: 500_000 }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: "cogs-o5", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-05-05T00:00:00Z") }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: "cogs-i5", orderId: "cogs-o5", variantId: "cogs-var-3", productId: "cogs-prod", productName: "Áo xanh", quantity: 1, unitPrice: 500_000, lineTotal: 500_000, unitCost: 90_000 }).onConflictDoNothing();
  await giaoThanhCong("cogs-s5", "cogs-o5", "COGS005", "2026-05-10T00:00:00Z");
  await rematerializeOutcomes(["cogs-o5"]);
  const tamTinh = await dongCua("cogs-o5");
  assert.equal(Number(tamTinh.recognizedCogs), 90_000, "(3) chưa có phiếu ⇒ dùng giá vốn Pancake làm tạm tính, không phải 0");
  assert.equal(tamTinh.cogsBasis, "PROVISIONAL");
  const [phieuTruoc] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-05-01T00:00:00Z"), reference: "Lô tháng 5 (áo xanh)", totalQuantity: 10, totalCost: 1_000_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuTruoc.id, variantId: "cogs-var-3", quantity: 10, unitCost: 100_000 });
  await rematerializeStale();
  const tamTinhDaChot = await dongCua("cogs-o5");
  assert.equal(Number(tamTinhDaChot.recognizedCogs), 100_000, "(3) phiếu nhập TRƯỚC ngày giao xuất hiện ⇒ chốt lại theo phiếu");
  assert.equal(tamTinhDaChot.cogsBasis, "RECEIPT_BEFORE", "(3) và căn cứ nay là có chứng từ");
  assert.equal(Number(tamTinhDaChot.truedUpFrom), 90_000);
  assert.equal(tamTinhDaChot.truedUpFromBasis, "PROVISIONAL");
  assert.equal((await nhatKy("cogs-o5")).length, 1);
  const [phieuNua] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-05-05T00:00:00Z"), reference: "Lô tháng 5 lần 2 (áo xanh)", totalQuantity: 10, totalCost: 1_100_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuNua.id, variantId: "cogs-var-3", quantity: 10, unitCost: 110_000 });
  await rematerializeStale();
  assert.equal(Number((await dongCua("cogs-o5")).recognizedCogs), 100_000, "(3) đã chốt lại một lần ⇒ đóng băng, phiếu sau không đổi được nữa");

  // (4) Đơn suy ngược (cogs-o3): thêm một lô nữa SAU ngày giao là cùng hạng chứng từ ⇒ không chốt lại.
  const truocLoMoi = await dongCua("cogs-o3");
  const [phieuThang10] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-10-01T00:00:00Z"), reference: "Lô tháng 10", totalQuantity: 10, totalCost: 3_000_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieuThang10.id, variantId: VARIANT, quantity: 10, unitCost: 300_000 });
  await rematerializeStale();
  const sauLoThang10 = await dongCua("cogs-o3");
  if (truocLoMoi.outcome === "DELIVERED") {
    assert.equal(Number(sauLoThang10.recognizedCogs), Number(truocLoMoi.recognizedCogs), "(4) lô mới cùng hạng (cũng lập sau ngày giao) không phải chứng từ mạnh hơn ⇒ giữ nguyên");
    assert.equal(sauLoThang10.truedUpAt, null, "(4) không tiêu quyền chốt lại");
    assert.equal(Number(sauLoThang10.cogs), 300_000, "(4) giá vốn 'hiện tại' vẫn theo lô mới nhất — đó là ước tính, không phải số kỳ đã qua");
  }
  clearMemo();

  // ───────── MỌI BÁO CÁO PHẢI DÙNG CÙNG MỘT GIÁ VỐN ─────────
  //
  // Sửa `getFinancialTruth` mà quên `reports.ts` thì Báo cáo lợi nhuận vẫn tự đổi khi kho nhập lô
  // mới, trong khi Bảng điều khiển thì không — hai màn hình nói hai con số cho cùng một tháng. Định
  // nghĩa nay nằm ở đúng MỘT hàm dùng chung (`orderCogsFast`), nên bài kiểm này khoá việc đó.
  clearMemo();
  const kyThang8: Period = {
    key: "custom",
    from: new Date("2026-08-01T00:00:00+07:00"),
    to: new Date("2026-08-31T23:59:59+07:00"),
    label: "Tháng 8",
    fromKey: "2026-08-01",
    toKey: "2026-08-31",
  };
  const [baoCao, chanLy] = await Promise.all([getProfitReport(kyThang8, "created"), getFinancialTruth(kyThang8)]);
  const cogsChanLy = Math.abs(chanLy.waterfall.find((w) => w.key === "cogs")?.amount ?? 0);
  assert.equal(
    baoCao.current.cogs,
    cogsChanLy,
    "Báo cáo lợi nhuận và Chân lý tài chính phải cùng một giá vốn — hai màn hình không được nói hai con số cho cùng một tháng",
  );

  const [{ n: chuaXacMinh }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.canonicalOrderOutcome)
    .where(eq(schema.canonicalOrderOutcome.cogsBasis, "RECEIPT_AFTER"));

  console.log(
    `✓ Giá vốn kỳ đã chốt: nhập lô mới KHÔNG viết lại lợi nhuận tháng trước · đơn chưa giao là CHƯA CÓ chứ không phải 0 · dựng lại nhiều lần vẫn y nguyên · ${chuaXacMinh} đơn mang căn cứ suy ngược được gắn nhãn`,
  );
}

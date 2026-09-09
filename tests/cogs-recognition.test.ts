import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CANONICAL_OUTCOME_VERSION, rematerializeOutcomes, rematerializeStale } from "@/lib/queries/canonical-outcome";
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

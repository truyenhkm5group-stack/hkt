/**
 * CHẠY THỬ NGẦM trên chính các hội thoại đã nạp — CHỈ ĐỌC.
 *
 * Không gọi mô hình, không gửi tin, không tạo đơn, không ghi một dòng nào. Bấm bao nhiêu lần cũng
 * ra cùng kết quả, nên nút này an toàn để bấm lại sau mỗi lần đổi cấu hình — mà đó chính là cách
 * dùng nó: đổi mã WIN hoặc khai một nguồn TEST rồi bấm xem con số đổi thế nào.
 *
 * Chỉ đếm hội thoại CÓ TIN KHÁCH: cuộc chưa ai nhắn thì không có gì để phân loại, tính vào mẫu chỉ
 * làm loãng tỷ lệ.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { classifyConversationSource } from "@/lib/ai-workforce/agents/sales/classify-source";
import { resolveProduct } from "@/lib/ai-workforce/agents/sales/resolve-product";
import type { ClassificationSource, SourceType } from "@/lib/constants/fanpage-sales";

export type BenchmarkResult = {
  pancakePageId: string;
  total: number;
  byType: Record<SourceType, number>;
  bySource: Partial<Record<ClassificationSource, number>>;
  /** Hội thoại WIN giải ra được mẫu hàng. */
  winResolved: number;
  winTotal: number;
  /** Hội thoại TEST gắn được hồ sơ mẫu test. */
  testResolved: number;
  testTotal: number;
  /**
   * SỐ PHẢI BẰNG 0: hội thoại TEST mà phép giải lại trả về một mẫu hàng ERP — tức là đã rơi về
   * mẫu thắng của page. Đây là con số duy nhất ở đây mà khác 0 nghĩa là hỏng thật.
   */
  testFellBackToWin: number;
  /** Hội thoại TEST thiếu dữ kiện (chưa có giá) — máy không được báo giá, không được mượn của WIN. */
  testMissingPrice: number;
  unresolved: number;
  ranAt: string;
};

const RONG: Record<SourceType, number> = { WIN: 0, TEST: 0, HUMAN_ONLY: 0, UNKNOWN: 0 };

export async function runShadowBenchmark(pancakePageId: string): Promise<BenchmarkResult> {
  const db = await getDb();
  const ds = await db
    .select({ id: schema.salesConversations.id })
    .from(schema.salesConversations)
    .where(
      and(
        eq(schema.salesConversations.pageId, pancakePageId),
        sql`exists (select 1 from sales_messages m where m.conversation_id = ${schema.salesConversations.id} and m.from_page = false and btrim(m.text) <> '')`,
      ),
    )
    .limit(500);

  const byType = { ...RONG };
  const bySource: Partial<Record<ClassificationSource, number>> = {};
  let winResolved = 0;
  let winTotal = 0;
  let testResolved = 0;
  let testTotal = 0;
  let testFellBackToWin = 0;
  let testMissingPrice = 0;
  let unresolved = 0;

  for (const c of ds) {
    const pl = await classifyConversationSource({ conversationId: c.id, pancakePageId }, db);
    byType[pl.sourceType] += 1;
    bySource[pl.classificationSource] = (bySource[pl.classificationSource] ?? 0) + 1;

    // Tin khách gần nhất — đúng thứ dây chuyền thật sẽ giải.
    const [tin] = await db
      .select({ text: schema.salesMessages.text })
      .from(schema.salesMessages)
      .where(and(eq(schema.salesMessages.conversationId, c.id), eq(schema.salesMessages.fromPage, false)))
      .orderBy(sql`${schema.salesMessages.sentAt} desc nulls last`)
      .limit(1);

    const kq = await resolveProduct({ conversationId: c.id, pageId: pancakePageId, text: tin?.text ?? "", classification: pl }, db);

    if (pl.sourceType === "WIN") {
      winTotal += 1;
      if (kq.productId) winResolved += 1;
      else unresolved += 1;
    } else if (pl.sourceType === "TEST") {
      testTotal += 1;
      if (pl.testProductId) testResolved += 1;
      // Phép giải KHÔNG được trả về mẫu hàng ERP cho hội thoại TEST.
      if (kq.productId) testFellBackToWin += 1;
      if (pl.offer?.unitPrice === null || pl.offer === null) testMissingPrice += 1;
    } else {
      unresolved += 1;
    }
  }

  return {
    pancakePageId,
    total: ds.length,
    byType,
    bySource,
    winResolved,
    winTotal,
    testResolved,
    testTotal,
    testFellBackToWin,
    testMissingPrice,
    unresolved,
    ranAt: new Date().toISOString(),
  };
}

/**
 * KIỂM KÊ ĐỘ ĐẦY ĐỦ CỦA ĐIỀU KIỆN BÁN cho mã WIN của một page.
 *
 * Bật mô hình thật khi hồ sơ còn thiếu là mời nó tự điền vào chỗ trống — mà chỗ trống ở đây là
 * giá, màu, bảng số đo, chính sách đổi trả. Bảng này là danh sách việc phải làm TRƯỚC, không phải
 * một cảnh báo để bỏ qua.
 */
export type OfferAudit = {
  field: string;
  ok: boolean;
  value: string;
  why: string;
};

export async function auditWinOffer(pancakePageId: string): Promise<{ productCode: string; rows: OfferAudit[] }> {
  const db = await getDb();
  const [h] = await db
    .select()
    .from(schema.fanpageSalesProfiles)
    .where(eq(schema.fanpageSalesProfiles.pancakePageId, pancakePageId))
    .limit(1);
  if (!h) return { productCode: "", rows: [{ field: "hồ sơ fanpage", ok: false, value: "chưa có", why: "Chưa khai hồ sơ cho page này" }] };

  const [sp] = h.activeProductId
    ? await db.select({ code: schema.products.customId, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, h.activeProductId)).limit(1)
    : [];

  const soMauMa = h.activeProductId
    ? await db
        .select({ n: sql<number>`count(*)::int`, colors: sql<string>`string_agg(distinct nullif(${schema.productVariants.color}, ''), ', ')` })
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.productId, h.activeProductId), eq(schema.productVariants.isRemoved, false)))
    : [];

  const [size] = h.sizeProfileId
    ? await db.select({ name: schema.salesSizeProfiles.name, rules: schema.salesSizeProfiles.rules }).from(schema.salesSizeProfiles).where(eq(schema.salesSizeProfiles.id, h.sizeProfileId)).limit(1)
    : [];

  const mauERP = String(soMauMa[0]?.colors ?? "");
  const rows: OfferAudit[] = [
    { field: "Mã WIN", ok: Boolean(h.activeProductId), value: sp?.code ? `${sp.code} · ${sp.name}` : "chưa khai", why: "Chưa khai thì mọi hội thoại rơi về UNKNOWN và chuyển người" },
    { field: "Giá bán", ok: h.unitPrice !== null, value: h.unitPrice === null ? "CHƯA KHAI" : `${h.unitPrice.toLocaleString("vi-VN")}đ`, why: "Chưa khai thì máy không được báo giá" },
    { field: "Phí ship", ok: h.shippingFee !== null, value: h.shippingFee === null ? "CHƯA KHAI" : `${h.shippingFee.toLocaleString("vi-VN")}đ`, why: "Chưa khai thì máy không nói được tổng tiền" },
    { field: "Giá combo", ok: Boolean(h.comboPricing), value: h.comboPricing ? "đã khai" : "CHƯA KHAI", why: "Không có thì máy không chào được combo — mất một đường tăng giá trị đơn" },
    { field: "Ngưỡng miễn ship", ok: h.freeShipFrom !== null, value: h.freeShipFrom === null ? "CHƯA KHAI" : `${h.freeShipFrom.toLocaleString("vi-VN")}đ`, why: "Không bắt buộc, nhưng chưa khai thì máy không được hứa miễn ship" },
    { field: "Màu đang có", ok: h.availableColors.length > 0, value: h.availableColors.length ? h.availableColors.join(", ") : `CHƯA KHAI${mauERP ? ` (ERP có: ${mauERP})` : ""}`, why: "Chưa khai thì máy không tư vấn được màu, dù ERP có mẫu mã" },
    { field: "Bảng số đo", ok: Boolean(size && Array.isArray(size.rules) && (size.rules as unknown[]).length > 0), value: size ? `${size.name}${Array.isArray(size.rules) ? ` (${(size.rules as unknown[]).length} dòng)` : " (chưa có dòng nào)"}` : "CHƯA CÓ", why: "Thiếu thì khách hỏi size phải chuyển người — máy không được đoán size trên cơ thể người thật" },
    { field: "Chính sách COD", ok: Boolean(h.codPolicy), value: h.codPolicy || "CHƯA KHAI", why: "Khách hỏi thanh toán thì máy phải né hoặc chuyển người" },
    { field: "Chính sách kiểm hàng", ok: Boolean(h.inspectionPolicy), value: h.inspectionPolicy || "CHƯA KHAI", why: "Câu hỏi rất hay gặp; chưa khai là chưa trả lời được" },
    { field: "Thời gian giao", ok: Boolean(h.deliveryEstimate), value: h.deliveryEstimate || "CHƯA KHAI", why: "Chưa khai thì máy không được hứa ngày giao" },
    { field: "Chính sách đổi trả", ok: Boolean(h.exchangePolicy), value: h.exchangePolicy || "CHƯA KHAI", why: "Liên quan trực tiếp tới tỷ lệ hoàn" },
    { field: "Câu dữ kiện đã duyệt", ok: h.approvedFacts.length > 0, value: h.approvedFacts.length ? `${h.approvedFacts.length} câu` : "CHƯA KHAI", why: "Không có thì mô hình thật sẽ tự nghĩ ra dữ kiện khi bị hỏi ngoài kịch bản" },
  ];
  return { productCode: sp?.code ?? "", rows };
}

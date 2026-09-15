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

/**
 * BẢN ĐỒ QUẢNG CÁO → SẢN PHẨM: đọc cho màn hình người bấm.
 *
 * Trả về HAI danh sách, và sự tách bạch ấy mới là điểm chính:
 *   · `daMap`    — khoá đã trỏ tới một sản phẩm.
 *   · `chuaMap`  — khoá THẬT SỰ xuất hiện trong hội thoại mà chưa ai trỏ đi đâu. Đây là việc phải
 *                  làm, và nó được xếp theo SỐ HỘI THOẠI đang chờ, để người bấm cái đáng tiền nhất
 *                  trước chứ không bấm theo thứ tự chữ cái.
 */
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

export type AdMapRow = {
  pageId: string;
  adKey: string;
  keyKind: string;
  productId: string | null;
  productName: string;
  productCode: string;
  source: string;
  confidence: number;
  adDescription: string;
  mediaUrl: string;
  evidence: string;
  conversations: number;
};

export type UnmappedRow = {
  pageId: string;
  adKey: string;
  keyKind: string;
  adDescription: string;
  /** Ảnh của quảng cáo — danh mục đặt tên bằng mã nên người phải NHÌN mới trỏ đúng được. */
  mediaUrl: string;
  postUrl: string;
  conversations: number;
  messages: number;
};

export async function listAdMappings(): Promise<AdMapRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      pageId: schema.salesAdProductMap.pageId,
      adKey: schema.salesAdProductMap.adKey,
      keyKind: schema.salesAdProductMap.keyKind,
      productId: schema.salesAdProductMap.productId,
      productName: schema.products.name,
      productCode: schema.products.customId,
      source: schema.salesAdProductMap.source,
      confidence: schema.salesAdProductMap.confidence,
      adDescription: schema.salesAdProductMap.adDescription,
      evidence: schema.salesAdProductMap.evidence,
      mediaUrl: sql<string>`(select max(m.ad_media_url) from sales_messages m where m.ad_id = ${schema.salesAdProductMap.adKey})`,
      conversations: sql<number>`(
        select count(distinct m.conversation_id)::int from sales_messages m
        where m.ad_id = ${schema.salesAdProductMap.adKey} or m.post_url = ${schema.salesAdProductMap.adKey}
      )`,
    })
    .from(schema.salesAdProductMap)
    .leftJoin(schema.products, eq(schema.products.id, schema.salesAdProductMap.productId))
    .orderBy(desc(schema.salesAdProductMap.updatedAt))
    .limit(500);
  return rows.map((r) => ({
    ...r,
    productName: r.productName ?? "",
    productCode: r.productCode ?? "",
    mediaUrl: r.mediaUrl ?? "",
    conversations: Number(r.conversations ?? 0),
  }));
}

/**
 * Khoá quảng cáo ĐANG CÓ TRONG HỘI THOẠI mà chưa ai ánh xạ.
 * Chỉ liệt kê khoá có thật trong dữ liệu — một danh sách đoán trước sẽ đầy khoá không ai gặp.
 */
export async function listUnmappedAdKeys(): Promise<UnmappedRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      pageId: schema.salesMessages.platform,
      adKey: schema.salesMessages.adId,
      adDescription: sql<string>`max(${schema.salesMessages.adDescription})`,
      mediaUrl: sql<string>`max(${schema.salesMessages.adMediaUrl})`,
      postUrl: sql<string>`max(${schema.salesMessages.postUrl})`,
      conversations: sql<number>`count(distinct ${schema.salesMessages.conversationId})::int`,
      messages: sql<number>`count(*)::int`,
      pageReal: sql<string>`max(c.page_id)`,
    })
    .from(schema.salesMessages)
    .leftJoin(sql`sales_conversations c`, sql`c.id = ${schema.salesMessages.conversationId}`)
    .where(
      and(
        ne(schema.salesMessages.adId, ""),
        isNotNull(schema.salesMessages.adId),
        sql`not exists (select 1 from sales_ad_product_map m where m.ad_key = ${schema.salesMessages.adId})`,
      ),
    )
    .groupBy(schema.salesMessages.adId, schema.salesMessages.platform)
    .orderBy(sql`count(distinct ${schema.salesMessages.conversationId}) desc`)
    .limit(200);
  return rows.map((r) => ({
    pageId: r.pageReal ?? "",
    adKey: r.adKey,
    keyKind: "AD",
    adDescription: r.adDescription ?? "",
    mediaUrl: r.mediaUrl ?? "",
    postUrl: r.postUrl ?? "",
    conversations: Number(r.conversations ?? 0),
    messages: Number(r.messages ?? 0),
  }));
}

/** Danh mục rút gọn cho ô chọn sản phẩm. */
export async function listProductChoices() {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.products.id, name: schema.products.name, code: schema.products.customId })
    .from(schema.products)
    .where(and(eq(schema.products.isRemoved, false), eq(schema.products.isHidden, false)))
    .orderBy(schema.products.name)
    .limit(1000);
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? "" }));
}

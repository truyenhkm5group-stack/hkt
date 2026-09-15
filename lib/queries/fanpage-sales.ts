/**
 * ĐỌC CẤU HÌNH BÁN HÀNG THEO FANPAGE cho màn hình người bấm.
 *
 * Liệt kê MỌI page có hội thoại trong ERP, kể cả page CHƯA có hồ sơ — page chưa khai mới là page
 * cần khai, giấu nó đi thì không ai biết nó tồn tại.
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

export type FanpageRow = {
  pancakePageId: string;
  name: string;
  hasProfile: boolean;
  aiMode: string;
  active: boolean;
  version: number;
  activeProductId: string | null;
  activeProductCode: string;
  activeProductName: string;
  unitPrice: number | null;
  shippingFee: number | null;
  availableColors: string[];
  sizeProfileId: string | null;
  conversations: number;
  /** Hội thoại đã chụp ảnh ngữ cảnh — con số này chỉ tăng, không đổi khi cấu hình đổi. */
  snapshotted: number;
};

export async function listFanpages(): Promise<FanpageRow[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    select
      pg.page_id                                         as pancake_page_id,
      coalesce(f.name, '')                               as name,
      (f.id is not null)                                 as has_profile,
      coalesce(f.ai_mode, 'SHADOW')                      as ai_mode,
      coalesce(f.active, true)                           as active,
      coalesce(f.version, 0)                             as version,
      f.active_product_id                                as active_product_id,
      coalesce(p.custom_id, '')                          as active_product_code,
      coalesce(p.name, '')                               as active_product_name,
      f.unit_price                                       as unit_price,
      f.shipping_fee                                     as shipping_fee,
      coalesce(f.available_colors, '{}')                 as available_colors,
      f.size_profile_id                                  as size_profile_id,
      pg.n                                               as conversations,
      pg.snap                                            as snapshotted
    from (
      select page_id,
             count(*)::int                                          as n,
             count(*) filter (where source_type <> '')::int          as snap
      from sales_conversations where page_id <> '' group by page_id
    ) pg
    left join fanpage_sales_profiles f on f.pancake_page_id = pg.page_id
    left join products p on p.id = f.active_product_id
    order by pg.n desc
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    pancakePageId: String(r.pancake_page_id),
    name: String(r.name ?? ""),
    hasProfile: Boolean(r.has_profile),
    aiMode: String(r.ai_mode ?? "SHADOW"),
    active: Boolean(r.active),
    version: Number(r.version ?? 0),
    activeProductId: (r.active_product_id as string) ?? null,
    activeProductCode: String(r.active_product_code ?? ""),
    activeProductName: String(r.active_product_name ?? ""),
    unitPrice: r.unit_price === null || r.unit_price === undefined ? null : Number(r.unit_price),
    shippingFee: r.shipping_fee === null || r.shipping_fee === undefined ? null : Number(r.shipping_fee),
    availableColors: (r.available_colors as string[]) ?? [],
    sizeProfileId: (r.size_profile_id as string) ?? null,
    conversations: Number(r.conversations ?? 0),
    snapshotted: Number(r.snapshotted ?? 0),
  }));
}

export type SourceRuleRow = {
  id: string;
  pancakePageId: string;
  sourceKind: string;
  sourceId: string;
  sourceType: string;
  productCode: string;
  testCode: string;
  note: string;
  conversations: number;
  adDescription: string;
  mediaUrl: string;
};

export async function listSourceRules(pancakePageId?: string): Promise<SourceRuleRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.salesSourceRules.id,
      pancakePageId: schema.salesSourceRules.pancakePageId,
      sourceKind: schema.salesSourceRules.sourceKind,
      sourceId: schema.salesSourceRules.sourceId,
      sourceType: schema.salesSourceRules.sourceType,
      productCode: schema.products.customId,
      testCode: schema.testProductProfiles.testCode,
      note: schema.salesSourceRules.note,
      conversations: sql<number>`(select count(distinct m.conversation_id)::int from sales_messages m where m.ad_id = ${schema.salesSourceRules.sourceId} or m.post_url = ${schema.salesSourceRules.sourceId})`,
      adDescription: sql<string>`(select max(m.ad_description) from sales_messages m where m.ad_id = ${schema.salesSourceRules.sourceId})`,
      mediaUrl: sql<string>`(select max(m.ad_media_url) from sales_messages m where m.ad_id = ${schema.salesSourceRules.sourceId})`,
    })
    .from(schema.salesSourceRules)
    .leftJoin(schema.products, eq(schema.products.id, schema.salesSourceRules.productId))
    .leftJoin(schema.testProductProfiles, eq(schema.testProductProfiles.id, schema.salesSourceRules.testProductId))
    .where(pancakePageId ? eq(schema.salesSourceRules.pancakePageId, pancakePageId) : undefined)
    .orderBy(desc(schema.salesSourceRules.updatedAt))
    .limit(300);
  return rows.map((r) => ({
    ...r,
    productCode: r.productCode ?? "",
    testCode: r.testCode ?? "",
    conversations: Number(r.conversations ?? 0),
    adDescription: r.adDescription ?? "",
    mediaUrl: r.mediaUrl ?? "",
  }));
}


/** Nguồn CÓ THẬT trong dữ liệu mà chưa có luật — ứng viên để khai ngoại lệ. */
export async function listSourcesWithoutRule(pancakePageId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      sourceId: schema.salesMessages.adId,
      conversations: sql<number>`count(distinct ${schema.salesMessages.conversationId})::int`,
      adDescription: sql<string>`max(${schema.salesMessages.adDescription})`,
      mediaUrl: sql<string>`max(${schema.salesMessages.adMediaUrl})`,
    })
    .from(schema.salesMessages)
    .where(sql`${schema.salesMessages.adId} <> '' and not exists (select 1 from sales_source_rules r where r.source_id = ${schema.salesMessages.adId} and r.pancake_page_id = ${pancakePageId})`)
    .groupBy(schema.salesMessages.adId)
    .orderBy(sql`count(distinct ${schema.salesMessages.conversationId}) desc`)
    .limit(50);
  return rows.map((r) => ({ ...r, conversations: Number(r.conversations ?? 0), adDescription: r.adDescription ?? "", mediaUrl: r.mediaUrl ?? "" }));
}

export async function listTestProducts() {
  const db = await getDb();
  return db
    .select({
      id: schema.testProductProfiles.id,
      testCode: schema.testProductProfiles.testCode,
      name: schema.testProductProfiles.name,
      status: schema.testProductProfiles.status,
      price: schema.testProductProfiles.price,
      colors: schema.testProductProfiles.colors,
      aiReplyEnabled: schema.testProductProfiles.aiReplyEnabled,
      allowAutoOrderCreate: schema.testProductProfiles.allowAutoOrderCreate,
    })
    .from(schema.testProductProfiles)
    .orderBy(desc(schema.testProductProfiles.updatedAt))
    .limit(200);
}

/*
 * KHÔNG CÓ `listSizeProfiles` Ở ĐÂY NỮA.
 *
 * Bảng số đo là của máy gợi ý size (`settings["ai.sizeRules"]`), đọc qua `sizeRuleFor()`. Một hàm
 * liệt kê "các bảng số đo" từ một bảng riêng là dấu hiệu bảng riêng ấy còn tồn tại — 0091 đã gỡ nó.
 */

export type SourceLine = {
  sourceId: string;
  sourceKind: string;
  /** DEFAULT_WIN khi chưa có luật — mặc định của fanpage vốn đã là WIN. */
  status: "DEFAULT_WIN" | "TEST" | "HUMAN_ONLY";
  testCode: string;
  adDescription: string;
  mediaUrl: string;
  conversations: number;
};

/**
 * MỌI nguồn CÓ THẬT đang phát sinh hội thoại của một page, kèm trạng thái hiện tại — một danh
 * sách duy nhất thay vì hai bảng "đã khai" và "chưa khai".
 *
 * Gộp lại là có chủ ý: việc hằng ngày là NHÌN một danh sách rồi đổi vài dòng, không phải đối chiếu
 * qua lại giữa hai bảng để biết dòng nào đang ở đâu.
 */
export async function listSourceLines(pancakePageId: string): Promise<SourceLine[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    select
      s.source_id                                  as source_id,
      coalesce(r.source_kind, 'AD')                as source_kind,
      coalesce(r.source_type, 'DEFAULT_WIN')       as status,
      coalesce(t.test_code, '')                    as test_code,
      coalesce(s.ad_description, '')               as ad_description,
      coalesce(s.media_url, '')                    as media_url,
      s.n                                          as conversations
    from (
      select m.ad_id as source_id,
             max(m.ad_description) as ad_description,
             max(m.ad_media_url)   as media_url,
             count(distinct m.conversation_id)::int as n
      from sales_messages m
      join sales_conversations c on c.id = m.conversation_id
      where m.ad_id <> '' and c.page_id = ${pancakePageId}
      group by m.ad_id
    ) s
    left join sales_source_rules r on r.source_id = s.source_id and r.pancake_page_id = ${pancakePageId}
    left join test_product_profiles t on t.id = r.test_product_id
    order by s.n desc
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    sourceId: String(r.source_id),
    sourceKind: String(r.source_kind ?? "AD"),
    status: String(r.status) as SourceLine["status"],
    testCode: String(r.test_code ?? ""),
    adDescription: String(r.ad_description ?? ""),
    mediaUrl: String(r.media_url ?? ""),
    conversations: Number(r.conversations ?? 0),
  }));
}

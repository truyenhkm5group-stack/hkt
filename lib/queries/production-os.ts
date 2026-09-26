import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { REQUIRE_APPROVED_DESIGN_KEY, TOPIC_OPEN_STATUSES, TOPIC_STATUSES, TOPIC_STATUS_LABEL, type TopicStatus } from "@/lib/constants/production-os";
import { isProvisionalModel } from "@/lib/constants/provisional-model";
import { designOptionsForProduct } from "@/lib/production/orders";
import { getSettingJson } from "@/lib/settings";
import type { ListParams } from "@/lib/search-params";

/**
 * ═══════════ ĐỌC: SẢN XUẤT NỬA ĐẦU (Company OS · Agent C) ═══════════
 *
 * Chỉ đọc. Không công thức mới cho con số đã có: tổng giá thành đọc từ cột đã lưu lúc lập / chốt, không
 * tính lại ở đây.
 */

const tp = schema.productionTopics;
const pm = schema.productModels;

/**
 * Cờ bắt buộc bản duyệt khi gửi xưởng. CHỈ đúng giá trị JSON `true` mới tính — không có dòng, chuỗi
 * `"true"`, JSON hỏng, lỗi CSDL ⇒ TẮT (mọi nhánh lỗi rơi về phía cũ: chỉ cảnh báo).
 *
 * Đọc qua bộ đọc chung `getSettingJson` với mặc định `false`: từ Agent K nó trả đúng giá trị nguyên thuỷ
 * CÙNG KIỂU với mặc định (chuỗi `"true"` khác kiểu ⇒ mặc định), nên bản đọc thẳng dòng C từng phải viết để
 * né lỗi `{ ...fallback, ...parsed }` đã bỏ — cùng hành vi ở mọi nhánh (kiểm thử khoá).
 */
export async function requireApprovedDesignFlag(): Promise<boolean> {
  return (await getSettingJson<boolean>(REQUIRE_APPROVED_DESIGN_KEY, false)) === true;
}

export const TOPIC_SORTABLE = ["updatedAt", "createdAt", "status"];

export type TopicListRow = {
  id: string;
  title: string;
  status: TopicStatus;
  modelId: string;
  modelCode: string;
  modelName: string;
  supplierName: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  messages: number;
  lastQuote: number | null;
};

export async function listTopics(params: ListParams): Promise<{ rows: TopicListRow[]; total: number; pageCount: number }> {
  const db = await getDb();
  const conds: SQL[] = [];
  const st = (params.filters.status ?? []).filter((s): s is TopicStatus => (TOPIC_STATUSES as readonly string[]).includes(s));
  if (st.length) conds.push(inArray(tp.status, st));
  if (params.filters.open?.includes("1")) conds.push(inArray(tp.status, [...TOPIC_OPEN_STATUSES]));
  if (params.q) {
    const q = `%${params.q}%`;
    conds.push(or(ilike(tp.title, q), ilike(pm.code, q), ilike(pm.name, q))!);
  }
  const where = conds.length ? and(...conds) : undefined;
  const huong = params.dir === "asc" ? asc : desc;
  const orderCol = params.sort === "createdAt" ? tp.createdAt : params.sort === "status" ? tp.status : tp.updatedAt;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: tp.id,
        title: tp.title,
        status: tp.status,
        modelId: pm.id,
        modelCode: pm.code,
        modelName: pm.name,
        supplierName: schema.suppliers.name,
        createdBy: tp.createdBy,
        createdAt: tp.createdAt,
        updatedAt: tp.updatedAt,
        messages: sql<number>`(select count(*)::int from ${schema.productionTopicMessages} m where m.topic_id = "production_topics"."id")`,
        lastQuote: sql<number | null>`(select m.quoted_unit_price from ${schema.productionTopicMessages} m where m.topic_id = "production_topics"."id" and m.kind = 'QUOTE' order by m.created_at desc limit 1)`,
      })
      .from(tp)
      .innerJoin(pm, eq(pm.id, tp.modelId))
      .leftJoin(schema.suppliers, eq(schema.suppliers.id, tp.supplierId))
      .where(where)
      .orderBy(huong(orderCol), desc(tp.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    db.select({ total: count() }).from(tp).innerJoin(pm, eq(pm.id, tp.modelId)).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, status: r.status as TopicStatus, messages: Number(r.messages), lastQuote: r.lastQuote === null ? null : Number(r.lastQuote) })),
    total: Number(total),
    pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)),
  };
}

export async function topicStatusFacets(): Promise<{ value: string; label: string; count: number }[]> {
  const db = await getDb();
  const rows = await db.select({ status: tp.status, n: count() }).from(tp).groupBy(tp.status);
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  return TOPIC_STATUSES.map((s) => ({ value: s, label: TOPIC_STATUS_LABEL[s], count: by.get(s) ?? 0 }));
}

export async function listSupplierOptions(): Promise<{ id: string; name: string }[]> {
  const db = await getDb();
  return db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.active, true)).orderBy(asc(schema.suppliers.name));
}

/** Mẫu chọn được khi mở topic từ `/production/topics/new` (không có `?model=`). */
export async function listModelOptions(): Promise<{ id: string; code: string; name: string; state: string | null; provisional: boolean }[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: pm.id, code: pm.code, name: pm.name, state: pm.lifecycleState, registeredBy: pm.registeredBy, productId: pm.productId, designConceptId: pm.designConceptId })
    .from(pm)
    .orderBy(asc(pm.code))
    .limit(2000);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, state: r.state, provisional: isProvisionalModel(r) }));
}

export async function getModelBrief(modelId: string) {
  const db = await getDb();
  const [m] = await db
    .select({ id: pm.id, code: pm.code, name: pm.name, state: pm.lifecycleState, productId: pm.productId, productName: schema.products.name, productImage: schema.products.image, registeredBy: pm.registeredBy, designConceptId: pm.designConceptId })
    .from(pm)
    .leftJoin(schema.products, eq(schema.products.id, pm.productId))
    .where(eq(pm.id, modelId))
    .limit(1);
  return m ? { ...m, provisional: isProvisionalModel(m) } : null;
}

/** Toàn bộ bàn sản xuất của MỘT mẫu: giá thành (mọi phiên bản + dòng), mẫu (mọi phiên bản + phán quyết), bản duyệt. */
export async function getModelProductionDesk(modelId: string) {
  const db = await getDb();
  const cs = schema.costSheets;
  const sm = schema.samples;
  const [sheets, lines, samplesRows, reviews, designs] = await Promise.all([
    db.select().from(cs).where(eq(cs.modelId, modelId)).orderBy(desc(cs.version)),
    db
      .select({ line: schema.costSheetLines })
      .from(schema.costSheetLines)
      .innerJoin(cs, eq(cs.id, schema.costSheetLines.costSheetId))
      .where(eq(cs.modelId, modelId))
      .orderBy(asc(schema.costSheetLines.sortOrder)),
    db
      .select({ sample: sm, supplierName: schema.suppliers.name })
      .from(sm)
      .leftJoin(schema.suppliers, eq(schema.suppliers.id, sm.supplierId))
      .where(eq(sm.modelId, modelId))
      .orderBy(desc(sm.version)),
    db
      .select({ review: schema.sampleReviews })
      .from(schema.sampleReviews)
      .innerJoin(sm, eq(sm.id, schema.sampleReviews.sampleId))
      .where(eq(sm.modelId, modelId)),
    db.select().from(schema.designVersions).where(eq(schema.designVersions.modelId, modelId)).orderBy(desc(schema.designVersions.version)),
  ]);
  const linesBySheet = new Map<string, (typeof lines)[number]["line"][]>();
  for (const { line } of lines) linesBySheet.set(line.costSheetId, [...(linesBySheet.get(line.costSheetId) ?? []), line]);
  const reviewBySample = new Map(reviews.map(({ review }) => [review.sampleId, review]));
  const designBySample = new Map(designs.map((d) => [d.sampleId, d]));
  return {
    costSheets: sheets.map((s) => ({ ...s, lines: linesBySheet.get(s.id) ?? [] })),
    samples: samplesRows.map(({ sample, supplierName }) => ({ ...sample, supplierName, review: reviewBySample.get(sample.id) ?? null, design: designBySample.get(sample.id) ?? null })),
    designVersions: designs,
  };
}

export async function getTopicDetail(topicId: string) {
  const db = await getDb();
  const [t] = await db
    .select({ topic: tp, supplierName: schema.suppliers.name })
    .from(tp)
    .leftJoin(schema.suppliers, eq(schema.suppliers.id, tp.supplierId))
    .where(eq(tp.id, topicId))
    .limit(1);
  if (!t) return null;
  const [model, messages, desk] = await Promise.all([
    getModelBrief(t.topic.modelId),
    db.select().from(schema.productionTopicMessages).where(eq(schema.productionTopicMessages.topicId, topicId)).orderBy(asc(schema.productionTopicMessages.createdAt), asc(schema.productionTopicMessages.id)),
    getModelProductionDesk(t.topic.modelId),
  ]);
  return { topic: { ...t.topic, status: t.topic.status as TopicStatus, supplierName: t.supplierName }, model, messages, ...desk };
}

/** Bản duyệt chọn được cho lệnh của một sản phẩm — trình sửa lệnh SX dùng. */
export async function designOptionsForPo(productId: string | null) {
  const db = await getDb();
  return designOptionsForProduct(db, productId);
}

export async function getDesignVersionBrief(id: string | null) {
  if (!id) return null;
  const db = await getDb();
  const [d] = await db
    .select({ id: schema.designVersions.id, version: schema.designVersions.version, modelId: schema.designVersions.modelId, modelCode: pm.code, approvedAt: schema.designVersions.approvedAt, approvedBy: schema.designVersions.approvedBy })
    .from(schema.designVersions)
    .innerJoin(pm, eq(pm.id, schema.designVersions.modelId))
    .where(eq(schema.designVersions.id, id))
    .limit(1);
  return d ?? null;
}

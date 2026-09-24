import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  CREATIVE_CONFIG_KEY,
  CREATIVE_SOURCE_KINDS,
  normalizeCreativeConfig,
  parseOwnAdMetrics,
  parsePartialGenes,
  type ConfigProblem,
  type CreativeLoopConfig,
  type CreativeSourceKind,
  type Genes,
  type OwnAdMetrics,
} from "@/lib/constants/creative-loop";

/**
 * ═══════════ VÒNG MẪU — ĐỌC NGUỒN ẢNH VÀ CẤU HÌNH (CHỈ ĐỌC) ═══════════
 *
 * Phục vụ hai tab "Nguồn ảnh" và "Cấu hình" của `/marketing/creatives`. Tệp nằm trong `lib/queries`
 * nên CHỈ ĐỌC (`tests/advisory-safety.test.ts`); mọi phép ghi ở `lib/actions/creative-*.ts`.
 *
 * Truy vấn danh sách KHÔNG BAO GIỜ kéo điểm ảnh (`creative_images.data`) — chỉ id và mốc xoá.
 */

const s = schema.creativeSources;
const img = schema.creativeImages;
const p = schema.products;

export type CreativeSourceRow = {
  id: string;
  kind: CreativeSourceKind;
  productId: string | null;
  productName: string | null;
  productCode: string | null;
  title: string;
  note: string;
  sourceUrl: string;
  /** `null` khi chưa có ảnh HOẶC điểm ảnh đã bị xoá — `imagePurged` phân biệt hai trường hợp. */
  imageId: string | null;
  imagePurged: boolean;
  /** Gen ĐỌC ĐƯỢC (một phần). Rỗng + `visionAt = null` ⇒ CHƯA ĐỌC, không phải "không có gen". */
  genes: Partial<Genes>;
  visionSummary: string;
  visionAt: Date | null;
  active: boolean;
  createdByName: string;
  createdAt: Date;
  /** Số mẫu (ô trong lô) đã dùng nguồn này làm ảnh gốc hoặc nguồn cảm hứng. */
  uses: number;
  /** Chỉ `OWN_AD`: mẩu QC gốc, số đo chụp lúc nhập, câu chữ đã chạy. Nguồn khác: `null` / rỗng. */
  fbAdId: string | null;
  ownAd: OwnAdMetrics | null;
  headline: string;
  primaryText: string;
};

/** Rỗng = không lọc. Giá trị lạ trong URL bị bỏ, không làm rỗng danh sách. */
export type SourceFilter = { kinds?: string[]; active?: string[]; q?: string };

function sourceWhere(f: SourceFilter): SQL | undefined {
  const conds: SQL[] = [];
  const kinds = (f.kinds ?? []).filter((k) => (CREATIVE_SOURCE_KINDS as readonly string[]).includes(k));
  if (kinds.length) conds.push(inArray(s.kind, kinds));
  const on = (f.active ?? []).includes("ON");
  const off = (f.active ?? []).includes("OFF");
  if (on !== off) conds.push(eq(s.active, on));
  const q = (f.q ?? "").trim();
  if (q) conds.push(sql`(${s.title} ilike ${`%${q}%`} or ${s.note} ilike ${`%${q}%`} or coalesce(${p.name}, '') ilike ${`%${q}%`} or coalesce(${p.customId}, '') ilike ${`%${q}%`})`);
  return conds.length ? and(...conds) : undefined;
}

export async function listCreativeSources(f: SourceFilter & { page?: number; pageSize?: number }): Promise<{ rows: CreativeSourceRow[]; total: number; pageCount: number }> {
  const db = await getDb();
  const pageSize = Math.min(96, Math.max(1, f.pageSize ?? 24));
  const page = Math.max(1, f.page ?? 1);
  const cond = sourceWhere(f);
  const uses = sql<number>`(select count(*)::int from ${schema.creativeVariants} v where v.product_photo_source_id = ${s.id} or v.inspiration_source_id = ${s.id})`;
  const [rows, [tong]] = await Promise.all([
    db
      .select({
        id: s.id,
        kind: s.kind,
        productId: s.productId,
        productName: p.name,
        productCode: p.customId,
        title: s.title,
        note: s.note,
        sourceUrl: s.sourceUrl,
        imageId: s.imageId,
        purgedAt: img.purgedAt,
        genes: s.genes,
        visionSummary: s.visionSummary,
        visionAt: s.visionAt,
        active: s.active,
        createdByName: s.createdByName,
        createdAt: s.createdAt,
        uses,
        fbAdId: s.fbAdId,
        metrics: s.metrics,
        headline: s.headline,
        primaryText: s.primaryText,
      })
      .from(s)
      .leftJoin(p, eq(p.id, s.productId))
      .leftJoin(img, eq(img.id, s.imageId))
      .where(cond)
      .orderBy(desc(s.createdAt), desc(s.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(s).leftJoin(p, eq(p.id, s.productId)).where(cond),
  ]);
  const total = Number(tong?.n ?? 0);
  return {
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((r) => ({
      id: r.id,
      kind: (CREATIVE_SOURCE_KINDS as readonly string[]).includes(r.kind) ? (r.kind as CreativeSourceKind) : "MANUAL",
      productId: r.productId,
      productName: r.productName,
      productCode: r.productCode,
      title: r.title,
      note: r.note,
      sourceUrl: r.sourceUrl,
      imageId: r.imageId && !r.purgedAt ? r.imageId : null,
      imagePurged: Boolean(r.imageId && r.purgedAt),
      genes: parsePartialGenes(r.genes),
      visionSummary: r.visionSummary,
      visionAt: r.visionAt,
      active: r.active,
      createdByName: r.createdByName,
      createdAt: r.createdAt,
      uses: Number(r.uses ?? 0),
      fbAdId: r.fbAdId,
      ownAd: r.kind === "OWN_AD" ? parseOwnAdMetrics(r.metrics) : null,
      headline: r.headline,
      primaryText: r.primaryText,
    })),
  };
}

export type SourceCounts = {
  /** Nguồn ĐANG BẬT theo loại. */
  activeByKind: Record<CreativeSourceKind, number>;
  total: number;
  /** Số MÃ HÀNG có ít nhất một ảnh sản phẩm thật đang bật — mã nào không có thì máy không test được. */
  productsWithPhoto: number;
};

export async function creativeSourceCounts(): Promise<SourceCounts> {
  const db = await getDb();
  const [byKind, [tong], [ma]] = await Promise.all([
    db.select({ kind: s.kind, n: count() }).from(s).where(eq(s.active, true)).groupBy(s.kind),
    db.select({ n: count() }).from(s),
    db
      .select({ n: sql<number>`count(distinct ${s.productId})::int` })
      .from(s)
      .where(and(eq(s.kind, "PRODUCT_PHOTO"), eq(s.active, true))),
  ]);
  const activeByKind = Object.fromEntries(CREATIVE_SOURCE_KINDS.map((k) => [k, 0])) as Record<CreativeSourceKind, number>;
  for (const r of byKind) if (r.kind in activeByKind) activeByKind[r.kind as CreativeSourceKind] = Number(r.n);
  return { activeByKind, total: Number(tong?.n ?? 0), productsWithPhoto: Number(ma?.n ?? 0) };
}

export type ProductOption = { id: string; name: string; code: string };

/** Danh sách mã hàng cho ô tìm mã (ảnh sản phẩm thật · mã ưu tiên). Bỏ sản phẩm đã xoá trên Pancake. */
export async function listCreativeProductOptions(): Promise<ProductOption[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: p.id, name: p.name, code: p.customId })
    .from(p)
    .where(eq(p.isRemoved, false))
    .orderBy(p.name)
    .limit(5000);
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? "" }));
}

export type CreativeConfigState = {
  /** Đã có dòng `creative.config` trong `settings` chưa. Chưa ⇒ đang chạy bằng mặc định trong mã. */
  saved: boolean;
  /** Dòng đã lưu không đọc được JSON — cấu hình rơi về mặc định và màn hình phải nói ra. */
  unreadable: boolean;
  config: CreativeLoopConfig;
  problems: ConfigProblem[];
  updatedAt: Date | null;
};

/**
 * Cấu hình vòng mẫu như MÁY sẽ đọc nó: dòng thô trong `settings` → `normalizeCreativeConfig`.
 * Không dùng `getSettingJson` vì hàm ấy trộn mặc định vào TRƯỚC khi kẹp — luật hỏng trong dòng đã
 * lưu sẽ không còn được báo.
 */
export async function readCreativeConfig(): Promise<CreativeConfigState> {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, CREATIVE_CONFIG_KEY) }).catch(() => null);
  let raw: unknown = {};
  let unreadable = false;
  if (row) {
    try {
      raw = JSON.parse(row.value);
    } catch {
      unreadable = true;
    }
  }
  const { config, problems } = normalizeCreativeConfig(raw);
  return { saved: Boolean(row), unreadable, config, problems, updatedAt: row?.updatedAt ?? null };
}

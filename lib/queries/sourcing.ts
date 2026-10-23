/**
 * ═══ KHO MẪU NGUỒN — ĐƯỜNG ĐỌC (SRC-3, chỉ máy chủ) ═══
 *
 * Ba bảng của 0256 ở CSDL tổ chức. Mọi hàm ở đây bắt lỗi bảng chưa có (42P01) và trả `{ unavailable: true }` — tổ chức chưa áp
 * 0256 thì /sourcing in một câu, không sập (MIGRATION_SERVE_COMPAT). Bậc giá đọc qua `parsePriceTiers` (fen nguyên); «cũ» KHÔNG
 * đọc từ CSDL mà tính lúc xem bằng `staleness` từ mốc chụp.
 */
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { SOURCING_COMPARE_MAX, SOURCING_PLATFORMS, type SourcingDataStatus, type SourcingPlatform } from "@/lib/constants/sourcing";
import { parsePriceTiers, type PriceTier } from "@/lib/sourcing/price";
import { parseSkus, type OfferSkus } from "@/lib/sourcing/skus";
import type { ListParams } from "@/lib/search-params";

export const SOURCING_OFFER_SORTABLE = ["createdAt", "platform", "titleVi"];
/** Trạng thái lưu trữ — bộ lọc của danh sách; không chọn gì ⇒ chỉ mẫu đang dùng. */
export const SOURCING_OFFER_STATES = ["ACTIVE", "ARCHIVED"] as const;

/** Bảng chưa tồn tại (SQLSTATE 42P01) — drizzle bọc lỗi pg trong `cause`. */
export function isMissingSourcingTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

export type Unavailable = { unavailable: true };
const UNAVAILABLE: Unavailable = { unavailable: true };

/** Chạy một lượt đọc của Tìm hàng nguồn; bảng chưa có (CSDL chưa áp migration) ⇒ `{ unavailable: true }`. Dùng chung cho mọi tệp truy vấn sourcing. */
export async function guardSourcingTables<T>(fn: () => Promise<T>): Promise<T | Unavailable> {
  return guard(fn);
}

async function guard<T>(fn: () => Promise<T>): Promise<T | Unavailable> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSourcingTable(e)) return UNAVAILABLE;
    throw e;
  }
}

export type SnapshotView = {
  id: string;
  capturedAt: Date;
  /** `null` = jsonb hỏng hình dạng — màn hình in «bậc giá hỏng», không in 0. */
  tiers: PriceTier[] | null;
  moq: number | null;
  skus: OfferSkus | null;
  source: SourcingDataStatus;
  capturedByName: string | null;
};

const o = schema.sourcingOffers;
const s = schema.sourcingOfferSnapshots;
const sup = schema.sourcingSuppliers;

function toSnapshot(r: { id: string; capturedAt: Date; tiers: unknown; moq: number | null; skus: unknown; source: string; capturedByName: string | null }): SnapshotView {
  return { id: r.id, capturedAt: r.capturedAt, tiers: parsePriceTiers(r.tiers), moq: r.moq, skus: parseSkus(r.skus), source: r.source as SourcingDataStatus, capturedByName: r.capturedByName };
}

async function snapshotsOf(offerIds: string[], limitPerOffer: number | null): Promise<Map<string, SnapshotView[]>> {
  const out = new Map<string, SnapshotView[]>();
  if (!offerIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ offerId: s.offerId, id: s.id, capturedAt: s.capturedAt, tiers: s.tiers, moq: s.moq, skus: s.skus, source: s.source, capturedByName: schema.users.name })
    .from(s)
    .leftJoin(schema.users, eq(schema.users.id, s.capturedBy))
    .where(inArray(s.offerId, offerIds))
    .orderBy(asc(s.offerId), desc(s.capturedAt), desc(s.id));
  for (const r of rows) {
    const list = out.get(r.offerId) ?? [];
    if (limitPerOffer === null || list.length < limitPerOffer) list.push(toSnapshot(r));
    out.set(r.offerId, list);
  }
  return out;
}

/** Số mẫu KHÁC mang cùng khoá ảnh — chỉ để gắn cờ «có thể trùng ảnh». */
async function imageDupCounts(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const db = await getDb();
  const rows = await db.select({ key: o.imageKey, n: count() }).from(o).where(inArray(o.imageKey, keys)).groupBy(o.imageKey);
  for (const r of rows) if (r.key) out.set(r.key, Number(r.n) - 1);
  return out;
}

export function sourcingOfferWhere(params: ListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  const states = params.filters.state ?? [];
  const wantActive = !states.length || states.includes("ACTIVE");
  const wantArchived = states.includes("ARCHIVED");
  if (wantActive && !wantArchived) conds.push(isNull(o.archivedAt));
  if (wantArchived && !wantActive) conds.push(isNotNull(o.archivedAt));
  const platforms = (params.filters.platform ?? []).filter((p): p is SourcingPlatform => (SOURCING_PLATFORMS as readonly string[]).includes(p));
  if (platforms.length) conds.push(inArray(o.platform, platforms));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(o.titleVi, like), ilike(o.titleZh, like), ilike(o.offerId, like), ilike(o.canonicalUrl, like), ilike(sup.name, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export type SourcingOfferRow = {
  id: string;
  platform: SourcingPlatform;
  offerId: string | null;
  canonicalUrl: string;
  titleZh: string;
  titleVi: string;
  imageUrl: string | null;
  dataStatus: SourcingDataStatus;
  createdAt: Date;
  archivedAt: Date | null;
  supplierName: string | null;
  latest: SnapshotView | null;
  /** Số mẫu KHÁC cùng ảnh; 0 = không thấy trùng; `null` = mẫu không có link ảnh. */
  imageDupes: number | null;
};

export async function listSourcingOffers(params: ListParams): Promise<{ unavailable: false; rows: SourcingOfferRow[]; total: number; pageCount: number } | Unavailable> {
  return guard(async () => {
    const db = await getDb();
    const where = sourcingOfferWhere(params);
    const sortMap = { createdAt: o.createdAt, platform: o.platform, titleVi: o.titleVi } as const;
    const col = sortMap[params.sort as keyof typeof sortMap] ?? o.createdAt;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ id: o.id, platform: o.platform, offerId: o.offerId, canonicalUrl: o.canonicalUrl, titleZh: o.titleZh, titleVi: o.titleVi, imageUrl: o.imageUrl, imageKey: o.imageKey, dataStatus: o.dataStatus, createdAt: o.createdAt, archivedAt: o.archivedAt, supplierName: sup.name })
        .from(o)
        .leftJoin(sup, eq(sup.id, o.supplierId))
        .where(where)
        .orderBy(params.dir === "asc" ? asc(col) : desc(col), desc(o.createdAt), desc(o.id))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      db.select({ total: count() }).from(o).leftJoin(sup, eq(sup.id, o.supplierId)).where(where),
    ]);
    const [snaps, dupes] = await Promise.all([snapshotsOf(rows.map((r) => r.id), 1), imageDupCounts(rows.map((r) => r.imageKey).filter((k): k is string => Boolean(k)))]);
    const out: SourcingOfferRow[] = rows.map((r) => ({
      id: r.id,
      platform: r.platform as SourcingPlatform,
      offerId: r.offerId,
      canonicalUrl: r.canonicalUrl,
      titleZh: r.titleZh,
      titleVi: r.titleVi,
      imageUrl: r.imageUrl,
      dataStatus: r.dataStatus as SourcingDataStatus,
      createdAt: r.createdAt,
      archivedAt: r.archivedAt,
      supplierName: r.supplierName && r.supplierName.trim() ? r.supplierName : null,
      latest: snaps.get(r.id)?.[0] ?? null,
      imageDupes: r.imageKey ? (dupes.get(r.imageKey) ?? 0) : null,
    }));
    return { unavailable: false as const, rows: out, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
  });
}

export type SourcingSupplierView = {
  id: string;
  platform: SourcingPlatform;
  shopUrl: string;
  name: string;
  yearsOnPlatform: number | null;
  ratingX100: number | null;
  responseRateBp: number | null;
  verified: boolean | null;
  shipFrom: string | null;
  factsSource: SourcingDataStatus;
  factsAsOf: Date | null;
};

function toSupplier(r: typeof sup.$inferSelect): SourcingSupplierView {
  return {
    id: r.id,
    platform: r.platform as SourcingPlatform,
    shopUrl: r.shopUrl,
    name: r.name,
    yearsOnPlatform: r.yearsOnPlatform,
    ratingX100: r.ratingX100,
    responseRateBp: r.responseRateBp,
    verified: r.verified,
    shipFrom: r.shipFrom,
    factsSource: r.factsSource as SourcingDataStatus,
    factsAsOf: r.factsAsOf,
  };
}

export type SourcingOfferDetail = {
  offer: Omit<SourcingOfferRow, "latest" | "imageDupes" | "supplierName"> & { sourceUrl: string; createdByName: string | null; updatedAt: Date };
  supplier: SourcingSupplierView | null;
  snapshots: SnapshotView[];
  /** Mẫu KHÁC cùng khoá ảnh (gắn cờ, không gộp). */
  sameImage: { id: string; titleVi: string; archived: boolean }[];
};

export async function getSourcingOffer(id: string): Promise<SourcingOfferDetail | null | Unavailable> {
  return guard(async () => {
    const db = await getDb();
    const [r] = await db
      .select({ offer: o, createdByName: schema.users.name })
      .from(o)
      .leftJoin(schema.users, eq(schema.users.id, o.createdBy))
      .where(eq(o.id, id))
      .limit(1);
    if (!r) return null;
    const [supplierRow, snaps, sameImage] = await Promise.all([
      r.offer.supplierId ? db.select().from(sup).where(eq(sup.id, r.offer.supplierId)).limit(1) : Promise.resolve([]),
      snapshotsOf([id], 50),
      r.offer.imageKey
        ? db.select({ id: o.id, titleVi: o.titleVi, archivedAt: o.archivedAt }).from(o).where(and(eq(o.imageKey, r.offer.imageKey), ne(o.id, id))).orderBy(desc(o.createdAt)).limit(10)
        : Promise.resolve([]),
    ]);
    const x = r.offer;
    return {
      offer: {
        id: x.id,
        platform: x.platform as SourcingPlatform,
        offerId: x.offerId,
        canonicalUrl: x.canonicalUrl,
        sourceUrl: x.sourceUrl,
        titleZh: x.titleZh,
        titleVi: x.titleVi,
        imageUrl: x.imageUrl,
        dataStatus: x.dataStatus as SourcingDataStatus,
        createdAt: x.createdAt,
        updatedAt: x.updatedAt,
        archivedAt: x.archivedAt,
        createdByName: r.createdByName,
      },
      supplier: supplierRow[0] ? toSupplier(supplierRow[0]) : null,
      snapshots: snaps.get(id) ?? [],
      sameImage: sameImage.map((m) => ({ id: m.id, titleVi: m.titleVi, archived: m.archivedAt !== null })),
    };
  });
}

export type SourcingCompareItem = { id: string; platform: SourcingPlatform; titleVi: string; titleZh: string; imageUrl: string | null; canonicalUrl: string; archived: boolean; supplier: SourcingSupplierView | null; latest: SnapshotView | null };

/** Mẫu để so sánh, GIỮ thứ tự `ids` người chọn; id không có ⇒ bỏ (trả kèm danh sách bị bỏ để nói ra). */
export async function getSourcingCompare(ids: readonly string[]): Promise<{ unavailable: false; items: SourcingCompareItem[]; missing: string[] } | Unavailable> {
  const wanted = [...new Set(ids)].slice(0, SOURCING_COMPARE_MAX);
  return guard(async () => {
    if (!wanted.length) return { unavailable: false as const, items: [], missing: [] };
    const db = await getDb();
    const rows = await db.select({ offer: o, supplier: sup }).from(o).leftJoin(sup, eq(sup.id, o.supplierId)).where(inArray(o.id, wanted));
    const snaps = await snapshotsOf(wanted, 1);
    const byId = new Map(rows.map((r) => [r.offer.id, r]));
    const items: SourcingCompareItem[] = [];
    const missing: string[] = [];
    for (const id of wanted) {
      const r = byId.get(id);
      if (!r) {
        missing.push(id);
        continue;
      }
      items.push({
        id,
        platform: r.offer.platform as SourcingPlatform,
        titleVi: r.offer.titleVi,
        titleZh: r.offer.titleZh,
        imageUrl: r.offer.imageUrl,
        canonicalUrl: r.offer.canonicalUrl,
        archived: r.offer.archivedAt !== null,
        supplier: r.supplier ? toSupplier(r.supplier) : null,
        latest: snaps.get(id)?.[0] ?? null,
      });
    }
    return { unavailable: false as const, items, missing };
  });
}

export type OfferWeight = { grams: number; source: SourcingDataStatus; capturedAt: Date; capturedByName: string | null };

/**
 * Cân nặng MỚI NHẤT của từng mẫu (0257). Truy vấn RIÊNG, có bắt bảng chưa có: CSDL chưa áp 0257 ⇒ `unavailable: true` và mọi mẫu
 * «chưa khai cân nặng» — kho mẫu và bảng giá vẫn chạy (MIGRATION_SERVE_COMPAT).
 */
export async function latestOfferWeights(offerIds: readonly string[], historyLimit = 1): Promise<{ unavailable: boolean; byOffer: Map<string, OfferWeight[]> }> {
  const byOffer = new Map<string, OfferWeight[]>();
  if (!offerIds.length) return { unavailable: false, byOffer };
  const w = schema.sourcingOfferWeights;
  try {
    const db = await getDb();
    const rows = await db
      .select({ offerId: w.offerId, grams: w.grams, source: w.source, capturedAt: w.capturedAt, capturedByName: schema.users.name })
      .from(w)
      .leftJoin(schema.users, eq(schema.users.id, w.capturedBy))
      .where(inArray(w.offerId, [...offerIds]))
      .orderBy(asc(w.offerId), desc(w.capturedAt), desc(w.id));
    for (const r of rows) {
      const list = byOffer.get(r.offerId) ?? [];
      if (list.length < historyLimit) list.push({ grams: r.grams, source: r.source as SourcingDataStatus, capturedAt: r.capturedAt, capturedByName: r.capturedByName });
      byOffer.set(r.offerId, list);
    }
    return { unavailable: false, byOffer };
  } catch (e) {
    if (isMissingSourcingTable(e)) return { unavailable: true, byOffer };
    throw e;
  }
}

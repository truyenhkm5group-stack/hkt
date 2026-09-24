import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { GENE_KEYS, GENE_VOCAB_VERSION, geneSignature, parseGenes, parseOwnAdMetrics, parsePartialGenes, type CreativeLoopConfig, type CreativeSourceKind, type GeneKey } from "@/lib/constants/creative-loop";
import { shiftDay } from "@/lib/constants/marketing-decision-ledger";
import type { GeneStat } from "@/lib/creative/learn";
import { parentKey, type PlanInput, type PlanInspiration, type PlanParent, type PlanProduct } from "@/lib/creative/plan";

/**
 * ═══════════ GOM ĐẦU VÀO CHO `planBatch()` — CHỈ ĐỌC ═══════════
 *
 * `lib/queries/*` không được ghi (`tests/advisory-safety.test.ts` quét cả thư mục). Tệp này đọc
 * CSDL rồi dựng đúng hình dạng `PlanInput` mà hàm thuần `planBatch()` nhận; mọi quyết định (ô nào,
 * gen nào) vẫn nằm ở hàm thuần.
 *
 * Mốc "30 ngày", "14 ngày" tính lùi từ 00:00 giờ Việt Nam của NGÀY CHẠY — không từ đồng hồ lúc
 * gọi — để chạy lại cùng lô ra cùng đầu vào.
 */

/** Số ngày nhìn lại khi đếm số mẫu đã test của một mã (ưu tiên mã ít được thử). */
export const PLAN_RECENT_TEST_DAYS = 30;
/** Số ngày nhìn lại khi chống trùng chữ ký (mã + bộ gen). */
export const PLAN_DEDUP_DAYS = 14;

function vnMidnight(day: string): Date {
  return new Date(`${day}T00:00:00+07:00`);
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Ép an toàn một dòng `gene_stats` (JSON không tin được) về `GeneStat`. Hỏng ⇒ `null`. */
export function parseGeneStat(raw: unknown): GeneStat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = GENE_KEYS.find((k) => k === r.key);
  if (!key || typeof r.value !== "string") return null;
  if (parsePartialGenes({ [key]: r.value })[key as GeneKey] === undefined) return null;
  const tests = finiteOrNull(r.tests);
  const successes = finiteOrNull(r.successes);
  const wins = finiteOrNull(r.wins);
  const posteriorMean = finiteOrNull(r.posteriorMean);
  if (tests === null || successes === null || wins === null || posteriorMean === null) return null;
  return {
    key,
    value: r.value,
    tests,
    successes,
    wins,
    spendVnd: finiteOrNull(r.spendVnd) ?? 0,
    bookedOrders: finiteOrNull(r.bookedOrders) ?? 0,
    posteriorMean,
    relativeCount: finiteOrNull(r.relativeCount) ?? 0,
  };
}

/**
 * Đầu vào của `planBatch()` cho lô `batchDay`.
 *
 *  · products     — mã có nguồn `PRODUCT_PHOTO` còn bật, ảnh chưa xoá, mã chưa bị gỡ; nếu cấu hình
 *                   khai `focusProductIds` thì CHỈ các mã ấy. Một mã nhiều ảnh ⇒ lấy ảnh mới nhất.
 *  · inspirations — nguồn còn bật không phải ảnh sản phẩm; `usedCount` = số mẫu đã dùng nó.
 *  · parents      — mẫu đã vào thư viện (THẮNG) hoặc phán quyết MỚI NHẤT là HỨA HẸN; gen hỏng hoặc
 *                   khác phiên bản từ vựng ⇒ bỏ (không so được). CỘNG nguồn `OWN_AD` (quảng cáo cũ của
 *                   shop) có ĐỦ sáu gen và có mã hàng nằm trong `products` — THẮNG nếu lúc nhập nó là
 *                   mẫu thắng, không thì HỨA HẸN; đơn / chi lấy từ số đo chụp lúc nhập. `OWN_AD` chưa đủ
 *                   điều kiện ấy vẫn là nguồn cảm hứng (đứng trước spy / tay / R&D ở `planBatch`).
 *  · stats        — `gene_stats` của dòng sổ học mới nhất, cùng phiên bản từ vựng; chưa có ⇒ rỗng.
 */
export async function loadPlanInputs(db: Db, batchDay: string, cfg: Pick<CreativeLoopConfig, "batchSize" | "extraCandidates" | "exploreShare" | "focusProductIds">): Promise<PlanInput> {
  const dayStart = vnMidnight(batchDay);
  const recentFrom = vnMidnight(shiftDay(batchDay, -PLAN_RECENT_TEST_DAYS));
  const dedupFrom = vnMidnight(shiftDay(batchDay, -PLAN_DEDUP_DAYS));
  const s = schema.creativeSources;
  const v = schema.creativeVariants;
  const img = schema.creativeImages;

  // ─── Mã hàng có ảnh sản phẩm thật ───
  const photoRows = await db
    .select({ sourceId: s.id, productId: s.productId, createdAt: s.createdAt })
    .from(s)
    .innerJoin(img, eq(img.id, s.imageId))
    .innerJoin(schema.products, eq(schema.products.id, s.productId))
    .where(and(eq(s.kind, "PRODUCT_PHOTO"), eq(s.active, true), isNull(img.purgedAt), eq(schema.products.isRemoved, false)))
    .orderBy(desc(s.createdAt), s.id);
  const focus = new Set(cfg.focusProductIds);
  const photoOf = new Map<string, string>();
  for (const r of photoRows) {
    if (!r.productId || photoOf.has(r.productId)) continue;
    if (focus.size > 0 && !focus.has(r.productId)) continue;
    photoOf.set(r.productId, r.sourceId);
  }
  const productIds = [...photoOf.keys()];
  const testCounts = productIds.length
    ? await db
        .select({ productId: v.productId, n: sql<number>`count(*)::int` })
        .from(v)
        .where(and(inArray(v.productId, productIds), gte(v.createdAt, recentFrom), sql`${v.createdAt} < ${dayStart}`))
        .groupBy(v.productId)
    : [];
  const testsOf = new Map(testCounts.map((r) => [r.productId as string, Number(r.n)]));
  const products: PlanProduct[] = productIds.map((productId) => ({ productId, photoSourceId: photoOf.get(productId) as string, recentTests: testsOf.get(productId) ?? 0 }));

  // ─── Nguồn cảm hứng ───
  const inspRows = await db
    .select({ sourceId: s.id, kind: s.kind, productId: s.productId, genes: s.genes, title: s.title, metrics: s.metrics, imageId: s.imageId, imagePurgedAt: img.purgedAt })
    .from(s)
    .leftJoin(img, eq(img.id, s.imageId))
    .where(and(eq(s.active, true), ne(s.kind, "PRODUCT_PHOTO")));
  const usedRows = inspRows.length
    ? await db
        .select({ sourceId: v.inspirationSourceId, n: sql<number>`count(*)::int` })
        .from(v)
        .where(inArray(v.inspirationSourceId, inspRows.map((r) => r.sourceId)))
        .groupBy(v.inspirationSourceId)
    : [];
  const usedOf = new Map(usedRows.map((r) => [r.sourceId as string, Number(r.n)]));
  const inspirations: PlanInspiration[] = [];
  const ownAdParents: PlanParent[] = [];
  for (const r of inspRows) {
    if (r.kind === "OWN_AD") {
      const genes = parseGenes(r.genes);
      if (genes && r.productId && photoOf.has(r.productId)) {
        const m = parseOwnAdMetrics(r.metrics);
        ownAdParents.push({
          variantId: null,
          ownAdSourceId: r.sourceId,
          productId: r.productId,
          genes,
          verdict: m.reason === "WIN" ? "WIN" : "PROMISING",
          bookedOrders: m.bookedOrders,
          // Không có số chi ⇒ CHƯA BIẾT, không phải 0 — `rankParents` xếp sau.
          spendVnd: m.spendVnd,
          imageId: r.imageId && r.imagePurgedAt === null ? r.imageId : null,
        });
        continue;
      }
    }
    if (r.kind !== "OWN_AD" && r.kind !== "MANUAL" && r.kind !== "SPY" && r.kind !== "RND") continue;
    inspirations.push({
      sourceId: r.sourceId,
      kind: r.kind as Exclude<CreativeSourceKind, "PRODUCT_PHOTO">,
      ...(r.kind === "OWN_AD" && r.title ? { label: r.title } : {}),
      productId: r.productId,
      genes: parsePartialGenes(r.genes),
      usedCount: usedOf.get(r.sourceId) ?? 0,
    });
  }

  // ─── Mẫu cha: THẮNG (đã vào thư viện) hoặc phán quyết mới nhất là HỨA HẸN ───
  const cv = schema.creativeVerdicts;
  const latest = await db
    .selectDistinctOn([cv.variantId], { variantId: cv.variantId, verdict: cv.verdict, metrics: cv.metrics })
    .from(cv)
    .orderBy(cv.variantId, desc(cv.verdictDay), desc(cv.updatedAt));
  const latestOf = new Map(latest.map((r) => [r.variantId, r]));
  const promisingIds = latest.filter((r) => r.verdict === "PROMISING" || r.verdict === "WIN").map((r) => r.variantId);
  const parentRows = await db
    .select({ id: v.id, productId: v.productId, genes: v.genes, genesVersion: v.genesVersion, libraryAt: v.libraryAt, libraryOrders: v.libraryOrders, imageId: v.imageId, imagePurgedAt: img.purgedAt })
    .from(v)
    .leftJoin(img, eq(img.id, v.imageId))
    .where(promisingIds.length ? sql`${v.libraryAt} is not null or ${inArray(v.id, promisingIds)}` : isNotNull(v.libraryAt));
  const parents: PlanParent[] = [];
  for (const r of parentRows) {
    const genes = parseGenes(r.genes);
    if (!genes || !r.productId || r.genesVersion !== GENE_VOCAB_VERSION) continue;
    const lv = latestOf.get(r.id);
    const metrics = (lv?.metrics ?? {}) as Record<string, unknown>;
    const isWin = r.libraryAt !== null || lv?.verdict === "WIN";
    parents.push({
      variantId: r.id,
      productId: r.productId,
      genes,
      verdict: isWin ? "WIN" : "PROMISING",
      bookedOrders: finiteOrNull(metrics.bookedOrders) ?? r.libraryOrders ?? 0,
      // Không có số chi ⇒ CHƯA BIẾT, không phải 0 — `rankParents` xếp mẫu ấy sau.
      spendVnd: finiteOrNull(metrics.spendVnd),
      imageId: r.imageId && r.imagePurgedAt === null ? r.imageId : null,
    });
  }
  parents.push(...ownAdParents);
  parents.sort((a, b) => parentKey(a).localeCompare(parentKey(b)));

  // ─── Sổ học mới nhất ───
  const [learning] = await db
    .select({ geneStats: schema.creativeLearnings.geneStats, genesVersion: schema.creativeLearnings.genesVersion })
    .from(schema.creativeLearnings)
    .where(sql`${schema.creativeLearnings.learningDay} < ${batchDay}`)
    .orderBy(desc(schema.creativeLearnings.learningDay))
    .limit(1);
  const stats: GeneStat[] =
    learning && learning.genesVersion === GENE_VOCAB_VERSION && Array.isArray(learning.geneStats) ? learning.geneStats.map(parseGeneStat).filter((x): x is GeneStat => x !== null) : [];

  // ─── Chữ ký các mẫu gần đây ───
  const sigRows = await db
    .select({ productId: v.productId, genes: v.genes })
    .from(v)
    .where(and(gte(v.createdAt, dedupFrom), isNotNull(v.productId)));
  const recentSignatures = [
    ...new Set(
      sigRows.flatMap((r) => {
        const g = parseGenes(r.genes);
        return g && r.productId ? [geneSignature(r.productId, g)] : [];
      }),
    ),
  ].sort();

  return {
    batchDay,
    slotCount: cfg.batchSize + cfg.extraCandidates,
    exploreShare: cfg.exploreShare,
    products,
    inspirations: inspirations.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    parents,
    stats,
    recentSignatures,
  };
}

export type ProductBrief = { productId: string; name: string; code: string; priceVnd: number | null };

/**
 * Tên, mã, giá bán của một mã hàng cho người viết câu chữ.
 *
 * Giá = giá bán sau giảm của các mẫu mã còn bán (Pancake điền bằng giá niêm yết khi không giảm).
 * Các mẫu mã cùng MỘT giá ⇒ giá đó. Nhiều giá khác nhau (size lớn đắt hơn…) hoặc chưa có giá ⇒
 * `null` = CHƯA BIẾT, và câu chữ không được ghi con số giá nào — chọn đại một giá là quảng cáo sai
 * cho một phần khách.
 */
export async function loadProductBrief(db: Db, productId: string): Promise<ProductBrief | null> {
  const [p] = await db
    .select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId, displayId: schema.products.displayId })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  if (!p) return null;
  const pv = schema.productVariants;
  const prices = await db
    .select({ after: pv.retailPriceAfterDiscount, list: pv.retailPrice })
    .from(pv)
    .where(and(eq(pv.productId, productId), eq(pv.isRemoved, false)));
  const distinct = [...new Set(prices.map((r) => (r.after > 0 ? r.after : r.list)).filter((x) => x > 0))];
  return { productId: p.id, name: p.name, code: p.customId ?? (p.displayId !== null ? String(p.displayId) : ""), priceVnd: distinct.length === 1 ? distinct[0] : null };
}

/**
 * Câu chữ ĐÃ BÁN ĐƯỢC cho người viết học giọng văn: mẫu THẮNG của vòng (thư viện) và quảng cáo cũ của
 * shop (`OWN_AD` còn bật, có câu chữ) — cùng mã hàng đứng trước, rồi xen kẽ hai nguồn (mẫu vòng trước),
 * mỗi nguồn theo thứ tự tốt nhất của nó: thư viện mới nhất · quảng cáo cũ nhiều đơn nhất rồi rẻ tin
 * nhắn nhất. Xen kẽ để thư viện đầy không đẩy hết câu chữ đã bán được trên tài khoản của shop ra ngoài.
 */
export async function loadWinningExamples(db: Db, productId: string | null, limit = 3): Promise<{ primaryText: string; headline: string }[]> {
  const v = schema.creativeVariants;
  const s = schema.creativeSources;
  const same = productId ?? "";
  const [variantRows, ownRows] = await Promise.all([
    db
      .select({ primaryText: v.primaryText, headline: v.headline, productId: v.productId })
      .from(v)
      .where(and(isNotNull(v.libraryAt), ne(v.primaryText, "")))
      .orderBy(sql`case when ${v.productId} = ${same} then 0 else 1 end`, desc(v.libraryAt), v.id)
      .limit(limit),
    db
      .select({ primaryText: s.primaryText, headline: s.headline, productId: s.productId })
      .from(s)
      .where(and(eq(s.kind, "OWN_AD"), eq(s.active, true), ne(s.primaryText, "")))
      .orderBy(
        sql`case when ${s.productId} = ${same} then 0 else 1 end`,
        sql`(case when jsonb_typeof(${s.metrics} -> 'bookedOrders') = 'number' then (${s.metrics} ->> 'bookedOrders')::numeric else 0 end) desc`,
        sql`(case when jsonb_typeof(${s.metrics} -> 'costPerMessageVnd') = 'number' then (${s.metrics} ->> 'costPerMessageVnd')::numeric end) asc nulls last`,
        s.id,
      )
      .limit(limit),
  ]);
  const tagged = [...variantRows.map((r, i) => ({ r, i, k: 0 })), ...ownRows.map((r, i) => ({ r, i, k: 1 }))];
  tagged.sort((a, b) => Number(a.r.productId !== same || !productId) - Number(b.r.productId !== same || !productId) || a.i - b.i || a.k - b.k);
  return tagged.slice(0, limit).map((x) => ({ primaryText: x.r.primaryText, headline: x.r.headline }));
}

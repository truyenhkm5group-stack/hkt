/**
 * ═══════════ GHI MỐI NỐI MẨU → BÀI VÀO `fb_ads` ═══════════
 *
 * Đường ghi DUY NHẤT của nút "Đồng bộ vào ERP". Nó nhận kết quả tra do MÁY CHỦ vừa hỏi Meta — không
 * bao giờ nhận Post ID từ trình duyệt: client gửi mã khác thì dòng dữ liệu nói một đằng còn Meta nói
 * một nẻo (cùng lý do mục 34).
 *
 * ─── BA LUẬT ───
 *
 *  1. IDEMPOTENT. Khoá là `ad_id` (PK). Ghi lại cùng kết quả ⇒ cùng một dòng, `changed = 0`.
 *  2. KHÔNG ĐÈ ĐIỀU ĐÃ BIẾT BẰNG CHƯA BIẾT. Mẩu tra ra mà chưa ra bài thì chỉ cập nhật phần mẩu và lỗi;
 *     bài đã lưu từ trước giữ nguyên. Tên fanpage / permalink không đọc được lần này thì giữ bản cũ.
 *  3. Mẩu Meta KHÔNG trả về (không tồn tại / không có quyền / lỗi kết nối) thì KHÔNG ghi gì: một lần
 *     tra tay hỏng không được biến thành một dòng "missing" chặn đường tự đồng bộ 7 ngày.
 */
import { inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AdPostResolution } from "@/lib/constants/meta-ad-post";

type Db = Awaited<ReturnType<typeof getDb>>;

export type AdPostSaveResult = { inserted: number; updated: number; unchanged: number; skipped: { adId: string; reason: string }[] };

/** Các cột mà một lượt ghi có thể đổi — so trước/sau trên đúng tập này để đếm `changed`. */
const COMPARED = ["name", "adsetId", "campaignId", "campaignName", "accountId", "status", "missing", "creativeId", "effectiveObjectStoryId", "objectStoryId", "postId", "storyId", "pageId", "postResolutionSource", "pageName", "permalinkUrl"] as const;

function errorJson(r: AdPostResolution) {
  if (!r.error) return null;
  return {
    code: r.error,
    graphCode: r.graphError?.code ?? null,
    graphSubcode: r.graphError?.subcode ?? null,
    message: r.graphError?.message ?? "",
    fbtraceId: r.graphError?.fbtraceId ?? "",
    at: r.resolvedAt,
  };
}

export async function saveAdPostResolutions(results: AdPostResolution[], options: { db?: Db; now?: Date } = {}): Promise<AdPostSaveResult> {
  const db = options.db ?? (await getDb());
  const now = options.now ?? new Date();
  const out: AdPostSaveResult = { inserted: 0, updated: 0, unchanged: 0, skipped: [] };
  const writable = results.filter((r) => {
    if (r.adFound) return true;
    out.skipped.push({ adId: r.adId, reason: r.message || "Meta không trả mẩu quảng cáo này" });
    return false;
  });
  if (!writable.length) return out;

  const beforeRows = await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, writable.map((r) => r.adId)));
  const before = new Map(beforeRows.map((b) => [b.id, b]));

  for (const r of writable) {
    const adPart = {
      name: r.adName,
      adsetId: r.adsetId,
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      accountId: r.adAccountId,
      status: r.adStatus,
      missing: false,
      creativeId: r.creativeId,
      effectiveObjectStoryId: r.rawEffectiveObjectStoryId,
      objectStoryId: r.rawObjectStoryId,
      resolveError: errorJson(r),
      fetchedAt: now,
      updatedAt: now,
    };
    const postPart = r.ok
      ? {
          postId: r.postId,
          storyId: r.objectStoryId,
          pageId: r.pageId,
          postResolutionSource: r.resolutionSource,
          postResolvedAt: now,
        }
      : {};
    // Lần này không đọc được tên / permalink thì giữ bản cũ (luật 2) — `coalesce(excluded, cũ)`.
    const namePart = r.ok ? { pageName: sql`coalesce(excluded.page_name, ${schema.fbAds.pageName})`, permalinkUrl: sql`coalesce(excluded.permalink_url, ${schema.fbAds.permalinkUrl})` } : {};
    await db
      .insert(schema.fbAds)
      .values({ id: r.adId, ...adPart, ...postPart, pageName: r.ok ? r.pageName : null, permalinkUrl: r.ok ? r.permalinkUrl : null })
      .onConflictDoUpdate({ target: schema.fbAds.id, set: { ...adPart, ...postPart, ...namePart } });

    const old = before.get(r.adId);
    if (!old) {
      out.inserted += 1;
      continue;
    }
    const [fresh] = await db.select().from(schema.fbAds).where(inArray(schema.fbAds.id, [r.adId]));
    const changed = COMPARED.some((k) => (old[k] ?? null) !== (fresh?.[k] ?? null));
    if (changed) out.updated += 1;
    else out.unchanged += 1;
  }
  return out;
}

/** Tên fanpage trong sổ `fanpages` (tên người đặt thắng tên API, như `fanpageDisplayName`). */
export async function erpFanpageNames(pageIds: string[], db?: Db): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = [...new Set(pageIds.filter(Boolean))];
  if (!clean.length) return out;
  const d = db ?? (await getDb());
  const rows = await d
    .select({ id: schema.fanpages.externalPageId, name: schema.fanpages.name, alias: schema.fanpages.alias })
    .from(schema.fanpages)
    .where(inArray(schema.fanpages.externalPageId, clean));
  for (const r of rows) {
    const name = r.alias.trim() || r.name.trim();
    if (name) out.set(r.id, name);
  }
  return out;
}

export type StoredAdPost = {
  postId: string | null;
  storyId: string | null;
  postResolvedAt: string | null;
  fetchedAt: string;
};

/** Điều ERP đang biết về MỘT mẩu: dòng đã lưu (nếu có) và các mẫu vòng mẫu nối tới nó. */
export type AdPostErpContext = {
  stored: StoredAdPost | null;
  /** Mẫu của vòng mẫu đã đăng thành mẩu / bài này — mắt xích Creative Growth Loop. */
  creativeVariantIds: string[];
};

/**
 * ERP ĐANG BIẾT gì về các mẩu này: dòng `fb_ads` đã lưu và mẫu của vòng mẫu (`creative_variants`)
 * trỏ tới cùng mẩu hoặc cùng bài. Đọc để màn hình nói "đã đồng bộ lúc …" và "bài này là mẫu nào".
 *
 * `creative_variants.fb_post_id` lưu `effective_object_story_id` NGUYÊN VĂN (`<page>_<post>`, xem
 * `lib/creative/publish.ts`) — nên so với `story_id`, KHÔNG so với `post_id` (bài học ads-identity.ts).
 */
export async function loadAdPostErpContext(items: { adId: string; storyId: string | null }[], db?: Db): Promise<Map<string, AdPostErpContext>> {
  const out = new Map<string, AdPostErpContext>();
  const ids = [...new Set(items.map((i) => i.adId).filter(Boolean))];
  if (!ids.length) return out;
  const d = db ?? (await getDb());
  const rows = await d.select().from(schema.fbAds).where(inArray(schema.fbAds.id, ids));
  const storedById = new Map(rows.map((r) => [r.id, r]));
  // Bài của mỗi mẩu: kết quả vừa tra thắng, không có thì bài đã lưu.
  const storyOf = new Map(items.map((i) => [i.adId, i.storyId || storedById.get(i.adId)?.storyId || null]));
  const stories = [...new Set([...storyOf.values()].filter((s): s is string => Boolean(s)))];
  const cv = schema.creativeVariants;
  const variants = await d
    .select({ id: cv.id, fbAdId: cv.fbAdId, fbPostId: cv.fbPostId })
    .from(cv)
    .where(stories.length ? or(inArray(cv.fbAdId, ids), inArray(cv.fbPostId, stories)) : inArray(cv.fbAdId, ids));
  for (const id of ids) {
    const r = storedById.get(id);
    const story = storyOf.get(id);
    out.set(id, {
      stored: r ? { postId: r.postId, storyId: r.storyId, postResolvedAt: r.postResolvedAt ? r.postResolvedAt.toISOString() : null, fetchedAt: r.fetchedAt.toISOString() } : null,
      creativeVariantIds: variants.filter((v) => v.fbAdId === id || (story !== null && story !== undefined && v.fbPostId === story)).map((v) => v.id),
    });
  }
  return out;
}

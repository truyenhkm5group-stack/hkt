import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { OWN_AD_IMPORT, PANCAKE_PHOTO_IMPORT_MAX, type OwnAdMetrics } from "@/lib/constants/creative-loop";
import { CREATIVE_IMAGE_MAX_BYTES, storeCreativeImage } from "@/lib/creative/images";
import { asArray, asRecord, str } from "@/lib/integrations/http";
import { inferOwnAdProducts, listOwnAdCandidates, ownAdMetricsOf } from "@/lib/queries/creative-own-ads";

/**
 * ═══════════ VÒNG MẪU — NHẬP NGUỒN ẢNH CÓ SẴN (PANCAKE · FACEBOOK) ═══════════
 *
 * Chủ shop 24/09/2026: tab Nguồn ảnh đang bắt tải tay ảnh sản phẩm thật trong khi Pancake đã có ảnh
 * chính cho mọi mã đang bán; và "lấy luôn những ảnh mẫu win và mẫu có chỉ số tốt (giá tin nhắn <
 * 4.000đ) để làm nguồn ảnh ban đầu". Tệp này là ĐƯỜNG GHI DUY NHẤT của hai việc ấy; Server Action chỉ
 * kiểm quyền rồi gọi vào đây.
 *
 * ─── LŨY ĐẲNG ───
 *
 *  · Ảnh Pancake: một mã + một URL ảnh ⇒ một nguồn `PRODUCT_PHOTO` (URL lưu ở `source_url`). Bấm lại
 *    không đẻ bản thứ hai; Pancake đổi ảnh chính (URL mới) thì có thêm một nguồn mới — ảnh mới nhất
 *    được lập lô dùng trước (`loadPlanInputs`).
 *  · Quảng cáo cũ: khoá `fb_ad_id` (chỉ mục duy nhất trong CSDL). Hai lượt bấm chồng nhau thì lượt sau
 *    vấp khoá và được báo "đã có"; ảnh nó vừa lưu bị dọn.
 *
 * ─── LỖI TỪNG DÒNG KHÔNG LÀM HỎNG CẢ LƯỢT ───
 *
 * Mỗi ảnh / mỗi mẩu là một lần thử riêng; lỗi được GOM kèm lý do vào bản tóm tắt, không ném. Một ảnh
 * Pancake 404 không được làm sáu mã còn lại mất ảnh.
 *
 * ─── KHÔNG GỌI MẠNG KHI KIỂM THỬ ───
 *
 * Tải ảnh đi qua `fetchImpl` tiêm được; Graph đi qua `OwnAdGraph` tiêm được. Bản thật dựng từ
 * `FacebookAdsClient` (chỉ-đọc) ở Server Action.
 */

/** Trần chờ tải một ảnh. */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

export type ImportActor = { id: string | null; name: string };

export type DownloadDeps = { fetchImpl?: typeof fetch; timeoutMs?: number };

/**
 * Tải một ảnh. Chỉ `http(s)`; chặn trước theo `content-length` rồi chặn lại theo số byte thật (máy chủ có
 * thể khai sai). Loại ảnh KHÔNG đọc từ `content-type` — `storeCreativeImage` tự nhận bằng chữ ký tệp.
 */
export async function downloadImage(url: string, deps: DownloadDeps = {}): Promise<Uint8Array> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Địa chỉ ảnh không phải http(s).");
  const timeoutMs = deps.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `Tải ảnh quá ${Math.round(timeoutMs / 1000)} giây.` : `Không tải được ảnh: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Máy chủ ảnh trả HTTP ${res.status}.`);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CREATIVE_IMAGE_MAX_BYTES) throw new Error(`Ảnh quá lớn (${Math.round(declared / 1024)} KB) — tối đa ${CREATIVE_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > CREATIVE_IMAGE_MAX_BYTES) throw new Error(`Ảnh quá lớn (${Math.round(bytes.length / 1024)} KB) — tối đa ${CREATIVE_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  return bytes;
}

function errText(e: unknown): string {
  return (e instanceof Error && e.message ? e.message : String(e)).slice(0, 300);
}

// ───────────────────────────── ẢNH SẢN PHẨM TỪ PANCAKE ─────────────────────────────

export type PancakeImportSummary = {
  /** Mã đang bán có ảnh chính trên Pancake. */
  scanned: number;
  imported: { productId: string; name: string; sourceId: string }[];
  /** Đã có nguồn `PRODUCT_PHOTO` từ đúng URL ấy. */
  existing: number;
  failed: { productId: string; name: string; reason: string }[];
  /** Còn bấy nhiêu mã chưa thử vì chạm trần một lượt — bấm lại để nhập tiếp. */
  remaining: number;
};

/**
 * Với mỗi mã đang bán (`not is_removed`) có `products.image`, chưa có nguồn `PRODUCT_PHOTO` từ đúng URL
 * ấy: tải ảnh → `storeCreativeImage` → nguồn `PRODUCT_PHOTO` (`title` = tên mã, `source_url` = URL).
 */
export async function importPancakeProductPhotos(db: Db, actor: ImportActor, deps: DownloadDeps & { max?: number } = {}): Promise<PancakeImportSummary> {
  const p = schema.products;
  const s = schema.creativeSources;
  const products = await db
    .select({ id: p.id, name: p.name, image: p.image })
    .from(p)
    .where(and(eq(p.isRemoved, false), isNotNull(p.image), sql`trim(${p.image}) <> ''`))
    .orderBy(p.name, p.id);
  const summary: PancakeImportSummary = { scanned: products.length, imported: [], existing: 0, failed: [], remaining: 0 };
  if (products.length === 0) return summary;

  const have = await db
    .select({ productId: s.productId, sourceUrl: s.sourceUrl })
    .from(s)
    .where(and(eq(s.kind, "PRODUCT_PHOTO"), inArray(s.productId, products.map((x) => x.id))));
  const key = (productId: string, url: string) => `${productId}\u0000${url}`;
  const seen = new Set(have.map((r) => key(r.productId ?? "", r.sourceUrl)));

  const max = Math.max(1, deps.max ?? PANCAKE_PHOTO_IMPORT_MAX);
  let tried = 0;
  for (const prod of products) {
    const url = (prod.image ?? "").trim();
    if (seen.has(key(prod.id, url))) {
      summary.existing += 1;
      continue;
    }
    if (tried >= max) {
      summary.remaining += 1;
      continue;
    }
    tried += 1;
    try {
      const bytes = await downloadImage(url, deps);
      const stored = await storeCreativeImage(db, bytes);
      const [row] = await db
        .insert(s)
        .values({
          kind: "PRODUCT_PHOTO",
          productId: prod.id,
          title: prod.name,
          note: "Ảnh chính của mã trên Pancake — nhập tự động.",
          sourceUrl: url,
          imageId: stored.id,
          createdByUserId: actor.id,
          createdByName: actor.name,
        })
        .returning({ id: s.id });
      seen.add(key(prod.id, url));
      summary.imported.push({ productId: prod.id, name: prod.name, sourceId: row.id });
    } catch (e) {
      summary.failed.push({ productId: prod.id, name: prod.name, reason: errText(e) });
    }
  }
  return summary;
}

// ───────────────────────────── QUẢNG CÁO CŨ TỪ FACEBOOK ─────────────────────────────

/** Hai lời gọi Graph CHỈ-ĐỌC mà lượt nhập cần. Bản thật: `FacebookAdsClient`; kiểm thử: bản giả. */
export type OwnAdGraph = {
  getAdCreativeContent(adId: string): Promise<Record<string, unknown>>;
  getAdImageUrls(accountId: string, hashes: string[]): Promise<Record<string, string>>;
};

export type OwnAdContent =
  | { ok: true; name: string; accountId: string | null; imageUrl: string | null; imageHash: string | null; primaryText: string; headline: string }
  | { ok: false; reason: string };

const nonEmpty = (r: Record<string, unknown>) => Object.keys(r).length > 0;

/**
 * Bóc ảnh + câu chữ từ bản ghi Graph của một mẩu — hàm thuần.
 *
 * Chỉ nhận quảng cáo MỘT ẢNH. Video / băng chuyền / quảng cáo động bị bỏ KÈM LÝ DO, vì vòng mẫu sinh
 * ảnh tĩnh: lấy khung hình đầu của video hay ảnh thứ nhất của băng chuyền làm "mẫu cha" là khẳng định
 * rằng đó là thứ đã bán được — không chứng minh được. Ảnh thu nhỏ (`thumbnail_url`, ~64px) không dùng.
 */
export function pickOwnAdContent(raw: Record<string, unknown>): OwnAdContent {
  const creative = asRecord(raw.creative);
  if (!nonEmpty(creative)) return { ok: false, reason: "Graph không trả nội dung quảng cáo (creative) — token có thể thiếu quyền đọc." };
  if (nonEmpty(asRecord(creative.asset_feed_spec))) return { ok: false, reason: "Quảng cáo động (Facebook tự ghép nhiều ảnh / câu chữ) — không biết ảnh nào đã bán được." };
  const oss = asRecord(creative.object_story_spec);
  const link = asRecord(oss.link_data);
  const photo = asRecord(oss.photo_data);
  if (nonEmpty(asRecord(oss.video_data)) || str(creative.video_id) || str(creative.object_type).toUpperCase() === "VIDEO") return { ok: false, reason: "Quảng cáo video — vòng mẫu chỉ làm ảnh tĩnh." };
  if (asArray(link.child_attachments).length > 0) return { ok: false, reason: "Quảng cáo băng chuyền (nhiều ảnh) — không biết ảnh nào đã bán được." };
  if (nonEmpty(asRecord(oss.template_data))) return { ok: false, reason: "Quảng cáo danh mục / động — không có một ảnh cố định." };
  const imageUrl = str(creative.image_url, link.picture, photo.url) || null;
  const imageHash = str(creative.image_hash, link.image_hash, photo.image_hash) || null;
  if (!imageUrl && !imageHash) return { ok: false, reason: "Không tìm thấy ảnh gốc (chỉ có ảnh thu nhỏ) — thường là quảng cáo dùng lại một bài viết có sẵn trên fanpage." };
  return {
    ok: true,
    name: str(raw.name),
    accountId: str(raw.account_id).replace(/^act_/, "") || null,
    imageUrl,
    imageHash,
    primaryText: str(creative.body, link.message, photo.caption, photo.message).slice(0, 2000),
    headline: str(creative.title, link.name).slice(0, 255),
  };
}

export type OwnAdImportSummary = {
  imported: { adId: string; name: string; sourceId: string; productId: string | null }[];
  existing: { adId: string; name: string }[];
  skipped: { adId: string; name: string; reason: string }[];
  /** Mẩu nhập được nhưng KHÔNG suy được mã hàng — chưa làm mẫu cha được cho tới khi gắn mã. */
  noProduct: string[];
};

/**
 * Nhập các mẩu đã chọn thành nguồn `OWN_AD` (tối đa `OWN_AD_IMPORT.maxPerImport` một lượt).
 *
 * Danh sách client gửi lên chỉ là LỰA CHỌN: điều kiện được KIỂM LẠI ở máy chủ bằng đúng
 * `listOwnAdCandidates()` của bước xem trước, và số đo lưu vào nguồn là số máy chủ vừa đo — không nhận
 * số nào từ client.
 */
export async function importOwnAds(db: Db, adIdsRaw: readonly string[], actor: ImportActor, deps: DownloadDeps & { graph: OwnAdGraph; now?: Date; winOrdersAbove: number }): Promise<OwnAdImportSummary> {
  const now = deps.now ?? new Date();
  const summary: OwnAdImportSummary = { imported: [], existing: [], skipped: [], noProduct: [] };
  const adIds = [...new Set(adIdsRaw.map((x) => String(x).trim()).filter((x) => /^\d{5,}$/.test(x)))].slice(0, OWN_AD_IMPORT.maxPerImport);
  if (adIds.length === 0) return summary;

  const { rows } = await listOwnAdCandidates(db, { now, winOrdersAbove: deps.winOrdersAbove, adIds, limit: adIds.length });
  const byId = new Map(rows.map((r) => [r.adId, r]));
  const products = await inferOwnAdProducts(db, adIds);
  const s = schema.creativeSources;

  for (const adId of adIds) {
    const c = byId.get(adId);
    if (!c) {
      summary.skipped.push({ adId, name: "", reason: "Không còn đạt ngưỡng mẫu thắng / mẫu tốt (hoặc không có dòng chi cấp mẩu trong kỳ)." });
      continue;
    }
    if (c.importedSourceId) {
      summary.existing.push({ adId, name: c.adName });
      continue;
    }
    let content: OwnAdContent;
    try {
      content = pickOwnAdContent(await deps.graph.getAdCreativeContent(adId));
    } catch (e) {
      summary.skipped.push({ adId, name: c.adName, reason: `Không đọc được quảng cáo từ Facebook: ${errText(e)}` });
      continue;
    }
    if (!content.ok) {
      summary.skipped.push({ adId, name: c.adName, reason: content.reason });
      continue;
    }
    let imageUrl = content.imageUrl;
    if (!imageUrl && content.imageHash) {
      const account = content.accountId ?? c.accountId;
      try {
        imageUrl = account ? ((await deps.graph.getAdImageUrls(account, [content.imageHash]))[content.imageHash] ?? null) : null;
      } catch (e) {
        summary.skipped.push({ adId, name: c.adName, reason: `Không tra được ảnh theo mã băm: ${errText(e)}` });
        continue;
      }
      if (!imageUrl) {
        summary.skipped.push({ adId, name: c.adName, reason: account ? "Thư viện ảnh của tài khoản không còn ảnh mang mã băm này." : "Không biết tài khoản quảng cáo để tra ảnh theo mã băm." });
        continue;
      }
    }
    if (!imageUrl) {
      summary.skipped.push({ adId, name: c.adName, reason: "Không có địa chỉ ảnh." });
      continue;
    }

    let stored: Awaited<ReturnType<typeof storeCreativeImage>>;
    try {
      stored = await storeCreativeImage(db, await downloadImage(imageUrl, deps));
    } catch (e) {
      summary.skipped.push({ adId, name: c.adName, reason: `Tải ảnh lỗi: ${errText(e)}` });
      continue;
    }
    const product = products.get(adId) ?? null;
    const metrics: OwnAdMetrics = ownAdMetricsOf(c, product?.basis ?? "NONE", now);
    const name = c.adName || content.name || `Quảng cáo ${adId}`;
    const [row] = await db
      .insert(s)
      .values({
        kind: "OWN_AD",
        productId: product?.productId ?? null,
        title: name.slice(0, 200),
        note: product ? "" : "Chưa suy được mã hàng (không có đơn mang ad_id này, tên chiến dịch không ghép được mã) — chưa làm mẫu cha được.",
        sourceUrl: `https://www.facebook.com/adsmanager/manage/ads?selected_ad_ids=${adId}`,
        imageId: stored.id,
        fbAdId: adId,
        metrics: metrics as unknown as Record<string, unknown>,
        primaryText: content.primaryText,
        headline: content.headline,
        createdByUserId: actor.id,
        createdByName: actor.name,
      })
      .onConflictDoNothing()
      .returning({ id: s.id });
    if (!row) {
      // Một lượt khác vừa nhập đúng mẩu này — dọn ảnh vừa lưu, báo "đã có".
      await db.delete(schema.creativeImages).where(eq(schema.creativeImages.id, stored.id));
      summary.existing.push({ adId, name });
      continue;
    }
    summary.imported.push({ adId, name, sourceId: row.id, productId: product?.productId ?? null });
    if (!product) summary.noProduct.push(adId);
  }
  return summary;
}

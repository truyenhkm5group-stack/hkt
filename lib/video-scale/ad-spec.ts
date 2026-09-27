import { createHmac, timingSafeEqual } from "node:crypto";
import { MESSENGER_DOC_LINK } from "@/lib/creative/story-spec";
import type { TemplateAd, TemplateAdset } from "@/lib/integrations/facebook/ads-write";

/**
 * ═══════════ BÀI QUẢNG CÁO VIDEO TỪ MẨU MẪU — HÀM THUẦN ═══════════
 *
 * Cùng luật với `buildObjectStorySpec` của vòng mẫu ảnh: máy CHÉP nút kêu gọi / đích / lời chào từ mẩu mẫu người dựng, không
 * tự chọn. Mẩu mẫu phải có ĐÚNG MỘT nút kêu gọi đọc được; không có ⇒ không dựng (không đoán hình dạng quảng cáo).
 * Fanpage đứng tên luôn là fanpage ĐƯỢC DUYỆT của mã (không phải fanpage của mẩu mẫu); mẩu mẫu ở fanpage khác ⇒ bỏ tài
 * khoản Instagram của fanpage kia (không để quảng cáo chạy trên Instagram của một thương hiệu khác).
 */

export type VideoSpecContent = { pageId: string; videoId: string; imageHash: string; message: string; title: string };
export type VideoSpecResult = { ok: true; spec: Record<string, unknown> } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type Cta = { type: string; link: string | null; welcome: unknown };

/** Nút kêu gọi của mẩu mẫu — từ link_data / video_data / photo_data, hoặc quảng cáo động có đúng một nút. */
export function templateCta(template: Pick<TemplateAd, "objectStorySpec" | "assetFeedSpec">): Cta | { error: string } {
  const oss = template.objectStorySpec;
  for (const k of ["link_data", "video_data", "photo_data"]) {
    const d = isRecord(oss) && isRecord(oss[k]) ? (oss[k] as Record<string, unknown>) : null;
    const cta = d && isRecord(d.call_to_action) ? d.call_to_action : null;
    if (cta && typeof cta.type === "string" && cta.type) {
      const value = isRecord(cta.value) ? cta.value : {};
      const link = typeof value.link === "string" && value.link ? value.link : typeof d?.link === "string" && d.link ? (d.link as string) : null;
      return { type: cta.type, link, welcome: d?.page_welcome_message ?? null };
    }
  }
  const feed = template.assetFeedSpec;
  if (isRecord(feed)) {
    const ctas = Array.isArray(feed.call_to_action_types) ? [...new Set(feed.call_to_action_types.filter((x): x is string => typeof x === "string" && x !== ""))] : [];
    if (ctas.length !== 1) return { error: `mẩu mẫu quảng cáo động có ${ctas.length} nút kêu gọi — cần đúng một` };
    const links = Array.isArray(feed.link_urls) ? feed.link_urls.map((x) => (isRecord(x) && typeof x.website_url === "string" ? x.website_url : "")).filter(Boolean) : [];
    const extra = isRecord(feed.additional_data) ? feed.additional_data : {};
    return { type: ctas[0], link: links[0] ?? null, welcome: extra.page_welcome_message ?? null };
  }
  return { error: "mẩu mẫu không có nút kêu gọi (call_to_action) đọc được" };
}

export function buildVideoStorySpec(template: Pick<TemplateAd, "objectStorySpec" | "assetFeedSpec">, c: VideoSpecContent): VideoSpecResult {
  if (!c.pageId || !c.videoId || !c.imageHash) return { ok: false, error: "Thiếu fanpage / video / ảnh bìa." };
  if (!c.message.trim()) return { ok: false, error: "Quảng cáo chưa có câu chữ." };
  const cta = templateCta(template);
  if ("error" in cta) return { ok: false, error: `Mẩu mẫu không dùng được cho quảng cáo video: ${cta.error}.` };
  const link = cta.link ?? (cta.type === "MESSAGE_PAGE" ? MESSENGER_DOC_LINK : null);
  if (!link && cta.type !== "MESSAGE_PAGE") return { ok: false, error: `Mẩu mẫu dùng nút ${cta.type} mà không có đường dẫn — máy không đoán.` };
  const base: Record<string, unknown> = isRecord(template.objectStorySpec) ? clone(template.objectStorySpec) : {};
  const samePage = base.page_id === c.pageId;
  for (const k of ["link_data", "photo_data", "video_data", "template_data", "text_data"]) delete base[k];
  if (!samePage) {
    delete base.instagram_actor_id;
    delete base.instagram_user_id;
  }
  base.page_id = c.pageId;
  const video: Record<string, unknown> = {
    video_id: c.videoId,
    image_hash: c.imageHash,
    message: c.message,
    call_to_action: { type: cta.type, value: cta.type === "MESSAGE_PAGE" ? { app_destination: "MESSENGER" } : { link } },
  };
  if (c.title.trim()) video.title = c.title.trim().slice(0, 40);
  if (cta.welcome !== null && cta.welcome !== undefined) video.page_welcome_message = clone(cta.welcome);
  base.video_data = video;
  return { ok: true, spec: base };
}

/**
 * Nhóm quảng cáo mẫu áp sang fanpage của mã: `promoted_object.page_id` (nếu mẫu có) đổi về fanpage được duyệt — một
 * nhóm tối ưu tin nhắn mà trỏ tin nhắn về fanpage khác là tiền mua hội thoại cho người khác. Hàm THUẦN.
 */
export function adsetForPage(t: TemplateAdset, pageId: string): TemplateAdset {
  const po = t.promotedObject ? { ...t.promotedObject } : null;
  if (po && "page_id" in po) po.page_id = pageId;
  return { ...t, promotedObject: po };
}

// ───────────────────────────── LINK KÝ TÊN CHO FACEBOOK TẢI VIDEO ─────────────────────────────

/** Link ký tên sống tối đa 2 giờ — đủ cho Facebook tải một video, không đủ để thành link công khai lâu dài. */
export const SIGNED_URL_MAX_MS = 2 * 3_600_000;

export function assetSignature(secret: string, assetId: string, expUnix: number): string {
  return createHmac("sha256", secret).update(`video-scale-asset\n${assetId}\n${expUnix}`).digest("hex").slice(0, 40);
}

export function signedAssetUrl(appUrl: string, secret: string, assetId: string, now: Date, ttlMs = 60 * 60_000): string {
  const exp = Math.floor((now.getTime() + Math.min(ttlMs, SIGNED_URL_MAX_MS)) / 1000);
  return `${appUrl.replace(/\/$/, "")}/api/video-scale/public/${encodeURIComponent(assetId)}?exp=${exp}&sig=${assetSignature(secret, assetId, exp)}`;
}

/** Kiểm link ký tên: đúng chữ ký (so hằng thời gian), chưa hết hạn, hạn không xa quá 2 giờ. Hàm THUẦN. */
export function verifyAssetSignature(secret: string, assetId: string, expRaw: string | null, sig: string | null, now: Date): boolean {
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || !sig) return false;
  const nowSec = now.getTime() / 1000;
  if (exp < nowSec || exp > nowSec + SIGNED_URL_MAX_MS / 1000 + 60) return false;
  const want = Buffer.from(assetSignature(secret, assetId, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

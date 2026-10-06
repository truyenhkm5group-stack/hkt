/**
 * ═══════════ QUẢNG CÁO NÀO DẪN KHÁCH VÀO HỘI THOẠI — BỘ ĐỌC THUẦN (không import máy chủ) ═══════════
 *
 * Đơn ERP (bot chốt / ghi đơn từ hội thoại) từng không mang mã quảng cáo nào, nên /ads in «0 đơn chốt» ở mọi chiến dịch của
 * tổ chức chỉ có đơn ERP. Hai bộ đọc dưới đây lấy mã mẩu quảng cáo Meta từ gói tin của KHÁCH; `lib/sales-chatbot/ad-referral.ts`
 * lưu nó lên hội thoại, đơn tạo sau đó đọc lại (cửa sổ: `lib/constants/chat-ad-attribution.ts`).
 *
 * PANCAKE: CHƯA ĐO được Pancake gửi trường nào (06/10/2026) — nên chấp nhận mọi khuôn đã biết ở POS Pancake, và màn /ads đếm số
 * hội thoại có mã để lộ ra nếu Pancake không gửi gì. MESSENGER: `referral` của Meta, CHỈ khi `source = "ADS"`.
 *
 * Chỉ nhận mã là chuỗi CHỮ SỐ (mã quảng cáo Meta); chuỗi lạ ⇒ không phải mã. Tin phía page / tiếng vọng KHÔNG BAO GIỜ mang
 * quảng cáo của khách.
 */
import type { ChatAdSource } from "@/lib/constants/chat-ad-attribution";

export type AdReferral = { adId: string; clickedAt: Date | null; source: ChatAdSource };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const AD_ID_RE = /^\d{5,30}$/;
const adIdOf = (v: unknown): string | null => {
  const s = str(v);
  return AD_ID_RE.test(s) ? s : null;
};

/** Mốc Pancake: ISO KHÔNG múi giờ là UTC (AGENTS.md mục 4) · số ⇒ giây hoặc mili giây. Sai ⇒ `null`. */
function timeOf(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000);
  const s = str(v);
  if (!s) return null;
  if (/^\d+$/.test(s)) return timeOf(Number(s));
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Tin Pancake là của PHÍA PAGE (nhân viên / bot / page tự động): người gửi là page, hoặc mang `admin_id` / `uid`. Cùng luật
 * `parsePancakeWebhook` dùng — một bản, hai chỗ đọc.
 */
export function isPancakePageSide(from: unknown, pageId: string): boolean {
  const f = obj(from) ?? {};
  return str(f.id) === pageId || Boolean(f.admin_id) || Boolean(f.uid);
}

/** Một mục của danh sách lượt bấm: chuỗi mã, hoặc object có `ad_id` / `id` + mốc. */
function entryOf(v: unknown): { adId: string; at: Date | null } | null {
  const o = obj(v);
  if (!o) {
    const id = adIdOf(v);
    return id ? { adId: id, at: null } : null;
  }
  const id = adIdOf(o.ad_id) ?? adIdOf(o.id);
  if (!id) return null;
  return { adId: id, at: timeOf(o.inserted_at) ?? timeOf(o.time) ?? timeOf(o.clicked_at) ?? timeOf(o.created_at) ?? timeOf(o.timestamp) };
}

/** Nhiều mục ⇒ mục có mốc MỚI NHẤT; không mục nào có mốc ⇒ phần tử cuối. */
function latest(list: readonly { adId: string; at: Date | null }[]): { adId: string; at: Date | null } | null {
  if (!list.length) return null;
  const timed = list.filter((e) => e.at);
  if (!timed.length) return list[list.length - 1];
  return timed.reduce((a, b) => (b.at!.getTime() >= a.at!.getTime() ? b : a));
}

/**
 * Gói webhook Pancake (event_type = messaging) ⇒ mã quảng cáo của KHÁCH, hoặc `null`. Thứ tự: `conversation.ad_clicks` →
 * `conversation.ads` → `conversation.ad_id` → `message.ad_id` (danh sách trước, vì nó mang mốc). HÀM THUẦN.
 */
export function adReferralFromPancake(payload: unknown): AdReferral | null {
  const p = obj(payload);
  if (!p || p.event_type !== "messaging") return null;
  const data = obj(p.data) ?? {};
  const msg = obj(data.message) ?? {};
  const conv = obj(data.conversation) ?? {};
  if (isPancakePageSide(msg.from, str(p.page_id))) return null;
  for (const key of ["ad_clicks", "ads"] as const) {
    const list = Array.isArray(conv[key]) ? (conv[key] as unknown[]).map(entryOf).filter((e): e is { adId: string; at: Date | null } => e !== null) : [];
    const hit = latest(list);
    if (hit) return { adId: hit.adId, clickedAt: hit.at, source: "PANCAKE" };
  }
  const single = adIdOf(conv.ad_id) ?? adIdOf(msg.ad_id);
  return single ? { adId: single, clickedAt: null, source: "PANCAKE" } : null;
}

/**
 * MỘT mục `entry[].messaging[]` của webhook Meta ⇒ mã quảng cáo của khách, hoặc `null`. Đọc `message.referral`,
 * `postback.referral` và sự kiện `referral` đứng riêng (messaging_referrals) — CHỈ khi `source === "ADS"` và có `ad_id`.
 * Tiếng vọng (tin page gửi đi) ⇒ `null`. Mốc = `timestamp` của mục. HÀM THUẦN.
 */
export function adReferralFromMessenger(messagingItem: unknown): AdReferral | null {
  const m = obj(messagingItem);
  if (!m) return null;
  const msg = obj(m.message);
  if (msg?.is_echo === true) return null;
  const postback = obj(m.postback);
  for (const ref of [obj(msg?.referral), obj(postback?.referral), obj(m.referral)]) {
    if (!ref || str(ref.source).toUpperCase() !== "ADS") continue;
    const adId = adIdOf(ref.ad_id);
    if (adId) return { adId, clickedAt: typeof m.timestamp === "number" ? timeOf(m.timestamp) : null, source: "MESSENGER" };
  }
  return null;
}

/**
 * ═══════════ ẢNH ĐẠI DIỆN KHÁCH + BẤM ẢNH ĐI ĐÂU — LÕI THUẦN (chủ shop 10/10/2026, mục E · F) ═══════════
 *
 * Tệp này KHÔNG đọc / ghi CSDL, KHÔNG gọi mạng, KHÔNG import gì của máy chủ ⇒ client component dùng được (thread-view), và mọi
 * đường ghi (webhook Pancake · quét lại · nhập lịch sử · Graph Meta) cùng đi qua đúng các hàm ở đây.
 *
 * 1. ẢNH. Ba nguồn đang có, đọc ra một trong NĂM trạng thái chẩn đoán (`avatarStatusOf`) — tính LÚC ĐỌC từ dữ kiện đã lưu trong
 *    `sales_chat_conversations.state`, không cột mới, không backfill:
 *      · `state.messengerProfile` `{ pic, at, error, code, subcode, http }` — Graph `GET /{PSID}?fields=profile_pic` (messenger.ts);
 *      · `state.pancakeAvatarUrl` — ảnh Pancake trả sẵn KHÔNG mang khoá;
 *      · `state.pancakeAvatar` `{ at, outcome, via }` — lần gần nhất ERP thấy payload Pancake của khách, và payload đó nói gì về ảnh
 *        (`URL` · `TOKENIZED_URL` · `INVALID_URL` · `NO_AVATAR_FIELD`). Không có dòng này thì chẩn đoán KHÔNG đoán là "Pancake không
 *        có ảnh" — nó là CHƯA LẤY.
 *
 * 2. LINK. `facebookProfileHrefOf` theo ĐÚNG thứ tự mục F:
 *      (1) URL trang Facebook THẬT do nguồn cung cấp ⇒ dùng (https, host facebook.com / m.facebook.com / fb.com, đường dẫn là một
 *          trang cá nhân — không phải trang hội thoại Pancake, không phải hộp thoại / bài viết / nhóm, không mang khoá);
 *      (2) mã Facebook mà nguồn CHỨNG MINH là định danh trang công khai (`PUBLIC_PROFILE`) ⇒ dựng `profile.php?id=`;
 *      (3) PSID / mã THEO PAGE ⇒ KHÔNG BAO GIỜ dựng — `facebook.com/<PSID>` mở ra trang lỗi hoặc SAI NGƯỜI;
 *      (4) còn lại ⇒ `null` kèm lý do, và nơi gọi lùi về hồ sơ khách nội bộ (`avatarLinkOf`).
 *    Nghĩa của từng trường mã nằm ở `FACEBOOK_ID_SOURCES` kèm CĂN CỨ trong kho. Đo 10/10/2026: KHÔNG nguồn nào đang chứng minh được
 *    một mã công khai và KHÔNG nguồn nào trả URL trang cá nhân ⇒ hôm nay mọi ảnh mở hồ sơ khách nội bộ. Đó là hành vi ĐÚNG, không
 *    phải lỗi: một link Facebook đoán sai đưa nhân viên nhắn nhầm người.
 */

// ─────────────────────────── 1. ẢNH ───────────────────────────

/** Ảnh đại diện Meta là URL CDN có hạn — đọc lại sau chừng này (giữ nguyên số của bản 0233). */
export const PROFILE_REFRESH_MS = 3 * 24 * 3_600_000;
/** Lần lấy hỏng vì QUYỀN (app thiếu Business Asset User Profile Access, token page sai) — hỏi lại sau một ngày, không hỏi mỗi lượt. */
export const PROFILE_DENIED_RETRY_MS = 24 * 3_600_000;
/** Lần lấy hỏng vì mạng / Meta giới hạn tốc độ — thử lại sớm hơn hẳn; không phải câu trả lời của Meta về người này. */
export const PROFILE_TRANSIENT_RETRY_MS = 3_600_000;
/** Ghi lại dấu «đã thấy payload Pancake» tối đa mỗi chừng này cho một hội thoại — mỗi tin khách không đẻ ra một lượt ghi. */
export const PANCAKE_AVATAR_RESTAMP_MS = 24 * 3_600_000;

export const AVATAR_STATUSES = ["PROFILE_AVAILABLE", "PROFILE_PERMISSION_DENIED", "PROFILE_NOT_AVAILABLE", "PROFILE_EXPIRED", "PROFILE_NOT_FETCHED"] as const;
export type AvatarStatus = (typeof AVATAR_STATUSES)[number];

export const AVATAR_STATUS_LABEL: Record<AvatarStatus, string> = {
  PROFILE_AVAILABLE: "Có ảnh",
  PROFILE_PERMISSION_DENIED: "Không có quyền đọc hồ sơ",
  PROFILE_NOT_AVAILABLE: "Nguồn không cho ảnh",
  PROFILE_EXPIRED: "Ảnh đã hết hạn",
  PROFILE_NOT_FETCHED: "Chưa lấy",
};

/** Lý do chi tiết đi kèm trạng thái — đủ để biết phải sửa ở đâu. */
export type AvatarReason =
  | "META_PIC"
  | "PANCAKE_URL"
  | "META_PIC_URL_EXPIRED"
  | "META_PIC_STALE"
  | "PANCAKE_URL_EXPIRED"
  | "META_PERMISSION"
  | "META_TOKEN_INVALID"
  | "META_NO_PROFILE_PIC"
  | "META_OBJECT_UNREADABLE"
  | "META_RATE_LIMITED"
  | "META_TRANSIENT"
  | "PANCAKE_URL_REQUIRES_TOKEN"
  | "PANCAKE_URL_INVALID"
  | "PANCAKE_PAYLOAD_NO_AVATAR"
  | "NEVER_FETCHED";

export type AvatarDiagnosis = { status: AvatarStatus; source: "META" | "PANCAKE" | null; reason: AvatarReason };

/** Dữ kiện Graph đã lưu (`state.messengerProfile`). Bản 0233 chỉ có `pic · at · error`; mã lỗi có từ 10/10/2026. */
export type StoredMetaProfile = { pic?: unknown; at?: unknown; error?: unknown; code?: unknown; subcode?: unknown; http?: unknown };

export const PANCAKE_AVATAR_OUTCOMES = ["URL", "TOKENIZED_URL", "INVALID_URL", "NO_AVATAR_FIELD"] as const;
export type PancakeAvatarOutcome = (typeof PANCAKE_AVATAR_OUTCOMES)[number];
export function isPancakeAvatarOutcome(v: unknown): v is PancakeAvatarOutcome {
  return typeof v === "string" && (PANCAKE_AVATAR_OUTCOMES as readonly string[]).includes(v);
}
export type PancakeAvatarVia = "WEBHOOK" | "POLL" | "HISTORY";
/** Payload Pancake nói gì về ảnh của khách. `url` chỉ có khi `outcome = URL`. */
export type PancakeAvatarFacts = { url: string | null; outcome: PancakeAvatarOutcome; via?: PancakeAvatarVia };

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** URL ảnh Pancake dùng được: https, ≤ 1000 ký tự, KHÔNG mang khoá. Luật của `history.ts::pancakeAvatarOf` từ 0221, giữ nguyên. */
function pancakeUrlOk(url: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(url) && url.length <= 1000 && !/token|access|secret|key=/i.test(url);
}

/**
 * Một đối tượng Pancake (hội thoại của danh sách · `data.conversation` / `data.message` của webhook) ⇒ ảnh khách + VÌ SAO không có.
 * Đọc ĐÚNG các khoá `pancakeAvatarOf` đọc từ 0221 (`history.ts` gọi hàm này — một luật, không chép). Đường ảnh riêng của Pancake
 * đòi `page_access_token` trong URL ⇒ `TOKENIZED_URL`, không bao giờ lưu (kho mã PUBLIC; CSDL không phải chỗ cất khoá). HÀM THUẦN.
 */
export function pancakeAvatarFactsOf(obj: unknown, via?: PancakeAvatarVia): PancakeAvatarFacts {
  const c = rec(obj);
  const from = rec(c.from);
  const cust = rec(Array.isArray(c.customers) ? c.customers[0] : null);
  let outcome: PancakeAvatarOutcome = "NO_AVATAR_FIELD";
  for (const v of [c.avatar_url, c.avatar, from.avatar_url, from.avatar, from.picture, cust.avatar_url, cust.avatar, cust.picture]) {
    const url = str(v).trim();
    if (!url) continue;
    if (pancakeUrlOk(url)) return { url, outcome: "URL", ...(via ? { via } : {}) };
    if (/token|access|secret|key=/i.test(url)) outcome = "TOKENIZED_URL";
    else if (outcome === "NO_AVATAR_FIELD") outcome = "INVALID_URL";
  }
  return { url: null, outcome, ...(via ? { via } : {}) };
}

const OUTCOME_RANK: Record<PancakeAvatarOutcome, number> = { URL: 3, TOKENIZED_URL: 2, INVALID_URL: 1, NO_AVATAR_FIELD: 0 };
/** Nhiều đối tượng của CÙNG một gói (hội thoại + tin) ⇒ một kết luận: có ảnh thắng, rồi lý do mạnh nhất. HÀM THUẦN. */
export function mergePancakeAvatarFacts(list: readonly PancakeAvatarFacts[]): PancakeAvatarFacts {
  return list.reduce<PancakeAvatarFacts>((best, f) => (OUTCOME_RANK[f.outcome] > OUTCOME_RANK[best.outcome] ? f : best), { url: null, outcome: "NO_AVATAR_FIELD", ...(list[0]?.via ? { via: list[0].via } : {}) });
}

/**
 * Bản vá `state` của hội thoại sau khi thấy một payload Pancake của khách — `null` = không cần ghi. Luật:
 *  · có ảnh mới ⇒ ghi ảnh + dấu; cùng ảnh ⇒ chỉ đóng lại dấu khi dấu cũ quá `PANCAKE_AVATAR_RESTAMP_MS`;
 *  · không có ảnh ⇒ KHÔNG xoá ảnh đã có (một gói thiếu trường không phải bằng chứng khách bỏ ảnh), chỉ ghi lý do khi khác lý do cũ
 *    hoặc dấu cũ đã quá hạn.
 * Dùng chung cho webhook / quét lại (`fanpage.ts::noteCustomerArrived`) và nhập lịch sử (`history.ts::finishThread`). HÀM THUẦN.
 */
export function pancakeAvatarPatch(state: unknown, facts: PancakeAvatarFacts, now: Date): Record<string, unknown> | null {
  const st = rec(state);
  const prev = rec(st.pancakeAvatar);
  const prevAt = Date.parse(str(prev.at));
  const stale = !Number.isFinite(prevAt) || now.getTime() - prevAt >= PANCAKE_AVATAR_RESTAMP_MS;
  const stamp = { pancakeAvatar: { at: now.toISOString(), outcome: facts.outcome, ...(facts.via ? { via: facts.via } : {}) } };
  if (facts.outcome === "URL" && facts.url) {
    if (facts.url !== st.pancakeAvatarUrl) return { pancakeAvatarUrl: facts.url, ...stamp };
    return prev.outcome !== "URL" || stale ? stamp : null;
  }
  return prev.outcome !== facts.outcome || stale ? stamp : null;
}

/**
 * Mốc hết hạn GHI TRONG URL CDN của Meta: `ext=<giây>` (platform-lookaside — dạng `profile_pic` trả) hoặc `oe=<giây hệ 16>` (fbcdn).
 * Không có tham số ⇒ `null` (không biết — không đoán). HÀM THUẦN.
 */
export function cdnExpiryMs(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const ext = u.searchParams.get("ext");
  if (ext && /^\d{9,11}$/.test(ext)) return Number(ext) * 1000;
  const oe = u.searchParams.get("oe");
  if (oe && /^[0-9a-f]{6,10}$/i.test(oe)) return parseInt(oe, 16) * 1000;
  return null;
}

/**
 * Ảnh hộp thư SẼ hiện: cùng điều kiện với `inbox-shared.ts::safeAvatarUrl` (https, ≤ 2000, không mang khoá) — chẩn đoán «có ảnh»
 * phải trùng đúng thứ nhân viên thấy (`tests/inbox-avatar-profile.test.ts` so hai hàm trên cùng bảng URL). Không import qua lại vì
 * inbox-shared đã import tệp này.
 */
function goodHttps(v: unknown): string | null {
  const url = str(v).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) && url.length <= 2000 && !/access_token|[?&](token|key|secret)=/i.test(url) ? url : null;
}

/** Lỗi Graph đã lưu ⇒ loại. Mã có từ 10/10/2026; dòng cũ chỉ có câu ⇒ đọc câu, mơ hồ ⇒ coi là chưa lấy được (không khẳng định). HÀM THUẦN. */
export function metaProfileErrorKind(p: StoredMetaProfile): "PERMISSION" | "TOKEN_INVALID" | "NO_PIC" | "UNREADABLE" | "RATE_LIMITED" | "TRANSIENT" {
  const code = Number(p.code);
  const subcode = Number(p.subcode);
  const http = Number(p.http);
  const msg = str(p.error);
  if (code === 190 || /error validating access token|session has expired|invalid oauth/i.test(msg)) return "TOKEN_INVALID";
  if ([4, 17, 32, 613].includes(code) || /request limit|rate limit|too many calls/i.test(msg)) return "RATE_LIMITED";
  if (code === 10 || (code >= 200 && code <= 299) || /permission|not authorized|business asset|\(#10\)|\(#2\d\d\)/i.test(msg)) return "PERMISSION";
  // Meta trả MỘT câu cho ba khả năng («does not exist, cannot be loaded due to missing permissions, or does not support this
  // operation») ⇒ không đủ để nói là thiếu quyền hay khách không còn — giữ một loại riêng.
  if ((code === 100 && subcode === 33) || /unsupported get request|cannot be loaded/i.test(msg)) return "UNREADABLE";
  if (code === 100 || http === 404) return "NO_PIC";
  return "TRANSIENT";
}

/** Mốc lấy hồ sơ Meta tiếp theo đã tới chưa. Không bao giờ ném. HÀM THUẦN. */
export function profileRefreshDue(prev: StoredMetaProfile | null | undefined, now: Date): boolean {
  const at = Date.parse(str(prev?.at));
  if (!prev || !Number.isFinite(at)) return true;
  const age = now.getTime() - at;
  const pic = goodHttps(prev.pic);
  if (pic) {
    const exp = cdnExpiryMs(pic);
    return age >= PROFILE_REFRESH_MS || (exp !== null && exp <= now.getTime());
  }
  if (!str(prev.error)) return age >= PROFILE_REFRESH_MS; // trả 200 mà không có ảnh ⇒ người dùng không có ảnh công khai
  const kind = metaProfileErrorKind(prev);
  const wait = kind === "PERMISSION" || kind === "TOKEN_INVALID" ? PROFILE_DENIED_RETRY_MS : kind === "RATE_LIMITED" || kind === "TRANSIENT" ? PROFILE_TRANSIENT_RETRY_MS : PROFILE_REFRESH_MS;
  return age >= wait;
}

/**
 * Năm trạng thái chẩn đoán ảnh đại diện từ `state` đã lưu. Thứ tự: có ảnh còn hạn (Meta rồi Pancake) ⇒ ảnh đã hết hạn ⇒ lời Meta
 * về lần lấy gần nhất ⇒ lời Pancake về payload gần nhất ⇒ CHƯA LẤY. HÀM THUẦN.
 */
export function avatarStatusOf(state: unknown, now: Date): AvatarDiagnosis {
  const st = rec(state);
  const meta = rec(st.messengerProfile) as StoredMetaProfile;
  const metaAt = Date.parse(str(meta.at));
  const metaPic = goodHttps(meta.pic);
  const pancakeUrl = goodHttps(st.pancakeAvatarUrl);
  const expired = (url: string) => {
    const exp = cdnExpiryMs(url);
    return exp !== null && exp <= now.getTime();
  };
  let expiredHit: AvatarDiagnosis | null = null;
  if (metaPic) {
    if (expired(metaPic)) expiredHit = { status: "PROFILE_EXPIRED", source: "META", reason: "META_PIC_URL_EXPIRED" };
    else if (cdnExpiryMs(metaPic) === null && Number.isFinite(metaAt) && now.getTime() - metaAt >= PROFILE_REFRESH_MS) expiredHit = { status: "PROFILE_EXPIRED", source: "META", reason: "META_PIC_STALE" };
    else return { status: "PROFILE_AVAILABLE", source: "META", reason: "META_PIC" };
  }
  if (pancakeUrl) {
    if (expired(pancakeUrl)) expiredHit ??= { status: "PROFILE_EXPIRED", source: "PANCAKE", reason: "PANCAKE_URL_EXPIRED" };
    else return { status: "PROFILE_AVAILABLE", source: "PANCAKE", reason: "PANCAKE_URL" };
  }
  if (expiredHit) return expiredHit;
  if (Number.isFinite(metaAt) && str(meta.error)) {
    const kind = metaProfileErrorKind(meta);
    if (kind === "PERMISSION") return { status: "PROFILE_PERMISSION_DENIED", source: "META", reason: "META_PERMISSION" };
    if (kind === "TOKEN_INVALID") return { status: "PROFILE_PERMISSION_DENIED", source: "META", reason: "META_TOKEN_INVALID" };
    if (kind === "NO_PIC") return { status: "PROFILE_NOT_AVAILABLE", source: "META", reason: "META_NO_PROFILE_PIC" };
    if (kind === "UNREADABLE") return { status: "PROFILE_NOT_AVAILABLE", source: "META", reason: "META_OBJECT_UNREADABLE" };
    return { status: "PROFILE_NOT_FETCHED", source: "META", reason: kind === "RATE_LIMITED" ? "META_RATE_LIMITED" : "META_TRANSIENT" };
  }
  if (Number.isFinite(metaAt)) return { status: "PROFILE_NOT_AVAILABLE", source: "META", reason: "META_NO_PROFILE_PIC" };
  const pk = rec(st.pancakeAvatar);
  if (pk.outcome === "TOKENIZED_URL") return { status: "PROFILE_NOT_AVAILABLE", source: "PANCAKE", reason: "PANCAKE_URL_REQUIRES_TOKEN" };
  if (pk.outcome === "INVALID_URL") return { status: "PROFILE_NOT_AVAILABLE", source: "PANCAKE", reason: "PANCAKE_URL_INVALID" };
  if (pk.outcome === "NO_AVATAR_FIELD") return { status: "PROFILE_NOT_AVAILABLE", source: "PANCAKE", reason: "PANCAKE_PAYLOAD_NO_AVATAR" };
  return { status: "PROFILE_NOT_FETCHED", source: null, reason: "NEVER_FETCHED" };
}

// ─────────────────────────── 2. LINK FACEBOOK ───────────────────────────

/** Nghĩa của một mã Facebook theo nguồn: THEO PAGE (PSID) · CHƯA CHỨNG MINH · trang công khai đã chứng minh. */
export type FacebookIdKind = "PAGE_SCOPED" | "UNPROVEN" | "PUBLIC_PROFILE";

/**
 * SỔ NGHĨA CÁC TRƯỜNG MÃ FACEBOOK ERP ĐANG LƯU — mỗi dòng một CĂN CỨ trong kho. Thêm `PUBLIC_PROFILE` chỉ khi có tài liệu của nguồn
 * HOẶC phép đo trên dữ liệu thật chứng minh mã đó mở đúng trang công khai của đúng người.
 */
export const FACEBOOK_ID_SOURCES = {
  /** `sales_chat_conversations.thread_id` của hội thoại Messenger trực tiếp, `sales_chat_inbound.sender_id`. */
  META_PSID: {
    kind: "PAGE_SCOPED",
    basis: "PSID do Messenger Platform cấp theo TỪNG page (webhook `sender.id`) — `order-sync.ts::inboundThreadProfile`: «PSID chỉ có nghĩa trong page».",
  },
  /** `customers.fb_id` — đồng bộ khách Pancake (`lib/integrations/pancake/mapper.ts` đọc `c.fb_id`). */
  PANCAKE_CUSTOMER_FB_ID: {
    kind: "PAGE_SCOPED",
    basis:
      "Mã hội thoại INBOX của Pancake là `<page>_<PSID>` (docs/saas/PRICING_V1.md) và `lib/cs/failed-delivery.ts` · `lib/cs/phone-verify.ts` dùng `fb_id` THAY CHO phần cuối mã hội thoại khi gọi tin nhắn; `returning.ts` gom `fb_id` cùng không gian với `message.from.id` của khách (PSID). Không tài liệu / dữ liệu nào trong kho chứng minh đây là mã trang công khai.",
  },
  /** Pancake webhook `conversation.from_psid`. */
  PANCAKE_FROM_PSID: { kind: "PAGE_SCOPED", basis: "Tên trường của chính Pancake: `from_psid` (fanpage.ts::parsePancakeWebhook)." },
} as const satisfies Record<string, { kind: FacebookIdKind; basis: string }>;
export type FacebookIdSource = keyof typeof FACEBOOK_ID_SOURCES;

export type FacebookHrefReason =
  | "FACEBOOK_SOURCE_URL"
  | "FACEBOOK_PUBLIC_ID"
  | "NO_SOURCE_URL"
  | "SOURCE_URL_NOT_FACEBOOK"
  | "SOURCE_URL_NOT_PROFILE"
  | "ONLY_PAGE_SCOPED_ID"
  | "ID_MEANING_UNPROVEN";

export const FACEBOOK_HREF_REASON_LABEL: Record<FacebookHrefReason, string> = {
  FACEBOOK_SOURCE_URL: "link trang Facebook do nguồn cung cấp",
  FACEBOOK_PUBLIC_ID: "mã trang Facebook công khai đã xác minh",
  NO_SOURCE_URL: "nguồn không cung cấp link trang Facebook",
  SOURCE_URL_NOT_FACEBOOK: "link nguồn không phải trang Facebook (vd link Pancake)",
  SOURCE_URL_NOT_PROFILE: "link nguồn không phải trang cá nhân Facebook",
  ONLY_PAGE_SCOPED_ID: "nguồn chỉ có mã theo page (PSID) — không dựng được link trang Facebook",
  ID_MEANING_UNPROVEN: "chưa chứng minh được mã là trang công khai — không dựng link",
};

const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"]);
/** Đường dẫn Facebook KHÔNG phải trang cá nhân (hộp thoại, bài, nhóm, trang page, chia sẻ…). */
const NON_PROFILE_PATHS = new Set(["dialog", "pages", "groups", "events", "messages", "sharer", "sharer.php", "share", "share.php", "login", "login.php", "plugins", "permalink.php", "story.php", "photo", "photo.php", "photos", "watch", "reel", "ads", "business", "help", "l.php", "marketplace", "gaming", "hashtag", "search", "settings", "privacy", "policies", "home.php", "notifications", "friends", "people", "public", "media", "video.php", "videos", "posts", "stories", "live", "fundraisers", "legal", "terms", "about"]);

export type FacebookIdInput = { value: string | null | undefined; source: FacebookIdSource } | { value: string | null | undefined; kind: FacebookIdKind };
const kindOf = (i: FacebookIdInput): FacebookIdKind => ("source" in i ? FACEBOOK_ID_SOURCES[i.source].kind : i.kind);

/**
 * Link trang Facebook của khách theo thứ tự mục F, hoặc `null` + lý do. `ids` = mọi mã ERP biết về khách kèm NGHĨA của nó; mã theo
 * page còn dùng để TỪ CHỐI một URL nguồn trỏ vào chính mã đó (`facebook.com/<PSID>`). HÀM THUẦN.
 */
export function facebookProfileHrefOf(input: { sourceProfileUrl?: string | null; ids?: readonly FacebookIdInput[] }): { href: string | null; reason: FacebookHrefReason } {
  const ids = (input.ids ?? []).map((i) => ({ value: str(i.value).trim(), kind: kindOf(i) })).filter((i) => i.value);
  const scoped = new Set(ids.filter((i) => i.kind !== "PUBLIC_PROFILE").map((i) => i.value));
  let urlReason: FacebookHrefReason | null = null;
  const raw = str(input.sourceProfileUrl).trim();
  if (raw) {
    const checked = checkProfileUrl(raw, scoped);
    if (checked.href) return { href: checked.href, reason: "FACEBOOK_SOURCE_URL" };
    urlReason = checked.reason;
  }
  const pub = ids.find((i) => i.kind === "PUBLIC_PROFILE" && /^\d{5,20}$/.test(i.value) && !scoped.has(i.value));
  if (pub) return { href: `https://www.facebook.com/profile.php?${new URLSearchParams({ id: pub.value })}`, reason: "FACEBOOK_PUBLIC_ID" };
  if (urlReason) return { href: null, reason: urlReason };
  if (ids.some((i) => i.kind === "PAGE_SCOPED")) return { href: null, reason: "ONLY_PAGE_SCOPED_ID" };
  if (ids.some((i) => i.kind === "UNPROVEN")) return { href: null, reason: "ID_MEANING_UNPROVEN" };
  return { href: null, reason: "NO_SOURCE_URL" };
}

function checkProfileUrl(raw: string, scoped: ReadonlySet<string>): { href: string | null; reason: FacebookHrefReason } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { href: null, reason: "SOURCE_URL_NOT_FACEBOOK" };
  }
  if (u.protocol !== "https:" || !FACEBOOK_HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password || u.port) return { href: null, reason: "SOURCE_URL_NOT_FACEBOOK" };
  if (/token|secret|key=|access/i.test(u.search)) return { href: null, reason: "SOURCE_URL_NOT_PROFILE" };
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 1 && segs[0].toLowerCase() === "profile.php") {
    const id = u.searchParams.get("id") ?? "";
    if (!/^\d{5,20}$/.test(id)) return { href: null, reason: "SOURCE_URL_NOT_PROFILE" };
    if (scoped.has(id)) return { href: null, reason: "ONLY_PAGE_SCOPED_ID" };
    return { href: `https://${u.hostname.toLowerCase()}/profile.php?${new URLSearchParams({ id })}`, reason: "FACEBOOK_SOURCE_URL" };
  }
  if (segs.length !== 1 || !/^[A-Za-z0-9.]{3,80}$/.test(segs[0]) || NON_PROFILE_PATHS.has(segs[0].toLowerCase())) return { href: null, reason: "SOURCE_URL_NOT_PROFILE" };
  if (scoped.has(segs[0])) return { href: null, reason: "ONLY_PAGE_SCOPED_ID" };
  return { href: `https://${u.hostname.toLowerCase()}/${segs[0]}`, reason: "FACEBOOK_SOURCE_URL" };
}

// ─────────────────────────── 3. BẤM ẢNH ───────────────────────────

export type AvatarLinkReason = FacebookHrefReason | "NO_CUSTOMER_PROFILE";
/** Bấm ảnh đi đâu: `external` ⇒ trang Facebook, mở tab mới; không ⇒ hồ sơ khách nội bộ; `href = null` ⇒ ảnh không phải link. */
export type AvatarLink = { href: string | null; external: boolean; reason: AvatarLinkReason };

/**
 * Link Facebook hợp lệ ⇒ mở trang Facebook (tab mới). Không ⇒ hồ sơ khách nội bộ khi đã nối (`reason` nói vì sao không có link
 * Facebook); chưa nối hồ sơ ⇒ ảnh không phải link. HÀM THUẦN.
 */
export function avatarLinkOf(input: { customerId?: string | null; sourceProfileUrl?: string | null; ids?: readonly FacebookIdInput[] }): AvatarLink {
  const fb = facebookProfileHrefOf({ sourceProfileUrl: input.sourceProfileUrl, ids: input.ids });
  if (fb.href) return { href: fb.href, external: true, reason: fb.reason };
  if (input.customerId) return { href: `/customers/${encodeURIComponent(input.customerId)}`, external: false, reason: fb.reason };
  return { href: null, external: false, reason: "NO_CUSTOMER_PROFILE" };
}

/** Câu hiện khi rê chuột / đọc màn hình. */
export function avatarLinkTitle(link: AvatarLink): string {
  if (link.external) return "Mở trang Facebook";
  if (link.reason === "NO_CUSTOMER_PROFILE") return "";
  return `Mở hồ sơ khách — chưa có link Facebook: ${FACEBOOK_HREF_REASON_LABEL[link.reason]}`;
}

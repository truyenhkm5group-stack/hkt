/**
 * ═══════════ KÊNH KẾT NỐI HỢP NHẤT — LUẬT THUẦN (dùng được ở client) ═══════════
 *
 * Một màn cho khách thấy MỌI page / tài khoản nhắn tin của workspace, bất kể tin về qua đường nào:
 *  · Facebook / Instagram nối THẲNG (`org_channel_pages`, connector `facebook-messenger`);
 *  · Fanpage qua Pancake (connector `pancake-fanpage`, một page mỗi tổ chức);
 *  · Zalo OA (connector `zalo-oa`).
 * Một page nối cả hai đường là MỘT dòng — đường nào đang nhận tin do `transportOwnerOf` (lib/sales-chatbot/channel-ownership.ts)
 * quyết, màn này CHỈ HIỂN THỊ kết luận đó, không có luật nhận tin thứ hai.
 *
 * Sức khoẻ có ĐÚNG ba mức cho khách — Sẵn sàng · Cần xử lý · Mất kết nối — và mỗi mức khác «Sẵn sàng» luôn đi kèm MỘT việc phải
 * làm bằng lời thường. «Sẵn sàng» đòi CHỨNG CỨ (kiểm tra đạt, hoặc đã có tin về sau lỗi gần nhất): page chưa từng kiểm, chưa
 * từng nhận tin là CHƯA BIẾT, không được in thành khoẻ (AGENTS mục 42 · 52).
 *
 * Câu khách không bao giờ chứa thuật ngữ kỹ thuật (`CUSTOMER_FORBIDDEN_TERMS`, kiểm thử quét chuỗi); chi tiết kỹ thuật chỉ đi
 * ra cho người vận hành nền tảng (lớp đọc máy chủ lib/channels/overview.ts dựng `technical` khi và chỉ khi người xem là họ).
 *
 * Tệp này chỉ `import type` từ máy chủ + giá trị từ hai tệp câu chữ thuần — không kéo mã máy chủ vào gói client.
 */
import { CUSTOMER_GRAPH_ERROR_TEXT, type GraphErrorKind } from "@/lib/integrations/messenger/graph-errors";
import type { DiscoveryReason, WebhookState } from "@/lib/integrations/messenger/graph";
import { CUSTOMER_WEBHOOK_TEXT, customerDiscoveryIssue, type CustomerIssue } from "@/lib/integrations/messenger/permission-guide";

/** Route của màn — luồng điều hướng (menu) trỏ vào hằng này, không gõ lại chuỗi. */
export const CHANNELS_ROUTE = "/ai/channels";
/**
 * Cookie đánh dấu «lượt kết nối Facebook bắt đầu từ màn Kênh kết nối» — callback OAuth (không đổi) vẫn quay về trang Messenger
 * như cũ; trang đó thấy cookie thì chuyển tiếp nguyên tham số sang đây. Không mang dữ liệu nào ngoài cờ `1`.
 */
export const CHANNELS_RETURN_COOKIE = "erp_channels_return";
export const CHANNELS_RETURN_TTL_SEC = 15 * 60;
/** Tham số callback mà màn này hiểu (đúng bộ trang Messenger đang đọc). */
export const CONNECT_RESULT_PARAMS = ["chon", "ok", "loi", "lydo", "ct", "msg", "webhook"] as const;

export type ChannelPlatform = "FACEBOOK" | "INSTAGRAM" | "ZALO";
/** Đường đang nhận tin của page — `null` = không đường nào (đã gỡ / chưa bật). */
export type ChannelOwner = "MESSENGER" | "PANCAKE" | "ZALO";
export type ChannelHealthLevel = "READY" | "NEEDS_ACTION" | "DISCONNECTED";

export const CHANNEL_HEALTH_LABEL: Record<ChannelHealthLevel, string> = { READY: "Sẵn sàng", NEEDS_ACTION: "Cần xử lý", DISCONNECTED: "Mất kết nối" };
export const CHANNEL_OWNER_LABEL: Record<ChannelOwner, string> = { MESSENGER: "Facebook trực tiếp", PANCAKE: "Qua Pancake", ZALO: "Zalo OA" };
export const CHANNEL_PLATFORM_LABEL: Record<ChannelPlatform, string> = { FACEBOOK: "Facebook", INSTAGRAM: "Instagram", ZALO: "Zalo" };
const SEVERITY: Record<ChannelHealthLevel, number> = { DISCONNECTED: 0, NEEDS_ACTION: 1, READY: 2 };

/** Sự thật của một page nối thẳng (một hàng `org_channel_pages` hoặc page của hàng kết nối đơn cũ). Không bí mật nào. */
export type DirectFacts = {
  status: "ACTIVE" | "DISABLED";
  kind: "PAGE" | "INSTAGRAM";
  parentPageId: string | null;
  aiEnabled: boolean;
  lastEventAt: string | null;
  lastErrorAt: string | null;
  /** Loại lỗi đọc lại từ câu đã lưu (`graphErrorKindOfText`) — `null` = không có lỗi HOẶC không nhận ra loại. */
  errorKind: GraphErrorKind | null;
  hasError: boolean;
  legacy: boolean;
};

/** Sự thật của một kết nối một-page (Pancake · Zalo) — đọc từ `org_connections`, không bí mật. */
export type ConnectionFacts = { status: "DRAFT" | "ACTIVE" | "DISABLED"; lastTestOk: boolean | null; lastActivityAt: string | null };

/** Kết quả kiểm «page có đang gửi tin về không» gần nhất (chỉ đọc ở Facebook). */
export type WebhookFact = { state: WebhookState; at: string | null };

export type ChannelRowFacts = {
  /** Khoá dòng: mã page Facebook / Instagram; Zalo mang tiền tố `zalo:` để không bao giờ trùng mã page Facebook. */
  key: string;
  pageId: string;
  name: string;
  platform: ChannelPlatform;
  owner: ChannelOwner | null;
  direct: DirectFacts | null;
  pancake: ConnectionFacts | null;
  zalo: ConnectionFacts | null;
};

export type ChannelHealth = { level: ChannelHealthLevel; issue: CustomerIssue | null; note: string | null };

// ─────────────────────────── Gộp hai nguồn thành một danh sách ───────────────────────────

export type DirectPageInput = { id: string; name: string } & DirectFacts;

/**
 * Gộp page nối thẳng + page Pancake + Zalo OA thành danh sách MỘT DÒNG MỖI PAGE. Page có ở cả hai đường ⇒ một dòng mang cả hai
 * bộ sự thật; tên lấy từ đường nối thẳng (Pancake không lưu tên page). `ownerOf` là `transportOwnerOf` của channel-ownership.ts
 * (truyền vào để tệp này không kéo mã máy chủ). HÀM THUẦN.
 */
export function mergeChannelSources(input: {
  direct: readonly DirectPageInput[];
  pancake: { pageId: string; facts: ConnectionFacts } | null;
  zalo: { oaId: string; facts: ConnectionFacts } | null;
  ownerOf: (pageId: string) => "MESSENGER" | "PANCAKE" | null;
}): ChannelRowFacts[] {
  const rows = new Map<string, ChannelRowFacts>();
  for (const d of input.direct) {
    const id = d.id.trim();
    if (!id || rows.has(id)) continue;
    const facts: DirectFacts = { status: d.status, kind: d.kind, parentPageId: d.parentPageId, aiEnabled: d.aiEnabled, lastEventAt: d.lastEventAt, lastErrorAt: d.lastErrorAt, errorKind: d.errorKind, hasError: d.hasError, legacy: d.legacy };
    rows.set(id, { key: id, pageId: id, name: d.name.trim() || id, platform: d.kind === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK", owner: null, direct: facts, pancake: null, zalo: null });
  }
  const pid = input.pancake?.pageId.trim() ?? "";
  if (input.pancake && pid) {
    const had = rows.get(pid);
    if (had) had.pancake = input.pancake.facts;
    else rows.set(pid, { key: pid, pageId: pid, name: `Fanpage ${pid}`, platform: "FACEBOOK", owner: null, direct: null, pancake: input.pancake.facts, zalo: null });
  }
  const oa = input.zalo?.oaId.trim() ?? "";
  if (input.zalo && oa) {
    const key = `zalo:${oa}`;
    rows.set(key, { key, pageId: oa, name: `Zalo OA ${oa}`, platform: "ZALO", owner: input.zalo.facts.status === "ACTIVE" ? "ZALO" : null, direct: null, pancake: null, zalo: input.zalo.facts });
  }
  for (const r of rows.values()) if (r.platform !== "ZALO") r.owner = input.ownerOf(r.pageId);
  return [...rows.values()];
}

// ─────────────────────────── Sức khoẻ ba mức ───────────────────────────

const after = (a: string | null, b: string | null): boolean => Boolean(a) && (!b || a! > b);
const sameOrAfter = (a: string | null, b: string | null): boolean => !b || (Boolean(a) && a! >= b);

const PLATFORM_DOWN: CustomerIssue = { title: "Kết nối Facebook của nền tảng đang được bảo trì", action: "Không phải lỗi ở Page của bạn — liên hệ đội hỗ trợ nếu kéo dài quá vài giờ.", who: "SUPPORT" };

/** Lỗi gửi / đọc của Facebook ⇒ câu khách; mọi loại đều là việc chủ shop làm được (nối lại / kiểm lại / không cần làm gì). */
const graphIssue = (k: GraphErrorKind): CustomerIssue => ({ ...CUSTOMER_GRAPH_ERROR_TEXT[k], who: "SHOP" });

function connectionHealth(c: ConnectionFacts, via: "Pancake" | "Zalo OA"): ChannelHealth {
  const where = via === "Pancake" ? "Mở Cài đặt → Kết nối, dòng «Fanpage qua Pancake»" : "Mở Cài đặt → Kết nối, dòng «Zalo OA»";
  if (c.status === "DISABLED") return { level: "DISCONNECTED", issue: { title: `Kết nối qua ${via} đang tắt`, action: `${where} và bật lại nếu muốn dùng.`, who: "SHOP" }, note: null };
  if (c.status === "DRAFT") return { level: "NEEDS_ACTION", issue: { title: `Kết nối qua ${via} chưa bật`, action: `${where}, bấm «Kiểm tra» rồi «Bật».`, who: "SHOP" }, note: null };
  if (c.lastTestOk === false) return { level: "NEEDS_ACTION", issue: { title: `Lần kiểm tra gần nhất của kết nối qua ${via} không đạt`, action: `${where}, bấm «Kiểm tra».`, who: "SHOP" }, note: null };
  return { level: "READY", issue: null, note: null };
}

function directHealth(d: DirectFacts, webhook: WebhookFact | null, appReady: boolean): ChannelHealth {
  if (d.status === "DISABLED") return { level: "DISCONNECTED", issue: { title: "Bạn đã gỡ Page này khỏi ERP", action: "Bấm «Kết nối Facebook» và chọn lại Page nếu muốn dùng.", who: "SHOP" }, note: null };
  if (!appReady) return { level: "NEEDS_ACTION", issue: PLATFORM_DOWN, note: null };
  const evt = d.lastEventAt;
  // Kết quả kiểm chỉ còn giá trị khi KHÔNG có tin nào về sau nó — tin về sau là chứng cứ mạnh hơn.
  const wh = d.kind === "PAGE" && webhook && webhook.state !== "OK" && webhook.state !== "UNKNOWN" && sameOrAfter(webhook.at, evt) ? webhook.state : null;
  if (wh === "TOKEN_EXPIRED" || wh === "NOT_SUBSCRIBED") return { level: "DISCONNECTED", issue: CUSTOMER_WEBHOOK_TEXT[wh], note: null };
  const errFresh = d.hasError && after(d.lastErrorAt, evt);
  if (errFresh && (d.errorKind === "TOKEN" || d.errorKind === "PERMISSION")) return { level: "DISCONNECTED", issue: graphIssue(d.errorKind), note: null };
  if (wh === "MISSING_FIELDS") return { level: "NEEDS_ACTION", issue: CUSTOMER_WEBHOOK_TEXT.MISSING_FIELDS, note: null };
  // Ngoài 24 giờ / khách chặn page / chạm trần: MỘT tin không gửi được, kết nối KHÔNG hỏng (graph-errors.ts) ⇒ không hạ mức.
  if (errFresh && (d.errorKind === null || d.errorKind === "OTHER")) return { level: "NEEDS_ACTION", issue: graphIssue("OTHER"), note: null };
  if (evt || (d.kind === "PAGE" && webhook?.state === "OK")) return { level: "READY", issue: null, note: null };
  return {
    level: "NEEDS_ACTION",
    issue: d.kind === "INSTAGRAM" ? { title: "Chưa nhận tin Instagram nào", action: "Nhắn thử một tin vào Instagram của shop để kiểm tra.", who: "SHOP" } : { title: "Chưa nhận tin nhắn nào qua Page", action: "Nhắn thử một tin vào Page, hoặc bấm «Kiểm tra lại».", who: "SHOP" },
    note: null,
  };
}

/**
 * Sức khoẻ ba mức của MỘT dòng, theo ĐÚNG đường đang nhận tin. Không đường nào nhận ⇒ lấy lý do của đường đang có (đã gỡ /
 * chưa bật / đang tắt). HÀM THUẦN — màn hình gọi lại sau «Kiểm tra lại» mà không cần hỏi máy chủ thêm.
 */
export function channelHealth(row: ChannelRowFacts, webhook: WebhookFact | null, appReady: boolean): ChannelHealth {
  let h: ChannelHealth;
  if (row.owner === "ZALO" && row.zalo) h = connectionHealth(row.zalo, "Zalo OA");
  else if (row.owner === "PANCAKE" && row.pancake) h = connectionHealth(row.pancake, "Pancake");
  else if (row.owner === "MESSENGER" && row.direct) h = directHealth(row.direct, webhook, appReady);
  else {
    const options = [row.direct ? directHealth(row.direct, webhook, appReady) : null, row.pancake ? connectionHealth(row.pancake, "Pancake") : null, row.zalo ? connectionHealth(row.zalo, "Zalo OA") : null].filter((x): x is ChannelHealth => x !== null);
    // Không đường nào đang nhận ⇒ không bao giờ «Sẵn sàng», kể cả khi một bộ sự thật lẻ trông ổn.
    const best = options.sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level])[0];
    h = best && best.level !== "READY" ? best : { level: "DISCONNECTED", issue: { title: "Page chưa nhận tin qua đường nào", action: "Bấm «Kết nối Facebook» để nối Page.", who: "SHOP" }, note: null };
  }
  if (row.owner === "PANCAKE" && row.direct?.status === "ACTIVE") return { ...h, note: "Page cũng đã nối thẳng với Facebook — tin đang đi qua Pancake để khách không nhận hai câu trả lời." };
  return h;
}

/** Lần đồng bộ cuối theo ĐÚNG đường đang nhận tin; không đường nào ⇒ mốc mới nhất đang có. `null` = chưa từng (không phải 0). */
export function lastSyncOf(row: ChannelRowFacts): string | null {
  if (row.owner === "MESSENGER") return row.direct?.lastEventAt ?? null;
  if (row.owner === "PANCAKE") return row.pancake?.lastActivityAt ?? null;
  if (row.owner === "ZALO") return row.zalo?.lastActivityAt ?? null;
  const all = [row.direct?.lastEventAt, row.pancake?.lastActivityAt, row.zalo?.lastActivityAt].filter((x): x is string => Boolean(x)).sort();
  return all.at(-1) ?? null;
}

/** Trạng thái kết nối (khác sức khoẻ): page có đang được nối ở ERP không. */
export function connectionLabel(row: ChannelRowFacts): string {
  if (row.owner) return "Đã kết nối";
  if (row.direct?.status === "DISABLED" && !row.pancake && !row.zalo) return "Đã gỡ";
  const c = row.pancake ?? row.zalo;
  if (c?.status === "DRAFT") return "Chưa bật";
  if (c?.status === "DISABLED") return "Đang tắt";
  return "Chưa kết nối";
}

/**
 * Công tắc AI của dòng: page nối thẳng có công tắc RIÊNG (`setMessengerPagesAiAction`); Pancake / Zalo theo cấu hình chung của
 * Chatbot bán hàng (không có cờ theo page — không bịa ra một công tắc không làm gì).
 */
export function aiControlOf(row: ChannelRowFacts): { kind: "PAGE" | "GLOBAL"; on: boolean | null } {
  if (row.direct && row.direct.kind === "PAGE" && row.owner !== "PANCAKE") return { kind: "PAGE", on: row.direct.status === "ACTIVE" ? row.direct.aiEnabled : null };
  return { kind: "GLOBAL", on: null };
}

/** Ảnh đại diện CÔNG KHAI của page Facebook (không cần quyền); Instagram / Zalo / mã lạ ⇒ `null` (màn dùng chữ cái đầu). */
export function pageAvatarUrl(row: Pick<ChannelRowFacts, "platform" | "pageId">): string | null {
  return row.platform === "FACEBOOK" && /^\d{5,30}$/.test(row.pageId) ? `https://graph.facebook.com/${row.pageId}/picture?type=square&width=96&height=96` : null;
}

export function initialOf(name: string): string {
  const ch = name.trim().replace(/^(fanpage|zalo oa|instagram)\s+@?/i, "").charAt(0);
  return (ch || "?").toUpperCase();
}

/** Thứ tự: việc cần làm lên đầu (mất kết nối → cần xử lý → sẵn sàng), rồi theo tên. */
export function sortChannelRows<T extends { name: string; level: ChannelHealthLevel }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level] || a.name.localeCompare(b.name, "vi"));
}

// ─────────────────────────── Kết quả lượt kết nối (tham số callback) ───────────────────────────

const CONNECT_ERROR_TEXT: Record<string, CustomerIssue> = {
  quyen: { title: "Cần quyền quản trị cửa hàng để kết nối Page", action: "Nhờ chủ cửa hàng bấm «Kết nối Facebook».", who: "SHOP" },
  app: PLATFORM_DOWN,
  huy: { title: "Bạn đã dừng ở bước cấp quyền của Facebook", action: "Bấm «Kết nối Facebook» lại khi sẵn sàng.", who: "SHOP" },
  state: { title: "Phiên kết nối đã hết hạn", action: "Bấm «Kết nối Facebook» lại.", who: "SHOP" },
  khongpage: { title: "Chưa nối được Page nào", action: "Bấm «Kết nối lại» và tick đủ các Page cần dùng.", who: "SHOP" },
  fb: { title: "Facebook chưa cho kết nối lúc này", action: "Thử lại sau ít phút; nếu vẫn lỗi, liên hệ đội hỗ trợ.", who: "SHOP" },
};
const GENERIC_CONNECT_ERROR: CustomerIssue = { title: "Kết nối chưa xong", action: "Bấm «Kết nối Facebook» lại.", who: "SHOP" };

export type ConnectParams = Partial<Record<(typeof CONNECT_RESULT_PARAMS)[number], string>>;
export type StoredDiagnosticFacts = { reason?: string | null; missing?: unknown; withoutMessaging?: unknown } | null;

const isStrs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);

/**
 * Câu khách cho kết quả một lượt «Kết nối Facebook» (tham số callback + chẩn đoán đã lưu). `isReason` truyền vào để tệp này không
 * giữ bản sao danh sách lý do. Không bao giờ trả câu gốc của Facebook (`msg` / `ct`) — đó là chi tiết cho người vận hành.
 */
export function connectOutcome(p: ConnectParams, diag: StoredDiagnosticFacts, isReason: (x: string) => x is DiscoveryReason): { kind: "ERROR"; issue: CustomerIssue } | { kind: "PICK" } | { kind: "OK"; webhook: WebhookState | null } | null {
  if (p.loi) {
    const reason = p.lydo && isReason(p.lydo) ? p.lydo : diag?.reason && isReason(diag.reason) ? diag.reason : null;
    if (p.loi === "khongpage" && reason) {
      const pageNames = Array.isArray(diag?.withoutMessaging) ? (diag.withoutMessaging as unknown[]).map((x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? (x as { name: string }).name : "")).filter(Boolean) : [];
      return { kind: "ERROR", issue: customerDiscoveryIssue(reason, { missing: isStrs(diag?.missing), pageNames }) };
    }
    return { kind: "ERROR", issue: CONNECT_ERROR_TEXT[p.loi] ?? GENERIC_CONNECT_ERROR };
  }
  if (p.chon) return { kind: "PICK" };
  if (p.ok) {
    const w = p.webhook && p.webhook !== "OK" ? (p.webhook as WebhookState) : null;
    return { kind: "OK", webhook: w && w in CUSTOMER_WEBHOOK_TEXT ? w : null };
  }
  return null;
}

// ─────────────────────────── Từ cấm trên màn khách ───────────────────────────

/** Thuật ngữ kỹ thuật KHÔNG được xuất hiện trong câu khách (kiểm thử quét mọi câu của tệp này + hai tệp câu chữ Messenger). */
export const CUSTOMER_FORBIDDEN_TERMS: readonly RegExp[] = [/webhook/i, /token/i, /\bAPI\b/i, /verify/i, /oauth/i, /\bgraph\b/i, /app review/i, /app dashboard/i, /subscribed_apps/i, /\bpages_[a-z_]+/i, /stack/i, /\bHTTP\b/i, /access/i];

export function customerTextViolations(text: string): string[] {
  return CUSTOMER_FORBIDDEN_TERMS.filter((re) => re.test(text)).map((re) => re.source);
}

/**
 * ═══════════ KÊNH KẾT NỐI HỢP NHẤT — LỚP ĐỌC (CHỈ MÁY CHỦ, CHỈ ĐỌC) ═══════════
 *
 * Gom MỌI page nhắn tin của tổ chức NGỮ CẢNH thành một danh sách cho màn «Kênh kết nối» (luật ở overview-shared.ts):
 *  · page nối thẳng — `messengerView()` (org_channel_pages + page của hàng kết nối đơn cũ), đã lọc đúng mã tổ chức;
 *  · Fanpage qua Pancake + Zalo OA — `messagingConnectionSummaries()` (chỉ ô KHÔNG bí mật, đã lọc đúng mã tổ chức);
 *  · đường đang nhận tin — `loadTransportFacts()` + `transportOwnerOf()` (channel-ownership.ts, MỘT nguồn sự thật);
 *  · kiểm «page có gửi tin về không» gần nhất — `messenger.lastWebhookCheck` (callback / trang Messenger ghi, không token);
 *  · lần đồng bộ cuối của Pancake / Zalo — tin sống mới nhất của page trong `sales_chat_inbound` (14 ngày).
 * Không ghi gì, không gọi Facebook. Câu lỗi gốc chỉ đi ra trong `technical`, và `technical` chỉ có khi người xem là người vận
 * hành nền tảng (`viewer.operator`).
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { messagingConnectionSummaries } from "@/lib/connectors/service";
import { WEBHOOK_STATES, messengerApp, type WebhookState } from "@/lib/integrations/messenger/graph";
import { graphErrorKindOfText } from "@/lib/integrations/messenger/graph-errors";
import { WEBHOOK_LABEL } from "@/lib/integrations/messenger/permission-guide";
import { currentOrganization } from "@/lib/platform/context";
import { getSettingJson } from "@/lib/settings";
import { MESSENGER_DIRECT_KEY, PANCAKE_FANPAGE_KEY, loadTransportFacts, transportOwnerOf } from "@/lib/sales-chatbot/channel-ownership";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { messengerView } from "@/lib/sales-chatbot/messenger";
import { zaloPageKey } from "@/lib/sales-chatbot/zalo";
import { mergeChannelSources, type ChannelRowFacts, type ConnectionFacts, type WebhookFact } from "@/lib/channels/overview-shared";

export const ZALO_OA_KEY = "zalo-oa";
export const WEBHOOK_CHECK_SETTING_KEY = "messenger.lastWebhookCheck";
const ACTIVITY_WINDOW_DAYS = 14;

export type ChannelRowView = ChannelRowFacts & {
  /** Kết quả kiểm đã lưu của page (nếu có) — màn tính lại sức khoẻ sau «Kiểm tra lại». */
  webhook: WebhookFact | null;
  /** Chi tiết kỹ thuật — CHỈ người vận hành nền tảng; khách luôn `null`. */
  technical: string[] | null;
};

export type ChannelsOverview = {
  orgCode: string;
  /** App Facebook của nền tảng đã cấu hình chưa — chưa thì page nối thẳng không làm gì được, và đó không phải việc của khách. */
  appReady: boolean;
  /** Chatbot bán hàng đang bật ở cấu hình chung (tắt ⇒ công tắc theo page không có tác dụng). */
  botEnabled: boolean;
  rows: ChannelRowView[];
};

type StoredWebhookCheck = { at?: unknown; pages?: unknown };

const isWebhookState = (x: unknown): x is WebhookState => typeof x === "string" && (WEBHOOK_STATES as readonly string[]).includes(x);
const asConnStatus = (s: string): ConnectionFacts["status"] => (s === "ACTIVE" ? "ACTIVE" : s === "DISABLED" ? "DISABLED" : "DRAFT");

/** Kết quả kiểm đã lưu theo page (chỉ trạng thái + mốc; câu chi tiết giữ riêng cho người vận hành). */
function storedChecks(v: StoredWebhookCheck | null): Map<string, { state: WebhookState; at: string | null; detail: string | null; missing: string[] }> {
  const out = new Map<string, { state: WebhookState; at: string | null; detail: string | null; missing: string[] }>();
  const at = typeof v?.at === "string" ? v.at : null;
  for (const c of Array.isArray(v?.pages) ? (v.pages as unknown[]) : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as { pageId?: unknown; state?: unknown; detail?: unknown; missingFields?: unknown };
    if (typeof r.pageId !== "string" || !isWebhookState(r.state)) continue;
    out.set(r.pageId, { state: r.state, at, detail: typeof r.detail === "string" ? r.detail.slice(0, 300) : null, missing: Array.isArray(r.missingFields) ? r.missingFields.filter((x): x is string => typeof x === "string") : [] });
  }
  return out;
}

/** Tin SỐNG mới nhất của từng page (mọi chiều, không tính tin nhập lịch sử) — mốc «đồng bộ cuối» của Pancake / Zalo. */
async function lastActivity(pageIds: readonly string[], now: Date): Promise<Map<string, string>> {
  const ids = [...new Set(pageIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const t = schema.salesChatInbound;
  const rows = await (await getDb())
    .select({ pageId: t.pageId, last: sql<Date | string | null>`max(${t.createdAt})` })
    .from(t)
    .where(and(inArray(t.pageId, ids), isNull(t.importedAt), gte(t.createdAt, new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86_400_000))))
    .groupBy(t.pageId);
  return new Map(rows.filter((r) => r.pageId && r.last).map((r) => [r.pageId as string, new Date(r.last as string | Date).toISOString()]));
}

/** Nhật ký mà CHỈ lượt nối page (upsertChannelPage, kèm token mới) ghi — bật / tắt AI ghi hành động khác. */
export const PAGE_CONNECT_AUDIT_ACTION = "ORG_CHANNEL_PAGE_CONNECT";

/**
 * Mốc NỐI LẠI THẬT gần nhất của từng page nối thẳng — đọc nhật ký, không đọc `updated_at` (bật / tắt AI cũng đẩy mốc đó).
 * Nhật ký ghi hỏng thì page không có mốc ⇒ kiểm hỏng giữ nguyên: lỗi rơi về phía «Mất kết nối», không về phía «Sẵn sàng».
 */
async function lastConnectAt(pageIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(pageIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const a = schema.auditLogs;
  const rows = await (await getDb())
    .select({ entityId: a.entityId, last: sql<Date | string | null>`max(${a.createdAt})` })
    .from(a)
    .where(and(eq(a.action, PAGE_CONNECT_AUDIT_ACTION), inArray(a.entityId, ids.map((id) => `${MESSENGER_DIRECT_KEY}:${id}`))))
    .groupBy(a.entityId);
  return new Map(rows.filter((r) => r.last).map((r) => [r.entityId.slice(MESSENGER_DIRECT_KEY.length + 1), new Date(r.last as string | Date).toISOString()]));
}

export async function loadChannelsOverview(viewer: { operator: boolean }, now: Date = new Date()): Promise<ChannelsOverview> {
  const org = await currentOrganization();
  const [view, facts, conns, whStored, cfg] = await Promise.all([
    messengerView(),
    loadTransportFacts(),
    messagingConnectionSummaries([PANCAKE_FANPAGE_KEY, ZALO_OA_KEY]),
    getSettingJson<StoredWebhookCheck | null>(WEBHOOK_CHECK_SETTING_KEY, null),
    loadSalesChatbotConfig(),
  ]);
  const connectedAt = await lastConnectAt(view.pages.map((p) => p.id));
  const pancakeConn = conns.find((c) => c.connectorKey === PANCAKE_FANPAGE_KEY) ?? null;
  const zaloConn = conns.find((c) => c.connectorKey === ZALO_OA_KEY) ?? null;
  const pancakePageId = (pancakeConn?.plainSettings.pageId ?? "").trim();
  const zaloOaId = (zaloConn?.plainSettings.oaId ?? "").trim();
  const activity = await lastActivity([pancakePageId, zaloOaId ? zaloPageKey(zaloOaId) : ""], now);
  const rawError = new Map(view.pages.map((p) => [p.id, p.lastError]));

  const merged = mergeChannelSources({
    direct: view.pages.map((p) => ({ id: p.id, name: p.name, status: p.status, kind: p.kind, parentPageId: p.parentPageId, aiEnabled: p.aiEnabled, lastEventAt: p.lastEventAt, lastErrorAt: p.lastErrorAt, errorKind: graphErrorKindOfText(p.lastError), hasError: Boolean(p.lastErrorAt), legacy: p.legacy, connectedAt: connectedAt.get(p.id) ?? null })),
    pancake: pancakeConn && pancakePageId ? { pageId: pancakePageId, facts: { status: asConnStatus(pancakeConn.status), lastTestOk: pancakeConn.lastTestOk, lastActivityAt: activity.get(pancakePageId) ?? null } } : null,
    zalo: zaloConn && zaloOaId ? { oaId: zaloOaId, facts: { status: asConnStatus(zaloConn.status), lastTestOk: zaloConn.lastTestOk, lastActivityAt: activity.get(zaloPageKey(zaloOaId)) ?? null } } : null,
    ownerOf: (id) => transportOwnerOf(facts, id),
  });

  const checks = storedChecks(whStored);
  const rows: ChannelRowView[] = merged.map((r) => {
    const c = r.platform === "FACEBOOK" ? (checks.get(r.pageId) ?? null) : null;
    const webhook: WebhookFact | null = c ? { state: c.state, at: c.at } : null;
    let technical: string[] | null = null;
    if (viewer.operator) {
      technical = [];
      if (c) technical.push(`Webhook (${c.at ?? "?"}): ${c.state === "MISSING_FIELDS" ? `${WEBHOOK_LABEL.MISSING_FIELDS}: ${c.missing.join(", ")}` : WEBHOOK_LABEL[c.state]}${c.detail ? ` — ${c.detail}` : ""}`);
      const err = rawError.get(r.pageId);
      if (r.direct && err) technical.push(`last_error (${r.direct.lastErrorAt ?? "?"}, loại ${r.direct.errorKind ?? "không nhận ra"}): ${err.slice(0, 300)}`);
      if (r.direct?.legacy) technical.push("Page của hàng kết nối đơn cũ (trước 0220) — token đọc ở org_connections.");
      if (r.pancake) technical.push(`${PANCAKE_FANPAGE_KEY}: status ${r.pancake.status} · last_test_ok ${String(r.pancake.lastTestOk)}${pancakeConn?.lastTestMessage ? ` — ${pancakeConn.lastTestMessage.slice(0, 200)}` : ""}`);
      if (r.zalo) technical.push(`${ZALO_OA_KEY}: status ${r.zalo.status} · last_test_ok ${String(r.zalo.lastTestOk)}${zaloConn?.lastTestMessage ? ` — ${zaloConn.lastTestMessage.slice(0, 200)}` : ""}`);
      technical.push(`transportOwnerOf = ${r.owner ?? "null"} · org ${org.code}`);
    }
    return { ...r, webhook, technical };
  });

  return { orgCode: org.code, appReady: messengerApp() !== null, botEnabled: cfg.enabled === true, rows };
}

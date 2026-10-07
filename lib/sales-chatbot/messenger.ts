import { noteAiCustomerReply } from "@/lib/pricing/ai-customer";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/session";
import { adoptLegacyChannelPages, disableChannelPages, listChannelPages, messagingConnectionSummaries, noteChannelPageHealth, openActiveConnection, openChannelPageToken, saveConnection, setChannelPagesState, setConnectionStatus, testOrgConnection, upsertChannelPage } from "@/lib/connectors/service";
import type { TesterDeps } from "@/lib/connectors/testers";
import { appSecretProof, graphBase, instagramAccountOf, messengerApp, messengerBotAppIds, postMessage, sendMessengerImage, sendMessengerText, sendPrivateReply, subscribePage, unsubscribePage, MESSENGER_TEXT_MAX, type ConnectablePage, type MessengerEvent } from "@/lib/integrations/messenger/graph";
import { chunkText } from "@/lib/messaging/providers";
import { canUseModule } from "@/lib/platform/capabilities";
import { AI_DOWN_HANDOFF_REASON, chatTurn, conversationView, describeCustomerImages } from "@/lib/sales-chatbot/engine";
import { ALREADY_REPLIED_NOTE, alreadyRepliedRows, CONV_OPEN_FAILED_NOTE, EMPTY_REPLY_NOTE, HANDOFF_SILENT_NOTE, DEAD_AI_DOWN_NOTE, DEAD_SEND_NOTE_PREFIX, deadLetter, dueForClaim, releaseWithBackoff } from "@/lib/sales-chatbot/inbound-retry";
import { clearPageMode, dualConnectedPages, DUPLICATE_SOURCE_REASON, insertCustomerInbound, liveTransportsOf, loadTransportFacts, NON_CANONICAL_NOTE, PANCAKE_OWNS_PAGE_REASON, recordPageMode, routeVerdict, threadTransport, transportOwnerOf, type RouteVerdict } from "@/lib/sales-chatbot/channel-ownership";
import {
  CLAIM_STALE_MS,
  conversationFor,
  COPILOT_NOTE,
  erpStaffEchoCond,
  fanpageVisitorKey,
  FIRST_CONTACT_LOOKBACK_MS,
  FIRST_CONTACT_WAIT_MS,
  FOLLOWUP_WAIT_MS,
  GRACE_SLACK_MS,
  markWaitingForCustomer,
  MEDIA_ONLY_NOTE,
  MEDIA_ONLY_TEXT,
  normalizeEcho,
  noteCustomerArrived,
  noteCustomerAd,
  mirrorFanpageContext,
  OBSERVE_HUMAN_ARM_NOTE,
  OBSERVE_NOTE,
  PAGE_REPLIED_REASON,
  PAGE_REPLY,
  postContextPrompt,
  RETRY_MS,
  sendFanpageImages,
  sendFanpageText,
  STAFF_IMAGE_MARK,
  pageSideIsStaffCond,
  STAFF_OUT_PREFIX,
  STAFF_REASON,
  staffOutRowId,
  stopFollowups,
  WAITING,
  type FanpageDeps,
  type ProcessResult,
  type ReceiveResult,
  type StaffMark,
} from "@/lib/sales-chatbot/fanpage";
import { draftCopilotSuggestion, loadModeConfig, pinArm } from "@/lib/sales-chatbot/operating-mode";
import { readQuickReplyImage } from "@/lib/sales-chatbot/quick-replies";
import { readPinnedArm, replyGate } from "@/lib/sales-chatbot/operating-mode-shared";
import { applyConversationControl, controlOf, controlSkipNote } from "@/lib/sales-chatbot/conversation-control-shared";
import { botMaySend, captureSendSnapshot, holdGate, startHumanCooldown } from "@/lib/sales-chatbot/conversation-control";
import { noteMessengerGraphFailure } from "@/lib/sales-chatbot/messenger-health";
import { botSendAllowed, inboundPageGate } from "@/lib/sales-chatbot/page-runtime";
import { PAGE_NOT_LIVE_SEND_ERROR } from "@/lib/sales-chatbot/page-runtime-shared";

/**
 * ═══════════ MESSENGER TRỰC TIẾP — BOT FANPAGE KHÔNG CẦN PANCAKE (0207 · docs/platform/messenger.md) ═══════════
 *
 * Cùng con bot, cùng hàng chờ (`sales_chat_inbound`), cùng hội thoại kênh `FANPAGE` (khoá = băm(page, PSID)) với đường
 * Pancake — chỉ khác ĐƯỜNG VÀO (webhook của Meta, xác thực bằng chữ ký app) và ĐƯỜNG RA (Send API). Mọi luật của lượt trả lời
 * giữ nguyên: đợi khách gõ xong, tin đầu đợi xem Meta có tự trả lời không, nhân viên trả lời ⇒ bot nhường 30 phút, chuyển
 * người ⇒ bot im, đọc ảnh, follow-up.
 *
 * Phân biệt người gửi KHÔNG phải đoán như với Pancake: Meta gửi «tiếng vọng» (`is_echo`) cho MỌI tin page gửi đi, kèm `app_id`
 * của app đã gửi. `app_id` = app của nền tảng ⇒ tin của chính bot. Khác ⇒ người (Hộp thư Meta Business Suite) hoặc trả lời
 * tự động của Meta.
 */

export const MESSENGER_CONNECTOR = "facebook-messenger";

const TEXT_MAX = 2000;

/**
 * Mã mà kết nối đang bật «sở hữu»: page (Messenger) và — nếu page gắn tài khoản Instagram doanh nghiệp — mã Instagram (DM).
 * Hai kênh dùng CÙNG page token và CÙNG Send API; hội thoại tách theo (mã, người gửi).
 */
function ownedIds(settings: Record<string, string>): string[] {
  return [settings.pageId, settings.igAccountId].map((x) => (x ?? "").trim()).filter(Boolean);
}

/**
 * NHIỀU PAGE (0220 · org_channel_pages): mỗi page đã nối một hàng, token riêng. Tổ chức nối từ TRƯỚC bản này chưa có hàng nào
 * ⇒ page của hàng kết nối đơn (page + Instagram gắn với nó) vẫn được coi là đã nối — không backfill, không đổi hành vi.
 */
export async function messengerOwnedPageIds(): Promise<string[]> {
  const rows = await listChannelPages(MESSENGER_CONNECTOR);
  const active = rows.filter((r) => r.status === "ACTIVE").map((r) => r.pageId);
  const known = new Set(rows.map((r) => r.pageId));
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  const legacy = conn.ok ? ownedIds(conn.settings).filter((id) => !known.has(id)) : [];
  return [...new Set([...active, ...legacy])];
}

/** Token gửi tin của ĐÚNG page. Hàng page có ⇒ token của hàng (page tắt ⇒ không gửi); chưa có hàng ⇒ hàng kết nối đơn cũ. */
export async function messengerTokenFor(pageId: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const own = await openChannelPageToken(MESSENGER_CONNECTOR, pageId);
  if (own.ok) return own;
  if (own.known) return { ok: false, error: `Kết nối Messenger chưa bật / khác page (${own.reason})` };
  const conn = await openActiveConnection(MESSENGER_CONNECTOR);
  if (!conn.ok || !ownedIds(conn.settings).includes(pageId)) return { ok: false, error: "Kết nối Messenger chưa bật / khác page" };
  const token = (conn.secrets.pageAccessToken ?? "").trim();
  return token ? { ok: true, token } : { ok: false, error: "Kết nối Messenger chưa có token" };
}

/** AI có được trả lời trên page này không (bật / tắt AI theo page). Page cũ chưa có hàng ⇒ bật như trước. */
export async function messengerPageAiOn(pageId: string): Promise<boolean> {
  const row = (await listChannelPages(MESSENGER_CONNECTOR)).find((r) => r.pageId === pageId);
  return row ? row.aiEnabled : true;
}

export const PAGE_AI_OFF_NOTE = "AI đang tắt cho page này — nhân viên trả lời ở Hộp thư";

// ─────────────────────────── Nối / gỡ page ───────────────────────────

export type MessengerConnectResult = { ok: true; message: string } | { error: string };

export type MessengerPagesResult = { ok: true; message: string; connected: string[]; failed: { id: string; name: string; error: string }[] } | { error: string };

/**
 * Nối MỘT HAY NHIỀU page vừa cấp quyền (0220): mỗi page một hàng `org_channel_pages` (token mã hoá riêng) + một dòng chỉ mục
 * webhook ở nền tảng. Page này hỏng (thuộc cửa hàng khác · đang chạy qua Pancake · Meta từ chối đăng ký) KHÔNG chặn page kia.
 * Không còn xoá chỉ mục của page đã nối trước — nối thêm page là THÊM. Hàng kết nối đơn (`org_connections`) vẫn được dựng một
 * lần ở page đầu tiên: nó là «nhà cung cấp đã bật» mà trang Kết nối, bộ kiểm và các màn khác đọc.
 */
export async function connectMessengerPages(user: SessionUser, pages: readonly ConnectablePage[], deps: { fetch?: typeof fetch; tester?: TesterDeps } = {}): Promise<MessengerPagesResult> {
  const orgCode = user.organization?.code;
  if (!orgCode) return { error: "Phiên không mang tổ chức." };
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật — bật ở Cài đặt → Module." };
  const app = messengerApp();
  if (!app) return { error: "Nền tảng chưa cấu hình app Facebook — báo người vận hành." };
  if (!pages.length) return { error: "Chưa chọn page nào." };
  const fetchImpl = deps.fetch ?? fetch;
  const pdb = await getPlatformDb();
  const idx = schema.platformMessengerPages;
  const facts = await loadTransportFacts();
  const connected: string[] = [];
  const failed: { id: string; name: string; error: string }[] = [];
  const notes: string[] = [];
  let providerReady = (await openActiveConnection(MESSENGER_CONNECTOR)).ok;
  for (const page of pages) {
    const label = page.name || page.id;
    const fail = (error: string) => failed.push({ id: page.id, name: page.name, error });
    if (!/^\d{5,30}$/.test(page.id) || !page.token) {
      fail("Page không hợp lệ.");
      continue;
    }
    const [owner] = await pdb.select({ orgCode: idx.orgCode }).from(idx).where(eq(idx.pageId, page.id)).limit(1);
    if (owner && owner.orgCode !== orgCode) {
      fail(`Page «${label}» đang nối với một cửa hàng khác trên nền tảng. Gỡ ở cửa hàng đó trước, hoặc liên hệ hỗ trợ.`);
      continue;
    }
    // MỘT PAGE — MỘT ĐƯỜNG (channel-ownership.ts): page đang chạy qua Pancake ⇒ không nối thêm đường thứ hai.
    if (transportOwnerOf(facts, page.id) === "PANCAKE") {
      fail(`Page «${label}» đang nhận tin qua Pancake. Mỗi page chỉ nhận tin qua MỘT đường để khách không nhận hai câu trả lời — gỡ «Fanpage qua Pancake» ở Cài đặt → Kết nối rồi nối lại, hoặc giữ Pancake.`);
      continue;
    }
    // Instagram doanh nghiệp gắn với page (nếu có và chưa thuộc tổ chức khác) — nối cùng lượt, cùng token.
    const ig = await instagramAccountOf(app, page.id, page.token, fetchImpl);
    const [igOwner] = ig ? await pdb.select({ orgCode: idx.orgCode }).from(idx).where(eq(idx.pageId, ig.id)).limit(1) : [];
    const igOk = ig && (!igOwner || igOwner.orgCode === orgCode) ? ig : null;
    if (!providerReady) {
      const saved = await saveConnection(user, {
        connectorKey: MESSENGER_CONNECTOR,
        settings: { pageId: page.id, pageName: page.name.slice(0, 120), igAccountId: igOk?.id ?? "", igUsername: igOk?.username ?? "" },
        secrets: { pageAccessToken: page.token },
      });
      if ("error" in saved) {
        fail(saved.error);
        continue;
      }
    }
    const sub = await subscribePage(app, page.id, page.token, fetchImpl);
    if (!sub.ok) {
      fail(`Chưa đăng ký nhận tin cho page: ${sub.error}`);
      continue;
    }
    if (!providerReady) {
      const tested = await testOrgConnection(user, MESSENGER_CONNECTOR, deps.tester ? { tester: deps.tester } : deps.fetch ? { tester: { fetch: deps.fetch } } : {});
      if ("error" in tested) {
        fail(`Kiểm tra chưa đạt: ${tested.error}`);
        continue;
      }
      const on = await setConnectionStatus(user, MESSENGER_CONNECTOR, "ACTIVE");
      if ("error" in on) {
        fail(on.error);
        continue;
      }
      providerReady = true;
    }
    const savedPage = await upsertChannelPage(user, { connectorKey: MESSENGER_CONNECTOR, pageId: page.id, kind: "PAGE", parentPageId: null, name: page.name, token: page.token });
    if ("error" in savedPage) {
      fail(savedPage.error);
      continue;
    }
    if (igOk) await upsertChannelPage(user, { connectorKey: MESSENGER_CONNECTOR, pageId: igOk.id, kind: "INSTAGRAM", parentPageId: page.id, name: `Instagram @${igOk.username}`, token: page.token });
    const indexed: [string, string][] = [[page.id, page.name], ...(igOk ? ([[igOk.id, `Instagram @${igOk.username}`]] as [string, string][]) : [])];
    for (const [id, name] of indexed) {
      await pdb
        .insert(idx)
        .values({ pageId: id, orgCode, pageName: name.slice(0, 120), connectedByEmail: user.email })
        .onConflictDoUpdate({ target: idx.pageId, set: { pageName: name.slice(0, 120), connectedByEmail: user.email, updatedAt: new Date() }, where: eq(idx.orgCode, orgCode) });
    }
    connected.push(page.id);
    // PAGE MỚI ƯU TIÊN META TRỰC TIẾP (0233): Pancake không chạy page này ⇒ đường chính = Meta trực tiếp (nguồn CONNECT, người nối).
    // Pancake đang chạy page này thì đã bị từ chối ở trên — không bao giờ tới đây.
    for (const [id] of indexed) {
      if (liveTransportsOf(facts, id).PANCAKE || facts.modes?.[id] === "META_DIRECT") continue;
      const from = await recordPageMode(id, "META_DIRECT", "CONNECT", `Nối Meta trực tiếp cho page — Pancake không chạy page này (${user.name || user.email})`.slice(0, 300), user.id);
      await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHANNEL_MODE_SET", entity: "CHANNEL_PAGE", entityId: id, detail: { from: from ?? "NONE", to: "META_DIRECT", reason: "CONNECT" } });
    }
    if (igOk) notes.push(`Instagram @${igOk.username}`);
    else if (ig) notes.push(`Instagram @${ig.username} của «${label}» đang nối với cửa hàng khác — chưa nối`);
  }
  if (!connected.length) return { error: failed.map((f) => (pages.length > 1 ? `${f.name || f.id}: ${f.error}` : f.error)).join(" · ").slice(0, 600) || "Chưa nối được page nào." };
  const head = connected.length === 1 ? `Đã nối Messenger của page «${pages.find((p) => p.id === connected[0])?.name || connected[0]}»` : `Đã nối ${connected.length} page`;
  const igNote = notes.length ? ` và ${notes.join(" · ")}` : "";
  const failNote = failed.length ? ` — ${failed.length} page chưa nối: ${failed.map((f) => f.name || f.id).join(", ")}` : "";
  return { ok: true, message: `${head}${igNote}${failNote}. Nhắn thử một tin để thấy bot trả lời.`, connected, failed };
}

/** Nối MỘT page (đường cũ: lượt cấp quyền chỉ có một page). Cùng lõi với nối nhiều page. */
export async function connectMessengerPage(user: SessionUser, page: ConnectablePage, deps: { fetch?: typeof fetch; tester?: TesterDeps } = {}): Promise<MessengerConnectResult> {
  const r = await connectMessengerPages(user, [page], deps);
  if ("error" in r) return r;
  return r.failed.length ? { error: r.failed[0].error } : { ok: true, message: r.message };
}

/**
 * Gỡ. `pageId` có ⇒ gỡ ĐÚNG page đó (+ Instagram gắn với nó): hàng page về DISABLED, chỉ mục webhook của page ấy mất — các
 * page khác chạy tiếp. Không `pageId` ⇒ gỡ cả kết nối như trước. Token đã lưu giữ nguyên (mã hoá).
 */
/**
 * Gỡ đăng ký webhook ở Meta cho các PAGE (Instagram đi theo page cha) TRƯỚC khi gỡ phía ERP — lúc token còn đọc được. Hỏng (token đã
 * bị thu hồi…) KHÔNG chặn việc gỡ: chỉ mục mất ⇒ tin Meta còn gửi tới vẫn bị webhook bỏ qua, không rơi về tổ chức nào. Trả câu ghi
 * chú cho người bấm (`""` khi gỡ được hết).
 */
async function unsubscribeMetaPages(pageIds: readonly string[], fetchImpl: typeof fetch = fetch): Promise<string> {
  const app = messengerApp();
  if (!app) return "";
  const failed: string[] = [];
  for (const id of pageIds) {
    const tk = await messengerTokenFor(id);
    const r = tk.ok ? await unsubscribePage(app, id, tk.token, fetchImpl) : { ok: false as const };
    if (!r.ok) failed.push(id);
  }
  return failed.length ? ` Chưa gỡ được đăng ký webhook ở Facebook cho ${failed.length} page (token không còn dùng được) — tin của page đó vẫn bị bỏ qua.` : "";
}

export async function disconnectMessengerPage(user: SessionUser, pageId?: string, deps: { fetch?: typeof fetch } = {}): Promise<MessengerConnectResult> {
  const orgCode = user.organization?.code;
  if (!orgCode) return { error: "Phiên không mang tổ chức." };
  const pdb = await getPlatformDb();
  const idx = schema.platformMessengerPages;
  const view = await messengerView();
  if (pageId) {
    const target = view.pages.find((p) => p.id === pageId && p.kind === "PAGE");
    if (!target) return { error: "Không có page này trong các page đã nối." };
    const group = view.pages.filter((p) => p.id === pageId || p.parentPageId === pageId);
    const note = await unsubscribeMetaPages([pageId], deps.fetch);
    const off = await disableChannelPages(user, MESSENGER_CONNECTOR, group.map((p) => ({ pageId: p.id, kind: p.kind, parentPageId: p.parentPageId, name: p.name })));
    if ("error" in off) return off;
    await pdb.delete(idx).where(and(eq(idx.orgCode, orgCode), inArray(idx.pageId, group.map((p) => p.id))));
    const back = await handBackToPancake(user, group.map((p) => p.id));
    return { ok: true, message: `Đã gỡ page «${target.name || target.id}» — các page khác vẫn chạy.${back}${note}` };
  }
  const note = await unsubscribeMetaPages(view.pages.filter((p) => p.kind === "PAGE").map((p) => p.id), deps.fetch);
  const off = await setConnectionStatus(user, MESSENGER_CONNECTOR, "DISABLED");
  if ("error" in off) return { error: off.error };
  if (view.pages.length) await disableChannelPages(user, MESSENGER_CONNECTOR, view.pages.map((p) => ({ pageId: p.id, kind: p.kind, parentPageId: p.parentPageId, name: p.name })));
  await pdb.delete(idx).where(eq(idx.orgCode, orgCode));
  const back = await handBackToPancake(user, view.pages.map((p) => p.id));
  return { ok: true, message: `Đã gỡ Messenger trực tiếp — bot không nhận tin từ page qua đường này nữa.${back}${note}` };
}

/**
 * Người gỡ Meta trực tiếp của page mà Pancake ĐANG chạy page đó ⇒ đường chính về Pancake (0233) — hệ quả TƯỜNG MINH của chính thao
 * tác gỡ, có nhật ký; không có bước này page im lặng (đường chính đã lưu không chạy). Pancake không chạy ⇒ giữ nguyên dòng.
 */
async function handBackToPancake(user: SessionUser, pageIds: readonly string[]): Promise<string> {
  try {
    const facts = await loadTransportFacts();
    const moved: string[] = [];
    for (const id of pageIds) {
      if (facts.modes?.[id] !== "META_DIRECT") continue;
      if (!liveTransportsOf(facts, id).PANCAKE) {
        // Không còn đường nào chạy page ⇒ bỏ dòng canonical (về luật mặc định): nối Pancake sau này chạy ngay, không bị dòng cũ trỏ
        // vào đường đã gỡ làm AI im.
        if (await clearPageMode(id)) await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHANNEL_MODE_SET", entity: "CHANNEL_PAGE", entityId: id, detail: { from: "META_DIRECT", to: "DEFAULT", reason: "DISCONNECT_META_NO_ROUTE" } });
        continue;
      }
      await recordPageMode(id, "PANCAKE_WEBHOOK", "MANUAL", `Gỡ Meta trực tiếp — Pancake đang chạy page này nên đường chính về Pancake (${user.name || user.email})`.slice(0, 300), user.id);
      await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHANNEL_MODE_SET", entity: "CHANNEL_PAGE", entityId: id, detail: { from: "META_DIRECT", to: "PANCAKE_WEBHOOK", reason: "DISCONNECT_META" } });
      moved.push(id);
    }
    return moved.length ? ` Page ${moved.join(", ")} chuyển về nhận tin qua Pancake.` : "";
  } catch {
    return "";
  }
}

/** Bật / tắt AI cho NHIỀU page một lượt (thao tác hàng loạt; quyền kiểm ở lõi kết nối). Page đã gỡ không bật lại được ở đây. */
export async function setMessengerPagesAi(user: SessionUser, pageIds: readonly string[], aiEnabled: boolean): Promise<MessengerConnectResult> {
  const view = await messengerView();
  // Instagram gắn với page đi theo page của nó.
  const chosen = view.pages.filter((p) => (pageIds.includes(p.id) || (p.parentPageId !== null && pageIds.includes(p.parentPageId))) && p.status === "ACTIVE");
  if (!chosen.length) return { error: "Chưa chọn page đang nối nào." };
  // Page của hàng kết nối đơn cũ chưa có hàng riêng ⇒ dựng hàng (không token — token vẫn đọc ở hàng cũ) để mang được cờ AI.
  const legacy = chosen.filter((p) => p.legacy);
  if (legacy.length) {
    const made = await adoptLegacyChannelPages(user, MESSENGER_CONNECTOR, legacy.map((p) => ({ pageId: p.id, kind: p.kind, parentPageId: p.parentPageId, name: p.name })));
    if ("error" in made) return made;
  }
  const r = await setChannelPagesState(user, MESSENGER_CONNECTOR, chosen.map((p) => p.id), { aiEnabled });
  return "error" in r ? r : { ok: true, message: aiEnabled ? `Đã bật AI cho ${r.changed} page.` : `Đã tạm dừng AI ở ${r.changed} page — nhân viên trả lời ở Hộp thư.` };
}

// ─────────────────────────── Nhận tin (webhook) ───────────────────────────

/** Ghi MỘT sự kiện Messenger của tổ chức ngữ cảnh. Không gọi AI, không gọi Meta — webhook trả 200 ngay sau đây. */
export async function receiveMessengerEvent(ev: MessengerEvent, now: Date = new Date()): Promise<ReceiveResult> {
  const owned = await messengerOwnedPageIds();
  if (!owned.length) return { queued: false, reason: "Kết nối Messenger chưa bật" };
  if (!owned.includes(ev.pageId)) return { queued: false, reason: "Tin của page khác page đã nối" };
  await noteChannelPageHealth(MESSENGER_CONNECTOR, ev.pageId, { ok: true }, now);
  // MỘT PAGE — MỘT ĐƯỜNG CANONICAL (channel-ownership.ts · 0233): Pancake là đường chính của page và đang chạy ⇒ đường này nhường
  // MỌI gói tin của page đó (cả tiếng vọng) — không hội thoại thứ hai, không câu trả lời thứ hai. Đường chính đã lưu mà KHÔNG chạy
  // ⇒ vẫn ghi tin khách cho người đọc, KHÔNG kích AI (`NON_CANONICAL_NOTE`).
  const verdict: RouteVerdict = routeVerdict(await loadTransportFacts(), ev.pageId, "MESSENGER");
  if (verdict === "OTHER_OWNS") return { queued: false, reason: PANCAKE_OWNS_PAGE_REASON };
  const db = await getDb();
  const t = schema.salesChatInbound;
  // 0225: quảng cáo dẫn KHÁCH vào hội thoại — ghi lên hội thoại (đường phụ, không làm hỏng lượt nhận). Sự kiện CHỈ mang quảng
  // cáo (messaging_referrals) dừng ở đây: nó không phải tin nhắn, bot không trả lời nó.
  if (ev.referralOnly) {
    if (ev.adReferral) await noteCustomerAd(ev.pageId, ev.psid, ev.adReferral, ev.at ?? now);
    return { queued: false, reason: "Khách bấm quảng cáo — đã ghi mã quảng cáo lên hội thoại, không phải tin nhắn" };
  }
  if (!ev.isEcho && !ev.comment && ev.adReferral) await noteCustomerAd(ev.pageId, ev.psid, ev.adReferral, ev.at ?? now);
  if (ev.isEcho) {
    // Tin nhân viên gửi từ hộp thư ERP đi qua CHÍNH app nền tảng ⇒ phải bắt trước nhánh «mã app = bot», không thì thành tin bot.
    const [staffEcho] = await db.select({ id: t.id }).from(t).where(erpStaffEchoCond(ev.pageId, ev.psid, normalizeEcho(ev.text), now)).limit(1);
    if (staffEcho) return { queued: false, reason: "Tin nhân viên gửi từ hộp thư ERP" };
    // Tin của chính bot: mã app của nền tảng (app Messenger HOẶC app đăng nhập — trong lúc chuyển app cả hai là bot), HOẶC đúng
    // mã tin bot đã ghi lúc gửi (tiếng vọng Instagram không mang mã app).
    const [sentByBot] = await db.select({ id: t.id }).from(t).where(and(eq(t.messageId, ev.mid), eq(t.note, "BOT_SENT"))).limit(1);
    if ((ev.appId !== null && messengerBotAppIds().includes(ev.appId)) || sentByBot) {
      await db.insert(t).values({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: ev.text.slice(0, TEXT_MAX), status: "DONE", processedAt: now, note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
      return { queued: false, reason: "Tin của chính bot" };
    }
    // Tin page gửi đi KHÔNG qua app nền tảng: người trong Hộp thư Meta, hoặc trả lời tự động của Meta.
    await db.insert(t).values({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: ev.text.slice(0, TEXT_MAX), status: "DONE", processedAt: now, note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
    await stopFollowups(ev.pageId, ev.psid, now, false);
    const c = schema.salesChatConversations;
    const key = fanpageKey(ev.pageId, ev.psid);
    // Đang trò chuyện với bot mà page lên tiếng ⇒ là người ⇒ nhường như nhân viên. Đầu hội thoại ⇒ trả lời tự động của Meta.
    const [active] = await db
      .select({ id: c.id, status: c.status })
      .from(c)
      .where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, key), pageSideIsStaffCond(now)))
      .limit(1);
    if (!active) return { queued: false, reason: "Trả lời tự động của page — bot không chen" };
    // Nhường 30 phút + sự kiện «bắt đầu nhường» — CÙNG đường với Pancake (`startHumanCooldown`). Thiếu sự kiện thì hội thoại nhân
    // viên đã cầm trong Hộp thư Meta bị đếm vào nhóm «AI tự làm» ở màn «Hiệu quả».
    await startHumanCooldown(active.id, { reason: STAFF_REASON, at: now, actorUserId: null, key: `staff:${ev.mid}`, via: "MESSENGER" });
    return { queued: false, reason: "Nhân viên đang trả lời — bot nhường" };
  }
  // BÌNH LUẬN dưới bài viết (trường `feed`): một hàng chờ riêng mỗi bình luận (`threadId` = «comment:<mã>») — bot trả lời bằng
  // TIN RIÊNG (Private Replies), không bao giờ công khai. Mỗi bình luận Meta chỉ cho MỘT tin riêng.
  if (ev.comment) {
    const rows = await db
      .insert(t)
      .values({ pageId: ev.pageId, threadId: ev.mid, messageId: ev.mid, text: ev.text, kind: "COMMENT", postId: ev.comment.postId, fromId: ev.psid, transport: "MESSENGER", ...(verdict === "CANONICAL_DOWN" ? { status: "SKIPPED", processedAt: now, note: NON_CANONICAL_NOTE } : {}) })
      .onConflictDoNothing({ target: t.messageId })
      .returning({ id: t.id });
    return rows.length ? { queued: true, reason: "Đã nhận bình luận" } : { queued: false, reason: "Bình luận trùng — đã nhận trước đó" };
  }
  if (!ev.text && !ev.imageUrls.length) {
    await stopFollowups(ev.pageId, ev.psid, now, true);
    // NGƯỜI phải thấy tin này trong hộp thư (MEDIA_ONLY — không vào hàng chờ của bot).
    const media = await insertCustomerInbound({ pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: MEDIA_ONLY_TEXT, status: "DONE", processedAt: now, note: MEDIA_ONLY_NOTE, transport: "MESSENGER", senderId: ev.psid }, now, { canonical: verdict === "CANONICAL" });
    if (media.duplicate) return { queued: false, reason: DUPLICATE_SOURCE_REASON };
    await noteCustomerArrived(ev.pageId, ev.psid, now);
    return { queued: false, reason: "Tin không có chữ hay ảnh — để nhân viên xem" };
  }
  const skipped = verdict === "CANONICAL_DOWN";
  const ins = await insertCustomerInbound(
    { pageId: ev.pageId, threadId: ev.psid, messageId: ev.mid, text: ev.text, ...(ev.imageUrls.length ? { imageUrls: ev.imageUrls } : {}), ...(skipped ? { status: "SKIPPED", processedAt: now, note: NON_CANONICAL_NOTE } : {}), transport: "MESSENGER", senderId: ev.psid },
    now,
    { canonical: !skipped },
  );
  if (ins.duplicate) return { queued: false, reason: DUPLICATE_SOURCE_REASON };
  if (ins.inserted) await noteCustomerArrived(ev.pageId, ev.psid, now);
  if (ins.inserted && skipped) return { queued: false, reason: NON_CANONICAL_NOTE };
  return ins.inserted ? { queued: true, reason: "Đã nhận" } : { queued: false, reason: "Tin trùng — đã nhận trước đó" };
}

/** Cùng khoá hội thoại với đường Pancake (băm page + mã hội thoại) — PSID và mã hội thoại Pancake không bao giờ trùng nhau. */
const fanpageKey = (pageId: string, psid: string) => fanpageVisitorKey(pageId, psid);

// ─────────────────────────── Gửi ───────────────────────────

/** Gửi MỘT tin chữ của bot qua Send API (chia ≤ 2.000 ký tự). Ghi mã tin đã gửi — tiếng vọng tới sau là «tin của chính bot». */
export async function sendMessengerPageText(pageId: string, psid: string, text: string, deps: FanpageDeps = {}, mark?: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  const tk = await messengerTokenFor(pageId);
  if (!tk.ok) return { ok: false, error: tk.error };
  // Chốt cuối của cổng page (page-runtime.ts): tin BOT chỉ đi khi page LIVE; tin nhân viên (`mark`) không qua cổng.
  if (!mark && !(await botSendAllowed(pageId))) return { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR };
  const app = messengerApp();
  if (!app) return { ok: false, error: "Nền tảng chưa cấu hình app Facebook" };
  const token = tk.token;
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const parts = chunkText(text, MESSENGER_TEXT_MAX);
  for (const [i, part] of parts.entries()) {
    if (mark) {
      // Tin nhân viên (hộp thư ERP): ghi sẵn TRƯỚC khi gửi — tiếng vọng tới nhanh hơn phản hồi của Send API.
      const rowId = staffOutRowId(mark, i);
      await db.insert(t).values({ pageId, threadId: psid, messageId: rowId, text: normalizeEcho(part), status: "DONE", processedAt: now(), note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
      const sent = await sendMessengerText(app, token, psid, part, deps.fetch ?? fetch);
      if (!sent.ok) {
        await noteMessengerGraphFailure(sent, pageId);
        await db.delete(t).where(eq(t.messageId, rowId));
        await noteChannelPageHealth(MESSENGER_CONNECTOR, pageId, { ok: false, error: `Gửi tin: ${sent.error}` }, now());
        return { ok: false, error: i > 0 ? `${sent.error} (đã gửi ${i}/${parts.length} đoạn)` : sent.error };
      }
      continue;
    }
    const sent = await sendMessengerText(app, token, psid, part, deps.fetch ?? fetch);
    if (!sent.ok) {
      // Token hỏng / mất quyền ⇒ báo người (messenger-health.ts — theo page khi page có token riêng). Sức khoẻ THEO PAGE: lỗi
      // gửi của page này hiện ở đúng page, không làm dừng page khác.
      await noteMessengerGraphFailure(sent, pageId);
      await noteChannelPageHealth(MESSENGER_CONNECTOR, pageId, { ok: false, error: `Gửi tin: ${sent.error}` }, now());
      return { ok: false, error: sent.error };
    }
    await db
      .insert(t)
      .values({ pageId, threadId: psid, messageId: sent.id ?? `bot-out:${randomUUID()}`, text: part.slice(0, TEXT_MAX), status: "DONE", processedAt: now(), note: "BOT_SENT" })
      .onConflictDoNothing({ target: t.messageId });
  }
  return { ok: true };
}

/** Nhân viên gửi ẢNH qua Send API (0211): mỗi ảnh một lời gọi (tải tệp kèm). Dòng ghi sẵn «[Ảnh]» như đường Pancake. */
export async function sendMessengerPageImages(pageId: string, psid: string, images: readonly { data: Uint8Array; contentType: string }[], deps: FanpageDeps, mark: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  const tk = await messengerTokenFor(pageId);
  if (!tk.ok) return { ok: false, error: tk.error };
  const app = messengerApp();
  if (!app) return { ok: false, error: "Nền tảng chưa cấu hình app Facebook" };
  const token = tk.token;
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  const rowId = `${STAFF_OUT_PREFIX}${mark.staffMessageId}:img`;
  await db.insert(t).values({ pageId, threadId: psid, messageId: rowId, text: STAFF_IMAGE_MARK, status: "DONE", processedAt: now(), note: PAGE_REPLY }).onConflictDoNothing({ target: t.messageId });
  for (const [i, img] of images.entries()) {
    const sent = await sendMessengerImage(app, token, psid, img, deps.fetch ?? fetch);
    if (!sent.ok) {
      await noteMessengerGraphFailure(sent, pageId);
      if (i === 0) await db.delete(t).where(eq(t.messageId, rowId));
      return { ok: false, error: i > 0 ? `${sent.error} (đã gửi ${i}/${images.length} ảnh)` : sent.error };
    }
  }
  return { ok: true };
}

/** Ảnh của nhân viên vào hội thoại fanpage, ĐÚNG đường của page: Pancake nếu page nối qua Pancake, không thì Messenger trực tiếp. */
export async function sendPageImages(pageId: string, threadId: string, images: readonly { data: Uint8Array; contentType: string }[], deps: FanpageDeps, mark: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  if ((await sendRouteOf(pageId, threadId)) === "MESSENGER") return sendMessengerPageImages(pageId, threadId, images, deps, mark);
  const viaPancake = await sendFanpageImages(pageId, threadId, images, deps, mark);
  if (viaPancake.ok || !/chưa bật \/ khác page/.test(viaPancake.error)) return viaPancake;
  return sendMessengerPageImages(pageId, threadId, images, deps, mark);
}

/**
 * ẢNH CỦA CÂU TRẢ LỜI MẪU do BOT gửi qua Send API: đọc tệp ảnh của câu mẫu trong ERP, mỗi ảnh một lời gọi (tải tệp kèm).
 * Mã tin Meta trả về ghi `BOT_SENT` — tiếng vọng tới sau là tin của bot (Instagram không mang mã app). Ảnh hỏng / mất ⇒ bỏ ảnh
 * đó, không chặn ảnh sau; lỗi gửi ⇒ dừng, trả câu lỗi.
 */
export async function sendBotImages(pageId: string, psid: string, imageIds: readonly string[], deps: FanpageDeps = {}): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  // Chốt cổng page (page-runtime.ts) trước cả lời đọc token: ảnh của bot chỉ đi khi page LIVE.
  if (!(await botSendAllowed(pageId))) return { ok: false, error: PAGE_NOT_LIVE_SEND_ERROR };
  const tk = await messengerTokenFor(pageId);
  if (!tk.ok) return { ok: false, error: tk.error };
  const app = messengerApp();
  if (!app) return { ok: false, error: "Nền tảng chưa cấu hình app Facebook" };
  const token = tk.token;
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const t = schema.salesChatInbound;
  let sent = 0;
  for (const id of imageIds) {
    const img = await readQuickReplyImage(id);
    if (!img) continue;
    const r = await sendMessengerImage(app, token, psid, { data: new Uint8Array(img.data), contentType: img.contentType }, deps.fetch ?? fetch);
    if (!r.ok) return (await noteMessengerGraphFailure(r, pageId), { ok: false, error: r.error });
    sent += 1;
    await db.insert(t).values({ pageId, threadId: psid, messageId: r.id ?? `bot-out:${randomUUID()}`, text: "", status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
  }
  return { ok: true, sent };
}

/**
 * Đường GỬI của một luồng fanpage (0233). Luồng do đường Messenger ghi ⇒ Messenger; luồng do Pancake ghi ⇒ đường cũ (thử Pancake rồi
 * Messenger); dòng cũ chưa mang đường ⇒ theo đường canonical của page — page Meta trực tiếp không gửi nhầm qua Pancake với mã PSID.
 * Lỗi đọc ⇒ `null` (đường cũ — hành vi trước 0233).
 */
async function sendRouteOf(pageId: string, threadId: string): Promise<"MESSENGER" | "PANCAKE" | null> {
  try {
    const own = await threadTransport(pageId, threadId);
    if (own) return own;
    return transportOwnerOf(await loadTransportFacts(), pageId);
  } catch {
    return null;
  }
}

/** Một tin của bot vào hội thoại fanpage, ĐÚNG đường của page: Pancake nếu page nối qua Pancake, không thì Messenger trực tiếp. */
export async function sendBotText(pageId: string, threadId: string, text: string, deps: FanpageDeps = {}, mark?: StaffMark): Promise<{ ok: true } | { ok: false; error: string }> {
  if ((await sendRouteOf(pageId, threadId)) === "MESSENGER") return sendMessengerPageText(pageId, threadId, text, deps, mark);
  const viaPancake = await sendFanpageText(pageId, threadId, text, deps, mark);
  if (viaPancake.ok || !/chưa bật \/ khác page/.test(viaPancake.error)) return viaPancake;
  return sendMessengerPageText(pageId, threadId, text, deps, mark);
}

// ─────────────────────────── Xử lý lượt ───────────────────────────

/** Gom tin chờ của MỘT khách (PSID) ⇒ một lượt chatbot ⇒ gửi trả lời qua Send API. Cùng luật chờ / nhường với đường Pancake. */
export async function processMessengerThread(pageId: string, psid: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());
  const out: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  // Chỉ đường CANONICAL của page được kích AI (0233). Đọc hỏng ⇒ chạy như trước (không chặn đường đang chạy vì một lỗi đọc).
  const verdict = await loadTransportFacts()
    .then((f) => routeVerdict(f, pageId, "MESSENGER"))
    .catch(() => "CANONICAL" as const);
  if (verdict !== "CANONICAL") return { ...out, skipped: verdict === "OTHER_OWNS" ? PANCAKE_OWNS_PAGE_REASON : NON_CANONICAL_NOTE };
  const tk = await messengerTokenFor(pageId);
  if (!tk.ok) return { ...out, skipped: tk.error };
  const token = tk.token;
  const db = await getDb();
  const t = schema.salesChatInbound;
  for (let round = 0; round < 3; round++) {
    const [pend] = await db
      .select({ newest: sql<Date | string | null>`max(${t.createdAt})`, oldest: sql<Date | string | null>`min(${t.createdAt})` })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.status, "PENDING")));
    if (!pend?.newest || !pend.oldest) break;
    const oldest = new Date(pend.oldest);
    const [prior] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), lt(t.createdAt, oldest), sql`coalesce(${t.note}, '') <> ${PAGE_REPLY}`))
      .limit(1);
    const firstContact = !prior;
    // Messenger gửi tiếng vọng kèm mã app ⇒ «page đã trả lời» là sự thật, không phải suy đoán theo thứ tự tới.
    const pageRepliedSince = async () => {
      const [r] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.note, PAGE_REPLY), gte(t.createdAt, firstContact ? new Date(oldest.getTime() - FIRST_CONTACT_LOOKBACK_MS) : oldest)))
        .limit(1);
      return Boolean(r);
    };
    if (!deps.catchUp && new Date(pend.newest).getTime() > now().getTime() - (firstContact ? FIRST_CONTACT_WAIT_MS : FOLLOWUP_WAIT_MS) && !(await pageRepliedSince())) return { ...out, skipped: WAITING };
    const claim = randomUUID();
    const staleBefore = new Date(now().getTime() - CLAIM_STALE_MS);
    // Lượt giành QUÁ HẠN của một tiến trình đã chết — để biết lượt đó đã kịp gửi chưa (inbound-retry.ts).
    const staleRows = await db
      .select({ id: t.id, claimedAt: t.claimedAt })
      .from(t)
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.status, "PENDING"), isNotNull(t.claimId), lt(t.claimedAt, staleBefore)));
    const claimed = await db
      .update(t)
      .set({ claimId: claim, claimedAt: now() })
      .where(and(eq(t.pageId, pageId), eq(t.threadId, psid), eq(t.status, "PENDING"), or(isNull(t.claimId), lt(t.claimedAt, staleBefore)), dueForClaim(now())))
      .returning({ id: t.id, text: t.text, createdAt: t.createdAt, imageUrls: t.imageUrls, kind: t.kind, postId: t.postId, messageId: t.messageId });
    if (!claimed.length) break;
    // KHÔNG TRẢ LỜI TRÙNG: chỉ CHÍNH các tin của lượt quá hạn đã kịp được trả lời mới chốt; tin mới cùng lượt vẫn xử lý.
    const repliedIds = staleRows.length ? await alreadyRepliedRows(db, pageId, psid, staleRows, claimed) : [];
    if (repliedIds.length) {
      await db.update(t).set({ status: "DONE", processedAt: now(), note: ALREADY_REPLIED_NOTE }).where(and(inArray(t.id, repliedIds), eq(t.claimId, claim)));
      out.processed += repliedIds.length;
      out.skipped = ALREADY_REPLIED_NOTE;
      if (repliedIds.length === claimed.length) continue;
      const done = new Set(repliedIds);
      for (let i = claimed.length - 1; i >= 0; i--) if (done.has(claimed[i].id)) claimed.splice(i, 1);
    }
    const ids = claimed.map((r) => r.id);
    const finish = (status: "DONE" | "SKIPPED" | "PENDING", note: string | null) =>
      db
        .update(t)
        .set(status === "PENDING" ? { claimId: null, claimedAt: null, note } : { status, processedAt: now(), note })
        .where(and(inArray(t.id, ids), eq(t.claimId, claim)));
    const lastCustomerAt = new Date(Math.max(...claimed.map((r) => r.createdAt.getTime())));
    // CỔNG PAGE CỦA NHÀ (page-runtime.ts) — cùng cổng với đường Pancake.
    const pageGate = await inboundPageGate({ pageId, threadId: psid, rows: claimed, conversation: () => conversationFor(pageId, psid), mirror: (id, at) => mirrorFanpageContext(id, pageId, psid, at) });
    if (pageGate) {
      await finish("SKIPPED", pageGate);
      out.processed += ids.length;
      out.skipped = pageGate;
      continue;
    }
    if (await pageRepliedSince()) {
      await finish("SKIPPED", PAGE_REPLIED_REASON);
      out.processed += ids.length;
      out.skipped = PAGE_REPLIED_REASON;
      continue;
    }
    const conv = await conversationFor(pageId, psid);
    if (!conv) {
      // Lỗi tạm: nhả tin, lùi dần; hết lượt ⇒ DEAD (inbound-retry.ts).
      await releaseWithBackoff(db, ids, claim, CONV_OPEN_FAILED_NOTE, now());
      return { ...out, error: CONV_OPEN_FAILED_NOTE };
    }
    {
      const cv = schema.salesChatConversations;
      await db
        .update(cv)
        .set({ lastCustomerAt, waitingSince: null, followupsSent: 0, nextFollowupAt: null, status: sql`case when ${cv.status} = 'WAITING' then 'OPEN' else ${cv.status} end` })
        .where(eq(cv.id, conv.id));
    }
    // NHƯỜNG NGƯỜI — cùng cổng với đường Pancake (`holdGate`): đang nhường / tiếp quản ⇒ tin đã lưu, 0 lời gọi AI, 0 tin gửi.
    {
      const held = await holdGate(conv, now());
      if (held) {
        await finish("SKIPPED", held.skip);
        out.processed += ids.length;
        out.skipped = held.skip;
        continue;
      }
    }
    await mirrorFanpageContext(conv.id, pageId, psid, new Date(Math.min(...claimed.map((r) => r.createdAt.getTime()))));
    // CHẾ ĐỘ VẬN HÀNH (operating-mode-shared.ts): CÙNG cổng với đường Pancake — quan sát · copilot · thử nghiệm · tự động. Đặt
    // TRƯỚC mọi lời gọi tốn tiền (đọc ảnh, AI). Mặc định TỰ ĐỘNG.
    // Chế độ của HỘI THOẠI (Tiếp quản / AI gợi ý) chỉ THU HẸP cổng của tổ chức.
    const control = controlOf(conv.state);
    const gate = applyConversationControl(replyGate(await loadModeConfig(), fanpageKey(pageId, psid), readPinnedArm(conv.state)), control);
    await pinArm(conv.id, gate, now());
    if (gate.mode === "OBSERVE") {
      const note = controlSkipNote(control) ?? (gate.arm ? OBSERVE_HUMAN_ARM_NOTE : OBSERVE_NOTE);
      await finish("SKIPPED", note);
      out.processed += ids.length;
      out.skipped = note;
      continue;
    }
    // AI TẮT CHO PAGE NÀY (bật / tắt theo page): như «quan sát» — hội thoại vẫn mở, tin vẫn ở Hộp thư, bot không nói.
    if (!(await messengerPageAiOn(pageId))) {
      await finish("SKIPPED", PAGE_AI_OFF_NOTE);
      out.processed += ids.length;
      out.skipped = PAGE_AI_OFF_NOTE;
      continue;
    }
    for (const r of claimed) {
      const urls = Array.isArray(r.imageUrls) ? r.imageUrls.filter((u): u is string => typeof u === "string") : [];
      if (!urls.length) continue;
      const line = await describeCustomerImages(urls, { conversationId: conv.id, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      r.text = [r.text, line].filter(Boolean).join("\n").slice(0, TEXT_MAX);
      await db.update(t).set({ text: r.text, imageUrls: null }).where(eq(t.id, r.id));
    }
    const before = (await conversationView(conv.id))?.messages.length ?? 0;
    const text = claimed
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => r.text)
      .join("\n")
      .slice(0, TEXT_MAX);
    // BÌNH LUẬN: đọc nội dung bài viết để «cho giá» hiểu đúng món (cùng lời nhắc với đường Pancake).
    const commentRow = [...claimed].reverse().find((r) => r.kind === "COMMENT");
    let context = "";
    if (commentRow?.postId) {
      const app = messengerApp();
      context = postContextPrompt(app ? await postMessage(app, token, commentRow.postId, deps.fetch ?? fetch) : null);
    }
    if (gate.mode === "COPILOT") {
      // Bot soạn ở hội thoại BÓNG, không gửi: người của shop trả lời trong Hộp thư Meta; câu thật tới sau được đem so với gợi ý.
      await draftCopilotSuggestion({ conversationId: conv.id, pageId, threadId: psid, text, ...(context ? { context } : {}), now: now() });
      await finish("SKIPPED", COPILOT_NOTE);
      out.processed += ids.length;
      out.skipped = COPILOT_NOTE;
      continue;
    }
    // Ảnh chụp ĐẦU LƯỢT: người gửi tin / tiếp quản trong lúc AI đang soạn ⇒ bot không gửi câu đã soạn.
    const sendGuard = await captureSendSnapshot(conv.id);
    const turn = await chatTurn(conv.id, text, { channel: "FANPAGE", visitorKey: fanpageKey(pageId, psid), now: now(), customerName: null, ...(context ? { context } : {}) });
    if (!turn.ok) {
      const busy = /Đang trả lời câu trước/.test(turn.error);
      await finish(busy ? "PENDING" : "SKIPPED", turn.error.slice(0, 300));
      if (busy) return { ...out, skipped: "Hội thoại đang được trả lời" };
      out.processed += ids.length;
      out.skipped = turn.error;
      continue;
    }
    if (turn.view.status === "HANDOFF") {
      // AI HỎNG ⇒ DEAD-LETTER (thử lại khi provider hồi phục); chuyển người có chủ đích ⇒ DONE như cũ.
      const cvh = schema.salesChatConversations;
      const [hc] = await db.select({ reason: cvh.handoffReason, error: cvh.lastError }).from(cvh).where(eq(cvh.id, conv.id)).limit(1);
      if (hc?.reason === AI_DOWN_HANDOFF_REASON) await deadLetter(db, ids, claim, DEAD_AI_DOWN_NOTE, hc.error, now());
      else await finish("DONE", HANDOFF_SILENT_NOTE);
      out.processed += ids.length;
      out.skipped = "Chuyển nhân viên — bot im lặng";
      continue;
    }
    const replies = turn.view.messages.slice(before).filter((m) => m.role === "assistant" && m.text.trim());
    const mayFirst = await botMaySend(conv.id, sendGuard);
    if (!mayFirst.ok) {
      await finish("DONE", mayFirst.reason);
      out.processed += ids.length;
      out.skipped = mayFirst.reason;
      continue;
    }
    if (commentRow) {
      // MỘT tin riêng gộp mọi câu trả lời (Meta chỉ cho một tin riêng mỗi bình luận). Ảnh câu mẫu không đi kèm được tin riêng.
      const replyText = replies.map((r) => r.text).join("\n\n").trim();
      // Chốt cổng page ngay trước tin riêng trả lời bình luận (sendPrivateReply là lời gọi Graph trực tiếp).
      if (!(await botSendAllowed(pageId))) {
        await finish("SKIPPED", PAGE_NOT_LIVE_SEND_ERROR);
        out.processed += ids.length;
        out.skipped = PAGE_NOT_LIVE_SEND_ERROR;
        continue;
      }
      const app = messengerApp();
      const commentId = commentRow.messageId.replace(/^comment:/, "");
      const pr = replyText && app ? await sendPrivateReply(app, token, commentId, replyText, deps.fetch ?? fetch) : null;
      if (pr && !pr.ok) await noteMessengerGraphFailure(pr, pageId);
      if (pr?.ok) {
        out.replies += 1;
        if (replies.some((r) => (turn.aiTexts ?? []).includes(r.text))) await noteAiCustomerReply(conv.id, now());
        if (pr.id) await db.insert(t).values({ pageId, threadId: psid, messageId: pr.id, text: replyText.slice(0, TEXT_MAX), status: "DONE", processedAt: now(), note: "BOT_SENT" }).onConflictDoNothing({ target: t.messageId });
      }
      if (pr && !pr.ok) await deadLetter(db, ids, claim, `${DEAD_SEND_NOTE_PREFIX}${pr.error}`, pr.error, now());
      else await finish("DONE", replyText ? null : EMPTY_REPLY_NOTE);
      out.processed += ids.length;
      if (pr && !pr.ok) {
        out.error = pr.error;
        break;
      }
      continue;
    }
    let sendError: string | null = null;
    // Đồng hồ khách AI (0228): đếm câu DO MODEL SINH (đánh dấu tại nguồn — `turn.aiTexts`) đã gửi THÀNH CÔNG ở CHÍNH lượt
    // này; câu mẫu (chữ hay kèm ảnh) đi trong lượt model không bao giờ được đếm.
    let aiSent = 0;
    const aiTexts = new Set(turn.aiTexts ?? []);
    let yielded: string | null = null;
    let mediaDone = false;
    // Ảnh của câu trả lời mẫu: gửi NGAY SAU chữ của chính câu mẫu đó (như đường Pancake); không khớp ⇒ sau toàn bộ phần chữ.
    const sendMedia = async () => {
      mediaDone = true;
      const ids = turn.media?.imageIds ?? [];
      if (!ids.length) return;
      const may = await botMaySend(conv.id, sendGuard);
      if (!may.ok) {
        yielded = may.reason;
        return;
      }
      const r = await sendBotImages(pageId, psid, ids, deps);
      if (!r.ok) sendError = r.error;
    };
    for (const [i, r] of replies.entries()) {
      // Câu đầu đã được hỏi ở trên; từ câu thứ hai hỏi lại — người có thể vừa trả lời giữa hai câu.
      if (i > 0) {
        const may = await botMaySend(conv.id, sendGuard);
        if (!may.ok) {
          yielded = may.reason;
          mediaDone = true;
          break;
        }
      }
      const sent = await sendMessengerPageText(pageId, psid, r.text, deps);
      if (!sent.ok) {
        sendError = sent.error;
        break;
      }
      out.replies += 1;
      if (aiTexts.has(r.text)) aiSent += 1;
      if (!mediaDone && turn.media?.afterText && r.text === turn.media.afterText) {
        await sendMedia();
        if (sendError || yielded) break;
      }
    }
    if (!sendError && !yielded && !mediaDone) await sendMedia();
    // Gửi hỏng ⇒ DEAD-LETTER, KHÔNG tự gửi lại (lời gọi gửi có thể đã tới nơi).
    if (sendError) await deadLetter(db, ids, claim, `${DEAD_SEND_NOTE_PREFIX}${sendError}`, sendError, now());
    else await finish("DONE", yielded);
    if (aiSent > 0) await noteAiCustomerReply(conv.id, now());
    if (!sendError && out.replies > 0) await markWaitingForCustomer(conv.id, now());
    if (yielded) out.skipped = yielded;
    out.processed += ids.length;
    if (sendError) {
      out.error = sendError;
      break;
    }
  }
  return out;
}

/** Sau phản hồi webhook: đợi khách gõ xong rồi xử lý; tin đầu chưa đủ tuổi / hội thoại bận ⇒ thử lại (như đường Pancake). */
export async function processMessengerThreadDebounced(pageId: string, psid: string, deps: FanpageDeps = {}): Promise<ProcessResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(FOLLOWUP_WAIT_MS + GRACE_SLACK_MS);
  let last: ProcessResult = { processed: 0, replies: 0, skipped: null, error: null };
  const tries = Math.ceil((FIRST_CONTACT_WAIT_MS - FOLLOWUP_WAIT_MS) / RETRY_MS) + 3;
  for (let i = 0; i < tries; i++) {
    last = await processMessengerThread(pageId, psid, deps);
    if (last.skipped !== "Hội thoại đang được trả lời" && last.skipped !== WAITING) break;
    await sleep(RETRY_MS);
  }
  // Ảnh đại diện cho hộp thư — SAU lượt trả lời (không làm chậm câu trả lời), hỏng thì thôi.
  await refreshMessengerProfile(pageId, psid, deps).catch(() => "FAILED");
  return last;
}

/** Ảnh đại diện Meta là URL CDN có hạn — đọc lại sau chừng này. */
export const PROFILE_REFRESH_MS = 3 * 24 * 3_600_000;

/**
 * ẢNH ĐẠI DIỆN KHÁCH MESSENGER cho hộp thư (0233): `GET /{PSID}?fields=profile_pic` bằng token của page. Meta chỉ trả khi app có
 * quyền đọc hồ sơ người dùng (Business Asset User Profile Access) — không có ⇒ ghi lỗi, hộp thư hiện chữ cái. Ghi vào
 * `state.messengerProfile` `{ pic, at, error }` (không đẩy `updated_at` — đồng hồ nhường không đọc cột đó nhưng màn khác thì có);
 * đọc lại sau `PROFILE_REFRESH_MS`. Không bao giờ lưu token; câu lỗi đã che bí mật. Không mở hội thoại mới.
 */
export async function refreshMessengerProfile(pageId: string, psid: string, deps: FanpageDeps = {}): Promise<"FETCHED" | "FRESH" | "FAILED" | "SKIPPED"> {
  if (!/^\d{5,30}$/.test(psid)) return "SKIPPED";
  const now = (deps.now ?? (() => new Date()))();
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select({ id: c.id, state: c.state }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageKey(pageId, psid)))).limit(1);
  if (!row) return "SKIPPED";
  const prev = (row.state as Record<string, unknown> | null)?.messengerProfile as { at?: unknown } | undefined;
  const prevAt = typeof prev?.at === "string" ? Date.parse(prev.at) : NaN;
  if (Number.isFinite(prevAt) && now.getTime() - prevAt < PROFILE_REFRESH_MS) return "FRESH";
  const app = messengerApp();
  const tk = await messengerTokenFor(pageId);
  if (!app || !tk.ok) return "SKIPPED";
  let pic: string | null = null;
  let error: string | null = null;
  try {
    const url = `${graphBase()}/${encodeURIComponent(psid)}?${new URLSearchParams({ fields: "profile_pic", access_token: tk.token, appsecret_proof: appSecretProof(tk.token, app.appSecret) })}`;
    const res = await (deps.fetch ?? fetch)(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const body = ((await res.json().catch(() => null)) ?? {}) as { profile_pic?: unknown; error?: { message?: unknown } };
    const raw = typeof body.profile_pic === "string" ? body.profile_pic.trim() : "";
    if (res.ok && /^https:\/\/[^\s]+$/i.test(raw) && raw.length <= 2000) pic = raw;
    else error = (typeof body.error?.message === "string" ? body.error.message : `HTTP ${res.status}`).split(tk.token).join("…").split(app.appSecret).join("…").slice(0, 200);
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).split(tk.token).join("…").slice(0, 200);
  }
  const stamp = { messengerProfile: { pic, at: now.toISOString(), error } };
  await db
    .update(c)
    .set({ state: sql`${c.state} || ${JSON.stringify(stamp)}::jsonb`, updatedAt: sql`${c.updatedAt}` })
    .where(eq(c.id, row.id));
  return pic ? "FETCHED" : "FAILED";
}

/**
 * Tin chờ quá lâu của page Messenger (lượt sau phản hồi mất vì máy khởi động lại…) — gọi kèm mỗi webhook Messenger và trong
 * job `sales-followup` (5 phút). Tin quá 30 phút KHÔNG trả lời bù: nhắn vào hội thoại đã nguội là làm phiền.
 */
export async function sweepStaleMessengerThreads(deps: FanpageDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const ids = await messengerOwnedPageIds();
  if (!ids.length) return 0;
  const db = await getDb();
  const t = schema.salesChatInbound;
  const stale = await db
    .selectDistinct({ pageId: t.pageId, threadId: t.threadId })
    .from(t)
    .where(
      and(
        inArray(t.pageId, ids),
        eq(t.status, "PENDING"),
        lt(t.createdAt, new Date(now().getTime() - 60_000)),
        gte(t.createdAt, new Date(now().getTime() - 30 * 60_000)),
        or(isNull(t.claimId), lt(t.claimedAt, new Date(now().getTime() - CLAIM_STALE_MS))),
      ),
    )
    .limit(5);
  for (const r of stale) await processMessengerThread(r.pageId, r.threadId, { ...deps, catchUp: true });
  return stale.length;
}

// ─────────────────────────── Màn hình ───────────────────────────

/** Một page (hoặc Instagram gắn với page) trên màn quản lý page. Không bí mật nào. */
export type MessengerPageView = {
  id: string;
  name: string;
  kind: "PAGE" | "INSTAGRAM";
  parentPageId: string | null;
  status: "ACTIVE" | "DISABLED";
  aiEnabled: boolean;
  lastEventAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Page nối bằng hàng kết nối đơn cũ (trước 0220), chưa có hàng riêng. */
  legacy: boolean;
  /** Page này cũng bật qua Pancake ⇒ đường Messenger đang nhường (channel-ownership.ts). */
  mutedByPancake: boolean;
};

export type MessengerView = {
  appReady: boolean;
  /** Page đầu tiên đang nối (tương thích màn cũ / ô «Vào việc ngay»). */
  page: { id: string; name: string } | null;
  instagram: { id: string; username: string } | null;
  status: string | null;
  lastTestOk: boolean | null;
  /** Ít nhất một page đang nhường Pancake. */
  mutedByPancake: boolean;
  /** MỌI page của kết nối — đang nối trước, đã gỡ sau. */
  pages: MessengerPageView[];
};

/** Trạng thái kết nối Messenger của tổ chức ngữ cảnh (không bí mật nào). */
export async function messengerView(): Promise<MessengerView> {
  const appReady = messengerApp() !== null;
  const [row] = await messagingConnectionSummaries([MESSENGER_CONNECTOR]);
  const rows = await listChannelPages(MESSENGER_CONNECTOR);
  const facts = await loadTransportFacts();
  const muted = new Set(dualConnectedPages(facts));
  const pages: MessengerPageView[] = rows.map((r) => ({ id: r.pageId, name: r.name || r.pageId, kind: r.kind, parentPageId: r.parentPageId, status: r.status, aiEnabled: r.aiEnabled, lastEventAt: r.lastEventAt?.toISOString() ?? null, lastError: r.lastError, lastErrorAt: r.lastErrorAt?.toISOString() ?? null, legacy: false, mutedByPancake: muted.has(r.pageId) }));
  // Page của hàng kết nối đơn cũ chưa có hàng riêng ⇒ vẫn là page đã nối.
  if (row?.status === "ACTIVE") {
    const known = new Set(rows.map((r) => r.pageId));
    const id = (row.plainSettings.pageId ?? "").trim();
    const ig = (row.plainSettings.igAccountId ?? "").trim();
    const base = { status: "ACTIVE" as const, aiEnabled: true, lastEventAt: null, lastError: null, lastErrorAt: null, legacy: true };
    if (id && !known.has(id)) pages.push({ ...base, id, name: row.plainSettings.pageName || id, kind: "PAGE", parentPageId: null, mutedByPancake: muted.has(id) });
    if (ig && !known.has(ig)) pages.push({ ...base, id: ig, name: `Instagram @${row.plainSettings.igUsername ?? ig}`, kind: "INSTAGRAM", parentPageId: id || null, mutedByPancake: muted.has(ig) });
  }
  pages.sort((x, y) => Number(x.status !== "ACTIVE") - Number(y.status !== "ACTIVE") || (x.parentPageId ?? x.id).localeCompare(y.parentPageId ?? y.id) || Number(x.kind === "INSTAGRAM") - Number(y.kind === "INSTAGRAM"));
  const firstPage = pages.find((p) => p.status === "ACTIVE" && p.kind === "PAGE") ?? null;
  const firstIg = firstPage ? (pages.find((p) => p.status === "ACTIVE" && p.kind === "INSTAGRAM" && p.parentPageId === firstPage.id) ?? null) : null;
  return {
    appReady,
    page: firstPage ? { id: firstPage.id, name: firstPage.name } : null,
    instagram: firstIg ? { id: firstIg.id, username: firstIg.name.replace(/^Instagram @/, "") } : null,
    status: row ? (pages.some((p) => p.status === "ACTIVE") ? row.status : row.status === "ACTIVE" ? "DISABLED" : row.status) : pages.some((p) => p.status === "ACTIVE") ? "ACTIVE" : null,
    lastTestOk: row?.lastTestOk ?? null,
    mutedByPancake: muted.size > 0,
    pages,
  };
}

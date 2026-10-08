/**
 * ═══════════ CHATBOT BÁN HÀNG — BÁO NGƯỜI (CHỈ MÁY CHỦ) ═══════════
 *
 * Hai loại tin, mỗi loại ghi HAI nơi:
 *  · hàng đợi CHUNG `notifications` — như mọi cảnh báo, cho tổ chức bật module «Cần xử lý»;
 *  · HỘP THƯ CÁ NHÂN `user_messages` của đúng người có quyền — chuông luôn đọc hộp thư này, kể cả khi tổ chức KHÔNG bật
 *    «Cần xử lý». Đo UAT 30/09/2026: mẫu «Thực phẩm đóng gói» không bật module đó, nên mọi «chatbot chuyển khách cho
 *    nhân viên» chỉ nằm trong hàng đợi chung mà không ai đọc được — khách được hứa «đã chuyển nhân viên» và không ai gọi.
 *
 * Người nhận chọn bằng `activeUserIdsWhoCan` — đúng `can()` mà trang dùng, không tính quyền lần thứ hai. Chống gửi trùng ở
 * CSDL (khoá duy nhất `dedupe_key`), nên gọi lại nhiều lần vẫn là MỘT tin mỗi người.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { sendInboxMessages } from "@/lib/inbox/send";
import { deliverMessage } from "@/lib/messaging/service";
import { isMessagingConnector, ORDER_NOTIFY_RULE_KEYS, type MessagingConnectorKey } from "@/lib/messaging/types";
import { listRules } from "@/lib/workflow/rules";
import { parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { sendTelegram } from "@/lib/alerts/telegram";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { STATUS_DOT, STATUS_LABEL, type HealthAlertDecision, type SalesHealth, type SalesHealthSnapshot } from "@/lib/sales-chatbot/health-shared";
import { ORDER_WRITE_HANDOFF_PREFIX, ORDER_WRITE_STALE_MINUTES, ORDER_WRITE_STALE_SCAN_LIMIT } from "@/lib/constants/ops-signals";

/** Cấu hình bot — đọc thẳng settings (engine import tệp này, không import ngược). */
async function handoffNotifiesGroup(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
  try {
    return parseSalesChatbotConfig(row?.value ? (JSON.parse(row.value) as unknown) : null).handoff.notifyGroup;
  } catch {
    return false;
  }
}

/**
 * Nhóm chat «báo nhóm vận hành» shop ĐÃ cấu hình (Cài đặt → Thông báo: luật đơn chốt / sửa / huỷ đang chạy THẬT có hành động
 * gửi tin) — nơi nhân viên đang theo dõi. `null` khi chưa cấu hình: không đoán kênh, không gửi.
 */
export async function operationsGroupChannel(): Promise<{ connectorKey: MessagingConnectorKey; destination: string | null } | null> {
  const rules = await listRules();
  for (const key of Object.values(ORDER_NOTIFY_RULE_KEYS)) {
    const rule = rules.find((r) => r.key === key && r.status === "ACTIVE" && r.mode === "LIVE");
    const send = rule?.actions.find((a) => a.kind === "send_message");
    if (send?.kind === "send_message" && isMessagingConnector(send.connectorKey)) return { connectorKey: send.connectorKey, destination: send.destination?.trim() || null };
  }
  return null;
}

/** Luật «báo nhóm» của MỘT sự kiện đơn đang chạy THẬT (ACTIVE + LIVE, có hành động gửi tin) — tin của luật đã tới nhóm. */
export async function orderNotifyRuleLive(event: keyof typeof ORDER_NOTIFY_RULE_KEYS): Promise<boolean> {
  const rule = (await listRules()).find((r) => r.key === ORDER_NOTIFY_RULE_KEYS[event] && r.status === "ACTIVE" && r.mode === "LIVE");
  return Boolean(rule?.actions.some((a) => a.kind === "send_message"));
}

/** Tên khách hiện trên fanpage (tin khách gần nhất của hội thoại) — để nhân viên tìm đúng hội thoại trong Pancake. */
async function fanpageCustomerName(conversationId: string): Promise<string | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ pageId: c.pageId, threadId: c.threadId }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv?.pageId || !conv.threadId) return null;
  const t = schema.salesChatInbound;
  const [row] = await db.select({ name: t.customerName }).from(t).where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId), isNotNull(t.customerName))).orderBy(desc(t.createdAt)).limit(1);
  return row?.name?.trim() || null;
}

/** Khách cần nhân viên (bot chuyển, hoặc AI không trả lời được): người ĐỌC được hội thoại chatbot được báo. */
/**
 * `opts.dedupeKey`: khoá chống trùng của MỘT sự cố (mặc định `sales-chat:handoff:<hội thoại>` — vĩnh viễn, một tin mỗi hội thoại). Sự cố
 * có danh tính riêng (ghi đơn hỏng ở lượt N) truyền khoá riêng, nếu không hội thoại từng chuyển người một lần sẽ không bao giờ báo lại.
 */
export async function notifySalesChatHandoff(conversationId: string, reason: string, customer: { name: string; phone: string } | null | undefined, now: Date, opts: { dedupeKey?: string } = {}): Promise<void> {
  const title = "Chatbot chuyển khách cho nhân viên";
  const body = `${reason}${customer ? ` — ${customer.name} · ${customer.phone}` : ""}`;
  const href = `/ai/sales-chatbot/inbox?c=${encodeURIComponent(conversationId)}`;
  const key = opts.dedupeKey ?? `sales-chat:handoff:${conversationId}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title, body, href, entityType: "SALES_CHAT", entityId: conversationId, dedupeKey: key, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:view");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title, body, href, dedupeKey: `${key}:${userId}` })), db);
  // NHÓM CHAT (chủ shop 02/10/2026, ảnh «Lê Quyền»): trên fanpage bot IM LẶNG khi chuyển người, còn chuông ERP thì nhân viên
  // đang làm trên Pancake không thấy ⇒ khách chờ hơn 5 phút. Gửi MỘT tin vào đúng nhóm «báo nhóm vận hành» của shop; mỗi lần
  // chuyển một tin (khoá theo 10 phút — gọi lặp trong cùng lượt không nhân đôi). Lỗi gửi không chặn lượt chat.
  try {
    // Chủ shop Hải Sản Làng Chài 03/10/2026: «Không cần thông báo chatbot chuyển khách cho nhân viên, chỉ cần thông báo khi
    // có đơn mới» ⇒ nhóm chỉ nhận khi shop BẬT ở cấu hình bot (mặc định tắt).
    if (!(await handoffNotifiesGroup())) return;
    const group = await operationsGroupChannel();
    if (!group) return;
    const who = (await fanpageCustomerName(conversationId)) ?? customer?.name ?? null;
    const lines = [`🙋 Khách cần nhân viên trả lời${who ? `: ${who}` : ""}`, `Lý do: ${reason}`, customer?.phone ? `SĐT: ${customer.phone}` : "", "Bot đã dừng trả lời hội thoại này — vào Pancake trả lời khách."].filter(Boolean);
    await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: lines.join("\n"), dedupeKey: `${key}:group:${Math.floor(now.getTime() / 600_000)}`, event: "sales_chat.handoff", subject: { type: "SALES_CHAT", id: conversationId } });
  } catch {
    // Nhóm chat là đường phụ — tin trong ERP ở trên đã ghi.
  }
}

/**
 * Bot vừa giữ một chỗ trong lịch của shop: người XEM được lịch hẹn được báo (chuông + hàng đợi chung) — lễ tân xếp kỹ thuật
 * viên và gọi xác nhận. Một tin mỗi lịch.
 */
export async function notifySalesChatBooking(appointmentId: string, conversationId: string, text: string, now: Date): Promise<void> {
  const title = "Chatbot vừa đặt lịch hẹn";
  const href = "/appointments";
  const key = `sales-chat:booking:${appointmentId}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "info", title, body: text, href, entityType: "SALES_CHAT", entityId: conversationId, dedupeKey: key, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("appointments:view");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_BOOKING", title, body: text, href, dedupeKey: `${key}:${userId}` })), db);
}

/** Chatbot ngừng trả lời vì AI của shop: MỘT tin mỗi lý do mỗi ngày (giờ VN) cho người CẤU HÌNH được chatbot. */
/**
 * Model shop khai (cấu hình bot / kết nối AI) KHÔNG gọi được ⇒ bot đã tự chạy bằng model mặc định. Chủ shop được báo MỘT lần
 * mỗi ngày mỗi model để sửa ô model — bot vẫn trả lời khách bình thường.
 */
export async function notifySalesChatModelFallback(model: string, fallbackModel: string, now: Date): Promise<void> {
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const title = "Model AI của chatbot không dùng được";
  const body = `Model «${model}» bị nhà cung cấp AI từ chối — bot đang tự chạy bằng «${fallbackModel}». Sửa ô Model ở trang Chatbot bán hàng (hoặc Cài đặt → Kết nối) — để trống là dùng mặc định.`;
  const dedupe = `sales-chat:model-fallback:${model}:${day}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "warning", title, body, href: "/ai/sales-chatbot", entityType: "SALES_CHAT", entityId: model, dedupeKey: dedupe, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_AI_DOWN", title, body, href: "/ai/sales-chatbot", dedupeKey: `${dedupe}:${userId}` })), db);
}

export async function notifySalesChatAiDown(key: string, label: string, now: Date): Promise<void> {
  const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const title = "Chatbot bán hàng ngừng trả lời khách";
  const body = `${label}. Trong lúc chưa sửa, khách nhắn trang chat được chuyển thẳng cho nhân viên.`;
  const dedupe = `sales-chat:provider:${key}:${day}`;
  const db = await getDb();
  await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: "critical", title, body, href: "/ai/sales-chatbot", entityType: "SALES_CHAT", entityId: key, dedupeKey: dedupe, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey });
  const users = await activeUserIdsWhoCan("ai_sales:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_AI_DOWN", title, body, href: "/ai/sales-chatbot", dedupeKey: `${dedupe}:${userId}` })), db);
  // NHÓM CHAT (sự cố P0 06/10/2026): tài khoản AI hết tiền lúc 11:38, bot im và máy ngừng ghi đơn ~2 giờ — cảnh báo chỉ nằm
  // trong chuông ERP, nơi không ai đang nhìn. Lớp lỗi KHÔNG tự khỏi (hết tiền · khoá bị từ chối) ⇒ MỘT tin vào nhóm vận hành mỗi
  // lý do mỗi ngày (cùng khoá với chuông). KHÁC tin «chuyển nhân viên» (chủ shop 03/10 tắt): đây là sự cố cả shop, không phải
  // một khách. Lỗi gửi không chặn lượt chat.
  try {
    const group = await operationsGroupChannel();
    if (group)
      await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: `🚨 ${title}\n${body}\nAI bán hàng ngừng cả trả lời lẫn TỰ GHI ĐƠN — sửa ngay để không sót đơn.`, dedupeKey: `${dedupe}:group`, event: "sales_chat.ai_down", subject: { type: "SALES_CHAT", id: key } });
  } catch {
    // Nhóm chat là đường phụ — chuông ERP ở trên đã ghi.
  }
}

/** Trang cockpit của AI bán hàng — đích của mọi tin giám sát. */
export const SALES_COCKPIT_HREF = "/ai/sales-chatbot/cockpit";

/**
 * Nhóm của ĐƠN VỊ VẬN HÀNH NỀN TẢNG (VNX) — kênh cảnh báo của tổ chức NHÀ (Lark nhóm quản lý, rồi Telegram). Chỉ nhận MÃ
 * tổ chức + trạng thái + câu kiểm (số đếm, lớp lỗi) — KHÔNG tên khách, SĐT, nội dung tin (luật ISO-05 của `loadAlertConfig`:
 * dữ liệu của tổ chức khách không bao giờ chảy vào nhóm của VNX). Không ném.
 */
export type OperatorNotifyResult = "SENT" | "NO_CHANNEL" | "FAILED";
export async function notifyPlatformOperator(title: string, lines: string[]): Promise<OperatorNotifyResult> {
  const send = async (): Promise<OperatorNotifyResult> => {
    const cfg = await loadAlertConfig();
    let r: { ok: boolean } | null = null;
    if (cfg.larkManagerWebhookUrl) r = await sendLark(cfg.larkManagerWebhookUrl, cfg.larkManagerSecret, title, lines.map((text) => [{ text }]));
    else if (cfg.larkWebhookUrl) r = await sendLark(cfg.larkWebhookUrl, cfg.larkSecret, title, lines.map((text) => [{ text }]));
    else if (cfg.telegramBotToken && cfg.telegramChatId) {
      const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      r = await sendTelegram(cfg.telegramBotToken, cfg.telegramChatId, [`<b>${esc(title)}</b>`, ...lines.map(esc)].join("\n"));
    }
    return r === null ? "NO_CHANNEL" : r.ok ? "SENT" : "FAILED";
  };
  try {
    const org = await currentOrganization();
    if (org.isHome) return await send();
    return await withOrganization((await getHomeOrganization()).code, send);
  } catch {
    // Đường phụ — chuông của tổ chức đã ghi. Nơi cần biết (ngưỡng khách AI) đọc «FAILED» để thử lại lượt sau.
    return "FAILED";
  }
}

/**
 * GIÁM SÁT AI BÁN HÀNG (job `sales-health`): sự cố MỚI · nhắc khi còn ĐỎ · hồi phục. Chống trùng ở CSDL bằng khoá của quyết
 * định (`decideHealthAlert` đã gắn khung giờ) — và tin RA NGOÀI (nhóm shop · nhóm VNX) chỉ đi khi dòng `notifications` theo
 * khoá đó được ghi MỚI: job chạy 5 phút/lần, không có cổng này thì mỗi lượt là một tin Lark.
 */
export async function notifySalesHealth(p: { decision: Exclude<HealthAlertDecision, { kind: "NONE" }>; health: SalesHealth; snapshot: SalesHealthSnapshot; now: Date }): Promise<void> {
  const { decision, health, snapshot, now } = p;
  const recovered = decision.kind === "RECOVERED";
  const title = recovered ? "🟢 AI bán hàng đã hoạt động lại" : `${STATUS_DOT[health.status]} AI bán hàng: ${STATUS_LABEL[health.status]}`;
  const bad = health.checks.filter((c) => c.level === "CRITICAL" || c.level === "WARNING");
  const lines = recovered
    ? [`Mọi kiểm đã về bình thường. Câu bot cuối: ${snapshot.lastAiReplyAt ? new Date(snapshot.lastAiReplyAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—"}.`]
    : bad.map((c) => `${c.level === "CRITICAL" ? "🔴" : "🟡"} ${c.title}: ${c.detail}${c.fix ? ` ⇒ ${c.fix}` : ""}`);
  const body = lines.join("\n");
  const db = await getDb();
  const inserted = await db
    .insert(schema.notifications)
    .values({ kind: "SYSTEM", severity: recovered ? "info" : health.status === "RED" ? "critical" : "warning", title, body: body.slice(0, 2000), href: SALES_COCKPIT_HREF, entityType: "SALES_CHAT", entityId: "health", dedupeKey: decision.dedupe, occurredAt: now })
    .onConflictDoNothing({ target: schema.notifications.dedupeKey })
    .returning({ id: schema.notifications.id });
  if (!inserted.length) return;
  const users = await activeUserIdsWhoCan("ai_sales:manage");
  await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_AI_DOWN", title, body: body.slice(0, 2000), href: SALES_COCKPIT_HREF, dedupeKey: `${decision.dedupe}:${userId}` })), db);
  try {
    const group = await operationsGroupChannel();
    if (group) await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: `${title}\n${body}`.slice(0, 3500), dedupeKey: `${decision.dedupe}:group`, event: "sales_chat.health", subject: { type: "SALES_CHAT", id: "health" } });
  } catch {
    // Nhóm chat là đường phụ — chuông ERP ở trên đã ghi.
  }
  const org = await currentOrganization();
  await notifyPlatformOperator(`${title} — tổ chức ${org.code}`, recovered ? lines : bad.map((c) => `${c.level === "CRITICAL" ? "🔴" : "🟡"} ${c.title}: ${c.detail}`));
}

/**
 * KHÁCH CHỜ VÌ GHI ĐƠN HỎNG (sứ mệnh saas-ops-signals, review #692 MEDIUM-1). Chuyển người vì ghi đơn KHÔNG tự hết hạn (bot không tự ghi
 * lại một đơn chưa ai kiểm) — đúng, nhưng tin chuyển người chỉ tới chuông ERP, nhóm chat chỉ nhận khi shop bật «báo nhóm khi chuyển
 * người» (Hải Sản Làng Chài tắt từ 03/10), còn gương nền tảng chỉ người vận hành VNX thấy ⇒ khách muốn mua bị im mà không ai biết.
 *
 * Job `sales-health` (5 phút / lần) gọi hàm này: hội thoại còn HANDOFF với lý do mở đầu `ORDER_WRITE_HANDOFF_PREFIX`, quá
 * `ORDER_WRITE_STALE_MINUTES` phút kể từ lúc chuyển, mà CHƯA có tin nhân viên gửi TỪ ERP sau mốc đó (`last_staff_at`) ⇒ báo:
 *  · chuông + hộp thư người đọc được hội thoại (MỘT tin mỗi sự cố: khoá = hội thoại + mốc chuyển người);
 *  · nhóm vận hành của shop (Lark / Telegram) — KHÔNG theo công tắc «báo nhóm khi chuyển người»: như tin «bot ngừng trả lời», đây là
 *    sự cố máy (lõi đơn hỏng), không phải một khách xin người;
 *  · nhóm VNX — chỉ mã tổ chức + số hội thoại, không tên / SĐT / nội dung (ISO-05).
 * Nhân viên trả lời thẳng trên Pancake thì ERP không thấy ⇒ có thể báo một hội thoại đã có người lo — chấp nhận (một tin mỗi sự cố); chiều
 * ngược lại (im lặng khi khách đang chờ) mới là thứ phải chặn. Tin chỉ đi khi dòng `notifications` được ghi MỚI. Không ném.
 */
export type StaleOrderWriteRun = { stale: number; alerted: number; group: "SENT" | "NO_CHANNEL" | "FAILED" | "SKIPPED"; operator: OperatorNotifyResult | "SKIPPED" };
export async function alertStaleOrderWriteHandoffs(now: Date = new Date()): Promise<StaleOrderWriteRun> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const handoffAt = sql<Date>`case when ${c.state}->'handoff'->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${c.state}->'handoff'->>'at')::timestamptz else ${c.updatedAt} end`;
  const cutoff = new Date(now.getTime() - ORDER_WRITE_STALE_MINUTES * 60_000);
  // Không đào lại sự cố quá 7 ngày: hội thoại bị bỏ quên từ lâu đã có tin của chính nó lúc đó.
  const floor = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db
    .select({ id: c.id, reason: c.handoffReason, at: handoffAt })
    .from(c)
    .where(
      and(
        eq(c.status, "HANDOFF"),
        sql`${c.handoffReason} like ${`${ORDER_WRITE_HANDOFF_PREFIX}%`}`,
        sql`${handoffAt} <= ${cutoff}`,
        sql`${handoffAt} >= ${floor}`,
        sql`(${c.lastStaffAt} is null or ${c.lastStaffAt} < ${handoffAt})`,
      ),
    )
    .orderBy(handoffAt)
    .limit(ORDER_WRITE_STALE_SCAN_LIMIT);
  const out: StaleOrderWriteRun = { stale: rows.length, alerted: 0, group: "SKIPPED", operator: "SKIPPED" };
  if (!rows.length) return out;
  const title = "Khách đang chờ nhân viên — bot ghi đơn hỏng";
  const fresh: { id: string; key: string; reason: string; waited: number }[] = [];
  for (const r of rows) {
    const at = r.at instanceof Date ? r.at : new Date(String(r.at));
    const key = `sales-chat:order-write-stale:${r.id}:${at.toISOString()}`;
    const waited = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
    const body = `${r.reason ?? ORDER_WRITE_HANDOFF_PREFIX} — khách đã chờ ${waited} phút, chưa có nhân viên trả lời từ ERP.`;
    const href = `/ai/sales-chatbot/inbox?c=${encodeURIComponent(r.id)}`;
    const ins = await db
      .insert(schema.notifications)
      .values({ kind: "SYSTEM", severity: "critical", title, body, href, entityType: "SALES_CHAT", entityId: r.id, dedupeKey: key, occurredAt: now })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey })
      .returning({ id: schema.notifications.id });
    if (!ins.length) continue;
    fresh.push({ id: r.id, key, reason: r.reason ?? ORDER_WRITE_HANDOFF_PREFIX, waited });
    const users = await activeUserIdsWhoCan("ai_sales:view");
    await sendInboxMessages(users.map((userId) => ({ userId, kind: "SALES_CHAT_HANDOFF", title, body, href, dedupeKey: `${key}:${userId}` })), db);
  }
  out.alerted = fresh.length;
  if (!fresh.length) return out;
  try {
    const group = await operationsGroupChannel();
    if (!group) out.group = "NO_CHANNEL";
    else {
      const lines = [`🔴 ${title}: ${fresh.length} hội thoại chờ quá ${ORDER_WRITE_STALE_MINUTES} phút`];
      for (const f of fresh.slice(0, 10)) lines.push(`· ${(await fanpageCustomerName(f.id)) ?? "Khách"} — chờ ${f.waited} phút — ${f.reason}`);
      if (fresh.length > 10) lines.push(`· … và ${fresh.length - 10} hội thoại nữa (xem hộp thư chatbot trong ERP)`);
      lines.push("Bot đã dừng trả lời các hội thoại này — vào Pancake trả lời khách, KIỂM ĐƠN trước khi lên tay.");
      await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title, body: lines.join("\n").slice(0, 3500), dedupeKey: `${fresh[0].key}:group`, event: "sales_chat.order_write_stale", subject: { type: "SALES_CHAT", id: fresh[0].id } });
      out.group = "SENT";
    }
  } catch {
    out.group = "FAILED";
  }
  const org = await currentOrganization();
  out.operator = await notifyPlatformOperator(`🔴 Ghi đơn hỏng — khách chờ nhân viên — tổ chức ${org.code}`, [`${fresh.length} hội thoại chuyển người vì ghi đơn hỏng đã chờ quá ${ORDER_WRITE_STALE_MINUTES} phút, chưa có nhân viên trả lời từ ERP.`]);
  return out;
}

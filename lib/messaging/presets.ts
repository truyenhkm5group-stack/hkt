/**
 * ═══════════ CẤU HÌNH SẴN «BÁO NHÓM VẬN HÀNH» (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Một màn hình (`/settings/notifications`) cho câu hỏi của chủ shop: "đơn chốt / sửa / huỷ thì báo nhóm nào, nói gì".
 * Lưu = tạo / sửa LUẬT TỰ ĐỘNG THẬT qua đúng dịch vụ luật (`saveRule` → `setRuleStatus(ACTIVE)` → `setRuleMode(LIVE)`),
 * khoá luật cố định (`ORDER_NOTIFY_RULE_KEYS` — trùng khoá luật dựng sẵn của mẫu «Thực phẩm đóng gói», nên cấu hình này
 * NÂNG đúng luật của mẫu thay vì đẻ luật thứ hai). Không có đường gửi riêng: tin đi qua hành động `send_message` của bộ
 * máy luật (lib/workflow/actions.ts) → `deliverMessage` → `MessagingProvider`.
 *
 * Mỗi luật = [báo trong ERP, gửi tin nhóm]. Luật huỷ có điều kiện `wasConfirmed = true`: đơn chưa từng chốt thì nhóm vận
 * hành chưa từng nhận tin, báo huỷ là tin rác. Bỏ chọn một sự kiện ⇒ luật đó TẠM DỪNG (không xoá — lịch sử lượt chạy giữ).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { can, type SessionUser } from "@/lib/auth/session";
import { messagingConnectionSummaries } from "@/lib/connectors/service";
import { sampleOrderMessageVars } from "@/lib/messaging/order-message";
import { deliverMessage, listDeliveries, type DeliveryRow } from "@/lib/messaging/service";
import {
  DEFAULT_ORDER_TEMPLATES,
  isMessagingConnector,
  MESSAGE_TEMPLATE_MAX,
  MESSAGING_CONNECTOR_KEYS,
  messagingStatusOf,
  ORDER_MESSAGE_EVENT_LABEL,
  ORDER_MESSAGE_EVENTS,
  ORDER_MESSAGE_VAR_KEYS,
  ORDER_NOTIFY_RULE_KEYS,
  renderTemplate,
  unknownTemplateKeys,
  type MessagingConnectorKey,
  type MessagingStatus,
  type OrderMessageEvent,
} from "@/lib/messaging/types";
import { listRules, saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";
import type { WorkflowAction, WorkflowCondition, WorkflowRule } from "@/lib/workflow/types";

export const NOTIFICATIONS_PERMISSION = "workflow:manage" as const;

export type ConnectionOption = { key: MessagingConnectorKey; status: MessagingStatus; destination: string | null; message: string | null };
/** `configured` = luật đã có hành động gửi tin nhóm (đã từng lưu ở màn hình này). Luật dựng sẵn của mẫu chỉ báo trong ERP ⇒ `false`. */
export type EventPreset = { event: OrderMessageEvent; label: string; ruleId: string | null; configured: boolean; enabled: boolean; live: boolean; template: string; connectorKey: string | null; destination: string };
export type NotificationSetup = { connections: ConnectionOption[]; events: EventPreset[]; deliveries: DeliveryRow[] };

async function connectionOptions(): Promise<ConnectionOption[]> {
  const rows = await messagingConnectionSummaries(MESSAGING_CONNECTOR_KEYS);
  return MESSAGING_CONNECTOR_KEYS.map((key) => {
    const row = rows.find((r) => r.connectorKey === key) ?? null;
    const settings = row?.plainSettings ?? {};
    const destination = key === "telegram-bot" || key === "zalo-bot" ? settings.chatId || null : key === "sandbox-messaging" ? settings.channelName || null : row ? "Nhóm của webhook" : null;
    return { key, status: messagingStatusOf(key, row ? { status: row.status, lastTestOk: row.lastTestOk } : null), destination, message: row?.lastTestMessage ?? null };
  });
}

function sendActionOf(rule: WorkflowRule | undefined): Extract<WorkflowAction, { kind: "send_message" }> | null {
  return (rule?.actions.find((a) => a.kind === "send_message") as Extract<WorkflowAction, { kind: "send_message" }> | undefined) ?? null;
}

export async function loadNotificationSetup(): Promise<NotificationSetup> {
  const rules = await listRules();
  const events: EventPreset[] = ORDER_MESSAGE_EVENTS.map((event) => {
    const rule = rules.find((r) => r.key === ORDER_NOTIFY_RULE_KEYS[event]);
    const send = sendActionOf(rule);
    return {
      event,
      label: ORDER_MESSAGE_EVENT_LABEL[event],
      ruleId: rule?.id ?? null,
      configured: Boolean(send),
      enabled: Boolean(rule && rule.status === "ACTIVE" && send),
      live: Boolean(rule && rule.mode === "LIVE"),
      template: send?.template ?? DEFAULT_ORDER_TEMPLATES[event],
      connectorKey: send?.connectorKey ?? null,
      destination: send?.destination ?? "",
    };
  });
  return { connections: await connectionOptions(), events, deliveries: await listDeliveries({ limit: 30 }) };
}

const presetZ = z
  .object({
    connectorKey: z.string().refine(isMessagingConnector, "Chọn một kết nối nhắn tin."),
    destination: z.string().trim().max(120).default(""),
    events: z.array(z.enum(ORDER_MESSAGE_EVENTS)).max(3),
    templates: z.partialRecord(z.enum(ORDER_MESSAGE_EVENTS), z.string().trim().min(1, "Mẫu tin không được rỗng").max(MESSAGE_TEMPLATE_MAX)),
  })
  .strict();

export type PresetResult = { ok: true; message: string; setup: NotificationSetup } | { ok: false; error: string };

const NOTIFY_TEXT: Record<OrderMessageEvent, string> = {
  "order.confirmed": "Đơn vừa chốt — đóng gói và giao",
  "order.updated": "Đơn đã chốt vừa được sửa — kiểm lại trước khi giao",
  "order.cancelled": "Đơn đã chốt vừa bị huỷ — không đóng / không giao",
};

const RULE_NAME: Record<OrderMessageEvent, string> = {
  "order.confirmed": "Đơn chốt ⇒ báo nhóm vận hành",
  "order.updated": "Đơn đã chốt bị sửa ⇒ báo cập nhật cho nhóm",
  "order.cancelled": "Đơn huỷ ⇒ báo nhóm vận hành",
};

const CONDITIONS: Record<OrderMessageEvent, WorkflowCondition | null> = {
  "order.confirmed": null,
  "order.updated": null,
  "order.cancelled": { field: "system:payload.wasConfirmed", op: "eq", value: true },
};

/**
 * Lưu cấu hình: mỗi sự kiện được chọn ⇒ luật tương ứng (tạo hoặc sửa) ⇒ BẬT ⇒ CHẠY THẬT. Sự kiện bỏ chọn ⇒ luật đang bật
 * TẠM DỪNG. Lỗi của một bước ⇒ dừng và nói bước nào (các luật đã lưu trước đó giữ nguyên — chúng hợp lệ).
 */
export async function saveOrderNotificationPreset(user: SessionUser, raw: unknown): Promise<PresetResult> {
  if (!can(user, NOTIFICATIONS_PERMISSION)) return { ok: false, error: "Bạn không có quyền cấu hình luật tự động (workflow:manage)." };
  const parsed = presetZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  const v = parsed.data;
  const connectorKey = v.connectorKey as MessagingConnectorKey;
  for (const event of v.events) {
    const t = v.templates[event];
    if (!t) return { ok: false, error: `Thiếu mẫu tin cho «${ORDER_MESSAGE_EVENT_LABEL[event]}».` };
    const unknown = unknownTemplateKeys(t, ORDER_MESSAGE_VAR_KEYS);
    if (unknown.length) return { ok: false, error: `Mẫu tin «${ORDER_MESSAGE_EVENT_LABEL[event]}» có ô không điền được: ${unknown.map((k) => `{{${k}}}`).join(", ")}.` };
  }
  const connections = await connectionOptions();
  const conn = connections.find((c) => c.key === connectorKey);
  if (v.events.length && conn && conn.status !== "CONNECTED" && conn.status !== "TEST_MODE") {
    return { ok: false, error: `Kết nối «${connectorKey}» chưa sẵn sàng (${conn.status}) — khai, kiểm tra rồi bật ở Cài đặt → Kết nối trước.` };
  }

  const actor = { id: user.id, email: user.email, permissions: user.permissions, isAdmin: user.role === "ADMIN" };
  const rules = await listRules();
  const done: string[] = [];
  for (const event of ORDER_MESSAGE_EVENTS) {
    const key = ORDER_NOTIFY_RULE_KEYS[event];
    const existing = rules.find((r) => r.key === key);
    const want = v.events.includes(event);
    if (!want) {
      if (existing && existing.status === "ACTIVE") {
        const paused = await setRuleStatus(existing.id, "PAUSED", actor);
        if (!paused.ok) return { ok: false, error: `Không tạm dừng được luật «${existing.name}»: ${paused.errors[0]?.message ?? paused.code}` };
        done.push(`tạm dừng «${existing.name}»`);
      }
      continue;
    }
    const actions: WorkflowAction[] = [
      { kind: "notify", message: NOTIFY_TEXT[event] },
      { kind: "send_message", connectorKey, ...(v.destination && connectorKey !== "lark-webhook" ? { destination: v.destination } : {}), template: v.templates[event]! },
    ];
    const saved = await saveRule(
      {
        ...(existing ? { id: existing.id } : {}),
        key,
        name: existing?.name ?? RULE_NAME[event],
        description: "Cấu hình ở Cài đặt → Thông báo nhóm. Gửi MỘT tin tới nhóm chat của tổ chức cho mỗi lần đơn đổi — gửi lại / chạy lại không đẻ tin thứ hai.",
        trigger: { kind: "event", event },
        conditions: CONDITIONS[event],
        actions,
        gate: null,
      },
      actor,
    );
    if (!saved.ok) return { ok: false, error: `Không lưu được luật «${RULE_NAME[event]}»: ${saved.errors.map((e) => e.message).join(" · ")}` };
    const active = await setRuleStatus(saved.rule.id, "ACTIVE", actor);
    if (!active.ok) return { ok: false, error: `Không bật được luật «${saved.rule.name}»: ${active.errors[0]?.message ?? active.code}` };
    const live = await setRuleMode(saved.rule.id, "LIVE", actor);
    if (!live.ok) return { ok: false, error: `Không chuyển chạy thật được luật «${saved.rule.name}»: ${live.errors[0]?.message ?? live.code}` };
    done.push(`bật «${saved.rule.name}»`);
  }
  return { ok: true, message: done.length ? `Đã ${done.join(", ")}.` : "Không có gì thay đổi.", setup: await loadNotificationSetup() };
}

const testZ = z
  .object({
    connectorKey: z.string().refine(isMessagingConnector, "Chọn một kết nối nhắn tin."),
    destination: z.string().trim().max(120).default(""),
    event: z.enum(ORDER_MESSAGE_EVENTS),
    template: z.string().trim().min(1).max(MESSAGE_TEMPLATE_MAX),
  })
  .strict();

/** «Gửi thử»: MỘT tin điền bằng đơn gần nhất (hoặc dữ liệu mẫu ghi rõ là mẫu) qua ĐÚNG đường gửi của luật. */
export async function sendTestNotification(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!can(user, NOTIFICATIONS_PERMISSION)) return { ok: false, error: "Bạn không có quyền cấu hình luật tự động (workflow:manage)." };
  const parsed = testZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  const v = parsed.data;
  const connectorKey = v.connectorKey as MessagingConnectorKey;
  const { vars, sample, orderId } = await sampleOrderMessageVars();
  const body = renderTemplate(v.template, vars);
  const r = await deliverMessage({
    connectorKey,
    destination: v.destination && connectorKey !== "lark-webhook" ? v.destination : null,
    title: sample ? "[TIN THỬ · dữ liệu mẫu]" : "[TIN THỬ]",
    body,
    dedupeKey: `test:${randomUUID()}`,
    event: v.event,
    subject: orderId ? { type: "order", id: orderId } : null,
    isTest: true,
    createdBy: user.email,
  });
  if (r.status === "SENT") return { ok: true, message: connectorKey === "sandbox-messaging" ? "Đã ghi tin thử vào hộp thử — xem ở bảng «Tin đã gửi» bên dưới." : `Đã gửi tin thử${r.destination ? ` tới ${r.destination}` : ""} — mở nhóm chat để xác nhận.` };
  if (r.status === "FAILED") return { ok: false, error: r.error };
  return { ok: false, error: "Không xác định được kết quả gửi — xem sổ tin đã gửi." };
}

/** Tin đã gửi cho một đơn (trang chi tiết đơn in lại). */
export async function deliveriesForOrder(orderId: string): Promise<DeliveryRow[]> {
  return listDeliveries({ subjectId: orderId, limit: 20 });
}

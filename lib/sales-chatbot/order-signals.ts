/**
 * ═══════════ ĐƠN CỦA BOT GHI KHÔNG THÀNH — TÍN HIỆU CÓ TÊN, KHÔNG ĐỘI LỐT «AI HỎNG» (sứ mệnh saas-ops-signals) — CHỈ MÁY CHỦ ═══════════
 *
 * Đo trên main 08/10/2026: lõi đơn (`lib/records/order-create.ts`) NÉM lỗi CSDL bên trong một công cụ của bot ⇒ lỗi bay lên catch của
 * lượt gọi AI (`engine.ts`) ⇒ sổ AI ghi ERROR + hội thoại chuyển người với lý do «AI tạm không trả lời được». Khách lẫn người vận hành
 * thấy «AI hỏng» trong khi thứ hỏng là GHI ĐƠN; còn đơn bị lõi đơn / công cụ TỪ CHỐI thì chỉ nằm trong tin công cụ của hội thoại.
 *
 * Tệp này cho hai tín hiệu tên riêng, ghi ở HAI nơi:
 *  · `audit_logs` của TỔ CHỨC — `order.create_failed` (7) / `order.validation_failed` (6), entity `ORDER_ATTEMPT`, `correlation_id` =
 *    id hội thoại (khoá nối với `platform_ai_usage.conversation_id`), entity_id = mã đơn nếu có (dòng thời gian của đơn thấy nó).
 *    Không câu lỗi gốc (có thể mang SĐT / tên khách) — chỉ mã lý do, tên công cụ, SQLSTATE, tên trường.
 *  · gương `platform_org_health` (CSDL nhà) — nâng mức ngay để người vận hành thấy không đợi lượt đo 5 phút (có trần tần suất).
 * Không ném: ghi tín hiệu hỏng không được làm hỏng lượt phục vụ khách.
 */
import { audit } from "@/lib/audit";
import { ORDER_ATTEMPT_ENTITY, ORDER_CREATE_FAILED_ACTION, ORDER_VALIDATION_FAILED_ACTION, opsReasonLabel, type OrderValidationReason, type OrderWriteReason } from "@/lib/constants/ops-signals";
import type { MetaFailure } from "@/lib/metadata/errors";
import { currentOrganization } from "@/lib/platform/context";
import { noteOrgHealthEvent } from "@/lib/platform/org-health";

/**
 * Công cụ của bot chạm LÕI ĐƠN (khách · đơn nháp · chốt · ghi chú «khách huỷ») ⇒ lý do khi nó NÉM. Lỗi ném từ công cụ khác (tìm hàng,
 * tra đơn…) vẫn đi đường cũ — sứ mệnh này chỉ tách ghi đơn (ghi rõ ở báo cáo bàn giao).
 */
export const ORDER_SIGNAL_TOOLS: Readonly<Record<string, Exclude<OrderWriteReason, "ORDER_POSTWRITE_ERROR">>> = {
  create_customer: "CUSTOMER_WRITE_ERROR",
  create_draft_order: "ORDER_DRAFT_ERROR",
  update_draft_order: "ORDER_DRAFT_ERROR",
  confirm_order: "ORDER_CONFIRM_ERROR",
  mark_declined: "ORDER_FLAG_ERROR",
  cancel_order: "ORDER_FLAG_ERROR",
};

/** Lý do «ghi đơn hỏng» của MỘT công cụ — `Object.hasOwn`: tên công cụ do model gửi, «constructor» / «toString» không phải công cụ. */
export function orderSignalToolReason(name: string): Exclude<OrderWriteReason, "ORDER_POSTWRITE_ERROR"> | null {
  return Object.hasOwn(ORDER_SIGNAL_TOOLS, name) ? ORDER_SIGNAL_TOOLS[name] : null;
}

/**
 * Dấu «lõi đơn đã ghi xong» của MỘT lượt công cụ: `executeTool` tạo, công cụ đánh dấu NGAY SAU KHI lõi đơn trả `ok` (`markOrderWritten`).
 * Lỗi ném sau dấu này là lỗi SAU GHI — đơn có thể đã có, câu báo nhân viên phải là «kiểm trước», không phải «lên đơn tay».
 */
export type OrderWriteMark = { committed: boolean; orderId: string | null };
export function markOrderWritten(mark: OrderWriteMark | undefined, orderId: string | null): void {
  if (!mark) return;
  mark.committed = true;
  mark.orderId = orderId;
}

/**
 * Lõi đơn ném lỗi bên trong một công cụ của bot. `engine.ts` bắt RIÊNG lớp này: lượt AI KHÔNG bị ghi ERROR, hội thoại chuyển người với
 * `ORDER_WRITE_HANDOFF_REASON`, không báo «nhà cung cấp AI hỏng». `message` không mang câu lỗi gốc (có thể chứa dữ liệu khách).
 */
export class OrderWriteError extends Error {
  constructor(
    readonly reason: OrderWriteReason,
    readonly tool: string,
    readonly sqlState: string | null,
    /** Đơn của lượt (mã đơn đã ghi khi `postWrite`, hoặc đơn nháp sẵn có của hội thoại) — để câu báo nhân viên trỏ đúng đơn. */
    readonly orderId: string | null = null,
    /** Ném SAU KHI lõi đơn đã ghi xong — đơn có thể ĐÃ có. */
    readonly postWrite: boolean = false,
  ) {
    super(`Ghi đơn hỏng (${reason}) ở công cụ ${tool}${sqlState ? ` · SQLSTATE ${sqlState}` : ""}`);
    this.name = "OrderWriteError";
  }
}

/** SQLSTATE của lỗi CSDL (drizzle bọc lỗi gốc ở `cause`) — mã 5 ký tự, không mang dữ liệu. `null` = không phải lỗi CSDL / không đọc được. */
export function sqlStateOf(error: unknown): string | null {
  for (let e: unknown = error, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Lỗi nghiệp vụ lõi đơn trả về (`MetaFailure`) ⇒ lý do đơn không hợp lệ. Lỗi ở `customerId` = hạn mức nợ / cần duyệt. HÀM THUẦN. */
export function omsValidationReason(f: Pick<MetaFailure, "code" | "errors">): OrderValidationReason {
  if (f.code === "INVALID" && f.errors.some((e) => e.field === "customerId")) return "CREDIT_LIMIT";
  switch (f.code) {
    case "INVALID":
      return "OMS_INVALID";
    case "CONFLICT":
      return "OMS_CONFLICT";
    case "NOT_SUPPORTED":
      return "OMS_NOT_SUPPORTED";
    case "MODULE_DISABLED":
      return "OMS_MODULE_DISABLED";
    case "FORBIDDEN":
      return "OMS_FORBIDDEN";
    case "NOT_FOUND":
      return "OMS_NOT_FOUND";
    default:
      return "OMS_OTHER";
  }
}

type AttemptBase = { conversationId: string; tool: string; orderId: string | null; channel: string; turn: number | null; agent: { name: string; source: string } };

const fieldsOnly = (fields: readonly string[] | undefined) => (fields ?? []).map((f) => String(f).slice(0, 60)).slice(0, 10);

/** (7) Lõi đơn NÉM khi bot ghi khách / đơn. Không ném. */
export async function recordOrderWriteFailure(input: AttemptBase & { reason: OrderWriteReason; sqlState: string | null }, now: Date = new Date()): Promise<void> {
  try {
    await audit({
      userId: null,
      userEmail: `agent:${input.agent.source}`,
      actorKind: "AGENT",
      action: ORDER_CREATE_FAILED_ACTION,
      entity: ORDER_ATTEMPT_ENTITY,
      entityId: input.orderId ?? input.conversationId,
      correlationId: input.conversationId,
      reason: `${input.agent.name}: ${opsReasonLabel(input.reason)} — ${input.reason === "ORDER_POSTWRITE_ERROR" ? "đơn có thể ĐÃ ghi, nhân viên kiểm trước khi lên tay" : input.orderId ? "đơn chưa cập nhật được, nhân viên kiểm đơn" : "đơn CHƯA ghi được"}, hội thoại chuyển nhân viên`,
      detail: { reasonCode: input.reason, tool: input.tool, sqlState: input.sqlState, channel: input.channel, turn: input.turn, orderId: input.orderId },
    });
    const org = await currentOrganization();
    await noteOrgHealthEvent(org.code, "ORDER_WRITE", { level: "CRITICAL", reason: input.reason, at: now, correlationId: input.conversationId });
  } catch (error) {
    console.error(`[order-signals] ghi tín hiệu ghi đơn hỏng thất bại (${input.tool}/${input.reason}): ${error instanceof Error ? error.message.slice(0, 200) : "lỗi lạ"}`);
  }
}

/** (6) Công cụ / lõi đơn TỪ CHỐI đơn của bot. Không ném. */
export async function recordOrderValidationFailure(input: AttemptBase & { reason: OrderValidationReason; fields?: readonly string[] }, now: Date = new Date()): Promise<void> {
  try {
    await audit({
      userId: null,
      userEmail: `agent:${input.agent.source}`,
      actorKind: "AGENT",
      action: ORDER_VALIDATION_FAILED_ACTION,
      entity: ORDER_ATTEMPT_ENTITY,
      entityId: input.orderId ?? input.conversationId,
      correlationId: input.conversationId,
      reason: `${input.agent.name}: ${opsReasonLabel(input.reason)}`,
      detail: { reasonCode: input.reason, tool: input.tool, fields: fieldsOnly(input.fields), channel: input.channel, turn: input.turn, orderId: input.orderId },
    });
    const org = await currentOrganization();
    await noteOrgHealthEvent(org.code, "ORDER_VALIDATION", { level: "WARNING", reason: input.reason, at: now, correlationId: input.conversationId });
  } catch (error) {
    console.error(`[order-signals] ghi tín hiệu đơn không hợp lệ thất bại (${input.tool}/${input.reason}): ${error instanceof Error ? error.message.slice(0, 200) : "lỗi lạ"}`);
  }
}

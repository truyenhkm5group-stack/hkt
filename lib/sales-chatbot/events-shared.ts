/**
 * ═══════════ SỔ SỰ KIỆN HỘI THOẠI BÁN HÀNG — PHẦN THUẦN (0202 · docs/productization/TARGET_ARCHITECTURE.md §5.1) ═══════════
 *
 * Một lượt của bot được đọc thành sự kiện bằng cách SO ẢNH CHỤP TRƯỚC / SAU lượt (trạng thái hội thoại + các tin vừa ghi),
 * không bằng móc rải trong vòng công cụ: lõi hội thoại (`engine.ts`) đổi hằng ngày, và một móc sót là một sự kiện mất im
 * lặng. Hàm ở đây KHÔNG đọc / ghi CSDL — cùng đầu vào luôn ra cùng danh sách (kể cả `key`), nên ghi lại hai lần không đẻ
 * dòng thứ hai (`dedupe_key`).
 *
 * Định nghĩa (không đoán ngoài các định nghĩa này):
 *  · `ai.replied` — lượt có câu gửi khách; `mode` AI (có lời gọi model) · QUICK_REPLY (câu mẫu khớp chữ / AI chọn mã) · SYSTEM
 *    (câu dựng sẵn: ngoài giờ, đang chuyển người, quá trần, AI hỏng). Thời gian phản hồi = mốc tin trả lời − mốc tin khách.
 *  · `quote.given` — công cụ báo giá (get_current_price / calculate_cart) trả kết quả KHÔNG lỗi trong lượt.
 *  · `upsell.offered` — CHỈ đo được khi shop có câu mẫu UPSELL (`state.upsellSent`). Lời mời lẫn trong tin tóm tắt (shop không
 *    có câu mẫu upsell) KHÔNG đo được — chỉ số upsell của shop đó là CHƯA ĐO, không phải 0.
 *  · `upsell.accepted` — sau lời mời, đơn nháp của CÙNG lượt mua TĂNG giá trị trước khi chốt; `amount_vnd` = phần tăng.
 *  · `upsell.declined` — đơn chốt mà lượt mua đã được mời và chưa có `upsell.accepted`.
 *  · `handoff.requested` — hội thoại chuyển sang `HANDOFF` trong lượt; `actor` AI khi model gọi `handoff_to_human`, còn lại SYSTEM.
 */
import type { AiBlock } from "@/lib/ai/provider";
import type { ChatState } from "@/lib/sales-chatbot/tools";

export const SALES_EVENT_TYPES = [
  "conversation.opened",
  "message.received",
  "ai.replied",
  "stage.changed",
  "quote.given",
  "customer.identified",
  "upsell.offered",
  "upsell.accepted",
  "upsell.declined",
  "order.drafted",
  "order.confirmed",
  "appointment.booked",
  "handoff.requested",
  "human.took_over",
  /** Nhân viên trả lời khách TỪ HỘP THƯ ERP — mang users.id (luật 34); trả lời gõ trên Pancake không có danh tính. */
  "human.replied",
  "ai.resumed",
  "followup.sent",
  "conversation.declined",
] as const;
export type SalesEventType = (typeof SALES_EVENT_TYPES)[number];

/** Tên tiếng Việt của từng loại sự kiện cho màn hình — `Record` đủ khoá nên thêm loại mới mà quên tên là lỗi biên dịch. */
export const SALES_EVENT_LABEL: Record<SalesEventType, string> = {
  "conversation.opened": "Mở hội thoại",
  "message.received": "Khách nhắn",
  "ai.replied": "AI trả lời",
  "stage.changed": "Chuyển bước bán hàng",
  "quote.given": "Báo giá",
  "customer.identified": "Có SĐT khách",
  "upsell.offered": "Mời mua thêm",
  "upsell.accepted": "Khách mua thêm",
  "upsell.declined": "Khách không mua thêm",
  "order.drafted": "Lên đơn nháp",
  "order.confirmed": "Chốt đơn",
  "appointment.booked": "Đặt lịch hẹn",
  "handoff.requested": "Chuyển cho nhân viên",
  "human.took_over": "Nhân viên nhận hội thoại",
  "human.replied": "Nhân viên trả lời",
  "ai.resumed": "AI trả lời lại",
  "followup.sent": "Nhắn lại khách",
  "conversation.declined": "Khách không mua",
};

export const SALES_EVENT_ACTORS = ["CUSTOMER", "AI", "HUMAN", "SYSTEM"] as const;
export type SalesEventActor = (typeof SALES_EVENT_ACTORS)[number];

/** Phiên bản ĐỊNH NGHĨA sự kiện (luật 40): đổi cách suy một loại ⇒ tăng số, hai kỳ khác phiên bản không vẽ xu hướng. */
export const SALES_EVENT_SCHEMA_VERSION = 1;

export type SalesEventDraft = {
  type: SalesEventType;
  actorKind: SalesEventActor;
  actorUserId?: string | null;
  occurredAt: Date;
  orderId?: string | null;
  amountVnd?: number | null;
  reasonCode?: string | null;
  payload?: Record<string, unknown>;
  /** Phần riêng của khoá chống trùng — khoá đầy đủ = `<mã hội thoại>:<key>`. */
  key: string;
};

export type TurnSnapshot = {
  status: string;
  handoffReason: string | null;
  state: ChatState;
  /** `seq` lớn nhất của tin trong hội thoại lúc chụp. */
  maxSeq: number;
  turns: number;
  quickReplies: number;
  aiCalls: number;
};

export type TurnMessage = { seq: number; role: "user" | "assistant"; content: AiBlock[]; at: Date };

/** Mã lý do chuyển người — đếm được theo nhóm. Câu gốc vẫn nằm ở `payload.reason`. */
export const HANDOFF_REASON_CODES = [
  "WHOLESALE",
  "OUT_OF_POLICY",
  "COMPLAINT",
  "PRODUCT_UNCLEAR",
  "PRICE_STOCK_ANOMALY",
  "NOT_UNDERSTOOD",
  "CUSTOMER_REQUEST",
  "AFTER_ORDER",
  "AI_DOWN",
  /** Lõi đơn hỏng khi bot ghi khách / đơn (sứ mệnh saas-ops-signals) — KHÁC «AI hỏng»: nhà cung cấp AI vẫn chạy. */
  "ORDER_WRITE_FAILED",
  "TOO_LONG",
  "TOOL_ROUNDS",
  "TOOL_REQUIRES_HUMAN",
  "STAFF_REPLIED",
  /** Nhân viên bấm «Tiếp quản» trong hộp thư — bot im tới khi người trả lại (conversation-control-shared.ts). */
  "STAFF_TOOK_OVER",
  "OTHER",
] as const;
export type HandoffReasonCode = (typeof HANDOFF_REASON_CODES)[number];

export const HANDOFF_REASON_LABEL: Record<HandoffReasonCode, string> = {
  WHOLESALE: "Khách sỉ",
  OUT_OF_POLICY: "Ngoài chính sách",
  COMPLAINT: "Khiếu nại",
  PRODUCT_UNCLEAR: "Không xác định được sản phẩm",
  PRICE_STOCK_ANOMALY: "Giá / tồn bất thường",
  NOT_UNDERSTOOD: "Không hiểu ý khách",
  CUSTOMER_REQUEST: "Khách muốn gặp người",
  AFTER_ORDER: "Khách nhắn sau khi đã chốt",
  AI_DOWN: "AI không trả lời được",
  ORDER_WRITE_FAILED: "Ghi đơn hỏng",
  TOO_LONG: "Hội thoại quá dài",
  TOOL_ROUNDS: "Quá số vòng công cụ",
  TOOL_REQUIRES_HUMAN: "Công cụ thấy bất thường",
  STAFF_REPLIED: "Nhân viên đang trả lời",
  STAFF_TOOK_OVER: "Nhân viên tiếp quản",
  OTHER: "Khác",
};

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Câu lý do (do lời nhắc dặn model mở đầu bằng NHÓM, hoặc do máy chủ đặt) ⇒ mã nhóm. HÀM THUẦN. Thứ tự quan trọng: lý do của
 * máy chủ (AI hỏng, quá dài, sau khi chốt) đứng trước các nhóm của model vì câu của chúng có thể chứa chữ trùng.
 */
export function classifyHandoffReason(reason: string | null | undefined): HandoffReasonCode {
  const r = fold(reason ?? "").trim();
  if (!r) return "OTHER";
  if (r.startsWith("ai tam khong tra loi")) return "AI_DOWN";
  if (r.startsWith("ghi don hong")) return "ORDER_WRITE_FAILED";
  if (r.startsWith("hoi thoai qua dai")) return "TOO_LONG";
  if (r.startsWith("qua so vong cong cu")) return "TOOL_ROUNDS";
  if (r.startsWith("khach nhan sau khi da chot")) return "AFTER_ORDER";
  if (r.startsWith("nhan vien dang tra loi")) return "STAFF_REPLIED";
  if (r.startsWith("nhan vien tiep quan")) return "STAFF_TOOK_OVER";
  if (r.startsWith("can nguoi xu ly")) return "TOOL_REQUIRES_HUMAN";
  if (r.startsWith("khach si")) return "WHOLESALE";
  if (r.startsWith("ngoai chinh sach")) return "OUT_OF_POLICY";
  if (r.startsWith("khieu nai")) return "COMPLAINT";
  if (r.startsWith("khong xac dinh duoc san pham")) return "PRODUCT_UNCLEAR";
  if (r.startsWith("gia / ton") || r.startsWith("gia/ton")) return "PRICE_STOCK_ANOMALY";
  if (r.startsWith("khong hieu y khach")) return "NOT_UNDERSTOOD";
  if (/gap nguoi|gap nhan vien|noi chuyen voi nguoi/.test(r)) return "CUSTOMER_REQUEST";
  return "OTHER";
}

/** Giá trị đơn nháp = Σ đơn giá × số lượng (tiền hàng, chưa ship). `null` khi thiếu đơn giá của dòng nào đó. HÀM THUẦN. */
export function draftValue(draft: ChatState["draft"] | undefined): number | null {
  if (!draft) return null;
  let sum = 0;
  for (const l of draft.lines) {
    const p = draft.unitPrices[l.variantId];
    if (typeof p !== "number" || !Number.isFinite(p)) return null;
    sum += p * l.quantity;
  }
  return Math.round(sum);
}

/** Lượt mua (0 = lượt đầu) — số đơn đã chốt ở các lượt mua TRƯỚC trong hội thoại. */
export function purchaseCycle(state: ChatState): number {
  return state.pastOrders?.length ?? 0;
}

const QUOTE_TOOLS = new Set(["get_current_price", "calculate_cart"]);

function isCustomerText(m: TurnMessage): boolean {
  return m.role === "user" && m.content.length > 0 && m.content.every((b) => b.type === "text");
}

function delivered(content: string): boolean {
  try {
    const d = (JSON.parse(content) as { __deliver?: unknown }).__deliver;
    return typeof d === "string" && d.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Sự kiện của MỘT lượt `chatTurn`. `messages` = các tin có `seq` > `before.maxSeq` (ghi trong lượt), theo `seq` tăng.
 * `acceptedInCycle` = lượt mua này đã có `upsell.accepted` từ trước (người gọi đọc sổ). HÀM THUẦN.
 */
export function deriveTurnEvents(input: { before: TurnSnapshot; after: TurnSnapshot; messages: readonly TurnMessage[]; acceptedInCycle: boolean }): SalesEventDraft[] {
  const { before, after, messages } = input;
  const out: SalesEventDraft[] = [];
  const b = before.state;
  const a = after.state;
  const cycle = purchaseCycle(a);
  const last = messages[messages.length - 1];
  const turnAt = last?.at ?? null;
  if (!turnAt) return out;

  const customer = messages.find(isCustomerText);
  if (customer) {
    if (before.turns === 0) out.push({ type: "conversation.opened", actorKind: "CUSTOMER", occurredAt: customer.at, key: "opened" });
    const chars = customer.content.reduce((n, x) => n + (x.type === "text" ? x.text.length : 0), 0);
    out.push({ type: "message.received", actorKind: "CUSTOMER", occurredAt: customer.at, payload: { chars }, key: `msg:${customer.seq}` });
  }

  // Công cụ được gọi trong lượt (theo thứ tự) + kết quả lỗi / không.
  const toolUses: { id: string; name: string }[] = [];
  const toolOk = new Map<string, { ok: boolean; at: Date }>();
  let deliveredAt: Date | null = null;
  for (const m of messages) {
    for (const x of m.content) {
      if (x.type === "tool_use") toolUses.push({ id: x.id, name: x.name });
      if (x.type === "tool_result") {
        toolOk.set(x.toolUseId, { ok: !x.isError, at: m.at });
        if (!deliveredAt && delivered(x.content)) deliveredAt = m.at;
      }
    }
  }
  const firstText = messages.find((m) => m.role === "assistant" && m.content.some((x) => x.type === "text" && x.text.trim()));
  const replyAt = [firstText?.at, deliveredAt].filter((d): d is Date => d instanceof Date).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
  if (replyAt) {
    const aiCalled = after.aiCalls > before.aiCalls;
    const quick = after.quickReplies > before.quickReplies;
    const mode = toolUses.length || (aiCalled && !quick) ? "AI" : quick ? "QUICK_REPLY" : aiCalled ? "AI" : "SYSTEM";
    out.push({
      type: "ai.replied",
      actorKind: mode === "SYSTEM" ? "SYSTEM" : "AI",
      occurredAt: replyAt,
      payload: { mode, tools: toolUses.map((t) => t.name), ...(customer ? { responseMs: Math.max(0, replyAt.getTime() - customer.at.getTime()) } : {}) },
      key: `reply:${customer?.seq ?? last.seq}`,
    });
  }

  const quote = toolUses.find((t) => QUOTE_TOOLS.has(t.name) && toolOk.get(t.id)?.ok);
  if (quote) out.push({ type: "quote.given", actorKind: "AI", occurredAt: toolOk.get(quote.id)!.at, payload: { tool: quote.name }, key: `quote:${customer?.seq ?? last.seq}` });

  if (a.stage && a.stage !== b.stage) out.push({ type: "stage.changed", actorKind: "AI", occurredAt: turnAt, payload: { from: b.stage ?? null, to: a.stage }, key: `stage:${last.seq}:${a.stage}` });

  if (a.customer?.phone && a.customer.phone !== b.customer?.phone) {
    out.push({ type: "customer.identified", actorKind: "CUSTOMER", occurredAt: turnAt, payload: { savedAddress: Boolean(a.customer.savedAddress), simulated: a.customer.simulated }, key: `customer:${cycle}:${a.customer.phone.slice(-4)}` });
  }

  if (a.upsellSent && !b.upsellSent) out.push({ type: "upsell.offered", actorKind: "AI", occurredAt: turnAt, key: `upsell-offer:${cycle}` });

  // Upsell nhận: đã mời TRƯỚC lượt này, đơn nháp của lượt mua tăng giá trị, chưa chốt trước lượt.
  const vb = draftValue(b.draft);
  const va = draftValue(a.draft);
  let accepted = input.acceptedInCycle;
  if (b.upsellSent && !b.confirmed && b.draft && a.draft && vb !== null && va !== null && va > vb && purchaseCycle(b) === cycle) {
    accepted = true;
    out.push({ type: "upsell.accepted", actorKind: "CUSTOMER", occurredAt: turnAt, orderId: a.draft.orderId, amountVnd: va - vb, payload: { linesBefore: b.draft.lines.length, linesAfter: a.draft.lines.length, simulated: a.draft.simulated }, key: `upsell-accept:${cycle}:${last.seq}` });
  }

  if (a.draft && (a.draft.orderId ? a.draft.orderId !== b.draft?.orderId : !b.draft)) {
    out.push({ type: "order.drafted", actorKind: "AI", occurredAt: turnAt, orderId: a.draft.orderId, amountVnd: va, payload: { simulated: a.draft.simulated, lines: a.draft.lines.length }, key: `draft:${a.draft.orderId ?? `sim:${cycle}:${last.seq}`}` });
  }

  if (a.confirmed && !b.confirmed) {
    out.push({ type: "order.confirmed", actorKind: "CUSTOMER", occurredAt: turnAt, orderId: a.confirmed.orderId, amountVnd: Math.round(a.confirmed.total), payload: { simulated: a.confirmed.simulated, ...(a.confirmed.stamp ? { stamp: a.confirmed.stamp } : {}) }, key: `confirm:${a.confirmed.orderId ?? `sim:${cycle}`}` });
    if (a.upsellSent && !accepted) out.push({ type: "upsell.declined", actorKind: "CUSTOMER", occurredAt: turnAt, key: `upsell-decline:${cycle}` });
  }

  if (a.appointment && !b.appointment) out.push({ type: "appointment.booked", actorKind: "CUSTOMER", occurredAt: turnAt, payload: { simulated: a.appointment.simulated, startsAt: a.appointment.startsAt }, key: `appt:${a.appointment.id ?? `sim:${last.seq}`}` });

  if (after.status === "HANDOFF" && before.status !== "HANDOFF") {
    const byModel = toolUses.some((t) => t.name === "handoff_to_human");
    out.push({ type: "handoff.requested", actorKind: byModel ? "AI" : "SYSTEM", occurredAt: turnAt, reasonCode: classifyHandoffReason(after.handoffReason), payload: { reason: (after.handoffReason ?? "").slice(0, 200) }, key: `handoff:${last.seq}` });
  }

  if (a.declined && !b.declined) out.push({ type: "conversation.declined", actorKind: "CUSTOMER", occurredAt: turnAt, payload: { reason: a.declined.reason.slice(0, 200) }, key: `declined:${cycle}` });

  return out;
}

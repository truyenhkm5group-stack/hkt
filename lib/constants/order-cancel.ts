/**
 * ═══════════ KHÁCH HUỶ ĐƠN — LUẬT THUẦN, CLIENT-SAFE (chủ shop chốt 10/10/2026, thay luật 08/10) ═══════════
 *
 * Sự cố #189A435E (HSLC, 10/10/2026): khách xin huỷ, AI «đồng ý huỷ», khung đơn vẫn «ĐÃ XÁC NHẬN». Luật 08/10 chỉ cho máy GẮN CỜ
 * cần người kiểm; luật mới: khách muốn huỷ ⇒ bot giữ đơn ĐÚNG MỘT lần ⇒ khách vẫn muốn huỷ ⇒ đơn TỰ «Đã huỷ» KHI ĐỦ ĐIỀU KIỆN.
 *
 * «Đủ điều kiện» đi theo VÒNG ĐỜI VẬN ĐƠN, không theo trạng thái đơn (`customerCancelPlan` — một chỗ quyết, bot · đối soát · màn
 * hình đọc chung):
 *  · chưa có lần gửi nào còn giữ đơn ⇒ huỷ ngay;
 *  · có MỘT vận đơn do ERP tạo, hãng chưa cầm hàng, hãng còn cho huỷ ⇒ gọi hãng huỷ — CHỈ coi là huỷ khi hãng xác nhận
 *    (phong bì phản hồi OK, không phải HTTP 200); hãng từ chối / không trả lời ⇒ KHÔNG huỷ đơn, ngoại lệ cho người;
 *  · ĐVVC đã cầm hàng (chặng trong `CARRIER_HANDOFF_STAGES` hoặc mốc lấy hàng — AGENTS mục 41) ⇒ KHÔNG tự huỷ: người chặn giao /
 *    chờ hoàn;
 *  · hàng đã xuất kho tay (phiếu ISSUE trỏ về đơn) mà chưa có chứng cứ bàn giao ⇒ coi như chưa thể tự huỷ, chuyển người;
 *  · lượt tạo vận đơn chưa rõ kết quả, vận đơn không do ERP tạo, nhiều lần gửi cùng giữ đơn ⇒ người.
 *
 * NƠI LƯU: `orders.raw.cancellation` của đơn tay `erp-` (cùng chỗ `raw.review`) — KHÔNG cột mới, KHÔNG migration. Ghi: lý do,
 * `requestedAt`, `cancelledAt`, ai YÊU CẦU (khách / người), ai GHI (AI · người · job — luật 34: người là `users.id`, máy là `null`
 * kèm nhãn), lượt giữ đơn và kết quả, kết cục (đã huỷ / ngoại lệ + mã lý do). Nhật ký và sự kiện `order.cancelled` ghi ở lõi.
 *
 * Huỷ KHÔNG đổi công thức nào: `ORDER_OUTCOME` đã xếp đơn «Đã huỷ» vào `CANCELLED`; khả dụng bán (`RESERVED_IN_WAREHOUSE`) chỉ
 * giữ hàng cho đơn CONFIRMED…SHIPPED ⇒ đơn huỷ tự rời phép trừ — không có bảng giữ chỗ riêng nào để nhả.
 */
import { attemptHoldsOrder } from "@/lib/constants/carrier-vtp";
import { CARRIER_HANDOFF_STAGES } from "@/lib/constants/carrier-handoff";

/** Ai YÊU CẦU huỷ. */
export type CancelRequester = "CUSTOMER" | "HUMAN";
/** Ai GHI lượt huỷ: AI (bot bán hàng) · người (users.id) · job đối soát. Máy luôn `userId = null` (luật 34, 36). */
export type CancelActorKind = "AI" | "HUMAN" | "SYSTEM";
export type CancelActor = { kind: CancelActorKind; userId: string | null; name: string };

/** Kết quả lượt giữ đơn: chưa xong · khách đồng ý giữ · khách vẫn huỷ · không có lượt giữ (người huỷ tay, đối soát lịch sử). */
export const RESCUE_RESULTS = ["PENDING", "SUCCEEDED", "FAILED", "NOT_ATTEMPTED"] as const;
export type RescueResult = (typeof RESCUE_RESULTS)[number];
export const RESCUE_RESULT_LABEL: Record<RescueResult, string> = {
  PENDING: "Đang giữ đơn",
  SUCCEEDED: "Giữ đơn thành công — khách không huỷ",
  FAILED: "Giữ đơn không được — khách vẫn huỷ",
  NOT_ATTEMPTED: "Không có lượt giữ đơn",
};

/**
 * Vì sao máy KHÔNG tự huỷ được — mỗi mã một việc khác cho người. Bốn mã cuối sinh ra SAU khi đã thử (hãng / CSDL), các mã đầu
 * sinh ra từ vòng đời vận đơn trước khi gọi ai.
 */
export const CANCEL_BLOCK_CODES = [
  "NOT_ERP_ORDER",
  "FINAL_STAGE",
  "HANDED_TO_CARRIER",
  "LEFT_WAREHOUSE_NO_HANDOFF",
  "ATTEMPT_UNRESOLVED",
  "FOREIGN_SHIPMENT",
  "MULTIPLE_ATTEMPTS",
  "CARRIER_NOT_CANCELLABLE",
  "AMBIGUOUS_ORDER",
  "CARRIER_REJECTED",
  "CARRIER_UNKNOWN",
  "CARRIER_UNAVAILABLE",
  "WRITE_FAILED",
] as const;
export type CancelBlockCode = (typeof CANCEL_BLOCK_CODES)[number];

export const CANCEL_BLOCK_LABEL: Record<CancelBlockCode, string> = {
  NOT_ERP_ORDER: "Đơn đồng bộ từ nguồn khác — huỷ ở nguồn",
  FINAL_STAGE: "Đơn đã giao / đã hoàn / đã xoá — không huỷ được",
  HANDED_TO_CARRIER: "Đơn vị vận chuyển đã lấy hàng — chặn giao / chờ hoàn",
  LEFT_WAREHOUSE_NO_HANDOFF: "Hàng đã xuất kho nhưng chưa có chứng cứ bàn giao — người kiểm",
  ATTEMPT_UNRESOLVED: "Lượt tạo vận đơn chưa rõ kết quả — tra trên trang hãng",
  FOREIGN_SHIPMENT: "Vận đơn không do ERP tạo — huỷ ở nơi đã tạo",
  MULTIPLE_ATTEMPTS: "Nhiều lần gửi cùng còn hiệu lực — người xác định",
  CARRIER_NOT_CANCELLABLE: "Hãng không còn cho huỷ vận đơn này",
  AMBIGUOUS_ORDER: "Hội thoại có nhiều đơn đang mở — người xác định đơn khách huỷ",
  CARRIER_REJECTED: "Hãng từ chối huỷ vận đơn",
  CARRIER_UNKNOWN: "Không rõ hãng đã nhận lệnh huỷ chưa",
  CARRIER_UNAVAILABLE: "Chưa gọi được hãng (kết nối chưa bật / lỗi)",
  WRITE_FAILED: "Ghi trạng thái huỷ hỏng sau khi thử lại",
};

/** Việc người phải làm với từng mã — in cạnh lý do. */
export const CANCEL_BLOCK_HINT: Record<CancelBlockCode, string> = {
  NOT_ERP_ORDER: "Huỷ đơn ở Pancake / nguồn đồng bộ.",
  FINAL_STAGE: "Đọc lại hội thoại — đơn đã khép, xử lý như đổi trả.",
  HANDED_TO_CARRIER: "Báo hãng chặn giao / chuyển hoàn; hàng về kho thì lập phiếu tái nhập.",
  LEFT_WAREHOUSE_NO_HANDOFF: "Kiểm hàng còn ở kho không: còn ⇒ huỷ phiếu xuất rồi «Huỷ đơn»; đã đi ⇒ xử lý như hoàn.",
  ATTEMPT_UNRESOLVED: "Tra trên trang hãng: có vận đơn ⇒ huỷ trên trang hãng; không có ⇒ «Bỏ lượt tạo», rồi «Huỷ đơn».",
  FOREIGN_SHIPMENT: "Huỷ vận đơn ở nơi đã tạo, rồi «Huỷ đơn».",
  MULTIPLE_ATTEMPTS: "Huỷ từng lần gửi ở khung vận đơn, rồi «Huỷ đơn».",
  CARRIER_NOT_CANCELLABLE: "Gọi hãng chặn giao; hãng đã lấy thì xử lý như hoàn.",
  AMBIGUOUS_ORDER: "Hỏi lại khách đơn nào, rồi «Huỷ đơn» đúng đơn đó.",
  CARRIER_REJECTED: "Đọc lời hãng ở nhật ký; huỷ trên trang hãng rồi «Huỷ đơn».",
  CARRIER_UNKNOWN: "Kiểm trên trang hãng trước khi bấm lại — đừng gửi lệnh huỷ hai lần mù.",
  CARRIER_UNAVAILABLE: "Kiểm kết nối hãng ở «Kết nối dữ liệu», rồi huỷ vận đơn + «Huỷ đơn».",
  WRITE_FAILED: "Bấm «Huỷ đơn» trên trang đơn; lỗi lặp lại thì báo kỹ thuật.",
};

/** Giai đoạn đơn còn MỞ — đơn khách có thể đang muốn huỷ. Đơn đồng bộ còn PACKING…SHIPPED (ERP không ghi được ⇒ người). */
export const CANCEL_OPEN_STAGES = ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP", "SHIPPED"] as const;

/** Trần chữ lưu — chặn một hội thoại phình `raw`. */
export const CANCEL_LIMITS = { quoteMax: 300, reasonMax: 300, detailMax: 300 } as const;

export type CancelOutcomeStatus = "CANCELLED" | "EXCEPTION";

/** Lời khai huỷ trên `orders.raw.cancellation`. Mốc ISO; `null` = chưa xảy ra (không phải 0). */
export type OrderCancellation = {
  requestedAt: string | null;
  requestedBy: CancelRequester;
  requestQuote: string | null;
  reason: string;
  conversationId: string | null;
  rescue: { result: RescueResult; attemptedAt: string | null; decidedAt: string | null; quote: string | null };
  status: CancelOutcomeStatus | null;
  cancelledAt: string | null;
  actor: CancelActor | null;
  exception: { code: CancelBlockCode; detail: string; at: string } | null;
  /** Số lượt thực thi (gồm thử lại) — đo idempotent. */
  attempts: number;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);
const clip = (s: string | null | undefined, n: number) => (s ? s.trim().slice(0, n) || null : null);

function parseActor(v: unknown): CancelActor | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (a.kind !== "AI" && a.kind !== "HUMAN" && a.kind !== "SYSTEM") return null;
  return { kind: a.kind, userId: strOrNull(a.userId), name: str(a.name) };
}

/** Lời khai huỷ của một đơn (đọc `orders.raw`); không có / hỏng ⇒ `null`. HÀM THUẦN. */
export function orderCancellationOf(raw: unknown): OrderCancellation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = (raw as Record<string, unknown>).cancellation;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const x = c as Record<string, unknown>;
  const r = (x.rescue && typeof x.rescue === "object" ? x.rescue : {}) as Record<string, unknown>;
  const result = (RESCUE_RESULTS as readonly string[]).includes(str(r.result)) ? (r.result as RescueResult) : "NOT_ATTEMPTED";
  const ex = (x.exception && typeof x.exception === "object" ? x.exception : null) as Record<string, unknown> | null;
  const exCode = ex && (CANCEL_BLOCK_CODES as readonly string[]).includes(str(ex.code)) ? (ex.code as CancelBlockCode) : null;
  return {
    requestedAt: strOrNull(x.requestedAt),
    requestedBy: x.requestedBy === "HUMAN" ? "HUMAN" : "CUSTOMER",
    requestQuote: strOrNull(x.requestQuote),
    reason: str(x.reason),
    conversationId: strOrNull(x.conversationId),
    rescue: { result, attemptedAt: strOrNull(r.attemptedAt), decidedAt: strOrNull(r.decidedAt), quote: strOrNull(r.quote) },
    status: x.status === "CANCELLED" || x.status === "EXCEPTION" ? x.status : null,
    cancelledAt: strOrNull(x.cancelledAt),
    actor: parseActor(x.actor),
    exception: ex && exCode ? { code: exCode, detail: str(ex.detail), at: str(ex.at) } : null,
    attempts: typeof x.attempts === "number" && Number.isInteger(x.attempts) && x.attempts >= 0 ? x.attempts : 0,
  };
}

const empty = (): OrderCancellation => ({
  requestedAt: null,
  requestedBy: "CUSTOMER",
  requestQuote: null,
  reason: "",
  conversationId: null,
  rescue: { result: "NOT_ATTEMPTED", attemptedAt: null, decidedAt: null, quote: null },
  status: null,
  cancelledAt: null,
  actor: null,
  exception: null,
  attempts: 0,
});

const put = (raw: Record<string, unknown>, c: OrderCancellation) => ({ ...raw, cancellation: c });
const same = (a: OrderCancellation | null, b: OrderCancellation) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Khách vừa xin huỷ (bước 1) ⇒ ghi yêu cầu + mở lượt giữ đơn. Yêu cầu đang mở (chưa huỷ, chưa giữ được) ⇒ GIỮ mốc yêu cầu đầu tiên,
 * không ghi lại (tin trùng / webhook trùng không đẻ yêu cầu thứ hai). Yêu cầu cũ đã giữ được (SUCCEEDED) mà khách lại xin huỷ ⇒
 * một yêu cầu MỚI. HÀM THUẦN.
 */
export function withCancelRequest(raw: Record<string, unknown>, req: { at: string; quote: string | null; reason: string; conversationId: string | null; rescue: boolean }): { raw: Record<string, unknown>; changed: boolean } {
  const cur = orderCancellationOf(raw);
  if (cur && cur.requestedAt && cur.status !== "CANCELLED" && cur.rescue.result !== "SUCCEEDED") return { raw, changed: false };
  const next: OrderCancellation = {
    ...empty(),
    requestedAt: req.at,
    requestedBy: "CUSTOMER",
    requestQuote: clip(req.quote, CANCEL_LIMITS.quoteMax),
    reason: clip(req.reason, CANCEL_LIMITS.reasonMax) ?? "Khách huỷ",
    conversationId: req.conversationId,
    rescue: req.rescue ? { result: "PENDING", attemptedAt: req.at, decidedAt: null, quote: null } : { result: "NOT_ATTEMPTED", attemptedAt: null, decidedAt: null, quote: null },
  };
  return { raw: put(raw, next), changed: true };
}

/** Kết quả lượt giữ đơn (khách đồng ý giữ / vẫn huỷ). Chỉ áp lên yêu cầu ĐANG giữ (PENDING); đã quyết ⇒ không đổi. HÀM THUẦN. */
export function withRescueResult(raw: Record<string, unknown>, r: { result: "SUCCEEDED" | "FAILED"; at: string; quote: string | null }): { raw: Record<string, unknown>; changed: boolean } {
  const cur = orderCancellationOf(raw);
  if (!cur || cur.rescue.result !== "PENDING") return { raw, changed: false };
  const next: OrderCancellation = { ...cur, rescue: { ...cur.rescue, result: r.result, decidedAt: r.at, quote: clip(r.quote, CANCEL_LIMITS.quoteMax) } };
  return { raw: put(raw, next), changed: true };
}

/**
 * Kết cục của MỘT lượt thực thi: đã huỷ (mốc + ai ghi) hoặc ngoại lệ (mã + chi tiết). Thiếu lời khai yêu cầu (người huỷ tay, đơn
 * cũ) ⇒ dựng lời khai từ `fallback`. Cùng ngoại lệ (mã + chi tiết) ghi lại ⇒ không đổi gì. HÀM THUẦN.
 */
export function withCancelOutcome(
  raw: Record<string, unknown>,
  o: { status: CancelOutcomeStatus; at: string; actor: CancelActor; exception?: { code: CancelBlockCode; detail: string } | null; fallback?: { requestedBy: CancelRequester; reason: string; quote?: string | null; conversationId?: string | null; rescue?: RescueResult } },
): { raw: Record<string, unknown>; changed: boolean } {
  const cur = orderCancellationOf(raw);
  const base: OrderCancellation = cur ?? {
    ...empty(),
    requestedAt: o.at,
    requestedBy: o.fallback?.requestedBy ?? "HUMAN",
    requestQuote: clip(o.fallback?.quote ?? null, CANCEL_LIMITS.quoteMax),
    reason: clip(o.fallback?.reason ?? "", CANCEL_LIMITS.reasonMax) ?? "",
    conversationId: o.fallback?.conversationId ?? null,
    rescue: { result: o.fallback?.rescue ?? "NOT_ATTEMPTED", attemptedAt: null, decidedAt: null, quote: null },
  };
  if (o.status === "EXCEPTION" && base.status === "EXCEPTION" && base.exception && o.exception && base.exception.code === o.exception.code && base.exception.detail === clip(o.exception.detail, CANCEL_LIMITS.detailMax)) return { raw, changed: false };
  if (o.status === "CANCELLED" && base.status === "CANCELLED") return { raw, changed: false };
  const next: OrderCancellation = {
    ...base,
    reason: base.reason || (clip(o.fallback?.reason ?? "", CANCEL_LIMITS.reasonMax) ?? ""),
    status: o.status,
    cancelledAt: o.status === "CANCELLED" ? o.at : null,
    actor: o.actor,
    exception: o.status === "EXCEPTION" && o.exception ? { code: o.exception.code, detail: clip(o.exception.detail, CANCEL_LIMITS.detailMax) ?? "", at: o.at } : null,
    attempts: base.attempts + 1,
  };
  return same(cur, next) ? { raw, changed: false } : { raw: put(raw, next), changed: true };
}

// ─────────────────────────── VÒNG ĐỜI VẬN ĐƠN → ĐƯỢC TỰ HUỶ KHÔNG ───────────────────────────

/** Một lần gửi của đơn, đủ để quyết — lớp gọi đọc từ `shipments` (+ `CARRIER_HANDOFF_KNOWN_SQL`) và từ adapter của hãng. */
export type CancelAttemptInput = {
  stage: string;
  raw: unknown;
  /** Có chứng cứ bàn giao (mốc lấy hàng / sự kiện chặng đã-cầm-hàng — `CARRIER_HANDOFF_KNOWN_SQL`). */
  handoffKnown: boolean;
  /** Lần gửi do ERP tạo (`raw.carrierCreate`) — chỉ lần đó ERP huỷ được qua adapter. */
  createdByErp: boolean;
  /** Trạng thái lượt tạo (`CREATED` · `REQUESTED` · `UNKNOWN` …); `null` = không do ERP tạo. */
  createState: string | null;
  hasTrackingCode: boolean;
  /** Adapter của hãng nói còn huỷ được (`cancellable` theo chặng / mã của CHÍNH hãng); `null` = không có adapter. */
  carrierCancellable: boolean | null;
};

export type CancelPlanInput = {
  /** Đơn tạo trong ERP (`erp-…` + lời khai gốc đơn tay). */
  manual: boolean;
  stage: string;
  attempts: readonly CancelAttemptInput[];
  /** Số phiếu XUẤT KHO TAY (ISSUE) trỏ về đơn — hàng đã rời kho không qua ĐVVC. */
  manualIssues: number;
};

export type CancelPlan =
  | { kind: "ALREADY_CANCELLED" }
  | { kind: "CANCEL_NOW" }
  | { kind: "CARRIER_CANCEL"; attemptIndex: number }
  | { kind: "NEEDS_HUMAN"; code: CancelBlockCode };

const HANDOFF = new Set<string>(CARRIER_HANDOFF_STAGES);
const MANUAL_CANCELLABLE = new Set(["NEW", "WAITING", "CONFIRMED"]);

/**
 * Được tự huỷ không, và bằng đường nào. HÀM THUẦN — cùng đầu vào ra cùng kết quả; mọi nhánh không chắc rơi về NGƯỜI (AGENTS 31).
 * Thứ tự: đã huỷ ⇒ không làm gì · đơn không phải đơn ERP / đã khép ⇒ người · ĐÃ BÀN GIAO (kể cả lần gửi đã bị huỷ sau khi lấy —
 * hàng có thể đang trên đường về) ⇒ người · hàng xuất kho tay ⇒ người · không lần gửi nào còn giữ đơn ⇒ huỷ ngay · đúng MỘT lần
 * gửi do ERP tạo, có mã, hãng còn cho huỷ ⇒ gọi hãng · còn lại ⇒ người.
 */
export function customerCancelPlan(i: CancelPlanInput): CancelPlan {
  if (i.stage === "CANCELLED") return { kind: "ALREADY_CANCELLED" };
  if (!i.manual) return { kind: "NEEDS_HUMAN", code: "NOT_ERP_ORDER" };
  if (!MANUAL_CANCELLABLE.has(i.stage)) return { kind: "NEEDS_HUMAN", code: "FINAL_STAGE" };
  if (i.attempts.some((a) => a.handoffKnown || HANDOFF.has(a.stage))) return { kind: "NEEDS_HUMAN", code: "HANDED_TO_CARRIER" };
  if (i.manualIssues > 0) return { kind: "NEEDS_HUMAN", code: "LEFT_WAREHOUSE_NO_HANDOFF" };
  const live = i.attempts.map((a, idx) => ({ a, idx })).filter(({ a }) => attemptHoldsOrder({ stage: a.stage, raw: a.raw }));
  if (!live.length) return { kind: "CANCEL_NOW" };
  if (live.length > 1) return { kind: "NEEDS_HUMAN", code: "MULTIPLE_ATTEMPTS" };
  const { a, idx } = live[0];
  if (!a.createdByErp) return { kind: "NEEDS_HUMAN", code: "FOREIGN_SHIPMENT" };
  if (a.createState !== "CREATED" || !a.hasTrackingCode) return { kind: "NEEDS_HUMAN", code: "ATTEMPT_UNRESOLVED" };
  if (a.carrierCancellable !== true) return { kind: "NEEDS_HUMAN", code: "CARRIER_NOT_CANCELLABLE" };
  return { kind: "CARRIER_CANCEL", attemptIndex: idx };
}

/** Câu một dòng cho người đọc (hộp thư · trang đơn · thông báo): «Đã huỷ lúc … · khách yêu cầu · AI ghi». HÀM THUẦN. */
export function cancellationLine(c: OrderCancellation | null): string | null {
  if (!c) return null;
  const who = c.requestedBy === "CUSTOMER" ? "khách yêu cầu" : "người yêu cầu";
  const by = c.actor ? (c.actor.kind === "AI" ? "AI ghi" : c.actor.kind === "SYSTEM" ? "job đối soát ghi" : `${c.actor.name || "nhân viên"} ghi`) : null;
  if (c.status === "CANCELLED") return ["Đã huỷ", who, by, c.reason ? `lý do: ${c.reason}` : null].filter(Boolean).join(" · ");
  if (c.status === "EXCEPTION" && c.exception) return `Khách xin huỷ — máy chưa huỷ: ${CANCEL_BLOCK_LABEL[c.exception.code]}`;
  if (c.rescue.result === "PENDING") return "Khách xin huỷ — đang giữ đơn";
  if (c.rescue.result === "SUCCEEDED") return "Khách xin huỷ rồi đồng ý giữ đơn";
  return null;
}

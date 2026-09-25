/**
 * ═══════════ SẢN XUẤT NỬA ĐẦU: TOPIC → GIÁ THÀNH → MẪU → BẢN DUYỆT → LỆNH SẢN XUẤT ═══════════
 *
 * Hợp đồng: docs/company-os/shared-contracts.md mục 5 · kiến trúc: target-architecture.md Q7, Q8, §4
 * (bước 4–7 của chủ shop: "tạo topic hỏi giá xưởng và trao đổi phương án → chốt phương án, báo giá
 * thành tạm tính và lên mẫu → duyệt mẫu → MKTer lập bảng số lượng, nhập giá tạm tính để tính BCLN").
 *
 * Tệp THUẦN — không đọc/ghi CSDL, client import được. Mọi luật quyết định (bảng chuyển trạng thái,
 * cách tính giá thành, ai được duyệt, khi nào phải ghi lý do, vòng đời mẫu đi theo sự kiện nào) nằm ở
 * đây để giao diện và lõi dịch vụ đọc CÙNG một câu trả lời.
 *
 * ─── BA THỨ BẤT BIẾN ───
 *
 *  · Lượt trao đổi của topic (`production_topic_messages`), lượt duyệt mẫu (`sample_reviews`) và bản
 *    thiết kế đã duyệt (`design_versions`) là APPEND-ONLY: chỉ INSERT, không UPDATE / DELETE ở đâu cả.
 *  · Bảng giá thành `FINAL` không sửa được — muốn đổi thì tạo phiên bản mới; phiên bản cũ vẫn nằm đó.
 *  · Bản thiết kế đã duyệt là ẢNH CHỤP (Q8): sửa mẫu / topic / giá thành về sau KHÔNG đổi nó.
 */
import { MODEL_TRANSITIONS, type ModelState } from "@/lib/constants/model-lifecycle";
import type { WorkStatus } from "@/lib/constants/work";
import type { TopicOpenContext } from "@/lib/constants/early-topic";

// ─────────────────────────── TOPIC HỎI GIÁ / BÀN PHƯƠNG ÁN ───────────────────────────

export const TOPIC_STATUSES = ["WAITING_QUOTE", "DISCUSSING", "OPTIONS_READY", "WAITING_DECISION", "SELECTED", "CLOSED"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = {
  WAITING_QUOTE: "Chờ xưởng báo giá",
  DISCUSSING: "Đang trao đổi",
  OPTIONS_READY: "Đã có phương án",
  WAITING_DECISION: "Chờ quyết định",
  SELECTED: "Đã chốt phương án",
  CLOSED: "Đã đóng",
};

export const TOPIC_STATUS_TONE: Record<TopicStatus, string> = {
  WAITING_QUOTE: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DISCUSSING: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  OPTIONS_READY: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  WAITING_DECISION: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  SELECTED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CLOSED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/**
 * Bảng chuyển trạng thái topic. Trao đổi với xưởng đi tới đi lui là chuyện thường (xưởng báo giá lại,
 * phương án bị gạt), nên các bước giữa mở cho nhau; `SELECTED` chỉ ra `CLOSED` hoặc quay lại bàn
 * (`DISCUSSING`) khi phương án đã chốt đổ vỡ. `CLOSED` mở lại được, nhưng BẮT BUỘC ghi vì sao
 * (`TOPIC_REOPEN_NEEDS_NOTE`).
 */
export const TOPIC_TRANSITIONS: Record<TopicStatus, readonly TopicStatus[]> = {
  WAITING_QUOTE: ["DISCUSSING", "OPTIONS_READY", "WAITING_DECISION", "CLOSED"],
  DISCUSSING: ["WAITING_QUOTE", "OPTIONS_READY", "WAITING_DECISION", "SELECTED", "CLOSED"],
  OPTIONS_READY: ["DISCUSSING", "WAITING_DECISION", "SELECTED", "CLOSED"],
  WAITING_DECISION: ["DISCUSSING", "OPTIONS_READY", "SELECTED", "CLOSED"],
  SELECTED: ["DISCUSSING", "CLOSED"],
  CLOSED: ["DISCUSSING"],
};

/** Trạng thái còn là VIỆC (topic chưa ngã ngũ). `SELECTED` / `CLOSED` rời hàng đợi. */
export const TOPIC_OPEN_STATUSES: readonly TopicStatus[] = ["WAITING_QUOTE", "DISCUSSING", "OPTIONS_READY", "WAITING_DECISION"];

/**
 * Chiếu sang ngôn ngữ chung của hàng đợi (luật 19). Phủ HẾT trạng thái — thiếu một giá trị thì việc
 * rơi âm thầm vào `NEW`.
 *
 *  · `WAITING_QUOTE` ⇒ `WAITING`: đang chờ BÊN NGOÀI (xưởng), người trong shop chỉ giục được.
 *  · `OPTIONS_READY` / `WAITING_DECISION` ⇒ `NEW`: có phương án trên bàn, CẦN MỘT NGƯỜI QUYẾT.
 *  · `DISCUSSING` ⇒ `IN_PROGRESS`.
 */
export const TOPIC_STATUS_TO_WORK: Record<TopicStatus, WorkStatus> = {
  WAITING_QUOTE: "WAITING",
  DISCUSSING: "IN_PROGRESS",
  OPTIONS_READY: "NEW",
  WAITING_DECISION: "NEW",
  SELECTED: "DONE",
  CLOSED: "DONE",
};

export const TOPIC_MESSAGE_KINDS = ["NOTE", "QUOTE", "OPTION", "DECISION"] as const;
export type TopicMessageKind = (typeof TOPIC_MESSAGE_KINDS)[number];
export const TOPIC_MESSAGE_KIND_LABEL: Record<TopicMessageKind, string> = {
  NOTE: "Ghi chú",
  QUOTE: "Báo giá",
  OPTION: "Phương án",
  DECISION: "Quyết định",
};

/**
 * Yêu cầu của topic — điều shop HỎI xưởng. Mọi ô là tuỳ chọn: một topic mở ra lúc chưa biết giá mục
 * tiêu vẫn là một topic hợp lệ; ô trống in "—", không in 0 (mục 42).
 */
export type TopicRequirements = {
  material: string;
  colors: string[];
  sizes: string[];
  trims: string;
  designNotes: string;
  /** Giá mục tiêu mỗi sản phẩm (VND). `null` = chưa đặt. */
  targetPrice: number | null;
  /** Số lượng dự kiến đặt. `null` = chưa đặt. */
  expectedQty: number | null;
  /** Hạn cần hàng `YYYY-MM-DD`. `null` = chưa đặt. */
  deadline: string | null;
};

export const EMPTY_REQUIREMENTS: TopicRequirements = { material: "", colors: [], sizes: [], trims: "", designNotes: "", targetPrice: null, expectedQty: null, deadline: null };

/**
 * ẢNH CHỤP chứng cứ lúc mở topic — số đơn / chi quảng cáo mà người mở topic đang nhìn thấy. Nó KHÔNG
 * được cập nhật về sau: câu hỏi nó trả lời là "lúc quyết đi hỏi giá, mẫu này đang bán thế nào".
 * `null` ở một ô = CHƯA BIẾT (mẫu chưa có sản phẩm Pancake), không phải 0.
 */
export type TopicEvidenceSnapshot = {
  kind: "SNAPSHOT";
  capturedAt: string;
  basis: string;
  productId: string | null;
  orders30d: number | null;
  ordersTotal: number | null;
  adSpend30d: number | null;
  /**
   * Bối cảnh lúc mở (Agent T · topic mở sớm): tín hiệu mẫu + trạng thái khai. Tuỳ chọn — topic mở trước khi
   * có hai trường này KHÔNG được backfill. Kiểu đầy đủ và luật đọc: `lib/constants/early-topic.ts`.
   */
  signalAtOpen?: TopicOpenContext["signalAtOpen"];
  signalErrorAtOpen?: string | null;
  lifecycleAtOpen?: ModelState | null;
};

/** Căn cứ in cạnh ảnh chụp — nói rõ đây là đơn LÊN, không phải đơn giao thành công (ORDER_OUTCOME). */
export const TOPIC_EVIDENCE_BASIS =
  "Ảnh chụp lúc mở topic từ getModelEvidence (lib/queries/models.ts): đơn LÊN 30 ngày / từ trước tới nay (không kể huỷ, xoá — KHÔNG phải đơn giao thành công) và chi quảng cáo 30 ngày gắn thẳng sản phẩm.";

export function buildTopicEvidenceSnapshot(
  ev: { orders30d: number | null; ordersTotal: number | null; adSpend30d: number | null },
  productId: string | null,
  capturedAt: Date,
): TopicEvidenceSnapshot {
  return { kind: "SNAPSHOT", capturedAt: capturedAt.toISOString(), basis: TOPIC_EVIDENCE_BASIS, productId, orders30d: ev.orders30d, ordersTotal: ev.ordersTotal, adSpend30d: ev.adSpend30d };
}

export type TopicTransitionCheck = { ok: true; noop: boolean } | { ok: false; error: string };

/**
 * Kiểm một lượt đổi trạng thái topic.
 *  · cùng trạng thái ⇒ `noop` (bấm hai lần không ghi gì — cùng bài học với AGENTS.md mục 61);
 *  · sang `SELECTED` ⇒ phải nói chốt phương án NÀO;
 *  · mở lại topic đã đóng ⇒ phải ghi vì sao.
 */
export function checkTopicTransition(from: TopicStatus, to: TopicStatus, opts: { selectedOption?: string | null; note?: string | null }): TopicTransitionCheck {
  if (!(TOPIC_STATUSES as readonly string[]).includes(to)) return { ok: false, error: `Trạng thái "${String(to)}" không có` };
  if (from === to) return { ok: true, noop: true };
  if (!TOPIC_TRANSITIONS[from].includes(to)) return { ok: false, error: `Không chuyển được “${TOPIC_STATUS_LABEL[from]}” → “${TOPIC_STATUS_LABEL[to]}”` };
  if (to === "SELECTED" && !(opts.selectedOption ?? "").trim()) return { ok: false, error: "Chốt phương án thì phải ghi phương án được chọn" };
  if (from === "CLOSED" && (opts.note ?? "").trim().length < TOPIC_REOPEN_NOTE_MIN) return { ok: false, error: `Mở lại topic đã đóng phải ghi lý do (ít nhất ${TOPIC_REOPEN_NOTE_MIN} ký tự)` };
  return { ok: true, noop: false };
}

export const TOPIC_REOPEN_NOTE_MIN = 5;

// ─────────────────────────── BẢNG GIÁ THÀNH (PHIÊN BẢN) ───────────────────────────

export const COST_LINE_KINDS = ["FABRIC", "LABOR", "TRIM", "PRINTING", "PACKING", "FACTORY_TRANSPORT", "INBOUND", "WASTAGE", "OTHER"] as const;
export type CostLineKind = (typeof COST_LINE_KINDS)[number];
export const COST_LINE_KIND_LABEL: Record<CostLineKind, string> = {
  FABRIC: "Vải",
  LABOR: "Công may",
  TRIM: "Phụ liệu",
  PRINTING: "In / thêu",
  PACKING: "Đóng gói",
  FACTORY_TRANSPORT: "Vận chuyển từ xưởng",
  INBOUND: "Nhập kho",
  WASTAGE: "Hao hụt",
  OTHER: "Khác",
};

export const COST_SHEET_STATUSES = ["DRAFT", "FINAL"] as const;
export type CostSheetStatus = (typeof COST_SHEET_STATUSES)[number];
export const COST_SHEET_STATUS_LABEL: Record<CostSheetStatus, string> = { DRAFT: "Nháp", FINAL: "Đã chốt" };

/**
 * ĐƠN VỊ PHẦN TRĂM — cách DUY NHẤT để ghi hao hụt theo tỷ lệ.
 *
 * Một dòng có `unit = "%"` (chỉ dòng `WASTAGE` được dùng) thì `qty` là SỐ PHẦN TRĂM và
 * `amount = round(cơ sở × qty / 100)`, với **cơ sở = tổng tiền mọi dòng KHÔNG phải phần trăm** của
 * cùng bảng. Nhiều dòng phần trăm cùng tính trên MỘT cơ sở (không lãi kép), để thứ tự dòng không đổi
 * kết quả. Dòng thường: `amount = round(qty × unit_cost)`.
 */
export const PERCENT_UNIT = "%";

export type CostLineInput = { kind: CostLineKind; description: string; qty: number; unit: string; unitCost: number };
export type CostLineComputed = CostLineInput & { amount: number; isPercent: boolean };

export type CostSheetComputation = { lines: CostLineComputed[]; base: number; percentTotal: number; total: number } | { error: string };

/** Trần hợp lý của một đơn giá / một dòng: chặn gõ thừa ba số 0, không phải ngưỡng nghiệp vụ. */
export const COST_LINE_MAX_VND = 100_000_000;

export function computeCostSheet(lines: readonly CostLineInput[]): CostSheetComputation {
  if (!lines.length) return { error: "Bảng giá thành cần ít nhất một dòng" };
  const out: CostLineComputed[] = [];
  let base = 0;
  for (const [i, l] of lines.entries()) {
    if (!(COST_LINE_KINDS as readonly string[]).includes(l.kind)) return { error: `Dòng ${i + 1}: loại chi phí không hợp lệ` };
    if (!Number.isFinite(l.qty) || l.qty < 0) return { error: `Dòng ${i + 1}: số lượng phải ≥ 0` };
    if (!Number.isInteger(l.unitCost) || l.unitCost < 0 || l.unitCost > COST_LINE_MAX_VND) return { error: `Dòng ${i + 1}: đơn giá là số nguyên VND từ 0` };
    const isPercent = l.unit.trim() === PERCENT_UNIT;
    if (isPercent && l.kind !== "WASTAGE") return { error: `Dòng ${i + 1}: chỉ dòng Hao hụt được tính theo %` };
    if (isPercent && l.qty > 100) return { error: `Dòng ${i + 1}: hao hụt không quá 100%` };
    const amount = isPercent ? 0 : Math.round(l.qty * l.unitCost);
    if (amount > COST_LINE_MAX_VND) return { error: `Dòng ${i + 1}: thành tiền quá lớn — kiểm tra lại số 0` };
    if (!isPercent) base += amount;
    out.push({ ...l, unit: l.unit.trim(), description: l.description.trim(), amount, isPercent });
  }
  let percentTotal = 0;
  for (const l of out) {
    if (!l.isPercent) continue;
    // Phần trăm: đơn giá không có nghĩa, lưu 0 để một con số lạc không bị đọc nhầm là tiền.
    l.unitCost = 0;
    l.amount = Math.round((base * l.qty) / 100);
    percentTotal += l.amount;
  }
  return { lines: out, base, percentTotal, total: base + percentTotal };
}

// ─────────────────────────── MẪU (SAMPLE) & DUYỆT ───────────────────────────

export const SAMPLE_STATUSES = ["IN_PROGRESS", "SUBMITTED", "CHANGES_REQUESTED", "REJECTED", "APPROVED"] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];
export const SAMPLE_STATUS_LABEL: Record<SampleStatus, string> = {
  IN_PROGRESS: "Xưởng đang làm",
  SUBMITTED: "Đã gửi, chờ duyệt",
  CHANGES_REQUESTED: "Yêu cầu sửa",
  REJECTED: "Loại",
  APPROVED: "Đã duyệt",
};
export const SAMPLE_STATUS_TONE: Record<SampleStatus, string> = {
  IN_PROGRESS: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  SUBMITTED: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  CHANGES_REQUESTED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  REJECTED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  APPROVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
};

/** Phiên bản mẫu còn "đang mở": chưa có phán quyết. Mỗi mẫu tối đa MỘT phiên bản mở cùng lúc. */
export const SAMPLE_OPEN_STATUSES: readonly SampleStatus[] = ["IN_PROGRESS", "SUBMITTED"];

export const SAMPLE_REVIEW_DECISIONS = ["REQUEST_CHANGES", "REJECT", "APPROVE"] as const;
export type SampleReviewDecision = (typeof SAMPLE_REVIEW_DECISIONS)[number];
export const SAMPLE_REVIEW_DECISION_LABEL: Record<SampleReviewDecision, string> = { REQUEST_CHANGES: "Yêu cầu sửa", REJECT: "Loại mẫu", APPROVE: "Duyệt mẫu" };

/** Phán quyết ⇒ trạng thái mẫu. Cả ba đều KẾT THÚC phiên bản đó; sửa tiếp là một phiên bản mới. */
export const SAMPLE_STATUS_AFTER: Record<SampleReviewDecision, SampleStatus> = { REQUEST_CHANGES: "CHANGES_REQUESTED", REJECT: "REJECTED", APPROVE: "APPROVED" };

/** Ghi chú ngắn hơn thế này thì xưởng đọc không biết phải sửa gì. */
export const REVIEW_NOTE_MIN = 5;

/**
 * Ai được ghi phán quyết nào (Q7a — cửa người loại (a)).
 *
 *  · `APPROVE` và `REJECT` là QUYẾT ĐỊNH bỏ vốn / bỏ mẫu ⇒ cần `production:approve`.
 *  · `REQUEST_CHANGES` là việc trao đổi thường ngày với xưởng ⇒ `production:write` là đủ.
 *  · Mọi phán quyết mang khoá tài khoản người (mục 34) — không có đường máy.
 *  · `REQUEST_CHANGES` / `REJECT` BẮT BUỘC ghi chú: "yêu cầu sửa" không nói sửa gì thì xưởng không
 *    làm được, "loại" không nói vì sao thì lần sau không ai học được gì.
 */
export function checkSampleReview(input: {
  status: SampleStatus;
  decision: SampleReviewDecision;
  note: string | null | undefined;
  reviewerUserId: string | null;
  canApprove: boolean;
}): { ok: true } | { error: string } {
  if (!(SAMPLE_REVIEW_DECISIONS as readonly string[]).includes(input.decision)) return { error: "Phán quyết không hợp lệ" };
  if (!input.reviewerUserId) return { error: "Duyệt mẫu phải là một người có tài khoản ERP (AGENTS.md mục 34)" };
  if (input.status !== "SUBMITTED") return { error: `Chỉ duyệt được mẫu đang “${SAMPLE_STATUS_LABEL.SUBMITTED}” — mẫu này đang “${SAMPLE_STATUS_LABEL[input.status]}”` };
  if ((input.decision === "APPROVE" || input.decision === "REJECT") && !input.canApprove) return { error: "Duyệt / loại mẫu cần quyền “Sản xuất: duyệt mẫu & chốt giá thành”" };
  if (input.decision !== "APPROVE" && (input.note ?? "").trim().length < REVIEW_NOTE_MIN) {
    return { error: `${SAMPLE_REVIEW_DECISION_LABEL[input.decision]} phải ghi rõ vì sao / sửa gì (ít nhất ${REVIEW_NOTE_MIN} ký tự)` };
  }
  return { ok: true };
}

/** Chốt bảng giá thành cũng là một chữ ký (Q7a): cần `production:approve` và một người thật. */
export function checkCostFinalize(input: { status: CostSheetStatus; finalizerUserId: string | null; canApprove: boolean }): { ok: true } | { error: string } {
  if (!input.finalizerUserId) return { error: "Chốt giá thành phải là một người có tài khoản ERP (AGENTS.md mục 34)" };
  if (!input.canApprove) return { error: "Chốt giá thành cần quyền “Sản xuất: duyệt mẫu & chốt giá thành”" };
  if (input.status !== "DRAFT") return { error: "Bảng này đã chốt — muốn đổi thì tạo phiên bản mới" };
  return { ok: true };
}

/** `SUBMITTED` ⇒ việc chờ duyệt; mọi trạng thái khác rời hàng đợi (hoặc chưa tới lượt duyệt). */
export const SAMPLE_STATUS_TO_WORK: Record<SampleStatus, WorkStatus> = {
  IN_PROGRESS: "WAITING",
  SUBMITTED: "NEW",
  CHANGES_REQUESTED: "DONE",
  REJECTED: "DONE",
  APPROVED: "DONE",
};

// ─────────────────────────── VÒNG ĐỜI MẪU ĐI THEO SỰ KIỆN ───────────────────────────

/**
 * Sự kiện nghiệp vụ của miền này ⇒ trạng thái vòng đời mà NÓ gợi ra (Q3: người đã quyết ở miền này,
 * máy ghi lượt chuyển với `actor_kind = SYSTEM` và trỏ về sự kiện gây ra nó).
 *
 * Chỉ đi theo CẠNH TIẾN có trong `MODEL_TRANSITIONS` tính từ trạng thái HIỆN TẠI. Không phải cạnh tiến
 * (mẫu chưa khai, mẫu đang ở chỗ khác, lùi bước, nhảy cóc) ⇒ KHÔNG chuyển: một hành động ở miền sản
 * xuất không bao giờ tự kéo lùi hay nhảy cóc vòng đời — việc đó cần lý do của người.
 */
export const LIFECYCLE_FOLLOW: Record<string, ModelState> = {
  "production_topic.created": "PRODUCTION_DISCUSSION",
  "costing.version_created": "COSTING",
  "sample.created": "SAMPLING",
  "sample.submitted": "SAMPLE_REVIEW",
  // Yêu cầu sửa: SAMPLE_REVIEW → SAMPLING là cạnh tiến (vòng sửa mẫu) trong sơ đồ §3.
  "sample.reviewed": "SAMPLING",
  "sample.approved": "APPROVED",
  "production_order.linked_design": "PRODUCTION_PLANNING",
};

export function lifecycleTarget(current: ModelState | null, eventName: string): ModelState | null {
  const to = LIFECYCLE_FOLLOW[eventName];
  if (!to || current === null) return null;
  return MODEL_TRANSITIONS[current].includes(to) ? to : null;
}

// ─────────────────────────── LỆNH SẢN XUẤT: GỢI Ý MÁY vs SỐ NGƯỜI CHỐT ───────────────────────────

/** Cờ `settings`: `true` ⇒ chặn gửi xưởng (DRAFT → SENT) lệnh chưa trỏ bản thiết kế đã duyệt. Mặc định TẮT. */
export const REQUIRE_APPROVED_DESIGN_KEY = "production.requireApprovedDesign";

/**
 * Ảnh chụp gợi ý của máy lưu trên lệnh — `buildMatrixForProduct` (lib/queries/production.ts) TÍNH Ở
 * MÁY CHỦ lúc lưu, không nhận từ trình duyệt: gợi ý do client gửi thì một lệnh gửi "gợi ý = số đã
 * chốt" là né được lý do.
 */
export type SuggestedCellsSnapshot = {
  cells: Record<string, number>;
  basis: { source: "buildMatrixForProduct"; coverDays: number; countIncoming: boolean; leadTimeDays: number };
  computedAt: string;
};

export type CellDiff = { key: string; suggested: number; final: number };

/** Ô nào người chốt khác máy gợi ý. Ô vắng mặt = 0. Thứ tự ổn định theo khoá. */
export function diffCells(suggested: Record<string, number>, final: Record<string, number>): CellDiff[] {
  const keys = [...new Set([...Object.keys(suggested), ...Object.keys(final)])].sort();
  const out: CellDiff[] = [];
  for (const key of keys) {
    const s = Math.max(0, Math.round(Number(suggested[key] ?? 0)) || 0);
    const f = Math.max(0, Math.round(Number(final[key] ?? 0)) || 0);
    if (s !== f) out.push({ key, suggested: s, final: f });
  }
  return out;
}

export const OVERRIDE_REASON_MIN = 5;

/**
 * Có phải ghi lý do không — KHÔNG CÓ NGƯỠNG (luật 38: ngưỡng là quyết định kinh doanh, không phải hằng
 * số): chỉ cần MỘT ô khác gợi ý của máy là phải nói vì sao. Không có gợi ý nào (lệnh lập tay, lệnh cũ)
 * ⇒ không có gì để so, không đòi lý do.
 */
export function checkOverride(suggested: Record<string, number> | null, final: Record<string, number>, reason: string | null | undefined): { ok: true; diff: CellDiff[]; reason: string | null } | { error: string; diff: CellDiff[] } {
  if (!suggested) return { ok: true, diff: [], reason: null };
  const diff = diffCells(suggested, final);
  if (!diff.length) return { ok: true, diff, reason: null };
  const r = (reason ?? "").trim();
  if (r.length < OVERRIDE_REASON_MIN) {
    return { error: `Số chốt khác gợi ý của máy ở ${diff.length} ô — ghi lý do (ít nhất ${OVERRIDE_REASON_MIN} ký tự) hoặc điền lại theo đề xuất`, diff };
  }
  return { ok: true, diff, reason: r };
}

/**
 * Gửi xưởng (DRAFT → SENT) một lệnh chưa trỏ bản thiết kế đã duyệt:
 *  · cờ TẮT (mặc định) ⇒ cho qua, nhưng màn hình cảnh báo;
 *  · cờ BẬT ⇒ chặn.
 * Chỉ xét ĐÚNG lượt DRAFT → SENT: lệnh đã gửi / đã nhận từ trước KHÔNG bị đụng tới khi cờ bật (không
 * hồi tố).
 */
export function checkSendWithoutDesign(input: { from: string; to: string; designVersionId: string | null; requireApprovedDesign: boolean }): { ok: true; warn: boolean } | { error: string } {
  if (!(input.from === "DRAFT" && input.to === "SENT")) return { ok: true, warn: false };
  if (input.designVersionId) return { ok: true, warn: false };
  if (input.requireApprovedDesign) return { error: "Shop đang bật luật “lệnh sản xuất phải trỏ bản thiết kế đã duyệt” — chọn bản duyệt trong bảng đặt hàng trước khi gửi xưởng" };
  return { ok: true, warn: true };
}

/** Câu cảnh báo in trên lệnh chưa trỏ bản duyệt — một chỗ để hai màn hình nói cùng một câu. */
export function designWarning(requireApprovedDesign: boolean): string {
  return requireApprovedDesign
    ? "Lệnh này chưa trỏ bản thiết kế đã duyệt — shop đang bật luật bắt buộc, nên KHÔNG gửi xưởng được cho tới khi chọn bản duyệt."
    : "Lệnh này chưa trỏ bản thiết kế đã duyệt. Xưởng sẽ may theo lời dặn chứ không theo một mẫu đã chốt.";
}

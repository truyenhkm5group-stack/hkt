/**
 * ═══════════ SỔ KHAI TÊN SỰ KIỆN (Company OS · `domain_events`) ═══════════
 *
 * Hợp đồng: docs/company-os/shared-contracts.md mục 2. Tệp THUẦN — client import được.
 *
 * Mỗi tên sự kiện được phát ở đâu đó phải có ĐÚNG MỘT dòng ở đây, và dòng đó nói thật:
 *
 *  · `LIVE`     ⇒ `emitter` là đường dẫn tệp CÓ THẬT chứa lời gọi phát tên đó. Bài kiểm mở từng tệp.
 *  · `RESERVED` ⇒ tên đã cấp cho một agent nhưng CHƯA được phát ở đâu cả (`emitter = null`). Agent chủ
 *    tên chuyển nó sang `LIVE` trong CHÍNH PR bắt đầu phát nó.
 *
 * `emitDomainEvent` ném lỗi với tên không có trong sổ — đó là lỗi lập trình, không phải lỗi dữ liệu:
 * một tên gõ sai một ký tự sẽ lặng lẽ thành một dòng thời gian không ai đọc tới.
 *
 * ─── SỔ NÀY CHỈ CHO MIỀN MỚI (target-architecture.md Q5) ───
 *
 * Đơn, vận đơn, hoàn, phiếu kho đã có nhật ký riêng, append-only, có khoá. Chép chúng sang đây là tạo
 * bản thứ hai phải giữ đồng bộ (luật 19). Dòng thời gian mẫu CHIẾU các nhật ký ấy lúc đọc
 * (`lib/queries/models.ts::getModelTimeline`). Và không phát sự kiện trong giao dịch của webhook
 * Pancake / Viettel Post hay job đồng bộ nóng (luật 51: một lệnh lỗi huỷ cả giao dịch vá vận đơn).
 */

/** Ai gây ra sự kiện. `USER` bắt buộc có `actor_id` (CHECK ở CSDL — AGENTS.md mục 34). */
export const DOMAIN_ACTOR_KINDS = ["USER", "SYSTEM", "AGENT", "WEBHOOK"] as const;
export type DomainActorKind = (typeof DOMAIN_ACTOR_KINDS)[number];

export const DOMAIN_ACTOR_KIND_LABEL: Record<DomainActorKind, string> = {
  USER: "Người",
  SYSTEM: "Máy (luật)",
  AGENT: "Agent AI",
  WEBHOOK: "Webhook",
};

/** Cùng biểu thức với CHECK `domain_events_name_check` của migration 0131. */
export const DOMAIN_EVENT_NAME_PATTERN = /^[a-z_]+(\.[a-z_]+)+$/;

export type DomainEventOwner = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export type DomainEventSpec = {
  name: string;
  /** `subject_type` bắt buộc của sự kiện này — `emitDomainEvent` từ chối subject khác. */
  subjectType: string;
  owner: DomainEventOwner;
  status: "LIVE" | "RESERVED";
  /** Tệp phát sự kiện (khi `LIVE`). */
  emitter: string | null;
  why: string;
};

/** Subject của mọi sự kiện `model.*`. */
export const MODEL_SUBJECT = "product_model";

/** Tệp lõi dịch vụ của sổ mẫu — nơi DUY NHẤT phát `model.*`. */
const MODEL_EMITTER = "lib/models/service.ts";

export const DOMAIN_EVENTS = [
  // ─── Agent A · sổ mẫu (LIVE ở Wave 1) ───
  {
    name: "model.registered",
    subjectType: MODEL_SUBJECT,
    owner: "A",
    status: "LIVE",
    emitter: MODEL_EMITTER,
    why: "Một mẫu vào sổ danh tính — do job đồng bộ sổ (từ sản phẩm Pancake / thiết kế TK) hoặc do người gõ mã mẫu mới.",
  },
  {
    name: "model.linked",
    subjectType: MODEL_SUBJECT,
    owner: "A",
    status: "LIVE",
    emitter: MODEL_EMITTER,
    why: "Một mẫu đã có trong sổ được nối thêm sản phẩm Pancake hoặc thiết kế có ĐÚNG mã của nó (đúng một khớp — luật 35).",
  },
  {
    name: "model.state_changed",
    subjectType: MODEL_SUBJECT,
    owner: "A",
    status: "LIVE",
    emitter: MODEL_EMITTER,
    why: "Trạng thái vòng đời KHAI đổi — đi kèm đúng một dòng product_model_state_history trong cùng giao dịch.",
  },
  {
    name: "model.owner_changed",
    subjectType: MODEL_SUBJECT,
    owner: "A",
    status: "LIVE",
    emitter: MODEL_EMITTER,
    why: "Người phụ trách mẫu đổi — do người chọn, không bao giờ do máy suy.",
  },

  // ─── Agent C · sản xuất nửa đầu (Wave 2) ───
  { name: "production_topic.created", subjectType: "production_topic", owner: "C", status: "RESERVED", emitter: null, why: "Mở chủ đề hỏi giá / bàn phương án với xưởng cho một mẫu." },
  { name: "production_topic.status_changed", subjectType: "production_topic", owner: "C", status: "RESERVED", emitter: null, why: "Chủ đề sản xuất đổi trạng thái." },
  { name: "production_topic.message_added", subjectType: "production_topic", owner: "C", status: "RESERVED", emitter: null, why: "Thêm một lượt trao đổi vào chủ đề sản xuất (append-only)." },
  { name: "costing.version_created", subjectType: "cost_sheet", owner: "C", status: "RESERVED", emitter: null, why: "Một phiên bản bảng giá thành mới cho mẫu." },
  { name: "costing.finalized", subjectType: "cost_sheet", owner: "C", status: "RESERVED", emitter: null, why: "Chốt bảng giá thành — phiên bản FINAL bất biến." },
  { name: "sample.created", subjectType: "sample", owner: "C", status: "RESERVED", emitter: null, why: "Xưởng làm một phiên bản mẫu mới." },
  { name: "sample.reviewed", subjectType: "sample", owner: "C", status: "RESERVED", emitter: null, why: "Người duyệt ghi nhận xét một phiên bản mẫu (yêu cầu sửa / loại / duyệt)." },
  { name: "sample.approved", subjectType: "sample", owner: "C", status: "RESERVED", emitter: null, why: "Mẫu được duyệt — có thể đưa vòng đời sang APPROVED qua transitionModelCore." },
  { name: "design_version.approved", subjectType: "design_version", owner: "C", status: "RESERVED", emitter: null, why: "Ảnh chụp thiết kế bất biến được duyệt để lệnh sản xuất trỏ vào." },
  { name: "production_order.linked_design", subjectType: "production_order", owner: "C", status: "RESERVED", emitter: null, why: "Lệnh sản xuất được nối vào một bản thiết kế đã duyệt." },
  { name: "production_plan.overridden", subjectType: "production_order", owner: "C", status: "RESERVED", emitter: null, why: "Người chốt số khác gợi ý của máy, kèm lý do." },

  // ─── Agent D / E / G / H ───
  { name: "stock_receipt.linked_production", subjectType: "stock_receipt", owner: "D", status: "RESERVED", emitter: null, why: "Phiếu nhập kho được nối với lệnh / lô sản xuất (D chỉ thêm cột ở Wave 1)." },
  { name: "return.disposition_set", subjectType: "return_inspection", owner: "E", status: "RESERVED", emitter: null, why: "Kết quả xử lý hàng hoàn: sửa lại / huỷ." },
  { name: "approval.executed", subjectType: "approval_request", owner: "G", status: "RESERVED", emitter: null, why: "Yêu cầu duyệt đã được tiêu thụ đúng một lần." },
  { name: "recommendation.decided", subjectType: "recommendation", owner: "H", status: "RESERVED", emitter: null, why: "Chủ shop chấp nhận / bỏ qua một đề xuất trên cockpit — để đo độ đúng sau này." },
] as const satisfies readonly DomainEventSpec[];

export type DomainEventName = (typeof DOMAIN_EVENTS)[number]["name"];

export const DOMAIN_EVENT_BY_NAME: Readonly<Record<string, DomainEventSpec>> = Object.fromEntries(DOMAIN_EVENTS.map((e) => [e.name, e]));

/** Nhãn tiếng Việt cho dòng thời gian. Tên chưa có nhãn thì in nguyên tên — không giấu. */
export const DOMAIN_EVENT_LABEL: Partial<Record<DomainEventName, string>> = {
  "model.registered": "Vào sổ mẫu",
  "model.linked": "Nối sản phẩm / thiết kế",
  "model.state_changed": "Đổi trạng thái vòng đời",
  "model.owner_changed": "Đổi người phụ trách",
};

export function domainEventLabel(name: string): string {
  return DOMAIN_EVENT_LABEL[name as DomainEventName] ?? name;
}

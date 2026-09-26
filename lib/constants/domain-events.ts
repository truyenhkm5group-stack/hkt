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

/** Cùng biểu thức với CHECK `domain_events_name_check` của migration 0132. */
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

/** Agent C — mỗi miền con một tệp lõi dịch vụ (lib/production/*), mỗi tệp là nơi DUY NHẤT phát tên của nó. */
const C_TOPIC_EMITTER = "lib/production/topics.ts";
const C_COSTING_EMITTER = "lib/production/costing.ts";
const C_SAMPLE_EMITTER = "lib/production/samples.ts";
const C_ORDER_EMITTER = "lib/production/orders.ts";

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
    name: "model.code_assigned",
    subjectType: MODEL_SUBJECT,
    owner: "A",
    status: "LIVE",
    emitter: MODEL_EMITTER,
    why: "Người chốt MÃ CHÍNH THỨC cho một mẫu đang mang mã tạm (mẫu mới test mở topic sản xuất trước khi lên mã — chủ shop 26/09/2026). Đổi mã của chính dòng ấy; mọi thứ gắn theo model_id đi theo.",
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

  // ─── Agent C · sản xuất nửa đầu (Wave 2 — LIVE: lib/production/*) ───
  { name: "production_topic.created", subjectType: "production_topic", owner: "C", status: "LIVE", emitter: C_TOPIC_EMITTER, why: "Mở chủ đề hỏi giá / bàn phương án với xưởng cho một mẫu." },
  { name: "production_topic.status_changed", subjectType: "production_topic", owner: "C", status: "LIVE", emitter: C_TOPIC_EMITTER, why: "Chủ đề sản xuất đổi trạng thái." },
  { name: "production_topic.message_added", subjectType: "production_topic", owner: "C", status: "LIVE", emitter: C_TOPIC_EMITTER, why: "Thêm một lượt trao đổi vào chủ đề sản xuất (append-only)." },
  { name: "costing.version_created", subjectType: "cost_sheet", owner: "C", status: "LIVE", emitter: C_COSTING_EMITTER, why: "Một phiên bản bảng giá thành mới cho mẫu." },
  { name: "costing.finalized", subjectType: "cost_sheet", owner: "C", status: "LIVE", emitter: C_COSTING_EMITTER, why: "Chốt bảng giá thành — phiên bản FINAL bất biến." },
  { name: "sample.created", subjectType: "sample", owner: "C", status: "LIVE", emitter: C_SAMPLE_EMITTER, why: "Xưởng làm một phiên bản mẫu mới." },
  {
    name: "sample.submitted",
    subjectType: "sample",
    owner: "C",
    status: "LIVE",
    emitter: C_SAMPLE_EMITTER,
    why: "Mẫu đã về tay shop, chờ duyệt — là sự kiện GÂY RA lượt chuyển vòng đời SAMPLING → SAMPLE_REVIEW (Q3 cần một sự kiện để trỏ về).",
  },
  { name: "sample.reviewed", subjectType: "sample", owner: "C", status: "LIVE", emitter: C_SAMPLE_EMITTER, why: "Người duyệt ghi nhận xét một phiên bản mẫu (yêu cầu sửa / loại / duyệt)." },
  { name: "sample.approved", subjectType: "sample", owner: "C", status: "LIVE", emitter: C_SAMPLE_EMITTER, why: "Mẫu được duyệt — có thể đưa vòng đời sang APPROVED qua transitionModelCore." },
  { name: "design_version.approved", subjectType: "design_version", owner: "C", status: "LIVE", emitter: C_SAMPLE_EMITTER, why: "Ảnh chụp thiết kế bất biến được duyệt để lệnh sản xuất trỏ vào." },
  { name: "production_order.linked_design", subjectType: "production_order", owner: "C", status: "LIVE", emitter: C_ORDER_EMITTER, why: "Lệnh sản xuất được nối vào một bản thiết kế đã duyệt." },
  { name: "production_plan.overridden", subjectType: "production_order", owner: "C", status: "LIVE", emitter: C_ORDER_EMITTER, why: "Người chốt số khác gợi ý của máy, kèm lý do." },

  // ─── Agent D / E / G / H ───
  // Agent K: LIVE. Phát CÙNG giao dịch với phiếu (lib/inventory/receipt-create.ts); khoá chống trùng = id phiếu; mẫu = mẫu của sản phẩm trong lệnh / lô (NULL khi chưa vào sổ mẫu).
  {
    name: "stock_receipt.linked_production",
    subjectType: "stock_receipt",
    owner: "D",
    status: "LIVE",
    emitter: "lib/inventory/receipt-create.ts",
    why: "Phiếu nhập kho được nối với lệnh / lô sản xuất — hàng của lần đặt xưởng nào đã về kho.",
  },
  // Agent E (0137): LIVE. Một sự kiện cho MỖI dòng sổ `return_dispositions` (khoá chống trùng theo id dòng), phát trong CÙNG giao dịch với dòng sổ và phiếu tái nhập (nếu có).
  { name: "return.disposition_set", subjectType: "return_inspection", owner: "E", status: "LIVE", emitter: "lib/returns/disposition.ts", why: "Kết cục của hàng hoàn không tái nhập: sửa / giặt lại, nhập lại sau sửa, huỷ bỏ, trả xưởng." },
  /*
    Agent U (0144): LIVE. Miền hàng hoàn (chủ E). Subject giữ `return_inspection` theo quy ước của R cho món
    không nhãn: `subject_id = unidentified:<id>` (không bao giờ trùng id phiếu kiểm), `payload.grain =
    "UNIDENTIFIED"`. Phát CÙNG giao dịch với lượt ghi mẫu mã; `model_id` khi sản phẩm của mẫu đã vào sổ mẫu.
    Không phát khi chọn lại đúng mẫu đang có; không phát cho lượt chọn mẫu ngay lúc nhận kiện.
  */
  {
    name: "return.variant_identified",
    subjectType: "return_inspection",
    owner: "E",
    status: "LIVE",
    emitter: "lib/returns/unidentified.ts",
    why: "Người kho xác nhận (hoặc đổi, kèm lý do) mẫu mã của một món hàng hoàn không nhãn sau khi nhận — từ đây món đếm được về mẫu.",
  },
  // Agent K: LIVE. Phát CÙNG giao dịch với lượt ghi trạng thái của yêu cầu (lật EXECUTED, hoặc lượt khẳng định sau khi thao tác xong); khoá chống trùng = id yêu cầu.
  { name: "approval.executed", subjectType: "approval_request", owner: "G", status: "LIVE", emitter: "lib/approvals/service.ts", why: "Yêu cầu duyệt đã được tiêu thụ đúng một lần VÀ thao tác được duyệt đã chạy xong." },
  // Agent H (0139): LIVE. Một sự kiện cho MỖI dòng `recommendation_decisions` (khoá chống trùng theo id dòng), phát trong CÙNG giao dịch với dòng sổ. `subject_id` = khoá nguồn của đề xuất.
  { name: "recommendation.decided", subjectType: "recommendation", owner: "H", status: "LIVE", emitter: "lib/owner-decisions/service.ts", why: "Chủ shop chấp nhận / bỏ qua / hẹn nhắc lại một đề xuất trên cockpit — để đo độ đúng sau này." },
] as const satisfies readonly DomainEventSpec[];

export type DomainEventName = (typeof DOMAIN_EVENTS)[number]["name"];

export const DOMAIN_EVENT_BY_NAME: Readonly<Record<string, DomainEventSpec>> = Object.fromEntries(DOMAIN_EVENTS.map((e) => [e.name, e]));

/** Nhãn tiếng Việt cho dòng thời gian. Tên chưa có nhãn thì in nguyên tên — không giấu. */
export const DOMAIN_EVENT_LABEL: Partial<Record<DomainEventName, string>> = {
  "model.registered": "Vào sổ mẫu",
  "model.linked": "Nối sản phẩm / thiết kế",
  "model.code_assigned": "Chốt mã chính thức",
  "model.state_changed": "Đổi trạng thái vòng đời",
  "model.owner_changed": "Đổi người phụ trách",
  "production_topic.created": "Mở topic sản xuất",
  "production_topic.status_changed": "Topic sản xuất đổi trạng thái",
  "production_topic.message_added": "Trao đổi trong topic sản xuất",
  "costing.version_created": "Phiên bản giá thành mới",
  "costing.finalized": "Chốt giá thành",
  "sample.created": "Mẫu mới",
  "sample.submitted": "Mẫu chờ duyệt",
  "sample.reviewed": "Duyệt mẫu: ghi phán quyết",
  "sample.approved": "Mẫu được duyệt",
  "design_version.approved": "Bản thiết kế đã duyệt",
  "production_order.linked_design": "Lệnh SX trỏ bản duyệt",
  "production_plan.overridden": "Số đặt khác gợi ý máy",
  // Company OS · QA: sự kiện của Agent E đã LIVE mà thiếu nhãn ⇒ dòng thời gian mẫu in mã thô "return.disposition_set".
  "return.disposition_set": "Kết cục hàng hoàn không tái nhập",
  "return.variant_identified": "Kho xác định mẫu mã hàng hoàn không nhãn",
  "recommendation.decided": "Phản ứng với đề xuất trên buồng lái",
  "approval.executed": "Việc đã duyệt được thực hiện",
  "stock_receipt.linked_production": "Phiếu nhập nối lệnh / lô sản xuất",
};

export function domainEventLabel(name: string): string {
  return DOMAIN_EVENT_LABEL[name as DomainEventName] ?? name;
}

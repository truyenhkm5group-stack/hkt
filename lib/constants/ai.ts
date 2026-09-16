/**
 * ───────────── NỀN TẢNG NHÂN SỰ AI — KHAI BÁO DÙNG CHUNG ─────────────
 *
 * Tệp này CHỈ có hằng số và kiểu (client-safe, không đụng CSDL), để cả Server Component,
 * Client Component lẫn kiểm thử đọc chung MỘT bản khai. Nền tảng này dựng cho MỌI nhân sự AI
 * sau này (bán hàng, marketing, vận hành…), nên không có chỗ nào ở đây được nhắc riêng tới
 * nghiệp vụ bán hàng.
 *
 * RANH GIỚI KHÔNG ĐƯỢC XOÁ: ERP là **nguồn sự thật**; AI chỉ là một **người làm việc** đọc ERP
 * qua cổng công cụ. Tuyệt đối không có đường nào để AI trở thành nguồn của sự thật sản phẩm,
 * mẫu mã, giá, khuyến mãi, tồn kho, cước, trạng thái đơn / tiền / vận đơn. Văn bản do mô hình
 * sinh ra KHÔNG BAO GIỜ là một quyết định nghiệp vụ — quyết định nằm ở hàm thuần `decide`,
 * còn mô hình chỉ diễn đạt lại quyết định đó thành câu chữ.
 */

// ───────────────────────── Chế độ vận hành ─────────────────────────

/**
 * Bốn nấc quyền hạn của một nhân sự AI. Nấc càng cao càng tự quyết nhiều.
 * `SHADOW` là nấc DUY NHẤT được phép chạy trên dữ liệu thật ở giai đoạn này.
 */
export const AGENT_MODES = ["OFF", "SHADOW", "COPILOT", "AUTO"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const AGENT_MODE_LABEL: Record<AgentMode, string> = {
  OFF: "Tắt",
  SHADOW: "Chạy ngầm (chỉ gợi ý, không gửi)",
  COPILOT: "Trợ lý (người duyệt từng tin)",
  AUTO: "Tự động (có hạn mức)",
};

export const AGENT_MODE_HINT: Record<AgentMode, string> = {
  OFF: "Không nhận việc, không chạy, không tốn token.",
  SHADOW: "Đọc hội thoại thật, dựng trạng thái và soạn gợi ý để đối chiếu với nhân viên — KHÔNG gửi cho khách.",
  COPILOT: "Soạn sẵn tin, người bấm gửi; mỗi lần gửi là một phiếu duyệt có người ký.",
  AUTO: "Tự gửi trong hạn mức đã khai; ngoài hạn mức vẫn phải chuyển người.",
};

/** Thứ tự quyền hạn: dùng để so sánh "nấc này có đủ cao không", không bao giờ so sánh chuỗi. */
const MODE_RANK: Record<AgentMode, number> = { OFF: 0, SHADOW: 1, COPILOT: 2, AUTO: 3 };

export function modeAtLeast(mode: AgentMode, minimum: AgentMode): boolean {
  return MODE_RANK[mode] >= MODE_RANK[minimum];
}

/**
 * Chế độ mặc định khi CHƯA khai báo gì. Phải là nấc thấp nhất có ích: một lần triển khai lỗi
 * cấu hình không được biến thành một con bot tự nhắn khách.
 */
export const DEFAULT_AGENT_MODE: AgentMode = "SHADOW";

/**
 * Nấc tối đa được phép ở giai đoạn này. Mọi yêu cầu vượt nấc bị hạ xuống đây.
 *
 * 16/09/2026 — NÂNG TỪ `SHADOW` LÊN `COPILOT`, chủ shop phê duyệt tường minh đúng một dòng này.
 *
 * VÌ SAO PHẢI SỬA: trần này là thứ DUY NHẤT chặn đợt thí điểm nấc trợ lý, và nó chặn IM LẶNG.
 * Thao tác ops ghi `ai_agents.mode = 'COPILOT'`, cột ấy đọc ra đúng `COPILOT`, nhưng
 * `effectiveMode()` kẹp xuống `SHADOW` — nút gửi trên `/ai/copilot` tắt, `canSend()` từ chối, và
 * không một dòng nào nói vì sao. Đo trên bản chạy thử 07:34 ngày 16/09: cột COPILOT · không có
 * ghi đè settings · trần SHADOW ⇒ nấc có hiệu lực SHADOW.
 *
 * ĐÂY KHÔNG PHẢI PHÊ DUYỆT `AUTO`, và cấu trúc giữ điều đó chứ không phải lời hứa:
 *
 *   · `AUTO` có thứ hạng 3, trần mới có thứ hạng 2 ⇒ `clampMode("AUTO")` vẫn trả `COPILOT`.
 *     Không cấu hình nào, không câu SQL nào, không dòng `.env` nào với tới nấc máy tự nhắn khách.
 *   · `AI_ALLOW_AUTO_SEND` và `AI_ALLOW_ORDER_CREATE` vẫn ghim `"false"` ở
 *     `docker-compose.staging.yml` cho CẢ `app` LẪN `ingest` — một lớp thứ hai, độc lập, không đi
 *     qua hằng số này.
 *   · Nấc `COPILOT` theo đúng định nghĩa ở `AGENT_MODE_HINT` là "soạn sẵn tin, NGƯỜI bấm gửi":
 *     vẫn cần phiên đăng nhập, quyền `ai:send`, page trong danh sách trắng, và một cú bấm.
 *
 * Quay lại trạng thái chỉ-quan-sát: đổi dòng này về `"SHADOW"`. Nó vẫn là công tắc hẹp nhất trong
 * cả hệ thống.
 */
export const MAX_ALLOWED_MODE: AgentMode = "COPILOT";

export function clampMode(requested: AgentMode, ceiling: AgentMode = MAX_ALLOWED_MODE): AgentMode {
  return MODE_RANK[requested] > MODE_RANK[ceiling] ? ceiling : requested;
}

// ───────────────────────── Vòng đời một lượt chạy ─────────────────────────

export const RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "HANDED_OFF"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  RUNNING: "Đang chạy",
  SUCCEEDED: "Xong",
  FAILED: "Lỗi",
  SKIPPED: "Bỏ qua",
  HANDED_OFF: "Chuyển người",
};

export const RUN_STATUS_TONE: Record<RunStatus, string> = {
  RUNNING: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  SUCCEEDED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  SKIPPED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  HANDED_OFF: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};

export const TASK_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];


export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];


// ───────────────────────── Định tuyến mô hình ─────────────────────────

/**
 * BỐN NẤC XỬ LÝ, leo dần. Nấc rẻ nhất chạy trước; chỉ leo lên khi nấc dưới KHÔNG kết luận được.
 * Leo tới `HUMAN` nghĩa là máy đã hết cách — phải chuyển người, không được đoán bừa.
 */
export const ROUTE_TIERS = ["RULE", "ECONOMY", "STRONG", "HUMAN"] as const;
export type RouteTier = (typeof ROUTE_TIERS)[number];

export const ROUTE_TIER_LABEL: Record<RouteTier, string> = {
  RULE: "Luật / mẫu câu (không tốn token)",
  ECONOMY: "Mô hình rẻ",
  STRONG: "Mô hình mạnh",
  HUMAN: "Chuyển người",
};

/** Lý do leo nấc — ghi vào lượt chạy để đọc lại được vì sao tốn tiền mô hình mạnh. */
export const ESCALATION_REASONS = [
  "RULE_UNSURE",
  "SCHEMA_INVALID",
  "LOW_CONFIDENCE",
  "MODEL_ERROR",
  "MODEL_TIMEOUT",
  "MODEL_NOT_CONFIGURED",
  "POLICY_REQUIRES_HUMAN",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export const ESCALATION_REASON_LABEL: Record<EscalationReason, string> = {
  RULE_UNSURE: "Luật không đủ chắc",
  SCHEMA_INVALID: "Mô hình trả về sai cấu trúc",
  LOW_CONFIDENCE: "Độ tin thấp hơn ngưỡng",
  MODEL_ERROR: "Mô hình báo lỗi",
  MODEL_TIMEOUT: "Mô hình quá thời gian",
  MODEL_NOT_CONFIGURED: "Chưa cấu hình khoá / tên mô hình",
  POLICY_REQUIRES_HUMAN: "Chính sách bắt buộc người quyết",
};

/** Ngưỡng tin cậy để KHÔNG phải leo nấc. Dưới ngưỡng là "chưa chắc", không phải "sai". */
export const CONFIDENCE_FLOOR = { RULE: 0.75, MODEL: 0.6 } as const;

// ───────────────────────── Lỗi ─────────────────────────

export const AI_ERROR_SCOPES = ["WEBHOOK", "INGEST", "PIPELINE", "TOOL", "MODEL", "OUTBOUND"] as const;
export type AiErrorScope = (typeof AI_ERROR_SCOPES)[number];

export const AI_ERROR_SCOPE_LABEL: Record<AiErrorScope, string> = {
  WEBHOOK: "Gói tin vào",
  INGEST: "Nạp hội thoại",
  PIPELINE: "Dây chuyền xử lý",
  TOOL: "Công cụ ERP",
  MODEL: "Nhà cung cấp mô hình",
  OUTBOUND: "Gửi tin ra",
};

// ───────────────────────── Cờ tính năng ─────────────────────────

/**
 * Cờ tính năng đọc từ bảng `settings` (khoá `ai.config`). MẶC ĐỊNH LUÔN LÀ NẤC AN TOÀN:
 * một khoá thiếu, một JSON hỏng, một lần triển khai quên cấu hình đều phải rơi về phía HẸP HƠN.
 */
export const AI_CONFIG_KEY = "ai.config";

export type AiFeatureFlags = {
  /** Tắt tổng: false thì không nhân sự AI nào nhận việc, kể cả đã bật riêng. */
  enabled: boolean;
  /** Cho phép gọi nhà cung cấp mô hình. Tắt = chỉ chạy nấc luật (không tốn tiền). */
  modelCallsEnabled: boolean;
  /** Nạp hội thoại Pancake vào miền bán hàng. */
  ingestEnabled: boolean;
  /** Số lượt chạy tối đa mỗi giờ cho MỌI nhân sự AI (chặn vòng lặp tốn tiền). */
  maxRunsPerHour: number;
  /** Trần chi phí ước tính mỗi ngày (VND). 0 = chưa khai, KHÔNG phải "miễn phí". */
  dailyCostCapVnd: number;
  /** Hội thoại được phép gửi tin thật để kiểm thử vòng khép kín (deterministic, không phải tin AI). */
  testConversationIds: string[];
};

export const DEFAULT_AI_FLAGS: AiFeatureFlags = {
  enabled: true,
  modelCallsEnabled: false,
  ingestEnabled: true,
  maxRunsPerHour: 600,
  dailyCostCapVnd: 0,
  testConversationIds: [],
};


// ───────────────────────── Chặn cứng cấp môi trường ─────────────────────────

/**
 * HAI CÔNG TẮC CHẶN CỨNG, đọc TỪ BIẾN MÔI TRƯỜNG và không có đường nào ghi đè từ CSDL.
 *
 * Vì sao không để chúng trong bảng `settings` như mọi cấu hình khác: `settings` sửa được lúc chạy,
 * từ giao diện, từ ops, từ một câu SQL. Trên một bản chạy thử đang cắm vào page Pancake THẬT, câu
 * hỏi không phải "ai được phép bật" mà là "có tổ hợp cấu hình nào bật nhầm được không". Câu trả
 * lời phải là KHÔNG — và cách duy nhất để nó là không, là đặt công tắc ở nơi chỉ đổi được bằng cách
 * sửa tệp môi trường rồi khởi động lại tiến trình.
 *
 * Hai công tắc này chỉ biết NÓI KHÔNG. Chúng không bao giờ cấp thêm quyền: nấc quyền hạn vẫn phải
 * đủ cao NHƯ CŨ, rồi mới tới lượt chúng có ý kiến.
 */
export type AiHardLimits = {
  /**
   * MÁY TỰ GỬI. false = không có đường nào để một job / bộ lập lịch / dây chuyền tự nhắn khách.
   *
   * Tách hẳn khỏi `allowHumanApprovedSend` bên dưới là việc phải làm trước khi mở nấc COPILOT:
   * một công tắc gộp "cho phép gửi tin" thì lúc bật lên để nhân viên bấm gửi cũng đồng thời mở
   * đường cho máy tự gửi. Hai việc ấy có hai mức rủi ro khác nhau hoàn toàn, nên phải có hai
   * công tắc — và công tắc nguy hiểm hơn phải là công tắc khó bật hơn.
   */
  allowAutoSend: boolean;
  /**
   * NHÂN VIÊN BẤM GỬI. false = kể cả người thật bấm nút cũng không ra được tin nào.
   *
   * Bật cái này KHÔNG bao giờ mở được đường tự gửi: `canSend()` đọc hai cờ ở hai nhánh riêng, và
   * nhánh tự gửi chỉ đọc `allowAutoSend`.
   */
  allowHumanApprovedSend: boolean;
  /** false = KHÔNG tạo / chốt đơn trên POS, bất kể nấc quyền hạn. */
  allowOrderCreate: boolean;
};

/** Mặc định của mặc định: CẤM. Thiếu biến môi trường, gõ sai, tệp .env rỗng — đều ra CẤM. */
export const SAFEST_HARD_LIMITS: AiHardLimits = { allowAutoSend: false, allowHumanApprovedSend: false, allowOrderCreate: false };

export const HARD_LIMIT_LABEL: Record<keyof AiHardLimits, string> = {
  allowAutoSend: "Cho phép MÁY tự gửi tin",
  allowHumanApprovedSend: "Cho phép NHÂN VIÊN bấm gửi tin",
  allowOrderCreate: "Cho phép tạo / chốt đơn",
};

/**
 * AI GỬI, VÀ GỬI THEO ĐƯỜNG NÀO — ba loại, ba mức rủi ro, ba công tắc.
 *
 *   `AUTO`           — máy tự quyết và tự gửi. Nguy hiểm nhất, và là thứ phải luôn TẮT ở giai đoạn
 *                      này. Không phiếu duyệt nào, không người nào đứng giữa.
 *   `HUMAN_APPROVED` — một nhân viên đã ĐỌC câu máy soạn và chủ động bấm gửi. Người chịu trách
 *                      nhiệm là người bấm, và phiếu duyệt mang khoá tài khoản của họ.
 *   `ROUNDTRIP_TEST` — một chuỗi CỐ ĐỊNH, không phải câu của mô hình, gửi tới hội thoại trong danh
 *                      sách trắng để chứng minh đường truyền hai chiều còn sống.
 *
 * Gộp ba loại này vào một cờ `allowCustomerSend` là cách chắc chắn nhất để một ngày nào đó bật nấc
 * COPILOT lên và vô tình mở luôn đường tự gửi.
 */
export const SEND_KINDS = ["AUTO", "HUMAN_APPROVED", "ROUNDTRIP_TEST"] as const;
export type SendKind = (typeof SEND_KINDS)[number];

export const SEND_KIND_LABEL: Record<SendKind, string> = {
  AUTO: "Máy tự gửi",
  HUMAN_APPROVED: "Nhân viên bấm gửi",
  ROUNDTRIP_TEST: "Tin kiểm thử đường truyền",
};

// ───────────────────────── Hiển thị ─────────────────────────

/**
 * Chi phí một lượt chạy. `null` là CHƯA BIẾT (chưa khai đơn giá mô hình) và phải in ra dấu gạch,
 * KHÔNG in ra "0 ₫" — in 0 vào chỗ chưa biết là khẳng định một điều không chứng minh được.
 * Hàm nhận bộ định dạng tiền để tệp này vẫn client-safe và không kéo theo phụ thuộc nào.
 */
export function costLabel(value: number | null | undefined, formatMoney: (n: number) => string): string {
  return value === null || value === undefined ? "—" : formatMoney(value);
}

/**
 * ═══════════ KHUNG LƯU TRỮ THEO LOẠI DỮ LIỆU (docs/legal/DATA_PROCESSING_REGISTER.md §5 · M-RETENTION) ═══════════
 *
 * Một dòng cho mỗi LOẠI dữ liệu: giữ bao lâu, căn cứ, ai quyết, đã quyết chưa. Tệp CHỈ KHAI BÁO — không có job xoá nào
 * đọc nó trong lượt này (job `retention-sweep` là việc sau, và chạy thử trước khi xoá).
 *
 * ─── `null` = CHƯA QUYẾT = KHÔNG XOÁ ───
 * `retentionDays: null` nghĩa là chưa ai có thẩm quyền chốt con số — KHÔNG phải «giữ mãi» như một quyết định, càng không
 * phải «0 ngày». Không có giá trị mặc định ngầm: job xoá tương lai phải đi qua `deletableAfterDays()`, hàm đó trả `null`
 * cho mọi loại chưa quyết ⇒ không xoá. Con số «đề xuất» trong tài liệu (24 tháng, 12 tháng, 10 năm…) nằm ở `proposal`
 * dạng CHỮ để người quyết đọc — không trường số nào được dẫn xuất từ nó.
 *
 * Ai quyết (VIETNAM_LEGAL_COMPLIANCE.md §0): F chủ sở hữu · G luật sư · E kế toán. Hôm nay (09/10/2026) KHÔNG loại nào có
 * con số được F / G / E xác nhận cho thời hạn giữ ⇒ mọi `retentionDays` là `null`. Mốc DUY NHẤT đã được chủ sở hữu quyết và
 * công bố là SÀN giữ dữ liệu khách thuê sau khi hết hạn (`SERVICE_COMMITMENTS.retainAfterExpiryDays`, Điều khoản §7) — đó
 * là «không xoá TRƯỚC N ngày», không phải «xoá SAU N ngày», nên nằm ở trường riêng.
 */
import { SERVICE_COMMITMENTS } from "@/lib/constants/company";

export const RETENTION_CATEGORIES = [
  "CONVERSATIONS",
  "CUSTOMERS_LEADS",
  "AI_CONTEXT",
  "ORDERS",
  "BILLING_INVOICES",
  "LOGS",
  "AUDIT",
  "BACKUPS",
  "OTP_INTENTS",
  "WEBHOOK_EVENTS",
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export const RETENTION_DECIDERS = ["F", "G", "E"] as const;
export type RetentionDecider = (typeof RETENTION_DECIDERS)[number];

/** `UNDECIDED` — chưa có con số được người có thẩm quyền xác nhận. `DECIDED` — có, kèm bằng chứng quyết định. */
export const RETENTION_STATES = ["UNDECIDED", "DECIDED"] as const;
export type RetentionState = (typeof RETENTION_STATES)[number];

export type RetentionRule = {
  category: RetentionCategory;
  label: string;
  /** Tập dữ liệu ở DATA_PROCESSING_REGISTER.md §2. */
  datasets: readonly string[];
  /** Bảng / nơi lưu chính. */
  stores: readonly string[];
  /** Giữ bao nhiêu ngày trong thời gian thuê — `null` = CHƯA QUYẾT (không xoá, không mặc định ngầm). */
  retentionDays: number | null;
  status: RetentionState;
  /** Ai phải quyết con số. */
  decidedBy: readonly RetentionDecider[];
  /** Căn cứ đang được viện dẫn (đề xuất — người quyết chốt). */
  basis: string;
  /** Con số đề xuất ở tài liệu, dạng CHỮ — để đọc, KHÔNG phải để tính. */
  proposal: string | null;
  /** Văn bản quyết định (chỉ khi DECIDED). */
  decisionEvidence: string | null;
  /** LEGAL HOLD — không xoá theo yêu cầu chủ thể vì nghĩa vụ giữ (kế toán / TMĐT / ANM). */
  legalHold: boolean;
  /** Sàn đã công bố: không xoá trước N ngày sau khi khách thuê hết hạn — `null` khi không áp. */
  afterExpiryFloorDays: number | null;
  /** Hệ thống ĐANG làm gì với loại này hôm nay. */
  currentBehaviour: string;
};

const TENANT_FLOOR = SERVICE_COMMITMENTS.retainAfterExpiryDays;

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    category: "CONVERSATIONS",
    label: "Hội thoại, ảnh, câu trả lời AI",
    datasets: ["D4", "D9"],
    stores: ["sales_chat_inbound", "sales_chat_messages", "sales_chat_staff_messages", "sales_chat_staff_images", "sales_copilot_suggestions", "sales_ai_reviews"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F", "G"],
    basis: "Hợp đồng (Điều khoản §7); nguyên tắc xoá khi hết mục đích (Luật 91)",
    proposal: "24 tháng kể từ tin cuối (DATA_PROCESSING_REGISTER.md §5)",
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: TENANT_FLOOR,
    currentBehaviour: "Giữ vô thời hạn; cascade khi xoá hội thoại; không job dọn",
  },
  {
    category: "CUSTOMERS_LEADS",
    label: "Hồ sơ khách, lead, SĐT, địa chỉ, bộ nhớ khách cũ",
    datasets: ["D3", "D5", "D6", "D10", "D17"],
    stores: ["customers", "sales_chat_conversations", "conversation_funnel", "outreach_targets", "wholesale_*"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F", "G"],
    basis: "Hợp đồng mua bán của khách thuê; quyền xoá của chủ thể (NĐ 356)",
    proposal: "Tới khi khách thuê xoá hoặc chủ thể yêu cầu (DATA_PROCESSING_REGISTER.md §5)",
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: TENANT_FLOOR,
    currentBehaviour: "Giữ vô thời hạn; wholesale_* có expires_at cho snapshot; không xoá được theo một chủ thể",
  },
  {
    category: "AI_CONTEXT",
    label: "Ngữ cảnh AI (prompt ghép lúc gọi)",
    datasets: ["D8"],
    stores: ["(không lưu prompt — chỉ token ở platform_ai_usage)", "ai_interactions", "ai_blueprint_drafts"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F", "G"],
    basis: "Luật AI Điều 14 (nhật ký) đối lại tối thiểu hoá — luật sư cân",
    proposal: null,
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: null,
    currentBehaviour: "Prompt bán hàng không lưu; Copilot ERP lưu ai_interactions vô thời hạn; thời gian bên AI giữ: UNKNOWN (X1)",
  },
  {
    category: "ORDERS",
    label: "Đơn hàng và chứng từ giao dịch",
    datasets: ["D7"],
    stores: ["orders", "order_items", "shipments", "domain_events", "sales_conversation_events"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["E", "G"],
    basis: "Nghĩa vụ kế toán / thuế của khách thuê — kế toán xác nhận thời hạn",
    proposal: "Theo luật kế toán của khách thuê; [10] năm nếu luật buộc (DATA_PROCESSING_REGISTER.md §5)",
    decisionEvidence: null,
    legalHold: true,
    afterExpiryFloorDays: TENANT_FLOOR,
    currentBehaviour: "Giữ vô thời hạn",
  },
  {
    category: "BILLING_INVOICES",
    label: "Thanh toán phí thuê bao, hoá đơn, Số dư AI",
    datasets: ["D11"],
    stores: ["platform_invoices", "platform_billing_payments", "platform_payment_intents", "platform_ai_ledger_entries", "platform_subscriptions", "platform_accounts"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["E"],
    basis: "Luật kế toán / thuế — chứng từ của VNX",
    proposal: "10 năm cho chứng từ kế toán — kế toán xác nhận",
    decisionEvidence: null,
    legalHold: true,
    afterExpiryFloorDays: null,
    currentBehaviour: "Sổ cái chỉ ghi thêm; offboard từ chối xoá tổ chức còn dòng tiền",
  },
  {
    category: "LOGS",
    label: "Nhật ký đăng nhập / IP / hệ thống",
    datasets: ["D12"],
    stores: ["audit_logs (LOGIN, không IP)", "Docker logs trên VPS", "platform_signup_attempts.ip_hash"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["G", "F"],
    basis: "NĐ 333 nếu áp cho SaaS B2B (G-5)",
    proposal: "≥ 12 tháng (DATA_PROCESSING_REGISTER.md §5) — chỉ khi G-5 xác nhận NĐ 333 áp",
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: null,
    currentBehaviour: "Không có nhật ký đăng nhập bền vững có IP; throttle chỉ trong bộ nhớ",
  },
  {
    category: "AUDIT",
    label: "Nhật ký kiểm toán",
    datasets: ["D13"],
    stores: ["audit_logs", "platform_audit_log", "work_item_events", "care_case_events"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F", "G"],
    basis: "Trách nhiệm giải trình; Luật ANM",
    proposal: "≥ 24 tháng (DATA_PROCESSING_REGISTER.md §5)",
    decisionEvidence: null,
    legalHold: true,
    afterExpiryFloorDays: null,
    currentBehaviour: "Chỉ ghi thêm, vô thời hạn; platform_audit_log giữ cả khi offboard",
  },
  {
    category: "BACKUPS",
    label: "Bản sao lưu (VPS + Google Drive mã hoá)",
    datasets: ["D16"],
    stores: ["/root/backups (VPS)", "Google Drive gcrypt:", "WAL PITR"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F"],
    basis: "Khôi phục sự cố; xoay vòng theo script — DSR không chạm bản sao (Chính sách §9)",
    proposal: null,
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: null,
    currentBehaviour:
      "Xoay vòng theo scripts/erp-backup.sh + erp-pitr.sh (Chính sách 1.1 §7 công bố hằng ngày 7 ngày · hằng tuần 4 tuần); bản giờ của tổ chức, PITR, bản tay có lịch riêng — thời hạn TỐI ĐA trên mọi bản chưa được chốt thành một con số",
  },
  {
    category: "OTP_INTENTS",
    label: "OTP, ý định thanh toán, token dùng một lần",
    datasets: ["D1", "D12"],
    stores: ["platform_phone_otps", "platform_payment_intents", "user_invites"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F"],
    basis: "Hết mục đích khi hết hạn",
    proposal: "Theo expires_at + 7 ngày (DATA_PROCESSING_REGISTER.md §5)",
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: null,
    currentBehaviour: "Có expires_at nhưng không job xoá",
  },
  {
    category: "WEBHOOK_EVENTS",
    label: "Gói tin webhook thô (payload, header)",
    datasets: ["D12", "D4"],
    stores: ["webhook_events"],
    retentionDays: null,
    status: "UNDECIDED",
    decidedBy: ["F"],
    basis: "Gỡ lỗi / đối chiếu; mang header (user-agent, x-forwarded-for) và nội dung tin",
    proposal: "N ngày (TECH_HANDOFF_LEGAL.md M-RETENTION) — chưa có số",
    decisionEvidence: null,
    legalHold: false,
    afterExpiryFloorDays: null,
    currentBehaviour: "Giữ vô thời hạn",
  },
];

/** Dòng khung của một loại. */
export function retentionRule(category: RetentionCategory): RetentionRule {
  const r = RETENTION_RULES.find((x) => x.category === category);
  if (!r) throw new Error(`Chưa khai khung lưu trữ cho «${category}».`);
  return r;
}

/**
 * Số ngày sau đó một dòng loại này ĐƯỢC PHÉP xoá theo lịch — `null` = không xoá (chưa quyết). Đường DUY NHẤT mà một job xoá
 * tương lai được đọc; không có nhánh «mặc định N ngày».
 */
export function deletableAfterDays(category: RetentionCategory): number | null {
  const r = retentionRule(category);
  if (r.status !== "DECIDED" || r.retentionDays === null) return null;
  return r.retentionDays;
}

/**
 * Yêu cầu XOÁ của một chủ thể (DSR) có được xoá loại này không. LEGAL HOLD ⇒ không xoá — ẩn danh trường không cần cho nghĩa
 * vụ giữ và ghi lý do (docs/legal/DSR_PROCEDURE.md). LEGAL HOLD chặn xoá THEO YÊU CẦU, không chặn xoá theo lịch khi đã có
 * thời hạn được quyết.
 */
export function subjectEraseAllowed(category: RetentionCategory): boolean {
  return !retentionRule(category).legalHold;
}

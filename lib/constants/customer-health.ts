/**
 * ═══════════ SỨC KHOẺ KHÁCH SAAS — MỨC · LÝ DO · NGƯỠNG (CLIENT-SAFE) ═══════════
 *
 * Màn `/platform/customers` (sứ mệnh saas-customer-health, 08/10/2026): người vận hành từng phải mở BA màn (danh sách khách,
 * chi tiết khách, sức khoẻ tổ chức) mới biết một khách có thật sự chạy không. Tệp này khai MỨC, LÝ DO, CHỖ CHƯA ĐO và NGƯỠNG;
 * hàm phân loại THUẦN ở `lib/saas/customer-health.ts`, đường đọc gom (một lượt, chỉ CSDL nhà) ở `lib/saas/customer-signals.ts`.
 *
 * ─── KHÔNG PHẢI ĐIỂM TỔNG ───
 * `docs/productization/11_SAAS_METRICS_SPEC.md` §7 cấm điểm sức khoẻ có TRỌNG SỐ khi chưa có dữ liệu khách rời để kiểm chứng.
 * Đây không phải điểm: mỗi LÝ DO là một sự việc kiểm được (một con số, một mốc, một nguồn có thật), và mức của khách là mức
 * NẶNG NHẤT trong các lý do — không cộng, không trọng số, không xếp hạng khách với nhau.
 *
 * ─── THIẾU DỮ LIỆU KHÔNG BAO GIỜ LÀ «KHOẺ» (luật 39 · 42 · 52) ───
 * Không lý do nào mà còn một tín hiệu BẮT BUỘC chưa đọc được ⇒ «Chưa đủ dữ liệu», không phải «Khoẻ». «Khoẻ» chỉ khi MỌI tín
 * hiệu áp dụng cho sản phẩm khách thuê đều đọc được và không tín hiệu nào chạm ngưỡng.
 *
 * ─── NGƯỠNG LÀ MẶC ĐỊNH KỸ THUẬT — CHỦ SHOP ĐỔI ĐƯỢC ───
 * Đổi = sửa ĐÚNG MỘT chỗ: `CUSTOMER_HEALTH_THRESHOLDS` dưới đây. Ngưỡng nào chủ shop ĐÃ chốt ở nơi khác thì LẤY LẠI từ hằng
 * đang chạy (luật 22 — gõ lại một con số là mở đường cho hai nơi nói hai số): SLO AI bán hàng (`DEFAULT_AI_SALES_SLO`, chủ shop
 * chốt 06/10/2026), luật phiên đăng nhập (`SESSION_ABSOLUTE_DAYS`), ngưỡng cảnh báo dùng của phiên bản giá (đọc theo phiên bản
 * của từng workspace). Ngưỡng ghi «mặc định kỹ thuật» là chỗ chủ shop CHƯA quyết — đặt để màn hình chạy được, đổi khi chủ shop
 * yêu cầu. SLO AI có ghi đè theo tổ chức ở `settings` của CSDL tổ chức; màn danh sách không mở CSDL tổ chức nào nên đọc MẶC ĐỊNH.
 */
import { DEFAULT_AI_SALES_SLO } from "@/lib/constants/ai-sales-slo";
import { SESSION_ABSOLUTE_DAYS } from "@/lib/constants/session";

// ─────────────────────────── Mức ───────────────────────────

export const CUSTOMER_HEALTH_LEVELS = ["CRITICAL", "NEEDS_ATTENTION", "UNKNOWN", "HEALTHY", "INACTIVE"] as const;
export type CustomerHealthLevel = (typeof CUSTOMER_HEALTH_LEVELS)[number];
export type ProblemLevel = "CRITICAL" | "NEEDS_ATTENTION";

export const CUSTOMER_HEALTH_LABEL: Record<CustomerHealthLevel, string> = {
  CRITICAL: "Nguy cấp",
  NEEDS_ATTENTION: "Cần chú ý",
  UNKNOWN: "Chưa đủ dữ liệu",
  HEALTHY: "Khoẻ",
  INACTIVE: "Đã dừng",
};

/** Một câu nghĩa của từng mức — in ở ⓘ của thanh lọc. */
export const CUSTOMER_HEALTH_MEANING: Record<CustomerHealthLevel, string> = {
  CRITICAL: "Sản phẩm đang KHÔNG chạy được cho khách, hoặc tiền / cấp phát đang hỏng — xử lý hôm nay.",
  NEEDS_ATTENTION: "Có dấu hiệu cụ thể cần người xem (lỗi gần đây, không ai đăng nhập, vượt gói, chưa nối kênh…).",
  UNKNOWN: "Không thấy lý do nào, nhưng còn tín hiệu bắt buộc chưa đọc được — KHÔNG phải khoẻ.",
  HEALTHY: "Mọi tín hiệu áp dụng đều đọc được và không tín hiệu nào chạm ngưỡng.",
  INACTIVE: "Tài khoản đóng / tạm dừng, workspace lưu trữ hoặc thuê bao đã dừng do người quyết — không xếp vào sức khoẻ.",
};

/** Thứ tự xếp: nặng trước. */
export const CUSTOMER_HEALTH_RANK: Record<CustomerHealthLevel, number> = { CRITICAL: 0, NEEDS_ATTENTION: 1, UNKNOWN: 2, HEALTHY: 3, INACTIVE: 4 };

/** Mức của một nhóm = mức nặng nhất (INACTIVE chỉ thắng khi mọi phần đều INACTIVE — người gọi lo vế đó). */
export function worstLevel(levels: readonly CustomerHealthLevel[]): CustomerHealthLevel {
  return levels.reduce<CustomerHealthLevel>((w, l) => (CUSTOMER_HEALTH_RANK[l] < CUSTOMER_HEALTH_RANK[w] ? l : w), "INACTIVE");
}

export function isCustomerHealthLevel(v: unknown): v is CustomerHealthLevel {
  return typeof v === "string" && (CUSTOMER_HEALTH_LEVELS as readonly string[]).includes(v);
}

// ─────────────────────────── Lý do ───────────────────────────

type ReasonSpec = { level: ProblemLevel; label: string; source: string };

/**
 * Mỗi lý do: MỨC cố định, NHÃN ngắn, NGUỒN có thật (bảng / hàm) — câu cụ thể (con số, mốc) do hàm phân loại dựng. Không lý do nào
 * dựa trên tiền COD / trạng thái Pancake / thứ suy đoán; lý do về đơn chỉ đọc LỖI GHI ĐƠN (sổ AI), không kết luận kết cục đơn.
 */
export const HEALTH_REASONS = {
  // ── Nguy cấp: sản phẩm không chạy / tiền, cấp phát hỏng.
  WORKSPACE_SETUP_FAILED: { level: "CRITICAL", label: "Dựng workspace hỏng", source: "platform_organizations.status = SETUP_FAILED" },
  PROVISIONING_FAILED: { level: "CRITICAL", label: "Job cấp phát hỏng", source: "platform_provisioning_jobs.status = FAILED" },
  SUBSCRIPTION_EXPIRED: { level: "CRITICAL", label: "Hết hạn — chỉ xem", source: "platform_product_subscriptions + thu phí (effectiveSubscriptionStatus)" },
  AI_OFF: { level: "CRITICAL", label: "AI bị tắt", source: "công tắc AI: platform_settings['platform.ai.enabled'] · platform_organizations.settings.ai.disabled" },
  AI_FAILING: { level: "CRITICAL", label: "AI đang lỗi", source: "platform_ai_usage (sales_chatbot) — cửa sổ + số lượt của SLO AI bán hàng" },
  ORDER_SYNC_FAILING: { level: "CRITICAL", label: "Ghi đơn đang lỗi", source: "platform_ai_usage (ref order-sync:) — cửa sổ + số lượt của SLO AI bán hàng" },
  CHANNEL_LOST: { level: "CRITICAL", label: "Mất kênh bán", source: "platform_tenant_usage_daily.fanpages_active + mốc CHANNEL_CONNECTED + platform_messenger_pages" },
  // ── Cần chú ý: dấu hiệu cụ thể cần người xem.
  PAST_DUE: { level: "NEEDS_ATTENTION", label: "Quá hạn thanh toán", source: "thu phí (billingStanding = OVERDUE)" },
  WORKSPACE_SUSPENDED: { level: "NEEDS_ATTENTION", label: "Workspace đình chỉ", source: "platform_organizations.status = SUSPENDED" },
  NO_WORKSPACE: { level: "NEEDS_ATTENTION", label: "Chưa có workspace", source: "platform_organizations.account_id" },
  NO_SUBSCRIPTION: { level: "NEEDS_ATTENTION", label: "Chưa thuê sản phẩm", source: "platform_product_subscriptions" },
  LOSING_MONEY: { level: "NEEDS_ATTENTION", label: "Đang lỗ gộp", source: "bảng kê nháp kỳ (loadCommercialSnapshot) — khách đã trả tiền" },
  NEVER_LOGGED_IN: { level: "NEEDS_ATTENTION", label: "Chưa ai đăng nhập", source: "platform_identities (chỉ mục đăng nhập)" },
  LOGIN_STALE: { level: "NEEDS_ATTENTION", label: "Không ai đăng nhập", source: "platform_identities.last_used_at + luật phiên SESSION_ABSOLUTE_DAYS" },
  AI_MODULE_OFF: { level: "NEEDS_ATTENTION", label: "Module AI bán hàng tắt", source: "platform_organization_modules (ai_sales)" },
  AI_ERRORS_RECENT: { level: "NEEDS_ATTENTION", label: "AI lỗi gần đây", source: "platform_ai_usage (sales_chatbot) 24 giờ" },
  AI_BLOCKED_QUOTA: { level: "NEEDS_ATTENTION", label: "AI bị chặn vì hạn mức", source: "platform_ai_usage.status = BLOCKED_QUOTA 24 giờ" },
  AI_SILENT: { level: "NEEDS_ATTENTION", label: "Bot im", source: "platform_tenant_usage_daily (tin khách · tin bot theo ngày)" },
  ORDER_SYNC_ERRORS: { level: "NEEDS_ATTENTION", label: "Lỗi ghi đơn", source: "platform_ai_usage (ref order-sync:) 24 giờ" },
  FANPAGE_OFF: { level: "NEEDS_ATTENTION", label: "0 fanpage đang bật", source: "platform_tenant_usage_daily.fanpages_active" },
  NO_CHANNEL: { level: "NEEDS_ATTENTION", label: "Chưa nối kênh bán", source: "platform_tenant_usage_daily.fanpages_active + mốc CHANNEL_CONNECTED" },
  NOT_ACTIVATED: { level: "NEEDS_ATTENTION", label: "Chưa kích hoạt", source: "mốc FIRST_AI_REPLY (platform_org_milestones) + platform_ai_usage 7 ngày" },
  INBOUND_DROP: { level: "NEEDS_ATTENTION", label: "Tin khách dừng", source: "platform_tenant_usage_daily.customer_messages — nền trung vị theo ngày (luật 52)" },
  NO_ACTIVITY: { level: "NEEDS_ATTENTION", label: "Không hoạt động", source: "platform_tenant_usage_daily + platform_ai_usage 7 ngày" },
  USAGE_OVER_LIMIT: { level: "NEEDS_ATTENTION", label: "Vượt hạn mức gói", source: "đồng hồ khách AI (platform_usage_events) / phần vượt ghế — ngưỡng cảnh báo của phiên bản giá" },
  FAIR_USE: { level: "NEEDS_ATTENTION", label: "Vượt fair-use", source: "fairUseVerdict (hội thoại · câu AI) — chỉ nhắc, không thu phí" },
} as const satisfies Record<string, ReasonSpec>;

export type HealthReasonCode = keyof typeof HEALTH_REASONS;

// ─────────────────────────── Chỗ chưa đo (không phải lỗi, không phải «ổn») ───────────────────────────

/**
 * Một tín hiệu BẮT BUỘC không đọc được. Có chỗ chưa đo mà không lý do nào ⇒ «Chưa đủ dữ liệu». `why` nói thiếu đúng cái gì,
 * đủ cụ thể để biết đi đâu sửa (luật 37 · 45).
 */
export const HEALTH_GAPS = {
  LOGIN_UNREADABLE: { label: "Chưa đọc được đăng nhập", why: "Không đọc được chỉ mục đăng nhập platform_identities ở CSDL nhà." },
  LOGIN_BEFORE_INDEX: { label: "Đăng nhập chưa xác định", why: "Workspace có từ trước chỉ mục đăng nhập (#497) và chưa ai đăng nhập lại từ đó — phiên cũ có thể còn hạn, nên vắng dòng chưa chứng minh được gì." },
  NEW_WORKSPACE_PENDING: { label: "Mới tạo — đang thiết lập", why: "Workspace mới tạo, khách chưa xong bước đầu (đăng nhập / nối kênh / AI trả lời khách thật) — còn trong ân hạn trước khi coi là cần chú ý; chưa có chứng cứ khách đã chạy." },
  MODULES_UNREADABLE: { label: "Chưa đọc được module", why: "Không đọc được platform_organization_modules của workspace." },
  MILESTONES_UNREADABLE: { label: "Chưa đọc được mốc kích hoạt", why: "Không đọc được platform_org_milestones — không phân biệt được «chưa từng nối kênh» với «đã mất kênh»." },
  AI_SWITCH_UNREADABLE: { label: "Chưa đọc được công tắc AI", why: "Không đọc được công tắc AI (platform_settings / platform_organizations.settings.ai)." },
  AI_LEDGER_UNREADABLE: { label: "Chưa đọc được sổ AI", why: "Không đọc được sổ AI platform_ai_usage." },
  AI_RUNTIME_LEGACY: { label: "AI chạy runtime cũ", why: "AI bán hàng chạy runtime cũ (chatbot/, container riêng) — runtime đó không ghi sổ AI nền tảng nên lỗi / im của nó không đo được ở đây." },
  USAGE_LEDGER_UNREADABLE: { label: "Chưa đọc được sổ dùng", why: "Không đọc được sổ dùng theo ngày platform_tenant_usage_daily." },
  USAGE_LEDGER_MISSING: { label: "Sổ dùng chưa có ngày nào", why: "Sổ dùng theo ngày chưa chụp workspace này (lượt chụp ké job alerts của nhà) — kênh, tin khách, đơn AI chưa đo." },
  USAGE_LEDGER_STALE: { label: "Sổ dùng cũ", why: "Lần chụp sổ dùng gần nhất đã quá ngưỡng tươi — kênh, tin khách, đơn AI có thể đã khác." },
} as const satisfies Record<string, { label: string; why: string }>;

export type HealthGapCode = keyof typeof HEALTH_GAPS;

// ─────────────────────────── Ngưỡng ───────────────────────────

/**
 * Ngày đầu TRỌN của chỉ mục đăng nhập `platform_identities` (0193, #497 gộp 03/10/2026 20:35 giờ VN). Lấy ngày SAU lượt gộp cho
 * an toàn: «không đăng nhập từ X» với X muộn hơn là một khẳng định YẾU hơn — không bao giờ nói khách bỏ dùng khi họ chỉ đăng nhập
 * trước lúc chỉ mục bắt đầu ghi.
 */
export const IDENTITY_INDEX_SINCE = "2026-10-04";

export const CUSTOMER_HEALTH_THRESHOLDS = {
  /** AI ĐANG LỖI: cửa sổ (phút) — SLO AI bán hàng, chủ shop chốt 06/10/2026. */
  aiFailWindowMinutes: DEFAULT_AI_SALES_SLO.providerWindowMinutes,
  /** … số lượt lỗi / bị chặn trong cửa sổ mà KHÔNG lượt nào thành công sau lỗi cuối — SLO AI bán hàng. */
  aiFailBurst: DEFAULT_AI_SALES_SLO.providerErrorBurst,
  /** BOT IM: một ngày có ≥ chừng này tin khách mà 0 tin bot (trong khi trước đó bot vẫn trả lời) — SLO AI bán hàng. */
  aiSilentMinCustomerMessages: DEFAULT_AI_SALES_SLO.silentMinCustomerMessages,
  /** TIN KHÁCH DỪNG: nền trung vị theo ngày tối thiểu (tin / ngày) — cùng ngưỡng nền «webhook im» của SLO AI bán hàng. */
  inboundBaselineMinPerDay: DEFAULT_AI_SALES_SLO.webhookSilentBaselineMin,
  /** … số ngày tối thiểu trong nền, dưới đó là CHƯA BIẾT (luật 52) — SLO AI bán hàng. */
  inboundBaselineMinDays: DEFAULT_AI_SALES_SLO.webhookBaselineMinDays,
  /** … số ngày gần nhất (gồm hôm nay) phải cùng bằng 0 tin khách. Mặc định kỹ thuật: hôm qua TRỌN ngày + hôm nay. */
  inboundDropDays: 2,
  /**
   * KHÔNG AI ĐĂNG NHẬP: quá chừng này ngày kể từ lần đăng nhập cuối thì MỌI phiên đã hết hạn (trần tuyệt đối của phiên) — chắc
   * chắn không ai đang dùng. Ngắn hơn trần thì người dùng hằng ngày vẫn có thể đang chạy bằng phiên trượt: không kết luận.
   */
  loginStaleDays: SESSION_ABSOLUTE_DAYS,
  /**
   * ÂN HẠN THIẾT LẬP (giờ) sau lúc tạo workspace: chưa đăng nhập / chưa nối kênh / AI chưa trả lời khách thật trong khoảng này là
   * «đang thiết lập» (Chưa đủ dữ liệu), quá khoảng này là «Cần chú ý». Đủ để khách nhận và bấm liên kết kích hoạt. Mặc định kỹ thuật.
   */
  newWorkspaceGraceHours: 24,
  /** AI LỖI GẦN ĐÂY (đã phục hồi): tỷ lệ lỗi 24 giờ (%) từ đó vẫn cần xem. Mặc định kỹ thuật. */
  aiErrorRateAttentionPct: 10,
  /** … mẫu tối thiểu (lượt) để nói về tỷ lệ — dưới mẫu này một lượt lỗi không phải «10%». Mặc định kỹ thuật. */
  aiErrorRateMinSample: 20,
  /** Cửa sổ «không hoạt động» / tổng 7 ngày (ngày). Mặc định kỹ thuật. */
  activityWindowDays: 7,
  /**
   * SỔ DÙNG CÒN TƯƠI (giờ): sổ chụp ké job `alerts` của nhà mỗi `SAAS_SNAPSHOT_JOB_EVERY_MS` (6 giờ, lib/platform/saas-cockpit.ts)
   * ⇒ chấp nhận lỡ MỘT nhịp + 1 giờ dung sai. Bài kiểm khoá liên hệ với nhịp chụp (đổi nhịp mà quên số này là đỏ).
   */
  usageLedgerFreshHours: 13,
  /** Số ngày sổ dùng đọc ngược (đơn AI gần nhất, nền tin khách). */
  usageLookbackDays: 30,
} as const;

export type CustomerHealthThresholds = { -readonly [K in keyof typeof CUSTOMER_HEALTH_THRESHOLDS]: number };

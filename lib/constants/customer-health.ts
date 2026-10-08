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
 * Mỗi lý do: MỨC cố định, NHÃN ngắn, NGUỒN có thật (bảng / hàm — KHÔNG in ra màn hình) — câu cụ thể (con số, mốc) do hàm phân loại
 * dựng bằng chữ thường cho người vận hành. Không lý do nào dựa trên tiền COD / trạng thái Pancake / thứ suy đoán; lý do về đơn chỉ đọc
 * LỖI CỦA LƯỢT AI ĐỌC HỘI THOẠI ĐỂ GHI ĐƠN HỘ (sổ AI), không kết luận kết cục đơn, không gồm lỗi lưu đơn.
 */
export const HEALTH_REASONS = {
  // ── Nguy cấp: sản phẩm không chạy / tiền, cấp phát hỏng.
  WORKSPACE_SETUP_FAILED: { level: "CRITICAL", label: "Dựng workspace hỏng", source: "platform_organizations.status = SETUP_FAILED" },
  PROVISIONING_FAILED: { level: "CRITICAL", label: "Job cấp phát hỏng", source: "platform_provisioning_jobs.status = FAILED" },
  SUBSCRIPTION_EXPIRED: { level: "CRITICAL", label: "Hết hạn — chỉ xem", source: "platform_product_subscriptions + thu phí (effectiveSubscriptionStatus) — chỉ khách ĐÃ TỪNG trả tiền (readEverPaidOrgs); dùng thử hết hạn chưa trả là «Đã dừng»" },
  AI_OFF: { level: "CRITICAL", label: "AI bị tắt", source: "công tắc AI: platform_settings['platform.ai.enabled'] · platform_organizations.settings.ai.disabled" },
  AI_FAILING: { level: "CRITICAL", label: "AI đang lỗi", source: "platform_ai_usage (sales_chatbot, KHÔNG gồm lượt order-sync:) — cửa sổ phút + số lượt của SLO AI bán hàng; mốc phục hồi = lượt trả lời thành công (chatLastOkAt)" },
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
  AI_SILENT: { level: "NEEDS_ATTENTION", label: "Bot im", source: "platform_tenant_usage_daily (tin khách · tin bot theo ngày) · hoặc tin khách trong cửa sổ activityWindowDays mà platform_ai_usage 7 ngày không lượt OK nào (đã từng kích hoạt)" },
  /**
   * Lượt AI ĐỌC HỘI THOẠI ĐỂ GHI ĐƠN HỘ bị lỗi: dòng `platform_ai_usage` ref `order-sync:` trạng thái ERROR — chỉ ghi khi lời gọi nhà
   * cung cấp AI ném lỗi (lib/sales-chatbot/order-sync.ts); dòng OK ghi TRƯỚC khi đọc kết quả / lưu đơn. KHÔNG gồm lỗi lưu đơn · lưu
   * khách · thiếu giá (SKIPPED, không vào sổ) và lượt bị chặn hạn mức — lỗi ghi đơn THẬT là việc của sứ mệnh saas-ops-signals.
   * Mức CẦN CHÚ Ý, không Nguy cấp: sổ AI không mang lớp lỗi nên không biết nhà cung cấp có cần người xử lý không (giám sát cũ
   * `health-shared.ts` chỉ đỏ khi lỗi cần người), và lượt sau tự đọc lại; nhà cung cấp hỏng thật thì «AI đang lỗi» đã Nguy cấp.
   */
  ORDER_SYNC_ERRORS: { level: "NEEDS_ATTENTION", label: "AI ghi đơn hộ lỗi", source: "platform_ai_usage (ref order-sync:, status ERROR) — chỉ lỗi gọi nhà cung cấp AI; không gồm lỗi lưu đơn / lưu khách / thiếu giá (SKIPPED) và lượt bị chặn hạn mức" },
  FANPAGE_OFF: { level: "NEEDS_ATTENTION", label: "0 fanpage đang bật", source: "platform_tenant_usage_daily.fanpages_active" },
  NO_CHANNEL: { level: "NEEDS_ATTENTION", label: "Chưa nối kênh bán", source: "platform_tenant_usage_daily.fanpages_active + mốc CHANNEL_CONNECTED" },
  NOT_ACTIVATED: { level: "NEEDS_ATTENTION", label: "Chưa kích hoạt", source: "mốc FIRST_AI_REPLY (platform_org_milestones) + platform_ai_usage 7 ngày" },
  INBOUND_DROP: { level: "NEEDS_ATTENTION", label: "Tin khách dừng", source: "platform_tenant_usage_daily.customer_messages — nền trung vị theo ngày (luật 52)" },
  NO_ACTIVITY: { level: "NEEDS_ATTENTION", label: "Không hoạt động", source: "platform_tenant_usage_daily + platform_ai_usage 7 ngày" },
  USAGE_NEAR_LIMIT: { level: "NEEDS_ATTENTION", label: "Sắp chạm hạn mức gói", source: "đồng hồ khách AI (platform_usage_events) — mức NOTIFY của ngưỡng cảnh báo phiên bản giá (báo người vận hành)" },
  USAGE_OVER_LIMIT: { level: "NEEDS_ATTENTION", label: "Vượt hạn mức gói", source: "đồng hồ khách AI (platform_usage_events) mức OVERAGE / STRONG / REVIEW / gói không gồm · phần vượt ghế của bảng kê nháp" },
  FAIR_USE: { level: "NEEDS_ATTENTION", label: "Vượt fair-use", source: "fairUseVerdict (hội thoại · câu AI) — chỉ nhắc, không thu phí" },
} as const satisfies Record<string, ReasonSpec>;

export type HealthReasonCode = keyof typeof HEALTH_REASONS;

// ─────────────────────────── Chỗ chưa đo (không phải lỗi, không phải «ổn») ───────────────────────────

/**
 * Một tín hiệu BẮT BUỘC không đọc được / chưa đủ để kết luận. Có chỗ chưa đo mà không lý do nào ⇒ «Chưa đủ dữ liệu». `why` là câu
 * thường cho người vận hành (in ra khối chi tiết); `source` là nguồn kỹ thuật để người sửa mã tra (KHÔNG in ra màn hình) — luật 37 · 45.
 */
export const HEALTH_GAPS = {
  LOGIN_UNREADABLE: { label: "Chưa đọc được đăng nhập", why: "Không đọc được dữ liệu đăng nhập của workspace.", source: "platform_identities (workspaceReach)" },
  LOGIN_BEFORE_INDEX: { label: "Đăng nhập chưa xác định", why: "Workspace có từ trước khi hệ thống bắt đầu ghi lần đăng nhập, và chưa ai đăng nhập lại từ đó — phiên cũ có thể còn hạn nên chưa kết luận được.", source: "platform_identities ghi từ IDENTITY_INDEX_SINCE (#497, 0193)" },
  NEW_WORKSPACE_PENDING: { label: "Mới tạo — đang thiết lập", why: "Workspace mới tạo, khách chưa xong bước đầu (đăng nhập / nối kênh / AI trả lời khách thật) — còn trong ân hạn trước khi coi là cần chú ý; chưa có chứng cứ khách đã chạy.", source: "platform_organizations.created_at + newWorkspaceGraceHours" },
  MODULES_UNREADABLE: { label: "Chưa đọc được module", why: "Không đọc được danh sách module đang bật của workspace.", source: "platform_organization_modules (getEnabledModules)" },
  MILESTONES_UNREADABLE: { label: "Chưa đọc được mốc kích hoạt", why: "Không đọc được các mốc kích hoạt — không phân biệt được «chưa từng nối kênh / chưa kích hoạt» với «đã mất kênh / ngừng chạy».", source: "platform_org_milestones (readMilestones)" },
  AI_SWITCH_UNREADABLE: { label: "Chưa đọc được công tắc AI", why: "Không đọc được công tắc AI của nền tảng hoặc của workspace.", source: "platform_settings['platform.ai.enabled'] · platform_organizations.settings.ai" },
  AI_LEDGER_UNREADABLE: { label: "Chưa đọc được nhật ký lượt AI", why: "Không đọc được nhật ký lượt AI của workspace.", source: "platform_ai_usage (salesAiUsageHealthByOrg)" },
  AI_RUNTIME_LEGACY: { label: "Bot đời cũ", why: "AI bán hàng của workspace chạy bằng bot đời cũ — bot đó không ghi nhật ký lượt AI chung nên lỗi / im của nó không đo được ở đây.", source: "chatbot/ (container riêng) không ghi platform_ai_usage" },
  USAGE_LEDGER_UNREADABLE: { label: "Chưa đọc được sổ dùng", why: "Không đọc được sổ dùng theo ngày.", source: "platform_tenant_usage_daily (readUsageDaily)" },
  USAGE_LEDGER_MISSING: { label: "Sổ dùng chưa có ngày nào", why: "Sổ dùng theo ngày chưa chụp workspace này — kênh, tin khách, đơn AI chưa đo.", source: "platform_tenant_usage_daily — chụp ké job alerts của nhà (captureSaasSnapshot)" },
  USAGE_LEDGER_STALE: { label: "Sổ dùng cũ", why: "Lần chụp sổ dùng gần nhất đã quá ngưỡng tươi — kênh, tin khách, đơn AI có thể đã khác.", source: "platform_tenant_usage_daily.captured_at + usageLedgerFreshHours" },
  INBOUND_BASELINE_SHORT: { label: "Chưa đủ ngày để kết luận tin khách", why: "Không có tin khách những ngày gần nhất nhưng sổ dùng chưa đủ số ngày nền để biết đó là bình thường hay tin đã dừng.", source: "platform_tenant_usage_daily — nền theo ngày tối thiểu inboundBaselineMinDays (luật 52)" },
  ACTIVITY_WINDOW_SHORT: { label: "Chưa đủ ngày để kết luận hoạt động", why: "Không có tin khách và không có lượt AI nào nhưng sổ dùng chưa chụp đủ số ngày để kết luận «không hoạt động».", source: "platform_tenant_usage_daily (activityWindowDays, tối thiểu inboundBaselineMinDays ngày đã chụp) + platform_ai_usage 7 ngày" },
  USAGE_METER_UNMEASURED: { label: "Chưa đo khách AI so với gói", why: "Chưa đếm được khách AI của kỳ hoặc chưa đọc được ngưỡng của bảng giá — chưa biết có sắp chạm / vượt gói không.", source: "platform_usage_events (chotdon.ai_customers, độ phủ NOT_MEASURED) / platform_price_versions.alert_thresholds" },
} as const satisfies Record<string, { label: string; why: string; source: string }>;

export type HealthGapCode = keyof typeof HEALTH_GAPS;

// ─────────────────────────── Ngưỡng ───────────────────────────

/**
 * Ngày đầu TRỌN của chỉ mục đăng nhập `platform_identities` (0193, #497 gộp 03/10/2026 20:35 giờ VN). Lấy ngày SAU lượt gộp cho
 * an toàn: «không đăng nhập từ X» với X muộn hơn là một khẳng định YẾU hơn — không bao giờ nói khách bỏ dùng khi họ chỉ đăng nhập
 * trước lúc chỉ mục bắt đầu ghi.
 */
export const IDENTITY_INDEX_SINCE = "2026-10-04";

/**
 * Nhịp chụp sổ dùng theo ngày (giờ): ké job `alerts` của nhà mỗi `SAAS_SNAPSHOT_JOB_EVERY_MS` (lib/platform/saas-cockpit.ts — tệp
 * máy chủ, không import được vào hằng client-safe). Bài kiểm khoá hai số bằng nhau: đổi nhịp mà quên số này là đỏ (luật 22).
 */
export const USAGE_SNAPSHOT_EVERY_HOURS = 6;

export const CUSTOMER_HEALTH_THRESHOLDS = {
  /** AI ĐANG LỖI: cửa sổ (phút) — SLO AI bán hàng, chủ shop chốt 06/10/2026 (cùng đơn vị: phút). */
  aiFailWindowMinutes: DEFAULT_AI_SALES_SLO.providerWindowMinutes,
  /** … số lượt lỗi / bị chặn trong cửa sổ mà KHÔNG lượt trả lời nào thành công sau lỗi cuối — SLO AI bán hàng (cùng đơn vị: lượt). */
  aiFailBurst: DEFAULT_AI_SALES_SLO.providerErrorBurst,
  /**
   * BOT IM: một NGÀY có ≥ chừng này tin khách mà 0 tin bot (trong khi trước đó bot vẫn trả lời). Mặc định kỹ thuật — SLO AI bán hàng
   * dùng 3 tin / 30 PHÚT cho giám sát thời gian thực; khác đơn vị nên KHÔNG lấy lại số đó.
   */
  aiSilentMinCustomerMessagesPerDay: 3,
  /**
   * TIN KHÁCH DỪNG: nền trung vị tối thiểu (tin / NGÀY) để gọi «0 tin» là bất thường. Mặc định kỹ thuật — SLO «webhook im» dùng 3 tin /
   * GIỜ cùng khung giờ; khác đơn vị nên KHÔNG lấy lại số đó.
   */
  inboundBaselineMinMessagesPerDay: 3,
  /** … số ngày tối thiểu trong nền, dưới đó là CHƯA BIẾT (luật 52) — SLO AI bán hàng (cùng đơn vị: ngày có số liệu). */
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
  /** SỔ DÙNG CÒN TƯƠI (giờ): chấp nhận lỡ MỘT nhịp chụp + 1 giờ dung sai — dẫn xuất từ nhịp chụp, không gõ số. */
  usageLedgerFreshHours: 2 * USAGE_SNAPSHOT_EVERY_HOURS + 1,
  /** Số ngày sổ dùng đọc ngược (đơn AI gần nhất, nền tin khách). */
  usageLookbackDays: 30,
} as const;

export type CustomerHealthThresholds = { -readonly [K in keyof typeof CUSTOMER_HEALTH_THRESHOLDS]: number };

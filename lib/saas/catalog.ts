/**
 * ═══════════ DANH MỤC SẢN PHẨM SAAS — THUẦN, CLIENT-SAFE (docs/saas/README.md §3) ═══════════
 *
 * Product → Capability → Feature → Entitlement. Danh mục là MÃ NGUỒN (có phiên bản cùng mã, như sổ module — P6); cấu hình
 * theo khách (thuê bao, gói, ghi đè) là DỮ LIỆU ở mặt phẳng điều khiển. Thêm sản phẩm thứ ba = thêm MỘT mục vào `PRODUCTS`
 * (khả năng · tính năng · chỉ số dùng · module cần cấp) — không sửa mô hình khách, thuê bao, sổ dùng hay bảng kê
 * (`tests/saas-platform.test.ts::Product03` chứng minh bằng một danh mục thử).
 *
 *  · CAPABILITY = nhóm năng lực bán được, nối vào MODULE đã có (`lib/constants/platform-modules.ts` — module là đơn vị bật/tắt
 *    kỹ thuật, đã có cổng đường dẫn + quyền) và vào TÍNH NĂNG thương mại (`lib/pricing/features.ts`, entitlement theo gói).
 *  · LÕI THƯƠNG MẠI DÙNG CHUNG (`SHARED_COMMERCE_CORE`): khách · sản phẩm · đơn · kho. CHỦ SỞ HỮU là ERP (nguồn sự thật của
 *    sản phẩm, giá, tồn, đơn — docs/saas/OWNERSHIP.md), nhưng sản phẩm khác CẦN nó (Chốt Đơn hỏi tồn, tạo đơn) nên nó được
 *    cấp cùng sản phẩm đó mà KHÔNG làm workspace thành khách thuê ERP. Đó là lý do shop «Chỉ cần AI bán hàng» không bị tính
 *    là khách ERP.
 *  · Khoá sản phẩm, khả năng, chỉ số BẤT BIẾN — chúng nằm trong `platform_product_subscriptions`, `platform_usage_events`,
 *    bảng kê đã chốt. Đổi khoá là làm mồ côi lịch sử (cùng tinh thần luật 37).
 */
import type { FeatureKey } from "@/lib/pricing/features";
import { MODULE_KEYS, type ModuleKey } from "@/lib/constants/platform-modules";

/** Phiên bản HỢP ĐỒNG nền tảng ↔ sản phẩm (`lib/saas/sdk.ts`). Đổi hình dạng hợp đồng ⇒ tăng phiên bản, giữ bản cũ. */
export const SAAS_CONTRACT_VERSION = "v1";

export const PRODUCT_KEYS = ["erp", "chotdon"] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

/**
 * NGUỒN của một chỉ số dùng — mỗi chỉ số khai ĐÚNG MỘT nguồn (một nguồn cho một con số):
 *  · `AI_LEDGER` — `platform_ai_usage` (lượt gọi model, token, tiền AI), lọc theo `aiFeatures`;
 *  · `DAILY_SNAPSHOT` — `platform_tenant_usage_daily` (đếm từ chứng từ trong CSDL tổ chức, 0204);
 *  · `EVENT_LEDGER` — `platform_usage_events` (sổ dùng chung, sản phẩm tự ghi qua `recordUsage`).
 */
export type MetricSource = "AI_LEDGER" | "DAILY_SNAPSHOT" | "EVENT_LEDGER";
export type SnapshotColumn = "conversationsStarted" | "customerMessages" | "botMessages" | "aiOrders";
export type AiMeasure = "requests" | "inputTokens" | "outputTokens" | "costUsd";

export type ProductMetric = {
  key: string;
  label: string;
  unit: string;
  source: MetricSource;
  /** `AI_LEDGER`: đại lượng đọc. */
  aiMeasure?: AiMeasure;
  /** `DAILY_SNAPSHOT`: cột đọc. Cộng theo ngày — chỉ khai chỉ số mà cộng ngày KHÔNG đếm hai lần. */
  snapshotColumn?: SnapshotColumn;
  /**
   * `EVENT_LEDGER`: đã có đường ghi thật trên production chưa. `false` ⇒ đọc ra `null` (CHƯA ĐO), không phải 0 — sổ trống
   * vì chưa ai ghi khác hẳn sổ trống vì không ai dùng (luật 42).
   */
  emitterLive?: boolean;
  /** Bảng kê được tính tiền theo chỉ số này khi gói khai đơn giá vượt (`platform_plans.commercial.overage`). */
  billable: boolean;
};

export type Capability = {
  key: string;
  label: string;
  /** Module kỹ thuật mang khả năng này (cổng đường dẫn + quyền đã có). */
  modules: readonly ModuleKey[];
  /** Tính năng thương mại (entitlement theo gói) thuộc khả năng này. */
  features: readonly FeatureKey[];
};

export type ProductDef = {
  key: string;
  name: string;
  /** Thương hiệu bán sản phẩm (`platform_organizations.brand`, `lib/platform/site-host.ts`). */
  brand: "vnx" | "chotdon";
  description: string;
  capabilities: readonly Capability[];
  /** Module CHỈ sản phẩm này sở hữu — bật một module trong số này ⇒ workspace là khách của sản phẩm. */
  exclusiveModules: readonly ModuleKey[];
  /** Cấp workspace cho sản phẩm thì bật những module này (ngoài lõi). Đóng dưới phụ thuộc ở `setOrganizationModule`. */
  provisionModules: readonly ModuleKey[];
  /** Sản phẩm cần lõi thương mại dùng chung (ERP làm chủ) — cấp kèm, không tính là thuê ERP. */
  needsCommerceCore: boolean;
  /** `platform_ai_usage.feature` thuộc sản phẩm này — chi phí AI của khoá đó tính cho sản phẩm này. */
  aiFeatures: readonly string[];
  metrics: readonly ProductMetric[];
  /** Miền dữ liệu sản phẩm là NGUỒN SỰ THẬT (docs/saas/OWNERSHIP.md). Hai sản phẩm không bao giờ cùng sở hữu một miền. */
  ownedDomains: readonly string[];
};

/** Lõi thương mại: ERP sở hữu, sản phẩm khác dùng qua cùng CSDL workspace (ranh giới gọi hàm — docs/saas/INTEGRATION.md). */
export const SHARED_COMMERCE_CORE: readonly ModuleKey[] = ["core", "work", "customers", "products", "orders", "inventory"];

/**
 * Runtime CŨ của miền AI bán hàng: bot nhà (`chatbot/`, container riêng) gác bằng feature `connector_pancake.chatbot`. Miền
 * thuộc Chốt Đơn; runtime này chỉ còn cho workspace nhà tới khi chuyển xong (docs/saas/OWNERSHIP.md §4).
 */
export const LEGACY_CHATBOT_FEATURE = "connector_pancake.chatbot";

const CHOTDON_MODULES: readonly ModuleKey[] = ["ai_sales"];

const ERP_EXCLUSIVE: readonly ModuleKey[] = MODULE_KEYS.filter((k) => !SHARED_COMMERCE_CORE.includes(k) && !CHOTDON_MODULES.includes(k));

export const PRODUCTS: readonly ProductDef[] = [
  {
    key: "erp",
    name: "VNX ERP",
    brand: "vnx",
    description: "Hệ điều hành kinh doanh: sản phẩm, giá, tồn kho, đơn, giao vận, tài chính, lương, sản xuất, marketing.",
    capabilities: [
      { key: "commerce_core", label: "Khách · sản phẩm · đơn · kho", modules: ["customers", "products", "orders", "inventory"], features: [] },
      { key: "fulfillment", label: "Giao vận · hoàn · mua hàng · sản xuất", modules: ["logistics", "returns", "purchasing", "production", "lots"], features: [] },
      { key: "finance", label: "Tài chính · lương", modules: ["finance", "payroll"], features: [] },
      { key: "marketing", label: "Marketing · kênh bán", modules: ["marketing", "sales_channels", "alerts"], features: [] },
      { key: "customer_care", label: "Chăm sóc khách", modules: ["customer_care", "warranty"], features: [] },
      { key: "work", label: "Việc · OKR", modules: ["work"], features: [] },
      { key: "integrations", label: "Kết nối", modules: ["connector_pancake", "connector_viettelpost", "connector_meta", "connector_bank", "connector_messaging", "integrations", "apps", "tech"], features: [] },
      { key: "verticals", label: "Gói ngành", modules: ["appointments", "wholesale_leads", "stays", "field_jobs", "real_estate"], features: [] },
    ],
    exclusiveModules: ERP_EXCLUSIVE,
    provisionModules: ["customers", "products", "orders", "inventory", "logistics", "finance"],
    needsCommerceCore: true,
    aiFeatures: ["ai_builder", "copilot", "creative_image", "creative_copy", "lead_hunter"],
    metrics: [
      { key: "ai_calls", label: "Lượt gọi AI", unit: "lượt", source: "AI_LEDGER", aiMeasure: "requests", billable: false },
      { key: "ai_cost_usd", label: "Chi phí AI", unit: "USD", source: "AI_LEDGER", aiMeasure: "costUsd", billable: false },
    ],
    ownedDomains: ["product", "sku", "price", "inventory", "customer_record", "order", "warehouse", "shipping", "logistics", "finance", "payroll", "production"],
  },
  {
    key: "chotdon",
    name: "Chốt Đơn Tự Động",
    brand: "chotdon",
    description: "AI bán hàng trên fanpage / Messenger / web chat: hộp thư hợp nhất, tư vấn, chốt và lên đơn, nhắn lại, chuyển nhân viên.",
    capabilities: [
      { key: "ai_sales", label: "AI bán hàng", modules: ["ai_sales"], features: ["ai_sales", "ai_order_creation", "upsell", "cross_sell", "follow_up", "custom_ai_training"] },
      { key: "inbox", label: "Hộp thư hợp nhất", modules: ["ai_sales"], features: ["multi_page_inbox", "human_handoff"] },
      { key: "analytics", label: "Phân tích hội thoại", modules: ["ai_sales"], features: ["analytics", "advanced_analytics"] },
      { key: "developer", label: "API · webhook", modules: ["ai_sales"], features: ["api", "webhook"] },
      { key: "team", label: "Nhiều người dùng", modules: ["core"], features: ["multi_user"] },
    ],
    exclusiveModules: CHOTDON_MODULES,
    provisionModules: ["ai_sales"],
    needsCommerceCore: true,
    aiFeatures: ["sales_chatbot", "sales_playbook"],
    metrics: [
      // ĐỒNG HỒ THU CHÍNH (0225 · docs/saas/PRICING_V1.md): khách nhận ít nhất một câu trả lời AI đã gửi trong kỳ — ghi ở điểm
      // gửi thành công (`lib/pricing/ai-customer.ts`), khoá idempotent theo (kỳ, kênh, page, khách).
      { key: "ai_customers", label: "Khách AI", unit: "khách AI", source: "EVENT_LEDGER", emitterLive: true, billable: true },
      { key: "conversations_started", label: "Hội thoại mới", unit: "hội thoại", source: "DAILY_SNAPSHOT", snapshotColumn: "conversationsStarted", billable: false },
      { key: "customer_messages", label: "Tin khách", unit: "tin", source: "DAILY_SNAPSHOT", snapshotColumn: "customerMessages", billable: false },
      { key: "bot_messages", label: "Tin AI gửi", unit: "tin", source: "DAILY_SNAPSHOT", snapshotColumn: "botMessages", billable: false },
      { key: "ai_orders", label: "Đơn AI chốt", unit: "đơn", source: "DAILY_SNAPSHOT", snapshotColumn: "aiOrders", billable: false },
      { key: "ai_calls", label: "Lượt gọi AI", unit: "lượt", source: "AI_LEDGER", aiMeasure: "requests", billable: false },
      { key: "ai_cost_usd", label: "Chi phí AI", unit: "USD", source: "AI_LEDGER", aiMeasure: "costUsd", billable: false },
    ],
    ownedDomains: ["channel", "facebook_page", "conversation", "message", "unified_inbox", "ai_sales_agent", "agent_config", "prompt", "knowledge", "ai_runtime", "follow_up", "sales_automation", "conversation_analytics", "ai_sales_attribution"],
  },
];

export function isProductKey(v: unknown, catalog: readonly ProductDef[] = PRODUCTS): v is ProductKey {
  return typeof v === "string" && catalog.some((p) => p.key === v);
}

export function productDef(key: string, catalog: readonly ProductDef[] = PRODUCTS): ProductDef | null {
  return catalog.find((p) => p.key === key) ?? null;
}

/** Sản phẩm sở hữu một `platform_ai_usage.feature`. Khoá lạ ⇒ `null` (in "chưa gán sản phẩm", không đoán). */
export function productOfAiFeature(feature: string, catalog: readonly ProductDef[] = PRODUCTS): string | null {
  return catalog.find((p) => p.aiFeatures.includes(feature))?.key ?? null;
}

/**
 * Workspace là khách của sản phẩm nào, suy từ module ĐANG BẬT — CÙNG luật với backfill 0224 (bài kiểm chạy cả hai):
 *  · sản phẩm có ít nhất một module ĐỘC QUYỀN đang bật;
 *  · Chốt Đơn còn được tính khi runtime cũ của nó (bot nhà, `connector_pancake.chatbot`) đang bật.
 * Lõi thương mại dùng chung không tự nó làm workspace thành khách của ai.
 */
export function productsFromModules(enabled: ReadonlySet<string>, opts: { legacyChatbotOn?: boolean; catalog?: readonly ProductDef[] } = {}): string[] {
  const catalog = opts.catalog ?? PRODUCTS;
  const out = catalog.filter((p) => p.exclusiveModules.some((m) => enabled.has(m))).map((p) => p.key);
  if (opts.legacyChatbotOn && enabled.has("connector_pancake") && !out.includes("chotdon") && catalog.some((p) => p.key === "chotdon")) out.push("chotdon");
  return out;
}

/** Module cần bật để cấp sản phẩm cho một workspace: lõi (nếu cần) + module cấp của sản phẩm. */
export function modulesToProvision(product: ProductDef): ModuleKey[] {
  return [...new Set<ModuleKey>([...(product.needsCommerceCore ? SHARED_COMMERCE_CORE : (["core"] as const)), ...product.provisionModules])];
}

/** Một miền dữ liệu có đúng một chủ sở hữu — kiểm danh mục không để hai sản phẩm cùng làm nguồn sự thật. */
export function domainOwnershipConflicts(catalog: readonly ProductDef[] = PRODUCTS): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const p of catalog)
    for (const d of p.ownedDomains) {
      const other = seen.get(d);
      if (other && other !== p.key) out.push(`${d}: ${other} ↔ ${p.key}`);
      seen.set(d, p.key);
    }
  return out;
}

/** Tính năng thương mại thuộc sản phẩm (hợp các khả năng). */
export function productFeatures(product: ProductDef): FeatureKey[] {
  return [...new Set(product.capabilities.flatMap((c) => c.features))];
}

export const PRODUCT_LABEL: Record<string, string> = Object.fromEntries(PRODUCTS.map((p) => [p.key, p.name]));

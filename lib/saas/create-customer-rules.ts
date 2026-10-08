/**
 * ═══════════ LUẬT THƯƠNG MẠI CỦA MỘT WORKSPACE — THUẦN, CLIENT-SAFE (docs/saas/PROVISIONING.md) ═══════════
 *
 * Khách trả tiền đầu tiên của Chốt Đơn được tạo ở `/platform/customers` → «Tạo khách mới» (form
 * `components/saas/operator-actions.tsx` → job `lib/saas/provisioning.ts` → `lib/platform/provision.ts`). Kiểm khởi chạy 08/10/2026
 * thấy bốn mặc định sai; review #682 thấy thêm các cửa KHÁC tạo / đổi workspace lách được cùng luật ấy (`/start` của người vận hành,
 * mã mời, đổi gói / thương hiệu sau lúc tạo, thuê thêm sản phẩm). Nên luật nằm ở MỘT chỗ — tệp này (thuần) + một hàm máy chủ đọc
 * sổ (`lib/saas/workspace-commercial.ts`) mà `provisionOrganization` và mọi cửa gọi — form chỉ PHẢN ÁNH, «trình duyệt nói được» và
 * «máy chủ nói được» không bao giờ là hai luật:
 *
 *  1. THƯƠNG HIỆU do BỘ SẢN PHẨM quyết. Mọi sản phẩm đều thuộc thương hiệu Chốt Đơn ⇒ `chotdon`: thiếu nó thì `salesAgentShell`
 *     sai (lib/constants/saas-nav.ts) ⇒ khách thấy MENU ERP nội bộ, và liên kết mời / đặt lại mật khẩu trỏ erp.vnxcommerce.com
 *     (lib/platform/org-links.ts). Lựa chọn TƯỜNG MINH ngược lại (người vận hành chọn VNX) ⇒ từ chối (`resolveCreateBrand`); thương
 *     hiệu chỉ là GỢI Ý (host khách đứng lúc đăng ký) ⇒ bộ sản phẩm thắng (`decidedBrand`). Có ERP trong bộ ⇒ không khoá.
 *  2. GÓI hợp lệ = gói của bảng giá CATALOG đang hiệu lực (đọc từ sổ giá bằng `currentCatalogVersion` — không gõ tay danh sách) +
 *     `trial`. Gói CHỈ CÒN ở giá cũ: chỉ tài khoản NỘI BỘ (`legacyPlanOnCreateAllowed`, lib/saas/policy.ts — luật đang có) VÀ không
 *     phải workspace chỉ-Chốt-Đơn (review #682 L2: gói cũ credit AI 0 ⇒ bot im, nội bộ cũng vậy). Khách NGOÀI chọn gói cũ là giá
 *     legacy, không dùng thử, trần AI của dòng cũ ⇒ BOT IM. `internal` (không giới hạn) chỉ của workspace NHÀ — không cấp cho ai.
 *  3. MẪU: khách CHỈ thuê Chốt Đơn ⇒ job cài mẫu «Chỉ cần AI bán hàng» như `/start` (lib/saas/provisioning-template.ts) — trong vỏ
 *     Chốt Đơn khách không tự mở được `/settings/templates`. Gói KHÔNG có AI bán hàng (Inbox) ⇒ không cài mẫu AI bán hàng.
 *  4. Ô CÒN THIẾU của form (`createCustomerMissing`) — để nút «Tạo khách…» nói được VÌ SAO nó chưa bấm được.
 */
import type { Blueprint } from "@/lib/blueprints/types";
import { DEFAULT_PLAN_KEY, HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { formatNumber, formatVND } from "@/lib/format";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { currentCatalogVersion, type PriceBook } from "@/lib/pricing/versions";
import { PRODUCTS, productDef, type ProductDef } from "@/lib/saas/catalog";
import { legacyPlanOnCreateAllowed } from "@/lib/saas/policy";

export type CreateBrand = ProductDef["brand"];

/** Thương hiệu duy nhất mà bộ sản phẩm KHOÁ — vỏ app 8 mục + liên kết về host riêng chỉ bật khi workspace mang nó. */
const SHELL_BRAND: CreateBrand = "chotdon";

// ─────────────────────────── 1 · Thương hiệu ───────────────────────────

function defsOf(products: readonly string[], catalog: readonly ProductDef[]): ProductDef[] | null {
  const defs = products.map((k) => productDef(k, catalog));
  return defs.length > 0 && defs.every((d) => d !== null) ? (defs as ProductDef[]) : null;
}

/** Khách CHỈ dùng sản phẩm của thương hiệu Chốt Đơn (workspace «Sales Agent»). Bộ rỗng / khoá lạ ⇒ `false`. */
export function salesAgentOnly(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): boolean {
  const defs = defsOf(products, catalog);
  return defs !== null && defs.every((d) => d.brand === SHELL_BRAND);
}

/** Thương hiệu bộ sản phẩm KHOÁ (xem đầu tệp); `null` = không khoá. */
export function lockedBrandFor(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): CreateBrand | null {
  return salesAgentOnly(products, catalog) ? SHELL_BRAND : null;
}

/** Thương hiệu gợi ý cho form: khoá thì đúng nó; không khoá ⇒ thương hiệu của sản phẩm đầu tiên ngoài Chốt Đơn (ERP ⇒ `vnx`). */
export function suggestedBrandFor(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): CreateBrand {
  return lockedBrandFor(products, catalog) ?? products.map((k) => productDef(k, catalog)).find((d) => d && d.brand !== SHELL_BRAND)?.brand ?? "vnx";
}

/**
 * Thương hiệu cho một LỰA CHỌN TƯỜNG MINH (người vận hành chọn ở form / đổi ở trang tổ chức). Bộ sản phẩm khoá ⇒ đúng thương hiệu
 * khoá: bỏ trống ⇒ tự đặt; chọn thương hiệu KHÁC ⇒ từ chối (ghi đè im lặng một lựa chọn tường minh là đoán ý người bấm). Không khoá ⇒
 * đúng lựa chọn (`null` = không theo dõi, như trước).
 */
export function resolveCreateBrand(products: readonly string[], requested: CreateBrand | null | undefined, catalog: readonly ProductDef[] = PRODUCTS): { brand: CreateBrand | null } | { error: string } {
  const locked = lockedBrandFor(products, catalog);
  if (!locked) return { brand: requested ?? null };
  if (requested && requested !== locked) {
    const names = (defsOf(products, catalog) ?? []).map((d) => d.name).join(" + ");
    const own = catalog.find((p) => p.brand === locked)?.name ?? locked;
    const asked = catalog.find((p) => p.brand === requested)?.name ?? requested;
    return { error: `Workspace chỉ dùng ${names} phải mang thương hiệu ${own} — thiếu nó thì khách thấy menu ERP nội bộ và liên kết mời trỏ sang phần mềm khác. Thương hiệu ${asked} chỉ chọn được khi khách dùng kèm sản phẩm của thương hiệu ấy.` };
  }
  return { brand: locked };
}

/** Thương hiệu khi giá trị đưa vào chỉ là GỢI Ý (host lúc khách tự đăng ký): bộ sản phẩm khoá thì thắng, không thì giữ gợi ý. */
export function decidedBrand(products: readonly string[], hint: CreateBrand | null | undefined, catalog: readonly ProductDef[] = PRODUCTS): CreateBrand | null {
  return lockedBrandFor(products, catalog) ?? hint ?? null;
}

// ─────────────────────────── 2 · Gói ───────────────────────────

/** `CATALOG` = bảng giá đang niêm yết (+ `trial`) · `LEGACY` = chỉ còn giá cũ · `HOME_ONLY` = gói không giới hạn của nhà. */
export type PlanTier = "CATALOG" | "LEGACY" | "HOME_ONLY";

/** Khoá gói của bảng giá CATALOG đang hiệu lực lúc `now` (theo thứ tự của phiên bản) + `trial` — đọc từ sổ giá, không gõ tay. */
export function catalogPlanKeys(book: PriceBook, now: Date): string[] {
  const version = currentCatalogVersion(book, now);
  const keys = version
    ? book.prices
        .filter((p) => p.versionKey === version.key)
        .sort((a, b) => a.position - b.position || a.planKey.localeCompare(b.planKey))
        .map((p) => p.planKey)
    : [];
  return keys.includes(DEFAULT_PLAN_KEY) ? keys : [DEFAULT_PLAN_KEY, ...keys];
}

export function planTier(planKey: string, catalogKeys: readonly string[]): PlanTier {
  if (planKey === HOME_PLAN_KEY) return "HOME_ONLY";
  return planKey === DEFAULT_PLAN_KEY || catalogKeys.includes(planKey) ? "CATALOG" : "LEGACY";
}

/**
 * Gói hạng `tier` có ĐẶT được cho workspace (tài khoản loại `accountType`, bộ sản phẩm `products`) không — một luật cho tạo mới,
 * đổi gói sau lúc tạo, thuê thêm sản phẩm, mã mời. Loại lạ / thiếu ⇒ như khách ngoài (phía hẹp).
 */
export function planAllowed(tier: PlanTier, accountType: string | null | undefined, products: readonly string[] = [], catalog: readonly ProductDef[] = PRODUCTS): boolean {
  if (tier === "CATALOG") return true;
  if (tier === "HOME_ONLY") return false;
  return legacyPlanOnCreateAllowed(accountType) && !salesAgentOnly(products, catalog);
}

/** Câu từ chối bằng ngôn ngữ kinh doanh — `null` = được. `listed` = tên các gói đang niêm yết, in kèm để chọn lại. */
export function planRefusal(input: { planName: string; tier: PlanTier; accountType: string | null | undefined; products?: readonly string[]; listed: readonly string[]; catalog?: readonly ProductDef[] }): string | null {
  const products = input.products ?? [];
  if (planAllowed(input.tier, input.accountType, products, input.catalog)) return null;
  const pick = input.listed.length ? ` Chọn một gói đang niêm yết: ${input.listed.join(" · ")}.` : "";
  if (input.tier === "HOME_ONLY") return `Gói «${input.planName}» là gói không giới hạn của workspace nhà — không cấp cho khách, kể cả tài khoản nội bộ (khách nội bộ dùng gói thường, chargeback theo bảng kê).${pick}`;
  if (legacyPlanOnCreateAllowed(input.accountType)) return `Gói «${input.planName}» chỉ còn ở giá cũ — workspace chỉ dùng Chốt Đơn phải ở gói đang niêm yết, kể cả tài khoản nội bộ (gói cũ có credit AI bằng 0 thì bot im).${pick}`;
  return `Gói «${input.planName}» chỉ còn giữ giá cho khách cũ — khách mới đặt vào đó sẽ tính giá cũ, không có dùng thử và trần AI theo gói cũ (gói cũ có credit AI bằng 0 thì bot im ngay).${pick}`;
}

/** Một dòng của ô «Gói» trên form — dựng ở máy chủ từ sổ gói + sổ giá, form chỉ lọc theo loại tài khoản / bộ sản phẩm. */
export type CreatePlanOption = {
  key: string;
  name: string;
  tier: PlanTier;
  /** Giá MỘT tháng như màn người vận hành đọc (`readPlans`); `null` = không niêm yết giá tháng. */
  priceVnd: number | null;
  priceFromVnd: number | null;
  trialDays: number | null;
  /** Số khách AI gồm trong gói DÙNG THỬ — dùng thử dừng ở mốc nào tới trước: hết ngày hay hết khách AI (PRICING_V1 §7). */
  trialAiCustomers: number | null;
  contactSales: boolean;
  /** Gói có «AI bán hàng» không, theo dòng giá của bảng giá đang niêm yết; `null` = chưa khai / gói cũ. */
  aiSales: boolean | null;
};

const TIER_RANK: Record<PlanTier, number> = { CATALOG: 0, LEGACY: 1, HOME_ONLY: 2 };

export function createCustomerPlanOptions(plans: readonly { key: string; name: string; priceVnd: number | null }[], book: PriceBook, now: Date): CreatePlanOption[] {
  const version = currentCatalogVersion(book, now);
  const keys = catalogPlanKeys(book, now);
  const rowOf = (key: string) => (version ? (book.prices.find((p) => p.versionKey === version.key && p.planKey === key) ?? null) : null);
  return plans
    .map((p, i) => {
      const row = rowOf(p.key);
      const option: CreatePlanOption = {
        key: p.key,
        name: p.name,
        tier: planTier(p.key, keys),
        priceVnd: p.priceVnd,
        priceFromVnd: row?.priceFromVnd ?? null,
        trialDays: row?.trialDays ?? null,
        trialAiCustomers: row?.trialDays ? (row.included.aiCustomers ?? null) : null,
        contactSales: row?.contactSales ?? false,
        aiSales: row?.features ? row.features.includes("ai_sales") : null,
      };
      return { option, order: [TIER_RANK[option.tier], row?.position ?? Number.MAX_SAFE_INTEGER, i] as const };
    })
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2])
    .map((x) => x.option);
}

/** Gói form được hiện cho loại tài khoản / bộ sản phẩm này — đúng phép `planAllowed` của máy chủ. */
export function plansForAccountType(options: readonly CreatePlanOption[], accountType: string | null | undefined, products: readonly string[] = []): CreatePlanOption[] {
  return options.filter((o) => planAllowed(o.tier, accountType, products));
}

/** Gói chọn sẵn: dùng thử nếu có, không thì gói đầu tiên. */
export function defaultCreatePlanKey(options: readonly CreatePlanOption[]): string | null {
  return options.find((o) => o.key === DEFAULT_PLAN_KEY)?.key ?? options[0]?.key ?? null;
}

export function planOptionLabel(o: CreatePlanOption): string {
  const trial = o.trialDays ? `${o.trialDays} ngày${o.trialAiCustomers ? ` hoặc ${formatNumber(o.trialAiCustomers)} khách AI (cái nào tới trước)` : ""}, miễn phí` : null;
  const price = trial ?? (o.contactSales ? `hợp đồng${o.priceFromVnd ? `, từ ${formatVND(o.priceFromVnd)}/tháng` : ""}` : o.priceVnd ? `${formatVND(o.priceVnd)}/tháng` : null);
  const notes = [price, o.aiSales === false ? "không có AI bán hàng" : null, o.tier === "LEGACY" ? "giá cũ" : null].filter((s): s is string => Boolean(s));
  return notes.length ? `${o.name} — ${notes.join(" · ")}` : o.name;
}

// ─────────────────────────── 3 · Mẫu ───────────────────────────

/** Mẫu cài kèm cho khách CHỈ thuê Chốt Đơn = loại hình «Chỉ cần AI bán hàng» của `/start` (cùng bảng `BUSINESS_TYPE_SPEC`). */
export type CreateTemplate = { businessType: "ai_sales"; templateKey: string; label: string };

export const SALES_AGENT_TEMPLATE: CreateTemplate | null = BUSINESS_TYPE_SPEC.ai_sales.templateKey ? { businessType: "ai_sales", templateKey: BUSINESS_TYPE_SPEC.ai_sales.templateKey, label: BUSINESS_TYPE_SPEC.ai_sales.label } : null;

/**
 * Mẫu job «Tạo khách» cài cho bộ sản phẩm + gói này; `null` = không cài. Khách có ERP tự chọn mẫu ngành ở `/settings/templates`;
 * gói KHÔNG có AI bán hàng (`planAiSales = false`, vd Inbox — khách trả lời tay) ⇒ không cài mẫu AI bán hàng. `null` (gói chưa
 * khai tính năng) ⇒ cài: sản phẩm Chốt Đơn chính là AI bán hàng.
 */
export function provisioningTemplateFor(products: readonly string[], opts: { planAiSales: boolean | null }, catalog: readonly ProductDef[] = PRODUCTS): CreateTemplate | null {
  if (!salesAgentOnly(products, catalog) || opts.planAiSales === false) return null;
  return SALES_AGENT_TEMPLATE;
}

/** Một câu kể mẫu sẽ dựng sẵn gì — đọc từ CHÍNH gói (không gõ lại danh sách ở form). */
export function templateSummary(bp: Pick<Blueprint, "roles" | "fields" | "pages" | "workflows" | "ai">): string {
  return [
    ...(bp.roles ?? []).map((r) => `vai trò «${r.label}»`),
    bp.fields?.length ? `${bp.fields.length} field tuỳ biến` : null,
    ...(bp.pages ?? []).map((p) => `trang «${p.name}»`),
    ...(bp.workflows ?? []).map((w) => `luật «${w.name}» (ở NHÁP)`),
    bp.ai ? "hồ sơ cửa hàng cho AI" : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(" · ");
}

// ─────────────────────────── 4 · Ô còn thiếu ───────────────────────────

/** Email quản trị — CÙNG biểu thức `validateRequest` kiểm. */
export const ADMIN_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Điều kiện form còn thiếu (cụm động từ ngắn, in sau «Chưa thể tạo khách — cần …»). Chỉ là lời nhắc: máy chủ kiểm LẠI mọi thứ
 * (`validateRequest`), nên một ô không có ở đây vẫn bị chặn nếu sai.
 */
export function createCustomerMissing(f: { workspaceCode: string; workspaceName: string; products: readonly string[]; planKey: string | null; offeredPlanKeys: readonly string[]; adminEmail: string }): string[] {
  const out: string[] = [];
  if (!ORGANIZATION_CODE_PATTERN.test(f.workspaceCode.trim().toLowerCase())) out.push("nhập mã workspace (chữ thường, số, gạch ngang)");
  if (f.workspaceName.trim().length < 2) out.push("nhập tên workspace");
  if (!f.products.length) out.push("chọn ít nhất một sản phẩm");
  if (!f.planKey || !f.offeredPlanKeys.includes(f.planKey)) out.push("chọn gói");
  if (!ADMIN_EMAIL_PATTERN.test(f.adminEmail.trim())) out.push("nhập email quản trị");
  return out;
}

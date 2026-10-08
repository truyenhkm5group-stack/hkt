/**
 * ═══════════ LUẬT «TẠO KHÁCH MỚI» CỦA NGƯỜI VẬN HÀNH — THUẦN, CLIENT-SAFE (docs/saas/PROVISIONING.md) ═══════════
 *
 * Khách trả tiền đầu tiên của Chốt Đơn được tạo ở `/platform/customers` → «Tạo khách mới» (form
 * `components/saas/operator-actions.tsx` → job `lib/saas/provisioning.ts` → `lib/platform/provision.ts`). Kiểm khởi chạy 08/10/2026
 * thấy bốn mặc định sai. Cả bốn là luật của MÁY CHỦ (`validateRequest` + job); form chỉ PHẢN ÁNH — và đọc ĐÚNG bản luật này, để
 * «trình duyệt nói được» và «máy chủ nói được» không bao giờ là hai luật:
 *
 *  1. THƯƠNG HIỆU do BỘ SẢN PHẨM quyết. Mọi sản phẩm chọn đều thuộc thương hiệu Chốt Đơn ⇒ `chotdon`, người vận hành không đổi
 *     được. Ô «(mặc định)» = NULL làm `salesAgentShell` sai (lib/constants/saas-nav.ts) ⇒ khách thấy MENU ERP nội bộ, và mọi liên
 *     kết mời / đặt lại mật khẩu trỏ erp.vnxcommerce.com (lib/platform/org-links.ts). Có ERP trong bộ ⇒ người vận hành chọn (gợi
 *     ý `vnx`): khách ERP dùng menu ERP với thương hiệu nào cũng đúng, nên không có gì để khoá.
 *  2. GÓI hợp lệ = gói của bảng giá CATALOG đang hiệu lực (đọc từ sổ giá bằng `currentCatalogVersion` — không gõ tay danh sách) +
 *     `trial`. Gói CHỈ CÒN ở giá cũ chỉ dành cho tài khoản NỘI BỘ (`legacyPlanOnCreateAllowed`, lib/saas/policy.ts — luật đang có);
 *     khách NGOÀI chọn nó là rơi về giá legacy, không có dùng thử, trần AI của dòng cũ (gói credit 0 ⇒ BOT IM ngay ngày đầu).
 *     `internal` (không giới hạn) là gói của workspace NHÀ — không cấp cho ai qua «Tạo khách» (cùng luật `lib/platform/org-plan.ts`).
 *  3. MẪU: khách CHỈ thuê Chốt Đơn ⇒ job cài mẫu «Chỉ cần AI bán hàng» như `/start` (lib/saas/provisioning-template.ts) — khách
 *     trong vỏ Chốt Đơn không tự cài được vì `/settings/templates` bị cổng vỏ chặn. Khách có ERP tự chọn mẫu ngành ở đó.
 *  4. Ô CÒN THIẾU của form (`createCustomerMissing`) — để nút «Tạo khách…» nói được VÌ SAO nó chưa bấm được.
 */
import type { Blueprint } from "@/lib/blueprints/types";
import { DEFAULT_PLAN_KEY, HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { formatVND } from "@/lib/format";
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

/** Khách CHỈ thuê sản phẩm của thương hiệu Chốt Đơn (workspace «Sales Agent»). Bộ rỗng / khoá lạ ⇒ `false`. */
export function salesAgentOnly(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): boolean {
  const defs = defsOf(products, catalog);
  return defs !== null && defs.every((d) => d.brand === SHELL_BRAND);
}

/** Thương hiệu bộ sản phẩm KHOÁ (xem đầu tệp); `null` = không khoá — người vận hành chọn. */
export function lockedBrandFor(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): CreateBrand | null {
  return salesAgentOnly(products, catalog) ? SHELL_BRAND : null;
}

/** Thương hiệu gợi ý cho form: khoá thì đúng nó; không khoá ⇒ thương hiệu của sản phẩm đầu tiên ngoài Chốt Đơn (ERP ⇒ `vnx`). */
export function suggestedBrandFor(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): CreateBrand {
  return lockedBrandFor(products, catalog) ?? products.map((k) => productDef(k, catalog)).find((d) => d && d.brand !== SHELL_BRAND)?.brand ?? "vnx";
}

/**
 * Thương hiệu MÁY CHỦ ghi cho workspace mới. Bộ sản phẩm khoá thương hiệu ⇒ đúng thương hiệu đó: yêu cầu bỏ trống ⇒ tự đặt; xin
 * thương hiệu KHÁC ⇒ từ chối (ghi đè im lặng một lựa chọn tường minh là đoán ý người bấm). Không khoá ⇒ đúng lựa chọn của người
 * vận hành (`null` = không theo dõi, như trước).
 */
export function resolveCreateBrand(products: readonly string[], requested: CreateBrand | null | undefined, catalog: readonly ProductDef[] = PRODUCTS): { brand: CreateBrand | null } | { error: string } {
  const locked = lockedBrandFor(products, catalog);
  if (!locked) return { brand: requested ?? null };
  if (requested && requested !== locked) {
    const names = (defsOf(products, catalog) ?? []).map((d) => d.name).join(" + ");
    const own = catalog.find((p) => p.brand === locked)?.name ?? locked;
    const asked = catalog.find((p) => p.brand === requested)?.name ?? requested;
    return { error: `Khách chỉ thuê ${names} phải mang thương hiệu ${own} — thiếu nó thì khách thấy menu ERP nội bộ và liên kết mời trỏ sang phần mềm khác. Thương hiệu ${asked} chỉ chọn được khi khách thuê kèm sản phẩm của thương hiệu ấy.` };
  }
  return { brand: locked };
}

// ─────────────────────────── 2 · Gói ───────────────────────────

/** `CATALOG` = bảng giá đang niêm yết (+ `trial`) · `LEGACY` = chỉ còn giá cũ · `HOME_ONLY` = gói không giới hạn của nhà. */
export type CreatePlanTier = "CATALOG" | "LEGACY" | "HOME_ONLY";

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

export function createPlanTier(planKey: string, catalogKeys: readonly string[]): CreatePlanTier {
  if (planKey === HOME_PLAN_KEY) return "HOME_ONLY";
  return planKey === DEFAULT_PLAN_KEY || catalogKeys.includes(planKey) ? "CATALOG" : "LEGACY";
}

/** Gói hạng `tier` có đặt được cho workspace mới của tài khoản loại `accountType` không. Loại lạ / thiếu ⇒ như khách ngoài. */
export function createPlanAllowed(tier: CreatePlanTier, accountType: string | null | undefined): boolean {
  return tier === "CATALOG" || (tier === "LEGACY" && legacyPlanOnCreateAllowed(accountType));
}

/** Câu từ chối bằng ngôn ngữ kinh doanh — `null` = được. `listed` = tên các gói đang niêm yết, in kèm để chọn lại. */
export function createPlanRefusal(input: { planName: string; tier: CreatePlanTier; accountType: string | null | undefined; listed: readonly string[] }): string | null {
  if (createPlanAllowed(input.tier, input.accountType)) return null;
  const pick = input.listed.length ? ` Chọn một gói đang niêm yết: ${input.listed.join(" · ")}.` : "";
  if (input.tier === "HOME_ONLY") return `Gói «${input.planName}» là gói không giới hạn của workspace nhà — không cấp cho khách, kể cả tài khoản nội bộ (khách nội bộ dùng gói thường, chargeback theo bảng kê).${pick}`;
  return `Gói «${input.planName}» chỉ còn giữ giá cho khách cũ — khách mới đặt vào đó sẽ tính giá cũ, không có dùng thử và trần AI theo gói cũ (gói cũ có credit AI bằng 0 thì bot im ngay).${pick}`;
}

/** Một dòng của ô «Gói» trên form — dựng ở máy chủ từ sổ gói + sổ giá, form chỉ lọc theo loại tài khoản. */
export type CreatePlanOption = {
  key: string;
  name: string;
  tier: CreatePlanTier;
  /** Giá MỘT tháng như màn người vận hành đọc (`readPlans`); `null` = không niêm yết giá tháng. */
  priceVnd: number | null;
  priceFromVnd: number | null;
  trialDays: number | null;
  contactSales: boolean;
  /** Gói có «AI bán hàng» không, theo dòng giá của bảng giá đang niêm yết; `null` = chưa khai / gói cũ. */
  aiSales: boolean | null;
};

const TIER_RANK: Record<CreatePlanTier, number> = { CATALOG: 0, LEGACY: 1, HOME_ONLY: 2 };

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
        tier: createPlanTier(p.key, keys),
        priceVnd: p.priceVnd,
        priceFromVnd: row?.priceFromVnd ?? null,
        trialDays: row?.trialDays ?? null,
        contactSales: row?.contactSales ?? false,
        aiSales: row?.features ? row.features.includes("ai_sales") : null,
      };
      return { option, order: [TIER_RANK[option.tier], row?.position ?? Number.MAX_SAFE_INTEGER, i] as const };
    })
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2])
    .map((x) => x.option);
}

/** Gói form được hiện cho loại tài khoản này — đúng phép `createPlanAllowed` của máy chủ. */
export function plansForAccountType(options: readonly CreatePlanOption[], accountType: string | null | undefined): CreatePlanOption[] {
  return options.filter((o) => createPlanAllowed(o.tier, accountType));
}

/** Gói chọn sẵn: dùng thử nếu có, không thì gói đầu tiên. */
export function defaultCreatePlanKey(options: readonly CreatePlanOption[]): string | null {
  return options.find((o) => o.key === DEFAULT_PLAN_KEY)?.key ?? options[0]?.key ?? null;
}

export function planOptionLabel(o: CreatePlanOption): string {
  const price = o.trialDays ? `${o.trialDays} ngày miễn phí` : o.contactSales ? `hợp đồng${o.priceFromVnd ? `, từ ${formatVND(o.priceFromVnd)}/tháng` : ""}` : o.priceVnd ? `${formatVND(o.priceVnd)}/tháng` : null;
  const notes = [price, o.aiSales === false ? "không có AI bán hàng" : null, o.tier === "LEGACY" ? "giá cũ" : null].filter((s): s is string => Boolean(s));
  return notes.length ? `${o.name} — ${notes.join(" · ")}` : o.name;
}

// ─────────────────────────── 3 · Mẫu ───────────────────────────

/** Mẫu cài kèm cho khách CHỈ thuê Chốt Đơn = loại hình «Chỉ cần AI bán hàng» của `/start` (cùng bảng `BUSINESS_TYPE_SPEC`). */
export type CreateTemplate = { businessType: "ai_sales"; templateKey: string; label: string };

export const SALES_AGENT_TEMPLATE: CreateTemplate | null = BUSINESS_TYPE_SPEC.ai_sales.templateKey ? { businessType: "ai_sales", templateKey: BUSINESS_TYPE_SPEC.ai_sales.templateKey, label: BUSINESS_TYPE_SPEC.ai_sales.label } : null;

/** Mẫu job «Tạo khách» cài cho bộ sản phẩm này; `null` = không cài (khách có ERP tự chọn mẫu ngành ở `/settings/templates`). */
export function provisioningTemplateFor(products: readonly string[], catalog: readonly ProductDef[] = PRODUCTS): CreateTemplate | null {
  return salesAgentOnly(products, catalog) ? SALES_AGENT_TEMPLATE : null;
}

/** Một câu kể mẫu sẽ dựng sẵn gì — đọc từ CHÍNH gói (không gõ lại danh sách ở form). */
export function templateSummary(bp: Pick<Blueprint, "roles" | "fields" | "pages" | "workflows" | "ai">): string {
  return [
    ...(bp.roles ?? []).map((r) => `vai trò «${r.label}»`),
    bp.fields?.length ? `${bp.fields.length} field cho bot đọc` : null,
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

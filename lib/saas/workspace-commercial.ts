/**
 * ═══════════ LUẬT THƯƠNG MẠI CỦA WORKSPACE — MỘT ĐƯỜNG MÁY CHỦ CHO MỌI CỬA (review #682 · MEDIUM-2) — CHỈ MÁY CHỦ ═══════════
 *
 * Luật (thuần) ở `lib/saas/create-customer-rules.ts`; tệp này chỉ ĐỌC những gì luật cần (sổ gói, sổ giá, loại tài khoản, sản phẩm
 * đang dùng) rồi hỏi luật. Mọi cửa tạo / đổi workspace đi qua đây — không cửa nào tự viết lại:
 *  · tạo MỚI: `provisionOrganization` (khi cửa khai `commercial`) — job «Tạo khách», `/start` (công khai · mã mời · người vận
 *    hành), script cấp phát. Job và `/start` hỏi TRƯỚC (từ chối sớm, không để lại workspace dựng dở), `provisionOrganization` hỏi
 *    LẠI lúc ghi dòng tổ chức;
 *  · đổi gói sau lúc tạo (`lib/platform/org-plan.ts`), thuê thêm sản phẩm có gói riêng (`validateRequest` SUBSCRIBE_PRODUCT), mã mời
 *    mang gói (`lib/onboarding/invites.ts`): `workspacePlanRefusal`.
 * Lỗi đọc sổ ⇒ NÉM (như mọi đường tiền đọc sổ giá — lib/pricing/price-book.ts): không cấp một gói trên một bảng giá đoán.
 */
import { listPlans } from "@/lib/entitlements/check";
import { DEFAULT_PLAN_KEY } from "@/lib/entitlements/kinds";
import { loadPriceBook } from "@/lib/pricing/price-book";
import { currentCatalogVersion, priceOf } from "@/lib/pricing/versions";
import { accountOfWorkspace, productsInUse } from "@/lib/saas/accounts";
import { PRODUCTS, type ProductDef } from "@/lib/saas/catalog";
import { catalogPlanKeys, decidedBrand, planRefusal, planTier, resolveCreateBrand, type CreateBrand } from "@/lib/saas/create-customer-rules";

/** Tên gói như người vận hành đọc: tên của bảng giá đang niêm yết nếu gói có ở đó, không thì tên ở sổ gói. */
async function planNames(now: Date): Promise<{ book: Awaited<ReturnType<typeof loadPriceBook>>; listed: string[]; nameOf: (key: string) => string | null }> {
  const [plans, book] = await Promise.all([listPlans(), loadPriceBook()]);
  // `listPlans` nuốt lỗi đọc thành danh sách rỗng — sổ gói rỗng ở đây là KHÔNG ĐỌC ĐƯỢC, không phải «gói không có».
  if (!plans.length) throw new Error("Không đọc được sổ gói dịch vụ — thử lại.");
  const version = currentCatalogVersion(book, now);
  const nameOf = (key: string) => {
    const row = plans.find((p) => p.key === key);
    if (!row) return null;
    const hit = priceOf(book, version?.key ?? null, key);
    return hit?.source === "VERSION" ? hit.price.name : row.name;
  };
  const listed = catalogPlanKeys(book, now)
    .map((k) => nameOf(k))
    .filter((n): n is string => Boolean(n));
  return { book, listed, nameOf };
}

/**
 * Gói `planKey` có ĐẶT được cho workspace (tài khoản loại `accountType`, bộ sản phẩm `products`) không — `null` = được, chuỗi = câu
 * từ chối bằng ngôn ngữ kinh doanh. Gói không có trong sổ ⇒ từ chối.
 */
export async function workspacePlanRefusal(input: { planKey: string; accountType: string | null; products: readonly string[]; now?: Date; catalog?: readonly ProductDef[] }): Promise<string | null> {
  const now = input.now ?? new Date();
  const { book, listed, nameOf } = await planNames(now);
  const name = nameOf(input.planKey);
  if (!name) return `Gói "${input.planKey}" không có.`;
  return planRefusal({ planName: name, tier: planTier(input.planKey, catalogPlanKeys(book, now)), accountType: input.accountType, products: input.products, listed, catalog: input.catalog });
}

/** Như `workspacePlanRefusal` cho một workspace ĐÃ CÓ: loại tài khoản + sản phẩm đang dùng đọc từ sổ (thêm `adding` nếu đang thuê thêm). */
export async function existingWorkspacePlanRefusal(orgCode: string, planKey: string, opts: { adding?: string | null; catalog?: readonly ProductDef[] } = {}): Promise<string | null> {
  const [account, inUse] = await Promise.all([accountOfWorkspace(orgCode), productsInUse(orgCode)]);
  const products = [...new Set([...inUse, ...(opts.adding ? [opts.adding] : [])])];
  return workspacePlanRefusal({ planKey, accountType: account?.accountType ?? null, products, catalog: opts.catalog });
}

export type NewWorkspaceInput = {
  /** Gói xin; trống ⇒ `trial` (cùng nghĩa với cột `plan` để trống — `planKeyOf`). */
  planKey: string | null | undefined;
  brand: CreateBrand | null | undefined;
  /** `true` = người vận hành CHỌN thương hiệu (chọn ngược luật ⇒ từ chối); `false` = gợi ý (host) — bộ sản phẩm thắng. */
  brandIsChoice: boolean;
  /** Loại tài khoản workspace SẼ thuộc. Cửa không gắn tài khoản có sẵn ⇒ tài khoản mới là khách ngoài (`ensureAccountForWorkspace`). */
  accountType: string | null;
  /** Sản phẩm DỰ ĐỊNH của workspace. */
  products: readonly string[];
  now?: Date;
  catalog?: readonly ProductDef[];
};

/** Quyết định thương mại cho một workspace MỚI: thương hiệu sẽ ghi, hoặc câu từ chối (gói / thương hiệu sai luật). */
export async function decideNewWorkspace(input: NewWorkspaceInput): Promise<{ ok: true; brand: CreateBrand | null } | { error: string }> {
  const catalog = input.catalog ?? PRODUCTS;
  let brand: CreateBrand | null;
  if (input.brandIsChoice) {
    const r = resolveCreateBrand(input.products, input.brand, catalog);
    if ("error" in r) return r;
    brand = r.brand;
  } else brand = decidedBrand(input.products, input.brand, catalog);
  const refusal = await workspacePlanRefusal({ planKey: input.planKey?.trim() || DEFAULT_PLAN_KEY, accountType: input.accountType, products: input.products, now: input.now, catalog });
  return refusal ? { error: refusal } : { ok: true, brand };
}

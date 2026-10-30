import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { liveLineUnitCost } from "@/lib/constants/live-cogs";
import { VARIANT_CURRENT_MARKETER_COST } from "@/lib/queries/current-marketer-cost";
import { LAST_RECEIPT_COST } from "@/lib/queries/stock";
import { getSettingJson, setSettingJson, settingDeclared } from "@/lib/settings";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { parseQuotationPolicy, QUOTATION_LIMITS, QUOTATION_SETTING_KEY, type QuotationPolicy } from "@/lib/wholesale/quotation-engine";
import { suggestQuotationPolicy, type PolicySuggestion, type PolicyTier, type PolicyVariant } from "@/lib/wholesale/quotation-settings";

/**
 * ═══════════ CÀI ĐẶT BÁO GIÁ SỈ — ĐỌC + GHI (CHỈ MÁY CHỦ) ═══════════
 *
 * Đọc: chính sách đang khai (`settings["wholesale.quotation"]`) và GỢI Ý tính từ bảng giá sỉ đang bật. Dùng giá vốn sống
 * theo luật 3.13 (`liveLineUnitCost`: giá báo MKT → phiếu nhập gần nhất → giá nhập mẫu mã; 0 = chưa biết). Lượt đọc KHÔNG ghi
 * gì: mở trang không tạo dòng settings nào.
 *
 * Ghi: quyền `wholesale:config` (quyền sẵn có «cấu hình Săn khách sỉ», không thêm khoá mới) → zod → bắt buộc LÝ DO →
 * `setSettingJson` → `audit` kèm trước / sau. Gợi ý không bao giờ tự chảy vào đây: người bấm Lưu mới là người quyết.
 */

export type QuotationPolicyView = { policy: QuotationPolicy; declared: boolean | null; suggestion: PolicySuggestion; activeLists: number };

/** Gợi ý + chính sách hiện tại. CHỈ ĐỌC. */
export async function loadQuotationPolicyView(): Promise<QuotationPolicyView> {
  const db = await getDb();
  const [raw, declared, lists] = await Promise.all([
    getSettingJson<Record<string, unknown>>(QUOTATION_SETTING_KEY, {}),
    settingDeclared(QUOTATION_SETTING_KEY),
    db.select({ id: schema.priceLists.id, name: schema.priceLists.name }).from(schema.priceLists).where(eq(schema.priceLists.active, true)),
  ]);
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const items = lists.length
    ? await db
        .select({ listId: schema.priceListItems.priceListId, variantId: schema.priceListItems.variantId, minQuantity: schema.priceListItems.minQuantity, unitPrice: schema.priceListItems.unitPrice })
        .from(schema.priceListItems)
        .where(inArray(schema.priceListItems.priceListId, lists.map((l) => l.id)))
    : [];
  const ids = [...new Set(items.map((i) => i.variantId))];
  const pv = schema.productVariants;
  const p = schema.products;
  const rows = ids.length
    ? await db
        .select({ id: pv.id, sku: pv.sku, detail: pv.detail, color: pv.color, size: pv.size, name: p.name, retail: pv.retailPrice, marketer: VARIANT_CURRENT_MARKETER_COST, receipt: LAST_RECEIPT_COST, variantDefault: pv.lastImportedPrice })
        .from(pv)
        .innerJoin(p, eq(p.id, pv.productId))
        .where(inArray(pv.id, ids))
    : [];
  const variants = new Map<string, PolicyVariant>();
  for (const r of rows) {
    const label = r.detail.trim() || [r.color, r.size].filter((x) => x.trim()).join(" · ");
    const cost = liveLineUnitCost({ marketer: r.marketer, receipt: r.receipt, orderSnapshot: null, variantDefault: r.variantDefault });
    variants.set(r.id, { label: `${r.sku ? `${r.sku} — ` : ""}${r.name}${label ? ` (${label})` : ""}`, retailPrice: r.retail !== null && r.retail > 0 ? r.retail : null, unitCost: cost.unitCost === null ? null : Math.round(cost.unitCost) });
  }
  const tiers: PolicyTier[] = items.map((i) => ({ listId: i.listId, listName: listName.get(i.listId) ?? i.listId, variantId: i.variantId, minQuantity: i.minQuantity, unitPrice: i.unitPrice }));
  return { policy: parseQuotationPolicy(raw), declared, suggestion: suggestQuotationPolicy(tiers, variants), activeLists: lists.length };
}

const pct = (min: number, max: number) => z.number({ error: "Nhập số %" }).finite().min(min, `Từ ${min}%`).max(max, `Tối đa ${max}%`).nullable().default(null);

export const quotationPolicySchema = z
  .object({
    maxDiscountPercent: pct(0, 100),
    minMarginPercent: pct(-100, 100),
    taxRatePercent: pct(0, 100),
    taxSource: z.string().trim().max(QUOTATION_LIMITS.sourceMax).default(""),
    reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự) — vd «theo bảng giá sỉ HSLC 30/10».").max(QUOTATION_LIMITS.reasonMax),
  })
  .strict()
  .refine((v) => v.taxRatePercent === null || v.taxSource.length > 0, { message: "Thuế suất phải kèm căn cứ (vd loại hoá đơn / văn bản áp dụng).", path: ["taxSource"] });

export type QuotationPolicyInput = z.input<typeof quotationPolicySchema>;

/** Lưu chính sách báo giá — CẢ object (cờ settings phải là object), ô trống = `null` = CHƯA KHAI. */
export async function saveQuotationPolicyCore(user: SessionUser, raw: unknown): Promise<CoreResult<{ policy: QuotationPolicy }>> {
  if (!can(user, "wholesale:config")) return { error: "Bạn không có quyền sửa cài đặt báo giá sỉ (wholesale:config)." };
  const parsed = quotationPolicySchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const v = parsed.data;
  const before = parseQuotationPolicy(await getSettingJson<Record<string, unknown>>(QUOTATION_SETTING_KEY, {}));
  const value = { maxDiscountPercent: v.maxDiscountPercent, minMarginPercent: v.minMarginPercent, taxRatePercent: v.taxRatePercent, taxSource: v.taxRatePercent === null ? null : v.taxSource };
  await setSettingJson(QUOTATION_SETTING_KEY, value);
  const after = parseQuotationPolicy(value);
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_POLICY_SET", entity: "SETTINGS", entityId: QUOTATION_SETTING_KEY, before, after, reason: v.reason });
  return { ok: true, policy: after };
}

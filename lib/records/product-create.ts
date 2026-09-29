/**
 * ═══════════ TẠO / SỬA SẢN PHẨM TẠO TAY (pilot P0 #1/#2) — LÕI CỦA `createProductAction` / `updateProductAction` ═══════════
 *
 * Tách khỏi tệp "use server" vì cùng hai lẽ với `lib/records/customer-create.ts`: mọi hàm xuất khẩu của tệp đó là một cửa
 * gọi được từ trình duyệt, và bài kiểm cần gọi đúng hàm action gọi mà không có cookie của Next.
 *
 * HÀNG RÀO, theo thứ tự (cùng khuôn khách hàng):
 *  1. Module Sản phẩm bật.
 *  2. Năng lực `create` của sổ đối tượng + tổ chức KHÔNG có nguồn đồng bộ sản phẩm (`orgHasSyncedSource("products")`
 *     — lib/platform/capabilities.ts; sổ đối tượng khai cùng module ở `requiresModuleOff`, bài kiểm khoá hai nơi khớp
 *     nhau). Tổ chức nhà bật Pancake ⇒ từ chối kể cả Quản trị — mã tạo tay sẽ song song với mã đồng bộ của cùng món hàng.
 *  3. Quyền `products:write` (mặc định chỉ Quản trị; vai trò tuỳ chỉnh cấp được).
 *  4. zod → kiểm TRÙNG SKU trong tổ chức (mã sản phẩm với mã sản phẩm, SKU mẫu mã với SKU mẫu mã; không phân biệt hoa
 *     thường) → ghi trong MỘT giao dịch → nhật ký.
 * Sửa: chỉ bản ghi mang id `erp-` (tạo tay). Bản đồng bộ ⇒ từ chối và nói "sửa ở nguồn". Mẫu mã không bao giờ bị XOÁ ở
 * đây: xoá mẫu mã là xoá (cascade) dòng phiếu kho của nó — sổ kho mất chứng từ. Muốn thôi bán thì bỏ "Đang bán".
 *
 * SỔ KHO KHÔNG ĐỔI MỘT DÒNG: tạo mã không ghi phiếu nào — mẫu mã mới là "Chưa có phiếu nhập" (`stockKnown = false`) cho
 * tới khi kho lập phiếu NHẬP HÀNG (luật 10). Giá vốn khai tay chỉ là bậc cuối của thang giá vốn (luật 13).
 */
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { duplicateSkus, isManualRecordId, MANUAL_PRODUCT_ORIGIN, newManualId, skuKey, type ManualProductRaw } from "@/lib/constants/manual-products";
import { objectDef } from "@/lib/constants/object-registry";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { canUseModule, orgHasSyncedSource } from "@/lib/platform/capabilities";
import { manualProductSchema, type ManualProductInput } from "@/lib/validation/products";

export type ProductCreateGate = { allowed: true } | { allowed: false; code: "FORBIDDEN" | "NOT_SUPPORTED" | "MODULE_DISABLED"; reason: string };

/** Người này có được tạo / sửa sản phẩm tạo tay ở tổ chức hiện hành không — trang dùng để hiện nút / trả 404. */
export async function productCreateGate(user: SessionUser): Promise<ProductCreateGate> {
  const def = objectDef("product");
  const create = def?.capabilities.create;
  if (!def || !create) return { allowed: false, code: "NOT_SUPPORTED", reason: "Sản phẩm không tạo tay được." };
  if (!(await canUseModule(def.module))) return { allowed: false, code: "MODULE_DISABLED", reason: "Module Sản phẩm chưa bật cho tổ chức này." };
  if (await orgHasSyncedSource("products")) {
    return { allowed: false, code: "NOT_SUPPORTED", reason: "Tổ chức đang dùng kết nối Pancake: sản phẩm do đồng bộ tạo, không tạo tay (tránh hai mã cho cùng một món hàng)." };
  }
  if (!can(user, "products:write")) return { allowed: false, code: "FORBIDDEN", reason: "Bạn không có quyền tạo / sửa sản phẩm (products:write)." };
  return { allowed: true };
}

/** `variantIds`: mẫu mã vừa TẠO trong lượt này (theo thứ tự gửi lên) — lượt tạo luôn có; lượt sửa không mang. */
export type ProductWriteResult = { ok: true; id: string; variantIds?: string[] } | MetaFailure;

function zodErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];
type DbLike = Awaited<ReturnType<typeof getDb>> | Tx;

/**
 * Trùng mã trong tổ chức: mã sản phẩm với `products.custom_id`, SKU mẫu mã với `product_variants.sku` — bỏ qua CHÍNH bản
 * ghi đang sửa. Trả lỗi theo ô.
 */
async function conflicts(db: DbLike, data: ManualProductInput, self: { productId: string | null; variantIds: string[] }): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const pc = schema.products;
  const pv = schema.productVariants;
  const codeHit = await db
    .select({ id: pc.id })
    .from(pc)
    .where(and(sql`lower(btrim(${pc.customId})) = ${skuKey(data.code)}`, self.productId ? ne(pc.id, self.productId) : undefined))
    .limit(1);
  if (codeHit.length) errors.push({ field: "code", message: `Mã sản phẩm "${data.code}" đã có trong tổ chức — mã phải duy nhất.` });

  const inside = duplicateSkus(data.variants.map((v) => v.sku));
  data.variants.forEach((v, i) => {
    if (inside.some((d) => skuKey(d) === skuKey(v.sku))) errors.push({ field: `variants.${i}.sku`, message: `SKU "${v.sku}" lặp lại trong chính sản phẩm này.` });
  });
  const keys = [...new Set(data.variants.map((v) => skuKey(v.sku)))];
  const taken = await db
    .select({ id: pv.id, key: sql<string>`lower(btrim(${pv.sku}))` })
    .from(pv)
    .where(and(inArray(sql`lower(btrim(${pv.sku}))`, keys), self.variantIds.length ? notInArray(pv.id, self.variantIds) : undefined));
  const takenKeys = new Set(taken.map((t) => t.key));
  data.variants.forEach((v, i) => {
    // Mẫu mã đang sửa giữ nguyên SKU của nó thì không tính là trùng (đã loại khỏi truy vấn ở trên).
    if (takenKeys.has(skuKey(v.sku))) errors.push({ field: `variants.${i}.sku`, message: `SKU "${v.sku}" đã có trong tổ chức — SKU phải duy nhất.` });
  });
  return errors;
}

function variantValues(data: ManualProductInput, v: ManualProductInput["variants"][number]) {
  const retail = v.retailPrice ?? data.retailPrice;
  const cost = v.cost ?? data.cost;
  const detail = [v.color && `Màu: ${v.color}`, v.size && `Size: ${v.size}`].filter(Boolean).join(", ");
  return {
    sku: v.sku,
    size: v.size,
    color: v.color,
    detail,
    // Cột tiền `NOT NULL DEFAULT 0`: "chưa khai" lưu 0 — thang giá vốn đọc 0 là "chưa có" (`nullif`), nhật ký giữ `null`.
    retailPrice: retail ?? 0,
    retailPriceAfterDiscount: retail ?? 0,
    lastImportedPrice: cost ?? 0,
    isHidden: !v.selling,
  };
}

export async function createProductCore(user: SessionUser, rawInput: unknown): Promise<ProductWriteResult> {
  const gate = await productCreateGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const parsed = manualProductSchema.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error.issues));
  const data = parsed.data;
  if (data.variants.some((v) => v.id)) return fail("INVALID", "Sản phẩm mới không mang mẫu mã có sẵn.", "variants");

  const db = await getDb();
  const productId = newManualId();
  const raw: ManualProductRaw = { origin: MANUAL_PRODUCT_ORIGIN, unit: data.unit };
  const result = await db.transaction(async (tx) => {
    const errors = await conflicts(tx, data, { productId: null, variantIds: [] });
    if (errors.length) return { ok: false as const, errors };
    const now = new Date();
    await tx.insert(schema.products).values({ id: productId, name: data.name, customId: data.code, raw, insertedAt: now });
    const variants = data.variants.map((v) => ({ id: newManualId(), productId, insertedAt: now, ...variantValues(data, v) }));
    await tx.insert(schema.productVariants).values(variants);
    return { ok: true as const, variantIds: variants.map((v) => v.id) };
  });
  if (!result.ok) return fail("INVALID", result.errors);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PRODUCT_CREATE",
    entity: "PRODUCT",
    entityId: productId,
    before: null,
    after: { ...data, variantIds: result.variantIds },
    reason: "Tạo tay trên ERP — tổ chức không đồng bộ sản phẩm từ nguồn ngoài",
  });
  return { ok: true, id: productId, variantIds: result.variantIds };
}

export async function updateProductCore(user: SessionUser, productId: string, rawInput: unknown): Promise<ProductWriteResult> {
  const gate = await productCreateGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  if (!isManualRecordId(productId)) return fail("NOT_SUPPORTED", "Sản phẩm đồng bộ từ nguồn ngoài — sửa ở nguồn, không sửa ở ERP (lượt đồng bộ kế tiếp sẽ ghi đè).");
  const parsed = manualProductSchema.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error.issues));
  const data = parsed.data;

  const db = await getDb();
  const before = await db.query.products.findFirst({ where: eq(schema.products.id, productId), with: { variants: true } });
  if (!before) return fail("NOT_FOUND", "Không tìm thấy sản phẩm trong tổ chức này.");
  const own = new Map(before.variants.map((v) => [v.id, v]));
  const errors: FieldError[] = [];
  data.variants.forEach((v, i) => {
    if (!v.id) return;
    if (!own.has(v.id)) errors.push({ field: `variants.${i}.id`, message: "Mẫu mã không thuộc sản phẩm này." });
    else if (!isManualRecordId(v.id)) errors.push({ field: `variants.${i}.id`, message: "Mẫu mã đồng bộ từ nguồn ngoài — không sửa ở ERP." });
  });
  if (new Set(data.variants.filter((v) => v.id).map((v) => v.id)).size !== data.variants.filter((v) => v.id).length) errors.push({ field: "variants", message: "Một mẫu mã được gửi hai lần." });
  if (errors.length) return fail("INVALID", errors);

  const raw: ManualProductRaw = { origin: MANUAL_PRODUCT_ORIGIN, unit: data.unit };
  const result = await db.transaction(async (tx) => {
    // Mẫu mã KHÔNG gửi lên vẫn nằm nguyên — loại chúng khỏi phép so trùng là sai, nên chỉ loại mẫu mã đang sửa.
    const errs = await conflicts(tx, data, { productId, variantIds: data.variants.flatMap((v) => (v.id ? [v.id] : [])) });
    if (errs.length) return { ok: false as const, errors: errs };
    const now = new Date();
    await tx.update(schema.products).set({ name: data.name, customId: data.code, raw, updatedAt: now }).where(eq(schema.products.id, productId));
    const added: string[] = [];
    for (const v of data.variants) {
      if (v.id) await tx.update(schema.productVariants).set({ ...variantValues(data, v), updatedAt: now }).where(and(eq(schema.productVariants.id, v.id), eq(schema.productVariants.productId, productId)));
      else {
        const id = newManualId();
        added.push(id);
        await tx.insert(schema.productVariants).values({ id, productId, insertedAt: now, ...variantValues(data, v) });
      }
    }
    return { ok: true as const, added };
  });
  if (!result.ok) return fail("INVALID", result.errors);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "PRODUCT_UPDATE",
    entity: "PRODUCT",
    entityId: productId,
    before: { name: before.name, code: before.customId, raw: before.raw, variants: before.variants.map((v) => ({ id: v.id, sku: v.sku, size: v.size, color: v.color, retailPrice: v.retailPrice, cost: v.lastImportedPrice, selling: !v.isHidden })) },
    after: { ...data, addedVariantIds: result.added },
    reason: "Sửa sản phẩm tạo tay trên ERP",
  });
  return { ok: true, id: productId };
}

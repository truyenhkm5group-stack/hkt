"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { isHomeOrg } from "@/lib/branding/copy";
import { isReceiptPricingMode, RECEIPT_PRICING_SETTING_KEY } from "@/lib/constants/receipt-pricing-mode";
import type { MetadataErrorCode } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { createProductCore, updateProductCore } from "@/lib/records/product-create";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ SẢN PHẨM TẠO TAY + CÁCH ĐỊNH GIÁ PHIẾU NHẬP (pilot P0 #1/#2 · P1 #9) ═══════════
 *
 * Mỏng: phiên → lõi (`lib/records/product-create.ts` — cổng năng lực tổ chức, quyền, zod, trùng SKU, giao dịch, nhật
 * ký) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error, errors, code }`, không ném.
 */

type Failure = { error: string; errors: FieldError[]; code: MetadataErrorCode };

function failure(r: { code: MetadataErrorCode; errors: FieldError[] }): Failure {
  return { error: r.errors.map((e) => e.message).join(" · ") || "Không lưu được.", errors: r.errors, code: r.code };
}

function revalidateProducts(id?: string) {
  for (const path of ["/products", "/inventory/receipts", "/inventory"]) revalidatePath(path);
  if (id) revalidatePath(`/products/${id}`);
}

/** Tạo sản phẩm + mẫu mã — chỉ khi tổ chức KHÔNG bật `connector_pancake` và người bấm có `products:write`. */
export async function createProductAction(input: unknown): Promise<{ ok: true; id: string; redirectTo: string; message: string } | Failure> {
  const user = await requireUser();
  const r = await createProductCore(user, input);
  if (!r.ok) return failure(r);
  revalidateProducts(r.id);
  return { ok: true, id: r.id, redirectTo: `/products/${r.id}`, message: "Đã tạo sản phẩm" };
}

/** Sửa sản phẩm TẠO TAY (id `erp-…`); bản đồng bộ bị từ chối ở lõi. */
export async function updateProductAction(productId: string, input: unknown): Promise<{ ok: true; id: string; message: string } | Failure> {
  const user = await requireUser();
  if (typeof productId !== "string" || !productId) return { error: "Thiếu mã sản phẩm.", errors: [{ field: "_", message: "Thiếu mã sản phẩm." }], code: "INVALID" };
  const r = await updateProductCore(user, productId, input);
  if (!r.ok) return failure(r);
  revalidateProducts(r.id);
  return { ok: true, id: r.id, message: "Đã lưu sản phẩm" };
}

/**
 * Chọn cách định giá phiếu nhập hàng mới của tổ chức (`inventory.receiptPricing`). Chỉ tổ chức KHÁC nhà: tổ chức nhà
 * theo giá báo MKT do chủ shop chốt — đổi là việc phải hỏi chủ shop, không phải một cú bấm.
 */
export async function setReceiptPricingModeAction(mode: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) return { error: "Cần quyền cài đặt để đổi cách định giá phiếu nhập." };
  if (isHomeOrg(user)) return { error: "Tổ chức nhà luôn lấy giá báo MKT cho phiếu nhập (chủ shop chốt 25/09/2026)." };
  if (!isReceiptPricingMode(mode)) return { error: "Cách định giá không hợp lệ." };
  const before = await getSettingJson<unknown>(RECEIPT_PRICING_SETTING_KEY, null);
  await setSettingJson(RECEIPT_PRICING_SETTING_KEY, mode);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTING_UPDATE", entity: "SETTING", entityId: RECEIPT_PRICING_SETTING_KEY, before, after: mode, reason: "Đổi cách định giá phiếu nhập hàng mới" });
  revalidatePath("/inventory/receipts");
  return { ok: true };
}

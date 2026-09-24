"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { ESTIMATED_COST_KEY, ESTIMATED_UNIT_COST_MAX, parseEstimatedCosts, type EstimatedCost } from "@/lib/constants/estimated-cost";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ ĐẶT GIÁ VỐN DỰ TÍNH CHO MỘT MÃ — MỘT ĐƯỜNG GHI, MỘT KHOÁ ═══════════
 *
 * Đọc bản lưu TỪ MÁY CHỦ rồi chỉ thay đúng một mã: client không gửi những mã nó không sửa, nên
 * không có cách nào xoá chúng (cùng bài học với `setDeliveryRateOverride`).
 *
 * KHÔNG qua cổng người thứ hai: giá dự tính chỉ đi vào báo cáo lợi nhuận DANH NGHĨA, không vào
 * lương, không vào dòng tiền thực, không vào kỳ đã chốt, và TỰ đứng sang một bên khi mã có giá nhập
 * thật. Bán kính của một con số sai là hữu hạn và tự đóng — giống ghi đè tỷ lệ loại TẠM.
 *
 * `clearMemo()` vì người vừa bấm lưu phải thấy NGAY con số mới: báo cáo được nhớ đệm 120 giây, và
 * `revalidatePath` chỉ dựng lại trang chứ không xoá đệm — trang sẽ vẽ lại đúng con số cũ.
 */
const schema = z.object({
  productId: z.string().min(1, "Thiếu mã hàng"),
  unitCost: z.number().int("Giá vốn là số nguyên VND").min(1, "Giá vốn dự tính phải lớn hơn 0").max(ESTIMATED_UNIT_COST_MAX, "Giá vốn quá lớn — kiểm tra lại số 0"),
  reason: z.string().trim().min(3, "Phải ghi vì sao đặt con số này"),
});

async function docBanLuu() {
  return parseEstimatedCosts(await getSettingJson<Record<string, unknown>>(ESTIMATED_COST_KEY, {}));
}

export async function setEstimatedCost(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "reports:assumptions")) return { error: "Không có quyền" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { productId, unitCost, reason } = parsed.data;

  const before = await docBanLuu();
  const entry: EstimatedCost = { unitCost, reason, setAt: new Date().toISOString(), setBy: user.email };
  await setSettingJson(ESTIMATED_COST_KEY, { ...before, [productId]: entry });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: `${ESTIMATED_COST_KEY}#${productId}`,
    detail: { productId, before: before[productId] ?? null, after: entry },
  });
  clearMemo();
  revalidatePath("/reports");
  return { ok: true };
}

/** Bỏ giá dự tính — mã quay về "chưa biết giá vốn" cho tới khi có phiếu nhập. */
export async function clearEstimatedCost(productId: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "reports:assumptions")) return { error: "Không có quyền" };
  if (!productId) return { error: "Thiếu mã hàng" };
  const before = await docBanLuu();
  const cu = before[productId];
  if (!cu) return { ok: true };
  const sau = { ...before };
  delete sau[productId];
  await setSettingJson(ESTIMATED_COST_KEY, sau);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: `${ESTIMATED_COST_KEY}#${productId}`,
    detail: { productId, before: cu, after: null },
  });
  clearMemo();
  revalidatePath("/reports");
  return { ok: true };
}

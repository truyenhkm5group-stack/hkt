"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { audit } from "@/lib/audit";
import { clearMemo } from "@/lib/cache";
import { can, requireUser } from "@/lib/auth/session";
import { parseDeliveryRateOverride, type StoredDeliveryRateOverride } from "@/lib/constants/delivery-rate";
import { DEFAULT_PROFIT_ASSUMPTIONS, PROFIT_ASSUMPTIONS_KEY, type ProfitAssumptions } from "@/lib/constants/profit";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ ĐẶT TAY TỶ LỆ GTC CHO MỘT MÃ — MỘT ĐƯỜNG GHI, KHÔNG ĐỤNG GIẢ ĐỊNH KHÁC ═══════════
 *
 * ─── VÌ SAO KHÔNG DÙNG LẠI `saveProfitAssumptions` ───
 *
 * `saveProfitAssumptions` nhận TOÀN BỘ bản giả định và lược đồ của nó có `.default()` ở 8 trường.
 * Ô ghi đè tỷ lệ trên màn hình chỉ gửi 6 trường, nên mỗi lần chủ shop sửa tỷ lệ của MỘT mã thì
 * `packingFeePerOrder` · `opsStaffPerOrder` · `opsStaffPerRescued` · `rescueRatePercent` ·
 * `fixedCostMonthly` · `inventoryRiskPercent` · `taxPercent` · `otherCostPercentOfAds` ·
 * `failedToReturnPercent` **âm thầm bị đặt lại về mặc định** — `fixedCostMonthly` về 5.000.000 ₫
 * bất kể chủ shop đã khai bao nhiêu. Không có thông báo nào, và con số lợi nhuận của mọi mã đổi
 * theo.
 *
 * Đường ghi này đọc bản giả định TỪ MÁY CHỦ rồi chỉ thay đúng một khoá trong `overrides`. Client
 * không gửi đi những trường nó không sửa, nên nó không có cách nào xoá chúng.
 *
 * ─── HAI TUỔI THỌ, HAI MỨC CỔNG ───
 *
 * `UNTIL_MATURE` là việc thường ngày của một mã mới: nó tự hết hiệu lực khi mã đủ chín, nên bán
 * kính ảnh hưởng của một con số sai là hữu hạn và tự đóng. Đi thẳng, có vết kiểm toán.
 *
 * `PERMANENT` thì khác: nó ĐÈ LÊN CẢ SỐ ĐO THẬT, mãi mãi, ở mọi báo cáo đọc thang bậc này. Đó đúng
 * là thứ `BUSINESS_RULE_CHANGE` sinh ra để chặn, nên nhánh ấy đi qua cổng người thứ hai như
 * `saveProfitAssumptions`.
 *
 * TÊN NGƯỜI ĐẶT do MÁY CHỦ đọc từ phiên đăng nhập, không nhận từ client (mục 34).
 */
const schema = z.object({
  productId: z.string().min(1, "Thiếu mã hàng"),
  /** Tỷ lệ GIAO THÀNH CÔNG (%) — đây là con số chủ shop nhìn thấy trên màn hình. */
  deliveryRate: z.number().min(0).max(100),
  reason: z.string().trim().min(3, "Phải ghi vì sao đặt con số này"),
  mode: z.enum(["PERMANENT", "UNTIL_MATURE"]).default("UNTIL_MATURE"),
});

async function docGiaDinh(): Promise<ProfitAssumptions> {
  return getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
}

export async function setDeliveryRateOverride(input: unknown): Promise<{ ok: true } | { error: string }> {
  return withApprovalExecution(async () => {
    const user = await requireUser();
    if (!can(user, "reports:assumptions")) return { error: "Không có quyền" };
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const { productId, deliveryRate, reason, mode } = parsed.data;

    const before = await docGiaDinh();
    if (mode === "PERMANENT") {
      const cong = await guardSecondApproval({
        group: "BUSINESS_RULE_CHANGE",
        action: "reports.deliveryRateOverride",
        entity: "SETTINGS",
        entityId: `${PROFIT_ASSUMPTIONS_KEY}#${productId}`,
        summary: `Ghi đè VĨNH VIỄN tỷ lệ giao thành công của mã ${productId} = ${deliveryRate}%`,
        amount: null,
        payload: { productId, deliveryRate, reason, truoc: before.overrides?.[productId] ?? null },
      });
      if (cong.mode === "NEEDS_APPROVAL") return { error: `Ghi đè vĩnh viễn cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cần xử lý.` };
      if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Ghi đè vĩnh viễn cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    }

    const entry: StoredDeliveryRateOverride = {
      // LƯU TỶ LỆ HOÀN, không phải GTC: mọi dòng đã có trong `settings` là tỷ lệ hoàn, và trộn hai
      // quy ước trong cùng một bản đồ là cách chắc chắn để một ngày nào đó đọc ngược con số.
      returnRate: Math.min(100, Math.max(0, 100 - deliveryRate)),
      mode,
      reason,
      setAt: new Date().toISOString(),
      setBy: user.email,
    };
    const overrides = { ...(before.overrides ?? {}), [productId]: entry };
    await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...before, overrides });
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "SETTINGS_UPDATE",
      entity: "SETTINGS",
      entityId: `${PROFIT_ASSUMPTIONS_KEY}#${productId}`,
      detail: { productId, before: before.overrides?.[productId] ?? null, after: entry },
    });
    // Báo cáo được nhớ đệm 120 giây; người vừa bấm lưu phải thấy ngay tỷ lệ mới.
    clearMemo();
    revalidatePath("/reports");
    return { ok: true };
  });
}

/** Bỏ ghi đè — mã quay về thang bậc tự động (số đo / co ngót / tỷ lệ khai). */
export async function clearDeliveryRateOverride(productId: string): Promise<{ ok: true } | { error: string }> {
  return withApprovalExecution(async () => {
    const user = await requireUser();
    if (!can(user, "reports:assumptions")) return { error: "Không có quyền" };
    if (!productId) return { error: "Thiếu mã hàng" };
    const before = await docGiaDinh();
    const cu = before.overrides?.[productId];
    if (cu === undefined) return { ok: true };

    // Gỡ một ghi đè VĨNH VIỄN cũng là đổi luật đọc số: nó trả mã về cho máy đo, và con số lợi nhuận
    // của mọi kỳ đã in đổi theo. Cùng cổng với lúc đặt nó.
    if (parseDeliveryRateOverride(cu)?.mode === "PERMANENT") {
      const cong = await guardSecondApproval({
        group: "BUSINESS_RULE_CHANGE",
        action: "reports.deliveryRateOverride.clear",
        entity: "SETTINGS",
        entityId: `${PROFIT_ASSUMPTIONS_KEY}#${productId}`,
        summary: `Bỏ ghi đè VĨNH VIỄN tỷ lệ giao thành công của mã ${productId}`,
        amount: null,
        payload: { productId, truoc: cu },
      });
      if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cần xử lý.` };
      if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    }

    const overrides = { ...(before.overrides ?? {}) };
    delete overrides[productId];
    await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...before, overrides });
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "SETTINGS_UPDATE",
      entity: "SETTINGS",
      entityId: `${PROFIT_ASSUMPTIONS_KEY}#${productId}`,
      detail: { productId, before: cu, after: null },
    });
    // Báo cáo được nhớ đệm 120 giây; người vừa bấm lưu phải thấy ngay tỷ lệ mới.
    clearMemo();
    revalidatePath("/reports");
    return { ok: true };
  });
}

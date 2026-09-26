"use server";

import { revalidatePath } from "next/cache";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { DEFAULT_PROFIT_ASSUMPTIONS, PROFIT_ASSUMPTIONS_KEY, type ProfitAssumptions } from "@/lib/constants/profit";
import { getSettingJson, setSettingJson } from "@/lib/settings";

const schema = z.object({
  shipFeeDelivered: z.number().int().min(0).max(1_000_000),
  shipFeeReturned: z.number().int().min(0).max(1_000_000),
  packingFeePerOrder: z.number().int().min(0).max(1_000_000).default(5_000),
  opsStaffPerOrder: z.number().int().min(0).max(1_000_000).default(2_000),
  opsStaffPerRescued: z.number().int().min(0).max(1_000_000).default(10_000),
  rescueRatePercent: z.number().min(0).max(100).default(10),
  fixedCostMonthly: z.number().int().min(0).max(10_000_000_000).default(5_000_000),
  returnRateWindowDays: z.number().int().min(7).max(730),
  defaultReturnRate: z.number().min(0).max(100),
  minFinishedOrders: z.number().int().min(1).max(10_000),
  rateMatureMinFinished: z.number().int().min(1).max(10_000).default(DEFAULT_PROFIT_ASSUMPTIONS.rateMatureMinFinished),
  /*
    HAI DẠNG, VÌ KHO `settings` ĐANG CÓ CẢ HAI. Số trần là dòng lưu trước 23/09/2026 (nghĩa: giữ
    vĩnh viễn); bản khai là dòng mới, có lý do và tự nhường chỗ khi mã đủ chín. Thu hẹp lược đồ về
    một dạng sẽ làm lượt lưu kế tiếp **xoá sạch** mọi ghi đè dạng kia — zod loại bỏ thứ nó không
    nhận, và ở đây nó im lặng.

    Đặt tay tỷ lệ cho MỘT mã đi qua `lib/actions/delivery-rate-override.ts`; đường này chỉ cần nhận
    lại `overrides` nguyên vẹn để biểu mẫu Giả định không làm rơi mất chúng.
  */
  overrides: z.record(
    z.string(),
    z.union([
      z.number().min(0).max(100),
      z.object({
        returnRate: z.number().min(0).max(100),
        mode: z.enum(["PERMANENT", "UNTIL_MATURE"]).optional(),
        reason: z.string().optional(),
        setAt: z.string().nullable().optional(),
        setBy: z.string().nullable().optional(),
      }),
    ]),
  ),
  // MỘT mặc định duy nhất (`DEFAULT_PROFIT_ASSUMPTIONS`): trước đây ở đây ghi 5 trong khi hằng số
  // ghi 10 — hai nơi nói hai số, và giá trị nào thắng tuỳ vào việc biểu mẫu có gửi trường này hay không.
  inventoryRiskPercent: z.number().min(0).max(100).default(DEFAULT_PROFIT_ASSUMPTIONS.inventoryRiskPercent),
  taxPercent: z.number().min(0).max(50).default(1.5),
  otherCostPercentOfAds: z.number().min(0).max(50).default(1.1),
  failedToReturnPercent: z.number().min(0).max(100).default(0),
});

export async function saveProfitAssumptions(input: unknown): Promise<{ ok: true } | { error: string }> {
  return withApprovalExecution(async () => {
    const user = await requireUser();
    if (!can(user, "reports:assumptions")) return { error: "Không có quyền" };
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const before = await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
    {
      // Đổi giả định lợi nhuận là đổi cách ĐỌC mọi số liệu lịch sử cùng lúc — báo cáo tháng trước in
      // lại sẽ ra con số khác mà không ai đụng vào dữ liệu của tháng đó.
      const cong = await guardSecondApproval({
        group: "BUSINESS_RULE_CHANGE",
        action: "reports.assumptions",
        entity: "SETTINGS",
        entityId: PROFIT_ASSUMPTIONS_KEY,
        summary: `Đổi giả định lợi nhuận`,
        amount: null,
        payload: { truoc: before, sau: parsed.data },
      });
      if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cần xử lý.` };
      if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    }
    await setSettingJson(PROFIT_ASSUMPTIONS_KEY, parsed.data);
    await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PROFIT_ASSUMPTIONS_KEY, detail: { before, after: parsed.data } });
    revalidatePath("/reports");
    return { ok: true };
  });
}

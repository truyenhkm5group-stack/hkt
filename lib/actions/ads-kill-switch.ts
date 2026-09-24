"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { ADS_WRITE_KILL_KEY } from "@/lib/constants/ads-kill-switch";
import { readAdsKillSwitch } from "@/lib/integrations/facebook/ads-write";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ KÉO / NHẢ CÔNG TẮC KHẨN CẤP ĐƯỜNG GHI QUẢNG CÁO ═══════════
 *
 * Luật và lý do: `lib/constants/ads-kill-switch.ts`. Đường cùng việc không cần giao diện: ops
 * `set-setting ads.write.kill '{"killed":true,"reason":"…"}'`.
 *
 * ─── QUYỀN BẤT ĐỐI XỨNG, CỐ Ý ───
 *
 *  · KÉO (đóng đường ghi): ai duyệt được lô / tiêu thêm (`expenses:write`) hoặc quản trị cấu hình
 *    (`settings:manage`). Người được phép cho tiền chảy ra thì phải được phép làm nó ngừng chảy — và
 *    lúc khẩn cấp không ai nên phải đi tìm người có quyền cao hơn.
 *  · NHẢ (mở lại): chỉ `settings:manage`. Mở lại là cho máy tiêu tiền tiếp, cùng tầm với sửa cấu
 *    hình vòng mẫu (`saveCreativeConfig`).
 *
 * Lý do bắt buộc ở CẢ HAI chiều: sáng hôm sau người đọc sổ phải biết vì sao đường ghi đóng/mở.
 * Người thao tác do MÁY CHỦ ghi từ phiên (mục 34), không nhận từ client.
 */
const inputSchema = z.object({
  killed: z.boolean(),
  reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự) — sổ phải nói vì sao đường ghi đóng/mở.").max(300),
});

export type KillSwitchActionResult = { ok: true; killed: boolean } | { error: string };

export async function setAdsWriteKillSwitch(input: unknown): Promise<KillSwitchActionResult> {
  const user = await requireUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { killed, reason } = parsed.data;

  if (killed ? !(can(user, "expenses:write") || can(user, "settings:manage")) : !can(user, "settings:manage")) {
    return {
      error: killed
        ? "Cần quyền “Chi phí vận hành & Quảng cáo: sửa” hoặc “Cấu hình hệ thống khác” để kéo công tắc khẩn cấp."
        : "Chỉ người có quyền “Cấu hình hệ thống khác” mới được nhả công tắc — nhả là cho máy tiêu tiền tiếp.",
    };
  }

  const before = await readAdsKillSwitch();
  const after = { killed, reason, by: user.email, at: new Date().toISOString() };
  await setSettingJson(ADS_WRITE_KILL_KEY, after);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: killed ? "ADS_WRITE_KILL_ENGAGE" : "ADS_WRITE_KILL_RELEASE",
    entity: "SETTINGS",
    entityId: ADS_WRITE_KILL_KEY,
    before,
    after,
    reason,
  });
  revalidatePath("/marketing/creatives");
  revalidatePath("/ads");
  return { ok: true, killed };
}

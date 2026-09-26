"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { assignBatchNames, saveVariantNamesCore } from "@/lib/creative/naming";
import { variantNamesInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — SỬA TÊN CHIẾN DỊCH · NHÓM · QUẢNG CÁO TRƯỚC KHI DUYỆT (§5i) ═══════════
 *
 * Mọi luật ở `lib/creative/naming.ts::saveVariantNamesCore` (cùng điều kiện với sửa câu chữ: lô chưa duyệt,
 * còn hạn, mẫu `GENERATED`). Quyền `ideas:write` — biên tập nội dung, chưa chạm tiền. Tên nằm trong digest
 * của phiếu duyệt ⇒ phiếu đã phát mất hiệu lực. Để trống một ô = dùng lại tên mặc định theo khuôn (điền lại
 * ngay trong action).
 */

const PATH = "/marketing/creatives";

export async function saveVariantNames(raw: unknown): Promise<{ ok: true; changed: boolean } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = variantNamesInputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Đầu vào không hợp lệ" };
  const db = await getDb();
  const now = new Date();
  const r = await saveVariantNamesCore(db, parsed.data, now);
  if (!r.ok) return { error: r.error };
  if (!r.changed) {
    // Không đổi gì vẫn làm mới: trang có thể đang cũ (người khác vừa làm) — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
    revalidatePath(PATH);
    return { ok: true, changed: false };
  }
  // Ô để trống ⇒ điền lại tên mặc định ngay, để người thấy tên sẽ đăng mà không phải đợi lượt vòng mẫu.
  await assignBatchNames(db, r.batchId, now);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_VARIANT_NAMES_EDITED",
    entity: "CREATIVE_VARIANT",
    entityId: parsed.data.variantId,
    before: r.before,
    after: { ...r.after, batchId: r.batchId, batchDay: r.batchDay },
    reason: `Sửa tên chiến dịch / nhóm / quảng cáo trước khi duyệt lô ${r.batchDay} — phiếu duyệt đã phát (nếu có) mất hiệu lực.`,
  });
  revalidatePath(PATH);
  return { ok: true, changed: true };
}

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/constants/actor";
import { REVOKE_AUDIT_ACTION, revokeMarkFrom, revokeNeedsReason, type RevokeTrigger } from "@/lib/constants/session-revocation";

/**
 * ═══════════ MỘT ĐƯỜNG GHI DUY NHẤT CHO MỘT LƯỢT THU HỒI ═══════════
 *
 * Bốn nguyên nhân (tự đăng xuất mọi thiết bị · quản trị thu hồi · đổi mật khẩu · khoá tài khoản)
 * đều đi qua đúng hàm này. Không server action nào được tự viết câu `UPDATE` — nếu có hai đường
 * ghi thì chỉ cần một đường quên `GREATEST` là luật "chỉ tiến" mất hiệu lực, mà lỗi đó KHÔNG lộ ra
 * ở đâu cả: mốc lùi lại nghĩa là GỠ THU HỒI, và hệ thống vẫn chạy bình thường.
 */

export type RevokeResult = {
  /** Mốc TRƯỚC lượt ghi — `null` = tài khoản này chưa từng bị thu hồi. */
  before: Date | null;
  /** Mốc SAU lượt ghi. Luôn ≥ `before`. */
  after: Date;
  /** `false` khi lượt ghi không làm mốc tiến lên (một lượt thu hồi khác vừa ghi mốc muộn hơn). */
  advanced: boolean;
};

export class RevokeReasonRequired extends Error {
  constructor(trigger: RevokeTrigger) {
    super(`Thu hồi phiên kiểu ${trigger} bắt buộc phải có lý do`);
    this.name = "RevokeReasonRequired";
  }
}

/**
 * Thu hồi mọi phiên của một người, rồi ghi nhật ký.
 *
 * @returns `null` khi không tìm thấy tài khoản (không ghi nhật ký — không có gì đã xảy ra).
 */
export async function applySessionRevocation(params: {
  targetUserId: string;
  targetEmail: string;
  trigger: RevokeTrigger;
  /** BẮT BUỘC với `ADMIN_REVOKE`. Xem `revokeNeedsReason()`. */
  reason?: string;
  actor: Actor;
  nowMs?: number;
}): Promise<RevokeResult | null> {
  const reason = params.reason?.trim() ?? "";
  // Chặn ở TẦNG DỊCH VỤ, không chỉ ở lược đồ đầu vào: một đường gọi mới (job, script, action khác)
  // không đi qua zod vẫn phải gặp cùng một luật.
  if (revokeNeedsReason(params.trigger) && !reason) throw new RevokeReasonRequired(params.trigger);

  const mark = new Date(revokeMarkFrom(params.nowMs ?? Date.now()));
  const db = await getDb();

  /*
    TRƯỚC và SAU lấy trong CÙNG MỘT câu lệnh.

    Đọc trước rồi ghi sau là hai lượt, và giữa hai lượt ấy một lần thu hồi khác có thể chen vào —
    lúc đó nhật ký in một giá trị "trước" chưa bao giờ là trạng thái ngay trước lượt ghi này. Bản
    tự nối (`FROM users truoc`) đọc dòng cũ ở đầu câu lệnh nên `truoc` luôn là giá trị tiền-UPDATE.

    `GREATEST` là luật CHỈ TIẾN. Trigger trong migration 0106 khoá lại lần nữa ở tầng CSDL, phòng
    một câu `UPDATE` gõ tay ở ops.
  */
  const rows = await db.execute<{ truoc: string | null; sau: string }>(sql`
    UPDATE "users" u
    SET "session_invalid_before" = GREATEST(COALESCE(u."session_invalid_before", 'epoch'::timestamptz), ${mark.toISOString()}::timestamptz)
    FROM "users" truoc
    WHERE u."id" = ${params.targetUserId} AND truoc."id" = u."id"
    RETURNING truoc."session_invalid_before" AS truoc, u."session_invalid_before" AS sau
  `);

  const row = (rows as unknown as { rows?: { truoc: string | null; sau: string }[] }).rows?.[0] ?? (rows as unknown as { truoc: string | null; sau: string }[])[0];
  if (!row) return null;

  const before = row.truoc ? new Date(row.truoc) : null;
  const after = new Date(row.sau);
  const advanced = !before || after.getTime() > before.getTime();

  await audit({
    userId: params.actor.id,
    userEmail: params.actor.label,
    action: REVOKE_AUDIT_ACTION,
    entity: "USER",
    entityId: params.targetUserId,
    before: { sessionInvalidBefore: before ? before.toISOString() : null },
    after: { sessionInvalidBefore: after.toISOString() },
    reason: reason || undefined,
    detail: { email: params.targetEmail, trigger: params.trigger, advanced },
  });

  return { before, after, advanced };
}

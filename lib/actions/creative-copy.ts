"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { CaptionOption } from "@/lib/creative/caption";
import { saveVariantCopyCore, suggestVariantCopyCore } from "@/lib/creative/copy-edit";
import { variantCopyInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — SOẠN CÂU CHỮ TRƯỚC KHI DUYỆT ═══════════
 *
 * Hai cú bấm ở mỗi thẻ mẫu của tab Duyệt lô:
 *  · "AI gợi ý theo ảnh" (`suggestVariantCopy`) — CHỈ ĐỌC + gọi mô hình đọc ảnh, trả 2–3 phương án.
 *    Không ghi gì vào mẫu: người chọn một phương án, sửa nếu muốn, rồi mới bấm Lưu.
 *  · "Lưu" (`saveVariantCopy`) — ghi tiêu đề + nội dung chính. Mọi luật ở `lib/creative/copy-edit.ts`.
 *
 * Quyền `ideas:write` — cùng quyền gạt mẫu / tải mẫu tự làm: đây là việc BIÊN TẬP nội dung, chưa chạm
 * tiền. Tiền chỉ đi sau lượt duyệt lô (quyền `expenses:write`), và câu chữ nằm trong digest của phiếu
 * duyệt — sửa một chữ là phiếu đã phát mất hiệu lực, người duyệt phải mở lại và bấm duyệt lại.
 */

const PATH = "/marketing/creatives";

type Fail = { error: string };

const suggestSchema = z.object({ variantId: z.string().trim().min(1) }).strict();

export async function suggestVariantCopy(raw: { variantId: string }): Promise<{ ok: true; options: CaptionOption[]; seen: string; model: string; priceStripped: boolean } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = suggestSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const r = await suggestVariantCopyCore(db, parsed.data.variantId, new Date());
  if (!r.ok) return { error: r.error };
  return { ok: true, options: r.options, seen: r.seen, model: r.model, priceStripped: r.priceStripped };
}

export async function saveVariantCopy(raw: unknown): Promise<{ ok: true; changed: boolean; warnings: string[] } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = variantCopyInputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Đầu vào không hợp lệ" };

  const db = await getDb();
  const r = await saveVariantCopyCore(db, parsed.data, new Date());
  if (!r.ok) return { error: r.error };
  if (!r.changed) return { ok: true, changed: false, warnings: r.warnings };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_VARIANT_COPY_EDITED",
    entity: "CREATIVE_VARIANT",
    entityId: parsed.data.variantId,
    before: r.before,
    after: { ...r.after, batchId: r.batchId, batchDay: r.batchDay, warnings: r.warnings },
    reason: `Sửa câu chữ trước khi duyệt lô ${r.batchDay} — phiếu duyệt đã phát (nếu có) mất hiệu lực.`,
  });
  revalidatePath(PATH);
  return { ok: true, changed: true, warnings: r.warnings };
}

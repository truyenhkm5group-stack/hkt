"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { DISPOSITION_LABEL, RETURN_DISPOSITIONS } from "@/lib/constants/return-disposition";
import { setReturnDispositionCore, type SetDispositionResult } from "@/lib/returns/disposition";

/**
 * ═══════════ KẾT CỤC HÀNG HOÀN KHÔNG TÁI NHẬP — ĐƯỜNG GHI TỪ TRẠM KIỂM ═══════════
 *
 * Khuôn của kho mã: `requireUser` → `can("inventory:write")` → zod → lõi dịch vụ (một giao dịch:
 * phiếu tái nhập nếu có + dòng sổ + sự kiện) → `audit()` → `revalidatePath`. Lỗi nghiệp vụ trả
 * `{ error }`.
 *
 * TÊN NGƯỜI LÀM DO MÁY CHỦ ĐỌC từ phiên đăng nhập (luật 34) — form không gửi tên.
 * Huỷ bỏ đi qua `guardSecondApproval` nhóm `INVENTORY_WRITE_OFF` có sẵn (lõi gọi cổng TRƯỚC giao dịch).
 */

const input = z.object({
  subjectKey: z.string().trim().min(3).max(200),
  disposition: z.enum(RETURN_DISPOSITIONS),
  qty: z.number().int().positive().max(100_000).nullable().default(null),
  note: z.string().max(1000).default(""),
  variantId: z.string().trim().max(100).nullable().optional(),
  requestKey: z.string().trim().min(8).max(100).nullable().optional(),
});

function revalidate() {
  for (const path of ["/inventory/returns", "/inventory", "/products", "/inventory/planning", "/work", "/models"]) revalidatePath(path);
}

export async function setReturnDisposition(raw: unknown): Promise<SetDispositionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const db = await getDb();
  const res = await setReturnDispositionCore(db, {
    ...parsed.data,
    actor: { id: user.id, label: user.name || user.email },
    gate: guardSecondApproval,
  });
  if ("error" in res || res.replayed) return res;

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "RETURN_DISPOSITION_SET",
    entity: "RETURN_DISPOSITION",
    entityId: res.dispositionId,
    after: {
      subjectKey: parsed.data.subjectKey,
      disposition: parsed.data.disposition,
      label: DISPOSITION_LABEL[parsed.data.disposition],
      qty: parsed.data.qty,
      stockReceiptId: res.receiptId,
      valueEstimate: res.valueEstimate,
    },
    reason: parsed.data.note.trim() || undefined,
  });
  revalidate();
  return res;
}

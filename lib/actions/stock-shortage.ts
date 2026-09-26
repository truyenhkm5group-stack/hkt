"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { SHORTAGE_DECISIONS, SHORTAGE_DECISIONS_KEY, SHORTAGE_DECISION_LABEL, type ShortageDecisionBook } from "@/lib/constants/stock-shortage";
import { getStockShortage } from "@/lib/queries/stock-shortage";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ BA NÚT CỦA TIN LARK THIẾU HÀNG ═══════════
 *
 * Chỉ ghi sổ `inventory.shortage.decisions` — quyết định NHẮC hay không nhắc trên Lark. Không tạo lệnh
 * sản xuất, không đổi tồn, không đổi đơn: đơn đang chờ vẫn ở hàng đợi CSKH dù mẫu đã tắt nhắc.
 *
 * Mức thiếu lúc bấm do MÁY CHỦ đọc, không nhận từ client: link Lark có thể được mở sau vài giờ, và
 * "đã đặt" phải gắn với con số của lúc người bấm, không phải con số trong tin cũ.
 */

const decideSchema = z.object({
  variantId: z.string().trim().min(1).max(120),
  decision: z.enum(SHORTAGE_DECISIONS),
  note: z.string().trim().max(300).default(""),
});

export async function decideShortage(input: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Cần quyền lập bảng đặt hàng sản xuất để xác nhận" };
  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { variantId, decision, note } = parsed.data;

  const snapshot = await getStockShortage({ fresh: true });
  const row = snapshot.variants.find((v) => v.variantId === variantId);
  if (!row) return { error: "Mẫu này hiện không thiếu hàng cho đơn đã chốt — không có gì để xác nhận." };

  const book = await getSettingJson<ShortageDecisionBook>(SHORTAGE_DECISIONS_KEY, {});
  const entry = { decision, at: new Date().toISOString(), byUserId: user.id, byName: user.name || user.email, shortQtyAtDecision: row.shortQty, note };
  await setSettingJson(SHORTAGE_DECISIONS_KEY, { ...book, [variantId]: entry });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "STOCK_SHORTAGE_DECISION",
    entity: "VARIANT",
    entityId: variantId,
    detail: { decision, shortQty: row.shortQty, waitingOrders: row.waitingOrders, previous: book[variantId]?.decision ?? null, note },
  });
  revalidatePath("/inventory/shortage");
  const label = `${row.productCode || row.productName} ${[row.color, row.size].filter(Boolean).join("/")}`;
  return { ok: true, message: `${label}: ${SHORTAGE_DECISION_LABEL[decision]} (thiếu ${row.shortQty})` };
}

/** Bỏ quyết định — mẫu quay lại được nhắc như bình thường. Dùng cho "không đặt nữa" bấm nhầm. */
export async function clearShortageDecision(variantId: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Cần quyền lập bảng đặt hàng sản xuất" };
  const id = z.string().trim().min(1).max(120).safeParse(variantId);
  if (!id.success) return { error: "Thiếu mẫu mã" };
  const book = await getSettingJson<ShortageDecisionBook>(SHORTAGE_DECISIONS_KEY, {});
  const previous = book[id.data];
  if (!previous) {
    // Không đổi gì vẫn làm mới: trang có thể đang cũ (người khác vừa làm) — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
    revalidatePath("/inventory/shortage");
    return { ok: true };
  }
  const next = { ...book };
  delete next[id.data];
  await setSettingJson(SHORTAGE_DECISIONS_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "STOCK_SHORTAGE_DECISION_CLEAR", entity: "VARIANT", entityId: id.data, detail: { previous } });
  revalidatePath("/inventory/shortage");
  return { ok: true };
}

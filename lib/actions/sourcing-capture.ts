"use server";

/**
 * Token tiện ích «Lưu mẫu từ 1688» (SRC-6) — server action MỎNG: phiên + quyền → lõi `lib/sourcing/capture-tokens.ts` → revalidatePath.
 *  · Tạo: `sourcing:write` (token chỉ gửi được đúng việc người đó đã làm được bằng tay — lưu mẫu), token gắn tổ chức của PHIÊN.
 *  · Thu hồi: chủ token, hoặc `sourcing:approve` thu hồi token của người khác (vd máy bị mất, nhân viên nghỉ).
 */
import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import { createCaptureToken, revokeCaptureToken, type CaptureTokenResult } from "@/lib/sourcing/capture-tokens";
import { currentOrganization } from "@/lib/platform/context";

export type { CaptureTokenResult };

const PATH = "/sourcing/extension";

export async function createCaptureTokenAction(input: { label: string }): Promise<CaptureTokenResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return { ok: false, errors: [{ message: "Bạn chưa có quyền «Tìm hàng: lưu & sửa mẫu»." }] };
  const org = await currentOrganization();
  const r = await createCaptureToken({ id: user.id, email: user.email }, org.code, input);
  if (r.ok) revalidatePath(PATH);
  return r;
}

export async function revokeCaptureTokenAction(input: { tokenId: string }): Promise<CaptureTokenResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:view")) return { ok: false, errors: [{ message: "Bạn chưa có quyền xem Tìm hàng nguồn." }] };
  const r = await revokeCaptureToken({ id: user.id, email: user.email }, input, can(user, "sourcing:approve"));
  if (r.ok) revalidatePath(PATH);
  return r;
}

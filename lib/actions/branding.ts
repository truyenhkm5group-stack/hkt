"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { removeLogoCore, saveBrandingCore, uploadLogoCore } from "@/lib/branding/service";

/**
 * SERVER ACTION CỦA `/settings/branding` (Phase 10 · §4): đọc phiên (`settings:manage`) → lõi `lib/branding/service.ts`
 * (kiểm quyền LẦN HAI, chặn tổ chức nhà, kiểm tệp theo chữ ký byte, hạn mức dung lượng) → làm mới bố cục (thanh đầu
 * mang tên + logo, màu nhấn nằm ở layout).
 */

type Out = { ok: true } | { error: string };

export async function saveBrandingAction(input: { displayName: string; accent: string | null }): Promise<Out> {
  const user = await requirePermission("settings:manage");
  const r = await saveBrandingCore(user, input);
  if ("error" in r) return r;
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function uploadLogoAction(formData: FormData): Promise<Out> {
  const user = await requirePermission("settings:manage");
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Chưa chọn tệp." };
  const r = await uploadLogoCore(user, { data: new Uint8Array(await file.arrayBuffer()), filename: file.name });
  if ("error" in r) return r;
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function removeLogoAction(): Promise<Out> {
  const user = await requirePermission("settings:manage");
  const r = await removeLogoCore(user);
  if ("error" in r) return r;
  revalidatePath("/", "layout");
  return { ok: true };
}

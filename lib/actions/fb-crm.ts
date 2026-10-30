"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { fbCrmApplyCore, fbCrmCreateTaskCore, type FbCrmOpInput, type FbCrmResult, type FbCrmTaskInput } from "@/lib/fb-crm/service";
import { fbCrmEnabled } from "@/lib/queries/fb-crm";

/**
 * Vỏ Next của Facebook Friend CRM. Lõi (`lib/fb-crm/service.ts`) tự kiểm quyền `customers:write` + zod + luật thuần. Cờ tổ chức
 * `fbCrm.enabled` tắt ⇒ không ghi gì (trang cũng không hiện) — một nút còn sót trên trình duyệt không mở lại được tính năng.
 */

const OFF: FbCrmResult = { ok: false, error: "Facebook Friend CRM chưa bật cho tổ chức này." };

function refresh(customerId: string) {
  revalidatePath("/customers/facebook-crm");
  revalidatePath(`/customers/${customerId}`);
}

export async function fbCrmUpdateAction(customerId: string, input: FbCrmOpInput): Promise<FbCrmResult> {
  const user = await requireUser();
  if (!(await fbCrmEnabled())) return OFF;
  const r = await fbCrmApplyCore(user, customerId, input);
  if (r.ok && r.changed) refresh(customerId);
  return r;
}

export async function fbCrmCreateTaskAction(customerId: string, input: FbCrmTaskInput): Promise<FbCrmResult> {
  const user = await requireUser();
  if (!(await fbCrmEnabled())) return OFF;
  const r = await fbCrmCreateTaskCore(user, customerId, input);
  if (r.ok && r.changed) {
    refresh(customerId);
    revalidatePath("/work");
  }
  return r;
}

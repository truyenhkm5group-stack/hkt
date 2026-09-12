"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import * as svc from "@/lib/care/service";
import { CARE_NOTE_PRESETS_KEY, CARE_NOTE_PRESETS_MAX, type CareNotePreset } from "@/lib/constants/care";
import { CARE_ACTION_KINDS } from "@/lib/constants/delivery-tower";
import { setSettingJson } from "@/lib/settings";

/**
 * Lớp mỏng: kiểm quyền rồi giao cho `lib/care/service.ts`. Đổi trạng thái / note / giao việc cần
 * `shipments:view`; gửi yêu cầu tới Viettel Post cần `shipments:manage`.
 */
async function actor(permission: "shipments:view" | "shipments:manage"): Promise<svc.CareActor | null> {
  const user = await requireUser();
  if (!can(user, permission)) return null;
  return { id: user.id, email: user.email ?? "", name: user.name };
}
const DENIED = { error: "Không có quyền" } as const;

export async function setCareStatus(input: z.input<typeof svc.statusSchema>) {
  const a = await actor("shipments:view");
  return a ? svc.setCareStatus(a, input) : DENIED;
}
export async function reopenCase(input: z.input<typeof svc.reopenSchema>) {
  const a = await actor("shipments:view");
  return a ? svc.reopenCase(a, input) : DENIED;
}
export async function setCareOwner(input: z.input<typeof svc.ownerSchema>) {
  const a = await actor("shipments:view");
  return a ? svc.setCareOwner(a, input) : DENIED;
}
export async function setCareFollowUp(input: z.input<typeof svc.followUpSchema>) {
  const a = await actor("shipments:view");
  return a ? svc.setCareFollowUp(a, input) : DENIED;
}
export async function addCareNote(input: z.input<typeof svc.noteSchema>) {
  const a = await actor("shipments:view");
  return a ? svc.addCareNote(a, input) : DENIED;
}
export async function requestCarrierAction(input: z.input<typeof svc.requestSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.requestCarrierAction(a, input) : { error: "Không có quyền thao tác vận đơn" as const };
}
export async function markCarrierManualDone(input: z.input<typeof svc.manualSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.markCarrierManualDone(a, input) : { error: "Không có quyền thao tác vận đơn" as const };
}

const presetsSchema = z.object({
  presets: z.array(z.object({ id: z.string().min(1).max(40), kind: z.enum(CARE_ACTION_KINDS), text: z.string().trim().min(1, "Mẫu không được trống").max(200, "Mẫu tối đa 200 ký tự") })).max(CARE_NOTE_PRESETS_MAX, `Tối đa ${CARE_NOTE_PRESETS_MAX} mẫu`),
});

/**
 * Bộ mẫu note dùng CHUNG cả shop: ai có `shipments:view` thì DÙNG được; thêm / sửa / xoá cần
 * `shipments:manage` (trưởng CS / quản trị) — đổi mẫu chung là đổi cách cả đội ghi nhận, không phải
 * việc của từng người trực. Có nhật ký ai đổi.
 */
export async function saveCareNotePresets(input: z.input<typeof presetsSchema>): Promise<{ ok: true; data: CareNotePreset[] } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Chỉ người có quyền thao tác vận đơn (shipments:manage) mới sửa được mẫu chung" };
  const parsed = presetsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  // Không cho hai mẫu trùng chữ — bấm nhầm không phân biệt được.
  const seen = new Set<string>();
  const presets = parsed.data.presets.filter((p) => {
    const k = p.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await setSettingJson(CARE_NOTE_PRESETS_KEY, { presets });
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: CARE_NOTE_PRESETS_KEY, after: { count: presets.length }, reason: "Mẫu note care" });
  revalidatePath("/shipments");
  return { ok: true, data: presets };
}

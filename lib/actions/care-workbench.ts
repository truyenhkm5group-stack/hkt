"use server";

import type { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import * as svc from "@/lib/care/service";

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

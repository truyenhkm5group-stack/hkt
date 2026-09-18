"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import * as svc from "@/lib/care/service";
import { CARE_NOTE_PRESETS_KEY, CARE_NOTE_PRESETS_MAX, type CareNotePreset } from "@/lib/constants/care";
import { CARE_ACTION_KINDS } from "@/lib/constants/delivery-tower";
import { RESOLUTION_ACTIONS, RESOLUTION_NOTES_KEY, RESOLUTION_NOTES_MAX, type ResolutionAction } from "@/lib/constants/care-resolution";
import { getResolutionNotePresets } from "@/lib/queries/care-workbench";
import { setSettingJson } from "@/lib/settings";

/**
 * Lớp mỏng: kiểm quyền rồi giao cho `lib/care/service.ts`.
 *
 * Ghi chú cần `shipments:view` (ai nhìn thấy kiện cũng được ghi lại việc mình vừa làm). Mọi thao tác
 * ĐỔI DỮ LIỆU CA — đổi trạng thái, giao người, hẹn, mở lại, gửi ĐVVC, quyết định nghiệp vụ — cần
 * `shipments:manage`: CS và LEADER đã có quyền đó (lib/auth/permissions.ts), còn VIEWER / MARKETING
 * chỉ xem thì không được đóng ca của người khác.
 */
async function actor(permission: "shipments:view" | "shipments:manage"): Promise<svc.CareActor | null> {
  const user = await requireUser();
  if (!can(user, permission)) return null;
  return { id: user.id, email: user.email ?? "", name: user.name };
}
const DENIED = { error: "Không có quyền" } as const;

export async function setCareStatus(input: z.input<typeof svc.statusSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.setCareStatus(a, input) : DENIED;
}
export async function reopenCase(input: z.input<typeof svc.reopenSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.reopenCase(a, input) : DENIED;
}
export async function setCareOwner(input: z.input<typeof svc.ownerSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.setCareOwner(a, input) : DENIED;
}
export async function setCareFollowUp(input: z.input<typeof svc.followUpSchema>) {
  const a = await actor("shipments:manage");
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
/**
 * Gửi lệnh ĐVVC cho nhiều kiện một lượt. Kết quả TỪNG KIỆN, không phải một câu chung — xem
 * `bulkRequestCarrierAction`. Kiện không đủ điều kiện KHÔNG sinh yêu cầu nào lên ĐVVC.
 */
export async function bulkRequestCarrierAction(input: z.input<typeof svc.bulkRequestSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.bulkRequestCarrierAction(a, input) : { error: "Không có quyền thao tác vận đơn" as const };
}
/**
 * Bốn QUYẾT ĐỊNH nghiệp vụ: Duyệt hoàn · Phát tiếp · Đổi · Theo dõi tiếp.
 *
 * Tách khỏi `setCareStatus` có chủ đích: trạng thái xử lý nói ĐỘI ĐANG Ở ĐÂU, quyết định nghiệp vụ
 * nói ĐỘI ĐÃ CHỌN LÀM GÌ. Trộn chung một menu thì "Duyệt hoàn" nằm cạnh "Đang xử lý" như thể cùng
 * loại, và không ai đọc được lịch sử ra thành một câu chuyện.
 */
export async function recordBusinessAction(input: z.input<typeof svc.businessActionSchema>) {
  const a = await actor("shipments:manage");
  return a ? svc.recordBusinessAction(a, input) : { error: "Không có quyền thao tác vận đơn" as const };
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

/**
 * MỘT KẾT QUẢ MỖI LƯỢT GHI, cố ý.
 *
 * Người dùng sửa mẫu của ĐÚNG cái nút họ đang mở, nên gửi cả ba rổ là gửi kèm hai rổ họ không chạm
 * tới — và nếu hai người cùng sửa hai rổ khác nhau thì người bấm sau ghi đè mất phần của người kia
 * bằng chính bản sao cũ mà màn hình họ đang cầm.
 */
const resolutionNotesSchema = z.object({
  action: z.enum(RESOLUTION_ACTIONS),
  presets: z.array(z.string().trim().min(1, "Mẫu không được trống").max(200, "Mẫu tối đa 200 ký tự")).max(RESOLUTION_NOTES_MAX, `Tối đa ${RESOLUTION_NOTES_MAX} mẫu mỗi kết quả`),
});

/**
 * Mẫu note gắn với từng KẾT QUẢ XỬ LÝ — cùng luật quyền với mẫu note chung: ai cũng DÙNG được,
 * chỉ `shipments:manage` mới SỬA. Mẫu là ngôn ngữ của shop, và đổi nó là đổi cách cả đội ghi nhận.
 */
export async function saveResolutionNotePresets(input: z.input<typeof resolutionNotesSchema>): Promise<{ ok: true; data: Record<ResolutionAction, string[]> } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Chỉ người có quyền thao tác vận đơn (shipments:manage) mới sửa được mẫu chung" };
  const parsed = resolutionNotesSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  // Bản lưu là bản ĐẦY ĐỦ: hai rổ người dùng không chạm tới giữ nguyên bộ ĐANG CHẠY đọc từ máy chủ,
  // không phải bản sao cũ trên màn hình họ.
  const dangChay = await getResolutionNotePresets();
  const next: Record<ResolutionAction, string[]> = { ...dangChay, [parsed.data.action]: [...new Set(parsed.data.presets.map((x) => x.trim()).filter(Boolean))] };
  await setSettingJson(RESOLUTION_NOTES_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: RESOLUTION_NOTES_KEY, after: Object.fromEntries(RESOLUTION_ACTIONS.map((k) => [k, next[k].length])), reason: "Mẫu note theo kết quả xử lý" });
  revalidatePath("/shipments");
  return { ok: true, data: next };
}

import { memo } from "@/lib/cache";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { REASON_GROUP_KEY, sanitizeReasonGroups, type ReasonGroupOverrides } from "@/lib/constants/return-reason-mapping";

/**
 * Cách xếp nhóm lý do hoàn, do chủ shop đặt. Mặc định nằm trong mã (`RETURN_REASON_GROUP_OF`);
 * đây chỉ là phần ĐÃ SỬA.
 *
 * 60 giây, cùng lý lẽ với `getWorkConfig`: bảng này đổi vài lần một quý nhưng nằm trên đường dựng
 * MỌI báo cáo hoàn. Server Action lưu xong gọi `revalidatePath` nên người vừa sửa vẫn thấy ngay.
 */
export async function getReasonGroupOverrides(): Promise<ReasonGroupOverrides> {
  return memo("returns-reason-groups", 60_000, async () => sanitizeReasonGroups(await getSettingJson<Record<string, unknown>>(REASON_GROUP_KEY, {})));
}

export async function saveReasonGroupOverrides(next: ReasonGroupOverrides): Promise<void> {
  await setSettingJson(REASON_GROUP_KEY, sanitizeReasonGroups(next));
}

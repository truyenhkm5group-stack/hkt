import { memo } from "@/lib/cache";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { REASON_GROUP_KEY, reasonGroupTable, sanitizeReasonGroups, type ReasonGroupOverrides } from "@/lib/constants/return-reason-mapping";
import { buildReasonGrouping, parseReasonTaxonomy, REASON_TAXONOMY_KEY, type ReasonGrouping, type ReasonTaxonomy } from "@/lib/constants/return-reason-evidence";

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

/**
 * CÁCH ĐỌC NHÓM ĐANG BẬT (`returns.reason-taxonomy`). Mặc định `LEGACY` = đúng số cũ; chủ shop
 * duyệt bảng chạy thử (`ops reason-taxonomy-dryrun`) rồi mới bật bằng
 * `set-setting returns.reason-taxonomy '{"taxonomy":"EVIDENCE"}'`.
 *
 * GIÁ TRỊ LÀ OBJECT, KHÔNG PHẢI CHUỖI — cố ý: `scripts/set-setting.ts` GỘP object (`{...cũ, ...mới}`),
 * nên một cờ kiểu chuỗi đi qua ops sẽ thành `{0:"E",1:"V",…}` và đọc ra `LEGACY` trong im lặng —
 * chủ shop tưởng đã bật mà màn hình vẫn số cũ.
 * Đảo ngược được: đặt lại `LEGACY` là về số cũ, không dòng lịch sử nào bị ghi lại.
 */
export async function getReasonTaxonomy(): Promise<ReasonTaxonomy> {
  return memo("returns-reason-taxonomy", 60_000, async () => parseReasonTaxonomy((await getSettingJson<{ taxonomy?: unknown }>(REASON_TAXONOMY_KEY, {})).taxonomy));
}

/**
 * Cách xếp nhóm cho MỘT lượt đọc — bảng tổng hợp, drilldown và màn hình chi tiết vận đơn đều lấy
 * từ đây. `taxonomy` truyền vào được để lượt chạy thử dựng CẢ HAI cách trên cùng một tập ca.
 */
export async function getReasonGrouping(taxonomy?: ReasonTaxonomy): Promise<ReasonGrouping> {
  const [t, ghiDe] = await Promise.all([taxonomy ? Promise.resolve(taxonomy) : getReasonTaxonomy(), getReasonGroupOverrides()]);
  return buildReasonGrouping(t, reasonGroupTable(ghiDe), ghiDe);
}

import { memo } from "@/lib/cache";
import { FRESHNESS_KEY, sanitizeFreshness, type FreshnessOverrides } from "@/lib/constants/logistics-freshness";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ NGƯỠNG IM LẶNG CHỦ SHOP SỬA ĐƯỢC ═══════════
 *
 * Cùng lối với `getWorkConfig()`: bảng ghi đè THƯA ở `settings`, mặc định vẫn nằm trong mã. Lý lẽ
 * đầy đủ ở `lib/constants/logistics-freshness.ts`.
 *
 * 60 giây, cùng lý lẽ với `work-config`: bảng này đổi vài lần một quý nhưng nằm trên đường dựng
 * hàng đợi đối chiếu, dải độ tươi và luật cảnh báo im lặng. Server Action lưu cấu hình gọi
 * `revalidatePath` nên người vừa sửa vẫn thấy ngay.
 */
const FRESHNESS_TTL_MS = 60_000;

export async function getFreshnessConfig(): Promise<FreshnessOverrides> {
  return memo("logistics-freshness", FRESHNESS_TTL_MS, async () => sanitizeFreshness(await getSettingJson<Record<string, unknown>>(FRESHNESS_KEY, {})));
}

export async function saveFreshnessOverrides(next: FreshnessOverrides): Promise<void> {
  await setSettingJson(FRESHNESS_KEY, sanitizeFreshness(next));
}

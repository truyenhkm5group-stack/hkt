import { memo } from "@/lib/cache";
import { isDepartmentCode, WORK_OWNERSHIP_KEY, type OwnershipOverrides } from "@/lib/constants/work-ownership";
import { SLA_HOURS_MAX, SLA_HOURS_MIN, WORK_SLA_KEY, type SlaOverrides } from "@/lib/constants/work-sla";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ CẤU HÌNH VẬN HÀNH: THỨ CHỦ SHOP ĐỔI ĐƯỢC MÀ KHÔNG CẦN DEPLOY ═══════════
 *
 * Hai bảng, lưu ở `settings`, đọc một lần cho mỗi lượt dựng hàng đợi:
 *
 *  · `work.sla`       — hạn xử lý theo `<nguồn>` / `<nguồn>:<loại>`  (`lib/constants/work-sla.ts`)
 *  · `work.ownership` — phòng ban chịu trách nhiệm                   (`lib/constants/work-ownership.ts`)
 *
 * ─── GHI ĐÈ LÀ THƯA, KHÔNG PHẢI BẢN SAO ĐẦY ĐỦ ───
 *
 * Chỉ khoá nào chủ shop ĐÃ SỬA mới nằm trong `settings`. Lưu cả bảng thì mặc định trong mã thành
 * vô nghĩa: sửa `CASE_SLA_HOURS` sẽ không bao giờ tới được production nữa vì bản chụp cũ đè lên.
 * Bảng thưa giữ đúng tính chất "mặc định là mã, ghi đè là quyết định của người".
 *
 * ─── ĐỌC PHẢI LUÔN THÀNH CÔNG ───
 *
 * Dòng rác trong `settings` (sửa tay, nhập sai kiểu) KHÔNG được làm sập hàng đợi của cả shop.
 * `sanitize*` bỏ khoá hỏng và giữ phần còn lại; mất một ghi đè còn hơn mất cả màn hình công việc.
 */

export type WorkConfig = { sla: SlaOverrides; ownership: OwnershipOverrides };

export const EMPTY_WORK_CONFIG: WorkConfig = { sla: {}, ownership: {} };

/** Giá trị hợp lệ: số giờ trong dải, hoặc `null` = CỐ Ý không đặt hạn. Mọi thứ khác bị bỏ. */
export function sanitizeSla(raw: unknown): SlaOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SlaOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    if (v === null) {
      out[k] = null;
      continue;
    }
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    const h = Math.round(n);
    if (h < SLA_HOURS_MIN || h > SLA_HOURS_MAX) continue;
    out[k] = h;
  }
  return out;
}

export function sanitizeOwnership(raw: unknown): OwnershipOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: OwnershipOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k && typeof v === "string" && isDepartmentCode(v)) out[k] = v;
  }
  return out;
}

/**
 * 60 giây: cấu hình đổi vài lần một quý, nhưng nó nằm trên đường dựng MỌI hàng đợi. Đọc lại từ
 * CSDL mỗi lần là thêm một lượt truy vấn vào màn hình mở đầu ca mà chẳng đổi được gì. Server
 * Action lưu cấu hình gọi `revalidatePath` nên người vừa sửa vẫn thấy ngay.
 */
const TTL_MS = 60_000;

export async function getWorkConfig(): Promise<WorkConfig> {
  return memo("work-config", TTL_MS, async () => {
    const [sla, ownership] = await Promise.all([
      getSettingJson<Record<string, unknown>>(WORK_SLA_KEY, {}),
      getSettingJson<Record<string, unknown>>(WORK_OWNERSHIP_KEY, {}),
    ]);
    return { sla: sanitizeSla(sla), ownership: sanitizeOwnership(ownership) };
  });
}

export async function saveSlaOverrides(next: SlaOverrides): Promise<void> {
  await setSettingJson(WORK_SLA_KEY, sanitizeSla(next));
}

export async function saveOwnershipOverrides(next: OwnershipOverrides): Promise<void> {
  await setSettingJson(WORK_OWNERSHIP_KEY, sanitizeOwnership(next));
}

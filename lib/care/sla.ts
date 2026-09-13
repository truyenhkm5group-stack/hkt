import { DEFAULT_CARE_SLA_HOURS, type CareSlaHours } from "@/lib/care/view";
import { slaHoursFor } from "@/lib/constants/work-sla";
import { getWorkConfig } from "@/lib/queries/work-config";

/**
 * NGƯỠNG SLA CARE ĐANG HIỆU LỰC — đọc qua sổ hạn xử lý (luật 22), không gõ số ở nơi khác.
 *
 * Khoá `SHIPMENT_CARE` (đóng ca) và `SHIPMENT_CARE:FIRST_RESPONSE` (phản hồi đầu) nằm ở
 * `lib/constants/work-sla.ts`; mặc định của chúng LẤY LẠI từ `CARE_SLA`, và chủ shop ghi đè ở
 * `settings.work.sla`. Chủ shop cố ý bỏ hạn (`null`) thì rơi về mặc định của care — bàn care luôn
 * cần một cái hạn để xếp thứ tự việc.
 */
export async function careSlaHours(): Promise<CareSlaHours> {
  const cfg = await getWorkConfig();
  return {
    firstResponseHours: slaHoursFor("SHIPMENT_CARE", "FIRST_RESPONSE", cfg.sla) ?? DEFAULT_CARE_SLA_HOURS.firstResponseHours,
    resolveHours: slaHoursFor("SHIPMENT_CARE", null, cfg.sla) ?? DEFAULT_CARE_SLA_HOURS.resolveHours,
  };
}

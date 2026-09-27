import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { marketerCampaignCode, type MarketerOption } from "@/lib/constants/campaign-setup";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { resolveMarketer } from "@/lib/integrations/facebook/mapping";

/**
 * ═══════════ MKTER CỦA MỘT CAMP "ĐĂNG CAMP" ═══════════
 *
 * Chủ shop 27/09/2026: chọn MKTer trong setup camp ⇒ mã MKTer vào tên chiến dịch ("chọn MKTer Tuyết Trinh thì ghi thêm
 * TRINH để tracking tiền ads"). Nguồn DUY NHẤT là danh sách nhân sự ở trang Lương (`PAYROLL_EMPLOYEES_KEY`) — chính danh
 * sách mà luật quy tiền ads (`resolveMarketer`) đọc bí danh — nên mã vào tên là thứ luật ấy nhận ra, không phải một bảng
 * mã thứ hai. Tên / mã do MÁY CHỦ đọc từ `marketerId` (AGENTS.md mục 34), không nhận chữ từ trình duyệt.
 */

/** Danh sách nhân sự của trang Lương, đọc bằng `db` được truyền vào. Không có / hỏng ⇒ `[]`. */
export async function readPayrollEmployees(db: Db): Promise<Employee[]> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_EMPLOYEES_KEY)).limit(1);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as { list?: unknown };
    return Array.isArray(parsed.list) ? (parsed.list as Employee[]).filter((e) => e && typeof e.id === "string") : [];
  } catch {
    return [];
  }
}

/** MKTer chọn được: nhân sự CÒN LÀM có ít nhất một bí danh dùng được làm mã. Người chưa khai bí danh không hiện (không đoán mã). */
export function marketerOptions(employees: readonly Employee[]): MarketerOption[] {
  return employees
    .filter((e) => e.active !== false)
    .map((e) => ({ id: e.id, name: (e.shortName || e.name || e.id).trim(), code: marketerCampaignCode(e.aliases) }))
    .filter((m): m is MarketerOption => m.code !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

/**
 * Tên chiến dịch có quy về ĐÚNG MKTer đã chọn không — hỏi CHÍNH luật quy tiền ads (`resolveMarketer`, không ghép tay theo
 * chiến dịch, không theo tài khoản). `null` = đúng; chuỗi = câu lỗi cho người (tên thiếu mã, hoặc bí danh của người khác
 * dài hơn chen vào và thắng). Hàm THUẦN.
 */
export function marketerNameProblem(campaignName: string, marketer: MarketerOption, employees: Employee[]): string | null {
  const got = resolveMarketer("", campaignName, null, { campaignMap: {}, aliases: {}, employees });
  if (got === marketer.id) return null;
  const other = got ? employees.find((e) => e.id === got) : null;
  return other
    ? `Tên chiến dịch "${campaignName}" bị nhận là của MKTer ${other.shortName || other.name} (bí danh của người ấy có trong tên) — tiền ads sẽ không quy về ${marketer.name}. Sửa tên cho có mã ${marketer.code} và bỏ bí danh kia.`
    : `Tên chiến dịch "${campaignName}" không mang mã MKTer ${marketer.code} — tiền ads sẽ không quy về ${marketer.name}. Để trống ô tên (máy tự ghép) hoặc gõ thêm ${marketer.code}.`;
}

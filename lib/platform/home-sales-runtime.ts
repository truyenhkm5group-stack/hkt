import { canUseModule, getModuleRows } from "@/lib/platform/capabilities";
import type { ModuleRow, Organization } from "@/lib/platform/types";

/**
 * ═══════════ TỔ CHỨC NHÀ CÓ ĐANG CHẠY RUNTIME CHỐT ĐƠN KHÔNG (Phase 8b · docs/saas/OWNERSHIP.md §4) ═══════════
 *
 * Bot bán hàng của VNX hôm nay là container `chatbot/` (runtime cũ). Chuyển sang runtime Chốt Đơn (`lib/sales-chatbot`) là
 * quyết định của chủ shop, làm TỪNG PAGE, chạy bóng trước. Công tắc DUY NHẤT của việc đó là module `ai_sales` của nhà — đang
 * TẮT (0180), nên mọi nhánh dưới đây trả `false` và hành vi production y như trước.
 *
 * Câu hỏi này CHỈ dành cho những chỗ trước đây loại nhà vô điều kiện (webhook fanpage / Zalo theo token). Job nền KHÔNG
 * hỏi ở đây: `runJob` đã tự bỏ qua `MODULE_DISABLED` theo đúng module của job.
 *
 * Luật hẹp hơn `canUseModule` một bậc: phải có DÒNG cấu hình bật `ai_sales` một cách TƯỜNG MINH. Nhà khai
 * `module_default = ENABLED`, nên khi bảng module chưa đọc được (máy chưa migrate) mọi module của nhà "bật" — kể cả
 * `ai_sales`. Mở cửa webhook cho nhà vì một bảng thiếu là hỏng về phía RỘNG; ở đây mọi nhánh lỗi rơi về `false`.
 */

export const HOME_SALES_RUNTIME_MODULE = "ai_sales" as const;

/** HÀM THUẦN: dòng cấu hình module có bật `ai_sales` tường minh không. Hai dòng mâu thuẫn ⇒ một dòng tắt là đủ để tắt. */
export function homeSalesRuntimeDeclared(rows: readonly ModuleRow[]): boolean {
  const own = rows.filter((r) => r.moduleKey === HOME_SALES_RUNTIME_MODULE);
  return own.length > 0 && own.every((r) => r.enabled === true);
}

/** Tổ chức `org` là NHÀ, đang hoạt động, và đã bật tường minh module `ai_sales` (đủ phụ thuộc). Lỗi đọc ⇒ `false`. */
export async function homeSalesRuntimeEnabled(org: Pick<Organization, "code" | "isHome" | "status">): Promise<boolean> {
  if (!org.isHome || org.status !== "ACTIVE") return false;
  try {
    const { rows } = await getModuleRows(org.code);
    if (!homeSalesRuntimeDeclared(rows)) return false;
    return await canUseModule(HOME_SALES_RUNTIME_MODULE, org.code);
  } catch {
    return false;
  }
}

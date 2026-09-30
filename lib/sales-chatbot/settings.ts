/**
 * ═══════════ LƯU CẤU HÌNH CHATBOT BÁN HÀNG (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Quyền `ai_sales:manage` (module «AI bán hàng»). zod là CÙNG lược đồ với form. BẬT bot (trang chat công khai nhận khách
 * lạ) chỉ được khi khoá AI đã chọn là kết nối ĐANG BẬT của chính tổ chức — không bật một bot chắc chắn sẽ trả lỗi cho
 * khách. Mọi lượt lưu có nhật ký trước / sau (không có bí mật nào trong cấu hình: khoá AI nằm ở `org_connections`).
 */
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { canUseModule } from "@/lib/platform/capabilities";
import { salesChatbotConfigZ, SALES_CHATBOT_SETTING_KEY, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { setSettingJson } from "@/lib/settings";

export const SALES_CHATBOT_MANAGE = "ai_sales:manage" as const;

export async function saveSalesChatbotConfig(user: SessionUser, raw: unknown): Promise<{ ok: true; config: SalesChatbotConfig; message: string } | { ok: false; error: string }> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật — bật ở Cài đặt → Module." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { ok: false, error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const parsed = salesChatbotConfigZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "cấu hình"}: ${i.message}`).join(" · ") };
  const cfg = parsed.data;
  if (cfg.allowedTools.length === 0) return { ok: false, error: "Bot cần ít nhất một công cụ — tối thiểu «Tìm sản phẩm»." };
  if (cfg.enabled) {
    const conn = await openActiveConnection(cfg.connectorKey);
    if (!conn.ok) return { ok: false, error: `Chưa bật được bot: ${conn.reason}` };
  }
  const before = await loadSalesChatbotConfig();
  await setSettingJson(SALES_CHATBOT_SETTING_KEY, cfg);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHATBOT_CONFIG", entity: "SETTINGS", entityId: SALES_CHATBOT_SETTING_KEY, before, after: cfg, reason: before.enabled !== cfg.enabled ? (cfg.enabled ? "Bật chatbot bán hàng" : "Tắt chatbot bán hàng") : "Sửa cấu hình chatbot bán hàng" });
  return { ok: true, config: cfg, message: cfg.enabled ? "Đã lưu — bot ĐANG BẬT (trang chat công khai nhận khách khi ERP đã xuất bản)." : "Đã lưu — bot đang TẮT: chỉ khung thử dùng được." };
}

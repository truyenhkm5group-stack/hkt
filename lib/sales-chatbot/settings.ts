/**
 * ═══════════ LƯU CẤU HÌNH CHATBOT BÁN HÀNG (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Quyền `ai_sales:manage` (module «AI bán hàng»). zod là CÙNG lược đồ với form. BẬT bot (trang chat công khai nhận khách
 * lạ) chỉ được khi khoá AI đã chọn là kết nối ĐANG BẬT của chính tổ chức — không bật một bot chắc chắn sẽ trả lỗi cho
 * khách. Mọi lượt lưu có nhật ký trước / sau (không có bí mật nào trong cấu hình: khoá AI nằm ở `org_connections`).
 *
 * Workspace KHÁCH (chủ shop 07/10/2026): động cơ AI (nguồn AI, model, dự phòng, mạch ngắt, mức suy nghĩ) là của người vận
 * hành — lượt lưu của khách GIỮ NGUYÊN giá trị đang lưu (lib/saas/visibility.ts); người vận hành sửa qua
 * `saveChatbotEngineAsOperator` (khối «AI của workspace» ở `/platform/org/<mã>`).
 */
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { connectionIsActive, openActiveConnection } from "@/lib/connectors/service";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { currentOrganization } from "@/lib/platform/context";
import { canUseModule } from "@/lib/platform/capabilities";
import { salesChatbotConfigZ, SALES_CHATBOT_SETTING_KEY, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { setSettingJson } from "@/lib/settings";
import { CHATBOT_ENGINE_FIELDS, chatbotEngineConfig, CUSTOMER_AI_STATE_HINT, customerFacing, keepStoredEngineFields, type ChatbotEngineConfig } from "@/lib/saas/visibility";

export const SALES_CHATBOT_MANAGE = "ai_sales:manage" as const;

const zodError = (issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${i.path.map(String).join(".") || "cấu hình"}: ${i.message}`).join(" · ");

export async function saveSalesChatbotConfig(user: SessionUser, raw: unknown): Promise<{ ok: true; config: SalesChatbotConfig; message: string } | { ok: false; error: string }> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật — bật ở Cài đặt → Module." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { ok: false, error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const ctx = await currentOrganization();
  const before = await loadSalesChatbotConfig();
  // Khách: các ô động cơ AI lấy ĐÚNG giá trị đang lưu — khách gửi gì (kể cả không gửi) cũng bỏ, không bao giờ về mặc định.
  const customer = customerFacing(ctx);
  const parsed = salesChatbotConfigZ.safeParse(customer ? keepStoredEngineFields(before, raw) : raw);
  if (!parsed.success) return { ok: false, error: zodError(parsed.error.issues) };
  const cfg = parsed.data;
  if (cfg.allowedTools.length === 0) return { ok: false, error: "Bot cần ít nhất một công cụ — tối thiểu «Tìm sản phẩm»." };
  if (cfg.enabled) {
    if (cfg.connectorKey === "platform") {
      const plat = await platformChatAi(ctx.code);
      if (!plat.ok) return { ok: false, error: `Chưa bật được bot: ${customer ? CUSTOMER_AI_STATE_HINT.NEEDS_SETUP : plat.reason}` };
    } else {
      const conn = await openActiveConnection(cfg.connectorKey);
      if (!conn.ok) return { ok: false, error: `Chưa bật được bot: ${customer ? CUSTOMER_AI_STATE_HINT.NEEDS_SETUP : conn.reason}` };
    }
  }
  await setSettingJson(SALES_CHATBOT_SETTING_KEY, cfg);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHATBOT_CONFIG", entity: "SETTINGS", entityId: SALES_CHATBOT_SETTING_KEY, before, after: cfg, reason: before.enabled !== cfg.enabled ? (cfg.enabled ? "Bật chatbot bán hàng" : "Tắt chatbot bán hàng") : "Sửa cấu hình chatbot bán hàng" });
  return { ok: true, config: cfg, message: cfg.enabled ? "Đã lưu — bot ĐANG BẬT (trang chat công khai nhận khách khi ERP đã xuất bản)." : "Đã lưu — bot đang TẮT: chỉ khung thử dùng được." };
}

/**
 * NGƯỜI VẬN HÀNH NỀN TẢNG đổi ĐỘNG CƠ AI của bot trong tổ chức NGỮ CẢNH (nơi gọi đã kiểm người vận hành + bọc
 * `withOrganization`). Chỉ ghi đè đúng các ô động cơ — mọi ô của chủ shop (giọng, ship, giờ làm việc…) giữ nguyên. Bot đang
 * BẬT mà nguồn AI mới chưa dùng được ⇒ TỪ CHỐI (cùng luật với lượt bật bot): không đổi sang một nguồn chắc chắn trả lỗi cho
 * khách đang chat. Người vận hành không có tài khoản trong CSDL tổ chức ⇒ nhật ký `userId = null`, email mang nhãn vận hành.
 */
export async function saveChatbotEngineAsOperator(input: { engine: unknown; operator: { orgCode: string; email: string }; reason: string }): Promise<{ ok: true; before: ChatbotEngineConfig; after: ChatbotEngineConfig; message: string } | { ok: false; error: string }> {
  const raw = input.engine && typeof input.engine === "object" && !Array.isArray(input.engine) ? (input.engine as Record<string, unknown>) : null;
  if (!raw) return { ok: false, error: "Thiếu cấu hình AI." };
  for (const k of Object.keys(raw)) if (!(CHATBOT_ENGINE_FIELDS as readonly string[]).includes(k)) return { ok: false, error: `«${k}» không phải ô cấu hình AI.` };
  const ctx = await currentOrganization();
  const before = await loadSalesChatbotConfig();
  const parsed = salesChatbotConfigZ.safeParse({ ...before, ...raw });
  if (!parsed.success) return { ok: false, error: zodError(parsed.error.issues) };
  const cfg = parsed.data;
  if (cfg.enabled && cfg.connectorKey !== before.connectorKey) {
    if (cfg.connectorKey === "platform") {
      const plat = await platformChatAi(ctx.code);
      if (!plat.ok) return { ok: false, error: `Bot đang bật — chưa chuyển được sang AI dùng chung: ${plat.reason}` };
    } else if (!(await connectionIsActive(cfg.connectorKey))) return { ok: false, error: `Bot đang bật — khoá «${cfg.connectorKey}» của workspace chưa bật (Lưu → Kiểm tra → Bật trước).` };
  }
  const who = `${input.operator.email} (vận hành nền tảng · ${input.operator.orgCode})`;
  await setSettingJson(SALES_CHATBOT_SETTING_KEY, cfg);
  await audit({ userId: null, userEmail: who, action: "SALES_CHATBOT_CONFIG", entity: "SETTINGS", entityId: SALES_CHATBOT_SETTING_KEY, before: chatbotEngineConfig(before), after: chatbotEngineConfig(cfg), reason: `Người vận hành đổi cấu hình AI: ${input.reason}` });
  return { ok: true, before: chatbotEngineConfig(before), after: chatbotEngineConfig(cfg), message: "Đã lưu cấu hình AI của workspace." };
}

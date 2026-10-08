/**
 * ═══════════ LOADER ĐÃ LỌC THEO NGƯỜI XEM — CHỈ MÁY CHỦ ═══════════
 *
 * Mỗi màn hình có số liệu AI nội bộ đọc qua đây thay vì tự gọi sổ AI / sức khoẻ khoá / bảng chi phí. Workspace KHÁCH nhận DTO
 * KHÔNG có khoá nội bộ (model, nguồn AI, token, chi phí, sức khoẻ khoá) — máy chủ không đọc chúng luôn, nên không có gì để
 * lọt vào props của RSC. Workspace nhà nhận đủ như trước. Luật ở `lib/saas/visibility.ts`.
 */
import type { SessionUser } from "@/lib/auth/session";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { connectionStatusRows } from "@/lib/connectors/service";
import { SALES_BOT_CONNECTORS, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadChatCostReport, type ChatCostReport } from "@/lib/sales-chatbot/cost-report";
import { loadProviderHealth } from "@/lib/sales-chatbot/provider-failover";
import { chatbotEngineConfig, customerAiState, customerChatbotConfig, customerFacing, customerQuotaExhausted, type ChatbotEngineConfig, type CustomerAiState, type CustomerChatbotConfig, type EngineConnectionView, type ProviderHealthView } from "@/lib/saas/visibility";

export type { EngineConnectionView, ProviderHealthView };


export type ChatbotAiView =
  | { audience: "INTERNAL"; config: SalesChatbotConfig; engine: { config: ChatbotEngineConfig; connections: EngineConnectionView[]; health: ProviderHealthView[] }; aiReady: boolean; aiReason: string | null; costReport: ChatCostReport | null }
  | { audience: "CUSTOMER"; config: CustomerChatbotConfig; aiState: CustomerAiState; aiReady: boolean };

/** Các nguồn AI của bot trong tổ chức NGỮ CẢNH (cùng cách trang chatbot vẫn tính) — đọc trạng thái, không giải mã bí mật. */
export async function engineConnections(orgCode: string): Promise<EngineConnectionView[]> {
  const [connections, platformAi] = await Promise.all([connectionStatusRows(), platformChatAi(orgCode)]);
  return SALES_BOT_CONNECTORS.map((k) => {
    if (k === "platform") return { key: k, ready: platformAi.ok, configured: platformAi.ok, reason: platformAi.ok ? null : platformAi.reason, vendor: platformAi.ok ? (platformAi.provider.name.split("-")[0] ?? null) : null };
    const row = connections.find((c) => c.connectorKey === k);
    return { key: k, ready: Boolean(row && row.status === "ACTIVE" && row.lastTestOk === true), configured: Boolean(row), reason: null, vendor: k.split("-")[0] ?? null };
  });
}

export async function providerHealthView(): Promise<ProviderHealthView[]> {
  return Object.entries(await loadProviderHealth()).map(([key, h]) => ({ key, lastSuccessAt: h.lastSuccessAt, lastFailureAt: h.lastFailureAt, lastErrorClass: h.lastErrorClass, openUntil: h.openUntil }));
}

/**
 * Phần AI của trang «Chatbot bán hàng». `manage` = người xem cấu hình được bot (chỉ họ thấy sức khoẻ khoá / chi phí ở nhà).
 * KHÁCH: cấu hình không có khoá động cơ AI, trạng thái là MỘT trong bốn câu, không chi phí, không sức khoẻ khoá.
 */
export async function loadChatbotAiView(user: Pick<SessionUser, "organization">, cfg: SalesChatbotConfig, opts: { manage: boolean }): Promise<ChatbotAiView> {
  const orgCode = user.organization?.code ?? "";
  const connections = orgCode ? await engineConnections(orgCode) : [];
  const selected = connections.find((a) => a.key === cfg.connectorKey);
  const aiReady = Boolean(selected?.ready);
  if (customerFacing(user.organization)) {
    // «Hết lượt» = trần lượt / credit của GÓI (khách tự xử được ở trang gói) — tách khỏi «Đang chuẩn bị» (việc của hỗ trợ).
    const quota = orgCode && !aiReady && cfg.connectorKey === "platform" ? await checkAiQuota(orgCode, "PLATFORM", { notify: false }).catch(() => null) : null;
    const quotaExhausted = Boolean(quota && !quota.ok && customerQuotaExhausted(quota.reason));
    return { audience: "CUSTOMER", config: customerChatbotConfig(cfg), aiState: customerAiState({ enabled: cfg.enabled, aiReady, quotaExhausted }), aiReady };
  }
  const [health, costReport] = opts.manage ? await Promise.all([providerHealthView(), orgCode ? loadChatCostReport(orgCode).catch(() => null) : Promise.resolve(null)]) : [[], null];
  return { audience: "INTERNAL", config: cfg, engine: { config: chatbotEngineConfig(cfg), connections, health }, aiReady, aiReason: selected?.reason ?? null, costReport };
}

/** Trang Hiệu quả AI: tiền AI / token chỉ cho người cấu hình bot Ở WORKSPACE NHÀ. Khách giữ chỉ số kinh doanh. */
export function aiPerformanceWithMoney(user: Pick<SessionUser, "organization">, manage: boolean): boolean {
  return manage && !customerFacing(user.organization);
}

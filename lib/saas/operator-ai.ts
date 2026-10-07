/**
 * ═══════════ «AI CỦA WORKSPACE» — NGƯỜI VẬN HÀNH NỀN TẢNG SỬA CẤU HÌNH AI CỦA MỘT WORKSPACE KHÁCH ═══════════
 *
 * Từ 07/10/2026 khách không còn ô nguồn AI / model / dự phòng / khoá AI (lib/saas/visibility.ts), nên người vận hành cần
 * MỘT chỗ sửa: khối «AI của workspace» trên `/platform/org/<mã>`. Mọi lượt:
 *  · kiểm `platformOperatorDenial` (người tổ chức nhà + `platform:operate`) và LÝ DO (≥ 5 ký tự) — `parseOperatorTarget`;
 *  · chạy trong ngữ cảnh tổ chức ĐÍCH (`withOrganization`) bằng ĐÚNG hàm cấu hình hiện có — `saveChatbotEngineAsOperator`
 *    (lib/sales-chatbot/settings.ts) và lõi Lưu / Kiểm tra / Bật của sổ kết nối (lib/connectors/service.ts) — không đường
 *    ghi thứ hai;
 *  · ghi nhật ký của tổ chức (nhãn vận hành) VÀ nhật ký nền tảng (`AI_ORG_CONTROL_SET`).
 * Khoá AI CHỈ NHẬP: không đường đọc nào ở đây trả gợi ý / bản mã — chỉ «đã có khoá» hay chưa.
 */
import type { SessionUser } from "@/lib/auth/session";
import { aiConnectionsForOperator, OPERATOR_AI_CONNECTORS, saveAiConnectionAsOperator, setAiConnectionStatusAsOperator, testAiConnectionAsOperator, type OperatorAiConnectionRow } from "@/lib/connectors/service";
import type { TesterDeps } from "@/lib/connectors/testers";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { platformAudit } from "@/lib/platform/audit";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { parseOperatorTarget } from "@/lib/platform/kill-switches";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { saveChatbotEngineAsOperator } from "@/lib/sales-chatbot/settings";
import { chatbotEngineConfig, type ChatbotEngineConfig, type EngineConnectionView, type ProviderHealthView } from "@/lib/saas/visibility";
import { engineConnections, providerHealthView } from "@/lib/saas/visibility-loaders";

export type OperatorOrgAiConfig = { orgCode: string; botEnabled: boolean; engine: ChatbotEngineConfig; connections: EngineConnectionView[]; health: ProviderHealthView[]; keys: OperatorAiConnectionRow[] };

export async function loadOperatorOrgAiConfig(user: SessionUser, orgCode: string): Promise<{ ok: true; value: OperatorOrgAiConfig } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const org = await findOrganization(orgCode);
  if (!org) return { ok: false, error: `Không có tổ chức mã «${orgCode}».` };
  try {
    const value = await withOrganization(org.code, async () => {
      const cfg = await loadSalesChatbotConfig();
      const [connections, health, keys] = await Promise.all([engineConnections(org.code), providerHealthView(), aiConnectionsForOperator()]);
      return { orgCode: org.code, botEnabled: cfg.enabled, engine: chatbotEngineConfig(cfg), connections, health, keys };
    });
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Không đọc được cấu hình AI của tổ chức." };
  }
}

type OpResult = { ok: true; message: string } | { error: string };

/** Đổi động cơ AI của bot (nguồn AI, model, dự phòng, mạch ngắt, mức suy nghĩ) — mọi ô khác của chủ shop giữ nguyên. */
export async function saveOrgChatbotEngine(user: SessionUser, input: unknown): Promise<OpResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; engine?: unknown };
  const p = await parseOperatorTarget(user, raw);
  if ("error" in p) return p;
  const r = await withOrganization(p.org.code, () => saveChatbotEngineAsOperator({ engine: raw.engine, operator: p.actor, reason: p.reason }));
  if (!r.ok) return { error: r.error };
  await platformAudit({ action: "AI_ORG_CONTROL_SET", targetOrgCode: p.org.code, subject: "sales_chatbot.engine", before: r.before, after: r.after, reason: p.reason, source: "UI", actor: p.actor });
  return { ok: true, message: r.message };
}

/** Lưu / Kiểm tra / Bật / Tắt MỘT khoá AI của workspace khách. Khoá chỉ nhập: ô trống = giữ khoá đã lưu. */
export async function operateOrgAiConnection(user: SessionUser, input: unknown, deps: { tester?: TesterDeps } = {}): Promise<OpResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; connectorKey?: unknown; op?: unknown; settings?: unknown; secrets?: unknown };
  const p = await parseOperatorTarget(user, raw);
  if ("error" in p) return p;
  const connectorKey = typeof raw.connectorKey === "string" ? raw.connectorKey : "";
  if (!(OPERATOR_AI_CONNECTORS as readonly string[]).includes(connectorKey)) return { error: "Chỉ sửa được khoá AI của workspace ở đây." };
  const op = raw.op;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const operator = { orgCode: p.actor.orgCode, email: p.actor.email };
  const r = await withOrganization(p.org.code, async () => {
    if (op === "save") {
      // Luật lõi: lưu ⇒ Nháp. Khoá ĐANG BẬT (vd khoá chính của bot HSLC) mà để Nháp là bot mất nguồn AI — nên lưu xong TỰ kiểm tra
      // lại và bật lại khi đạt; kiểm tra hỏng ⇒ báo rõ khoá đang ở Nháp (màn hình đã cảnh báo trước khi bấm).
      const wasActive = (await aiConnectionsForOperator()).find((k) => k.connectorKey === connectorKey)?.status === "ACTIVE";
      const saved = await saveAiConnectionAsOperator({ connectorKey, settings: obj(raw.settings), secrets: obj(raw.secrets), operator, reason: p.reason });
      if ("error" in saved || !wasActive) return saved;
      const tested = await testAiConnectionAsOperator({ connectorKey, operator, reason: `${p.reason} (tự kiểm lại sau khi lưu)` }, deps.tester ? { tester: deps.tester } : {});
      if ("error" in tested) return { error: `Đã lưu nhưng kiểm tra lại HỎNG — khoá đang ở Nháp, bot không dùng được khoá này: ${tested.error}` };
      const on = await setAiConnectionStatusAsOperator({ connectorKey, status: "ACTIVE", operator, reason: `${p.reason} (bật lại sau khi kiểm tra đạt)` });
      return "error" in on ? { error: `Đã lưu và kiểm tra đạt nhưng chưa bật lại được: ${on.error}` } : { ok: true as const, status: on.status, message: "Đã lưu, kiểm tra lại đạt và bật lại khoá." };
    }
    if (op === "test") return testAiConnectionAsOperator({ connectorKey, operator, reason: p.reason }, deps.tester ? { tester: deps.tester } : {});
    if (op === "activate" || op === "disable") return setAiConnectionStatusAsOperator({ connectorKey, status: op === "activate" ? "ACTIVE" : "DISABLED", operator, reason: p.reason });
    return { error: "Thao tác không hợp lệ." };
  });
  if ("error" in r) return r;
  // Nhật ký nền tảng KHÔNG mang bí mật: chỉ tên ô bí mật được nhập (nếu có).
  const secretKeys = Object.keys(obj(raw.secrets) ?? {}).filter((k) => typeof obj(raw.secrets)?.[k] === "string" && String(obj(raw.secrets)?.[k]).trim());
  await platformAudit({ action: "AI_ORG_CONTROL_SET", targetOrgCode: p.org.code, subject: `connection:${connectorKey}:${String(op)}`, before: null, after: { status: r.status, secretsChanged: secretKeys }, reason: p.reason, source: "UI", actor: p.actor });
  return { ok: true, message: r.message ?? "Đã xong." };
}

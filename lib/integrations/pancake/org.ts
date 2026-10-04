import { openActiveConnection } from "@/lib/connectors/service";
import type { SecretsKeyState } from "@/lib/connectors/secrets";
import { PANCAKE_POS_ORG_CONNECTOR, PANCAKE_POS_ORG_FIRST_RUN_DAYS, PANCAKE_POS_ORG_MAX_DAYS } from "@/lib/constants/pancake-pos-org";
import { PancakeClient, withPancakeClient } from "@/lib/integrations/pancake/client";
import { syncPancakeAll } from "@/lib/integrations/pancake/sync";
import { currentOrganization } from "@/lib/platform/context";
import { getSyncState, type SyncTrigger } from "@/lib/sync/runner";

/**
 * ═══════════ PANCAKE POS CỦA TỔ CHỨC KHÁCH — LỚP NỐI (F1 · docs/verticals/fashion-cod.md) ═══════════
 *
 *   kết nối «pancake-pos-org» ĐANG BẬT của tổ chức ngữ cảnh (`openActiveConnection` — AAD gắn tổ chức)
 *     ⇒ `PancakeClient.fromOrgConnection` (chặn bằng chủ của khoá, địa chỉ API hằng số, câu lỗi đã che khoá)
 *     ⇒ `withPancakeClient` ⇒ ĐÚNG bộ đồng bộ của nhà (`syncPancakeAll`, `processPancakeWebhook`): cùng mapper, cùng khoá tự
 *       nhiên, cùng luật «webhook cũ không đè dữ liệu mới». Không có bộ đồng bộ thứ hai (AGENTS.md mục 8.12).
 *
 * Tổ chức nhà dùng biến môi trường (job `pancake-*`) — lớp này bỏ qua nó. Tổ chức chưa bật kết nối ⇒ bỏ qua CÓ LÝ DO,
 * không ghi `sync_runs`.
 */

export type OrgPancakeSkipped = { skipped: "HOME_USES_ENV" | "NO_ACTIVE_CONNECTION"; org: string; detail: string };

export function isOrgPancakeSkipped(r: unknown): r is OrgPancakeSkipped {
  return !!r && typeof r === "object" && typeof (r as { skipped?: unknown }).skipped === "string";
}

/** Client Pancake POS của tổ chức ngữ cảnh, từ kết nối ĐANG BẬT của chính nó — hoặc lý do bỏ qua. */
export async function openOrgPancakeClient(deps: { keyState?: SecretsKeyState } = {}): Promise<{ ok: true; client: PancakeClient; org: string } | OrgPancakeSkipped> {
  const org = await currentOrganization();
  if (org.isHome) return { skipped: "HOME_USES_ENV", org: org.code, detail: "Tổ chức nhà đồng bộ Pancake bằng các job «pancake-*» (biến môi trường) — lớp này chỉ dành cho tổ chức khách." };
  const conn = await openActiveConnection(PANCAKE_POS_ORG_CONNECTOR, { keyState: deps.keyState });
  if (!conn.ok) return { skipped: "NO_ACTIVE_CONNECTION", org: org.code, detail: `Bỏ qua: ${conn.reason}` };
  const client = PancakeClient.fromOrgConnection({ organization: org.code, apiKey: (conn.secrets.apiKey ?? "").trim(), shopId: (conn.settings.shopId ?? "").trim() });
  return { ok: true, client, org: org.code };
}

/** Chạy `fn` với client Pancake của tổ chức ngữ cảnh; chưa có kết nối đang bật ⇒ trả lý do bỏ qua, không gọi `fn`. */
export async function withOrgPancake<T>(fn: () => Promise<T>, deps: { keyState?: SecretsKeyState } = {}): Promise<T | OrgPancakeSkipped> {
  const opened = await openOrgPancakeClient(deps);
  if (!("ok" in opened)) return opened;
  return withPancakeClient(opened.client, fn);
}

/**
 * Đồng bộ đủ (kho · sản phẩm · đơn · khách · đổi trả · lịch sử tồn) bằng kết nối của tổ chức. Lượt ĐẦU (chưa xong lượt kéo
 * lùi) kéo `PANCAKE_POS_ORG_FIRST_RUN_DAYS` ngày đơn, không phải 365 ngày của nhà; các lượt sau kéo phần mới.
 */
export async function syncOrgPancake(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}, deps: { keyState?: SecretsKeyState } = {}) {
  return withOrgPancake(async () => {
    const backfill = await getSyncState<{ done?: boolean }>("pancake.orders.backfill");
    const days = Math.min(Math.max(1, Math.floor(options.days ?? PANCAKE_POS_ORG_FIRST_RUN_DAYS)), PANCAKE_POS_ORG_MAX_DAYS);
    return syncPancakeAll({ trigger: options.trigger, actor: options.actor, backfill: !backfill?.done || options.days !== undefined, days });
  }, deps);
}

import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { listChannelPages, openActiveConnection } from "@/lib/connectors/service";
import { messengerApp, pageConversations } from "@/lib/integrations/messenger/graph";
import { canUseModule } from "@/lib/platform/capabilities";
import { MEDIA_ONLY_TEXT, STAFF_IMAGE_MARK } from "@/lib/sales-chatbot/fanpage";
import { finishThread, writeThreadPage } from "@/lib/sales-chatbot/history";
import { messengerTokenFor } from "@/lib/sales-chatbot/messenger";
import { noteMessengerGraphFailure } from "@/lib/sales-chatbot/messenger-health";
import {
  EMPTY_MESSENGER_HISTORY,
  MESSENGER_HISTORY_JOB,
  MESSENGER_HISTORY_LIMITS,
  MESSENGER_HISTORY_SETTING_KEY,
  messengerHistoryStale,
  parseMessengerHistoryRun,
  planGraphConversation,
  type MessengerHistoryPage,
  type MessengerHistoryRun,
} from "@/lib/sales-chatbot/messenger-history-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

/**
 * ═══════════ NHẬP HỘI THOẠI GẦN ĐÂY CỦA PAGE NỐI THẲNG META VÀO «HỘP THƯ KHÁCH» — CHỈ MÁY CHỦ (gap analysis lát B) ═══════════
 *
 * Đường Pancake (#599) không phủ shop nối THẲNG Meta — đúng nhóm khách mới. Lượt này đọc Conversations API của TỪNG page đang nối
 * (Instagram: qua page cha, `platform=instagram`), tối đa `conversationsPerPage` hội thoại mới cập nhật nhất × 20 tin gần nhất (giới
 * hạn của Meta), và ghi qua ĐÚNG đường ghi của #599: khoá `message_id` (= mã tin Meta, cùng khoá webhook ghi ⇒ nhập lại / trùng
 * webhook là bỏ qua), dấu `imported_at` + `HISTORY`, không gọi bot, không mở follow-up, không thổi phồng «chưa đọc» / «chờ trả
 * lời», máy ghi đơn không đọc lại. Không một lời gọi Pancake. Token hỏng ⇒ báo theo page (messenger-health.ts), page khác chạy
 * tiếp. Mỗi lượt một dòng `sync_runs` (`messenger-inbox-history`); trạng thái ở `settings` để màn hình hiện tiến độ.
 */

type Target = { pageId: string; kind: "PAGE" | "INSTAGRAM"; readVia: string };

/** Page / tài khoản Instagram đang nối trực tiếp: hàng `org_channel_pages` ACTIVE + page của hàng kết nối đơn cũ chưa có hàng. */
async function historyTargets(): Promise<Target[]> {
  const rows = await listChannelPages("facebook-messenger");
  const out: Target[] = rows.filter((r) => r.status === "ACTIVE").map((r) => ({ pageId: r.pageId, kind: r.kind, readVia: r.kind === "INSTAGRAM" ? (r.parentPageId ?? "") : r.pageId }));
  const known = new Set(rows.map((r) => r.pageId));
  const conn = await openActiveConnection("facebook-messenger");
  if (conn.ok) {
    const page = (conn.settings.pageId ?? "").trim();
    const ig = (conn.settings.igAccountId ?? "").trim();
    if (page && !known.has(page)) out.push({ pageId: page, kind: "PAGE", readVia: page });
    if (ig && page && !known.has(ig)) out.push({ pageId: ig, kind: "INSTAGRAM", readVia: page });
  }
  return out.filter((t) => t.readVia);
}

export type MessengerHistoryDeps = { fetch?: typeof fetch; now?: () => Date };

async function importTarget(target: Target, now: Date, deps: MessengerHistoryDeps): Promise<MessengerHistoryPage> {
  const res: MessengerHistoryPage = { pageId: target.pageId, kind: target.kind, conversations: 0, inserted: 0, duplicates: 0, fresh: 0, error: null };
  const app = messengerApp();
  if (!app) return { ...res, error: "Nền tảng chưa cấu hình app Facebook" };
  const tk = await messengerTokenFor(target.readVia);
  if (!tk.ok) return { ...res, error: tk.error };
  let after: string | null = null;
  while (res.conversations < MESSENGER_HISTORY_LIMITS.conversationsPerPage) {
    const r = await pageConversations(app, tk.token, target.readVia, { platform: target.kind === "INSTAGRAM" ? "instagram" : "messenger", after, limit: MESSENGER_HISTORY_LIMITS.pageSize, messages: MESSENGER_HISTORY_LIMITS.messagesPerConversation }, deps.fetch ?? fetch);
    if (!r.ok) {
      await noteMessengerGraphFailure(r, target.readVia, now);
      return { ...res, error: r.error };
    }
    for (const conv of r.items) {
      if (res.conversations >= MESSENGER_HISTORY_LIMITS.conversationsPerPage) break;
      const plan = planGraphConversation(conv, target.pageId, { nowMs: now.getTime(), freshMs: MESSENGER_HISTORY_LIMITS.freshMinutes * 60_000, mediaOnlyText: MEDIA_ONLY_TEXT, imageMark: STAFF_IMAGE_MARK });
      if (!plan) continue;
      res.conversations += 1;
      res.fresh += plan.fresh;
      const w = await writeThreadPage(target.pageId, plan.threadId, plan.rows, now);
      res.inserted += w.inserted;
      res.duplicates += w.duplicates;
      await finishThread(target.pageId, { id: plan.threadId, name: plan.name, phones: [], avatarUrl: null, updatedAt: plan.updatedAt }, [], now);
    }
    if (!r.after) break;
    after = r.after;
  }
  return res;
}

export async function loadMessengerHistoryRun(): Promise<MessengerHistoryRun> {
  return parseMessengerHistoryRun(await getSettingJson(MESSENGER_HISTORY_SETTING_KEY, null));
}

/** MỘT lượt nhập cho tổ chức ngữ cảnh (chạy nền sau nút bấm). Ghi `sync_runs` + trạng thái. Không ném. */
export async function runMessengerHistory(o: { trigger: SyncTrigger; actor: string }, deps: MessengerHistoryDeps = {}): Promise<MessengerHistoryRun> {
  const now = (deps.now ?? (() => new Date()))();
  const start = await loadMessengerHistoryRun();
  const r = await runSyncJob({ source: "FACEBOOK", job: MESSENGER_HISTORY_JOB, trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const pages: MessengerHistoryPage[] = [];
    for (const t of await historyTargets()) pages.push(await importTarget(t, now, deps));
    const failed = pages.filter((p) => p.error);
    const run: MessengerHistoryRun = { ...start, status: failed.length && failed.length === pages.length ? "FAILED" : "DONE", finishedAt: new Date().toISOString(), pages, lastError: failed[0]?.error ?? (pages.length ? null : "Chưa nối page Facebook / Instagram nào trực tiếp") };
    await setSettingJson(MESSENGER_HISTORY_SETTING_KEY, run);
    const sum = (k: "conversations" | "inserted" | "duplicates" | "fresh") => pages.reduce((n, p) => n + p[k], 0);
    ctx.summary.imported = sum("inserted");
    ctx.summary.updated = sum("conversations");
    ctx.summary.skipped = sum("duplicates") + sum("fresh");
    ctx.summary.detail = `nhập hội thoại Messenger trực tiếp: ${pages.length} page · ${sum("conversations")} hội thoại · ${sum("inserted")} tin mới · ${sum("duplicates")} trùng · ${sum("fresh")} quá mới`.slice(0, 900);
    if (failed.length) ctx.summary.warning = failed.map((p) => `${p.pageId}: ${p.error}`).join(" · ").slice(0, 500);
    return run;
  });
  if (r.result) return r.result;
  const failed: MessengerHistoryRun = { ...start, status: "FAILED", finishedAt: new Date().toISOString(), lastError: r.skippedBecauseRunning ? "Một lượt nhập khác đang chạy" : "Lượt nhập hỏng" };
  if (!r.skippedBecauseRunning) await setSettingJson(MESSENGER_HISTORY_SETTING_KEY, failed);
  return failed;
}

type Result = { ok: true; message: string } | { error: string };

/** Nút «Nhập hội thoại gần đây» — kiểm module + quyền; việc nặng do vỏ action chạy SAU phản hồi (`runMessengerHistory`). */
export async function startMessengerHistory(user: SessionUser, now: Date = new Date()): Promise<Result> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Chỉ người quản lý chatbot (ai_sales:manage) mới nhập được lịch sử hộp thư." };
  if (!(await historyTargets()).length) return { error: "Chưa nối page Facebook / Instagram nào trực tiếp — vào Messenger → Kết nối Facebook trước." };
  const run = await loadMessengerHistoryRun();
  if (run.status === "RUNNING" && !messengerHistoryStale(run, now)) return { error: "Lượt nhập đang chạy — bấm «Làm mới» để xem tiến độ." };
  await setSettingJson(MESSENGER_HISTORY_SETTING_KEY, { ...EMPTY_MESSENGER_HISTORY, status: "RUNNING", requestedBy: user.email, startedAt: now.toISOString() } satisfies MessengerHistoryRun);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_INBOX_MESSENGER_HISTORY_START", entity: "SETTINGS", entityId: MESSENGER_HISTORY_SETTING_KEY, before: { status: run.status }, after: { status: "RUNNING" }, reason: "Nhập hội thoại gần đây của page nối trực tiếp vào hộp thư" });
  return { ok: true, message: "Đang nhập hội thoại gần đây từ Facebook / Instagram — chạy nền vài chục giây; bấm «Làm mới» để xem kết quả." };
}

/** Khối «Hội thoại gần đây từ Facebook» của trang Chatbot bán hàng — chỉ người quản lý chatbot, chỉ khi có page nối trực tiếp. */
export async function loadMessengerHistoryView(user: SessionUser): Promise<{ run: MessengerHistoryRun; pages: number } | null> {
  if (!can(user, SALES_CHATBOT_MANAGE)) return null;
  const pages = (await historyTargets()).length;
  if (!pages) return null;
  return { run: await loadMessengerHistoryRun(), pages };
}

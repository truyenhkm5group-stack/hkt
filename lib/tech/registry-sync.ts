import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import {
  REGISTRY_NOTIFY_MAX_AGE_HOURS,
  TECH_REGISTRY_BRANCH,
  missionControlState,
  ownerDecisionQuestion,
  ownerEscalationLabel,
  parseMergeSha,
  registryNotifyKey,
  registryNotifyKind,
  type MissionControlState,
  type RegistryEntry,
} from "@/lib/constants/tech-registry";
import { env } from "@/lib/env";
import {
  GithubError,
  commitContains,
  githubConfig,
  readBranchHead,
  readRawFile,
  readTreeAt,
  type GithubErrorKind,
} from "@/lib/integrations/github/client";
import { organizationBaseUrl } from "@/lib/platform/org-links";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { gitBlobSha, missionIdFromPath, parseRegistryEvents, parseRegistryMissionText } from "@/lib/tech/registry-parse";
import { runningVersion } from "@/lib/version";

/**
 * ═══════════ CHIẾU SỔ TECH ROOM VÀO `/tech` — ĐƯỜNG GHI DUY NHẤT CỦA PHÉP CHIẾU ═══════════
 *
 * CHỈ ĐỌC sổ (`ai-control/registry` trên GitHub), GHI vào hai bảng ảnh chụp của ERP. Không một lệnh nào ở đây ghi
 * ngược vào kho git — client GitHub chỉ có `GET` (`tests/tech-phase2a.test.ts` khoá), và `tests/tech-mission-control
 * .test.ts` quét tệp này để chắc không có `git push` / `PUT` / `POST`.
 *
 * ─── IDEMPOTENT ───
 *  · Sứ mệnh: upsert theo `registry_id`; blob không đổi SHA ⇒ không tải lại, không ghi.
 *  · Sự kiện: `ON CONFLICT (line_key) DO NOTHING`, khoá = băm nội dung dòng.
 *  · Sứ mệnh biến khỏi sổ ⇒ đánh dấu `in_registry = false`, KHÔNG xoá.
 *
 * ─── BÁO LARK ĐÚNG MỘT LẦN CHO MỖI LẦN CHUYỂN ───
 *  Khoá = trạng thái + mốc bắt đầu trạng thái (`registryNotifyKey`). Giành quyền báo bằng so-sánh-rồi-đổi trên
 *  `notified_key`; gửi hỏng ⇒ trả khoá cũ, lượt sau thử lại. Lần đọc ĐẦU (bảng còn trống) và lượt có quá nhiều chuyển
 *  trạng thái một lúc (đổi luật phân loại, nạp lại sổ) CHỈ ghi mốc, không gửi một tràng tin.
 */

export const REGISTRY_SYNC_STATE_KEY = "tech:registry:sync";
/** Một lượt có nhiều chuyển trạng thái đáng báo hơn chừng này ⇒ coi là thay đổi hàng loạt: ghi mốc, không gửi. */
export const REGISTRY_NOTIFY_BATCH_CAP = 10;
/** Số lần hỏi GitHub «production có chứa commit gộp không» mỗi lượt — ẩn danh chỉ 60 lượt/giờ, chia với các job khác. */
export const REGISTRY_DEPLOY_CHECK_BUDGET = { TOKEN: 20, PUBLIC: 3 } as const;
const FETCH_CONCURRENCY = 6;

type SyncStateValue = { etag: string | null; commitSha: string | null; eventsBlobSha: string | null; at: string };

export type RegistryLarkDeps = {
  send?: typeof sendLark;
  target?: () => Promise<{ url: string; secret: string }>;
  appUrl?: string;
};

export type RegistrySyncResult = {
  skippedReason: string | null;
  skippedKind: GithubErrorKind | null;
  /** Sổ không đổi từ lần đọc trước (304 hoặc cùng commit). */
  unchanged: boolean;
  commitSha: string | null;
  initial: boolean;
  missionFiles: number;
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  restored: number;
  recomputed: number;
  invalid: { id: string; errors: string[] }[];
  fetchFailed: number;
  eventsInserted: number;
  eventsInvalid: number;
  deployChecked: number;
  deployContained: number;
  notify: { sent: number; baselined: number; skipped: string | null; error: string | null };
};

function emptyResult(): RegistrySyncResult {
  return {
    skippedReason: null,
    skippedKind: null,
    unchanged: false,
    commitSha: null,
    initial: false,
    missionFiles: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    restored: 0,
    recomputed: 0,
    invalid: [],
    fetchFailed: 0,
    eventsInserted: 0,
    eventsInvalid: 0,
    deployChecked: 0,
    deployContained: 0,
    notify: { sent: 0, baselined: 0, skipped: null, error: null },
  };
}

async function readState(): Promise<SyncStateValue | null> {
  const db = await getDb();
  const row = await db.query.syncState.findFirst({ where: eq(schema.syncState.key, REGISTRY_SYNC_STATE_KEY) });
  const v = row?.value as Partial<SyncStateValue> | undefined;
  if (!v || typeof v !== "object") return null;
  return { etag: v.etag ?? null, commitSha: v.commitSha ?? null, eventsBlobSha: v.eventsBlobSha ?? null, at: v.at ?? "" };
}

async function writeState(value: SyncStateValue) {
  const db = await getDb();
  await db
    .insert(schema.syncState)
    .values({ key: REGISTRY_SYNC_STATE_KEY, value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: new Date() } });
}

/** Mốc đọc sổ thành công gần nhất — `null` = chưa lượt nào đọc được. */
export async function lastRegistrySync(): Promise<{ at: Date | null; commitSha: string | null }> {
  const s = await readState();
  const at = s?.at ? new Date(s.at) : null;
  return { at: at && Number.isFinite(at.getTime()) ? at : null, commitSha: s?.commitSha ?? null };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const toDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
};

/** Đọc sổ (nếu đổi) → chiếu → hỏi deploy → báo Lark. Lỗi GitHub ⇒ `skippedReason`, không ném. */
export async function syncTechRegistry(opts: { force?: boolean; now?: Date; lark?: RegistryLarkDeps; deployBudget?: number } = {}): Promise<RegistrySyncResult> {
  const out: Internal = emptyResult();
  const now = opts.now ?? new Date();
  const cfg = githubConfig();
  if (!cfg.configured) return { ...out, skippedReason: cfg.reason, skippedKind: "NOT_CONFIGURED" };

  const db = await getDb();
  const m = schema.techRegistryMissions;
  const existingRows = await db
    .select({ id: m.id, registryId: m.registryId, blobSha: m.blobSha, controlState: m.controlState, inRegistry: m.inRegistry, entry: m.entry })
    .from(m);
  const existing = new Map(existingRows.map((r) => [r.registryId, r]));
  out.initial = existingRows.length === 0;

  const state = await readState();
  try {
    const head = await readBranchHead(TECH_REGISTRY_BRANCH, opts.force ? null : (state?.etag ?? null));
    if (head.notModified || (!opts.force && head.sha === state?.commitSha && existingRows.length > 0)) {
      out.unchanged = true;
      out.commitSha = state?.commitSha ?? null;
      // Không gì đổi ở sổ — vẫn ghi mốc ĐỌC (đọc được thật, chỉ là không có gì mới).
      if (state) await writeState({ ...state, at: now.toISOString() });
    } else {
      out.commitSha = head.sha;
      const complete = await projectTree(head.sha, existing, state, now, out);
      await writeState({
        // Chỉ nhớ ETag / commit khi đọc TRỌN: còn tệp tải hỏng thì lượt sau phải đọc lại cây (tệp đã có SHA khớp sẽ không tải lại).
        etag: complete ? head.etag : null,
        commitSha: complete ? head.sha : null,
        eventsBlobSha: out.eventsBlobSha ?? state?.eventsBlobSha ?? null,
        at: now.toISOString(),
      });
    }
  } catch (e) {
    if (e instanceof GithubError) return { ...out, skippedReason: e.message, skippedKind: e.kind };
    throw e;
  }

  await recomputeStates(now, out);
  await checkDeployments(now, out, opts.deployBudget ?? REGISTRY_DEPLOY_CHECK_BUDGET[cfg.auth]);
  out.notify = await notifyTransitions(now, out.initial, opts.lark ?? {});
  return out;
}

type Internal = RegistrySyncResult & { eventsBlobSha?: string | null };

async function projectTree(
  commitSha: string,
  existing: Map<string, { id: string; registryId: string; blobSha: string; controlState: string; inRegistry: boolean }>,
  state: SyncStateValue | null,
  now: Date,
  out: Internal,
): Promise<boolean> {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const tree = await readTreeAt(commitSha);
  const files = tree.entries.filter((e) => e.type === "blob");
  const missionFiles = files.map((f) => ({ ...f, missionId: missionIdFromPath(f.path) })).filter((f): f is typeof f & { missionId: string } => f.missionId !== null);
  out.missionFiles = missionFiles.length;
  let complete = !tree.truncated;

  // ── Sứ mệnh còn trong sổ mà blob KHÔNG đổi: chỉ cần khôi phục cờ nếu trước đó đã biến mất ──
  const restore = missionFiles.filter((f) => {
    const ex = existing.get(f.missionId);
    return ex && ex.blobSha === f.sha && !ex.inRegistry;
  });
  if (restore.length) {
    await db
      .update(m)
      .set({ inRegistry: true, removedAt: null, syncedAt: now })
      .where(inArray(m.registryId, restore.map((f) => f.missionId)));
    out.restored = restore.length;
  }

  // ── Blob mới / đổi SHA ⇒ tải theo SHA commit (bất biến) ──
  const toFetch = missionFiles.filter((f) => existing.get(f.missionId)?.blobSha !== f.sha);
  const fetched = await mapLimit(toFetch, FETCH_CONCURRENCY, async (f) => {
    try {
      return { f, text: await readRawFile(commitSha, f.path) };
    } catch (e) {
      // Hết hạn mức / mất mạng giữa chừng: NÉM để cả lượt dừng có lý do — phần đã ghi vẫn đúng.
      if (e instanceof GithubError && (e.kind === "RATE_LIMITED" || e.kind === "AUTH_FAILED")) throw e;
      return { f, text: null as string | null };
    }
  });

  for (const { f, text } of fetched) {
    if (text === null) {
      out.fetchFailed += 1;
      complete = false;
      continue;
    }
    out.fetched += 1;
    if (gitBlobSha(text) !== f.sha) {
      // Raw theo SHA commit là bất biến, nên lệch nghĩa là nội dung bị biến đổi dọc đường — không chiếu thứ mình không chắc.
      out.invalid.push({ id: f.missionId, errors: ["nội dung tải về không khớp SHA blob trong cây"] });
      complete = false;
      continue;
    }
    const parsed = parseRegistryMissionText(text);
    if (!parsed.entry || parsed.entry.missionId !== f.missionId) {
      out.invalid.push({ id: f.missionId, errors: parsed.entry ? ["mission_id trong tệp khác tên tệp"] : parsed.errors });
      continue;
    }
    const e = parsed.entry;
    const cs = missionControlState(e).state;
    const ex = existing.get(e.missionId);
    const values = {
      registryId: e.missionId,
      title: e.title,
      status: e.status,
      controlState: cs,
      priority: e.priority,
      risk: e.risk,
      owner: e.owner,
      branch: e.branch ?? "",
      entry: e as unknown as Record<string, unknown>,
      blobSha: f.sha,
      srcUpdatedAt: toDate(e.updatedAt),
      lastHeartbeatAt: toDate(e.lastHeartbeat),
      inRegistry: true,
      removedAt: null,
      syncedAt: now,
    };
    if (!ex) {
      await db.insert(m).values({ ...values, stateSince: now }).onConflictDoNothing({ target: m.registryId });
      out.inserted += 1;
    } else {
      await db
        .update(m)
        .set({ ...values, ...(ex.controlState !== cs ? { stateSince: now } : {}) })
        .where(eq(m.id, ex.id));
      out.updated += 1;
    }
  }

  // ── Biến khỏi sổ ⇒ đánh dấu, không xoá ──
  if (!tree.truncated) {
    const present = new Set(missionFiles.map((f) => f.missionId));
    const gone = [...existing.values()].filter((r) => r.inRegistry && !present.has(r.registryId)).map((r) => r.registryId);
    if (gone.length) {
      await db
        .update(m)
        .set({ inRegistry: false, removedAt: now, syncedAt: now })
        .where(and(inArray(m.registryId, gone), eq(m.inRegistry, true)));
      out.removed = gone.length;
    }
  }

  // ── Nhật ký sự kiện ──
  const ev = files.find((f) => f.path === "events.ndjson");
  if (ev && ev.sha !== state?.eventsBlobSha) {
    try {
      const text = await readRawFile(commitSha, ev.path);
      const parsed = parseRegistryEvents(text);
      out.eventsInvalid = parsed.invalid;
      const e = schema.techRegistryEvents;
      for (let i = 0; i < parsed.events.length; i += 500) {
        const chunk = parsed.events.slice(i, i + 500);
        const ins = await db
          .insert(e)
          .values(chunk.map((x) => ({ lineKey: x.lineKey, seq: x.seq, at: x.at, kind: x.kind, actor: x.actor, missionId: x.missionId, detail: x.detail, syncedAt: now })))
          .onConflictDoNothing({ target: e.lineKey })
          .returning({ id: e.id });
        out.eventsInserted += ins.length;
      }
      out.eventsBlobSha = ev.sha;
    } catch (err) {
      if (err instanceof GithubError && (err.kind === "RATE_LIMITED" || err.kind === "AUTH_FAILED")) throw err;
      complete = false;
    }
  }
  return complete;
}

/** Luật phân loại đổi theo bản deploy ⇒ tính lại trạng thái từ dòng sổ ĐÃ LƯU, không cần tải lại. */
async function recomputeStates(now: Date, out: RegistrySyncResult) {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const rows = await db.select({ id: m.id, controlState: m.controlState, entry: m.entry }).from(m);
  for (const r of rows) {
    const cs = missionControlState(r.entry as unknown as RegistryEntry).state;
    if (cs === r.controlState) continue;
    await db.update(m).set({ controlState: cs, stateSince: now }).where(and(eq(m.id, r.id), eq(m.controlState, r.controlState)));
    out.recomputed += 1;
  }
}

/**
 * DEPLOYED do ERP tự kiểm: commit đang chạy (`ERP_COMMIT`) có CHỨA commit gộp không (GitHub compare). Đã CHỨA thì không
 * hỏi lại; CHƯA chứa thì hỏi lại khi production đổi commit. Không biết commit đang chạy ⇒ không hỏi (CHƯA BIẾT).
 */
async function checkDeployments(now: Date, out: RegistrySyncResult, budget: number) {
  const prod = runningVersion().commit;
  if (!prod || !/^[0-9a-f]{7,40}$/i.test(prod) || budget <= 0) return;
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const rows = await db
    .select({ id: m.id, entry: m.entry, deployCheck: m.deployCheck, deployCheckedCommit: m.deployCheckedCommit, srcUpdatedAt: m.srcUpdatedAt })
    .from(m)
    .where(eq(m.inRegistry, true));
  const cands = rows
    .map((r) => ({ ...r, mergeSha: parseMergeSha((r.entry as unknown as RegistryEntry).evidence?.merged) }))
    .filter((r) => r.mergeSha && r.deployCheck !== "CONTAINED" && r.deployCheckedCommit !== prod)
    .sort((a, b) => (b.srcUpdatedAt?.getTime() ?? 0) - (a.srcUpdatedAt?.getTime() ?? 0))
    .slice(0, budget);
  for (const c of cands) {
    try {
      const contained = await commitContains(prod, c.mergeSha as string);
      await db
        .update(m)
        .set({ deployCheck: contained ? "CONTAINED" : "NOT_CONTAINED", deployCheckedCommit: prod, deployCheckedAt: now })
        .where(eq(m.id, c.id));
      out.deployChecked += 1;
      if (contained) out.deployContained += 1;
    } catch (e) {
      if (e instanceof GithubError) break; // hết hạn mức / mạng — lượt sau hỏi tiếp, không ghi một câu trả lời đoán
      throw e;
    }
  }
}

async function defaultTarget() {
  const c = await loadAlertConfig();
  return { url: c.larkManagerWebhookUrl, secret: c.larkManagerSecret };
}

const maskUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "[url]");

/** Gửi MỘT tin Lark cho mọi lần chuyển trạng thái đáng báo chưa báo. Trả kết quả, không ném. */
export async function notifyTransitions(now: Date, initial: boolean, deps: RegistryLarkDeps): Promise<RegistrySyncResult["notify"]> {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const rows = await db
    .select({ id: m.id, registryId: m.registryId, title: m.title, controlState: m.controlState, stateSince: m.stateSince, priority: m.priority, risk: m.risk, notifiedKey: m.notifiedKey, entry: m.entry })
    .from(m)
    .where(eq(m.inRegistry, true));
  const maxAge = REGISTRY_NOTIFY_MAX_AGE_HOURS * 3_600_000;
  const due = rows
    .map((r) => ({ ...r, kind: registryNotifyKind(r.controlState as MissionControlState, r.priority, r.risk), key: registryNotifyKey(r.controlState as MissionControlState, r.stateSince) }))
    .filter((r) => r.kind && r.notifiedKey !== r.key);
  const result = { sent: 0, baselined: 0, skipped: null as string | null, error: null as string | null };
  if (!due.length) return result;

  const fresh = due.filter((r) => now.getTime() - r.stateSince.getTime() <= maxAge);
  const baseline = async (list: typeof due) => {
    for (const r of list) await db.update(m).set({ notifiedKey: r.key }).where(and(eq(m.id, r.id), eq(m.notifiedKey, r.notifiedKey)));
    result.baselined += list.length;
  };
  // Chuyển trạng thái quá cũ: ghi mốc, không báo (tin cũ hai ngày không giúp ai quyết gì).
  await baseline(due.filter((r) => !fresh.includes(r)));
  if (!fresh.length) return result;
  if (initial || fresh.length > REGISTRY_NOTIFY_BATCH_CAP) {
    await baseline(fresh);
    result.skipped = initial ? "lần đọc sổ đầu tiên — chỉ ghi mốc, không báo hàng loạt" : `${fresh.length} chuyển trạng thái cùng lúc (> ${REGISTRY_NOTIFY_BATCH_CAP}) — coi là thay đổi hàng loạt, chỉ ghi mốc`;
    return result;
  }

  const to = await (deps.target ?? defaultTarget)();
  if (!to.url) {
    result.skipped = "chưa khai webhook nhóm Quản lý (LARK_MANAGER_WEBHOOK_URL) — không gửi, không lùi về nhóm khác";
    return result;
  }

  // Giành quyền báo: chỉ lượt ghi được khoá mới gửi.
  const won: typeof fresh = [];
  for (const r of fresh) {
    const ok = await db
      .update(m)
      .set({ notifiedKey: r.key, notifiedAt: now })
      .where(and(eq(m.id, r.id), eq(m.notifiedKey, r.notifiedKey)))
      .returning({ id: m.id });
    if (ok.length) won.push(r);
  }
  if (!won.length) return result;

  const appUrl = deps.appUrl ?? (await organizationBaseUrl().catch(() => env.appUrl));
  const lines = won.map((r) => {
    const e = r.entry as unknown as RegistryEntry;
    if (r.kind === "WAITING_APPROVAL") {
      const viec = e.needsOwner?.action || ownerDecisionQuestion(r.title);
      return [{ text: `• Chờ anh quyết — ${ownerEscalationLabel(e.needsOwner?.category)}: ` }, { text: viec.slice(0, 300), href: `${appUrl}/tech/needs-owner` }];
    }
    return [{ text: `• Xong, đã kiểm production (${r.priority} · ${r.risk}): ` }, { text: `${r.registryId} — ${r.title.slice(0, 200)}`, href: `${appUrl}/tech/missions/registry/${r.registryId}` }];
  });
  const title = `Phòng Tech: ${won.length} sứ mệnh cần anh biết`;
  const send = deps.send ?? sendLark;
  const sent = await send(to.url, to.secret, title, lines).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!sent.ok) {
    // Trả khoá cũ: lượt sau thử lại. Không ghi «đã báo» cho một tin chưa tới.
    for (const r of won) await db.update(m).set({ notifiedKey: r.notifiedKey, notifiedAt: null }).where(and(eq(m.id, r.id), eq(m.notifiedKey, r.key)));
    result.error = maskUrls(sent.error ?? "không rõ");
    return result;
  }
  result.sent = won.length;
  return result;
}

export async function runTechRegistrySync(options: { trigger?: SyncTrigger; actor?: string; force?: boolean } = {}) {
  return runSyncJob({ source: "GITHUB", job: "tech-registry-sync", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const r = await syncTechRegistry({ force: options.force });
    if (r.skippedReason) {
      ctx.summary.warning = `Chưa đọc được sổ: ${r.skippedReason}`;
      ctx.summary.detail = r.skippedKind === "RATE_LIMITED" ? "Bỏ qua — GitHub tạm khoá vì hạn mức, lượt sau tự đọc lại." : r.skippedKind === "NOT_CONFIGURED" ? "Bỏ qua — chưa biết đọc kho nào." : `Đọc sổ hỏng (${r.skippedKind ?? "HTTP"}).`;
      if (r.skippedKind !== "RATE_LIMITED" && r.skippedKind !== "NOT_CONFIGURED") ctx.summary.failed = 1;
      return r;
    }
    ctx.summary.imported = r.inserted + r.eventsInserted;
    ctx.summary.updated = r.updated + r.removed + r.restored + r.recomputed + r.deployChecked;
    ctx.summary.skipped = r.unchanged ? r.missionFiles : Math.max(0, r.missionFiles - r.fetched);
    ctx.summary.failed = r.fetchFailed + r.invalid.length;
    const bao = r.notify.sent ? `báo Lark ${r.notify.sent}` : r.notify.error ? `báo Lark HỎNG: ${r.notify.error}` : r.notify.skipped ? `không báo (${r.notify.skipped})` : "không có gì để báo";
    ctx.summary.detail = r.unchanged
      ? `Sổ không đổi (${(r.commitSha ?? "").slice(0, 7)}) · ${r.recomputed} tính lại trạng thái · hỏi deploy ${r.deployChecked} · ${bao}`
      : `Sổ ${(r.commitSha ?? "").slice(0, 7)}: ${r.missionFiles} sứ mệnh · tải ${r.fetched} · thêm ${r.inserted} · cập nhật ${r.updated} · biến mất ${r.removed} · ${r.eventsInserted} sự kiện mới · hỏi deploy ${r.deployChecked} · ${bao}`;
    for (const x of r.invalid) ctx.log(`bỏ dòng sổ ${x.id}: ${x.errors.join("; ")}`);
    if (r.invalid.length || r.fetchFailed || r.notify.error) {
      ctx.summary.warning = [r.invalid.length ? `${r.invalid.length} dòng sổ sai dạng (không chiếu)` : "", r.fetchFailed ? `${r.fetchFailed} tệp tải hỏng (lượt sau đọc lại)` : "", r.notify.error ? `gửi Lark hỏng: ${r.notify.error}` : ""].filter(Boolean).join(" · ");
    }
    return r;
  });
}

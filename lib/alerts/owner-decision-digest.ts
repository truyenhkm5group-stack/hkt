import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { resolvePermissions } from "@/lib/auth/permissions";
import { loadRoleTemplates, type SessionUser } from "@/lib/auth/session";
import {
  DEFAULT_OWNER_DIGEST_CONFIG,
  decideOwnerDecisionDigest,
  inOwnerDigestWindow,
  OWNER_DIGEST_CONFIG_KEY,
  OWNER_DIGEST_LEDGER_KEY,
  OWNER_DIGEST_SKIP_LABEL,
  OWNER_DIGEST_URGENT_KINDS,
  ownerDigestMorningDone,
  parseOwnerDigestLedger,
  type OwnerDigestConfig,
  type OwnerDigestLedger,
  type OwnerDigestQueue,
  type OwnerDigestReason,
} from "@/lib/constants/owner-digest";
import type { OwnerDecisionKind } from "@/lib/constants/owner-decisions";
import { env } from "@/lib/env";
import { getOwnerDecisionQueue, OWNER_DECISION_WRITE_TIMEOUT_MS } from "@/lib/queries/owner-decisions";
import { getSettingJson } from "@/lib/settings";

/**
 * ═══════════ GỬI "CẦN ANH QUYẾT" VÀO NHÓM LARK QUẢN LÝ ═══════════
 *
 * Chạy trong job `alerts` có sẵn (10 phút/lần và sau webhook) — KHÔNG thêm lịch mới (AGENTS.md §7).
 * Khi nào gửi do hàm thuần `decideOwnerDecisionDigest` quyết; tệp này chỉ đọc, gửi, và ghi sổ.
 *
 * ─── AI LÀ "NGƯỜI XEM" CỦA BẢN TIN ───
 *
 * Tin đi vào NHÓM Quản lý, không phải hộp thư chủ shop — nên nó chỉ được mang loại mà người trong nhóm
 * được thấy. Người xem là một TÀI KHOẢN MÁY (`OWNER_DIGEST_VIEWER_ID`, không có dòng `users`) mang ĐÚNG bộ
 * quyền mẫu của vai trò `MANAGER` (`resolvePermissions("MANAGER", null, loadRoleTemplates())` — tức cả
 * bản ghi đè `auth.rolePermissions` trên production). `getOwnerDecisionQueue` áp `allowedKinds` lên bộ
 * quyền đó như với mọi người xem: loại nào Quản lý không mở được màn hình chủ thì nguồn của nó KHÔNG được
 * đọc. Quyền này chỉ sống trong lượt dựng tin: không phiên, không cookie, không ghi được gì (tệp này không
 * gọi một server action nào). Phạm vi dữ liệu coi là `ALL` — mặc định của mọi tài khoản (luật 30) và là
 * phạm vi của nhóm điều hành; quyền `expenses:view` của loại quảng cáo vẫn phải có trong mẫu MANAGER.
 *
 * Người xem máy không phải người xin duyệt nào, nên mọi yêu cầu đang chờ đều hiện (người xin tự duyệt
 * không được — nhưng người đọc tin là cả nhóm).
 *
 * ─── CHỐNG GỬI LẠI, KỂ CẢ HAI LƯỢT CHẠY SONG SONG ───
 *
 * `evaluateAlerts` được gọi từ nhiều job cùng lúc. Sổ `owner.digest.sent` ghi bằng SO-SÁNH-RỒI-ĐỔI trên
 * đúng dòng `settings`: lượt muốn gửi phải GIÀNH quyền (ghi `claim` với điều kiện sổ chưa đổi); lượt thua
 * bỏ qua. Gửi xong thì ghi sổ mới; gửi HỎNG thì trả sổ cũ (lượt sau thử lại, không im lặng bỏ cả ngày).
 * Máy chết giữa chừng ⇒ `claim` quá `claimTtlMinutes` thì lượt sau lấy lại. Không giữ giao dịch CSDL
 * trong lúc gọi mạng: bể kết nối chỉ có 5.
 *
 * Không in URL webhook / khoá ký ra kết quả: lỗi gửi đi qua `maskUrls` trước khi vào nhật ký.
 */

export const OWNER_DIGEST_VIEWER_ID = "system:owner-digest";

/** Sau một lượt đọc đầy đủ hàng đợi mà KHÔNG gửi được (hỏng / rỗng vì nguồn hỏng), đợi chừng này mới đọc lại. */
const FULL_RETRY_MS = 5 * 60_000;
const holder = globalThis as unknown as { __erpOwnerDigestFullAt?: number };

export type OwnerDigestResult = {
  sent: OwnerDigestReason | null;
  items: number;
  skipped?: string;
  error?: string;
};

export type OwnerDigestDeps = {
  now?: Date;
  /** Thay đường gửi (kiểm thử — KHÔNG BAO GIỜ gọi mạng trong bài kiểm). */
  send?: typeof sendLark;
  /** Thay đường đọc hàng đợi (kiểm thử). */
  loadQueue?: (viewer: SessionUser, now: Date, onlyKinds: readonly OwnerDecisionKind[] | undefined) => Promise<OwnerDigestQueue>;
  /** Thay nơi lấy webhook nhóm Quản lý (kiểm thử). */
  target?: () => Promise<{ url: string; secret: string }>;
  /** Thay nhịp đọc lại sau lượt đầy đủ không gửi được (kiểm thử đặt 0). */
  fullRetryMs?: number;
};

/** Che mọi URL trong một câu lỗi — kho PUBLIC, nhật ký job không được mang webhook. */
export function maskUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/g, "[url]");
}

/** Người xem máy của bản tin — bộ quyền mẫu của vai trò MANAGER, phạm vi ALL. */
export async function ownerDigestViewer(): Promise<SessionUser> {
  const templates = await loadRoleTemplates().catch(() => ({}));
  return {
    id: OWNER_DIGEST_VIEWER_ID,
    email: "",
    name: "Bản tin Cần anh quyết (máy)",
    role: "MANAGER",
    permissions: resolvePermissions("MANAGER", null, templates),
    scope: "ALL",
    departmentCodes: [],
    positionId: null,
  };
}

async function defaultLoadQueue(viewer: SessionUser, now: Date, onlyKinds: readonly OwnerDecisionKind[] | undefined): Promise<OwnerDigestQueue> {
  // Không ai ngồi chờ job: hạn mỗi nguồn rộng như lượt ghi, để nguồn nặng (tồn, quảng cáo) kịp trả.
  return getOwnerDecisionQueue({ viewer, now, onlyKinds, timeoutMs: OWNER_DECISION_WRITE_TIMEOUT_MS, scopeOk: async () => true });
}

async function defaultTarget() {
  const cfg = await loadAlertConfig();
  return { url: cfg.larkManagerWebhookUrl, secret: cfg.larkManagerSecret };
}

// ─── Sổ trên đúng một dòng settings, ghi bằng so-sánh-rồi-đổi ───

async function readLedgerRow(): Promise<{ text: string | null; ledger: OwnerDigestLedger }> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, OWNER_DIGEST_LEDGER_KEY)).limit(1);
  const text = row?.value ?? null;
  return { text, ledger: parseOwnerDigestLedger(text) };
}

/** Ghi `next` CHỈ KHI dòng vẫn đúng là `fromText` (null = chưa có dòng). Trả `true` nếu ghi được. */
async function casLedger(fromText: string | null, next: OwnerDigestLedger): Promise<{ ok: boolean; text: string }> {
  const db = await getDb();
  const s = schema.settings;
  const text = JSON.stringify(next);
  if (fromText === null) {
    const r = await db.insert(s).values({ key: OWNER_DIGEST_LEDGER_KEY, value: text }).onConflictDoNothing().returning({ key: s.key });
    return { ok: r.length === 1, text };
  }
  const r = await db
    .update(s)
    .set({ value: text, updatedAt: new Date() })
    .where(and(eq(s.key, OWNER_DIGEST_LEDGER_KEY), eq(s.value, fromText)))
    .returning({ key: s.key });
  return { ok: r.length === 1, text };
}

export async function runOwnerDecisionDigest(deps: OwnerDigestDeps = {}): Promise<OwnerDigestResult> {
  const now = deps.now ?? new Date();
  const cfg = await getSettingJson<OwnerDigestConfig>(OWNER_DIGEST_CONFIG_KEY, DEFAULT_OWNER_DIGEST_CONFIG);
  if (cfg.enabled !== true) return { sent: null, items: 0, skipped: OWNER_DIGEST_SKIP_LABEL.DISABLED };
  const to = await (deps.target ?? defaultTarget)();
  if (!to.url) return { sent: null, items: 0, skipped: "chưa khai webhook nhóm Quản lý — không gửi (không lùi về nhóm vận đơn)" };
  // Ngoài giờ thì khỏi đọc hàng đợi (hàm thuần cũng chặn — đây chỉ là tiết kiệm).
  if (!inOwnerDigestWindow(now)) return { sent: null, items: 0, skipped: OWNER_DIGEST_SKIP_LABEL.OUTSIDE_HOURS };

  const before = await readLedgerRow();
  // Bản sáng đã xét ⇒ chỉ loại GẤP mới kích được tin: đọc hai nguồn nhẹ, không dựng lại tồn / quảng cáo.
  const morningDone = ownerDigestMorningDone(before.ledger, now);
  if (!morningDone && holder.__erpOwnerDigestFullAt && now.getTime() - holder.__erpOwnerDigestFullAt < (deps.fullRetryMs ?? FULL_RETRY_MS) && now.getTime() >= holder.__erpOwnerDigestFullAt) {
    return { sent: null, items: 0, skipped: "vừa thử bản sáng — đợi vài phút rồi đọc lại" };
  }
  const viewer = await ownerDigestViewer();
  const queue = await (deps.loadQueue ?? defaultLoadQueue)(viewer, now, morningDone ? OWNER_DIGEST_URGENT_KINDS : undefined);
  const decision = decideOwnerDecisionDigest(before.ledger, queue, now, { enabled: true, appUrl: env.appUrl });

  if (!decision.send || !decision.message) {
    if (!morningDone && decision.reason === "SOURCES_FAILED") holder.__erpOwnerDigestFullAt = now.getTime();
    if (JSON.stringify(decision.nextState) !== JSON.stringify(before.ledger)) await casLedger(before.text, decision.nextState);
    return { sent: null, items: 0, skipped: OWNER_DIGEST_SKIP_LABEL[decision.reason as keyof typeof OWNER_DIGEST_SKIP_LABEL] ?? String(decision.reason) };
  }

  // Giành quyền gửi: chỉ MỘT lượt ghi được `claim` lên đúng bản sổ nó đã đọc.
  const claimed = await casLedger(before.text, { ...before.ledger, claim: { token: randomUUID(), at: now.toISOString() } });
  if (!claimed.ok) return { sent: null, items: 0, skipped: "lượt khác vừa ghi sổ — không gửi trùng" };

  const send = deps.send ?? sendLark;
  const r = await send(to.url, to.secret, decision.message.title, decision.message.lines).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!r.ok) {
    // Trả sổ cũ (bỏ claim): lượt sau thử lại. Không ghi "đã gửi" cho một tin chưa tới.
    await casLedger(claimed.text, { ...before.ledger, claim: null });
    if (!morningDone) holder.__erpOwnerDigestFullAt = now.getTime();
    const error = maskUrls(r.error ?? "không rõ");
    return { sent: null, items: decision.keys.length, skipped: "gửi hỏng", error };
  }
  await casLedger(claimed.text, decision.nextState);
  return { sent: decision.reason as OwnerDigestReason, items: decision.keys.length };
}

/** Chỉ cho kiểm thử: xoá nhịp đọc lại trong bộ nhớ. */
export function resetOwnerDigestThrottle() {
  holder.__erpOwnerDigestFullAt = undefined;
}

/**
 * ═══════════ SỔ LỖI ĐĂNG NHẬP CÓ LÝ DO — ĐƯỜNG GHI DUY NHẤT CỦA `platform_auth_failures` (CSDL NHÀ) — CHỈ MÁY CHỦ ═══════════
 *
 * Gọi từ màn đăng nhập (`lib/actions/auth.ts`), liên kết đặt lại / kích hoạt mật khẩu (`lib/users/password-reset.ts`) và liên kết mời
 * (`lib/users/invites.ts`) — ĐÚNG ở nhánh hỏng, SAU khi câu trả cho người dùng đã quyết (câu ấy không đổi, không lộ gì).
 *
 * ─── ĐƯỜNG NÓNG ───
 *  · KHÔNG BAO GIỜ ném, không chặn luồng chính: lỗi ghi sổ chỉ in một dòng log máy chủ (không email, không IP, không mật khẩu).
 *  · Không thêm vòng CSDL mà kẻ dò khuếch đại được: lượt sai thường đã bị bộ chặn dò giới hạn (5 / cặp, 30 / máy mỗi 15 phút) — mỗi
 *    lượt sai một dòng là tỷ lệ 1:1 với một lượt băm mật khẩu. Lượt BỊ CHẶN thì không: kẻ dò bắn bao nhiêu cũng được. Nên THROTTLED
 *    ghi ĐÚNG MỘT dòng cho mỗi (khoá đang chặn, cửa sổ khoá): kiểm trong bộ nhớ TRƯỚC mọi lượt đọc / ghi CSDL, và khoá `dedupe_key`
 *    duy nhất ở CSDL chặn lần nữa (nhiều tiến trình).
 *
 * ─── KHÔNG DỮ LIỆU THÔ ───
 *  · `identifier_hash` = HMAC-SHA256(AUTH_SECRET) của định danh ĐÃ CHUẨN HOÁ (`parseLoginIdentifier`): đếm được «cùng một người thử
 *    lại», không tra ngược được. `identifier_masked` = «ng***@gmail.com» (CHECK ở CSDL buộc có «***»). IP chỉ băm. Không mật khẩu.
 *  · `org_code` chỉ khi tổ chức CÓ THẬT trong sổ — mã kẻ dò gõ bừa không vào bảng.
 */
import { createHmac } from "node:crypto";
import { lt } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { parseLoginIdentifier } from "@/lib/auth/identity-shared";
import { AUTH_FAILURE_FLOWS, AUTH_FAILURE_REASONS, AUTH_FAILURE_RETENTION_DAYS, maskLoginIdentifier, type AuthFailureFlow, type AuthFailureReason } from "@/lib/constants/auth-failures";
import { env } from "@/lib/env";
import { findOrganization } from "@/lib/platform/organizations";

export type AuthFailureInput = {
  flow: AuthFailureFlow;
  reason: AuthFailureReason;
  /** Mã tổ chức ỨNG VIÊN (gõ trên form / trên đường dẫn / tổ chức đã tra) — chỉ vào sổ khi tổ chức có thật. */
  orgCode: string | null;
  /** Ô email / SĐT người gõ, hoặc email của liên kết đã tra ra. `null` = không biết là ai. */
  identifier: string | null;
  ip: string | null;
  at?: Date;
  /** THROTTLED: khoá đang chặn + mốc mở (`loginLockOf`) — danh tính của cửa sổ khoá. Thiếu ⇒ KHÔNG ghi (không chống trùng được). */
  lock?: { key: string; lockedUntil: number } | null;
};

/** Định danh đã chuẩn hoá: email / SĐT hợp lệ ⇒ dạng chuẩn; chuỗi khác ⇒ chữ thường, cắt 200 ký tự (chỉ để băm, che thành «***»). */
export function normalizeAuthIdentifier(raw: string | null | undefined): { kind: "EMAIL" | "PHONE" | null; value: string } | null {
  if (typeof raw !== "string") return null;
  const parsed = parseLoginIdentifier(raw);
  if (parsed) return parsed;
  const v = raw.trim().toLowerCase().slice(0, 200);
  return v ? { kind: null, value: v } : null;
}

/** HMAC của định danh đã chuẩn hoá — khoá AUTH_SECRET, tách miền bằng tiền tố (không trùng băm nào khác của kho). */
export function authIdentifierHash(normalized: string): string {
  return createHmac("sha256", env.authSecret).update(`auth-failure-id/v1\n${normalized}`).digest("hex");
}

function ipHashOf(ip: string): string {
  return createHmac("sha256", env.authSecret).update(`auth-failure-ip/v1\n${ip || "unknown"}`).digest("hex");
}

// ─── THROTTLED: một dòng mỗi cửa sổ khoá (bộ nhớ, có trần) ───
const seenLocks = new Map<string, number>();
const SEEN_LOCKS_MAX = 5_000;

function firstInLockWindow(id: string, lockedUntil: number, now: number): boolean {
  if (seenLocks.has(id)) return false;
  if (seenLocks.size >= SEEN_LOCKS_MAX) {
    for (const [k, until] of seenLocks) if (until <= now) seenLocks.delete(k);
    while (seenLocks.size >= SEEN_LOCKS_MAX) {
      const oldest = seenLocks.keys().next();
      if (oldest.done) break;
      seenLocks.delete(oldest.value);
    }
  }
  seenLocks.set(id, lockedUntil);
  return true;
}

/** Chỉ cho kiểm thử: quên các cửa sổ khoá đã ghi. */
export function resetAuthFailureLocksForTests(): void {
  seenLocks.clear();
}

/** Ghi MỘT lỗi. `true` = đã có dòng mới; `false` = bỏ qua (trùng cửa sổ khoá / dữ liệu sai hình) hoặc ghi hỏng. Không ném. */
export async function recordAuthFailure(input: AuthFailureInput): Promise<boolean> {
  try {
    if (!(AUTH_FAILURE_FLOWS as readonly string[]).includes(input.flow) || !(AUTH_FAILURE_REASONS as readonly string[]).includes(input.reason)) return false;
    const at = input.at ?? new Date();
    let dedupeKey: string | null = null;
    if (input.reason === "THROTTLED") {
      if (!input.lock) return false;
      const id = `${input.flow}\n${input.lock.key}\n${input.lock.lockedUntil}`;
      if (!firstInLockWindow(id, input.lock.lockedUntil, at.getTime())) return false;
      dedupeKey = createHmac("sha256", env.authSecret).update(`auth-failure-lock/v1\n${id}`).digest("hex");
    }
    const candidate = (input.orgCode ?? "").trim().toLowerCase();
    const org = candidate ? await findOrganization(candidate) : null;
    const ident = normalizeAuthIdentifier(input.identifier);
    const pdb = await getPlatformDb();
    const insert = pdb.insert(schema.platformAuthFailures).values({
      at,
      orgCode: org?.code ?? null,
      flow: input.flow,
      reasonCode: input.reason,
      identifierHash: ident ? authIdentifierHash(ident.value) : null,
      identifierMasked: ident ? maskLoginIdentifier(ident.kind, ident.value) : null,
      ipHash: input.ip ? ipHashOf(input.ip) : null,
      dedupeKey,
    });
    if (!dedupeKey) {
      await insert;
      return true;
    }
    const rows = await insert.onConflictDoNothing().returning({ id: schema.platformAuthFailures.id });
    return rows.length > 0;
  } catch (error) {
    // Không in input (email / IP) — chỉ đường và lý do.
    console.error(`[auth-failures] ghi lỗi đăng nhập hỏng (${input.flow}/${input.reason}): ${error instanceof Error ? error.message.slice(0, 200) : "lỗi lạ"}`);
    return false;
  }
}

/** Dọn dòng quá hạn giữ (`AUTH_FAILURE_RETENTION_DAYS`). Gọi từ lượt `alerts` của tổ chức nhà, có nhịp. Ném khi CSDL hỏng. */
export async function pruneAuthFailures(now: Date = new Date(), days: number = AUTH_FAILURE_RETENTION_DAYS): Promise<number> {
  const pdb = await getPlatformDb();
  const t = schema.platformAuthFailures;
  const rows = await pdb
    .delete(t)
    .where(lt(t.at, new Date(now.getTime() - days * 86_400_000)))
    .returning({ id: t.id });
  return rows.length;
}

/** Nhịp dọn trong tiến trình: tối đa một lượt mỗi 6 giờ (lượt `alerts` chạy 10 phút / lần). */
const PRUNE_EVERY_MS = 6 * 3_600_000;
let lastPruneAt = 0;

/** Cho job: dọn khi tới nhịp; trả câu ngắn cho chi tiết lượt chạy (`null` = chưa tới nhịp). Không ném. */
export async function pruneAuthFailuresForJob(now: Date = new Date()): Promise<string | null> {
  if (now.getTime() - lastPruneAt < PRUNE_EVERY_MS) return null;
  lastPruneAt = now.getTime();
  try {
    const n = await pruneAuthFailures(now);
    return n ? `dọn ${n} dòng lỗi đăng nhập quá ${AUTH_FAILURE_RETENTION_DAYS} ngày` : null;
  } catch (e) {
    return `dọn sổ lỗi đăng nhập hỏng: ${e instanceof Error ? e.message.slice(0, 120) : "lỗi lạ"}`;
  }
}

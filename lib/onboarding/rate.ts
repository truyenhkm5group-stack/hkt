/**
 * ═══════════ TRẦN ĐĂNG KÝ (Phase 10 · §1) — ĐẾM TỪ BẢNG, KHÔNG TỪ BỘ NHỚ ═══════════
 *
 * Nhiều tiến trình (hoặc một lần khởi động lại) thì bộ đếm trong bộ nhớ là trần GIẢ. Nên mỗi lượt thử ghi MỘT dòng
 * `platform_signup_attempts` (CSDL nhà) và trần là câu `count(*)` trên chính bảng đó.
 *
 *  · IP KHÔNG lưu thô: `sha256(AUTH_SECRET : ip)` — đủ để đếm theo máy, không đủ để biết máy nào.
 *  · Ba trần: số tổ chức một IP dựng được trong một giờ (lượt tạo, kể cả hỏng); số lượt thử bất kỳ của một IP trong
 *    một giờ (kể cả mã mời sai — chặn dò); số tổ chức tự đăng ký mở (`open`) toàn nền tảng trong 24 giờ.
 *  · Người vận hành (`operator`) không bị trần — họ đã đăng nhập tổ chức nhà với `platform:operate`.
 */
import { createHash } from "node:crypto";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { env } from "@/lib/env";

export const SIGNUP_LIMITS = {
  /** Tổ chức (lượt tạo, kể cả hỏng) một IP dựng được mỗi giờ. */
  createsPerIpPerHour: 3,
  /** Lượt thử bất kỳ (kể cả mã mời sai) của một IP mỗi giờ. */
  attemptsPerIpPerHour: 20,
  /** Tổ chức tự đăng ký MỞ toàn nền tảng mỗi 24 giờ. */
  openCreatesPerDay: 50,
} as const;

export type AttemptMode = "invite" | "open" | "operator";
export type AttemptOutcome = "CREATED" | "FAILED" | "REJECTED" | "INVITE_REJECTED";

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${env.authSecret}:signup-ip:${ip || "unknown"}`).digest("hex");
}

export async function recordAttempt(input: { mode: AttemptMode; ipHash: string; orgCode?: string | null; outcome: AttemptOutcome; reason?: string | null }): Promise<void> {
  const pdb = await getPlatformDb();
  await pdb.insert(schema.platformSignupAttempts).values({ mode: input.mode, ipHash: input.ipHash, organizationCode: input.orgCode ?? null, outcome: input.outcome, reason: input.reason?.slice(0, 300) ?? null });
}

export type RateVerdict = { ok: true } | { ok: false; error: string };

/** Lượt thử này (của `mode`) có vượt trần không. `creating` = lượt TẠO (tính vào trần tạo), khác lượt kiểm từng bước. */
export async function checkSignupRate(mode: AttemptMode, ipHash: string, opts: { creating: boolean }): Promise<RateVerdict> {
  if (mode === "operator") return { ok: true };
  const pdb = await getPlatformDb();
  const t = schema.platformSignupAttempts;
  const hourAgo = sql`now() - interval '1 hour'`;
  const [any] = await pdb.select({ n: count() }).from(t).where(and(eq(t.ipHash, ipHash), gt(t.at, hourAgo), inArray(t.mode, ["invite", "open"])));
  if (Number(any?.n ?? 0) >= SIGNUP_LIMITS.attemptsPerIpPerHour) return { ok: false, error: "Quá nhiều lượt thử từ máy này trong một giờ — thử lại sau." };
  if (!opts.creating) return { ok: true };
  const [mine] = await pdb.select({ n: count() }).from(t).where(and(eq(t.ipHash, ipHash), gt(t.at, hourAgo), inArray(t.mode, ["invite", "open"]), inArray(t.outcome, ["CREATED", "FAILED"])));
  if (Number(mine?.n ?? 0) >= SIGNUP_LIMITS.createsPerIpPerHour) return { ok: false, error: "Máy này đã tạo đủ số tổ chức cho một giờ — thử lại sau." };
  if (mode === "open") {
    const [day] = await pdb.select({ n: count() }).from(t).where(and(eq(t.mode, "open"), gt(t.at, sql`now() - interval '24 hours'`), inArray(t.outcome, ["CREATED", "FAILED"])));
    if (Number(day?.n ?? 0) >= SIGNUP_LIMITS.openCreatesPerDay) return { ok: false, error: "Nền tảng đã nhận đủ số đăng ký cho hôm nay — thử lại ngày mai." };
  }
  return { ok: true };
}

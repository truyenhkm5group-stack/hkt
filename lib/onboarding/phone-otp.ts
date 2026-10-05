import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { displayPhone, normalizePhone } from "@/lib/auth/identity-shared";
import { openActiveConnection } from "@/lib/connectors/service";
import { env } from "@/lib/env";
import { zaloSendZnsTemplate, ZNS_TEMPLATE_ID_PATTERN, type ZaloDeps } from "@/lib/integrations/zalo/oa";
import { hashIp } from "@/lib/onboarding/rate";
import { effectiveSignupMode } from "@/lib/onboarding/signup-mode";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { ZALO_CONNECTOR, zaloAccessToken } from "@/lib/sales-chatbot/zalo";
import type { SignupActor } from "@/lib/onboarding/service";

/**
 * ═══════════ XÁC MINH SĐT KHI ĐĂNG KÝ — MÃ OTP QUA ZALO ZNS (docs/platform/phone-otp.md) ═══════════
 *
 * SĐT người đăng ký trở thành DANH TÍNH ĐĂNG NHẬP (`recordIdentity("PHONE")`). Không xác minh thì ai cũng chiếm được số của
 * người khác. Mã gửi bằng tin ZNS qua Zalo OA CỦA NỀN TẢNG — chính kết nối «zalo-oa» của TỔ CHỨC NHÀ (cùng lõi mã hoá + làm
 * mới token với kênh chat của chatbot), không có khoá thứ hai ở biến môi trường.
 *
 *  · MẶC ĐỊNH TẮT. Người vận hành bật ở `/platform` sau khi Zalo duyệt mẫu ZNS và OA nhà đã nối; bật mà OA nhà chưa nối ⇒ từ chối.
 *  · Bật rồi thì BẮT BUỘC (không lùi về «bỏ qua» khi Zalo hỏng): lỗi phía nền tảng ⇒ khách thấy «thử lại sau», người vận hành
 *    thấy lỗi gần nhất ở `/platform`; tắt công tắc là đường thoát.
 *  · Mỗi tin ZNS là tiền thật ⇒ ba trần đếm từ bảng (không từ bộ nhớ): theo SĐT, theo IP (băm), toàn nền tảng mỗi ngày; và
 *    chờ giữa hai lần gửi. Mã 6 số sống 5 phút, sai quá 5 lần ⇒ phải xin mã mới. Mã và IP chỉ lưu BĂM.
 *  · Người vận hành tạo hộ khách (`operator`) không cần mã.
 */

export const PHONE_OTP_SETTING_KEY = "platform.signup.phoneOtp";

export const PHONE_OTP_LIMITS = {
  codeTtlMinutes: 5,
  resendCooldownSeconds: 60,
  perPhonePerHour: 3,
  perIpPerHour: 5,
  platformPerDay: 300,
  maxAttempts: 5,
} as const;

export type PhoneOtpSetting = { enabled: boolean; templateId: string; param: string; updatedAt: string | null; updatedByEmail: string | null };
const PARAM_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

let cache: { at: number; value: PhoneOtpSetting } | null = null;
const CACHE_MS = 10_000;

export async function readPhoneOtpSetting(opts: { fresh?: boolean } = {}): Promise<PhoneOtpSetting> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PHONE_OTP_SETTING_KEY) });
  const v = (row?.value ?? {}) as Partial<PhoneOtpSetting>;
  const value: PhoneOtpSetting = {
    enabled: v.enabled === true,
    templateId: typeof v.templateId === "string" && ZNS_TEMPLATE_ID_PATTERN.test(v.templateId) ? v.templateId : "",
    param: typeof v.param === "string" && PARAM_PATTERN.test(v.param) ? v.param : "otp",
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedByEmail: row?.updatedByEmail ?? null,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Đăng ký nhanh có phải nhập mã không. Thiếu mẫu ZNS ⇒ coi như tắt (không bao giờ đòi một mã không gửi được). */
export async function phoneOtpRequired(): Promise<boolean> {
  const s = await readPhoneOtpSetting();
  return s.enabled && Boolean(s.templateId);
}

export async function homeZaloConnected(): Promise<boolean> {
  const home = await getHomeOrganization();
  return withOrganization(home.code, async () => (await openActiveConnection(ZALO_CONNECTOR)).ok);
}

export type PhoneOtpActor = { orgCode: string; userId: string; email: string };

/** Đổi cài đặt (lớp action đã kiểm `platform:operate`). Bật ⇒ phải có mẫu ZNS và OA nhà đang nối. */
export async function setPhoneOtpSetting(actor: PhoneOtpActor, input: unknown, deps: { zaloConnected?: () => Promise<boolean> } = {}): Promise<{ ok: true; setting: PhoneOtpSetting } | { error: string }> {
  const i = (input ?? {}) as Record<string, unknown>;
  const enabled = i.enabled === true;
  const templateId = typeof i.templateId === "string" ? i.templateId.trim() : "";
  const param = typeof i.param === "string" && i.param.trim() ? i.param.trim() : "otp";
  if (templateId && !ZNS_TEMPLATE_ID_PATTERN.test(templateId)) return { error: "Mã mẫu ZNS là dãy số (xem ở ZCA → ZNS → Mẫu tin)." };
  if (!PARAM_PATTERN.test(param)) return { error: "Tên tham số của mẫu chỉ gồm chữ thường, số, gạch dưới (thường là «otp»)." };
  if (enabled && !templateId) return { error: "Nhập mã mẫu ZNS đã được Zalo duyệt trước khi bật." };
  if (enabled && !(await (deps.zaloConnected ?? homeZaloConnected)())) return { error: "Tổ chức nhà chưa nối Zalo OA (Kết nối dữ liệu → Zalo OA) — mã OTP gửi qua OA đó." };
  const pdb = await getPlatformDb();
  const now = new Date();
  const value = { enabled, templateId, param };
  const by = `${actor.orgCode}:${actor.userId}`;
  await pdb
    .insert(schema.platformSettings)
    .values({ key: PHONE_OTP_SETTING_KEY, value, updatedAt: now, updatedBy: by, updatedByEmail: actor.email })
    .onConflictDoUpdate({ target: schema.platformSettings.key, set: { value, updatedAt: now, updatedBy: by, updatedByEmail: actor.email } });
  cache = null;
  return { ok: true, setting: await readPhoneOtpSetting({ fresh: true }) };
}

export function otpHash(phone: string, code: string): string {
  return createHash("sha256").update(`${env.authSecret}:signup-otp:${phone}:${code}`).digest("hex");
}

export type OtpSender = (input: { phone: string; code: string; templateId: string; param: string; trackingId: string }) => Promise<{ ok: true } | { ok: false; error: string; phoneSide: boolean }>;

/** Gửi thật: token của kết nối «zalo-oa» ở TỔ CHỨC NHÀ (làm mới + lưu cặp mới như kênh chat) ⇒ ZNS. */
export function znsSender(deps: ZaloDeps = {}): OtpSender {
  return async (input) => {
    const home = await getHomeOrganization();
    return withOrganization(home.code, async () => {
      const tok = await zaloAccessToken(deps);
      if (!tok.ok) return { ok: false, error: tok.error, phoneSide: false };
      const r = await zaloSendZnsTemplate({ accessToken: tok.token, phone: input.phone, templateId: input.templateId, data: { [input.param]: input.code }, trackingId: input.trackingId }, deps);
      return r.ok ? { ok: true } : r;
    });
  };
}

export type SendOtpResult = { ok: true; sentTo: string; resendAfterSeconds: number; expiresInMinutes: number } | { error: string; retryAfterSeconds?: number };

export async function sendSignupOtp(rawPhone: unknown, who: SignupActor, deps: { send?: OtpSender; now?: Date } = {}): Promise<SendOtpResult> {
  if (who.kind === "operator") return { error: "Người vận hành tạo hộ khách không cần mã xác minh." };
  if ((await effectiveSignupMode()) === "off") return { error: "Chưa mở đăng ký tổ chức mới." };
  const setting = await readPhoneOtpSetting();
  if (!setting.enabled || !setting.templateId) return { error: "Đăng ký hiện không cần mã xác minh." };
  const phone = normalizePhone(rawPhone);
  if (!phone) return { error: "Số điện thoại di động không hợp lệ (vd 0912 345 678)." };
  const now = deps.now ?? new Date();
  const ipHash = hashIp(who.ip);
  const pdb = await getPlatformDb();
  const t = schema.platformPhoneOtps;
  const hourAgo = new Date(now.getTime() - 3600_000);

  const [last] = await pdb.select({ at: t.createdAt }).from(t).where(eq(t.phone, phone)).orderBy(desc(t.createdAt)).limit(1);
  const since = last ? (now.getTime() - last.at.getTime()) / 1000 : Infinity;
  if (since < PHONE_OTP_LIMITS.resendCooldownSeconds) {
    const wait = Math.ceil(PHONE_OTP_LIMITS.resendCooldownSeconds - since);
    return { error: `Mã vừa được gửi — đợi ${wait} giây rồi gửi lại.`, retryAfterSeconds: wait };
  }
  const [byPhone] = await pdb.select({ n: count() }).from(t).where(and(eq(t.phone, phone), gt(t.createdAt, hourAgo)));
  if (Number(byPhone?.n ?? 0) >= PHONE_OTP_LIMITS.perPhonePerHour) return { error: "Số này đã nhận đủ số mã cho một giờ — thử lại sau." };
  const [byIp] = await pdb.select({ n: count() }).from(t).where(and(eq(t.ipHash, ipHash), gt(t.createdAt, hourAgo)));
  if (Number(byIp?.n ?? 0) >= PHONE_OTP_LIMITS.perIpPerHour) return { error: "Máy này đã xin quá nhiều mã trong một giờ — thử lại sau." };
  const [day] = await pdb.select({ n: count() }).from(t).where(gt(t.createdAt, new Date(now.getTime() - 86_400_000)));
  if (Number(day?.n ?? 0) >= PHONE_OTP_LIMITS.platformPerDay) return { error: "Hệ thống đã gửi đủ số mã cho hôm nay — thử lại ngày mai hoặc liên hệ hỗ trợ." };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomUUID();
  const sent = await (deps.send ?? znsSender())({ phone, code, templateId: setting.templateId, param: setting.param, trackingId: `otp-${id}` });
  await pdb.insert(t).values({
    id,
    phone,
    codeHash: otpHash(phone, code),
    ipHash,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PHONE_OTP_LIMITS.codeTtlMinutes * 60_000),
    status: sent.ok ? "SENT" : "FAILED",
    error: sent.ok ? null : sent.error.slice(0, 300),
  });
  if (!sent.ok) {
    if (sent.phoneSide) return { error: "Zalo không gửi được tới số này — số có dùng Zalo không? Kiểm tra lại số hoặc liên hệ hỗ trợ." };
    console.error(`[phone-otp] gửi ZNS hỏng: ${sent.error}`);
    return { error: "Chưa gửi được mã xác minh — thử lại sau ít phút." };
  }
  return { ok: true, sentTo: displayPhone(phone), resendAfterSeconds: PHONE_OTP_LIMITS.resendCooldownSeconds, expiresInMinutes: PHONE_OTP_LIMITS.codeTtlMinutes };
}

/** Gửi THỬ (người vận hành, trước khi bật): mã ngẫu nhiên tới SĐT nhập tay, không ghi bảng mã, không mở đường đăng ký. */
export async function sendTestOtp(input: { phone: unknown; templateId: unknown; param: unknown }, deps: { send?: OtpSender } = {}): Promise<{ ok: true; message: string } | { error: string }> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { error: "Số điện thoại di động không hợp lệ." };
  const templateId = typeof input.templateId === "string" ? input.templateId.trim() : "";
  if (!ZNS_TEMPLATE_ID_PATTERN.test(templateId)) return { error: "Nhập mã mẫu ZNS (dãy số)." };
  const param = typeof input.param === "string" && PARAM_PATTERN.test(input.param.trim()) ? input.param.trim() : "otp";
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const r = await (deps.send ?? znsSender())({ phone, code, templateId, param, trackingId: `otp-test-${randomUUID()}` });
  return r.ok ? { ok: true, message: `Đã gửi mã thử tới ${displayPhone(phone)} — mở Zalo trên máy đó để xem.` } : { error: r.error };
}

export type VerifyOtpResult = { ok: true; id: string } | { error: string };

/**
 * Mã có đúng cho SĐT này không — đối chiếu với mã MỚI NHẤT đã gửi được, còn hạn, chưa dùng. Sai ⇒ tăng bộ đếm (một câu
 * nguyên tử); sai quá trần ⇒ mã đó chết. Đúng ⇒ CHƯA tiêu: tiêu ở `consumeSignupOtp` sau khi tạo cửa hàng thành công, để một
 * lần tạo hỏng (trùng email…) không bắt khách xin mã lại.
 */
export async function verifySignupOtp(phone: string, rawCode: unknown, now: Date = new Date()): Promise<VerifyOtpResult> {
  const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
  const pdb = await getPlatformDb();
  const t = schema.platformPhoneOtps;
  const [row] = await pdb
    .select({ id: t.id, codeHash: t.codeHash, attempts: t.attempts })
    .from(t)
    .where(and(eq(t.phone, phone), eq(t.status, "SENT"), isNull(t.consumedAt), gt(t.expiresAt, now)))
    .orderBy(desc(t.createdAt))
    .limit(1);
  if (!row) return { error: "Bấm «Gửi mã qua Zalo» để nhận mã xác minh (mã cũ đã hết hạn hoặc đã dùng)." };
  if (row.attempts >= PHONE_OTP_LIMITS.maxAttempts) return { error: "Nhập sai quá nhiều lần — gửi mã mới." };
  if (code.length !== 6) return { error: "Nhập đủ 6 số của mã xác minh." };
  const a = Buffer.from(otpHash(phone, code), "hex");
  const b = Buffer.from(row.codeHash, "hex");
  if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, id: row.id };
  const [after] = await pdb.update(t).set({ attempts: sql`${t.attempts} + 1` }).where(eq(t.id, row.id)).returning({ attempts: t.attempts });
  const left = PHONE_OTP_LIMITS.maxAttempts - (after?.attempts ?? PHONE_OTP_LIMITS.maxAttempts);
  return { error: left > 0 ? `Mã không đúng — còn ${left} lần thử.` : "Nhập sai quá nhiều lần — gửi mã mới." };
}

export async function consumeSignupOtp(id: string, now: Date = new Date()): Promise<void> {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformPhoneOtps).set({ consumedAt: now }).where(and(eq(schema.platformPhoneOtps.id, id), isNull(schema.platformPhoneOtps.consumedAt)));
}

/** Tóm tắt cho `/platform`: 24 giờ gần nhất + lỗi gần nhất. */
export async function phoneOtpSummary(): Promise<{ sent24h: number; failed24h: number; lastError: { at: string; error: string } | null }> {
  const pdb = await getPlatformDb();
  const t = schema.platformPhoneOtps;
  const dayAgo = new Date(Date.now() - 86_400_000);
  const rows = await pdb.select({ status: t.status, n: count() }).from(t).where(gt(t.createdAt, dayAgo)).groupBy(t.status);
  const [err] = await pdb.select({ at: t.createdAt, error: t.error }).from(t).where(eq(t.status, "FAILED")).orderBy(desc(t.createdAt)).limit(1);
  return {
    sent24h: Number(rows.find((r) => r.status === "SENT")?.n ?? 0),
    failed24h: Number(rows.find((r) => r.status === "FAILED")?.n ?? 0),
    lastError: err ? { at: err.at.toISOString(), error: err.error ?? "" } : null,
  };
}

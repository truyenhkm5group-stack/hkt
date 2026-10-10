/**
 * ═══════════ «QUÊN MẬT KHẨU» TỰ PHỤC VỤ — CHỈ MÁY CHỦ (PUB-07 · docs/platform/password-reset.md §Tự phục vụ) ═══════════
 *
 * Trước bản này `/login` là ngõ cụt: chỉ quản trị tổ chức hoặc người vận hành phát được liên kết đặt lại, và người quên mật khẩu
 * không có nút nào để bấm. Kho chưa có kênh gửi thư (dịch vụ ngoài mới cần chủ nền tảng duyệt — AGENTS §7), nên có HAI nhánh, đều
 * đi qua lõi CÓ SẴN:
 *
 *  · OTP ZALO BẬT (`/platform`, mặc định TẮT) và tài khoản có SĐT ⇒ gửi mã qua ĐÚNG lõi đăng ký (`issuePhoneOtp` — cùng chờ giữa hai
 *    lần gửi, cùng ba trần đếm từ bảng, mã chỉ lưu băm) ⇒ nhập đúng mã (`verifySignupOtp`) ⇒ phát phiếu qua ĐÚNG lõi đặt lại
 *    (`issueSelfResetAfterPhoneOtp` — thu hồi phiếu cũ, dùng một lần, chỉ băm trong CSDL) ⇒ chuyển tới `/reset/<tổ chức>/<mã>`.
 *    Không có đường ghi mật khẩu thứ hai.
 *  · CÒN LẠI (OTP tắt · tài khoản không có SĐT · nhiều SĐT · Zalo không gửi được · người dùng bấm «Không nhận được mã») ⇒ ghi MỘT
 *    YÊU CẦU HỖ TRỢ: chuông `notifications` của CHÍNH tổ chức (mở /settings/users — nơi quản trị bấm «Gửi liên kết đặt lại») + nhật
 *    ký nền tảng `PASSWORD_RESET_REQUEST` (hiện ở «Nhật ký» của /platform/customers/<mã> — lối ra khi người quên là chính quản trị).
 *    Khoá chống trùng của chuông = (tài khoản, ngày giờ VN): tối đa một yêu cầu mỗi tài khoản mỗi ngày, bấm bao nhiêu lần cũng vậy.
 *
 * ─── CHỐNG DÒ TÀI KHOẢN ───
 *  · Câu trả lời bước 1 chỉ phụ thuộc CÔNG TẮC OTP (công khai) và nút người dùng bấm — không bao giờ vào việc tài khoản có tồn tại,
 *    có SĐT, hay đã gửi được mã. Lỗi của lõi gửi mã (chờ, chạm trần, Zalo từ chối) KHÔNG đi ra ngoài: nó chỉ chuyển nhánh sang yêu cầu
 *    hỗ trợ.
 *  · Bước 2 gộp mọi lý do (sai mã · hết hạn · quá số lần · không có tài khoản) thành MỘT câu.
 *  · Bộ chặn dò dùng chung `lib/auth/login-throttle.ts` với khoá riêng của luồng (`pair:forgot:` / `ip:forgot:`): MỖI lượt gửi bước 1
 *    và mỗi mã sai đều đếm — 5 / (định danh, máy) và 30 / máy mỗi 15 phút, kể cả khi không có tài khoản nào khớp (nếu chỉ đếm khi có
 *    tài khoản thì chính bộ đếm là máy dò).
 *  · Sổ lỗi đăng nhập (`platform_auth_failures`, danh sách lý do ĐÓNG có CHECK ở CSDL) ghi dưới luồng `RESET_LINK` với lý do có sẵn:
 *    không có tài khoản / tổ chức · bị chặn dò. Mã OTP sai KHÔNG có lý do riêng trong danh sách đóng (thêm là một migration) — nó vẫn
 *    bị đếm ở bộ chặn dò và ở bộ đếm sai của chính mã.
 *
 * Không mã, không phiếu, không SĐT đầy đủ nào được in ra log.
 */
import { createHash } from "node:crypto";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { parseLoginIdentifier } from "@/lib/auth/identity-shared";
import { findUserByIdentifier, loginCandidates, strongestLoginFailure, type LoginFailureReason } from "@/lib/auth/login";
import { clearLoginFailures, loginAllowed, loginLockOf, recordLoginFailure } from "@/lib/auth/login-throttle";
import { env } from "@/lib/env";
import { vnDateKey } from "@/lib/format";
import { consumeSignupOtp, issuePhoneOtp, readPhoneOtpSetting, verifySignupOtp, type OtpSender } from "@/lib/onboarding/phone-otp";
import { recordAuthFailure } from "@/lib/platform/auth-failures";
import { platformAudit } from "@/lib/platform/audit";
import { OrgContextError, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { issueSelfResetAfterPhoneOtp } from "@/lib/users/password-reset";
import { FORGOT_BAD_IDENTIFIER, FORGOT_CODE_INVALID, FORGOT_OTP_OFF, FORGOT_SENT_OTP, FORGOT_SENT_SUPPORT, FORGOT_THROTTLED } from "@/lib/users/forgot-password-shared";

/** Người gửi yêu cầu hỗ trợ CHƯA xác minh danh tính: nhật ký tổ chức ghi `userId = null` + nhãn này ⇒ tác nhân CHƯA BIẾT (không phải máy, không phải người dùng). */
export const FORGOT_REQUESTER_LABEL = "trang Quên mật khẩu (người gửi chưa xác minh)";

/** Một lượt bước 1 ghi yêu cầu hỗ trợ cho tối đa ngần này tài khoản (email trùng ở nhiều cửa hàng). */
const MAX_SUPPORT_TARGETS = 5;

export type ForgotContext = { ip: string; /** Tổ chức gắn cứng theo tên miền con (`hostOrganization`) — có thì bỏ qua ô mã cửa hàng. */ hostOrgCode: string | null };
export type ForgotDeps = { send?: OtpSender; now?: Date };

type Account = { orgCode: string; orgName: string; userId: string; email: string; phone: string | null };
type SupportWhy = "OTP_OFF" | "NO_SINGLE_PHONE" | "OTP_UNAVAILABLE" | "USER_ASKED";

/** Hai khoá chặn dò của luồng này — tách miền khỏi màn đăng nhập (`pair:` / `ip:` trần) và liên kết đặt lại (`ip:reset:`). */
export function forgotThrottleKeys(identifier: string, ip: string, orgKey: string): string[] {
  const h = createHash("sha256").update(`${env.authSecret}:forgot-ip:${ip || "unknown"}`).digest("hex").slice(0, 32);
  return [`pair:forgot:${orgKey}:${identifier}|${h}`, `ip:forgot:${h}`];
}

function orgHintOf(raw: unknown, ctx: ForgotContext): string | null {
  if (ctx.hostOrgCode) return ctx.hostOrgCode;
  const typed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return typed || null;
}

/**
 * Tài khoản ĐANG HOẠT ĐỘNG khớp định danh — CÙNG luật với màn đăng nhập: có mã cửa hàng (gõ tay / tên miền con) ⇒ đúng tổ chức đó;
 * không ⇒ các tổ chức mà chỉ mục danh tính nói có định danh này + tổ chức nhà (`loginCandidates`), tra từng nơi bằng
 * `findUserByIdentifier` trong `withOrganization`. Kèm lý do mạnh nhất khi không khớp đâu (chỉ cho sổ lỗi).
 */
async function resolveAccounts(identifier: string, orgHint: string | null): Promise<{ accounts: Account[]; miss: { reason: LoginFailureReason; orgCode: string | null } }> {
  const candidates = orgHint ? [orgHint] : await loginCandidates(identifier);
  const accounts: Account[] = [];
  const fails: { reason: LoginFailureReason; orgCode: string | null }[] = [];
  for (const code of candidates) {
    const org = await findOrganization(code);
    if (!org) {
      fails.push({ reason: "ORG_NOT_FOUND", orgCode: null });
      continue;
    }
    if (org.status !== "ACTIVE") {
      fails.push({ reason: "ORG_INACTIVE", orgCode: org.code });
      continue;
    }
    try {
      const user = await withOrganization(org.code, () => findUserByIdentifier(identifier));
      if (!user) fails.push({ reason: "NO_IDENTITY", orgCode: org.code });
      else if (!user.active) fails.push({ reason: "USER_INACTIVE", orgCode: org.code });
      else accounts.push({ orgCode: org.code, orgName: org.name, userId: user.id, email: user.email, phone: user.phone ?? null });
    } catch (error) {
      if (!(error instanceof OrgContextError)) throw error;
      fails.push({ reason: "ORG_INACTIVE", orgCode: org.code });
    }
  }
  return { accounts, miss: strongestLoginFailure(fails, orgHint ? "" : (candidates[candidates.length - 1] ?? "")) };
}

/** SĐT duy nhất của các tài khoản khớp — hai SĐT khác nhau (email trùng ở hai cửa hàng) ⇒ không đoán số nào, đi yêu cầu hỗ trợ. */
function singlePhone(accounts: readonly Account[]): string | null {
  const phones = new Set(accounts.map((a) => a.phone).filter((p): p is string => Boolean(p)));
  return phones.size === 1 ? [...phones][0] : null;
}

const SUPPORT_WHY_TEXT: Record<SupportWhy, string> = {
  OTP_OFF: "đặt lại bằng mã Zalo đang tắt",
  NO_SINGLE_PHONE: "tài khoản không có (hoặc có nhiều) số điện thoại để nhận mã",
  OTP_UNAVAILABLE: "không gửi được mã Zalo lúc này",
  USER_ASKED: "người dùng bấm «Không nhận được mã»",
};

/**
 * Ghi MỘT yêu cầu hỗ trợ cho một tài khoản: chuông của tổ chức (khoá chống trùng theo tài khoản + ngày VN) ⇒ chỉ khi chuông MỚI
 * thì ghi nhật ký tổ chức + nhật ký nền tảng. KHÔNG phát phiếu nào. Không ném: một lượt ghi hỏng mà bay lên là trang 500 chỉ
 * với tài khoản CÓ THẬT — chính nó là máy dò.
 */
async function fileSupportRequest(a: Account, why: SupportWhy, now: Date): Promise<boolean> {
  const reason = `Yêu cầu từ trang «Quên mật khẩu» — ${SUPPORT_WHY_TEXT[why]}. Người gửi CHƯA xác minh danh tính.`;
  try {
    const fresh = await withOrganization(a.orgCode, async () => {
      const db = await getDb();
      const rows = await db
        .insert(schema.notifications)
        .values({
          kind: "SYSTEM",
          severity: "warning",
          title: `Yêu cầu đặt lại mật khẩu — ${a.email}`,
          body: `Có người ở trang «Quên mật khẩu» xin đặt lại mật khẩu cho tài khoản ${a.email} (${SUPPORT_WHY_TEXT[why]}). Nếu đúng là người của cửa hàng: vào Người dùng → menu ⋯ của tài khoản → «Gửi liên kết đặt lại», rồi gửi liên kết cho họ qua Zalo / Messenger. Không phải ⇒ bỏ qua, mật khẩu không đổi.`,
          href: "/settings/users",
          entityType: "USER",
          entityId: a.userId,
          dedupeKey: `password-help:${a.userId}:${vnDateKey(now)}`,
          occurredAt: now,
        })
        .onConflictDoNothing({ target: schema.notifications.dedupeKey })
        .returning({ id: schema.notifications.id });
      if (rows.length === 0) return false;
      await audit({ userId: null, userEmail: FORGOT_REQUESTER_LABEL, action: "PASSWORD_RESET_REQUEST", entity: "USER", entityId: a.userId, after: { email: a.email, why }, reason });
      return true;
    });
    if (fresh) await platformAudit({ action: "PASSWORD_RESET_REQUEST", targetOrgCode: a.orgCode, subject: `user:${a.email}`, after: { why, inbox: "/settings/users" }, reason, source: "UI", actor: null });
    return fresh;
  } catch (error) {
    console.error(`[forgot-password] không ghi được yêu cầu hỗ trợ (${a.orgCode}): ${error instanceof Error ? error.message.slice(0, 200) : "lỗi lạ"}`);
    return false;
  }
}

export type ForgotRequestResult = { ok: true; otp: boolean; message: string } | { error: string };

/**
 * BƯỚC 1 — người dùng nhập email / SĐT (+ mã cửa hàng). `channel: "SUPPORT"` = bấm «Không nhận được mã / Gửi yêu cầu hỗ trợ».
 * `otp` = form hiện ô nhập mã — chỉ theo công tắc + nút bấm, không theo tài khoản.
 */
export async function requestPasswordHelp(raw: { identifier?: unknown; orgCode?: unknown; channel?: unknown }, ctx: ForgotContext, deps: ForgotDeps = {}): Promise<ForgotRequestResult> {
  const id = parseLoginIdentifier(raw.identifier);
  if (!id) return { error: FORGOT_BAD_IDENTIFIER };
  const orgHint = orgHintOf(raw.orgCode, ctx);
  const keys = forgotThrottleKeys(id.value, ctx.ip, orgHint ?? "*");
  if (!loginAllowed(keys).ok) {
    await recordAuthFailure({ flow: "RESET_LINK", reason: "THROTTLED", orgCode: orgHint, identifier: id.value, ip: ctx.ip, lock: loginLockOf(keys) });
    return { error: FORGOT_THROTTLED };
  }
  // Mọi lượt gửi đều đếm — có tài khoản hay không (xem đầu tệp).
  recordLoginFailure(keys);
  const now = deps.now ?? new Date();
  const setting = await readPhoneOtpSetting();
  const otpOn = setting.enabled && Boolean(setting.templateId);
  const userAsked = raw.channel === "SUPPORT";
  const answer: ForgotRequestResult = otpOn && !userAsked ? { ok: true, otp: true, message: FORGOT_SENT_OTP } : { ok: true, otp: false, message: FORGOT_SENT_SUPPORT };

  const { accounts, miss } = await resolveAccounts(id.value, orgHint);
  if (accounts.length === 0) {
    await recordAuthFailure({ flow: "RESET_LINK", reason: miss.reason, orgCode: miss.orgCode, identifier: id.value, ip: ctx.ip });
    return answer;
  }

  let why: SupportWhy = userAsked ? "USER_ASKED" : "OTP_OFF";
  if (otpOn && !userAsked) {
    const phone = singlePhone(accounts);
    if (!phone) why = "NO_SINGLE_PHONE";
    else {
      const sent = await issuePhoneOtp(phone, ctx.ip, setting, { send: deps.send, now });
      // Đã gửi, hoặc vừa gửi chưa tới 60 giây (mã trước vẫn dùng được) ⇒ xong; mọi lý do khác ⇒ người thật cần một đường ra.
      if ("ok" in sent || sent.refusal === "COOLDOWN") return answer;
      console.warn(`[forgot-password] không gửi được mã (${sent.refusal}) — chuyển thành yêu cầu hỗ trợ`);
      why = "OTP_UNAVAILABLE";
    }
  }
  for (const a of accounts.slice(0, MAX_SUPPORT_TARGETS)) await fileSupportRequest(a, why, now);
  return answer;
}

export type ForgotVerifyResult = { ok: true; resetPath: string } | { choose: { code: string; name: string }[] } | { error: string };

/**
 * BƯỚC 2 — nhập mã. Đúng mã của SĐT thuộc tài khoản ⇒ phát phiếu đặt lại (lõi `password-reset`) rồi TIÊU mã; trả đường dẫn
 * `/reset/<tổ chức>/<phiếu>` cho action chuyển hướng. Một SĐT có tài khoản ở NHIỀU cửa hàng ⇒ hỏi chọn cửa hàng (danh sách chỉ hiện
 * SAU khi mã đã đúng — người không giữ SĐT không thấy gì); gửi lại kèm `pick` với CÙNG mã (mã chưa bị tiêu, lượt đúng không đếm sai).
 */
export async function verifyPasswordOtp(raw: { identifier?: unknown; orgCode?: unknown; code?: unknown; pick?: unknown }, ctx: ForgotContext, deps: { now?: Date } = {}): Promise<ForgotVerifyResult> {
  const id = parseLoginIdentifier(raw.identifier);
  if (!id) return { error: FORGOT_BAD_IDENTIFIER };
  const orgHint = orgHintOf(raw.orgCode, ctx);
  const keys = forgotThrottleKeys(id.value, ctx.ip, orgHint ?? "*");
  if (!loginAllowed(keys).ok) {
    await recordAuthFailure({ flow: "RESET_LINK", reason: "THROTTLED", orgCode: orgHint, identifier: id.value, ip: ctx.ip, lock: loginLockOf(keys) });
    return { error: FORGOT_THROTTLED };
  }
  const setting = await readPhoneOtpSetting();
  if (!setting.enabled || !setting.templateId) return { error: FORGOT_OTP_OFF };
  const invalid = (): ForgotVerifyResult => {
    recordLoginFailure(keys);
    return { error: FORGOT_CODE_INVALID };
  };
  const { accounts } = await resolveAccounts(id.value, orgHint);
  const phone = singlePhone(accounts);
  if (!phone) return invalid();
  const now = deps.now ?? new Date();
  const v = await verifySignupOtp(phone, raw.code, now);
  if ("error" in v) return invalid();
  const owners = accounts.filter((a) => a.phone === phone);
  const pick = typeof raw.pick === "string" ? raw.pick.trim().toLowerCase() : "";
  const chosen = owners.length === 1 ? owners[0] : owners.find((a) => a.orgCode === pick);
  if (!chosen) return { choose: owners.map((a) => ({ code: a.orgCode, name: a.orgName })) };
  const issued = await issueSelfResetAfterPhoneOtp(chosen.orgCode, chosen.userId);
  if ("error" in issued) return invalid();
  await consumeSignupOtp(v.id, now);
  clearLoginFailures(keys);
  return { ok: true, resetPath: issued.path };
}

/**
 * ═══════════ CHẾ ĐỘ ĐĂNG KÝ `/start` — ĐỌC VÀ GHI DUY NHẤT (docs/platform/launch-gates.md mục B) — CHỈ MÁY CHỦ ═══════════
 *
 * Hiệu lực = min(trần môi trường `PLATFORM_SIGNUP_MODE`, cài đặt `platform_settings['platform.signup.mode']`). Phép tính
 * thuần nằm ở `lib/onboarding/shared.ts` (`signupCeiling`, `narrowerSignupMode`); tệp này chỉ đọc hai nguồn và ghi một.
 *
 * ─── ĐỆM NGẮN, CÓ TRẦN ───
 * Cài đặt đọc ở mỗi lượt dựng `/start` và mỗi bước của luồng tạo tổ chức, nên đệm `SIGNUP_MODE_CACHE_MS` (≤ 30 giây —
 * bài kiểm khoá con số này). Lượt ghi trong CÙNG tiến trình xoá đệm ngay ⇒ người vận hành bấm là có hiệu lực tức thì;
 * tiến trình khác trễ tối đa bằng đệm. Trần môi trường KHÔNG đệm: đọc `process.env` mỗi lần.
 *
 * ─── HỎNG VỀ PHÍA ĐÓNG ───
 * Thiếu bảng (migration chưa áp), thiếu dòng, giá trị lạ, lỗi CSDL ⇒ cài đặt đọc là `off`. Lỗi không được đệm, để lượt
 * sau thử lại. Không có nhánh nào lỗi mà ra `invite` / `open`.
 *
 * ─── GHI ───
 * Chỉ người vận hành nền tảng (`platformOperatorDenial`: tổ chức nhà + `platform:operate`), bắt buộc lý do, không vượt
 * trần đang có, và MỌI lượt đổi ghi `platform_audit_log` (`SIGNUP_MODE_SET`) trước khi coi là xong.
 */
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { platformAudit } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import {
  DEFAULT_SIGNUP_SETTING,
  exceedsSignupCeiling,
  narrowerSignupMode,
  SIGNUP_MODE_LABEL,
  SIGNUP_MODES,
  signupCeiling,
  type SignupCeiling,
  type SignupMode,
} from "@/lib/onboarding/shared";

export const SIGNUP_MODE_SETTING_KEY = "platform.signup.mode";
export const SIGNUP_MODE_ENV = "PLATFORM_SIGNUP_MODE";
/** Đệm cài đặt trong tiến trình. Bài kiểm khoá ≤ 30 giây: bật / tắt phải có hiệu lực gần như ngay. */
export const SIGNUP_MODE_CACHE_MS = 10_000;

export type SignupSetting = { mode: SignupMode; stored: boolean; updatedAt: string | null; updatedByEmail: string | null };
export type SignupModeState = { ceiling: SignupCeiling; setting: SignupSetting; effective: SignupMode; cacheSeconds: number };

type Entry = { at: number; value: SignupSetting };
const holder = globalThis as unknown as { __erpSignupSetting?: { entry: Entry | null } };
if (!holder.__erpSignupSetting) holder.__erpSignupSetting = { entry: null };
const cache = holder.__erpSignupSetting;

const DEFAULT_SETTING: SignupSetting = { mode: DEFAULT_SIGNUP_SETTING, stored: false, updatedAt: null, updatedByEmail: null };

/** Xoá đệm (lượt ghi gọi; bài kiểm gọi sau khi ghi thẳng vào bảng). */
export function invalidateSignupSetting() {
  cache.entry = null;
}

function modeOfValue(value: unknown): SignupMode | null {
  return typeof value === "string" && (SIGNUP_MODES as readonly string[]).includes(value) ? (value as SignupMode) : null;
}

async function loadSetting(): Promise<SignupSetting> {
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  if (!row) return DEFAULT_SETTING;
  const mode = modeOfValue(row.value);
  // Giá trị lạ (CHECK của CSDL lẽ ra đã chặn) ⇒ đóng, và nói là "có dòng" để màn hình không bảo "chưa đặt".
  return { mode: mode ?? "off", stored: true, updatedAt: row.updatedAt.toISOString(), updatedByEmail: row.updatedByEmail ?? null };
}

/** Cài đặt ở control plane. `now` chỉ để bài kiểm đi qua hạn đệm mà không phải ngủ. */
export async function readSignupSetting(opts: { now?: number; fresh?: boolean } = {}): Promise<SignupSetting> {
  const now = opts.now ?? Date.now();
  const hit = cache.entry;
  if (!opts.fresh && hit && now - hit.at >= 0 && now - hit.at < SIGNUP_MODE_CACHE_MS) return hit.value;
  let value: SignupSetting;
  try {
    value = await loadSetting();
  } catch {
    // Thiếu bảng / CSDL hỏng: ĐÓNG, và không đệm — lượt sau đọc lại.
    return DEFAULT_SETTING;
  }
  cache.entry = { at: now, value };
  return value;
}

/** Trần + cài đặt + hiệu lực. `env` chỉ để bài kiểm đưa vào môi trường giả; mặc định đọc `process.env` mỗi lần. */
export async function signupModeState(opts: { now?: number; env?: (name: string) => string | undefined } = {}): Promise<SignupModeState> {
  const readEnv = opts.env ?? ((n: string) => process.env[n]);
  const ceiling = signupCeiling(readEnv(SIGNUP_MODE_ENV));
  const setting = await readSignupSetting({ now: opts.now });
  return { ceiling, setting, effective: narrowerSignupMode(ceiling.mode, setting.mode), cacheSeconds: Math.round(SIGNUP_MODE_CACHE_MS / 1000) };
}

/** Chế độ ĐANG CÓ HIỆU LỰC của `/start`. */
export async function effectiveSignupMode(): Promise<SignupMode> {
  return (await signupModeState()).effective;
}

// ═══ GHI — chỉ người vận hành nền tảng ═══

export type SetSignupModeResult = { ok: true; changed: boolean; state: SignupModeState } | { error: string };

export async function setSignupSetting(user: SessionUser, input: unknown): Promise<SetSignupModeResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { mode?: unknown; reason?: unknown };
  const mode = modeOfValue(typeof raw.mode === "string" ? raw.mode.trim().toLowerCase() : raw.mode);
  if (!mode) return { error: "Chế độ chỉ nhận off · invite · open." };
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason.length < 5) return { error: "Ghi lý do (ít nhất 5 ký tự) — nó vào nhật ký nền tảng." };
  if (reason.length > 500) return { error: "Lý do dài quá 500 ký tự." };

  const ceiling = signupCeiling(process.env[SIGNUP_MODE_ENV]);
  if (exceedsSignupCeiling(mode, ceiling.mode)) {
    return {
      error:
        ceiling.mode === "off"
          ? `Máy chủ đang TẮT CỨNG đăng ký (${SIGNUP_MODE_ENV}=${ceiling.source === "ENV_INVALID" ? "giá trị lạ" : "off"}) — cài đặt ở đây không mở được. Gỡ trần ở biến môi trường rồi khởi động lại.`
          : `Trần của máy chủ là «${SIGNUP_MODE_LABEL[ceiling.mode]}» — không đặt được «${SIGNUP_MODE_LABEL[mode]}». Mở hẳn cần chủ nền tảng khai ${SIGNUP_MODE_ENV}=open.`,
    };
  }

  const before = await readSignupSetting({ fresh: true });
  if (before.stored && before.mode === mode) return { ok: true, changed: false, state: await signupModeState() };

  const home = await getHomeOrganization();
  const actor = { orgCode: user.organization!.code, userId: user.id, email: user.email };
  const pdb = await getPlatformDb();
  const now = new Date();
  await pdb
    .insert(schema.platformSettings)
    .values({ key: SIGNUP_MODE_SETTING_KEY, value: mode, updatedAt: now, updatedBy: `${actor.orgCode}:${actor.userId}`, updatedByEmail: actor.email })
    .onConflictDoUpdate({ target: schema.platformSettings.key, set: { value: mode, updatedAt: now, updatedBy: `${actor.orgCode}:${actor.userId}`, updatedByEmail: actor.email } });
  invalidateSignupSetting();
  try {
    await platformAudit({
      action: "SIGNUP_MODE_SET",
      targetOrgCode: home.code,
      subject: SIGNUP_MODE_SETTING_KEY,
      before: { setting: before.stored ? before.mode : null, effective: narrowerSignupMode(ceiling.mode, before.mode) },
      after: { setting: mode, effective: narrowerSignupMode(ceiling.mode, mode), ceiling: ceiling.mode, ceilingSource: ceiling.source },
      reason,
      source: "UI",
      actor,
    });
  } catch {
    // Một lượt mở cửa KHÔNG có vết là thứ không được tồn tại: hoàn lại đúng trạng thái trước rồi báo lỗi.
    if (before.stored) await pdb.update(schema.platformSettings).set({ value: before.mode }).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
    else await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
    invalidateSignupSetting();
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại cài đặt cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true, state: await signupModeState() };
}

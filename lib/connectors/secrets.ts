import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { SecretsSelfTestReport } from "@/lib/connectors/types";

/**
 * ═══════════ BÍ MẬT CỦA KẾT NỐI THEO TỔ CHỨC — AES-256-GCM ═══════════
 *
 * Hợp đồng: docs/platform/phase-9-contracts.md §2 · builder-roadmap X6. CHỈ MÁY CHỦ — không tệp
 * `"use client"` nào, và không tệp nào ngoài `lib/connectors/service.ts` được gọi `openSecrets`
 * (`tests/connectors.test.ts` quét).
 *
 * ─── KHOÁ ───
 *
 * Khoá mã hoá dẫn xuất HKDF-SHA256 từ `PLATFORM_SECRETS_KEY` (≥ 32 ký tự). THIẾU / NGẮN ⇒ tính năng
 * lưu bí mật TẮT và câu lỗi nói rõ — KHÔNG lùi về `AUTH_SECRET` (khoá ký phiên: lộ một là lộ cả hai),
 * KHÔNG lùi về hằng số trong mã (kho mã PUBLIC: khoá cứng = không mã hoá).
 *
 * Không có đệm: khoá đọc từ biến môi trường ở MỖI lần gọi (HKDF rẻ). "Khởi động lại" = biến môi trường
 * được nạp lại từ `.env`; cùng chuỗi ⇒ cùng khoá, cùng mã khoá — bài kiểm chứng minh điều đó.
 *
 * ─── XOAY KHOÁ: `PLATFORM_SECRETS_KEY_PREVIOUS` ───
 *
 * Deploy khoá MỚI không được giết bí mật đã mã hoá bằng khoá CŨ trước khi lượt xoay chạy xong. Nên khi
 * biến PREVIOUS có mặt (và hợp lệ, và khác khoá hiện tại), `openSecrets` giải bản mã mang ĐÚNG mã khoá
 * của PREVIOUS bằng khoá cũ. Chọn khoá theo MÃ KHOÁ lưu cạnh bản mã — không "thử bừa từng khoá". Mã hoá
 * LUÔN bằng khoá hiện tại: mỗi lượt lưu lại tự chuyển dòng sang khoá mới; phần còn lại do
 * `scripts/rotate-platform-secrets.ts` làm (docs/platform/launch-gates.md mục A · Xoay khoá).
 *
 * ─── MỖI LẦN MÃ HOÁ MỘT NONCE NGẪU NHIÊN ───
 *
 * GCM dùng lại nonce với cùng khoá là lộ luồng khoá VÀ giả được thẻ xác thực. 12 byte ngẫu nhiên mỗi
 * lần; số lần mã hoá của một tổ chức (vài lần lưu cấu hình) xa hàng tỷ lần dưới ngưỡng trùng.
 *
 * ─── AAD GẮN TỔ CHỨC + CONNECTOR ───
 *
 * `org:<mã>|connector:<khoá>|v1` đi vào thẻ xác thực. Bản mã của tổ chức A chép sang dòng của tổ
 * chức B (sao lưu khôi phục nhầm, lệnh SQL chép dòng, một lỗi định tuyến CSDL) KHÔNG giải được ở B —
 * không phải "giải ra khoá của A cho B dùng". Chép sang connector khác cùng tổ chức cũng không giải được.
 *
 * ─── ĐỊNH DẠNG ───
 *
 * `[1 byte phiên bản = 1][12 byte nonce][16 byte thẻ][bản mã]`. `secrets_key_id` = 8 byte đầu của
 * HMAC(khoá dẫn xuất, "kid") ở dạng hex: đổi `PLATFORM_SECRETS_KEY` thì biết NGAY là "khoá đã đổi"
 * thay vì một lỗi giải mã mơ hồ. Mã khoá không suy ngược được ra khoá.
 */

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_MASTER_CHARS = 32;
const HKDF_SALT = "vnx-erp/org-connections";
const HKDF_INFO = "org-connection-secrets/v1";

export const SECRETS_KEY_ENV = "PLATFORM_SECRETS_KEY";
export const SECRETS_KEY_PREVIOUS_ENV = "PLATFORM_SECRETS_KEY_PREVIOUS";

type DerivedKey = { key: Buffer; keyId: string };

/** Trạng thái biến PREVIOUS: không đặt · dùng được · đặt mà không dùng được (ngắn, hoặc TRÙNG khoá hiện tại). */
export type PreviousKeyState = "absent" | "ready" | "invalid";

export type SecretsKeyState =
  | { ok: true; key: Buffer; keyId: string; previous: DerivedKey | null; previousState: PreviousKeyState }
  | { ok: false; problem: "MISSING" | "INVALID"; reason: string };

export class SecretsUnavailableError extends Error {
  readonly code = "SECRETS_KEY_MISSING" as const;
  constructor(message: string) {
    super(message);
    this.name = "SecretsUnavailableError";
  }
}

export class SecretsDecryptError extends Error {
  readonly code = "SECRETS_DECRYPT_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "SecretsDecryptError";
  }
}

function derive(raw: string): DerivedKey {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32));
  const keyId = createHmac("sha256", key).update("kid").digest("hex").slice(0, 16);
  return { key, keyId };
}

/**
 * Đọc khoá lúc GỌI (không đóng băng lúc nạp module) — đổi biến môi trường rồi khởi động lại là đủ.
 * `readEnv` chỉ để bài kiểm đưa vào một "môi trường" giả mà không chạm biến thật của máy.
 */
export function secretsKeyState(readEnv: (name: string) => string | undefined = (n) => process.env[n]): SecretsKeyState {
  const raw = (readEnv(SECRETS_KEY_ENV) ?? "").trim();
  if (!raw) return { ok: false, problem: "MISSING", reason: `Máy chủ chưa có ${SECRETS_KEY_ENV} — tính năng lưu bí mật kết nối đang TẮT. Người vận hành nền tảng thêm secret GitHub ${SECRETS_KEY_ENV} (openssl rand -base64 48) rồi chạy deploy (docs/platform/launch-gates.md mục A).` };
  if (raw.length < MIN_MASTER_CHARS) return { ok: false, problem: "INVALID", reason: `${SECRETS_KEY_ENV} quá ngắn (${raw.length} ký tự, cần ≥ ${MIN_MASTER_CHARS}) — tính năng lưu bí mật kết nối đang TẮT. Người vận hành nền tảng thay secret GitHub ${SECRETS_KEY_ENV} bằng openssl rand -base64 48 rồi chạy deploy.` };
  const current = derive(raw);
  const rawPrev = (readEnv(SECRETS_KEY_PREVIOUS_ENV) ?? "").trim();
  let previous: DerivedKey | null = null;
  let previousState: PreviousKeyState = "absent";
  if (rawPrev) {
    // Ngắn ⇒ không dùng (không nới luật độ dài cho khoá cũ). Trùng khoá hiện tại ⇒ vô nghĩa, và in "ready" sẽ làm người
    // vận hành tưởng lượt xoay đã được chuẩn bị trong khi chưa.
    const d = rawPrev.length >= MIN_MASTER_CHARS ? derive(rawPrev) : null;
    if (d && d.keyId !== current.keyId) {
      previous = d;
      previousState = "ready";
    } else previousState = "invalid";
  }
  return { ok: true, key: current.key, keyId: current.keyId, previous, previousState };
}

/** Trạng thái khoá ĐỂ IN RA màn hình: không khoá, không chuỗi gốc — chỉ 8 ký tự đầu của mã khoá (HMAC, không suy ngược). */
export type SecretsKeyPublicStatus = { ready: true; keyIdShort: string; previous: PreviousKeyState; previousKeyIdShort: string | null } | { ready: false; reason: string };

export function secretsKeyPublicStatus(state: SecretsKeyState = secretsKeyState()): SecretsKeyPublicStatus {
  return state.ok
    ? { ready: true, keyIdShort: `${state.keyId.slice(0, 8)}…`, previous: state.previousState, previousKeyIdShort: state.previous ? `${state.previous.keyId.slice(0, 8)}…` : null }
    : { ready: false, reason: state.reason };
}

/**
 * Dòng cho `/api/health` (tuyến CÔNG KHAI): chỉ trạng thái + 8 ký tự hex đầu của MÃ khoá — đủ để so hai lượt deploy
 * "khoá có bị đổi không" từ bên ngoài, không đủ để làm gì khác. KHÔNG có mã khoá đầy đủ, KHÔNG có câu lý do (câu lý do
 * nói độ dài khoá).
 */
export type SecretsKeyHealth = { secretsKey: "ready" | "missing" | "invalid"; secretsKeyIdShort: string | null; secretsKeyPrevious: PreviousKeyState };

export function secretsKeyHealth(state: SecretsKeyState = secretsKeyState()): SecretsKeyHealth {
  if (!state.ok) return { secretsKey: state.problem === "MISSING" ? "missing" : "invalid", secretsKeyIdShort: null, secretsKeyPrevious: "absent" };
  return { secretsKey: "ready", secretsKeyIdShort: state.keyId.slice(0, 8), secretsKeyPrevious: state.previousState };
}

export function connectionAad(orgCode: string, connectorKey: string): Buffer {
  return Buffer.from(`org:${orgCode}|connector:${connectorKey}|v1`, "utf8");
}

/** Mã hoá một bộ bí mật `{ trường: giá trị }`. Thiếu khoá ⇒ NÉM `SecretsUnavailableError`. Luôn bằng khoá HIỆN TẠI. */
export function sealSecrets(
  values: Record<string, string>,
  binding: { orgCode: string; connectorKey: string },
  state: SecretsKeyState = secretsKeyState(),
): { ciphertext: Buffer; keyId: string } {
  if (!state.ok) throw new SecretsUnavailableError(state.reason);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", state.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(connectionAad(binding.orgCode, binding.connectorKey));
  const body = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, tag, body]), keyId: state.keyId };
}

/**
 * Giải mã. Khoá chọn theo `keyId` lưu cạnh bản mã: trùng khoá hiện tại ⇒ khoá hiện tại; trùng PREVIOUS ⇒ khoá cũ;
 * không trùng cái nào ⇒ từ chối với câu "nhập lại". Mọi lỗi (khoá đổi, bản mã bị sửa, AAD lệch tổ chức / connector,
 * định dạng lạ) ⇒ NÉM `SecretsDecryptError` với câu KHÔNG chứa byte nào của bản mã hay khoá.
 */
export function openSecrets(
  ciphertext: Buffer | Uint8Array,
  binding: { orgCode: string; connectorKey: string; keyId?: string | null },
  state: SecretsKeyState = secretsKeyState(),
): Record<string, string> {
  if (!state.ok) throw new SecretsUnavailableError(state.reason);
  const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  let key = state.key;
  if (binding.keyId && binding.keyId !== state.keyId) {
    if (state.previous && binding.keyId === state.previous.keyId) key = state.previous.key;
    else {
      throw new SecretsDecryptError(
        `Bí mật được mã hoá bằng một ${SECRETS_KEY_ENV} khác (mã khoá ${binding.keyId.slice(0, 8)}…, hiện tại ${state.keyId.slice(0, 8)}…${state.previous ? `, ${SECRETS_KEY_PREVIOUS_ENV} ${state.previous.keyId.slice(0, 8)}…` : ""}) — nhập lại bí mật của kết nối này.`,
      );
    }
  }
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES || buf[0] !== FORMAT_VERSION) throw new SecretsDecryptError("Bản mã bí mật không đúng định dạng — nhập lại bí mật của kết nối này.");
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const body = buf.subarray(1 + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(connectionAad(binding.orgCode, binding.connectorKey));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    throw new SecretsDecryptError("Không giải mã được bí mật của kết nối (thẻ xác thực sai: bản mã bị sửa, hoặc thuộc tổ chức / connector khác) — nhập lại bí mật.");
  }
}

/* ═════════════ TỰ KIỂM KHOÁ — TRONG BỘ NHỚ, KHÔNG CSDL, KHÔNG IN GIÁ TRỊ ═════════════ */

/** Tổ chức GIẢ của lượt tự kiểm — không phải mã tổ chức hợp lệ (`_` không có trong mẫu mã), nên không trùng tổ chức thật nào. */
export const SELF_TEST_ORG = "__tu_kiem__";
const SELF_TEST_CONNECTOR = "tu-kiem-khoa";

type Opener = typeof openSecrets;

/**
 * Chứng minh khoá đang chạy DÙNG ĐƯỢC mà không cần tổ chức thứ hai và không ghi CSDL: mã hoá một chuỗi NGẪU NHIÊN
 * (sinh lúc chạy, không bao giờ trả ra) với AAD của một tổ chức giả, giải lại, rồi đòi BỐN lượt giải sai phải bị TỪ
 * CHỐI — AAD tổ chức khác · AAD connector khác · khoá khác · bản mã bị sửa một byte. Một lượt "giải được" ở đó là
 * HỎNG (fail closed): bộ mã hoá mà nhận bừa thì không được gọi là sẵn sàng. Có PREVIOUS ⇒ thêm một lượt: bản mã của
 * khoá cũ giải được qua đường chọn-theo-mã-khoá. `open` chỉ để bài kiểm tiêm một bộ giải HỎNG và thấy kết luận đổi.
 */
export function selfTestSecrets(state: SecretsKeyState = secretsKeyState(), deps: { open?: Opener } = {}): SecretsSelfTestReport {
  const open = deps.open ?? openSecrets;
  if (!state.ok) return { ok: false, keyIdShort: null, keySource: SECRETS_KEY_ENV, previous: "absent", reason: state.reason, checks: [] };
  const probe = randomBytes(24).toString("base64url");
  const bind = { orgCode: SELF_TEST_ORG, connectorKey: SELF_TEST_CONNECTOR };
  const checks: { name: string; ok: boolean }[] = [];
  const mustOpen = (name: string, fn: () => Record<string, string>) => {
    let ok = false;
    try {
      ok = fn().probe === probe;
    } catch {
      ok = false;
    }
    checks.push({ name, ok });
  };
  const mustReject = (name: string, fn: () => Record<string, string>) => {
    let ok = false;
    try {
      fn();
    } catch (e) {
      ok = e instanceof SecretsDecryptError;
    }
    checks.push({ name, ok });
  };

  let sealed: { ciphertext: Buffer; keyId: string } | null = null;
  try {
    sealed = sealSecrets({ probe }, bind, state);
  } catch {
    sealed = null;
  }
  checks.push({ name: "Mã hoá bằng khoá hiện tại", ok: sealed !== null });
  if (sealed) {
    const s = sealed;
    checks.push({ name: "Bản mã không chứa bản rõ", ok: !s.ciphertext.includes(Buffer.from(probe, "utf8")) });
    const again = sealSecrets({ probe }, bind, state);
    checks.push({ name: "Mỗi lần mã hoá một nonce mới", ok: !again.ciphertext.subarray(1, 1 + NONCE_BYTES).equals(s.ciphertext.subarray(1, 1 + NONCE_BYTES)) });
    mustOpen("Giải lại đúng bản rõ", () => open(s.ciphertext, { ...bind, keyId: s.keyId }, state));
    mustReject("AAD tổ chức khác ⇒ từ chối", () => open(s.ciphertext, { orgCode: `${SELF_TEST_ORG}b`, connectorKey: SELF_TEST_CONNECTOR }, state));
    mustReject("AAD connector khác ⇒ từ chối", () => open(s.ciphertext, { orgCode: SELF_TEST_ORG, connectorKey: `${SELF_TEST_CONNECTOR}-b` }, state));
    const wrong = secretsKeyState((n) => (n === SECRETS_KEY_ENV ? randomBytes(48).toString("base64") : undefined));
    mustReject("Khoá khác ⇒ từ chối", () => open(s.ciphertext, bind, wrong));
    mustReject("Khoá khác, mang mã khoá cũ ⇒ từ chối", () => open(s.ciphertext, { ...bind, keyId: s.keyId }, wrong));
    const tampered = Buffer.from(s.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    mustReject("Bản mã bị sửa một byte ⇒ từ chối", () => open(tampered, { ...bind, keyId: s.keyId }, state));
  }
  if (state.previous) {
    const prevState: SecretsKeyState = { ok: true, key: state.previous.key, keyId: state.previous.keyId, previous: null, previousState: "absent" };
    const old = sealSecrets({ probe }, bind, prevState);
    mustOpen(`Bản mã của ${SECRETS_KEY_PREVIOUS_ENV} vẫn giải được (chờ xoay khoá)`, () => open(old.ciphertext, { ...bind, keyId: old.keyId }, state));
  }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: checks.length > 0 && failed.length === 0,
    keyIdShort: `${state.keyId.slice(0, 8)}…`,
    keySource: SECRETS_KEY_ENV,
    previous: state.previousState,
    reason: failed.length ? `Tự kiểm HỎNG ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join(" · ")}` : null,
    checks,
  };
}

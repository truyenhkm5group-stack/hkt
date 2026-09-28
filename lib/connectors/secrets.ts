import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

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

export type SecretsKeyState = { ok: true; key: Buffer; keyId: string } | { ok: false; reason: string };

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

/**
 * Đọc khoá lúc GỌI (không đóng băng lúc nạp module) — đổi biến môi trường rồi khởi động lại là đủ.
 * `readEnv` chỉ để bài kiểm đưa vào một "môi trường" giả mà không chạm biến thật của máy.
 */
export function secretsKeyState(readEnv: (name: string) => string | undefined = (n) => process.env[n]): SecretsKeyState {
  const raw = (readEnv(SECRETS_KEY_ENV) ?? "").trim();
  if (!raw) return { ok: false, reason: `Máy chủ chưa có ${SECRETS_KEY_ENV} — tính năng lưu bí mật kết nối đang TẮT. Người vận hành đặt biến này (≥ ${MIN_MASTER_CHARS} ký tự ngẫu nhiên) rồi khởi động lại.` };
  if (raw.length < MIN_MASTER_CHARS) return { ok: false, reason: `${SECRETS_KEY_ENV} quá ngắn (${raw.length} ký tự, cần ≥ ${MIN_MASTER_CHARS}) — tính năng lưu bí mật kết nối đang TẮT.` };
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32));
  const keyId = createHmac("sha256", key).update("kid").digest("hex").slice(0, 16);
  return { ok: true, key, keyId };
}

export function connectionAad(orgCode: string, connectorKey: string): Buffer {
  return Buffer.from(`org:${orgCode}|connector:${connectorKey}|v1`, "utf8");
}

/** Mã hoá một bộ bí mật `{ trường: giá trị }`. Thiếu khoá ⇒ NÉM `SecretsUnavailableError`. */
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
 * Giải mã. Mọi lỗi (khoá đổi, bản mã bị sửa, AAD lệch tổ chức / connector, định dạng lạ) ⇒ NÉM
 * `SecretsDecryptError` với câu KHÔNG chứa byte nào của bản mã hay khoá.
 */
export function openSecrets(
  ciphertext: Buffer | Uint8Array,
  binding: { orgCode: string; connectorKey: string; keyId?: string | null },
  state: SecretsKeyState = secretsKeyState(),
): Record<string, string> {
  if (!state.ok) throw new SecretsUnavailableError(state.reason);
  const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  if (binding.keyId && binding.keyId !== state.keyId) {
    throw new SecretsDecryptError(`Bí mật được mã hoá bằng một ${SECRETS_KEY_ENV} khác (mã khoá ${binding.keyId}, hiện tại ${state.keyId}) — nhập lại bí mật của kết nối này.`);
  }
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES || buf[0] !== FORMAT_VERSION) throw new SecretsDecryptError("Bản mã bí mật không đúng định dạng — nhập lại bí mật của kết nối này.");
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const body = buf.subarray(1 + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", state.key, nonce, { authTagLength: TAG_BYTES });
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

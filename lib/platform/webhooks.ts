import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { secretsKeyState, type SecretsKeyState } from "@/lib/connectors/secrets";
import { findOrganization, getHomeOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ WEBHOOK THUỘC TỔ CHỨC NÀO — KHAI, KHÔNG NGẦM ĐỊNH ═══════════
 *
 * Hợp đồng: shared-contracts.md mục 8 · audit ISO-07. Webhook không có phiên, nên không có chứng
 * cứ nào tự nói "gói tin này của ai". Trước nền tảng câu trả lời ngầm là "của CSDL mặc định"; nay
 * mỗi nhà cung cấp phải KHAI cách phân giải trong bảng dưới, và route bọc TOÀN BỘ phần xử lý (kể
 * cả việc sau phản hồi) trong `withOrganization(mã đã phân giải)`.
 *
 * Phase 1: bí mật webhook là MỘT giá trị môi trường cho cả tiến trình — tức là bí mật của tổ chức
 * nhà — nên mọi nhà cung cấp là `HOME_ONLY`. Phase 1.x thêm cách phân giải theo bí mật trong
 * đường dẫn (`secret_hash → tổ chức`); bí mật không khớp tổ chức nào thì 401, KHÔNG rơi về nhà.
 */

export type WebhookProvider = "PANCAKE" | "VIETTELPOST" | "VTP_STATEMENT" | "SEPAY" | "PANCAKE_FANPAGE" | "PANCAKE_POS_ORG" | "VIETTELPOST_ORG" | "MESSENGER" | "ZALO_OA";

/**
 * `HOME_ONLY` — bí mật là một biến môi trường của tổ chức nhà.
 * `URL_SECRET` — đường dẫn mang MỘT token «<mã tổ chức>.<chữ ký>», chữ ký = HMAC của khoá con dẫn xuất từ
 * `PLATFORM_SECRETS_KEY` trên (nhà cung cấp, mã tổ chức). Token sai / tổ chức không hoạt động ⇒ 401, KHÔNG rơi về nhà.
 * `PAGE_INDEX` — MỘT địa chỉ chung cho mọi tổ chức (Meta chỉ cho khai một URL webhook mỗi app); gói tin đã xác thực bằng chữ
 * ký của app, và MÃ PAGE trong gói tra ở `platform_messenger_pages` (một page thuộc đúng một tổ chức). Không có dòng / tổ
 * chức không hoạt động ⇒ NÉM, không rơi về nhà.
 */
export type WebhookBinding = { mode: "HOME_ONLY"; reason: string } | { mode: "URL_SECRET"; reason: string } | { mode: "PAGE_INDEX"; reason: string };

export const WEBHOOK_BINDINGS: Readonly<Record<WebhookProvider, WebhookBinding>> = {
  PANCAKE: { mode: "HOME_ONLY", reason: "Bí mật trong đường dẫn so với PANCAKE_WEBHOOK_SECRET — một giá trị môi trường, của tổ chức nhà." },
  VIETTELPOST: { mode: "HOME_ONLY", reason: "Gói Viettel Post không mang mã khách; bí mật duy nhất là VIETTELPOST_WEBHOOK_SECRET của tổ chức nhà." },
  VTP_STATEMENT: { mode: "HOME_ONLY", reason: "Kịch bản Gmail của hộp thư tổ chức nhà, dùng chung VIETTELPOST_WEBHOOK_SECRET." },
  SEPAY: { mode: "HOME_ONLY", reason: "Chữ ký HMAC bằng SEPAY_WEBHOOK_SECRET — một giá trị môi trường, của tổ chức nhà." },
  PANCAKE_FANPAGE: { mode: "URL_SECRET", reason: "Tin fanpage của MỘT tổ chức khách: token trong đường dẫn mang mã tổ chức + chữ ký HMAC riêng của tổ chức đó (dẫn xuất từ PLATFORM_SECRETS_KEY)." },
  VIETTELPOST_ORG: { mode: "URL_SECRET", reason: "Hành trình vận đơn Viettel Post của MỘT tổ chức khách: gói VTP không mang mã khách, nên token trong đường dẫn mang mã tổ chức + chữ ký HMAC riêng của tổ chức đó." },
  ZALO_OA: { mode: "URL_SECRET", reason: "Tin Zalo OA của MỘT tổ chức khách (app Zalo của chính shop): token trong đường dẫn mang mã tổ chức + chữ ký HMAC riêng của tổ chức đó; gói tin còn được kiểm chữ ký X-ZEvent-Signature bằng OA Secret Key của shop." },
  PANCAKE_POS_ORG: { mode: "URL_SECRET", reason: "Đơn / khách / sản phẩm / tồn từ Pancake POS của MỘT tổ chức khách (kết nối «pancake-pos-org»): token trong đường dẫn mang mã tổ chức + chữ ký HMAC riêng của tổ chức đó." },
  MESSENGER: { mode: "PAGE_INDEX", reason: "Messenger trực tiếp (0207): Meta gửi mọi page về MỘT URL, ký X-Hub-Signature-256 bằng app secret của nền tảng; mã page trong gói tra ở platform_messenger_pages — page chưa nối / tổ chức không hoạt động ⇒ từ chối." },
};

/** Token trong đường dẫn không khớp tổ chức nào (URL_SECRET) — route trả 401, KHÔNG rơi về nhà. */
export class WebhookAuthError extends Error {}

/**
 * Mã tổ chức mà gói tin của `provider` thuộc về. Nhà cung cấp chưa khai ⇒ NÉM, không đoán. Chế độ `URL_SECRET` cần `token`
 * (đoạn trong đường dẫn); sai / thiếu ⇒ NÉM `WebhookAuthError`.
 */
export async function resolveWebhookOrganization(provider: WebhookProvider, opts: { token?: string; pageId?: string } = {}): Promise<string> {
  // `Object.hasOwn`: chuỗi lạ trùng tên thuộc tính của Object (`toString`, `constructor`…) không được
  // lọt qua như một dòng khai.
  const binding = Object.hasOwn(WEBHOOK_BINDINGS, provider) ? WEBHOOK_BINDINGS[provider] : undefined;
  if (!binding) throw new Error(`Webhook "${provider}" chưa khai cách phân giải tổ chức trong WEBHOOK_BINDINGS.`);
  switch (binding.mode) {
    case "HOME_ONLY":
      return (await getHomeOrganization()).code;
    case "URL_SECRET": {
      const code = opts.token ? await resolveUrlSecretOrganization(provider, opts.token) : null;
      if (!code) throw new WebhookAuthError(`Sai token webhook ${provider}`);
      return code;
    }
    case "PAGE_INDEX": {
      const code = opts.pageId ? await resolvePageOrganization(opts.pageId) : null;
      if (!code) throw new WebhookAuthError(`Page ${opts.pageId ?? "(trống)"} chưa nối với tổ chức nào (${provider})`);
      return code;
    }
    default:
      // Chế độ lạ (dữ liệu hỏng, bản sau thêm chế độ mà quên nhánh) ⇒ NÉM, không rơi về nhà.
      throw new Error(`Webhook "${provider}" khai chế độ phân giải "${String((binding as { mode?: unknown }).mode)}" chưa được hỗ trợ.`);
  }
}

// ─── URL_SECRET: token theo tổ chức ───

const ORG_CODE_IN_TOKEN = /^[a-z0-9][a-z0-9-]{1,40}$/;

function tokenSignature(key: Buffer, provider: WebhookProvider, orgCode: string): string {
  // Khoá con riêng cho token webhook — tách miền khỏi khoá mã hoá bí mật kết nối.
  const sub = createHmac("sha256", key).update("webhook-url-token/v1").digest();
  return createHmac("sha256", sub).update(`${provider}:${orgCode}`).digest("base64url").slice(0, 32);
}

/** Token webhook của `orgCode` cho `provider` (chỉ chế độ URL_SECRET). `null` khi máy chưa có khoá bí mật. */
export function webhookUrlToken(provider: WebhookProvider, orgCode: string, state: SecretsKeyState = secretsKeyState()): string | null {
  if (!state.ok || WEBHOOK_BINDINGS[provider]?.mode !== "URL_SECRET") return null;
  return `${orgCode}.${tokenSignature(state.key, provider, orgCode)}`;
}

/**
 * Token trong đường dẫn ⇒ mã tổ chức, hoặc `null` (⇒ 401). So chữ ký bằng `timingSafeEqual`; nhận cả chữ ký của khoá CŨ
 * (`PLATFORM_SECRETS_KEY_PREVIOUS`) trong lúc xoay khoá. Tổ chức nhà, tổ chức không có hoặc không hoạt động ⇒ `null`.
 */
export async function resolveUrlSecretOrganization(provider: WebhookProvider, token: string, state: SecretsKeyState = secretsKeyState()): Promise<string | null> {
  if (!state.ok || WEBHOOK_BINDINGS[provider]?.mode !== "URL_SECRET") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 120) return null;
  const orgCode = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "utf8");
  if (!ORG_CODE_IN_TOKEN.test(orgCode)) return null;
  const keys = [state.key, ...(state.previous ? [state.previous.key] : [])];
  const ok = keys.some((k) => {
    const want = Buffer.from(tokenSignature(k, provider, orgCode), "utf8");
    return want.length === sig.length && timingSafeEqual(want, sig);
  });
  if (!ok) return null;
  const org = await findOrganization(orgCode);
  if (!org || org.isHome || org.status !== "ACTIVE") return null;
  return org.code;
}


// ─── PAGE_INDEX: mã page ⇒ tổ chức ───

/** Mã page Messenger ⇒ mã tổ chức đang hoạt động, hoặc `null`. Bảng chưa có (máy chưa migrate) ⇒ `null`. */
export async function resolvePageOrganization(pageId: string): Promise<string | null> {
  if (!/^\d{5,30}$/.test(pageId)) return null;
  try {
    const pdb = await getPlatformDb();
    const [row] = await pdb.select({ orgCode: schema.platformMessengerPages.orgCode }).from(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.pageId, pageId)).limit(1);
    if (!row) return null;
    const org = await findOrganization(row.orgCode);
    return org && org.status === "ACTIVE" ? org.code : null;
  } catch {
    return null;
  }
}

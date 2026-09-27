import { AsyncLocalStorage } from "node:async_hooks";
import { jwtVerify } from "jose";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/constants/session";
import { FALLBACK_HOME_CODE, findOrganization, getHomeOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ NGỮ CẢNH TỔ CHỨC — "ĐANG CHẠY CHO AI" ═══════════
 *
 * Hợp đồng: docs/platform/shared-contracts.md mục 3. Mọi lời gọi `getDb()` đi qua
 * `currentOrganization()`, nên đây là chỗ DUY NHẤT quyết định một câu truy vấn chạm vào CSDL nào.
 *
 * ─── CHỨNG CỨ, THEO THỨ TỰ ───
 *
 *  1. `withOrganization(mã, fn)` — TƯỜNG MINH (AsyncLocalStorage). Job, webhook, script, kiểm thử.
 *  2. Claim `org` trong JWT phiên — do MÁY CHỦ ký lúc đăng nhập, xác minh chữ ký ở đây.
 *  3. Token cũ KHÔNG có claim `org` ⇒ tổ chức nhà. Nó được phát ra khi hệ thống chỉ có một tổ chức,
 *     nên đó là câu trả lời duy nhất đúng — và là thứ giữ cho lượt deploy nền tảng không đăng xuất
 *     cả shop.
 *  4. Không có phiên nào ⇒ tổ chức nhà: tiến trình script, tuyến máy-gọi-máy đã tự xác thực bằng
 *     bí mật của tổ chức nhà (`/api/sync`, webhook). Trang cần đăng nhập không bao giờ tới được đây
 *     không phiên vì middleware đã chuyển về `/login`.
 *
 * ─── KHÔNG BAO GIỜ TỪ CLIENT ───
 *
 * Không đọc mã tổ chức từ query string, body hay header do trình duyệt gửi. Một tham số
 * `organization_id` mà đổi được ngữ cảnh là một cửa để đọc dữ liệu khách khác bằng cách sửa URL.
 *
 * ─── CLAIM TRỎ TỚI TỔ CHỨC KHÔNG CÒN / BỊ ĐÌNH CHỈ ⇒ NÉM, KHÔNG RƠI VỀ NHÀ ───
 *
 * Rơi về nhà ở nhánh này nghĩa là một người của tổ chức B (vừa bị đình chỉ) đọc được CSDL của A.
 * Mọi nhánh lỗi phải rơi về phía HẸP HƠN (AGENTS.md luật 31).
 */

export type OrgContextSource = "EXPLICIT" | "SESSION" | "LEGACY_SESSION" | "HOME_DEFAULT";
export type OrgContext = { code: string; isHome: boolean; source: OrgContextSource };

export class OrgContextError extends Error {
  constructor(
    readonly code: "ORG_UNKNOWN" | "ORG_INACTIVE" | "ORG_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "OrgContextError";
  }
}

const holder = globalThis as unknown as { __erpOrgCtx?: AsyncLocalStorage<OrgContext> };
if (!holder.__erpOrgCtx) holder.__erpOrgCtx = new AsyncLocalStorage<OrgContext>();
const als = holder.__erpOrgCtx;

/** Chạy `fn` trong ngữ cảnh tổ chức TƯỜNG MINH. Lồng được; ngữ cảnh trong cùng thắng. */
export async function withOrganization<T>(code: string, fn: () => Promise<T>): Promise<T> {
  const org = await findOrganization(code);
  if (!org) throw new OrgContextError("ORG_UNKNOWN", `Không có tổ chức "${code}".`);
  if (org.status !== "ACTIVE") throw new OrgContextError("ORG_INACTIVE", `Tổ chức "${code}" đang ${org.status}.`);
  return als.run({ code: org.code, isHome: org.isHome, source: "EXPLICIT" }, fn);
}

/** Chỉ đọc ngữ cảnh TƯỜNG MINH, đồng bộ. `null` = không có (request thường, hoặc script cũ). */
export function peekOrganization(): OrgContext | null {
  return als.getStore() ?? null;
}

/**
 * Ngữ cảnh tổ chức nhà khi KHÔNG có phiên mang claim tổ chức và không có ngữ cảnh tường minh.
 *
 * ─── KHÔNG ĐƯỢC PHỤ THUỘC CSDL ───
 *
 * Ở nhánh này câu trả lời "là nhà" đã chắc chắn trước khi đọc sổ; sổ chỉ cho biết MÃ của nhà. Script
 * chạy trên GitHub Actions không có `DATABASE_URL` (cầu nối mở PR `scripts/agent-open-pr.ts` đi qua
 * `assertHomeCredentials()` của client GitHub) — bản đầu để lỗi "Chưa cấu hình DATABASE_URL" của lượt
 * đọc sổ ném lên, và cầu nối mở PR hỏng cho MỌI phiên ngay sau khi Phase 1 lên `main` (27/09/2026).
 * Đọc sổ hỏng ⇒ dùng mã dựng sẵn của nhà. Không mở rộng quyền nào: nhánh có claim tổ chức (hoặc ngữ
 * cảnh tường minh) KHÔNG đi qua đây, nên tổ chức khác không bao giờ rơi về nhà vì lỗi sổ.
 */
async function homeContext(source: OrgContextSource): Promise<OrgContext> {
  try {
    const home = await getHomeOrganization();
    return { code: home.code, isHome: true, source };
  } catch {
    return { code: FALLBACK_HOME_CODE, isHome: true, source };
  }
}

export async function currentOrganization(): Promise<OrgContext> {
  const explicit = als.getStore();
  if (explicit) return explicit;
  const claim = await sessionOrgClaim();
  if (claim === undefined) return homeContext("HOME_DEFAULT");
  if (claim === null) return homeContext("LEGACY_SESSION");
  const org = await findOrganization(claim);
  if (!org) throw new OrgContextError("ORG_UNKNOWN", `Phiên thuộc tổ chức "${claim}" nhưng tổ chức này không tồn tại.`);
  if (org.status !== "ACTIVE") throw new OrgContextError("ORG_INACTIVE", `Tổ chức "${claim}" đang ${org.status}.`);
  return { code: org.code, isHome: org.isHome, source: "SESSION" };
}

// ─────────────────────────── đọc claim từ cookie phiên ───────────────────────────

/**
 * Đệm KẾT QUẢ XÁC MINH theo chuỗi token: một lần dựng trang gọi `getDb()` hàng chục lần, mỗi lần
 * xác minh lại chữ ký HS256 là phí. Token là giấy đã ký — cùng chuỗi thì cùng kết quả cho tới khi
 * nó hết hạn, nên đệm theo `exp` của chính nó. Trần kích thước để không phình vô hạn.
 */
const VERIFIED_MAX = 500;
const verified = new Map<string, { org: string | null; expMs: number }>();

type CookieReader = () => Promise<{ get(name: string): { value: string } | undefined }>;
let cookieReader: CookieReader | null | undefined;

async function readCookies(): Promise<CookieReader | null> {
  if (cookieReader !== undefined) return cookieReader;
  try {
    const mod = await import("next/headers");
    cookieReader = mod.cookies as unknown as CookieReader;
  } catch {
    cookieReader = null;
  }
  return cookieReader;
}

/**
 * MÓC KIỂM THỬ: bộ kiểm thử chạy ngoài Next nên không có cookie. Đặt một hàm trả token để giả lập
 * "request của người đang đăng nhập" — đi qua ĐÚNG đường xác minh chữ ký như request thật, không
 * có nhánh tắt nào. Đặt `null` để gỡ. Mã sản phẩm không được gọi hàm này (bài kiểm quét).
 */
let tokenOverride: (() => Promise<string | undefined>) | null = null;
export function setSessionTokenSourceForTests(source: (() => Promise<string | undefined>) | null) {
  tokenOverride = source;
}

/**
 * Token phiên thô của request hiện hành — ĐƯỜNG ĐỌC DUY NHẤT, dùng chung với `lib/auth/session.ts` để
 * ngữ cảnh tổ chức và danh tính người dùng không bao giờ đọc hai token khác nhau.
 */
export async function readSessionTokenRaw(): Promise<string | undefined> {
  if (tokenOverride) return tokenOverride();
  const reader = await readCookies();
  if (!reader) return undefined;
  try {
    return (await reader()).get(SESSION_COOKIE)?.value;
  } catch {
    // Gọi ngoài phạm vi một request (script, timer của tiến trình): không có phiên.
    return undefined;
  }
}

/**
 * `undefined` = không có phiên hợp lệ · `null` = phiên hợp lệ nhưng token cũ, không có claim ·
 * chuỗi = mã tổ chức trong claim.
 */
async function sessionOrgClaim(): Promise<string | null | undefined> {
  const token = await readSessionTokenRaw();
  if (!token) return undefined;
  const now = Date.now();
  const hit = verified.get(token);
  if (hit && hit.expMs > now) return hit.org;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.authSecret));
    const org = typeof payload.org === "string" && payload.org ? payload.org : null;
    if (verified.size >= VERIFIED_MAX) verified.clear();
    verified.set(token, { org, expMs: typeof payload.exp === "number" ? payload.exp * 1000 : now + 60_000 });
    return org;
  } catch {
    return undefined;
  }
}

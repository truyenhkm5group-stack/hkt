/**
 * ═══════════ SỔ CHẤP THUẬN VĂN BẢN PHÁP LÝ (M-ACCEPT · 0236) — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop chốt: KHÔNG thêm ma sát — không checkbox, không màn chặn, không bước mới. Chấp thuận được GHI Ở BACKEND tại đúng
 * chỗ khách đã đồng ý hôm nay: dòng «Bằng việc tạo cửa hàng / bấm Tạo, bạn đồng ý với Điều khoản sử dụng và Chính sách quyền
 * riêng tư» ở `/start` (docs/legal/CONVERSION_FIRST_REAUDIT.md · P0-6).
 *
 * ─── KHÔNG BỊA CHẤP THUẬN ───
 * Một dòng sổ chỉ được ghi khi người gọi nêu ĐÚNG một chỗ trên giao diện có dòng đồng ý thật (`LEGAL_CONSENT_SURFACES` — mỗi
 * khoá trỏ tới tệp giao diện chứa câu đồng ý, bài kiểm mở từng tệp). Đường không có dòng đồng ý (khách do người vận hành tạo
 * qua job «Tạo khách» rồi đặt mật khẩu bằng liên kết · nhân viên vào qua `/join` · người vận hành tạo hộ ở `/start`) KHÔNG có
 * dòng nào — đó là chỗ hở đã ghi cho luật sư (docs/legal/TECH_HANDOFF_LEGAL.md mục M-ACCEPT), không phải thứ để lấp bằng đoán.
 * Không backfill tổ chức tạo trước sổ (AGENTS 35).
 *
 * ─── KHÔNG DỮ LIỆU NGƯỜI THÔ ───
 * Email: HMAC-SHA256 theo `AUTH_SECRET`, tiền tố miền riêng (`legal-acceptance-email/v1`) — trên main chưa có phép băm định
 * danh dùng chung nào cho email. IP: ĐÚNG phép băm của trần đăng ký (`lib/onboarding/rate.ts::hashIp`), để đối chiếu được với
 * `platform_signup_attempts` mà không lưu IP. User-Agent cắt `USER_AGENT_MAX` ký tự.
 *
 * ─── KHÔNG LÀM HỎNG ĐĂNG KÝ ───
 * Ghi sổ hỏng ⇒ cảnh báo trong log (không email / IP / UA), đăng ký vẫn thành công. Sổ là bằng chứng bổ sung — nhật ký
 * `ORG_ONBOARDED` của tổ chức vẫn mang phiên bản như trước.
 *
 * ─── PHIÊN BẢN + BĂM NỘI DUNG ───
 * Người gọi đưa `{ document, version, contentSha256 }`. Nguồn hiện tại (`signupDocuments`) đọc hằng phiên bản ĐANG CÓ
 * (`lib/constants/company.ts`). Băm nội dung đã render chưa có hàm dùng chung trên main (sứ mệnh `legal-registers` sẽ cấp
 * `lib/constants/legal-documents.ts::legalContentSha256`) ⇒ `contentSha256 = null` = CHƯA BIẾT, không phải một băm bịa từ
 * số phiên bản. Khi hàm đó vào main, chỉ `signupDocuments` đổi.
 */
import { createHmac } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { env } from "@/lib/env";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/** Danh sách ĐÓNG — khớp CHECK `platform_legal_acceptances_document_check`. */
export const LEGAL_DOCUMENTS = ["TERMS", "PRIVACY", "DPA"] as const;
export type LegalDocumentKey = (typeof LEGAL_DOCUMENTS)[number];

/** Danh sách ĐÓNG — khớp CHECK `platform_legal_acceptances_action_check`. `INVITE_ACCEPT` / `NOTICE_SEEN` chưa có đường ghi. */
export const LEGAL_ACCEPTANCE_ACTIONS = ["SIGNUP", "INVITE_ACCEPT", "NOTICE_SEEN"] as const;
export type LegalAcceptanceAction = (typeof LEGAL_ACCEPTANCE_ACTIONS)[number];

/**
 * Chỗ trên giao diện CÓ dòng đồng ý thật ⇒ tệp mang câu đó. Khớp CHECK `platform_legal_acceptances_source_check`. Thêm một chỗ
 * ghi mới = thêm câu đồng ý vào giao diện TRƯỚC, rồi mới thêm khoá ở đây (tests/legal-acceptance.test.ts mở từng tệp).
 */
export const LEGAL_CONSENT_SURFACES = {
  /** Trình hướng dẫn đầy đủ `/start?day-du=1` — «Bằng việc bấm Tạo, bạn đồng ý với…» ở bước xem trước. */
  START_WIZARD: "components/onboarding/start-wizard.tsx",
  /** Đăng ký nhanh một màn hình `/start` (kể cả qua Google / Facebook) — «Bằng việc tạo cửa hàng, bạn đồng ý với…». */
  START_QUICK: "components/onboarding/quick-start.tsx",
} as const;
export type LegalConsentSurface = keyof typeof LEGAL_CONSENT_SURFACES;

export const USER_AGENT_MAX = 300;

export type LegalDocumentVersion = { document: LegalDocumentKey; version: string; contentSha256: string | null };

/**
 * Văn bản mà dòng đồng ý ở `/start` dẫn chiếu, ở phiên bản ĐANG công bố. Nguồn tạm: hằng phiên bản của `company.ts`; băm nội
 * dung `null` (CHƯA BIẾT) cho tới khi có hàm băm bản đã render dùng chung với trang.
 */
export function signupDocuments(): LegalDocumentVersion[] {
  return [
    { document: "TERMS", version: TERMS_OF_SERVICE.version, contentSha256: null },
    { document: "PRIVACY", version: PRIVACY_POLICY.version, contentSha256: null },
  ];
}

/** HMAC email (chuẩn hoá chữ thường, bỏ khoảng trắng) — không đảo ngược được nếu không có `AUTH_SECRET`. */
export function legalEmailHash(email: string): string {
  return createHmac("sha256", env.authSecret).update(`legal-acceptance-email/v1\n${email.trim().toLowerCase()}`).digest("hex");
}

export function trimUserAgent(ua: string | null | undefined): string | null {
  // Ký tự điều khiển (xuống dòng, tab…) thành dấu cách — UA là chuỗi một dòng, không để nó chèn dòng vào log / bản xuất.
  const s = Array.from(ua ?? "", (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("").trim();
  return s ? s.slice(0, USER_AGENT_MAX) : null;
}

let faultHook: (() => void) | null = null;
/** Móc cho bài kiểm: ném trước lượt ghi để chứng minh đăng ký không vỡ khi sổ lỗi. */
export function setLegalAcceptanceFaultForTests(hook: (() => void) | null) {
  faultHook = hook;
}

export type SignupAcceptanceInput = {
  orgCode: string;
  userId: string | null;
  email: string;
  /** Đã băm bằng `hashIp` (lib/onboarding/rate.ts) — hàm này không nhận IP thô. */
  ipHash: string | null;
  userAgent: string | null | undefined;
  surface: LegalConsentSurface;
  documents: readonly LegalDocumentVersion[];
};

/**
 * Ghi chấp thuận lúc TẠO tổ chức qua `/start`. Không bao giờ ném: lỗi ⇒ log (không dữ liệu người), trả số dòng đã ghi (0).
 * Idempotent theo (tổ chức, văn bản, phiên bản) — chạy lại sau hỏng không nhân đôi.
 */
export async function recordSignupAcceptance(input: SignupAcceptanceInput): Promise<number> {
  try {
    faultHook?.();
    if (!(input.surface in LEGAL_CONSENT_SURFACES)) throw new Error(`chỗ đồng ý lạ: ${String(input.surface)}`);
    const pdb = await getPlatformDb();
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, input.orgCode), columns: { id: true, accountId: true } });
    const ua = trimUserAgent(input.userAgent);
    const emailHash = legalEmailHash(input.email);
    const rows = input.documents.map((d) => ({
      orgCode: input.orgCode,
      organizationId: org?.id ?? null,
      accountId: org?.accountId ?? null,
      userId: input.userId,
      emailHash,
      document: d.document,
      version: d.version,
      contentSha256: d.contentSha256,
      action: "SIGNUP" as const,
      ipHash: input.ipHash,
      userAgent: ua,
      source: input.surface,
    }));
    if (!rows.length) return 0;
    const written = await pdb.insert(schema.platformLegalAcceptances).values(rows).onConflictDoNothing().returning({ id: schema.platformLegalAcceptances.id });
    return written.length;
  } catch (error) {
    // Không in email / IP / UA: chỉ mã tổ chức (không phải dữ liệu người) và câu lỗi đã cắt.
    console.warn(`[legal] chưa ghi được sổ chấp thuận cho tổ chức ${input.orgCode}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    return 0;
  }
}

export type AcceptanceRow = {
  id: string;
  orgCode: string | null;
  organizationId: string | null;
  accountId: string | null;
  userId: string | null;
  document: string;
  version: string;
  contentSha256: string | null;
  action: string;
  acceptedAt: Date;
  source: string;
  /** `false` ⇒ dòng của một ĐỜI tổ chức trước đã bị xoá mà mã được dùng lại — không phải chấp thuận của tổ chức hiện tại. */
  currentWorkspace: boolean;
};

/**
 * Người vận hành nền tảng đọc sổ của một mã tổ chức (chưa có trang). Không trả băm email / IP / UA: đọc «ai đồng ý gì, lúc
 * nào, phiên bản nào» là đủ; băm chỉ dùng để đối chiếu khi có tranh chấp, làm qua ops chỉ đọc.
 */
export async function listAcceptances(user: SessionUser, orgCode: string): Promise<{ ok: true; rows: AcceptanceRow[] } | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, orgCode), columns: { id: true } });
  const t = schema.platformLegalAcceptances;
  const rows = await pdb
    .select({ id: t.id, orgCode: t.orgCode, organizationId: t.organizationId, accountId: t.accountId, userId: t.userId, document: t.document, version: t.version, contentSha256: t.contentSha256, action: t.action, acceptedAt: t.acceptedAt, source: t.source })
    .from(t)
    .where(eq(t.orgCode, orgCode))
    .orderBy(desc(t.acceptedAt));
  return { ok: true, rows: rows.map((r) => ({ ...r, currentWorkspace: Boolean(org && r.organizationId === org.id) })) };
}

/**
 * ═══ TOKEN TIỆN ÍCH «LƯU MẪU TỪ 1688» (SRC-6, 0260) — CHỈ MÁY CHỦ ═══
 *
 * Một token = MỘT người, MỘT máy, phạm vi DUY NHẤT `sourcing:capture`. Hình dạng `vnxs1.<mã tổ chức>.<bí mật 32 byte>`:
 *  · mã tổ chức chọn CSDL (như lịch .ics, `lib/stays/feed.ts`); bí mật chỉ lưu BĂM sha256 trong CSDL của CHÍNH tổ chức đó ⇒ token
 *    tổ chức A gắn nhãn tổ chức B không khớp dòng nào, và lộ CSDL không lộ token.
 *  · token chỉ hiện MỘT lần lúc tạo; màn hình về sau chỉ thấy 4 ký tự cuối.
 *  · thu hồi = `revoked_at` (không xoá) — lần chụp cũ vẫn truy được về token đã dùng.
 *  · KHÔNG bao giờ nhận / lưu cookie 1688: tiện ích chỉ gửi token ERP + nhánh dữ liệu sản phẩm.
 * Mỗi lượt dùng vẫn hỏi lại tài khoản ĐANG BẬT, quyền `sourcing:write`, module `sourcing`, cổng thu phí — token không cấp quyền nào
 * mà người cầm nó không còn có.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { activeSessionUserById, can, type SessionUser } from "@/lib/auth/session";
import { billingWriteDenied } from "@/lib/billing/rules";
import { orgBillingStanding } from "@/lib/billing/standing";
import { parseCaptureToken, SOURCING_CAPTURE_PATH, SOURCING_CAPTURE_SCOPE, SOURCING_CAPTURE_TOKENS_PER_USER } from "@/lib/constants/sourcing";
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, isOperationalOrganization } from "@/lib/platform/organizations";
import { isMissingSourcingTable } from "@/lib/queries/sourcing";
import { billingLockApplies } from "@/lib/saas/policy";

const NOT_MIGRATED = "CSDL của tổ chức chưa áp migration 0260 (lưu mẫu từ 1688) — báo người vận hành.";

export function hashCaptureSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export type CaptureTokenView = { id: string; userId: string; userName: string | null; label: string; hint: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };

export type CaptureTokenResult = { ok: true; id: string; message: string; token?: string } | { ok: false; errors: { message: string }[] };
const fail = (message: string): CaptureTokenResult => ({ ok: false, errors: [{ message }] });

/** Người thao tác — khoá tài khoản BẮT BUỘC (AGENTS 34). */
export type CaptureTokenActor = { id: string; email: string };

const createSchema = z.object({ label: z.string().trim().min(2, "Đặt tên cho token (vd «Chrome máy văn phòng»)").max(80) });

/** Tạo token cho CHÍNH người thao tác. Trả token MỘT lần — không lưu, không ghi vào nhật ký. */
export async function createCaptureToken(actor: CaptureTokenActor, orgCode: string, input: z.input<typeof createSchema>): Promise<CaptureTokenResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  try {
    const db = await getDb();
    const t = schema.sourcingCaptureTokens;
    const active = await db.select({ id: t.id }).from(t).where(and(eq(t.userId, actor.id), isNull(t.revokedAt)));
    if (active.length >= SOURCING_CAPTURE_TOKENS_PER_USER) return fail(`Mỗi người tối đa ${SOURCING_CAPTURE_TOKENS_PER_USER} token còn hiệu lực — thu hồi token máy cũ trước.`);
    const secret = randomBytes(32).toString("base64url");
    const token = `vnxs1.${orgCode}.${secret}`;
    if (!parseCaptureToken(token)) return fail("Mã tổ chức không dùng được trong token — báo người vận hành.");
    const [row] = await db
      .insert(t)
      .values({ userId: actor.id, label: parsed.data.label, tokenHash: hashCaptureSecret(secret), tokenHint: secret.slice(-4), scope: SOURCING_CAPTURE_SCOPE })
      .returning({ id: t.id });
    await audit({ userId: actor.id, userEmail: actor.email, action: "SOURCING_CAPTURE_TOKEN_CREATE", entity: "SOURCING_CAPTURE_TOKEN", entityId: row.id, after: { label: parsed.data.label, hint: secret.slice(-4), scope: SOURCING_CAPTURE_SCOPE } });
    return { ok: true, id: row.id, token, message: "Đã tạo token — chép ngay, ERP chỉ hiện MỘT lần." };
  } catch (e) {
    if (isMissingSourcingTable(e)) return fail(NOT_MIGRATED);
    throw e;
  }
}

const revokeSchema = z.object({ tokenId: z.string().min(1).max(100) });

/** Thu hồi. Chủ token tự thu hồi được; người khác cần `mayRevokeOthers` (quyền `sourcing:approve`, action kiểm). Hai lần không ghi thêm. */
export async function revokeCaptureToken(actor: CaptureTokenActor, input: z.input<typeof revokeSchema>, mayRevokeOthers: boolean): Promise<CaptureTokenResult> {
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return fail("Thiếu token.");
  try {
    const db = await getDb();
    const t = schema.sourcingCaptureTokens;
    const [row] = await db.select().from(t).where(eq(t.id, parsed.data.tokenId)).limit(1);
    if (!row) return fail("Không thấy token.");
    if (row.userId !== actor.id && !mayRevokeOthers) return fail("Chỉ chủ token hoặc người có quyền duyệt tìm hàng mới thu hồi được.");
    if (row.revokedAt) return { ok: true, id: row.id, message: "Token đã thu hồi từ trước." };
    const revokedAt = new Date();
    await db.update(t).set({ revokedAt, revokedBy: actor.id }).where(and(eq(t.id, row.id), isNull(t.revokedAt)));
    await audit({ userId: actor.id, userEmail: actor.email, action: "SOURCING_CAPTURE_TOKEN_REVOKE", entity: "SOURCING_CAPTURE_TOKEN", entityId: row.id, before: { revokedAt: null }, after: { revokedAt, ownerId: row.userId, hint: row.tokenHint } });
    return { ok: true, id: row.id, message: "Đã thu hồi — tiện ích dùng token này sẽ bị từ chối ngay lượt sau." };
  } catch (e) {
    if (isMissingSourcingTable(e)) return fail(NOT_MIGRATED);
    throw e;
  }
}

/** Token của một người (hoặc của mọi người khi `userId = null`) — không bao giờ trả băm. Bảng chưa có ⇒ `null`. */
export async function listCaptureTokens(userId: string | null): Promise<CaptureTokenView[] | null> {
  try {
    const db = await getDb();
    const t = schema.sourcingCaptureTokens;
    const rows = await db
      .select({ id: t.id, userId: t.userId, userName: schema.users.name, label: t.label, hint: t.tokenHint, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt })
      .from(t)
      .leftJoin(schema.users, eq(schema.users.id, t.userId))
      .where(userId ? eq(t.userId, userId) : undefined)
      .orderBy(desc(t.createdAt))
      .limit(200);
    return rows;
  } catch (e) {
    if (isMissingSourcingTable(e)) return null;
    throw e;
  }
}

export type CaptureAuthFailure = { status: 401 | 402 | 403 | 503; error: string };
export type CaptureAuthContext = { orgCode: string; tokenId: string; user: SessionUser };

/** Câu DUY NHẤT cho mọi token sai: không nói tổ chức có tồn tại không, token có từng đúng không. */
const BAD_TOKEN: CaptureAuthFailure = { status: 401, error: "Token không hợp lệ hoặc đã thu hồi — tạo token mới ở ERP › Tìm hàng nguồn › Tiện ích 1688." };

/**
 * CỔNG của POST /api/sourcing/capture: token ⇒ tổ chức ⇒ (trong ngữ cảnh tổ chức) module bật · token còn hiệu lực · người ĐANG BẬT
 * · quyền `sourcing:write` · cổng thu phí ⇒ chạy `handler`. Mọi nhánh lỗi rơi về phía HẸP (AGENTS 31): không bao giờ rơi về tổ chức
 * nhà, không bao giờ chạy `handler` khi chưa qua đủ.
 */
export async function authenticateCaptureToken<T>(authorization: string | null, handler: (ctx: CaptureAuthContext) => Promise<T>): Promise<T | CaptureAuthFailure> {
  const raw = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1] ?? "";
  const parsed = parseCaptureToken(raw);
  if (!parsed) return BAD_TOKEN;
  const org = await findOrganization(parsed.orgCode);
  if (!org || !isOperationalOrganization(org)) return BAD_TOKEN;
  return withOrganization(org.code, async (): Promise<T | CaptureAuthFailure> => {
    if (!(await canUseModule("sourcing", org.code))) return { status: 403, error: "Tổ chức chưa bật module Tìm hàng nguồn." };
    const t = schema.sourcingCaptureTokens;
    let row: { id: string; userId: string } | undefined;
    try {
      const db = await getDb();
      [row] = await db
        .select({ id: t.id, userId: t.userId })
        .from(t)
        .where(and(eq(t.tokenHash, hashCaptureSecret(parsed.secret)), isNull(t.revokedAt), eq(t.scope, SOURCING_CAPTURE_SCOPE)))
        .limit(1);
    } catch (e) {
      if (isMissingSourcingTable(e)) return { status: 503, error: NOT_MIGRATED };
      throw e;
    }
    if (!row) return BAD_TOKEN;
    const user = await activeSessionUserById(row.userId);
    if (!user) return BAD_TOKEN;
    if (!can(user, "sourcing:write")) return { status: 403, error: "Tài khoản của token không còn quyền «Tìm hàng: lưu & sửa mẫu»." };
    if (billingLockApplies(org)) {
      const standing = await orgBillingStanding(org);
      if (billingWriteDenied({ isHome: org.isHome, standing: standing.kind, method: "POST", path: SOURCING_CAPTURE_PATH })) return { status: 402, error: "Tổ chức đang ở chế độ chỉ xem (quá hạn thanh toán) — chưa lưu được mẫu." };
    }
    const db = await getDb();
    await db.update(t).set({ lastUsedAt: new Date() }).where(eq(t.id, row.id));
    return handler({ orgCode: org.code, tokenId: row.id, user });
  });
}

export function isCaptureAuthFailure(x: unknown): x is CaptureAuthFailure {
  return !!x && typeof x === "object" && "status" in x && "error" in x && typeof (x as { status: unknown }).status === "number";
}

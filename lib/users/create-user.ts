/**
 * ═══════════ ĐƯỜNG GHI DUY NHẤT TẠO TÀI KHOẢN NGƯỜI DÙNG (trong CSDL của tổ chức ngữ cảnh) ═══════════
 *
 * Hai cửa tạo người dùng, MỘT đường ghi:
 *  · quản trị tạo hộ và đặt mật khẩu (`createUser` — lib/actions/users.ts → `createUserCore`);
 *  · nhân viên nhận lời mời và tự đặt mật khẩu (`acceptUserInviteCore` — lib/users/invites.ts).
 * Cả hai qua `checkNewUserAccount` (email trùng, hạn mức gói) → `insertUserAccount` (băm mật khẩu, vai trò, vai trò tuỳ
 * chỉnh, phạm vi dữ liệu) → `auditUserCreate` → `indexNewUserAccount` (chỉ mục đăng nhập: email ⇒ tổ chức, để người mới
 * đăng nhập ở trang chung KHÔNG cần mã tổ chức — P0 08/10/2026). Viết một câu `insert(users)` thứ hai là mở đường cho hai
 * cửa lệch nhau: một cửa quên băm, một cửa quên hạn mức, một cửa quên chỉ mục.
 *
 * Tách khỏi tệp "use server": mọi export ở đó là một cửa gọi được từ trình duyệt, và bài kiểm cần gọi đúng lõi này
 * không qua cookie của Next.
 */
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { Role } from "@/db/schema";
import { audit } from "@/lib/audit";
import { indexAccountInCurrentOrganization } from "@/lib/auth/identities";
import { hashPassword } from "@/lib/auth/password";
import { can, type SessionUser } from "@/lib/auth/session";
import { normalizeScope, type AccessScope } from "@/lib/constants/access-scope";
import { checkEntitlement } from "@/lib/entitlements/check";
import { createUserSchema } from "@/lib/validation/users";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** CSDL ngữ cảnh hoặc một giao dịch đang mở trên nó — đường ghi dùng được trong cả hai. */
export type UserWriter = Pick<Tx, "insert">;

export type NewUserAccount = {
  email: string;
  name: string;
  password: string;
  role: Role;
  /** Vai trò tuỳ chỉnh (`access_roles.id`); `null` = mẫu quyền của vai trò hệ thống. */
  accessRoleId?: string | null;
  /** Phạm vi dữ liệu; bỏ trống ⇒ `ALL` (mặc định của cột — không tài khoản nào bị thu hẹp ngầm). */
  dataScope?: AccessScope;
};

export const USER_EMAIL_TAKEN = "Email này đã được sử dụng";

export type NewUserGate = { ok: true } | { ok: false; code: "EMAIL_TAKEN" | "PLAN_LIMIT"; error: string };

/**
 * Lời mời còn hạn chưa dùng — "ghế đã hứa". Cửa tạo hộ và cửa tạo lời mời tính chúng vào mức dùng của gói, để một tổ
 * chức gói 3 người không phát được 10 liên kết rồi 7 người bấm vào mới biết là hết chỗ.
 */
export async function pendingUserInviteCount(): Promise<number> {
  const db = await getDb();
  const t = schema.userInvites;
  const [r] = await db
    .select({ n: count() })
    .from(t)
    .where(and(isNull(t.acceptedAt), isNull(t.revokedAt), gt(t.expiresAt, sql`now()`)));
  return Number(r?.n ?? 0);
}

/**
 * Kiểm TRƯỚC khi ghi: email đã là tài khoản? gói còn chỗ? ĐỌC CSDL ngữ cảnh — gọi NGOÀI giao dịch (PGlite chỉ có một
 * kết nối: một câu đọc ngoài giao dịch đang mở sẽ đợi chính giao dịch ấy mãi mãi).
 *
 * `reserved`: số ghế đã hứa cho lời mời còn hạn, cộng vào lượt kiểm (xem `pendingUserInviteCount`). Lượt NHẬN một lời
 * mời truyền 0 — ghế của chính nó đã nằm trong số đó.
 */
export async function checkNewUserAccount(email: string, opts: { reserved?: number } = {}): Promise<NewUserGate> {
  const db = await getDb();
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email), columns: { id: true } });
  if (existing) return { ok: false, code: "EMAIL_TAKEN", error: USER_EMAIL_TAKEN };
  // Hạn mức gói (Phase 10 · §5): tổ chức nhà không giới hạn và không đếm gì.
  const reserved = Math.max(0, Math.floor(opts.reserved ?? 0));
  const ent = await checkEntitlement("users", 1 + reserved);
  if (!ent.ok) return { ok: false, code: "PLAN_LIMIT", error: reserved > 0 ? `${ent.error} (đã tính ${reserved} lời mời còn hạn chưa dùng — thu hồi bớt lời mời nếu không cần)` : ent.error };
  return { ok: true };
}

/** Chèn MỘT tài khoản — băm mật khẩu ở đây, không nơi nào khác. */
export async function insertUserAccount(writer: UserWriter, data: NewUserAccount): Promise<{ id: string }> {
  const [row] = await writer
    .insert(schema.users)
    .values({
      email: data.email,
      name: data.name,
      role: data.role,
      passwordHash: await hashPassword(data.password),
      active: true,
      accessRoleId: data.accessRoleId ?? null,
      dataScope: normalizeScope(data.dataScope ?? "ALL"),
    })
    .returning({ id: schema.users.id });
  return row;
}

/** Nhật ký `USER_CREATE` — cùng một dạng cho cả hai cửa; `via` nói tài khoản ra đời bằng đường nào. */
export async function auditUserCreate(actor: { id: string | null; email: string }, userId: string, data: NewUserAccount, extra: { via: "ADMIN" | "INVITE"; inviteId?: string } = { via: "ADMIN" }) {
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    action: "USER_CREATE",
    entity: "USER",
    entityId: userId,
    detail: {
      email: data.email,
      name: data.name,
      role: data.role,
      ...(data.accessRoleId ? { accessRoleId: data.accessRoleId } : {}),
      ...(data.dataScope && data.dataScope !== "ALL" ? { scope: data.dataScope } : {}),
      via: extra.via,
      ...(extra.inviteId ? { inviteId: extra.inviteId } : {}),
    },
  });
}

/**
 * Chỉ mục đăng nhập của tài khoản VỪA tạo (lib/auth/identities.ts) — cùng cho hai cửa, gọi SAU khi dòng `users` chắc chắn đã có
 * (giao dịch nhận lời mời đã chốt: ghi chỉ mục trong giao dịch rồi giao dịch lùi thì chỉ mục trỏ vào một tài khoản không tồn tại).
 * Tổ chức = đúng tổ chức `getDb()` vừa ghi vào. Thiếu bước này thì người mới chỉ đăng nhập được khi gõ «mã tổ chức».
 */
export async function indexNewUserAccount(userId: string, data: Pick<NewUserAccount, "email">) {
  await indexAccountInCurrentOrganization({ id: userId, email: data.email });
}

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/** Lõi của `createUser`: quản trị tạo hộ, tự đặt mật khẩu. */
export async function createUserCore(user: SessionUser, input: unknown): Promise<{ ok: true; id: string } | { error: string }> {
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const gate = await checkNewUserAccount(data.email, { reserved: await pendingUserInviteCount() });
  if (!gate.ok) return { error: gate.error };
  const db = await getDb();
  const account: NewUserAccount = { email: data.email, name: data.name, password: data.password, role: data.role };
  const row = await insertUserAccount(db, account);
  await auditUserCreate({ id: user.id, email: user.email }, row.id, account);
  await indexNewUserAccount(row.id, account);
  return { ok: true, id: row.id };
}

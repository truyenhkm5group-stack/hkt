import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { normalizeEmail, normalizePhone, type IdentityKind } from "@/lib/auth/identity-shared";
import { currentOrganization } from "@/lib/platform/context";
import { listOrganizations } from "@/lib/platform/organizations";

/**
 * ═══════════ CHỈ MỤC DANH TÍNH TOÀN NỀN TẢNG (`platform_identities`, 0193) — CHỈ MÁY CHỦ ═══════════
 *
 * Trả lời đúng MỘT câu: «danh tính này có tài khoản ở những tổ chức nào?» — để khách đăng nhập ở trang chung mà không
 * phải nhớ mã tổ chức. KHÔNG là nguồn sự thật của tài khoản: mật khẩu, quyền, khoá vẫn đọc ở CSDL tổ chức mỗi lượt, và
 * dòng trỏ tới tổ chức không còn hoạt động bị bỏ qua lúc đọc.
 *
 * ─── HAI LÚC GHI, MỘT ĐƯỜNG GHI (`indexAccountIdentities`) — P0 08/10/2026 ───
 *
 * Bản cũ chỉ ghi SAU lượt đăng nhập thành công đầu tiên, mà lượt đầu ấy lại cần chỉ mục mới tìm ra tổ chức: quản trị khách do
 * người vận hành tạo (job cấp phát) kích hoạt xong vẫn bị «sai mật khẩu» ở `/login` cho tới khi gõ «mã tổ chức» — thứ khách
 * không biết là gì (báo cáo Finish Line 08/10/2026 — PR #680, blocker 1). Nay:
 *  · TÀI KHOẢN VỪA ĐĂNG NHẬP ĐƯỢC BẰNG MẬT KHẨU — cấp phát quản trị (`provisionOrganization`), quản trị tạo hộ / nhân viên nhận
 *    lời mời (`lib/users/create-user.ts`), đặt mật khẩu qua liên kết, quản trị đặt mật khẩu tay, MỞ KHOÁ tài khoản, đối chiếu dữ
 *    liệu cũ (`lib/platform/identity-reconcile.ts`): `last_used_at = NULL` — chỉ mục CÓ, nhưng CHƯA AI DÙNG nó để đăng nhập.
 *  · ĐĂNG NHẬP THÀNH CÔNG (`verifyLogin` — màn đăng nhập, đăng ký, nhận lời mời; Google / Facebook): `last_used_at = lúc đó`.
 *
 * `last_used_at` khác NULL = «danh tính này ĐÃ được dùng để đăng nhập vào ĐÚNG tài khoản này». Hai chỗ đọc dựa vào nó: ô «Người
 * đã đăng nhập» của trang khách (đếm người đã vào, không đếm lời mời — `workspaceReach`), và phép khớp EMAIL của Google /
 * Facebook (`lib/auth/social.ts`): email do quản trị GÕ, chưa ai xác minh, nên nó chỉ mở đường vào KHÔNG mật khẩu sau khi chính
 * tài khoản ấy đã từng vào bằng mật khẩu — đúng phạm vi như trước bản này, không rộng thêm (IDENTITY.md §1 quan sát 2).
 *
 * Ghi hỏng KHÔNG làm hỏng lượt gọi: chỉ mục là tiện ích, đường «mã tổ chức» vẫn còn, và mọi lượt kích hoạt / đăng nhập sau ghi
 * lại (idempotent — khoá duy nhất `(kind, value, org_code)`, chạy lại không đẻ dòng thứ hai).
 */

export type IdentityHit = { orgCode: string; userId: string };

/**
 * Ghi một dòng chỉ mục. `usedAt` = mốc ĐĂNG NHẬP (mặc định: bây giờ) hoặc `null` = chỉ ghi chỉ mục, không phải một lượt đăng nhập.
 * Trùng khoá ⇒ cập nhật đúng tài khoản; với `null`, mốc dùng GIỮ NGUYÊN khi dòng vẫn trỏ cùng tài khoản (chạy lại cấp phát không xoá
 * được dấu «đã đăng nhập») và về NULL khi dòng ĐỔI CHỦ — «đã dùng» là của cặp (danh tính, tài khoản), không truyền sang tài khoản khác.
 * Trả `false` khi không ghi được (đã cảnh báo ra log) — đối chiếu đếm nó; nơi khác bỏ qua.
 */
export async function recordIdentity(kind: IdentityKind, value: string, orgCode: string, userId: string, usedAt: Date | null = new Date()): Promise<boolean> {
  if (!value) return false;
  try {
    const pdb = await getPlatformDb();
    const t = schema.platformIdentities;
    await pdb
      .insert(t)
      .values({ kind, value, orgCode, userId, lastUsedAt: usedAt })
      .onConflictDoUpdate({
        target: [t.kind, t.value, t.orgCode],
        // Tên cột viết ĐỦ bảng: trong ON CONFLICT DO UPDATE, tên trần là mơ hồ giữa dòng cũ và `excluded`.
        set: usedAt ? { userId, lastUsedAt: usedAt } : { userId, lastUsedAt: sql`case when "platform_identities"."user_id" = excluded."user_id" then "platform_identities"."last_used_at" else null end` },
      });
    return true;
  } catch (error) {
    console.warn(`[identities] không ghi được ${kind} cho ${orgCode}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Tổ chức ĐANG HOẠT ĐỘNG có danh tính này. Thứ tự TẤT ĐỊNH: mới dùng nhất trước, chưa dùng cuối, rồi theo mã tổ chức — danh sách
 * «chọn cửa hàng» không đổi chỗ giữa hai lượt bấm. `usedOnly` = chỉ dòng đã từng dùng để đăng nhập (phép khớp email của Google /
 * Facebook — xem đầu tệp). Bảng chưa có (máy chưa migrate) ⇒ rỗng.
 */
export async function findIdentity(kind: IdentityKind, value: string, opts: { usedOnly?: boolean } = {}): Promise<IdentityHit[]> {
  if (!value) return [];
  let rows: { orgCode: string; userId: string }[] = [];
  try {
    const pdb = await getPlatformDb();
    const t = schema.platformIdentities;
    rows = await pdb
      .select({ orgCode: t.orgCode, userId: t.userId })
      .from(t)
      .where(and(eq(t.kind, kind), eq(t.value, value), opts.usedOnly ? isNotNull(t.lastUsedAt) : undefined))
      .orderBy(sql`${t.lastUsedAt} desc nulls last`, asc(t.orgCode), asc(t.userId))
      .limit(20);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const active = new Set((await listOrganizations()).filter((o) => o.status === "ACTIVE").map((o) => o.code));
  return rows.filter((r) => active.has(r.orgCode));
}

/** Tài khoản cần ghi chỉ mục — đúng các cột của dòng `users` trong CSDL tổ chức. `active` bỏ trống = đang bật. */
export type IndexableAccount = { id: string; email: string | null; phone?: string | null; active?: boolean };

/**
 * ĐƯỜNG GHI DUY NHẤT cho email / SĐT của một tài khoản (xem đầu tệp). Chỉ ghi giá trị ĐÃ ở dạng chuẩn — đúng chuỗi mà màn đăng
 * nhập tra (`parseLoginIdentifier` ⇒ `findUserByIdentifier`): giá trị lệch dạng thì tài khoản ấy vốn không đăng nhập bằng nó
 * được, ghi vào chỉ đẻ một dòng không ai khớp. Tài khoản đang KHOÁ không ghi (đăng nhập không mở được nó); dòng cũ của nó GIỮ —
 * chỉ mục chỉ HẸP lại lúc đọc, và người bị khoá gõ đúng mật khẩu nhận đúng câu «Tài khoản đã bị khoá», không phải «sai mật khẩu».
 * Vì lượt ghi bỏ qua tài khoản khoá, MỞ KHOÁ (`lib/actions/users.ts`) gọi lại hàm này — tài khoản bị khoá trước khi kịp có dòng
 * vẫn vào được không cần mã tổ chức ngay sau khi mở.
 */
export async function indexAccountIdentities(orgCode: string, account: IndexableAccount, opts: { usedAt?: Date | null } = {}): Promise<{ written: number; failed: number }> {
  const out = { written: 0, failed: 0 };
  if (account.active === false || !orgCode || !account.id) return out;
  const usedAt = opts.usedAt === undefined ? null : opts.usedAt;
  const values: [IdentityKind, string][] = [];
  if (account.email && normalizeEmail(account.email) === account.email) values.push(["EMAIL", account.email]);
  if (account.phone && normalizePhone(account.phone) === account.phone) values.push(["PHONE", account.phone]);
  for (const [kind, value] of values) {
    if (await recordIdentity(kind, value, orgCode, account.id, usedAt)) out.written += 1;
    else out.failed += 1;
  }
  return out;
}

/**
 * `indexAccountIdentities` cho ĐÚNG tổ chức mà `getDb()` vừa ghi vào: ngữ cảnh tường minh (`withOrganization` — nhận lời mời) hoặc
 * claim `org` của phiên (quản trị tạo hộ / đặt mật khẩu ở /settings/users). Cùng một hàm chọn CSDL thì không thể ghi chỉ mục cho
 * tổ chức này mà dòng `users` nằm ở tổ chức kia.
 */
export async function indexAccountInCurrentOrganization(account: IndexableAccount): Promise<{ written: number; failed: number }> {
  return indexAccountIdentities((await currentOrganization()).code, account);
}

/** Gỡ mọi danh tính của một tài khoản (tài khoản bị xoá). Chưa có nơi gọi: ERP không có đường xoá tài khoản — chỉ KHOÁ. */
export async function forgetIdentitiesOf(orgCode: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const pdb = await getPlatformDb();
  const t = schema.platformIdentities;
  await pdb.delete(t).where(and(eq(t.orgCode, orgCode), inArray(t.userId, [...userIds])));
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { jwtVerify } from "jose";
import { middleware } from "@/middleware";
import { schema, type Db } from "@/db";
import { signSession, type SessionIdentity } from "@/lib/auth/session";
import { RevokeReasonRequired, applySessionRevocation } from "@/lib/auth/session-revoke";
import { SESSION_COOKIE, claimsFrom } from "@/lib/constants/session";
import {
  DENY_REASON_MESSAGE,
  DENY_REASON_PARAM,
  LOGIN_REASONS_STAY,
  REVOKE_AUDIT_ACTION,
  loginShouldStay,
  revokeMarkFrom,
  sessionRevoked,
} from "@/lib/constants/session-revocation";

/**
 * ═══════════ THU HỒI PHIÊN: TOKEN KÝ ĐÚNG VẪN PHẢI CHẾT ĐƯỢC ═══════════
 *
 * Trước bản này, đổi mật khẩu KHÔNG làm token cũ chết. Ai cầm được cookie thì dùng tiếp tới khi
 * hết hạn — tức là việc đổi mật khẩu vì nghi lộ không có tác dụng gì trong tối đa 7 ngày, và tới
 * 30 ngày nếu phiên được gia hạn trượt.
 *
 * Bài kiểm này giữ ba điều kéo ngược chiều nhau:
 *
 *   1. thu hồi phải ĂN NGAY, kể cả với token còn hạn và ký đúng;
 *   2. gia hạn trượt KHÔNG được hồi sinh phiên đã thu hồi (đây là chỗ dễ hỏng nhất — và nó hỏng
 *      IM LẶNG: tính năng trông như đang chạy);
 *   3. những việc KHÔNG phải thu hồi (đăng xuất thường, đổi vai trò) không được vô tình thu hồi.
 *
 * Không mốc nào bị ghim thành một ngày tuyệt đối (luật 50): mọi thứ dựng quanh `Date.now()` của
 * chính lượt chạy, hoặc truyền `nowMs` vào một hàm thuần.
 */

const P = "srev-";
const NGAY_MS = 86_400_000;

function khoa() {
  const secret = process.env.AUTH_SECRET?.trim() || (process.env.NODE_ENV === "production" ? "" : "dev-secret-change-me-please-32-chars-min");
  return new TextEncoder().encode(secret);
}

async function tokenVoi(user: SessionIdentity, loginAtSec: number, nowSec: number) {
  return signSession(user, { loginAtSec, nowSec });
}

export async function testSessionRevocation(d: Db) {
  const bayGio = Date.now();
  const A: SessionIdentity = { id: `${P}a`, email: "a@erp.test", name: "Người A", role: "CS" };
  const B: SessionIdentity = { id: `${P}b`, email: "b@erp.test", name: "Người B", role: "CS" };

  await d.insert(schema.users).values([
    { id: A.id, email: A.email, name: A.name, passwordHash: "x", role: "CS", active: true },
    { id: B.id, email: B.email, name: B.name, passwordHash: "x", role: "CS", active: true },
  ]).onConflictDoNothing();

  /* ═══════════ 5 · CỘT NULL ⇒ HÀNH VI KHÔNG ĐỔI SO VỚI HÔM NAY ═══════════

     Đây là điều kiện để bản này deploy được mà không đá ai ra. `NULL` nghĩa là CHƯA TỪNG THU HỒI,
     KHÔNG phải "thu hồi từ năm 1970" — nhầm hai thứ đó là đăng xuất toàn bộ công ty lúc 0 giờ. */

  const chuaThuHoi = await d.query.users.findFirst({ where: eq(schema.users.id, A.id), columns: { sessionInvalidBefore: true } });
  assert.equal(chuaThuHoi?.sessionInvalidBefore ?? null, null, "tài khoản mới phải có mốc thu hồi NULL — migration không được backfill");
  assert.equal(sessionRevoked(Math.floor(bayGio / 1000) - 10 * 86_400, null), false, "cột NULL ⇒ mọi phiên còn hạn vẫn hợp lệ");
  assert.equal(sessionRevoked(0, undefined), false, "undefined cũng là CHƯA TỪNG THU HỒI");

  /* ═══════════ 1 · `lgn` CŨ HƠN MỐC ⇒ BỊ TỪ CHỐI ═══════════ */

  const ketQua = await applySessionRevocation({
    targetUserId: A.id,
    targetEmail: A.email,
    trigger: "SELF_LOGOUT_ALL",
    actor: { id: A.id, label: A.email },
    // Lượt thu hồi xảy ra TRƯỚC lượt gia hạn ở khối 3 — đúng thứ tự của đời thật: người ta bấm thu
    // hồi, rồi một lượt GET nào đó mới chạm tới middleware. Ghim khoảng cách để bài kiểm không phụ
    // thuộc vào việc hai mốc có rơi vào cùng một giây hay không.
    nowMs: bayGio - 5_000,
  });
  assert.ok(ketQua, "phải tìm thấy tài khoản");
  assert.equal(ketQua.before, null, "lần thu hồi ĐẦU TIÊN: giá trị trước phải là null");
  assert.ok(ketQua.advanced, "lần thu hồi đầu tiên luôn làm mốc tiến lên");

  const moc = ketQua.after;
  const lgnCu = Math.floor(bayGio / 1000) - 3 * 86_400;
  assert.equal(sessionRevoked(lgnCu, moc), true, "phiên đăng nhập TRƯỚC lượt thu hồi phải bị từ chối");

  /* ═══════════ 2 · `lgn` MỚI HƠN MỐC ⇒ DÙNG ĐƯỢC NGAY ═══════════

     Thu hồi mà người ta không đăng nhập lại được thì đó là khoá tài khoản, không phải thu hồi. */

  const lgnMoi = Math.ceil(moc.getTime() / 1000) + 1;
  assert.equal(sessionRevoked(lgnMoi, moc), false, "đăng nhập LẠI sau lượt thu hồi phải dùng được ngay");

  /* Mốc làm tròn LÊN tới giây: một lần đăng nhập trong CÙNG giây với lượt thu hồi bị coi là cũ.
     Chiều an toàn — `lgn` chỉ có độ phân giải giây nên hai phía không phân biệt được, và để lọt
     một phiên đáng lẽ đã chết là thứ không được phép đánh đổi. */
  assert.equal(revokeMarkFrom(1_700_000_000_123) % 1000, 0, "mốc thu hồi phải tròn giây");
  assert.ok(revokeMarkFrom(1_700_000_000_123) > 1_700_000_000_123, "và phải làm tròn LÊN, không phải xuống");
  assert.equal(revokeMarkFrom(1_700_000_000_000), 1_700_000_000_000, "đúng đầu giây thì giữ nguyên, không nhảy thêm một giây");

  /* ═══════════ 3 · GIA HẠN TRƯỢT KHÔNG ĐƯỢC HỒI SINH PHIÊN ĐÃ THU HỒI ═══════════

     TIÊU CHÍ QUAN TRỌNG NHẤT CỦA CẢ BÀI. Middleware chạy ở Edge, không có CSDL, nên nó VẪN gia hạn
     cookie của một phiên đã bị thu hồi — nó không có cách nào biết. Điều đó vô hại CHỈ KHI lần ký
     lại giữ NGUYÊN `lgn`. Nếu một ngày ai đó "dọn dẹp" bằng cách lấy `iat` làm mốc, phiên bị thu
     hồi sẽ tự sống lại ở lượt GET kế tiếp — và không có gì báo cho ai biết.

     Nên bài này chạy middleware THẬT, lấy cookie nó trả ra, rồi hỏi lại luật thu hồi. */

  const nowSec = Math.floor(bayGio / 1000);
  const doiToken = 7 * 86_400;
  // Qua nửa đời ⇒ chắc chắn được gia hạn.
  const iatCu = nowSec - Math.floor(doiToken * 0.75);
  const tokenCu = await tokenVoi(A, lgnCu, iatCu);

  const req = new NextRequest("https://erp.test/shipments", { method: "GET" });
  req.cookies.set(SESSION_COOKIE, tokenCu);
  const res = await middleware(req);
  const cookieMoi = res.cookies.get(SESSION_COOKIE)?.value;
  assert.ok(cookieMoi, "middleware phải gia hạn token đã qua nửa đời — kể cả của phiên đã bị thu hồi (Edge không biết)");

  const { payload } = await jwtVerify(cookieMoi, khoa());
  const claims = claimsFrom(payload as Record<string, unknown>);
  assert.ok(claims, "token gia hạn phải đọc được");
  assert.equal(claims.loginAtSec, lgnCu, "gia hạn phải GIỮ NGUYÊN mốc đăng nhập gốc");
  assert.ok(claims.issuedAtSec > iatCu, "và `iat` thì phải mới hơn — đó chính là thứ không được dùng để so");
  assert.equal(sessionRevoked(claims.loginAtSec, moc), true, "SAU KHI GIA HẠN, phiên đã thu hồi vẫn phải bị từ chối");
  assert.equal(sessionRevoked(claims.issuedAtSec, moc), false, "…và đây là bằng chứng vì sao: so với `iat` thì nó đã sống lại rồi");

  /* ═══════════ 4 · THU HỒI CỦA NGƯỜI A KHÔNG ĐỤNG TỚI NGƯỜI B ═══════════ */

  const cuaB = await d.query.users.findFirst({ where: eq(schema.users.id, B.id), columns: { sessionInvalidBefore: true } });
  assert.equal(cuaB?.sessionInvalidBefore ?? null, null, "thu hồi phải đi theo TỪNG người, không phải một công tắc toàn hệ thống");

  /* ═══════════ 6 · MỐC CHỈ TIẾN, KHÔNG BAO GIỜ LÙI ═══════════

     Mốc lùi lại nghĩa là GỠ THU HỒI — lỗi an ninh im lặng nhất trong cả thiết kế, vì hệ thống vẫn
     chạy bình thường sau đó. Khoá ở HAI tầng: `GREATEST` trong câu lệnh, và trigger của CSDL cho
     những câu `UPDATE` gõ tay không đi qua mã ứng dụng. */

  const luiMotNgay = new Date(moc.getTime() - NGAY_MS);
  const lui = await applySessionRevocation({
    targetUserId: A.id,
    targetEmail: A.email,
    trigger: "SELF_LOGOUT_ALL",
    actor: { id: A.id, label: A.email },
    nowMs: luiMotNgay.getTime(),
  });
  assert.equal(lui?.after.getTime(), moc.getTime(), "GREATEST phải giữ mốc cũ khi lượt ghi mới CŨ HƠN");
  assert.equal(lui?.advanced, false, "và phải nói thẳng rằng lượt ghi này không làm mốc tiến lên");

  // Trigger CSDL: một câu UPDATE trần, không qua ứng dụng.
  await d.execute(sql`UPDATE "users" SET "session_invalid_before" = ${luiMotNgay.toISOString()}::timestamptz WHERE "id" = ${A.id}`);
  const sauKhiLui = await d.query.users.findFirst({ where: eq(schema.users.id, A.id), columns: { sessionInvalidBefore: true } });
  assert.equal(sauKhiLui?.sessionInvalidBefore?.getTime(), moc.getTime(), "trigger CSDL phải chặn cả câu UPDATE gõ tay kéo mốc lùi");

  await d.execute(sql`UPDATE "users" SET "session_invalid_before" = NULL WHERE "id" = ${A.id}`);
  const sauKhiXoa = await d.query.users.findFirst({ where: eq(schema.users.id, A.id), columns: { sessionInvalidBefore: true } });
  assert.equal(sauKhiXoa?.sessionInvalidBefore?.getTime(), moc.getTime(), "xoá mốc về NULL là GỠ THU HỒI — trigger phải chặn");

  // Tiến lên thì phải đi được, nếu không thì luật này biến thành "thu hồi đúng một lần mãi mãi".
  const tien = await applySessionRevocation({
    targetUserId: A.id,
    targetEmail: A.email,
    trigger: "PASSWORD_RESET",
    actor: { id: A.id, label: A.email },
    nowMs: moc.getTime() + NGAY_MS,
  });
  assert.ok(tien && tien.after.getTime() > moc.getTime(), "mốc MỚI HƠN phải ghi được");
  assert.equal(tien.before?.getTime(), moc.getTime(), "và nhật ký phải in đúng giá trị ngay trước lượt ghi");
  assert.ok(tien.advanced, "lượt ghi tiến lên phải được đánh dấu là có tiến");

  /* ═══════════ 9 · MỘT LƯỢT THU HỒI ⇒ ĐÚNG MỘT DÒNG NHẬT KÝ, CÓ KHOÁ TÀI KHOẢN, CÓ TRƯỚC→SAU ═══════════ */

  const nhatKy = await d.query.auditLogs.findMany({
    where: and(eq(schema.auditLogs.entityId, A.id), eq(schema.auditLogs.action, REVOKE_AUDIT_ACTION)),
  });
  assert.equal(nhatKy.length, 3, "ba lượt gọi ⇒ ba dòng nhật ký, kể cả lượt không làm mốc tiến lên (nó vẫn là một hành động của người)");
  for (const dong of nhatKy) {
    assert.equal(dong.userId, A.id, "nhật ký phải mang KHOÁ TÀI KHOẢN, không chỉ ô chữ (luật 34)");
    const chiTiet = dong.detail as Record<string, unknown>;
    assert.ok("before" in chiTiet && "after" in chiTiet, "thiếu trước→sau thì không phân biệt được lần thu hồi ĐẦU với lần thu hồi LẠI");
    assert.ok(typeof chiTiet.trigger === "string", "phải ghi NGUYÊN NHÂN thu hồi");
  }
  const lanDau = nhatKy.find((r) => (r.detail as { before?: { sessionInvalidBefore?: unknown } } | null)?.before?.sessionInvalidBefore === null);
  assert.ok(lanDau, "phải phân biệt được lần thu hồi đầu tiên (trước = null) với các lần sau");

  /* ═══════════ 10 · `ADMIN_REVOKE` THIẾU LÝ DO ⇒ BỊ TỪ CHỐI, VÀ KHÔNG GHI GÌ ═══════════

     "Không ghi gì" là vế quan trọng: một lượt bị từ chối mà vẫn đẩy mốc lên thì người dùng bị đá
     ra vì một thao tác đã thất bại. */

  const mocTruoc = tien.after;
  const soDongTruoc = (await d.query.auditLogs.findMany({ where: eq(schema.auditLogs.entityId, B.id) })).length;
  await assert.rejects(
    () =>
      applySessionRevocation({
        targetUserId: B.id,
        targetEmail: B.email,
        trigger: "ADMIN_REVOKE",
        reason: "   ",
        actor: { id: A.id, label: A.email },
      }),
    RevokeReasonRequired,
    "quản trị thu hồi phiên người khác mà không nêu lý do phải bị từ chối",
  );
  const bSauKhiTuChoi = await d.query.users.findFirst({ where: eq(schema.users.id, B.id), columns: { sessionInvalidBefore: true } });
  assert.equal(bSauKhiTuChoi?.sessionInvalidBefore ?? null, null, "lượt bị từ chối KHÔNG được đụng vào mốc");
  assert.equal((await d.query.auditLogs.findMany({ where: eq(schema.auditLogs.entityId, B.id) })).length, soDongTruoc, "lượt bị từ chối KHÔNG được ghi nhật ký");

  // Có lý do thì đi được, và lý do phải nằm trong nhật ký.
  const coLyDo = await applySessionRevocation({
    targetUserId: B.id,
    targetEmail: B.email,
    trigger: "ADMIN_REVOKE",
    reason: "nhân viên báo mất điện thoại đang đăng nhập ERP",
    actor: { id: A.id, label: A.email },
  });
  assert.ok(coLyDo, "có lý do thì phải thu hồi được");
  const dongAdmin = await d.query.auditLogs.findMany({ where: and(eq(schema.auditLogs.entityId, B.id), eq(schema.auditLogs.action, REVOKE_AUDIT_ACTION)) });
  assert.equal(dongAdmin.length, 1, "đúng một dòng cho lượt thu hồi có lý do");
  assert.match(String((dongAdmin[0].detail as { reason?: string }).reason ?? ""), /mất điện thoại/, "lý do phải đi vào nhật ký, không chỉ dừng ở màn hình");
  assert.equal(dongAdmin[0].userId, A.id, "nhật ký phải ghi NGƯỜI BẤM, không phải người bị thu hồi");
  assert.equal(mocTruoc.getTime(), tien.after.getTime(), "thu hồi B không được đụng mốc của A");

  /* ═══════════ 7 · ĐĂNG XUẤT THƯỜNG KHÔNG CHẠM VÀO CỘT ═══════════
     ═══════════ 8 · ĐỔI VAI TRÒ / QUYỀN KHÔNG THU HỒI PHIÊN ═══════════

     Hai tiêu chí này nói về những đường KHÔNG được gọi tới thu hồi, nên chúng được khoá ở mức MÃ
     NGUỒN: một lời gọi thừa lọt vào đây thì không bài kiểm hành vi nào bắt được — mọi thứ vẫn
     "chạy", chỉ là cả đội bị đá ra mỗi lần quản trị sửa một cái nhãn, và họ sẽ học cách bỏ qua
     thông báo phiên. */

  const goc = path.resolve(__dirname, "..");
  const nguonAuth = readFileSync(path.join(goc, "lib/actions/auth.ts"), "utf8");
  assert.ok(!/applySessionRevocation/.test(nguonAuth), "đăng xuất thường chỉ xoá cookie của MÁY NÀY — không được thu hồi mọi thiết bị");

  const nguonUsers = readFileSync(path.join(goc, "lib/actions/users.ts"), "utf8");
  for (const ham of ["updateUserPermissions", "saveRolePermissions"]) {
    const bat = nguonUsers.indexOf(`export async function ${ham}`);
    assert.ok(bat > 0, `không tìm thấy ${ham}`);
    const ket = nguonUsers.indexOf("\nexport async function", bat + 1);
    const than = nguonUsers.slice(bat, ket === -1 ? undefined : ket);
    assert.ok(!/applySessionRevocation/.test(than), `${ham} KHÔNG được thu hồi phiên — quyền đã nạp lại từ CSDL ở mọi lượt gọi`);
  }

  // Còn bốn đường PHẢI thu hồi thì phải thực sự gọi tới.
  for (const ham of ["updateUser", "setUserActive", "resetUserPassword", "changeMyPassword"]) {
    const bat = nguonUsers.indexOf(`export async function ${ham}`);
    const ket = nguonUsers.indexOf("\nexport async function", bat + 1);
    const than = nguonUsers.slice(bat, ket === -1 ? undefined : ket);
    assert.ok(/applySessionRevocation/.test(than), `${ham} PHẢI thu hồi phiên`);
  }

  /* ═══════════ 11 · BA NGUYÊN NHÂN TỪ CHỐI ⇒ BA CÂU KHÁC NHAU ═══════════

     Trước bản này cả ba đều ra `?reason=inactive` — tức là nói với một nhân viên rằng tài khoản họ
     bị khoá trong khi tài khoản hoàn toàn bình thường, và họ đi gọi quản trị. */

  const thamSo = Object.values(DENY_REASON_PARAM);
  assert.equal(new Set(thamSo).size, 3, "ba nguyên nhân phải có ba tham số `?reason=` khác nhau");
  const cau = thamSo.map((r) => DENY_REASON_MESSAGE[r]);
  assert.equal(new Set(cau).size, 3, "…và ba CÂU khác nhau, không phải ba mã cùng một câu");
  for (const c of cau) assert.ok(c && c.length > 10, "mỗi nguyên nhân phải có câu giải thích thật");

  /* VÒNG LẶP CHUYỂN HƯỚNG. `/login` chỉ kiểm chữ ký và hạn, nên một phiên BỊ THU HỒI vẫn trông
     hợp lệ với nó. Thiếu một lý do trong danh sách "ở lại" là người dùng bị đẩy qua đẩy lại giữa
     `/login` và trang trong cho tới khi trình duyệt báo ERR_TOO_MANY_REDIRECTS — và họ mất hẳn
     đường đăng nhập lại. */
  for (const r of thamSo) assert.ok(loginShouldStay(r), `\`?reason=${r}\` phải giữ người dùng LẠI trang đăng nhập, nếu không là vòng lặp chuyển hướng`);
  assert.ok(LOGIN_REASONS_STAY.length >= thamSo.length, "danh sách ở-lại phải phủ hết mọi nguyên nhân từ chối");
  assert.equal(loginShouldStay(undefined), false, "không có lý do thì vẫn chuyển hướng như cũ");

  const nguonLogin = readFileSync(path.join(goc, "app/login/page.tsx"), "utf8");
  assert.ok(/loginShouldStay\(params\.reason\)/.test(nguonLogin), "trang đăng nhập phải dùng danh sách dùng chung, không viết lại điều kiện");

  /* ═══════════ DỌN ═══════════ */
  await d.delete(schema.auditLogs).where(sql`${schema.auditLogs.entityId} like ${P + "%"}`);
  await d.delete(schema.users).where(sql`${schema.users.id} like ${P + "%"}`);

  console.log(
    "✓ Thu hồi phiên: token ký đúng vẫn chết được · gia hạn KHÔNG hồi sinh phiên đã thu hồi · mốc chỉ tiến (chặn ở cả GREATEST lẫn trigger CSDL) · thu hồi đi theo từng người · đăng xuất thường và đổi quyền KHÔNG thu hồi · quản trị thu hồi phải nêu lý do · ba nguyên nhân từ chối ba câu khác nhau, không vòng lặp chuyển hướng",
  );
}

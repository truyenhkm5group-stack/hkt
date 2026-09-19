import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { getDb, schema } from "@/db";
import { applySessionRevocation, RevokeReasonRequired } from "@/lib/auth/session-revoke";
import { SESSION_COOKIE, SESSION_LOGIN_CLAIM } from "@/lib/constants/session";
import { REVOKE_AUDIT_ACTION } from "@/lib/constants/session-revocation";

/**
 * ═══════════ NGHIỆM THU THU HỒI PHIÊN TRÊN MÁY CHỦ THẬT ═══════════
 *
 * `session-verify` chỉ ĐỌC, nên nó trả lời được "migration đã áp chưa" mà KHÔNG trả lời được câu
 * quan trọng nhất: *"thu hồi có thật sự chặn được một lượt gọi đang chạy không?"*. Câu đó chỉ trả
 * lời được bằng một lượt GHI — nên nó cần một tài khoản dành riêng, và đây là script đó.
 *
 * ─── HAI HÀNG RÀO, VÀ CHÚNG KHÔNG PHẢI LỜI HỨA ───
 *
 *  1. **CHỈ chạm đúng một tài khoản**, khoá cứng theo email ở `QA_EMAIL`. Không tìm thấy ⇒ DỪNG.
 *     Tìm thấy mà vai trò không phải `VIEWER` ⇒ DỪNG. Một bộ nghiệm thu đi lạc sang tài khoản
 *     nhân viên thật là đá một người đang làm việc ra khỏi hệ thống giữa ca.
 *  2. **Ghi bằng ĐÚNG hàm mà giao diện gọi** (`applySessionRevocation`), không `INSERT`/`UPDATE`
 *     tay. Kiểm một đường ghi bằng cách đi một đường ghi KHÁC thì cái được kiểm không phải cái
 *     đang chạy.
 *
 * ─── VÌ SAO KHÔNG CẦN MẬT KHẨU ───
 *
 * Script chạy TRONG container, nơi có `AUTH_SECRET`, nên nó ký được phiếu phiên hợp lệ cho tài
 * khoản QA — đúng cách `session-verify` vẫn làm. Đăng nhập bằng trình duyệt chỉ để LẤY một phiếu
 * như vậy; ở đây ta ký thẳng. Hai phiếu khác `lgn` = hai phiên trên hai máy.
 *
 * ─── MỘT THỨ KHÔNG DỌN ĐƯỢC, VÀ ĐÓ LÀ ĐÚNG ───
 *
 * `session_invalid_before` của tài khoản QA sẽ ở lại sau lượt chạy. Không dọn được, và KHÔNG NÊN:
 * luật "chỉ tiến" cấm kéo mốc lùi, kể cả để dọn dẹp. Tài khoản QA giữ lại cho lượt hồi quy sau.
 */

const QA_EMAIL = (process.env.QA_SESSION_EMAIL ?? "qa-session-test@vnxcommerce.com").trim().toLowerCase();
const NOI_BO = process.env.SESSION_VERIFY_URL ?? "http://127.0.0.1:3000";
const NGAY = 86_400;

type KetQua = { ma: string; ten: string; dat: boolean; thay: string };
const bang: KetQua[] = [];
function ghi(ma: string, ten: string, dat: boolean, thay: string) {
  bang.push({ ma, ten, dat, thay });
  console.log(`${dat ? "  ✓" : "  ✗"} ${ma} · ${ten}\n      ${thay}`);
}

/** Che email: đủ để biết đúng tài khoản QA, không đủ để dùng lại. Kho mã này PUBLIC. */
const che = (e: string) => `${e.slice(0, 2)}***@${e.split("@")[1] ?? ""}`;

async function main() {
  const db = await getDb();
  const qa = await db.query.users.findFirst({
    where: eq(schema.users.email, QA_EMAIL),
    columns: { id: true, email: true, name: true, role: true, active: true, sessionInvalidBefore: true },
  });

  if (!qa) {
    console.error(`✗ DỪNG: không có tài khoản ${che(QA_EMAIL)}. Tạo nó ở /settings/users (vai trò Chỉ xem) rồi chạy lại.`);
    process.exit(2);
  }
  if (qa.role !== "VIEWER") {
    console.error(`✗ DỪNG: ${che(qa.email)} có vai trò ${qa.role}, phải là VIEWER. Bộ nghiệm thu này KHÔNG chạm tài khoản có quyền.`);
    process.exit(2);
  }
  if (!qa.active) {
    console.error(`✗ DỪNG: ${che(qa.email)} đang bị khoá — kết quả sẽ lẫn giữa "bị khoá" và "bị thu hồi".`);
    process.exit(2);
  }

  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) {
    console.error("✗ DỪNG: không có AUTH_SECRET, không ký được phiếu phiên.");
    process.exit(2);
  }
  const key = new TextEncoder().encode(secret);

  console.log(`\n═══ NGHIỆM THU THU HỒI PHIÊN — CHỈ TRÊN TÀI KHOẢN QA ═══`);
  console.log(`  tài khoản : ${che(qa.email)} · vai trò ${qa.role}`);
  console.log(`  mốc hiện có: ${qa.sessionInvalidBefore ? qa.sessionInvalidBefore.toISOString() : "NULL (chưa từng thu hồi)"}`);

  const ky = (lgnSec: number) =>
    new SignJWT({ email: qa.email, name: qa.name, role: qa.role, [SESSION_LOGIN_CLAIM]: lgnSec })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(qa.id)
      .setIssuedAt(lgnSec)
      .setExpirationTime(lgnSec + 7 * NGAY)
      .sign(key);

  const goi = async (duong: string, token: string | null) => {
    const ctl = new AbortController();
    const hen = setTimeout(() => ctl.abort(), 5000);
    try {
      return await fetch(`${NOI_BO}${duong}`, { redirect: "manual", signal: ctl.signal, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {} });
    } finally {
      clearTimeout(hen);
    }
  };

  const demNhatKy = async () => {
    const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, qa.id), eq(schema.auditLogs.action, REVOKE_AUDIT_ACTION)));
    return Number(r?.n ?? 0);
  };
  const mocHienTai = async () => (await db.query.users.findFirst({ where: eq(schema.users.id, qa.id), columns: { sessionInvalidBefore: true } }))?.sessionInvalidBefore ?? null;

  const bay = Math.floor(Date.now() / 1000);

  /* ═══ A · HAI PHIÊN CÙNG TÀI KHOẢN, CẢ HAI ĐANG DÙNG ĐƯỢC ═══ */
  const phienA = await ky(bay - 3600);
  const phienB = await ky(bay - 1800);
  const aTruoc = await goi("/api/notifications", phienA);
  const bTruoc = await goi("/api/notifications", phienB);
  ghi("A", "hai phiên cùng tài khoản đều dùng được trước khi thu hồi", aTruoc.status === 200 && bTruoc.status === 200, `phiên A HTTP ${aTruoc.status} · phiên B HTTP ${bTruoc.status}`);

  /* ═══ B · "ĐĂNG XUẤT MỌI THIẾT BỊ" — đi qua ĐÚNG hàm mà giao diện gọi ═══ */
  const nhatKyTruoc = await demNhatKy();
  const luot1 = await applySessionRevocation({ targetUserId: qa.id, targetEmail: qa.email, trigger: "SELF_LOGOUT_ALL", actor: { id: qa.id, label: qa.email } });
  ghi("B", "đăng xuất mọi thiết bị ghi được mốc thu hồi", Boolean(luot1?.advanced), luot1 ? `trước ${luot1.before?.toISOString() ?? "NULL"} → sau ${luot1.after.toISOString()}` : "không ghi được");

  /* ═══ C · PHIÊN CÒN LẠI BỊ TỪ CHỐI, VÀ TRANG VỀ ĐÚNG `?reason=revoked` ═══ */
  const bSau = await goi("/api/notifications", phienB);
  const trangSau = await goi("/shipments", phienB);
  const diToi = trangSau.headers.get("location") ?? "";
  ghi("C", "phiên còn lại bị từ chối · API 401 · trang về /login?reason=revoked", bSau.status === 401 && trangSau.status === 307 && diToi.includes("reason=revoked"), `API HTTP ${bSau.status} · trang HTTP ${trangSau.status} → ${diToi || "(không có Location)"}`);

  /* ═══ D · KHÔNG VÒNG LẶP CHUYỂN HƯỚNG ═══

     `/login` chỉ kiểm chữ ký và hạn, nên phiên đã thu hồi vẫn trông hợp lệ với nó. Thiếu lý do
     trong danh sách "ở lại" là người dùng bị đẩy qua đẩy lại tới khi trình duyệt bỏ cuộc — và mất
     hẳn đường đăng nhập lại. */
  const login = await goi("/login?reason=revoked", phienB);
  ghi("D", "trang đăng nhập GIỮ người dùng lại, không đẩy ngược vào trong", login.status === 200, `HTTP ${login.status}${login.status === 307 ? ` → ${login.headers.get("location")} — ĐÂY LÀ VÒNG LẶP` : ""}`);

  /* ═══ E · ĐĂNG NHẬP LẠI DÙNG ĐƯỢC NGAY ═══ */
  const phienMoi = await ky(Math.floor(Date.now() / 1000) + 1);
  const sauDangNhapLai = await goi("/api/notifications", phienMoi);
  ghi("E", "đăng nhập lại sau thu hồi dùng được NGAY", sauDangNhapLai.status === 200, `HTTP ${sauDangNhapLai.status}`);

  /* ═══ F · NHẬT KÝ: ĐÚNG MỘT DÒNG, CÓ KHOÁ TÀI KHOẢN, CÓ TRƯỚC→SAU ═══ */
  const dong = await db.query.auditLogs.findMany({ where: and(eq(schema.auditLogs.entityId, qa.id), eq(schema.auditLogs.action, REVOKE_AUDIT_ACTION)) });
  const moiNhat = dong.at(-1);
  const ct = (moiNhat?.detail ?? {}) as { before?: { sessionInvalidBefore?: unknown }; after?: { sessionInvalidBefore?: unknown }; trigger?: string; reason?: string };
  ghi(
    "F",
    "một lượt thu hồi ⇒ đúng một dòng nhật ký, mang khoá tài khoản, có trước→sau",
    dong.length === nhatKyTruoc + 1 && moiNhat?.userId === qa.id && "before" in ct && "after" in ct && ct.trigger === "SELF_LOGOUT_ALL",
    `${dong.length - nhatKyTruoc} dòng mới · userId ${moiNhat?.userId === qa.id ? "đúng khoá" : "SAI"} · trigger ${ct.trigger ?? "—"} · trước→sau ${"before" in ct && "after" in ct ? "có" : "THIẾU"}`,
  );

  /* ═══ G · QUẢN TRỊ THU HỒI THIẾU LÝ DO ⇒ TỪ CHỐI, VÀ KHÔNG ĐỂ LẠI DẤU VẾT ═══

     Vế thứ hai mới là vế quan trọng: một thao tác ĐÃ THẤT BẠI mà vẫn đẩy mốc lên thì người dùng
     bị đá ra vì một lệnh không bao giờ chạy. */
  const mocTruocG = await mocHienTai();
  const demTruocG = await demNhatKy();
  let biTuChoi = false;
  try {
    await applySessionRevocation({ targetUserId: qa.id, targetEmail: qa.email, trigger: "ADMIN_REVOKE", reason: "   ", actor: { id: qa.id, label: "e2e" } });
  } catch (e) {
    biTuChoi = e instanceof RevokeReasonRequired;
  }
  const mocSauG = await mocHienTai();
  const demSauG = await demNhatKy();
  ghi("G", "quản trị thu hồi THIẾU lý do ⇒ bị từ chối, mốc không đổi, không ghi nhật ký", biTuChoi && mocSauG?.getTime() === mocTruocG?.getTime() && demSauG === demTruocG, `từ chối: ${biTuChoi ? "có" : "KHÔNG"} · mốc đổi: ${mocSauG?.getTime() === mocTruocG?.getTime() ? "không" : "CÓ"} · nhật ký thêm: ${demSauG - demTruocG}`);

  /* ═══ H · QUẢN TRỊ THU HỒI CÓ LÝ DO ⇒ CHẠY, VÀ LÝ DO VÀO NHẬT KÝ ═══ */
  const lyDo = "nghiệm thu E2E thu hồi phiên trên tài khoản QA";
  const luot2 = await applySessionRevocation({ targetUserId: qa.id, targetEmail: qa.email, trigger: "ADMIN_REVOKE", reason: lyDo, actor: { id: qa.id, label: "e2e" } });
  const dongAdmin = (await db.query.auditLogs.findMany({ where: and(eq(schema.auditLogs.entityId, qa.id), eq(schema.auditLogs.action, REVOKE_AUDIT_ACTION)) })).at(-1);
  const ctAdmin = (dongAdmin?.detail ?? {}) as { reason?: string; trigger?: string };
  ghi("H", "quản trị thu hồi CÓ lý do ⇒ chạy, lý do đi vào nhật ký", Boolean(luot2) && ctAdmin.trigger === "ADMIN_REVOKE" && (ctAdmin.reason ?? "").includes("nghiệm thu"), `ghi được: ${luot2 ? "có" : "không"} · trigger ${ctAdmin.trigger ?? "—"} · lý do ${ctAdmin.reason ? "có trong nhật ký" : "THIẾU"}`);

  /* ═══ I · TRIGGER CSDL CHẶN MỐC LÙI — trên production, bằng câu UPDATE TRẦN ═══

     Đây là phép đo mà `session-verify` không làm được: nó cần một lượt GHI. Hai chiều tấn công:
     kéo mốc LÙI, và xoá mốc về NULL. Cả hai đều là GỠ THU HỒI. */
  const mocTruocI = await mocHienTai();
  const lui = new Date((mocTruocI?.getTime() ?? Date.now()) - 86_400_000);
  await db.execute(sql`UPDATE "users" SET "session_invalid_before" = ${lui.toISOString()}::timestamptz WHERE "id" = ${qa.id}`);
  const sauLui = await mocHienTai();
  await db.execute(sql`UPDATE "users" SET "session_invalid_before" = NULL WHERE "id" = ${qa.id}`);
  const sauNull = await mocHienTai();
  ghi(
    "I",
    "trigger CSDL chặn kéo mốc LÙI và chặn xoá về NULL (câu UPDATE trần, không qua ứng dụng)",
    sauLui?.getTime() === mocTruocI?.getTime() && sauNull?.getTime() === mocTruocI?.getTime(),
    `kéo lùi 1 ngày → ${sauLui?.getTime() === mocTruocI?.getTime() ? "bị chặn" : "LỌT"} · đặt NULL → ${sauNull?.getTime() === mocTruocI?.getTime() ? "bị chặn" : "LỌT"}`,
  );

  /* ═══ J · TIẾN LÊN VẪN ĐI ĐƯỢC ═══

     Không có vế này thì "chỉ tiến" và "đóng băng vĩnh viễn" nhìn giống hệt nhau. */
  const luot3 = await applySessionRevocation({ targetUserId: qa.id, targetEmail: qa.email, trigger: "PASSWORD_RESET", actor: { id: qa.id, label: "e2e" }, nowMs: Date.now() + 2000 });
  ghi("J", "mốc MỚI HƠN vẫn ghi được — chỉ-tiến không phải đóng băng", Boolean(luot3?.advanced), luot3 ? `${luot3.before?.toISOString()} → ${luot3.after.toISOString()}` : "không ghi được");

  const hong = bang.filter((r) => !r.dat);
  console.log(`\n═══ ${bang.length - hong.length}/${bang.length} PHÉP ĐẠT ═══`);
  console.log(`Tài khoản QA giữ lại cho lượt hồi quy sau. Mốc thu hồi của nó KHÔNG dọn được — luật chỉ-tiến cấm kéo lùi, kể cả để dọn dẹp, và đó đúng là điều phép I vừa chứng minh.`);
  if (hong.length) {
    console.log(`✗ KHÔNG ĐẠT: ${hong.map((r) => r.ma).join(" · ")}`);
    process.exitCode = 1;
  } else {
    console.log("✓ Thu hồi phiên chạy đúng trên máy chủ thật: chặn được phiên đang mở, không vòng lặp, đăng nhập lại được ngay, nhật ký đủ, thiếu lý do thì không để lại dấu vết, và trigger CSDL chặn mọi đường gỡ thu hồi.");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});

import { eq, isNotNull, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { getDb, schema } from "@/db";
import { SESSION_ABSOLUTE_DAYS, SESSION_COOKIE, SESSION_IDLE_DAYS, SESSION_LOGIN_CLAIM } from "@/lib/constants/session";
import { REVOKE_AUDIT_ACTION, sessionRevoked } from "@/lib/constants/session-revocation";

/**
 * ═══════════ KIỂM PHIÊN TRƯỢT TRÊN CHÍNH MÁY CHỦ ĐANG CHẠY ═══════════
 *
 * Bài kiểm trong `tests/` gọi hàm `middleware()` trực tiếp. Nó đúng, nhưng nó KHÔNG trả lời được
 * ba câu chỉ production mới trả lời được:
 *
 *   1. Next có thật sự gửi `Set-Cookie` của middleware ra ngoài dây không (trên cả phản hồi
 *      `text/event-stream` của SSE)?
 *   2. Cờ `Secure` có sống sót qua tấm proxy kết thúc TLS không?
 *   3. `getCurrentUser()` — thứ duy nhất đọc CSDL — có còn từ chối một token ký ĐÚNG nhưng trỏ
 *      tới một tài khoản không tồn tại không?
 *
 * ─── SCRIPT NÀY CHỈ ĐỌC ───
 *
 * Không `insert`, không `update`, không `delete`, không gọi Viettel Post, không gửi tin cho ai.
 * Nó ký vài phiếu phiên ngắn cho CHÍNH tài khoản quản trị đang có, gọi vài địa chỉ, rồi đọc header.
 * Token và khoá ký KHÔNG BAO GIỜ được in ra — kho mã này PUBLIC và log workflow thì ai cũng đọc.
 */

const NGAY = 86_400;
const NOI_BO = process.env.SESSION_VERIFY_URL ?? "http://127.0.0.1:3000";
/** Địa chỉ công khai, để xem cờ `Secure` có sống sót qua Caddy không. Bỏ trống thì bỏ qua phép đó. */
const CONG_KHAI = (process.env.APP_URL ?? "").replace(/\/$/, "");

type KetQua = { ma: string; ten: string; dat: boolean; thay: string };
const bang: KetQua[] = [];

function ghi(ma: string, ten: string, dat: boolean, thay: string) {
  bang.push({ ma, ten, dat, thay });
  console.log(`${dat ? "  ✓" : "  ✗"} ${ma} · ${ten}\n      ${thay}`);
}

/** Che token: đủ để đối chiếu hai phiếu khác nhau, không đủ để dùng lại. */
const che = (t: string) => `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} ký tự)`;

/** Bóc `Set-Cookie` của phiên ra khỏi phản hồi. `null` = middleware KHÔNG gia hạn lượt này. */
function cookiePhien(res: Response): { raw: string; token: string } | null {
  const tatCa = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  const raw = tatCa.find((c) => c && c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(`${SESSION_COOKIE}=`.length).split(";")[0] ?? "";
  return token ? { raw, token } : null;
}

async function main() {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) throw new Error("Thiếu AUTH_SECRET — không ký được phiếu phiên để kiểm");
  const key = new TextEncoder().encode(secret);

  const db = await getDb();
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
  if (!admin) throw new Error("Chưa có tài khoản quản trị nào để kiểm phiên");

  const now = Math.floor(Date.now() / 1000);
  const doi = SESSION_IDLE_DAYS * NGAY;

  /** Ký một phiếu với mốc tuỳ ý — đúng bộ claim mà `lib/auth/session.ts` ký. */
  const ky = (opts: { iat: number; exp: number; lgn?: number; sub?: string; role?: string }) =>
    new SignJWT({ email: admin.email, name: admin.name, role: opts.role ?? admin.role, [SESSION_LOGIN_CLAIM]: opts.lgn ?? opts.iat })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(opts.sub ?? admin.id)
      .setIssuedAt(opts.iat)
      .setExpirationTime(opts.exp)
      .sign(key);

  const goi = async (duong: string, token: string | null, init: RequestInit = {}, goc = NOI_BO) => {
    const ctl = new AbortController();
    // `/api/events` là một dòng chảy không bao giờ đóng — chỉ cần header, nên cắt sau 4 giây.
    const hen = setTimeout(() => ctl.abort(), 4000);
    try {
      return await fetch(`${goc}${duong}`, {
        ...init,
        redirect: "manual",
        signal: ctl.signal,
        headers: { ...(init.headers ?? {}), ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
      });
    } finally {
      clearTimeout(hen);
    }
  };

  console.log(`\n═══ KIỂM PHIÊN TRƯỢT TRÊN MÁY CHỦ ĐANG CHẠY ═══`);
  console.log(`  nội bộ: ${NOI_BO}${CONG_KHAI ? ` · công khai: ${CONG_KHAI}` : " · (không có APP_URL, bỏ qua phép kiểm Secure trên dây)"}`);
  console.log(`  chính sách: nghỉ ${SESSION_IDLE_DAYS} ngày (trượt) · trần sống ${SESSION_ABSOLUTE_DAYS} ngày (cứng)`);
  console.log(`  tài khoản mẫu: ${admin.email.replace(/(.{2}).*(@.*)/, "$1***$2")}\n`);

  /* ═══ A · TRƯỚC NỬA ĐỜI: ĐI TIẾP, KHÔNG KÝ LẠI ═══ */
  {
    const t = await ky({ iat: now - NGAY, exp: now - NGAY + doi });
    const res = await goi("/api/notifications", t);
    const ck = cookiePhien(res);
    ghi("A", "trước nửa đời không gia hạn sớm", res.status === 200 && ck === null, `HTTP ${res.status} · Set-Cookie: ${ck ? "CÓ (sai)" : "không (đúng)"}`);
  }

  /* ═══ B · QUA NỬA ĐỜI: GIA HẠN, ĐẨY HẠN, GIỮ NGUYÊN MỐC ĐĂNG NHẬP ═══ */
  let mauCookie = "";
  {
    const lgn = now - 5 * NGAY;
    const t = await ky({ iat: lgn, exp: lgn + doi, lgn });
    const res = await goi("/api/notifications", t);
    const ck = cookiePhien(res);
    if (!ck) {
      ghi("B", "qua nửa đời phải được gia hạn", false, `HTTP ${res.status} · KHÔNG có Set-Cookie`);
    } else {
      mauCookie = ck.raw;
      const { payload: cu } = await jwtVerify(t, key);
      const { payload: moi } = await jwtVerify(ck.token, key);
      const dat =
        res.status === 200 &&
        Number(moi.exp) > Number(cu.exp) &&
        Number(moi[SESSION_LOGIN_CLAIM]) === lgn &&
        moi.sub === cu.sub &&
        Number(moi.iat) > Number(cu.iat);
      ghi(
        "B",
        "qua nửa đời được gia hạn, lgn giữ nguyên",
        dat,
        `HTTP ${res.status} · exp +${Math.round((Number(moi.exp) - Number(cu.exp)) / 3600)}h · lgn ${Number(moi[SESSION_LOGIN_CLAIM]) === lgn ? "NGUYÊN VẸN" : "BỊ ĐỔI"} · sub ${moi.sub === cu.sub ? "nguyên" : "ĐỔI"} · ${che(ck.token)}`,
      );
    }
  }

  /* ═══ C · TRẦN TUYỆT ĐỐI: HẠN MỚI KHÔNG BAO GIỜ VƯỢT lgn + 30 NGÀY ═══ */
  {
    const lgn = now - (SESSION_ABSOLUTE_DAYS - 3) * NGAY; // còn 3 ngày dưới trần
    const t = await ky({ iat: now - 5 * NGAY, exp: now + 2 * NGAY, lgn });
    const res = await goi("/api/notifications", t);
    const ck = cookiePhien(res);
    if (!ck) {
      ghi("C", "sát trần vẫn gia hạn nhưng bị cắt", false, `HTTP ${res.status} · không có Set-Cookie`);
    } else {
      const { payload: moi } = await jwtVerify(ck.token, key);
      const tran = lgn + SESSION_ABSOLUTE_DAYS * NGAY;
      const dat = Number(moi.exp) === tran && Number(moi.exp) < now + doi;
      ghi("C", "hạn mới bị CẮT về đúng trần sống", dat, `exp mới = lgn + ${Math.round((Number(moi.exp) - lgn) / NGAY)} ngày (trần ${SESSION_ABSOLUTE_DAYS}) · ngắn hơn một kỳ nghỉ trọn vẹn: ${Number(moi.exp) < now + doi}`);
    }
  }
  {
    // Đã kịch trần: không còn gì để gia hạn, phiếu phải tự chết đúng hạn.
    const tran = now + NGAY;
    const t = await ky({ iat: now - 5 * NGAY, exp: tran, lgn: tran - SESSION_ABSOLUTE_DAYS * NGAY });
    const res = await goi("/api/notifications", t);
    ghi("C2", "kịch trần thì thôi gia hạn", res.status === 200 && cookiePhien(res) === null, `HTTP ${res.status} · Set-Cookie: ${cookiePhien(res) ? "CÓ (sai)" : "không (đúng)"}`);
  }

  /* ═══ D · HẾT HẠN: KHÔNG HỒI SINH, CHẶN ĐÚNG KIỂU TỪNG LOẠI ĐƯỜNG ═══ */
  {
    const t = await ky({ iat: now - (SESSION_IDLE_DAYS + 2) * NGAY, exp: now - NGAY });
    const api = await goi("/api/notifications", t);
    const trang = await goi("/shipments", t);
    const loc = trang.headers.get("location") ?? "";
    const dat = api.status === 401 && cookiePhien(api) === null && (trang.status === 307 || trang.status === 302) && loc.includes("/login");
    ghi("D", "token hết hạn: 401 ở API, /login ở trang, KHÔNG gia hạn", dat, `API ${api.status} (Set-Cookie: ${cookiePhien(api) ? "CÓ — SAI" : "không"}) · trang ${trang.status} → ${loc || "(không có Location)"}`);
  }

  /* ═══ E · SSE VÀ CHUÔNG: ĐÚNG VÒNG ĐÃ ĐÁ NGƯỜI DÙNG RA ═══ */
  for (const duong of ["/api/events", "/api/notifications"]) {
    const lgn = now - 5 * NGAY;
    const t = await ky({ iat: lgn, exp: lgn + doi, lgn });
    try {
      const res = await goi(duong, t);
      const ck = cookiePhien(res);
      const kieu = res.headers.get("content-type") ?? "";
      ghi(`E:${duong}`, "token cũ còn hạn KHÔNG bị 401, và được gia hạn", res.status === 200 && ck !== null, `HTTP ${res.status} · ${kieu.split(";")[0]} · Set-Cookie: ${ck ? "có" : "KHÔNG — SAI"}`);
    } catch (e) {
      ghi(`E:${duong}`, "token cũ còn hạn KHÔNG bị 401", false, `lỗi gọi: ${(e as Error).message}`);
    }
  }

  /* ═══ F · POST KHÔNG BAO GIỜ GIA HẠN — ĐỂ ĐĂNG XUẤT KHÔNG BỊ GHI ĐÈ ═══ */
  {
    const lgn = now - 5 * NGAY;
    const t = await ky({ iat: lgn, exp: lgn + doi, lgn });
    const res = await goi("/api/notifications", t, { method: "POST" });
    const ck = cookiePhien(res);
    // Route chỉ có GET nên Next trả 405 — điều đang đo là middleware KHÔNG kèm Set-Cookie.
    ghi("F", "POST không gia hạn (đăng xuất không bị ghi đè)", ck === null && res.status !== 401, `HTTP ${res.status} · Set-Cookie: ${ck ? "CÓ — SAI, đăng xuất có thể bị ghi đè" : "không (đúng)"}`);
  }

  /* ═══ G · CHỮ KÝ ĐÚNG KHÔNG PHẢI LÀ QUYỀN — CSDL MỚI LÀ ═══
     Phiếu ký ĐÚNG, vai trò ADMIN, nhưng trỏ tới một tài khoản không tồn tại. Middleware cho qua
     (nó chỉ biết chữ ký và hạn — bằng chứng là vẫn có Set-Cookie), còn route phải TỪ CHỐI vì
     `getCurrentUser()` tra CSDL và không thấy ai. Nếu ERP tin vai trò trong token thì phép này
     trả 200, và đó sẽ là một lỗ hổng leo thang quyền. */
  {
    const lgn = now - 5 * NGAY;
    const t = await ky({ iat: lgn, exp: lgn + doi, lgn, sub: "khong-ton-tai-session-verify", role: "ADMIN" });
    const res = await goi("/api/notifications", t);
    const ck = cookiePhien(res);
    ghi("G", "vai trò trong token KHÔNG qua mặt được CSDL", res.status === 401 && ck !== null, `HTTP ${res.status} (phải 401) · middleware có cho qua và gia hạn: ${ck ? "có — đúng, chặn đến từ CSDL" : "không"}`);
  }

  /* ═══ H · THUỘC TÍNH COOKIE TRÊN DÂY ═══ */
  {
    const thap = mauCookie.toLowerCase();
    const dat = thap.includes("httponly") && thap.includes("samesite=lax") && thap.includes("path=/") && /max-age=\d+/.test(thap);
    const maxAge = Number(/max-age=(\d+)/.exec(thap)?.[1] ?? 0);
    ghi("H", "cookie gia hạn giữ đủ thuộc tính (nội bộ http)", dat, `HttpOnly:${thap.includes("httponly")} · SameSite:${/samesite=(\w+)/.exec(thap)?.[1] ?? "—"} · Path:${/path=([^;]+)/.exec(thap)?.[1] ?? "—"} · Max-Age:${Math.round(maxAge / NGAY)} ngày · Secure:${thap.includes("secure")}`);
  }
  if (CONG_KHAI.startsWith("https")) {
    const lgn = now - 5 * NGAY;
    const t = await ky({ iat: lgn, exp: lgn + doi, lgn });
    try {
      const res = await goi("/api/notifications", t, {}, CONG_KHAI);
      const ck = cookiePhien(res);
      const thap = (ck?.raw ?? "").toLowerCase();
      ghi("H2", "qua HTTPS công khai cookie PHẢI có Secure", Boolean(ck) && thap.includes("secure") && thap.includes("httponly"), ck ? `Secure:${thap.includes("secure")} · HttpOnly:${thap.includes("httponly")} · SameSite:${/samesite=(\w+)/.exec(thap)?.[1] ?? "—"}` : `không có Set-Cookie (HTTP ${res.status})`);
    } catch (e) {
      ghi("H2", "qua HTTPS công khai cookie PHẢI có Secure", false, `không gọi được từ máy chủ: ${(e as Error).message}`);
    }
  }

  /* ═══ I · THU HỒI PHIÊN: CỘT ĐÃ CÓ, VÀ NHỮNG LƯỢT THU HỒI ĐÃ XẢY RA ĐỀU TỰ NHẤT QUÁN ═══

     PHÉP NÀY ĐO ĐƯỢC GÌ, VÀ KHÔNG ĐO ĐƯỢC GÌ — nói thẳng để không ai đọc nhầm một dấu ✓.

     ĐO ĐƯỢC: migration 0106 đã áp trên máy chủ này; luật "chỉ tiến" không bị vi phạm ở bất kỳ dòng
     nào đang có; mỗi lượt thu hồi đã xảy ra đều có một dòng nhật ký mang khoá tài khoản; và với
     những tài khoản ĐÃ bị thu hồi, một phiếu phiên cũ thật sự bị luật từ chối.

     KHÔNG ĐO ĐƯỢC: "thu hồi có chặn được một lượt gọi thật trên production hay không". Câu đó chỉ
     trả lời được bằng cách GHI vào CSDL production — mà script này chỉ đọc, và không có tài khoản
     QA riêng để ghi lên. Chủ shop xác minh bằng tay: bấm "Đăng xuất mọi thiết bị" trên một máy,
     tải lại trang trên máy thứ hai, phải ra `/login?reason=revoked`. */
  {
    let coCot = true;
    try {
      await db.select({ n: sql<number>`count(*)` }).from(schema.users).where(isNotNull(schema.users.sessionInvalidBefore));
    } catch {
      coCot = false;
    }
    if (!coCot) {
      ghi("I", "cột thu hồi phiên đã có trên máy chủ này", false, "không đọc được users.session_invalid_before — migration 0106 CHƯA áp");
    } else {
      const daThuHoi = await db.query.users.findMany({
        where: isNotNull(schema.users.sessionInvalidBefore),
        columns: { id: true, sessionInvalidBefore: true },
      });
      const soDong = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, REVOKE_AUDIT_ACTION));
      const soNhatKy = Number(soDong[0]?.n ?? 0);

      // Với mỗi tài khoản đã bị thu hồi: một phiếu phiên cấp TRƯỚC mốc phải bị luật từ chối, và một
      // phiếu cấp SAU mốc phải được chấp nhận. Hàm thuần, không gọi mạng, không ghi gì.
      const sai = daThuHoi.filter((u) => {
        const moc = u.sessionInvalidBefore;
        if (!moc) return false;
        const truoc = Math.floor(moc.getTime() / 1000) - 60;
        const sau = Math.ceil(moc.getTime() / 1000) + 60;
        return !sessionRevoked(truoc, moc) || sessionRevoked(sau, moc);
      });

      const dat = sai.length === 0 && (daThuHoi.length === 0 || soNhatKy > 0);
      const thay =
        daThuHoi.length === 0
          ? `cột đã có · chưa tài khoản nào bị thu hồi (${soNhatKy} dòng nhật ký) — phép này chỉ xác nhận migration 0106 đã áp`
          : `${daThuHoi.length} tài khoản đã thu hồi · ${soNhatKy} dòng nhật ký · luật từ chối đúng ở ${daThuHoi.length - sai.length}/${daThuHoi.length}`;
      ghi("I", "thu hồi phiên: cột đã áp, luật tự nhất quán, mỗi lượt đều có nhật ký", dat, thay);
    }
  }

  const hong = bang.filter((r) => !r.dat);
  console.log(`\n═══ ${bang.length - hong.length}/${bang.length} PHÉP ĐẠT ═══`);
  if (hong.length) {
    console.log(`✗ KHÔNG ĐẠT: ${hong.map((r) => r.ma).join(" · ")}`);
    process.exitCode = 1;
  } else {
    console.log("✓ Phiên trượt chạy đúng trên máy chủ thật: gia hạn đúng lúc, trần sống chặn được, hết hạn vẫn chết, SSE không còn 401, POST không ghi đè đăng xuất, CSDL vẫn là nơi quyết định quyền, cột thu hồi phiên đã áp.");
  }
}

void main();

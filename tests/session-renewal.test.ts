import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { middleware } from "@/middleware";
import { signSession, type SessionIdentity } from "@/lib/auth/session";
import {
  SESSION_ABSOLUTE_DAYS,
  SESSION_COOKIE,
  SESSION_IDLE_DAYS,
  SESSION_RENEW_AFTER_FRACTION,
  claimsFrom,
  cookieMaxAgeSec,
  decideRenewal,
  sessionCookieSecure,
} from "@/lib/constants/session";

/**
 * ═══════════ PHIÊN TRƯỢT: NGƯỜI ĐANG LÀM VIỆC KHÔNG BỊ ĐÁ RA, VÀ PHIÊN VẪN CHẾT ĐÚNG HẠN ═══════════
 *
 * Sự cố đo được 19/09/2026: token ký cứng 7 ngày, không bao giờ gia hạn. Đúng 7 ngày sau mỗi lần
 * đăng nhập, giữa giờ làm, `/api/events` trả 401 → SSE chết → `realtime-provider` gọi
 * `router.refresh()` sau 5 phút → middleware đá về `/login`. Người dùng không bấm gì cả.
 *
 * Bài kiểm này giữ HAI điều cùng lúc, và chúng kéo ngược chiều nhau:
 *
 *   1. người còn dùng ERP thì KHÔNG bị đá ra (cái đang hỏng);
 *   2. phiên vẫn phải chết — hết hạn thì chết, và dù chăm chỉ tới đâu cũng chết ở trần tuyệt đối
 *      (cái dễ vô tình phá khi sửa điều 1).
 *
 * Không mốc nào bị ghim thành một ngày tuyệt đối (luật 50): mọi thứ dựng quanh `Date.now()` của
 * chính lượt chạy, hoặc truyền `nowSec` vào một hàm thuần.
 */

const NGAY = 86_400;
const NV: SessionIdentity = { id: "sess-u1", email: "nv@erp.test", name: "Nhân viên", role: "CS" };

/** Cùng phép chọn khoá với `middleware.ts` và `lib/env.ts` — hai nơi đó đã có bài kiểm giữ khớp. */
function khoa() {
  const s = process.env.AUTH_SECRET?.trim() || "dev-secret-change-me-please-32-chars-min";
  return new TextEncoder().encode(s);
}

/** Một lượt gọi thật đi qua middleware thật. */
async function goi(duongDan: string, token: string | null, method: "GET" | "POST" = "GET") {
  const headers = new Headers();
  if (token) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  const res = await middleware(new NextRequest(`https://erp.test${duongDan}`, { method, headers }));
  const moi = res.cookies.get(SESSION_COOKIE)?.value ?? null;
  return { res, moi };
}

export async function testSessionRenewal() {
  const now = Math.floor(Date.now() / 1000);
  const doi = SESSION_IDLE_DAYS * NGAY;

  /* ═══════════ 1 · KHÔNG CÓ TOKEN THÌ KHÔNG GIA HẠN GÌ CẢ ═══════════

     Đây là nhánh của ĐĂNG XUẤT: `destroySession()` xoá cookie, nên lượt gọi sau không mang token.
     Nếu hàm quyết định "gia hạn" ở đây thì đăng xuất không bao giờ ăn. */

  assert.deepEqual(decideRenewal(null, now), { renew: false, reason: "NO_TOKEN" });

  /* ═══════════ 2 · TRƯỚC NỬA ĐỜI: KHÔNG GIA HẠN ═══════════

     Ký lại ở mọi lượt gọi là phí — bàn care hỏi `/api/notifications` 30 giây một lần. */

  const treTuoi = { issuedAtSec: now - NGAY, expiresAtSec: now - NGAY + doi, loginAtSec: now - NGAY };
  assert.deepEqual(decideRenewal(treTuoi, now), { renew: false, reason: "TOO_EARLY" }, "token mới một ngày (đời 7 ngày) chưa tới nửa đời");

  /* ═══════════ 3 · BIÊN NỬA ĐỜI: ĐÚNG NỬA LÀ ĐÃ TỚI LƯỢT ═══════════

     Biên là chỗ dễ sai nhất, và sai về phía "chưa tới" nghĩa là token qua nửa đời vẫn không được
     gia hạn ở lượt gọi đó — tự nó không hỏng, nhưng nó làm bài kiểm nói dối về thời điểm. */

  const nuaDoi = Math.floor(doi * SESSION_RENEW_AFTER_FRACTION);
  const sinhRa = now - nuaDoi;
  const dungNua = { issuedAtSec: sinhRa, expiresAtSec: sinhRa + doi, loginAtSec: sinhRa };
  assert.equal(decideRenewal(dungNua, now - 1).renew, false, "trước nửa đời một giây: chưa");
  assert.equal(decideRenewal(dungNua, now).renew, true, "ĐÚNG nửa đời: đã tới lượt");

  /* ═══════════ 4 · QUA NỬA ĐỜI: GIA HẠN, VÀ MỐC MỚI LÀ MỘT KỲ NGHỈ TRỌN VẸN ═══════════ */

  const cu = { issuedAtSec: now - 5 * NGAY, expiresAtSec: now - 5 * NGAY + doi, loginAtSec: now - 5 * NGAY };
  const qd = decideRenewal(cu, now);
  assert.equal(qd.renew, true);
  assert.equal(qd.renew && qd.expiresAtSec, now + doi, "gia hạn = trọn một kỳ nghỉ nữa tính TỪ BÂY GIỜ, không phải cộng thêm vào mốc cũ");
  assert.equal(qd.renew && qd.loginAtSec, cu.loginAtSec, "mốc ĐĂNG NHẬP GỐC phải đi theo — nó là thứ duy nhất giữ trần tuyệt đối có nghĩa");

  /* ═══════════ 5 · HẾT HẠN: KHÔNG GIA HẠN, KHÔNG HỒI SINH ═══════════

     Vế quan trọng nhất. Thiếu nó thì một lượt gọi muộn cũng làm token sống lại, và hạn phiên của
     cả ERP trở thành trang trí. */

  const chet = { issuedAtSec: now - 8 * NGAY, expiresAtSec: now - NGAY, loginAtSec: now - 8 * NGAY };
  assert.deepEqual(decideRenewal(chet, now), { renew: false, reason: "EXPIRED" });
  const vuaChet = { issuedAtSec: now - doi, expiresAtSec: now, loginAtSec: now - doi };
  assert.deepEqual(decideRenewal(vuaChet, now), { renew: false, reason: "EXPIRED" }, "đúng giây hết hạn là ĐÃ hết hạn, không phải 'còn một giây'");

  /* ═══════════ 6 · TRẦN TUYỆT ĐỐI: KHÔNG CÓ PHIÊN BẤT TỬ ═══════════

     Mô phỏng người chăm chỉ nhất có thể: mở ERP MỖI NGÀY, không nghỉ ngày nào, suốt hai tháng.
     Nếu gia hạn không có trần thì vòng lặp này đẩy hạn đi mãi. */

  const dangNhapLuc = now;
  let token = { issuedAtSec: dangNhapLuc, expiresAtSec: dangNhapLuc + doi, loginAtSec: dangNhapLuc };
  let soLanGiaHan = 0;
  let songToi = token.expiresAtSec;
  for (let ngay = 1; ngay <= 60; ngay += 1) {
    const bayGio = dangNhapLuc + ngay * NGAY;
    if (bayGio >= token.expiresAtSec) break; // phiên đã chết giữa chừng ⇒ dừng, đúng như đời thật
    const r = decideRenewal(token, bayGio);
    if (r.renew) {
      soLanGiaHan += 1;
      token = { issuedAtSec: bayGio, expiresAtSec: r.expiresAtSec, loginAtSec: r.loginAtSec };
      songToi = r.expiresAtSec;
    }
  }
  const tran = dangNhapLuc + SESSION_ABSOLUTE_DAYS * NGAY;
  assert.ok(soLanGiaHan > 0, "người dùng mỗi ngày phải được gia hạn ít nhất một lần — nếu không thì bản vá này không vá gì");
  /*
    VÀ KHÔNG ĐƯỢC KÝ LẠI Ở MỌI LƯỢT GỌI. Sau một lần gia hạn, token mới trẻ lại nên nửa đời của nó
    còn cách 3,5 ngày — đó là lý do ngưỡng nửa đời tồn tại. Người mở ERP 60 ngày liên tục chỉ tốn
    khoảng chục chữ ký, không phải một chữ ký cho mỗi lượt hỏi chuông (30 giây/lần = 172.800 lượt).
  */
  assert.ok(soLanGiaHan <= 20, `60 ngày mà ký lại ${soLanGiaHan} lần — ngưỡng nửa đời không còn chặn, mỗi lượt gọi đang tốn một chữ ký`);
  assert.ok(songToi <= tran, `phiên sống tới ${songToi} vượt trần ${tran} — ĐÂY LÀ PHIÊN BẤT TỬ`);
  assert.ok(
    songToi >= tran - NGAY,
    "người dùng liên tục phải được sống SÁT trần, nếu không thì họ bị đá ra sớm hơn chính sách đã hứa",
  );
  // Và tới đúng trần thì hết: không lượt gọi nào sau đó gia hạn được nữa.
  assert.equal(decideRenewal({ issuedAtSec: tran - NGAY, expiresAtSec: tran, loginAtSec: dangNhapLuc }, tran).renew, false, "đúng trần tuyệt đối là hết, phải đăng nhập lại");

  /* ═══════════ 7 · KỊCH TRẦN THÌ NÓI RÕ LÀ KỊCH TRẦN, KHÔNG NÓI 'CHƯA TỚI LÚC' ═══════════ */

  /*
    Trạng thái THẬT của một phiên sắp chạm trần: đăng nhập 26 ngày trước, lần gia hạn gần nhất 5
    ngày trước (nên hạn hiện tại là now+2 ngày), trần còn cách 4 ngày. Lượt gia hạn này KHÔNG được
    cấp trọn 7 ngày — nó phải bị cắt về đúng trần.
  */
  const satTran = { issuedAtSec: now - 5 * NGAY, expiresAtSec: now + 2 * NGAY, loginAtSec: now - (SESSION_ABSOLUTE_DAYS - 4) * NGAY };
  const rTran = decideRenewal(satTran, now);
  assert.equal(rTran.renew, true, "còn 4 ngày dưới trần thì vẫn gia hạn được, chỉ là gia hạn ít");
  assert.equal(rTran.renew && rTran.expiresAtSec, satTran.loginAtSec + SESSION_ABSOLUTE_DAYS * NGAY, "mốc mới bị CẮT về đúng trần, không vượt qua");
  assert.ok(rTran.renew && rTran.expiresAtSec < now + doi, "và nó NGẮN HƠN một kỳ nghỉ trọn vẹn — đó chính là dấu hiệu trần đang chặn");

  /*
    Lượt cuối cùng trước khi chết: hạn hiện tại ĐÃ bằng trần, nên không còn gì để gia hạn. Phải nói
    đúng lý do `AT_ABSOLUTE_CAP` — gộp nó vào "chưa tới lúc" là giấu mất chính sách an ninh đang
    có hiệu lực, và người gỡ lỗi sẽ đi tìm nhầm chỗ.
  */
  const dungTran = { issuedAtSec: now - 5 * NGAY, expiresAtSec: now + NGAY, loginAtSec: now + NGAY - SESSION_ABSOLUTE_DAYS * NGAY };
  assert.deepEqual(decideRenewal(dungTran, now), { renew: false, reason: "AT_ABSOLUTE_CAP" }, "hạn đã bằng trần ⇒ để nó chết tự nhiên, và nói đúng lý do");

  /* ═══════════ 8 · TOKEN CŨ KHÔNG CÓ `lgn`: KHÔNG MIGRATION, KHÔNG AI BỊ ĐÁ RA ═══════════

     Mọi token đang nằm trong trình duyệt của nhân viên lúc triển khai đều thiếu claim đó. Với
     chúng thì `iat` ĐÚNG là mốc đăng nhập — hồi ấy chưa có lần gia hạn nào để đẩy `iat` đi. */

  const cuKhongLgn = claimsFrom({ iat: now - 3 * NGAY, exp: now + 4 * NGAY });
  assert.equal(cuKhongLgn?.loginAtSec, now - 3 * NGAY, "thiếu lgn ⇒ lấy iat, KHÔNG coi như vừa đăng nhập (sẽ dời trần) và KHÔNG coi như hết hạn (sẽ đá người ta ra)");
  assert.equal(claimsFrom({ exp: now + NGAY }), null, "thiếu iat ⇒ không đủ căn cứ, không đoán");
  assert.equal(claimsFrom({ iat: now }), null, "thiếu exp ⇒ không đủ căn cứ, không đoán");
  assert.equal(claimsFrom(null), null);

  /* ═══════════ 9 · HAI HÀM PHỤ NHỎ MÀ SAI THÌ ĐĂNG XUẤT TOÀN BỘ ═══════════ */

  assert.equal(cookieMaxAgeSec(now - 10, now), 0, "Max-Age ÂM là lệnh XOÁ cookie — phải kẹp về 0");
  assert.equal(cookieMaxAgeSec(now + 100, now), 100);
  assert.equal(sessionCookieSecure("production", "https://erp.vnxcommerce.com"), true);
  assert.equal(sessionCookieSecure("production", "http://erp.local"), false, "http thì không đánh dấu secure, nếu không trình duyệt vứt cookie và không ai đăng nhập được");
  assert.equal(sessionCookieSecure("development", "https://erp.vnxcommerce.com"), false);
  assert.equal(sessionCookieSecure("development", "http://localhost:3000", "https:"), true, "đang thật sự chạy trên https ⇒ luôn đánh dấu secure, kể cả khi biến môi trường nói khác");
  assert.equal(sessionCookieSecure("production", "https://erp.vnxcommerce.com", "http:"), true, "lưới an toàn chỉ THÊM: sau proxy kết thúc TLS thì luật cũ vẫn giữ cờ secure");

  /* ═══════════════════════════════════════════════════════════════════════════════════════════
     MIDDLEWARE THẬT — từ đây xuống là lượt gọi đi qua đúng hàm production, không phải bản mô phỏng.
     ═══════════════════════════════════════════════════════════════════════════════════════════ */

  /* ═══════════ 10 · NGƯỜI ĐANG LÀM VIỆC KHÔNG BỊ ĐÁ VỀ /login ═══════════ */

  const tokenCu = await signSession(NV, { nowSec: now - 5 * NGAY });
  const { res: r10, moi: moi10 } = await goi("/shipments", tokenCu);
  assert.equal(r10.status, 200, "token còn hạn ⇒ ĐI TIẾP, không chuyển hướng");
  assert.equal(r10.headers.get("location"), null, "không được có Location — đó chính là cú đá về /login");
  assert.ok(moi10, "token đã qua nửa đời ⇒ phải được gia hạn ngay trong lượt gọi này");

  /* ═══════════ 11 · TOKEN GIA HẠN GIỮ NGUYÊN DANH TÍNH VÀ MỐC ĐĂNG NHẬP GỐC ═══════════ */

  const { payload: cuP } = await jwtVerify(tokenCu, khoa());
  const { payload: moiP } = await jwtVerify(moi10!, khoa());
  assert.equal(moiP.sub, cuP.sub, "gia hạn KHÔNG được đổi người");
  assert.equal(moiP.email, cuP.email);
  assert.equal(moiP.role, cuP.role, "vai trò trong token chỉ để hiển thị, nhưng gia hạn vẫn không được tự ý đổi nó");
  assert.equal(moiP.lgn, cuP.lgn, "mốc đăng nhập gốc phải NGUYÊN VẸN qua mỗi lần gia hạn");
  assert.ok(Number(moiP.exp) > Number(cuP.exp), "hạn mới phải xa hơn hạn cũ, nếu không thì gia hạn chẳng để làm gì");
  assert.ok(Number(moiP.iat) > Number(cuP.iat), "iat phải là LÚC NÀY — nó khác lgn, và trộn hai mốc là mở đường cho phiên bất tử");

  /* ═══════════ 12 · TOKEN CÒN TRẺ: ĐI TIẾP NHƯNG KHÔNG KÝ LẠI ═══════════ */

  const tokenTre = await signSession(NV, { nowSec: now - NGAY });
  const { res: r12, moi: moi12 } = await goi("/shipments", tokenTre);
  assert.equal(r12.status, 200);
  assert.equal(moi12, null, "chưa qua nửa đời ⇒ KHÔNG ký lại, không tốn một Set-Cookie nào");

  /* ═══════════ 13 · SSE VÀ CHUÔNG THÔNG BÁO KHÔNG BỊ 401 VÌ TOKEN CŨ ═══════════

     Đây là đúng cái vòng đã đá người dùng ra: `/api/events` 401 → SSE chết → refresh → /login.
     Hai đường này là GET nên chúng vừa đi qua được, vừa TỰ GIA HẠN phiên cho người đang mở tab. */

  for (const duong of ["/api/events", "/api/notifications"]) {
    const { res, moi } = await goi(duong, await signSession(NV, { nowSec: now - 5 * NGAY }));
    assert.equal(res.status, 200, `${duong}: token CŨ NHƯNG CÒN HẠN không được trả 401`);
    assert.ok(moi, `${duong}: lượt gọi nền phải gia hạn phiên — đây là thứ giữ cho tab đang mở không chết`);
  }

  /* ═══════════ 14 · TOKEN THẬT SỰ HẾT HẠN THÌ VẪN PHẢI CHẶN ═══════════

     Bản vá không được biến thành "không bao giờ hết hạn". Nghỉ trọn kỳ nghỉ thì phải đăng nhập lại. */

  const tokenChet = await signSession(NV, { nowSec: now - (SESSION_IDLE_DAYS + 1) * NGAY });
  const { res: r14a, moi: moi14a } = await goi("/api/events", tokenChet);
  assert.equal(r14a.status, 401, "token hết hạn ⇒ API trả 401");
  assert.equal(moi14a, null, "và TUYỆT ĐỐI không gia hạn một token đã chết");
  const { res: r14b } = await goi("/shipments", tokenChet);
  assert.equal(r14b.status, 307, "trang thì chuyển hướng");
  assert.ok(r14b.headers.get("location")?.includes("/login"), "về /login");

  /* ═══════════ 15 · ĐĂNG XUẤT (POST) KHÔNG BỊ MỘT LƯỢT GIA HẠN GHI ĐÈ ═══════════

     `logoutAction` là một Server Action, tức là POST, và nó XOÁ cookie. Nếu middleware cũng ghi
     cookie trên cùng phản hồi thì hai lệnh Set-Cookie đua nhau — và "đăng xuất thỉnh thoảng không
     ăn" là lỗi an ninh, không phải lỗi giao diện. */

  const { res: r15, moi: moi15 } = await goi("/", await signSession(NV, { nowSec: now - 5 * NGAY }), "POST");
  assert.equal(r15.status, 200, "POST của người đã đăng nhập vẫn đi tiếp bình thường");
  assert.equal(moi15, null, "POST KHÔNG BAO GIỜ gia hạn — không có gì để đua với lệnh xoá cookie của đăng xuất");

  /* ═══════════ 16 · KHÔNG CÓ COOKIE: CHẶN, VÀ KHÔNG CẤP PHÁT GÌ ═══════════ */

  const { res: r16a, moi: moi16a } = await goi("/api/notifications", null);
  assert.equal(r16a.status, 401);
  assert.equal(moi16a, null, "không ai được nhận một phiên mới chỉ vì đã gọi một địa chỉ");
  const { res: r16b } = await goi("/shipments", null);
  assert.equal(r16b.status, 307);

  /* ═══════════ 17 · ĐƯỜNG CÔNG KHAI KHÔNG BỊ ĐỤNG TỚI ═══════════

     Webhook Viettel Post / Pancake phải trả lời trong dưới một giây và không mang cookie nào. */

  for (const duong of ["/api/webhooks/viettelpost", "/api/health", "/login"]) {
    const { res, moi } = await goi(duong, null);
    assert.equal(res.status, 200, `${duong}: đường công khai không được chặn`);
    assert.equal(moi, null, `${duong}: và không được cấp phiên`);
  }

  /* ═══════════ 18 · KHOÁ TÀI KHOẢN VÀ ĐỔI QUYỀN VẪN CÓ HIỆU LỰC NGAY ═══════════

     Middleware chạy ở Edge nên KHÔNG đọc được CSDL — nó chỉ biết chữ ký còn đúng và hạn còn hay
     hết. Việc "người này còn được dùng ERP không, quyền tới đâu" do `getCurrentUser()` làm, ở MỌI
     lần dựng trang và MỌI route `/api/*`. Nếu một ngày ai đó tối ưu bằng cách đọc quyền từ token
     thì khoá một tài khoản sẽ không còn hiệu lực cho tới khi phiên của họ hết hạn — tới 30 ngày.

     Kiểm ở mức MÃ NGUỒN vì `getCurrentUser()` đọc cookie qua `next/headers`, thứ không tồn tại
     ngoài một lượt gọi thật. */

  const goc = path.resolve(__dirname, "..");
  const nguon = readFileSync(path.join(goc, "lib/auth/session.ts"), "utf8");
  /*
    Neo vào `resolveCurrentUser` chứ không phải `getCurrentUser`: bản thu hồi phiên tách hàm này
    làm hai — `resolveCurrentUser` giữ toàn bộ phép quyết định và trả về LÝ DO từ chối,
    `getCurrentUser` chỉ là lớp mỏng nuốt lý do đi. Ba khẳng định dưới đây vẫn nói ĐÚNG câu cũ,
    chỉ đổi chỗ đứng.
  */
  const thanHam = nguon.slice(nguon.indexOf("export const resolveCurrentUser"));
  assert.ok(/db\.query\.users\.findFirst/.test(thanHam), "resolveCurrentUser phải TRA CSDL mỗi lần — token không phải nguồn sự thật về người dùng");
  assert.ok(/if \(!user\.active\) return \{ denied: "DISABLED" \}/.test(thanHam), "tài khoản bị khoá phải bị từ chối NGAY, không đợi token hết hạn");
  assert.ok(/resolvePermissions\(user\.role/.test(thanHam), "quyền phải tính từ VAI TRÒ TRONG CSDL, không phải vai trò trong token");
  assert.ok(/sessionRevoked\(session\.loginAtSec, user\.sessionInvalidBefore\)/.test(thanHam), "thu hồi phiên phải được kiểm ở tầng Node, nơi có CSDL");
  // Bỏ chú thích trước khi quét: chính đoạn chú thích giải thích LUẬT lại chứa đúng chữ đang bị
  // cấm, và một bài kiểm đỏ vì lời giải thích của chính nó thì không ai đọc thông điệp của nó nữa.
  const khongChuThich = thanHam.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/memo\(/.test(khongChuThich), "không được đệm lượt tra người dùng — mỗi giây đệm là một giây token đã thu hồi vẫn dùng được");
  const thanMw = readFileSync(path.join(goc, "middleware.ts"), "utf8");
  assert.ok(!/getDb|@\/db|drizzle/.test(thanMw), "middleware không được đọc CSDL (Edge) — và cũng không được giả vờ là mình biết quyền");
  assert.ok(/request\.method === "GET"/.test(thanMw), "luật chỉ-GET phải nằm ngay trong middleware, không nằm trong một lớp bọc nào khác");

  console.log(
    `✓ Phiên trượt: trước nửa đời không ký lại · qua nửa đời gia hạn · hết hạn thì chết · trần ${SESSION_ABSOLUTE_DAYS} ngày chặn phiên bất tử · SSE và chuông không còn 401 vì token cũ · POST (đăng xuất) không bị ghi đè · khoá tài khoản vẫn hiệu lực ngay`,
  );
}

/**
 * VÌ SAO KHÔNG BẤM ĐƯỢC GÌ TRÊN /ai/review — LẤY BẰNG CHỨNG, KHÔNG ĐOÁN.
 *
 *   npx tsx scripts/ai-staging-review-probe.ts --email=...
 *
 * Triệu chứng "trang hiện ra bình thường nhưng không control nào bấm được" gần như luôn có đúng
 * một nghĩa: HTML dựng từ máy chủ tới nơi, còn JS phía trình duyệt KHÔNG gắn được vào nó. Lúc đó
 * ngay cả một nút chỉ đổi `useState` cũng chết — nên đó KHÔNG phải chuyện quyền, không phải Server
 * Action, không phải CSDL.
 *
 * Tệp này đi tìm chỗ đứt ấy bằng cách làm đúng việc trình duyệt làm: lấy trang, đọc danh sách tệp
 * JS mà trang khai, rồi TẢI TỪNG TỆP và xem máy chủ trả gì. Một tệp 404 là câu trả lời đầy đủ.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { signSession } from "@/lib/auth/session";
import type { Role } from "@/db/schema";

const GOC = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
/** Trang cần dò. Mặc định là trang soát; truyền `--path=/ai/fanpage` để dò trang khác. */
const DUONG = process.argv.find((a) => a.startsWith("--path="))?.slice(7) || "/ai/review";

/**
 * CHUỖI PHẢI CÓ MẶT TRÊN TRANG — `--find=Cho máy soạn lại` (nhiều lần cũng được).
 *
 * Bài kiểm xanh KHÔNG chứng minh người dùng chạm tới được. Ngày 23/09/2026 một thẻ trên hàng đợi
 * hiện đúng một câu "Chỉ người đang cầm việc mới trả lại được" mà không kèm một cái nút nào —
 * typecheck sạch, lint sạch, `npm test` in TẤT CẢ KIỂM THỬ ĐẠT, và chủ shop thì không làm được gì.
 *
 * Nên sau mỗi lần sửa một NÚT, phải hỏi được một câu rất cụ thể: chữ trên nút ấy có thật sự nằm
 * trong HTML máy chủ vừa giao, ở đúng trạng thái dữ liệu THẬT hay không.
 */
function docChuoiCanTim(argv: string[]): string[] {
  /*
    GOM LẠI CÁC MẨU BỊ SHELL CẮT THEO DẤU CÁCH.

    Thao tác ops chạy `script.ts ${ARG}` không có nháy kép, nên `--find=Cho máy soạn lại` tới đây
    thành BỐN đối số. Bản đầu tiên chỉ đọc mẩu thứ nhất và in "✓ Cho — xuất hiện 18 lần": một
    phép kiểm ĐẠT trong khi nó đo nhầm thứ. Đó đúng là cái bẫy mà phép kiểm này sinh ra để chặn,
    nên nó không được phép mắc.

    Luật: sau `--find=`, nuốt tiếp mọi đối số cho tới đối số kế tiếp bắt đầu bằng `--`.
  */
  const ra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--find=")) continue;
    const mau = [argv[i].slice(7)];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) mau.push(argv[++i]);
    const chuoi = mau.join(" ").trim();
    if (chuoi) ra.push(chuoi);
  }
  return ra;
}

const PHAI_CO = docChuoiCanTim(process.argv);

async function main() {
  if (process.env.AI_STAGING !== "1" || process.env.AI_ALLOW_AUTO_SEND !== "false") {
    throw new Error("KHÔNG PHẢI CONTAINER BẢN CHẠY THỬ — dừng.");
  }
  const email = (process.argv.find((a) => a.startsWith("--email="))?.slice(8) ?? "").trim().toLowerCase();
  const matKhau = process.env.STAGING_USER_PASSWORD ?? "";
  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user) throw new Error(`Không có tài khoản ${email}`);
  if (!(await verifyPassword(matKhau, user.passwordHash))) throw new Error("Mật khẩu không khớp — không ký phiên.");
  const phien = await signSession({ id: user.id, email: user.email, name: user.name, role: user.role as Role });
  const cookie = `erp_session=${phien}`;

  console.log("───────── 1. TRANG DỰNG RA CÓ GÌ ─────────");
  console.log(`  đường dẫn: ${DUONG}`);
  const res = await fetch(`${GOC}${DUONG}`, { headers: { cookie }, redirect: "manual" });
  const html = res.status === 200 ? await res.text() : "";
  console.log(`  HTTP ${res.status} · ${html.length} ký tự`);
  if (res.status !== 200) {
    console.log(`  chuyển tới: ${res.headers.get("location") ?? "(không có)"}`);
    process.exit(1);
  }
  /*
    MỘT TRANG LỖI VẪN TRẢ HTTP 200.

    Next dựng được vỏ (thanh bên, đăng nhập) rồi mới gãy ở phần nội dung, nên mã trạng thái nói
    "ổn" trong khi người dùng thấy một khung lỗi. Chữ "Digest" là dấu vết Next để lại đúng chỗ ấy —
    bắt nó ở đây thì không phải tin vào ảnh chụp màn hình.
  */
  const dauLoi = /Digest[^0-9]{0,20}(\d{6,})/.exec(html);
  if (dauLoi) {
    console.log(`  ⛔ TRANG GÃY Ở PHẦN NỘI DUNG — mã truy vết (digest): ${dauLoi[1]}`);
  } else if (/application error|Something went wrong|đã xảy ra lỗi/i.test(html)) {
    console.log("  ⛔ TRANG GÃY (có khung lỗi nhưng không đọc được mã truy vết)");
  } else {
    console.log("  ✓ không thấy khung lỗi nào trong HTML");
  }
  const co = (s: string) => (html.includes(s) ? "CÓ" : "KHÔNG");
  console.log(`  khối "Chấm tay"        : ${co("Chấm tay")}`);
  console.log(`  nút "Lưu kết quả chấm" : ${co("Lưu kết quả chấm")}`);
  console.log(`  ô ghi chú              : ${co("Ghi chú (tuỳ chọn)")}`);
  console.log(`  trạng thái rỗng        : ${co("Chưa có lượt nào khớp bộ lọc")}`);
  const soNut = (html.match(/<button/g) ?? []).length;
  console.log(`  tổng số thẻ <button>   : ${soNut}`);

  console.log("");
  if (PHAI_CO.length) {
    console.log("───────── 1b. CHỮ TRÊN NÚT CÓ THẬT SỰ RA TỚI TRANG KHÔNG ─────────");
    let thieu = 0;
    for (const chu of PHAI_CO) {
      const co = html.includes(chu);
      if (!co) thieu += 1;
      console.log(`  ${co ? "✓" : "✗"} "${chu}"${co ? ` — xuất hiện ${html.split(chu).length - 1} lần` : " — KHÔNG CÓ trong HTML máy chủ giao"}`);
    }
    if (thieu) console.log(`  ⛔ ${thieu} chuỗi KHÔNG ra tới trang — tính năng không có đường bấm.`);
  }

  console.log("───────── 2. TRANG KHAI NHỮNG TỆP JS NÀO ─────────");
  const duong = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
  console.log(`  ${duong.length} tệp tĩnh được khai trong HTML`);
  if (!duong.length) {
    console.log("  ⛔ KHÔNG khai tệp JS nào — trang là HTML tĩnh, không đời nào bấm được.");
    process.exit(1);
  }

  console.log("");
  console.log("───────── 3. TẢI TỪNG TỆP — ĐÂY LÀ CHỖ ĐỨT NẾU CÓ ─────────");
  let hong = 0;
  for (const d of duong.slice(0, 40)) {
    const r = await fetch(`${GOC}${d}`, { headers: { cookie }, redirect: "manual" });
    const ok = r.status === 200;
    if (!ok) hong += 1;
    // Chỉ in tệp HỎNG và vài tệp đầu, để log không thành một bức tường chữ.
    if (!ok) console.log(`  ✗ ${r.status} ${d}`);
  }
  console.log(`  ${duong.length - hong}/${duong.length} tệp trả 200${hong ? ` · ${hong} tệp HỎNG` : ""}`);

  console.log("");
  console.log("───────── 4. RANH GIỚI CLIENT CÓ ĐƯỢC ĐÁNH DẤU KHÔNG ─────────");
  // Next nhét tải trọng RSC vào `self.__next_f`. Một client component phải xuất hiện ở đó dưới
  // dạng một tham chiếu tệp; không có nghĩa là cây không có ranh giới client nào để gắn vào.
  const coFlight = html.includes("__next_f");
  console.log(`  tải trọng RSC (__next_f): ${coFlight ? "CÓ" : "KHÔNG"}`);
  console.log(`  script nhúng            : ${(html.match(/<script/g) ?? []).length} thẻ`);
  if (hong === 0 && coFlight && soNut > 0) {
    console.log("");
    console.log("  ⇒ Máy chủ giao đủ HTML + JS. Chỗ đứt KHÔNG nằm ở phía máy chủ.");
  }
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});

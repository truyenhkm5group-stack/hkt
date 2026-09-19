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

/*
  BẢNG TRANG · DẤU HIỆU PHẢI CÓ.

  Trước đây tệp này dò ĐÚNG MỘT trang và dấu hiệu của trang ấy nằm thẳng trong mã. Nên mỗi bề mặt
  mới lại cần một lượt sửa tệp, và trên thực tế thì không ai sửa — bề mặt mới lên bản chạy thử mà
  KHÔNG có phép đo nào đứng sau nó.

  Dấu hiệu là CÂU CHỮ NGƯỜI ĐỌC THẤY, không phải tên lớp CSS hay id: câu chữ đổi thì có người
  nhận ra và đổi cả hai chỗ; tên lớp đổi thì phép đo âm thầm luôn xanh. Thiếu một dấu hiệu KHÔNG
  làm hỏng lượt chạy nếu trang vẫn dựng được — nó là một dòng để đọc, còn thứ làm đỏ là trang gãy
  hoặc tệp JS 404.
*/
const BANG_TRANG: { duong: string; dau: string[] }[] = [
  {
    duong: "/ai/review",
    dau: ["Chấm tay", "Lưu kết quả chấm", "Ghi chú (tuỳ chọn)", "Viền hổ phách", "Độ chính xác (chỉ tính trên phần đã chấm tay)"],
  },
  {
    duong: "/ai/fanpage",
    dau: ["Tình trạng vận hành", "Chỗ hổng dữ liệu đang tốn gì", "Thử kết nối", "Chứng thư Pancake"],
  },
  { duong: "/ai", dau: ["Lượt chạy"] },
  { duong: "/ai/copilot", dau: [] },
];

/** Dò MỘT trang thôi: `--path=/ai/fanpage`. Không truyền thì dò cả bảng trên. */
const CHI_MOT = process.argv.find((a) => a.startsWith("--path="))?.slice(7) ?? "";

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

  const danhSach = CHI_MOT ? [{ duong: CHI_MOT, dau: BANG_TRANG.find((x) => x.duong === CHI_MOT)?.dau ?? [] }] : BANG_TRANG;
  let hongTong = 0;

  for (const trang of danhSach) {
    console.log(`\n══════════ ${trang.duong} ══════════`);
    console.log("───────── 1. TRANG DỰNG RA CÓ GÌ ─────────");
    const res = await fetch(`${GOC}${trang.duong}`, { headers: { cookie }, redirect: "manual" });
    const html = res.status === 200 ? await res.text() : "";
    console.log(`  HTTP ${res.status} · ${html.length} ký tự`);
    if (res.status !== 200) {
      console.log(`  ✗ chuyển tới: ${res.headers.get("location") ?? "(không có)"}`);
      hongTong += 1;
      continue;
    }
    /*
      MỘT TRANG LỖI VẪN TRẢ HTTP 200.

      Next dựng được vỏ (thanh bên, đăng nhập) rồi mới gãy ở phần nội dung, nên mã trạng thái nói
      "ổn" trong khi người dùng thấy một khung lỗi. Chữ "Digest" là dấu vết Next để lại đúng chỗ
      ấy — bắt nó ở đây thì không phải tin vào ảnh chụp màn hình.
    */
    const dauLoi = /Digest[^0-9]{0,20}(\d{6,})/.exec(html);
    if (dauLoi) {
      console.log(`  ⛔ TRANG GÃY Ở PHẦN NỘI DUNG — mã truy vết (digest): ${dauLoi[1]}`);
      hongTong += 1;
    } else if (/application error|Something went wrong|đã xảy ra lỗi/i.test(html)) {
      console.log("  ⛔ TRANG GÃY (có khung lỗi nhưng không đọc được mã truy vết)");
      hongTong += 1;
    } else {
      console.log("  ✓ không thấy khung lỗi nào trong HTML");
    }
    for (const d of trang.dau) console.log(`  ${html.includes(d) ? "✓" : "⚠ THIẾU"} dấu hiệu: "${d}"`);
    const soNut = (html.match(/<button/g) ?? []).length;
    console.log(`  tổng số thẻ <button>   : ${soNut}`);

    console.log("\n───────── 2. TRANG KHAI NHỮNG TỆP JS NÀO ─────────");
    const duong = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
    console.log(`  ${duong.length} tệp tĩnh được khai trong HTML`);
    if (!duong.length) {
      console.log("  ⛔ KHÔNG khai tệp JS nào — trang là HTML tĩnh, không đời nào bấm được.");
      hongTong += 1;
      continue;
    }

    console.log("\n───────── 3. TẢI TỪNG TỆP — ĐÂY LÀ CHỖ ĐỨT NẾU CÓ ─────────");
    let hong = 0;
    for (const d of duong.slice(0, 40)) {
      const r = await fetch(`${GOC}${d}`, { headers: { cookie }, redirect: "manual" });
      if (r.status !== 200) {
        hong += 1;
        console.log(`  ✗ ${r.status} ${d}`);
      }
    }
    console.log(`  ${duong.length - hong}/${duong.length} tệp trả 200${hong ? ` · ${hong} tệp HỎNG` : ""}`);
    hongTong += hong;

    console.log("\n───────── 4. RANH GIỚI CLIENT CÓ ĐƯỢC ĐÁNH DẤU KHÔNG ─────────");
    // Next nhét tải trọng RSC vào `self.__next_f`. Một client component phải xuất hiện ở đó dưới
    // dạng một tham chiếu tệp; không có nghĩa là cây không có ranh giới client nào để gắn vào.
    const coFlight = html.includes("__next_f");
    console.log(`  tải trọng RSC (__next_f): ${coFlight ? "CÓ" : "KHÔNG"}`);
    if (hong === 0 && coFlight && soNut > 0) console.log("  ⇒ Máy chủ giao đủ HTML + JS. Chỗ đứt KHÔNG nằm ở phía máy chủ.");
    if (!coFlight) hongTong += 1;
  }

  /*
    ───────── 5. Ô TÌM CÓ THẬT SỰ THU HẸP KHÔNG ─────────

    Một ô tìm dựng ra được KHÔNG có nghĩa là nó lọc được gì. Phép đo đúng là ĐẾM SỐ VIỆC CHẤM
    ĐƯỢC trên trang, có và không có từ khoá, rồi so hai con số.

    ĐẾM NÚT CHẤM chứ không đếm thẻ `<form>`: bản đo đầu của tôi đếm `<form>` và ra hằng số 1 dù
    lọc hay không — nó đo cái khung, không đo cái bảng. Đếm chữ "đúng" trên các nút chấm thì con
    số đi theo số DÒNG, tức đi theo đúng thứ đang hỏi.
  */
  if (!CHI_MOT) {
    console.log("\n══════════ Ô TÌM TRÊN /ai/review ══════════");
    const dem = async (q: string) => {
      const r = await fetch(`${GOC}/ai/review?days=30${q ? `&q=${encodeURIComponent(q)}` : ""}`, { headers: { cookie }, redirect: "manual" });
      if (r.status !== 200) return -1;
      const h = await r.text();
      return (h.match(/>đúng</g) ?? []).length;
    };
    const khong = await dem("");
    const co = await dem("zzzkhongbaogiotontaizzz");
    console.log(`  không từ khoá : ${khong < 0 ? "HTTP lỗi" : khong} nút chấm`);
    console.log(`  từ khoá vô nghĩa: ${co < 0 ? "HTTP lỗi" : co} nút chấm`);
    if (khong > 0 && co === 0) console.log("  ✓ ô tìm THẬT SỰ thu hẹp — một từ khoá không tồn tại làm bảng rỗng.");
    else if (khong > 0 && co === khong) { console.log("  ✗ ô tìm KHÔNG thu hẹp — cùng số dòng dù từ khoá không tồn tại."); hongTong += 1; }
    else console.log("  ⚠ chưa kết luận được (bảng rỗng sẵn hoặc trang trả lỗi).");
  }

  console.log("\n───────── KẾT LUẬN ─────────");
  if (hongTong) {
    console.log(`  ✗ ${hongTong} vấn đề ở phía máy chủ bản chạy thử.`);
    process.exit(1);
  }
  console.log("  ✓ Mọi trang dò đều dựng được, JS giao đủ, không trang nào gãy.");
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});

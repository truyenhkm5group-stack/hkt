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
  const res = await fetch(`${GOC}/ai/review`, { headers: { cookie }, redirect: "manual" });
  const html = res.status === 200 ? await res.text() : "";
  console.log(`  HTTP ${res.status} · ${html.length} ký tự`);
  if (res.status !== 200) {
    console.log(`  chuyển tới: ${res.headers.get("location") ?? "(không có)"}`);
    process.exit(1);
  }
  const co = (s: string) => (html.includes(s) ? "CÓ" : "KHÔNG");
  console.log(`  khối "Chấm tay"        : ${co("Chấm tay")}`);
  console.log(`  nút "Lưu kết quả chấm" : ${co("Lưu kết quả chấm")}`);
  console.log(`  ô ghi chú              : ${co("Ghi chú (tuỳ chọn)")}`);
  console.log(`  trạng thái rỗng        : ${co("Chưa có lượt nào khớp bộ lọc")}`);
  const soNut = (html.match(/<button/g) ?? []).length;
  console.log(`  tổng số thẻ <button>   : ${soNut}`);

  console.log("");
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

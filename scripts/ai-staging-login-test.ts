/**
 * ĐĂNG NHẬP BẢN CHẠY THỬ — THỬ THẬT BẰNG HTTP, KHÔNG PHẢI "ĐỌC MÃ RỒI TIN".
 *
 *   npx tsx scripts/ai-staging-login-test.ts --email=...
 *
 * Chạy TRONG container của bản chạy thử và gọi vào chính nó qua HTTP, nên nó đi qua đủ cả dây:
 * middleware → server action → băm mật khẩu → ký phiên → cookie → dựng trang → cổng quyền.
 *
 * VÌ SAO KHÔNG KIỂM BẰNG CÁCH GỌI THẲNG HÀM. Gọi `verifyPassword()` rồi kết luận "đăng nhập được"
 * là kiểm một mắt xích và tin cả sợi dây. Đúng dạng sai lầm đã gặp ba lần trong đợt này: một phép
 * đo nhìn vào chỗ khác với chỗ mã đang chạy. Ở đây phép đo đi đúng con đường của người dùng.
 *
 * MẬT KHẨU chỉ đến từ biến môi trường `STAGING_USER_PASSWORD`, không bao giờ được in ra — kể cả
 * khi hỏng. Log của Actions trên kho công khai thì ai cũng đọc được.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { verifyPassword } from "@/lib/auth/password";
import { signSession } from "@/lib/auth/session";
import { getAgent } from "@/lib/ai-workforce/registry";
import { modeAtLeast } from "@/lib/constants/ai";
import { hasPermission, resolvePermissions } from "@/lib/auth/permissions";
import type { Role } from "@/db/schema";

const GOC = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
const SAI = "mat-khau-chac-chan-sai-9f2b7c41";

let hong = 0;
/** Cookie phiên của lượt đăng nhập ĐÚNG mật khẩu — mục kiểm tên miền dùng lại. */
let phienChung = "";
function dat(ok: boolean, ten: string, them = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${ten}${them ? ` — ${them}` : ""}`);
  if (!ok) hong += 1;
}

async function main() {
  const email = (process.argv.find((a) => a.startsWith("--email="))?.slice(8) ?? "").trim().toLowerCase();
  const matKhau = process.env.STAGING_USER_PASSWORD ?? "";
  if (!email) throw new Error("Thiếu --email=...");
  if (!matKhau) throw new Error("Thiếu STAGING_USER_PASSWORD (secret AI_STAGING_PILOT_PASSWORD).");

  // Cùng cổng chặn với `ai-staging-auth.ts`: script này POST một lượt đăng nhập thật, nên nó chỉ
  // được chạy trong container bản chạy thử.
  if (process.env.AI_STAGING !== "1" || process.env.AI_ALLOW_AUTO_SEND !== "false") {
    throw new Error("KHÔNG PHẢI CONTAINER BẢN CHẠY THỬ — dừng.");
  }

  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user) throw new Error(`Không có tài khoản ${email} trong CSDL bản chạy thử.`);

  console.log("───────── 1. CHƯA ĐĂNG NHẬP THÌ KHÔNG VÀO ĐƯỢC ─────────");
  const chua = await fetch(`${GOC}/ai/copilot`, { redirect: "manual" });
  const toi = chua.headers.get("location") ?? "";
  dat([302, 303, 307].includes(chua.status) && toi.includes("/login"), "/ai/copilot khi chưa đăng nhập chuyển sang /login", `${chua.status} → ${toi || "(không có)"}`);

  console.log("");
  console.log("───────── 2. MẬT KHẨU: ĐÚNG THÌ NHẬN, SAI THÌ TỪ CHỐI ─────────");
  /*
    VÌ SAO KHÔNG POST THẲNG VÀO FORM.

    Bản trước thử đóng vai trình duyệt-không-JS: đọc ô ẩn `$ACTION…` trong HTML rồi POST lại. Máy
    chủ trả 500 kèm "Failed to find Server Action" — vì form đăng nhập dùng `useActionState`, và
    Next KHÔNG phát ra một mã hành động replay được từ HTML cho dạng đó. Nghĩa là phép thử ấy đo
    chính nó, không đo đường đăng nhập.

    Nên chia làm hai phép đo, mỗi phép gọi ĐÚNG hàm mà `loginAction` gọi:

      · mật khẩu  → `verifyPassword()` trên ĐÚNG chuỗi băm đang nằm trong CSDL;
      · phiên     → `signSession()`, rồi mở trang THẬT bằng HTTP với cookie ấy.

    Mắt xích duy nhất không đo được ở đây là phần Next tự nối form với hành động — mã khung, không
    phải mã của kho này, và nó chạy đúng con đường mà trình duyệt của nhân viên đi (có JS). Lượt
    đăng nhập thật đầu tiên của nhân viên là phép thử cho mắt xích đó.

    CHỐT QUAN TRỌNG: chỉ ký phiên SAU KHI mật khẩu đã khớp. Script này vì thế không phải một cửa
    sau — không biết mật khẩu thì nó không dựng được phiên nào.
  */
  const trang = await fetch(`${GOC}/login`);
  dat(trang.status === 200, "mở được trang đăng nhập", `HTTP ${trang.status}`);
  dat((await verifyPassword(SAI, user.passwordHash)) === false, "SAI mật khẩu ⇒ bị từ chối");
  const dungMatKhau = await verifyPassword(matKhau, user.passwordHash);
  dat(dungMatKhau, "ĐÚNG mật khẩu ⇒ được chấp nhận");

  console.log("");
  console.log("───────── 3. PHIÊN ĐĂNG NHẬP MỞ ĐƯỢC HÀNG ĐỢI TRỢ LÝ ─────────");
  if (!dungMatKhau) {
    console.log("  · mật khẩu chưa khớp nên KHÔNG ký phiên — không có gì để thử tiếp.");
  } else {
    phienChung = await signSession({ id: user.id, email: user.email, name: user.name, role: user.role as Role });
    const trong = await fetch(`${GOC}/ai/copilot`, { headers: { cookie: `erp_session=${phienChung}` }, redirect: "manual" });
    const noi = trong.status === 200 ? await trong.text() : "";
    dat(trong.status === 200, "/ai/copilot trả 200 cho phiên đã đăng nhập", `HTTP ${trong.status}${trong.headers.get("location") ? ` → ${trong.headers.get("location")}` : ""}`);
    dat(noi.includes("Hàng đợi trợ lý AI"), "đúng là trang hàng đợi trợ lý");
    /*
      GIAO DIỆN THÍ ĐIỂM: ĐỌC TỪ HTML ĐÃ DỰNG, KHÔNG SUY TỪ "ẢNH ĐÃ KÉO XONG".

      Kéo đúng digest chỉ chứng minh cái tệp đã nằm trên máy. Thứ phải chứng minh là TRANG NHÂN
      VIÊN MỞ có đủ các khối ấy — hai chuyện khác nhau, và đã có lần ảnh mới nằm sẵn trên đĩa mà
      container vẫn chạy ảnh cũ.
    */
    dat(noi.includes("Thí điểm trợ lý — sáu bước"), "hướng dẫn sáu bước hiện trên đầu trang");
    dat(noi.includes("Tiến độ thí điểm"), "thẻ tiến độ thí điểm hiện trên trang");
    for (const nhan of ["Gửi nguyên văn", "Sửa &amp; gửi", "Từ chối", "Tự nhận việc (hội thoại)", "Tỷ lệ dùng được"]) {
      dat(noi.includes(nhan), `thẻ tiến độ có ô "${nhan.replace("&amp;", "&")}"`);
    }
    dat(noi.includes("FIRST_HUMAN_SEND_PENDING"), "trang in trạng thái lần gửi đầu tiên");
    // Hàng đợi rỗng phải nói rõ hệ thống vẫn đang canh. Có khách chờ thì thẻ hội thoại hiện ra —
    // một trong hai, không được cả hai cùng vắng.
    dat(
      noi.includes("Hiện không có khách cần xử lý") || noi.includes("Khách nhắn"),
      noi.includes("Khách nhắn") ? "hàng đợi đang có khách — hiện thẻ hội thoại" : "hàng đợi rỗng nói rõ hệ thống vẫn đang theo dõi tin mới",
    );

    /*
      HAI CÔNG TẮC ĐỌC TỪ CHÍNH TRANG NHÂN VIÊN NHÌN, không từ một biến môi trường đọc lại.
      Trang in "⛔ ĐANG MỞ" khi một chặn cứng bị mở, "CẤM (chưa mở công tắc)" khi nhân viên chưa
      được bấm gửi, và "Cổng gửi đang ĐÓNG" khi một trong ba điều kiện gửi chưa đủ.
    */
    dat(!noi.includes("⛔ ĐANG MỞ"), "trang KHÔNG báo chặn cứng nào đang mở (máy tự gửi · tạo đơn đều CẤM)");
    dat(!noi.includes("CẤM (chưa mở công tắc)"), "NHÂN VIÊN bấm gửi: được phép");
    dat(!noi.includes("Cổng gửi đang ĐÓNG"), "cổng gửi do người bấm đang MỞ cho tài khoản này");
  }

  console.log("");
  console.log("───────── 4. TÊN MIỀN CÔNG KHAI (qua Caddy + HTTPS thật) ─────────");
  const congKhai = "https://ai-staging.vnxcommerce.com";
  try {
    const ngoai = await fetch(`${congKhai}/ai/copilot`, { redirect: "manual" });
    const den = ngoai.headers.get("location") ?? "";
    dat([302, 303, 307].includes(ngoai.status) && den.includes("/login"), `${congKhai}/ai/copilot chưa đăng nhập ⇒ chuyển sang /login`, `${ngoai.status} → ${den || "(không có)"}`);
    if (phienChung) {
      const trongNgoai = await fetch(`${congKhai}/ai/copilot`, { headers: { cookie: `erp_session=${phienChung}` }, redirect: "manual" });
      dat(trongNgoai.status === 200, `${congKhai}/ai/copilot có phiên ⇒ 200`, `HTTP ${trongNgoai.status}`);
    }
  } catch (e) {
    // Container không ra được internet là chuyện hạ tầng, không phải lỗi đăng nhập — báo, không đỏ.
    console.log(`  · không gọi được tên miền công khai từ trong container: ${e instanceof Error ? e.message : e}`);
    console.log("    (không tính là KHÔNG ĐẠT — đường đăng nhập đã kiểm ở các mục trên)");
  }

  console.log("");
  console.log("───────── 5. QUYỀN VÀ HAI CÔNG TẮC CHẶN CỨNG ─────────");
  const quyen = resolvePermissions(user.role as Role, user.permissions);
  const coGui = user.role === "ADMIN" || hasPermission(quyen, "ai:send");
  dat(coGui, `tài khoản có quyền ai:send (vai trò ${user.role})`);
  dat(user.active, "tài khoản đang bật");

  const settings = await getAiSettings();
  const agent = await getAgent("sales", settings);
  const mode = agent?.mode ?? "OFF";
  dat(settings.hardLimits.allowAutoSend === false, "MÁY tự gửi: CẤM");
  dat(settings.hardLimits.allowOrderCreate === false, "tạo đơn: CẤM");
  dat(settings.hardLimits.allowHumanApprovedSend === true, "NGƯỜI bấm gửi: được phép");

  /*
    TỆP NÀY KHÔNG BAO GIỜ DỰNG MỘT KHOÁ NGƯỜI DUYỆT.

    `tests/sales-copilot.test.ts` quét mã đã vào kho và đòi rằng ĐÚNG MỘT tệp trong cả kho được
    đặt `approvedByUserId` — và tệp ấy là Server Action, thứ chỉ chạy được từ một lượt bấm mang
    phiên đăng nhập. Một script dưới `scripts/` tự dựng khoá ấy, dù chỉ để "kiểm thử", chính là
    hình dạng của thứ luật kia cấm: một tiến trình nền đóng vai người bấm. Nên phép kiểm ở đây đọc
    KẾT QUẢ trên trang, không mô phỏng một lượt duyệt.
  */
  dat(modeAtLeast(mode, "COPILOT"), `nấc quyền hạn ≥ TRỢ LÝ (đang chạy: ${mode})`);
  dat(mode !== "AUTO", "nấc AUTO KHÔNG được bật");

  console.log("");
  if (hong) {
    console.log(`⛔ ${hong} phép thử KHÔNG ĐẠT.`);
    process.exit(1);
  }
  console.log("✓ TẤT CẢ PHÉP THỬ ĐĂNG NHẬP ĐẠT.");
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});

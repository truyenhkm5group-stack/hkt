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

/** Lấy các ô ẩn mà Next dựng cho Server Action (dạng `$ACTION_...`). Không có ⇒ không thử được. */
function oAction(html: string): [string, string][] {
  const ra: [string, string][] = [];
  const re = /<input[^>]*type="hidden"[^>]*>/g;
  for (const the of html.match(re) ?? []) {
    const ten = /name="(\$ACTION[^"]*)"/.exec(the)?.[1];
    if (!ten) continue;
    ra.push([ten, /value="([^"]*)"/.exec(the)?.[1] ?? ""]);
  }
  return ra;
}

function cookiePhien(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const m = /^erp_session=([^;]*)/.exec(c);
    if (m && m[1]) return m[1];
  }
  return "";
}

async function dangNhap(email: string, matKhau: string, oAn: [string, string][]) {
  const form = new FormData();
  for (const [k, v] of oAn) form.append(k, v);
  form.append("next", "/");
  form.append("email", email);
  form.append("password", matKhau);
  /*
    `Origin` PHẢI CÓ VÀ PHẢI KHỚP. Next 15 chặn mọi lượt gọi Server Action mà nó không tin là
    cùng gốc — thiếu tiêu đề này thì lượt POST bị từ chối TRƯỚC khi `loginAction` chạy dòng nào,
    và cái ta đo được sẽ là hàng rào chống giả mạo chứ không phải đường đăng nhập.
  */
  return fetch(`${GOC}/login`, { method: "POST", body: form, redirect: "manual", headers: { origin: GOC } });
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
  console.log("───────── 2. SAI MẬT KHẨU PHẢI BỊ TỪ CHỐI ─────────");
  const trang = await fetch(`${GOC}/login`);
  const html = await trang.text();
  const oAn = oAction(html);
  dat(trang.status === 200, "mở được trang đăng nhập", `HTTP ${trang.status}`);
  if (!oAn.length) {
    console.log("  ⚠ Không tìm thấy ô ẩn Server Action trong HTML — không thử POST được từ script.");
    console.log("    KHÔNG kết luận ĐẠT. Phải thử bằng trình duyệt thật.");
    hong += 1;
  } else {
    const xau = await dangNhap(email, SAI, oAn);
    const than = await xau.text().catch(() => "");
    dat(!cookiePhien(xau), "sai mật khẩu KHÔNG cấp cookie phiên");
    /*
      MỘT LỖI 500 KHÔNG PHẢI MỘT LẦN TỪ CHỐI ĐÚNG.

      Bản đầu chấp nhận `status >= 400` là đạt. Nhưng máy chủ hỏng cũng trả 4xx/5xx và cũng không
      cấp cookie — nên cả hai phép thử đều XANH trong khi đường đăng nhập chưa chạy dòng nào. Đúng
      cái bẫy đã gặp nhiều lần trong đợt này: một phép đo nhìn vào chỗ khác chỗ mã đang chạy.
      Phải đòi ĐÚNG câu từ chối, và đòi máy chủ không hỏng.
    */
    dat(xau.status < 500, "lượt sai mật khẩu KHÔNG làm máy chủ lỗi", `HTTP ${xau.status}`);
    dat(than.includes("Email hoặc mật khẩu không đúng"), "sai mật khẩu trả về ĐÚNG câu từ chối");

    console.log("");
    console.log("───────── 3. ĐÚNG MẬT KHẨU PHẢI VÀO ĐƯỢC ─────────");
    const tot = await dangNhap(email, matKhau, oAn);
    const phien = cookiePhien(tot);
    phienChung = phien;
    dat(Boolean(phien), "đúng mật khẩu ⇒ được cấp cookie erp_session", `HTTP ${tot.status}`);
    if (!phien) {
      // Manh mối để khỏi phải đoán. Thân phản hồi của Next ở chế độ production không mang chi tiết
      // lỗi, nên in cả mã truy vết — log container mới có câu đầy đủ.
      const than2 = await tot.text().catch(() => "");
      const dau = /"digest":"(\d+)"|Digest: (\d+)/.exec(than2);
      console.log(`    · mã truy vết lỗi: ${dau ? dau[1] ?? dau[2] : "(không có)"}`);
      console.log(`    · vị trí chuyển tới: ${tot.headers.get("location") ?? "(không có)"} · x-nextjs: ${tot.headers.get("x-nextjs-redirect") ?? "-"}`);
      console.log(`    · đầu thân phản hồi: ${than2.slice(0, 160).replace(/\s+/g, " ")}`);
    }

    if (phien) {
      console.log("");
      console.log("───────── 4. VÀO THẲNG HÀNG ĐỢI TRỢ LÝ ─────────");
      const trong = await fetch(`${GOC}/ai/copilot`, { headers: { cookie: `erp_session=${phien}` }, redirect: "manual" });
      const noi = trong.status === 200 ? await trong.text() : "";
      dat(trong.status === 200, "/ai/copilot trả 200 cho phiên vừa đăng nhập", `HTTP ${trong.status}${trong.headers.get("location") ? ` → ${trong.headers.get("location")}` : ""}`);
      dat(noi.includes("Hàng đợi trợ lý AI"), "đúng là trang hàng đợi trợ lý");
      /*
        HƯỚNG DẪN SÁU BƯỚC là của ẢNH MỚI, không phải của đường đăng nhập. Một bài kiểm đăng nhập
        đỏ vì giao diện chưa kịp triển khai là một bài kiểm nói sai chỗ hỏng — nên dòng này chỉ
        BÁO, không tính vào kết quả.
      */
      console.log(`  · giao diện thí điểm (hướng dẫn sáu bước): ${noi.includes("Thí điểm trợ lý — sáu bước") ? "ĐÃ LÊN" : "CHƯA LÊN (ảnh cũ) — không ảnh hưởng đăng nhập"}`);

      /*
        HAI CÔNG TẮC ĐỌC TỪ CHÍNH TRANG NHÂN VIÊN NHÌN, không từ một biến môi trường đọc lại.

        Trang này in "⛔ ĐANG MỞ" khi một trong hai chặn cứng bị mở, "CẤM (chưa mở công tắc)" khi
        nhân viên chưa được bấm gửi, và "Cổng gửi đang ĐÓNG" khi một trong ba điều kiện gửi chưa
        đủ. Kiểm ngay trên HTML là kiểm đúng thứ người dùng thấy — đã ba lần trong đợt này một
        phép đo nhìn vào chỗ khác với chỗ mã đang chạy và nó nói dối.
      */
      dat(!noi.includes("⛔ ĐANG MỞ"), "trang KHÔNG báo chặn cứng nào đang mở (máy tự gửi · tạo đơn đều CẤM)");
      dat(!noi.includes("CẤM (chưa mở công tắc)"), "NHÂN VIÊN bấm gửi: được phép");
      dat(!noi.includes("Cổng gửi đang ĐÓNG"), "cổng gửi do người bấm đang MỞ cho tài khoản này");
    }
  }

  console.log("");
  console.log("───────── 5. TÊN MIỀN CÔNG KHAI (qua Caddy + HTTPS thật) ─────────");
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
  console.log("───────── 6. QUYỀN VÀ HAI CÔNG TẮC CHẶN CỨNG ─────────");
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

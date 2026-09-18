/**
 * ĐĂNG NHẬP BẢN CHẠY THỬ — KIỂM TRA VÀ VÁ, TRONG ĐÚNG MỘT TỆP.
 *
 *   npx tsx scripts/ai-staging-auth.ts --check
 *   npx tsx scripts/ai-staging-auth.ts --user --email=... --name="..." [--role=CS]
 *
 * ─── VÌ SAO KHÔNG AI ĐĂNG NHẬP ĐƯỢC ───
 *
 * Bản chạy thử có CSDL RIÊNG. Nó không đọc bảng `users` của production, và cũng không nên: một
 * bản chạy thử ghi được vào CSDL nghiệp vụ thật là một bản chạy thử có thể làm hỏng sổ sách thật.
 *
 * Lần dựng đầu, `ensureAdminUser()` tạo MỘT tài khoản quản trị từ `.env.staging`. Mà
 * `scripts/staging-up.sh` sinh `ADMIN_PASSWORD` bằng `openssl rand -base64 18` NGAY TRÊN MÁY CHỦ
 * và không in ra đâu cả. Đó là quyết định đúng về an toàn — và cũng đúng là lý do không một ai,
 * kể cả chủ shop, biết mật khẩu ấy. Tài khoản TỒN TẠI nhưng KHÔNG AI MỞ ĐƯỢC.
 *
 * ─── MẬT KHẨU ĐI ĐƯỜNG NÀO ───
 *
 * Qua biến môi trường `STAGING_USER_PASSWORD`, lấy từ GitHub Actions Secret. KHÔNG qua ô `arg`
 * (ô đó in nguyên văn vào log), KHÔNG in ra màn hình, KHÔNG ghi vào kho mã. Kho mã này CÔNG KHAI
 * và log Actions của kho công khai thì ai cũng đọc được — một mật khẩu in ra đó là một mật khẩu
 * đã mất.
 *
 * Tệp này KHÔNG BAO GIỜ in mật khẩu hay chuỗi băm. Nó chỉ in: có tồn tại không · vai trò · còn
 * hiệu lực không · có quyền vào hàng đợi trợ lý không.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hashPassword } from "@/lib/auth/password";
import { hasPermission, resolvePermissions } from "@/lib/auth/permissions";
import { roleEnum, type Role } from "@/db/schema";

const COPILOT_PERMISSION = "ai:send";

/**
 * CHỈ CHẠY TRÊN BẢN CHẠY THỬ.
 *
 * Tệp này GHI vào bảng `users`. Một script ghi tài khoản mà chạy nhầm vào CSDL production là
 * chuyện không sửa lại được bằng một lần bấm. Nên nó tự từ chối nếu chuỗi kết nối không trỏ tới
 * CSDL của bản chạy thử — nhánh lỗi rơi về phía KHÔNG LÀM GÌ.
 */
function banChayThu(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("Thiếu DATABASE_URL — không xác định được đang nối vào CSDL nào, nên dừng.");

  /*
    KHÔNG DÙNG `DATABASE_URL` LÀM BẰNG CHỨNG. Hai bản dùng CÙNG một chuỗi `@db:5432/erp` (compose
    đặt tên dịch vụ giống nhau ở cả hai nơi) — nên nhìn vào nó là nhìn vào đúng chỗ KHÔNG phân biệt
    được. Phải dùng hai dấu hiệu độc lập, và đòi CẢ HAI:

      · `AI_STAGING=1` — do chính lệnh `docker exec` trong workflow đặt, nơi tên container đích
        (`vnx-ai-staging-app`) được viết ra tường minh;
      · hai công tắc chặn cứng ghim "false" — CHỈ `docker-compose.staging.yml` ghim chúng;
        `docker-compose.prod.yml` không ghim `AI_ALLOW_*` nào.

    Một dấu hiệu thì sao chép nhầm được; hai dấu hiệu ở hai tệp khác nhau thì không.
  */
  const goiDungCho = process.env.AI_STAGING === "1";
  const ghimCung = process.env.AI_ALLOW_AUTO_SEND === "false" && process.env.AI_ALLOW_ORDER_CREATE === "false";
  if (!goiDungCho || !ghimCung) {
    throw new Error(
      "KHÔNG PHẢI CONTAINER BẢN CHẠY THỬ (thiếu AI_STAGING=1 hoặc thiếu công tắc chặn cứng ghim ở compose).\n" +
        "Tệp này GHI vào bảng users nên nhánh nghi ngờ rơi về phía KHÔNG LÀM GÌ.",
    );
  }
  return url.replace(/:\/\/[^@]*@/, "://***@");
}

function doc(ten: string, mac = ""): string {
  const co = process.argv.find((a) => a.startsWith(`--${ten}=`));
  return co ? co.slice(ten.length + 3) : mac;
}

/** In hồ sơ MỘT tài khoản — không bao giờ in chuỗi băm. */
function inNguoi(u: { email: string; name: string; role: string; active: boolean; permissions: string[] | null; passwordHash: string }) {
  const quyen = resolvePermissions(u.role as Role, u.permissions);
  const vao = u.role === "ADMIN" || hasPermission(quyen, COPILOT_PERMISSION);
  console.log(
    `  ${u.email.padEnd(32)} vai trò ${String(u.role).padEnd(11)} ${u.active ? "đang bật" : "ĐÃ KHOÁ  "} ` +
      `${u.passwordHash ? "có mật khẩu" : "CHƯA CÓ MẬT KHẨU"}  ${vao ? "✓ vào được hàng đợi trợ lý" : "✗ KHÔNG có quyền ai:send"}`,
  );
}

async function kiemTra() {
  const db = await getDb();
  console.log("───────── 1. ĐANG XÁC THỰC TỪ ĐÂU ─────────");
  console.log(`  nguồn danh tính : bảng "users" trong CSDL của CHÍNH bản chạy thử`);
  console.log(`  chuỗi kết nối   : ${banChayThu()}  (production trông y hệt ở chỗ này — xem chú thích ở banChayThu)`);
  console.log(`  cơ chế          : mật khẩu bcrypt trong CSDL → phiên JWT ký bằng AUTH_SECRET → cookie "erp_session"`);
  console.log(`  KHÔNG có        : NextAuth, dịch vụ xác thực riêng, hay đọc chéo sang CSDL production`);
  console.log("");

  console.log("───────── 2. CẤU HÌNH ẢNH HƯỞNG TỚI COOKIE ─────────");
  const appUrl = process.env.APP_URL ?? "(chưa đặt)";
  const nodeEnv = process.env.NODE_ENV ?? "(chưa đặt)";
  const secure = nodeEnv === "production" && appUrl.startsWith("https");
  console.log(`  APP_URL         : ${appUrl}`);
  console.log(`  NODE_ENV        : ${nodeEnv}`);
  console.log(`  AUTH_SECRET     : ${process.env.AUTH_SECRET ? `đã đặt (dài ${process.env.AUTH_SECRET.length} ký tự)` : "⛔ CHƯA ĐẶT"}`);
  console.log(`  cookie Secure   : ${secure ? "có" : "KHÔNG — cookie phiên đi được cả trên HTTP"}`);
  console.log(`  cookie domain   : không đặt ⇒ chỉ gắn với đúng tên miền đang mở (đúng cho ai-staging.vnxcommerce.com)`);
  console.log(`  cookie SameSite : lax · httpOnly · path=/`);
  if (!secure) {
    console.log(`  ⚠ APP_URL không phải https ⇒ cờ Secure TẮT. Đăng nhập VẪN chạy (trình duyệt gửi cookie thường qua HTTPS`);
    console.log(`    bình thường), nhưng nên sửa: thao tác ops "ai-staging-auth" với arg "--fix-app-url".`);
  }
  console.log("");

  console.log("───────── 3. CÓ TÀI KHOẢN NÀO KHÔNG ─────────");
  const users = await db.query.users.findMany({
    columns: { email: true, name: true, role: true, active: true, permissions: true, passwordHash: true, lastLoginAt: true },
    limit: 50,
  });
  if (!users.length) {
    console.log("  ⛔ KHÔNG CÓ TÀI KHOẢN NÀO. Không ai đăng nhập được cho tới khi tạo một tài khoản.");
  } else {
    for (const u of users) inNguoi(u);
    const daVao = users.filter((u) => u.lastLoginAt).length;
    console.log("");
    console.log(`  ${users.length} tài khoản · ${daVao} tài khoản đã từng đăng nhập được`);
    if (!daVao) {
      console.log("  ⚠ CHƯA AI ĐĂNG NHẬP ĐƯỢC LẦN NÀO — khớp với giả thiết: mật khẩu sinh ngẫu nhiên trên máy chủ, không ai biết.");
    }
  }
}

async function taoNguoi() {
  const db = await getDb();
  banChayThu();
  const email = doc("email").trim().toLowerCase();
  const name = doc("name").trim() || email.split("@")[0];
  const role = (doc("role", "CS").trim().toUpperCase() || "CS") as Role;
  const matKhau = process.env.STAGING_USER_PASSWORD ?? "";

  if (!email || !email.includes("@")) throw new Error('Thiếu --email=... (ví dụ --email="ha@vnxcommerce.com")');
  if (!(roleEnum.enumValues as readonly string[]).includes(role)) {
    throw new Error(`Vai trò "${role}" không có trong danh sách đóng: ${roleEnum.enumValues.join(" · ")}`);
  }
  if (!matKhau) {
    throw new Error(
      "Thiếu STAGING_USER_PASSWORD. Mật khẩu KHÔNG đi qua ô arg (ô đó in vào log công khai) — hãy khai\n" +
        "  Settings → Secrets and variables → Actions → New repository secret\n" +
        "  tên: AI_STAGING_PILOT_PASSWORD\n" +
        "rồi chạy lại thao tác này.",
    );
  }
  if (matKhau.length < 10) throw new Error("Mật khẩu ngắn hơn 10 ký tự — bản chạy thử mở ra internet nên không nhận.");

  const dangCo = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  const hash = await hashPassword(matKhau);
  if (dangCo) {
    await db.update(schema.users).set({ name, role, active: true, passwordHash: hash }).where(eq(schema.users.id, dangCo.id));
    console.log(`✓ CẬP NHẬT tài khoản đã có: ${email}`);
  } else {
    await db.insert(schema.users).values({ email, name, role, active: true, passwordHash: hash });
    console.log(`✓ TẠO MỚI tài khoản: ${email}`);
  }
  const sau = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
    columns: { email: true, name: true, role: true, active: true, permissions: true, passwordHash: true },
  });
  if (sau) inNguoi(sau);
  console.log("");
  console.log("  (mật khẩu KHÔNG được in ra ở bất kỳ đâu — người nhận đã biết nó từ chỗ khai secret)");
}

async function main() {
  const co = (c: string) => process.argv.includes(`--${c}`);
  if (co("user")) {
    await taoNguoi();
    console.log("");
  }
  await kiemTra();
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});

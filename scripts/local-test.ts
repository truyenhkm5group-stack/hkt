/**
 * ═══════════ DỰNG BẢN TEST TRÊN MÁY (localhost) ═══════════
 *
 *   npm run local          → chuẩn bị rồi mở giao diện ở http://localhost:3000
 *   npm run local:setup    → chỉ chuẩn bị (không chạy giao diện)
 *   npm run local:reset    → xoá sạch dữ liệu thử rồi gieo lại từ đầu
 *
 * Cờ: `--reset` (xoá dữ liệu thử trước), `--no-demo` (không gieo dữ liệu mẫu).
 *
 * Bản test là một ERP RIÊNG chạy trên máy cá nhân, dựng để xem tận mắt trước khi đưa thay đổi lên
 * ERP thật. Ba điều quyết định cách viết tệp này:
 *
 *   1. **Không bao giờ chạm vào dữ liệu thật.** Địa chỉ CSDL do chính lệnh này đặt
 *      (`pglite://./data/pglite-local`), không đọc từ `.env` của máy chủ; nếu người dùng tự đổi
 *      sang một địa chỉ ngoài máy thì `guardLocalDatabase` chặn ngay, vì lệnh này XOÁ và GIEO lại.
 *   2. **Không gọi ra ngoài.** Khoá Pancake / Viettel Post / Facebook bị để trống trong
 *      `.env.local`, nên bản test không kéo đơn thật cũng không đẩy gì đi đâu.
 *   3. **Nhìn là biết đây là bản test.** Cờ `ERP_LOCAL_TEST=1` bật dải cảnh báo trên mọi trang.
 *
 * PGlite chỉ cho MỘT tiến trình mở thư mục dữ liệu, nên tiến trình này KHÔNG tự mở CSDL: nó gọi
 * `scripts/seed-admin.ts` rồi `scripts/seed-demo.ts` lần lượt như tiến trình con.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_TEST_DATABASE_URL, LOCAL_TEST_FLAG, LOCAL_TEST_URL, guardLocalDatabase, pgliteDirectory } from "@/lib/local-mode";

const ENV_FILE = path.join(process.cwd(), ".env.local");
const reset = process.argv.includes("--reset");
const noDemo = process.argv.includes("--no-demo");

/** Giá trị mặc định của bản test. Khoá để trống = tắt tích hợp ngoài, cố ý. */
function defaults(): [string, string, string?][] {
  return [
    ["DATABASE_URL", LOCAL_TEST_DATABASE_URL, "CSDL nhúng của riêng bản test — xoá thư mục này là mất sạch, không sao cả."],
    [LOCAL_TEST_FLAG, "1", "Bật dải cảnh báo “BẢN TEST” trên mọi trang. Máy chủ thật không đặt cờ này."],
    ["APP_URL", LOCAL_TEST_URL],
    ["AUTH_SECRET", randomBytes(32).toString("hex"), "Khoá ký phiên đăng nhập, sinh ngẫu nhiên cho riêng máy này."],
    ["CRON_SECRET", randomBytes(24).toString("hex")],
    ["ADMIN_EMAIL", "admin@shop.local", "Tài khoản đăng nhập bản test."],
    ["ADMIN_PASSWORD", "Admin@12345"],
    ["ADMIN_NAME", "Quản trị viên (bản test)"],
    ["PANCAKE_API_KEY", "", "Từ đây trở xuống để TRỐNG: bản test không gọi API thật. Điền vào nếu cần thử một tích hợp."],
    ["PANCAKE_SHOP_ID", ""],
    ["PANCAKE_ACCESS_TOKEN", ""],
    ["PANCAKE_WEBHOOK_SECRET", ""],
    ["VIETTELPOST_API_KEY", ""],
    ["VIETTELPOST_USERNAME", ""],
    ["VIETTELPOST_PASSWORD", ""],
    ["VIETTELPOST_WEBHOOK_SECRET", ""],
    ["FACEBOOK_ACCESS_TOKEN", ""],
  ];
}

/** Đọc tệp .env đơn giản: KEY=value hoặc KEY="value", bỏ qua dòng trống và dòng chú thích. */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function thoat(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * Chuẩn bị `.env.local`: chỉ BỔ SUNG khoá còn thiếu, không bao giờ đè giá trị người dùng đã sửa —
 * ai đó đã điền token thật để thử một tích hợp thì lần chạy sau không được xoá mất công đó.
 */
function chuanBiEnv(): Record<string, string> {
  const hienCo = readEnvFile(ENV_FILE);
  const thieu = defaults().filter(([key]) => !(key in hienCo));
  if (thieu.length) {
    const dauTien = !existsSync(ENV_FILE);
    const khoi = [
      dauTien ? "# Cấu hình BẢN TEST TRÊN MÁY do `npm run local:setup` sinh ra." : `# Bổ sung ngày ${new Date().toISOString().slice(0, 10)} bởi \`npm run local:setup\`.`,
      dauTien ? "# Tệp này KHÔNG vào kho mã (.gitignore) và KHÔNG dùng cho máy chủ thật." : "",
      ...thieu.map(([key, value, ghiChu]) => `${ghiChu ? `\n# ${ghiChu}\n` : ""}${key}="${value}"`),
      "",
    ]
      .filter((d) => d !== "")
      .join("\n");
    writeFileSync(ENV_FILE, existsSync(ENV_FILE) ? `${readFileSync(ENV_FILE, "utf8").replace(/\s*$/, "")}\n\n${khoi}\n` : `${khoi}\n`, "utf8");
    console.log(`• .env.local: ${dauTien ? "đã tạo" : `đã bổ sung ${thieu.length} khoá còn thiếu`}`);
  } else {
    console.log("• .env.local: đã có đủ khoá, giữ nguyên");
  }
  return readEnvFile(ENV_FILE);
}

/** Xoá thư mục dữ liệu thử. Chỉ nhận PGlite và chỉ trong thư mục dự án — không đụng CSDL nào khác. */
function xoaDuLieu(databaseUrl: string) {
  const dir = pgliteDirectory(databaseUrl);
  if (!dir) thoat("--reset chỉ dùng được với CSDL PGlite. Với PostgreSQL, hãy tự xoá và tạo lại CSDL của máy mình.");
  const duongDan = path.resolve(process.cwd(), dir);
  if (!duongDan.startsWith(path.join(process.cwd(), "data"))) thoat(`Thư mục dữ liệu thử phải nằm trong ./data (đang là ${duongDan}).`);
  rmSync(duongDan, { recursive: true, force: true });
  console.log(`• Đã xoá dữ liệu thử: ${path.relative(process.cwd(), duongDan)}`);
}

/** Chạy một script của kho như tiến trình con, với đúng bộ biến môi trường của bản test. */
function chay(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  console.log(`• Đang chạy ${script}${args.length ? ` ${args.join(" ")}` : ""} …`);
  const r = spawnSync("npx", ["tsx", "--tsconfig", "tsconfig.json", script, ...args], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) thoat(`Lệnh ${script} thất bại (mã ${r.status ?? "?"}).`);
}

function main() {
  console.log("\n═══ Dựng bản test ERP trên máy ═══\n");
  const bienMoiTruong = chuanBiEnv();

  const guard = guardLocalDatabase(bienMoiTruong.DATABASE_URL);
  if (!guard.ok) thoat(guard.error);
  console.log(`• CSDL bản test: ${guard.url}`);

  if (reset) xoaDuLieu(guard.url);

  // Con thừa hưởng biến của .env.local; `dotenv` trong script con không ghi đè biến đã có sẵn,
  // nên `.env` của máy (nếu có) không kéo bản test về CSDL thật được.
  const env: NodeJS.ProcessEnv = { ...process.env, ...bienMoiTruong };

  chay("scripts/seed-admin.ts", env);
  // `seed-demo.ts` tự dọn dữ liệu mẫu cũ (id `demo-*`) trước khi gieo lại, nên chạy nhiều lần vẫn
  // ra đúng một bộ dữ liệu; dữ liệu tự nhập trên bản test không bị đụng tới.
  if (!noDemo) chay("scripts/seed-demo.ts", env);

  console.log(`
✔ Bản test đã sẵn sàng.

  Địa chỉ    : ${LOCAL_TEST_URL}   (chạy \`npm run local\` để mở)
  Đăng nhập  : ${bienMoiTruong.ADMIN_EMAIL} / ${bienMoiTruong.ADMIN_PASSWORD}
  Dữ liệu    : ${guard.url} — dữ liệu giả, xoá lúc nào cũng được (\`npm run local:reset\`)
  Tích hợp   : TẮT — bản test không gọi Pancake / Viettel Post / Facebook và không đẩy gì ra ngoài.

  Mọi trang đều có dải “BẢN TEST” để không nhầm với số thật của shop.
  Thử xong mới đưa lên ERP thật: npm run typecheck && npm run lint && npm test && npm run build
`);
}

main();

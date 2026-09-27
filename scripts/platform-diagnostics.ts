/**
 * CHẨN ĐOÁN DỮ LIỆU VÔ CHỦ CỦA NỀN TẢNG — `npm run platform:diagnostics`
 *
 * Mô hình silo không có cột tổ chức, nên "dữ liệu vô chủ" mang hình dạng khác (lib/queries/platform-health.ts):
 * mỗi tổ chức — kết nối được không · migration x/y · bốn bảng `platform_*` trong CSDL tổ chức KHÁC nhà
 * có rỗng không · dòng module mang khoá lạ · module khai bật mà thiếu phụ thuộc · lượt chạy luật tự động đang treo
 * (lib/workflow/stale.ts, Phase 3.1); cộng mức sổ: tổ chức
 * nhà có ĐÚNG MỘT dòng không. Cùng hàm với trang `/platform` — không có luật thứ hai.
 *
 * ═══ CHỈ ĐỌC — MÁY CHỦ ÉP, KHÔNG PHẢI LỜI HỨA ═══
 *
 * `ERP_READ_ONLY=1` đặt TRƯỚC khi nạp `@/db`: mọi kết nối của tiến trình mang
 * `default_transaction_read_only`, nên một lệnh ghi lọt vào đâu đó bị Postgres từ chối. CSDL tổ chức mở
 * bằng `getDbForInspection` — KHÔNG migrate, KHÔNG dọn bản sao `platform_*` (mở bằng đường của ứng
 * dụng thì xoá chính thứ đang đo). Không gọi `ensureMigrated()`.
 *
 * Mã thoát: 0 = đo đủ và sạch · 1 = có vấn đề · 2 = không vấn đề nào nhưng còn chỗ CHƯA ĐO ĐƯỢC
 * (không mở được sổ migration, không đếm được một bảng…) · 3 = chính lượt chẩn đoán hỏng.
 */
import "dotenv/config";

function pad(text: string, width: number): string {
  const t = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return t + " ".repeat(Math.max(0, width - t.length));
}

async function main(): Promise<number> {
  process.env.ERP_READ_ONLY = "1";
  // PGlite tự tạo thư mục khi mở — một lượt chẩn đoán trỏ nhầm đường dẫn không được đẻ ra một CSDL nhà rỗng.
  const { isPglite, pgliteDataDir } = await import("@/db");
  const homeDir = isPglite() ? pgliteDataDir() : undefined;
  if (homeDir && !(await import("node:fs")).existsSync(homeDir)) throw new Error(`Thư mục CSDL nhà "${homeDir}" không tồn tại — kiểm DATABASE_URL.`);
  const { getPlatformHealth, summarizeHealth } = await import("@/lib/queries/platform-health");
  const health = await getPlatformHealth({ mode: "READ_ONLY" });
  const s = summarizeHealth(health);

  const cols: [keyof (typeof s.rows)[number] | "homeText", string, number][] = [
    ["code", "Tổ chức", 18],
    ["homeText", "Nhà", 4],
    ["status", "Trạng thái", 10],
    ["connection", "Kết nối", 14],
    ["migrations", "Migration", 10],
    ["platformTables", "Bảng platform_*", 26],
    ["unknownModuleKeys", "Khoá module lạ", 16],
    ["dependencyErrors", "Lỗi phụ thuộc", 16],
    ["workflowStale", "Lượt luật treo", 14],
  ];
  console.log(`Chẩn đoán nền tảng (CHỈ ĐỌC) · ${health.checkedAt} · mã nguồn có ${health.migrationsExpected ?? "—"} migration`);
  console.log(cols.map(([, h, w]) => pad(h, w)).join("  "));
  console.log(cols.map(([, , w]) => "─".repeat(w)).join("  "));
  for (const r of s.rows) {
    const cell = (k: (typeof cols)[number][0]) => (k === "homeText" ? (r.home ? "có" : "") : String(r[k]));
    console.log(cols.map(([k, , w]) => pad(cell(k), w)).join("  "));
  }
  console.log("");
  if (s.problems.length) {
    console.log(`VẤN ĐỀ (${s.problems.length}):`);
    for (const p of s.problems) console.log(`  ✗ ${p}`);
  }
  if (s.unmeasured.length) {
    console.log(`CHƯA ĐO ĐƯỢC (${s.unmeasured.length}) — không phải lỗi, cũng không phải "ổn":`);
    for (const u of s.unmeasured) console.log(`  ? ${u}`);
  }
  if (!s.problems.length && !s.unmeasured.length) console.log("Không phát hiện vấn đề nào, và mọi ô đều đo được.");
  return s.exitCode;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/platform-diagnostics.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("[platform:diagnostics] lượt chẩn đoán hỏng:", error instanceof Error ? error.message : error);
      process.exit(3);
    });
}

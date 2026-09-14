/**
 * ĐO ĐIỀU HƯỚNG THẬT QUA HTTP — thời gian người dùng thật sự phải chờ khi bấm sang một trang.
 *
 * `scripts/bench-reports.ts` đo lớp truy vấn; script này đo TOÀN BỘ đường đi: middleware kiểm phiên
 * → Server Component dựng trang → tuần tự hoá RSC → truyền về. Nó cũng đo KÍCH THƯỚC gói dữ liệu —
 * con số quyết định trên đường truyền chậm và là thứ `bench-reports` không nhìn thấy.
 *
 * Đo hai kiểu yêu cầu, đúng như trình duyệt:
 *   · HTML   — mở trang lần đầu (dán link, F5);
 *   · RSC    — bấm chuyển tab trong ứng dụng (header `RSC: 1`), gói nhỏ hơn nhiều.
 *
 * Cách dùng (máy chủ phải đang chạy và CSDL đã có dữ liệu):
 *   npm run build && npm start        (hoặc trỏ vào máy chủ thật)
 *   npx tsx scripts/bench-http.ts --base=http://localhost:3000 --rounds=5 --out=docs/perf/http.json
 *
 * Cần một phiên đăng nhập. Script tự ký cookie bằng `AUTH_SECRET` — cùng khoá mà middleware dùng
 * để kiểm — nên không phải nhập mật khẩu và không đụng gì tới dữ liệu. Truyền `--user=<id người
 * dùng ADMIN có thật trong CSDL>`: `getCurrentUser()` nạp lại người dùng từ CSDL nên id phải tồn tại.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const base = arg("base", "http://localhost:3000").replace(/\/$/, "");
const rounds = Number(arg("rounds", "5"));
const outPath = arg("out", "");
const label = arg("label", "");
const userId = arg("user", "");
if (!userId) {
  console.error("Thiếu --user=<id người dùng ADMIN>. Lấy id bằng: npx tsx scripts/bench/http-setup.ts");
  process.exit(1);
}

/** Trang đo + kỳ báo cáo mặc định của trang đó */
const PAGES: { name: string; path: string }[] = [
  { name: "Tổng quan", path: "/" },
  { name: "Báo cáo lợi nhuận", path: "/reports" },
  { name: "Đơn hàng", path: "/orders" },
  { name: "Vận đơn", path: "/shipments" },
  { name: "Quảng cáo", path: "/ads" },
  { name: "Hiệu quả mẫu mã", path: "/products/performance" },
  { name: "Sản phẩm & tồn kho", path: "/products" },
  { name: "Nhật ký kho", path: "/inventory" },
  { name: "Cần xử lý (hàng đợi việc)", path: "/alerts" },
  { name: "Chất lượng dữ liệu", path: "/data-quality" },
  { name: "Tỷ lệ giao thành công", path: "/reports/returns" },
];

/** Đổi kỳ báo cáo trên CÙNG một trang — thao tác người dùng làm nhiều nhất */
const PERIOD_SWITCHES: { name: string; path: string }[] = [
  { name: "Tổng quan · đổi kỳ 7 ngày", path: "/?period=7d" },
  { name: "Tổng quan · đổi kỳ tháng trước", path: "/?period=last_month" },
  { name: "Lợi nhuận · đổi kỳ 90 ngày", path: "/reports?period=90d" },
  { name: "Lợi nhuận · đổi tab dòng tiền", path: "/reports?tab=cash" },
  { name: "Quảng cáo · đổi kỳ 30 ngày", path: "/ads?period=30d" },
];

type Sample = { ms: number; bytes: number; status: number };
type Row = { name: string; path: string; kind: "HTML" | "RSC"; p50: number; p95: number; min: number; kb: number; status: number };

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]);
}

async function sessionCookie() {
  const secret = (process.env.AUTH_SECRET || "dev-secret-change-me-please-32-chars-min").trim();
  const token = await new SignJWT({ email: "bench@local", name: "Đo hiệu năng", role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));
  return `erp_session=${token}`;
}

async function measure(url: string, headers: Record<string, string>): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(url, { headers, redirect: "manual" });
  const body = await response.arrayBuffer();
  return { ms: performance.now() - started, bytes: body.byteLength, status: response.status };
}

async function main() {
  const cookie = await sessionCookie();
  const rows: Row[] = [];

  const run = async (name: string, target: string, kind: "HTML" | "RSC") => {
    const url = `${base}${target}`;
    const headers: Record<string, string> = { cookie, "accept-encoding": "gzip, deflate, br" };
    if (kind === "RSC") headers.RSC = "1";
    // Một lượt làm nóng (biên dịch route, mở kết nối) rồi mới đo
    const warm = await measure(url, headers);
    if (warm.status >= 400) {
      rows.push({ name, path: target, kind, p50: -1, p95: -1, min: -1, kb: 0, status: warm.status });
      return;
    }
    const samples: Sample[] = [];
    for (let i = 0; i < rounds; i += 1) samples.push(await measure(url, headers));
    const times = samples.map((s) => s.ms);
    rows.push({
      name,
      path: target,
      kind,
      p50: quantile(times, 0.5),
      p95: quantile(times, 0.95),
      min: Math.round(Math.min(...times)),
      kb: Math.round((samples[0].bytes / 1024) * 10) / 10,
      status: samples[0].status,
    });
  };

  for (const page of PAGES) {
    await run(page.name, page.path, "HTML");
    await run(page.name, page.path, "RSC");
  }
  for (const page of PERIOD_SWITCHES) await run(page.name, page.path, "RSC");

  const report = {
    label: label || "http",
    base,
    rounds,
    measuredAt: new Date().toISOString(),
    /** Ngân sách hiệu năng — xem docs/erp-performance-p0-report.md */
    nganSach: { dieuHuongCoDem: 200, doiKy: 700, baoCaoLanh: 1500, apiP95: 1000 },
    rows: rows.sort((a, b) => b.p95 - a.p95),
  };
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n", "utf8");
    console.log(`Đã ghi ${outPath}`);
  }
  console.log(
    ["TRANG".padEnd(34) + "KIỂU".padEnd(6) + "p50".padStart(7) + "p95".padStart(7) + "KB".padStart(9)]
      .concat(report.rows.map((r) => r.name.slice(0, 32).padEnd(34) + r.kind.padEnd(6) + String(r.p50).padStart(7) + String(r.p95).padStart(7) + String(r.kb).padStart(9)))
      .join("\n"),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/**
 * ───────────── CỔNG RA CUỐI (FINAL GATE) ─────────────
 *
 * Chạy TRỌN danh sách kiểm trước khi deploy, một lệnh, không bỏ bước:
 *
 *   npm run gate
 *
 * Vì sao cần script thay vì làm tay: danh sách kiểm làm tay luôn bị rút gọn đúng vào hôm vội nhất.
 * Ba lỗi đã xảy ra thật trong kho mã này đều thuộc loại "một bước bị bỏ qua":
 *   · file migration có mà sổ `_journal.json` không có ⇒ không bao giờ được áp trên production;
 *   · một file kiểm thử được commit trong khi thư viện nó phụ thuộc chưa lên ⇒ checkout sạch đỏ tsc;
 *   · cây làm việc còn thay đổi chưa commit lúc deploy ⇒ máy chủ chạy bản không ai đọc được.
 *
 * Cổng này CHỈ ĐỌC và KHÔNG deploy. Nó chạy xong rồi in ra nên deploy hay không; việc bấm deploy
 * vẫn là của con người.
 */

type Step = { name: string; run: () => void };

const results: { name: string; ok: boolean; detail: string; ms: number }[] = [];

function shell(cmd: string) {
  execSync(cmd, { stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Bản làm việc phải sạch: deploy một bản mà kho mã không ghi lại được là không quay lui được. */
function cayLamViecSach() {
  const out = execSync("git status --porcelain", { encoding: "utf8" });
  const dong = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dong.length) throw new Error(`còn ${dong.length} file chưa commit:\n  ${dong.slice(0, 12).join("\n  ")}${dong.length > 12 ? "\n  …" : ""}`);
}

/**
 * Mọi file migration phải có mục trong sổ. Thiếu mục nghĩa là file đó KHÔNG BAO GIỜ chạy trên
 * production, và không có gì báo lỗi — CSDL chỉ đơn giản thiếu cột.
 */
function soMigrationDayDu() {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  const trongSo = new Set(journal.entries.map((e) => e.tag));
  const trenDia = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
  const thieu = trenDia.filter((t) => !trongSo.has(t));
  if (thieu.length) throw new Error(`file migration không có trong sổ (sẽ không bao giờ được áp): ${thieu.join(", ")}`);
  const dư = [...trongSo].filter((t) => !trenDia.includes(t));
  if (dư.length) throw new Error(`sổ ghi migration không tồn tại trên đĩa: ${dư.join(", ")}`);
}

/** Không có bí mật nào lọt vào kho mã — repo này là PUBLIC. */
function khongLoBiMat() {
  const mau: { ten: string; re: RegExp }[] = [
    { ten: "token Facebook", re: /\bEAA([A-Za-z0-9]{20,})/g },
    { ten: "webhook Lark", re: /open\.larksuite\.com\/open-apis\/bot\/v2\/hook\/([A-Za-z0-9-]{8,})/g },
    { ten: "token Telegram", re: /\b\d{8,10}:AA([A-Za-z0-9_-]{30,})/g },
    { ten: "khoá riêng", re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g },
  ];
  /**
   * Chỗ giữ chỗ trong giao diện KHÔNG phải bí mật. Không loại chúng ra thì cổng ra đỏ vì một ô
   * `placeholder="…/hook/xxxxxxxx"` — và một cổng ra hay báo động giả sẽ bị người ta tắt đi, đúng
   * lúc nó cần nhất.
   */
  const laChoGiuCho = (token: string) =>
    /x{4,}/i.test(token) ||
    new Set(token.toLowerCase()).size <= 2 ||
    /(your|thay-bang|dien-|example|placeholder)/i.test(token);
  const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").map((f) => f.trim()).filter(Boolean);
  const dinh: string[] = [];
  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs|json|md|ya?ml|sh|sql|env.*)$/i.test(f)) continue;
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of mau) {
      for (const khop of src.matchAll(m.re)) {
        if (laChoGiuCho(khop[1] ?? "")) continue;
        dinh.push(`${f} (${m.ten})`);
        break;
      }
    }
  }
  if (existsSync(".env") && files.includes(".env")) dinh.push(".env đã bị đưa vào kho mã");
  if (dinh.length) throw new Error(`nghi có bí mật trong kho mã:\n  ${dinh.join("\n  ")}`);
}

const STEPS: Step[] = [
  { name: "Cây làm việc sạch", run: cayLamViecSach },
  { name: "Sổ migration khớp file trên đĩa", run: soMigrationDayDu },
  { name: "Không lộ bí mật trong kho mã", run: khongLoBiMat },
  { name: "Kiểu dữ liệu (tsc --noEmit)", run: () => shell("npm run typecheck") },
  { name: "Lint", run: () => shell("npm run lint") },
  { name: "Toàn bộ kiểm thử nghiệp vụ", run: () => shell("npm test") },
  { name: "Dựng bản production", run: () => shell("npm run build") },
];

async function main() {
  const chiChay = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  console.log("── CỔNG RA CUỐI ──\n");
  for (const step of STEPS) {
    if (chiChay.length && !chiChay.some((k) => step.name.toLowerCase().includes(k.toLowerCase()))) continue;
    const t0 = Date.now();
    try {
      step.run();
      results.push({ name: step.name, ok: true, detail: "", ms: Date.now() - t0 });
      console.log(`✓ ${step.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const stdout = (error as { stdout?: string })?.stdout ?? "";
      const detail = (stdout || raw).split("\n").filter(Boolean).slice(-12).join("\n    ");
      results.push({ name: step.name, ok: false, detail, ms: Date.now() - t0 });
      console.error(`✗ ${step.name} (${Math.round((Date.now() - t0) / 1000)}s)\n    ${detail}`);
    }
  }

  const hong = results.filter((r) => !r.ok);
  console.log("\n──────────────────");
  if (hong.length) {
    console.error(`CỔNG RA CUỐI: KHÔNG ĐẠT — ${hong.length}/${results.length} bước hỏng: ${hong.map((h) => h.name).join(", ")}`);
    console.error("KHÔNG deploy cho tới khi mọi bước xanh. Bước đỏ nghĩa là code sai, không phải kiểm thử sai.");
    process.exit(1);
  }
  console.log(`CỔNG RA CUỐI: ĐẠT — ${results.length}/${results.length} bước.`);
  console.log("Vẫn phải làm tay trước khi deploy: đối chiếu số liệu trước/sau trên production bằng ops db-query, và ghi lại commit đang chạy để còn quay lui.");
  process.exit(0);
}

main();

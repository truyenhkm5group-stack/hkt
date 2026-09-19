/**
 * ═══════════ MÁY RUNNER ĐÃ SẴN SÀNG CHẠY AGENT CHƯA ═══════════
 *
 *     npm run agent:check
 *
 * Trả lời đúng một câu hỏi, TRƯỚC khi ai đó tốn một lượt chạy agent để phát hiện ra điều lẽ ra
 * biết được trong hai giây: máy này có đủ thứ để chạy một agent không.
 *
 * ─── VÌ SAO TÁCH KHỎI `check-integrations` ───
 *
 * `check-integrations --ai` hỏi "AI Copilot trên MÁY CHỦ có chạy không". Đây là một máy khác, một
 * khoá khác, một hạn mức khác. Gộp hai câu lại thì một lượt 429 của Copilot production sẽ được
 * đọc thành "runner hỏng", và người ta đi sửa nhầm máy.
 *
 * ─── KHÔNG BAO GIỜ ───
 *
 * Không in khoá. Không in độ dài khoá (độ dài phân biệt được nhà cung cấp và đôi khi cả loại
 * khoá — và nó KHÔNG giúp trả lời câu hỏi ở đây, khác với lúc ghi `.env` nơi độ dài là cách duy
 * nhất để biết đã ghi được gì). Không `printenv`, không `cat .env`, không ghi CSDL, không commit.
 * Chỉ trả lời CÓ / KHÔNG và DÙNG ĐƯỢC / KHÔNG DÙNG ĐƯỢC.
 *
 * ─── BỐN KẾT LUẬN, BỐN CÁCH SỬA ───
 *
 * `MISSING`          chưa có khoá nào          → đặt biến môi trường trên MÁY RUNNER
 * `AUTH_FAILED`      401/403 — khoá sai/hết    → thay khoá
 * `QUOTA_OR_RATE_LIMIT` 429                    → CHỜ, hoặc dùng khoá có hạn mức thật
 * `PROVIDER_ERROR`   5xx / mạng                → lỗi phía nhà cung cấp, không phải lỗi cấu hình
 *
 * Gộp cả bốn thành "agent failed" là lời nói dối tốn kém nhất trong cả Phase 2A: nó đổ cho agent
 * một thứ agent chưa từng chạy.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { checkCommand, DOCUMENTATION_COMMANDS, sandboxEnv, SECRET_ENV_NAMES } from "@/lib/constants/agent-sandbox";
import { testAiConnection } from "@/lib/ai/provider";
import { aiDisabledReason, modelFor, resolveProviderName } from "@/lib/ai/router";
import { env } from "@/lib/env";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`    ${m}`);

export type RunnerCredentialVerdict = "READY" | "MISSING" | "AUTH_FAILED" | "QUOTA_OR_RATE_LIMIT" | "PROVIDER_ERROR";

/**
 * Xếp loại lỗi của nhà cung cấp AI. Đọc mã trạng thái nếu SDK có kèm, rồi mới dò câu chữ — câu chữ
 * đổi theo phiên bản SDK, mã trạng thái thì không.
 */
export function classifyProviderError(error: unknown): { verdict: Exclude<RunnerCredentialVerdict, "READY" | "MISSING">; detail: string } {
  const e = error as { status?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : null;
  const raw = e?.message ? String(e.message) : String(error);
  // Cắt ngắn VÀ không bao giờ in nguyên phần thân lỗi: phản hồi 4xx của một số nhà cung cấp vọng
  // lại chính header yêu cầu, và header đó mang khoá.
  const detail = raw.replace(/\s+/g, " ").slice(0, 200);
  if (status === 401 || status === 403) return { verdict: "AUTH_FAILED", detail };
  if (status === 429) return { verdict: "QUOTA_OR_RATE_LIMIT", detail };
  if (status !== null && status >= 500) return { verdict: "PROVIDER_ERROR", detail };
  if (/\b401\b|unauthor|invalid[_ ]?api[_ ]?key|authentication/i.test(raw)) return { verdict: "AUTH_FAILED", detail };
  if (/\b429\b|rate[_ ]?limit|quota|credit balance|insufficient/i.test(raw)) return { verdict: "QUOTA_OR_RATE_LIMIT", detail };
  return { verdict: "PROVIDER_ERROR", detail };
}

async function kiemKhoaAi(): Promise<RunnerCredentialVerdict> {
  console.log("\n▶ Khoá AI của máy runner");
  const provider = resolveProviderName();
  if (!provider) {
    bad(`Chưa có khoá nào dùng được: ${aiDisabledReason()}`);
    info("Đặt ANTHROPIC_API_KEY (khuyên dùng) hoặc OPENAI_API_KEY vào môi trường của MÁY RUNNER.");
    info("KHÔNG đặt trên container production, và KHÔNG dùng chung khoá với AI Copilot đang chạy —");
    info("một lượt 429 của Copilot sẽ lẫn vào lỗi của runner và không ai phân biệt được cái nào hỏng.");
    return "MISSING";
  }
  info(`nhà cung cấp ${provider} · model bậc routine ${modelFor(provider, "routine")}`);
  try {
    const ping = await testAiConnection();
    ok(`Gọi thật được: ${ping.provider} · ${ping.model} trả lời sau ${ping.latencyMs} ms`);
    return "READY";
  } catch (error) {
    const { verdict, detail } = classifyProviderError(error);
    bad(`[${verdict}] ${detail}`);
    if (verdict === "AUTH_FAILED") info("Khoá sai hoặc đã bị thu hồi — thay khoá. KHÔNG phải lỗi của runner.");
    if (verdict === "QUOTA_OR_RATE_LIMIT") info("Hết hạn mức / hết tín dụng — chờ, hoặc dùng khoá có quota thật. KHÔNG phải lỗi của runner.");
    if (verdict === "PROVIDER_ERROR") info("Lỗi phía nhà cung cấp hoặc mạng — thử lại sau. KHÔNG phải lỗi cấu hình.");
    /*
      CÓ KHOÁ CỦA NHÀ CUNG CẤP KIA MÀ KHÔNG NÓI RA LÀ ĐỂ NGƯỜI ĐỌC ĐI VÀO NGÕ CỤT.

      ĐÃ XẢY RA THẬT (lượt chạy agent đầu tiên, 19/09/2026): kho có CẢ HAI khoá, router để `auto`
      nên chọn OpenAI, và khoá OpenAI hết tín dụng. Bản in lúc đó dừng ở "hết hạn mức" — đúng
      nhưng chưa đủ, vì lối ra đang nằm ngay đó: khoá Anthropic còn nguyên, chưa ai thử.
    */
    const conKhoaKhac = provider === "openai" ? env.ai.anthropicConfigured : env.ai.openaiConfigured;
    if (conKhoaKhac) {
      const kia = provider === "openai" ? "anthropic" : "openai";
      info(`CÒN MỘT KHOÁ NỮA CHƯA THỬ: máy này cũng có khoá ${kia.toUpperCase()} nhưng router đang chọn ${provider}.`);
      info(`Thử \`AI_PROVIDER=${kia}\` rồi chạy lại. CHƯA THỬ nghĩa là chưa biết — nó có thể cũng hết tín dụng.`);
    }
    return verdict;
  }
}

function kiemMayRunner() {
  console.log("\n▶ Máy runner");
  try {
    const v = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    ok(v);
  } catch {
    bad("Không có `git` — runner dựng cây làm việc bằng `git worktree`, thiếu nó thì không chạy được gì.");
  }
  ok(`Node ${process.version}`);
  // Cây làm việc phải SẠCH: runner lấy base là một commit ĐÃ VÀO KHO, và một cây bẩn nghĩa là
  // base thật khác base ghi trong sổ (AGENTS.md mục 9).
  try {
    const ban = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    if (ban) {
      bad(`Cây làm việc còn ${ban.split("\n").length} tệp chưa vào kho — chạy agent ở đây thì base SHA trong sổ không mô tả đúng thứ agent thấy.`);
      info("Dùng một cây làm việc riêng: git worktree add --detach ../wt-agent origin/main");
    } else ok("Cây làm việc sạch");
  } catch {
    bad("Không đọc được trạng thái git ở thư mục hiện tại.");
  }
}

function kiemHangRao() {
  console.log("\n▶ Hàng rào (đọc từ mã nguồn, không phải từ lời hứa)");
  ok(`${DOCUMENTATION_COMMANDS.length} lệnh được phép cho vai tài liệu`);
  const camMau: string[][] = [["git", "push", "origin", "main"], ["ssh", "root@vps"], ["printenv"], ["psql", "$DATABASE_URL"]];
  const lot = camMau.filter((argv) => checkCommand(argv).allowed);
  if (lot.length) bad(`LỌT ${lot.length} lệnh lẽ ra phải bị chặn: ${lot.map((a) => a.join(" ")).join(", ")}`);
  else ok("Bốn lệnh nguy hiểm mẫu đều bị chặn");
  const con = sandboxEnv(process.env as Record<string, string | undefined>);
  const conLai = SECRET_ENV_NAMES.filter((k) => k in con);
  if (conLai.length) bad(`LỌT ${conLai.length} biến bí mật xuống tiến trình con: ${conLai.join(", ")}`);
  else ok(`${SECRET_ENV_NAMES.length} biến bí mật đều bị gỡ khỏi tiến trình con của agent`);
}

async function main() {
  console.log("Máy runner đã sẵn sàng chạy agent chưa — VNXcommerce ERP");
  kiemMayRunner();
  kiemHangRao();
  const ket = await kiemKhoaAi();
  console.log(`\nKẾT LUẬN: ${ket}`);
  if (ket !== "READY") {
    console.log("Chưa chạy agent được. Đây KHÔNG phải lỗi của agent — agent chưa từng chạy.");
    process.exit(2);
  }
  console.log("Chạy được. Bước tiếp: npm run agent:run -- --task <TECH-xx> --agent documentation --gates typecheck,lint,test,build --keep");
  process.exit(0);
}

if (process.argv[1] && process.argv[1].includes("agent-runner-check")) {
  main().catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

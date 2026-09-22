/**
 * ═══════════ GỬI SỔ LƯỢT CHẠY AGENT VỀ ERP PRODUCTION ═══════════
 *
 *     npm run agent:report -- --task TECH-1
 *
 * Bước cuối của `agent-run.yml`. Đọc dòng `tech_agent_runs` trong CSDL PGlite dùng-một-lần của máy
 * Actions, rồi POST nó qua cửa hẹp `/api/tech/agent-run` để `/tech/agents` trên production thôi
 * hiện "0 lượt chạy" cho một vai đã chạy thật.
 *
 * ─── VÌ SAO PHẢI CÓ BƯỚC NÀY THAY VÌ NỐI THẲNG CSDL ───
 *
 * Máy Actions không nối được PostgreSQL production, và giữ nguyên tính chất đó là CHỦ Ý của chủ
 * shop (phương án B): *code chưa qua review không chạy cạnh CSDL production*. Nới `DATABASE_URL`
 * ra Internet để tiện chép sổ là đánh đổi đúng thứ mà cả thiết kế này sinh ra để bảo vệ.
 *
 * ─── KHÔNG LÀM HỎNG LƯỢT CHẠY VÌ MỘT LƯỢT CHÉP SỔ ───
 *
 * Mặc định script này **không** trả mã thoát khác 0 khi không gửi được: bằng chứng THẬT của một
 * lượt chạy là hiện vật + nhánh git, không phải dòng sổ chép về. Để một lần ERP bận làm cả lượt
 * chạy agent trông như hỏng là đổi một phiền toái lấy một kết luận sai. `--strict` bật hành vi
 * ngược lại cho ai muốn.
 *
 * ─── KHÔNG IN BÍ MẬT ───
 *
 * Kho mã này PUBLIC nên log Actions ai cũng đọc được. Script chỉ in CÓ / KHÔNG cho khoá,
 * và URL đích in ra ở dạng gốc (scheme + host), không kèm tham số.
 */
import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { agentRunExternalRef } from "@/lib/constants/agent-ingest";
import { TECH_GATE_RESULTS, type TechGateResult } from "@/lib/constants/tech";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Chỉ scheme + host — đủ để người đọc log biết nó gửi đi đâu, không lộ đường dẫn hay tham số. */
function goc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(URL không hợp lệ)";
  }
}

async function main() {
  const taskRef = (arg("task") ?? "").trim();
  const strict = process.argv.includes("--strict");
  if (!taskRef) {
    console.error("Thiếu --task.");
    process.exit(1);
  }

  /*
    ĐỊA CHỈ ERP KHÔNG PHẢI MỘT BÍ MẬT, NÊN NÓ KHÔNG ĐƯỢC LÀ MỘT VIỆC PHẢI KHAI.

    `deploy-vps.yml` đã suy tên miền từ `vars.ERP_DOMAIN || 'erp.vnxcommerce.com'` từ lâu. Bắt
    người ta khai thêm một biến mang đúng thông tin ấy là dựng một việc thủ công cho một giá trị
    đã biết — và dựng luôn cơ hội để hai chỗ nói hai tên miền khác nhau. Ở đây dùng LẠI đúng nguồn
    đó; `ERP_BASE_URL` vẫn đè được khi cần trỏ sang máy khác.
  */
  const domain = (process.env.ERP_DOMAIN ?? "").trim();
  const base = ((process.env.ERP_BASE_URL ?? "").trim() || (domain ? `https://${domain}` : "")).replace(/\/$/, "");
  /*
    KHOÁ RIÊNG TRƯỚC, KHOÁ LẬP LỊCH SAU. `AGENT_INGEST_SECRET` chỉ mở được đúng một cửa ghi vào một
    bảng quan sát; `CRON_SECRET` mở được cả bộ lập lịch, trong đó có job ghi hàng loạt — đưa nó lên
    một máy chạy mã chưa review là đánh đổi bán kính thiệt hại lấy một dòng cấu hình.
  */
  const secret = (process.env.AGENT_INGEST_SECRET ?? "").trim() || (process.env.CRON_SECRET ?? "").trim();
  /*
    THIẾU CẤU HÌNH LÀ "CHƯA BẬT", KHÔNG PHẢI "HỎNG".

    Kho chưa khai khoá thì bước này chưa được bật — nói thẳng câu đó kèm chỗ khai, thay vì ném một
    lỗi mạng khó hiểu ở dưới. (AGENTS.md mục 42: chưa biết không được in
    ra thành một kết luận.)
  */
  if (!base || !secret) {
    console.log("══════════ CHÉP SỔ VỀ ERP: CHƯA BẬT ══════════");
    console.log(`địa chỉ ERP          ${base ? goc(base) : "KHÔNG có"}`);
    console.log(`AGENT_INGEST_SECRET  ${secret ? "có" : "KHÔNG có"}`);
    // Câu hướng dẫn cố ý KHÔNG mở đầu bằng chữ `secret`: bộ gác "không in bí mật" ở
    // `tests/agent-run-ingest.test.ts` quét theo từ khoá, và một bộ gác kêu nhầm là bộ gác bị tắt.
    console.log("Khai ĐÚNG MỘT chỗ — Settings → Secrets and variables → Actions →");
    console.log("New repository Secret, tên AGENT_INGEST_SECRET.");
    console.log("Lần deploy kế tiếp tự mang khoá xuống .env của VPS.");
    console.log("Lượt chạy agent KHÔNG bị tính là hỏng vì điều này — bằng chứng vẫn nằm ở hiện vật và nhánh git.");
    process.exit(strict ? 1 : 0);
  }

  await ensureMigrated();
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, taskRef), columns: { id: true, code: true } });
  if (!task) {
    console.error(`Không tìm thấy việc ${taskRef}.`);
    process.exit(1);
  }
  const run = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.taskId, task.id), orderBy: [desc(schema.techAgentRuns.startedAt)] });
  if (!run) {
    console.error(`Việc ${taskRef} chưa có lượt chạy agent nào — không có gì để chép.`);
    process.exit(1);
  }

  /*
    KHOÁ DỰNG TỪ DANH TÍNH LƯỢT CHẠY GITHUB, KHÔNG TỪ `run.id`.

    `run.id` là uuid sinh ra trong CSDL PGlite dùng-một-lần: chạy lại đúng workflow ấy sẽ ra một
    uuid khác, nên nó chống được đúng số 0 lần phát lại. `runId` + `attempt` của Actions mới là thứ
    nhận diện được cùng một sự việc từ hai phía.
  */
  /*
    Mã việc TRÊN PRODUCTION, do workflow truyền xuống. Rỗng = lượt tự kiểm, không thuộc việc nào.
    KHÔNG suy từ `task.code` của CSDL tạm: hai không gian mã khác nhau, và chúng trùng nhau một
    cách tình cờ chính là cái bẫy đã cắn.
  */
  const maProduction = (arg("prod-task") ?? "").trim();
  if (!maProduction) console.log("Không có mã việc production — chép sổ KHÔNG gắn vào việc nào (đúng với lượt tự kiểm).");

  const externalRef = agentRunExternalRef(
    "github",
    process.env.GITHUB_RUN_ID ?? `local-${run.id}`,
    process.env.GITHUB_RUN_ATTEMPT ?? "1",
  );
  if (!externalRef) {
    console.error("Không dựng được external_ref — thiếu GITHUB_RUN_ID.");
    process.exit(strict ? 1 : 0);
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const externalUrl = repo && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;

  /*
    `RUNNING` KHÔNG GỬI ĐƯỢC — và đó là điều đúng, không phải một hạn chế phải lách.

    Cửa nhận chỉ lấy trạng thái đã kết thúc (`lib/constants/agent-ingest.ts`). Một lượt chạy còn
    `RUNNING` lúc này nghĩa là runner chết giữa chừng; chép nó về sẽ tạo một dòng mồ côi vĩnh viễn
    trên production mà không ai đóng lại được. Nói ra, rồi dừng.
  */
  if (run.status === "RUNNING") {
    console.log("Lượt chạy còn ở RUNNING (runner dừng giữa chừng) — KHÔNG chép về; cửa nhận chỉ lấy lượt đã kết thúc.");
    process.exit(strict ? 1 : 0);
  }

  /*
    CỘT TRONG CSDL LÀ CHỮ TỰ DO; CỬA NHẬN LÀ DANH SÁCH ĐÓNG.

    Một giá trị lạ ở đây (phiên bản runner cũ, dữ liệu vá tay) mà gửi thẳng đi sẽ làm CẢ gói tin bị
    từ chối vì một ô trang trí — mất nguyên dòng sổ của một lượt chạy có thật. Nên quy về UNKNOWN,
    tức CHƯA BIẾT, và NÓI RA. Không quy về PASSED và cũng không quy về FAILED: cả hai đều là một
    kết luận mà không ai đo được (AGENTS.md mục 42).
  */
  const veCong = (ten: string, gia: string): TechGateResult => {
    if ((TECH_GATE_RESULTS as readonly string[]).includes(gia)) return gia as TechGateResult;
    console.log(`  ⚠ cổng ${ten} mang giá trị lạ "${gia}" — gửi đi là CHƯA BIẾT, không phải đạt.`);
    return "UNKNOWN";
  };
  const gates: Record<string, TechGateResult> = {
    typecheck: veCong("typecheck", run.typecheckResult),
    lint: veCong("lint", run.lintResult),
    test: veCong("test", run.testResult),
    build: veCong("build", run.buildResult),
  };

  const body = {
    externalRef,
    agentKey: run.agentKey,
    /*
      ═══════════ CHỈ GẮN VÀO VIỆC KHI CÓ MỘT VIỆC THẬT TRÊN PRODUCTION ═══════════

      ĐÃ CẮN THẬT. Lượt TỰ KIỂM không lấy việc từ production — nó tự tạo một việc R0 trong CSDL
      tạm, và trong một CSDL RỖNG việc ấy mang mã `TECH-1`. Gửi mã đó đi thì cửa nhận tra thấy
      `TECH-1` CỦA PRODUCTION — một việc có thật, hoàn toàn khác — và gắn lượt chạy vào đó.

      Đo được: 4 lượt tự kiểm đang nằm dưới việc “Đánh giá tốc độ trang vận đơn” (R2), một việc
      chúng chưa bao giờ chạm tới.

      Một lượt tự kiểm KHÔNG THUỘC việc nào trên production, và cửa nhận chấp nhận điều đó
      (`task_id` để trống). Không gắn là câu trả lời ĐÚNG; gắn bừa vào một mã trùng là bịa ra một
      quan hệ chưa từng có (AGENTS.md mục 34–35).
    */
    taskCode: maProduction || undefined,
    status: run.status,
    branch: run.branch || undefined,
    baseCommit: run.baseCommit || undefined,
    resultCommit: run.resultCommit || undefined,
    summary: run.summary || undefined,
    error: run.error || undefined,
    testsRun: run.testsRun || undefined,
    gates,
    filesChanged: ((run.filesChanged as string[] | null) ?? []).slice(0, 200),
    startedAt: run.startedAt?.toISOString(),
    endedAt: (run.endedAt ?? new Date()).toISOString(),
    /* Tiền của lượt chạy — `null` là CHƯA ĐO ĐƯỢC, không phải 0 (mục 42). */
    chiPhi: ((run.metadata as { chiPhi?: unknown } | null)?.chiPhi ?? null) as never,
    externalUrl,
  };

  console.log("══════════ CHÉP SỔ LƯỢT CHẠY AGENT VỀ ERP ══════════");
  console.log(`đích          ${goc(base)}`);
  console.log(`khoá          ${externalRef}`);
  console.log(`vai           ${run.agentKey}`);
  console.log(`việc          ${task.code}`);
  console.log(`trạng thái    ${run.status}`);

  let res: Response;
  try {
    res = await fetch(`${base}/api/tech/agent-run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.log(`✗ KHÔNG gửi được: ${error instanceof Error ? error.message : String(error)}`);
    console.log("  Bằng chứng lượt chạy vẫn nằm ở hiện vật và nhánh git; chỉ thiếu dòng sổ trên production.");
    process.exit(strict ? 1 : 0);
  }

  const text = await res.text();
  if (!res.ok) {
    console.log(`✗ ERP từ chối (HTTP ${res.status}): ${text.slice(0, 500)}`);
    process.exit(strict ? 1 : 0);
  }
  /*
    201 = vừa tạo dòng mới · 200 = đã có rồi (chạy lại bước này không nhân đôi sổ).
    Hai câu khác nhau, vì gộp lại thì không ai biết lượt chạy lại có được ghi hay không.
  */
  console.log(res.status === 201 ? `✓ Đã ghi sổ trên production: ${text.slice(0, 300)}` : `✓ Đã có sẵn, không ghi thêm (chống phát lại): ${text.slice(0, 300)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DOCUMENTATION_COMMANDS, DOCUMENTATION_READ_GLOBS } from "@/lib/constants/agent-sandbox";
import { goiPhanHoi, checkRerun } from "@/lib/constants/agent-rerun";
import { GATE_REPAIR, congChiPhi, dungPhanHoiCong, type KetQuaCong } from "@/lib/constants/agent-gate-repair";
import { writeGlobsForRole } from "@/lib/constants/agent-scopes";
import type { TechGateResult, TechRisk } from "@/lib/constants/tech";
import { finishTechAgentRun, startTechAgentRun, type TechActor } from "@/lib/tech/service";
import { dinhNhanh, soCommitCuaAgent, AgentWorkspace } from "@/lib/agents/workspace";
import type {AgentExecutor, AgentOutcome } from "@/lib/agents/executor";

/**
 * NHỊP TIM MỖI PHÚT, ĐỐI VỚI NGƯỠNG THU DỌN 45 PHÚT.
 *
 * Tỷ lệ 1:45 là cố ý rộng: một lượt chạy phải lỡ BỐN MƯƠI LĂM nhịp liên tiếp mới bị coi là đã
 * chết. Nhịp dày hơn không làm gì thêm ngoài việc ghi CSDL nhiều hơn; nhịp thưa hơn thì khoảng
 * mù lại rộng ra đúng bằng chỗ đã sinh ra lỗi này.
 */
const HEARTBEAT_EVERY_MS = 60_000;

/**
 * ═══════════ RUNNER — NƠI MỌI CỔNG ĐƯỢC THI HÀNH ═══════════
 *
 * Executor (model) quyết định NỘI DUNG. Runner quyết định ĐƯỢC PHÉP HAY KHÔNG, và runner tự đo
 * kết quả. Ranh giới đó là cả kiến trúc an toàn của Phase 2A:
 *
 *   · Agent KHÔNG tự chấm mình      — bốn cổng đo bằng EXIT CODE thật của tiến trình con.
 *   · Agent KHÔNG tự commit         — `git add`/`commit` không nằm trong danh sách lệnh của nó.
 *   · Agent KHÔNG tự mở lượt chạy   — runner kiểm quyền trước khi `startTechAgentRun`.
 *   · Agent KHÔNG tự phê duyệt      — `decideTechApproval` từ chối mọi actor không phải HUMAN.
 *
 * ─── KIỂM LẠI MỨC RỦI RO HAI LẦN ───
 *
 * Một lần TRƯỚC khi bắt đầu, một lần TRƯỚC khi commit. Lý do: mức rủi ro đổi được TRONG LÚC lượt
 * chạy đang diễn ra (người đè mức, xem `overrideTechTaskRisk`), và một việc vừa được nâng lên R2
 * thì thứ agent vừa viết KHÔNG được vào kho dưới danh nghĩa một lượt chạy hợp lệ.
 */

export type RunnerResult = {
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  runId: string | null;
  branch: string | null;
  baseCommit: string | null;
  resultCommit: string | null;
  filesChanged: string[];
  gates: { typecheck: TechGateResult; lint: TechGateResult; test: TechGateResult; build: TechGateResult };
  summary: string;
  reason: string | null;
  /**
   * Tiền của lượt chạy — `null` khi lượt chạy dừng TRƯỚC khi gọi model lần nào (thiếu khoá, việc
   * không hợp lệ). `null` ở đây là CHƯA CÓ LƯỢT GỌI NÀO, khác hẳn "gọi rồi mà không định giá được"
   * (cái đó là `chiPhi.usd === null`).
   */
  chiPhi: AgentOutcome["chiPhi"] | null;
};

const KHONG_CHAY: TechGateResult = "UNKNOWN";

export type RunnerOptions = {
  taskId: string;
  agentKey: string;
  executor: AgentExecutor;
  repoRoot: string;
  baseCommit: string;
  actor: TechActor;
  /** Cổng phải chạy sau khi agent xong. Mặc định typecheck + lint (đủ cho một việc tài liệu). */
  gates?: ("typecheck" | "lint" | "test" | "build")[];
  /** Giữ cây làm việc lại để soi bằng tay. Mặc định dọn. */
  keepWorkspace?: boolean;
  /**
   * NẤC 5 — chạy lại trên một nhánh ĐÃ CÓ thay vì mở nhánh mới.
   *
   * Có giá trị ⇒ base SHA là ĐỈNH của nhánh ấy, không phải `main`: lấy `main` nghĩa là vứt công
   * việc của lượt trước và làm lại từ đầu, đúng thứ nấc này sinh ra để tránh.
   */
  rerunBranch?: string;
  /** Phản hồi của người xem, đi vào prompt dưới dạng DỮ LIỆU — xem `lib/constants/agent-rerun.ts`. */
  feedback?: readonly { tacGia: string; noiDung: string }[];
};

/**
 * Chạy một việc Tech bằng một agent.
 *
 * Trả về `BLOCKED` (kèm lý do) thay vì ném lỗi cho mọi trường hợp "không được phép" — vì đó là kết
 * quả HỢP LỆ của một cổng đang làm đúng việc, không phải một sự cố.
 */
export async function runAgentOnTask(opts: RunnerOptions): Promise<RunnerResult> {
  const db = await getDb();
  const rong: RunnerResult = {
    status: "BLOCKED",
    runId: null,
    branch: null,
    baseCommit: opts.baseCommit,
    resultCommit: null,
    filesChanged: [],
    gates: { typecheck: KHONG_CHAY, lint: KHONG_CHAY, test: KHONG_CHAY, build: KHONG_CHAY },
    summary: "",
    reason: null,
    // Dừng trước khi gọi model lần nào ⇒ CHƯA CÓ lượt gọi, không phải "tốn 0 đồng".
    chiPhi: null,
  };

  /* ───────── 1. Việc và agent phải có thật ───────── */
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, opts.taskId) });
  if (!task) return { ...rong, reason: "Không tìm thấy việc này." };
  const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.key, opts.agentKey) });
  if (!agent) return { ...rong, reason: `Không có agent \`${opts.agentKey}\` trong sổ. Khởi tạo sổ agent ở /tech/agents trước.` };

  /* ───────── 2. Agent phải đang BẬT ───────── */
  if (!agent.enabled) return { ...rong, reason: `Agent “${agent.name}” đang TẮT — chủ shop chưa bật nó.` };

  /* ───────── 3. Mức rủi ro của việc phải nằm trong quyền của agent ───────── */
  if (!agent.allowedRisks.includes(task.risk)) {
    return { ...rong, reason: `Việc ${task.code} ở mức ${task.risk}, agent “${agent.name}” chỉ được phép ${agent.allowedRisks.join(", ") || "(chưa khai mức nào)"}.` };
  }

  /* ───────── 4. Ba quyền chưa tồn tại máy thi hành ───────── */
  if (agent.canMerge || agent.canDeploy || agent.canRunProdWrite) {
    return { ...rong, reason: "Phase 2A không chạy agent mang quyền merge / deploy / ghi production — máy thi hành cho những việc đó chưa được xây." };
  }

  /* ───────── 5. Không hai lượt chạy song song trên cùng một việc ───────── */
  const dangChay = await db.query.techAgentRuns.findFirst({
    where: and(eq(schema.techAgentRuns.taskId, opts.taskId), eq(schema.techAgentRuns.status, "RUNNING")),
  });
  if (dangChay) {
    return { ...rong, reason: `Việc ${task.code} đã có một lượt chạy đang mở (${dangChay.id}). Đóng nó trước — hai lượt song song sẽ ghi đè bằng chứng của nhau.` };
  }

  /* ───────── 6. Executor phải dùng được — chưa có khoá thì BLOCKED, KHÔNG giả vờ xong ───────── */
  const san = opts.executor.available();
  if (!san.ok) return { ...rong, reason: `CHƯA CẤU HÌNH: ${san.reason}` };

  /* ───────── 6b. Phạm vi ghi ĐỌC TỪ VAI, không ghi cứng một hằng số ─────────
     Sổ `lib/constants/agent-scopes.ts` là chỗ duy nhất khai vai nào ghi được ở đâu. Vai lạ hay
     chưa khai rơi về `docs/` — mọi nhánh lỗi rơi về phía HẸP HƠN (cùng luật AGENTS.md mục 31). */
  const phamViGhi = writeGlobsForRole(agent.role);

  /* ───────── 7. Mở lượt chạy ───────── */
  /* ───────── 6c. NHÁNH: mở mới, hay chạy lại trên nhánh đã có ───────── */
  let branch = `ai/${agent.key}/${task.code}-${Date.now().toString(36)}`;
  let baseCommit = opts.baseCommit;
  let dungLaiNhanh = false;
  if (opts.rerunBranch) {
    /*
      ĐẾM BẰNG HAI NGUỒN, LẤY SỐ LỚN HƠN — VÀ ĐÂY LÀ MỘT BẢN VÁ CHO LỜI KHẲNG ĐỊNH CỦA CHÍNH TÔI.

      Bản đầu chỉ đếm từ `tech_agent_runs` và chú thích rằng *"sổ thì không quên"*. Câu ấy đúng ở
      máy có CSDL thật — và SAI ở chỗ nó thật sự chạy: trên máy Actions, sổ là một CSDL PGlite
      DỰNG MỚI MỖI LƯỢT, nên nó luôn đếm được 0 và trần KHÔNG BAO GIỜ chạm tới. Một cái trần không
      bao giờ chạm tới thì không phải cái trần; nó là một dòng chú thích.

      Thứ DUY NHẤT sống sót qua các lượt chạy trên máy dùng-một-lần là chính cái nhánh git: mỗi
      lượt agent để lại đúng một commit. Nên lấy MAX của hai nguồn — sổ (đúng trên máy người vận
      hành) và số commit của nhánh (đúng trên máy CI). Không nguồn nào thay được nguồn kia, và lấy
      số lớn hơn là rơi về phía CHẶT hơn (AGENTS.md mục 31).

      Đếm được `null` (git không trả lời) ⇒ chỉ còn sổ. KHÔNG coi `null` là 0: đó là CHƯA BIẾT.
    */
    const theoSo = await db.$count(schema.techAgentRuns, eq(schema.techAgentRuns.taskId, task.id));
    const theoNhanh = await soCommitCuaAgent(opts.repoRoot, opts.rerunBranch, "origin/main");
    const daCo = Math.max(theoSo, theoNhanh ?? 0);
    const v = checkRerun({ branch: opts.rerunBranch, agentKey: agent.key, soLuotDaCo: daCo });
    if (!v.ok) return { ...rong, reason: v.reason };
    const dinh = await dinhNhanh(opts.repoRoot, v.branch);
    if (!dinh) return { ...rong, reason: `Không đọc được đỉnh nhánh “${v.branch}” — nhánh chưa có trong kho?` };
    branch = v.branch;
    baseCommit = dinh;
    dungLaiNhanh = true;
  }
  const mo = await startTechAgentRun({ agentId: agent.id, taskId: task.id, branch, baseCommit }, opts.actor);
  if ("error" in mo) return { ...rong, reason: mo.error };
  const runId = mo.id;

  let ws: AgentWorkspace | null = null;
  try {
    /* ───────── 8. Cây làm việc riêng, dựng từ base SHA ĐÃ VÀO KHO ───────── */
    ws = await AgentWorkspace.create({
      repoRoot: opts.repoRoot,
      branch,
      baseCommit,
      reuseBranch: dungLaiNhanh,
      allowedCommands: DOCUMENTATION_COMMANDS,
      readGlobs: DOCUMENTATION_READ_GLOBS,
      writeGlobs: phamViGhi,
    });
    await db.update(schema.techAgentRuns).set({ worktree: ws.root, heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId));

    /* ───────── 9. Agent làm việc ─────────
       NHỊP TIM PHẢI ĐẬP TRONG LÚC BƯỚC NÀY CHẠY, KHÔNG CHỈ KHI NÓ XONG.

       Trước đây `heartbeat_at` chỉ được ghi ở ba mốc THƯA: dựng xong cây làm việc, executor trả
       về, và sau mỗi cổng. Bước dưới đây — agent suy nghĩ và sửa tệp — là bước DÀI NHẤT và nằm
       trọn giữa hai mốc. Từ lúc `agent-reaper` có lịch (ngưỡng 45 phút), một lượt chạy dài hơn
       thế bị đóng GIỮA CHỪNG dù tiến trình vẫn sống, và hậu quả không dừng ở một dòng sai:

        · Cổng "không hai lượt song song" mở ra ⇒ một lượt thứ hai khởi động trên cùng việc.
        · Khi tiến trình thật xong, `finishTechAgentRun` thấy `status !== 'RUNNING'` và trả về
          ngay (AGENTS.md mục 61 — đóng một ca đã đóng không được ghi gì thêm), nên commit SHA,
          kết quả bốn cổng và danh sách tệp đổi BỊ VỨT.

       Nhịp tim là lời khai "tiến trình còn sống", và một tiến trình đang chờ một lời gọi dài thì
       VẪN SỐNG. Nên nó phải tự khai mỗi phút, chứ không phải im lặng rồi bị coi là đã chết.
       `unref()` để nhịp này không bao giờ giữ tiến trình lại sau khi việc xong. */
    const nhip = setInterval(() => {
      void db.update(schema.techAgentRuns).set({ heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId)).catch(() => undefined);
    }, HEARTBEAT_EVERY_MS);
    nhip.unref?.();
    /* Cây làm việc đã dựng; giữ một tham chiếu KHÔNG null để lượt sửa dùng lại đúng cây ấy. */
    const cay = ws;
    /** Dựng đề bài MỘT chỗ — lượt sửa phải nhận y hệt lượt đầu, chỉ khác phần phản hồi. */
    const deBai = (phanHoi: string) => ({
      taskCode: task.code,
      role: agent.role,
      taskTitle: task.title,
      taskDescription: task.description,
      writeGlobs: phamViGhi,
      readGlobs: DOCUMENTATION_READ_GLOBS,
      feedback: phanHoi,
      baseCommit,
      branch,
      workspace: cay,
    });
    let outcome: Awaited<ReturnType<AgentExecutor["run"]>>;
    try {
      outcome = await opts.executor.run(deBai(goiPhanHoi(opts.feedback ?? [])));
    } finally {
      clearInterval(nhip);
    }
    await db.update(schema.techAgentRuns).set({ heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId));

    /* ───────── 10. KIỂM LẠI MỨC RỦI RO — việc có thể đã bị nâng trong lúc chạy ───────── */
    const sauKhiChay = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, opts.taskId), columns: { risk: true, code: true, status: true } });
    const riskMoi = (sauKhiChay?.risk ?? task.risk) as TechRisk;
    if (riskMoi !== task.risk && !agent.allowedRisks.includes(riskMoi)) {
      const ly = `Việc ${task.code} bị NÂNG từ ${task.risk} lên ${riskMoi} trong lúc lượt chạy đang diễn ra — dừng trước bước commit, không đưa gì vào kho.`;
      await finishTechAgentRun({ runId, status: "CANCELLED", summary: ly, error: ly }, opts.actor);
      return { ...rong, status: "BLOCKED", runId, branch, reason: ly };
    }

    /* ───────── 11. BỐN CỔNG — đo bằng EXIT CODE, không hỏi agent ───────── */
    const canChay = opts.gates ?? ["typecheck", "lint"];
    const gates = { typecheck: KHONG_CHAY, lint: KHONG_CHAY, test: KHONG_CHAY, build: KHONG_CHAY } as RunnerResult["gates"];
    const lenh: Record<string, string[]> = { typecheck: ["npm", "run", "typecheck"], lint: ["npm", "run", "lint"], test: ["npm", "test"], build: ["npm", "run", "build"] };
    const daChay: string[] = [];

    /** Chạy đủ bộ cổng một lượt; trả về những cổng ĐỎ kèm đầu ra, để còn đưa lại cho agent. */
    const chayCong = async (): Promise<KetQuaCong[]> => {
      const hong: KetQuaCong[] = [];
      for (const g of canChay) {
        const r = await cay.run(lenh[g]);
        if ("blocked" in r) {
          gates[g] = KHONG_CHAY;
          continue;
        }
        daChay.push(`${lenh[g].join(" ")} (exit=${r.exitCode})`);
        gates[g] = r.ok ? "PASSED" : "FAILED";
        if (!r.ok) hong.push({ ten: lenh[g].join(" "), exitCode: r.exitCode, dauRa: `${r.stdout}
${r.stderr}` });
        await db.update(schema.techAgentRuns).set({ heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId));
      }
      return hong;
    };

    const hong = await chayCong();

    /*
      ═══ MỘT LƯỢT SỬA NGAY TRONG LƯỢT CHẠY — xem `lib/constants/agent-gate-repair.ts` ═══

      Cổng chạy SAU khi agent gọi `finish`, nên agent chưa từng nhìn thấy lỗi của chính mình. Hai
      lượt liền (#23 $0,2719 · #24 $0,3024) mất trắng vì đúng chỗ hở đó — cả hai đều tin là đã xong.

      Tệp nó viết VẪN CÒN trên cây làm việc, nên đưa lỗi lại và cho sửa tiếp rẻ hơn hẳn việc bỏ cả
      lượt rồi dispatch lại từ đầu. Chỉ MỘT lần; hết thì lượt chạy kết thúc ĐỎ như cũ.

      Chỉ sửa khi agent ĐÃ gọi finish: nó dừng giữa chừng vì lý do khác (hết vòng, bỏ cuộc) thì cổng
      đỏ không phải thứ đáng nói tới trước.
    */
    if (hong.length && outcome.finished && GATE_REPAIR.toiDa > 0) {
      const lan2 = await opts.executor.run(deBai(dungPhanHoiCong(hong)));
      outcome = {
        ...lan2,
        summary: lan2.summary || outcome.summary,
        steps: [...outcome.steps, { kind: "NOTE", detail: `Cổng đỏ (${hong.map((h) => h.ten).join(", ")}) — đưa lỗi lại cho agent sửa một lần.` }, ...lan2.steps],
        chiPhi: congChiPhi(outcome.chiPhi, lan2.chiPhi),
      };
      await chayCong();
    }

    const filesChanged = await ws.changedFiles();
    const congDo = Object.values(gates).some((v) => v === "FAILED");

    /* ───────── 12. Commit — CHỈ khi agent xong, có tệp đổi, và không cổng nào đỏ ───────── */
    let resultCommit: string | null = null;
    let commitDetail = "";
    if (!outcome.finished) {
      commitDetail = "Agent chưa gọi finish — không commit.";
    } else if (!filesChanged.length) {
      commitDetail = "Không tệp nào đổi — không có gì để commit.";
    } else if (congDo) {
      commitDetail = "Có cổng ĐỎ — không commit. Bằng chứng giữ nguyên trong cây làm việc.";
    } else {
      const c = await ws.commit(
        `${task.code}: ${task.title}\n\n${outcome.summary.slice(0, 1000)}\n\nLượt chạy agent: ${runId}\nAgent: ${agent.key} (${agent.role})\nCổng đã chạy: ${daChay.join(" · ") || "(không có)"}`,
        { name: `ERP agent ${agent.key}`, email: "agent@erp.local" },
      );
      resultCommit = c.commit;
      commitDetail = c.detail;
    }

    const status: RunnerResult["status"] = congDo || !outcome.finished ? "FAILED" : "SUCCEEDED";
    const summary = [outcome.summary, commitDetail].filter(Boolean).join(" ").slice(0, 4000);

    await finishTechAgentRun(
      {
        runId,
        status: status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        summary,
        resultCommit: resultCommit ?? "",
        testsRun: daChay.join(" · "),
        typecheckResult: gates.typecheck,
        lintResult: gates.lint,
        testResult: gates.test,
        buildResult: gates.build,
        filesChanged,
        error: outcome.error ?? (congDo ? "Có cổng kiểm thử ĐỎ." : ""),
      },
      opts.actor,
    );

    return { status, runId, branch, baseCommit: opts.baseCommit, resultCommit, filesChanged, gates, summary, reason: outcome.error, chiPhi: outcome.chiPhi };
  } catch (e) {
    const loi = e instanceof Error ? e.message : String(e);
    await finishTechAgentRun({ runId, status: "FAILED", summary: "Lượt chạy hỏng giữa chừng.", error: loi }, opts.actor).catch(() => undefined);
    return { ...rong, status: "FAILED", runId, branch, reason: loi };
  } finally {
    // Dọn cây, GIỮ nhánh và commit: xoá nhánh là xoá bằng chứng.
    if (ws && !opts.keepWorkspace) await ws.cleanup().catch(() => undefined);
  }
}

/**
 * LƯỢT CHẠY MỒ CÔI — tiến trình chết giữa chừng.
 *
 * Không có bước này thì một lượt chạy nằm mãi ở `RUNNING`: thẻ "agent đang chạy" nói dối vĩnh viễn,
 * và cổng "không hai lượt song song" chặn luôn mọi lượt sau trên cùng việc. Nhịp tim (`heartbeat_at`)
 * là thứ phân biệt "đang chạy thật" với "đã chết" — mốc đứng im quá lâu nghĩa là không ai còn cập
 * nhật nó.
 *
 * ─── VÌ SAO NAY CHẠY THEO LỊCH ───
 *
 * Phase 2A cố ý KHÔNG lên lịch: "một job tự đóng lượt chạy của người khác là thứ phải có người
 * quyết". Đo lại 20/09/2026 cho thấy cái giá của lựa chọn đó lớn hơn cái nó bảo vệ — và cái nó
 * bảo vệ thì KHÔNG tồn tại:
 *
 * · Hàm này KHÔNG đóng lượt chạy của ai đang chạy. Điều kiện là nhịp tim ĐỨNG IM quá ngưỡng; một
 *   tiến trình còn sống vẫn đập nhịp, nên nó không bao giờ lọt vào tập bị đóng. Thứ nó chạm tới
 *   đúng bằng những lượt chạy KHÔNG CÒN AI CẬP NHẬT.
 * · Không có lịch thì hậu quả không dừng ở "một dòng sai": cổng chống chạy song song đọc đúng
 *   bảng này, nên MỘT lượt chạy mồ côi khoá vĩnh viễn mọi lượt sau trên cùng việc — im lặng, cho
 *   tới khi có người biết là phải gọi tay. Để nguyên là chọn hỏng ĐÓNG mà không báo ai.
 *
 * Nhịp 15 phút với ngưỡng 45 phút: một lượt chạy phải im lặng qua ÍT NHẤT ba nhịp tim trước khi
 * bị đóng. Và nó đóng thành `FAILED` KÈM LÝ DO ĐO ĐƯỢC (mốc nhịp tim cuối, ngưỡng đã dùng), chứ
 * không xoá dòng — bằng chứng ở lại.
 */
export async function reapStaleRuns(staleMinutes = 45, actor: TechActor = { kind: "SYSTEM", name: "job:agent-reaper" }) {
  const db = await getDb();
  const nguong = new Date(Date.now() - staleMinutes * 60_000);
  const rows = await db.query.techAgentRuns.findMany({ where: eq(schema.techAgentRuns.status, "RUNNING") });
  const cu = rows.filter((r) => (r.heartbeatAt ?? r.startedAt) < nguong);
  for (const r of cu) {
    await finishTechAgentRun(
      {
        runId: r.id,
        status: "FAILED",
        summary: "Lượt chạy không đập nhịp nữa — tiến trình nhiều khả năng đã chết.",
        error: `Không có nhịp tim từ ${(r.heartbeatAt ?? r.startedAt).toISOString()}; ngưỡng ${staleMinutes} phút.`,
      },
      actor,
    );
  }
  return { checked: rows.length, reaped: cu.length, ids: cu.map((r) => r.id) };
}

/** Lượt chạy đang mở của một tập việc — dùng cho màn hình và cho chính cổng chống chạy song song. */
export async function activeRunsFor(taskIds: string[]) {
  if (!taskIds.length) return [];
  const db = await getDb();
  return db.query.techAgentRuns.findMany({
    where: and(inArray(schema.techAgentRuns.taskId, taskIds), eq(schema.techAgentRuns.status, "RUNNING")),
  });
}

/**
 * ═══════════ LƯỢT LẬP KẾ HOẠCH THẬT ĐẦU TIÊN CỦA AI CTO ═══════════
 *
 *     npm run cto:proof -- --actor "github:<login>"
 *
 * Chạy TRÊN MÁY RUNNER. Làm đúng năm việc rồi DỪNG:
 *
 *   1. khởi tạo sổ agent qua đúng hàm dịch vụ (12 vai, tất cả TẮT)
 *   2. bật ĐÚNG MỘT vai `ai-cto` — không vai viết mã nào được bật
 *   3. tạo một MỤC TIÊU thật qua `createTechTask()`
 *   4. gọi model THẬT, đọc bản kế hoạch qua zod
 *   5. ghi bản đề xuất
 *
 * KHÔNG duyệt. KHÔNG tạo việc con. Đó là việc của một con người, và script này không có đường nào
 * để làm thay — `approveProposal()` từ chối mọi actor không phải người, và script cũng không gọi.
 *
 * HẬU QUẢ PHẢI NÓI RA: máy Actions không nối được tới CSDL production (nó nằm sau mạng docker của
 * VPS), nên bản đề xuất này nằm ở một CSDL dùng-một-lần và được XUẤT ra thành hiện vật. Nó là một
 * lượt gọi model THẬT với một bản kế hoạch THẬT đã qua zod — nhưng nó KHÔNG hiện ở `/tech/cto`
 * trên production.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { buildCtoPrompt, runCtoPlanning } from "@/lib/agents/cto";
import { getAiProvider } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { createProposal } from "@/lib/tech/proposal";
import { createTechTask, seedTechAgents, setTechAgentEnabled, type TechActor } from "@/lib/tech/service";

const TITLE = "Đánh giá và đề xuất cải thiện tốc độ trang vận đơn";
const MO_TA = `Trang /shipments mở chậm khi có nhiều vận đơn. Cần đánh giá xem thời gian đi đâu và
đề nghị cách cải thiện.

Yêu cầu với bản kế hoạch: chia thành các việc làm được, nói rõ việc nào phải xong trước, mỗi việc
có tiêu chí nghiệm thu ĐO ĐƯỢC, và nêu vai agent phù hợp. Nếu thiếu dữ liệu để quyết thì hỏi.`;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const actorName = (arg("actor") ?? "").trim();
  if (!actorName) {
    console.error('Thiếu --actor. Ví dụ: npm run cto:proof -- --actor "github:someone"');
    process.exit(1);
  }
  // Tài khoản GitHub KHÔNG phải `users.id` — giữ tên như ẢNH CHỤP, khoá để trống (AGENTS.md mục 34).
  const nguoi: TechActor = { kind: "HUMAN", id: null, name: actorName };

  await ensureMigrated();
  const db = await getDb();

  const seed = await seedTechAgents(nguoi);
  if (!("ok" in seed)) {
    console.error(`✗ Không khởi tạo được sổ agent: ${seed.error}`);
    process.exit(1);
  }
  const agents = await db.query.techAgents.findMany();
  console.log(`▶ Sổ agent: ${agents.length} vai · đang bật trước khi mở: ${agents.filter((a) => a.enabled).length}`);

  const cto = agents.find((a) => a.key === "ai-cto");
  if (!cto) {
    console.error("✗ Không thấy vai ai-cto trong sổ.");
    process.exit(1);
  }
  const bat = await setTechAgentEnabled({ agentId: cto.id, enabled: true }, nguoi);
  if (!("ok" in bat)) {
    console.error(`✗ Không bật được vai ai-cto: ${bat.error}`);
    process.exit(1);
  }
  const dangBat = (await db.query.techAgents.findMany()).filter((a) => a.enabled);
  console.log(`▶ Đang bật: ${dangBat.map((a) => a.key).join(", ")}`);
  if (dangBat.length !== 1 || dangBat[0].key !== "ai-cto") {
    console.error("✗ Phải bật ĐÚNG MỘT vai ai-cto — Phase 2B KHÔNG mở agent viết mã nào.");
    process.exit(1);
  }

  const provider = getAiProvider("analysis");
  if (!provider) {
    console.error(`✗ CHƯA CẤU HÌNH: ${aiDisabledReason()}`);
    process.exit(2);
  }
  console.log(`▶ Nhà cung cấp: ${provider.name} · ${provider.model}`);

  const mucTieu = await createTechTask(
    { title: TITLE, description: MO_TA, taskType: "PERFORMANCE", module: "SHIPMENTS", priority: "P2", source: "OWNER" },
    nguoi,
  );
  if (!("ok" in mucTieu)) {
    console.error(`✗ Không tạo được mục tiêu: ${mucTieu.error}`);
    process.exit(1);
  }
  console.log(`▶ Mục tiêu: ${mucTieu.code} · rủi ro MÁY xếp = ${mucTieu.risk}`);

  const truocKhiChay = (await db.query.techTasks.findMany()).length;
  const ctx = await buildCtoPrompt(mucTieu.id);
  if (!ctx) {
    console.error("✗ Không dựng được ngữ cảnh.");
    process.exit(1);
  }
  console.log(`▶ Ngữ cảnh: ${ctx.prompt.length} ký tự · kiểm bí mật: ${ctx.blocked ?? "sạch"}`);
  if (ctx.blocked) {
    console.error(`✗ TỪ CHỐI gọi model: prompt chứa ${ctx.blocked}`);
    process.exit(1);
  }

  const t0 = Date.now();
  const res = await runCtoPlanning(provider, ctx);
  console.log(`▶ Lượt gọi model xong sau ${Math.round((Date.now() - t0) / 1000)} giây · ${res.ok ? "ĐỌC ĐƯỢC kế hoạch" : "KHÔNG đọc được"}`);

  const ghi = await createProposal({
    sourceTaskId: mucTieu.id,
    agentId: cto.id,
    agentKey: cto.key,
    provider: res.provider,
    model: res.model,
    plan: res.ok ? res.plan : null,
    error: res.ok ? "" : res.error,
    rawOutput: res.raw,
  });
  if (!("ok" in ghi)) {
    console.error(`✗ Không ghi được bản đề xuất: ${ghi.error}`);
    process.exit(1);
  }

  const sauKhiChay = await db.query.techTasks.findMany();
  const items = await db.query.techProposalTasks.findMany({
    where: eq(schema.techProposalTasks.proposalId, ghi.id),
    orderBy: (t, { asc }) => [asc(t.seq)],
  });

  console.log("\n══════════ BẢN ĐỀ XUẤT CỦA AI CTO ══════════");
  console.log(`proposal id   ${ghi.id}`);
  console.log(`trạng thái    ${ghi.status}`);
  console.log(`mục tiêu      ${mucTieu.code} · ${TITLE}`);
  console.log(`provider      ${res.provider} · ${res.model}`);
  if (!res.ok) console.log(`LỖI           ${res.error}`);
  if (res.ok) {
    console.log(`tóm tắt       ${res.plan.summary.slice(0, 500)}`);
    console.log(`giả định      ${res.plan.assumptions.length}`);
    for (const a of res.plan.assumptions) console.log(`  · ${a}`);
    console.log(`câu hỏi       ${res.plan.questions.length}`);
    for (const q of res.plan.questions) console.log(`  ? ${q}`);
    console.log(`việc đề nghị  ${items.length}`);
    for (const t of items) {
      console.log(`  [${t.key}] ${t.title}`);
      console.log(`       loại=${t.taskType} module=${t.module} ưu tiên=${t.suggestedPriority} vai=${t.suggestedAgentKey}`);
      console.log(`       AI nghĩ rủi ro=${t.suggestedRisk} · phụ thuộc=${(t.dependsOnKeys as string[]).join(",") || "—"} · cần người quyết=${t.needsHumanDecision}`);
      for (const a of t.acceptanceCriteria as string[]) console.log(`       ✓ ${a}`);
    }
  }
  console.log(`\nviệc thật trước lượt chạy: ${truocKhiChay} · sau: ${sauKhiChay.length}`);
  console.log("═══════════════════════════════════════════");

  writeFileSync(
    "bang-chung-cto.json",
    JSON.stringify(
      {
        proposalId: ghi.id,
        status: ghi.status,
        sourceTask: { id: mucTieu.id, code: mucTieu.code, title: TITLE, risk: mucTieu.risk },
        provider: res.provider,
        model: res.model,
        error: res.ok ? null : res.error,
        summary: res.ok ? res.plan.summary : null,
        assumptions: res.ok ? res.plan.assumptions : [],
        questions: res.ok ? res.plan.questions : [],
        tasks: items.map((t) => ({
          key: t.key,
          title: t.title,
          taskType: t.taskType,
          module: t.module,
          suggestedPriority: t.suggestedPriority,
          suggestedRisk: t.suggestedRisk,
          riskExplanation: t.riskExplanation,
          suggestedAgent: t.suggestedAgentKey,
          dependsOn: t.dependsOnKeys,
          acceptanceCriteria: t.acceptanceCriteria,
          expectedScope: t.expectedScope,
          needsHumanDecision: t.needsHumanDecision,
          appliedTaskId: t.appliedTaskId,
        })),
        realTasksBefore: truocKhiChay,
        realTasksAfter: sauKhiChay.length,
        enabledAgents: dangBat.map((a) => a.key),
      },
      null,
      2,
    ),
  );

  /*
    ĐIỀU KIỆN ĐẠT — và "AI không tạo việc thật" là điều kiện QUAN TRỌNG NHẤT.

    Nếu số việc thật tăng sau một lượt lập kế hoạch thì toàn bộ chế độ đề xuất là giả: AI đã đi
    thẳng vào hàng đợi mà không qua người nào.
  */
  const hong: string[] = [];
  if (sauKhiChay.length !== truocKhiChay) hong.push(`AI đã tạo ${sauKhiChay.length - truocKhiChay} việc thật — chế độ đề xuất bị phá`);
  if (!res.ok) hong.push(`không đọc được kế hoạch: ${res.error}`);
  if (res.ok && items.length === 0) hong.push("bản kế hoạch không có việc nào");
  if (items.some((t) => t.appliedTaskId)) hong.push("có dòng đề xuất đã nối tới việc thật — chưa ai duyệt mà đã áp");

  if (hong.length) {
    console.log("\n✗ LƯỢT LẬP KẾ HOẠCH KHÔNG ĐẠT:");
    for (const h of hong) console.log(`  · ${h}`);
    process.exit(1);
  }
  console.log("\n✓ ĐẠT: model thật · kế hoạch qua zod · bản đề xuất đã ghi · KHÔNG việc thật nào được tạo.");
  console.log("  CHƯA duyệt — đó là việc của một con người, trên /tech/cto.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

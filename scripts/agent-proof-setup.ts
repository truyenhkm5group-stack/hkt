/**
 * ═══════════ DỰNG SÂN CHO LƯỢT CHẠY AGENT ĐẦU TIÊN ═══════════
 *
 *     npm run agent:proof-setup -- --actor "github:<login>"
 *
 * Chạy TRÊN MÁY RUNNER, trước `agent:run`. Làm đúng ba việc, mỗi việc qua ĐÚNG hàm dịch vụ mà
 * giao diện `/tech` gọi — không `INSERT` tay, không migration gieo dữ liệu (đặc tả mục 3).
 *
 *   1. `seedTechAgents()`    — khởi tạo sổ 12 vai, tất cả TẮT. Gọi hai lần để chứng minh idempotent.
 *   2. `setTechAgentEnabled()` — bật ĐÚNG MỘT vai `documentation`. Không vai nào khác.
 *   3. `createTechTask()`    — tạo việc R0, rồi KIỂM lại mức rủi ro MÁY tự xếp.
 *
 * ─── VÌ SAO NGƯỜI THAO TÁC LÀ `HUMAN` ───
 *
 * `seedTechAgents()` và `setTechAgentEnabled()` TỪ CHỐI mọi actor không phải người — đó là luật
 * "mẫu không tự kích hoạt" (AGENTS.md mục 23), và nó tồn tại để một cỗ máy không tự dựng rồi tự
 * bật agent cho chính nó. Script này chỉ chạy được từ một workflow `workflow_dispatch`, tức là
 * phải có người cầm quyền trên kho bấm Run, và `--actor` mang đúng tên tài khoản GitHub ấy vào
 * sổ. `id: null` vì tài khoản GitHub KHÔNG phải `users.id` — nối bừa hai không gian danh tính là
 * quy kết sai (mục 34).
 *
 * ─── VIỆC R0 PHẢI ĐƯỢC MÁY XẾP R0 ───
 *
 * Nếu máy trả R1/R2 thì script DỪNG và in ra luật nào đã khớp. KHÔNG đè mức rủi ro — đè là làm
 * cổng phê duyệt thành vô nghĩa, và đặc tả cấm thẳng.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { classifyTechRisk } from "@/lib/constants/tech-risk";
import { createTechTask, seedTechAgents, setTechAgentEnabled, type TechActor } from "@/lib/tech/service";

const TITLE = "Kiểm chứng DOCUMENTATION agent Phase 2A";

/*
  MÔ TẢ NÀY VỪA LÀ ĐỀ BÀI CHO AGENT, VỪA LÀ ĐẦU VÀO CỦA MÁY XẾP RỦI RO.

  Máy đọc CHỮ chứ không đọc Ý: một mô tả nhắc chữ "quyền" bị luật `ACCESS` kéo lên R2 dù việc chỉ
  viết một tệp markdown, và mọi việc khai module `PLATFORM` bị luật `INFRA` kéo lên R1. Nên mô tả
  dưới đây nói ĐÚNG thứ việc này làm, bằng chữ không khẳng định sai rằng nó chạm tới quyền hay hạ
  tầng. Đây KHÔNG phải né luật: việc thật sự chỉ ghi một tệp trong `docs/`.
*/
const DESCRIPTION = `Viết MỘT trang tài liệu ghi lại lượt chạy runner đầu tiên của Phòng Tech AI.

Chỉ được tạo hoặc sửa ĐÚNG MỘT tệp: docs/ai-tech-agent-runner-proof.md

Trang tài liệu phải ghi đủ:
- mã việc
- base SHA của lượt chạy
- tên nhánh agent làm việc trên đó
- vai agent đã chạy (DOCUMENTATION)
- phạm vi duy nhất của lượt chạy này (đúng một tệp nêu trên)
- kết quả bốn cổng: typecheck, lint, test, build
- những việc vai tài liệu KHÔNG được làm
- và đúng câu này, nguyên văn: "Agent không merge, không deploy"

Không sửa bất kỳ tệp nào khác. Không chạy lệnh ngoài danh sách cho phép.`;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const actorName = (arg("actor") ?? "").trim();
  if (!actorName) {
    console.error("Thiếu --actor. Ví dụ: npm run agent:proof-setup -- --actor \"github:someone\"");
    process.exit(1);
  }
  // Tài khoản GitHub KHÔNG phải users.id — giữ tên như một ẢNH CHỤP để người đọc, khoá để trống.
  const nguoi: TechActor = { kind: "HUMAN", id: null, name: actorName };

  await ensureMigrated();
  const db = await getDb();

  // ───── 1. Khởi tạo sổ agent, và chứng minh bấm lại không nhân đôi ─────
  const lan1 = await seedTechAgents(nguoi);
  if (!("ok" in lan1)) {
    console.error(`✗ Không khởi tạo được sổ agent: ${lan1.error}`);
    process.exit(1);
  }
  const lan2 = await seedTechAgents(nguoi);
  if (!("ok" in lan2)) {
    console.error(`✗ Lượt khởi tạo thứ hai lỗi: ${lan2.error}`);
    process.exit(1);
  }
  console.log(`▶ Sổ agent: lần 1 tạo ${lan1.created} / bỏ qua ${lan1.skipped} · lần 2 tạo ${lan2.created} / bỏ qua ${lan2.skipped}`);
  if (lan2.created !== 0) {
    console.error("✗ Bấm lại đã tạo thêm dòng — sổ agent KHÔNG idempotent.");
    process.exit(1);
  }

  const agents = await db.query.techAgents.findMany();
  console.log(`  ${agents.length} vai: ${agents.map((a) => a.key).sort().join(", ")}`);
  const dangBat = agents.filter((a) => a.enabled);
  if (dangBat.length) {
    console.error(`✗ Có ${dangBat.length} vai đã BẬT sẵn — mọi vai phải sinh ra ở trạng thái TẮT: ${dangBat.map((a) => a.key).join(", ")}`);
    process.exit(1);
  }
  console.log("  tất cả đang TẮT ✓");

  // ───── 2. Bật ĐÚNG MỘT vai ─────
  const doc = agents.find((a) => a.key === "documentation");
  if (!doc) {
    console.error("✗ Không thấy vai documentation trong sổ.");
    process.exit(1);
  }
  const bat = await setTechAgentEnabled({ agentId: doc.id, enabled: true }, nguoi);
  if (!("ok" in bat)) {
    console.error(`✗ Không bật được vai documentation: ${bat.error}`);
    process.exit(1);
  }
  const sauKhiBat = await db.query.techAgents.findMany();
  const batSau = sauKhiBat.filter((a) => a.enabled);
  console.log(`▶ Đang bật: ${batSau.map((a) => a.key).join(", ") || "(không vai nào)"}`);
  if (batSau.length !== 1 || batSau[0].key !== "documentation") {
    console.error("✗ Phải bật ĐÚNG một vai documentation, không hơn.");
    process.exit(1);
  }
  const q = sauKhiBat.find((a) => a.key === "documentation")!;
  console.log(`  quyền: risk=[${(q.allowedRisks as string[]).join(",")}] merge=${q.canMerge} deploy=${q.canDeploy} prodWrite=${q.canRunProdWrite} prodRead=${q.canRunProdRead} review=${q.canReview}`);
  if (q.canMerge || q.canDeploy || q.canRunProdWrite || q.canRunProdRead || q.canReview) {
    console.error("✗ Vai documentation KHÔNG được mang bất kỳ quyền nào trong năm quyền trên.");
    process.exit(1);
  }
  if ((q.allowedRisks as string[]).join(",") !== "R0") {
    console.error("✗ Vai documentation chỉ được phép R0.");
    process.exit(1);
  }

  // ───── 3. Tạo việc, rồi KIỂM lại mức rủi ro MÁY tự xếp ─────
  const truoc = classifyTechRisk({ title: TITLE, description: DESCRIPTION, taskType: "DOCS", module: "TECH" });
  console.log(`▶ Máy xếp rủi ro TRƯỚC khi tạo: ${truoc.risk} [${truoc.rules.join(",") || "không luật nào khớp"}]`);
  if (truoc.risk !== "R0") {
    console.error(`✗ DỪNG: máy xếp ${truoc.risk}, không phải R0. Luật khớp: ${truoc.rules.join(", ")}`);
    for (const r of truoc.reasons) console.error(`   · ${r}`);
    console.error("   KHÔNG đè mức rủi ro — sửa mô tả/module cho đúng với thứ việc này thật sự làm, hoặc hỏi chủ shop.");
    process.exit(1);
  }

  const sanCo = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.title, TITLE) });
  if (sanCo) {
    console.log(`▶ Việc đã có: ${sanCo.code} (rủi ro ${sanCo.risk}) — dùng lại, không tạo trùng.`);
    console.log(`TASK_CODE=${sanCo.code}`);
    return;
  }

  const t = await createTechTask({ title: TITLE, description: DESCRIPTION, taskType: "DOCS", module: "TECH", priority: "P3", source: "OWNER" }, nguoi);
  if (!("ok" in t)) {
    console.error(`✗ Không tạo được việc: ${t.error}`);
    process.exit(1);
  }
  console.log(`▶ Đã tạo ${t.code} · rủi ro MÁY xếp = ${t.risk}`);
  if (t.risk !== "R0") {
    console.error(`✗ DỪNG: việc đã lưu mang mức ${t.risk}, không phải R0.`);
    process.exit(1);
  }
  console.log(`TASK_CODE=${t.code}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

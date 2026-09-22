/**
 * ═══════════ LẤY ĐÚNG VIỆC ĐƯỢC GIAO TỪ ERP, RỒI GIEO VÀO CSDL TẠM CỦA MÁY RUNNER ═══════════
 *
 *     npm run agent:fetch-task -- --task TECH-12
 *
 * Bước đầu của `agent-run.yml` khi người ta giao một việc CÓ THẬT. Không truyền `--task` thì
 * workflow vẫn chạy đường cũ (`agent:proof-setup` tự tạo việc R0 tự kiểm).
 *
 * ─── VÌ SAO PHẢI LẤY QUA HTTP ───
 *
 * Máy Actions không nối được PostgreSQL production, và giữ nguyên tính chất đó là chủ ý. Truyền
 * tiêu đề + mô tả qua `inputs` của `workflow_dispatch` thì KHÔNG được: kho PUBLIC, và đầu vào
 * dispatch hiện nguyên văn trong giao diện Actions. Nên việc đi qua cửa đọc hẹp
 * `GET /api/tech/agent-task`, đối xứng với cửa ghi và dùng chung khoá.
 *
 * ─── MỨC RỦI RO ĐƯỢC KIỂM LẠI Ở ĐÂY, KHÔNG TIN LỜI ERP ───
 *
 * ERP đã chặn ở cổng giao việc, nhưng runner vẫn tự xếp lại rủi ro bằng `classifyTechRisk()` trên
 * chính tiêu đề + mô tả nhận được. Hai lý do: (a) một gói tin bị sửa trên đường không được nâng
 * quyền của lượt chạy; (b) nếu hai bên xếp khác nhau thì đó là một khác biệt ĐÁNG BIẾT, và lượt
 * chạy dừng lại thay vì âm thầm chạy theo mức thấp hơn.
 *
 * ─── KHÔNG IN BÍ MẬT ───
 *
 * Kho PUBLIC nên log Actions ai cũng đọc được: chỉ in CÓ / KHÔNG cho khoá, và URL ở dạng gốc.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { PHAM_VI_CHI_SINH_CHU, chiSinhRaChu } from "@/lib/constants/agent-dispatch";
import { writeGlobsForRole } from "@/lib/constants/agent-scopes";
import { TECH_AGENT_TEMPLATES } from "@/lib/constants/tech";
import { classifyTechRisk } from "@/lib/constants/tech-risk";
import { createTechTask, seedTechAgents, setTechAgentEnabled, type TechActor } from "@/lib/tech/service";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function goc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(URL không hợp lệ)";
  }
}

type ViecNhanDuoc = {
  code: string;
  title: string;
  description: string;
  taskType: string;
  module: string;
  risk: string;
  agentKey: string;
  writeGlobs: string[];
};

async function main() {
  const ma = (arg("task") ?? "").trim();
  const actor = (arg("actor") ?? "").trim() || "github:unknown";
  if (!ma) {
    console.error("Thiếu --task.");
    process.exit(1);
  }

  const domain = (process.env.ERP_DOMAIN ?? "").trim();
  const base = ((process.env.ERP_BASE_URL ?? "").trim() || (domain ? `https://${domain}` : "")).replace(/\/$/, "");
  const secret = (process.env.AGENT_INGEST_SECRET ?? "").trim() || (process.env.CRON_SECRET ?? "").trim();
  if (!base || !secret) {
    console.error("══════════ LẤY VIỆC TỪ ERP: CHƯA BẬT ══════════");
    console.error(`địa chỉ ERP          ${base ? goc(base) : "KHÔNG có"}`);
    console.error(`AGENT_INGEST_SECRET  ${secret ? "có" : "KHÔNG có"}`);
    console.error("Khai ở Settings → Secrets and variables → Actions.");
    process.exit(1);
  }

  console.log("══════════ LẤY VIỆC TỪ ERP ══════════");
  console.log(`đích   ${goc(base)}`);
  console.log(`việc   ${ma}`);

  let res: Response;
  try {
    res = await fetch(`${base}/api/tech/agent-task?code=${encodeURIComponent(ma)}`, {
      headers: { "x-cron-secret": secret },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error(`✗ Không gọi được ERP: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(`✗ ERP trả HTTP ${res.status}: ${t.slice(0, 300)}`);
    process.exit(1);
  }
  const body = (await res.json()) as { task?: ViecNhanDuoc };
  const viec = body.task;
  if (!viec?.code) {
    console.error("✗ ERP trả về gói tin không có việc nào.");
    process.exit(1);
  }
  console.log(`nhận   ${viec.code} · ${viec.title}`);
  console.log(`vai    ${viec.agentKey} · ghi trong ${viec.writeGlobs.join(", ")}`);

  /*
    KIỂM LẠI RỦI RO TRÊN CHÍNH DỮ LIỆU NHẬN ĐƯỢC — không tin lời ERP.
    Lệch nhau là một khác biệt ĐÁNG BIẾT, không phải chuyện để bỏ qua.
  */
  const tuXep = classifyTechRisk({ title: viec.title, description: viec.description, taskType: viec.taskType as never, module: viec.module as never });
  console.log(`rủi ro ERP nói ${viec.risk} · runner tự xếp ${tuXep.risk} [${tuXep.rules.join(",") || "không luật nào khớp"}]`);
  if (tuXep.risk !== viec.risk) {
    console.error(`✗ DỪNG: hai bên xếp rủi ro KHÁC NHAU (ERP ${viec.risk} vs runner ${tuXep.risk}).`);
    for (const r of tuXep.reasons) console.error(`   · ${r}`);
    console.error("   Không chạy theo mức thấp hơn. Sửa mô tả việc cho đúng, hoặc hỏi chủ shop.");
    process.exit(1);
  }
  /*
    ═══ CỬA HẸP R2 — MỘT LUẬT, KHÔNG PHẢI HAI BẢN ═══

    Chỗ này từng chặn CỨNG mọi việc R2. Khi `canDispatchTask()` đổi sang cửa hẹp ba điều kiện, bản
    sao ở đây KHÔNG đổi theo — và nó là bản CHẶT hơn, nên nó thắng: đo 22/09/2026, TECH-12 đi qua
    đủ mọi cổng của ERP (vai được cấp R2 · chỉ ghi `docs/` · chủ shop đã ký · đã phân loại), lấy
    được việc từ production, rồi chết ở đúng dòng này. Cả dây chuyền đứng lại vì một bản sao bị bỏ
    quên. Một luật có hai bản thì bản nào cũng là bản thật ở đâu đó — và người dùng gặp bản nào
    thì đó là luật của họ.

    Nay hỏi `chiSinhRaChu()`, CÙNG hàm mà cổng giao việc dùng.

    ─── VÀ VẪN KHÔNG TIN LỜI ERP ───

    `viec.writeGlobs` do ERP gửi sang. Cả khối này tồn tại để kiểm LẠI trên dữ liệu nhận được, nên
    lấy con số của bên kia làm căn cứ là tự bỏ mục đích của mình. Phạm vi ghi tính TẠI ĐÂY từ sổ
    vai cục bộ; lệch nhau là một khác biệt đáng biết, không phải chuyện bỏ qua.
  */
  if (tuXep.risk === "R2") {
    const vaiMau = TECH_AGENT_TEMPLATES.find((t) => t.key === viec.agentKey);
    const phamVi = writeGlobsForRole(vaiMau?.role ?? null);
    if (phamVi.join("|") !== [...viec.writeGlobs].join("|")) {
      console.error(`✗ DỪNG: phạm vi ghi hai bên nói khác nhau (ERP ${viec.writeGlobs.join(", ")} vs runner ${phamVi.join(", ")}).`);
      process.exit(1);
    }
    if (!chiSinhRaChu(phamVi)) {
      console.error(`✗ DỪNG: việc R2 chỉ mở cho vai CHỈ GHI RA CHỮ (${PHAM_VI_CHI_SINH_CHU.join(" · ")}); vai “${viec.agentKey}” ghi được ${phamVi.join(", ") || "(chưa khai)"}.`);
      console.error("   Một bài kiểm không phải chữ — nó là khẳng định chặn deploy.");
      process.exit(1);
    }
    console.log(`R2 qua cửa hẹp: vai “${viec.agentKey}” chỉ ghi ${phamVi.join(", ")} · chủ shop đã ký · ERP đã mở cổng`);
  }

  await ensureMigrated();
  const db = await getDb();
  const nguoi: TechActor = { kind: "HUMAN", id: null, name: actor };
  await seedTechAgents(nguoi);
  const vai = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.key, viec.agentKey), columns: { id: true } });
  if (!vai) {
    console.error(`✗ Sổ agent cục bộ không có vai “${viec.agentKey}”.`);
    process.exit(1);
  }
  await setTechAgentEnabled({ agentId: vai.id, enabled: true }, nguoi);

  /*
    GIEO LẠI BẰNG ĐÚNG HÀM DỊCH VỤ mà `/tech` dùng, KHÔNG `insert` thẳng: mức rủi ro, cổng phê
    duyệt và mã việc đều do hàm ấy quyết. Chạy lại trên cùng CSDL tạm thì dùng lại việc đã có.
  */
  const daCo = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.title, viec.title), columns: { id: true, code: true } });
  if (daCo) {
    // Dùng lại việc cũ vẫn phải mang mã production — xem khối bên dưới.
    if (daCo.code !== viec.code) await db.update(schema.techTasks).set({ code: viec.code }).where(eq(schema.techTasks.id, daCo.id));
    console.log(`▶ Việc đã có trong CSDL tạm — dùng lại dưới mã ${viec.code}.`);
    console.log(`TASK_CODE=${viec.code}`);
    console.log(`AGENT_KEY=${viec.agentKey}`);
    return;
  }
  const t = await createTechTask(
    { title: viec.title, description: viec.description, taskType: viec.taskType as never, module: viec.module as never, priority: "P3", source: "OWNER", agentId: vai.id },
    nguoi,
  );
  if (!("ok" in t)) {
    console.error(`✗ Không tạo được việc trong CSDL tạm: ${t.error}`);
    process.exit(1);
  }
  /*
    ═══════════ MÃ VIỆC PHẢI LÀ MÃ CỦA PRODUCTION ═══════════

    ĐÃ CẮN THẬT — lượt chạy agent #14, việc thật đầu tiên của Phòng Tech AI:

      · Chủ shop tạo `TECH-2` trên production.
      · `createTechTask` gieo lại vào CSDL tạm — một CSDL RỖNG, nên bộ sinh mã cấp `TECH-1`.
      · Mọi bước sau đọc mã CỤC BỘ: nhánh thành `ai/documentation/TECH-1-…`, và cửa chép sổ ghi
        lượt chạy ấy vào **TECH-1 trên production** — một việc HOÀN TOÀN KHÁC (“Đánh giá tốc độ
        trang vận đơn”, mức R2).

    Không có gì đỏ lên. Sổ production nói một lượt chạy thuộc về một việc nó không thuộc về, và đó
    đúng là loại sai mà AGENTS.md mục 34–35 gọi tên: quy kết đi bằng khoá, và không được đoán.

    Nên CSDL tạm mang ĐÚNG danh tính của production. Sửa ở đây — một script chỉ chạy trên máy CI,
    ghi vào một CSDL dùng-một-lần — thay vì mở cho `createTechTask` nhận mã từ ngoài: đó là hàm
    dịch vụ của `/tech`, và nới nó ra để phục vụ một đường CI là đổi luật thật vì một nhu cầu giả.
  */
  await db.update(schema.techTasks).set({ code: viec.code }).where(eq(schema.techTasks.id, t.id));
  console.log(`▶ Đã gieo ${viec.code} (mã cục bộ ban đầu ${t.code}, đã đổi về mã production) · rủi ro ${t.risk}`);
  console.log(`TASK_CODE=${viec.code}`);
  /*
    VAI ĐI THEO VIỆC, KHÔNG PHẢI MỘT HẰNG SỐ TRONG YAML.

    ĐÃ CẮN THẬT, lượt chạy #21 — việc thật thứ hai, giao cho vai QA: workflow gọi
    `--agent documentation`, vai ấy KHÔNG được bật trong CSDL tạm (chỉ vai của việc mới được
    bật), nên lượt chạy BLOCKED ngay trước khi gọi model. Việc đã tới đúng nơi; chỉ cái TÊN VAI
    là bịa.

    In ra đây để workflow đọc lại, cùng đường với `TASK_CODE`.
  */
  console.log(`AGENT_KEY=${viec.agentKey}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

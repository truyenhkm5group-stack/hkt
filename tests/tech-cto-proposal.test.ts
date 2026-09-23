import assert from "node:assert/strict";
import { DISPATCHABLE_STATUSES } from "@/lib/constants/agent-dispatch";
import type { TechTaskStatus } from "@/lib/constants/tech";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CTO_MAX_OUTPUT_TOKENS, parseCtoPlan, type CtoPlan } from "@/lib/constants/cto-proposal";
import { promptCoSecretKhong, runCtoPlanning } from "@/lib/agents/cto";
import { NGUONG_KHONG_STREAM, RETRIES_BY_TIER, type AiProvider, type AiResponse } from "@/lib/ai/provider";
import { approveProposal, createProposal, rejectProposal, supersedeOpenProposals } from "@/lib/tech/proposal";
import { assignTechTaskAgent, createTechTask, type TechActor } from "@/lib/tech/service";

/**
 * ═══════════ AI CTO CHỈ ĐƯỢC ĐỀ NGHỊ ═══════════
 *
 * Mười ba điều đặc tả Phase 2B đòi, và tất cả chạy hàm THẬT trên CSDL kiểm thử — không mô phỏng.
 *
 * Điều quan trọng nhất nằm ở khối 4: mức rủi ro trong bản đề xuất là Ý KIẾN, và nó KHÔNG đi vào
 * việc thật. Một bản đề xuất nói "R0" cho việc sửa lương vẫn phải ra R2 và vẫn chờ chủ shop ký —
 * nếu không thì cổng phê duyệt của Phase 1 bị một đường mới đi vòng qua.
 */

const goc = path.resolve(__dirname, "..");
const NGUOI: TechActor = { kind: "HUMAN", id: null, name: "cto-test:chu-shop" };
const MAY: TechActor = { kind: "AI_AGENT", id: null, name: "agent:ai-cto" };

function keHoach(over: Partial<CtoPlan> = {}): CtoPlan {
  return {
    summary: "Chia mục tiêu thành hai việc đọc được và đo được.",
    assumptions: ["Trang vận đơn hiện dùng truy vấn N+1"],
    questions: ["Ngưỡng chậm bao nhiêu mili giây thì coi là đạt?"],
    tasks: [
      {
        key: "T1",
        title: "Đo thời gian từng truy vấn của trang vận đơn",
        description: "Chạy perf-probe trên dữ liệu thật và ghi lại truy vấn chậm nhất.",
        taskType: "PERFORMANCE",
        module: "SHIPMENTS",
        suggestedPriority: "P1",
        suggestedRisk: "R0",
        riskExplanation: "Chỉ đo, không đổi một dòng dữ liệu nào.",
        suggestedAgent: "qa",
        dependsOn: [],
        acceptanceCriteria: ["Có bảng thời gian từng truy vấn, sắp xếp giảm dần"],
        expectedScope: ["scripts/perf-probe.ts"],
        needsHumanDecision: false,
        humanDecisionNote: "",
      },
      {
        key: "T2",
        title: "Gộp truy vấn chậm nhất của trang vận đơn",
        description: "Viết lại truy vấn đã xác định ở T1.",
        taskType: "PERFORMANCE",
        module: "SHIPMENTS",
        suggestedPriority: "P1",
        suggestedRisk: "R0",
        riskExplanation: "Không đổi công thức nào, chỉ đổi cách lấy dữ liệu.",
        suggestedAgent: "backend",
        dependsOn: ["T1"],
        acceptanceCriteria: ["Thời gian dựng trang giảm và số dòng không đổi"],
        expectedScope: ["lib/queries/shipments.ts"],
        needsHumanDecision: false,
        humanDecisionNote: "",
      },
    ],
    ...over,
  } as CtoPlan;
}

export async function testCtoProposal() {
  const db = await getDb();

  /*
    ═══ GIEO HAI VAI CÓ THẬT ═══

    `tech_agents` không được gieo sẵn trong bộ kiểm, mà đường áp kế hoạch tra vai BẰNG KHOÁ. Không
    gieo thì mọi việc rơi vào nhánh "vai không có thật" và phần đang đo biến mất — bài kiểm xanh vì
    một lý do khác hẳn thứ nó định đo.

    `qa` khai `R0/R1` ĐÚNG như mẫu vai thật: hai việc trong bản kế hoạch đều thuộc module SHIPMENTS
    nên MÁY xếp chúng lên R2, và đó là ca "gán được nhưng vai chưa đủ mức" — ca có thật, không dựng.
  */
  await db.insert(schema.techAgents).values([
    { key: "qa", name: "QA", role: "QA", enabled: true, allowedRisks: ["R0", "R1"] },
    { key: "backend", name: "Backend", role: "BACKEND", enabled: true, allowedRisks: ["R0", "R1"] },
    { key: "devops", name: "DevOps", role: "DEVOPS_SRE", enabled: true, allowedRisks: ["R0", "R1"] },
  ]);

  const mucTieu = await createTechTask(
    { title: "Đánh giá và đề xuất cải thiện tốc độ trang vận đơn", description: "Trang mở chậm khi nhiều vận đơn.", taskType: "PERFORMANCE", module: "SHIPMENTS", priority: "P2", source: "OWNER" },
    NGUOI,
  );
  assert.ok("ok" in mucTieu, "tạo được mục tiêu gốc");
  const sourceTaskId = "ok" in mucTieu ? mucTieu.id : "";

  /* ═════════ 1 · AI LẬP KẾ HOẠCH NHƯNG KHÔNG TẠO VIỆC THẬT ═════════ */
  const truoc = (await db.query.techTasks.findMany()).length;
  const p1 = await createProposal({ sourceTaskId, agentId: null, agentKey: "ai-cto", provider: "anthropic", model: "claude-opus-5", plan: keHoach() });
  assert.ok("ok" in p1 && p1.status === "READY_FOR_REVIEW", "bản đề xuất vào thẳng trạng thái CHỜ DUYỆT");
  const idP1 = "ok" in p1 ? p1.id : "";
  assert.equal((await db.query.techTasks.findMany()).length, truoc, "lập kế hoạch KHÔNG được tạo một việc thật nào");
  assert.equal((await db.query.techProposalTasks.findMany({ where: eq(schema.techProposalTasks.proposalId, idP1) })).length, 2, "hai việc đề nghị nằm ở bảng đề xuất");

  /* ═════════ 2 · AI KHÔNG DUYỆT, KHÔNG TỪ CHỐI, KHÔNG ÁP ═════════ */
  const mayDuyet = await approveProposal({ proposalId: idP1 }, MAY);
  assert.ok("error" in mayDuyet, "agent KHÔNG duyệt được kế hoạch của chính nó");
  assert.ok("error" in mayDuyet && mayDuyet.error.includes("con người"), "…và nói rõ cổng này cần một con người");
  const mayTuChoi = await rejectProposal({ proposalId: idP1, reason: "agent tự từ chối cho xong" }, MAY);
  assert.ok("error" in mayTuChoi, "agent cũng KHÔNG từ chối được — cùng một cổng, cửa sau khác");
  assert.equal((await db.query.techTasks.findMany()).length, truoc, "sau hai lượt agent thử, vẫn KHÔNG có việc thật nào");

  /* ═════════ 3 · NGƯỜI DUYỆT ⇒ VIỆC THẬT TẠO QUA DỊCH VỤ ═════════ */
  const duyet = await approveProposal({ proposalId: idP1, note: "Kế hoạch hợp lý" }, NGUOI);
  assert.ok("ok" in duyet, `người phải duyệt được — ${"error" in duyet ? duyet.error : ""}`);
  assert.equal("ok" in duyet ? duyet.created : -1, 2, "đúng hai việc thật được tạo");
  const sau = await db.query.techTasks.findMany();
  assert.equal(sau.length, truoc + 2, "và đúng hai dòng mới trong hàng đợi việc");

  // Phụ thuộc nối bằng khoá THẬT, không phải khoá cục bộ `T1`.
  const rows = await db.query.techProposalTasks.findMany({ where: eq(schema.techProposalTasks.proposalId, idP1), orderBy: (t, { asc }) => [asc(t.seq)] });
  const t1 = sau.find((t) => t.id === rows[0].appliedTaskId);
  const t2 = sau.find((t) => t.id === rows[1].appliedTaskId);
  assert.ok(t1 && t2, "cả hai dòng đề xuất phải nối được tới việc thật");
  assert.deepEqual(t2!.dependsOn, [t1!.id], "T2 phụ thuộc T1 bằng id THẬT — `T1` là khoá cục bộ, không tra được ở đâu khác");
  assert.equal(t1!.parentTaskId, sourceTaskId, "việc con treo dưới đúng mục tiêu gốc");

  /* ═════════ 3b · VAI CTO CHỌN PHẢI ĐI THEO VIỆC ═════════

     ĐÃ ĐO PRODUCTION 22/09/2026: bản kế hoạch của AI CTO có `suggested_agent_key` ở **9/9** việc
     (`architect` · `data` · `frontend` · `data-quality` · `devops` · `qa` · `documentation`), và
     **9/9** việc tạo ra đều `agent_id = NULL`. Lời gọi `createTechTask()` không truyền `agentId`,
     nên cột ấy bị đánh rơi đúng chín lần.

     Hậu quả không phải thẩm mỹ: màn hình `/tech/cto` VẪN hiện cột "vai đề xuất", nên chủ shop đọc
     bản kế hoạch thấy việc đã có người nhận, rồi mở việc ra thì nó vô chủ — và cổng giao việc trả
     "chưa gán agent nào". Câu hỏi *"có AI CTO mà sao vẫn phải tự giao việc"* có đáp án ở đúng đó. */
  /*
    HAI VIỆC NÀY THUỘC MODULE SHIPMENTS ⇒ MÁY xếp lên R2, mà `qa`/`backend` chỉ được cấp R0/R1.

    `assignTechTaskAgent` TỪ CHỐI — và đó đúng là ý định: chú thích của chính nó gọi tên đường đi
    vòng, *"không lách bằng cách giao bừa"*. Truyền `agentId` thẳng vào `createTechTask()` sẽ đi
    vòng qua cả ba hàng rào của nó (vai có thật · vai đang BẬT · vai được cấp đúng mức), nên đường
    áp kế hoạch KHÔNG được làm thế, dù ngắn hơn một dòng.

    Việc để trống, và LÝ DO phải nói ra ngay lúc áp — chứ không để chủ shop phát hiện bằng cách
    bấm cổng giao rồi đọc câu từ chối, lúc ấy họ đã tưởng việc có chủ suốt từ khi duyệt kế hoạch.
  */
  assert.equal(t1!.risk, "R2", "tiền đề: máy xếp việc module SHIPMENTS lên R2");

  /*
    ─── VIỆC SINH RA TỪ BẢN KẾ HOẠCH ĐÃ DUYỆT KHÔNG CÒN LÀ "CHƯA AI PHÂN LOẠI" ───

    `TRIAGED` đọc ra là "đã xác định mức ưu tiên, mức rủi ro và module bị chạm" — việc này có đủ cả
    ba theo cấu trúc, cộng một con người vừa duyệt cả bản. Để ở `NEW` là nói sai về việc, VÀ chặn
    luôn cổng giao (`DISPATCHABLE_STATUSES` không nhận `NEW`).

    Đo 22/09/2026: cả chín việc TECH-4…TECH-12 đều đang `NEW` — nên kể cả khi đã gán vai và đã ký
    duyệt thì chúng vẫn không giao được.
  */
  assert.equal(t1!.status, "TRIAGED", "việc từ kế hoạch đã duyệt phải ở ĐÃ PHÂN LOẠI, không phải MỚI");
  assert.ok(DISPATCHABLE_STATUSES.includes(t1!.status as TechTaskStatus), "…và đó đúng là điều kiện cổng giao việc đòi");
  const vetPl = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, t1!.id) });
  assert.ok(
    vetPl.some((e) => e.nextValue === "TRIAGED"),
    "lượt phân loại phải vào nhật ký việc — không đổi trạng thái lén",
  );
  assert.equal(t1!.agentId, null, "vai chưa được cấp R2 thì KHÔNG gán — hàng rào của `assignTechTaskAgent` giữ nguyên");
  const bcT1 = "ok" in duyet ? duyet.tasks.find((x) => x.key === "T1") : undefined;
  assert.equal(bcT1?.agentKey, "", "không gán được thì không khai là đã gán");
  assert.match(bcT1?.lyDoKhongGan ?? "", /R2/, "…và lý do phải nói rõ vướng ở mức rủi ro nào");

  /* ═════════ 4 · MỨC RỦI RO ĐƯỢC MÁY XẾP LẠI — AI KHÔNG ÉP ĐƯỢC ═════════ */
  //
  // Đây là ca quan trọng nhất của cả bài: một bản đề xuất khai R0 cho việc chạm LƯƠNG. Nếu mức
  // của AI đi thẳng vào `tech_tasks` thì cổng phê duyệt R2 của Phase 1 vừa bị một đường mới đi
  // vòng qua — và không ai thấy, vì trên màn hình việc đó trông như một việc R0 bình thường.
  const mtLuong = await createTechTask({ title: "Mục tiêu: xem lại cách tính lương", description: "Rà soát", taskType: "REFACTOR", module: "PAYROLL", priority: "P2", source: "OWNER" }, NGUOI);
  const idLuong = "ok" in mtLuong ? mtLuong.id : "";
  const pLuong = await createProposal({
    sourceTaskId: idLuong,
    agentId: null,
    agentKey: "ai-cto",
    provider: "anthropic",
    model: "claude-opus-5",
    plan: keHoach({
      tasks: [
        {
          key: "T1",
          title: "Sửa công thức lương cứng theo kỳ",
          description: "Đổi cách chia lương cứng theo số ngày chồng lấn trong kỳ trả.",
          taskType: "REFACTOR",
          module: "PAYROLL",
          suggestedPriority: "P1",
          // AI nói R0 — và nó SAI. Máy phải sửa lại.
          suggestedRisk: "R0",
          riskExplanation: "Tôi nghĩ chỉ là đổi cách chia, không đổi số.",
          suggestedAgent: "backend",
          dependsOn: [],
          acceptanceCriteria: ["Lương kỳ cũ không đổi một đồng"],
          expectedScope: ["lib/queries/payroll-cost.ts"],
          needsHumanDecision: true,
          humanDecisionNote: "Chạm tiền của người thật",
        },
      ],
    }),
  });
  const idPL = "ok" in pLuong ? pLuong.id : "";
  const duyetLuong = await approveProposal({ proposalId: idPL }, NGUOI);
  assert.ok("ok" in duyetLuong, "duyệt được");
  const apLuong = "ok" in duyetLuong ? duyetLuong.tasks[0] : null;
  assert.ok(apLuong, "có việc được tạo");
  assert.equal(apLuong!.suggestedRisk, "R0", "AI đã nói R0…");
  assert.equal(apLuong!.appliedRisk, "R2", "…nhưng MÁY xếp R2, và mức của máy là mức đi vào việc thật");
  assert.equal(apLuong!.riskChanged, true, "và chênh lệch đó phải hiện ra, không im lặng");
  const viecLuong = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, apLuong!.taskId) });
  assert.equal(viecLuong?.risk, "R2");
  assert.equal(viecLuong?.approvalRequired, true, "R2 ⇒ vẫn phải có chủ shop ký, y như mọi việc R2 khác");
  assert.equal(viecLuong?.approvalStatus, "PENDING", "…và nó đang CHỜ ký, không phải đã ký sẵn");

  /*
    ─── VAI HỢP LỆ VỚI LƯỢC ĐỒ NHƯNG KHÔNG CÓ TRONG SỔ `tech_agents` ───

    Hai danh sách khác nhau: lược đồ kế hoạch duyệt khoá theo `TECH_AGENT_TEMPLATES` (hằng số trong
    mã), còn việc thật gán theo DÒNG trong bảng `tech_agents`. Một khoá qua được lược đồ vẫn có thể
    không có dòng nào — vai bị xoá, hoặc một bản triển khai chưa gieo đủ.

    Khi đó: để TRỐNG và nói ra. Tuyệt đối KHÔNG dò một vai "gần giống" — gán việc cho nhầm người là
    đúng thứ AGENTS.md mục 35 cấm, và một khoá trỏ hụt của AI không phải bằng chứng về ý định của nó.
  */
  const pThieuVai = await createProposal({
    sourceTaskId,
    agentId: null,
    agentKey: "ai-cto",
    provider: "anthropic",
    model: "claude-opus-5",
    plan: keHoach({
      tasks: [
        {
          key: "TV",
          title: "Ghi lại kết quả đo vào tài liệu bàn giao",
          description: "Chép bảng thời gian truy vấn vào docs.",
          taskType: "DOCS",
          module: "PLATFORM",
          suggestedPriority: "P2",
          suggestedRisk: "R0",
          riskExplanation: "Chỉ viết chữ.",
          // Vai có trong mẫu nhưng KHÔNG có dòng nào trong `tech_agents` của bộ kiểm.
          suggestedAgent: "devops",
          dependsOn: [],
          acceptanceCriteria: ["Tài liệu có bảng số"],
          expectedScope: ["docs/perf/"],
          needsHumanDecision: false,
          humanDecisionNote: "",
        },
        {
          key: "TH",
          title: "Ghi chú vận hành cho lượt đo tiếp theo",
          description: "Chép các bước đã chạy vào docs.",
          taskType: "DOCS",
          module: "PLATFORM",
          suggestedPriority: "P3",
          suggestedRisk: "R0",
          riskExplanation: "Chỉ viết chữ.",
          // Vai CÓ trong `TECH_AGENT_TEMPLATES` (nên qua được lược đồ) nhưng KHÔNG có dòng nào
          // trong `tech_agents` của bộ kiểm — đúng ca khoá trỏ hụt.
          suggestedAgent: "incident",
          dependsOn: [],
          acceptanceCriteria: ["Có ghi chú"],
          expectedScope: ["docs/perf/"],
          needsHumanDecision: false,
          humanDecisionNote: "",
        },
      ],
    }),
  });
  const duyetThieu = await approveProposal({ proposalId: "ok" in pThieuVai ? pThieuVai.id : "" }, NGUOI);
  assert.ok("ok" in duyetThieu, "vẫn duyệt được — một vai trỏ hụt không được làm hỏng cả lượt áp");
  const apTV = "ok" in duyetThieu ? duyetThieu.tasks.find((x) => x.key === "TV") : null;
  const apTH = "ok" in duyetThieu ? duyetThieu.tasks.find((x) => x.key === "TH") : null;

  /* ─── CA GÁN ĐƯỢC: vai có thật, đang bật, và được cấp đúng mức máy xếp ─── */
  const viecTV = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, apTV!.taskId), with: { agent: { columns: { key: true } } } });
  assert.equal(viecTV?.risk, "R1", "tiền đề: DOCS + PLATFORM ⇒ máy xếp R1");
  assert.equal(viecTV?.agent?.key, "devops", "vai CTO chọn PHẢI đi theo việc — đây chính là 9/9 lần bị đánh rơi trên production");
  assert.equal(apTV?.agentKey, "devops", "và kết quả áp nói ra đã gán ai");
  assert.equal(apTV?.lyDoKhongGan, "", "gán xong thì không có lý do gì để nêu");

  /*
    Lượt gán phải để lại VẾT: một sự kiện `ASSIGN` trong nhật ký việc. Ghi thẳng cột `agent_id`
    thì cột đổi mà không ai trả lời được "ai giao việc này cho vai đó".
  */
  const vet = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, apTV!.taskId) });
  assert.ok(
    vet.some((e) => e.kind === "ASSIGN" && e.nextValue === "devops"),
    "lượt gán theo kế hoạch phải vào nhật ký việc, không ghi lén thẳng cột",
  );

  /* ─── CA KHOÁ TRỎ HỤT: để TRỐNG và nói ra ─── */
  assert.equal(apTH?.agentKey, "", "không gán được ai");
  assert.match(apTH?.lyDoKhongGan ?? "", /incident/, "…và phải NÓI RA khoá vai nào trỏ hụt, không im lặng");
  const viecTH = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, apTH!.taskId) });
  assert.equal(viecTH?.agentId, null, "việc để TRỐNG — KHÔNG dò một vai gần giống (mục 35)");

  /*
    ═══ LƯỢT ÁP LẠI BẮT KỊP PHẦN CÒN THIẾU — VÀ KHÔNG BAO GIỜ ĐÈ LÊN NGƯỜI ═══

    Chín việc TECH-4…TECH-12 trên production đã được tạo TRƯỚC bản vá này, nên nhánh idempotent bỏ
    qua chúng mãi mãi. Chỉ vá đường tạo mới thì bản vá cứu kế hoạch TƯƠNG LAI còn chín việc đang
    nằm trên bảng thì vô chủ vĩnh viễn — sửa xong mà hôm nay không ai dùng được gì.

    Nhưng bắt kịp KHÔNG được biến thành đè: nếu người đã gán tay một vai khác ý CTO, lượt áp lại
    phải im lặng đi qua. Lựa chọn của người thắng, luôn luôn.
  */
  assert.equal(viecTH?.agentId, null, "tiền đề: việc TH đang vô chủ");
  await db.insert(schema.techAgents).values({ key: "incident", name: "Sự cố", role: "INCIDENT", enabled: true, allowedRisks: ["R0", "R1"] });

  /* Người gán TAY một vai KHÁC với ý CTO cho việc TV (CTO chọn `devops`). */
  const vaiIn = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.key, "incident") });
  await assignTechTaskAgent({ taskId: apTV!.taskId, agentId: vaiIn!.id, note: "chủ shop đổi ý" }, NGUOI);

  const apLai = await approveProposal({ proposalId: "ok" in pThieuVai ? pThieuVai.id : "" }, NGUOI);
  assert.ok("ok" in apLai, "áp lại được");
  assert.equal("ok" in apLai ? apLai.created : -1, 0, "không tạo lại việc nào — phép idempotent giữ nguyên");

  const buTH = "ok" in apLai ? apLai.ganBu.find((x) => x.code === viecTH!.code) : null;
  assert.equal(buTH?.agentKey, "incident", "việc đang vô chủ nay gán được vì vai đã có trong sổ");
  const viecTHSau = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, apTH!.taskId), with: { agent: { columns: { key: true } } } });
  assert.equal(viecTHSau?.agent?.key, "incident", "…và việc thật đã có chủ");

  const buTV = "ok" in apLai ? apLai.ganBu.find((x) => x.code === viecTV!.code) : null;
  assert.equal(buTV, undefined, "việc ĐÃ CÓ CHỦ không được đụng tới — máy không cãi người, kể cả khi người chọn khác ý CTO");
  const viecTVSau = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, apTV!.taskId), with: { agent: { columns: { key: true } } } });
  assert.equal(viecTVSau?.agent?.key, "incident", "vai NGƯỜI gán tay vẫn còn nguyên, KHÔNG bị kéo về ý CTO");

  /* ═════════ 5 · DUYỆT HAI LẦN KHÔNG TẠO HAI BỘ VIỆC ═════════ */
  const soViec = (await db.query.techTasks.findMany()).length;
  const lai = await approveProposal({ proposalId: idP1, note: "bấm nhầm lần nữa" }, NGUOI);
  assert.ok("ok" in lai, "bấm lại không được báo lỗi — lượt áp có thể hỏng giữa chừng và cần chạy lại");
  assert.equal("ok" in lai ? lai.created : -1, 0, "…nhưng KHÔNG tạo thêm việc nào");
  assert.equal("ok" in lai ? lai.skipped : -1, 2, "hai dòng đã có khoá việc thật thì bỏ qua");
  assert.equal((await db.query.techTasks.findMany()).length, soViec, "tổng số việc không đổi");

  /* ═════════ 6 · BẢN ĐÃ TỪ CHỐI / ĐÃ BỊ THAY THẾ KHÔNG ÁP ĐƯỢC ═════════ */
  const p2 = await createProposal({ sourceTaskId, agentId: null, agentKey: "ai-cto", provider: "anthropic", model: "claude-opus-5", plan: keHoach() });
  const idP2 = "ok" in p2 ? p2.id : "";
  const tuChoiNgan = await rejectProposal({ proposalId: idP2, reason: "không" }, NGUOI);
  assert.ok("error" in tuChoiNgan, "từ chối mà không nói vì sao thì bị chặn");
  assert.ok("ok" in (await rejectProposal({ proposalId: idP2, reason: "Kế hoạch bỏ sót phần đo trước khi sửa" }, NGUOI)), "nói đủ thì từ chối được");
  const apTuChoi = await approveProposal({ proposalId: idP2 }, NGUOI);
  assert.ok("error" in apTuChoi, "bản ĐÃ TỪ CHỐI không áp được");

  const p3 = await createProposal({ sourceTaskId, agentId: null, agentKey: "ai-cto", provider: "anthropic", model: "claude-opus-5", plan: keHoach() });
  const idP3 = "ok" in p3 ? p3.id : "";
  const p4 = await createProposal({ sourceTaskId, agentId: null, agentKey: "ai-cto", provider: "anthropic", model: "claude-opus-5", plan: keHoach() });
  const idP4 = "ok" in p4 ? p4.id : "";
  const soThay = await supersedeOpenProposals(sourceTaskId, idP4);
  assert.ok(soThay >= 1, "lập lại kế hoạch thì bản chờ duyệt cũ bị đánh dấu ĐÃ BỊ THAY THẾ");
  const apThay = await approveProposal({ proposalId: idP3 }, NGUOI);
  assert.ok("error" in apThay, "bản ĐÃ BỊ THAY THẾ không áp được — không ai lỡ tay duyệt một kế hoạch lỗi thời");
  // …nhưng KHÔNG bị xoá: còn đọc được để so hai lần AI nghĩ khác nhau chỗ nào.
  assert.ok(await db.query.techProposals.findFirst({ where: eq(schema.techProposals.id, idP3) }), "bản cũ vẫn còn trong sổ");

  /* ═════════ 7 · JSON HỎNG / VAI LẠ BỊ TỪ CHỐI, KHÔNG ĐOÁN ═════════ */
  assert.equal(parseCtoPlan("không phải json").ok, false, "văn xuôi không phải kế hoạch");
  assert.equal(parseCtoPlan('{"summary":"thiếu tasks","tasks":[]}').ok, false, "kế hoạch không việc nào là kế hoạch rỗng");
  const vaiLa = parseCtoPlan(
    JSON.stringify({ summary: "x".repeat(20), tasks: [{ ...keHoach().tasks[0], suggestedAgent: "SUPER_ENGINEER" }] }),
  );
  assert.equal(vaiLa.ok, false, "vai agent không có thật ⇒ cả bản kế hoạch bị từ chối");
  assert.ok(!vaiLa.ok && vaiLa.error.includes("vai agent"), "…và nói rõ vì sao");
  const moduleLa = parseCtoPlan(JSON.stringify({ summary: "x".repeat(20), tasks: [{ ...keHoach().tasks[0], module: "KHONG_CO_THAT" }] }));
  assert.equal(moduleLa.ok, false, "module không có thật cũng bị từ chối");
  // Hàng rào markdown là phép BỎ VỎ xác định được — chấp nhận. Mọi thứ khác là đoán.
  assert.equal(parseCtoPlan("```json\n" + JSON.stringify({ ...keHoach(), tasks: keHoach().tasks }) + "\n```").ok, true, "khối ```json``` bọc ngoài vẫn đọc được");

  /* ═════════ 8 · PHỤ THUỘC VÒNG / TRỎ VÀO HƯ VÔ BỊ TỪ CHỐI ═════════ */
  const vong = parseCtoPlan(
    JSON.stringify({
      summary: "x".repeat(20),
      tasks: [
        { ...keHoach().tasks[0], key: "A", dependsOn: ["B"] },
        { ...keHoach().tasks[1], key: "B", dependsOn: ["A"] },
      ],
    }),
  );
  assert.equal(vong.ok, false, "phụ thuộc thành vòng ⇒ kế hoạch không bao giờ bắt đầu được");
  assert.ok(!vong.ok && vong.error.includes("vòng"), "…và nói đúng tên vấn đề");
  const treo = parseCtoPlan(JSON.stringify({ summary: "x".repeat(20), tasks: [{ ...keHoach().tasks[0], dependsOn: ["KHONG_CO"] }] }));
  assert.equal(treo.ok, false, "phụ thuộc trỏ vào việc không tồn tại cũng bị từ chối");

  /* ═════════ 9 · LƯỢT LẬP KẾ HOẠCH HỎNG VẪN ĐỂ LẠI DẤU ═════════ */
  const hong = await createProposal({ sourceTaskId, agentId: null, agentKey: "ai-cto", provider: "anthropic", model: "claude-opus-5", plan: null, error: "Bản kế hoạch không hợp lệ — tasks: rỗng" });
  assert.ok("ok" in hong && hong.status === "DRAFT", "bản hỏng nằm ở NHÁP, không phải CHỜ DUYỆT");
  const apHong = await approveProposal({ proposalId: "ok" in hong ? hong.id : "" }, NGUOI);
  assert.ok("error" in apHong, "bản NHÁP không áp được");

  /* ═════════ 10 · PROMPT KHÔNG BAO GIỜ MANG BÍ MẬT ═════════ */
  assert.equal(promptCoSecretKhong("Mục tiêu: sửa trang vận đơn"), null, "prompt bình thường thì sạch");
  assert.equal(promptCoSecretKhong("dùng ANTHROPIC_API_KEY để gọi"), "ANTHROPIC_API_KEY", "tên biến bí mật bị bắt");
  assert.equal(promptCoSecretKhong("DATABASE_URL=postgres://..."), "DATABASE_URL", "…kể cả khi nằm giữa câu");
  const giu = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "mat-khau-that-12345";
  assert.ok((promptCoSecretKhong("ai đó dán mat-khau-that-12345 vào đây") ?? "").includes("ADMIN_PASSWORD"), "GIÁ TRỊ của khoá đang đặt cũng bị bắt, không chỉ tên biến");
  if (giu === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = giu;

  /* ═════════ 11 · QUÉT MÃ NGUỒN: KHÔNG ĐƯỜNG GHI THỨ HAI ═════════ */
  const doc = (p: string) => readFileSync(path.join(goc, p), "utf8");
  /*
    QUÉT MÃ, KHÔNG QUÉT VĂN XUÔI.

    Chú thích trong `proposal.ts` nhắc `riskOverride` để nói rõ vì sao nó KHÔNG được truyền, và một
    bộ dò theo chuỗi thô sẽ bắt nhầm đúng câu giải thích ấy. Bỏ chú thích trước rồi mới dò — nếu
    không, lá chắn này sẽ dạy người ta viết chú thích né nó.
  */
  const boChuThich = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join("\n");
  const dv = boChuThich(doc("lib/tech/proposal.ts"));
  assert.ok(!/riskOverride/.test(dv), "đường áp KHÔNG được truyền riskOverride — đó là cách ép mức rủi ro đi vòng qua máy");
  assert.ok(dv.includes("createTechTask("), "…và phải tạo việc qua ĐÚNG hàm dịch vụ, không INSERT tay");
  assert.ok(!/insert\(schema\.techTasks\)/.test(dv), "KHÔNG được INSERT thẳng vào tech_tasks");
  for (const ham of ["approveProposal", "rejectProposal"]) {
    const i = dv.indexOf(`export async function ${ham}`);
    assert.ok(i > 0, `${ham} phải tồn tại`);
    assert.ok(dv.slice(i, i + 400).includes('actor.kind !== "HUMAN"'), `${ham} phải chặn actor không phải người NGAY dòng đầu`);
  }

  /* ═════════ 12 · GIAO DIỆN KHÔNG CÓ NÚT "CHẠY TẤT CẢ" ═════════ */
  const trang = boChuThich(doc("app/(dashboard)/tech/cto/page.tsx") + doc("app/(dashboard)/tech/cto/cto-controls.tsx"));
  for (const cam of ["Auto execute", "auto-execute", "Chạy tất cả", "Áp tất cả", "autoApply"]) {
    assert.ok(!trang.includes(cam), `giao diện KHÔNG được có “${cam}” — mỗi kế hoạch phải có một con người đọc rồi bấm`);
  }
  assert.ok(trang.includes("Phê duyệt kế hoạch"), "…nhưng phải có nút duyệt tường minh");

  /* ═════════ 13 · CHƯA MỞ AGENT VIẾT MÃ NÀO ═════════ */
  //
  // Phase 2B mở AI CTO ở chế độ đề xuất, KHÔNG mở agent thực thi. Bài này đọc bản khai trong mã
  // nguồn: vai CTO không được phép viết mã, và không vai nào được merge hay deploy.
  const { TECH_AGENT_TEMPLATES } = await import("@/lib/constants/tech");
  const cto = TECH_AGENT_TEMPLATES.find((t) => t.key === "ai-cto");
  assert.ok(cto, "phải có vai ai-cto trong bản khai");
  assert.equal(cto!.canCode, false, "AI CTO KHÔNG viết mã — nó lập kế hoạch");
  assert.equal(cto!.canMerge, false);
  assert.equal(cto!.canDeploy, false);
  assert.equal(cto!.canRunProdWrite, false);
  for (const t of TECH_AGENT_TEMPLATES) {
    assert.equal(t.canMerge, false, `${t.key}: KHÔNG vai nào merge được`);
    assert.equal(t.canDeploy, false, `${t.key}: KHÔNG vai nào deploy được`);
    assert.equal(t.canRunProdWrite, false, `${t.key}: KHÔNG vai nào ghi production được`);
  }
  // …và trong CSDL, mọi vai sinh ra đều TẮT (kiểm ở tests/tech-phase2a.test.ts). Ở đây chỉ khẳng
  // định không có đường nào trong mã tự bật một vai.
  const quetLib = (dir: string, acc: string[] = []): string[] => {
    const full = path.join(goc, dir);
    if (!existsSync(full)) return acc;
    for (const e of readdirSync(full)) {
      const con = path.join(dir, e);
      if (statSync(path.join(goc, con)).isDirectory()) quetLib(con, acc);
      else if (e.endsWith(".ts")) acc.push(con);
    }
    return acc;
  };
  //
  // Quét ĐƯỜNG CHẠY CỦA AGENT, không quét nơi ĐỊNH NGHĨA: `setTechAgentEnabled` sống ở
  // `lib/tech/service.ts` và phải sống ở đó — người bấm nút trên `/tech/agents` gọi đúng hàm ấy.
  // Điều cần khẳng định là KHÔNG mã nào của agent gọi nó, tức là không agent nào tự bật chính nó
  // hay bật một vai khác.
  const tuBat = quetLib("lib/agents").filter((f) => /setTechAgentEnabled\s*\(/.test(boChuThich(doc(f))));
  assert.deepEqual(tuBat, [], `KHÔNG tệp nào trong lib/agents được gọi setTechAgentEnabled — agent không tự bật vai:\n${tuBat.join("\n")}`);
  // …và đường áp kế hoạch cũng không, dù nó nằm ngoài lib/agents.
  assert.ok(!/setTechAgentEnabled\s*\(/.test(dv), "đường áp kế hoạch KHÔNG được bật vai nào");

  /* ───── 14. CÂU TRẢ LỜI BỊ CẮT KHÔNG ĐƯỢC IN RA THÀNH "JSON HỎNG" ─────

     Đo thật (lượt chạy 35428943458, 19/09/2026): trần 8.000 token cắt bản kế hoạch giữa một
     chuỗi, và màn hình in "Không đọc được JSON: Unterminated string at position 15355". Câu đó
     sai chỗ: nó gửi người sửa đi soi lược đồ và prompt, trong khi thứ hỏng là cái trần của chính
     ta. Hai nguyên nhân, hai câu chữ — cùng một luật với mục 55 của AGENTS.md. */
  const giaProvider = (res: Partial<AiResponse> & { content: AiResponse["content"] }): AiProvider => ({
    name: "gia",
    model: "gia-model",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "gia-model",
        latencyMs: 1,
        ...res,
      };
    },
  });
  const ctxGia = { prompt: "mục tiêu thử", blocked: null } as Awaited<ReturnType<typeof import("@/lib/agents/cto").buildCtoPrompt>> & object;

  const bicat = await runCtoPlanning(
    giaProvider({ content: [{ type: "text", text: '{"summary":"một bản kế hoạch dài bị cắt giữa chừng' }], stopReason: "max_tokens" }),
    ctxGia as never,
  );
  assert.equal(bicat.ok, false, "chạm trần token phải là lượt KHÔNG đạt");
  assert.ok(!bicat.ok && /bị cắt/.test(bicat.error), `phải nói rõ câu trả lời bị CẮT, nhận: ${!bicat.ok ? bicat.error : ""}`);
  assert.ok(!bicat.ok && !/JSON/i.test(bicat.error), "KHÔNG được đổ lỗi cho định dạng JSON khi chính ta cắt câu trả lời");
  assert.ok(!bicat.ok && bicat.error.includes(CTO_MAX_OUTPUT_TOKENS.toLocaleString("vi-VN")), "phải in ra cái trần đang chạm");

  // …còn JSON hỏng THẬT (model nói xong hẳn rồi) vẫn phải là lỗi định dạng, không bị gộp vào nhánh trên.
  const saiDinhDang = await runCtoPlanning(giaProvider({ content: [{ type: "text", text: "không phải JSON" }], stopReason: "end_turn" }), ctxGia as never);
  assert.ok(!saiDinhDang.ok && /JSON/i.test(saiDinhDang.error), "model nói hết câu mà sai định dạng thì vẫn là lỗi đọc JSON");

  // Model từ chối vì chính sách là tình huống thứ ba, cũng không phải lỗi định dạng.
  const tuchoi = await runCtoPlanning(giaProvider({ content: [{ type: "text", text: "" }], stopReason: "refusal" }), ctxGia as never);
  assert.ok(!tuchoi.ok && /từ chối/.test(tuchoi.error), "model từ chối phải được gọi đúng tên");

  /* ───── 14b. QUÁ TẢI CỦA NHÀ CUNG CẤP KHÔNG ĐƯỢC ĐỘI LỐT LỖI MÃ NGUỒN ─────

     Đo thật: hai lượt liên tiếp (35429768726 · 35429814259) chết trong 2 và 5 giây vì
     `overloaded_error`, và màn hình in nguyên phong bì JSON. Người đọc không có cách nào biết
     mình phải sửa mã, thay khoá, hay chỉ cần chạy lại — ba việc khác hẳn nhau. */
  const neVang = (mess: string, status?: number): AiProvider => ({
    name: "gia",
    model: "gia-model",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      throw Object.assign(new Error(mess), status === undefined ? {} : { status });
    },
  });

  const quaTai = await runCtoPlanning(neVang('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), ctxGia as never);
  assert.ok(!quaTai.ok && /QUÁ TẢI/.test(quaTai.error), "quá tải phải được gọi đúng tên");
  assert.ok(!quaTai.ok && /chạy lại/.test(quaTai.error), "…kèm việc phải làm: chạy lại");
  assert.ok(!quaTai.ok && /overloaded_error/.test(quaTai.error), "…và vẫn giữ nguyên văn để còn tra được");

  const saiKhoa = await runCtoPlanning(neVang("authentication_error: invalid x-api-key", 401), ctxGia as never);
  assert.ok(!saiKhoa.ok && /Khoá API/.test(saiKhoa.error), "khoá bị từ chối là một câu khác hẳn quá tải");

  const hetTien = await runCtoPlanning(neVang("Your credit balance is too low", 400), ctxGia as never);
  assert.ok(!hetTien.ok && /tín dụng|hạn mức/.test(hetTien.error), "hết tín dụng là một câu khác nữa");
  assert.ok(!hetTien.ok && !/QUÁ TẢI/.test(hetTien.error), "…và KHÔNG bị gộp vào nhánh quá tải");

  /* Bậc `analysis` phải kiên nhẫn hơn bậc có người ngồi đợi — nếu không, một cơn quá tải vài giây
     lại tiêu trọn một lượt CI như hai lần đã đo. */
  assert.ok(
    RETRIES_BY_TIER.analysis > RETRIES_BY_TIER.copilot,
    `bậc analysis (${RETRIES_BY_TIER.analysis} lần) phải thử lại nhiều hơn bậc copilot (${RETRIES_BY_TIER.copilot} lần) — chạy nền thì không ai đợi`,
  );

  /* ───── 16. MỘT LƯỢT SỬA CÓ KIỂM SOÁT ─────

     Đo thật (production, 19/09/2026): model trả 13 việc cho hợp đồng tối đa 12, và bản đề xuất bị
     từ chối. Từ chối là ĐÚNG. Cái sai là dừng ở đó: model là bên duy nhất biết việc nào gộp được
     với việc nào, nên đưa lỗi lại cho chính nó rẻ hơn hẳn bắt người mở lại màn hình bấm lần nữa.

     Ba thứ bài kiểm này khoá, và cả ba đều là chỗ dễ trượt:
       · sửa ĐÚNG MỘT lần — không phải vòng lặp;
       · lượt sửa đi qua CÙNG `parseCtoPlan`, không có bộ đọc lỏng tay cho lần hai;
       · KHÔNG sửa khi model chưa hề trả lời (429/529/401/hết giờ/từ chối/chạm trần). */
  const keHoachJson = (n: number) => {
    const k = keHoach();
    const tasks = Array.from({ length: n }, (_, i) => ({
      ...k.tasks[0],
      key: `T${i + 1}`,
      dependsOn: i === 0 ? [] : [`T${i}`],
    }));
    return JSON.stringify({ ...k, tasks });
  };

  /** Provider giả trả lời KHÁC NHAU theo từng lượt, và ĐẾM số lượt đã gọi. */
  const providerTheoLuot = (...luots: string[]) => {
    const daGoi: string[] = [];
    const p: AiProvider = {
      name: "gia",
      model: "gia-model",
      schemaDialect: "anthropic",
      async complete(req): Promise<AiResponse> {
        const i = daGoi.length;
        daGoi.push(req.messages.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("")).join(""));
        return {
          content: [{ type: "text", text: luots[Math.min(i, luots.length - 1)] }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: "gia-model",
          latencyMs: 1,
        };
      },
    };
    return { provider: p, daGoi };
  };

  /* A. 13 việc → sửa còn 10 → ĐẠT */
  {
    const { provider, daGoi } = providerTheoLuot(keHoachJson(13), keHoachJson(10));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.ok(r.ok, `A: lượt sửa phải cứu được bản kế hoạch, nhận: ${r.ok ? "" : r.error}`);
    assert.equal(daGoi.length, 2, "A: đúng HAI lượt gọi model — một đầu, một sửa");
    assert.equal(r.modelCalls, 2);
    assert.equal(r.repairOutcome, "PASS");
    assert.ok(/Too big|12/.test(r.initialError), `A: phải giữ lỗi BAN ĐẦU để đọc lại, nhận: ${r.initialError}`);
    assert.ok(r.ok && r.plan.tasks.length === 10, "A: lấy bản ĐÃ SỬA, không phải bản 13 việc");
    // Prompt sửa phải mang theo lỗi thật và bản cũ — không phải một lời xin làm lại chung chung.
    assert.ok(/LỖI KIỂM TRA/.test(daGoi[1]), "A: prompt sửa phải nêu lỗi kiểm tra");
    assert.ok(/BẢN JSON TRƯỚC/.test(daGoi[1]), "A: prompt sửa phải đính kèm bản model vừa viết");
    assert.ok(/GỘP/.test(daGoi[1]), "A: prompt sửa phải bảo GỘP, không bảo xoá bớt");
  }

  /* B. 13 việc → sửa vẫn 13 → KHÔNG ĐẠT, và KHÔNG có lượt thứ ba */
  {
    const { provider, daGoi } = providerTheoLuot(keHoachJson(13), keHoachJson(13));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.equal(r.ok, false, "B: sửa rồi vẫn sai thì vẫn phải hỏng");
    assert.equal(daGoi.length, 2, "B: TRẦN là hai lượt — không có lượt thứ ba, dù lượt hai vẫn sai");
    assert.equal(r.modelCalls, 2);
    assert.equal(r.repairOutcome, "FAIL");
    assert.ok(!r.ok && /Lỗi ban đầu/.test(r.error), "B: câu lỗi cuối phải nhắc cả lỗi ban đầu");
  }

  /* C. JSON hỏng → sửa ra JSON hợp lệ → ĐẠT */
  {
    const { provider, daGoi } = providerTheoLuot("{ đây không phải JSON", keHoachJson(3));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.ok(r.ok, "C: JSON hỏng cũng là đầu ra không đạt hợp đồng — sửa được");
    assert.equal(daGoi.length, 2);
    assert.equal(r.repairOutcome, "PASS");
  }

  /* D. vai agent không có thật → sửa sang vai có thật → ĐẠT */
  {
    const lac = JSON.parse(keHoachJson(2));
    lac.tasks[0].suggestedAgent = "SUPER_ENGINEER";
    const { provider, daGoi } = providerTheoLuot(JSON.stringify(lac), keHoachJson(2));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.ok(r.ok, "D: vai lạ phải sửa được");
    assert.equal(daGoi.length, 2);
    assert.equal(r.repairOutcome, "PASS");
    assert.ok(/suggestedAgent|SUPER_ENGINEER|Invalid/i.test(r.initialError), `D: lỗi ban đầu phải chỉ đúng chỗ, nhận: ${r.initialError}`);
  }

  /* E. dependsOn trỏ khoá không tồn tại → sửa → ĐẠT */
  {
    const treo = JSON.parse(keHoachJson(2));
    treo.tasks[1].dependsOn = ["T99"];
    const { provider, daGoi } = providerTheoLuot(JSON.stringify(treo), keHoachJson(2));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.ok(r.ok, "E: phụ thuộc treo phải sửa được");
    assert.equal(daGoi.length, 2);
    assert.equal(r.repairOutcome, "PASS");
    assert.ok(/T99|dependsOn|phụ thuộc/i.test(r.initialError), `E: lỗi ban đầu phải nêu khoá treo, nhận: ${r.initialError}`);
  }

  /*
    F + G. Nhà cung cấp 429 / 529 → TUYỆT ĐỐI KHÔNG SỬA.

    Không có câu trả lời nào để mà sửa, nên lượt thứ hai chỉ là nhân đôi một lượt hỏng — và với
    429 thì còn là đổ thêm request vào đúng cái đang bị giới hạn.
  */
  for (const [ten, mess, status] of [
    ["F/429", "rate_limit_error: Number of requests has exceeded your rate limit", 429],
    ["G/529", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529],
    ["401", "authentication_error: invalid x-api-key", 401],
  ] as [string, string, number][]) {
    let soLan = 0;
    const p: AiProvider = {
      name: "gia",
      model: "gia-model",
      schemaDialect: "anthropic",
      async complete(): Promise<AiResponse> {
        soLan += 1;
        throw Object.assign(new Error(mess), { status });
      },
    };
    const r = await runCtoPlanning(p, ctxGia as never);
    assert.equal(r.ok, false, `${ten}: phải hỏng`);
    assert.equal(soLan, 1, `${ten}: CHỈ MỘT lượt gọi — không sửa khi model chưa hề trả lời`);
    assert.equal(r.repairOutcome, "NONE", `${ten}: không có lượt sửa nào để ghi`);
    assert.equal(r.modelCalls, 1);
  }

  /* Hết giờ · model từ chối · chạm trần token — cùng một luật: không có gì để sửa. */
  {
    let soLan = 0;
    const p: AiProvider = {
      name: "gia",
      model: "gia-model",
      schemaDialect: "anthropic",
      async complete(): Promise<AiResponse> {
        soLan += 1;
        return {
          content: [{ type: "text", text: '{"summary":"bị cắt giữa chừng' }],
          stopReason: "max_tokens",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: "gia-model",
          latencyMs: 1,
        };
      },
    };
    const r = await runCtoPlanning(p, ctxGia as never);
    assert.equal(r.ok, false);
    assert.equal(soLan, 1, "chạm trần token: KHÔNG sửa — chỗ hỏng là cái trần của ta, bảo model viết lại thì nó lại bị cắt y như vậy");
    assert.equal(r.repairOutcome, "NONE");
  }
  {
    let soLan = 0;
    const p: AiProvider = {
      name: "gia",
      model: "gia-model",
      schemaDialect: "anthropic",
      async complete(): Promise<AiResponse> {
        soLan += 1;
        return {
          content: [{ type: "text", text: "" }],
          stopReason: "refusal",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: "gia-model",
          latencyMs: 1,
        };
      },
    };
    const r = await runCtoPlanning(p, ctxGia as never);
    assert.equal(r.ok, false);
    assert.equal(soLan, 1, "model từ chối: KHÔNG sửa — hỏi lại một câu đã bị từ chối là hỏi lại cùng một câu");
    assert.equal(r.repairOutcome, "NONE");
  }

  /* H. Đạt ngay lượt đầu → ĐÚNG MỘT lượt gọi, không có lượt sửa thừa */
  {
    const { provider, daGoi } = providerTheoLuot(keHoachJson(4));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.ok(r.ok, "H: bản hợp lệ phải đạt ngay");
    assert.equal(daGoi.length, 1, "H: đạt rồi thì KHÔNG gọi thêm lượt nào — mỗi lượt thừa là tiền thật");
    assert.equal(r.modelCalls, 1);
    assert.equal(r.repairOutcome, "NONE");
    assert.equal(r.initialError, "");
  }

  /* I. Lượt sửa KHÔNG được tạo việc thật — ghi bằng chứng vào sổ đề xuất, không vào hàng đợi. */
  {
    const truoc = (await db.select().from(schema.techTasks)).length;
    const { provider } = providerTheoLuot(keHoachJson(13), keHoachJson(5));
    const r = await runCtoPlanning(provider, ctxGia as never);
    assert.ok(r.ok && r.repairOutcome === "PASS");
    const ghi = await createProposal({
      sourceTaskId: mucTieu.id,
      agentId: null,
      agentKey: "ai-cto",
      provider: r.provider,
      model: r.model,
      plan: r.ok ? r.plan : null,
      rawOutput: r.raw,
      modelCalls: r.modelCalls,
      initialError: r.initialError,
      repairOutcome: r.repairOutcome,
    });
    assert.ok("ok" in ghi, "I: phải ghi được bản đề xuất");
    const sau = (await db.select().from(schema.techTasks)).length;
    assert.equal(sau, truoc, "I: lượt sửa KHÔNG được đẻ ra một việc thật nào");
    const dong = await db.query.techProposals.findFirst({ where: eq(schema.techProposals.id, "ok" in ghi ? ghi.id : "") });
    assert.equal(dong?.modelCalls, 2, "I: số lượt gọi phải đọc lại được từ CSDL");
    assert.equal(dong?.repairOutcome, "PASS");
    assert.ok((dong?.initialError ?? "").length > 0, "I: lỗi ban đầu phải còn đọc được sau khi ghi");
    /*
      "Chưa áp" ở đây là HAI điều, vì sổ đề xuất giữ chúng ở hai chỗ: bản đề xuất chưa ai QUYẾT
      (`decided_at`), và không dòng việc con nào đã nối tới một việc thật (`applied_task_id`).
    */
    assert.equal(dong?.decidedAt ?? null, null, "I: chưa ai quyết bản đề xuất này");
    const conDaNoi = await db
      .select()
      .from(schema.techProposalTasks)
      .where(eq(schema.techProposalTasks.proposalId, "ok" in ghi ? ghi.id : ""));
    assert.ok(conDaNoi.length > 0, "I: phải có việc con được ghi");
    assert.deepEqual(
      conDaNoi.filter((c) => c.appliedTaskId !== null),
      [],
      "I: không việc con nào được nối tới việc thật",
    );
  }

  /* ───── 15. TRẦN CỦA CTO PHẢI ĐI BẰNG STREAMING ─────

     Ta truyền `timeout` tường minh cho SDK, nên phép kiểm "lượt này dài quá, hãy streaming" của
     SDK bị BỎ QUA — nới trần mà không nới đường đi là đổi một lượt bị cắt lấy một lượt hết giờ,
     và lượt hết giờ thì không để lại lấy một chữ để đọc. */
  assert.ok(
    CTO_MAX_OUTPUT_TOKENS > NGUONG_KHONG_STREAM,
    `trần của CTO (${CTO_MAX_OUTPUT_TOKENS}) phải vượt ngưỡng không-streaming (${NGUONG_KHONG_STREAM}) để lượt gọi đi đường streaming`,
  );
  const nguonProvider = readFileSync(path.join(process.cwd(), "lib/ai/provider.ts"), "utf8");
  assert.ok(
    /max_tokens\s*>\s*NGUONG_KHONG_STREAM[\s\S]{0,200}messages\.stream\(/.test(nguonProvider),
    "AnthropicProvider phải chọn streaming theo NGUONG_KHONG_STREAM, không theo một số ghim cứng",
  );

  /* ───── dọn ───── */
  await db.delete(schema.techProposalTasks);
  await db.delete(schema.techProposals);
  /*
    ═══ ĐỀ BÀI DO AI CTO SINH RA KHÔNG ĐƯỢC BẢO AI KẾT LUẬN TỪ SỰ VẮNG MẶT ═══

    Prompt đã có luật "KHI THIẾU DỮ LIỆU: đưa vào questions" — luật ấy áp cho CHÍNH AI CTO. Nó
    KHÔNG cấm AI CTO viết một đề bài bảo agent kết luận từ chỗ không tìm thấy gì, và chỗ hở ấy đã
    cắn thật.

    Việc TECH-9 (23/09/2026): đề bài do AI CTO sinh ra nói "nếu không có bằng chứng thì ghi thẳng
    là không liên quan". Agent làm ĐÚNG lời dặn và giao về một mục mang tiêu đề "KHÔNG LIÊN QUAN",
    trong khi thân mục tự nói nó chỉ đọc được 500 dòng log. Lỗi ở LỜI DẶN, không ở agent — nên
    bản vá phải nằm ở nơi lời dặn được sinh ra.

    Bài kiểm này quét PROMPT, không quét đề bài sinh ra. Một bộ dò câu chữ trong đề bài sẽ là đúng
    thứ `AGENTS.md` mục 45 gọi là heuristic yếu: nó bắt được vài cách viết và bỏ sót vô số cách
    khác, rồi người ta tin nó. Prompt thì đọc được, và xoá một luật khỏi prompt là một diff nhìn
    thấy được.
  */
  const promptCto = readFileSync(path.join(goc, "lib/agents/cto.ts"), "utf8");
  const heThong = promptCto.slice(promptCto.indexOf("const HE_THONG"), promptCto.indexOf("function moTaVai"));
  assert.ok(/KẾT LUẬN TỪ SỰ VẮNG MẶT/.test(heThong), "prompt AI CTO phải cấm viết đề bài kết luận từ sự vắng mặt");
  assert.ok(/CHƯA TÌM THẤY BẰNG CHỨNG/.test(heThong), "và phải nêu ra kết quả đúng thay thế");
  assert.ok(/PHẠM VI/.test(heThong), "tiêu chí nghiệm thu phải đòi PHẠM VI đã tìm — một câu có/không không nói được chỗ nào chưa ai tới");

  await db.delete(schema.techTasks);

  console.log(
    "✓ AI CTO chế độ đề xuất: lập kế hoạch KHÔNG tạo việc thật · agent không duyệt/không từ chối · người duyệt thì việc tạo qua dịch vụ và phụ thuộc nối bằng id thật · AI nói R0 cho việc lương thì MÁY vẫn xếp R2 và vẫn chờ ký · duyệt hai lần không nhân đôi · bản từ chối/bị thay thế/nháp không áp được · JSON hỏng, vai lạ, module lạ, phụ thuộc vòng đều bị từ chối · prompt không mang bí mật (cả tên lẫn giá trị) · ĐÚNG MỘT lượt sửa khi sai hợp đồng, và KHÔNG sửa khi model chưa trả lời · câu trả lời bị cắt KHÔNG bị in ra thành lỗi JSON · quá tải/sai khoá/hết tín dụng là ba câu khác nhau · lượt dài đi bằng streaming · không đường ghi thứ hai vào tech_tasks · giao diện không có nút chạy tất cả · không vai nào merge/deploy/ghi production · đề bài sinh ra KHÔNG được bảo ai kết luận từ sự vắng mặt",
  );
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TIEN_TO_NHANH_AGENT, xetGhiNhanhViec } from "@/lib/constants/agent-branch-claim";
import { laMaViecHopLe } from "@/lib/constants/agent-dispatch";
import { __setDispatchFetchForTests, dispatchAgentRun } from "@/lib/integrations/github/dispatch";
import { dispatchTaskToAgent } from "@/lib/tech/dispatch-service";
import { ingestAgentRun } from "@/lib/tech/agent-run-ingest";

/**
 * ═══════════ NỬA SAU CỦA DÂY CHUYỀN: VIỆC THẬT PHẢI ĐI TIẾP ĐƯỢC ═══════════
 *
 * ĐO PRODUCTION 21/09/2026, một ngày sau khi tôi ghi "vòng đầu-cuối đã khép kín":
 *
 *     TECH-2 | TRIAGED | pr = 0 | pr_state = (trống)
 *
 * Agent đã làm việc thật, đẩy nhánh `ai/documentation/TECH-2-mub8rgnd`, PR #82 đã được duyệt và
 * ĐÃ GỘP. Production vẫn tưởng việc ấy chưa có PR nào và chưa ai bắt tay vào.
 *
 * Ba khúc đứt, cùng một câu chuyện, và **không khúc nào làm đỏ bất cứ thứ gì**:
 *
 *  1. **Nút khởi động không truyền mã việc.** `dispatchTaskToAgent()` gửi dispatch chỉ với `gates`,
 *     nên `agent-run.yml` rơi vào nhánh tự-kiểm và tự tạo một việc R0 của riêng nó. Nấc 3b đã dựng
 *     cửa đọc có khoá để phục vụ đúng chuyện này; nó chưa bao giờ được gọi từ ERP. Ghi chú sự kiện
 *     còn NÓI RA điều đó như một hạn chế đã biết — một khúc hỏng được ghi thành tài liệu thay vì
 *     được vá.
 *  2. **Nhánh không bao giờ về tới dòng việc.** Cửa chép sổ nhận `branch`, cất vào
 *     `tech_agent_runs`, rồi dừng. Nhưng `syncPullRequests()` ghép PR với việc bằng
 *     `tech_tasks.branch === head.ref` — cột ấy trước bản vá chỉ có một đường ghi: người gõ tay.
 *  3. **Luật đẩy trạng thái hết hạn cùng cửa sổ quan sát.** Cả hai luật cũ đòi `prState === "OPEN"`.
 *     Việc không được đẩy đúng lúc PR còn mở thì MẮC KẸT VĨNH VIỄN.
 *
 * Bài này khoá cả ba. Mốc thời gian đi theo đồng hồ thật (mục 50); dữ liệu dọn bằng tiền tố `vdt-`.
 */

const goc = path.resolve(__dirname, "..");
const TIEN_TO = "vdt-";

/* ═════════════ 1 · LUẬT THUẦN — NHÁNH NÀO ĐƯỢC GHI VÀO DÒNG VIỆC ═════════════ */

export function testNhanhVeToiViecPure() {
  const o = xetGhiNhanhViec({ hienTai: "", moi: "ai/documentation/TECH-2-abc" });
  assert.ok(o.ghi && o.nhanh === "ai/documentation/TECH-2-abc", "ô rỗng ⇒ ghi");

  const de = xetGhiNhanhViec({ hienTai: "ai/documentation/TECH-2-cu", moi: "ai/documentation/TECH-2-moi" });
  assert.ok(de.ghi && de.nhanh === "ai/documentation/TECH-2-moi", "nhánh agent cũ ⇒ lượt mới thắng");

  /*
    ───────── MÁY KHÔNG CÃI NGƯỜI ─────────

    Cột này cũng là nơi NGƯỜI khai nhánh của mình (AGENTS.md mục 9). Đè lên nó làm phép chiếu PR
    của họ trỏ sang PR của agent — và họ sẽ không bao giờ tin lại cái cột ấy nữa.
  */
  const nguoi = xetGhiNhanhViec({ hienTai: "claude/sua-trang-van-don", moi: "ai/documentation/TECH-2-abc" });
  assert.ok(!nguoi.ghi && nguoi.ma === "NGUOI_GIU", "nhánh của người ⇒ KHÔNG đè");
  assert.match(nguoi.ly, /sổ lượt chạy/, "và phải nói rõ nhánh lượt chạy KHÔNG mất, nó nằm ở sổ khác");

  /* Lượt chạy không đẩy nhánh nào: KHÔNG được xoá nhánh đang có — một ô rỗng làm phép chiếu mù lại. */
  for (const trong of ["", "   ", null, undefined]) {
    const v = xetGhiNhanhViec({ hienTai: "ai/documentation/TECH-2-abc", moi: trong });
    assert.ok(!v.ghi && v.ma === "KHONG_CO_NHANH", `moi=${JSON.stringify(trong)} ⇒ giữ nguyên, không xoá`);
  }

  const trung = xetGhiNhanhViec({ hienTai: "ai/x/Y-1", moi: "ai/x/Y-1" });
  assert.ok(!trung.ghi && trung.ma === "TRUNG", "trùng nhau ⇒ không ghi gì, không đẻ sự kiện");

  assert.equal(TIEN_TO_NHANH_AGENT, "ai/", "tiền tố phải khớp với nhánh runner thật sự đẩy lên");

  /* ───────── Ô `inputs` CỦA WORKFLOW LÀ CÔNG KHAI: CHỈ MÃ ĐƯỢC ĐI QUA ───────── */
  for (const tot of ["TECH-2", "TECH-12345", "OPS-1"]) assert.ok(laMaViecHopLe(tot), `${tot} là mã việc`);
  for (const xau of ["Viết tài liệu cho job đối chiếu", "tech-2", "TECH 2", "", "TECH-", "-1", "TECH-2 và mô tả dài"]) {
    assert.ok(!laMaViecHopLe(xau), `"${xau}" KHÔNG được coi là mã việc — nội dung việc không đi qua ô công khai`);
  }

  console.log("✓ Nhánh về tới dòng việc: ô rỗng ghi · nhánh agent cũ bị thay · nhánh NGƯỜI không bao giờ bị đè · lượt không đẩy nhánh thì không xoá · chỉ MÃ việc đi qua ô inputs công khai");
}

/* ═════════════ 2 · DISPATCH PHẢI MANG THEO MÃ VIỆC ═════════════ */

export async function testDispatchKemMaViec() {
  const db = await getDb();
  await cleanupViecDiTiepFixtures();
  const giuToken = process.env.ERP_GITHUB_DISPATCH_TOKEN;
  const giuRepo = process.env.ERP_GITHUB_REPO;

  try {
    process.env.ERP_GITHUB_REPO = "vi-du/kho";
    process.env.ERP_GITHUB_DISPATCH_TOKEN = "ghp_khoa_ghi_gia_cho_bai_kiem";

    /*
      ───────── MÃ SAI HÌNH DẠNG BỊ CHẶN TRƯỚC KHI CHẠM MẠNG ─────────
      Ô `inputs` hiện nguyên văn trong giao diện Actions của một kho PUBLIC. Một tiêu đề việc lọt
      vào đó là công khai nội dung nội bộ, và không có đường thu hồi.
    */
    let goiMang = 0;
    __setDispatchFetchForTests((async () => {
      goiMang += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    for (const xau of ["Viết tài liệu cho job đối chiếu sổ lượt chạy", "tech-2", ""]) {
      const v = await dispatchAgentRun({ workflow: "agent-run.yml", gates: "typecheck", taskCode: xau });
      assert.ok(!v.ok && v.kind === "FORBIDDEN", `taskCode "${xau}" phải bị từ chối`);
    }
    assert.equal(goiMang, 0, "không mã xấu nào được chạm tới mạng");

    /* ───────── ĐƯỜNG THẬT: NÚT TRONG ERP PHẢI GIAO ĐÚNG VIỆC NGƯỜI BẤM ───────── */
    const [u] = await db.insert(schema.users).values({ email: `${TIEN_TO}a@shop.vn`, name: "vdt", passwordHash: "x", role: "ADMIN" }).returning({ id: schema.users.id });
    const [ag] = await db.insert(schema.techAgents).values({ key: `${TIEN_TO}doc`, name: "vdt-doc", role: "DOCUMENTATION", enabled: true, allowedRisks: ["R0"] }).returning({ id: schema.techAgents.id });
    await db.insert(schema.techTasks).values({ code: "VDT-1", title: "vdt-viec-that", status: "TRIAGED", risk: "R0", agentId: ag.id });

    let batDuoc: { url: string; init: RequestInit } | null = null;
    __setDispatchFetchForTests((async (url: string, init: RequestInit) => {
      batDuoc = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    const res = await dispatchTaskToAgent({ taskCode: "VDT-1", gates: "typecheck,lint,test,build", actor: { id: u.id, email: `${TIEN_TO}a@shop.vn`, name: "vdt" } });
    assert.ok(res.ok, `phải giao được: ${res.ok ? "" : res.reason}`);

    const bat = batDuoc as unknown as { url: string; init: RequestInit };
    assert.ok(bat, "phải có lượt gọi dispatch");
    const body = JSON.parse(String(bat.init.body)) as { ref: string; inputs: Record<string, string> };
    assert.equal(body.inputs.task, "VDT-1", "dispatch PHẢI mang theo mã việc — không có nó, agent tự tạo việc R0 của riêng nó và việc người bấm không bao giờ được làm");
    assert.equal(body.inputs.gates, "typecheck,lint,test,build");
    assert.equal(body.ref, "main", "vẫn luôn là workflow của main");

    /*
      Và ô công khai KHÔNG được mang nội dung việc. Kiểm bằng chính TIÊU ĐỀ của việc vừa dựng:
      đó là thứ nguy hiểm thật, không phải một chuỗi tưởng tượng.
    */
    assert.ok(!String(bat.init.body).includes("vdt-viec-that"), "tiêu đề việc KHÔNG được lọt vào ô inputs công khai");

    /* ───────── GHI CHÚ SỰ KIỆN PHẢI THÔI NÓI DỐI ───────── */
    const viec = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, "VDT-1"), columns: { id: true } });
    const sk = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, viec!.id), columns: { kind: true, note: true } });
    const run = sk.filter((x) => x.kind === "RUN");
    assert.equal(run.length, 1, "đúng một sự kiện RUN cho lượt giao");
    assert.ok(!/CHƯA nhận được việc này/.test(run[0].note ?? ""), "ghi chú cũ khai rằng agent KHÔNG nhận được việc — nay nó nhận được, và ghi chú phải nói đúng");
  } finally {
    __setDispatchFetchForTests(null);
    if (giuToken === undefined) delete process.env.ERP_GITHUB_DISPATCH_TOKEN;
    else process.env.ERP_GITHUB_DISPATCH_TOKEN = giuToken;
    if (giuRepo === undefined) delete process.env.ERP_GITHUB_REPO;
    else process.env.ERP_GITHUB_REPO = giuRepo;
  }
  console.log("✓ Giao việc: dispatch mang theo MÃ việc · nội dung việc không lọt ô công khai · mã sai hình dạng bị chặn trước khi chạm mạng");
}

/* ═════════════ 3 · CỬA CHÉP SỔ PHẢI TRẢ NHÁNH VỀ DÒNG VIỆC ═════════════ */

export async function testIngestGhiNhanhViec() {
  const db = await getDb();
  await cleanupViecDiTiepFixtures();

  const [ag] = await db.insert(schema.techAgents).values({ key: `${TIEN_TO}doc`, name: "vdt-doc", role: "DOCUMENTATION", enabled: true, allowedRisks: ["R0"] }).returning({ id: schema.techAgents.id });
  await db.insert(schema.techTasks).values({ code: "VDT-2", title: "vdt-o-rong", status: "TRIAGED", risk: "R0", agentId: ag.id });
  await db.insert(schema.techTasks).values({ code: "VDT-3", title: "vdt-nguoi-giu", status: "BUILDING", risk: "R0", agentId: ag.id, branch: "claude/nguoi-dang-lam" });

  const chung = { agentKey: `${TIEN_TO}doc`, status: "SUCCEEDED" as const, baseCommit: "a".repeat(40) };

  /* ───────── Ô RỖNG ⇒ GHI, và đó là thứ làm phép chiếu PR ghép được ───────── */
  const r1 = await ingestAgentRun({ ...chung, externalRef: `${TIEN_TO}gh:1`, taskCode: "VDT-2", branch: "ai/documentation/VDT-2-xyz" });
  assert.ok("ok" in r1 && r1.ok, "chép sổ phải thành công");
  assert.ok("ok" in r1 && r1.nhanhViec?.ghi === true, "và phải NÓI RA rằng nó đã ghi nhánh — một việc làm âm thầm là một việc không ai kiểm được");
  const t2 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, "VDT-2"), columns: { id: true, branch: true, status: true } });
  assert.equal(t2!.branch, "ai/documentation/VDT-2-xyz", "nhánh phải về tới dòng việc — nếu không, syncPullRequests() không có khoá nào để ghép PR");

  /*
    ───────── CỬA NÀY VẪN KHÔNG ĐỤNG TRẠNG THÁI VIỆC ─────────
    Một lượt chạy xong KHÔNG phải một việc xong. Đẩy trạng thái là việc của Nấc 4, dựa trên bằng
    chứng GitHub, và đi qua `setTechTaskStatus()`.
  */
  assert.equal(t2!.status, "TRIAGED", "cửa chép sổ KHÔNG được tự đổi trạng thái việc");

  /* Vết phải nói rõ MÁY làm (mục 34: `id: null` có nghĩa MÁY, khác hẳn "chưa biết ai"). */
  const sk = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, t2!.id), columns: { kind: true, actorKind: true, actorId: true, nextValue: true } });
  const nhanh = sk.filter((x) => x.kind === "BRANCH");
  assert.equal(nhanh.length, 1, "đúng một sự kiện BRANCH");
  assert.equal(nhanh[0].actorKind, "SYSTEM", "vết phải nói rõ MÁY làm");
  assert.equal(nhanh[0].actorId, null, "máy làm ⇒ không khoá tài khoản");

  /* ───────── CHÉP LẠI CÙNG KHOÁ: KHÔNG ĐẺ SỰ KIỆN THỨ HAI ───────── */
  const lai = await ingestAgentRun({ ...chung, externalRef: `${TIEN_TO}gh:1`, taskCode: "VDT-2", branch: "ai/documentation/VDT-2-xyz" });
  assert.ok("ok" in lai && lai.ok && !lai.created, "lượt chép lặp phải trả về dòng cũ");
  const sk2 = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, t2!.id), columns: { kind: true } });
  assert.equal(sk2.filter((x) => x.kind === "BRANCH").length, 1, "chép lại KHÔNG được đẻ thêm sự kiện BRANCH");

  /* ───────── NHÁNH CỦA NGƯỜI: GIỮ NGUYÊN ───────── */
  const r3 = await ingestAgentRun({ ...chung, externalRef: `${TIEN_TO}gh:3`, taskCode: "VDT-3", branch: "ai/documentation/VDT-3-xyz" });
  assert.ok("ok" in r3 && r3.ok && r3.nhanhViec?.ghi === false, "nhánh người ⇒ không ghi");
  const t3 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, "VDT-3"), columns: { branch: true } });
  assert.equal(t3!.branch, "claude/nguoi-dang-lam", "MÁY KHÔNG CÃI NGƯỜI — nhánh người khai phải còn nguyên");

  /* ───────── LƯỢT CHẠY KHÔNG ĐẨY NHÁNH: KHÔNG XOÁ Ô ĐANG CÓ ───────── */
  const r4 = await ingestAgentRun({ ...chung, externalRef: `${TIEN_TO}gh:4`, taskCode: "VDT-2", status: "FAILED", branch: "" });
  assert.ok("ok" in r4 && r4.ok, "lượt hỏng vẫn vào sổ");
  const t2b = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, "VDT-2"), columns: { branch: true } });
  assert.equal(t2b!.branch, "ai/documentation/VDT-2-xyz", "lượt không đẩy nhánh KHÔNG được xoá nhánh đang có");

  await cleanupViecDiTiepFixtures();
  console.log("✓ Chép sổ: nhánh về tới dòng việc · không đụng trạng thái · vết mang danh MÁY · chép lại không đẻ sự kiện · nhánh người còn nguyên · lượt trắng không xoá gì");
}

/* ═════════════ 4 · QUÉT MÃ NGUỒN ═════════════ */

export function testViecDiTiepGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const svc = bo(readFileSync(path.join(goc, "lib/tech/dispatch-service.ts"), "utf8"));
  const ing = bo(readFileSync(path.join(goc, "lib/tech/agent-run-ingest.ts"), "utf8"));

  /* Nút trong ERP phải truyền mã việc — đọc ở MÃ NGUỒN vì một lời gọi thiếu tham số không đỏ gì cả. */
  assert.match(svc, /dispatchAgentRun\(\{[^}]*taskCode:\s*task\.code/, "dispatchTaskToAgent phải truyền taskCode: task.code");

  /*
    CỬA CHÉP SỔ CHẠM ĐÚNG MỘT CỘT CỦA `tech_tasks`, VÀ QUA HÀM DỊCH VỤ.

    `update` thẳng bảng việc từ một endpoint máy-gọi-máy là một đường ghi thứ hai không ai kiểm
    được; `setTechTaskBranch()` ghi sự kiện và bỏ qua khi không đổi.
  */
  assert.ok(ing.includes("setTechTaskBranch("), "phải đi qua hàm dịch vụ");
  assert.ok(!/db\s*\.\s*update\(schema\.techTasks\)/.test(ing), "KHÔNG được update thẳng bảng việc");
  assert.ok(!ing.includes("setTechTaskStatus("), "cửa chép sổ KHÔNG bao giờ đổi trạng thái việc — đó là quyết định, không phải quan sát");

  console.log("✓ Quét mã nguồn: nút ERP truyền mã việc · cửa chép sổ chỉ chạm cột nhánh, qua hàm dịch vụ, không đụng trạng thái");
}

export async function cleanupViecDiTiepFixtures() {
  const db = await getDb();
  const viec = await db.query.techTasks.findMany({ where: like(schema.techTasks.code, "VDT-%"), columns: { id: true } });
  const ids = viec.map((x) => x.id);
  if (ids.length) {
    await db.delete(schema.techAgentRuns).where(inArray(schema.techAgentRuns.taskId, ids));
    await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, ids));
    await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, ids));
  }
  await db.delete(schema.techAgentRuns).where(like(schema.techAgentRuns.externalRef, `${TIEN_TO}%`));
  await db.delete(schema.techAgents).where(like(schema.techAgents.key, `${TIEN_TO}%`));
  await db.delete(schema.users).where(like(schema.users.email, `${TIEN_TO}%`));
}

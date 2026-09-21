import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  DISPATCHABLE_WORKFLOWS,
  DISPATCH_AUDIT_ACTION,
  DISPATCH_QUOTA,
  DISPATCH_REF,
  canDispatchTask,
  checkDispatchQuota,
} from "@/lib/constants/agent-dispatch";
import { __setDispatchFetchForTests, dispatchAgentRun, dispatchConfig } from "@/lib/integrations/github/dispatch";
import { dispatchTaskToAgent } from "@/lib/tech/dispatch-service";

/**
 * ═══════════ NẤC 3 · ERP GIAO VIỆC CHO AGENT ═══════════
 *
 * Lần đầu tiên một màn hình nghiệp vụ khởi động được một tiến trình GHI MÃ. Ba cổng độc lập —
 * cấu hình · việc · hạn mức — và bài này đo cả ba trên đường thực thi THẬT, cộng một khối quét mã
 * nguồn cho những tính chất không hiện ra ở hành vi.
 *
 * Không lượt gọi mạng thật nào: `__setDispatchFetchForTests` tiêm `fetch` giả.
 */

const goc = path.resolve(__dirname, "..");
const TIEN_TO = "disp-";

/* ═════════════ 1 · LUẬT THUẦN ═════════════ */

export function testDispatchPure() {
  const hopLe = { code: "T-1", risk: "R0", status: "TRIAGED", approvalRequired: false, approvalStatus: "NOT_REQUIRED", agentKey: "documentation" };
  assert.ok(canDispatchTask(hopLe).ok, "việc R0 đã phân loại, có agent, không cần duyệt ⇒ giao được");

  // ───────── R2 KHÔNG BAO GIỜ ─────────
  const r2 = canDispatchTask({ ...hopLe, risk: "R2" });
  assert.ok(!r2.ok && r2.code === "RISK", "R2 không bao giờ mở cho agent");
  assert.ok(!r2.ok && /R2/.test(r2.reason), "lý do phải nói rõ mức rủi ro");

  /*
    `NEW` KHÔNG giao được: việc chưa ai phân loại thì chưa ai hiểu nó là gì, và giao cho máy một
    việc chưa hiểu là cách nhanh nhất để có một PR không ai muốn đọc.
  */
  for (const s of ["NEW", "DONE", "REVIEW", "BLOCKED"]) {
    const v = canDispatchTask({ ...hopLe, status: s });
    assert.ok(!v.ok && v.code === "STATUS", `trạng thái ${s} không giao được`);
  }

  /*
    ───────── PHÊ DUYỆT LÀ CỔNG CỨNG, VÀ DỮ LIỆU TỰ MÂU THUẪN RƠI VỀ PHÍA HẸP ─────────
    `approvalRequired = true` mà `approvalStatus = NOT_REQUIRED` là một mâu thuẫn; nó phải là
    KHÔNG, không phải là cho qua.
  */
  for (const st of ["PENDING", "REJECTED", "NOT_REQUIRED", ""]) {
    const v = canDispatchTask({ ...hopLe, approvalRequired: true, approvalStatus: st });
    assert.ok(!v.ok && v.code === "APPROVAL", `cần duyệt mà đang "${st}" thì không giao được`);
  }
  assert.ok(canDispatchTask({ ...hopLe, approvalRequired: true, approvalStatus: "APPROVED" }).ok, "đã duyệt thì giao được");

  const khongAgent = canDispatchTask({ ...hopLe, agentKey: null });
  assert.ok(!khongAgent.ok && khongAgent.code === "NO_AGENT", "chưa gán agent thì không giao được");

  /* Bốn lý do phải PHÂN BIỆT ĐƯỢC — gộp thành một "không giao được" là đẩy người đọc đi sửa nhầm chỗ. */
  const ma = new Set([r2, canDispatchTask({ ...hopLe, status: "NEW" }), canDispatchTask({ ...hopLe, approvalRequired: true, approvalStatus: "PENDING" }), khongAgent].map((v) => (v.ok ? "ok" : v.code)));
  assert.equal(ma.size, 4, "bốn tình huống phải cho bốn mã lý do khác nhau");

  /* ───────── HẠN MỨC: đúng trần, hơn trần, và biên dưới ───────── */
  assert.ok(checkDispatchQuota(0, 0).ok);
  assert.ok(checkDispatchQuota(DISPATCH_QUOTA.perHour - 1, 0).ok, "dưới trần một lượt thì vẫn được");
  assert.ok(!checkDispatchQuota(DISPATCH_QUOTA.perHour, 0).ok, "CHẠM trần giờ là hết — `>=` chứ không phải `>`");
  assert.ok(!checkDispatchQuota(0, DISPATCH_QUOTA.perDay).ok, "chạm trần ngày cũng hết");
  const con = checkDispatchQuota(1, 1);
  assert.ok(con.ok && con.conLaiGio === DISPATCH_QUOTA.perHour - 1 && con.conLaiNgay === DISPATCH_QUOTA.perDay - 1, "phải nói còn bao nhiêu suất");
}

/* ═════════════ 2 · CỬA GHI GITHUB ═════════════ */

export async function testDispatchCua() {
  const giuToken = process.env.ERP_GITHUB_DISPATCH_TOKEN;
  const giuRepo = process.env.ERP_GITHUB_REPO;
  try {
    /*
      ───────── CHƯA KHAI KHOÁ GHI ⇒ "CHƯA BẬT", KHÔNG PHẢI "HỎNG" ─────────
      Và tuyệt đối không được rơi về token ĐỌC: token đọc nằm sẵn trong .env production, nên một
      fallback như thế làm quyền ghi tự xuất hiện ở nơi không ai chủ ý cấp.
    */
    delete process.env.ERP_GITHUB_DISPATCH_TOKEN;
    process.env.ERP_GITHUB_REPO = "vi-du/kho";
    process.env.ERP_GITHUB_TOKEN = "token-doc-khong-duoc-dung-cho-ghi";
    const tat = dispatchConfig();
    assert.ok(!tat.configured, "chưa khai khoá ghi thì cửa ĐÓNG");
    assert.match(tat.reason ?? "", /ERP_GITHUB_DISPATCH_TOKEN/, "phải nói đúng tên biến còn thiếu");

    let goiMang = 0;
    __setDispatchFetchForTests((async () => {
      goiMang += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    const chuaBat = await dispatchAgentRun({ workflow: "agent-run.yml", gates: "typecheck" });
    assert.ok(!chuaBat.ok && chuaBat.kind === "NOT_CONFIGURED", "chưa bật thì trả NOT_CONFIGURED");
    assert.equal(goiMang, 0, "và KHÔNG được gọi mạng — cổng cấu hình phải chặn trước khi gửi");

    /* ───────── DANH SÁCH WORKFLOW LÀ ĐÓNG ───────── */
    process.env.ERP_GITHUB_DISPATCH_TOKEN = "ghp_khoa_ghi_gia_cho_bai_kiem";
    for (const xau of ["deploy-vps.yml", "ops-vps.yml", "../deploy-vps.yml", "agent-run.yaml", ""]) {
      const v = await dispatchAgentRun({ workflow: xau, gates: "typecheck" });
      assert.ok(!v.ok && v.kind === "FORBIDDEN", `"${xau}" phải bị từ chối — ERP không được khởi động workflow tuỳ ý`);
    }
    assert.equal(goiMang, 0, "không workflow lạ nào được chạm tới mạng");

    /* ───────── GỬI ĐÚNG: 204, ref là HẰNG SỐ, body đúng hình dạng ───────── */
    let batDuoc: { url: string; init: RequestInit } | null = null;
    __setDispatchFetchForTests((async (url: string, init: RequestInit) => {
      batDuoc = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    const ok = await dispatchAgentRun({ workflow: "agent-run.yml", gates: "typecheck,lint,test,build" });
    assert.ok(ok.ok, "204 là thành công");
    assert.ok(ok.ok && ok.ref === DISPATCH_REF, "ref phải là hằng số main");
    const bat = batDuoc as unknown as { url: string; init: RequestInit };
    assert.ok(bat, "phải có lượt gọi");
    assert.match(bat.url, /\/actions\/workflows\/agent-run\.yml\/dispatches$/, "gọi đúng endpoint dispatch");
    assert.equal(bat.init.method, "POST");
    const body = JSON.parse(String(bat.init.body)) as { ref: string; inputs: { gates: string } };
    assert.equal(body.ref, "main", "KHÔNG bao giờ chạy workflow của một nhánh khác");
    assert.equal(body.inputs.gates, "typecheck,lint,test,build");

    /* ───────── 403 (token thiếu quyền ghi) PHẢI KHÁC 404 VÀ KHÁC HẠN MỨC ───────── */
    __setDispatchFetchForTests((async () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403, headers: { "x-ratelimit-remaining": "4999" } })) as unknown as typeof fetch);
    const cam = await dispatchAgentRun({ workflow: "agent-run.yml", gates: "typecheck" });
    assert.ok(!cam.ok && cam.kind === "FORBIDDEN", "403 ⇒ thiếu quyền");
    assert.ok(!cam.ok && /actions: write/.test(cam.detail), "và phải nói rõ cần quyền gì — người đọc đi cấp quyền, không đi đổi tên kho");

    __setDispatchFetchForTests((async () => new Response(JSON.stringify({ message: "rate limit" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch);
    const hanMuc = await dispatchAgentRun({ workflow: "agent-run.yml", gates: "typecheck" });
    assert.ok(!hanMuc.ok && hanMuc.kind === "RATE_LIMITED", "403 kèm remaining=0 là HẠN MỨC, không phải thiếu quyền");

    __setDispatchFetchForTests((async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch);
    const khong = await dispatchAgentRun({ workflow: "agent-run.yml", gates: "typecheck" });
    assert.ok(!khong.ok && khong.kind === "NOT_FOUND", "404 là câu trả lời thứ ba, không gộp vào hai câu trên");
  } finally {
    __setDispatchFetchForTests(null);
    if (giuToken === undefined) delete process.env.ERP_GITHUB_DISPATCH_TOKEN;
    else process.env.ERP_GITHUB_DISPATCH_TOKEN = giuToken;
    if (giuRepo === undefined) delete process.env.ERP_GITHUB_REPO;
    else process.env.ERP_GITHUB_REPO = giuRepo;
    delete process.env.ERP_GITHUB_TOKEN;
  }
}

/* ═════════════ 3 · ĐƯỜNG THỰC THI TRÊN CSDL THẬT ═════════════ */

export async function testDispatchService() {
  const db = await getDb();
  await cleanupDispatchFixtures();
  const giuToken = process.env.ERP_GITHUB_DISPATCH_TOKEN;
  const giuRepo = process.env.ERP_GITHUB_REPO;

  try {
    const [u] = await db.insert(schema.users).values({ email: `${TIEN_TO}a@shop.vn`, name: "disp", passwordHash: "x", role: "ADMIN" }).returning({ id: schema.users.id });
    const actor = { id: u.id, email: `${TIEN_TO}a@shop.vn`, name: "disp" };
    const [ag] = await db.insert(schema.techAgents).values({ key: `${TIEN_TO}doc`, name: "disp-doc", role: "DOCUMENTATION", enabled: true, allowedRisks: ["R0"] }).returning({ id: schema.techAgents.id });
    const [agTat] = await db.insert(schema.techAgents).values({ key: `${TIEN_TO}tat`, name: "disp-tat", role: "QA", enabled: false }).returning({ id: schema.techAgents.id });
    await db.insert(schema.techTasks).values({ code: "DISP-1", title: "disp-viec", status: "TRIAGED", risk: "R0", agentId: ag.id });
    await db.insert(schema.techTasks).values({ code: "DISP-2", title: "disp-vai-tat", status: "TRIAGED", risk: "R0", agentId: agTat.id });

    let goiMang = 0;
    __setDispatchFetchForTests((async () => {
      goiMang += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    /* ───────── CỔNG CẤU HÌNH CHẶN TRƯỚC KHI ĐỤNG CSDL ───────── */
    delete process.env.ERP_GITHUB_DISPATCH_TOKEN;
    const chuaBat = await dispatchTaskToAgent({ taskCode: "DISP-1", gates: "typecheck", actor });
    assert.ok(!chuaBat.ok && chuaBat.code === "NOT_CONFIGURED", "chưa bật cửa ghi thì không giao được");

    process.env.ERP_GITHUB_REPO = "vi-du/kho";
    process.env.ERP_GITHUB_DISPATCH_TOKEN = "ghp_khoa_ghi_gia_cho_bai_kiem";

    const laVe = await dispatchTaskToAgent({ taskCode: "DISP-KHONG-CO", gates: "typecheck", actor });
    assert.ok(!laVe.ok && laVe.code === "UNKNOWN_TASK", "việc lạ phải nói rõ là không có, không phải một lỗi chung");

    /*
      ───────── VAI ĐANG TẮT KHÔNG GIAO ĐƯỢC ─────────
      Khác hẳn `agent-run-ingest`, nơi vai tắt VẪN được chép sổ: ở đó lượt chạy đã xảy ra rồi và từ
      chối là xoá bằng chứng; ở đây chưa có gì xảy ra và cờ `enabled` đúng là cổng quyết định.
    */
    const vaiTat = await dispatchTaskToAgent({ taskCode: "DISP-2", gates: "typecheck", actor });
    assert.ok(!vaiTat.ok && vaiTat.code === "TASK", "vai đang TẮT thì không giao được");
    assert.ok(!vaiTat.ok && /TẮT/.test(vaiTat.reason));
    assert.equal(goiMang, 0, "chưa lượt nào hợp lệ ⇒ chưa gọi mạng lần nào");

    /* ───────── GIAO ĐƯỢC, VÀ ĐỂ LẠI HAI VẾT ───────── */
    const ok = await dispatchTaskToAgent({ taskCode: "DISP-1", gates: "typecheck,lint,test,build", actor });
    assert.ok(ok.ok, `phải giao được: ${ok.ok ? "" : ok.reason}`);
    assert.equal(goiMang, 1);

    /*
      AUDIT KHÔNG ĐƯỢC GHI Ở ĐÂY — nó ở lớp action (xem khối 4). Bài này gọi thẳng service, nên
      bảng `audit_logs` phải còn nguyên; nếu service cũng ghi thì mỗi lượt giao tiêu HAI suất hạn
      mức và trần giờ tụt còn một nửa mà không ai thấy.
    */
    const nhatKy = await db.query.auditLogs.findMany({ where: like(schema.auditLogs.userEmail, `${TIEN_TO}%`) });
    assert.equal(nhatKy.length, 0, "service KHÔNG ghi audit — ghi cả hai tầng là đếm đôi hạn mức");

    const viec = await db.query.techTasks.findFirst({ where: like(schema.techTasks.code, "DISP-1"), columns: { id: true, status: true } });
    assert.equal(viec?.status, "TRIAGED", "GIAO việc KHÔNG được tự đổi trạng thái việc — đó là một quyết định khác");
    const suKien = await db.query.techTaskEvents.findMany({ where: like(schema.techTaskEvents.note, "Khởi động lượt chạy agent%") });
    assert.ok(suKien.length >= 1, "phải có một dòng trong lịch sử của chính việc ấy");

    /*
      ───────── HẠN MỨC ĐẾM TỪ NHẬT KÝ, VÀ CHẠM TRẦN THÌ DỪNG ─────────
      Gieo thêm cho đủ trần rồi thử lượt kế tiếp. Đây là vế chứng minh `audit_logs` THẬT SỰ được
      dùng làm sổ đếm, chứ không phải chỉ được ghi cho có.
    */
    for (let i = 0; i < DISPATCH_QUOTA.perHour; i++) {
      await db.insert(schema.auditLogs).values({ userId: u.id, userEmail: `${TIEN_TO}a@shop.vn`, action: DISPATCH_AUDIT_ACTION, entity: "TECH_TASK", entityId: "x" });
    }
    const hetSuat = await dispatchTaskToAgent({ taskCode: "DISP-1", gates: "typecheck", actor });
    assert.ok(!hetSuat.ok && hetSuat.code === "QUOTA", "chạm trần giờ thì dừng");
    assert.equal(goiMang, 1, "và KHÔNG gọi mạng thêm lần nào");
  } finally {
    __setDispatchFetchForTests(null);
    if (giuToken === undefined) delete process.env.ERP_GITHUB_DISPATCH_TOKEN;
    else process.env.ERP_GITHUB_DISPATCH_TOKEN = giuToken;
    if (giuRepo === undefined) delete process.env.ERP_GITHUB_REPO;
    else process.env.ERP_GITHUB_REPO = giuRepo;
    await cleanupDispatchFixtures();
  }
}

export async function cleanupDispatchFixtures() {
  const db = await getDb();
  const viec = await db.query.techTasks.findMany({ where: like(schema.techTasks.code, "DISP-%"), columns: { id: true } });
  if (viec.length) {
    await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, viec.map((v) => v.id)));
    await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, viec.map((v) => v.id)));
  }
  const vai = await db.query.techAgents.findMany({ where: like(schema.techAgents.key, `${TIEN_TO}%`), columns: { id: true } });
  if (vai.length) await db.delete(schema.techAgents).where(inArray(schema.techAgents.id, vai.map((v) => v.id)));
  const u = await db.query.users.findMany({ where: like(schema.users.email, `${TIEN_TO}%`), columns: { id: true } });
  if (u.length) {
    await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.userId, u.map((x) => x.id)));
    await db.delete(schema.users).where(inArray(schema.users.id, u.map((x) => x.id)));
  }
}

/* ═════════════ 4 · QUÉT MÃ NGUỒN ═════════════ */

export function testDispatchSourceGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const disp = bo(readFileSync(path.join(goc, "lib/integrations/github/dispatch.ts"), "utf8"));
  const client = bo(readFileSync(path.join(goc, "lib/integrations/github/client.ts"), "utf8"));
  const svc = bo(readFileSync(path.join(goc, "lib/tech/dispatch-service.ts"), "utf8"));

  /*
    ───────── CLIENT ĐỌC VẪN PHẢI CHỈ-ĐỌC ─────────
    Nấc 3 thêm một đường GHI, và cám dỗ tự nhiên là nhét nó vào client cho gần. Tách tệp làm câu
    hỏi "ERP ghi gì sang GitHub?" trả lời được bằng `ls`, thay vì bằng cách đọc cả tệp bốn trăm
    dòng và tin rằng mình không bỏ sót.
  */
  for (const m of ['method: "POST"', "/dispatches"]) {
    assert.ok(!client.includes(m), `client GitHub phải CHỈ ĐỌC — tìm thấy \`${m}\``);
  }

  /*
    ───────── KHOÁ GHI TÁCH KHỎI KHOÁ ĐỌC, KHÔNG CÓ FALLBACK ─────────
    `GITHUB_TOKEN`/`GH_TOKEN` có mặt sẵn trong mọi lượt chạy Actions; một fallback tới chúng làm
    quyền ghi tự xuất hiện ở nơi không ai chủ ý cấp.
  */
  assert.ok(disp.includes("ERP_GITHUB_DISPATCH_TOKEN"), "cửa ghi phải dùng khoá RIÊNG");
  for (const bien of ["ERP_GITHUB_TOKEN", "GH_TOKEN"]) {
    assert.ok(!disp.includes(`process.env.${bien}`), `cửa ghi KHÔNG được rơi về ${bien}`);
  }
  assert.ok(!/process\.env\.GITHUB_TOKEN/.test(disp), "cửa ghi KHÔNG được rơi về GITHUB_TOKEN");

  /* ───────── `ref` LÀ HẰNG SỐ, KHÔNG PHẢI THAM SỐ ───────── */
  assert.ok(disp.includes("ref: DISPATCH_REF"), "ref phải lấy từ hằng số");
  assert.ok(!/ref:\s*input\./.test(disp), "ref KHÔNG được nhận từ nơi gọi — chạy workflow của nhánh khác là đường để một lượt chạy tự viết lại hàng rào của lượt sau");
  assert.equal(DISPATCH_REF, "main");

  /* ───────── DANH SÁCH WORKFLOW ĐÓNG, VÀ KHÔNG CHỨA THỨ NGUY HIỂM ───────── */
  assert.deepEqual([...DISPATCHABLE_WORKFLOWS], ["agent-run.yml"], "đúng một workflow");
  for (const nguyHiem of ["deploy-vps.yml", "ops-vps.yml", "gates.yml"]) {
    assert.ok(!DISPATCHABLE_WORKFLOWS.includes(nguyHiem), `${nguyHiem} KHÔNG bao giờ được ERP khởi động`);
  }

  /*
    ───────── THỨ TỰ BA CỔNG LÀ MỘT TÍNH CHẤT ─────────
    Hạn mức phải đếm SAU cổng việc: đếm trước nghĩa là một lượt bấm vào việc không hợp lệ vẫn tiêu
    một suất. Và audit ghi SAU khi gửi: ghi trước rồi gửi hỏng ⇒ tiêu một suất cho một lượt chạy
    chưa từng tồn tại.
  */
  const iViec = svc.indexOf("canDispatchTask(");
  const iQuota = svc.indexOf("checkDispatchQuota(");
  const iGui = svc.indexOf("dispatchAgentRun(");
  assert.ok(iViec > 0 && iQuota > iViec, "cổng việc phải kiểm TRƯỚC khi đếm hạn mức");
  assert.ok(iGui > iQuota, "gửi phải sau khi qua hạn mức");

  /*
    ───────── AUDIT GHI Ở LỚP ACTION, VÀ GHI SAU KHI GỬI ─────────

    Dòng audit vừa là nhật ký vừa là SỔ ĐẾM hạn mức. Nó nằm ở `lib/actions/tech.ts` chứ không ở
    service vì luật nhà (`tech-control-plane`) đòi MỌI action Tech tự ghi nhật ký — để nó ở nơi bộ
    gác ấy nhìn thấy nghĩa là bộ gác bảo vệ luôn sổ đếm: quên ghi ⇒ bài kiểm đỏ, không quên được
    trong im lặng. Ghi ở tầng dưới là lách luật ấy.
  */
  assert.ok(!svc.includes("audit({"), "service KHÔNG ghi audit — nó phải ở lớp action, nơi bộ gác luật nhà nhìn thấy");
  const act = bo(readFileSync(path.join(goc, "lib/actions/tech.ts"), "utf8"));
  const than = act.slice(act.indexOf("export async function dispatchTaskToAgentAction"));
  assert.ok(than.includes("nguoiQuanTri()"), "action giao việc phải đi qua cổng quyền tech:manage");
  const jGui = than.indexOf("dispatchTaskToAgent(");
  const jAudit = than.indexOf("audit({");
  assert.ok(jGui > 0 && jAudit > jGui, "audit phải ghi SAU lượt gửi — ghi trước rồi gửi hỏng là tiêu một suất cho một lượt chạy chưa từng tồn tại");
  assert.ok(than.includes("DISPATCH_AUDIT_ACTION"), "và phải dùng ĐÚNG khoá hành động mà sổ đếm hạn mức đang đọc");

  /*
    ───────── LỜI NÓI PHẢI KHỚP VỚI THỨ MÃ NGUỒN LÀM ─────────

    Bộ gác hai chiều: workflow mọc thêm đầu vào việc ⇒ buộc sửa câu chữ; câu chữ quay lại hứa
    "giao việc" khi mã nguồn chưa làm được ⇒ ĐỎ. Một nút hứa nhiều hơn thứ nó làm là cách nhanh
    nhất để người dùng thôi tin mọi nút khác.

    ─── BỘ GÁC NÀY ĐÃ CHẾT TỪ LÚC SINH RA, VÀ KHÔNG AI BIẾT ───

    Phát hiện 21/09/2026. Biểu thức nhận diện đầu vào việc từng được viết là `/\btask…/`, nhưng
    trong tệp nguồn ký tự ấy là **một byte BACKSPACE thật (0x08)**, không phải hai ký tự `\` + `b`.
    Nên nó đòi một ký tự điều khiển đứng ngay trước chữ `task` — điều không bao giờ xảy ra.

    Hậu quả: `coDauVaoViec` VĨNH VIỄN `false`. Nấc 3b đã thêm đầu vào `task` vào workflow từ lâu,
    chiều "buộc đi sửa lại câu chữ" lẽ ra phải đỏ ngay hôm đó — nó im lặng, và màn hình tiếp tục
    nói với chủ shop một câu không còn đúng.

    Một bài kiểm luôn đi VÀO CÙNG MỘT NHÁNH thì nửa còn lại của nó chưa từng tồn tại.
    `tests/test-hygiene.test.ts` nay chặn cả LỚP lỗi này: không tệp kiểm thử nào được chứa ký tự
    điều khiển lọt vào mã nguồn.
  */
  const wf = readFileSync(path.join(goc, ".github/workflows/agent-run.yml"), "utf8");
  const khoiInputs = wf.slice(wf.indexOf("inputs:"), wf.indexOf("permissions:"));
  const coDauVaoViec = /\btask(_code)?\s*:/.test(khoiInputs);
  const ui = readFileSync(path.join(goc, "app/(dashboard)/tech/tasks/[id]/task-actions.tsx"), "utf8");
  if (!coDauVaoViec) {
    assert.ok(
      ui.includes("CHƯA nhận được việc này"),
      "workflow chưa nhận được việc thì màn hình PHẢI nói rõ điều đó — không được để nút hứa nhiều hơn thứ nó làm",
    );
    assert.ok(!ui.includes(">Giao cho agent<"), "…và nhãn nút không được là 'Giao cho agent' khi việc chưa được trao");
    assert.ok(svc.includes("CHƯA nhận được việc này"), "đường thực thi cũng phải ghi lại giới hạn ấy vào lịch sử của việc");
  } else {
    assert.ok(
      !ui.includes("CHƯA nhận được việc này"),
      "workflow ĐÃ nhận được việc — gỡ câu cảnh báo cũ đi, một cảnh báo sai còn tệ hơn không có",
    );
    /*
      VÀ ĐƯỜNG THỰC THI PHẢI THẬT SỰ TRAO VIỆC.

      Workflow nhận được đầu vào việc KHÔNG có nghĩa ERP đang gửi nó. Đúng khoảng hở ấy đã tồn tại
      từ Nấc 3b tới 21/09/2026: ô `task` có sẵn, mà `dispatchTaskToAgent()` gửi mỗi `gates`.
    */
    assert.match(svc, /dispatchAgentRun\(\{[^}]*taskCode:\s*task\.code/, "workflow nhận được việc thì ERP phải GỬI mã việc — có ô mà không gửi thì vẫn là lượt chạy tự kiểm");
  }

  console.log("✓ Nấc 3 (giao việc cho agent): 4 lý do từ chối phân biệt được · khoá GHI tách khỏi khoá ĐỌC không fallback · chỉ agent-run.yml, chỉ ref main · 403/404/hạn mức là ba câu khác nhau · hạn mức đếm từ audit_logs và chạm trần thì dừng trước khi gọi mạng · lời nói khớp mã nguồn (workflow nhận được việc, ERP GỬI mã việc, màn hình nói đúng)");
}


/**
 * ═══════════ KHOÁ KHỞI ĐỘNG PHẢI CÓ ĐƯỜNG ĐI TỪ SECRET TỚI `.env` ═══════════
 *
 * ĐÃ CẮN THẬT — lượt chạy ops #1624. Chủ shop làm theo hướng dẫn của tôi và thao tác chết ngay:
 * `apply-tech-github-env` **không hề biết** `ERP_GITHUB_DISPATCH_TOKEN`, lại còn BẮT BUỘC phải có
 * khoá ĐỌC trước — nên người chỉ muốn khai khoá KHỞI ĐỘNG nhận một thông điệp nói về đúng thứ họ
 * không cần.
 *
 * Mã ứng dụng đòi biến ấy (`canDispatchTask` báo thiếu nó), nhưng KHÔNG có đường nào đưa nó lên
 * máy chủ. Một biến được đòi mà không có đường khai là một biến không bao giờ được khai.
 *
 * Bài này nối hai đầu lại: tên biến mà mã đòi PHẢI xuất hiện đủ ba chặng của workflow ops —
 * nhận từ Secret · truyền qua SSH · ghi vào `.env`.
 */
export function testDuongKhaiKhoaKhoiDong() {
  const wf = readFileSync(path.join(goc, ".github/workflows/ops-vps.yml"), "utf8");
  const than = wf.split("\n").filter((d) => !d.trimStart().startsWith("#")).join("\n");
  const TEN = "ERP_GITHUB_DISPATCH_TOKEN";

  // Ba chặng: nhận từ Secret · truyền qua SSH · ghi vào `.env`. Thiếu một chặng là biến không tới nơi.
  assert.ok(than.includes(TEN + ': ${{ secrets.' + TEN + ' }}'), `workflow phải nhận Secret ${TEN}`);
  const dongEnvs = than.split("\n").find((d) => d.trimStart().startsWith("envs:") && d.includes("ERP_GITHUB_TOKEN"));
  assert.ok(dongEnvs?.includes(TEN), `${TEN} phải nằm trong danh sách envs truyền qua SSH — thiếu thì nó không tới máy chủ`);
  assert.ok(than.includes("upsert_env " + TEN), `phải GHI ${TEN} vào .env`);

  /*
    VÀ KHÔNG KHOÁ NÀO ĐƯỢC BẮT BUỘC PHẢI CÓ KHOÁ KIA.

    Hai khoá phục vụ hai việc khác nhau (ĐỌC lượt deploy · KHỞI ĐỘNG workflow). Bắt buộc có khoá
    này mới khai được khoá kia là dựng một phụ thuộc không có thật — và nó đã chặn chủ shop thật
    ở lượt chạy ops #1624.
  */
  assert.ok(
    than.includes('[ -z "${ERP_GITHUB_TOKEN:-}" ] && [ -z "${' + TEN + ':-}" ]'),
    "chỉ được dừng khi THIẾU CẢ HAI khoá",
  );

  /*
    GIÁ TRỊ KHOÁ KHÔNG BAO GIỜ ĐƯỢC IN — kho PUBLIC, log Actions ai cũng đọc. Chỉ ĐỘ DÀI.
  */
  assert.ok(than.includes("${#" + TEN + "}"), "phải in ĐỘ DÀI khoá để biết đã ghi được chưa");
  const dongIn = than.split("\n").filter((d) => d.includes("echo") && d.includes("$" + TEN) && !d.includes("${#" + TEN + "}"));
  assert.deepEqual(dongIn, [], "KHÔNG dòng echo nào được chạm vào GIÁ TRỊ khoá");
}

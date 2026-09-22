import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { readAgentTask } from "@/lib/tech/agent-task-read";

/**
 * ═══════════ NẤC 3B · CỬA ĐỌC HẸP — AGENT NHẬN ĐÚNG VIỆC ĐƯỢC GIAO ═══════════
 *
 * Nấc 3 để lại một chỗ hở và đã NÓI RA: `agent-run.yml` tự tạo việc R0 của riêng nó, nên bấm
 * "khởi động lượt chạy" ở `TECH-12` không làm `TECH-12`. Nấc này đóng chỗ hở ấy.
 *
 * Truyền nội dung việc qua `inputs` của `workflow_dispatch` thì KHÔNG được — kho PUBLIC và đầu
 * vào dispatch hiện nguyên văn trong giao diện Actions. Nên việc đi qua một cửa ĐỌC, đối xứng với
 * cửa GHI và dùng chung khoá.
 *
 * Bài này khoá ba tính chất, và tính chất thứ hai là tính chất dễ mất nhất:
 *
 *   1. Cửa đọc KHÔNG rộng hơn cổng giao việc — cùng bộ luật, không phải hai bản sao.
 *   2. Nó trả về ĐÚNG những trường đã khai, không phải "cả dòng cho tiện".
 *   3. Việc lạ và việc không được giao trả CÙNG một câu ở tầng HTTP.
 */

const goc = path.resolve(__dirname, "..");
const TIEN_TO = "rd-";

export async function testAgentTaskRead() {
  const db = await getDb();
  await cleanupAgentTaskReadFixtures();

  const [ag] = await db.insert(schema.techAgents).values({ key: `${TIEN_TO}doc`, name: "rd-doc", role: "DOCUMENTATION", enabled: true, allowedRisks: ["R0"] }).returning({ id: schema.techAgents.id });
  const [agTat] = await db.insert(schema.techAgents).values({ key: `${TIEN_TO}tat`, name: "rd-tat", role: "QA", enabled: false }).returning({ id: schema.techAgents.id });

  await db.insert(schema.techTasks).values({ code: "RD-1", title: "rd-việc hợp lệ", description: "mô tả", status: "TRIAGED", risk: "R0", agentId: ag.id, taskType: "DOCS", module: "TECH" });
  await db.insert(schema.techTasks).values({ code: "RD-2", title: "rd-chưa phân loại", status: "NEW", risk: "R0", agentId: ag.id });
  await db.insert(schema.techTasks).values({ code: "RD-3", title: "rd-chờ duyệt", status: "TRIAGED", risk: "R1", agentId: ag.id, approvalRequired: true, approvalStatus: "PENDING" });
  await db.insert(schema.techTasks).values({ code: "RD-4", title: "rd-vai tắt", status: "TRIAGED", risk: "R0", agentId: agTat.id });
  await db.insert(schema.techTasks).values({ code: "RD-5", title: "rd-chưa gán ai", status: "TRIAGED", risk: "R0" });

  /* ───────── 1 · VIỆC HỢP LỆ: TRẢ VỀ ĐÚNG NHỮNG TRƯỜNG ĐÃ KHAI ───────── */
  const ok = await readAgentTask("RD-1");
  assert.ok("ok" in ok && ok.ok, `việc hợp lệ phải đọc được: ${"error" in ok ? ok.error : ""}`);
  if (!("ok" in ok)) return;
  assert.equal(ok.task.code, "RD-1");
  assert.equal(ok.task.agentKey, `${TIEN_TO}doc`);
  assert.deepEqual([...ok.task.writeGlobs], ["docs/"], "phải kèm phạm vi ghi của VAI để runner dựng đúng hàng rào");
  /*
    MỨC CHỦ SHOP ĐÃ CẤP CŨNG PHẢI ĐI KÈM.

    Runner chạy trên CSDL PGlite dùng-một-lần, gieo từ `TECH_AGENT_TEMPLATES` — tức mang mức của
    MÃ NGUỒN, không mang mức của PRODUCTION. Thiếu trường này thì một vai được chủ shop cấp R2 vẫn
    bị chính runner chặn bằng "chỉ được phép R0" (đo 22/09/2026 trên TECH-12).

    Đây là dữ liệu KHÔNG nhạy cảm: nó nói vai được phép làm gì, không nói việc có gì trong đó.
  */
  assert.deepEqual([...ok.task.agentAllowedRisks], ["R0"], "phải kèm mức chủ shop đã cấp cho vai — sổ cục bộ của runner không có nó");

  /*
    ───────── DANH SÁCH TRƯỜNG LÀ ĐÓNG ─────────

    Một cửa đọc trả "cả dòng cho tiện" sẽ rò rỉ MỌI cột được thêm vào bảng sau này — kể cả cột
    chưa tồn tại lúc viết cửa. Khoá danh sách ở đây thì ngày ai đó thêm một cột nhạy cảm, bài kiểm
    này không đổi và cửa vẫn hẹp.
  */
  assert.deepEqual(
    Object.keys(ok.task).sort(),
    ["agentAllowedRisks", "agentKey", "code", "description", "module", "risk", "taskType", "title", "writeGlobs"],
    "cửa đọc chỉ được trả về đúng danh sách trường đã khai",
  );
  for (const cam of ["approvalStatus", "approvedBy", "prUrl", "branch", "worktree", "createdBy", "blockedReason"]) {
    assert.ok(!(cam in ok.task), `KHÔNG được trả về trường “${cam}”`);
  }

  /* ───────── 2 · CỬA ĐỌC KHÔNG RỘNG HƠN CỔNG GIAO VIỆC ───────── */
  for (const [ma, vi] of [["RD-2", "chưa phân loại"], ["RD-3", "chờ duyệt"], ["RD-4", "vai đang tắt"], ["RD-5", "chưa gán agent"]] as const) {
    const r = await readAgentTask(ma);
    assert.ok("error" in r, `${vi} (${ma}) KHÔNG được đọc qua cửa này`);
    assert.ok("error" in r && r.code === "NOT_DISPATCHABLE", `${vi} phải trả NOT_DISPATCHABLE, nhận ${"error" in r ? r.code : "?"}`);
  }

  const la = await readAgentTask("RD-KHONG-CO");
  assert.ok("error" in la && la.code === "UNKNOWN_TASK", "việc lạ trả mã riêng — để LOG nói được chuyện gì");
  const rong = await readAgentTask("   ");
  assert.ok("error" in rong, "mã rỗng không đọc được");

  await cleanupAgentTaskReadFixtures();
}

export async function cleanupAgentTaskReadFixtures() {
  const db = await getDb();
  const viec = await db.query.techTasks.findMany({ where: like(schema.techTasks.code, "RD-%"), columns: { id: true } });
  if (viec.length) {
    await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, viec.map((v) => v.id)));
    await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, viec.map((v) => v.id)));
  }
  const vai = await db.query.techAgents.findMany({ where: like(schema.techAgents.key, `${TIEN_TO}%`), columns: { id: true } });
  if (vai.length) await db.delete(schema.techAgents).where(inArray(schema.techAgents.id, vai.map((v) => v.id)));
}

/* ═════════════ QUÉT MÃ NGUỒN ═════════════ */

export function testAgentTaskReadGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const route = bo(readFileSync(path.join(goc, "app/api/tech/agent-task/route.ts"), "utf8"));
  const svc = bo(readFileSync(path.join(goc, "lib/tech/agent-task-read.ts"), "utf8"));
  const wf = readFileSync(path.join(goc, ".github/workflows/agent-run.yml"), "utf8");
  const fetcher = bo(readFileSync(path.join(goc, "scripts/agent-fetch-task.ts"), "utf8"));

  /* ───────── CHỈ ĐỌC, VÀ CHỈ MỘT VIỆC ───────── */
  assert.ok(route.includes("export async function GET"), "cửa này là GET");
  assert.ok(!/export\s+(const|async\s+function)\s+POST\b/.test(route), "KHÔNG có POST — cửa ghi là một tuyến khác");
  assert.ok(!route.includes("getCurrentUser"), "không có đường phiên đăng nhập — đây là cửa máy-gọi-máy");
  assert.ok(!/limit|offset|page|list/i.test(route.replace(/rate[^\n]*/gi, "")), "KHÔNG phân trang, KHÔNG liệt kê — một cửa đọc liệt kê được là một cửa xuất dữ liệu");
  assert.ok(!route.includes('from "@/db"'), "route KHÔNG chạm thẳng CSDL");
  assert.ok(route.includes("secretEquals"), "phải so khoá bằng secretEquals");

  /*
    ───────── HAI CA HỎNG TRẢ CÙNG MỘT CÂU Ở TẦNG HTTP ─────────

    Trả 403 cho "có việc này nhưng chưa duyệt" và 404 cho "không có việc này" là biến cửa thành
    máy dò: gọi lần lượt TECH-1…TECH-500 là biết kho có bao nhiêu việc và việc nào đang chờ duyệt.
  */
  const soLanTraLoiHong = (route.match(/status:\s*404/g) ?? []).length;
  assert.equal(soLanTraLoiHong, 1, "chỉ MỘT câu trả lời cho cả hai ca hỏng");
  assert.ok(!/status:\s*403/.test(route), "KHÔNG phân biệt 403/404 — đó là kênh dò sự tồn tại của việc");

  /* ───────── DÙNG LẠI ĐÚNG BỘ LUẬT CỦA CỔNG GIAO VIỆC ───────── */
  assert.ok(svc.includes("canDispatchTask("), "cửa đọc phải dùng LẠI luật của cổng giao việc, không viết bản sao");

  /* ───────── WORKFLOW NHẬN MÃ VIỆC, KHÔNG NHẬN NỘI DUNG ───────── */
  /*
    ĐỌC ĐÚNG TÊN ĐẦU VÀO, KHÔNG DÒ CHỮ TRONG CẢ KHỐI.

    Bản đầu của bộ gác này tìm chuỗi "description:" trong khối `inputs:` và lập tức kêu nhầm: đó
    là KHOÁ CỦA GITHUB (nhãn mô tả ô nhập), không phải một đầu vào TÊN `description`. Một bộ gác
    kêu nhầm là một bộ gác người ta tắt đi — nên nó phải đọc đúng thứ nó định đọc.

    Tên đầu vào nằm ở mức thụt 6 dấu cách ngay dưới `inputs:`; khoá con của mỗi đầu vào thụt 8.
  */
  const khoiInputs = wf.slice(wf.indexOf("    inputs:"), wf.indexOf("permissions:"));
  const mauTen = new RegExp("^ {6}([a-z_][a-z0-9_]*):" + String.raw`\s*$`);
  const tenDauVao = khoiInputs
    .split("\n")
    .map((d) => mauTen.exec(d)?.[1])
    .filter((x): x is string => Boolean(x));
  assert.ok(tenDauVao.includes("task"), `workflow phải nhận mã việc, hiện có: ${tenDauVao.join(", ")}`);
  for (const cam of ["title", "description", "body", "prompt"]) {
    assert.ok(!tenDauVao.includes(cam), `workflow KHÔNG được có đầu vào tên “${cam}” — kho PUBLIC, đầu vào dispatch hiện nguyên văn trong giao diện Actions`);
  }
  assert.ok(wf.includes("agent:fetch-task"), "workflow phải gọi bước lấy việc");
  assert.ok(wf.includes("agent:proof-setup"), "…và giữ đường cũ khi không truyền mã việc");

  /*
    ───────── RUNNER KIỂM LẠI RỦI RO, KHÔNG TIN LỜI ERP ─────────
    Một gói tin bị sửa trên đường không được nâng quyền của lượt chạy.
  */
  assert.ok(fetcher.includes("classifyTechRisk("), "runner phải tự xếp lại rủi ro trên dữ liệu nhận được");
  assert.ok(fetcher.includes('tuXep.risk !== viec.risk'), "…và DỪNG nếu hai bên xếp khác nhau");
  assert.ok(/R2/.test(fetcher), "…và chặn R2 một lần nữa ở phía runner");

  console.log("✓ Cửa đọc việc (Nấc 3b): chỉ GET một việc, không liệt kê · 8 trường đã khai, không trả cả dòng · không rộng hơn cổng giao việc · việc lạ và việc chưa duyệt CÙNG một câu 404 · workflow nhận MÃ chứ không nhận nội dung · runner tự xếp lại rủi ro");
}

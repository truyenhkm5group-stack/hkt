import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_LABEL, resolvePermissions } from "@/lib/auth/permissions";
import {
  TECH_AGENT_TEMPLATES,
  TECH_TASK_OPEN,
  TECH_TASK_STATUSES,
  TECH_TASK_TERMINAL,
  TECH_TASK_TRANSITIONS,
  canTransitionTechIncident,
  canTransitionTechTask,
  techDeployBlockers,
  techIncidentCloseBlockers,
  type TechTaskStatus,
} from "@/lib/constants/tech";
import { TECH_RISK_RULES, classifyTechRisk } from "@/lib/constants/tech-risk";
import { commitMatches, parseHealthPayload } from "@/lib/tech/health-parse";
import { worstHealth } from "@/lib/queries/tech-health";
import { listTechTasks, techOverviewCounts, techTaskFacets } from "@/lib/queries/tech";
import { listTechAgents } from "@/lib/queries/tech-agents";
import { listTechIncidents } from "@/lib/queries/tech-ops";
import {
  assignTechTaskAgent,
  createTechIncident,
  createTechTask,
  decideTechApproval,
  finishTechAgentRun,
  overrideTechTaskRisk,
  recordTechDeployment,
  seedTechAgents,
  setTechAgentEnabled,
  setTechIncidentStatus,
  setTechTaskStatus,
  startTechAgentRun,
  verifyTechTaskOnProduction,
  type TechActor,
} from "@/lib/tech/service";
import type { ListParams } from "@/lib/search-params";

/**
 * ═══════════ PHÒNG TECH AI — MẶT PHẲNG ĐIỀU KHIỂN (Phase 1) ═══════════
 *
 * Bài này khoá đúng những chỗ mà một mặt phẳng điều khiển thường nói dối:
 *
 *  1. Vòng đời việc đi theo LUẬT, và bấm hai lần không đẻ ra hai dòng lịch sử.
 *  2. Cổng phê duyệt của người KHÔNG lách được — kể cả bằng cách hạ mức rủi ro hay giao cho agent.
 *  3. Luật rủi ro chỉ NÂNG, và mọi luật đều giải thích được.
 *  4. CHƯA BIẾT không bao giờ hiện ra thành "khoẻ" hay "đã đạt".
 *  5. Quyền Tech không rơi vào tay vai trò nào qua cửa sau.
 *
 * TẤT CẢ MỐC THỜI GIAN ĐI THEO ĐỒNG HỒ THẬT (AGENTS.md mục 50): không ghim một ngày tuyệt đối rồi
 * gieo dữ liệu tương đối so với nó. Dữ liệu tự dọn bằng tiền tố `tech-t-`.
 */

const goc = path.resolve(__dirname, "..");
const doc = (p: string) => readFileSync(path.join(goc, p), "utf8");

const KY_TOAN_BO: ListParams["period"] = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

function thamSo(over: Partial<ListParams> = {}): ListParams {
  return { page: 1, pageSize: 50, sort: "createdAt", dir: "desc", q: "", filters: {}, period: KY_TOAN_BO, ...over };
}

/* ═════════════════════ 1. TỪ VỰNG & VÒNG ĐỜI (hàm thuần) ═════════════════════ */

export function testTechLifecycle() {
  // ───────── 1.1 Mọi trạng thái đều đi tới được từ trạng thái đầu ─────────
  // Một trạng thái không trạng thái nào dẫn tới là một trạng thái CHẾT: nó tồn tại trong bảng nhãn,
  // hiện trong bộ lọc, và không bao giờ có dòng nào mang nó.
  const toiDuoc = new Set<TechTaskStatus>(["NEW"]);
  for (let vong = 0; vong < TECH_TASK_STATUSES.length; vong += 1) {
    for (const from of [...toiDuoc]) for (const to of TECH_TASK_TRANSITIONS[from]) toiDuoc.add(to);
  }
  const chet = TECH_TASK_STATUSES.filter((s) => !toiDuoc.has(s));
  assert.deepEqual(chet, [], `trạng thái không bao giờ tới được từ NEW: ${chet.join(", ")}`);

  // ───────── 1.2 Chỉ DONE là trạng thái kết thúc ─────────
  assert.deepEqual(TECH_TASK_TERMINAL, ["DONE"], "chỉ 'Xong' mới là trạng thái kết thúc");
  assert.ok(!TECH_TASK_OPEN.includes("DONE"), "DONE không nằm trong nhóm 'còn mở'");
  for (const s of ["FAILED", "ROLLED_BACK", "BLOCKED"] as TechTaskStatus[]) {
    assert.ok(TECH_TASK_OPEN.includes(s), `${s} phải VẪN ĐẾM là việc còn mở — một việc thất bại là việc chưa xong`);
  }

  // ───────── 1.3 Không có đường tắt tới deploy ─────────
  for (const from of TECH_TASK_STATUSES) {
    if (from === "READY_TO_DEPLOY") continue;
    assert.ok(!canTransitionTechTask(from, "DEPLOYING"), `${from} không được nhảy thẳng sang DEPLOYING — chỉ đi qua 'Sẵn sàng deploy'`);
  }
  assert.ok(canTransitionTechTask("READY_TO_DEPLOY", "DEPLOYING"));
  // Và không đường nào nhảy thẳng tới DONE ngoài quan sát sau deploy.
  for (const from of TECH_TASK_STATUSES) {
    if (from === "OBSERVING") continue;
    assert.ok(!canTransitionTechTask(from, "DONE"), `${from} không được nhảy thẳng sang DONE`);
  }

  // ───────── 1.4 Tự-chuyển KHÔNG hợp lệ ở tầng luật ─────────
  // Tầng dịch vụ chặn nó SỚM HƠN bằng nhánh "bỏ qua, không ghi gì" (mục 61); ở đây chỉ khoá rằng
  // bảng luật không bao giờ tự sinh ra một vòng lặp tại chỗ.
  for (const s of TECH_TASK_STATUSES) assert.ok(!canTransitionTechTask(s, s), `${s} → ${s} không được là một phép chuyển hợp lệ`);

  // ───────── 1.5 Cổng deploy ─────────
  assert.deepEqual(techDeployBlockers({ approvalRequired: false, approvalStatus: "NOT_REQUIRED", risk: "R1" }), [], "việc không cần duyệt thì không bị chặn");
  assert.equal(techDeployBlockers({ approvalRequired: true, approvalStatus: "PENDING", risk: "R2" }).length, 1, "R2 chờ duyệt phải bị chặn");
  assert.equal(techDeployBlockers({ approvalRequired: true, approvalStatus: "REJECTED", risk: "R2" }).length, 1, "R2 bị từ chối phải bị chặn");
  assert.deepEqual(techDeployBlockers({ approvalRequired: true, approvalStatus: "APPROVED", risk: "R2" }), [], "R2 đã duyệt thì đi tiếp được");
  assert.ok(
    techDeployBlockers({ approvalRequired: true, approvalStatus: "REJECTED", risk: "R2" })[0].includes("từ chối"),
    "cổng phải nói LÝ DO chặn, không chỉ nói 'không'",
  );

  // ───────── 1.6 Vòng đời sự cố ─────────
  assert.ok(canTransitionTechIncident("MONITORING", "INVESTIGATING"), "sự cố tái phát quay lại điều tra được — không mở sự cố mới");
  assert.ok(!canTransitionTechIncident("RESOLVED", "OPEN"), "sự cố đã đóng không mở lại — mở lại là làm mất dòng thời gian của lần đầu");
  assert.equal(techIncidentCloseBlockers({ resolution: "" }).length, 1, "đóng sự cố mà không kể đã làm gì phải bị chặn");
  assert.deepEqual(techIncidentCloseBlockers({ resolution: "Đã revert commit abc1234 và deploy lại lúc 15:02" }), [], "kể được đã làm gì thì đóng được");

  console.log(`✓ Vòng đời Tech: ${TECH_TASK_STATUSES.length} trạng thái, mọi trạng thái tới được, chỉ DONE kết thúc, không đường tắt tới deploy, cổng phê duyệt nói được lý do`);
}

/* ═════════════════════ 2. MÁY XẾP RỦI RO ═════════════════════ */

export function testTechRiskEngine() {
  // ───────── 2.1 Chạm sự thật kinh doanh ⇒ R2 + bắt buộc phê duyệt ─────────
  const luong = classifyTechRisk({ taskType: "BUGFIX", module: "PAYROLL", title: "Sửa cột lương cứng" });
  assert.equal(luong.risk, "R2", "việc chạm lương phải là R2");
  assert.equal(luong.requiresApproval, true, "R2 bắt buộc chủ shop phê duyệt");
  assert.ok(luong.reasons.length > 0, "phải nói được VÌ SAO là R2");

  const outcome = classifyTechRisk({ taskType: "REFACTOR", module: "PLATFORM", title: "Dọn lại biểu thức ORDER_OUTCOME cho dễ đọc" });
  assert.equal(outcome.risk, "R2", "chạm ORDER_OUTCOME là R2 kể cả khi module khai là PLATFORM — luật bắt cả theo từ khoá");

  // Không dấu vẫn phải bắt được: người gõ việc thường gõ nhanh, không bỏ dấu.
  const khongDau = classifyTechRisk({ taskType: "BUGFIX", module: "PLATFORM", title: "Sua lai cach tinh ton kho cho dung" });
  assert.equal(khongDau.risk, "R2", "luật từ khoá phải khớp cả chuỗi không dấu");

  // ───────── 2.2 Luật chỉ NÂNG, không bao giờ hạ ─────────
  // Một việc `DOCS` (tự nó R0) mà đụng vào lương thì vẫn phải là R2.
  const tailieuLuong = classifyTechRisk({ taskType: "DOCS", module: "PAYROLL", title: "Viết lại tài liệu cách tính lương" });
  assert.equal(tailieuLuong.risk, "R2", "loại việc nhẹ KHÔNG hạ được mức của một luật nặng");

  // ───────── 2.3 Không luật nào khớp ⇒ R0, và R0 nói đúng nghĩa của nó ─────────
  const nhe = classifyTechRisk({ taskType: "DOCS", module: "TECH", title: "Ghi lại quy ước đặt tên nhánh" });
  assert.equal(nhe.risk, "R0");
  assert.equal(nhe.requiresApproval, false);
  assert.deepEqual(nhe.rules, [], "không luật nào khớp thì danh sách luật phải RỖNG — không bịa ra một luật để giải thích");

  // ───────── 2.4 Hàm THUẦN: chạy hai lần ra đúng một kết quả ─────────
  const a = classifyTechRisk({ taskType: "MIGRATION", module: "ORDERS", title: "Thêm cột" });
  const b = classifyTechRisk({ taskType: "MIGRATION", module: "ORDERS", title: "Thêm cột" });
  assert.deepEqual(a, b, "máy xếp rủi ro phải là hàm thuần — hai lượt chạy ra hai kết quả là một cổng không tin được");

  // ───────── 2.5 Mọi luật đều giải thích được ─────────
  for (const rule of TECH_RISK_RULES) {
    assert.ok(rule.why.length > 30, `luật ${rule.key} phải nói được vì sao chạm vào đây là rủi ro`);
    assert.ok(rule.modules?.length || rule.taskTypes?.length || rule.keywords?.length, `luật ${rule.key} không có điều kiện nào thì không bao giờ khớp`);
  }

  // ───────── 2.6 Mười một vùng sự thật của AGENTS.md đều có luật R2 canh ─────────
  const r2 = new Set(TECH_RISK_RULES.filter((r) => r.risk === "R2").map((r) => r.key));
  for (const khoa of ["ORDER_OUTCOME", "PAYROLL", "PROFIT", "INVENTORY_TRUTH", "ACCESS", "MIGRATION", "DATA_FIX", "SCHEDULER", "SECRETS", "COD_MONEY", "CARRIER_TRUTH"]) {
    assert.ok(r2.has(khoa), `thiếu luật R2 cho vùng ${khoa} — vùng sự thật không có cổng là vùng sẽ bị sửa không ai biết`);
  }

  console.log(`✓ Máy xếp rủi ro: ${TECH_RISK_RULES.length} luật (${r2.size} luật R2), chỉ nâng không hạ, hàm thuần, mọi luật giải thích được`);
}

/* ═════════════════════ 3. QUYỀN ═════════════════════ */

export function testTechPermissions() {
  assert.ok((ALL_PERMISSIONS as string[]).includes("tech:view"), "khoá tech:view phải có trong ma trận quyền");
  assert.ok((ALL_PERMISSIONS as string[]).includes("tech:manage"), "khoá tech:manage phải có trong ma trận quyền");
  assert.ok(PERMISSION_LABEL["tech:view"]?.length > 3 && PERMISSION_LABEL["tech:manage"]?.length > 3, "cả hai khoá phải có nhãn tiếng Việt");

  // ───────── Không vai trò nào ngoài ADMIN có quyền Tech theo mặc định ─────────
  // Mẫu của MANAGER dựng bằng phép TRỪ, nên một khoá mới lọt vào đó MÀ KHÔNG AI QUYẾT ĐỊNH là
  // cách nguy hiểm nhất để một quyền xuất hiện (xem ghi chú dài ở lib/auth/permissions.ts).
  for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as Role[]) {
    if (role === "ADMIN") continue;
    assert.ok(!DEFAULT_ROLE_PERMISSIONS[role].includes("tech:manage"), `vai trò ${role} KHÔNG được có tech:manage theo mặc định`);
    assert.ok(!DEFAULT_ROLE_PERMISSIONS[role].includes("tech:view"), `vai trò ${role} KHÔNG được có tech:view theo mặc định`);
  }
  assert.ok(resolvePermissions("ADMIN", null, null, null).includes("tech:manage"), "quản trị viên luôn có toàn quyền Tech");

  // Một tài khoản có DANH SÁCH QUYỀN RIÊNG lưu từ trước cũng không được tự nhận quyền Tech: khoá
  // mới chỉ rơi về mẫu VAI TRÒ, mà mẫu vai trò không có nó.
  const tuyChinh = resolvePermissions("MANAGER", ["dashboard:view", "orders:read"], null, null);
  assert.ok(!tuyChinh.includes("tech:manage"), "quyền Tech không được rơi vào tài khoản có danh sách quyền riêng");

  // ───────── Mọi trang /tech phải tự kiểm quyền, không dựa vào menu ─────────
  // Menu ẩn không khoá được đường dẫn: gõ thẳng `/tech/tasks` vẫn mở được nếu trang không hỏi quyền.
  for (const tuyen of ["", "/tasks", "/tasks/[id]", "/agents", "/deployments", "/incidents", "/incidents/[id]"]) {
    const src = doc(`app/(dashboard)/tech${tuyen}/page.tsx`);
    assert.match(src, /requirePermission\("tech:view"\)/, `app/(dashboard)/tech${tuyen}/page.tsx phải gọi requirePermission("tech:view")`);
  }

  // ───────── Mọi server action ghi phải kiểm `tech:manage` VÀ ghi nhật ký ─────────
  const actions = doc("lib/actions/tech.ts");
  assert.match(actions, /can\(user, "tech:manage"\)/, "lớp hành động phải kiểm tech:manage");
  const tenHam = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(tenHam.length >= 10, `đọc hụt danh sách hành động (chỉ thấy ${tenHam.length})`);
  for (const ten of tenHam) {
    const than = actions.slice(actions.indexOf(`export async function ${ten}(`));
    const ketThuc = than.indexOf("\nexport async function ");
    const doan = ketThuc > 0 ? than.slice(0, ketThuc) : than;
    assert.match(doan, /nguoiQuanTri\(\)/, `${ten} phải đi qua cổng quyền`);
    assert.match(doan, /audit\(\{/, `${ten} phải ghi nhật ký — thiếu nó thì sau này không ai trả lời được "ai sửa cái này"`);
  }

  console.log(`✓ Quyền Tech: hai khoá có nhãn, không vai trò nào ngoài ADMIN nhận theo mặc định, ${tenHam.length} hành động đều kiểm quyền và ghi nhật ký`);
}

/* ═════════════════════ 4. ĐỌC PHONG BÌ HEALTH & TRẠNG THÁI CHƯA BIẾT ═════════════════════ */

export function testTechHealthParsing() {
  // ───────── 4.1 Bốn tình huống, không phải hai ─────────
  const up = parseHealthPayload(JSON.stringify({ ok: true, time: "2026-09-18T03:00:00.000Z", commit: "abc1234def", branch: "main" }));
  assert.equal(up.reach, "UP");
  assert.equal(up.commit, "abc1234def");
  assert.equal(up.branch, "main");
  assert.ok(up.time instanceof Date);

  const down = parseHealthPayload(JSON.stringify({ ok: false, error: "connect ECONNREFUSED", commit: "abc1234def" }), 500);
  assert.equal(down.reach, "DOWN", "máy chủ tự báo hỏng là DOWN — khác hẳn không gọi tới được");
  assert.ok(down.detail.includes("ECONNREFUSED"), "phải giữ nguyên lý do máy chủ đưa ra");

  assert.equal(parseHealthPayload(null).reach, "UNREACHABLE", "không nhận được gì là UNREACHABLE");
  const la = parseHealthPayload("<!doctype html><html>Đăng nhập", 200);
  assert.equal(la.reach, "UNREADABLE", "nhận được HTML là UNREADABLE — KHÔNG được nuốt thành 'không gọi tới được'");
  assert.notEqual(la.reach, "UNREACHABLE", "hai tình huống này sửa ở hai chỗ khác nhau nên không được gộp");
  assert.equal(parseHealthPayload(JSON.stringify({ time: "x" })).reach, "UNREADABLE", "JSON thiếu cờ ok thì không kết luận được");

  // ───────── 4.2 "unknown" của /api/health đọc lại thành null, không thành một chuỗi ─────────
  const chuaBiet = parseHealthPayload(JSON.stringify({ ok: true, commit: "unknown", branch: "unknown" }));
  assert.equal(chuaBiet.commit, null, "'unknown' phải đọc ra thành CHƯA BIẾT, không phải một commit tên là 'unknown'");
  assert.equal(chuaBiet.branch, null);
  assert.ok(chuaBiet.detail.includes("KHÔNG khai commit"), "phải nói rõ là không đối chiếu được với Git");

  // ───────── 4.3 So commit: thiếu một vế thì KHÔNG kết luận ─────────
  assert.equal(commitMatches(null, "abc1234"), null, "chưa biết bản đang chạy thì không kết luận khớp/lệch");
  assert.equal(commitMatches("abc1234", null), null);
  assert.equal(commitMatches(null, null), null, "hai vế cùng trống KHÔNG phải là 'khớp' — đây là chỗ dễ nói dối nhất");
  assert.equal(commitMatches("abc1234def", "abc1234"), true, "so theo độ dài chung: SHA ngắn khớp SHA dài");
  assert.equal(commitMatches("abc1234def", "zzz9999"), false);

  // ───────── 4.4 Mức tổng = mức XẤU NHẤT, và UNKNOWN xếp trên HEALTHY ─────────
  assert.equal(worstHealth(["HEALTHY", "HEALTHY"]), "HEALTHY");
  assert.equal(worstHealth(["HEALTHY", "UNKNOWN"]), "UNKNOWN", "một tín hiệu chưa xác minh KHÔNG được biến bảng thành màu xanh");
  assert.equal(worstHealth(["HEALTHY", "UNKNOWN", "DEGRADED"]), "DEGRADED");
  assert.equal(worstHealth(["DEGRADED", "DOWN", "HEALTHY"]), "DOWN", "một chỗ hỏng là hệ thống hỏng — không lấy trung bình");
  assert.equal(worstHealth([]), "HEALTHY");

  console.log("✓ Sức khoẻ: bốn tình huống tách riêng, 'unknown' đọc thành CHƯA BIẾT, so commit thiếu vế thì trả null, mức tổng lấy xấu nhất");
}

/* ═════════════════════ 5. ĐƯỜNG GHI THẬT (CSDL) ═════════════════════ */

export async function testTechControlPlaneDb() {
  const db = await getDb();

  const [nguoi] = await db
    .insert(schema.users)
    .values({ id: "tech-t-user", email: "tech-t@shop.vn", name: "Chủ shop (kiểm thử)", passwordHash: "x", role: "ADMIN" })
    .onConflictDoNothing()
    .returning({ id: schema.users.id });
  const userId = nguoi?.id ?? "tech-t-user";
  const chuShop: TechActor = { kind: "HUMAN", id: userId, name: "Chủ shop (kiểm thử)" };
  const may: TechActor = { kind: "SYSTEM", name: "job:tech-test" };

  /* ───────── 5.1 Sổ agent KHÔNG tự đầy, và bấm lại không bật lại thứ đã tắt ───────── */
  const seed1 = await seedTechAgents(chuShop);
  assert.ok("ok" in seed1 && seed1.created === TECH_AGENT_TEMPLATES.length, "lượt khởi tạo đầu tiên phải thêm đủ bản khai");
  const sau1 = await listTechAgents();
  assert.equal(
    sau1.filter((a) => a.enabled).length,
    0,
    "MỌI agent phải sinh ra ở trạng thái TẮT — một agent bật sẵn lúc cài đặt là agent chưa ai quyết định cho chạy",
  );
  const seed2 = await seedTechAgents(chuShop);
  assert.ok("ok" in seed2 && seed2.created === 0, "bấm lại KHÔNG được nhân đôi sổ agent");

  const backend = sau1.find((a) => a.key === "backend");
  assert.ok(backend, "bản khai phải có agent backend");
  const devops = sau1.find((a) => a.key === "devops");
  assert.ok(devops, "bản khai phải có agent vận hành");

  // Máy KHÔNG khởi tạo được sổ: đây là quyết định của người.
  const seedMay = await seedTechAgents(may);
  assert.ok("error" in seedMay, "chỉ NGƯỜI mới khởi tạo được sổ agent");

  // Phase 1 không agent nào mang quyền merge / deploy / ghi production.
  for (const t of TECH_AGENT_TEMPLATES) {
    assert.equal(t.canMerge, false, `${t.key}: Phase 1 chưa có máy thi hành nên không được khai quyền merge`);
    assert.equal(t.canDeploy, false, `${t.key}: Phase 1 chưa có máy thi hành nên không được khai quyền deploy`);
    assert.equal(t.canRunProdWrite, false, `${t.key}: Phase 1 KHÔNG cho agent ghi vào production`);
    assert.ok(!t.allowedRisks.includes("R2"), `${t.key}: không mẫu nào được phép chạm việc R2 ở Phase 1`);
  }

  await setTechAgentEnabled({ agentId: backend.id, enabled: true }, chuShop);

  /* ───────── 5.2 Tạo việc: máy xếp rủi ro và bật cổng phê duyệt ───────── */
  const r2 = await createTechTask(
    {
      title: "tech-t-lương: cột lương cứng lệch 240.000đ so với sổ ngân hàng",
      description: "Đối chiếu kỳ 09/2026",
      taskType: "BUGFIX",
      module: "PAYROLL",
      priority: "P1",
      source: "OWNER",
    },
    chuShop,
  );
  assert.ok("ok" in r2, "phải tạo được việc");
  const r2Id = "ok" in r2 ? r2.id : "";
  assert.ok("ok" in r2 && r2.risk === "R2", "việc chạm lương phải tự động thành R2");
  assert.match("ok" in r2 ? r2.code : "", /^TECH-\d+$/, "mã việc phải đọc được");

  const r0 = await createTechTask(
    { title: "tech-t-tài liệu: ghi lại quy ước đặt tên nhánh", taskType: "DOCS", module: "TECH", priority: "P3", source: "STAFF" },
    chuShop,
  );
  assert.ok("ok" in r0 && r0.risk === "R0", "việc tài liệu không chạm gì phải là R0");
  const r0Id = "ok" in r0 ? r0.id : "";

  const taoR2 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r2Id) });
  assert.ok(taoR2?.approvalRequired && taoR2.approvalStatus === "PENDING", "R2 phải ở trạng thái chờ chủ shop duyệt ngay từ lúc tạo");
  const taoR0 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r0Id) });
  assert.ok(!taoR0?.approvalRequired && taoR0?.approvalStatus === "NOT_REQUIRED", "R0 không dựng ra một cổng phê duyệt giả");

  // Nhật ký bắt đầu ngay từ lúc tạo, và ghi rõ AI tạo.
  const suKienTao = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, r2Id) });
  assert.equal(suKienTao.length, 1, "tạo việc phải để lại đúng MỘT mốc");
  assert.equal(suKienTao[0].kind, "CREATE");
  assert.equal(suKienTao[0].actorKind, "HUMAN");
  assert.equal(suKienTao[0].actorId, userId, "quy kết đi bằng KHOÁ TÀI KHOẢN, không phải ô chữ (AGENTS.md mục 34)");

  /* ───────── 5.3 Vòng đời: phép chuyển sai bị chặn, bấm hai lần không ghi gì ───────── */
  const sai = await setTechTaskStatus({ taskId: r2Id, to: "DEPLOYING" }, chuShop);
  assert.ok("error" in sai, "NEW không nhảy thẳng sang DEPLOYING được");

  await setTechTaskStatus({ taskId: r2Id, to: "TRIAGED" }, chuShop);
  const lai = await setTechTaskStatus({ taskId: r2Id, to: "TRIAGED" }, chuShop);
  assert.ok("ok" in lai && lai.skipped === true, "bấm lại đúng trạng thái đang có phải BỎ QUA");
  const demSuKien = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, r2Id) });
  assert.equal(demSuKien.length, 2, "bấm hai lần KHÔNG được đẻ ra hai dòng lịch sử (AGENTS.md mục 61)");

  // BLOCKED phải nói bị chặn bởi cái gì.
  const chanThieuLyDo = await setTechTaskStatus({ taskId: r2Id, to: "BLOCKED" }, chuShop);
  assert.ok("error" in chanThieuLyDo, "báo bị chặn mà không nói vì sao phải bị từ chối");
  await setTechTaskStatus({ taskId: r2Id, to: "BLOCKED", note: "Chờ chủ shop xác nhận con số đúng là bao nhiêu" }, chuShop);
  const daChan = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r2Id), columns: { blockedReason: true, status: true } });
  assert.equal(daChan?.status, "BLOCKED");
  assert.ok((daChan?.blockedReason ?? "").length > 5, "lý do bị chặn phải được lưu");

  /* ───────── 5.4 Cổng phê duyệt KHÔNG lách được ───────── */
  for (const b of ["BUILDING", "REVIEW", "QA", "READY_TO_DEPLOY"] as TechTaskStatus[]) {
    const r = await setTechTaskStatus({ taskId: r2Id, to: b }, chuShop);
    assert.ok("ok" in r, `phải đi được tới ${b}`);
  }
  const chanDeploy = await setTechTaskStatus({ taskId: r2Id, to: "DEPLOYING" }, chuShop);
  assert.ok("error" in chanDeploy && chanDeploy.error.includes("phê duyệt"), "việc R2 chưa duyệt KHÔNG vào được bước deploy");

  // Máy KHÔNG tự duyệt được cho mình.
  const mayDuyet = await decideTechApproval({ taskId: r2Id, decision: "APPROVED" }, may);
  assert.ok("error" in mayDuyet, "chỉ NGƯỜI mới phê duyệt được — nếu không thì cổng chỉ là trang trí");

  // Và máy cũng KHÔNG hạ được mức rủi ro để đi vòng qua cổng.
  const mayHa = await overrideTechTaskRisk({ taskId: r2Id, risk: "R0", reason: "việc này nhẹ thôi, tôi làm nhanh" }, may);
  assert.ok("error" in mayHa, "máy hạ mức rủi ro của chính việc mình làm là tự mở cổng bằng cửa sau");

  await decideTechApproval({ taskId: r2Id, decision: "APPROVED", note: "Chủ shop đã xem số đối chiếu" }, chuShop);
  const daDuyet = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r2Id) });
  assert.equal(daDuyet?.approvalStatus, "APPROVED");
  assert.equal(daDuyet?.approvedBy, userId, "chữ ký đi bằng khoá tài khoản");
  assert.ok(daDuyet?.approvedAt, "phải có mốc phê duyệt");

  const quaCong = await setTechTaskStatus({ taskId: r2Id, to: "DEPLOYING" }, chuShop);
  assert.ok("ok" in quaCong, "đã duyệt thì đi tiếp được");

  /* ───────── 5.5 Giao việc cho agent: chặn theo mức rủi ro được phép ───────── */
  const giaoSai = await assignTechTaskAgent({ taskId: r2Id, agentId: backend.id }, chuShop);
  assert.ok("error" in giaoSai, "agent chưa được phép chạm R2 thì không nhận được việc R2");
  const giaoTat = await assignTechTaskAgent({ taskId: r0Id, agentId: devops.id }, chuShop);
  assert.ok("error" in giaoTat, "agent đang TẮT thì không nhận được việc nào");
  const giaoDung = await assignTechTaskAgent({ taskId: r0Id, agentId: backend.id }, chuShop);
  assert.ok("ok" in giaoDung, "agent đang bật và được phép mức R0 thì nhận được việc R0");

  /* ───────── 5.6 Đóng việc phải có bằng chứng ───────── */
  await setTechTaskStatus({ taskId: r2Id, to: "OBSERVING" }, chuShop);
  const dongIm = await setTechTaskStatus({ taskId: r2Id, to: "DONE" }, chuShop);
  assert.ok("error" in dongIm, "đóng việc mà không xác minh và không giải thích phải bị chặn");

  const xacMinhYeu = await verifyTechTaskOnProduction({ taskId: r2Id, evidence: "ok" }, chuShop);
  assert.ok("error" in xacMinhYeu, "xác minh phải kèm bằng chứng, không phải một chữ 'ok'");
  await verifyTechTaskOnProduction({ taskId: r2Id, evidence: "Mở /payroll kỳ 09/2026: lương cứng 12.400.000đ, khớp sổ ngân hàng" }, chuShop);
  const dong = await setTechTaskStatus({ taskId: r2Id, to: "DONE" }, chuShop);
  assert.ok("ok" in dong, "đã xác minh thì đóng được");
  const xong = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r2Id) });
  assert.ok(xong?.completedAt, "việc đã xong phải có mốc xong — không có mốc thì không đo được thời gian");
  assert.ok(xong?.productionVerifiedAt && xong.productionEvidence.length > 10, "bằng chứng xác minh phải được lưu");

  // Việc đã đóng là ĐÃ ĐÓNG: không còn nước đi nào.
  const moLai = await setTechTaskStatus({ taskId: r2Id, to: "BUILDING" }, chuShop);
  assert.ok("error" in moLai, "việc đã đóng không mở lại — hỏng lại thì mở việc MỚI có liên kết");

  /* ───────── 5.7 Đè mức rủi ro: bắt buộc lý do, và nâng lên R2 thì phải xin duyệt lại ───────── */
  const deThieuLyDo = await overrideTechTaskRisk({ taskId: r0Id, risk: "R2", reason: "cần" }, chuShop);
  assert.ok("error" in deThieuLyDo, "đè mức rủi ro mà không nói vì sao phải bị từ chối");
  await overrideTechTaskRisk({ taskId: r0Id, risk: "R2", reason: "Tài liệu này mô tả cách tính lương nên người đọc sẽ tin nó như luật" }, chuShop);
  const daDe = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r0Id) });
  assert.equal(daDe?.risk, "R2");
  assert.equal(daDe?.approvalRequired, true, "nâng lên R2 thì cổng phê duyệt bật lên");
  assert.equal(daDe?.approvalStatus, "PENDING", "và việc phải xin duyệt lại — cái đã duyệt trước đó là một việc khác");
  assert.equal(daDe?.riskOverriddenBy, userId, "lượt đè phải ký tên bằng khoá tài khoản");

  /* ───────── 5.8 Lượt chạy: bốn cổng mặc định CHƯA XÁC MINH ───────── */
  const luot = await startTechAgentRun({ agentId: backend.id, taskId: r0Id, branch: "claude/tech-t" }, chuShop);
  assert.ok("ok" in luot, "mở được lượt chạy cho agent đang bật");
  const luotId = "ok" in luot ? luot.id : "";
  const dangChay = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, luotId) });
  assert.equal(dangChay?.typecheckResult, "UNKNOWN");
  assert.equal(dangChay?.testResult, "UNKNOWN", "chưa chạy kiểm thử KHÔNG phải là đã đạt (AGENTS.md mục 42)");
  assert.equal(dangChay?.endedAt, null, "lượt đang chạy KHÔNG có mốc kết thúc — không phải 'kết thúc lúc 0 giờ'");

  await finishTechAgentRun({ runId: luotId, status: "SUCCEEDED", summary: "Sửa 2 tệp tài liệu", testsRun: "npm run typecheck && npm test", typecheckResult: "PASSED", testResult: "PASSED" }, chuShop);
  const daXong = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, luotId) });
  assert.equal(daXong?.status, "SUCCEEDED");
  assert.ok(daXong?.endedAt, "lượt đã đóng phải có mốc kết thúc");
  assert.equal(daXong?.lintResult, "UNKNOWN", "cổng KHÔNG khai vẫn là CHƯA XÁC MINH, không tự thành ĐẠT");
  const mocCu = daXong?.endedAt;
  await finishTechAgentRun({ runId: luotId, status: "FAILED", summary: "bấm lại" }, chuShop);
  const sauKhiBamLai = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, luotId) });
  assert.equal(sauKhiBamLai?.status, "SUCCEEDED", "đóng một lượt đã đóng KHÔNG được ghi đè kết quả");
  assert.deepEqual(sauKhiBamLai?.endedAt, mocCu, "và KHÔNG được đẩy mốc kết thúc về lần bấm sau");

  /* ───────── 5.9 Deploy: lớp quan sát, không chống trùng theo commit ───────── */
  const deploySai = await recordTechDeployment({ commitSha: "không-phải-sha" }, chuShop);
  assert.ok("error" in deploySai, "mã commit không hợp lệ phải bị từ chối");
  const d1 = await recordTechDeployment({ commitSha: "abc1234", status: "SUCCEEDED", taskId: r0Id, notes: "tech-t" }, chuShop);
  const d2 = await recordTechDeployment({ commitSha: "abc1234", status: "FAILED", notes: "tech-t chạy lại" }, chuShop);
  assert.ok("ok" in d1 && "ok" in d2, "cùng một commit deploy hai lần là chuyện có thật — lần chạy lại mới là lần đáng xem");
  const soDeploy = await db.query.techDeployments.findMany({ where: eq(schema.techDeployments.commitSha, "abc1234") });
  assert.equal(soDeploy.length, 2, "KHÔNG chống trùng theo commit — chống trùng ở đây sẽ giấu mất lần chạy lại");

  /* ───────── 5.10 Sự cố: vòng đời và ràng buộc khi đóng ───────── */
  const sc = await createTechIncident(
    { title: "tech-t-sự cố: trang Vận đơn trả lỗi 500", severity: "SEV1", module: "SHIPMENTS", evidence: "log: TypeError tại shipments/page.tsx dòng 44", taskId: r0Id },
    chuShop,
  );
  assert.ok("ok" in sc, "mở được sự cố");
  const scId = "ok" in sc ? sc.id : "";
  assert.match("ok" in sc ? sc.code : "", /^INC-\d+$/, "mã sự cố phải đọc được");

  const nhaySai = await setTechIncidentStatus({ incidentId: scId, to: "MONITORING" }, chuShop);
  assert.ok("error" in nhaySai, "OPEN không nhảy thẳng sang 'đang theo dõi' được");
  await setTechIncidentStatus({ incidentId: scId, to: "INVESTIGATING" }, chuShop);
  const lapLai = await setTechIncidentStatus({ incidentId: scId, to: "INVESTIGATING" }, chuShop);
  assert.ok("ok" in lapLai && lapLai.skipped === true, "đổi sang đúng trạng thái đang có thì bỏ qua");

  const dongThieu = await setTechIncidentStatus({ incidentId: scId, to: "RESOLVED" }, chuShop);
  assert.ok("error" in dongThieu, "đóng sự cố mà không kể đã làm gì phải bị chặn");
  await setTechIncidentStatus({ incidentId: scId, to: "RESOLVED", resolution: "Đã revert commit abc1234 và deploy lại lúc 15:02" }, chuShop);
  const daDong = await db.query.techIncidents.findFirst({ where: eq(schema.techIncidents.id, scId) });
  assert.equal(daDong?.status, "RESOLVED");
  assert.ok(daDong?.resolvedAt, "sự cố đã đóng phải có mốc đóng");
  assert.equal(daDong?.rootCause, "", "nguyên nhân gốc để TRỐNG là hợp lệ — chưa chứng minh được thì không bịa (AGENTS.md mục 45)");

  /* ───────── 5.11 Danh sách: lọc và phân trang ───────── */
  const locR2 = await listTechTasks(thamSo({ filters: { risk: ["R2"] } }));
  assert.ok(locR2.rows.every((r) => r.risk === "R2"), "bộ lọc rủi ro phải lọc đúng");
  assert.ok(locR2.total >= 2, "hai việc kiểm thử đều đã thành R2");

  const locMo = await listTechTasks(thamSo({ filters: { open: ["1"] } }));
  assert.ok(!locMo.rows.some((r) => r.id === r2Id), "việc đã đóng KHÔNG nằm trong nhóm còn mở");

  const trang = await listTechTasks(thamSo({ pageSize: 1 }));
  assert.equal(trang.rows.length, 1, "phân trang phải cắt đúng số dòng");
  assert.ok(trang.pageCount >= trang.total, "số trang phải phủ hết số dòng khi mỗi trang một dòng");
  const trang2 = await listTechTasks(thamSo({ pageSize: 1, page: 2 }));
  assert.notEqual(trang2.rows[0]?.id, trang.rows[0]?.id, "trang 2 phải là dòng khác trang 1");

  const timTheoMa = await listTechTasks(thamSo({ q: "tech-t-tài liệu" }));
  assert.ok(timTheoMa.total >= 1, "tìm theo tiêu đề phải ra kết quả");

  const mat = await techTaskFacets(thamSo());
  assert.ok(mat.risk.some((r) => r.value === "R2" && r.count >= 2), "mặt cắt rủi ro phải đếm đúng");
  assert.ok(mat.module.some((m) => m.value === "PAYROLL"), "mặt cắt module phải có nhãn tiếng Việt");
  assert.ok(mat.module.find((m) => m.value === "PAYROLL")?.label === "Lương & hoa hồng", "mặt cắt phải hiện nhãn, không hiện khoá thô");

  const locSuCo = await listTechIncidents(thamSo({ sort: "detectedAt", filters: { severity: ["SEV1"] } }));
  assert.ok(locSuCo.rows.every((r) => r.severity === "SEV1"), "bộ lọc mức nặng phải lọc đúng");

  /* ───────── 5.12 Thẻ đếm ở trang tổng quan ───────── */
  const dem = await techOverviewCounts();
  assert.ok(dem.tasks.total >= 2);
  assert.ok(dem.tasks.waitingApproval >= 1, "việc vừa nâng lên R2 phải nằm trong nhóm chờ phê duyệt");
  assert.ok(dem.agents.total === TECH_AGENT_TEMPLATES.length, "sổ agent đếm đúng");
  assert.equal(dem.agents.enabled, 1, "chỉ một agent được bật trong bài này");
  assert.ok(dem.incidents.open === 0 || dem.incidents.open >= 0);

  /* ───────── Dọn sạch ───────── */
  const idViec = [r2Id, r0Id];
  await db.delete(schema.techIncidents).where(eq(schema.techIncidents.id, scId));
  await db.delete(schema.techDeployments).where(eq(schema.techDeployments.commitSha, "abc1234"));
  await db.delete(schema.techAgentRuns).where(inArray(schema.techAgentRuns.taskId, idViec));
  await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, idViec));
  await db.delete(schema.techAgents).where(like(schema.techAgents.key, "%"));
  await db.delete(schema.users).where(eq(schema.users.id, userId));

  console.log(
    `✓ Mặt phẳng điều khiển Tech: sổ agent không tự đầy (${TECH_AGENT_TEMPLATES.length} vai, tất cả TẮT) · cổng phê duyệt R2 không lách được bằng máy, bằng hạ rủi ro hay bằng giao agent · bấm hai lần không đẻ lịch sử · đóng việc và đóng sự cố đều phải có bằng chứng · lọc và phân trang đúng`,
  );
}

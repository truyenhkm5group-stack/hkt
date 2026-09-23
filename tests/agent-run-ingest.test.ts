import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  AGENT_INGEST,
  EXTERNAL_REF_PATTERN,
  INGESTABLE_STATUSES,
  agentRunExternalRef,
  ingestAllowed,
  recordIngest,
  reportIsFresh,
  resetIngestThrottle,
} from "@/lib/constants/agent-ingest";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { ingestAgentRun } from "@/lib/tech/agent-run-ingest";

/**
 * ═══════════ NẤC 1 — CỬA HẸP CHÉP SỔ LƯỢT CHẠY AGENT VỀ PRODUCTION ═══════════
 *
 * Phương án B của chủ shop: runner ở lại máy GitHub Actions, KHÔNG nối CSDL production; sổ đi về
 * qua một cửa HTTP hẹp. Bài kiểm này khoá ba thứ, và thứ ba là thứ dễ trôi nhất:
 *
 *  1. **Hàm thuần** — khoá tự nhiên, trần lượt gọi, độ tươi.
 *  2. **Đường ghi thật** — chạy `ingestAgentRun()` trên CSDL thật, gồm cả ca chống phát lại được
 *     CSDL (không phải mã) chặn: bài tự tay chạy lệnh `insert` trùng khoá và đòi Postgres NÉM LỖI.
 *     Khẳng định "khoá duy nhất bảo vệ chúng ta" mà không chạy lệnh thật thì chỉ là một niềm tin.
 *  3. **Quét mã nguồn** — cửa phải HẸP theo hình dạng của chính nó: không nhận SQL, không nhận
 *     tên bảng, không mở đường phiên đăng nhập, không in bí mật ra log.
 *
 * Mốc thời gian đi theo ĐỒNG HỒ THẬT (AGENTS.md mục 50). Dữ liệu tự dọn bằng tiền tố `ing-`.
 */

const goc = path.resolve(__dirname, "..");

/* ═════════════════ 1 · HÀM THUẦN ═════════════════ */

export function testAgentIngestPure() {
  /*
    ───────── 1.1 `RUNNING` KHÔNG ĐƯỢC PHÉP CHÉP VỀ ─────────

    Đây là luật của cả thiết kế, không phải một tuỳ chọn: ERP không quan sát được một lượt chạy
    đang diễn ra ở máy khác, nên một dòng `RUNNING` chép về là lời khai không ai kiểm được — và
    nếu máy Actions chết giữa chừng, nó nằm lại vĩnh viễn, đúng loại mồ côi mà `agent-reaper` phải
    đi dọn. Mở một cửa để tự sinh việc cho cái chổi là ngược.
  */
  assert.ok(!(INGESTABLE_STATUSES as readonly string[]).includes("RUNNING"), "RUNNING không được nằm trong danh sách chép về");
  /*
    NỚI DANH SÁCH NGÀY 23/09/2026 — `BLOCKED`, và đây là một QUYẾT ĐỊNH, không phải một lần sửa
    cho CI xanh (AGENTS.md mục 0).

    Cửa chép sổ nhận lượt chạy ĐÃ KẾT THÚC. `BLOCKED` là một cách kết thúc: agent chạy xong và
    kết luận việc không thuộc môi trường của nó. Để nó ngoài danh sách nghĩa là đúng những lượt
    chạy nói lên "đề bài sai" lại không bao giờ tới được production — chỗ duy nhất người sửa đề
    bài đang nhìn.

    Tính chất mà khẳng định này thật sự canh vẫn nguyên: `RUNNING` ở dòng trên, và nó vẫn bị
    loại. Danh sách được phép DÀI ra khi có một cách kết thúc mới; nó không được phép nhận một
    trạng thái CHƯA kết thúc.
  */
  assert.deepEqual([...INGESTABLE_STATUSES], ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);
  for (const st of INGESTABLE_STATUSES) {
    assert.notEqual(st, "RUNNING", "mọi trạng thái chép về được phải là một trạng thái ĐÃ KẾT THÚC");
  }

  // ───────── 1.2 Khoá tự nhiên: `attempt` NẰM TRONG khoá ─────────
  const l1 = agentRunExternalRef("github", "123456", "1");
  const l2 = agentRunExternalRef("github", "123456", "2");
  assert.equal(l1, "github:123456:1");
  assert.notEqual(l1, l2, "chạy lại workflow là một sự việc MỚI — không được gộp vào cùng một dòng");
  assert.ok(EXTERNAL_REF_PATTERN.test(l1) && EXTERNAL_REF_PATTERN.test(l2));

  // Ký tự lạ bị lọc, không được mang nguyên vào khoá.
  assert.equal(agentRunExternalRef("GitHub Actions!", "12 34", "07"), "githubactions:1234:7");
  assert.equal(agentRunExternalRef("github", "9", ""), "github:9:1", "thiếu attempt ⇒ lần 1, không phải khoá rỗng");
  /*
    `"07"` và `"7"` là CÙNG MỘT lần chạy lại. Giữ nguyên câu chữ thì cùng một sự việc dựng ra hai
    khoá, và khoá duy nhất ở CSDL không cứu được — với nó đó là hai giá trị khác nhau.
  */
  assert.equal(agentRunExternalRef("github", "9", "07"), agentRunExternalRef("github", "9", 7), "số 0 đứng đầu không được đẻ ra một khoá thứ hai");
  assert.equal(agentRunExternalRef("github", "9", "0"), "github:9:1", "lần chạy 0 không tồn tại ⇒ lần 1");
  assert.equal(agentRunExternalRef("", "9", "1"), "", "thiếu provider ⇒ KHÔNG dựng khoá — rỗng, để nơi gọi dừng lại");
  assert.equal(agentRunExternalRef("github", "", "1"), "", "thiếu runId ⇒ KHÔNG dựng khoá");

  /*
    Hình dạng khoá phải từ chối thứ có thể trở thành một khoá khác sau khi cắt gọt. `a:b` thiếu
    attempt, `a:b:c:d` có phần thừa, và chuỗi có khoảng trắng thì hai nơi đọc ra hai giá trị.
  */
  for (const xau of ["github:123", "github:123:1:2", "github: 123:1", "github:123:x", "GITHUB:123:1", ""]) {
    assert.ok(!EXTERNAL_REF_PATTERN.test(xau), `khoá "${xau}" phải bị từ chối`);
  }

  /*
    ───────── 1.3 Độ tươi: MỐC Ở TƯƠNG LAI KHÔNG BỊ LOẠI ─────────

    Lệch đồng hồ vài giây giữa máy Actions và VPS là chuyện thường. Loại một gói tin hợp lệ vì
    đồng hồ máy gửi nhanh hơn là tự gây sự cố — cùng bài học AGENTS.md mục 64 (âm trong dung sai
    thì kẹp về 0 và VẪN TÍNH).
  */
  const bayGio = new Date("2026-09-20T10:00:00Z");
  assert.ok(reportIsFresh(new Date("2026-09-20T10:00:30Z"), bayGio), "mốc ở tương lai 30 giây vẫn tươi");
  assert.ok(reportIsFresh(new Date("2026-09-20T09:00:00Z"), bayGio), "60 phút trước vẫn trong ngưỡng 120");
  assert.ok(!reportIsFresh(new Date("2026-09-20T07:30:00Z"), bayGio), "150 phút trước thì quá cũ");
  assert.ok(!reportIsFresh(new Date(Number.NaN), bayGio), "mốc không đọc được KHÔNG được coi là tươi");
  // Đúng biên: `<=` nên chạm ngưỡng vẫn là tươi. Biên là chỗ hai người đọc luật ra hai kết quả.
  assert.ok(reportIsFresh(new Date(bayGio.getTime() - AGENT_INGEST.maxAgeMinutes * 60_000), bayGio));
  assert.ok(!reportIsFresh(new Date(bayGio.getTime() - AGENT_INGEST.maxAgeMinutes * 60_000 - 1), bayGio));

  // ───────── 1.4 Trần lượt gọi: đếm đúng, và NÓI ĐƯỢC còn bao lâu ─────────
  resetIngestThrottle();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < AGENT_INGEST.maxPerWindow; i++) {
    assert.ok(ingestAllowed("k", t0).ok, `lượt ${i + 1} phải được phép`);
    recordIngest("k", t0);
  }
  const chan = ingestAllowed("k", t0);
  assert.ok(!chan.ok, "vượt trần thì chặn");
  assert.ok(!chan.ok && chan.retryAfterSec > 0, "chặn thì phải nói được bao lâu nữa — một 429 không kèm số là một ngõ cụt");
  // Cửa sổ TRƯỢT: qua cửa sổ thì mở lại, không phải đợi tới một mốc cố định.
  assert.ok(ingestAllowed("k", t0 + AGENT_INGEST.windowMs + 1).ok, "qua cửa sổ thì mở lại");
  assert.ok(ingestAllowed("khoa-khac", t0).ok, "khoá khác không bị lây");
  resetIngestThrottle();
  console.log("✓ Cửa chép sổ (hàm thuần): RUNNING không chép được · attempt nằm TRONG khoá · mốc tương lai vẫn tươi · 429 kèm số giây");
}

/* ═════════════════ 2 · ĐƯỜNG GHI THẬT ═════════════════ */

async function gieo() {
  const db = await getDb();
  const [agent] = await db
    .insert(schema.techAgents)
    .values({ key: "ing-doc", name: "ing-Tài liệu", role: "DOCUMENTATION", enabled: true, allowedRisks: ["R0"] })
    .returning({ id: schema.techAgents.id });
  const [tat] = await db
    .insert(schema.techAgents)
    .values({ key: "ing-tat", name: "ing-Đã tắt", role: "QA", enabled: false, allowedRisks: ["R0"] })
    .returning({ id: schema.techAgents.id });
  const [task] = await db
    .insert(schema.techTasks)
    .values({ code: "ING-1", title: "ing-việc chép sổ", status: "BUILDING", risk: "R0" })
    .returning({ id: schema.techTasks.id, status: schema.techTasks.status });
  return { agentId: agent.id, agentTatId: tat.id, taskId: task.id, taskStatus: task.status };
}

export async function testAgentIngestDb() {
  const db = await getDb();
  await cleanupAgentIngestFixtures();
  const fx = await gieo();

  // ───────── 2.1 Chép một lượt chạy đã kết thúc ─────────
  const ket = await ingestAgentRun({
    externalRef: "github:900001:1",
    agentKey: "ing-doc",
    taskCode: "ING-1",
    status: "SUCCEEDED",
    branch: "ai/documentation/ING-1-abc",
    baseCommit: "1111111",
    resultCommit: "2222222",
    summary: "ing-tóm tắt",
    testsRun: "npm run typecheck && npm test",
    gates: { typecheck: "PASSED", lint: "PASSED", test: "PASSED", build: "PASSED" },
    filesChanged: ["docs/ing.md"],
    startedAt: new Date(Date.now() - 60_000),
    endedAt: new Date(),
    externalUrl: "https://github.com/x/y/actions/runs/900001",
  });
  assert.ok("ok" in ket && ket.ok, `phải ghi được: ${JSON.stringify(ket)}`);
  assert.ok("created" in ket && ket.created, "lần đầu phải là TẠO MỚI");

  const dong = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.externalRef, "github:900001:1") });
  assert.ok(dong, "dòng phải có thật trong bảng");
  assert.equal(dong.agentKey, "ing-doc");
  assert.equal(dong.status, "SUCCEEDED");
  assert.equal(dong.testResult, "PASSED");
  assert.deepEqual(dong.filesChanged, ["docs/ing.md"]);
  /*
    `metadata.source` PHẢI PHÂN BIỆT ĐƯỢC NGUỒN.

    Dòng chép về từ máy khác và dòng do chính ERP mở ra trông giống hệt nhau trong bảng. Không
    phân biệt được thì mọi phép đo "agent chạy thế nào" trộn hai nguồn có độ tin cậy khác nhau.
  */
  assert.equal((dong.metadata as { source?: string } | null)?.source, "EXTERNAL_INGEST");

  /*
    ───────── 2.2 CHÉP HAI LẦN KHÔNG ĐẺ HAI DÒNG ─────────

    Hai vế, và vế thứ hai mới là vế thật:
      (a) gọi lại hàm ⇒ trả về dòng cũ, `created: false` (nhánh idempotent ở tầng mã — RẺ, nhưng
          có cửa sổ đua giữa lúc đọc và lúc ghi);
      (b) tự tay chạy `insert` trùng khoá ⇒ **Postgres phải NÉM LỖI**. Đó là thứ đứng vững khi hai
          gói tin tới cùng một mili giây.
  */
  const lai = await ingestAgentRun({ externalRef: "github:900001:1", agentKey: "ing-doc", taskCode: "ING-1", status: "FAILED", summary: "ing-khai khác hẳn" });
  assert.ok("ok" in lai && lai.ok && !lai.created, "gọi lại phải trả về dòng cũ, không tạo thêm");
  assert.equal("ok" in lai && lai.runId, dong.id, "phải là ĐÚNG dòng cũ");

  const conNguyen = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.externalRef, "github:900001:1") });
  assert.equal(conNguyen?.status, "SUCCEEDED", "gói tin thứ hai KHÔNG được sửa dòng đã có — cửa này chỉ TẠO");
  assert.equal(conNguyen?.summary, "ing-tóm tắt");

  let loiTrung: unknown = null;
  try {
    await db.insert(schema.techAgentRuns).values({ agentId: fx.agentId, agentKey: "ing-doc", externalRef: "github:900001:1", status: "FAILED", endedAt: new Date() });
  } catch (error) {
    loiTrung = error;
  }
  assert.ok(loiTrung, "CSDL phải tự chặn khoá trùng — không được chỉ dựa vào mệnh đề kiểm trong mã");
  /*
    VÀ ĐƯỜNG GHI PHẢI NHẬN RA ĐƯỢC LỖI ẤY.

    Bài này đã tìm ra một lỗi thật: drizzle BỌC lỗi của driver, nên `String(error)` chỉ ra
    "Failed query: insert into …" — không tên ràng buộc, không mã SQLSTATE. Viết
    `String(error).includes("<tên khoá>")` thì nhánh "đọc lại dòng của kẻ thắng" KHÔNG BAO GIỜ
    chạy, và lượt gọi thua cuộc nhận một lỗi ghi trong khi CSDL vừa làm đúng việc của nó.
  */
  assert.ok(!String(loiTrung).includes("tech_agent_runs_external_ref_uq"), "GHI NHỚ: tên ràng buộc KHÔNG nằm ở String(error) — nó ở error.cause");
  assert.ok(isUniqueViolation(loiTrung, "tech_agent_runs_external_ref_uq"), "đường ghi phải nhận ra được khoá duy nhất vừa chặn, qua chuỗi cause");
  assert.ok(!isUniqueViolation(loiTrung, "tech_agent_runs_task_idx"), "và phải phân biệt được với một khoá khác trên cùng bảng");
  assert.ok(!isUniqueViolation(new Error("mất kết nối")), "lỗi thường KHÔNG được nhận nhầm thành trùng khoá");

  /*
    ───────── 2.3 LƯỢT CHẠY NỘI BỘ (`external_ref` NULL) KHÔNG ĐỤNG NHAU ─────────
    Postgres cho nhiều NULL cùng tồn tại dưới một khoá duy nhất. Nếu không, khoá mới này sẽ chặn
    mọi lượt chạy nội bộ thứ hai — một migration làm hỏng đường ghi cũ mà không ai thấy ngay.
  */
  await db.insert(schema.techAgentRuns).values({ agentId: fx.agentId, agentKey: "ing-doc", status: "SUCCEEDED", endedAt: new Date(), summary: "ing-nội bộ 1" });
  await db.insert(schema.techAgentRuns).values({ agentId: fx.agentId, agentKey: "ing-doc", status: "SUCCEEDED", endedAt: new Date(), summary: "ing-nội bộ 2" });

  // ───────── 2.4 `RUNNING` bị từ chối ở tầng dịch vụ, không chỉ ở lược đồ HTTP ─────────
  const dangChay = await ingestAgentRun({ externalRef: "github:900002:1", agentKey: "ing-doc", status: "RUNNING" as never });
  assert.ok("code" in dangChay && dangChay.code === "BAD_STATUS", "RUNNING phải bị từ chối");

  // ───────── 2.5 Vai lạ / việc lạ: nói rõ sai ở đâu, không gộp thành một lỗi ─────────
  const vaiLa = await ingestAgentRun({ externalRef: "github:900003:1", agentKey: "ing-khong-co", status: "SUCCEEDED" });
  assert.ok("code" in vaiLa && vaiLa.code === "UNKNOWN_AGENT");
  const viecLa = await ingestAgentRun({ externalRef: "github:900004:1", agentKey: "ing-doc", taskCode: "ING-KHONG-CO", status: "SUCCEEDED" });
  assert.ok("code" in viecLa && viecLa.code === "UNKNOWN_TASK");
  assert.ok(
    !(await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.externalRef, "github:900004:1") })),
    "việc lạ thì KHÔNG được để lại dòng nửa vời",
  );

  /*
    ───────── 2.6 VAI ĐANG TẮT VẪN ĐƯỢC CHÉP SỔ ─────────

    Cửa này không cho phép agent làm gì cả — lượt chạy ĐÃ xảy ra rồi, ở một máy khác. Từ chối ghi
    vì vai đang tắt là XOÁ BẰNG CHỨNG về một việc đã xảy ra, thứ tệ nhất một sổ quan sát có thể
    làm. Cờ `enabled` chặn ở chỗ MỞ lượt chạy, không phải ở chỗ ghi lại nó.
  */
  const daTat = await ingestAgentRun({ externalRef: "github:900005:1", agentKey: "ing-tat", status: "FAILED", error: "ing-lỗi" });
  assert.ok("ok" in daTat && daTat.ok && daTat.created, "vai tắt vẫn phải ghi được — không xoá bằng chứng");

  /*
    ───────── 2.7 CHÉP SỔ KHÔNG ĐỤNG TRẠNG THÁI VIỆC ─────────
    Một lượt chạy xong KHÔNG phải một việc xong. Chuyển trạng thái việc là một quyết định, và
    quyết định không đi qua một endpoint máy-gọi-máy.
  */
  const viec = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, fx.taskId), columns: { status: true } });
  assert.equal(viec?.status, fx.taskStatus, "trạng thái việc phải nguyên vẹn sau khi chép sổ");

  /*
    ───────── 2.8 CÓ VẾT, VÀ VẾT NÓI RÕ MÁY LÀM ─────────
    `actorId = null` ở đây có nghĩa xác định: MÁY làm — khác hẳn "chưa biết ai" (AGENTS.md mục 34).
  */
  const suKien = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, fx.taskId) });
  const run = suKien.filter((s) => s.kind === "RUN");
  assert.equal(run.length, 1, "đúng một sự kiện RUN cho lượt chép đầu tiên — gọi lại không ghi thêm vết");
  assert.equal(run[0].actorId, null, "máy làm ⇒ không có khoá tài khoản, và đó là câu trả lời ĐÚNG");
  console.log("✓ Chép sổ lượt chạy agent: CSDL tự chặn khoá trùng (chạy lệnh thật) · chỉ TẠO không SỬA · vai đã tắt vẫn ghi được · KHÔNG đụng trạng thái việc · lượt chạy nội bộ (NULL) không đụng nhau");
}

export async function cleanupAgentIngestFixtures() {
  const db = await getDb();
  const viec = await db.query.techTasks.findMany({ where: like(schema.techTasks.code, "ING-%"), columns: { id: true } });
  const vai = await db.query.techAgents.findMany({ where: like(schema.techAgents.key, "ing-%"), columns: { id: true } });
  if (vai.length) await db.delete(schema.techAgentRuns).where(inArray(schema.techAgentRuns.agentId, vai.map((v) => v.id)));
  if (viec.length) {
    await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, viec.map((v) => v.id)));
    await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, viec.map((v) => v.id)));
  }
  if (vai.length) await db.delete(schema.techAgents).where(inArray(schema.techAgents.id, vai.map((v) => v.id)));
}

/* ═════════════════ 3 · QUÉT MÃ NGUỒN — CỬA PHẢI HẸP THEO HÌNH DẠNG ═════════════════ */

export function testAgentIngestSourceGuards() {
  const route = readFileSync(path.join(goc, "app/api/tech/agent-run/route.ts"), "utf8");
  const service = readFileSync(path.join(goc, "lib/tech/agent-run-ingest.ts"), "utf8");
  const reporter = readFileSync(path.join(goc, "scripts/agent-run-report.ts"), "utf8");

  /*
    ───────── 3.1 KHÔNG BAO GIỜ TRỞ THÀNH MỘT CỬA TRUY VẤN TỔNG QUÁT ─────────

    Yêu cầu nguyên văn của chủ shop. Một cửa nhận được `table`, `sql`, `where` hay `query` thì
    không còn là cửa hẹp, dù nó tên gì. Quét bằng mã nguồn vì một dòng thêm vào lược đồ trông vô
    hại lúc review và không đỏ ở bất kỳ bài kiểm hành vi nào.
  */
  for (const cam of ["table:", "tableName", "sql:", "rawSql", "where:", "query:", "columns:"]) {
    assert.ok(!route.includes(cam), `cửa nhận KHÔNG được có trường "${cam}"`);
  }
  assert.ok(!/\bfrom\s+["']drizzle-orm["']/.test(route), "route KHÔNG import drizzle — mọi lượt ghi đi qua đúng một hàm dịch vụ");
  assert.ok(!route.includes('from "@/db"'), "route KHÔNG chạm thẳng CSDL");

  /*
    ───────── 3.2 LƯỢC ĐỒ PHẢI `.strict()` ─────────
    Không `.strict()` thì zod BỎ QUA trường lạ trong im lặng — và một cửa "hẹp" lờ đi thứ nó không
    hiểu sẽ rộng dần theo mỗi người gọi.
  */
  assert.ok(route.includes(".strict()"), "lược đồ đầu vào phải .strict()");

  /*
    ───────── 3.3 XÁC THỰC ĐÓNG-KHI-THIẾU, VÀ CHỈ QUA HEADER ─────────
    `secretEquals` trả `false` khi THIẾU một trong hai vế. Bí mật trên URL thì nằm trong access log
    của Caddy, log proxy và lịch sử trình duyệt — cùng bài học với `/api/sync/[job]`.
  */
  assert.ok(route.includes("secretEquals"), "phải so bí mật bằng secretEquals (thời gian không phụ thuộc nội dung)");
  assert.ok(!/searchParams/.test(route), "KHÔNG nhận bí mật (hay bất cứ gì) trên URL");
  assert.ok(!route.includes("getCurrentUser"), "KHÔNG có đường phiên đăng nhập — đây là cửa máy-gọi-máy");
  assert.ok(!/export\s+(const|async\s+function)\s+GET\b/.test(route), "KHÔNG có GET — một link bấm nhầm không được ghi sổ");

  /*
    ───────── 3.4 CHỈ TẠO, KHÔNG SỬA ─────────
    Nếu đường ghi này có `update`, thì cửa hướng ra Internet vừa trở thành đường viết lại lịch sử.
  */
  assert.ok(!/\bdb\s*\n?\s*\.update\(/.test(service) && !service.includes("db.update("), "đường ghi KHÔNG được có lệnh update");
  assert.ok(!service.includes("onConflictDoUpdate"), "KHÔNG upsert — trùng khoá thì trả về dòng cũ, không ghi đè");
  assert.ok(!service.includes("db.delete("), "đường ghi KHÔNG được xoá gì");
  // Đúng một bảng được ghi.
  const bangGhi = [...service.matchAll(/\.insert\(schema\.(\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bangGhi)], ["techAgentRuns"], "cửa này chỉ được ghi vào tech_agent_runs");

  /*
    ───────── 3.5 KHÔNG IN BÍ MẬT ─────────
    Kho mã này PUBLIC nên log Actions ai cũng đọc được. Script chỉ được in CÓ / KHÔNG, và cả độ
    dài cũng không (`agent-run.yml` đã theo luật đó cho khoá AI).
  */
  assert.ok(!/console\.log\([^)]*\bsecret\b(?!\s*\?)/.test(reporter.replace(/secret \? "có" : "KHÔNG có"/g, "")), "reporter KHÔNG được in giá trị bí mật");
  assert.ok(!reporter.includes("secret.length"), "KHÔNG in cả độ dài bí mật");
  assert.ok(!/console\.log\(`[^`]*\$\{\s*base\s*\}/.test(reporter), "URL đích chỉ in phần gốc (scheme + host), không kèm đường dẫn hay tham số");

  /*
    ───────── 3.6 BƯỚC TRONG WORKFLOW KHÔNG ĐƯỢC LÀM HỎNG LƯỢT CHẠY ─────────
    Bằng chứng THẬT của một lượt chạy là hiện vật + nhánh git. Một lần ERP bận mà làm cả lượt chạy
    agent trông như hỏng là đổi một phiền toái lấy một kết luận sai.
  */
  const wf = readFileSync(path.join(goc, ".github/workflows/agent-run.yml"), "utf8");
  const khoi = wf.slice(wf.indexOf("- name: Chép sổ lượt chạy về ERP"));
  assert.ok(khoi.length > 0, "workflow phải có bước chép sổ");
  assert.ok(khoi.slice(0, 400).includes("continue-on-error: true"), "bước chép sổ KHÔNG được làm hỏng lượt chạy agent");
  assert.ok(khoi.slice(0, 700).includes("AGENT_INGEST_SECRET"), "bước chép sổ phải truyền khoá RIÊNG xuống");

  /*
    ───────── 3.7 KHOÁ RIÊNG, KHÔNG MƯỢN KHOÁ CỦA BỘ LẬP LỊCH ─────────

    `CRON_SECRET` mở được hàng chục job đồng bộ, trong đó có job GHI hàng loạt. Đưa nó lên một máy
    chạy mã CHƯA QUA REVIEW là đánh đổi bán kính thiệt hại lấy một dòng cấu hình — trong khi thứ
    máy đó cần chỉ là ghi thêm dòng vào MỘT bảng quan sát. Khoá ở mức mã nguồn vì đây là một dòng
    YAML trông vô hại và không bài kiểm hành vi nào thấy được.
  */
  assert.ok(!wf.includes("secrets.CRON_SECRET"), "workflow agent KHÔNG được nhắc tới secrets.CRON_SECRET");

  /*
    ───────── 3.8 ĐỊA CHỈ ERP KHAI ĐÚNG MỘT LẦN ─────────

    `deploy-vps.yml` đã suy tên miền từ `vars.ERP_DOMAIN`. Khai lại ở một biến thứ hai là dựng một
    việc thủ công cho một giá trị đã biết, và dựng luôn cơ hội để hai chỗ nói hai tên miền khác
    nhau. Bài kiểm đòi CÙNG một biểu thức mặc định ở cả hai nơi.
  */
  const deploy = readFileSync(path.join(goc, ".github/workflows/deploy-vps.yml"), "utf8");
  const macDinh = "vars.ERP_DOMAIN || 'erp.vnxcommerce.com'";
  assert.ok(deploy.includes(macDinh), "deploy-vps.yml phải giữ nguyên nguồn tên miền");
  assert.ok(wf.includes(macDinh), "agent-run.yml phải dùng LẠI đúng nguồn đó, không khai lần hai");

  /*
    ───────── 3.9 KHOÁ ĐI ĐƯỢC TỪ SECRET TỚI `.env` CỦA MÁY CHỦ ─────────

    Một secret khai ở GitHub mà không có đường xuống `.env` thì cửa vẫn đóng, và người khai không
    có cách nào biết — đúng kiểu hỏng im lặng. Bốn mắt xích phải cùng có mặt.
  */
  const install = readFileSync(path.join(goc, "scripts/install-vps.sh"), "utf8");
  assert.ok(deploy.includes("AGENT_INGEST_SECRET: ${{ secrets.AGENT_INGEST_SECRET }}"), "deploy phải đọc secret");
  /*
    Cắt theo MỐC TRONG TỆP, không tách dòng và không biểu thức chính quy: một chuỗi thoát viết sai
    làm bộ gác lặng lẽ đo nhầm thứ khác — đã xảy ra đúng một lần khi viết chính bài kiểm này.
  */
  const iEnvs = deploy.indexOf("envs: ERP_BRANCH");
  const iScript = deploy.indexOf("script:", iEnvs);
  const iExport = deploy.indexOf("export ERP_BRANCH", iScript);
  const iSauExport = deploy.indexOf("KHOÁ VÒNG ĐỜI", iExport);
  assert.ok(iEnvs > 0 && iScript > iEnvs && iExport > iScript, "không tìm thấy khối envs/script của bước SSH");
  assert.ok(deploy.slice(iEnvs, iScript).includes("AGENT_INGEST_SECRET"), "khoá phải nằm trong danh sách envs của bước SSH");
  assert.ok(deploy.slice(iExport, iSauExport).includes("AGENT_INGEST_SECRET"), "và phải được export trong script chạy trên VPS");
  // Đọc theo DÒNG, không regex: một chuỗi thoát viết sai làm bộ gác lặng lẽ đo nhầm thứ khác.
  assert.ok(install.includes("upsert_env AGENT_INGEST_SECRET"), "install-vps.sh phải ghi khoá vào .env của máy đã có sẵn");
  // Nháy ĐƠN: `String.raw` vẫn nội suy `${...}`, nên chuỗi shell phải đi trong chuỗi không nội suy.
  assert.ok(install.includes('AGENT_INGEST_SECRET="${AGENT_INGEST_SECRET:-}"'), "mẫu .env mới cũng phải có khoá");

  /*
    ───────── 3.10 CỬA NHẬN CẢ HAI KHOÁ, VÀ LUÔN SO ĐỦ HAI LƯỢT ─────────

    Viết `secretEquals(a) || secretEquals(b)` với `||` ngắn mạch thì thời gian trả lời phụ thuộc
    việc máy chủ đang khai khoá nào — một kênh rò rỉ nhỏ nhưng có thật trên cửa hướng ra Internet.
  */
  /*
    ───────── 3.11 MIDDLEWARE PHẢI CHO TUYẾN NÀY ĐI QUA ─────────

    ĐÃ ĐO THẬT trên production (20/09/2026, bản `d24a5da`): `POST /api/tech/agent-run` trả **401**
    kể cả khi không kèm khoá, kèm khoá sai, hay gọi bằng `GET` (tuyến này không có `GET`, lẽ ra
    phải là 405). Cả ba giống hệt nhau vì cả ba dừng ở `middleware.ts` — phép kiểm khoá của chính
    route KHÔNG BAO GIỜ chạy tới.

    Đây là kiểu hỏng TỆ NHẤT của lớp cấu hình: người vận hành thấy 401 sẽ đi khai lại khoá, trong
    khi khoá chưa từng được đọc. Cửa có đúng mã, có đúng migration, có đúng secret — và vẫn không
    bao giờ mở.

    Hai vế phải cùng đúng, và vế thứ hai mới là vế dễ mất:
      · tuyến CÓ MẶT trong `PUBLIC_PREFIXES` (nếu không thì không với tới được);
      · tiền tố cụt `/api/tech` KHÔNG có mặt — khai cụt là mở TOÀN BỘ bề mặt API của Phòng Tech AI
        cho lượt gọi không đăng nhập. Một ký tự thiếu đổi cửa hẹp thành cửa rộng.
  */
  const mw = readFileSync(path.join(goc, "middleware.ts"), "utf8");
  const iDs = mw.indexOf("const PUBLIC_PREFIXES");
  const dsCongKhai = mw.slice(iDs, mw.indexOf("]", iDs));
  assert.ok(iDs > 0, "không đọc được PUBLIC_PREFIXES của middleware");
  assert.ok(dsCongKhai.includes('"/api/tech/agent-run"'), "middleware phải cho tuyến chép sổ đi qua — nếu không, phép kiểm khoá của route không bao giờ chạy");
  assert.ok(dsCongKhai.includes('"/api/tech/agent-task"'), "cửa ĐỌC cũng phải đi qua được — cùng lý do, và cùng kiểu hỏng im lặng nếu quên");
  assert.ok(!dsCongKhai.includes('"/api/tech"'), "KHÔNG khai tiền tố cụt /api/tech — nó mở toàn bộ bề mặt API Phòng Tech AI");
  assert.ok(!dsCongKhai.includes('"/api/tech/"'), "cũng không khai /api/tech/ — cùng hậu quả");

  assert.ok(route.includes("env.agentIngestSecret"), "cửa phải nhận khoá riêng");
  /*
    Hai lượt so phải CHẠY ĐỦ. Viết `secretEquals(a) || secretEquals(b)` thì `||` ngắn mạch, và thời
    gian trả lời tiết lộ máy chủ đang khai khoá nào — một kênh rò rỉ nhỏ nhưng có thật trên cửa
    hướng ra Internet. Đo bằng THỨ TỰ hai lượt gán, không bằng một biểu thức chính quy dễ viết sai.
  */
  const iRieng = route.indexOf("const rieng = secretEquals(");
  const iLapLich = route.indexOf("const lapLich = secretEquals(");
  const iTra = route.indexOf("return rieng || lapLich;");
  assert.ok(iRieng > 0 && iLapLich > iRieng && iTra > iLapLich, "phải gán đủ hai lượt so TRƯỚC khi hợp lại bằng ||");
  assert.ok(!wf.includes("DATABASE_URL: ${{"), "máy Actions KHÔNG bao giờ nhận DATABASE_URL của production");
  console.log("✓ Cửa hẹp theo hình dạng: không nhận SQL/tên bảng · .strict() · không GET · không đường phiên · chỉ ghi 1 bảng · không in bí mật · khoá RIÊNG (không mượn khoá bộ lập lịch) · tên miền khai một lần · secret thông được tới .env");
}

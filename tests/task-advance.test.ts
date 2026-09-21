import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TASK_ADVANCE_NEVER, TASK_ADVANCE_RULES, shouldAdvanceTask, type TaskPrState } from "@/lib/constants/task-advance";
import { TECH_TASK_TRANSITIONS } from "@/lib/constants/tech";
import { DISPATCHABLE_STATUSES } from "@/lib/constants/agent-dispatch";
import { advanceTasksFromGithub } from "@/lib/tech/task-advance-watch";
import { setTechTaskStatus } from "@/lib/tech/service";

/**
 * ═══════════ NẤC 4 · VIỆC TỰ ĐI TIẾP THEO BẰNG CHỨNG GITHUB ═══════════
 *
 * Tới Nấc 3b, phép chiếu PR đã chép trạng thái PR về `tech_tasks`. Nhưng TRẠNG THÁI VIỆC vẫn chỉ
 * nhúc nhích khi có người bấm — nên hàng đợi `/tech` đo TRÍ NHỚ của người bấm chứ không đo việc
 * thật sự đang ở đâu.
 *
 * Bài này khoá ba tính chất, và tính chất thứ ba là thứ quyết định bộ này có được dùng hay bị
 * tắt đi:
 *
 *   1. Máy chỉ đi ĐÚNG HAI bước có bằng chứng dứt khoát.
 *   2. Máy KHÔNG BAO GIỜ tự đặt những trạng thái là QUYẾT ĐỊNH hoặc lời QUY KẾT.
 *   3. MÁY KHÔNG CÃI NGƯỜI.
 */

const goc = path.resolve(__dirname, "..");

const pr = (o: Partial<TaskPrState>): TaskPrState => ({ prNumber: 1, prState: "", ciState: "", reviewState: "", mergeState: "", ...o });

/* ═════════════ 1 · LUẬT THUẦN ═════════════ */

export function testTaskAdvancePure() {
  // ───────── Hai bước được phép ─────────
  const mo = shouldAdvanceTask({ status: "BUILDING", pr: pr({ prState: "OPEN" }), nguoiVuaDoi: false });
  assert.ok(mo.advance && mo.to === "REVIEW", "có PR đang mở ⇒ BUILDING → REVIEW");
  const gop = shouldAdvanceTask({ status: "REVIEW", pr: pr({ prState: "MERGED" }), nguoiVuaDoi: false });
  assert.ok(gop.advance && gop.to === "QA", "PR đã gộp ⇒ REVIEW → QA");

  /*
    ───────── MÁY KHÔNG CÃI NGƯỜI ─────────

    Tính chất quyết định bộ này có được dùng hay không. Một người kéo việc từ REVIEW về BUILDING
    (vì họ biết điều gì đó máy không biết) mà thấy nó tự nhảy lại sau mười phút thì lần thứ hai họ
    sẽ tắt hẳn bộ này đi.
  */
  const nguoiGiu = shouldAdvanceTask({ status: "BUILDING", pr: pr({ prState: "OPEN" }), nguoiVuaDoi: true });
  assert.ok(!nguoiGiu.advance, "người vừa đổi ⇒ máy KHÔNG đẩy tiếp");
  assert.match(nguoiGiu.reason, /NGƯỜI/, "và phải nói rõ vì sao");

  /*
    ───────── KHÚC ĐẦU CŨNG PHẢI ĐI ĐƯỢC ─────────

    ĐO PRODUCTION 21/09/2026: TECH-2 nằm ở TRIAGED trong khi PR #82 của nó ĐÃ GỘP. Việc được giao
    thẳng từ giao diện Actions nên không ai bấm nó sang BUILDING, và không luật nào nhận nó.
  */
  for (const tu of ["TRIAGED", "SPEC_READY"]) {
    const v = shouldAdvanceTask({ status: tu, pr: pr({ prState: "OPEN" }), nguoiVuaDoi: false });
    assert.ok(v.advance && v.to === "BUILDING", `${tu} + PR mở ⇒ BUILDING`);
  }

  /*
    ───────── BẰNG CHỨNG "ĐÃ CÓ PR" KHÔNG HẾT HẠN KHI PR GỘP ─────────

    Bản đầu của bộ này đòi `prState === "OPEN"` ở mọi khúc đầu, nên một việc không được đẩy ĐÚNG
    LÚC PR còn mở thì mắc kẹt vĩnh viễn: cửa sổ quan sát đóng lại và không luật nào còn khớp.
    Khẳng định cũ ở đây ("BUILDING với PR MERGED không được đẩy") mã hoá đúng chỗ hỏng ấy.

    Một bộ tự động chỉ đúng khi nó chạy đúng nhịp là một bộ tự động sẽ sai — nó không chịu được
    một lần mất điện, một lần đổi lịch, hay một lượt chạy khởi động từ chỗ khác.
  */
  const ketDuocGo = shouldAdvanceTask({ status: "BUILDING", pr: pr({ prState: "MERGED" }), nguoiVuaDoi: false });
  assert.ok(ketDuocGo.advance && ketDuocGo.to === "REVIEW", "việc bị bỏ lỡ lúc PR còn mở vẫn phải đi tiếp được sau khi PR gộp");
  assert.ok(shouldAdvanceTask({ status: "TRIAGED", pr: pr({ prState: "MERGED" }), nguoiVuaDoi: false }).advance, "TRIAGED + PR đã gộp vẫn phải nhận ra là đã có người làm");

  // ───────── Chưa đủ bằng chứng ─────────
  for (const st of ["", "CLOSED"]) {
    const v = shouldAdvanceTask({ status: "BUILDING", pr: pr({ prState: st }), nguoiVuaDoi: false });
    assert.ok(!v.advance, `BUILDING với PR "${st}" KHÔNG được đẩy sang REVIEW`);
  }
  /*
    PR ĐÓNG MÀ KHÔNG GỘP là bằng chứng rằng thứ đã làm KHÔNG được dùng. Đi tới bằng một cái đã bỏ
    là tệ hơn đứng yên.
  */
  for (const tu of ["TRIAGED", "SPEC_READY"]) {
    assert.ok(!shouldAdvanceTask({ status: tu, pr: pr({ prState: "CLOSED" }), nguoiVuaDoi: false }).advance, `${tu} + PR bị đóng bỏ ⇒ KHÔNG đẩy`);
  }
  assert.ok(!shouldAdvanceTask({ status: "REVIEW", pr: pr({ prState: "OPEN" }), nguoiVuaDoi: false }).advance, "PR còn mở thì chưa qua QA");
  assert.ok(!shouldAdvanceTask({ status: "REVIEW", pr: pr({ prState: "CLOSED" }), nguoiVuaDoi: false }).advance, "PR đóng mà KHÔNG gộp ⇒ không phải đã xong review");

  /*
    ───────── NHỮNG TRẠNG THÁI MÁY KHÔNG BAO GIỜ TỰ ĐẶT ─────────

    `DONE` cần bằng chứng production — máy không có, nên tự đóng là bịa. `FAILED`/`BLOCKED` là lời
    QUY KẾT: CI đỏ giữa chừng là chuyện bình thường của một PR đang làm.
  */
  const dich = TASK_ADVANCE_RULES.map((r) => r.to);
  for (const cam of TASK_ADVANCE_NEVER) {
    assert.ok(!dich.includes(cam), `máy KHÔNG BAO GIỜ được tự đặt trạng thái ${cam}`);
  }
  assert.deepEqual([...dich], ["BUILDING", "BUILDING", "REVIEW", "QA"], "đúng ba đích, không hơn — mọi trạng thái còn lại là QUYẾT ĐỊNH hoặc lời QUY KẾT");

  /*
    Mỗi trạng thái nhiều nhất MỘT luật: hai luật cùng `from` là một cuộc đua không ai thắng chắc,
    và kết quả sẽ phụ thuộc vào thứ tự khai trong mảng.
  */
  const tuTrangThai = TASK_ADVANCE_RULES.map((r) => r.from);
  assert.equal(new Set(tuTrangThai).size, tuTrangThai.length, "mỗi trạng thái nhiều nhất MỘT luật đẩy");

  /* Mọi trạng thái GIAO ĐƯỢC cho agent phải có đường đi tiếp — nếu không, việc agent làm sẽ mắc kẹt. */
  for (const st of DISPATCHABLE_STATUSES) {
    assert.ok(tuTrangThai.includes(st), `${st} giao được cho agent nhưng KHÔNG có luật đẩy — việc sẽ mắc kẹt như TECH-2`);
  }

  /* Mọi luật phải là phép chuyển hợp lệ theo bảng CÓ THẨM QUYỀN. */
  for (const r of TASK_ADVANCE_RULES) {
    assert.ok(TECH_TASK_TRANSITIONS[r.from].includes(r.to), `${r.from} → ${r.to} phải nằm trong TECH_TASK_TRANSITIONS`);
  }
}

/* ═════════════ 2 · CHẠY THẬT TRÊN CSDL ═════════════ */

export async function testTaskAdvanceDb() {
  const db = await getDb();
  await cleanupTaskAdvanceFixtures();
  const may = { kind: "SYSTEM" as const, id: null, name: "test:advance" };

  const [t1] = await db
    .insert(schema.techTasks)
    .values({ code: "ADV-1", title: "adv-có PR mở", status: "BUILDING", risk: "R0", prNumber: 11, prState: "OPEN", prSyncedAt: new Date() })
    .returning({ id: schema.techTasks.id });
  await db
    .insert(schema.techTasks)
    .values({ code: "ADV-2", title: "adv-PR đã gộp", status: "REVIEW", risk: "R0", prNumber: 12, prState: "MERGED", prSyncedAt: new Date() });
  /*
    ADV-3: CHƯA có phép chiếu PR (`pr_synced_at` rỗng). Mọi ô `pr_*` là CHƯA BIẾT, không phải
    "không có PR" — đẩy theo chưa-biết là đoán.
  */
  await db.insert(schema.techTasks).values({ code: "ADV-3", title: "adv-chưa đồng bộ", status: "BUILDING", risk: "R0", prState: "OPEN" });
  const [t4] = await db
    .insert(schema.techTasks)
    .values({ code: "ADV-4", title: "adv-người vừa đổi", status: "BUILDING", risk: "R0", prNumber: 14, prState: "OPEN", prSyncedAt: new Date() })
    .returning({ id: schema.techTasks.id });

  /* NGƯỜI kéo ADV-4 về BUILDING — máy phải để nguyên. */
  await setTechTaskStatus({ taskId: t4.id, to: "REVIEW" }, may);
  await setTechTaskStatus({ taskId: t4.id, to: "BUILDING", note: "người biết điều máy không biết" }, { kind: "HUMAN", id: null, name: "adv-nguoi" });

  const r = await advanceTasksFromGithub();
  assert.equal(r.daDay, 2, `phải đẩy đúng 2 việc, nhận ${r.daDay}: ${JSON.stringify(r.chiTiet)}`);
  assert.equal(r.nguoiGiu, 1, "đúng một việc bị giữ lại vì người vừa đổi");

  const sau = await db.query.techTasks.findMany({ where: like(schema.techTasks.code, "ADV-%"), columns: { code: true, status: true } });
  const map = Object.fromEntries(sau.map((x) => [x.code, x.status]));
  assert.equal(map["ADV-1"], "REVIEW");
  assert.equal(map["ADV-2"], "QA");
  assert.equal(map["ADV-3"], "BUILDING", "việc CHƯA có phép chiếu PR phải để nguyên — chưa biết không phải là bằng chứng");
  assert.equal(map["ADV-4"], "BUILDING", "MÁY KHÔNG CÃI NGƯỜI");

  /*
    ───────── CHẠY LẠI KHÔNG ĐẨY THÊM ─────────
    ADV-1 nay ở REVIEW với PR đang MỞ ⇒ không luật nào khớp. Đây là idempotent tự nhiên: trạng
    thái đã đổi thì `from` không còn khớp nữa.
  */
  const lai = await advanceTasksFromGithub();
  assert.equal(lai.daDay, 0, `chạy lại KHÔNG được đẩy thêm, nhận ${lai.daDay}: ${JSON.stringify(lai.chiTiet)}`);

  /* Lượt đẩy phải để lại VẾT, và vết nói rõ MÁY làm. */
  const sk = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, t1.id), columns: { kind: true, actorKind: true, actorId: true, nextValue: true } });
  const day = sk.filter((x) => x.kind === "STATUS" && x.nextValue === "REVIEW");
  assert.equal(day.length, 1, "đúng một sự kiện STATUS cho lượt đẩy");
  assert.equal(day[0].actorKind, "SYSTEM", "vết phải nói rõ MÁY làm");
  assert.equal(day[0].actorId, null, "máy làm ⇒ không có khoá tài khoản, và đó là câu trả lời ĐÚNG");

  /* Và sau khi MÁY đẩy, máy vẫn được đẩy tiếp — chỉ NGƯỜI mới chặn. */
  await db.update(schema.techTasks).set({ prState: "MERGED" }).where(eq(schema.techTasks.id, t1.id));
  const tiep = await advanceTasksFromGithub();
  assert.equal(tiep.daDay, 1, "máy đẩy xong vẫn được đẩy tiếp ở chu kỳ sau — chỉ NGƯỜI mới giữ lại");

  await cleanupTaskAdvanceFixtures();
}

export async function cleanupTaskAdvanceFixtures() {
  const db = await getDb();
  const v = await db.query.techTasks.findMany({ where: like(schema.techTasks.code, "ADV-%"), columns: { id: true } });
  if (v.length) {
    await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, v.map((x) => x.id)));
    await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, v.map((x) => x.id)));
  }
}

/* ═════════════ 3 · QUÉT MÃ NGUỒN ═════════════ */

export function testTaskAdvanceGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const w = bo(readFileSync(path.join(goc, "lib/tech/task-advance-watch.ts"), "utf8"));

  /*
    ĐI QUA ĐÚNG CỬA MÀ NGƯỜI ĐI.

    `setTechTaskStatus()` giữ phép chuyển hợp lệ, ghi sự kiện, đặt `started_at`/`completed_at`, và
    chặn những nước đi cấm. Một `update` thẳng bảng là một đường ghi thứ hai không ai kiểm được —
    và nó sẽ lặng lẽ khác đi sau vài tháng.
  */
  assert.ok(w.includes("setTechTaskStatus("), "phải đi qua hàm dịch vụ, không update thẳng");
  assert.ok(!/db\s*\.\s*update\(schema\.techTasks\)/.test(w), "KHÔNG được update thẳng bảng việc");

  /* Chỉ xét việc ĐÃ có phép chiếu PR — chưa biết không phải bằng chứng. */
  assert.ok(w.includes("isNotNull(schema.techTasks.prSyncedAt)"), "phải loại việc chưa có phép chiếu PR");

  /* Vết phải nói rõ MÁY làm, không mượn danh một người. */
  assert.ok(w.includes('kind: "SYSTEM"'), "actor phải là SYSTEM");
  assert.ok(!/kind:\s*"HUMAN"/.test(w), "máy KHÔNG được ghi dưới danh nghĩa người");

  /* Job phải có lịch: một bộ đẩy không ai gọi thì bằng không có. */
  const sch = readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  assert.ok(sch.includes('job: "task-advance-watch"'), "bộ đẩy phải nằm trong bộ lập lịch");

  console.log("✓ Đẩy trạng thái việc (Nấc 4): đúng HAI bước có bằng chứng · không bao giờ tự đặt DONE/FAILED/BLOCKED/READY_TO_DEPLOY · MÁY KHÔNG CÃI NGƯỜI · chưa có phép chiếu PR thì để nguyên · đi qua đúng cửa dịch vụ · chạy lại không đẩy thêm");
}

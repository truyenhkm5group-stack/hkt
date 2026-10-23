/**
 * ═══ SỔ THEO DÕI TÁI DIỄN — LỖI 2B ĐÃ SỬA MÀ LỌT LẠI THÌ TỰ MỞ LẠI, KHÔNG DONE (Tech Lead 22/10/2026) ═══
 *
 * Khoá: (1) sổ khai đúng — mã có thật, chiều `delivery` khớp vai, mốc ISO, sứ mệnh không trùng, ai-tech đọc đúng tập sứ mệnh;
 * (2) chỉ hit SAU `liveAt` mới tính, ĐÃ CHẶN ≠ LỌT; (3) một việc cho (mã, sứ mệnh) — chạy nhiều ngày không đẻ việc mới, đóng rồi lọt
 * lại thì MỞ LẠI đúng việc ấy, đóng mà không lọt mới thì giữ đóng, mỗi lần tạo / mở lại gửi MỘT tin; (4) bảng ops gộp không mang mã
 * tổ chức và rơi về UNKNOWN khi không kết luận được; (5) ai-tech từ chối DONE khi thiếu bằng chứng hoặc còn tái diễn.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  REGRESSION_WATCH,
  countAfterLive,
  parseRegressionSummary,
  regressionDedupeKey,
  regressionVerdict,
  reopenAction,
  watchAppliesTo,
  watchedMissionsFromSource,
  type WatchHit,
} from "@/lib/constants/regression-watch";
import { SALES_QUALITY_CODES, SALES_QUALITY_SPEC, type SalesQualityCode } from "@/lib/constants/sales-quality";
import { appendHistory, salesQualityRates } from "@/lib/sales-quality/daily";
import { applyRegressionWatch, runningSha } from "@/lib/sales-quality/regression";
import { parseRegressionRunLog, regressionDoneGate, regressionWatchedMissions } from "../scripts/ai-tech";
import { regressionStatusLines, regressionStatusTable, type OrgRegressionSnapshot } from "../scripts/regression-watch-status";

const SO = readFileSync("lib/constants/regression-watch.ts", "utf8");
const row = (mission: string) => REGRESSION_WATCH.find((r) => r.mission === mission)!;

function testRegistry() {
  const codes = new Set<string>(SALES_QUALITY_CODES);
  const seen = new Set<string>();
  for (const r of REGRESSION_WATCH) {
    assert.ok(!seen.has(r.mission), `${r.mission}: một sứ mệnh một dòng`);
    seen.add(r.mission);
    assert.match(r.sha, /^[0-9a-f]{40}$/, `${r.mission}: SHA đủ 40 ký tự`);
    assert.ok(Number.isFinite(Date.parse(r.liveAt)) && r.liveAt.endsWith("Z"), `${r.mission}: liveAt là ISO UTC`);
    assert.ok(r.deployRun > 0 && r.pr > 0);
    for (const c of r.leakCodes) {
      assert.ok(codes.has(c), `${r.mission}: mã ${c} có thật`);
      assert.equal(SALES_QUALITY_SPEC[c].delivery, "REACHED_CUSTOMER", `${r.mission}: ${c} là lọt tới khách — mã ĐÃ CHẶN không bao giờ là tái diễn`);
    }
    for (const c of r.blockedCodes) assert.equal(SALES_QUALITY_SPEC[c].delivery, "BLOCKED_PRE_SEND", `${r.mission}: ${c} là lần chặn`);
    assert.equal(Boolean(r.leakUnavailable), r.leakCodes.length === 0, `${r.mission}: không có mã lọt ⇔ phải khai leakUnavailable (thiếu gì)`);
    if (r.leakUnavailable) assert.ok(r.leakUnavailable.length > 40, `${r.mission}: leakUnavailable nói cụ thể thiếu gì`);
  }
  // ai-tech đọc CHỮ của sổ trên main: hai phép đọc phải ra đúng tập sứ mệnh của sổ.
  const that = REGRESSION_WATCH.map((r) => r.mission).sort();
  assert.deepEqual(watchedMissionsFromSource(SO).sort(), that, "sổ tự đọc chữ của mình đúng");
  assert.deepEqual(regressionWatchedMissions(SO).sort(), that, "ai-tech đọc chữ của sổ đúng — khai `mission: \"…\"` mỗi dòng");
  assert.ok(!/^import (?!type )/m.test(SO), "sổ chỉ `import type` (ai-tech đọc chữ, không chạy mã)");
  // Mã chặn trước khi gửi — chiều khai ở sổ mã 2B.
  for (const c of ["QUANTITY_UNIT_AMBIGUOUS", "PACK_MULTIPLIER_MISMATCH", "CART_TOTAL_CONFLICT", "ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT", "CLAIM_GUARD_BLOCK"] as const) assert.equal(SALES_QUALITY_SPEC[c].delivery, "BLOCKED_PRE_SEND");
  assert.equal(SALES_QUALITY_SPEC.ADDRESS_REASK.delivery, "REACHED_CUSTOMER");
  // Bốn bản sửa P0 có dòng, mốc là mốc DEPLOY xanh (đo API Actions 22/10/2026), không phải mốc gộp.
  assert.deepEqual(
    REGRESSION_WATCH.map((r) => [r.pr, r.liveAt]),
    [[945, "2026-10-21T08:42:12Z"], [959, "2026-10-21T20:58:25Z"], [966, "2026-10-22T07:23:47Z"], [968, "2026-10-22T11:19:35Z"], [972, "2026-10-22T13:35:10Z"]],
  );
  assert.deepEqual(REGRESSION_WATCH.filter((r) => r.leakCodes.includes("ADDRESS_REASK")).map((r) => r.mission), ["address-resolver-ladder"], "ADDRESS_REASK nối #972, không nối #966");
  for (const r of REGRESSION_WATCH) if (r.leakMeasuredFrom) assert.ok(Date.parse(r.leakMeasuredFrom) >= Date.parse(r.liveAt), `${r.mission}: bộ dò lọt không thể có trước bản sửa`);
  assert.ok(watchAppliesTo(row("sales-address-applied"), null) && watchAppliesTo(row("sales-address-applied"), "hslc"), "ALL áp mọi tổ chức");
}

function testCounting() {
  const r = row("sales-short-qty-round");
  const live = Date.parse(r.liveAt);
  const h = (code: SalesQualityCode, ms: number, conv = "c1"): WatchHit => ({ code, at: new Date(live + ms), conv });
  const { leaked, blocked } = countAfterLive(r, [h("QTY_REASKED", -60_000), h("QTY_REASKED", 0), h("QTY_REASKED", 60_000), h("QTY_REASKED", 120_000, "c2"), h("CLARIFY_FALLBACK", 60_000)]);
  assert.equal(leaked.get("QTY_REASKED")?.hits, 2, "chỉ hit SAU liveAt (trước và ĐÚNG mốc không tính — bản sửa chưa chạy)");
  assert.equal(leaked.get("QTY_REASKED")?.convs.size, 2);
  assert.ok(!leaked.has("CLARIFY_FALLBACK"), "mã không thuộc dòng sổ không tính");
  assert.equal(blocked, 0);
  assert.equal(regressionVerdict(r, 2, 0), "REGRESSION_REOPENED");
  assert.equal(regressionVerdict(r, 0, 0), "QUIET");
  const g = row("sales-qty-unit-guard");
  const c2 = countAfterLive(g, [{ code: "PACK_MULTIPLIER_MISMATCH", at: new Date(Date.parse(g.liveAt) + 1000), conv: "x" }, { code: "CART_TOTAL_CONFLICT", at: new Date(Date.parse(g.liveAt) - 1000), conv: "x" }]);
  assert.equal(c2.blocked, 1, "lần CHẶN sau mốc đếm vào «đã chặn»");
  assert.equal(c2.leaked.size, 0, "ĐÃ CHẶN không bao giờ là lọt");
  assert.equal(regressionVerdict(g, 0, c2.blocked), "HOLDING", "có chặn, 0 lọt ⇒ hàng rào đang giữ");
  assert.deepEqual(g.leakCodes, ["PACK_MULTIPLIER_LEAKED"], "#968 đo lọt bằng bộ dò #975");
  assert.equal(g.leakMeasuredFrom, "2026-10-22T15:23:51Z", "bộ dò lọt có từ lúc #975 lên production");
  const c3 = countAfterLive(g, [{ code: "PACK_MULTIPLIER_LEAKED", at: new Date(Date.parse(g.liveAt) + 1000), conv: "x" }]);
  assert.equal(regressionVerdict(g, c3.leaked.get("PACK_MULTIPLIER_LEAKED")?.hits ?? 0, 0), "REGRESSION_REOPENED", "lọt sau mốc #968 ⇒ tái diễn (đếm từ liveAt, không từ leakMeasuredFrom)");
  const chuaDo = { ...g, leakCodes: [], leakUnavailable: "chưa có bộ dò lọt — kiểm thử" };
  assert.equal(regressionVerdict(chuaDo, 0, 1), "LEAK_UNAVAILABLE", "chưa có bộ dò lọt ⇒ không kết luận «yên», không REOPEN");
  const t = new Date("2026-10-23T00:00:00Z");
  assert.equal(reopenAction(null, t), "CREATE");
  assert.equal(reopenAction({ resolvedAt: null }, t), "REFRESH");
  assert.equal(reopenAction({ resolvedAt: new Date(t.getTime() - 1) }, t), "REOPEN", "đóng rồi lọt SAU lúc đóng ⇒ mở lại");
  assert.equal(reopenAction({ resolvedAt: t }, t), "KEEP_CLOSED", "lọt đúng / trước lúc đóng ⇒ người đóng đã thấy");
  const counts = Object.fromEntries(SALES_QUALITY_CODES.map((c) => [c, 0])) as Record<SalesQualityCode, number>;
  counts.QTY_REASKED = 3;
  counts.PACK_MULTIPLIER_MISMATCH = 2;
  assert.deepEqual(salesQualityRates(counts, 1), { detected: 5, blocked: 2, leaked: 3, regressions: 1 });
  const hist = appendHistory(appendHistory([{ day: "2026-10-20", detected: 1, blocked: 0, leaked: 1, regressions: 0 }, "rác"], "2026-10-21", salesQualityRates(counts, 0)), "2026-10-21", salesQualityRates(counts, 1));
  assert.deepEqual(hist.map((x) => [x.day, x.regressions]), [["2026-10-20", 0], ["2026-10-21", 1]], "một dòng / ngày, chạy lại cùng ngày thay dòng cũ");
  let dai: ReturnType<typeof appendHistory> = [];
  for (let i = 1; i <= 40; i++) dai = appendHistory(dai, `2026-09-${String(i).padStart(2, "0")}`, salesQualityRates(counts, 0));
  assert.equal(dai.length, 30, "giữ 30 ngày");
  assert.equal(runningSha({ ERP_IMAGE: "ghcr.io/x/erp:66c334a15b9fdbf1dc29ee559fc1a611aa2f631e" }), "66c334a15b9fdbf1dc29ee559fc1a611aa2f631e");
  assert.equal(runningSha({}), null, "không khai ⇒ null (in «không đọc được»), không đoán");
}

async function testReopenFlow(db: Db) {
  const n = schema.notifications;
  const wipe = () => db.delete(n).where(like(n.dedupeKey, "sales-quality:regression:%"));
  await wipe();
  try {
    const r = row("upsell-short-accept");
    const live = Date.parse(r.liveAt);
    const key = regressionDedupeKey("UPSELL_ACCEPTED_BUT_REASKED", r.mission);
    const sent: string[][] = [];
    const deps = { deliver: async (ids: { id: string }[]) => void sent.push(ids.map((x) => x.id)), sha: "abc1234" };
    const at = (ms: number) => new Date(live + ms);
    const hit = (ms: number, conv = "conv-1"): WatchHit => ({ code: "UPSELL_ACCEPTED_BUT_REASKED", at: at(ms), conv });
    const run = (day: string, hits: WatchHit[], nowMs: number) => applyRegressionWatch(db, { day, now: at(nowMs), hits, orgCode: "kiem-thu" }, deps);

    // Trước mốc ⇒ không việc.
    const r0 = await run("2026-10-21", [hit(-5_000)], 3_600_000);
    assert.equal(r0.regressions, 0);
    assert.equal((await db.select().from(n).where(eq(n.dedupeKey, key))).length, 0, "lọt TRƯỚC mốc lên production không phải tái diễn");
    // Sau mốc ⇒ MỘT việc + MỘT tin.
    const r1 = await run("2026-10-22", [hit(60_000), hit(120_000, "conv-2")], 86_400_000);
    assert.equal(r1.rows.find((x) => x.code === "UPSELL_ACCEPTED_BUT_REASKED")?.action, "CREATE");
    let [v] = await db.select().from(n).where(eq(n.dedupeKey, key));
    assert.ok(v && v.kind === "SALES_QUALITY" && v.resolvedAt === null && v.severity === "critical", "việc /work của 2B (kind SALES_QUALITY), mức nghiêm trọng");
    assert.match(v.title, /TÁI DIỄN sau bản sửa .* 2 lần lọt tới khách \/ 2 hội thoại/);
    assert.match(v.body, /PR #959, f574c1975/);
    assert.match(v.body, /Commit đang chạy: abc1234/);
    assert.ok(!v.body.includes("conv-1") && !v.body.includes("conv-2"), "chỉ mã BĂM, không mã hội thoại thô");
    assert.deepEqual(sent, [[v.id]], "gửi MỘT tin lúc tạo");
    // Ngày kế còn lọt, việc đang mở ⇒ cập nhật, KHÔNG việc thứ hai, KHÔNG tin thứ hai.
    const r2 = await run("2026-10-23", [hit(2 * 86_400_000)], 3 * 86_400_000);
    assert.equal(r2.rows.find((x) => x.code === "UPSELL_ACCEPTED_BUT_REASKED")?.action, "REFRESH");
    assert.equal((await db.select().from(n).where(like(n.dedupeKey, "sales-quality:regression:%"))).length, 1, "lọt nhiều ngày ⇒ vẫn MỘT việc (khoá mã + sứ mệnh, không theo ngày)");
    assert.equal(sent.length, 1, "việc đang mở ⇒ không gửi lại");
    // Người đóng việc lúc T.
    const dong = at(4 * 86_400_000);
    await db.update(n).set({ resolvedAt: dong, resolution: "MANUAL", notifiedAt: dong, notifyAttempts: 1 }).where(eq(n.dedupeKey, key));
    // Lượt chạy chỉ thấy lọt TRƯỚC lúc đóng ⇒ giữ đóng.
    const r3 = await run("2026-10-24", [hit(4 * 86_400_000 - 60_000)], 5 * 86_400_000);
    assert.equal(r3.rows.find((x) => x.code === "UPSELL_ACCEPTED_BUT_REASKED")?.action, "KEEP_CLOSED");
    [v] = await db.select().from(n).where(eq(n.dedupeKey, key));
    assert.ok(v.resolvedAt !== null, "đóng mà không có lọt mới sau lúc đóng ⇒ giữ đóng");
    // Lọt SAU lúc đóng ⇒ MỞ LẠI đúng việc ấy + MỘT tin.
    const r4 = await run("2026-10-25", [hit(5 * 86_400_000)], 6 * 86_400_000);
    assert.equal(r4.rows.find((x) => x.code === "UPSELL_ACCEPTED_BUT_REASKED")?.action, "REOPEN");
    const [v2] = await db.select().from(n).where(eq(n.dedupeKey, key));
    assert.equal(v2.id, v.id, "mở lại ĐÚNG việc cũ, không tạo việc mới");
    assert.deepEqual([v2.resolvedAt, v2.resolution, v2.notifiedAt, v2.notifyAttempts], [null, null, null, null], "xoá mốc đóng + mốc gửi để kênh cảnh báo báo lại");
    assert.deepEqual(sent, [[v.id], [v.id]], "mở lại ⇒ gửi đúng MỘT tin");
    // Hàng rào chặn sau mốc, không lọt ⇒ HOLDING, không việc nào.
    const g = row("sales-qty-unit-guard");
    const r5 = await applyRegressionWatch(db, { day: "2026-10-25", now: new Date(Date.parse(g.liveAt) + 3_600_000), hits: [{ code: "PACK_MULTIPLIER_MISMATCH", at: new Date(Date.parse(g.liveAt) + 60_000), conv: "x" }], orgCode: null }, deps);
    const gr = r5.rows.find((x) => x.mission === g.mission)!;
    assert.deepEqual([gr.code, gr.verdict, gr.leaked, gr.blocked, gr.action], ["PACK_MULTIPLIER_LEAKED", "HOLDING", 0, 1, null], "đã chặn ⇒ bằng chứng hàng rào chạy, 0 lọt, không việc");
    assert.equal((await db.select().from(n).where(eq(n.dedupeKey, regressionDedupeKey("PACK_MULTIPLIER_LEAKED", g.mission)))).length, 0);
    // Lọt sau mốc ⇒ việc tái diễn nói rõ bộ dò lọt có từ khi nào, và tách số đã chặn.
    const sau = Date.parse(g.leakMeasuredFrom!);
    await applyRegressionWatch(db, { day: "2026-10-25", now: new Date(sau + 3_600_000), hits: [{ code: "PACK_MULTIPLIER_LEAKED", at: new Date(sau + 60_000), conv: "y" }], orgCode: null }, deps);
    const [gv] = await db.select().from(n).where(eq(n.dedupeKey, regressionDedupeKey("PACK_MULTIPLIER_LEAKED", g.mission)));
    assert.match(gv?.body ?? "", /bộ dò lọt có từ 22:23 22\/10 — đo lọt từ mốc ấy/, "việc nói rõ đo lọt từ lúc bộ dò lên");
    assert.match(gv?.body ?? "", /Đã CHẶN trước khi gửi trong cùng kỳ/, "kèm số đã chặn — tách khỏi số lọt");
    // Phạm vi tổ chức: dòng khai riêng một tổ chức thì tổ chức khác không thấy.
    assert.equal(watchAppliesTo({ ...g, orgScope: ["hslc"] }, "khac"), false);
    assert.equal(watchAppliesTo({ ...g, orgScope: ["hslc"] }, null), false, "không biết tổ chức ⇒ phía HẸP");
  } finally {
    await wipe();
  }
}

function testStatusTable() {
  const base: OrgRegressionSnapshot = { day: "2026-10-23", rows: [], items: [] };
  const reopenKey = regressionDedupeKey("UPSELL_ACCEPTED_BUT_REASKED", "upsell-short-accept");
  const snaps: OrgRegressionSnapshot[] = [
    { ...base, rows: [{ mission: "upsell-short-accept", code: "UPSELL_ACCEPTED_BUT_REASKED", leaked: 3, blocked: 0, verdict: "REGRESSION_REOPENED", action: "CREATE" }], items: [{ dedupeKey: reopenKey, open: true }] },
    { ...base, rows: [{ mission: "sales-qty-unit-guard", code: "PACK_MULTIPLIER_LEAKED", leaked: 0, blocked: 4, verdict: "HOLDING", action: null }], items: [{ dedupeKey: reopenKey, open: false }] },
  ];
  const t = regressionStatusTable(snaps);
  const q = t.find((x) => x.mission === "sales-qty-unit-guard")!;
  assert.deepEqual([q.code, q.leaked, q.blocked, q.status, q.leakMeasuredFrom], ["PACK_MULTIPLIER_LEAKED", 0, 4, "HOLDING", "2026-10-22T15:23:51Z"]);
  assert.ok(regressionStatusLines(t, 2, 2).some((l) => l.includes("sales-qty-unit-guard") && l.includes("lọt 0 (đo lọt từ 2026-10-22T15:23:51Z)")), "0 lọt in kèm mốc bộ dò — không đọc nhầm thành 0 từ 11:19Z");
  // Dòng chưa có bộ dò lọt (sổ giả trong bài kiểm): in «chưa đo được», không in 0.
  const chuaDo = [{ ...row("sales-qty-unit-guard"), leakCodes: [], leakUnavailable: "chưa có bộ dò — kiểm thử", leakMeasuredFrom: undefined }];
  const tc = regressionStatusTable([{ ...base, rows: [{ mission: "sales-qty-unit-guard", code: null, leaked: null, blocked: 4, verdict: "LEAK_UNAVAILABLE", action: null }] }], chuaDo);
  assert.deepEqual([tc[0].code, tc[0].leaked, tc[0].blocked, tc[0].status], [null, null, 4, "LEAK_UNAVAILABLE"]);
  const up = t.find((x) => x.code === "UPSELL_ACCEPTED_BUT_REASKED")!;
  assert.deepEqual([up.leaked, up.reopened, up.status], [3, 1, "REGRESSION_REOPENED"], "đếm việc MỞ theo tổ chức; việc đã đóng không tính");
  const lines = regressionStatusLines(t, 2, 2);
  assert.ok(regressionStatusLines(tc, 1, 1).some((l) => l.includes("lọt chưa đo được")), "bảng in «chưa đo được», không in 0");
  assert.ok(lines.every((l) => !l.includes("kiem-thu") && !l.includes("hslc")), "kênh tóm tắt không mang mã tổ chức");
  const sum = parseRegressionSummary(lines.join("\n"));
  assert.equal(sum.get("upsell-short-accept"), 1);
  assert.equal(sum.get("sales-short-qty-round"), 0);
  assert.equal(parseRegressionRunLog(lines.join("\n")).get("upsell-short-accept"), 1, "ai-tech đọc đúng dòng ops in ra");
  // Không kết luận được ⇒ UNKNOWN cho mọi sứ mệnh.
  for (const [ran, unreadable] of [[0, 0], [2, 1]] as const) {
    const u = parseRegressionRunLog(regressionStatusLines(t, 2, ran, unreadable).join("\n"));
    assert.ok([...new Set(REGRESSION_WATCH.map((r) => r.mission))].every((m) => u.get(m) === "UNKNOWN"), `ran=${ran} unreadable=${unreadable} ⇒ UNKNOWN`);
  }
  assert.ok(regressionStatusTable([]).every((x) => x.status === "NOT_RUN"));
  // Mở CSDL tổ chức trong phiên chỉ đọc phải đi qua handle CHẨN ĐOÁN (không migrate, không dọn platform_*) — production 23/10
  // (run 39879228607) thiếu bước này nên 5/6 tổ chức «không đọc được».
  const st = readFileSync("scripts/regression-watch-status.ts", "utf8");
  const vong = st.slice(st.indexOf("for (const org of orgList)"));
  assert.ok(st.includes("getDbForInspection(org)") && vong.indexOf("bindReadOnlyOrgHandle(org)") >= 0 && vong.indexOf("bindReadOnlyOrgHandle(org)") < vong.indexOf("withOrganization("), "gắn handle chỉ đọc TRƯỚC withOrganization cho mọi tổ chức");
}

async function testDoneGate() {
  const now = new Date("2026-10-23T12:00:00Z");
  const log = (v: string) => `2026-10-23T11:00:00.0Z [ops:tom-tat] regression-watch mission=upsell-short-accept reopened=${v} rows=2\n`;
  const deps = (over: { path?: string; conclusion?: string; created?: string; text?: string } = {}) => ({
    now,
    getJson: async (p: string) => (p.includes("/jobs") ? { jobs: [{ id: 7 }] } : { path: over.path ?? ".github/workflows/ops-vps.yml", conclusion: over.conclusion ?? "success", created_at: over.created ?? "2026-10-23T10:00:00Z" }),
    getText: async () => over.text ?? log("0"),
  });
  assert.equal(await regressionDoneGate("mot-su-menh-khac", SO, undefined, deps()), null, "sứ mệnh không có dòng sổ ⇒ không kiểm");
  assert.equal(await regressionDoneGate("upsell-short-accept", null, undefined, deps()), null, "sổ chưa có trên main ⇒ không kiểm");
  const thieu = await regressionDoneGate("upsell-short-accept", SO, undefined, deps());
  assert.ok(thieu && !thieu.ok && /regression-watch-status/.test(thieu.msg) && /--regression-run=<run id>/.test(thieu.msg), "thiếu run ⇒ từ chối, câu nói lệnh để lấy run");
  for (const [d, why] of [
    [deps({ path: ".github/workflows/deploy-vps.yml" }), "không phải ops"],
    [deps({ conclusion: "failure" }), "hỏng"],
    [deps({ created: "2026-10-20T00:00:00Z" }), "quá cũ"],
    [deps({ text: "không có dòng nào\n" }), "không có dòng của sứ mệnh"],
    [deps({ text: log("UNKNOWN") }), "UNKNOWN"],
    [deps({ text: log("2") }), "còn tái diễn"],
  ] as const) {
    const g = await regressionDoneGate("upsell-short-accept", SO, "39779311419", d);
    assert.ok(g && !g.ok, `từ chối DONE khi ${why}`);
  }
  const ok = await regressionDoneGate("upsell-short-accept", SO, "39779311419", deps());
  assert.deepEqual(ok, { ok: true, note: "regression-watch run 39779311419: reopened=0" }, "0 việc tái diễn mở ⇒ được DONE, ghi bằng chứng vào sổ");
  // Nối thật vào `close`: cổng đứng TRƯỚC lượt ghi sổ, và lệnh gọi truyền kết quả cổng vào.
  const ai = readFileSync("scripts/ai-tech.ts", "utf8");
  assert.ok(ai.includes("return cmdClose(ctx, rest[0], a.flags, a.values, await regressionGateFor(ctx, rest[0], a.values));"), "close đi qua cổng tái diễn");
  const close = ai.slice(ai.indexOf("function cmdClose("));
  assert.ok(close.indexOf("regression && !regression.ok") > 0 && close.indexOf("regression && !regression.ok") < close.indexOf("mutateControl("), "từ chối TRƯỚC khi ghi sổ");
}

export async function testRegressionWatch(db: Db) {
  testRegistry();
  testCounting();
  testStatusTable();
  await testDoneGate();
  await testReopenFlow(db);
  console.log("  ✓ Sổ theo dõi tái diễn: 5 bản sửa P0, mốc = updated_at deploy xanh · #968 đo lọt bằng PACK_MULTIPLIER_LEAKED từ 15:23Z · chỉ đếm SAU mốc · ĐÃ CHẶN ≠ LỌT · một việc / (mã, sứ mệnh), nhiều ngày không đẻ việc · đóng rồi lọt lại ⇒ MỞ LẠI đúng việc + một tin · chưa có bộ dò ⇒ «chưa đo được», không REOPEN · bảng ops không mã tổ chức, không kết luận ⇒ UNKNOWN · ai-tech từ chối DONE khi thiếu bằng chứng / còn tái diễn");
}

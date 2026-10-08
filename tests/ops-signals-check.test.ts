/**
 * ═══════════ ops `ops-signals-check` — TÁM TÍN HIỆU O1–O8 TÍNH TRÊN PRODUCTION, CHỈ ĐỌC (scripts/ops-signals-check.ts) ═══════════
 *
 *  · Thuần: đếm tổ chức theo mức cho từng tín hiệu; tổ chức tính hỏng ⇒ FAIL và nêu đúng tín hiệu hỏng; UNKNOWN KHÔNG làm FAIL nhưng
 *    được đếm riêng; không tổ chức nào ⇒ FAIL; dòng công khai KHÔNG mang tên / email / SĐT / chi tiết / id tương quan / mã tổ chức khách
 *    nào ngoài workspace nghiệm thu; mã lý do lạ in «(khác)»; dòng ≤ 300 ký tự, lượt ≤ 60 dòng.
 *  · Gom: lượt gom ném ⇒ tính lại TỪNG tổ chức (một tổ chức hỏng không đổ cho mọi tổ chức); FORBIDDEN ⇒ mọi tổ chức hỏng.
 *  · Mã nguồn: không câu ghi, không SQL thứ hai cho tín hiệu (gọi ĐÚNG `loadOpsSignalsForOrgs` của khung), không gửi job / tin;
 *    ERP_READ_ONLY + hỏi lại Postgres; ops-vps khai thao tác (lựa chọn · mã hoá · làn đọc · nhánh case).
 *  · CSDL (PGlite): người vận hành máy dựng qua bộ tính quyền của phiên; khung tính được cho tổ chức nhà ⇒ PASS; người của tổ chức
 *    khách ⇒ FORBIDDEN ⇒ FAIL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { OPS_SIGNAL_KEYS, type OpsLevel, type OpsSignalKey, type OpsSignalLine } from "@/lib/constants/ops-signals";
import { getHomeOrganization } from "@/lib/platform/organizations";
import {
  collectOpsSignals,
  loginFlowOf,
  machineOperator,
  publicReasonCode,
  summarizeOpsSignals,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_LINES,
  type CollectDeps,
  type OrgSignalsOutcome,
} from "@/scripts/ops-signals-check";

const NT = "cdt-nghiem-thu";
const KHACH = "shop-bi-mat";
const TEN_KHACH = "Shop Bí Mật Của Khách";
const EMAIL_CHE = "ng***@chotdontudong.com";
const SDT = "0912345678";
const TUONG_QUAN = "conv-bi-mat-123";

function line(key: OpsSignalKey, level: OpsLevel, extra: Partial<OpsSignalLine> = {}): OpsSignalLine {
  return { key, label: key, level, count24h: null, count7d: null, lastAt: null, lastReason: null, lastReasonLabel: null, correlationId: null, detail: null, measuredFrom: null, measuredAt: null, stale: false, note: null, ...extra };
}

const allLines = (level: OpsLevel, over: Partial<Record<OpsSignalKey, OpsSignalLine>> = {}) => OPS_SIGNAL_KEYS.map((k) => over[k] ?? line(k, level));

export function testOpsSignalsCheckPure() {
  assert.equal(loginFlowOf(`Liên kết đặt mật khẩu · ${EMAIL_CHE}`), "RESET_LINK");
  assert.equal(loginFlowOf(`Đăng nhập · ${EMAIL_CHE}`), "LOGIN");
  assert.equal(loginFlowOf(EMAIL_CHE), null, "không nhãn luồng ⇒ null, không đoán");
  assert.equal(loginFlowOf(null), null);
  assert.deepEqual([publicReasonCode("BAD_PASSWORD"), publicReasonCode(null), publicReasonCode(`lỗi ${EMAIL_CHE}`), publicReasonCode("x")], ["BAD_PASSWORD", "—", "(khác)", "(khác)"]);

  // 1 · Đủ tám dòng cho mọi tổ chức ⇒ PASS; workspace nghiệm thu in mức + MÃ lý do + luồng, không chi tiết.
  const nt: OrgSignalsOutcome = {
    code: NT,
    status: "ACTIVE",
    result: {
      ok: true,
      lines: allLines("OK", {
        LOGIN: line("LOGIN", "WARNING", { count24h: 2, count7d: 3, lastReason: "RESET_LINK_USED", lastAt: "2026-10-09T01:00:00.000Z", detail: `Liên kết đặt mật khẩu · ${EMAIL_CHE}` }),
        AI: line("AI", "UNKNOWN", { note: "chưa biết" }),
        QUOTA: line("QUOTA", "CRITICAL", { count24h: 4, count7d: 4, lastReason: "COST_HARD", correlationId: TUONG_QUAN, detail: `${TEN_KHACH} ${SDT}` }),
      }),
    },
  };
  const khach: OrgSignalsOutcome = { code: KHACH, status: "ACTIVE", result: { ok: true, lines: allLines("NA", { WEBHOOK: line("WEBHOOK", "UNKNOWN", { detail: `page ${TEN_KHACH}`, correlationId: TUONG_QUAN }) }) } };
  const r1 = summarizeOpsSignals([nt, khach], { acceptanceCodes: [NT] });
  assert.equal(r1.verdict, "PASS", r1.publicLines.join("\n"));
  assert.deepEqual(r1.failedSignals, []);
  assert.equal(r1.orgs, 2);
  assert.deepEqual(r1.perSignal.LOGIN.levels, { OK: 0, WARNING: 1, CRITICAL: 0, UNKNOWN: 0, NA: 1 });
  assert.deepEqual(r1.perSignal.WEBHOOK.levels, { OK: 1, WARNING: 0, CRITICAL: 0, UNKNOWN: 1, NA: 0 });
  assert.equal(r1.unknownCells, 2, "UNKNOWN đếm riêng");
  assert.ok(OPS_SIGNAL_KEYS.every((k) => r1.perSignal[k].threw === 0));
  const pub1 = r1.publicLines.join("\n");
  assert.match(r1.publicLines[0], /^ops-signals-check: PASS · 2 tổ chức × 8 tín hiệu · 0 ô tính hỏng/);
  assert.match(pub1, /O1 LOGIN: OK 0 · WARNING 1 · CRITICAL 0 · UNKNOWN 0 · NA 1 · hỏng 0/);
  assert.match(pub1, /UNKNOWN \(CHƯA BIẾT — không phải lỗi, không tính FAIL\): 2\/16 ô/);
  assert.match(pub1, /cdt-nghiem-thu O1 LOGIN: WARNING · 24h 2 · 7d 3 · lý do cuối RESET_LINK_USED · luồng RESET_LINK/);
  assert.match(pub1, /cdt-nghiem-thu O4 AI: UNKNOWN · 24h — · 7d —/, "chưa biết in «—», không 0");
  assert.match(pub1, /cdt-nghiem-thu O8 QUOTA: CRITICAL · 24h 4 · 7d 4 · lý do cuối COST_HARD/);
  assert.match(pub1, /O1 bằng chứng cdt-nghiem-thu: CÓ lỗi đăng nhập ghi trong 24 giờ \(24h 2 · lý do cuối RESET_LINK_USED · luồng RESET_LINK\)/);
  for (const bad of [KHACH, TEN_KHACH, EMAIL_CHE, "***", "@", SDT, TUONG_QUAN, "page "]) assert.ok(!pub1.includes(bad), `dòng công khai không được mang «${bad}»`);

  // 2 · Workspace nghiệm thu chưa có lỗi đăng nhập ⇒ dòng bằng chứng nói CHƯA và chỉ việc phải làm.
  const r2 = summarizeOpsSignals([{ ...nt, result: { ok: true, lines: allLines("OK", { LOGIN: line("LOGIN", "OK", { count24h: 0, count7d: 0 }) }) } }], { acceptanceCodes: [NT] });
  assert.equal(r2.verdict, "PASS");
  assert.match(r2.publicLines.join("\n"), /O1 bằng chứng cdt-nghiem-thu: CHƯA .*saas-acceptance --apply/);
  // Workspace nghiệm thu chưa tồn tại ⇒ nói ra, không FAIL vì nó.
  const r2b = summarizeOpsSignals([khach], { acceptanceCodes: [NT] });
  assert.equal(r2b.verdict, "PASS");
  assert.match(r2b.publicLines.join("\n"), /cdt-nghiem-thu: chưa có workspace/);

  // 3 · Một tổ chức tính hỏng cả lượt ⇒ FAIL, cả tám tín hiệu bị nêu; câu lỗi không ra kênh công khai.
  const r3 = summarizeOpsSignals([nt, { code: KHACH, status: "ACTIVE", result: { ok: false, error: `relation lỗi ${TEN_KHACH}` } }], { acceptanceCodes: [NT] });
  assert.equal(r3.verdict, "FAIL");
  assert.deepEqual(r3.failedSignals, [...OPS_SIGNAL_KEYS]);
  assert.ok(OPS_SIGNAL_KEYS.every((k) => r3.perSignal[k].threw === 1));
  assert.match(r3.publicLines[0], /FAIL · 2 tổ chức × 8 tín hiệu · 8 ô tính hỏng \(1 tổ chức hỏng cả lượt\) · tín hiệu hỏng: O1 LOGIN, O2 FB_CONNECTION/);
  assert.ok(!r3.publicLines.join("\n").includes(TEN_KHACH) && !r3.publicLines.join("\n").includes(KHACH));

  // 4 · Thiếu ĐÚNG một dòng (hoặc mức lạ) ⇒ chỉ tín hiệu ấy hỏng.
  const thieuAi = allLines("OK").filter((l) => l.key !== "AI");
  const mucLa = allLines("OK").map((l) => (l.key === "SEND" ? { ...l, level: "BROKEN" as OpsLevel } : l));
  const r4 = summarizeOpsSignals([{ code: "a", status: "ACTIVE", result: { ok: true, lines: thieuAi } }, { code: "b", status: "ACTIVE", result: { ok: true, lines: mucLa } }], { acceptanceCodes: [] });
  assert.equal(r4.verdict, "FAIL");
  assert.deepEqual(r4.failedSignals, ["AI", "SEND"]);
  assert.match(r4.publicLines[0], /tín hiệu hỏng: O4 AI, O5 SEND$/);

  // 5 · Toàn UNKNOWN vẫn PASS (chưa biết ≠ hỏng); không tổ chức nào ⇒ FAIL.
  const r5 = summarizeOpsSignals([{ code: "a", status: "ACTIVE", result: { ok: true, lines: allLines("UNKNOWN") } }], { acceptanceCodes: [] });
  assert.equal(r5.verdict, "PASS");
  assert.equal(r5.unknownCells, 8);
  const r6 = summarizeOpsSignals([], { acceptanceCodes: [NT] });
  assert.equal(r6.verdict, "FAIL");
  assert.match(r6.publicLines[0], /KHÔNG có tổ chức nào/);

  // 6 · Trần kênh tóm tắt.
  const dai = summarizeOpsSignals([{ ...nt, result: { ok: true, lines: allLines("OK", { LOGIN: line("LOGIN", "WARNING", { count24h: 1, lastReason: "BAD_PASSWORD", lastAt: "x".repeat(400) }) }) } }], { acceptanceCodes: [NT, NT, NT, NT, NT, NT, NT] });
  assert.ok(dai.publicLines.length <= SUMMARY_MAX_LINES && dai.publicLines.every((l) => l.length <= SUMMARY_MAX_CHARS));
  console.log("✓ ops-signals-check thuần: đếm mức theo tín hiệu · hỏng ⇒ FAIL nêu đúng tín hiệu · UNKNOWN đếm riêng không FAIL · 0 tổ chức ⇒ FAIL · công khai chỉ mã + số");
}

export async function testOpsSignalsCheckCollect() {
  const orgs = [
    { code: "a-ok", status: "ACTIVE" },
    { code: "b-hong", status: "ACTIVE" },
    { code: "c-ok", status: "SUSPENDED" },
  ];
  const user = { id: "u" } as SessionUser;
  const calls: string[][] = [];
  const ai: string[] = [];
  const load: CollectDeps["load"] = async (_u, codes, opts) => {
    calls.push([...codes]);
    if (codes.includes("b-hong")) throw new Error(`câu SQL hỏng ${TEN_KHACH}`);
    assert.ok(opts?.aiSalesEnabled?.has(codes[0]), "chuyển cờ ai_sales của từng tổ chức cho khung");
    return { ok: true, value: new Map(codes.map((c) => [c, { orgCode: c, checkedAt: "", lines: allLines("OK") }])) };
  };
  const out = await collectOpsSignals(user, orgs, { load, aiSalesEnabled: async (c) => (ai.push(c), c === "a-ok"), now: () => new Date("2026-10-09T00:00:00Z") });
  assert.deepEqual(calls, [["a-ok", "b-hong", "c-ok"], ["a-ok"], ["b-hong"], ["c-ok"]], "lượt gom ném ⇒ tính lại TỪNG tổ chức");
  assert.deepEqual(ai, ["a-ok", "b-hong", "c-ok"]);
  assert.deepEqual(out.map((o) => [o.code, o.result.ok]), [["a-ok", true], ["b-hong", false], ["c-ok", true]]);
  const r = summarizeOpsSignals(out, { acceptanceCodes: [] });
  assert.equal(r.verdict, "FAIL");
  assert.ok(OPS_SIGNAL_KEYS.every((k) => r.perSignal[k].threw === 1 && r.perSignal[k].levels.OK === 2));

  const forbidden = await collectOpsSignals(user, orgs, { load: async () => ({ ok: false, code: "FORBIDDEN", error: "Chỉ người của tổ chức nhà." }), aiSalesEnabled: async () => null });
  assert.ok(forbidden.every((o) => !o.result.ok && o.result.error.startsWith("FORBIDDEN")));
  const missing = await collectOpsSignals(user, [{ code: "Sai_Ma", status: "ACTIVE" }], { load: async () => ({ ok: true, value: new Map() }), aiSalesEnabled: async () => null });
  assert.ok(!missing[0].result.ok, "hàm đọc bỏ mã ⇒ tính là hỏng, không im lặng");
  console.log("✓ ops-signals-check gom: lượt gom ném ⇒ tính lại từng tổ chức · FORBIDDEN ⇒ mọi tổ chức hỏng · mã bị bỏ ⇒ hỏng");
}

export function testOpsSignalsCheckSource() {
  const src = readFileSync("scripts/ops-signals-check.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(insert|update|delete|truncate|alter|drop|create|upsert)\b\s/i.test(code), "script không có câu ghi nào");
  assert.ok(!/\.(insert|update|delete|execute)\s*\(|onConflict|returning\s*\(/.test(code), "script không gọi một lệnh ghi / câu SQL thô nào");
  assert.ok(!/\bsql\s*`/.test(code) && !/platform_(auth_failures|org_health|ai_usage)/.test(code), "không SQL thứ hai cho tín hiệu (AGENTS §8.12)");
  assert.ok(!/buildOpsSignalLines\s*\(|groupOpsSignalRows\s*\(/.test(code), "không tự dựng tám dòng — đọc qua hàm của khung");
  for (const w of ["recordAuthFailure", "noteOrgHealthEvent", "mirrorSalesOpsHealth", "runJob", "requestProvisioning", "enqueue", "dispatch", "notify", "sendTelegram", "sendLark", "setSetting", "audit("]) {
    assert.ok(!code.includes(w), `script không ghi / không gửi: ${w}`);
  }
  assert.match(src, /import \{ loadOpsSignalsForOrgs, OPS_SIGNALS_MAX_ORGS \} from "@\/lib\/platform\/ops-signals"/, "gọi ĐÚNG hàm của khung /platform/org");
  assert.match(src, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(code, /platformReadOnlyConfirmed\(\)/, "hỏi lại Postgres trước khi đọc");
  assert.match(code, /activeUserIdsWhoCan\("platform:operate"\)/, "người vận hành máy lấy từ bộ tính quyền của phiên, không bịa quyền");
  assert.match(code, /platformOperatorDenial\(user\)/);

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- ops-signals-check\s+#/, "ops-vps khai lựa chọn ops-signals-check");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bops-signals-check\b/, "kết quả ops-signals-check MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bops-signals-check\b/, "ops-signals-check là thao tác ĐỌC");
  assert.match(ops, /\n\s+ops-signals-check\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/ops-signals-check\.ts ;;/, "nhánh case chạy đúng script qua ma_hoa_ket_qua");
  console.log("✓ ops-signals-check mã nguồn: không câu ghi · không SQL thứ hai · không job / tin · ERP_READ_ONLY + hỏi lại Postgres · ops-vps khai đủ bốn chỗ");
}

/** CSDL (PGlite của bộ kiểm thử): người vận hành máy + khung thật cho tổ chức nhà. */
export async function testOpsSignalsCheckDb() {
  const home = await getHomeOrganization();
  const db = await getDb();
  const EMAIL = "ops-signals-check@nha.local";
  await db.delete(schema.users).where(eq(schema.users.email, EMAIL));
  await db.insert(schema.users).values({ id: "0000-ops-signals-check", email: EMAIL, name: "Vận hành máy", passwordHash: "x", role: "ADMIN", active: true });
  try {
    const op = await machineOperator();
    assert.ok(op.ok, JSON.stringify(op));
    assert.ok(op.user.organization?.isHome && op.user.organization.code === home.code, "người vận hành máy thuộc tổ chức nhà");
    const out = await collectOpsSignals(op.user, [{ code: home.code, status: "ACTIVE" }]);
    assert.ok(out[0].result.ok, JSON.stringify(out[0].result));
    assert.deepEqual(out[0].result.lines.map((l) => l.key), [...OPS_SIGNAL_KEYS]);
    assert.equal(summarizeOpsSignals(out, { acceptanceCodes: [] }).verdict, "PASS");

    const khach: SessionUser = { ...op.user, organization: { code: "khach-x", name: "x", isHome: false } };
    const bi = await collectOpsSignals(khach, [{ code: home.code, status: "ACTIVE" }]);
    assert.ok(!bi[0].result.ok && bi[0].result.error.startsWith("FORBIDDEN"), "người của tổ chức khách ⇒ FORBIDDEN");
    assert.equal(summarizeOpsSignals(bi, { acceptanceCodes: [] }).verdict, "FAIL");
  } finally {
    await db.delete(schema.users).where(eq(schema.users.email, EMAIL));
  }
  console.log("✓ ops-signals-check CSDL: người vận hành máy qua bộ tính quyền của phiên · khung thật tính đủ tám dòng cho tổ chức nhà ⇒ PASS · người tổ chức khách ⇒ FORBIDDEN ⇒ FAIL");
}

export async function testOpsSignalsCheck() {
  testOpsSignalsCheckPure();
  await testOpsSignalsCheckCollect();
  testOpsSignalsCheckSource();
  await testOpsSignalsCheckDb();
}

if (/ops-signals-check\.test\.ts$/.test(process.argv[1] ?? "")) testOpsSignalsCheck().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

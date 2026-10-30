/**
 * BÁO CÁO CEO HẰNG NGÀY (ai-daily-report · 0266) — AI GIẢ, tổ chức PGlite riêng `dr-si`.
 *
 *  1. THUẦN — cấu hình hỏng / thiếu ⇒ TẮT; hàng rào số: số đúng khối số qua, số BỊA (đếm · tiền · %) bị chặn, «0» cho ô chưa đo bị chặn;
 *     đọc JSON AI đúng hình; tin gửi in «—» cho ô chưa đo.
 *  2. CSDL — mặc định TẮT (không bản nào); bật cần settings:manage, lưu lặp không ghi; chưa khai trần ⇒ không gọi AI (bản chỉ có khối
 *     số); AI bịa số ⇒ BLOCKED, lời không lưu; AI đúng ⇒ OK + ghi sổ dùng AI `daily_report`; chạm trần ⇒ không gọi; bản BẤT BIẾN
 *     (UPDATE bị trigger chặn); một bản mỗi ngày; CSDL chưa áp 0266 ⇒ bỏ qua trước khi tốn tiền; tổ chức nhà không thấy bản nào.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { FakeProvider } from "@/lib/ai/provider";
import { setBuilderAiForTests } from "@/lib/ai-builder/provider";
import type { SessionUser } from "@/lib/auth/session";
import { DAILY_REPORT_OFF, dailyReportMessage, numbersNotInFacts, parseAiReport, parseDailyReportConfig, type DailyFacts } from "@/lib/constants/daily-report";
import { runDailyReport, setDailyReportConfigCore } from "@/lib/daily-report/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { listDailyReports } from "@/lib/queries/daily-report";
import { quotationOpenCount } from "@/lib/queries/wholesale-quotations";
import { extractVndAmounts, unverifiedAmounts } from "@/lib/sales-chatbot/claim-guard";

const ORG = "dr-si";
const DAY = 86_400_000;
const vnDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const SAMPLE: DailyFacts = {
  date: "2026-10-29",
  generatedAt: "2026-10-30T01:00:00.000Z",
  sections: [
    {
      key: "orders",
      title: "Đơn hàng",
      facts: [
        { key: "orders", label: "Đơn tạo hôm qua", value: 12, unit: "count" },
        { key: "delivered", label: "Đã giao thành công", value: 3, unit: "count" },
        { key: "cash", label: "Tiền có chứng từ", value: 1_250_000, unit: "vnd" },
        { key: "rate7", label: "Tỷ lệ giao thành công 7 ngày", value: 62.5, unit: "pct" },
        { key: "spend", label: "Chi quảng cáo", value: null, unit: "vnd", missing: "chưa đồng bộ" },
      ],
    },
  ],
};
const guard = (text: string) => numbersNotInFacts(text, SAMPLE, { vndAmounts: extractVndAmounts(text), unverified: unverifiedAmounts });

function testPure() {
  assert.deepEqual(parseDailyReportConfig(undefined), DAILY_REPORT_OFF, "chưa khai ⇒ TẮT");
  assert.deepEqual(parseDailyReportConfig({ on: true, hourVn: null, maxCostUsdPerDay: null }), DAILY_REPORT_OFF, "bật mà không có giờ ⇒ hỏng ⇒ TẮT");
  assert.deepEqual(parseDailyReportConfig({ on: "true", hourVn: 7, maxCostUsdPerDay: 1 }), DAILY_REPORT_OFF);
  assert.deepEqual(parseDailyReportConfig({ on: true, hourVn: 7, maxCostUsdPerDay: null }), { on: true, hourVn: 7, maxCostUsdPerDay: null });

  assert.deepEqual(guard("Ngày 29/10 có 12 đơn, 3 đơn đã giao, tiền có chứng từ 1.250.000 ₫; tỷ lệ giao thành công 7 ngày 62.5%. Chi quảng cáo chưa đo được."), [], "số đúng khối số (kể cả số trong nhãn «7 ngày», ngày báo cáo) ⇒ qua");
  assert.deepEqual(guard("Có 15 đơn mới."), ["15"], "số đếm bịa bị chặn");
  assert.deepEqual(guard("Doanh thu 2.000.000 ₫."), ["2.000.000 ₫"], "tiền bịa bị chặn (bộ đọc tiền của hàng rào bot)");
  assert.deepEqual(guard("Tỷ lệ giao 70%."), ["70%"], "phần trăm bịa bị chặn");
  assert.deepEqual(guard("Tiền 1,25 triệu."), [], "1,25 triệu = 1.250.000 ₫ đúng khối số ⇒ qua");
  assert.deepEqual(guard("Chi quảng cáo 0 đơn vị."), ["0"], "«0» cho ô CHƯA ĐO là số bịa");
  assert.deepEqual(guard("Đơn tăng 9 đơn so với hôm kia."), ["9"], "phép tính tự suy (chênh lệch) không có trong khối số ⇒ chặn");

  assert.deepEqual(parseAiReport('```json\n{"summary":"Ổn.","highlights":["a","b","c"]}\n```'), { summary: "Ổn.", highlights: ["a", "b", "c"] });
  assert.equal(parseAiReport('{"summary":"Ổn.","highlights":["a","b"]}'), null, "phải đúng 3 điểm");
  assert.equal(parseAiReport("không phải JSON"), null);
  const msg = dailyReportMessage(SAMPLE, { status: "SKIPPED", summary: null, highlights: [], note: "chưa khai trần" }, null);
  assert.ok(msg.includes("Chi quảng cáo: —") && !msg.includes("Chi quảng cáo: 0"), "ô chưa đo in «—», không 0");
  // Không dựng danh tính quản trị giả để gọi hàm theo phiên (luật 28–31): số báo giá đi qua hàm đếm không nhận phiên.
  const svc = readFileSync(path.join(path.resolve(__dirname, ".."), "lib/daily-report/service.ts"), "utf8");
  assert.ok(!/role:\s*"ADMIN"|scope:\s*"ALL"|listQuotations\(/.test(svc), "dịch vụ báo cáo không tự dựng phiên ADMIN / phạm vi ALL");
  assert.ok(svc.includes("quotationOpenCount("), "số báo giá qua hàm đếm riêng");
  console.log("✓ Báo cáo ngày (thuần): mặc định tắt · hàng rào chặn số đếm / tiền / % bịa và «0» cho ô chưa đo · JSON AI đúng hình · tin in «—»");
}

const aiSays = (summary: string, highlights: string[]) => new FakeProvider([() => ({ content: [{ type: "text", text: JSON.stringify({ summary, highlights }) }], stopReason: "end_turn" })]);

export async function testDailyReport() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Shop thử báo cáo ngày", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT báo cáo", password: "DailyRep@12345" }, source: "TEST", actor: null });
  const now = new Date();
  const dates: string[] = [];
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Shop thử báo cáo ngày", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT báo cáo", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org };
      const manager: SessionUser = { ...admin, role: "MANAGER", permissions: ["approvals:decide"] };
      const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.dailyReports))[0].n;

      // Hàm đếm báo giá không nhận phiên: tổ chức chưa có báo giá nào ⇒ 0 THẬT (bảng có, không dòng nào).
      assert.equal(await quotationOpenCount(now), 0);

      // ── Mặc định TẮT ──
      assert.equal((await runDailyReport({ now })).ran, false);
      assert.equal(await count(), 0, "mặc định tắt ⇒ không bản nào");

      // ── Cấu hình: quyền · lưu lặp ──
      assert.ok(!(await setDailyReportConfigCore(manager, { on: true, hourVn: 0, maxCostUsdPerDay: null })).ok, "thiếu settings:manage ⇒ từ chối");
      assert.ok(!(await setDailyReportConfigCore(admin, { on: true, hourVn: null, maxCostUsdPerDay: null })).ok, "bật thì phải có giờ");
      const c1 = await setDailyReportConfigCore(admin, { on: true, hourVn: 0, maxCostUsdPerDay: null });
      assert.ok(c1.ok && c1.changed);
      const c2 = await setDailyReportConfigCore(admin, { on: true, hourVn: 0, maxCostUsdPerDay: null });
      assert.ok(c2.ok && !c2.changed, "lưu lặp ⇒ không ghi");

      // ── Chưa khai trần ⇒ KHÔNG gọi AI, bản chỉ có khối số ──
      const fake0 = aiSays("không được gọi", ["a", "b", "c"]);
      setBuilderAiForTests({ provider: fake0, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      const n0 = new Date(now.getTime() - 3 * DAY);
      const r0 = await runDailyReport({ now: n0 });
      assert.ok(r0.ran && r0.aiStatus === "SKIPPED", JSON.stringify(r0));
      assert.equal(fake0.calls.length, 0, "không trần chi phí ⇒ không tốn tiền AI");
      dates.push(r0.reportDate!);
      assert.equal(r0.reportDate, vnDay(new Date(n0.getTime() - DAY)), "bản của HÔM QUA so với lượt chạy");
      const again = await runDailyReport({ now: n0 });
      assert.ok(!again.ran && again.reason.includes("đã có"), "một bản mỗi ngày");

      // ── Bất biến: trigger chặn mọi UPDATE ──
      await assert.rejects(() => db.update(schema.dailyReports).set({ aiNote: "sửa lén" }).where(eq(schema.dailyReports.reportDate, r0.reportDate!)), "bản đã tạo không sửa được");

      // ── AI bịa số ⇒ BLOCKED, lời không lưu ──
      await setDailyReportConfigCore(admin, { on: true, hourVn: 0, maxCostUsdPerDay: 1 });
      setBuilderAiForTests({ provider: aiSays("Hôm qua có 999 đơn và doanh thu 7.777.777 ₫.", ["Tốt", "Ổn", "Theo dõi"]), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      const r1 = await runDailyReport({ now: new Date(now.getTime() - 2 * DAY) });
      assert.ok(r1.ran && r1.aiStatus === "BLOCKED", JSON.stringify(r1));
      dates.push(r1.reportDate!);
      const [b1] = await db.select().from(schema.dailyReports).where(eq(schema.dailyReports.reportDate, r1.reportDate!));
      assert.equal(b1.summary, null, "lời có số bịa KHÔNG được lưu");
      assert.ok(b1.blockedNumbers.includes("999") && b1.blockedNumbers.includes("7.777.777 ₫"), JSON.stringify(b1.blockedNumbers));

      // ── AI viết đúng ⇒ OK + sổ dùng AI ──
      const n2 = new Date(now.getTime() - DAY);
      const d2 = vnDay(new Date(n2.getTime() - DAY));
      const dd = String(Number(d2.slice(8, 10)));
      setBuilderAiForTests({ provider: aiSays(`Ngày ${dd} shop vận hành ổn, các ô chưa đo được ghi rõ.`, ["Xem hàng đợi việc", "Theo dõi care vận đơn", "Kiểm chi quảng cáo"]), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      const r2 = await runDailyReport({ now: n2 });
      assert.ok(r2.ran && r2.aiStatus === "OK", JSON.stringify(r2));
      dates.push(r2.reportDate!);
      const pdb = await getPlatformDb();
      const usage = await pdb.select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, ORG), eq(schema.platformAiUsage.feature, "daily_report")));
      assert.equal(usage.length, 2, "mỗi lượt gọi AI một dòng sổ dùng AI (bản bị chặn vẫn tốn tiền)");

      // ── Chạm trần chi phí hôm nay ⇒ không gọi ──
      await pdb.insert(schema.platformAiUsage).values({ orgCode: ORG, feature: "daily_report", billingSource: "BYOK", requests: 1, status: "OK", costUsd: 5, at: new Date() });
      const fake3 = aiSays("không được gọi", ["a", "b", "c"]);
      setBuilderAiForTests({ provider: fake3, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      const r3 = await runDailyReport({ now });
      assert.ok(r3.ran && r3.aiStatus === "SKIPPED", JSON.stringify(r3));
      assert.equal(fake3.calls.length, 0, "đã chạm trần ⇒ không gọi AI");
      dates.push(r3.reportDate!);

      const list = await listDailyReports();
      assert.equal(list.rows.length, 4);
      assert.equal(list.rows[0].reportDate, r3.reportDate, "mới nhất trước");
      const ordersSection = list.rows[0].facts.sections.find((s) => s.key === "orders");
      assert.ok(ordersSection && ordersSection.facts.every((f) => f.value === null || Number.isFinite(f.value)), "khối số lưu kèm bản");

      // ── CSDL chưa áp 0266 ⇒ bỏ qua TRƯỚC khi tốn tiền; trang nói thẳng ──
      await db.execute(sql.raw(`ALTER TABLE daily_reports RENAME TO daily_reports_tam`));
      try {
        const fake4 = aiSays("không được gọi", ["a", "b", "c"]);
        setBuilderAiForTests({ provider: fake4, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
        const r4 = await runDailyReport({ now: new Date(now.getTime() + DAY) });
        assert.ok(!r4.ran && r4.reason.includes("0266"), JSON.stringify(r4));
        assert.equal(fake4.calls.length, 0);
        assert.equal((await listDailyReports()).unavailable, true);
      } finally {
        await db.execute(sql.raw(`ALTER TABLE daily_reports_tam RENAME TO daily_reports`));
      }
    });

    // ── Cách ly: tổ chức nhà không có bản nào của `dr-si` ──
    const home = await getDb();
    const leaked = await home.select({ id: schema.dailyReports.id }).from(schema.dailyReports).where(inArray(schema.dailyReports.reportDate, dates));
    assert.equal(leaked.length, 0, "bản của tổ chức khác không có ở CSDL nhà");
  } finally {
    setBuilderAiForTests(undefined);
    await cleanupOrg();
  }
  console.log("✓ Báo cáo ngày (CSDL tổ chức): mặc định tắt · cấu hình cần settings:manage, lưu lặp không ghi · chưa khai trần / chạm trần ⇒ không gọi AI · số bịa ⇒ BLOCKED, lời không lưu · AI đúng ⇒ OK + sổ dùng AI daily_report · bản bất biến, một bản / ngày · chưa áp 0266 ⇒ bỏ qua trước khi tốn tiền · cách ly tổ chức");
}

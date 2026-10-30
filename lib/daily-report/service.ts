import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { estimateCostUsd } from "@/lib/ai/provider";
import { getBuilderAi } from "@/lib/ai-builder/provider";
import { aiUsageDaily, recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  DAILY_REPORT_CONFIG_KEY,
  DAILY_REPORT_SYSTEM,
  dailyReportConfigZ,
  dailyReportMessage,
  factsText,
  numbersNotInFacts,
  parseAiReport,
  parseDailyReportConfig,
  type AiStatus,
  type DailyFacts,
  type DailyReportConfig,
  type Fact,
  type FactSection,
} from "@/lib/constants/daily-report";
import { isUndefinedTableError } from "@/lib/constants/fb-crm";
import { addDays, vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { deliverMessage } from "@/lib/messaging/service";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { organizationBaseUrl } from "@/lib/platform/publish";
import { getCareQueue } from "@/lib/queries/care-workbench";
import { dataQualitySummary } from "@/lib/queries/data-quality";
import { fbCrmDueCare, fbCrmEnabled, fbCrmOverview } from "@/lib/queries/fb-crm";
import { getManagerDay } from "@/lib/queries/manager-day";
import { adSpendTotal } from "@/lib/queries/marketing-daily";
import { wholesaleDashboard, wholesaleEmailCoverage } from "@/lib/queries/wholesale";
import { outboxCounts } from "@/lib/queries/wholesale-email-outbox";
import { listQuotations } from "@/lib/queries/wholesale-quotations";
import { extractVndAmounts, unverifiedAmounts } from "@/lib/sales-chatbot/claim-guard";
import { operationsGroupChannel } from "@/lib/sales-chatbot/alerts";
import type { ListParams, Period } from "@/lib/search-params";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ BÁO CÁO CEO HẰNG NGÀY — GOM SỐ · AI VIẾT LỜI · HÀNG RÀO · LƯU BẤT BIẾN · GỬI NHÓM ═══════════
 *
 * Một lượt (`runDailyReport`, gọi trong job `work-recurrence` — không đổi lịch chung) cho tổ chức NGỮ CẢNH:
 *  1. cờ `dailyReport.config` TẮT (mặc định) ⇒ thôi; chưa tới giờ đã khai ⇒ thôi; bản của HÔM QUA đã có ⇒ thôi;
 *  2. MÁY gom số bằng các hàm báo cáo đang chạy (`dataQualitySummary` · `adSpendTotal` · `getCareQueue` · `getManagerDay` · hàm bán sỉ ·
 *     `fbCrmOverview`) — mỗi khối hỏng ⇒ số đó `null` («—»), không 0, không làm sập cả bản;
 *  3. AI (kết nối của tổ chức / credit nền tảng / AI nhà — `getBuilderAi`) CHỈ viết lời từ khối số, trong trần chi phí / ngày; mọi số
 *     trong lời AI phải có trong khối số (`numbersNotInFacts` + bộ đọc tiền của hàng rào bot bán hàng) — có số bịa ⇒ lời bị chặn;
 *  4. lưu MỘT dòng `daily_reports` (bất biến — trigger CSDL chặn sửa) rồi gửi tin vào nhóm báo vận hành đã cấu hình (không kênh mới).
 */

export type DailyReportDeps = { now?: Date };
export type DailyReportRun = { ran: boolean; reason: string; reportDate?: string; aiStatus?: AiStatus; sent?: boolean };

/** Người đọc MÁY phạm vi ALL — CHỈ để gọi hàm đếm báo giá sẵn có (hàm ấy hỏi phạm vi theo phiên). Không ghi gì. */
const REPORT_READER = (orgCode: string, isHome: boolean): SessionUser => ({
  id: "",
  email: "job:daily-report",
  name: "Báo cáo ngày (máy)",
  role: "ADMIN",
  permissions: [],
  scope: "ALL",
  departmentCodes: [],
  positionId: null,
  organization: { code: orgCode, name: orgCode, isHome },
});

const ALL_SCOPE = { allow: "ALL" as const, explain: "báo cáo ngày đọc toàn tổ chức" };

export async function readDailyReportConfig(): Promise<DailyReportConfig> {
  return parseDailyReportConfig(await getSettingJson<Record<string, unknown>>(DAILY_REPORT_CONFIG_KEY, {}));
}

/** Một khối số: chạy `fn`, hỏng ⇒ mọi số của khối thành CHƯA ĐO ĐƯỢC kèm lý do. */
async function section(key: string, title: string, labels: { key: string; label: string; unit: Fact["unit"] }[], fn: () => Promise<Record<string, number | null>>): Promise<FactSection> {
  try {
    const v = await fn();
    return { key, title, facts: labels.map((l) => ({ ...l, value: v[l.key] ?? null, ...(v[l.key] === null || v[l.key] === undefined ? { missing: "nguồn không trả số" } : {}) })) };
  } catch (e) {
    const why = e instanceof Error ? e.message.slice(0, 120) : "lỗi không rõ";
    return { key, title, facts: labels.map((l) => ({ ...l, value: null, missing: `không đọc được: ${why}` })) };
  }
}

/** Gom khối số của NGÀY HÔM QUA (giờ VN) bằng các hàm báo cáo sẵn có. Không công thức mới. */
export async function gatherDailyFacts(now: Date = new Date()): Promise<DailyFacts> {
  // Kỳ dựng TỪ `now` (không đọc đồng hồ thật lần hai) — bản của ngày D luôn nói về đúng ngày D, cả khi lượt chạy trễ.
  const day = vnDateKey(new Date(now.getTime() - 86_400_000));
  const yesterday: Period = { key: "custom", from: vnStartOfDay(day), to: vnEndOfDay(day), label: day, fromKey: day, toKey: day };
  const weekFrom = addDays(day, -6);
  const week: Period = { key: "custom", from: vnStartOfDay(weekFrom), to: vnEndOfDay(day), label: `${weekFrom} → ${day}`, fromKey: weekFrom, toKey: day };
  const org = await currentOrganization();
  const sections: FactSection[] = [];

  sections.push(
    await section(
      "orders",
      "Đơn hàng & tiền (đơn tạo hôm qua · kết quả theo ORDER_OUTCOME)",
      [
        { key: "orders", label: "Đơn tạo hôm qua", unit: "count" },
        { key: "delivered", label: "Trong đó đã giao thành công", unit: "count" },
        { key: "returned", label: "Trong đó hoàn", unit: "count" },
        { key: "cash", label: "Tiền có chứng từ của đơn giao thành công", unit: "vnd" },
        { key: "rate7", label: "Tỷ lệ giao thành công 7 ngày", unit: "pct" },
        { key: "cash7", label: "Tiền có chứng từ 7 ngày", unit: "vnd" },
      ],
      async () => {
        const [d, w] = await Promise.all([dataQualitySummary(yesterday), dataQualitySummary(week)]);
        return { orders: d.total, delivered: d.delivered, returned: d.returned, cash: d.provenCash, rate7: w.successRate, cash7: w.provenCash };
      },
    ),
  );
  sections.push(await section("ads", "Quảng cáo", [{ key: "spend", label: "Chi quảng cáo hôm qua", unit: "vnd" }], async () => ({ spend: await adSpendTotal(yesterday) })));
  sections.push(
    await section(
      "care",
      "Care vận đơn (hiện tại)",
      [
        { key: "overdue", label: "Ca quá hạn", unit: "count" },
        { key: "unassigned", label: "Ca chưa ai nhận", unit: "count" },
        { key: "money", label: "Tiền COD đang treo ở ca care", unit: "vnd" },
      ],
      async () => {
        const q = await getCareQueue();
        return { overdue: q.overdue, unassigned: q.unassigned, money: q.moneyAtRisk };
      },
    ),
  );
  sections.push(
    await section(
      "work",
      "Hàng đợi công việc (hiện tại)",
      [
        { key: "backlog", label: "Việc đang mở", unit: "count" },
        { key: "overdue", label: "Việc quá hạn", unit: "count" },
        { key: "unassigned", label: "Việc chưa ai nhận", unit: "count" },
      ],
      async () => {
        const m = await getManagerDay(null, now);
        return { backlog: m.backlog, overdue: m.overdue, unassigned: m.unassigned };
      },
    ),
  );
  if (await canUseModule("wholesale_leads").catch(() => false)) {
    sections.push(
      await section(
        "wholesale",
        "Bán sỉ",
        [
          { key: "newLeads", label: "Lead mới hôm qua", unit: "count" },
          { key: "withEmail", label: "Lead sẵn sàng có email", unit: "count" },
          { key: "drafts", label: "Thư đang chờ gửi", unit: "count" },
          { key: "quotes", label: "Báo giá chưa chốt (nháp · chờ duyệt · đã duyệt · đã gửi)", unit: "count" },
        ],
        async () => {
          const params: ListParams = { page: 1, pageSize: 1, sort: "createdAt", dir: "desc", q: "", filters: {}, period: yesterday };
          const [dash, cover, box, quotes] = await Promise.all([
            wholesaleDashboard({ from: yesterday.from, to: yesterday.to, dimension: "source", decision: ALL_SCOPE, now }),
            wholesaleEmailCoverage(ALL_SCOPE),
            outboxCounts(ALL_SCOPE),
            listQuotations(REPORT_READER(org.code, org.isHome), params, now),
          ]);
          const qc = "counts" in quotes ? Object.entries(quotes.counts).filter(([k]) => ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"].includes(k)).reduce((a, [, n]) => a + (n ?? 0), 0) : null;
          return { newLeads: dash.kpi.total, withEmail: cover.withEmail, drafts: box ? box.open : null, quotes: qc };
        },
      ),
    );
  }
  if (await fbCrmEnabled().catch(() => false)) {
    sections.push(
      await section(
        "fbcrm",
        "Facebook CRM (hiện tại)",
        [
          { key: "friends", label: "Khách đã kết bạn", unit: "count" },
          { key: "due", label: "Khách tới hẹn chăm sóc", unit: "count" },
        ],
        async () => {
          const [ov, due] = await Promise.all([fbCrmOverview(""), fbCrmDueCare(vnDateKey(now))]);
          return { friends: ov ? ov.statuses.FRIENDS : null, due: ov ? due.length : null };
        },
      ),
    );
  }
  return { date: day, generatedAt: now.toISOString(), sections };
}

type AiWrite = { status: AiStatus; summary: string | null; highlights: string[]; note: string; blocked: string[]; model: string | null; costUsd: number | null };

/** AI viết lời trong trần chi phí; số bịa ⇒ chặn. Không ném. */
export async function writeWithAi(facts: DailyFacts, cfg: DailyReportConfig, now: Date): Promise<AiWrite> {
  const skip = (note: string): AiWrite => ({ status: "SKIPPED", summary: null, highlights: [], note, blocked: [], model: null, costUsd: null });
  if (cfg.maxCostUsdPerDay === null) return skip("chưa khai trần chi phí AI / ngày");
  const org = await currentOrganization();
  const today = (await aiUsageDaily(org.code, 1, now)).filter((r) => r.feature === "daily_report");
  const spent = today.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  if (spent >= cfg.maxCostUsdPerDay) return skip(`đã chạm trần chi phí hôm nay (${spent.toFixed(2)} / ${cfg.maxCostUsdPerDay} USD)`);
  const b = await getBuilderAi();
  if (!b.ok) return skip(`chưa có AI: ${b.reason}`);
  const source: AiBillingSource = b.ai.source === "ORG_CONNECTION" ? "BYOK" : b.ai.source === "PLATFORM" ? "PLATFORM" : "HOME";
  const quota = await checkAiQuota(org.code, source);
  if (!quota.ok) return skip(quota.error);
  const provider = b.ai.provider;
  try {
    const res = await provider.complete({ system: DAILY_REPORT_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `DỮ KIỆN (ngày ${facts.date}):\n${factsText(facts)}` }] }], tools: [], maxTokens: 700, reasoning: "low" });
    const model = res.model || provider.model;
    const costUsd = estimateCostUsd(model, res.usage);
    await recordAiUsage({ orgCode: org.code, feature: "daily_report", workload: null, source, provider: provider.name, model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd, status: "OK", actorId: null, ref: `daily-report:${facts.date}` }).catch(() => undefined);
    const text = res.content
      .filter((x): x is Extract<typeof x, { type: "text" }> => x.type === "text")
      .map((x) => x.text)
      .join("");
    const parsed = parseAiReport(text);
    if (!parsed) return { status: "ERROR", summary: null, highlights: [], note: "AI trả sai hình (không phải JSON tóm tắt + 3 điểm)", blocked: [], model, costUsd };
    const all = [parsed.summary, ...parsed.highlights].join("\n");
    const blocked = numbersNotInFacts(all, facts, { vndAmounts: extractVndAmounts(all), unverified: unverifiedAmounts });
    if (blocked.length) return { status: "BLOCKED", summary: null, highlights: [], note: `số không có trong khối số: ${blocked.slice(0, 6).join(", ")}`, blocked, model, costUsd };
    return { status: "OK", summary: parsed.summary, highlights: parsed.highlights, note: "", blocked: [], model, costUsd };
  } catch (e) {
    await recordAiUsage({ orgCode: org.code, feature: "daily_report", workload: null, source, provider: provider.name, model: provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId: null, ref: `daily-report:${facts.date}` }).catch(() => undefined);
    return { status: "ERROR", summary: null, highlights: [], note: e instanceof Error ? e.message.slice(0, 160) : "lỗi không rõ", blocked: [], model: provider.model, costUsd: null };
  }
}

/** Một lượt cho tổ chức NGỮ CẢNH. KHÔNG ném — job chạy chung không được sập vì báo cáo. */
export async function runDailyReport(deps: DailyReportDeps = {}): Promise<DailyReportRun> {
  const now = deps.now ?? new Date();
  try {
    const cfg = await readDailyReportConfig();
    if (!cfg.on || cfg.hourVn === null) return { ran: false, reason: "báo cáo ngày đang tắt" };
    if ((now.getUTCHours() + 7) % 24 < cfg.hourVn) return { ran: false, reason: `trước ${cfg.hourVn} giờ` };
    const reportDate = vnDateKey(new Date(now.getTime() - 86_400_000));
    const db = await getDb();
    const r = schema.dailyReports;
    // Bản đã có ⇒ thôi (và CSDL chưa áp 0266 ⇒ 42P01 ⇒ thôi, TRƯỚC khi tốn tiền AI).
    const [done] = await db.select({ id: r.id }).from(r).where(eq(r.reportDate, reportDate)).limit(1);
    if (done) return { ran: false, reason: "bản hôm qua đã có", reportDate };
    const facts = await gatherDailyFacts(now);
    const ai = await writeWithAi(facts, cfg, now);
    const inserted = await db
      .insert(r)
      .values({ reportDate, facts: facts as unknown as Record<string, unknown>, summary: ai.summary, highlights: ai.highlights, aiStatus: ai.status, aiNote: ai.note, blockedNumbers: ai.blocked, model: ai.model, costUsd: ai.costUsd })
      .onConflictDoNothing({ target: r.reportDate })
      .returning({ id: r.id });
    if (!inserted.length) return { ran: false, reason: "lượt khác vừa tạo bản hôm qua", reportDate };
    const group = await operationsGroupChannel().catch(() => null);
    let sent = false;
    let sendNote = "chưa cấu hình nhóm báo vận hành — chỉ lưu, không gửi";
    if (group) {
      const msg = dailyReportMessage(facts, ai, await organizationBaseUrl().catch(() => null));
      const d = await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title: `Báo cáo ngày ${reportDate}`, body: msg, dedupeKey: `daily-report:${reportDate}`, event: "ops.daily_report" });
      sent = d.status === "SENT";
      sendNote = d.status === "FAILED" ? `gửi hỏng: ${d.error.slice(0, 120)}` : d.status;
    }
    await audit({ userEmail: "job:daily-report", action: "DAILY_REPORT_CREATE", entity: "DAILY_REPORT", entityId: inserted[0].id, after: { reportDate, aiStatus: ai.status, model: ai.model, costUsd: ai.costUsd, sent }, reason: `Báo cáo ngày ${reportDate} · ${sendNote}` }).catch(() => undefined);
    return { ran: true, reason: sendNote, reportDate, aiStatus: ai.status, sent };
  } catch (e) {
    if (isUndefinedTableError(e)) return { ran: false, reason: "CSDL chưa áp 0266" };
    return { ran: false, reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}

// ─────────────────────────── CẤU HÌNH ───────────────────────────

export type ConfigResult = { ok: true; changed: boolean; message: string } | { ok: false; error: string };

/** Bật / tắt + giờ + trần chi phí — chỉ `settings:manage`. Lưu lặp ⇒ không ghi (luật 61). */
export async function setDailyReportConfigCore(user: SessionUser, raw: unknown): Promise<ConfigResult> {
  if (!can(user, "settings:manage")) return { ok: false, error: "Chỉ quản trị cài đặt tổ chức (settings:manage) mới cấu hình báo cáo ngày." };
  const parsed = dailyReportConfigZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await readDailyReportConfig();
  const next = parsed.data;
  if (JSON.stringify(before) === JSON.stringify(next)) return { ok: true, changed: false, message: "Không có gì thay đổi." };
  await setSettingJson(DAILY_REPORT_CONFIG_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "DAILY_REPORT_CONFIG", entity: "SETTING", entityId: DAILY_REPORT_CONFIG_KEY, before, after: next, reason: next.on ? `Bật báo cáo ngày lúc ${next.hourVn} giờ` : "Tắt báo cáo ngày" });
  return { ok: true, changed: true, message: next.on ? `Đã bật báo cáo ngày — chạy từ ${next.hourVn} giờ mỗi ngày.` : "Đã tắt báo cáo ngày." };
}

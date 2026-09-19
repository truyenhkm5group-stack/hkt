import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import {
  DEFAULT_MARKETING_ALERT_CONFIG,
  MARKETING_ALERT_KEY,
  SEVERITY_RANK,
  type MarketingAlertConfig,
} from "@/lib/constants/marketing-alerts";
import { MARKETING_ALERT_MAX_PER_RUN, MARKETING_DIAGNOSIS } from "@/lib/constants/marketing-diagnosis";
import { MATURITY_LABEL } from "@/lib/constants/marketing-daily";
import { baselineOf, diagnose, lossStreakOf, sortFindings, type DiagnoseSnapshot, type MarketingFinding } from "@/lib/marketing/diagnose";
import { getMarketingBreakdown, getMarketingDaily, type MarketingDailyBase, type MarketingDailyRow } from "@/lib/queries/marketing-daily";
import { ratioOf } from "@/lib/queries/marketing-daily";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ BẢN TIN MARKETING HẰNG NGÀY — MỘT LẦN MỘT NGÀY, ĐÚNG NGƯỜI ═══════════
 *
 * Cùng khuôn với `lib/work/escalation-run.ts`: job này KHÔNG ghi vào bảng nghiệp vụ nào, không đổi
 * một con số nào. Nó chỉ đọc, dựng câu, và đi tìm người khi không ai mở màn hình.
 *
 * ─── VÌ SAO BẢN TIN NÓI VỀ HÔM QUA, KHÔNG PHẢI HÔM NAY ───
 *
 * Bản tin gửi lúc 9 giờ sáng mà nói về "hôm nay" thì nó đang nói về ba tiếng đầu ngày: tiền quảng
 * cáo chưa tiêu hết, đơn chưa lên hết, và chưa đơn nào kịp giao. Mọi con số sẽ đọc như thảm hoạ.
 * Nên bản tin nói về NGÀY HÔM QUA — ngày duy nhất vừa đã đóng vừa còn đáng hành động.
 *
 * Kể cả hôm qua thì độ chín vẫn thấp (đơn lên hôm qua chưa giao xong), nên **mọi bản tin đều in độ
 * chín ngay cạnh lợi nhuận**. Không có dòng nào nói "lỗ 1,5 triệu" mà không nói ngay bên cạnh rằng
 * 70% đơn của ngày đó còn đang trên đường.
 *
 * ─── SỔ CHỐNG GỬI LẠI ───
 *
 * Bộ lập lịch chạy job nhiều lần. Không có sổ thì mỗi MKTer nhận đúng một tin nhắn đó vài lần mỗi
 * giờ, và sau buổi sáng đầu tiên không ai đọc nữa — kể cả lần thật sự cần báo.
 */

const SENT_KEY = "marketing.digest.sent";

/** Ngày theo giờ Việt Nam. "Một lần mỗi ngày" phải là một ngày của người đi làm, không phải của UTC. */
export function vnDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

function dayPeriod(day: string): Period {
  const from = new Date(`${day}T00:00:00+07:00`);
  const to = new Date(`${day}T23:59:59.999+07:00`);
  return { key: "custom", from, to, label: day, fromKey: day, toKey: day };
}

function rangePeriod(fromDay: string, toDay: string): Period {
  return { key: "custom", from: new Date(`${fromDay}T00:00:00+07:00`), to: new Date(`${toDay}T23:59:59.999+07:00`), label: `${fromDay}→${toDay}`, fromKey: fromDay, toKey: toDay };
}

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function toSnapshot(b: MarketingDailyBase): DiagnoseSnapshot {
  return {
    adSpend: b.adSpend,
    messages: b.messages,
    orders: b.orders,
    posRevenue: b.posRevenue,
    deliveredRevenue: b.deliveredRevenue,
    deliveredOrders: b.deliveredOrders,
    returnedOrders: b.returnedOrders,
    finishedOrders: b.finishedOrders,
    pendingOrders: b.pendingOrders,
    contributionProfit: b.contributionProfit,
  };
}

export async function loadMarketingAlertConfig(): Promise<MarketingAlertConfig> {
  const stored = await getSettingJson<Partial<MarketingAlertConfig>>(MARKETING_ALERT_KEY, {});
  return { ...DEFAULT_MARKETING_ALERT_CONFIG, ...stored, recipients: stored.recipients ?? [] };
}

/* ═══════════════ DỰNG CÂU — HÀM THUẦN, KIỂM THỬ ĐƯỢC KHÔNG CẦN CSDL ═══════════════ */

const vnd = (v: number | null) => (v === null ? "—" : `${Math.round(v).toLocaleString("vi-VN")}đ`);
const num = (v: number | null) => (v === null ? "—" : Math.round(v).toLocaleString("vi-VN"));
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 10) / 10}%`);
const ratio = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100) / 100}`);

export type DigestScope = { key: string; label: string; totals: MarketingDailyBase & { maturity: string }; findings: MarketingFinding[] };

/**
 * Dòng chữ của một bản tin. Trả về MẢNG DÒNG chứ không phải một chuỗi, để Lark (dạng `post`),
 * hàng đợi ERP và kiểm thử dùng chung một nguồn — ba nơi in cùng một nội dung.
 */
export function digestLines(day: string, scope: DigestScope, previous: MarketingDailyBase | null, baseUrl: string): string[] {
  const t = scope.totals;
  const lines: string[] = [];
  lines.push(`Chi QC: ${vnd(t.adSpend)} · Tin nhắn: ${num(t.messages)} · Đơn: ${num(t.orders)}`);
  lines.push(`CPQC/đơn: ${vnd(ratioOf("costPerOrder", t))} · Tỷ lệ chốt: ${pct(ratioOf("closeRate", t))}`);
  lines.push(`Doanh số POS: ${vnd(t.posRevenue)} · Doanh thu thực: ${vnd(t.deliveredRevenue)}`);
  lines.push(`Giao TC: ${num(t.deliveredOrders)} · Hoàn: ${num(t.returnedOrders)} · Tỷ lệ giao: ${pct(ratioOf("deliveryRate", t))}`);
  lines.push(`ROAS thực: ${ratio(ratioOf("roasDelivered", t))} · Margin: ${pct(ratioOf("margin", t))}`);
  /*
    LỢI NHUẬN LUÔN ĐI KÈM ĐỘ CHÍN, TRÊN CÙNG MỘT DÒNG.

    Tách ra hai dòng là mời người đọc dừng lại ở dòng đầu. "Lỗ 1,5tr" đọc một mình dẫn tới quyết
    định cắt ngân sách; "lỗ 1,5tr — mới 20% đơn ngã ngũ" dẫn tới quyết định chờ. Hai quyết định
    khác hẳn nhau, và khoảng cách giữa chúng chỉ là mấy chữ.
  */
  lines.push(`Lợi nhuận góp: ${vnd(t.contributionProfit)} — độ chín ${pct(ratioOf("maturity", t) )} (${MATURITY_LABEL[t.maturity as keyof typeof MATURITY_LABEL] ?? t.maturity}), còn ${num(t.pendingOrders)} đơn đang đi`);

  if (previous) {
    const cmp: string[] = [];
    const chg = (now: number | null, before: number | null) => (now === null || before === null || before === 0 ? null : ((now - before) / Math.abs(before)) * 100);
    const add = (label: string, v: number | null) => {
      if (v === null) return;
      cmp.push(`${label} ${v >= 0 ? "+" : ""}${Math.round(v * 10) / 10}%`);
    };
    add("CPQC/đơn", chg(ratioOf("costPerOrder", t), ratioOf("costPerOrder", previous)));
    add("Tỷ lệ chốt", chg(ratioOf("closeRate", t), ratioOf("closeRate", previous)));
    add("Tỷ lệ giao", chg(ratioOf("deliveryRate", t), ratioOf("deliveryRate", previous)));
    if (cmp.length) lines.push(`So với TB ${MARKETING_DIAGNOSIS.baselineDays} ngày: ${cmp.join(" · ")}`);
  }

  if (scope.findings.length) {
    lines.push("");
    for (const f of scope.findings.slice(0, MARKETING_ALERT_MAX_PER_RUN)) {
      lines.push(`${f.severity === "CRITICAL" ? "🔴" : "🟡"} ${f.title}`);
      for (const e of f.evidence) lines.push(`   ${e}`);
      for (const a of f.actions.slice(0, 2)) lines.push(`   → ${a}`);
    }
  } else {
    lines.push("");
    lines.push("Không phát hiện bất thường nào vượt ngưỡng.");
  }
  if (baseUrl) lines.push(`Xem báo cáo: ${baseUrl.replace(/\/$/, "")}/ads/daily?period=custom&from=${day}&to=${day}`);
  return lines;
}

/* ═══════════════ CHẠY ═══════════════ */

export type DigestRunResult = {
  day: string;
  scopes: number;
  sent: { scope: string; ok: boolean; error?: string }[];
  skipped: { scope: string; reason: string }[];
  findings: number;
  detail: string;
};

/**
 * Bản tin hằng ngày. `now` truyền vào được để kiểm thử — luật AGENTS.md mục 50 (bài kiểm không
 * được ghim một ngày tuyệt đối rồi gieo dữ liệu tương đối so với nó).
 */
export async function runMarketingDigest(now: Date = new Date()): Promise<DigestRunResult> {
  const day = shiftDay(vnDay(now), -1); // hôm qua theo giờ VN
  const cfg = await loadMarketingAlertConfig();
  const [alertCfg, sentLedger] = await Promise.all([loadAlertConfig(), getSettingJson<Record<string, string>>(SENT_KEY, {})]);
  const baseUrl = (cfg.baseUrl || process.env.APP_URL || "").replace(/\/$/, "");

  const dayP = dayPeriod(day);
  const baseFrom = shiftDay(day, -MARKETING_DIAGNOSIS.baselineDays);
  const baseTo = shiftDay(day, -1);

  const [today, baselineRange] = await Promise.all([getMarketingDaily(dayP, "created"), getMarketingDaily(rangePeriod(baseFrom, baseTo), "created")]);
  const baseline = baselineOf(baselineRange.rows.map(toSnapshot), 3);
  const staleSources = today.freshness.filter((f) => f.stale).map((f) => f.label);

  const scopes: DigestScope[] = [];

  // ── Bản TỔNG cho quản lý ──
  const shopFindings = diagnose({
    day,
    scope: "",
    scopeLabel: "Toàn shop",
    current: toSnapshot(today.totals),
    baseline,
    lossStreak: lossStreakOf(baselineRange.rows.concat(today.rows) as MarketingDailyRow[]),
    staleSources,
  });
  scopes.push({ key: "", label: "Toàn shop", totals: today.totals, findings: sortFindings(shopFindings) });

  // ── Bản RIÊNG cho từng MKTer ──
  if (cfg.perMarketer && cfg.recipients.some((r) => r.active)) {
    const breakdown = await getMarketingBreakdown(dayP, "created", "marketer", {}, 20);
    const baseBreakdown = await getMarketingBreakdown(rangePeriod(baseFrom, baseTo), "created", "marketer", {}, 20);
    const baseByKey = new Map(baseBreakdown.rows.map((r) => [r.key, r]));
    for (const row of breakdown.rows) {
      const recipient = cfg.recipients.find((r) => r.marketerId === row.key && r.active);
      if (!recipient) continue;
      /*
        NỀN CỦA MỘT NGƯỜI phải là TRUNG BÌNH NGÀY của chính người đó, không phải tổng cả kỳ:
        so một ngày với tổng bảy ngày thì ai cũng "tụt 85%".
      */
      const b = baseByKey.get(row.key);
      const perDay = b ? divideBase(b, MARKETING_DIAGNOSIS.baselineDays) : null;
      const findings = diagnose({ day, scope: `marketer:${row.key}`, scopeLabel: row.label, current: toSnapshot(row), baseline: perDay ? toSnapshot(perDay) : null, staleSources });
      scopes.push({ key: `marketer:${row.key}`, label: row.label, totals: row, findings: sortFindings(findings) });
    }
  }

  // ── Gửi ──
  const sent: DigestRunResult["sent"] = [];
  const skipped: DigestRunResult["skipped"] = [];
  const ledger = { ...sentLedger };
  const minRank = SEVERITY_RANK[cfg.minSeverityToSend];

  for (const scope of scopes) {
    const ledgerKey = `${scope.key || "shop"}:${day}`;
    if (ledger[ledgerKey]) {
      skipped.push({ scope: scope.label, reason: "đã gửi cho ngày này" });
      continue;
    }
    if (!cfg.enabled) {
      skipped.push({ scope: scope.label, reason: "cấu hình đang tắt" });
      continue;
    }
    const isManager = scope.key === "";
    const target = isManager
      ? { url: cfg.managerWebhookUrl || alertCfg.larkWebhookUrl, secret: cfg.managerSecret || alertCfg.larkSecret }
      : (() => {
          const r = cfg.recipients.find((x) => `marketer:${x.marketerId}` === scope.key);
          return { url: r?.larkWebhookUrl ?? "", secret: r?.larkSecret ?? "" };
        })();
    if (!target.url) {
      // KHÔNG im lặng bỏ qua: bản tin vẫn được dựng, và lý do không gửi được phải đọc được ở lượt chạy.
      skipped.push({ scope: scope.label, reason: "chưa khai webhook Lark" });
      continue;
    }
    /*
      BẢN TỔNG luôn gửi (đó là bản tin hằng ngày, không phải cảnh báo). Bản RIÊNG chỉ gửi khi có
      phát hiện đủ mức — một tin nhắn "hôm qua bình thường" gửi mỗi sáng cho năm người là cách
      nhanh nhất để kênh này bị tắt thông báo.
    */
    const maxRank = scope.findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), -1);
    if (!isManager && maxRank < minRank) {
      skipped.push({ scope: scope.label, reason: "không có phát hiện đủ mức để làm phiền" });
      ledger[ledgerKey] = new Date().toISOString();
      continue;
    }
    const title = isManager ? `MARKETING — ${day}` : `MARKETING ${day} · ${scope.label}`;
    const lines = digestLines(day, scope, null, baseUrl).map((text) => [{ text }]);
    const res = await sendLark(target.url, target.secret, title, lines);
    sent.push({ scope: scope.label, ok: res.ok, error: res.error });
    if (res.ok) ledger[ledgerKey] = new Date().toISOString();
  }

  // Dọn sổ: chỉ giữ 30 ngày gần nhất để `settings` không phình vô hạn.
  const keep = shiftDay(day, -30);
  for (const key of Object.keys(ledger)) {
    const d = key.slice(key.lastIndexOf(":") + 1);
    if (d < keep) delete ledger[key];
  }
  await setSettingJson(SENT_KEY, ledger);

  const findingCount = scopes.reduce((s, x) => s + x.findings.length, 0);
  return {
    day,
    scopes: scopes.length,
    sent,
    skipped,
    findings: findingCount,
    detail: `Ngày ${day}: ${scopes.length} phạm vi · ${findingCount} phát hiện · gửi ${sent.filter((s) => s.ok).length}/${sent.length} · bỏ qua ${skipped.length}`,
  };
}

/** Chia một tổng kỳ thành TRUNG BÌNH NGÀY. `null` vẫn là `null` — chia một số chưa biết không ra số. */
function divideBase<T extends MarketingDailyBase>(b: T, days: number): MarketingDailyBase {
  const d = (v: number | null) => (v === null ? null : v / days);
  return {
    adSpend: d(b.adSpend),
    messages: d(b.messages),
    orders: b.orders / days,
    units: b.units / days,
    posRevenue: b.posRevenue / days,
    deliveredRevenue: b.deliveredRevenue / days,
    deliveredOrders: b.deliveredOrders / days,
    returnedOrders: b.returnedOrders / days,
    cancelledOrders: b.cancelledOrders / days,
    pendingOrders: b.pendingOrders / days,
    shippedOrders: b.shippedOrders / days,
    finishedOrders: b.finishedOrders / days,
    maturityBase: b.maturityBase / days,
    cogs: b.cogs / days,
    shippingCost: b.shippingCost / days,
    operatingCost: d(b.operatingCost),
    contributionProfit: d(b.contributionProfit),
    netProfit: d(b.netProfit),
  };
}

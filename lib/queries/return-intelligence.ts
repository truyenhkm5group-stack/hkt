/**
 * ═══════════ TẦNG QUYẾT ĐỊNH CỦA BÁO CÁO HOÀN ═══════════
 *
 * Hợp đồng và lý lẽ ở `lib/constants/return-intelligence.ts`. Tệp này chỉ đo.
 *
 * ─── TỆP NÀY KHÔNG ĐỊNH NGHĨA LẠI MỘT CHỈ SỐ NÀO ───
 *
 * "Đã gửi" · "giao thành công" · "hoàn" · "ước tính" đều đọc từ hai hợp đồng đang chạy:
 * `ORDER_OUTCOME` (`lib/queries/return-rate.ts`) và `PROJECTED_GTC_V3`
 * (`lib/queries/projected-delivery.ts`). Bảng lý do / marketer đọc từ `getReturnReasonReport`, vốn
 * cũng đứng trên hai hợp đồng ấy. Nhờ vậy mọi con số ở đây khớp với bảng phía trên cùng màn hình
 * — thứ mà một truy vấn "cho nhanh" ở tầng này chắc chắn sẽ phá.
 *
 * ─── NHỮNG THỨ CÓ THẬT Ở ĐÂY ───
 *
 *  · rủi ro theo mã hàng, chấm bằng ĐÍCH trong `metric_targets` (không có đích ⇒ không kết luận);
 *  · phân lớp vấn đề từ LÝ DO, kèm phòng ban và việc phải làm;
 *  · chất lượng đầu vào theo marketer, quy kết bằng khoá chiến dịch chứ không bằng tên;
 *  · hiệu quả chăm sóc kiện, CHỈ chấm trên ca đã ngã ngũ;
 *  · xu hướng theo ngày / tuần và so với kỳ trước cùng độ dài;
 *  · khối "Cần chú ý": mỗi dòng mang con số và cỡ mẫu đã dựng nên nó.
 */
import { sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { DEPARTMENT_LABEL } from "@/lib/constants/departments";
import { resolveTarget, verdict as targetVerdict, type TargetRow } from "@/lib/constants/metric-targets";
import { MARKETER_COVERAGE_WARN_PCT, type MarketerCoverage, type MarketerEvidence } from "@/lib/constants/marketer-attribution";
import { isModelledSubstate } from "@/lib/constants/projected-delivery";
import { CARRIER_HANDOFF_AT_SQL, timeBasisColumnSql, type TimeBasis } from "@/lib/constants/report-time-basis";
import {
  ACTION_LIST_MAX,
  ALERT_MIN_SAMPLE,
  PROBLEM_ACTION,
  PROBLEM_DEPARTMENT,
  PROBLEM_LABEL,
  PROBLEM_OF_REASON,
  PRODUCT_RISK_METRIC,
  type ProblemClass,
  type ReturnAction,
  type RiskLevel,
} from "@/lib/constants/return-intelligence";
import { RETURN_REASON_LABEL, type ReturnReason } from "@/lib/constants/return-reason";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
import { listTargets } from "@/lib/queries/metric-targets";
import { marketerLabel, marketerNames } from "@/lib/queries/order-marketer";
import { getProjectedDeliveryMetrics, getProbabilityLookup } from "@/lib/queries/projected-delivery";
import { getReturnReasonReport, type ReturnReasonReport } from "@/lib/queries/return-reason-report";
import { NO_ORDER_VALUE_FILTER, orderValueKey, orderValueWhereSql, type OrderValueFilter } from "@/lib/constants/order-value";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";
import { timingStat } from "@/lib/constants/care-timing";
import type { Period } from "@/lib/search-params";

/* ═══════════════════ 1. RỦI RO THEO MÃ HÀNG ═══════════════════ */

export type ProductRiskRow = {
  code: string;
  name: string;
  /** Đơn đã bàn giao ĐVVC trong cohort — mẫu số của mọi tỷ lệ ở dòng này. */
  eligibleSent: number;
  delivered: number;
  failed: number;
  active: number;
  finished: number;
  /** `null` = chưa đơn nào kết thúc. KHÔNG phải 0%. */
  actualRate: number | null;
  /** `PROJECTED_GTC_V3`. `null` = mô hình chưa dự báo được — không phải 0%. */
  projectedRate: number | null;
  returnRate: number | null;
  lostRevenue: number;
  /** Ba lý do lớn nhất, kèm lớp vấn đề của từng lý do. */
  topReasons: { reason: ReturnReason; label: string; count: number; problem: ProblemClass }[];
  /** Lớp vấn đề chiếm nhiều ca nhất — thứ quyết định việc này đi tới phòng nào. */
  dominantProblem: { problem: ProblemClass; count: number; share: number } | null;
  /** Tỷ lệ hoàn kỳ TRƯỚC cùng độ dài. `null` = kỳ trước chưa đủ mẫu hoặc không có dữ liệu. */
  prevReturnRate: number | null;
  /** Chênh điểm phần trăm so với kỳ trước; dương = XẤU ĐI (tỷ lệ hoàn là chỉ số càng thấp càng tốt). */
  returnRateDelta: number | null;
  risk: RiskLevel;
  /** Vì sao nhãn là thế — hiện thẳng, không giấu. */
  riskReason: string;
};

/* ═══════════════════ 2. CHẤT LƯỢNG ĐẦU VÀO THEO MARKETER ═══════════════════ */

export type MarketerQualityRow = {
  marketerId: string | null;
  label: string;
  finished: number;
  delivered: number;
  returned: number;
  successRate: number | null;
  returnRate: number | null;
  lostRevenue: number;
  topReason: { reason: ReturnReason; label: string; count: number } | null;
  /** Chênh điểm % của tỷ lệ hoàn so với toàn shop. Dương = hoàn nhiều hơn mặt bằng. */
  gapPoints: number | null;
  /** Đủ mẫu để so với toàn shop chưa. `false` ⇒ hiện thực tế, KHÔNG xếp hạng, KHÔNG gắn nhãn. */
  comparable: boolean;
  /** Đơn của người này vỡ theo LOẠI BẰNG CHỨNG quy kết. Cộng hai ô = `finished`. */
  byEvidence: Record<MarketerEvidence, number>;
};

/* ═══════════════════ 3. HIỆU QUẢ CHĂM SÓC KIỆN ═══════════════════ */

export type CareStateRow = {
  state: string;
  label: string;
  cases: number;
  withOwner: number;
  withAction: number;
  /** Trung vị số giờ từ lúc mở ca tới thao tác đầu tiên. `null` = chưa ca nào có thao tác. */
  hoursToFirstActionP50: number | null;
  delivered: number;
  failed: number;
  pending: number;
  /** Cứu được ÷ ca đã ngã ngũ. `null` = chưa ca nào ngã ngũ — không phải 0%. */
  rescueRate: number | null;
};

export type CarePicRow = {
  ownerEmail: string;
  cases: number;
  delivered: number;
  failed: number;
  pending: number;
  rescueRate: number | null;
  comparable: boolean;
};

/* ═══════════════════ 4. XU HƯỚNG ═══════════════════ */

export const TREND_GRAINS = ["DAY", "WEEK"] as const;
export type TrendGrain = (typeof TREND_GRAINS)[number];

export type TrendPoint = {
  /** Mốc đầu của rổ, theo ĐÚNG mốc thời gian đang lọc. */
  at: string;
  eligibleSent: number;
  delivered: number;
  failed: number;
  active: number;
  actualRate: number | null;
  returnRate: number | null;
  /** Ước tính của riêng rổ này — cùng bảng xác suất với con số toàn kỳ. `null` = chưa đo được. */
  projectedRate: number | null;
};

/* ═══════════════════ KẾT QUẢ TỔNG ═══════════════════ */

export type ReturnIntelligence = {
  products: ProductRiskRow[];
  marketers: MarketerQualityRow[];
  marketerCoverage: MarketerCoverage & { warn: boolean };
  care: { byState: CareStateRow[]; byPic: CarePicRow[]; totalCases: number; since: Date | null };
  trend: { grain: TrendGrain; points: TrendPoint[] };
  compare: {
    label: string;
    current: { finished: number; delivered: number; returned: number; successRate: number | null; returnRate: number | null; projectedRate: number | null };
    previous: { finished: number; delivered: number; returned: number; successRate: number | null; returnRate: number | null; projectedRate: number | null };
    /** Điểm phần trăm, dấu ĐÃ theo chiều: dương = tốt lên. */
    successDelta: number | null;
    returnDelta: number | null;
    /** Kỳ hiện tại còn nhiều đơn chưa ngã ngũ ⇒ so sánh chưa chín, phải cảnh báo. */
    immature: boolean;
    immatureNote: string | null;
  };
  coverage: {
    reason: { known: number; total: number; pct: number | null };
    marketer: { known: number; total: number; pct: number | null };
    /** Đơn lần được về một mã hàng — phần còn lại là dòng hàng gõ tay, KHÔNG đoán mã từ tên. */
    sku: { known: number; total: number; pct: number | null };
  };
  actions: ReturnAction[];
  /** Có đích cho chỉ số GTC hay chưa — quyết định có được phép gắn nhãn rủi ro không. */
  hasTarget: boolean;
};

export type IntelligenceInput = {
  period: Period;
  /** Khoảng giá trị đơn — xem `lib/constants/order-value.ts`. Mặc định không lọc. */
  value?: OrderValueFilter;
  /** Kỳ TRƯỚC cùng độ dài. `null` khi kỳ hiện tại không có cả hai đầu mốc (xem "tất cả"). */
  previous: { from: Date | null; to: Date | null } | null;
  basis: TimeBasis;
  codes?: string[];
  variantKeys?: string[];
  marketerIds?: string[];
  trendGrain?: TrendGrain;
  /** Báo cáo lý do đã dựng ở nơi gọi — truyền vào để KHÔNG dựng lại lần thứ hai. */
  reasonReport?: ReturnReasonReport;
};

export async function getReturnIntelligence(input: IntelligenceInput): Promise<ReturnIntelligence> {
  const key = [
    "return-intel",
    input.basis,
    input.period.from?.toISOString() ?? "-",
    input.period.to?.toISOString() ?? "-",
    (input.codes ?? []).join("+"),
    (input.variantKeys ?? []).join("+"),
    (input.marketerIds ?? []).join("+"),
    input.trendGrain ?? "DAY",
    // Bộ lọc giá trị đơn đổi TẤT CẢ các khối bên dưới ⇒ phải nằm trong khoá nhớ (§2).
    orderValueKey(input.value ?? NO_ORDER_VALUE_FILTER),
  ].join(":");
  // 90 giây, đúng dải AGENTS.md mục 2. Mọi tham số đổi kết quả đều nằm trong khoá.
  return memo(key, 90_000, () => dung(input));
}

async function dung(input: IntelligenceInput): Promise<ReturnIntelligence> {
  const value = input.value ?? NO_ORDER_VALUE_FILTER;
  const loc = { period: input.period, basis: input.basis, codes: input.codes, variantKeys: input.variantKeys, marketerIds: input.marketerIds, value };
  const trendGrain: TrendGrain = input.trendGrain ?? "DAY";

  const [hienTai, kyTruoc, duBao, targets, ten, cham, xuHuong] = await Promise.all([
    input.reasonReport ? Promise.resolve(input.reasonReport) : getReturnReasonReport(loc),
    input.previous ? getReturnReasonReport({ ...loc, period: { ...input.period, from: input.previous.from, to: input.previous.to } }) : Promise.resolve(null),
    getProjectedDeliveryMetrics(input.period, input.basis, "PRODUCT", value),
    listTargets(),
    marketerNames(),
    careRows(input.period, input.basis, value),
    trendPoints(input.period, input.basis, trendGrain, value),
  ]);

  /*
    ─── ĐÍCH: KHÔNG HẰNG SỐ NÀO, VÀ MỖI MÃ CÓ THỂ CÓ MỨC RIÊNG ───

    `dichCuaMa(code)` tra đúng một lần cho mỗi mã, trên CÙNG một tập dòng đã đọc. `resolveTarget`
    chọn tầng HẸP NHẤT còn hiệu lực: có đích riêng cho mã ⇒ dùng nó; không có ⇒ rơi về đích toàn
    công ty; không có cả hai ⇒ `null` ⇒ `NO_TARGET`, hiện thực tế và VẪN XẾP HẠNG.

    `dichChung` (không mã) là thứ dùng để trả lời câu "shop đã đặt mục tiêu GTC chưa" cho tầng
    hành động — một mã có đích riêng không có nghĩa là shop đã chốt chuẩn chung.
  */
  const moc = input.period.to ?? new Date();
  const dichCuaMa = (productCode: string | null) =>
    resolveTarget(targets as TargetRow[], {
      metricKey: PRODUCT_RISK_METRIC,
      departmentCode: null,
      positionId: null,
      productCode,
      at: moc,
      periodKind: "ANY",
    });
  const dich = dichCuaMa(null);

  const duBaoTheoMa = new Map(duBao.rows.map((r) => [r.code, r]));
  const truocTheoMa = new Map((kyTruoc?.products ?? []).map((p) => [p.code, p]));

  const products: ProductRiskRow[] = hienTai.products.map((p) => {
    const d = duBaoTheoMa.get(p.code);
    const truoc = truocTheoMa.get(p.code);
    const eligibleSent = d?.eligibleSent ?? p.finished;
    const active = d?.active ?? 0;
    const topReasons = (p.topReason ? [p.topReason] : []).map((t) => ({ reason: t.reason, label: t.label, count: t.count, problem: PROBLEM_OF_REASON[t.reason] }));
    const { risk, riskReason } = chamRuiRo({ actualRate: p.successRate, finished: p.finished, dich: dichCuaMa(p.code) });
    const prevReturnRate = truoc && truoc.finished >= ALERT_MIN_SAMPLE.minFinished ? truoc.returnRate : null;
    return {
      code: p.code,
      name: p.name,
      eligibleSent,
      delivered: p.delivered,
      failed: p.returned,
      active,
      finished: p.finished,
      actualRate: p.successRate,
      projectedRate: d?.projectedRate ?? null,
      returnRate: p.returnRate,
      lostRevenue: 0,
      topReasons,
      dominantProblem: null,
      prevReturnRate,
      returnRateDelta: prevReturnRate !== null && p.returnRate !== null ? Math.round((p.returnRate - prevReturnRate) * 10) / 10 : null,
      risk,
      riskReason,
    };
  });

  /* ─── LỚP VẤN ĐỀ CHIẾM NHIỀU CA NHẤT của từng mã: đếm trên lý do, không trên con số ─── */
  const lopTheoMa = await problemByProduct(loc);
  for (const p of products) {
    const m = lopTheoMa.get(p.code);
    if (!m) continue;
    p.lostRevenue = m.lostRevenue;
    p.topReasons = m.top.map((t) => ({ reason: t.reason, label: RETURN_REASON_LABEL[t.reason], count: t.count, problem: PROBLEM_OF_REASON[t.reason] }));
    const tong = [...m.byProblem.values()].reduce((a, b) => a + b, 0);
    const lon = [...m.byProblem].sort((a, b) => b[1] - a[1])[0];
    p.dominantProblem = lon && tong ? { problem: lon[0], count: lon[1], share: Math.round((lon[1] / tong) * 1000) / 10 } : null;
  }
  products.sort((a, b) => b.failed - a.failed || b.eligibleSent - a.eligibleSent);

  /* ─── MARKETER ─── */
  const tongHoanShop = hienTai.returnRate;
  const marketers: MarketerQualityRow[] = hienTai.marketers.map((m) => {
    const comparable = m.finished >= ALERT_MIN_SAMPLE.minMarketerFinished;
    return {
      marketerId: m.marketerId,
      label: marketerLabel(m.marketerId, ten),
      finished: m.finished,
      delivered: m.delivered,
      returned: m.returned,
      successRate: m.successRate,
      returnRate: m.returnRate,
      lostRevenue: m.lostRevenue,
      topReason: m.topReason,
      gapPoints: comparable && m.returnRate !== null && tongHoanShop !== null ? Math.round((m.returnRate - tongHoanShop) * 10) / 10 : null,
      comparable,
      byEvidence: m.byEvidence,
    };
  });

  /* ─── SO KỲ ─── */
  const compare = soKy(hienTai, kyTruoc, duBao.orderLevel.projectedRate, input);

  /* ─── ĐỘ PHỦ ─── */
  const coverage = {
    reason: { known: hienTai.reasonCoverage.known, total: hienTai.returned, pct: hienTai.reasonCoverage.pct },
    marketer: { known: hienTai.marketerCoverage.resolved, total: hienTai.marketerCoverage.total, pct: hienTai.marketerCoverage.pct },
    sku: {
      known: duBao.totalOrders - duBao.unmappedOrders,
      total: duBao.totalOrders,
      pct: duBao.totalOrders ? Math.round(((duBao.totalOrders - duBao.unmappedOrders) / duBao.totalOrders) * 1000) / 10 : null,
    },
  };

  const actions = dungHanhDong({ products, marketers, care: cham, coverage, hienTai, hasTarget: dich !== null, basis: input.basis, period: input.period });

  return {
    products,
    marketers,
    marketerCoverage: { ...hienTai.marketerCoverage, warn: (hienTai.marketerCoverage.pct ?? 0) < MARKETER_COVERAGE_WARN_PCT },
    care: cham,
    trend: { grain: trendGrain, points: xuHuong },
    compare,
    coverage,
    actions,
    hasTarget: dich !== null,
  };
}

/* ═══════════════════ CHẤM RỦI RO — ĐÍCH QUYẾT ĐỊNH, KHÔNG PHẢI HẰNG SỐ ═══════════════════ */

function chamRuiRo(input: { actualRate: number | null; finished: number; dich: ReturnType<typeof resolveTarget> }): { risk: RiskLevel; riskReason: string } {
  if (input.finished < ALERT_MIN_SAMPLE.minFinished) {
    return { risk: "INSUFFICIENT", riskReason: `Mới ${input.finished} đơn đã kết thúc — dưới ${ALERT_MIN_SAMPLE.minFinished}, chưa đủ để nói gì về mã này.` };
  }
  if (!input.dich) {
    return { risk: "NO_TARGET", riskReason: "Chưa ai đặt mục tiêu cho chỉ số Tỷ lệ giao thành công. Màn hình hiện thực tế và vẫn xếp hạng, chỉ không kết luận đạt/không đạt." };
  }
  if (input.actualRate === null) return { risk: "INSUFFICIENT", riskReason: "Chưa đơn nào đi tới kết quả cuối." };
  /*
    Dùng CHÍNH `verdict()` của hợp đồng đích, không viết lại phép so. `criticalAt` / `warningAt` là
    do chủ shop khai cùng lúc với đích — nơi này chỉ đọc.
  */
  const v = targetVerdict({ value: input.actualRate, target: input.dich.target, targetMax: input.dich.targetMax, direction: "HIGHER_BETTER" });
  /*
    NÓI RÕ ĐANG CHẤM BẰNG MỤC TIÊU NÀO. Mã Q004 đạt theo mức riêng 55% trong khi shop đặt 65% là
    một câu hoàn toàn khác với "Q004 đạt" — giấu vế sau là để người đọc tự suy ra sai.
  */
  const nguon = input.dich.scope === "PRODUCT" ? "mục tiêu riêng của mã" : "mục tiêu toàn shop";
  if (v === "MET") return { risk: "GOOD", riskReason: `GTC ${input.actualRate.toFixed(1)}% ≥ ${nguon} ${input.dich.target}%.` };
  const nghiemTrong = input.dich.criticalAt;
  if (nghiemTrong !== null && input.actualRate < nghiemTrong) {
    return { risk: "HIGH_RISK", riskReason: `GTC ${input.actualRate.toFixed(1)}% dưới ngưỡng báo động ${nghiemTrong}% chủ shop đã khai.` };
  }
  return { risk: "WATCH", riskReason: `GTC ${input.actualRate.toFixed(1)}% dưới ${nguon} ${input.dich.target}% nhưng chưa tới ngưỡng báo động.` };
}

/* ═══════════════════ LỚP VẤN ĐỀ THEO MÃ HÀNG ═══════════════════ */

/**
 * Đếm lý do theo mã hàng rồi quy về lớp vấn đề. Dùng lại `listReasonShipments` với NGUYÊN bộ lọc,
 * nên tập ca ở đây đúng bằng tập ca của bảng lý do phía trên — không có đường nào để lệch.
 */
async function problemByProduct(loc: {
  period: Period;
  basis: TimeBasis;
  codes?: string[];
  variantKeys?: string[];
  marketerIds?: string[];
}): Promise<Map<string, { byProblem: Map<ProblemClass, number>; top: { reason: ReturnReason; count: number }[]; lostRevenue: number }>> {
  const { listReasonShipments } = await import("@/lib/queries/return-reason-report");
  const rows = await listReasonShipments({ ...loc, limit: 500 });
  const out = new Map<string, { byProblem: Map<ProblemClass, number>; top: { reason: ReturnReason; count: number }[]; lostRevenue: number; reasons: Map<ReturnReason, number> }>();
  for (const r of rows) {
    // Đơn nhiều mã: tính cho MỌI mã (cả hai đều bị ảnh hưởng) — cùng luật với bảng lý do theo mã.
    const codes = r.productCodes ? r.productCodes.split(", ").filter(Boolean) : [];
    for (const code of codes) {
      const cur = out.get(code) ?? { byProblem: new Map(), top: [], lostRevenue: 0, reasons: new Map() };
      const lop = PROBLEM_OF_REASON[r.reason];
      cur.byProblem.set(lop, (cur.byProblem.get(lop) ?? 0) + 1);
      if (r.reason !== "UNKNOWN") cur.reasons.set(r.reason, (cur.reasons.get(r.reason) ?? 0) + 1);
      out.set(code, cur);
    }
  }
  const ket = new Map<string, { byProblem: Map<ProblemClass, number>; top: { reason: ReturnReason; count: number }[]; lostRevenue: number }>();
  for (const [code, v] of out) {
    const top = [...v.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => ({ reason, count }));
    ket.set(code, { byProblem: v.byProblem, top, lostRevenue: v.lostRevenue });
  }
  return ket;
}

/* ═══════════════════ CHĂM SÓC KIỆN ═══════════════════ */

async function careRows(period: Period, basis: TimeBasis, value: OrderValueFilter = NO_ORDER_VALUE_FILTER): Promise<ReturnIntelligence["care"]> {
  const db = await getDb();
  const dk: SQL[] = [REPORTABLE_ORDER];
  const locGiaTri = orderValueWhereSql(value);
  if (locGiaTri) dk.push(sql.raw(locGiaTri));
  const moc = sql.raw(timeBasisColumnSql(basis));
  if (period.from) dk.push(sql`${moc} >= ${period.from}`);
  if (period.to) dk.push(sql`${moc} <= ${period.to}`);
  if ((period.from || period.to) && basis !== "ORDERED") dk.push(sql`${moc} is not null`);

  // TẮT JIT: bảng dẫn xuất tính ORDER_OUTCOME_FAST cho mọi đơn của kỳ — cùng họ câu SQL thô với `baseRows` (return-reason-report.ts) đã đo JIT bật 4.034 ms ↔ tắt 183 ms.
  const rows = rowsOf<{
    state: string | null;
    owner_email: string | null;
    has_owner: boolean;
    has_action: boolean;
    hours_to_action: string | number | null;
    outcome: string;
    opened_at: unknown;
  }>(
    await chayKhongJit(db, (tx) => tx.execute(sql`
      select c.entry_carrier_state as state,
             nullif(c.owner_email, '') as owner_email,
             (c.owner_id is not null) as has_owner,
             (c.first_action_at is not null) as has_action,
             extract(epoch from (c.first_action_at - coalesce(c.opened_at, c.created_at))) / 3600 as hours_to_action,
             b.outcome,
             coalesce(c.opened_at, c.created_at) as opened_at
        from shipment_care c
        join (
          select "shipments"."id" as shipment_id, ${ORDER_OUTCOME_FAST} as outcome
            from "orders"
            join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
           where ${sql.join(dk, sql` and `)}
          offset 0
        ) b on b.shipment_id = c.shipment_id
    `)),
  );

  const theoTrangThai = new Map<string, { cases: number; withOwner: number; withAction: number; hours: number[]; delivered: number; failed: number; pending: number }>();
  const theoNguoi = new Map<string, { cases: number; delivered: number; failed: number; pending: number }>();
  let since: Date | null = null;

  for (const r of rows) {
    const state = r.state ?? "UNKNOWN";
    const cur = theoTrangThai.get(state) ?? { cases: 0, withOwner: 0, withAction: 0, hours: [], delivered: 0, failed: 0, pending: 0 };
    cur.cases += 1;
    if (r.has_owner) cur.withOwner += 1;
    if (r.has_action) cur.withAction += 1;
    const gio = r.hours_to_action === null || r.hours_to_action === undefined ? null : Number(r.hours_to_action);
    if (gio !== null && Number.isFinite(gio) && gio >= 0) cur.hours.push(gio);
    if (r.outcome === "DELIVERED") cur.delivered += 1;
    else if (r.outcome === "RETURNED" || r.outcome === "RETURNED_BY_RULE") cur.failed += 1;
    else cur.pending += 1;
    theoTrangThai.set(state, cur);

    /*
      CHỈ CA ĐÃ NGÃ NGŨ MỚI ĐƯỢC DÙNG ĐỂ CHẤM NGƯỜI (chủ shop chốt). Ca còn treo vẫn được đếm ở cột
      riêng để người quản lý biết khối lượng, nhưng nó KHÔNG vào tử/mẫu của tỷ lệ cứu.
    */
    if (r.owner_email) {
      const p = theoNguoi.get(r.owner_email) ?? { cases: 0, delivered: 0, failed: 0, pending: 0 };
      p.cases += 1;
      if (r.outcome === "DELIVERED") p.delivered += 1;
      else if (r.outcome === "RETURNED" || r.outcome === "RETURNED_BY_RULE") p.failed += 1;
      else p.pending += 1;
      theoNguoi.set(r.owner_email, p);
    }
    const at = r.opened_at ? new Date(r.opened_at as string) : null;
    if (at && !Number.isNaN(at.getTime()) && (!since || at < since)) since = at;
  }

  /*
    NGƯỠNG MẪU, KHÔNG PHẢI "CÓ DÒNG NÀO LÀ IN".

    Bản trước trả về một con số cho MỌI mảng khác rỗng — kể cả một dòng. Cùng lỗi với ô "thời gian
    phản hồi" ở thẻ điểm người: `first_action_at` chỉ có ở 2/319 đợt (đo 16/09/2026), nên "giờ tới
    hành động đầu" ở đây cũng đang dựng trên một hai quan sát. Ngưỡng dùng chung ở
    `lib/constants/care-timing.ts` để hai màn hình không nói hai ngưỡng khác nhau.
  */
  const trungVi = (xs: number[]): number | null => {
    const m = timingStat(xs, xs.length).median;
    return m === null ? null : Math.round(m * 10) / 10;
  };

  const byState: CareStateRow[] = [...theoTrangThai]
    .map(([state, v]) => {
      const ketThuc = v.delivered + v.failed;
      return {
        state,
        label: CARRIER_SUBSTATE_LABEL[state as CarrierSubstate] ?? state,
        cases: v.cases,
        withOwner: v.withOwner,
        withAction: v.withAction,
        hoursToFirstActionP50: trungVi(v.hours),
        delivered: v.delivered,
        failed: v.failed,
        pending: v.pending,
        rescueRate: ketThuc ? Math.round((v.delivered / ketThuc) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.cases - a.cases);

  const byPic: CarePicRow[] = [...theoNguoi]
    .map(([ownerEmail, v]) => {
      const ketThuc = v.delivered + v.failed;
      return {
        ownerEmail,
        cases: v.cases,
        delivered: v.delivered,
        failed: v.failed,
        pending: v.pending,
        rescueRate: ketThuc ? Math.round((v.delivered / ketThuc) * 1000) / 10 : null,
        // Dưới ngưỡng ⇒ hiện thực tế, KHÔNG xếp hạng (AGENTS.md mục 39 và 44).
        comparable: ketThuc >= ALERT_MIN_SAMPLE.minReasonCases * 2,
      };
    })
    .sort((a, b) => b.cases - a.cases);

  return { byState, byPic, totalCases: rows.length, since };
}

/* ═══════════════════ XU HƯỚNG ═══════════════════ */

async function trendPoints(period: Period, basis: TimeBasis, grain: TrendGrain, value: OrderValueFilter = NO_ORDER_VALUE_FILTER): Promise<TrendPoint[]> {
  const db = await getDb();
  const lookup = await getProbabilityLookup();
  const moc = sql.raw(timeBasisColumnSql(basis));
  const con = carrierSubstateSql(sql`"shipments"."vtp_status"`, sql`"shipments"."vtp_status_name"`, sql`"shipments"."stage"::text`);
  const dk: SQL[] = [REPORTABLE_ORDER];
  const locGiaTri = orderValueWhereSql(value);
  if (locGiaTri) dk.push(sql.raw(locGiaTri));
  if (period.from) dk.push(sql`${moc} >= ${period.from}`);
  if (period.to) dk.push(sql`${moc} <= ${period.to}`);
  dk.push(sql`${moc} is not null`);

  // TẮT JIT: ORDER_OUTCOME_FAST + mốc bàn giao (truy vấn con tương quan) cho mọi đơn của kỳ — cùng họ câu với `baseRows` đã đo 95 % là JIT biên dịch.
  const rows = rowsOf<{ bucket: unknown; outcome: string; con: string; age_hours: string | number | null; n: string | number }>(
    await chayKhongJit(db, (tx) => tx.execute(sql`
      select date_trunc(${grain === "WEEK" ? "week" : "day"}, b.moc) as bucket, b.outcome, b.con,
             /* Tuổi gom về rổ ngay ở SQL: rổ mới là thứ mô hình dùng, không phải từng giờ lẻ. */
             round(b.age_hours) as age_hours,
             count(*)::int as n
        from (
          select ${moc} as moc,
                 ${ORDER_OUTCOME_FAST} as outcome,
                 ${con} as con,
                 extract(epoch from (now() - ${sql.raw(CARRIER_HANDOFF_AT_SQL)})) / 3600 as age_hours
            from "orders"
            left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
           where ${sql.join(dk, sql` and `)}
          offset 0
        ) b
       group by 1, 2, 3, 4
       order by 1
    `)),
  );

  const theoRo = new Map<string, { eligibleSent: number; delivered: number; failed: number; active: number; projected: number; unmodelled: number }>();
  for (const r of rows) {
    const at = r.bucket ? new Date(r.bucket as string).toISOString().slice(0, 10) : "";
    if (!at) continue;
    const cur = theoRo.get(at) ?? { eligibleSent: 0, delivered: 0, failed: 0, active: 0, projected: 0, unmodelled: 0 };
    const n = Number(r.n);
    if (r.outcome === "DELIVERED") {
      cur.eligibleSent += n;
      cur.delivered += n;
      cur.projected += n;
    } else if (r.outcome === "RETURNED" || r.outcome === "RETURNED_BY_RULE") {
      cur.eligibleSent += n;
      cur.failed += n;
    } else if (r.outcome === "IN_TRANSIT") {
      cur.eligibleSent += n;
      cur.active += n;
      const tuoi = r.age_hours === null || r.age_hours === undefined ? null : Number(r.age_hours);
      const tra = isModelledSubstate(r.con) ? lookup.of(r.con, { ageHours: tuoi }) : null;
      if (!tra || tra.p === null) cur.unmodelled += n;
      else cur.projected += n * tra.p;
    }
    theoRo.set(at, cur);
  }

  return [...theoRo]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([at, v]) => {
      const ketThuc = v.delivered + v.failed;
      const mauDuBao = v.eligibleSent - v.unmodelled;
      return {
        at,
        eligibleSent: v.eligibleSent,
        delivered: v.delivered,
        failed: v.failed,
        active: v.active,
        actualRate: ketThuc ? Math.round((v.delivered / ketThuc) * 1000) / 10 : null,
        returnRate: ketThuc ? Math.round((v.failed / ketThuc) * 1000) / 10 : null,
        projectedRate: mauDuBao > 0 ? Math.round((v.projected / mauDuBao) * 1000) / 10 : null,
      };
    });
}

/* ═══════════════════ SO KỲ ═══════════════════ */

function soKy(
  hienTai: ReturnReasonReport,
  kyTruoc: ReturnReasonReport | null,
  projectedRate: number | null,
  input: IntelligenceInput,
): ReturnIntelligence["compare"] {
  const cur = {
    finished: hienTai.finished,
    delivered: hienTai.delivered,
    returned: hienTai.returned,
    successRate: hienTai.successRate,
    returnRate: hienTai.returnRate,
    projectedRate,
  };
  const prev = {
    finished: kyTruoc?.finished ?? 0,
    delivered: kyTruoc?.delivered ?? 0,
    returned: kyTruoc?.returned ?? 0,
    successRate: kyTruoc?.successRate ?? null,
    returnRate: kyTruoc?.returnRate ?? null,
    projectedRate: null as number | null,
  };
  /*
    ═══ KHÔNG SO MỘT LÔ CHƯA CHÍN MÀ KHÔNG NÓI RA ═══

    Kỳ vừa rồi còn nhiều kiện đang đi thì tỷ lệ GTC "thực tế" của nó đứng trên một mẫu nhỏ và
    thiên về những kiện xong nhanh — tức thiên về đơn giao được. So thẳng với một kỳ đã ngã ngũ
    gần hết sẽ ra một mũi tên đi lên không có thật.
  */
  const immature = cur.finished > 0 && kyTruoc !== null && prev.finished > 0 && cur.finished < prev.finished * 0.6;
  return {
    label: input.previous ? `${input.period.label} so với kỳ trước cùng độ dài` : "Chưa có kỳ trước để so",
    current: cur,
    previous: prev,
    successDelta: cur.successRate !== null && prev.successRate !== null ? Math.round((cur.successRate - prev.successRate) * 10) / 10 : null,
    // Tỷ lệ hoàn CÀNG THẤP CÀNG TỐT: dấu đảo lại để "dương = tốt lên" đúng với mọi ô.
    returnDelta: cur.returnRate !== null && prev.returnRate !== null ? Math.round((prev.returnRate - cur.returnRate) * 10) / 10 : null,
    immature,
    immatureNote: immature
      ? `Kỳ này mới có ${cur.finished} đơn đi tới kết quả cuối, kỳ trước có ${prev.finished}. Lô hàng gần đây còn đang đi, nên phần đã ngã ngũ thiên về đơn xong nhanh — so hai kỳ lúc này dễ ra một mũi tên không có thật.`
      : null,
  };
}

/* ═══════════════════ KHỐI "CẦN CHÚ Ý" ═══════════════════ */

function dungHanhDong(x: {
  products: ProductRiskRow[];
  marketers: MarketerQualityRow[];
  care: ReturnIntelligence["care"];
  coverage: ReturnIntelligence["coverage"];
  hienTai: ReturnReasonReport;
  hasTarget: boolean;
  basis: TimeBasis;
  period: Period;
}): ReturnAction[] {
  const out: ReturnAction[] = [];
  const q = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ period: x.period.key, basis: x.basis, ...extra });
    return `/reports/returns?${p.toString()}`;
  };

  /* ─── 1. Mã hàng: xấu đi so kỳ trước, hoặc đang ở mức rủi ro cao ─── */
  for (const p of x.products) {
    if (p.finished < ALERT_MIN_SAMPLE.minFinished) continue;
    const xauDi = p.returnRateDelta !== null && p.returnRateDelta >= ALERT_MIN_SAMPLE.minTrendPoints;
    if (!xauDi && p.risk !== "HIGH_RISK") continue;
    const lop = p.dominantProblem?.problem ?? "DATA_GAP";
    out.push({
      key: `product:${p.code}`,
      severity: p.risk === "HIGH_RISK" ? "HIGH" : "MEDIUM",
      problem: lop,
      department: PROBLEM_DEPARTMENT[lop],
      title: `${p.code} — ${PROBLEM_LABEL[lop]}`,
      evidence: [
        `hoàn ${p.returnRate === null ? "—" : `${p.returnRate.toFixed(1)}%`} trên ${p.finished} đơn đã kết thúc`,
        xauDi ? `tăng ${p.returnRateDelta!.toFixed(1)} điểm so kỳ trước (${p.prevReturnRate!.toFixed(1)}%)` : null,
        p.topReasons[0] ? `lý do nhiều nhất: ${p.topReasons[0].label} (${p.topReasons[0].count} đơn)` : null,
        p.dominantProblem ? `${p.dominantProblem.share.toFixed(0)}% ca hoàn đã biết lý do thuộc nhóm ${PROBLEM_LABEL[p.dominantProblem.problem].toLowerCase()}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      action: PROBLEM_ACTION[lop],
      productCode: p.code,
      href: q({ product: p.code }),
      sample: p.finished,
    });
  }

  /* ─── 2. Marketer: hoàn cao hơn mặt bằng, đủ mẫu mới nêu tên ─── */
  for (const m of x.marketers) {
    if (!m.comparable || m.gapPoints === null) continue;
    if (m.gapPoints < ALERT_MIN_SAMPLE.minGapPoints) continue;
    if (m.marketerId === null) continue; // "Chưa xác định" không phải một người để nhắc tên
    out.push({
      key: `marketer:${m.marketerId}`,
      severity: "MEDIUM",
      problem: "SALES_CONSULTING",
      department: "MARKETING",
      title: `Đơn từ ${m.label} hoàn cao hơn mặt bằng`,
      evidence: `hoàn ${m.returnRate?.toFixed(1)}% trên ${m.finished} đơn đã kết thúc · cao hơn toàn shop ${m.gapPoints.toFixed(1)} điểm${m.topReason ? ` · lý do nhiều nhất: ${m.topReason.label}` : ""}`,
      action: "Xem lại nội dung và tệp khách của các chiến dịch người này đang chạy: rẻ mà hoàn nhiều thì chi phí thật trên MỘT ĐƠN GIAO ĐƯỢC cao hơn nhìn qua CPQC.",
      productCode: null,
      href: q({ marketer: m.marketerId }),
      sample: m.finished,
    });
  }

  /* ─── 3. Chăm sóc kiện: ca không có người cầm ─── */
  const khongNguoi = x.care.byState.reduce((n, s) => n + (s.cases - s.withOwner), 0);
  if (khongNguoi >= ALERT_MIN_SAMPLE.minReasonCases) {
    out.push({
      key: "care:unowned",
      severity: khongNguoi >= 50 ? "HIGH" : "MEDIUM",
      problem: "LOGISTICS",
      department: "LOGISTICS",
      title: `${khongNguoi} ca chăm sóc kiện chưa có người cầm`,
      evidence: `trên tổng ${x.care.totalCases} ca trong kỳ · ca không ai cầm thì không ai gọi cho khách, và kiện đi thẳng tới hoàn`,
      action: "Giao người cho các ca đang mở ở hàng đợi Chăm sóc kiện. Chỉ ca đã ngã ngũ mới dùng để chấm người.",
      productCode: null,
      href: "/shipments/care",
      sample: x.care.totalCases,
    });
  }

  /* ─── 4. Độ phủ dữ liệu: chỗ trống là việc phải làm, không phải một con số buồn ─── */
  if (x.coverage.reason.pct !== null && x.coverage.reason.pct < 50 && x.coverage.reason.total >= ALERT_MIN_SAMPLE.minFinished) {
    out.push({
      key: "coverage:reason",
      severity: "MEDIUM",
      problem: "DATA_GAP",
      department: PROBLEM_DEPARTMENT.DATA_GAP,
      title: `Chỉ ${x.coverage.reason.pct.toFixed(0)}% đơn hoàn có lý do`,
      evidence: `${x.coverage.reason.known}/${x.coverage.reason.total} đơn hoàn xác định được lý do · phần còn lại không có mã lý do và không có sự kiện nào nêu lý do`,
      action: PROBLEM_ACTION.DATA_GAP,
      productCode: null,
      href: "/shipments?final=returned",
      sample: x.coverage.reason.total,
    });
  }
  if (x.coverage.marketer.pct !== null && x.coverage.marketer.pct < MARKETER_COVERAGE_WARN_PCT && x.coverage.marketer.total >= ALERT_MIN_SAMPLE.minMarketerFinished) {
    out.push({
      key: "coverage:marketer",
      severity: "INFO",
      problem: "DATA_GAP",
      department: "MARKETING",
      title: `Quy kết được marketer cho ${x.coverage.marketer.pct.toFixed(0)}% đơn`,
      evidence: `${x.coverage.marketer.known}/${x.coverage.marketer.total} đơn nối được về một chiến dịch có người phụ trách`,
      action: "Chạy đồng bộ chỉ mục quảng cáo Facebook và khai người phụ trách cho các chiến dịch còn trống ở Quảng cáo → Ghép chiến dịch.",
      productCode: null,
      href: "/ads",
      sample: x.coverage.marketer.total,
    });
  }

  /* ─── 5. Chưa đặt đích thì nói thẳng, đừng im lặng không chấm ─── */
  if (!x.hasTarget) {
    out.push({
      key: "target:missing",
      severity: "INFO",
      problem: "DATA_GAP",
      department: "MANAGEMENT",
      title: "Chưa đặt mục tiêu cho Tỷ lệ giao thành công",
      evidence: "Không có đích thì không màn hình nào được kết luận mã hàng nào đạt hay không đạt — bảng chỉ hiện thực tế.",
      action: `Đặt đích ở Mục tiêu → Đích chỉ số (${DEPARTMENT_LABEL.MANAGEMENT}), kèm ngưỡng cảnh báo và ngưỡng nghiêm trọng.`,
      productCode: null,
      href: "/work/settings#muc-tieu-chi-so",
      sample: 0,
    });
  }

  const uuTien = { HIGH: 0, MEDIUM: 1, INFO: 2 } as const;
  return out.sort((a, b) => uuTien[a.severity] - uuTien[b.severity] || b.sample - a.sample).slice(0, ACTION_LIST_MAX);
}

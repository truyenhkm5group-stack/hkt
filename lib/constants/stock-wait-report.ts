import { PANCAKE_ORDER_STATUS } from "@/lib/constants/pancake";
import { MIEN, MIEN_LABEL, VUNG, VUNG_LABEL, provinceRegion, type Mien, type Vung } from "@/lib/constants/vn-regions";
import { addDays, formatNumber, formatVND, vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";

/**
 * ═══════════ CHỜ HÀNG, VÙNG MIỀN VÀ TỶ LỆ GIAO THÀNH CÔNG ═══════════
 *
 * Chủ shop yêu cầu (25/09/2026): *"báo cáo và thống kê số đơn thiếu hàng theo ngày để biết bao nhiêu
 * đơn, những đơn nào thiếu hàng chưa gửi trong bao nhiêu ngày, và tỷ lệ GTC theo số ngày chờ hàng
 * của khách, tỷ lệ GTC theo vùng, miền — để nhìn được ảnh hưởng của số ngày chờ và vùng miền tới GTC
 * và đề xuất phương án tối ưu vận hành"*.
 *
 * ─── SỐ NGÀY CHỜ ĐO BẰNG HAI MỐC CÓ CHỨNG TỪ ───
 *
 *   ngày chờ = `carrier_handoff_at` − `orders.inserted_at`
 *
 * Mốc đầu là lúc khách chốt mua (đơn lên Pancake); mốc sau là lúc ĐVVC THẬT SỰ cầm hàng — đúng hợp
 * đồng `lib/constants/carrier-handoff.ts` (AGENTS.md mục 41), không phải lúc tạo vận đơn. Đó chính là
 * khoảng khách phải đợi trước khi hàng lên đường, bất kể vì thiếu hàng hay vì kho chậm.
 *
 * Đơn CHƯA có mốc bàn giao không có số ngày chờ đo được: đơn huỷ trước khi gửi xếp theo MỐC HUỶ
 * (lịch sử trạng thái Pancake) và chỉ đếm ở cột "huỷ trước khi gửi"; đơn còn trong kho đứng ở nhóm
 * `OPEN` — ĐẾM và IN RA, không xếp vào một khoảng ngày nào (chưa gửi thì chưa biết nó sẽ chờ bao lâu).
 *
 * ─── "THIẾU HÀNG" CÓ HAI NGUỒN, KHÔNG GỘP ───
 *
 *   · `ERP_LOG`         — sổ `stock_wait_log`: phép phân bổ tồn thực tế (`allocateStock`) đã kết luận
 *                         đơn này CHỜ HÀNG ít nhất một lần. Sổ chỉ có từ ngày nó được bật: ngày trước
 *                         đó là CHƯA ĐO, không phải 0 đơn.
 *   · `PANCAKE_WAITING` — nhân viên đặt đơn vào trạng thái Pancake nhóm "Chờ hàng" (suy từ
 *                         `PANCAKE_ORDER_STATUS`, không gõ tay mã số). Có lịch sử, nhưng là NHÃN
 *                         NGƯỜI GÕ, không phải phép đo tồn.
 *
 * ─── TƯƠNG QUAN, KHÔNG PHẢI NHÂN QUẢ ───
 *
 * Đơn chờ lâu thường là mẫu hot hết hàng, và vùng xa thường vừa giao chậm vừa hay hoàn. Nên bảng
 * chéo CHỜ × MIỀN đứng cạnh hai bảng đơn: nếu GTC tụt theo ngày chờ TRONG CÙNG một miền thì đó
 * không phải hiệu ứng vùng đội lốt. Các đề xuất dùng kiểm định hai tỷ lệ (z ≥ 1,96) để không gọi
 * một chênh lệch ngẫu nhiên là "điểm gãy".
 */

/* ═══════════════════ KHOẢNG NGÀY CHỜ ═══════════════════ */

export const WAIT_BUCKETS = [
  { key: "D0", label: "Dưới 1 ngày", minDays: 0, maxDays: 1 },
  { key: "D1", label: "1–2 ngày", minDays: 1, maxDays: 2 },
  { key: "D2", label: "2–3 ngày", minDays: 2, maxDays: 3 },
  { key: "D3_5", label: "3–5 ngày", minDays: 3, maxDays: 5 },
  { key: "D5_7", label: "5–7 ngày", minDays: 5, maxDays: 7 },
  { key: "D7_14", label: "7–14 ngày", minDays: 7, maxDays: 14 },
  { key: "D14", label: "Từ 14 ngày", minDays: 14, maxDays: null },
] as const;

export type WaitBucketKey = (typeof WAIT_BUCKETS)[number]["key"];
/** `OPEN` = chưa gửi, chưa huỷ (chưa đo được). `?` = mốc ngược / thiếu mốc huỷ — đếm riêng. */
export type WaitCellKey = WaitBucketKey | "OPEN" | "?";

export function waitBucketOf(days: number): WaitBucketKey | "?" {
  if (!Number.isFinite(days) || days < 0) return "?";
  for (const b of WAIT_BUCKETS) if (days >= b.minDays && (b.maxDays === null || days < b.maxDays)) return b.key;
  return "?";
}

/** Biểu thức SQL xếp khoảng — SINH RA từ `WAIT_BUCKETS`, không gõ lại lần thứ hai. `daysExpr` là số ngày (có thể NULL). */
export function waitBucketCaseSql(daysExpr: string): string {
  const arms = WAIT_BUCKETS.map((b) => `when ${daysExpr} >= ${b.minDays}${b.maxDays === null ? "" : ` and ${daysExpr} < ${b.maxDays}`} then '${b.key}'`);
  return `case when ${daysExpr} is null or ${daysExpr} < 0 then '?' ${arms.join(" ")} else '?' end`;
}

/* ═══════════════════ NGUỒN "THIẾU HÀNG" ═══════════════════ */

export type WaitSegment = "ERP_LOG" | "PANCAKE_WAITING" | "NONE";

export const WAIT_SEGMENT_LABEL: Record<WaitSegment, string> = {
  ERP_LOG: "ERP ghi nhận chờ hàng",
  PANCAKE_WAITING: "Pancake ghi “Chờ hàng”",
  NONE: "Không ghi nhận thiếu hàng",
};

/** Mã trạng thái Pancake thuộc nhóm "Chờ hàng" — suy từ bảng gốc. */
export const PANCAKE_WAITING_CODES: number[] = Object.entries(PANCAKE_ORDER_STATUS)
  .filter(([, v]) => v.stage === "WAITING")
  .map(([k]) => Number(k));

/** Mã trạng thái Pancake nghĩa là đơn đã huỷ / xoá — mốc huỷ lấy từ lần đầu đơn vào nhóm này. */
export const PANCAKE_CANCEL_CODES: number[] = Object.entries(PANCAKE_ORDER_STATUS)
  .filter(([, v]) => v.stage === "CANCELLED" || v.stage === "DELETED")
  .map(([k]) => Number(k));

/* ═══════════════════ Ô SỐ LIỆU ═══════════════════ */

/** Một nhóm (tỉnh × khoảng chờ × nguồn) do SQL gom sẵn. */
export type WaitCell = {
  province: string;
  bucket: WaitCellKey;
  segment: WaitSegment;
  orders: number;
  delivered: number;
  returned: number;
  inTransit: number;
  /** Huỷ khi hàng chưa rời kho — không vào GTC, đếm riêng. */
  cancelledBeforeShip: number;
  deliveredValue: number;
  returnedValue: number;
};

export type RateRow = {
  key: string;
  label: string;
  orders: number;
  delivered: number;
  returned: number;
  /** Đã kết thúc = giao TC + hoàn: mẫu số của GTC, luôn in cạnh tỷ lệ. */
  finished: number;
  inTransit: number;
  cancelledBeforeShip: number;
  /** `null` khi `finished` dưới ngưỡng mẫu — CHƯA ĐỦ DỮ LIỆU, không phải 0%. */
  successRate: number | null;
  deliveredValue: number;
  returnedValue: number;
};

function emptyRow(key: string, label: string): RateRow {
  return { key, label, orders: 0, delivered: 0, returned: 0, finished: 0, inTransit: 0, cancelledBeforeShip: 0, successRate: null, deliveredValue: 0, returnedValue: 0 };
}

function addCell(r: RateRow, c: WaitCell) {
  r.orders += c.orders;
  r.delivered += c.delivered;
  r.returned += c.returned;
  r.inTransit += c.inTransit;
  r.cancelledBeforeShip += c.cancelledBeforeShip;
  r.deliveredValue += c.deliveredValue;
  r.returnedValue += c.returnedValue;
}

function finish(r: RateRow, minSample: number): RateRow {
  r.finished = r.delivered + r.returned;
  r.successRate = r.finished >= minSample ? (r.delivered / r.finished) * 100 : null;
  return r;
}

function rollup(cells: WaitCell[], keys: { key: string; label: string }[], keyOf: (c: WaitCell) => string | null, minSample: number): RateRow[] {
  const map = new Map(keys.map((k) => [k.key, emptyRow(k.key, k.label)]));
  for (const c of cells) {
    const k = keyOf(c);
    if (k === null) continue;
    const r = map.get(k);
    if (r) addCell(r, c);
  }
  return [...map.values()].map((r) => finish(r, minSample));
}

export type WaitReport = {
  /** Chỉ đơn ĐÃ bàn giao hoặc huỷ trước khi gửi có mốc — theo khoảng ngày chờ. */
  byWait: RateRow[];
  byMien: RateRow[];
  byVung: RateRow[];
  /** Theo đúng chữ tỉnh gộp theo khoá chuẩn, nhiều đơn nhất trước. */
  byProvince: (RateRow & { mien: Mien | null; approxRegion: boolean })[];
  /** Bảng chéo: mỗi miền một hàng, mỗi khoảng chờ một ô. */
  matrix: { mien: Mien; label: string; cells: RateRow[] }[];
  bySegment: RateRow[];
  overall: RateRow;
  /** Đơn chưa gửi, chưa huỷ — nằm ngoài mọi khoảng chờ. */
  openOrders: number;
  /** Mốc ngược (bàn giao trước lúc lên đơn) hoặc huỷ mà không có mốc huỷ — đếm, không giấu. */
  anomalyOrders: number;
  /** Đơn không quy được về vùng (tỉnh trống / chữ lạ). */
  unknownRegion: { orders: number; finished: number; samples: string[] };
  /** Đơn ở tỉnh mới 2025 trải qua hai vùng — vùng gần đúng, miền vẫn đúng. */
  approxRegionOrders: number;
  minSample: number;
};

const BUCKET_KEYS = WAIT_BUCKETS.map((b) => ({ key: b.key as string, label: b.label as string }));

/** Gộp các ô SQL thành mọi bảng của báo cáo. Hàm THUẦN. */
export function buildWaitReport(cells: WaitCell[], minSample: number): WaitReport {
  const timed = (c: WaitCell) => c.bucket !== "OPEN" && c.bucket !== "?";
  const regionOf = (c: WaitCell) => provinceRegion(c.province);

  const byWait = rollup(cells, BUCKET_KEYS, (c) => (timed(c) ? c.bucket : null), minSample);
  const byMien = rollup(cells, MIEN.map((m) => ({ key: m, label: MIEN_LABEL[m] })), (c) => regionOf(c)?.mien ?? null, minSample);
  const byVung = rollup(cells, VUNG.map((v) => ({ key: v, label: VUNG_LABEL[v] })), (c) => regionOf(c)?.vung ?? null, minSample);
  const bySegment = rollup(
    cells,
    (Object.keys(WAIT_SEGMENT_LABEL) as WaitSegment[]).map((k) => ({ key: k, label: WAIT_SEGMENT_LABEL[k] })),
    (c) => c.segment,
    minSample,
  );
  const overall = finish(cells.reduce((r, c) => (addCell(r, c), r), emptyRow("ALL", "Tất cả")), minSample);

  const matrix = MIEN.map((m) => ({
    mien: m,
    label: MIEN_LABEL[m],
    cells: rollup(cells, BUCKET_KEYS, (c) => (timed(c) && regionOf(c)?.mien === m ? c.bucket : null), minSample),
  }));

  // Theo tỉnh: gộp nhiều cách viết về khoá chuẩn; chữ không nhận ra giữ nguyên chữ gốc.
  const prov = new Map<string, RateRow & { mien: Mien | null; approxRegion: boolean }>();
  const unknownSamples = new Map<string, number>();
  let unknownOrders = 0;
  let unknownFinished = 0;
  let approxRegionOrders = 0;
  for (const c of cells) {
    const reg = regionOf(c);
    const key = reg ? reg.key : `?:${c.province.trim()}`;
    const row = prov.get(key) ?? { ...emptyRow(key, c.province.trim() || "(trống)"), mien: reg?.mien ?? null, approxRegion: reg?.approxRegion ?? false };
    addCell(row, c);
    prov.set(key, row);
    if (!reg) {
      unknownOrders += c.orders;
      unknownFinished += c.delivered + c.returned;
      unknownSamples.set(c.province.trim() || "(trống)", (unknownSamples.get(c.province.trim() || "(trống)") ?? 0) + c.orders);
    } else if (reg.approxRegion) approxRegionOrders += c.orders;
  }
  const byProvince = [...prov.values()].map((r) => Object.assign(finish(r, minSample), { mien: r.mien, approxRegion: r.approxRegion })).sort((a, b) => b.orders - a.orders || a.label.localeCompare(b.label, "vi"));

  return {
    byWait,
    byMien,
    byVung,
    byProvince,
    matrix,
    bySegment,
    overall,
    openOrders: cells.filter((c) => c.bucket === "OPEN").reduce((t, c) => t + c.orders, 0),
    anomalyOrders: cells.filter((c) => c.bucket === "?").reduce((t, c) => t + c.orders, 0),
    unknownRegion: {
      orders: unknownOrders,
      finished: unknownFinished,
      samples: [...unknownSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k),
    },
    approxRegionOrders,
    minSample,
  };
}

/* ═══════════════════ KIỂM ĐỊNH ═══════════════════ */

/** Ngưỡng z hai phía ở mức tin cậy 95% — quy ước thống kê, không phải ngưỡng nghiệp vụ. */
export const Z_95 = 1.96;

/**
 * Kiểm định hai tỷ lệ (gộp phương sai). Trả z > 0 khi nhóm 1 CAO hơn nhóm 2. `null` khi một nhóm
 * rỗng hoặc tỷ lệ gộp bằng 0 / 100% (không có phương sai để so).
 */
export function twoProportionZ(success1: number, n1: number, success2: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p = (success1 + success2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  return (success1 / n1 - success2 / n2) / se;
}

export type WaitBreakpoint = {
  /** Khoảng chờ đầu tiên của phía "chờ lâu". */
  bucket: WaitBucketKey;
  /** Số ngày tại ranh giới: đơn chờ từ ngần này ngày trở lên. */
  fromDays: number;
  beforeRate: number;
  afterRate: number;
  beforeFinished: number;
  afterFinished: number;
  z: number;
};

/**
 * ĐIỂM GÃY: ranh giới ngày chờ mà GTC của phía chờ-lâu THẤP HƠN phía chờ-ngắn một cách có ý nghĩa
 * thống kê. Thử mọi ranh giới giữa hai khoảng liền nhau, giữ ranh giới có z lớn nhất. Mỗi phía phải
 * đủ `minSample` đơn đã kết thúc. Không ranh giới nào đạt `Z_95` ⇒ `null` — "chưa thấy khác biệt",
 * không phải "không có khác biệt".
 */
export function findWaitBreakpoint(byWait: RateRow[], minSample: number): WaitBreakpoint | null {
  let best: WaitBreakpoint | null = null;
  for (let i = 1; i < WAIT_BUCKETS.length; i++) {
    const before = byWait.slice(0, i);
    const after = byWait.slice(i);
    const dB = before.reduce((t, r) => t + r.delivered, 0);
    const nB = before.reduce((t, r) => t + r.finished, 0);
    const dA = after.reduce((t, r) => t + r.delivered, 0);
    const nA = after.reduce((t, r) => t + r.finished, 0);
    if (nB < minSample || nA < minSample) continue;
    const z = twoProportionZ(dB, nB, dA, nA);
    if (z === null || z < Z_95) continue;
    if (!best || z > best.z) {
      best = { bucket: WAIT_BUCKETS[i].key, fromDays: WAIT_BUCKETS[i].minDays, beforeRate: (dB / nB) * 100, afterRate: (dA / nA) * 100, beforeFinished: nB, afterFinished: nA, z };
    }
  }
  return best;
}

/* ═══════════════════ SỐ ĐƠN CHỜ HÀNG THEO NGÀY ═══════════════════ */

export type WaitInterval = { orderId: string; start: Date; end: Date | null };

export type DailyWaitingRow = {
  day: string;
  /** Đơn ERP kết luận chờ hàng trong ngày. `null` = ngày trước khi sổ được bật — CHƯA ĐO. */
  erpWaiting: number | null;
  /** Đơn MỚI vào trạng thái chờ hàng (ERP) trong ngày. */
  erpNew: number | null;
  /** Đơn nằm ở trạng thái Pancake "Chờ hàng" trong ngày. */
  pancakeWaiting: number;
};

function overlapsDay(iv: { start: Date; end: Date | null }, day: string, now: Date): boolean {
  const s = vnStartOfDay(day).getTime();
  const e = vnEndOfDay(day).getTime();
  const end = (iv.end ?? now).getTime();
  return iv.start.getTime() <= e && end >= s;
}

/**
 * Đếm theo ngày VN. Một đơn được tính vào ngày D nếu khoảng chờ của nó CHẠM ngày D. `erpSince` là
 * mốc sổ ERP bắt đầu ghi: ngày kết thúc TRƯỚC mốc đó in `null`, không in 0. Hàm THUẦN.
 */
export function dailyWaitingSeries(days: string[], erp: WaitInterval[], pancake: WaitInterval[], erpSince: Date | null, now: Date): DailyWaitingRow[] {
  const sinceKey = erpSince ? vnDateKey(erpSince) : null;
  return days.map((day) => {
    const measured = sinceKey !== null && day >= sinceKey;
    const pancakeIds = new Set(pancake.filter((iv) => overlapsDay(iv, day, now)).map((iv) => iv.orderId));
    return {
      day,
      erpWaiting: measured ? new Set(erp.filter((iv) => overlapsDay(iv, day, now)).map((iv) => iv.orderId)).size : null,
      erpNew: measured ? new Set(erp.filter((iv) => vnDateKey(iv.start) === day).map((iv) => iv.orderId)).size : null,
      pancakeWaiting: pancakeIds.size,
    };
  });
}

/** Danh sách ngày VN từ `fromKey` tới `toKey`, tối đa `maxDays` ngày gần nhất. */
export function dayRange(fromKey: string, toKey: string, maxDays: number): string[] {
  const out: string[] = [];
  let d = toKey;
  while (d >= fromKey && out.length < maxDays) {
    out.push(d);
    d = addDays(d, -1);
  }
  return out.reverse();
}

/* ═══════════════════ ĐƠN ĐANG CHỜ ═══════════════════ */

export type CurrentWaitingOrder = {
  orderId: string;
  systemId: number | null;
  customer: string;
  value: number;
  insertedAt: Date;
  province: string;
  mien: Mien | null;
  vung: Vung | null;
  /** ERP phân bổ thiếu hàng, Pancake ghi "Chờ hàng", hoặc cả hai. */
  sources: ("ERP" | "PANCAKE")[];
  /** Mẫu thiếu (chỉ có với nguồn ERP). */
  shortText: string;
  waitDays: number;
  bucket: WaitBucketKey | "?";
  /** GTC lịch sử của nhóm (khoảng chờ × miền), rơi về khoảng chờ nếu ô chéo chưa đủ mẫu. `null` = chưa đủ dữ liệu. */
  expectedRate: number | null;
  expectedBasis: "MATRIX" | "WAIT" | null;
};

/** GTC lịch sử cho một đơn đang chờ — bảng chéo trước, rồi tới khoảng chờ. KHÔNG phải dự báo của riêng đơn đó. */
export function expectedRateFor(report: WaitReport, bucket: WaitBucketKey | "?", mien: Mien | null): { rate: number | null; basis: "MATRIX" | "WAIT" | null } {
  if (bucket === "?") return { rate: null, basis: null };
  if (mien) {
    const cell = report.matrix.find((m) => m.mien === mien)?.cells.find((c) => c.key === bucket);
    if (cell && cell.successRate !== null) return { rate: cell.successRate, basis: "MATRIX" };
  }
  const row = report.byWait.find((r) => r.key === bucket);
  return row && row.successRate !== null ? { rate: row.successRate, basis: "WAIT" } : { rate: null, basis: null };
}

/* ═══════════════════ ĐỀ XUẤT VẬN HÀNH ═══════════════════ */

export type RecommendationTone = "danger" | "warn" | "info";

export type Recommendation = {
  key: string;
  tone: RecommendationTone;
  title: string;
  /** Căn cứ bằng số — người đọc kiểm lại được trên chính trang này. */
  evidence: string;
  action: string;
  /** Có phần ước tính (nhân tỷ lệ lịch sử lên đơn đang chờ) — màn hình gắn nhãn "ước tính". */
  estimated: boolean;
};

export type RecommendationInput = {
  report: WaitReport;
  breakpoint: WaitBreakpoint | null;
  current: CurrentWaitingOrder[];
  /** Mẫu gây chờ nhiều nhất hiện tại (từ bảng thiếu hàng). */
  topShortVariants: { label: string; waitingOrders: number }[];
  /** Mốc sổ ERP bắt đầu ghi; `null` = chưa ghi lần nào. */
  erpSince: Date | null;
  /** Đơn Pancake đang ở "Chờ hàng" mà phép phân bổ ERP không nhìn thấy. */
  pancakeOnlyWaiting: number;
};

const pctText = (x: number) => `${x.toFixed(1)}%`;

/**
 * Đề xuất SINH RA TỪ SỐ của chính trang — không có câu nào đứng một mình mà không kèm căn cứ.
 * Hàm THUẦN. Mỗi đề xuất chỉ xuất hiện khi điều kiện của nó có thật trong dữ liệu; không đủ mẫu thì
 * nói "chưa đủ dữ liệu", không bịa một khuyến nghị nghe hợp lý.
 */
export function buildRecommendations(input: RecommendationInput): Recommendation[] {
  const { report, breakpoint: bp, current } = input;
  const out: Recommendation[] = [];
  const m = report.minSample;

  // 1. Ngày chờ ảnh hưởng GTC tới đâu.
  if (bp) {
    const gap = bp.beforeRate - bp.afterRate;
    const late = current.filter((o) => o.waitDays >= bp.fromDays);
    const lateValue = late.reduce((t, o) => t + o.value, 0);
    const extraReturns = Math.round((late.length * gap) / 100);
    out.push({
      key: "WAIT_BREAKPOINT",
      tone: "danger",
      title: `Khách chờ từ ${bp.fromDays} ngày trở lên thì GTC tụt ${gap.toFixed(1)} điểm`,
      evidence: `Gửi trong dưới ${bp.fromDays} ngày: GTC ${pctText(bp.beforeRate)} (${formatNumber(bp.beforeFinished)} đơn đã kết thúc) · chờ từ ${bp.fromDays} ngày: ${pctText(bp.afterRate)} (${formatNumber(bp.afterFinished)} đơn) · z = ${bp.z.toFixed(1)}.`,
      action: `Đặt mốc nội bộ: đơn phải rời kho trước ngày thứ ${bp.fromDays}. Đơn thiếu hàng dự kiến vượt mốc này thì CSKH gọi báo ngày có hàng và xin xác nhận lại TRƯỚC khi gửi, hoặc đề nghị đổi màu/size còn hàng — gửi một đơn khách đã nguội là trả cước hai chiều.`,
      estimated: false,
    });
    if (late.length) {
      out.push({
        key: "LATE_BACKLOG",
        tone: "danger",
        title: `${formatNumber(late.length)} đơn đang chờ đã qua mốc ${bp.fromDays} ngày`,
        evidence: `Giá trị khai báo ${formatVND(lateValue)}. Nếu đi ra với GTC của nhóm chờ lâu thay vì nhóm gửi sớm, dự kiến hoàn thêm khoảng ${formatNumber(extraReturns)} đơn (ước tính = số đơn × chênh lệch GTC lịch sử).`,
        action: "Gọi lại từng khách trong danh sách bên dưới (đơn lâu nhất trước): còn nhận thì hẹn ngày và ghi ngày hẹn giao trên đơn; không chờ được thì huỷ sớm để khỏi tốn cước hoàn.",
        estimated: true,
      });
    }
  } else {
    const finishedTimed = report.byWait.reduce((t, r) => t + r.finished, 0);
    out.push({
      key: "WAIT_NO_BREAKPOINT",
      tone: "info",
      title: "Chưa thấy ngày chờ làm GTC giảm một cách có ý nghĩa",
      evidence: `${formatNumber(finishedTimed)} đơn đã kết thúc có số ngày chờ đo được; không ranh giới nào cho chênh lệch đạt mức tin cậy 95% với mỗi phía từ ${m} đơn trở lên.`,
      action: "Chưa đủ căn cứ để đặt mốc ngày chờ tối đa. Mở rộng kỳ xem (90 ngày) hoặc đợi thêm đơn kết thúc rồi xem lại.",
      estimated: false,
    });
  }

  // 2. Vùng / miền GTC thấp hơn phần còn lại có ý nghĩa.
  const regionRows = [...report.byVung.map((r) => ({ r, kind: "vùng" })), ...report.byMien.map((r) => ({ r, kind: "miền" }))];
  const totalD = report.byMien.reduce((t, r) => t + r.delivered, 0);
  const totalN = report.byMien.reduce((t, r) => t + r.finished, 0);
  const weak = regionRows
    .map(({ r, kind }) => {
      const restD = totalD - r.delivered;
      const restN = totalN - r.finished;
      if (r.finished < m || restN < m || r.successRate === null) return null;
      const z = twoProportionZ(r.delivered, r.finished, restD, restN);
      return z !== null && z <= -Z_95 ? { r, kind, z, restRate: (restD / restN) * 100 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.z - b.z);
  for (const w of weak.slice(0, 2)) {
    const waitingThere = current.filter((o) => (w.kind === "miền" ? o.mien === w.r.key : o.vung === w.r.key)).length;
    out.push({
      key: `REGION_${w.r.key}`,
      tone: "warn",
      title: `${w.r.label}: GTC ${pctText(w.r.successRate as number)}, thấp hơn phần còn lại (${pctText(w.restRate)})`,
      evidence: `${formatNumber(w.r.finished)} đơn đã kết thúc ở ${w.kind} này · z = ${w.z.toFixed(1)}${waitingThere ? ` · ${formatNumber(waitingThere)} đơn đang chờ hàng ở đây` : ""}.`,
      action: `Đơn ${w.r.label.toLowerCase()}: gọi xác nhận trước khi gửi, khuyến khích chuyển khoản trước; khi thiếu hàng thì đừng để đơn vùng này chờ thêm — đường xa đã cộng sẵn ngày giao.`,
      estimated: false,
    });
  }

  // 3. Chờ lâu hại nhất ở miền nào (bảng chéo).
  if (bp) {
    const idx = WAIT_BUCKETS.findIndex((b) => b.key === bp.bucket);
    const drops = report.matrix
      .map((row) => {
        const early = row.cells.slice(0, idx);
        const late = row.cells.slice(idx);
        const dE = early.reduce((t, c) => t + c.delivered, 0);
        const nE = early.reduce((t, c) => t + c.finished, 0);
        const dL = late.reduce((t, c) => t + c.delivered, 0);
        const nL = late.reduce((t, c) => t + c.finished, 0);
        if (nE < m || nL < m) return null;
        const z = twoProportionZ(dE, nE, dL, nL);
        return z !== null && z >= Z_95 ? { row, gap: (dE / nE - dL / nL) * 100, nE, nL } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.gap - a.gap);
    if (drops.length) {
      const d = drops[0];
      out.push({
        key: "WAIT_REGION_INTERACTION",
        tone: "warn",
        title: `Chờ lâu hại nhất ở ${d.row.label.toLowerCase()}: GTC tụt ${d.gap.toFixed(1)} điểm khi chờ từ ${bp.fromDays} ngày`,
        evidence: `So trong CÙNG ${d.row.label.toLowerCase()} (${formatNumber(d.nE)} đơn gửi sớm / ${formatNumber(d.nL)} đơn chờ lâu đã kết thúc) — không phải hiệu ứng vùng đội lốt.`,
        action: `Khi một mẫu về hàng mà không đủ cho mọi đơn chờ, cân nhắc ưu tiên đơn ${d.row.label.toLowerCase()} đã chờ lâu (hiện máy phân hàng theo thứ tự lên đơn — đổi thứ tự là quyết định của chủ shop).`,
        estimated: false,
      });
    }
  }

  // 4. Nguồn cung: vài mẫu gây phần lớn đơn chờ.
  const erpWaiting = current.filter((o) => o.sources.includes("ERP")).length;
  if (input.topShortVariants.length && erpWaiting) {
    const top = input.topShortVariants.slice(0, 3);
    const share = (top.reduce((t, v) => t + v.waitingOrders, 0) / erpWaiting) * 100;
    out.push({
      key: "TOP_SHORT_VARIANTS",
      tone: "warn",
      title: `${top.length} mẫu gây ${share.toFixed(0)}% số đơn đang chờ hàng`,
      evidence: top.map((v) => `${v.label} (${formatNumber(v.waitingOrders)} đơn)`).join(" · "),
      action: "Phòng Sản xuất đặt / giục xưởng đúng mấy mẫu này trước (trang Thiếu hàng giao đơn). Marketing tạm giảm ngân sách mẫu đang thiếu để không chốt thêm đơn phải chờ.",
      estimated: false,
    });
  }

  // 5. Lỗ hổng dữ liệu phải nói ra.
  if (input.pancakeOnlyWaiting > 0) {
    out.push({
      key: "PANCAKE_WAITING_GAP",
      tone: "info",
      title: `${formatNumber(input.pancakeOnlyWaiting)} đơn Pancake ghi “Chờ hàng” nằm ngoài phép phân bổ thiếu hàng`,
      evidence: "Sổ kho chỉ giữ hàng cho đơn đã xác nhận (Đã xác nhận → Chờ chuyển hàng); đơn ở nhóm Chờ hàng của Pancake không được phân tồn nên không hiện ở trang Thiếu hàng giao đơn.",
      action: "Kho/CSKH rà các đơn này: có hàng thì chuyển sang Đã xác nhận để ERP phân hàng; thật sự thiếu thì báo phòng Sản xuất.",
      estimated: false,
    });
  }
  if (!input.erpSince) {
    out.push({
      key: "ERP_LOG_EMPTY",
      tone: "info",
      title: "Sổ đơn chờ hàng của ERP chưa ghi lần nào",
      evidence: "Số đơn thiếu hàng theo ngày chỉ có từ lần ghi đầu tiên — những ngày trước đó hiện “—” (chưa đo), không phải 0.",
      action: "Sổ tự ghi mỗi 10 phút cùng job cảnh báo. Nếu vẫn trống sau một giờ, kiểm tra job `alerts` trên trang Kết nối dữ liệu.",
      estimated: false,
    });
  }
  if (report.unknownRegion.orders > 0) {
    out.push({
      key: "UNKNOWN_REGION",
      tone: "info",
      title: `${formatNumber(report.unknownRegion.orders)} đơn chưa quy được về vùng`,
      evidence: `Chữ tỉnh không nhận ra: ${report.unknownRegion.samples.join(", ") || "(trống)"}.`,
      action: "Đơn thiếu tỉnh thì sửa địa chỉ trên Pancake; chữ tỉnh lạ thì bổ sung cách viết vào `lib/constants/vn-regions.ts`.",
      estimated: false,
    });
  }
  return out;
}

/**
 * SỔ ĐO HIỆU NĂNG TRONG TIẾN TRÌNH — để biết endpoint/báo cáo nào chậm THẬT trên máy chủ thật,
 * thay vì đoán từ máy lập trình.
 *
 * Giữ vòng đệm cố định trong RAM (không ghi đĩa, không gửi đi đâu), gom theo TÊN BÁO CÁO chứ không
 * theo khoá đầy đủ — khoá có chứa kỳ báo cáo và bộ lọc, gom theo khoá thì mỗi kỳ một dòng và không
 * còn đọc được. Không ghi dữ liệu cá nhân: chỉ tên báo cáo, thời gian, trúng/trượt đệm.
 */
const MAX_SAMPLES = 200;

export type Sample = { ms: number; hit: boolean; at: number };
export type Summary = {
  name: string;
  calls: number;
  hits: number;
  hitRate: number;
  p50: number;
  p95: number;
  max: number;
  /** Thời gian trung bình khi TRƯỢT đệm — chi phí thật của việc tính lại */
  missAvg: number;
  lastAt: number;
};

type Store = { series: Map<string, Sample[]>; startedAt: number };
const holder = globalThis as unknown as { __erpPerf?: Store };
if (!holder.__erpPerf) holder.__erpPerf = { series: new Map(), startedAt: Date.now() };
const store = holder.__erpPerf;

/** Tên báo cáo từ khoá đệm: "getDashboardData:2026-01-01..2026-02-01" → "getDashboardData" */
export function reportName(key: string) {
  const cut = key.indexOf(":");
  return cut > 0 ? key.slice(0, cut) : key;
}

export function record(name: string, ms: number, hit: boolean) {
  let list = store.series.get(name);
  if (!list) {
    list = [];
    store.series.set(name, list);
  }
  list.push({ ms, hit, at: Date.now() });
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

export function summaries(): Summary[] {
  const out: Summary[] = [];
  for (const [name, list] of store.series) {
    if (!list.length) continue;
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const misses = list.filter((s) => !s.hit);
    const hits = list.length - misses.length;
    out.push({
      name,
      calls: list.length,
      hits,
      hitRate: Math.round((hits / list.length) * 1000) / 10,
      p50: Math.round(quantile(sorted, 0.5)),
      p95: Math.round(quantile(sorted, 0.95)),
      max: Math.round(sorted[sorted.length - 1]),
      missAvg: misses.length ? Math.round(misses.reduce((t, s) => t + s.ms, 0) / misses.length) : 0,
      lastAt: list[list.length - 1].at,
    });
  }
  return out.sort((a, b) => b.p95 - a.p95);
}

export function since() {
  return store.startedAt;
}

export function resetPerf() {
  store.series.clear();
  store.startedAt = Date.now();
}

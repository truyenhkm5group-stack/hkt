/**
 * ĐO TRƯỚC, SỬA SAU — dụng cụ đo chi phí thật của một lần dựng báo cáo.
 *
 * `probe()` mở một phạm vi đo bằng AsyncLocalStorage; mọi câu truy vấn chạy bên trong phạm vi đó
 * (kể cả trong Promise.all lồng nhau) được ghi lại: câu lệnh, thời gian, số dòng trả về. Nhờ vậy
 * biết được một trang tốn BAO NHIÊU câu truy vấn chứ không chỉ tổng thời gian — con số quan trọng
 * nhất khi đi tìm N+1.
 *
 * Khi không có phạm vi đo nào đang mở, chi phí là một lần đọc AsyncLocalStorage (≈0) nên để bật
 * thường trực trong production cũng không sao.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type QuerySample = { sql: string; ms: number; rows: number };
export type ProbeStats = {
  label: string;
  ms: number;
  queries: number;
  dbMs: number;
  rows: number;
  /** Câu chậm nhất, đã gộp theo hình dạng câu lệnh */
  slowest: { sql: string; count: number; ms: number; rows: number }[];
};

type Scope = { label: string; queries: QuerySample[] };

const holder = globalThis as unknown as { __erpProbe?: AsyncLocalStorage<Scope> };
if (!holder.__erpProbe) holder.__erpProbe = new AsyncLocalStorage<Scope>();
const storage = holder.__erpProbe;

/** Có phạm vi đo đang mở không (để lớp CSDL bỏ qua việc đo khi không cần) */
export function probeActive() {
  return storage.getStore() !== undefined;
}

export function recordQuery(sql: string, ms: number, rows: number) {
  const scope = storage.getStore();
  if (scope) scope.queries.push({ sql, ms, rows });
}

/** Rút gọn câu lệnh để gộp các câu cùng hình dạng (bỏ tham số, xuống dòng, khoảng trắng thừa) */
export function shapeOf(sql: string) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\$\d+/g, "?")
    .replace(/'[^']*'/g, "'?'")
    .trim()
    .slice(0, 240);
}

function summarize(label: string, queries: QuerySample[], ms: number): ProbeStats {
  const byShape = new Map<string, { sql: string; count: number; ms: number; rows: number }>();
  for (const q of queries) {
    const shape = shapeOf(q.sql);
    const entry = byShape.get(shape) ?? { sql: shape, count: 0, ms: 0, rows: 0 };
    entry.count += 1;
    entry.ms += q.ms;
    entry.rows += q.rows;
    byShape.set(shape, entry);
  }
  return {
    label,
    ms,
    queries: queries.length,
    dbMs: Math.round(queries.reduce((t, q) => t + q.ms, 0) * 100) / 100,
    rows: queries.reduce((t, q) => t + q.rows, 0),
    slowest: [...byShape.values()].sort((a, b) => b.ms - a.ms).slice(0, 5).map((e) => ({ ...e, ms: Math.round(e.ms * 100) / 100 })),
  };
}

/** Chạy `fn` trong một phạm vi đo và trả về kết quả kèm số liệu */
export async function probe<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; stats: ProbeStats }> {
  const scope: Scope = { label, queries: [] };
  const started = performance.now();
  const value = await storage.run(scope, fn);
  return { value, stats: summarize(label, scope.queries, Math.round((performance.now() - started) * 100) / 100) };
}

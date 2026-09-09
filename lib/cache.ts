/**
 * Cache bộ nhớ trong tiến trình cho các báo cáo tính toán nặng (lợi nhuận danh nghĩa, hiệu quả marketer, kế hoạch đặt hàng…).
 * Gộp các lời gọi đồng thời cùng khoá; hết hạn theo TTL; xoá toàn bộ sau mỗi job đồng bộ / thao tác ghi để số liệu luôn mới.
 *
 * Mỗi lần gọi đều ghi vào sổ đo hiệu năng (`lib/perf/registry.ts`): thời gian và trúng/trượt đệm.
 * Đây là chỗ duy nhất mọi báo cáo nặng đi qua, nên đo ở đây là đo được tất cả mà không phải rải
 * mã đo khắp nơi. Xem kết quả ở `/api/perf` (chỉ quản trị).
 */
import { record, reportName } from "@/lib/perf/registry";

type Entry = { value: unknown; expiresAt: number };
const holder = globalThis as unknown as { __erpMemo?: { entries: Map<string, Entry>; inflight: Map<string, Promise<unknown>>; version: number } };
if (!holder.__erpMemo) holder.__erpMemo = { entries: new Map(), inflight: new Map(), version: 0 };
const store = holder.__erpMemo;

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const started = performance.now();
  const name = reportName(key);
  const hit = store.entries.get(key);
  if (hit && hit.expiresAt > now) {
    record(name, performance.now() - started, true);
    return hit.value as T;
  }
  const running = store.inflight.get(key);
  // Đang có lượt tính cho đúng khoá này → dùng chung, không tính lại (khử trùng lặp yêu cầu).
  if (running) return running as Promise<T>;
  const version = store.version;
  const p = fn()
    .then((value) => {
      if (store.version === version) store.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      record(name, performance.now() - started, false);
      return value;
    })
    .finally(() => store.inflight.delete(key));
  store.inflight.set(key, p);
  return p;
}

/** Xoá toàn bộ cache (gọi sau đồng bộ, webhook, thao tác ghi ảnh hưởng báo cáo) */
export function clearMemo() {
  store.entries.clear();
  store.version += 1;
}

/** Số mục đang giữ trong đệm — chỉ dùng cho trang chẩn đoán */
export function memoSize() {
  return store.entries.size;
}

export function periodKey(period: { from: Date | null; to: Date | null }) {
  return `${period.from?.toISOString() ?? ""}..${period.to?.toISOString() ?? ""}`;
}

/**
 * KHOÁ ĐỆM CHO CÁC Ô TỔNG HỢP CỦA MỘT TRANG DANH SÁCH (thẻ tổng, bộ đếm bộ lọc).
 *
 * Phải chứa MỌI thứ làm đổi kết quả: kỳ báo cáo, từ khoá tìm, và các facet đang chọn. Cố ý KHÔNG
 * chứa `page`/`pageSize`/`sort` — chúng đổi thứ tự và trang, không đổi tổng — nên bấm sang trang 2
 * không phải tính lại thẻ tổng.
 *
 * `withFilters = false` cho các bộ đếm facet: chúng cố ý bỏ qua facet đang chọn (nếu không, chọn
 * một trạng thái sẽ làm mọi trạng thái khác biến mất khỏi danh sách lọc).
 */
export function listKey(
  params: { q: string; filters: Record<string, string[]>; period: { key: string; fromKey: string | null; toKey: string | null } },
  withFilters = true,
) {
  const period = `${params.period.key}:${params.period.fromKey ?? ""}:${params.period.toKey ?? ""}`;
  const filters = withFilters
    ? Object.keys(params.filters)
        .sort()
        .map((k) => `${k}=${[...params.filters[k]].sort().join("|")}`)
        .join(";")
    : "";
  return `${period}|q=${params.q}|${filters}`;
}

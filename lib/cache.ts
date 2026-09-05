/**
 * Cache bộ nhớ trong tiến trình cho các báo cáo tính toán nặng (lợi nhuận danh nghĩa, hiệu quả marketer, kế hoạch đặt hàng…).
 * Gộp các lời gọi đồng thời cùng khoá; hết hạn theo TTL; xoá toàn bộ sau mỗi job đồng bộ / thao tác ghi để số liệu luôn mới.
 */
type Entry = { value: unknown; expiresAt: number };
const holder = globalThis as unknown as { __erpMemo?: { entries: Map<string, Entry>; inflight: Map<string, Promise<unknown>>; version: number } };
if (!holder.__erpMemo) holder.__erpMemo = { entries: new Map(), inflight: new Map(), version: 0 };
const store = holder.__erpMemo;

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.entries.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const running = store.inflight.get(key);
  if (running) return running as Promise<T>;
  const version = store.version;
  const p = fn()
    .then((value) => {
      if (store.version === version) store.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
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

export function periodKey(period: { from: Date | null; to: Date | null }) {
  return `${period.from?.toISOString() ?? ""}..${period.to?.toISOString() ?? ""}`;
}

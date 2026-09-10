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

/**
 * ═══════ TRẢ SỐ CŨ NGAY, LÀM MỚI PHÍA SAU (stale-while-revalidate) ═══════
 *
 * SỰ CỐ THẬT (10/09/2026). `clearMemo()` xoá SẠCH đệm, và nó được gọi từ `audit()` cùng nhiều job
 * nền — trong đó `landing-sheet` chạy **mỗi phút**. Nên đệm bị san phẳng liên tục, và người mở trang
 * chủ gần như luôn rơi vào lượt tính nguội: đo được **73–88 giây**.
 *
 * Job giữ ấm không cứu được, vì nó chạy 4 phút một lần còn đệm bị xoá mỗi phút.
 *
 * ─── VÌ SAO KHÔNG PHẢI LÀ "TẮT BỚT clearMemo" ───
 *
 * Xoá đệm sau khi ghi dữ liệu là ĐÚNG: người vừa sửa một khoản chi phải thấy số mới. Vấn đề không
 * nằm ở việc xoá mà ở việc BẮT NGƯỜI ĐỌC TIẾP THEO TRẢ GIÁ dựng lại toàn bộ.
 *
 * Nên tách làm hai mức:
 *
 *  · `clearMemo()`  — dữ liệu vừa đổi do NGƯỜI dùng bấm. Xoá hẳn: họ phải thấy đúng số mới, chờ
 *                     một chút là chấp nhận được vì họ vừa chủ động thay đổi.
 *  · `staleMemo()`  — dữ liệu đổi do JOB NỀN. Đánh dấu cũ chứ không xoá: người đọc tiếp theo nhận
 *                     NGAY số của phút trước và một lượt làm mới chạy phía sau. Không ai chờ.
 *
 * Với bảng điều khiển, "số của một phút trước" và "số của lúc này" hầu như luôn giống nhau — đơn mới
 * về mỗi vài phút. Đổi 60 giây chờ lấy một phút lệch là đổi có lợi rõ ràng.
 */
const NGUONG_QUA_CU = 15 * 60_000;
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

  /**
   * ĐÃ CŨ NHƯNG CÒN DÙNG ĐƯỢC: trả ngay, làm mới phía sau.
   *
   * Có trần `NGUONG_QUA_CU`: số cũ quá 15 phút thì thà bắt chờ còn hơn trình bày một con số không
   * còn liên quan. Trả số của tuần trước mà không nói gì là tệ hơn bắt chờ.
   */
  if (hit && !store.inflight.has(key) && now - hit.expiresAt < NGUONG_QUA_CU) {
    const version = store.version;
    const refresh = fn()
      .then((value) => {
        if (store.version === version) store.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      })
      .catch(() => hit.value)
      .finally(() => store.inflight.delete(key));
    store.inflight.set(key, refresh as Promise<unknown>);
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

/**
 * XOÁ HẲN — dùng khi NGƯỜI dùng vừa ghi dữ liệu và phải thấy đúng số mới.
 *
 * Người vừa bấm lưu chấp nhận chờ, vì họ biết mình vừa thay đổi cái gì.
 */
export function clearMemo() {
  store.entries.clear();
  store.version += 1;
}

/**
 * ĐÁNH DẤU CŨ — dùng khi JOB NỀN vừa ghi dữ liệu.
 *
 * Không ai đang ngồi chờ job nền, nhưng có người đang mở trang. Đánh dấu cũ thì người đó nhận NGAY
 * số của lượt trước và một lượt làm mới chạy phía sau — thay vì trả giá dựng lại toàn bộ chỉ vì bộ
 * đồng bộ vừa chạy xong.
 */
export function staleMemo() {
  const now = Date.now();
  for (const [k, e] of store.entries) store.entries.set(k, { value: e.value, expiresAt: Math.min(e.expiresAt, now) });
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

/**
 * ═══════ AI ĐANG GHI: NGƯỜI, HAY JOB NỀN? ═══════
 *
 * `audit()` được gọi từ CẢ HAI đường và không có cách nào tự biết. Đoán theo dữ liệu (có `userId`
 * hay không) thì sai ngay lần đầu có job chạy dưới danh nghĩa một tài khoản.
 *
 * Nên đánh dấu tường minh: bộ chạy job bọc lượt chạy trong `trongJobNen()`, và `audit()` hỏi cờ này.
 * Người bấm lưu ⇒ xoá hẳn, họ chấp nhận chờ vì vừa chủ động đổi. Job nền ⇒ đánh dấu cũ, vì không ai
 * ngồi chờ job nhưng có người đang mở trang.
 *
 * Dùng biến toàn cục thay vì AsyncLocalStorage cho đơn giản: job chạy tuần tự trong tiến trình này,
 * và sai sót tệ nhất có thể xảy ra là một lượt xoá đệm mềm thay vì cứng — không mất dữ liệu.
 */
const nen = globalThis as unknown as { __erpJobNen?: number };

export async function trongJobNen<T>(fn: () => Promise<T>): Promise<T> {
  nen.__erpJobNen = (nen.__erpJobNen ?? 0) + 1;
  try {
    return await fn();
  } finally {
    nen.__erpJobNen = Math.max(0, (nen.__erpJobNen ?? 1) - 1);
  }
}

export function dangTrongJobNen(): boolean {
  return (nen.__erpJobNen ?? 0) > 0;
}

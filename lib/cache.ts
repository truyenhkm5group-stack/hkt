/**
 * Cache bộ nhớ trong tiến trình cho các báo cáo tính toán nặng (lợi nhuận danh nghĩa, hiệu quả marketer, kế hoạch đặt hàng…).
 * Gộp các lời gọi đồng thời cùng khoá; hết hạn theo TTL; xoá toàn bộ sau mỗi job đồng bộ / thao tác ghi để số liệu luôn mới.
 *
 * Mỗi lần gọi đều ghi vào sổ đo hiệu năng (`lib/perf/registry.ts`): thời gian và trúng/trượt đệm.
 * Đây là chỗ duy nhất mọi báo cáo nặng đi qua, nên đo ở đây là đo được tất cả mà không phải rải
 * mã đo khắp nơi. Xem kết quả ở `/api/perf` (chỉ quản trị).
 */
import { record, reportName } from "@/lib/perf/registry";
import { publish } from "@/lib/realtime/bus";

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

/**
 * ═══════ TRẦN CHỜ CHUNG MỘT LƯỢT TÍNH ═══════
 *
 * SỰ CỐ THẬT (10/09/2026, sau deploy #197): trang chủ treo đúng 60 giây, ba lượt đo liên tiếp, trên
 * một máy chủ RẢNH — `pg_stat_activity` không có truy vấn nào đang chạy. Sáu mươi giây đó không nằm
 * ở CSDL mà ở chính chỗ này.
 *
 * Nguyên nhân: gộp lời gọi trùng khoá (`inflight`) KHÔNG có trần thời gian. Job giữ ấm được gọi qua
 * `POST /api/sync/dashboard-warm?wait=0` — máy chủ trả lời ngay rồi bỏ rơi công việc phía sau. Một
 * lượt tính bị bỏ rơi giữa chừng thì lời hứa của nó KHÔNG BAO GIỜ kết thúc, nên `.finally` không
 * chạy và mục `inflight` nằm lại vĩnh viễn. Từ đó mọi người đọc cùng khoá đều rơi vào nhánh "đang
 * có lượt tính rồi, dùng chung" và chờ một lời hứa đã chết — **cho tới khi khởi động lại ứng dụng**.
 *
 * Vì sao chỉ trang chủ hỏng: chỉ khoá của bảng điều khiển mới được job giữ ấm chạm tới. Mọi trang
 * khác vẫn 70–170ms suốt thời gian đó, nên nhìn từ ngoài trông như một trang bị lỗi riêng.
 *
 * Trần ở đây KHÔNG phải để "chữa cháy cho job giữ ấm". Nó là điều kiện đúng đắn của chính cơ chế
 * gộp: gộp lời gọi chỉ hợp lệ khi lượt được gộp vào còn sống. Không kiểm chứng được điều đó thì
 * tính lại còn hơn treo mãi mãi.
 */
const TRAN_CHO_CHUNG = 20_000;

/** Đọc mỗi lần gọi (rẻ) để bài kiểm hạ trần xuống mili giây thay vì phải chờ đủ 20 giây thật. */
function tranChoChung(): number {
  return Number(process.env.MEMO_INFLIGHT_TIMEOUT_MS) || TRAN_CHO_CHUNG;
}

type DangChay = { p: Promise<unknown>; at: number };

const holder = globalThis as unknown as { __erpMemo?: { entries: Map<string, Entry>; inflight: Map<string, DangChay>; version: number } };
if (!holder.__erpMemo) holder.__erpMemo = { entries: new Map(), inflight: new Map(), version: 0 };
const store = holder.__erpMemo;

/** Lượt tính đang chạy cho khoá này, NẾU nó còn sống. Quá trần thì coi như đã bị bỏ rơi. */
function luotDangChay(key: string): Promise<unknown> | null {
  const cur = store.inflight.get(key);
  if (!cur) return null;
  if (Date.now() - cur.at > tranChoChung()) {
    store.inflight.delete(key);
    return null;
  }
  return cur.p;
}

/**
 * Ghi nhận một lượt tính đang chạy, và tự gỡ khi xong.
 *
 * Chỉ gỡ NẾU vẫn đúng lượt của mình: một lượt bị bỏ rơi mà kết thúc muộn không được phép gỡ lượt
 * mới đang chạy — làm thế sẽ mở đường cho hai lượt tính chồng nhau trên cùng một khoá.
 */
function ghiNhanChay(key: string, p: Promise<unknown>) {
  const muc: DangChay = { p, at: Date.now() };
  store.inflight.set(key, muc);
  const go = () => {
    if (store.inflight.get(key) === muc) store.inflight.delete(key);
  };
  void p.then(go, go);
}

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
  if (hit && !luotDangChay(key) && now - hit.expiresAt < NGUONG_QUA_CU) {
    const version = store.version;
    const refresh = fn()
      .then((value) => {
        if (store.version === version) {
          store.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
          /**
           * NGƯỜI ĐANG XEM SỐ CŨ PHẢI ĐƯỢC KÉO LÊN SỐ MỚI.
           *
           * Nhánh này trả số cũ ngay rồi mới tính lại — đúng chủ đích. Nhưng nếu dừng ở đó thì người
           * đang mở trang cứ nhìn số của phút trước cho tới khi có một sự kiện KHÁC xảy ra: job đồng
           * bộ xong → SSE → trang làm mới → đọc đệm → nhận số CŨ (lượt mới đang chạy phía sau) → không
           * còn sự kiện nào nữa. Đo được trên trang báo cáo: lệch tới vài phút.
           *
           * Nên khi lượt làm mới xong và giá trị THẬT SỰ đổi, phát một sự kiện để trang tự làm mới
           * lần nữa. Lần đó là trúng đệm, không tính lại, nên không có vòng lặp.
           */
          if (daDoi(hit.value, value)) publish({ type: "sync", source: "CACHE", job: `memo:${name}`, status: "SUCCESS" });
        }
        return value;
      })
      .catch(() => hit.value);
    ghiNhanChay(key, refresh as Promise<unknown>);
    record(name, performance.now() - started, true);
    return hit.value as T;
  }

  // Đang có lượt tính CÒN SỐNG cho đúng khoá này → dùng chung, không tính lại (khử trùng lặp).
  const running = luotDangChay(key);
  if (running) return running as Promise<T>;
  const version = store.version;
  const p = fn().then((value) => {
    if (store.version === version) store.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    record(name, performance.now() - started, false);
    return value;
  });
  ghiNhanChay(key, p);
  return p;
}

/** Hai giá trị đệm có khác nhau không — so bản JSON; không so được thì coi là đã đổi (an toàn hơn im lặng). */
function daDoi(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true;
  }
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

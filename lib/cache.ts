/**
 * Cache bộ nhớ trong tiến trình cho các báo cáo tính toán nặng (lợi nhuận danh nghĩa, hiệu quả marketer, kế hoạch đặt hàng…).
 * Gộp các lời gọi đồng thời cùng khoá; hết hạn theo TTL; xoá toàn bộ sau mỗi job đồng bộ / thao tác ghi để số liệu luôn mới.
 *
 * Mỗi lần gọi đều ghi vào sổ đo hiệu năng (`lib/perf/registry.ts`): thời gian và trúng/trượt đệm.
 * Đây là chỗ duy nhất mọi báo cáo nặng đi qua, nên đo ở đây là đo được tất cả mà không phải rải
 * mã đo khắp nơi. Xem kết quả ở `/api/perf` (chỉ quản trị).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { record, reportName } from "@/lib/perf/registry";
import { currentOrganization, peekOrganization, withOrganization } from "@/lib/platform/context";
import { publish } from "@/lib/realtime/bus";

/** `at` = mốc dữ liệu CŨ NHẤT đứng sau `value` (lúc bắt đầu tính, hoặc sớm hơn nếu nó đọc lại một mục đệm cũ hơn). */
type Entry = { value: unknown; expiresAt: number; at: number };

/**
 * ═══════ SỐ TRÊN MÀN HÌNH ĐƯỢC TÍNH LÚC NÀO (OD-UX-03, 23/10/2026) ═══════
 *
 * Đệm trả số CŨ tới `NGUONG_QUA_CU` rồi mới làm mới phía sau, và job giữ ấm tính trước cho vài trang — nên «bây giờ» KHÔNG
 * phải là mốc của con số người đang đọc. `collectAsOf(fn)` chạy `fn` và trả thêm mốc CŨ NHẤT của mọi mục đệm `fn` đã đọc
 * (trúng đệm, dùng chung lượt đang chạy, hay vừa tính), nên trang không phải chép lại khoá đệm nào.
 *
 * Bộ gom đi theo `AsyncLocalStorage`: hai request song song không thấy mốc của nhau. Lượt TÍNH của một mục đệm chạy trong
 * bộ gom RIÊNG (không cha) để mốc của mục ấy chỉ phụ thuộc chính nó — lượt ấy có thể được người khác dùng chung, hoặc chạy
 * sau khi request đã trả lời (làm mới phía sau). Ngoài `collectAsOf` thì không có bộ gom nào và `memo` chạy y như cũ.
 */
type AsOfCollector = { oldest: number | null; parent: AsOfCollector | null };
const asOfHolder = globalThis as unknown as { __erpAsOf?: AsyncLocalStorage<AsOfCollector> };
if (!asOfHolder.__erpAsOf) asOfHolder.__erpAsOf = new AsyncLocalStorage<AsOfCollector>();
const asOfStore = asOfHolder.__erpAsOf;

/** Ghi một mốc vào bộ gom hiện tại VÀ mọi bộ gom cha (`collectAsOf` lồng nhau). */
function noteAsOf(at: number) {
  for (let c = asOfStore.getStore() ?? null; c; c = c.parent) if (c.oldest === null || at < c.oldest) c.oldest = at;
}

/** Tính `fn` trong bộ gom riêng; mốc = lúc bắt đầu, hoặc mục đệm cũ hơn mà `fn` đã đọc lại. */
async function tinhKemMoc<T>(fn: () => Promise<T>): Promise<{ value: T; at: number }> {
  const start = Date.now();
  const c: AsOfCollector = { oldest: null, parent: null };
  const value = await asOfStore.run(c, fn);
  return { value, at: Math.min(start, c.oldest ?? start) };
}

/**
 * Chạy `fn` và trả `asOf` = mốc dữ liệu CŨ NHẤT đứng sau kết quả: mục đệm cũ nhất đã đọc, hoặc lúc bắt đầu nếu mọi thứ đọc
 * thẳng CSDL. `cached` = có ít nhất một mục đệm cũ hơn lúc bắt đầu (trang in «đệm» thay vì «truy vấn trực tiếp»).
 * Không bao giờ muộn hơn lúc bắt đầu: phần đọc thẳng CSDL đã chạy từ lúc đó — thà nói cũ hơn một chút còn hơn giả «bây giờ».
 */
export async function collectAsOf<T>(fn: () => Promise<T>): Promise<{ value: T; asOf: Date; cached: boolean }> {
  const start = Date.now();
  const c: AsOfCollector = { oldest: null, parent: asOfStore.getStore() ?? null };
  const value = await asOfStore.run(c, fn);
  const oldest = c.oldest;
  return { value, asOf: new Date(Math.min(start, oldest ?? start)), cached: oldest !== null && oldest < start };
}

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

const holder = globalThis as unknown as {
  __erpMemo?: { entries: Map<string, Entry>; inflight: Map<string, DangChay>; version: number; giuCu: string[]; orgVersion?: Map<string, number> };
};
if (!holder.__erpMemo) holder.__erpMemo = { entries: new Map(), inflight: new Map(), version: 0, giuCu: [], orgVersion: new Map() };
const store = holder.__erpMemo;
// Holder dựng bởi bản trước (chưa có trường này) trong cùng tiến trình — `giuCu` là tiền tố khoá, không chứa dữ liệu nghiệp vụ.
if (!Array.isArray(store.giuCu)) store.giuCu = [];
if (!(store.orgVersion instanceof Map)) store.orgVersion = new Map();
const orgVersion = store.orgVersion;

/**
 * ═══════ XOÁ ĐỆM THEO TỔ CHỨC (đo 24/10/2026) ═══════
 *
 * Kho đệm là MỘT cho cả tiến trình, còn dữ liệu nằm ở CSDL RIÊNG của từng tổ chức. Bản cũ để mọi lượt ghi (`audit()`
 * và các nơi gọi thẳng) xoá đệm của MỌI tổ chức. Giờ trưa 24/10, bot HSLC ghi liên tục vào CSDL của HSLC trong khi
 * CSDL nhà chỉ có 3 dòng nhật ký trong 20 phút (db-query 40069757141), vậy mà /reports/returns của nhà mở lần hai —
 * đáng ra trúng đệm — vẫn mất 9,2 s: một lượt ghi ở tổ chức A làm tổ chức B trả giá dựng lại toàn trang.
 *
 * `MemoScope` = MỘT tổ chức, hoặc `"ALL"`. Một tổ chức thì chỉ đụng khoá của nó (nhà: khoá trần; khác: `org:<mã>:`,
 * xem `memoStoreKey`) và chỉ tăng phiên bản CỦA NÓ — lượt tính đang chạy của tổ chức khác vẫn được lưu.
 * Không xác định được tổ chức ⇒ `"ALL"`: với đệm, phía AN TOÀN là xoá nhiều hơn (chỉ tốn hiệu năng), không phải ít hơn.
 */
export type MemoScope = { code: string; isHome: boolean } | "ALL";

const maPhamVi = (org: { code: string; isHome: boolean }) => (org.isHome ? "@nha" : org.code);
const thuocPhamVi = (key: string, org: { code: string; isHome: boolean }) => (org.isHome ? !key.startsWith("org:") : key.startsWith(`org:${org.code}:`));

/** Phiên bản mà một lượt tính phải còn nguyên lúc lưu: lượt xoá TOÀN BỘ hoặc lượt xoá của CHÍNH tổ chức đó đều làm nó cũ. */
type PhienBan = { all: number; org: number };
const phienBanCua = (org: { code: string; isHome: boolean }): PhienBan => ({ all: store.version, org: orgVersion.get(maPhamVi(org)) ?? 0 });
const conNguyen = (v: PhienBan, org: { code: string; isHome: boolean }) => v.all === store.version && v.org === (orgVersion.get(maPhamVi(org)) ?? 0);

/**
 * KHOÁ GIỮ SỐ CŨ KHI NGƯỜI DÙNG GHI (OD-UX-05 mục 2(c)). Miền đăng ký tiền tố khoá GỐC (không mang `org:<mã>:`) — danh sách
 * duy nhất ở lib/constants/work-cache.ts. `clearMemo()` đánh dấu chúng CŨ thay vì xoá, và lượt tính xong sau một lượt ghi
 * được lưu ở trạng thái CŨ thay vì vứt. Mọi khoá khác giữ nguyên ngữ nghĩa «xoá hẳn».
 */
export function registerStaleOnWrite(prefixes: readonly string[]) {
  for (const p of prefixes) if (p && !store.giuCu.includes(p)) store.giuCu.push(p);
}

/** Khoá thật ⇒ khoá gốc: bỏ tiền tố tổ chức `org:<mã>:` (memoStoreKey). */
const khoaGoc = (k: string) => (k.startsWith("org:") ? k.slice(k.indexOf(":", 4) + 1) : k);
const giuCuKhiGhi = (baseKey: string) => store.giuCu.some((p) => baseKey.startsWith(p));

/**
 * Ghi kết quả một lượt tính. Không có lượt ghi xen vào ⇒ số tươi. Có lượt ghi xen vào: khoá giữ-cũ ⇒ LƯU nhưng ở trạng thái
 * CŨ (tính trên dữ liệu TRƯỚC lượt ghi — người đọc kế tiếp nhận ngay và lượt làm mới chạy sau); khoá khác ⇒ vứt như trước.
 * Trả về `true` khi đã ghi số TƯƠI.
 */
function luuKetQua(key: string, baseKey: string, org: { code: string; isHome: boolean }, version: PhienBan, value: unknown, at: number, ttlMs: number): boolean {
  if (conNguyen(version, org)) {
    store.entries.set(key, { value, expiresAt: Date.now() + ttlMs, at });
    return true;
  }
  if (giuCuKhiGhi(baseKey)) store.entries.set(key, { value, expiresAt: Date.now(), at });
  return false;
}

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

/**
 * ═══════ KHOÁ ĐỆM MANG TỔ CHỨC — TỰ THÊM Ở ĐÂY, KHÔNG ĐỂ 130 NƠI GỌI TỰ NHỚ ═══════
 *
 * Audit ISO-01/02/26 · target-architecture P13. Kho đệm là MỘT cho cả tiến trình, còn khoá do nơi
 * gọi đặt chỉ gồm tên báo cáo + kỳ (`getDashboardData:<kỳ>`, thậm chí hằng như `"cash-position"`).
 * Hai tổ chức gọi cùng khoá ⇒ tổ chức B nhận NGUYÊN số của tổ chức nhà trong suốt TTL — kể cả mẫu
 * quyền vai trò (`auth:roleTemplates`), tức là leo thang quyền chéo tổ chức, không chỉ lộ số.
 *
 *  · Tổ chức NHÀ giữ khoá CŨ, từng ký tự: job giữ ấm, sổ đo hiệu năng và bài kiểm so tập khoá
 *    (`memoKeys()`) chạy y như trước nền tảng.
 *  · Tổ chức khác: khoá thật là `org:<mã>:<khoá>`. Lượt tính đang chạy (`inflight`) đi theo khoá
 *    thật, nên B không bao giờ "đi nhờ" lượt tính của A.
 *  · Không xác định được tổ chức (`OrgContextError`) ⇒ NÉM, không đoán là nhà.
 *
 * Sổ đo hiệu năng vẫn gom theo khoá GỐC (`reportName(key)`), để báo cáo của mọi tổ chức không bị
 * gộp thành một dòng tên `org`.
 */
export function memoStoreKey(org: { code: string; isHome: boolean }, key: string): string {
  return org.isHome ? key : `org:${org.code}:${key}`;
}

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const org = await currentOrganization();
  return memoFor(org, key, ttlMs, fn);
}

async function memoFor<T>(org: { code: string; isHome: boolean }, baseKey: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const key = memoStoreKey(org, baseKey);
  const now = Date.now();
  const started = performance.now();
  const name = reportName(baseKey);
  const hit = store.entries.get(key);
  if (hit && hit.expiresAt > now) {
    record(name, performance.now() - started, true);
    noteAsOf(hit.at);
    return hit.value as T;
  }

  /**
   * ĐÃ CŨ NHƯNG CÒN DÙNG ĐƯỢC: trả ngay, làm mới phía sau.
   *
   * Có trần `NGUONG_QUA_CU`: số cũ quá 15 phút thì thà bắt chờ còn hơn trình bày một con số không
   * còn liên quan. Trả số của tuần trước mà không nói gì là tệ hơn bắt chờ.
   */
  if (hit && !luotDangChay(key) && now - hit.expiresAt < NGUONG_QUA_CU) {
    const version = phienBanCua(org);
    /*
      Lượt làm mới chạy SAU khi request đã trả lời, nên ngữ cảnh phiên có thể không còn đọc được.
      Tổ chức khác nhà ⇒ bọc tường minh bằng mã đã phân giải ở trên: lượt tính lại và sự kiện
      realtime của nó chắc chắn thuộc đúng tổ chức. Nhà ⇒ đường cũ, không đổi gì.
    */
    const run = org.isHome ? fn : () => withOrganization(org.code, fn);
    const refresh = tinhKemMoc(run)
      .then(({ value, at }) => {
        if (luuKetQua(key, baseKey, org, version, value, at, ttlMs)) {
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
          if (daDoi(hit.value, value)) publish({ type: "sync", source: "CACHE", job: `memo:${name}`, status: "SUCCESS" }, org.code);
        }
        return value;
      })
      .catch(() => hit.value);
    ghiNhanChay(key, refresh as Promise<unknown>);
    record(name, performance.now() - started, true);
    // Người đọc nhận số CŨ ⇒ mốc là của số cũ, không phải của lượt làm mới đang chạy.
    noteAsOf(hit.at);
    return hit.value as T;
  }

  // Đang có lượt tính CÒN SỐNG cho đúng khoá này → dùng chung, không tính lại (khử trùng lặp).
  const running = luotDangChay(key);
  if (running) {
    const batDau = store.inflight.get(key)?.at ?? Date.now();
    // Lượt dùng chung có thể là lượt làm mới đã lỗi (trả lại số cũ) ⇒ đọc mốc của mục đệm thật, không đoán.
    return (running as Promise<T>).then((value) => {
      noteAsOf(store.entries.get(key)?.at ?? batDau);
      return value;
    });
  }
  const version = phienBanCua(org);
  const p = tinhKemMoc(fn).then(({ value, at }) => {
    luuKetQua(key, baseKey, org, version, value, at, ttlMs);
    record(name, performance.now() - started, false);
    return { value, at };
  });
  const v = p.then((r) => r.value);
  ghiNhanChay(key, v);
  return p.then(({ value, at }) => {
    noteAsOf(at);
    return value;
  });
}

/**
 * ĐỌC ĐỆM MÀ KHÔNG TÍNH (OD-UX-05 mục 2, 24/10/2026): mục còn hạn, hoặc đã cũ nhưng chưa quá `NGUONG_QUA_CU` — ĐÚNG luật
 * `memo()` dùng để trả số cũ — thì trả `{ value }`; không có ⇒ `null`, và KHÔNG khởi động lượt tính nào. Dành cho nguồn mà
 * đường trang không được tự tính (lượt tính 22 s giữ 3–4/5 kết nối của bể); job giữ ấm là đường tính duy nhất của chúng.
 * Mốc của mục ghi vào `collectAsOf` như một lượt trúng đệm.
 */
export async function memoPeek<T>(key: string): Promise<{ value: T } | null> {
  const org = await currentOrganization();
  const hit = store.entries.get(memoStoreKey(org, key));
  if (!hit || Date.now() - hit.expiresAt >= NGUONG_QUA_CU) return null;
  noteAsOf(hit.at);
  return { value: hit.value as T };
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
 *
 * PHẠM VI (hợp đồng mục 9, sửa 24/10/2026): mặc định là tổ chức của NGỮ CẢNH TƯỜNG MINH (`withOrganization` — job,
 * webhook, bot). Không có ngữ cảnh tường minh (server action theo phiên, script) ⇒ `"ALL"` như trước. `audit()` tự phân
 * giải tổ chức (kể cả từ phiên) rồi truyền vào. Chỗ ghi dữ liệu CHUNG của nền tảng (CSDL nền tảng mà mọi tổ chức đọc)
 * phải truyền `"ALL"` tường minh — xem `lib/platform/publish.ts`.
 */
export function clearMemo(scope: MemoScope = peekOrganization() ?? "ALL") {
  // Khoá giữ-cũ (registerStaleOnWrite) chỉ bị ĐÁNH DẤU CŨ — đúng ngữ nghĩa staleMemo; mọi khoá khác xoá hẳn như trước.
  const now = Date.now();
  for (const [k, e] of store.entries) {
    if (scope !== "ALL" && !thuocPhamVi(k, scope)) continue;
    if (giuCuKhiGhi(khoaGoc(k))) store.entries.set(k, { value: e.value, expiresAt: Math.min(e.expiresAt, now), at: e.at });
    else store.entries.delete(k);
  }
  if (scope === "ALL") store.version += 1;
  else orgVersion.set(maPhamVi(scope), (orgVersion.get(maPhamVi(scope)) ?? 0) + 1);
}

/**
 * XOÁ HẲN TOÀN BỘ, KỂ CẢ khoá giữ-cũ — khi chính người dùng HỎI số mới (nút «Làm mới số liệu») và khi bài kiểm cần đặt lại
 * sạch giữa hai bước. `clearMemo()` (sau một lượt GHI) cố ý giữ cũ các khoá riêng của /work; nút làm mới thì không: người vừa
 * bấm đang nhìn màn hình và hỏi đúng câu «số bây giờ là bao nhiêu».
 */
export function clearMemoAll() {
  store.entries.clear();
  store.version += 1;
}

/**
 * QUÊN MỘT KHOÁ của tổ chức NGỮ CẢNH — dùng khi chính nơi gọi biết số đệm vừa hết đúng (vd lượt kiểm hạn mức vừa cho
 * qua một lượt tạo: số đếm cũ thấp hơn thật đúng một đơn vị, và đệm 60 giây sẽ cho lọt quá trần). Chỉ xoá ĐÚNG khoá
 * đó của ĐÚNG tổ chức — không đụng khoá nào khác.
 */
export async function forgetMemo(key: string): Promise<void> {
  const org = await currentOrganization();
  store.entries.delete(memoStoreKey(org, key));
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
  for (const [k, e] of store.entries) store.entries.set(k, { value: e.value, expiresAt: Math.min(e.expiresAt, now), at: e.at });
}

/** Số mục đang giữ trong đệm — chỉ dùng cho trang chẩn đoán */
export function memoSize() {
  return store.entries.size;
}

/**
 * Khoá đang có trong đệm (kể cả khoá đã cũ còn giữ giá trị) — chỉ để chẩn đoán / kiểm thử: bài kiểm của
 * job giữ ấm so tập khoá job dựng với tập khoá trang chủ đọc, thay vì gõ lại tên khoá bằng tay.
 */
export function memoKeys(): string[] {
  return [...store.entries.keys()];
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

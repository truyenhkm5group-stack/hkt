/**
 * ═══════════ LƯỢT MỞ TRANG — ĐO ĐỂ RÚT GỌN MENU BẰNG SỐ, KHÔNG BẰNG CẢM GIÁC ═══════════
 *
 * ERP có hơn trăm màn hình và câu "trang này còn ai dùng không" chưa từng có số trả lời: đợt rà soát
 * điều hướng 24/09/2026 dừng đúng ở chỗ "cần đo lượt truy cập trước khi quyết" (vd Nhật ký kho).
 *
 * BA ĐIỀU CỐ Ý:
 *
 *  1. KHÔNG GHI AI MỞ. Mỗi dòng là (ngày theo giờ VN, mục trang, số lượt) — không khoá tài khoản, không
 *     vai trò, không nội dung, không tham số lọc. Câu hỏi là "màn hình này có được dùng không", và
 *     trả lời nó không cần biết ai; một bảng đếm theo người là một công cụ theo dõi nhân viên mà
 *     không ai yêu cầu.
 *  2. KHOÁ ĐẾM LÀ MỤC ĐÃ KHAI, KHÔNG PHẢI ĐƯỜNG DẪN THÔ. `/models/q001` đếm vào `/models`; đường
 *     dẫn không khớp mục nào rơi vào MỘT khoá `OTHER_USAGE_KEY`. Nhận đường dẫn thô là để bảng
 *     phình theo mọi mã đơn / mã mẫu và để bất kỳ ai gửi rác vào được.
 *  3. CHƯA ĐO ≠ 0 LƯỢT (luật 42). Trước ngày đầu tiên có số đo thì cả ERP là CHƯA BIẾT; từ ngày đó
 *     trở đi, một mục không có dòng nào là 0 THẬT — nhưng chỉ trong khoảng đã đo, và màn hình phải
 *     in khoảng ấy cạnh con số.
 *
 * Máy KHÔNG kết luận "nên bỏ trang này": ít lượt có thể là trang dùng một lần mỗi tháng (chốt lương)
 * và vẫn cần. Nó chỉ xếp và in — người quyết.
 */

/** Khoá gom mọi đường dẫn không khớp mục nào đã khai. */
export const OTHER_USAGE_KEY = "(khác)";

/** Cửa sổ đọc mặc định của màn hình — đủ dài để trang dùng hằng tuần hiện ra ít nhất bốn lần. */
export const PAGE_USAGE_WINDOW_DAYS = 28;

/** Đường dẫn dài hơn mức này không phải một trang của ERP — bỏ, không đếm. */
const MAX_PATH_LENGTH = 300;

/**
 * Khoá đếm từ danh sách trang đã khai. Mục mang tham số (`/models?view=bang` — một GÓC NHÌN của cùng
 * trang) bị bỏ: bộ đếm cố ý không đọc tham số, nên mục ấy không bao giờ khớp và sẽ nằm mãi ở 0 lượt
 * — một con số 0 giả. Lượt của nó đếm vào trang gốc.
 */
export function usageKeysFrom(declared: readonly string[]): string[] {
  return [...new Set(declared.filter((k) => k.startsWith("/") && !/[?#]/.test(k)))];
}

/**
 * Quy một đường dẫn về khoá đếm: mục đã khai DÀI NHẤT khớp theo RANH GIỚI ĐOẠN (`/reports/returns`
 * không đếm vào `/reports`, `/ordersx` không đếm vào `/orders`). `null` = không phải đường dẫn trang
 * (rỗng, quá dài, không bắt đầu bằng `/`, hoặc là `/api`) — tuyến ghi bỏ qua, không đếm vào "(khác)".
 */
export function usageKeyOf(pathname: unknown, knownKeys: readonly string[]): string | null {
  if (typeof pathname !== "string" || pathname.length === 0 || pathname.length > MAX_PATH_LENGTH) return null;
  let path = pathname.split(/[?#]/)[0] ?? "";
  if (!path.startsWith("/")) return null;
  path = path.replace(/\/{2,}/g, "/").toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/_next/")) return null;
  let best: string | null = null;
  for (const key of knownKeys) {
    const k = key.toLowerCase();
    const hit = k === "/" ? path === "/" : path === k || path.startsWith(`${k}/`);
    if (hit && (best === null || k.length > best.length)) best = key;
  }
  return best ?? OTHER_USAGE_KEY;
}

export type PageVisitRow = { day: string; key: string; visits: number };

export type PageUsageLine = {
  key: string;
  /** Tổng lượt trong cửa sổ. `null` = cửa sổ chưa có ngày đo nào (CHƯA BIẾT, không phải 0). */
  visits: number | null;
  /** Số ngày có ít nhất một lượt — phân biệt "một người bấm 50 lần một hôm" với "dùng mỗi ngày". */
  activeDays: number | null;
  lastDay: string | null;
};

export type PageUsageSummary = {
  /** Ngày đầu tiên có số đo trong toàn bộ sổ (không chỉ cửa sổ); `null` = chưa đo ngày nào. */
  firstMeasuredDay: string | null;
  /** Số ngày của cửa sổ thật sự nằm trong khoảng đã đo — con số in cạnh mọi "0 lượt". */
  measuredDays: number;
  windowDays: number;
  lines: PageUsageLine[];
  /** Lượt vào đường dẫn không khớp mục nào — lớn bất thường nghĩa là sổ mục đang thiếu trang. */
  otherVisits: number | null;
};

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Tóm tắt cửa sổ `windowDays` ngày kết thúc ở `today` (tính cả hôm nay). Hàm THUẦN: `today` do
 * người gọi truyền, nên bài kiểm không phụ thuộc đồng hồ (luật 50).
 *
 * `firstMeasuredDay` là ngày sớm nhất của TOÀN sổ, người gọi đọc riêng — lấy ngày sớm nhất trong
 * cửa sổ thì một mục chỉ được mở từ hôm qua sẽ làm cả bảng trông như mới đo từ hôm qua.
 */
export function summarizePageUsage(input: { rows: readonly PageVisitRow[]; keys: readonly string[]; today: string; windowDays: number; firstMeasuredDay: string | null }): PageUsageSummary {
  const { rows, keys, today, windowDays, firstMeasuredDay } = input;
  const windowStart = new Date(Date.parse(`${today}T00:00:00Z`) - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const measuredFrom = firstMeasuredDay && firstMeasuredDay > windowStart ? firstMeasuredDay : windowStart;
  const measuredDays = firstMeasuredDay === null || firstMeasuredDay > today ? 0 : dayDiff(today, measuredFrom) + 1;
  const known = measuredDays > 0;

  const acc = new Map<string, { visits: number; days: Set<string>; last: string | null }>();
  for (const r of rows) {
    if (r.day < windowStart || r.day > today || !(r.visits > 0)) continue;
    const cur = acc.get(r.key) ?? { visits: 0, days: new Set<string>(), last: null };
    cur.visits += r.visits;
    cur.days.add(r.day);
    if (cur.last === null || r.day > cur.last) cur.last = r.day;
    acc.set(r.key, cur);
  }
  const lineOf = (key: string): PageUsageLine => {
    const a = acc.get(key);
    if (!known) return { key, visits: null, activeDays: null, lastDay: null };
    return { key, visits: a?.visits ?? 0, activeDays: a?.days.size ?? 0, lastDay: a?.last ?? null };
  };
  const lines = keys.filter((k) => k !== OTHER_USAGE_KEY).map(lineOf);
  // Ít dùng nhất lên đầu — đó là câu hỏi màn hình này sinh ra để trả lời. Bằng nhau thì giữ thứ tự khai.
  const order = new Map(keys.map((k, i) => [k, i]));
  lines.sort((a, b) => (a.visits ?? 0) - (b.visits ?? 0) || (a.activeDays ?? 0) - (b.activeDays ?? 0) || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return { firstMeasuredDay, measuredDays, windowDays, lines, otherVisits: known ? (acc.get(OTHER_USAGE_KEY)?.visits ?? 0) : null };
}

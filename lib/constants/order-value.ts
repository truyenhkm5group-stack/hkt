/**
 * ═══════════ BỘ LỌC THEO GIÁ TRỊ ĐƠN — MỘT BẢN KHAI, MỘT CÔNG THỨC ═══════════
 *
 * Câu hỏi kinh doanh sinh ra tệp này (chủ shop chốt 21/09/2026): *"giảm giá một mã xuống dưới
 * 300K thì tỷ lệ giao thành công có tăng không, và bắn tin xả hàng chốt đơn nhỏ — không tốn thêm
 * tiền quảng cáo — thì lợi nhuận có tốt không?"*
 *
 * ─── VÌ SAO "GIÁ TRỊ ĐƠN" PHẢI LÀ GIÁ CHỐT, KHÔNG PHẢI TIỀN VỀ ───
 *
 * `orders.total_price_after_discount` = tiền hàng khách phải trả SAU giảm giá, CHƯA gồm cước
 * (cước nằm riêng ở `orders.shipping_fee`). Đây là con số người bán QUYẾT ĐỊNH lúc chốt đơn.
 *
 * Ba ứng viên còn lại đều làm hỏng đúng phép so sánh mà bộ lọc này sinh ra để phục vụ:
 *
 *  · **Tiền THỰC THU** (`shipments.cod_collected` / bảng kê) — mọi đơn hoàn đều thực thu ≈ 0 nên
 *    chúng rơi HẾT vào bậc thấp nhất. Bậc "< 300K" sẽ luôn có GTC gần 0% và bậc cao gần 100% —
 *    bộ lọc tự tạo ra kết luận thay vì đo ảnh hưởng của việc giảm giá. Đây là cùng một cái bẫy mà
 *    mục 64 của AGENTS.md đã đo được một lần: một phép lọc nghe hợp lý đổi kết luận theo hướng
 *    ngược hẳn.
 *  · **COD khai báo** — đơn khách chuyển khoản trước có COD = 0, nên cũng rơi vào bậc thấp nhất
 *    dù là đơn to.
 *  · **Tiền hàng TRƯỚC giảm giá** — chính cái giảm giá là thứ đang được đo, loại nó ra khỏi con số
 *    lọc thì đơn đã hạ giá vẫn nằm ở bậc cũ.
 *
 * ─── GIÁ TRỊ CỦA CẢ ĐƠN, KHÔNG PHẢI PHẦN CỦA MỘT MÃ TRONG ĐƠN ───
 *
 * Báo cáo vẫn tách theo mã hàng / theo marketer như cũ, nhưng ĐIỀU KIỆN LỌC đọc tổng tiền của CẢ
 * ĐƠN. Quyết định "xả hàng, chốt đơn dưới 300K" là quyết định ở mức ĐƠN — khách trả 280K cho một
 * đơn hai mã thì đó là một đơn 280K, không phải hai đơn 140K.
 *
 * ─── 0 ĐỒNG LÀ CHƯA BIẾT, KHÔNG PHẢI MỘT BẬC GIÁ (mục 42) ───
 *
 * Cột là `integer NOT NULL DEFAULT 0`, nên một đơn Pancake không khai tổng tiền hạ cánh thành 0 —
 * KHÔNG phân biệt được với đơn tặng 100%. Cả hai đều không trả lời được câu hỏi "đơn này thuộc
 * bậc giá nào", nên đơn `<= 0` nằm NGOÀI mọi bậc và màn hình phải IN RA số đơn rơi khỏi bộ lọc.
 * Nhét chúng vào bậc thấp nhất là khẳng định một điều không chứng minh được.
 */

import { param, type SearchParams } from "@/lib/search-params";

/** Tiền hàng sau giảm giá của CẢ ĐƠN — biểu thức duy nhất, mọi truy vấn dùng lại. */
export const ORDER_VALUE_SQL = `"orders"."total_price_after_discount"`;

/** Đơn KHÔNG khai được giá trị ⇒ ngoài mọi bậc, đếm riêng, không gộp vào bậc thấp nhất. */
export const ORDER_VALUE_UNKNOWN_SQL = `(${ORDER_VALUE_SQL} <= 0)`;

/**
 * Khoảng giá trị đang lọc. `null` ở một đầu = đầu đó không chặn.
 *
 * Quy ước KHOẢNG NỬA MỞ: `min <= giá trị < max` — các bậc dựng sẵn không chồng lên nhau nên cộng
 * lại đủ 100% số đơn có giá trị. "Đơn dưới 300K" của chủ shop là `max = 300_000`, tức đúng
 * 300.000 KHÔNG nằm trong đó.
 */
export type OrderValueFilter = { min: number | null; max: number | null };

export const NO_ORDER_VALUE_FILTER: OrderValueFilter = { min: null, max: null };

/** Trần trên cho số người dùng gõ tay — chặn số vô nghĩa làm hỏng bảng bậc giá. */
const MAX_VALUE = 1_000_000_000;

/**
 * ═══ CÁC BẬC CỦA BẢNG "THEO BẬC GIÁ TRỊ ĐƠN" ═══
 *
 * KHÔNG CHỒNG NHAU và phủ kín trục số, để bảng cộng lại đúng bằng tổng đơn có giá trị. Đây là
 * danh sách để SO SÁNH các bậc với nhau; các mức tắt của bộ lọc (`ORDER_VALUE_PRESETS`) là thứ
 * khác — chúng có quyền chồng nhau vì mỗi lần chỉ chọn một.
 */
export const ORDER_VALUE_TIERS: { key: string; label: string; min: number | null; max: number | null }[] = [
  { key: "lt200", label: "Dưới 200K", min: null, max: 200_000 },
  { key: "200-300", label: "200K – 300K", min: 200_000, max: 300_000 },
  { key: "300-500", label: "300K – 500K", min: 300_000, max: 500_000 },
  { key: "500-1m", label: "500K – 1 triệu", min: 500_000, max: 1_000_000 },
  { key: "gte1m", label: "Từ 1 triệu", min: 1_000_000, max: null },
];

/**
 * Mức tắt của bộ lọc. Có cả mức CỘNG DỒN ("dưới 300K") lẫn mức BẬC ("300K – 500K"): câu hỏi
 * "xả hàng dưới 300K lãi không" cần mức cộng dồn, câu hỏi "bậc nào GTC tốt nhất" cần mức bậc.
 */
export const ORDER_VALUE_PRESETS: { key: string; label: string; min: number | null; max: number | null }[] = [
  { key: "lt200", label: "< 200K", min: null, max: 200_000 },
  { key: "lt300", label: "< 300K", min: null, max: 300_000 },
  { key: "lt500", label: "< 500K", min: null, max: 500_000 },
  { key: "200-300", label: "200K – 300K", min: 200_000, max: 300_000 },
  { key: "300-500", label: "300K – 500K", min: 300_000, max: 500_000 },
  { key: "500-1m", label: "500K – 1tr", min: 500_000, max: 1_000_000 },
  { key: "gte500", label: "≥ 500K", min: 500_000, max: null },
  { key: "gte1m", label: "≥ 1tr", min: 1_000_000, max: null },
];

function clean(raw: string): number | null {
  // Người dùng gõ "300.000", "300,000" hay "300000" đều là một số tiền. Chữ thì không.
  //
  // DẤU TRỪ BỊ TỪ CHỐI, KHÔNG BỊ BỎ ĐI: bỏ dấu trừ rồi đọc "-500" thành 500 là tự sửa ý người gõ
  // thành một khoảng họ không chọn. Giá trị đơn không bao giờ âm, nên "-500" là gõ nhầm — và câu
  // trả lời đúng cho một lần gõ nhầm là KHÔNG LỌC GÌ, để người ta thấy và gõ lại.
  if (raw.includes("-")) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_VALUE, Math.round(n));
}

/**
 * Đọc bộ lọc từ URL (`vmin` / `vmax`, đơn vị ĐỒNG).
 *
 * Khoảng ngược (min >= max) bị BỎ NGUYÊN CẢ CẶP chứ không tự hoán vị: hoán vị hộ là đoán ý người
 * gõ, và người đọc sẽ tin mình đang xem một khoảng mình không hề chọn (cùng lý do với bộ mốc sai
 * thứ tự ở mục 54).
 */
export function parseOrderValue(params: SearchParams): OrderValueFilter {
  const min = clean(param(params, "vmin"));
  const max = clean(param(params, "vmax"));
  if (min !== null && max !== null && min >= max) return NO_ORDER_VALUE_FILTER;
  return { min, max };
}

export function orderValueActive(f: OrderValueFilter): boolean {
  return f.min !== null || f.max !== null;
}

/**
 * Mệnh đề SQL của bộ lọc — `null` khi không lọc gì (KHÔNG trả `"true"`: một mệnh đề thừa ở mọi
 * truy vấn là thứ che mất chỗ quên nối bộ lọc).
 *
 * Số đã qua `clean()` nên luôn là số nguyên dương ⇒ nội suy thẳng vào chuỗi là an toàn; đây cũng
 * là cách `CARRIER_HANDOFF_AT_SQL` đang làm, để biểu thức dùng được ở cả `sql.raw` lẫn drizzle.
 */
export function orderValueWhereSql(f: OrderValueFilter): string | null {
  if (!orderValueActive(f)) return null;
  const parts: string[] = [`${ORDER_VALUE_SQL} > 0`];
  if (f.min !== null) parts.push(`${ORDER_VALUE_SQL} >= ${f.min}`);
  if (f.max !== null) parts.push(`${ORDER_VALUE_SQL} < ${f.max}`);
  return `(${parts.join(" and ")})`;
}

/**
 * BẢN TypeScript CỦA ĐÚNG MỆNH ĐỀ TRÊN — dùng ở chỗ tập đơn đã nằm sẵn trong bộ nhớ (bảng lợi
 * nhuận đọc từng (đơn, mã) rồi mới chia), nên không cần hỏi CSDL lần thứ hai.
 *
 * Hai bản phải nói CÙNG MỘT điều với cùng một đơn; `tests/order-value-filter.test.ts` chạy cả hai
 * trên cùng bộ mốc biên và so từng đơn, theo đúng cách mục 59 giữ hai bản luật mở ca không trôi xa
 * nhau.
 */
export function orderValueMatches(f: OrderValueFilter, value: number): boolean {
  if (!orderValueActive(f)) return true;
  if (!(value > 0)) return false;
  if (f.min !== null && value < f.min) return false;
  if (f.max !== null && value >= f.max) return false;
  return true;
}

/** Nhãn ngắn của khoảng đang lọc — dùng ở tiêu đề trang, chú thích bảng và khoá cache. */
export function orderValueLabel(f: OrderValueFilter): string {
  if (!orderValueActive(f)) return "Mọi giá trị đơn";
  const tien = (n: number) => (n % 1_000_000 === 0 ? `${n / 1_000_000}tr` : n % 1_000 === 0 ? `${n / 1_000}K` : String(n));
  if (f.min === null) return `Đơn dưới ${tien(f.max as number)}`;
  if (f.max === null) return `Đơn từ ${tien(f.min)}`;
  return `Đơn ${tien(f.min)} – ${tien(f.max)}`;
}

/** Phần khoá cache / khoá memo của bộ lọc (AGENTS mục 2: tham số đổi kết quả phải vào khoá). */
export function orderValueKey(f: OrderValueFilter): string {
  return `${f.min ?? "-"}..${f.max ?? "-"}`;
}

/**
 * ═══════════ CÔNG TẮC "TÍNH CHI PHÍ QUẢNG CÁO" ═══════════
 *
 * Ở ngay cạnh bộ lọc giá trị đơn vì nó là VẾ THỨ HAI của cùng một câu hỏi: đơn xả hàng chốt từ
 * tin nhắn cho khách cũ không tiêu thêm một đồng quảng cáo nào, nên lợi nhuận có ý nghĩa của
 * chúng là lợi nhuận KHÔNG gánh CPQC.
 *
 * · BẬT (mặc định) — CPQC phân bổ và trừ vào lợi nhuận như mọi báo cáo hiện có.
 * · TẮT — báo cáo hiện **CPQC = 0** và lợi nhuận KHÔNG trừ CPQC.
 *
 * Tắt công tắc này thì các con số KHÔNG còn cộng ra được tổng lợi nhuận toàn kỳ — quảng cáo vẫn
 * là tiền đã tiêu thật. Màn hình BẮT BUỘC nói ra điều đó ở chỗ người đọc không thể bỏ qua; một
 * con số lợi nhuận đẹp hơn mà không ai biết vì sao là đúng thứ mà sổ chỉ số này tồn tại để chặn.
 */
export function parseAdsIncluded(params: SearchParams): boolean {
  return param(params, "ads", "1") !== "0";
}

export const ADS_EXCLUDED_NOTE =
  "Đang xem lợi nhuận KHÔNG gánh chi phí quảng cáo: CPQC hiện 0 và không trừ vào lợi nhuận. Con số này trả lời “bán thêm một đơn xả thì được thêm bao nhiêu tiền”, KHÔNG cộng ra được lợi nhuận thật của kỳ — tiền quảng cáo vẫn đã tiêu.";

/**
 * ═══ BẢNG SIZE TỪ CHỮ TRUNG GỐC (SRC-6) — HÀM THUẦN, CLIENT-SAFE ═══
 *
 * Bẫy đã đo trên trang thật (docs/tech/ai-sourcing.md §2.1c): bản dịch tự động đổi 斤 (cân Trung Quốc = 0,5 kg) thành «kg» —
 * mẫu 815636568273 ghi «M 90–100 kg» trong bản dịch, thật là 45–50 kg. Nên bộ đọc này CHỈ nhận chữ Trung gốc và CHỈ tin đơn vị
 * viết ngay sau con số: 斤 ÷ 2 = kg; 公斤 / 千克 / kg giữ nguyên. Dòng không có đơn vị, đơn vị lạ, hoặc ra ngoài khoảng người lớn
 * (`BODY_KG_MIN`–`BODY_KG_MAX`) ⇒ BỎ dòng đó, không đoán; không đọc được dòng nào ⇒ `rows = []`, người gọi gắn cờ.
 *
 * Cân nặng lưu bằng PHẦN MƯỜI kg nguyên (95 斤 = 47,5 kg ⇒ 475) — không số thực.
 */

export type SizeChartUnit = "JIN" | "KG";

export type SizeChartRow = {
  /** Nhãn size đúng như chữ gốc đã chuẩn hoá (in hoa, bỏ «码»): «M», «2XL», «均码». */
  size: string;
  /** Cân nặng khuyên dùng, phần mười kg. `max` = `min` khi trang ghi một số. */
  minKgX10: number;
  maxKgX10: number;
  /** Đơn vị trang ghi — để màn hình nói «trang ghi 斤, đã quy ra kg». */
  unit: SizeChartUnit;
  /** Đoạn chữ gốc của dòng — để người xem đối chiếu. */
  text: string;
};

export type SizeChart = { rows: SizeChartRow[]; sourceText: string };

/** Khoảng cân nặng người lớn hợp lý — ngoài khoảng ⇒ coi là đọc sai (vd bản dịch đã đổi đơn vị), bỏ dòng. */
export const BODY_KG_MIN = 25;
export const BODY_KG_MAX = 200;

const FULLWIDTH_DIGITS = /[０-９]/g;

function normalize(raw: string): string {
  return raw
    .replace(FULLWIDTH_DIGITS, (d) => String.fromCharCode(d.charCodeAt(0) - 0xff10 + 48))
    .replace(/[～〜~–—－至到]/g, "-")
    .replace(/[：]/g, ":")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/．/g, ".")
    .replace(/[ＸＬＳＭ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * Một dòng: SIZE [码] [(] [建议] [体重] [:] SỐ [- SỐ] ĐƠN-VỊ. Nhãn size nhận bộ chữ thông dụng của hàng may mặc; nhãn số (165/88A)
 * không nhận — nó là chiều cao / vòng ngực, không phải tên size người bán ghi cạnh cân nặng. Không dùng nhìn-ngược (lookbehind): tệp này
 * vào được trình duyệt, và Safari < 16.4 không biên dịch nổi cú pháp đó (cả trang sập) — dùng nhóm tiền tố thay.
 */
const ROW_RE = /(?:^|[^A-Za-z0-9])([2-6]XL|X{1,4}L|X{1,3}S|XS|S|M|L|均码|F)(?![A-Za-z])\s*码?\s*\(?\s*(?:建议)?\s*(?:体重)?\s*:?\s*(\d{2,3}(?:\.\d)?)\s*(?:-\s*(\d{2,3}(?:\.\d)?))?\s*(斤|公斤|千克|kg|KG|Kg)/g;

/** Số thập phân tối đa 1 chữ số ⇒ phần mười nguyên, không qua số thực. */
function tenths(s: string): number {
  const [i, f = ""] = s.split(".");
  return Number(i) * 10 + Number((f + "0").slice(0, 1));
}

function toKgX10(value: string, unit: SizeChartUnit): number {
  const t = tenths(value);
  // 斤 = 0,5 kg ⇒ phần mười kg = phần mười 斤 ÷ 2. Lẻ nửa phần mười (vd 95,5 斤) làm tròn xuống — sai số 0,05 kg.
  return unit === "JIN" ? Math.floor(t / 2) : t;
}

/** Chữ bảng size gốc ⇒ các dòng đọc được. Chữ trống ⇒ `null` (trang không có bảng size). HÀM THUẦN. */
export function parseSizeChart(raw: string | null | undefined): SizeChart | null {
  const sourceText = (raw ?? "").trim();
  if (!sourceText) return null;
  const text = normalize(sourceText);
  const rows: SizeChartRow[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ROW_RE)) {
    const size = m[1].toUpperCase();
    if (seen.has(size)) continue;
    const unit: SizeChartUnit = m[4] === "斤" ? "JIN" : "KG";
    const a = toKgX10(m[2], unit);
    const b = m[3] ? toKgX10(m[3], unit) : a;
    const [minKgX10, maxKgX10] = a <= b ? [a, b] : [b, a];
    if (minKgX10 < BODY_KG_MIN * 10 || maxKgX10 > BODY_KG_MAX * 10) continue;
    seen.add(size);
    rows.push({ size, minKgX10, maxKgX10, unit, text: m[0].slice(m[0].indexOf(m[1])).trim() });
  }
  return { rows, sourceText };
}

/** 475 ⇒ «47,5». HÀM THUẦN. */
export function formatKgX10(n: number): string {
  return n % 10 === 0 ? String(n / 10) : `${Math.floor(n / 10)},${n % 10}`;
}

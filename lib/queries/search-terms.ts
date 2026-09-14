import { normalizePhone } from "@/lib/integrations/http";

/**
 * ═══════════ TỪ KHOÁ NGƯỜI GÕ PHẢI ĐƯỢC CHUẨN HOÁ NHƯ LÚC GHI ═══════════
 *
 * ─── LỖI ĐÃ SỬA ───
 *
 * `normalizePhone` (`lib/integrations/http.ts`) được áp ở đường GHI: mapper Pancake chuẩn hoá
 * `receiverPhone`, `billPhone`, `shipPhone` trước khi lưu, nên trong CSDL số điện thoại luôn ở
 * dạng `0xxxxxxxxx`.
 *
 * Nhưng đường ĐỌC thì không. Ô tìm kiếm ghép thẳng chuỗi người gõ vào `ilike '%…%'`. Hệ quả: chủ
 * shop copy số từ Pancake hay từ tin nhắn — nơi số thường ở dạng `+84 912 345 678` hoặc
 * `84912345678` — dán vào ô tìm và màn hình trả về RỖNG, trong khi vận đơn nằm ngay đó.
 *
 * Đây là kiểu hỏng tệ nhất của một ô tìm kiếm: nó không báo lỗi, chỉ nói "không có gì". Người
 * dùng kết luận ERP thiếu dữ liệu, rồi đi tạo lại một bản ghi đã tồn tại.
 *
 * ─── CÁCH SỬA: SINH RA CÁC BIẾN THỂ, KHÔNG ĐOÁN MỘT CÁI ───
 *
 * Hàm này trả về TẬP các chuỗi đáng tìm cho một từ khoá. Tìm theo cả bản gốc lẫn bản chuẩn hoá:
 * chuẩn hoá quá tay sẽ làm hỏng việc tìm mã vận đơn (có chữ và số), nên bản gốc luôn nằm trong tập.
 */

/** Một từ khoá trông như số điện thoại Việt Nam sau khi bỏ mọi ký tự không phải chữ số. */
export function looksLikePhone(term: string): boolean {
  const digits = term.replace(/[^\d]/g, "");
  // 9–11 chữ số phủ `912345678` · `0912345678` · `84912345678`. Ngắn hơn là một phần mã đơn; dài
  // hơn thì không phải số điện thoại (mã quảng cáo Facebook dài 15–20 số).
  return digits.length >= 9 && digits.length <= 11 && /^[\d\s+.()-]+$/.test(term.trim());
}

/**
 * Các dạng của một số điện thoại đáng đem đi so.
 *
 * Dữ liệu ĐANG lưu ở dạng `0xxxxxxxxx`, nhưng bảng cũ (nhập trước khi có chuẩn hoá) vẫn có thể
 * còn dạng khác, nên trả về cả ba: bản chuẩn, bản `84…`, và chín số cuối. Chín số cuối là phần
 * BẤT BIẾN của mọi cách viết — đây mới là thứ khớp được một dòng đã lưu sai chuẩn.
 */
export function phoneVariants(term: string): string[] {
  const chuan = normalizePhone(term.trim());
  const so = chuan.replace(/[^\d]/g, "");
  const duoi9 = so.length >= 9 ? so.slice(-9) : "";
  const bien = new Set<string>();
  if (chuan) bien.add(chuan);
  if (duoi9) {
    bien.add(duoi9);
    bien.add(`0${duoi9}`);
    bien.add(`84${duoi9}`);
  }
  return [...bien].filter(Boolean);
}

export type SearchTerm = {
  /** Chuỗi người gõ, đã cắt khoảng trắng hai đầu. Luôn được tìm. */
  raw: string;
  /** Trông như số điện thoại ⇒ tìm thêm theo các biến thể. */
  isPhone: boolean;
  phones: string[];
  /**
   * Số nguyên dương sau khi bỏ `#` — mã đơn hiển thị trên giao diện (`#3461`).
   * `null` khi từ khoá không phải một con số.
   */
  orderNo: number | null;
};

/**
 * `orders.system_id` là kiểu `integer` của Postgres — trần 2.147.483.647.
 *
 * Không chặn trần ở đây thì một số điện thoại gõ dạng `84912345678` sẽ được đem so với cột đó và
 * Postgres BÁO LỖI `22003: value out of range for type integer` — tức ô tìm kiếm không trả về
 * danh sách rỗng mà làm đổ cả trang. Bài kiểm bắt được đúng ca này.
 */
const MAX_SYSTEM_ID = 2_147_483_647;

export function parseSearchTerm(q: string): SearchTerm | null {
  const raw = q.trim();
  if (!raw) return null;
  const isPhone = looksLikePhone(raw);
  const n = Number(raw.replace(/^#/, "").trim());
  /*
    Trông như SỐ ĐIỆN THOẠI thì KHÔNG phải mã đơn.

    `system_id` là một bộ đếm tăng dần (mã đơn thật đang ở mức bốn chữ số), nên một chuỗi 9–11 chữ
    số gần như chắc chắn là số điện thoại. Đem nó đi so với mã đơn vừa vô nghĩa vừa tràn kiểu.
  */
  const laSoNguyenHopLe = Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= MAX_SYSTEM_ID;
  const orderNo = laSoNguyenHopLe && !isPhone ? n : null;
  return { raw, isPhone, phones: isPhone ? phoneVariants(raw) : [], orderNo };
}

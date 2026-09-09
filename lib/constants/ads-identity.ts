/**
 * ───────────── DANH TÍNH QUẢNG CÁO: MỘT CHỖ CHUẨN HOÁ DUY NHẤT ─────────────
 *
 * ĐỊNH DẠNG THẬT, đo trên production 09/09/2026:
 *
 * | Nguồn              | Ví dụ                                   | Nhận xét                    |
 * |--------------------|-----------------------------------------|-----------------------------|
 * | `orders.post_id`   | `1092821970588849_122125401075345176`   | 1.809/1.809 CÓ gạch dưới    |
 * | `fb_ads.post_id`   | `122104683968493325`                    | 99/99 toàn chữ số           |
 * | `fb_ads.story_id`  | `1089070007619448_122104683968493325`   | 99/99 CÓ gạch dưới          |
 * | `orders.ad_id`     | `120247872389140225`                    | toàn chữ số                 |
 *
 * Pancake ghi bài viết ở dạng ĐẦY ĐỦ `"<page_id>_<post_id>"`; Facebook trả
 * `effective_object_story_id` cũng dạng đó, và ERP lưu phần sau vào `fb_ads.post_id`.
 *
 * SỰ CỐ ĐÃ XẢY RA: so thẳng hai cột thì KHÔNG BAO GIỜ khớp — một bên có tiền tố trang, một bên
 * không. Truy vấn chạy, kiểu dữ liệu đúng, kiểm thử xanh, và kết quả luôn bằng 0.
 *
 * VÌ SAO PHẢI GOM VỀ MỘT CHỖ: chuẩn hoá rải rác trong từng truy vấn thì mỗi nơi sẽ lệch đi một
 * chút, và lệch kiểu đó không bao giờ báo lỗi — nó chỉ trả về ít kết quả hơn sự thật.
 */

/** Cắt tiền tố trang nếu có. Chuỗi không có gạch dưới trả về nguyên vẹn. */
const POST_KEY_PREFIX = /^.*_/;

/**
 * Quy một mã bài viết bất kỳ về KHOÁ CHUNG: phần sau dấu gạch dưới cuối cùng.
 *
 * Nhận cả hai định dạng, và cả rác:
 *  · `"1092821970588849_122125401075345176"` → `"122125401075345176"`
 *  · `"122125401075345176"`                  → `"122125401075345176"`
 *  · `null` / `""` / khoảng trắng            → `null`
 */
export function normalizePostKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const key = value.replace(POST_KEY_PREFIX, "").trim();
  return key || null;
}

/**
 * Khoá bài viết có DÙNG ĐƯỢC để nối hay không.
 *
 * Facebook đánh số bài bằng chữ số. Một khoá chứa ký tự khác là dữ liệu hỏng (nhập tay, cắt chuỗi
 * sai, hoặc mã nội bộ của hệ thống khác) — nối theo nó là gán doanh thu vào chỗ không có thật.
 * Cố ý KHÔNG cố cứu chuỗi hỏng: thà bỏ qua còn hơn nối nhầm.
 */
export function isUsablePostKey(key: string | null | undefined): boolean {
  return Boolean(key && /^\d{5,}$/.test(key));
}

/** Mã mẩu quảng cáo Facebook: toàn chữ số, đủ dài. */
export function isUsableAdId(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  return /^\d{5,}$/.test(value);
}

/**
 * BẢN SQL NẰM Ở `lib/queries/ads-identity-sql.ts`, KHÔNG nằm ở đây.
 *
 * Trước 10/09/2026 chỗ này có hai hằng số chuỗi `POST_KEY_SQL` / `USABLE_POST_KEY_SQL` mang đúng chú
 * thích "kiểm thử đối chiếu hai bản này để chúng không trôi khỏi nhau" — mà KHÔNG nơi nào dùng chúng,
 * và bài kiểm đó chưa từng được viết. Hai tệp truy vấn mỗi tệp tự chép tay một bản riêng, thành ba
 * bản không có gì buộc phải khớp.
 *
 * Nay bản SQL là biểu thức drizzle thật, dùng chung ở đúng một chỗ, và `tests/ads-identity.test.ts`
 * chạy cả hai bản trên cùng bộ dữ liệu để chứng minh chúng cho cùng kết quả.
 *
 * Tệp này (constants) cố ý KHÔNG import drizzle: client component được phép import nó.
 */

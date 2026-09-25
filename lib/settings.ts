import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Trộn giá trị đã lưu (`settings.value`, TEXT chứa JSON) với mặc định — hàm THUẦN, dùng chung cho
 * `getSettingJson` và kiểm thử.
 *
 *  · Mặc định là OBJECT (kể cả mảng) ⇒ Y NGUYÊN luật cũ `{ ...fallback, ...parsed }`, cho MỌI giá trị đã
 *    lưu. Mọi khoá cấu hình dạng object đang chạy đọc ra đúng như trước — kiểm thử so từng lời gọi.
 *  · Mặc định là giá trị NGUYÊN THUỶ (boolean / số / chuỗi) hoặc `null` (Company OS · Agent K): luật cũ
 *    trải `{ ...false, ...true }` ra `{}`, nên một cờ boolean KHÔNG BAO GIỜ đọc được (Agent C phải đọc
 *    thẳng dòng để né — handoff-c). Nay:
 *      – đã lưu giá trị nguyên thuỷ CÙNG KIỂU với mặc định (hoặc mặc định `null`) ⇒ trả đúng giá trị đó;
 *      – khác kiểu (chuỗi `"true"` cho một cờ boolean), JSON `null`, JSON hỏng ⇒ mặc định. Không ép kiểu:
 *        đoán `"true"` là `true` là để một dòng gõ tay bật một cờ mà không ai định bật;
 *      – đã lưu một object với mặc định nguyên thuỷ / `null` ⇒ luật cũ (không đổi).
 */
export function mergeSettingJson<T>(raw: string, fallback: T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const macDinhLaObject = fallback !== null && typeof fallback === "object";
  const daLuuNguyenThuy = parsed === null || typeof parsed !== "object";
  if (!macDinhLaObject && daLuuNguyenThuy) {
    if (parsed === null) return fallback;
    return fallback === null || typeof parsed === typeof fallback ? (parsed as T) : fallback;
  }
  return { ...fallback, ...(parsed as Partial<T>) } as T;
}

/** Đọc cấu hình JSON lưu trong bảng settings. Lỗi CSDL / không có dòng ⇒ `fallback`. */
export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) }).catch(() => null);
  if (!row) return fallback;
  return mergeSettingJson(row.value, fallback);
}

export async function setSettingJson(key: string, value: unknown) {
  const db = await getDb();
  const text = JSON.stringify(value);
  await db
    .insert(schema.settings)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
}

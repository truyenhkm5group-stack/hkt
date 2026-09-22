import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/** Đọc cấu hình JSON lưu trong bảng settings */
export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) }).catch(() => null);
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as Partial<T>) } as T;
  } catch {
    return fallback;
  }
}

/**
 * ═══════════ ĐỌC NGUYÊN VẸN, KHÔNG TRỘN ═══════════
 *
 * `getSettingJson` TRỘN giá trị đã lưu vào `fallback` (`{ ...fallback, ...đãLưu }`). Với một
 * object cấu hình thì đó là tính năng: khoá mới thêm vào mã nguồn tự có mặc định mà không phải
 * ghi lại cả object.
 *
 * Với MẢNG hoặc CHUỖI thì đó là một cái bẫy im lặng: phép trải một mảng vào object literal cho ra
 * `{0: "…", 1: "…"}`, và một chuỗi cho ra `{0: "A", 1: "I", …}`. `Array.isArray()` trả `false`,
 * `typeof === "string"` trả `false`, nên nơi gọi rơi về mặc định — cấu hình đã ghi vào CSDL
 * nhưng KHÔNG BAO GIỜ có hiệu lực, và không có lỗi nào để lần theo.
 *
 * Đã cắn thật hai lần trong một ngày (23/09/2026): `ai.botSenderNames` (mảng) ghi xong mà ERP vẫn
 * gọi bot là nhân viên, và `ai.handoverMode` (chuỗi) ghi xong mà dây chuyền vẫn chạy chế độ cũ.
 *
 * Hàm này trả về ĐÚNG thứ đã lưu. Dùng nó cho mọi cấu hình KHÔNG phải object.
 */
export async function getSettingValue<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) }).catch(() => null);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSettingJson(key: string, value: unknown) {
  const db = await getDb();
  const text = JSON.stringify(value);
  await db
    .insert(schema.settings)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
}

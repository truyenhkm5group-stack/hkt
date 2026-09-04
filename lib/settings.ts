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

export async function setSettingJson(key: string, value: unknown) {
  const db = await getDb();
  const text = JSON.stringify(value);
  await db
    .insert(schema.settings)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
}

import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@/db";

/** Một giao dịch ĐANG MỞ của drizzle (đối số của `db.transaction(async (tx) => …)`). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Kết nối HOẶC một giao dịch đang mở của nơi gọi. */
export type DbOrTx = Db | DbTx;

/**
 * `db` có phải một giao dịch đang mở không (Company OS · Agent K).
 *
 * Kiểm bằng `is()` của drizzle (so `entityKind` dọc chuỗi nguyên mẫu), KHÔNG bằng `instanceof`: dưới
 * tsx / Next, `drizzle-orm/pg-core` có thể được nạp HAI bản (ESM qua `import()` động trong `db/index.ts`
 * và CJS ở tệp gọi), nên `tx instanceof PgTransaction` trả `false` cho một giao dịch thật — đã đo trên
 * PGlite. Và không bằng một cờ do nơi gọi tự khai: khai nhầm "không phải giao dịch" là mở savepoint lồng,
 * khai nhầm "là giao dịch" là ghi ngoài giao dịch.
 */
export function isOpenTransaction(db: DbOrTx): db is DbTx {
  return is(db, PgTransaction);
}

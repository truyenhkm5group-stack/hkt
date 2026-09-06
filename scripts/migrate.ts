/**
 * Áp dụng migration khi container khởi động.
 *
 * Thay cho `npx drizzle-kit migrate`: drizzle-kit chỉ in spinner rồi thoát khác 0 khi lỗi,
 * KHÔNG in câu lệnh SQL nào hỏng — đã làm ERP sập mà không ai biết vì sao.
 * Script này dùng đúng migrator của drizzle-orm (giống `ensureMigrated` lúc chạy app) và in
 * đầy đủ các trường lỗi của PostgreSQL (code, detail, hint, position, where, internalQuery…)
 * để chẩn đoán được ngay trong `docker compose logs app`.
 */
import { ensureMigrated } from "@/db/migrate";
import { databaseUrl } from "@/db";

/** Các trường lỗi node-postgres/PostgreSQL đáng in ra khi migration hỏng. */
const PG_ERROR_FIELDS = [
  "severity", "code", "detail", "hint", "position", "internalPosition",
  "internalQuery", "where", "schema", "table", "column", "dataType",
  "constraint", "file", "line", "routine",
] as const;

function describe(error: unknown, depth = 0): string {
  if (!error || depth > 4) return "";
  const lines: string[] = [];
  if (error instanceof Error) {
    lines.push(`${depth ? "nguyên nhân: " : "lỗi: "}${error.message}`);
  } else {
    lines.push(String(error));
  }
  const record = error as Record<string, unknown>;
  for (const field of PG_ERROR_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== "") lines.push(`  ${field}: ${String(value)}`);
  }
  const cause = record.cause;
  if (cause) lines.push(describe(cause, depth + 1));
  return lines.filter(Boolean).join("\n");
}

async function main() {
  const url = databaseUrl();
  // Không in mật khẩu ra log.
  console.log(`[migrate] CSDL: ${url.replace(/:\/\/[^@]*@/, "://***@") || "(chưa cấu hình)"}`);
  try {
    await ensureMigrated();
    console.log("[migrate] ✓ Migration đã áp dụng xong.");
    process.exit(0);
  } catch (error) {
    console.error("======================================================================");
    console.error("[migrate] MIGRATION THẤT BẠI — container sẽ thoát và bị restart lặp.");
    console.error("[migrate] ERP sẽ KHÔNG phục vụ được cho tới khi migration chạy xong.");
    console.error(describe(error));
    console.error("======================================================================");
    process.exit(1);
  }
}

main();

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { latestCustomerTurnUnhandledFor, latestWebTurnUnhandledFor } from "@/lib/sales-chatbot/response-ownership-ledger";

/**
 * ═══════════ BẢN CSDL CỦA ĐỊNH NGHĨA #803 — DỰNG TỪ CHÍNH HÀM TYPESCRIPT (P0 inbox-unread-perf) ═══════════
 *
 * Trigger 0245 lưu kết quả của `latestCustomerTurnUnhandledFor` / `latestWebTurnUnhandledFor` (response-ownership #803) vào một cột kết
 * quả của hội thoại. Trigger không gọi được TypeScript, nên migration giữ HAI hàm SQL mà thân là ĐÚNG câu SQL các hàm TS dựng ra — tham số
 * gắn thẳng thành hằng, đầu vào là tên tham số của hàm CSDL (`p_page` · `p_thread` · `p_conv` · `p_seen`). Tệp này là MỘT chỗ dựng câu ấy:
 * bài kiểm (tests/inbox-unread-perf.test.ts) so thân hàm trong migration với `renderTurnUnhandledSql()` từng ký tự (sau khi gộp khoảng
 * trắng) — #803 đổi định nghĩa mà migration chưa theo thì bài kiểm đỏ, không có chuyện hai bản lệch nhau trong im lặng.
 * Không gọi ở đường chạy của ứng dụng.
 */

const dialect = new PgDialect();

/** Gắn tham số `$n` thành hằng SQL (chuỗi trong nháy đơn, số giữ nguyên). HÀM THUẦN. */
export function inlineParams(text: string, params: readonly unknown[]): string {
  let out = text;
  for (let i = params.length; i >= 1; i -= 1) {
    const v = params[i - 1];
    const lit = typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
    out = out.split(`$${i}`).join(lit);
  }
  return out;
}

function render(q: SQL): string {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return inlineParams(text, params);
}

/** Thân hai hàm CSDL của migration 0245 — dựng từ hàm TS của #803. */
export function renderTurnUnhandledSql(): { thread: string; web: string } {
  return {
    thread: render(latestCustomerTurnUnhandledFor(sql.raw("p_page"), sql.raw("p_thread"), sql.raw("p_seen"))),
    web: render(latestWebTurnUnhandledFor(sql.raw("p_conv"), sql.raw("p_seen"))),
  };
}

/** Gộp khoảng trắng để so hai câu SQL. HÀM THUẦN. */
export function normalizeSql(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * EXPLAIN ANALYZE cho truy vấn SỔ KHO — câu chậm nhất của trang chủ.
 *
 * Bốn vòng chẩn đoán trước đều dừng ở "câu này 40 giây" rồi đoán tiếp. Kế hoạch thực thi là thứ duy
 * nhất trả lời được VÌ SAO: quét tuần tự hay dùng chỉ mục, chạy một lần hay chạy lại cho từng dòng.
 *
 * Dựng câu lệnh bằng CHÍNH mã của ứng dụng (`listProductsForStock` / `stockRiskSummary`), không chép
 * tay lại SQL — chép tay thì đo một câu khác với câu đang chạy thật.
 *
 * CHỈ ĐỌC: `EXPLAIN ANALYZE` có chạy thật câu lệnh, nhưng đây là `select` nên không ghi gì.
 */
import { getDb } from "@/db";
import { variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { sql } from "drizzle-orm";

function rowsOf<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}

async function main() {
  const db = await getDb();

  // Chỉ riêng bảng dẫn xuất phía ĐƠN HÀNG — nghi phạm chính.
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);

  for (const [ten, truyVan] of [
    ["vsales (đơn hàng → mẫu mã)", db.select().from(sales)],
    ["vreceipts (phiếu kho → mẫu mã)", db.select().from(receipts)],
  ] as const) {
    const { sql: text, params } = truyVan.toSQL();
    const t0 = Date.now();
    const plan = await db.execute(sql.raw(`explain (analyze, buffers, timing) ${bind(text, params)}`));
    const dong = rowsOf<Record<string, string>>(plan).map((r) => Object.values(r)[0]);
    console.log(`\n══════ ${ten} — ${Date.now() - t0}ms ══════`);
    console.log(dong.join("\n"));
  }
  process.exit(0);
}

/**
 * Nhúng tham số vào câu lệnh để `explain` chạy được.
 *
 * `EXPLAIN` không nhận tham số rời, mà mục đích ở đây là ĐỌC KẾ HOẠCH chứ không phải chạy an toàn —
 * script này chỉ chạy tay trên ops, không nằm trên đường của người dùng.
 */
function bind(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return String(v);
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

main().catch((error) => {
  console.error("explain-stock lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

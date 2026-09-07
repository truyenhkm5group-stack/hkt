/**
 * Xem bố cục thật của một tệp bảng kê đã lưu trong `vtp_statement_files`.
 *
 * Dùng để biết chính xác tệp Viettel Post gửi qua email chứa những gì (mã bảng kê, ngày về tiền,
 * các phần chi tiết) thay vì đoán. Chỉ ĐỌC, không ghi gì.
 *
 * Dùng:
 *   npx tsx scripts/vtp-statement-peek.ts                    # liệt kê tệp đang giữ
 *   npx tsx scripts/vtp-statement-peek.ts <phần tên tệp>     # in 30 dòng đầu của tệp khớp tên
 *   npx tsx scripts/vtp-statement-peek.ts <tên> --rows=60
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { sheetMatrix } from "@/lib/integrations/viettelpost/statement";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const soDong = Number(process.argv.find((a) => a.startsWith("--rows="))?.slice(7)) || 30;
  const db = await getDb();

  if (!args.length) {
    const rows = await db
      .select({ filename: schema.vtpStatementFiles.filename, kind: schema.vtpStatementFiles.kind, bytes: schema.vtpStatementFiles.bytes, rows: schema.vtpStatementFiles.rows, receivedAt: schema.vtpStatementFiles.receivedAt })
      .from(schema.vtpStatementFiles)
      .orderBy(schema.vtpStatementFiles.receivedAt);
    console.log(JSON.stringify({ so_tep: rows.length, tep: rows }, null, 2));
    return;
  }

  const [file] = await db
    .select({ filename: schema.vtpStatementFiles.filename, content: schema.vtpStatementFiles.content })
    .from(schema.vtpStatementFiles)
    .where(sql`${schema.vtpStatementFiles.filename} ilike ${`%${args[0]}%`}`)
    .limit(1);
  if (!file) {
    console.log(`Không có tệp nào khớp "${args[0]}"`);
    return;
  }

  const buffer = Buffer.from(file.content, "base64");
  const matrix = sheetMatrix(buffer, false, true);
  console.log(`Tệp: ${file.filename} · ${matrix.length} dòng`);
  for (const [i, row] of matrix.slice(0, soDong).entries()) {
    const cells = (row as unknown[]).map((c) => String(c ?? "").trim()).map((c: string) => (c.length > 34 ? `${c.slice(0, 34)}…` : c));
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) console.log(String(i).padStart(3), "|", cells.join(" | "));
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

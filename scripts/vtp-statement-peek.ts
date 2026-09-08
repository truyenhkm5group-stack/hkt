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
 *   npx tsx scripts/vtp-statement-peek.ts <tên> --find=PKE1484463365,PKE1508295104
 *
 * `--find` trả lời đúng một câu: tệp này CÓ chứa những mã đó hay không. Cần khi phải phân biệt
 * "nhập hỏng" với "tệp vốn đã thiếu dòng" — hai nguyên nhân đòi hai cách sửa hoàn toàn khác nhau.
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import * as XLSX from "xlsx";

/**
 * Đọc bảng tính thành ma trận. Cố ý KHÔNG dùng lại hàm trong lib: script vận hành được tải mới
 * từ GitHub còn lib thì nằm trong bản dựng đang chạy, nên phụ thuộc vào lib sẽ hỏng mỗi khi hai
 * bên lệch phiên bản. Viettel Post khai sai vùng dữ liệu nên phải mở rộng vùng trước khi đọc.
 */
function docBang(input: Buffer): unknown[][] {
  const wb = XLSX.read(input, { type: "buffer", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  let maxRow = 0;
  let maxCol = 0;
  for (const key of Object.keys(ws)) {
    if (key.startsWith("!")) continue;
    const cell = XLSX.utils.decode_cell(key);
    maxRow = Math.max(maxRow, cell.r);
    maxCol = Math.max(maxCol, cell.c);
  }
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
}

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
  const matrix = docBang(buffer);
  console.log(`Tệp: ${file.filename} · ${matrix.length} dòng`);

  const canTim = (process.argv.find((a) => a.startsWith("--find="))?.slice(7) ?? "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (canTim.length) {
    const oCua = new Map<string, number[]>();
    for (const [i, row] of matrix.entries()) {
      for (const cell of row as unknown[]) {
        const value = String(cell ?? "").trim().toUpperCase();
        if (!value) continue;
        for (const ma of canTim) if (value === ma || value.includes(ma)) (oCua.get(ma) ?? oCua.set(ma, []).get(ma)!).push(i);
      }
    }
    for (const ma of canTim) {
      const dong = oCua.get(ma) ?? [];
      if (!dong.length) { console.log(`✗ ${ma}: KHÔNG có trong tệp`); continue; }
      console.log(`✓ ${ma}: có ở dòng ${dong.join(", ")}`);
      for (const i of dong.slice(0, 2)) {
        const cells = (matrix[i] as unknown[]).map((c) => String(c ?? "").trim()).map((c) => (c.length > 30 ? `${c.slice(0, 30)}…` : c));
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        console.log("   ", cells.join(" | "));
      }
    }
    return;
  }
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

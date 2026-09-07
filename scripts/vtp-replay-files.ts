/**
 * PHÁT LẠI các tệp Viettel Post đã lưu (bảng `vtp_statement_files`).
 *
 * Dùng khi ERP sửa cách đọc tệp hoặc sửa cách ghi tiền: chạy lại trên đúng tệp gốc đã nhận, không
 * phải vào Gmail gỡ nhãn "đã nhập" để xin Apps Script gửi lại. Lần nhập là idempotent — mỗi
 * (tệp × mã vận đơn) một dòng trong sổ chứng từ nên phát lại bao nhiêu lần cũng ra một kết quả.
 *
 * Dùng:
 *   npx tsx scripts/vtp-replay-files.ts             # liệt kê tệp đang giữ, không nhập
 *   npx tsx scripts/vtp-replay-files.ts --apply     # phát lại toàn bộ
 *   npx tsx scripts/vtp-replay-files.ts --apply --like=BangKeChiCOD   # chỉ tệp khớp tên
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { runVtpDataFileImport } from "@/lib/integrations/viettelpost/import-run";

async function main() {
  const apply = process.argv.includes("--apply");
  const like = process.argv.find((a) => a.startsWith("--like="))?.slice(7) ?? "";
  const db = await getDb();

  const files = await db
    .select({ filename: schema.vtpStatementFiles.filename, content: schema.vtpStatementFiles.content, kind: schema.vtpStatementFiles.kind, bytes: schema.vtpStatementFiles.bytes, receivedAt: schema.vtpStatementFiles.receivedAt })
    .from(schema.vtpStatementFiles)
    .where(like ? sql`${schema.vtpStatementFiles.filename} ilike ${`%${like}%`}` : sql`true`)
    .orderBy(schema.vtpStatementFiles.receivedAt);

  if (!files.length) {
    console.log(JSON.stringify({ so_tep: 0, ghi_chu: "Chưa giữ tệp nào. Tệp chỉ được giữ từ lần nhập sau khi tính năng này lên." }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    che_do: apply ? "PHAT LAI" : "CHI LIET KE",
    so_tep: files.length,
    tep: files.map((f) => ({ ten: f.filename, loai: f.kind, kb: Math.round(f.bytes / 1024), nhan_luc: f.receivedAt })),
  }, null, 2));

  if (!apply) {
    console.log("\nChưa nhập gì. Thêm --apply để phát lại.");
    return;
  }

  // Phát lại theo THỨ TỰ NHẬN, từ cũ tới mới. Sổ chứng từ đã chống lệ thuộc thứ tự, nhưng chạy
  // theo trình tự tự nhiên vẫn dễ đọc nhật ký hơn khi cần dò lại.
  const ketQua = [];
  for (const f of files) {
    try {
      const r = await runVtpDataFileImport([{ filename: f.filename, base64: f.content }], "REPLAY:vtp-files");
      ketQua.push({ ten: f.filename, ...r.files[0] });
    } catch (e) {
      ketQua.push({ ten: f.filename, loi: e instanceof Error ? e.message : String(e) });
    }
  }
  const [tong] = (await db.execute(sql`
    select count(*) dong_so, count(*) filter (where shipment_id is not null) dong_ghep_duoc,
           coalesce(sum(cod) filter (where shipment_id is not null), 0) cod_ghep_duoc
    from cod_statement_lines
  `)) as unknown as Record<string, unknown>[];
  console.log(JSON.stringify({ da_phat_lai: ketQua, so_chung_tu: tong }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

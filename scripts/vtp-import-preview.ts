/**
 * ═══════════ CHẠY THỬ MỘT TỆP VIETTEL POST TRÊN DỮ LIỆU THẬT — KHÔNG GHI GÌ ═══════════
 *
 * ─── VÌ SAO CẦN CHẠY ĐƯỢC TỪ OPS ───
 *
 * Bước xem trước đã có trên giao diện (`/import-vtp`), nhưng nó đòi một phiên đăng nhập và một
 * tệp trong tay. Khi cần trả lời câu "đường nhập tệp trên MÁY CHỦ THẬT còn đọc đúng không" — sau
 * một lần phát hành, hoặc khi nghi Viettel Post đổi bố cục tệp — thì phải có đường chạy không
 * người, trên chính những tệp shop đã nạp (`vtp_statement_files`, hiện có 21 tệp).
 *
 * TUYỆT ĐỐI CHỈ ĐỌC với `shipments` và `shipment_events`: nó gọi `previewVtpOrderListFile()`, cùng
 * hàm mà màn hình xem trước dùng, nên không có đường nào khác để nó ghi nhầm. Dòng duy nhất được
 * tạo là một bản ghi `vtp_import_batches` ở chế độ `PREVIEW` — đúng thiết kế: chạy thử cũng phải
 * để lại vết, vì nó trả lời câu "ai đã xem tệp này và thấy gì" khi con số gây tranh cãi.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/vtp-import-preview.ts [phần tên tệp]
 *   (bỏ trống ⇒ liệt kê các tệp đã lưu rồi chạy thử tệp DANH SÁCH VẬN ĐƠN mới nhất)
 */
import "dotenv/config";
import { desc, ilike } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { previewVtpOrderListFile, ghiSoNhapTep } from "@/lib/integrations/viettelpost/import-preview";
import { PREVIEW_VERDICT_LABEL, PREVIEW_VERDICT_ORDER } from "@/lib/constants/vtp-import";

async function main() {
  const loc = (process.argv[2] ?? "").trim();
  const db = await getDb();

  const files = await db
    .select({ filename: schema.vtpStatementFiles.filename, kind: schema.vtpStatementFiles.kind, rows: schema.vtpStatementFiles.rows, bytes: schema.vtpStatementFiles.bytes })
    .from(schema.vtpStatementFiles)
    .where(loc ? ilike(schema.vtpStatementFiles.filename, `%${loc}%`) : undefined)
    .orderBy(desc(schema.vtpStatementFiles.receivedAt))
    .limit(30);

  console.log(`═══ TỆP VIETTEL POST ĐÃ LƯU (${files.length}) ═══`);
  for (const f of files) console.log(`  ${(f.kind ?? "?").padEnd(18)} ${String(f.rows ?? "?").padStart(6)} dòng  ${f.filename}`);

  // Ưu tiên tệp DANH SÁCH VẬN ĐƠN: đó là tệp mang TRẠNG THÁI GIAO. Tệp bảng kê mang TIỀN và đi
  // đường đối soát COD riêng — màn hình xem trước cố ý từ chối nó kèm lý do.
  const chon = files.find((f) => f.kind === "ORDER_LIST") ?? files[0];
  if (!chon) {
    console.log("Không có tệp nào để chạy thử.");
    process.exit(0);
  }

  const [row] = await db
    .select({ filename: schema.vtpStatementFiles.filename, content: schema.vtpStatementFiles.content })
    .from(schema.vtpStatementFiles)
    .where(ilike(schema.vtpStatementFiles.filename, chon.filename))
    .limit(1);
  if (!row?.content) {
    console.log(`Tệp ${chon.filename} không còn nội dung gốc.`);
    process.exit(0);
  }

  console.log(`\n═══ CHẠY THỬ: ${row.filename} ═══`);
  const xem = await previewVtpOrderListFile({ filename: row.filename, base64: row.content });

  console.log(`loại tệp   : ${xem.kind}`);
  console.log(`số dòng    : ${xem.rows}`);
  console.log(`mã tệp     : ${xem.checksum.slice(0, 16)}…`);
  if (xem.error) console.log(`LÝ DO DỪNG : ${xem.error}`);
  console.log(`đã ghi lần trước: ${xem.previouslyAppliedAt ? xem.previouslyAppliedAt.toISOString() : "chưa bao giờ"}`);

  if (!xem.error) {
    console.log(`\n── PHÁN QUYẾT TỪNG DÒNG ──`);
    for (const v of PREVIEW_VERDICT_ORDER) {
      if (xem.counts[v] > 0) console.log(`  ${PREVIEW_VERDICT_LABEL[v].padEnd(28)} ${xem.counts[v]}`);
    }
    console.log(`\n── MẪU (tối đa 8 dòng KHÁC với thứ ERP đang giữ) ──`);
    for (const r of xem.sample.slice(0, 8)) {
      console.log(`  ${r.trackingCode.padEnd(16)} ${PREVIEW_VERDICT_LABEL[r.verdict].padEnd(24)} VTP:"${r.fileStatusText}" @${r.fileStatusAt ?? "-"}  ERP:${r.erpStage ?? "-"}`);
    }
  }

  // Chạy thử CŨNG vào sổ — cùng một đường mà màn hình dùng.
  const id = await ghiSoNhapTep({
    filename: xem.filename,
    checksum: xem.checksum,
    bytes: xem.bytes,
    kind: xem.kind,
    mode: "PREVIEW",
    uploadedBy: "OPS:vtp-import-preview",
    uploadedById: null,
    rows: xem.rows,
    stale: xem.counts.OLDER,
    duplicates: xem.counts.DUPLICATE_ROW,
    conflicts: xem.counts.AMBIGUOUS,
    unmatched: xem.counts.UNMATCHED,
    unknownStatus: xem.counts.UNKNOWN_STATUS,
    invalid: xem.counts.INVALID,
    error: xem.error,
    summary: { counts: xem.counts },
  }).catch((e: unknown) => `lỗi ghi sổ: ${e instanceof Error ? e.message : e}`);
  console.log(`\nĐã ghi một dòng CHẠY THỬ vào sổ lần nhập: ${id}`);
  console.log("KHÔNG một vận đơn hay sự kiện hành trình nào bị thay đổi.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

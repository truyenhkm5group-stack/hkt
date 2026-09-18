import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * ═══════════ SỔ LẦN NHẬP: ĐỌC LẠI ĐƯỢC THÌ MỚI LÀ SỔ ═══════════
 *
 * `vtp_import_batches` đã ghi từ bản trước, nhưng chưa màn hình nào đọc nó. Một cuốn sổ không ai mở
 * được thì tương đương không có sổ: câu hỏi nó sinh ra để trả lời — *"con số này tới từ lần nhập
 * nào, ai bấm, và lần ấy thấy gì"* — vẫn phải mở CSDL mới trả lời được.
 *
 * Chạy thử (`PREVIEW`) hiện CÙNG bảng với lần ghi thật, có nhãn riêng. Cố ý: nó trả lời câu "hôm
 * qua ai đã xem trước tệp này và thấy gì" khi con số sau đó gây tranh cãi — và người đọc phải
 * phân biệt được ngay lượt nào đã đổi dữ liệu, lượt nào không.
 */

export type ImportBatchRow = {
  id: string;
  filename: string;
  checksum: string;
  kind: string;
  mode: string;
  uploadedBy: string;
  rows: number;
  applied: number;
  matched: number;
  stale: number;
  duplicates: number;
  conflicts: number;
  unmatched: number;
  unknownStatus: number;
  invalid: number;
  checked: number;
  webhookOk: number;
  webhookGaps: number;
  error: string | null;
  createdAt: Date;
};

export async function listVtpImportBatches(limit = 30): Promise<ImportBatchRow[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.vtpImportBatches).orderBy(desc(schema.vtpImportBatches.createdAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    checksum: r.checksum,
    kind: r.kind,
    mode: r.mode,
    uploadedBy: r.uploadedBy,
    rows: r.rows,
    applied: r.applied,
    matched: r.matched,
    stale: r.stale,
    duplicates: r.duplicates,
    conflicts: r.conflicts,
    unmatched: r.unmatched,
    unknownStatus: r.unknownStatus,
    invalid: r.invalid,
    checked: r.checked,
    webhookOk: r.webhookOk,
    webhookGaps: r.webhookGaps,
    error: r.error,
    createdAt: r.createdAt,
  }));
}

export type ImportBatchDetail = {
  batch: ImportBatchRow;
  summary: unknown;
  /**
   * Những khoảng hụt webhook mà CHÍNH lần nhập này tìm ra. Đây là lý do dòng sổ phải được lập
   * TRƯỚC khi ghi: lập sau thì các dòng này mồ côi và câu "lần nhập nào phát hiện ra" — thứ duy
   * nhất làm phép đo tra lại được — không trả lời được nữa.
   */
  gaps: {
    trackingCode: string;
    carrierStatusText: string;
    carrierEventAt: Date;
    erpKnewAt: Date | null;
    erpKnewSource: string | null;
    gapMinutes: number;
    severity: string;
  }[];
  /** Lần nhập khác mang CÙNG nội dung tệp (checksum), để thấy ngay tệp này đã chạy mấy lượt. */
  sameFile: { id: string; mode: string; createdAt: Date; uploadedBy: string }[];
};

export async function getVtpImportBatch(id: string): Promise<ImportBatchDetail | null> {
  const db = await getDb();
  const row = await db.query.vtpImportBatches.findFirst({ where: eq(schema.vtpImportBatches.id, id) });
  if (!row) return null;
  const [gaps, sameFile] = await Promise.all([
    db
      .select({
        trackingCode: schema.vtpWebhookGaps.trackingCode,
        carrierStatusText: schema.vtpWebhookGaps.carrierStatusText,
        carrierEventAt: schema.vtpWebhookGaps.carrierEventAt,
        erpKnewAt: schema.vtpWebhookGaps.erpKnewAt,
        erpKnewSource: schema.vtpWebhookGaps.erpKnewSource,
        gapMinutes: schema.vtpWebhookGaps.gapMinutes,
        severity: schema.vtpWebhookGaps.severity,
      })
      .from(schema.vtpWebhookGaps)
      .where(eq(schema.vtpWebhookGaps.batchId, id))
      .orderBy(desc(schema.vtpWebhookGaps.gapMinutes))
      .limit(100),
    db
      .select({ id: schema.vtpImportBatches.id, mode: schema.vtpImportBatches.mode, createdAt: schema.vtpImportBatches.createdAt, uploadedBy: schema.vtpImportBatches.uploadedBy })
      .from(schema.vtpImportBatches)
      // Danh tính một tệp là CHECKSUM của nội dung, không phải tên: Viettel Post đặt tên theo
      // khoảng ngày nên hai lần tải cùng khoảng cho ra cùng TÊN với nội dung khác nhau.
      .where(sql`${schema.vtpImportBatches.checksum} = ${row.checksum} and ${schema.vtpImportBatches.id} <> ${id}`)
      .orderBy(desc(schema.vtpImportBatches.createdAt))
      .limit(20),
  ]);
  const { summary, ...rest } = row;
  return { batch: rest as ImportBatchRow, summary, gaps, sameFile };
}

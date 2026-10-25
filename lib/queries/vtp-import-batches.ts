import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { gapWithinSkewSql } from "@/lib/constants/webhook-gap";

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
  /**
   * Dòng sổ hụt của lượt này nằm trong dung sai lệch đồng hồ tệp ↔ webhook (webhook-gap.ts, 25/10/2026) — đã cộng vào `webhookOk`,
   * trừ khỏi `webhookGaps` LÚC ĐỌC; bộ đếm ghi trên dòng sổ giữ nguyên. Lượt CHẠY THỬ không ghi dòng hụt nên không phân loại lại được.
   */
  skewReclassified: number;
  error: string | null;
  createdAt: Date;
};

/** Số dòng hụt của MỘT lượt nhập nằm trong dung sai lệch đồng hồ (bản SQL của erpKnewWithinSkew). */
const skewReclassifiedOf = sql<number>`(select count(*)::int from vtp_webhook_gaps g where g.batch_id = ${schema.vtpImportBatches.id} and ${sql.raw(gapWithinSkewSql("g"))})`;

export async function listVtpImportBatches(limit = 30): Promise<ImportBatchRow[]> {
  const db = await getDb();
  const rows = await db
    .select({ ...getTableColumns(schema.vtpImportBatches), lech: skewReclassifiedOf })
    .from(schema.vtpImportBatches)
    .orderBy(desc(schema.vtpImportBatches.createdAt))
    .limit(limit);
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
    webhookOk: r.webhookOk + Number(r.lech ?? 0),
    webhookGaps: Math.max(0, r.webhookGaps - Number(r.lech ?? 0)),
    skewReclassified: Number(r.lech ?? 0),
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
  const [row] = await db
    .select({ ...getTableColumns(schema.vtpImportBatches), lech: skewReclassifiedOf })
    .from(schema.vtpImportBatches)
    .where(eq(schema.vtpImportBatches.id, id))
    .limit(1);
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
      // Chỉ dòng hụt THẬT — dòng lệch đồng hồ trong dung sai đã được tính là «ERP đã biết» ở bộ đếm.
      .where(sql`${schema.vtpWebhookGaps.batchId} = ${id} and not ${sql.raw(gapWithinSkewSql("vtp_webhook_gaps"))}`)
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
  const { summary, lech, ...rest } = row;
  const n = Number(lech ?? 0);
  return { batch: { ...rest, webhookOk: rest.webhookOk + n, webhookGaps: Math.max(0, rest.webhookGaps - n), skewReclassified: n } as ImportBatchRow, summary, gaps, sameFile };
}

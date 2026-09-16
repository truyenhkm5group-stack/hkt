import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { vnStartOfDay } from "@/lib/format";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { detectVtpFile, mergeDetectedOrderLists, VtpFileError, type DetectedVtpFile } from "@/lib/integrations/viettelpost/import-files";
import { matchVtpOrderList, type OrderListMatch } from "@/lib/integrations/viettelpost/statement-db";
import type { ShipmentStage } from "@/db/schema";
import { PREVIEW_VERDICTS, type PreviewVerdict } from "@/lib/constants/vtp-import";

export type { PreviewVerdict };

/**
 * ═══════════ XEM TRƯỚC MỘT LẦN NHẬP TỆP VIETTEL POST ═══════════
 *
 * ─── VÌ SAO PHẢI CÓ BƯỚC NÀY ───
 *
 * Nhập tệp là đường CỨU khi webhook rơi và tài khoản API mù (audit RC-1). Nhưng nó cũng là đường
 * duy nhất mà một con người có thể, chỉ bằng một cú bấm, ghi đè trạng thái của hàng trăm vận đơn
 * bằng nội dung một tệp mà chưa ai đọc. Trước bản này ERP chỉ có "nhập" — không có "xem trước".
 *
 * Hàm này CHỈ ĐỌC. Nó dùng lại đúng trình đọc tệp (`detectVtpFile`) và đúng bộ ghép
 * (`matchVtpOrderList`) mà đường ghi dùng, nên con số xem trước và con số sau khi ghi không thể
 * lệch nhau vì hai luật khác nhau. Nếu muốn đổi cách ghép thì sửa ở đó, không sửa ở đây.
 *
 * ─── NÓ KHÔNG TRẢ LỜI CÂU "SẼ GHI BAO NHIÊU DÒNG" ───
 *
 * Nó trả lời "tệp này NÓI GÌ so với thứ ERP đang giữ". Con số cuối cùng có thể lệch một ít vì giữa
 * lúc xem và lúc ghi, một webhook có thể tới và đổi trạng thái — và khi đó việc ĐÚNG là dòng tệp
 * trở thành cũ hơn. Nói ra điều đó rõ ràng còn hơn hứa một con số không giữ được.
 */

export type PreviewRow = {
  trackingCode: string;
  orderLabel: string;
  verdict: PreviewVerdict;
  /** Chữ NGUYÊN VĂN của Viettel Post trong tệp — không thay bằng tên trong bảng mã của ERP. */
  fileStatusText: string;
  fileStage: ShipmentStage | null;
  fileStatusAt: string | null;
  erpStage: ShipmentStage | null;
  erpStatusAt: string | null;
  note: string;
};

export type ImportPreview = {
  filename: string;
  checksum: string;
  bytes: number;
  kind: "ORDER_LIST" | "STATEMENT_DETAIL" | "ERROR";
  rows: number;
  counts: Record<PreviewVerdict, number>;
  /** Mẫu dòng để người đọc kiểm chứng — không phải toàn bộ tệp. */
  sample: PreviewRow[];
  /** Lần nhập trước đã ÁP DỤNG đúng tệp này (theo checksum). Có nghĩa lần này sẽ không đổi gì mới. */
  previouslyAppliedAt: Date | null;
  error: string | null;
};

const RONG = Object.fromEntries(PREVIEW_VERDICTS.map((v) => [v, 0])) as Record<PreviewVerdict, number>;

/** SHA-256 của NỘI DUNG tệp — danh tính thật, không phụ thuộc tên tệp Viettel Post đặt. */
export function fileChecksum(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

/** Mốc ĐVVC của một dòng tệp, theo đúng luật mà đường ghi dùng. `null` = dòng không dùng được. */
function rowOccurredAt(m: OrderListMatch): Date | null {
  const at = m.statusAt ? new Date(m.statusAt) : m.statusDate ? vnStartOfDay(m.statusDate) : null;
  return at && Number.isFinite(at.getTime()) ? at : null;
}

function verdictOf(m: OrderListMatch, seen: Set<string>): { verdict: PreviewVerdict; note: string } {
  const at = rowOccurredAt(m);
  if (!at) return { verdict: "INVALID", note: "Không đọc được ngày trạng thái — dòng này sẽ bị bỏ qua" };
  if (m.matchIssue) return { verdict: "AMBIGUOUS", note: m.matchIssue };
  if (!m.shipmentId) return { verdict: "UNMATCHED", note: "ERP chưa có vận đơn mang mã này" };
  if (m.mapped.stage === "UNKNOWN") {
    return { verdict: "UNKNOWN_STATUS", note: `Chữ của ĐVVC được ghi vào sổ trạng thái để bổ sung bảng mã; trạng thái vận đơn giữ nguyên` };
  }
  const key = `${m.shipmentId}|${m.statusText}|${at.getTime()}`;
  if (seen.has(key)) return { verdict: "DUPLICATE_ROW", note: "Cùng vận đơn, cùng trạng thái, cùng mốc với một dòng khác trong tệp" };
  seen.add(key);
  const erpAt = m.currentStatusDate;
  if (erpAt && erpAt.getTime() > at.getTime()) {
    return { verdict: "OLDER", note: `ERP đang giữ chứng từ muộn hơn (${SHIPMENT_STAGE_LABEL[(m.currentStage ?? "UNKNOWN") as ShipmentStage]}) — không hạ trạng thái` };
  }
  if (m.currentStage === m.mapped.stage && erpAt && erpAt.getTime() === at.getTime()) {
    return { verdict: "SAME", note: "Đã có đúng chứng từ này trong lịch sử" };
  }
  if (m.currentStage === m.mapped.stage) return { verdict: "SAME", note: "Trạng thái đã trùng; chỉ làm mới tiền / cước nếu tệp có số khác" };
  return { verdict: "NEWER", note: `${SHIPMENT_STAGE_LABEL[(m.currentStage ?? "UNKNOWN") as ShipmentStage]} → ${SHIPMENT_STAGE_LABEL[m.mapped.stage]}` };
}

/**
 * Chạy thử MỘT tệp. Không ghi gì vào `shipments` / `shipment_events`.
 *
 * Tệp CHI TIẾT BẢNG KÊ (tiền thực thu) cố ý KHÔNG được xem trước ở đây: nó đi vào chiều TIỀN, có
 * sổ chứng từ riêng (`cod_statement_lines`) và luật đối soát riêng. Trộn hai màn hình xem trước là
 * mời người dùng đọc số tiền bằng con mắt đang đọc trạng thái giao.
 */
export async function previewVtpOrderListFile(file: { filename: string; base64: string }): Promise<ImportPreview> {
  const buffer = Buffer.from(file.base64, "base64");
  const checksum = fileChecksum(file.base64);
  const base = { filename: file.filename, checksum, bytes: buffer.byteLength, rows: 0, counts: { ...RONG }, sample: [] as PreviewRow[], previouslyAppliedAt: null as Date | null };

  let detected: DetectedVtpFile;
  try {
    const isText = /\.(csv|txt|tsv)$/i.test(file.filename);
    detected = detectVtpFile(isText ? buffer.toString("utf8") : buffer, file.filename);
  } catch (e) {
    return { ...base, kind: "ERROR", error: e instanceof VtpFileError || e instanceof Error ? e.message : String(e) };
  }
  if (detected.kind !== "ORDER_LIST") {
    return {
      ...base,
      kind: "STATEMENT_DETAIL",
      rows: detected.rows.length,
      error:
        "Đây là tệp CHI TIẾT BẢNG KÊ (tiền thực thu), không phải danh sách vận đơn. Tiền đi qua màn hình đối soát COD — " +
        "nhập nó ở đây sẽ làm người đọc lẫn chiều tiền với chiều giao hàng.",
    };
  }

  const db = await getDb();
  const merged = mergeDetectedOrderLists([detected]);
  const matches = await matchVtpOrderList(merged);
  const counts = { ...RONG };
  const seen = new Set<string>();
  const sample: PreviewRow[] = [];
  // Xếp theo mốc để mẫu hiện ra đúng thứ tự mà đường ghi sẽ đi qua.
  for (const m of matches) {
    const { verdict, note } = verdictOf(m, seen);
    counts[verdict] += 1;
    // Mẫu ưu tiên những dòng THAY ĐỔI ĐƯỢC GÌ ĐÓ hoặc cần người quyết; dòng "giống ERP" chỉ để
    // lấp chỗ trống. Một bảng xem trước toàn dòng "không đổi gì" là bảng không ai đọc tới cuối.
    if (sample.length < 200 && verdict !== "SAME") {
      sample.push({
        trackingCode: m.trackingCode,
        orderLabel: m.orderLabel,
        verdict,
        fileStatusText: m.statusText,
        fileStage: m.mapped.stage === "UNKNOWN" ? null : m.mapped.stage,
        fileStatusAt: m.statusAt ?? m.statusDate ?? null,
        erpStage: (m.currentStage ?? null) as ShipmentStage | null,
        erpStatusAt: m.currentStatusDate ? m.currentStatusDate.toISOString() : null,
        note,
      });
    }
  }

  const [truoc] = await db
    .select({ at: schema.vtpImportBatches.createdAt })
    .from(schema.vtpImportBatches)
    .where(and(eq(schema.vtpImportBatches.checksum, checksum), eq(schema.vtpImportBatches.mode, "APPLY")))
    .orderBy(desc(schema.vtpImportBatches.createdAt))
    .limit(1);

  return {
    ...base,
    kind: "ORDER_LIST",
    rows: merged.length,
    counts,
    sample,
    previouslyAppliedAt: truoc?.at ?? null,
    error: null,
  };
}

/**
 * Ghi một dòng vào sổ lần nhập. Dùng cho CẢ chạy thử lẫn lần ghi thật — chạy thử được ghi cố ý:
 * nó trả lời câu "ai đã xem trước tệp này và thấy gì" khi con số sau đó gây tranh cãi.
 */
export async function ghiSoNhapTep(input: {
  filename: string;
  checksum: string;
  bytes: number;
  kind: "ORDER_LIST" | "STATEMENT_DETAIL" | "ERROR";
  mode: "PREVIEW" | "APPLY";
  uploadedBy: string;
  uploadedById: string | null;
  rows: number;
  matched?: number;
  applied?: number;
  stale?: number;
  duplicates?: number;
  conflicts?: number;
  unmatched?: number;
  unknownStatus?: number;
  invalid?: number;
  error?: string | null;
  summary?: unknown;
}): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(schema.vtpImportBatches)
    .values({
      filename: input.filename,
      checksum: input.checksum,
      bytes: input.bytes,
      kind: input.kind,
      mode: input.mode,
      uploadedBy: input.uploadedBy,
      uploadedById: input.uploadedById,
      rows: input.rows,
      matched: input.matched ?? 0,
      applied: input.applied ?? 0,
      stale: input.stale ?? 0,
      duplicates: input.duplicates ?? 0,
      conflicts: input.conflicts ?? 0,
      unmatched: input.unmatched ?? 0,
      unknownStatus: input.unknownStatus ?? 0,
      invalid: input.invalid ?? 0,
      error: input.error ?? null,
      summary: (input.summary ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: schema.vtpImportBatches.id });
  return row.id;
}

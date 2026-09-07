import { audit } from "@/lib/audit";
import { detectVtpFile, mergeDetectedOrderLists, type DetectedVtpFile } from "@/lib/integrations/viettelpost/import-files";
import { applyStatementDetailRows, applyVtpOrderList, matchStatementFileToBatch } from "@/lib/integrations/viettelpost/statement-db";


/** Lỗi hiển thị cho chủ shop, không phải JSON thô của Zod. */
function readableError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export type VtpImportFileResult = {
  filename: string;
  kind: "ORDER_LIST" | "STATEMENT_DETAIL" | "ERROR";
  rows: number;
  periodFrom: string | null;
  periodTo: string | null;
  /** Danh sách vận đơn: số vận đơn được cập nhật. Bảng kê: số vận đơn ghi được chứng từ. */
  applied: number;
  withCash: number;
  matchedBatch: string | null;
  note: string;
};

/**
 * LÕI NHẬP TỆP VIETTEL POST — dùng chung cho cả người bấm trên giao diện lẫn luồng tự động
 * (Apps Script trong Gmail đẩy tệp đính kèm của thư "BẢNG KÊ ĐỐI SOÁT THANH TOÁN" sang ERP).
 * Không đụng tới phiên đăng nhập nên gọi được từ webhook; `actor` là ai đã kích hoạt lần nhập.
 *
 * MỘT CHỖ NHẬP DUY NHẤT cho cả hai loại tệp Viettel Post.
 *
 * Viettel Post chia nhỏ tệp theo khoảng ngày nên chủ shop luôn có nhiều tệp mỗi lần tải.
 * ERP tự nhận loại từng tệp (danh sách vận đơn hay chi tiết bảng kê) rồi đưa vào đúng luồng,
 * để không phải chọn tab và không nhập nhầm loại — một bên là trạng thái giao, một bên là tiền.
 *
 * Thứ tự xử lý cố ý: DANH SÁCH VẬN ĐƠN trước, CHI TIẾT BẢNG KÊ sau. Danh sách tạo/cập nhật
 * vận đơn, bảng kê mới có cái để ghi tiền thực thu lên.
 */
export async function runVtpDataFileImport(files: { filename: string; base64: string }[], actor: string): Promise<{ files: VtpImportFileResult[]; orderRows: number; statementRows: number }> {
  const detected: DetectedVtpFile[] = [];
  const results: VtpImportFileResult[] = [];
  for (const file of files) {
    const buffer = Buffer.from(file.base64, "base64");
    const isText = /\.(csv|txt|tsv)$/i.test(file.filename);
    try {
      detected.push(detectVtpFile(isText ? buffer.toString("utf8") : buffer, file.filename));
    } catch (e) {
      results.push({ filename: file.filename, kind: "ERROR", rows: 0, periodFrom: null, periodTo: null, applied: 0, withCash: 0, matchedBatch: null, note: readableError(e, "Không đọc được tệp") });
    }
  }

  // 1) Danh sách vận đơn — gộp mọi tệp rồi ghi một lần để xử lý trùng/xung đột giữa các tệp.
  const orderFiles = detected.filter((d) => d.kind === "ORDER_LIST");
  let orderRows = 0;
  if (orderFiles.length) {
    const merged = mergeDetectedOrderLists(detected);
    orderRows = merged.length;
    const applied = await applyVtpOrderList(merged, actor);
    const dates = merged.map((r) => r.statusDate).filter(Boolean).sort();
    for (const f of orderFiles) {
      results.push({
        filename: f.filename,
        kind: "ORDER_LIST",
        rows: f.rows.length,
        periodFrom: dates[0] ?? null,
        periodTo: dates[dates.length - 1] ?? null,
        applied: applied.updated,
        withCash: 0,
        matchedBatch: null,
        note: `Toàn bộ tệp danh sách gộp lại: cập nhật ${applied.updated} vận đơn`
          + (applied.linked ? ` (${applied.linked} vận đơn được gắn mã theo SĐT người nhận)` : "")
          + `, ${applied.legs} chiều hoàn, bỏ qua ${applied.stale} dòng cũ, ${applied.conflicts} xung đột cần đối chiếu`
          + (applied.unmatched ? `, ${applied.unmatched} vận đơn của VTP chưa có trong ERP` : ""),
      });
    }
    await audit({ userId: null, userEmail: actor, action: "VTP_ORDER_LIST_IMPORT", entity: "SHIPMENT", detail: { files: orderFiles.map((f) => f.filename), ...applied } });
  }

  // 2) Chi tiết bảng kê — ghi tiền thực thu, luôn ghi kể cả chưa có đợt tiền về khớp.
  let statementRows = 0;
  for (const f of detected) {
    if (f.kind !== "STATEMENT_DETAIL") continue;
    statementRows += f.rows.length;
    const match = await matchStatementFileToBatch(f.filename, f.rows);
    const applied = await applyStatementDetailRows(f.rows, f.filename, match.batchId);
    results.push({
      filename: f.filename,
      kind: "STATEMENT_DETAIL",
      rows: f.rows.length,
      periodFrom: match.periodFrom,
      periodTo: match.periodTo,
      applied: applied.linked,
      withCash: applied.withCash,
      matchedBatch: match.batchReference,
      note: applied.linked === 0 ? (match.issue ?? "Không vận đơn nào trong tệp có trong ERP") : `Ghi chứng từ cho ${applied.linked} vận đơn, ${applied.withCash} vận đơn có tiền thực thu`,
    });
    await audit({ userId: null, userEmail: actor, action: "COD_STATEMENT_DETAIL", entity: "COD_BATCH", entityId: match.batchId ?? f.filename, detail: { filename: f.filename, ...applied, period: [match.periodFrom, match.periodTo] } });
  }

  return { files: results, orderRows, statementRows };
}

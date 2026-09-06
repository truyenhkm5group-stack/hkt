import { parseStatementDetail, parseVtpOrderList, mergeVtpOrderLists, type StatementDetailRow, type VtpOrderListRow } from "@/lib/integrations/viettelpost/statement";

/**
 * Hai loại tệp tải trực tiếp từ Viettel Post, dùng làm DỮ LIỆU GỐC cho ERP:
 *  · ORDER_LIST        — "Danh sách vận đơn": trạng thái giao/hoàn, COD khai báo, cước.
 *  · STATEMENT_DETAIL  — "Chi tiết bảng kê": tiền THỰC THU về tài khoản của từng vận đơn.
 *
 * Viettel Post chia nhỏ file theo khoảng ngày nên chủ shop thường có nhiều tệp mỗi loại.
 * ERP tự nhận loại từng tệp để không phải chọn tab thủ công và không nhập nhầm loại —
 * nhập nhầm nguy hiểm vì một bên là trạng thái, một bên là tiền.
 */
export type VtpFileKind = "ORDER_LIST" | "STATEMENT_DETAIL";

export type DetectedVtpFile =
  | { kind: "ORDER_LIST"; filename: string; rows: VtpOrderListRow[] }
  | { kind: "STATEMENT_DETAIL"; filename: string; rows: StatementDetailRow[] };

/** Lỗi đọc tệp kèm tên tệp để chủ shop biết bỏ tệp nào ra. */
export class VtpFileError extends Error {
  constructor(readonly filename: string, message: string) {
    super(`${filename}: ${message}`);
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Nhận loại tệp bằng chính hai trình đọc thật, không đoán theo tên tệp.
 * Mỗi trình đọc đã tự từ chối loại còn lại kèm lý do rõ ràng, nên chỉ cần thử lần lượt:
 * tệp nào cả hai đều không đọc được thì báo nguyên văn lỗi của trình đọc phù hợp nhất.
 */
export function detectVtpFile(input: Buffer | string, filename: string): DetectedVtpFile {
  let orderError = "";
  try {
    return { kind: "ORDER_LIST", filename, rows: parseVtpOrderList(input) };
  } catch (error) {
    orderError = message(error);
  }
  try {
    return { kind: "STATEMENT_DETAIL", filename, rows: parseStatementDetail(input, filename) };
  } catch (error) {
    // Nếu trình đọc danh sách vận đơn đã khẳng định đây là chi tiết bảng kê thì lỗi của
    // trình đọc bảng kê mới là lỗi thật; ngược lại giữ lỗi của trình đọc danh sách.
    const statementError = message(error);
    throw new VtpFileError(filename, orderError.includes("CHI TIẾT BẢNG KÊ") ? statementError : orderError);
  }
}

/** Gộp nhiều tệp danh sách vận đơn thành một tập, phát hiện xung đột giữa các tệp. */
export function mergeDetectedOrderLists(files: DetectedVtpFile[]): VtpOrderListRow[] {
  return mergeVtpOrderLists(files.flatMap((f) => (f.kind === "ORDER_LIST" ? f.rows : [])));
}

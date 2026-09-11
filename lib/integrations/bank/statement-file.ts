/**
 * ═══════ ĐỌC TỆP SAO KÊ NGÂN HÀNG (.xlsx / .xls / .csv / .json) ═══════
 *
 * Tách riêng khỏi `ledger.ts` vì `ledger.ts` bị một Client Component import (bảng xem trước ở trang
 * Chi phí lấy `PLAN_STATUS_LABEL` từ đó). Nhét `xlsx` vào đấy là kéo cả thư viện đọc Excel xuống
 * trình duyệt cho một cái nhãn tiếng Việt — nên phần đọc nhị phân phải nằm ở tệp CHỈ máy chủ dùng.
 *
 * Ngân hàng gửi sao kê ở cả hai định dạng và chủ shop tải cái nào tiện tay hơn; bắt đổi sang CSV
 * trước khi nhập là đẩy việc sang người dùng, và đó chính là lỗi "ERP không nhận file .xlsx".
 */
import { parseLedger, rowsToLedgerTxns, CSV_HEADER_HINT, findHeader, type LedgerTxn } from "@/lib/integrations/bank/ledger";
import { sheetMatrix } from "@/lib/integrations/viettelpost/statement";

/** Chữ ký đầu tệp — tin byte thật chứ không tin phần mở rộng tên tệp. */
const SIGNATURES = {
  /** .xlsx / .ods — vốn là tệp nén ZIP */
  zip: [0x50, 0x4b, 0x03, 0x04],
  /** .xls đời cũ — tài liệu ghép OLE2 */
  ole: [0xd0, 0xcf, 0x11, 0xe0],
};

export function isSpreadsheet(buf: Buffer) {
  return Object.values(SIGNATURES).some((sig) => sig.every((b, i) => buf[i] === b));
}

/**
 * Tệp sao kê → danh sách giao dịch.
 *
 * Excel đọc với `cellDates` nên ô ngày về dưới dạng `Date` thật, KHÔNG phải chuỗi đã định dạng theo
 * ngôn ngữ máy: để SheetJS tự định dạng thì "05/08/2026" có thể ra "8/5/26" kiểu Mỹ và mọi giao
 * dịch lệch tháng. `raw` giữ nguyên chuỗi "3,122,361" của ô chữ để bộ tách số của ERP xử lý.
 */
export function parseLedgerFile(input: Buffer | string): LedgerTxn[] {
  if (typeof input === "string") return parseLedger(input);
  if (!isSpreadsheet(input)) return parseLedger(input.toString("utf8"));
  const matrix = sheetMatrix(input, true, true);
  const txns = rowsToLedgerTxns(matrix);
  if (!txns.length) {
    throw new Error(
      findHeader(matrix) ? "Đọc được dòng tiêu đề nhưng không có giao dịch nào bên dưới" : CSV_HEADER_HINT,
    );
  }
  return txns;
}

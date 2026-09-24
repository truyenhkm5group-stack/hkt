/**
 * ═══════════ NGUỒN DỮ LIỆU TAY: MÁY NHẮC ĐÚNG LÚC, KHÔNG ĐỢI NGƯỜI NHỚ ═══════════
 *
 * Hai đường dữ liệu mà ERP KHÔNG tự kéo về được, và khi chúng im thì chính hệ thống không thấy:
 *
 *  1. **Tệp "Danh sách vận đơn" Viettel Post** — nguồn DUY NHẤT thấy trạng thái "Lấy không thành
 *     công": webhook không bao giờ đẩy nó (đo 21/09/2026: 29 trạng thái, 4.700 lần ghi nhận, 0 dòng
 *     lấy-hỏng, trong khi viettelpost.vn cùng lúc báo 55 đơn). Không ai nhập tệp thì nhóm kiện đó
 *     hiện dưới nhãn trung tính "chờ lấy" — nghe như bưu tá sắp tới, thật ra bưu tá đã tới và về tay
 *     không.
 *
 *  2. **Bảng kê COD** — tiền Viettel Post chuyển về tài khoản mà ERP không có tệp bảng kê thì mọi
 *     vận đơn của đợt đó hiện "quá hạn chưa trả", và người đọc đi đòi một khoản tiền đã nhận. Đo
 *     24/09/2026: 4 đợt chuyển khoản · ~55 triệu có trong sao kê mà không có tệp.
 *
 * Tệp này giữ các con số VẬN HÀNH (nhịp nhắc), không phải ngưỡng nghiệp vụ kiểu 50K/100K: chúng
 * quyết định LÚC NÀO máy nhắc, không quyết định một đơn thành công hay hoàn. Mọi hàm ở đây THUẦN.
 */

/** Tệp Danh sách vận đơn cũ hơn chừng này thì coi là đến hạn nhập lại. Quy trình của shop: mỗi ngày một lần. */
export const VTP_ORDER_LIST_MAX_AGE_HOURS = 24;

/**
 * Trước giờ này (giờ Việt Nam) không nhắc: người phụ trách chưa vào ca, và một tin lúc 2 giờ sáng
 * chỉ dạy cả nhóm tắt thông báo.
 */
export const VTP_ORDER_LIST_REMIND_FROM_HOUR_VN = 10;

/**
 * Chuyển khoản COD mới về dưới chừng này giờ thì CHƯA đòi bảng kê: thư bảng kê của Viettel Post và
 * lệnh chuyển tiền không tới cùng một phút, và script Gmail chạy 15 phút một lần.
 */
export const COD_STATEMENT_GRACE_HOURS = 24;

/** Chỉ soi chuyển khoản COD trong chừng này ngày — xa hơn thì đã qua đối soát cuối tháng. */
export const COD_STATEMENT_LOOKBACK_DAYS = 45;

/**
 * Đợt bảng kê cùng SỐ TIỀN THỰC NHẬN và cách ngày chuyển khoản không quá chừng này ngày thì coi là
 * cùng một đợt. Ngày trên bảng kê là ngày CHỐT, còn tiền có thể về hôm sau (cuối tuần: vài hôm sau).
 */
export const COD_STATEMENT_MATCH_WINDOW_DAYS = 3;

/** Ngày theo giờ Việt Nam, dạng `YYYY-MM-DD`. */
export function vnDayOf(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

function vnHourOf(at: Date): number {
  return new Date(at.getTime() + 7 * 3_600_000).getUTCHours();
}

export type OrderListDue = { due: false } | { due: true; ageHours: number | null };

/**
 * Tệp Danh sách vận đơn có đến hạn nhập không.
 *
 * `lastImportAt = null` (CHƯA TỪNG nhập) là ĐẾN HẠN, không phải "không biết": đây là việc tay bắt
 * buộc, và chưa làm lần nào là đúng tình huống cần nhắc nhất. `ageHours = null` để tin nhắn nói
 * "chưa từng nhập" thay vì bịa ra một con số giờ.
 */
export function vtpOrderListDue(lastImportAt: Date | null, now: Date): OrderListDue {
  if (vnHourOf(now) < VTP_ORDER_LIST_REMIND_FROM_HOUR_VN) return { due: false };
  if (!lastImportAt) return { due: true, ageHours: null };
  const ageHours = (now.getTime() - lastImportAt.getTime()) / 3_600_000;
  return ageHours >= VTP_ORDER_LIST_MAX_AGE_HOURS ? { due: true, ageHours } : { due: false };
}

/**
 * SỐ BẢNG KÊ Viettel Post — định danh của một đợt chi trả, KHÔNG phải dữ liệu cá nhân. Hai chỗ
 * mang nó, cùng một con số:
 *
 *  · tên tệp email:    `BangKeChiCOD_30873899_1789…xlsx`        → 30873899
 *  · sao kê ngân hàng: `… VTP GLMTQY18 180926 30873899 …`       → 30873899
 *
 * MỘT hàm cho cả cảnh báo "thiếu bảng kê" lẫn ops `cod-statement-audit` — hai biểu thức cho cùng
 * một luật là cách chắc nhất để máy nhắc một đằng, bản kiểm tra nói một nẻo.
 *
 * Không khớp mẫu ⇒ `null` = KHÔNG ĐỌC ĐƯỢC — không đoán từ một dãy số bất kỳ (một SĐT trong nội
 * dung chuyển khoản trông y hệt một số bảng kê). Khi ấy dòng tiền chỉ còn được đối chiếu bằng số
 * tiền, không bị coi là "thiếu bảng kê" chỉ vì không đọc được nội dung.
 */
export function statementNumberOf(text: string): string | null {
  const tep = /BangKeChiCOD_(\d{6,10})(?:_|\.|$)/i.exec(text);
  if (tep) return tep[1]!;
  const ck = /\bVTP\s+[A-Z0-9]+\s+\d{6}\s+(\d{6,10})\b/i.exec(text);
  return ck ? ck[1]! : null;
}

export type CodTransferInput = { id: string; txnAt: Date; amount: number; description: string };
export type StatementBatchInput = { id: string; receivedAt: Date; totalAmount: number; note: string; reference: string };

export type StatementCoverage =
  | { covered: true; by: "LINKED" | "NUMBER" | "AMOUNT"; batchId: string | null }
  | { covered: false; statementNumber: string | null };

/**
 * Chuyển khoản COD này đã có bảng kê trong ERP chưa. Ba căn cứ, theo thứ tự mạnh → yếu:
 *
 *  1. `LINKED` — người (hoặc máy, ở mức EXACT) đã nối dòng tiền với một đợt COD;
 *  2. `NUMBER` — số bảng kê đọc từ nội dung chuyển khoản có trong tên tệp bảng kê đã nhập;
 *  3. `AMOUNT` — có đợt bảng kê cùng số tiền thực nhận, cách không quá vài ngày.
 *
 * Chỉ khi CẢ BA đều không có mới là thiếu. Căn cứ thứ ba cố ý rộng: thà bỏ sót một đợt trùng số
 * tiền ngẫu nhiên còn hơn bắt kế toán đi tìm một tệp đã có.
 */
export function statementCoverage(
  tx: CodTransferInput,
  batches: StatementBatchInput[],
  statementFiles: string[],
  linkedBatchIds: string[],
): StatementCoverage {
  if (linkedBatchIds.length) return { covered: true, by: "LINKED", batchId: linkedBatchIds[0] };
  const so = statementNumberOf(tx.description);
  if (so) {
    const theoTep = statementFiles.some((f) => f.includes(so));
    const theoDot = batches.find((b) => b.note.includes(so) || b.reference.includes(so));
    if (theoDot) return { covered: true, by: "NUMBER", batchId: theoDot.id };
    if (theoTep) return { covered: true, by: "NUMBER", batchId: null };
  }
  const cuaSo = COD_STATEMENT_MATCH_WINDOW_DAYS * 86_400_000;
  const theoTien = batches.find((b) => b.totalAmount === tx.amount && Math.abs(b.receivedAt.getTime() - tx.txnAt.getTime()) <= cuaSo);
  if (theoTien) return { covered: true, by: "AMOUNT", batchId: theoTien.id };
  return { covered: false, statementNumber: so };
}

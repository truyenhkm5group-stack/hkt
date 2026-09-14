/**
 * ═══════ ĐỐI KHỚP SAO KÊ VỚI CHỨNG TỪ — XÁC ĐỊNH TRƯỚC, ĐOÁN SAU, VÀ NÓI RÕ MÌNH ĐANG LÀM GÌ ═══════
 *
 * Một dòng sao kê là TIỀN THẬT đã đi. Nối nó với một chứng từ trong ERP là nói "đồng tiền này chính
 * là khoản kia" — và nếu nối sai thì hai sổ cùng lúc mất tin cậy: chứng từ được đánh dấu đã trả
 * trong khi tiền thật đi chỗ khác.
 *
 * BỐN MỨC, và ranh giới giữa chúng là BẰNG CHỨNG chứ không phải điểm số:
 *
 *  · `EXACT`           — có ĐỊNH DANH trùng khớp (mã bảng kê, mã phiếu, mã tham chiếu) VÀ số tiền
 *                        khớp. Chỉ mức này được tự nối, vì nó không phải phỏng đoán.
 *  · `HIGH_CONFIDENCE` — số tiền khớp chính xác, ngày gần nhau, và CHỈ CÓ MỘT ứng viên. Đây là ĐỀ
 *                        XUẤT: máy nói "gần như chắc", người bấm xác nhận.
 *  · `AMBIGUOUS`       — nhiều ứng viên cùng khớp. BẮT BUỘC người xem, không được tự chọn cái đầu.
 *  · `UNMATCHED`       — không có ứng viên nào.
 *
 * LUẬT KHÔNG NỚI: **không nối bằng SỐ TIỀN đơn độc khi có nhiều ứng viên.** Shop trả lương nhiều
 * người cùng mức, trả xưởng nhiều đợt cùng giá — số tiền trùng là chuyện thường ngày. Chọn đại một
 * cái rồi đánh dấu "đã đối soát" là tạo ra một sổ sai mà trông như đã kiểm.
 *
 * Mọi kết luận đều kèm `reasons`: người dùng phải đọc được VÌ SAO máy đề xuất, chứ không phải tin
 * một con số tin cậy không giải thích được.
 */

export const MATCH_CONFIDENCES = ["EXACT", "HIGH_CONFIDENCE", "AMBIGUOUS", "UNMATCHED"] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];

export const MATCH_CONFIDENCE_LABEL: Record<MatchConfidence, string> = {
  EXACT: "Khớp định danh",
  HIGH_CONFIDENCE: "Gần như chắc",
  AMBIGUOUS: "Nhiều ứng viên",
  UNMATCHED: "Chưa khớp",
};

export const MATCH_CONFIDENCE_NOTE: Record<MatchConfidence, string> = {
  EXACT: "Có mã chứng từ trùng khớp và số tiền khớp — tự nối được vì đây không phải phỏng đoán.",
  HIGH_CONFIDENCE: "Số tiền khớp chính xác, ngày gần nhau, chỉ có một ứng viên. Máy đề xuất, người xác nhận.",
  AMBIGUOUS: "Nhiều chứng từ cùng khớp. Phải có người chọn — máy không được chọn hộ.",
  UNMATCHED: "Không tìm thấy chứng từ nào khớp.",
};

/** Chỉ EXACT được tự nối. Ba mức còn lại luôn cần người. */
export const AUTO_CONFIRMABLE: Record<MatchConfidence, boolean> = {
  EXACT: true,
  HIGH_CONFIDENCE: false,
  AMBIGUOUS: false,
  UNMATCHED: false,
};

export type MatchTargetType = "EXPENSE" | "COD_BATCH" | "STOCK_RECEIPT" | "AD_SPEND";

export type MatchCandidate = {
  type: MatchTargetType;
  id: string;
  amount: number;
  at: Date;
  /** Mã chứng từ có thể xuất hiện trong nội dung chuyển khoản: mã bảng kê, mã phiếu, số hoá đơn. */
  identifiers: string[];
  label: string;
};

export type BankTxnForMatch = {
  id: string;
  amount: number;
  txnAt: Date;
  description: string;
  counterparty: string;
};

export type MatchResult = {
  confidence: MatchConfidence;
  target: MatchCandidate | null;
  /** Ứng viên khác khi nhập nhằng — người chọn cần nhìn thấy cả những cái bị loại. */
  others: MatchCandidate[];
  reasons: string[];
};

/** Ngày lệch bao nhiêu vẫn coi là cùng một giao dịch. Ngân hàng ghi nhận trễ là chuyện bình thường. */
export const MATCH_DAY_WINDOW = 3;

/** Chuẩn hoá để dò mã trong nội dung: bỏ dấu cách, gạch, và không phân biệt hoa thường. */
function chuanHoa(v: string): string {
  return v.toLowerCase().replace(/[\s\-_.]/g, "");
}

function lechNgay(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Đối khớp MỘT dòng sao kê với danh sách ứng viên đã lọc sẵn theo loại.
 *
 * Hàm thuần: không chạm CSDL, nên kiểm thử được từng luật một mà không phải dựng dữ liệu.
 */
export function matchTransaction(txn: BankTxnForMatch, candidates: MatchCandidate[]): MatchResult {
  const reasons: string[] = [];
  const tienSaoKe = Math.abs(txn.amount);
  const noiDung = chuanHoa(`${txn.description} ${txn.counterparty}`);

  // ── 1. ĐỊNH DANH: mã chứng từ nằm ngay trong nội dung chuyển khoản ──
  //
  // Mã phải ĐỦ DÀI mới tính. Một mã hai ký tự sẽ trùng ngẫu nhiên với bất kỳ nội dung nào, và khớp
  // ngẫu nhiên còn tệ hơn không khớp vì nó đội lốt bằng chứng.
  const theoDinhDanh = candidates.filter((c) =>
    c.identifiers.some((idf) => {
      const k = chuanHoa(idf);
      return k.length >= 5 && noiDung.includes(k);
    }),
  );
  const dinhDanhVaTien = theoDinhDanh.filter((c) => Math.abs(c.amount) === tienSaoKe);
  if (dinhDanhVaTien.length === 1) {
    reasons.push(`Nội dung chuyển khoản chứa mã chứng từ “${dinhDanhVaTien[0].identifiers.find((i) => noiDung.includes(chuanHoa(i))) ?? ""}”`, "Số tiền khớp chính xác");
    return { confidence: "EXACT", target: dinhDanhVaTien[0], others: [], reasons };
  }
  if (dinhDanhVaTien.length > 1) {
    reasons.push(`${dinhDanhVaTien.length} chứng từ cùng mã và cùng số tiền — máy không được chọn hộ`);
    return { confidence: "AMBIGUOUS", target: null, others: dinhDanhVaTien, reasons };
  }
  // Có mã nhưng số tiền LỆCH: đây là manh mối mạnh nhưng KHÔNG phải khớp. Nói ra, đừng nối.
  if (theoDinhDanh.length === 1) {
    reasons.push(
      "Nội dung có mã chứng từ nhưng SỐ TIỀN LỆCH " + `(${Math.abs(Math.abs(theoDinhDanh[0].amount) - tienSaoKe).toLocaleString("vi-VN")}đ)`,
      "Lệch tiền có thể do phí ngân hàng, trả một phần, hoặc ghép nhầm — cần người xem",
    );
    return { confidence: "AMBIGUOUS", target: null, others: theoDinhDanh, reasons };
  }

  // ── 2. SỐ TIỀN + NGÀY: chỉ đề xuất khi CHỈ CÓ MỘT ứng viên ──
  const theoTien = candidates.filter((c) => Math.abs(c.amount) === tienSaoKe && lechNgay(c.at, txn.txnAt) <= MATCH_DAY_WINDOW);
  if (theoTien.length === 1) {
    const c = theoTien[0];
    reasons.push("Số tiền khớp chính xác", `Ngày lệch ${Math.round(lechNgay(c.at, txn.txnAt))} ngày (trong ngưỡng ${MATCH_DAY_WINDOW})`, "Chỉ có duy nhất một chứng từ khớp");
    return { confidence: "HIGH_CONFIDENCE", target: c, others: [], reasons };
  }
  if (theoTien.length > 1) {
    // ĐÂY LÀ LUẬT QUAN TRỌNG NHẤT CỦA CẢ TỆP. Xem ghi chú đầu tệp.
    reasons.push(
      `${theoTien.length} chứng từ cùng số tiền ${tienSaoKe.toLocaleString("vi-VN")}đ trong khoảng ${MATCH_DAY_WINDOW} ngày`,
      "KHÔNG nối bằng số tiền đơn độc: trả lương nhiều người cùng mức, trả xưởng nhiều đợt cùng giá là chuyện thường ngày",
    );
    return { confidence: "AMBIGUOUS", target: null, others: theoTien, reasons };
  }

  reasons.push(
    candidates.length
      ? `Có ${candidates.length} chứng từ cùng loại nhưng không cái nào khớp cả tiền lẫn ngày`
      : "Không có chứng từ nào cùng loại trong ERP",
  );
  return { confidence: "UNMATCHED", target: null, others: [], reasons };
}

/**
 * ═══════════ XẾP MỘT CHỮ GỐC VÀO DANH MỤC — HÀM THUẦN, KHÔNG ĐỌC CSDL ═══════════
 *
 * Tách khỏi truy vấn để kiểm được từng ca mà không cần dựng CSDL, và để lượt backfill với lượt
 * webhook chạy CÙNG một phép xếp — hai bản sao là hai kết quả khác nhau cho cùng một câu chữ.
 *
 * ─── LUẬT AN TOÀN, QUAN TRỌNG HƠN MỌI LUẬT KHỚP CHỮ ───
 *
 * Nguồn không đủ thẩm quyền kết luận lỗi của shop (ĐVVC, Pancake) thì chữ của nó KHÔNG BAO GIỜ
 * được xếp vào một lý do thuộc nhóm CHỈ NGƯỜI MỚI BIẾT — dù chữ ấy nghe thuyết phục tới đâu.
 *
 * Đây không phải cẩn thận thừa. Đo trên production 14/09/2026: ~150 kiện mang chuỗi "Khách từ
 * chối nhận - Sai thông tin đơn hàng" và ~24 kiện mang "Khách từ chối nhận - Không hài lòng về sản
 * phẩm". Xếp chúng vào "sale tư vấn sai" và "chất lượng kém" thì hai cột ấy lập tức có số, trông
 * y hệt những ca đã có người gọi khách xác minh — và mọi quyết định sau đó (đổi xưởng, phạt sale)
 * đứng trên một câu bưu tá gõ vội.
 *
 * Nên ca đó ra `CUSTOMER_REFUSED`: khách từ chối — một QUAN SÁT, không phải một kết luận. Chữ gốc
 * vẫn còn nguyên để người xử lý đọc rồi XÁC NHẬN.
 */
import {
  boDau,
  REASON_NEEDS_HUMAN,
  RETURN_REASONS,
  RETURN_REASON_LABEL,
  RETURN_REASON_TEXT_RULES,
  RETURN_STEP_NOT_REASON,
  VTP_REASON_TO_RETURN_REASON,
  type ReturnReason,
} from "@/lib/constants/return-reason";
import { SOURCE_CAN_CONCLUDE_SHOP_FAULT, type ReasonSource } from "@/lib/constants/return-reason-source";

export type ClassifyResult = {
  reason: ReturnReason;
  /** Luật nào khớp — để giải thích được, và để đếm xem luật nào đang gánh bao nhiêu ca. */
  rule: string;
  /** `true` = khớp được một luật; `false` = giữ `UNKNOWN` vì chưa xếp được. */
  matched: boolean;
  /** Có một luật khớp nhưng bị CHẶN vì nguồn không đủ thẩm quyền. Đếm riêng: đây là việc phải làm. */
  blockedBySource?: ReturnReason;
};

const CHUA_XEP: ClassifyResult = { reason: "UNKNOWN", rule: "", matched: false };

/**
 * LUẬT CHO CHỮ CỦA NGƯỜI — chỉ áp dụng cho nguồn có thẩm quyền kết luận.
 *
 * Người của shop gõ "vải mỏng quá" là họ ĐÃ hỏi khách; ĐVVC không bao giờ gõ câu đó. Vì vậy tập
 * luật này rộng hơn hẳn tập dùng cho chữ ĐVVC, và nó chỉ được chạy khi nguồn cho phép.
 *
 * Thứ tự là thứ tự ƯU TIÊN: mẫu cụ thể đứng trước mẫu chung, để "chật tay" không bị nuốt bởi
 * "chật".
 */
export const HUMAN_TEXT_RULES: { match: string; reason: ReturnReason }[] = [
  { match: "sale tu van sai", reason: "SIZE_SALES_ADVICE_WRONG" },
  { match: "tu van sai size", reason: "SIZE_SALES_ADVICE_WRONG" },
  { match: "khong giong mau", reason: "QUALITY_NOT_AS_PICTURED" },
  { match: "khong giong hinh", reason: "QUALITY_NOT_AS_PICTURED" },
  { match: "vai xau", reason: "QUALITY_FABRIC_BAD" },
  { match: "vai mong", reason: "QUALITY_FABRIC_THIN" },
  { match: "vai nong", reason: "QUALITY_FABRIC_HOT" },
  { match: "day qua", reason: "QUALITY_TOO_THICK" },
  { match: "may xau", reason: "QUALITY_SEWING_BAD" },
  { match: "duong may", reason: "QUALITY_SEWING_BAD" },
  { match: "mau xau", reason: "QUALITY_COLOR_BAD" },
  { match: "loi", reason: "QUALITY_DEFECT" },
  { match: "rach", reason: "QUALITY_DEFECT" },
  { match: "ban", reason: "QUALITY_DEFECT" },
  { match: "mac xau", reason: "QUALITY_LOOKS_BAD_ON" },
  { match: "chat ao", reason: "SIZE_TIGHT_TOP" },
  { match: "chat quan", reason: "SIZE_TIGHT_BOTTOM" },
  { match: "rong ao", reason: "SIZE_LOOSE_TOP" },
  { match: "rong quan", reason: "SIZE_LOOSE_BOTTOM" },
  { match: "chat", reason: "SIZE_TIGHT" },
  { match: "rong", reason: "SIZE_LOOSE" },
  { match: "khong vua", reason: "SIZE_DOES_NOT_FIT" },
  { match: "kho dong sai", reason: "WAREHOUSE_PACKED_WRONG" },
  { match: "dong sai", reason: "WAREHOUSE_PACKED_WRONG" },
  { match: "giao lau", reason: "SLOW_DELIVERY" },
  { match: "giao cham", reason: "SLOW_DELIVERY" },
  { match: "boom", reason: "BOOM_NO_REASON" },
  { match: "don trung", reason: "DUPLICATE_ORDER" },
  { match: "trung don", reason: "DUPLICATE_ORDER" },
  { match: "huy truoc khi gui", reason: "CANCELLED_BEFORE_SHIP" },
];

/**
 * Xếp MỘT chữ gốc vào danh mục, theo đúng thẩm quyền của nguồn.
 *
 * `vtpCode` truyền vào khi nguồn là mã lý do có cấu trúc của ĐVVC — bảng mã tin cậy hơn chữ tự do
 * nên nó được xét trước.
 */
export function classifyRaw(rawText: string, source: ReasonSource, vtpCode?: number | null): ClassifyResult {
  /* ─── Mã có cấu trúc của ĐVVC: chắc chắn hơn mọi phép đọc chữ ─── */
  if (vtpCode !== null && vtpCode !== undefined) {
    const r = VTP_REASON_TO_RETURN_REASON[vtpCode];
    if (r) return { reason: r, rule: `vtp:${vtpCode}`, matched: true };
  }

  const s = boDau(rawText);
  if (!s) return CHUA_XEP;

  /*
    BƯỚC ĐI KHÔNG PHẢI LÝ DO. "Tồn - Thông báo chuyển hoàn bưu cục gốc" nói kiện đang trên đường
    về — chưa nói vì sao. Nhận nhầm nó thành lý do tạo ra một nhãn chiếm gần 1/5 báo cáo mà không
    hành động được gì với nó.
  */
  if (RETURN_STEP_NOT_REASON.some((b) => s.includes(b))) return CHUA_XEP;

  const duocKetLuan = SOURCE_CAN_CONCLUDE_SHOP_FAULT[source];

  /*
    ─── Chữ của NGƯỜI: tập luật rộng ───

    Luật CHẠY cho mọi nguồn, nhưng chỉ nguồn có thẩm quyền mới được KẾT LUẬN. Nguồn không đủ thẩm
    quyền thì ca rơi về `UNKNOWN` kèm cờ `blockedBySource`.

    Vì sao không bỏ qua hẳn tập luật này cho nguồn ngoài shop: một bưu tá gõ "khách bảo vải xấu"
    là chữ ĐÁNG ĐỌC. Bỏ qua im lặng thì ca ấy trông y hệt kiện chưa ai nói gì — và hai chỗ trống
    đó dẫn tới hai việc khác hẳn nhau (đọc chữ rồi chọn lý do · đi hỏi khách). Chặn KẾT LUẬN mà
    vẫn giữ DẤU VẾT là cách duy nhất giữ được cả hai điều.
  */
  for (const rule of HUMAN_TEXT_RULES) {
    if (!s.includes(rule.match)) continue;
    if (!duocKetLuan) return { ...CHUA_XEP, blockedBySource: rule.reason };
    return { reason: rule.reason, rule: `human:${rule.match}`, matched: true };
  }

  /* ─── Chữ THÔ (ĐVVC, Pancake): tập luật hẹp, đã khoá bởi tests/kpi-clarity ─── */
  for (const rule of RETURN_REASON_TEXT_RULES) {
    if (!s.includes(rule.match)) continue;
    /*
      CỬA AN TOÀN. Luật chữ thô hiện không luật nào trỏ tới lý do chỉ-người-mới-biết (bài kiểm
      khoá điều đó), nhưng cửa này vẫn đứng đây: ngày ai đó thêm một luật như thế, ca ấy rơi về
      `UNKNOWN` kèm cờ `blockedBySource` thay vì lặng lẽ vào cột "chất lượng kém".
    */
    if (!duocKetLuan && REASON_NEEDS_HUMAN[rule.reason]) {
      return { ...CHUA_XEP, blockedBySource: rule.reason };
    }
    return { reason: rule.reason, rule: `carrier:${rule.match}`, matched: true };
  }

  return CHUA_XEP;
}

/** Nhãn để in ra khi giải thích một lượt xếp. Rỗng = chưa xếp được. */
export function ruleLabel(r: ClassifyResult): string {
  if (!r.matched) return r.blockedBySource ? `CHẶN (nguồn không đủ thẩm quyền kết luận "${RETURN_REASON_LABEL[r.blockedBySource]}")` : "chưa xếp được";
  return `${RETURN_REASON_LABEL[r.reason]} · ${r.rule}`;
}

/** Mọi khoá lý do — để bài kiểm chắc luật không trỏ tới một khoá không có trong sổ. */
export const ALL_REASON_KEYS: readonly string[] = RETURN_REASONS;

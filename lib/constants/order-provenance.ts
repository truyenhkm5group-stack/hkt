/**
 * SỔ NGUỒN CỦA TỪNG Ô ĐƠN HÀNG — AI NÓI RA CON SỐ NÀY, Ở TIN NHẮN NÀO.
 *
 * ═══ VẤN ĐỀ NÓ GIẢI ═══
 *
 * Trạng thái đơn nằm ở MỘT ô jsonb (`sales_conversations.state`): một túi phẳng các giá trị trần.
 * `state.size = "L"` không nói được "L" từ đâu ra, và nó có tới BA chỗ ghi khác nhau — khách nói,
 * bảng số đo ERP suy ra, hoặc dòng mẫu mã khớp được. Cả ba ghi cùng một chuỗi.
 *
 * Nên khi một đơn giao sai size, câu hỏi đầu tiên của người xử lý khiếu nại — *lúc ấy ai đã chốt
 * size này* — không có chỗ nào trả lời được. `ai_runs.state_before/state_after` cho biết ô ấy ĐỔI
 * ở lượt nào, nhưng không cho biết AI đã đổi nó.
 *
 * ═══ NÓ KHÔNG PHẢI MÁY TRẠNG THÁI THỨ HAI ═══
 *
 * Đặc tả ghi thẳng, và đây là ranh giới quan trọng nhất của tệp: `sales_conversations.state` VẪN
 * là nguồn sự thật cho dây chuyền nghiệp vụ. Sổ này chỉ GHI LẠI. Không một quyết định bán hàng
 * nào được đọc nó — nếu có, ta vừa dựng ra hai nơi trả lời cùng một câu hỏi, và chúng sẽ nói khác
 * nhau vào đúng lúc tệ nhất.
 *
 * ═══ HAI CHIỀU PHẢI TÁCH, VÌ CHÚNG TRẢ LỜI HAI CÂU HỎI KHÁC NHAU ═══
 *
 *   NGUỒN (`sourceType`)       — dữ kiện này tới từ đâu.
 *   MỨC KHẲNG ĐỊNH (`claim`)   — nó có phải lời KHÁCH nói không.
 *
 * Gộp chúng lại thì "size L do bảng số đo ERP gợi ý" và "size L do khách tự chọn" trông y hệt
 * nhau, và đó đúng là chỗ đặc tả cấm (ca E): máy suy ra một size KHÔNG được ghi như lời khách.
 */

/**
 * SÁU Ô của bản V1 — chọn theo mức thiệt hại khi sai, không theo mức dễ làm.
 *
 * Sai sáu ô này là giao nhầm hàng hoặc giao nhầm người. `customer_name`, `address`, `price` mở
 * rộng sau: sai tên thì vẫn tới đúng nhà, còn giá thì đã có đường riêng (máy chủ tính, mô hình
 * không được đặt) nên nó không nằm trong nhóm "ai đã nói ra con số này".
 */
export const PROVENANCE_FIELDS = ["product_id", "variant_id", "color", "size", "quantity", "phone"] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

export const PROVENANCE_FIELD_LABEL: Record<ProvenanceField, string> = {
  product_id: "Mã hàng",
  variant_id: "Mẫu mã",
  color: "Màu",
  size: "Size",
  quantity: "Số lượng",
  phone: "Số điện thoại",
};

/** Ô mở rộng ở bản sau — khai sẵn để không ai đặt tên khác cho cùng một thứ. */
export const PROVENANCE_FIELDS_V2 = ["customer_name", "address", "price"] as const;

/**
 * NGUỒN — tới từ đâu. Tập ĐÓNG: một ô chữ tự do ở đây sẽ thành mười cách viết cho cùng một nguồn,
 * và mọi phép đếm sau đó đều sai.
 */
export const PROVENANCE_SOURCE_TYPES = [
  /** Khách gõ ra, trong chính tin nhắn này. Bậc chắc chắn nhất. */
  "CUSTOMER_MESSAGE",
  /** Nhân viên gõ ra trong hội thoại. */
  "STAFF_MESSAGE",
  /** Dòng mẫu mã trong danh mục ERP khớp được ⇒ ERP điền nốt size/màu còn thiếu. */
  "ERP_CATALOG",
  /** Bảng số đo của shop suy ra size. LỜI GỢI Ý, không phải lời khách. */
  "ERP_SIZE_ENGINE",
  /** Bộ nhận diện sản phẩm (`sales_product_resolutions`) — có sổ nguồn riêng, chi tiết hơn. */
  "PRODUCT_RESOLVER",
  /** Mô hình bóc ra từ câu khách mà không có luật nào chắc. Bậc yếu nhất được ghi. */
  "MODEL_INFERENCE",
  /** Người vận hành sửa tay trên màn hình. */
  "HUMAN_EDIT",
] as const;
export type ProvenanceSourceType = (typeof PROVENANCE_SOURCE_TYPES)[number];

/**
 * MỨC KHẲNG ĐỊNH — chiều thứ hai, và là chiều ca E của đặc tả nói tới.
 *
 *   `STATED`   khách hoặc nhân viên NÓI RA. Đây là sự thật của hội thoại.
 *   `DERIVED`  ERP tính ra từ dữ liệu CÓ THẬT (dòng mẫu mã, bảng số đo). Kiểm lại được.
 *   `INFERRED` đoán ra từ ngôn ngữ. Có thể sai, và phải đọc được là nó có thể sai.
 */
export const PROVENANCE_CLAIMS = ["STATED", "DERIVED", "INFERRED"] as const;
export type ProvenanceClaim = (typeof PROVENANCE_CLAIMS)[number];

export const PROVENANCE_CLAIM_LABEL: Record<ProvenanceClaim, string> = {
  STATED: "Khách/nhân viên nói ra",
  DERIVED: "ERP suy ra từ dữ liệu có thật",
  INFERRED: "Máy đoán từ câu chữ",
};

/**
 * Mỗi nguồn khai SẴN mức khẳng định của nó — bảng, không phải một tham số mà nơi gọi tự điền.
 *
 * Để nơi gọi tự điền `claim` là mở đúng cánh cửa ca E: một chỗ nào đó sẽ ghi
 * `{ sourceType: "ERP_SIZE_ENGINE", claim: "STATED" }` và size máy gợi ý biến thành lời khách.
 */
export const CLAIM_OF_SOURCE: Record<ProvenanceSourceType, ProvenanceClaim> = {
  CUSTOMER_MESSAGE: "STATED",
  STAFF_MESSAGE: "STATED",
  HUMAN_EDIT: "STATED",
  ERP_CATALOG: "DERIVED",
  ERP_SIZE_ENGINE: "DERIVED",
  PRODUCT_RESOLVER: "DERIVED",
  MODEL_INFERENCE: "INFERRED",
};

export const PROVENANCE_STATUSES = ["ACTIVE", "SUPERSEDED"] as const;
export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];

/** Một dòng sổ. `value` luôn là CHỮ: sổ này để người đọc, không để tính toán. */
export type ProvenanceRecord = {
  field: ProvenanceField;
  value: string;
  sourceType: ProvenanceSourceType;
  claim: ProvenanceClaim;
  /** Tin nhắn đã dẫn tới dữ kiện này. `null` = không sinh từ một tin cụ thể (người sửa tay). */
  sourceMessageId: string | null;
  /** Trỏ tới bản ghi gốc ở miền khác — ví dụ `sales_product_resolutions.id`. */
  sourceReference: string | null;
  /** Câu/cụm đã dẫn tới kết luận. Để người đọc lại hiểu, không để máy đọc. */
  evidence: string;
  /** 0–1. `null` = CHƯA ĐO ĐƯỢC, không phải 0. */
  confidence: number | null;
};

/** Ảnh chụp sáu ô, lấy từ `SalesState`. Chỉ đọc. */
export type ProvenanceSnapshot = Partial<Record<ProvenanceField, string>>;

export type ProvenanceContext = {
  sourceMessageId: string | null;
  /** Ô nào trong lượt này do KHÁCH gõ ra — bóc từ thực thể của câu khách. */
  statedByCustomer: Partial<Record<ProvenanceField, string>>;
  /** Ô nào do ERP suy ra, kèm nguồn cụ thể. */
  derived: Partial<Record<ProvenanceField, { sourceType: ProvenanceSourceType; reference?: string | null }>>;
  evidence: string;
  confidence: number | null;
};

/** Chuẩn hoá để SO SÁNH, không để lưu: "  XL " và "xl" là một giá trị. */
function chuan(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

/**
 * Ô này ở lượt này tới từ đâu.
 *
 * Thứ tự ưu tiên là điều quan trọng nhất của hàm, và nó CHẶT có chủ ý: khách nói ra thì đó là
 * khách nói ra, dù cùng lúc ERP cũng suy ra đúng giá trị ấy. Ngược lại thì một lượt khách tự chọn
 * size sẽ bị ghi thành "ERP suy ra", và ca E mất nghĩa theo chiều ngược lại.
 */
function nguonCua(field: ProvenanceField, ctx: ProvenanceContext): { sourceType: ProvenanceSourceType; reference: string | null } {
  const khachNoi = ctx.statedByCustomer[field];
  if (khachNoi !== undefined && chuan(khachNoi).length > 0) return { sourceType: "CUSTOMER_MESSAGE", reference: null };
  const suyRa = ctx.derived[field];
  if (suyRa) return { sourceType: suyRa.sourceType, reference: suyRa.reference ?? null };
  // Không khai được nguồn nào ⇒ đây là phần mô hình bóc ra. Ghi đúng như vậy, bậc YẾU NHẤT —
  // im lặng bỏ qua thì một dữ kiện không ai chịu trách nhiệm sẽ nằm trong đơn mà không có dấu vết.
  return { sourceType: "MODEL_INFERENCE", reference: null };
}

/**
 * SO HAI ẢNH CHỤP rồi sinh ra các dòng sổ cần GHI THÊM. HÀM THUẦN.
 *
 * Chỉ sinh dòng cho ô THẬT SỰ ĐỔI GIÁ TRỊ. Một lượt khách nhắn "vâng" không đổi ô nào thì không
 * sinh dòng nào — đây là ca C của đặc tả, và nó là mặc định của hàm chứ không phải một nhánh
 * riêng: không có nhánh riêng thì không có nhánh nào để quên.
 *
 * Ô bị XOÁ (có giá trị → rỗng) cũng không sinh dòng mới; nó chỉ làm dòng cũ thành SUPERSEDED.
 * Trả về cả hai phần để nơi gọi ghi trong MỘT lượt.
 */
export function diffProvenance(
  truoc: ProvenanceSnapshot,
  sau: ProvenanceSnapshot,
  ctx: ProvenanceContext,
): { insert: ProvenanceRecord[]; supersede: ProvenanceField[] } {
  const insert: ProvenanceRecord[] = [];
  const supersede: ProvenanceField[] = [];

  for (const field of PROVENANCE_FIELDS) {
    const a = chuan(truoc[field]);
    const b = chuan(sau[field]);
    if (a === b) continue; // không đổi ⇒ không có gì để ghi

    // Giá trị cũ (nếu có) hết hiệu lực — kể cả khi ô bị xoá trắng.
    if (a.length > 0) supersede.push(field);
    if (b.length === 0) continue; // bị xoá ⇒ chỉ khép dòng cũ, không mở dòng mới

    const { sourceType, reference } = nguonCua(field, ctx);
    insert.push({
      field,
      value: String(sau[field]),
      sourceType,
      // Mức khẳng định LẤY TỪ BẢNG, không nhận từ nơi gọi — xem `CLAIM_OF_SOURCE`.
      claim: CLAIM_OF_SOURCE[sourceType],
      sourceMessageId: ctx.sourceMessageId,
      sourceReference: reference,
      evidence: ctx.evidence.slice(0, 300),
      confidence: ctx.confidence,
    });
  }
  return { insert, supersede };
}

/**
 * Ô này có được KHÁCH tự nói ra không — câu hỏi mà người xử lý khiếu nại hỏi đầu tiên.
 *
 * Tách thành một hàm có tên thay vì để nơi gọi tự so `claim === "STATED"`: mỗi chỗ tự so là một
 * chỗ có thể so nhầm, và câu hỏi này quá quan trọng để nằm rải rác.
 */
export function isCustomerStated(r: Pick<ProvenanceRecord, "claim" | "sourceType">): boolean {
  return r.claim === "STATED" && (r.sourceType === "CUSTOMER_MESSAGE" || r.sourceType === "STAFF_MESSAGE" || r.sourceType === "HUMAN_EDIT");
}

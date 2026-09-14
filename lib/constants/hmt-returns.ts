/**
 * ═══════════ ĐỐI SOÁT MỘT LẦN: SỔ HÀNG HOÀN VIẾT TAY (HMT) ↔ ERP ═══════════
 *
 * Kho giữ một bảng tính riêng ghi từng kiện hàng hoàn đã về tới nơi. ERP giữ vòng đời kiện
 * (`lib/constants/return-lifecycle.ts`). Hai sổ chưa bao giờ được đối chiếu, nên ERP đang nói
 * "chờ kho nhận" cho những kiện đã nằm trên kệ hàng tháng.
 *
 * Đây là một lượt ĐỐI SOÁT LỊCH SỬ, KHÔNG phải một đường đồng bộ định kỳ. Không có job, không có
 * lịch, không có webhook — chạy một lần, ghi lại đã ghi những gì, rồi thôi.
 *
 * ─── BA ĐIỀU KHÔNG ĐƯỢC PHÁ ───
 *
 *  1. **Chứng cứ đi bằng ĐỊNH DANH, không bằng người.** Mã vận đơn là danh tính của KIỆN, mẫu mã
 *     là danh tính của MÓN. Tuyệt đối không ghép theo số điện thoại, tên khách, hay chỉ theo mã
 *     dòng sản phẩm (`Q002`) — một mã có nhiều màu nhiều size, và ghép sai trông y hệt ghép đúng.
 *
 *  2. **Bảng tính chứng minh HÀNG ĐÃ VỀ KHO, KHÔNG chứng minh HÀNG CÒN BÁN ĐƯỢC.** Nên lượt ghi
 *     duy nhất là `RECEIVED_AT_WAREHOUSE` (`markReturnsArrived`). Tồn kho KHÔNG đổi một món nào;
 *     kiện đi tiếp vào hàng đợi đếm và người kho vẫn phải mở ra đếm (AGENTS.md mục 10).
 *
 *  3. **Không khớp thì GIỮ NGUYÊN.** Chín trạng thái dưới đây có đúng MỘT trạng thái được ghi.
 *     Tám trạng thái còn lại là câu trả lời "chưa đủ căn cứ", và câu đó phải hiện ra thành số chứ
 *     không được lặng lẽ biến thành một lượt ghi.
 */

/** Nhãn bảng tính nguồn — ghi vào từng dòng chứng cứ để sáu tháng sau còn biết số ở đâu ra. */
export const HMT_WORKBOOK_LABEL = "Bản sao của Hàng hoàn HMT";

/** Nguồn của lượt ghi, đứng cùng hạng với `SYSTEM_RECONCILIATION` của CSKH. */
export const HMT_SOURCE = "HMT_RETURN_RECONCILIATION";

/**
 * Trần một lượt tải sổ hàng hoàn lên qua ERP.
 *
 * Sổ thật đo được **45 KB**; 8 MB là rộng gấp gần hai trăm lần mà vẫn nằm dưới trần thân yêu cầu
 * của Server Action (`next.config.ts`). Trần tồn tại để một tệp nhầm (video, ảnh chụp cả thư mục)
 * bị chặn ở cửa chứ không làm nghẽn máy chủ.
 */
export const HMT_MAX_UPLOAD_BYTES = 8_000_000;

/**
 * BA SHEET, BA VAI TRÒ KHÁC HẲN NHAU.
 *
 * `TRACKING_INDEX` chỉ có mã vận đơn và trạng thái — nó nói "kiện này có trong sổ", KHÔNG nói món
 * nào đã về. Một mình nó KHÔNG đủ căn cứ để ghi nhận, và đây là chỗ dễ sai nhất: 834 dòng mã vận
 * đơn trông rất giống một danh sách sẵn sàng để ghi.
 */
export const HMT_SHEET_ROLES = ["TRACKING_INDEX", "FULL_RETURN_ITEMS", "PARTIAL_RETURN_ITEMS"] as const;
export type HmtSheetRole = (typeof HMT_SHEET_ROLES)[number];

export type HmtSheetSpec = {
  role: HmtSheetRole;
  /** Tên sheet trong bảng tính, đúng nguyên văn. */
  name: string;
  label: string;
  /** Sheet này có bằng chứng tới mức MÓN hay chỉ tới mức KIỆN. */
  grain: "SHIPMENT" | "ITEM";
  /** Có được dùng làm căn cứ ghi nhận đã về kho hay không. */
  authoritative: boolean;
  why: string;
};

export const HMT_SHEETS: Record<HmtSheetRole, HmtSheetSpec> = {
  TRACKING_INDEX: {
    role: "TRACKING_INDEX",
    name: "MVĐ hoàn, 1 phần",
    label: "Danh sách mã vận đơn hoàn / hoàn một phần",
    grain: "SHIPMENT",
    authoritative: false,
    why: "Chỉ có mã vận đơn và trạng thái — không nói món nào đã về. Dùng để đối chiếu ĐỘ PHỦ (sheet chi tiết có bỏ sót kiện nào không), không dùng để ghi.",
  },
  FULL_RETURN_ITEMS: {
    role: "FULL_RETURN_ITEMS",
    name: "Chi tiết đơn hoàn",
    label: "Chi tiết đơn hoàn toàn phần",
    grain: "ITEM",
    authoritative: true,
    why: "Từng dòng là một món có mã vận đơn kèm theo — bằng chứng tới mức món cho kiện hoàn toàn phần.",
  },
  PARTIAL_RETURN_ITEMS: {
    role: "PARTIAL_RETURN_ITEMS",
    name: "Chi tiết đơn 1 phần",
    label: "Chi tiết đơn hoàn một phần",
    grain: "ITEM",
    authoritative: true,
    why: "Từng dòng là một món của kiện hoàn MỘT PHẦN. Chỉ những món có trong sheet mới được coi là đã về — không suy ra cả đơn.",
  },
};

export const HMT_SHEET_BY_NAME: Record<string, HmtSheetRole> = Object.fromEntries(
  HMT_SHEET_ROLES.map((r) => [HMT_SHEETS[r].name, r]),
);

/**
 * ═══════════ CHÍN TRẠNG THÁI KHỚP — CHỈ MỘT CÁI ĐƯỢC GHI ═══════════
 *
 * Không có trạng thái "gần khớp". Một dòng hoặc có đủ hai định danh trùng khớp, hoặc không — và
 * mọi cách nói giảm đi giữa hai vế đó đều dẫn tới việc ai đó bấm nút "ghi hết".
 */
export const HMT_MATCH_STATUSES = [
  "MATCHED",
  "ALREADY_RECEIVED",
  "AMBIGUOUS_TRACKING",
  "AMBIGUOUS_SKU",
  "SKU_MISMATCH",
  "QUANTITY_CONFLICT",
  "UNMATCHED_TRACKING",
  "DUPLICATE_SOURCE_ROW",
  "CONFLICT",
] as const;
export type HmtMatchStatus = (typeof HMT_MATCH_STATUSES)[number];

export type HmtMatchSpec = {
  key: HmtMatchStatus;
  label: string;
  /** Có ghi vào ERP hay không. ĐÚNG MỘT trạng thái được `true`. */
  writes: boolean;
  /** Câu nói cho người đọc báo cáo: vì sao dòng này ở nhóm này, và ai phải làm gì tiếp. */
  hint: string;
};

export const HMT_MATCH: Record<HmtMatchStatus, HmtMatchSpec> = {
  MATCHED: {
    key: "MATCHED",
    label: "Khớp — mã vận đơn và mẫu mã đều trùng",
    writes: true,
    hint: "Mã vận đơn lần ra đúng MỘT kiện trong ERP, mẫu mã lần ra đúng MỘT mẫu mã, và mẫu mã đó nằm trong danh sách hàng kỳ vọng của chính kiện đó. Ghi nhận ĐÃ VỀ KHO — chưa vào tồn.",
  },
  ALREADY_RECEIVED: {
    key: "ALREADY_RECEIVED",
    label: "Kho đã ghi nhận từ trước",
    writes: false,
    hint: "Kiện đã có phiếu nhận (hoặc đã đếm xong). Không ghi lần hai — đây là điều kiện làm cho lượt chạy thứ hai không sinh thêm gì.",
  },
  AMBIGUOUS_TRACKING: {
    key: "AMBIGUOUS_TRACKING",
    label: "Mã vận đơn không xác định được",
    writes: false,
    hint: "Ô mã vận đơn trống mà bảng tính không gộp ô để chứng minh dòng này thuộc kiện phía trên, hoặc mã lần ra nhiều kiện. Người đọc sổ giấy phải điền mã rồi chạy lại.",
  },
  AMBIGUOUS_SKU: {
    key: "AMBIGUOUS_SKU",
    label: "Mẫu mã lần ra nhiều ứng viên",
    writes: false,
    hint: "Mã hàng + màu + size lần ra từ hai mẫu mã trở lên trong danh mục. ERP không chọn hộ — danh mục phải tách trước.",
  },
  SKU_MISMATCH: {
    key: "SKU_MISMATCH",
    label: "Mẫu mã không nằm trong hàng kỳ vọng của kiện",
    writes: false,
    hint: "Mẫu mã có thật, kiện có thật, nhưng mẫu mã đó không có trong đơn của kiện. Hoặc sổ ghi nhầm dòng, hoặc khách trả nhầm hàng — cả hai đều cần người xem.",
  },
  QUANTITY_CONFLICT: {
    key: "QUANTITY_CONFLICT",
    label: "Số lượng vượt quá số kỳ vọng",
    writes: false,
    hint: "Sổ ghi nhiều món hơn số còn lại có thể nhận của kiện. Không cắt bớt cho vừa — số dôi ra là một câu hỏi thật.",
  },
  UNMATCHED_TRACKING: {
    key: "UNMATCHED_TRACKING",
    label: "Mã vận đơn không có trong ERP",
    writes: false,
    hint: "Không kiện nào trong ERP mang mã này (kể cả sau khi lần mã gốc của vận đơn chiều về). Kiện có thể chưa được đồng bộ, hoặc sổ ghi sai mã.",
  },
  DUPLICATE_SOURCE_ROW: {
    key: "DUPLICATE_SOURCE_ROW",
    label: "Dòng trùng trong chính bảng tính",
    writes: false,
    hint: "Cùng sheet, cùng mã vận đơn, cùng dòng sản phẩm, xuất hiện nhiều lần và tổng vượt số kỳ vọng. Dòng đầu được xét; các dòng sau nằm ở đây để đếm được, không bị nuốt mất.",
  },
  CONFLICT: {
    key: "CONFLICT",
    label: "Hai sheet nói khác nhau về cùng một kiện",
    writes: false,
    hint: "Cùng một mã vận đơn xuất hiện ở CẢ sheet hoàn toàn phần LẪN sheet hoàn một phần. Một kiện không thể vừa hoàn cả vừa hoàn một phần — người phải quyết.",
  },
};

/** Trạng thái được ghi. Suy ra từ bảng khai, không gõ lại — hai chỗ khai là hai chỗ lệch. */
export const HMT_WRITABLE_STATUSES: readonly HmtMatchStatus[] = HMT_MATCH_STATUSES.filter((k) => HMT_MATCH[k].writes);

/**
 * ═══════════ Ô MÃ VẬN ĐƠN TRỐNG: KẾ THỪA CHỈ KHI CÓ CHỨNG CỨ CẤU TRÚC ═══════════
 *
 * Bảng tính có dòng sản phẩm mà ô mã vận đơn trống. Cách "hiển nhiên" là điền xuống từ dòng trên
 * (forward-fill). Cách đó SAI ở đúng chỗ nguy hiểm nhất: nếu người ghi sổ chỉ bỏ trống vì lười,
 * mọi món phía dưới sẽ bị gán cho một kiện không chứa chúng — và kiện đó được ghi nhận "đã về"
 * kèm bằng chứng của một kiện khác.
 *
 * Nên chỉ kế thừa khi CHÍNH TỆP nói rằng hai dòng thuộc cùng một kiện:
 *
 *  · `MERGED_CELL` — ô mã vận đơn được GỘP dọc qua nhiều dòng (`!merges` trong tệp xlsx). Đây là
 *    người ghi sổ nói ra bằng cấu trúc: "những dòng này là một kiện".
 *
 * Mọi trường hợp còn lại (`NONE`) là `AMBIGUOUS_TRACKING`. Không đoán.
 */
export const HMT_INHERITANCE = ["OWN_CELL", "MERGED_CELL", "NONE"] as const;
export type HmtInheritance = (typeof HMT_INHERITANCE)[number];

export const HMT_INHERITANCE_LABEL: Record<HmtInheritance, string> = {
  OWN_CELL: "Mã ghi ngay trên dòng",
  MERGED_CELL: "Kế thừa từ ô gộp — bảng tính chứng minh cùng một kiện",
  NONE: "Ô trống, không có chứng cứ cấu trúc",
};

/**
 * Vận đơn chiều về mang hậu tố `1P1`.
 *
 * Trong KPI của LẦN BÁN GỐC, vận đơn `1P1` bị loại (AGENTS.md mục 7 — nó là dòng riêng, không đè
 * lên vận đơn gốc). Nhưng trong bối cảnh HÀNG VỀ KHO thì nó ngược lại: chính nó là kiện chở hàng
 * hoàn về, nên nó là bằng chứng ĐÁNG GIÁ NHẤT, không phải rác.
 *
 * `lib/returns/product-context.ts` đã biết lần từ `1P1` về đơn gốc bằng `legBaseCode`. Ở đây chỉ
 * cần nhớ: không được lọc bỏ chúng.
 */
export const HMT_KEEP_RETURN_LEG = true;

/**
 * ═══════════ NGƯỜI GỠ MỘT DÒNG KHÔNG KHỚP — BỐN CÁCH, KHÔNG CÓ CÁCH THỨ NĂM ═══════════
 *
 * Lượt đối soát để lại 26 dòng không khớp và 144 mã chỉ có ở sheet tổng. Trước bản này chúng chỉ
 * là những con số trên một thẻ tóm tắt: đếm được, nhưng không ai LÀM được gì với chúng. Một con số
 * không có nút bấm là một con số người ta học cách bỏ qua.
 *
 * Bốn cách gỡ, và cả bốn đều đi qua NGƯỜI:
 *
 *  · `LINKED_SHIPMENT` — người kho tra ra kiện thật cho một mã sổ giấy ghi sai / ghi tắt. Bằng
 *    chứng là chính con mắt của họ trên kiện hàng, nên phải chọn ĐÍCH DANH một kiện trong ERP.
 *  · `RESOLVED_SKU`    — mẫu mã sổ ghi không đủ để máy lần ra (thiếu mã hàng, thiếu màu/size).
 *    Người chọn đúng mẫu mã trong danh mục.
 *  · `DISMISSED`       — dòng này không dẫn tới đâu (ghi nhầm, trùng, hàng của shop khác). BẮT
 *    BUỘC ghi lý do: một dòng biến mất không lời giải thích là một dòng sẽ quay lại làm phiền
 *    người tiếp theo.
 *  · *(chưa xử lý)*    — `NULL`. Đây là mặc định và là phần lớn; nó KHÔNG phải "đã xem xong".
 *
 * ─── ĐIỀU QUAN TRỌNG NHẤT: GỠ ≠ GHI TỒN ───
 *
 * Gỡ một dòng chỉ đưa nó vào hàng đợi ĐẾM, đúng như 724 dòng đã khớp. Tồn kho vẫn không đổi một
 * món nào cho tới khi người kho mở kiện ra đếm (AGENTS.md mục 10). Không có đường tắt nào từ
 * "người xác nhận mã vận đơn" tới "tồn tăng".
 *
 * ─── VÀ DÒNG ĐÃ GHI THÌ BẤT KHẢ XÂM PHẠM ───
 *
 * 724 dòng `MATCHED` đã là chứng cứ nhận hàng. Ràng buộc `hmt_return_rec_resolution_written_check`
 * ở CSDL cấm gắn kết luận của người lên chúng — muốn sửa một lượt nhận đã ghi thì đi đường huỷ
 * nhận (`undoReturnArrived`), để lại dấu vết, chứ không viết đè lên bằng chứng cũ.
 */
export const HMT_RESOLUTIONS = ["LINKED_SHIPMENT", "RESOLVED_SKU", "DISMISSED"] as const;
export type HmtResolution = (typeof HMT_RESOLUTIONS)[number];

export const HMT_RESOLUTION_LABEL: Record<HmtResolution, string> = {
  LINKED_SHIPMENT: "Đã nối tay với kiện trong ERP",
  RESOLVED_SKU: "Đã chọn đúng mẫu mã",
  DISMISSED: "Bỏ qua có lý do",
};

/** Cách gỡ nào BẮT BUỘC ghi lý do. Bỏ qua mà không nói vì sao là xoá bằng chứng lặng lẽ. */
export const HMT_RESOLUTION_NEEDS_NOTE: Record<HmtResolution, boolean> = {
  LINKED_SHIPMENT: true,
  RESOLVED_SKU: true,
  DISMISSED: true,
};

/**
 * ═══════════ BỐN HÀNG ĐỢI NGOẠI LỆ, BỐN VIỆC KHÁC NHAU ═══════════
 *
 * Gộp chúng thành một danh sách "cần xem lại" là cách chắc chắn nhất để không ai xem: bốn nhóm này
 * cần bốn thao tác khác nhau, do (có thể) hai người khác nhau làm, và một nhóm trong đó KHÔNG phải
 * việc của kho chút nào.
 */
export const HMT_EXCEPTION_QUEUES = ["SKU_REVIEW", "TRACKING_REVIEW", "NOT_IN_ERP", "TRACKING_ONLY"] as const;
export type HmtExceptionQueue = (typeof HMT_EXCEPTION_QUEUES)[number];

export type HmtQueueSpec = {
  key: HmtExceptionQueue;
  label: string;
  /** Trạng thái khớp nào rơi vào hàng đợi này. `TRACKING_ONLY` không đến từ bảng chứng cứ. */
  statuses: readonly HmtMatchStatus[];
  /** Người dùng phải LÀM gì — không phải mô tả vấn đề, mà là hành động tiếp theo. */
  action: string;
  /** Cách gỡ hợp lệ ở hàng đợi này. */
  allow: readonly HmtResolution[];
};

export const HMT_QUEUE: Record<HmtExceptionQueue, HmtQueueSpec> = {
  SKU_REVIEW: {
    key: "SKU_REVIEW",
    label: "Cần đối chiếu mẫu mã",
    statuses: ["SKU_MISMATCH", "AMBIGUOUS_SKU"],
    action: "Kiện có thật, mã vận đơn đúng — nhưng mẫu mã sổ ghi không nằm trong hàng kỳ vọng của kiện, hoặc ghi thiếu tới mức lần ra nhiều mẫu. Mở kiện xem hàng thật rồi chọn đúng mẫu mã.",
    allow: ["RESOLVED_SKU", "DISMISSED"],
  },
  TRACKING_REVIEW: {
    key: "TRACKING_REVIEW",
    label: "Cần xác minh mã vận đơn",
    statuses: ["AMBIGUOUS_TRACKING", "DUPLICATE_SOURCE_ROW", "CONFLICT", "QUANTITY_CONFLICT"],
    action: "Ô mã vận đơn trống mà bảng tính không gộp ô để chứng minh dòng thuộc kiện trên, hoặc mã lần ra nhiều kiện. Tra sổ giấy / kiện thật rồi nối tay với đúng kiện.",
    allow: ["LINKED_SHIPMENT", "DISMISSED"],
  },
  NOT_IN_ERP: {
    key: "NOT_IN_ERP",
    label: "Mã không có trong ERP",
    statuses: ["UNMATCHED_TRACKING"],
    action: "Không kiện nào trong ERP mang mã này. Hoặc vận đơn chưa đồng bộ về, hoặc sổ ghi sai mã (Excel hay đổi mã dài thành dạng khoa học). Kiểm tra rồi nối tay, hoặc bỏ qua kèm lý do.",
    allow: ["LINKED_SHIPMENT", "DISMISSED"],
  },
  TRACKING_ONLY: {
    key: "TRACKING_ONLY",
    label: "Có bằng chứng kiện, chưa có chi tiết hàng",
    statuses: [],
    action: "Mã có ở sheet tổng của sổ giấy nhưng không có dòng món nào. Mã vận đơn chứng minh DANH TÍNH KIỆN, không chứng minh trong kiện có món gì — nên ERP KHÔNG ghi nhận gì. Kho ghi bổ sung dòng món vào sổ rồi tải lại.",
    allow: [],
  },
};

/** Trạng thái khớp nào KHÔNG phải ngoại lệ — đã khớp hoặc kho đã ghi nhận từ trước. */
export const HMT_SETTLED_STATUSES: readonly HmtMatchStatus[] = ["MATCHED", "ALREADY_RECEIVED"];

export function queueOfStatus(status: HmtMatchStatus): HmtExceptionQueue | null {
  for (const q of HMT_EXCEPTION_QUEUES) if ((HMT_QUEUE[q].statuses as readonly string[]).includes(status)) return q;
  return null;
}

export function isHmtResolution(value: unknown): value is HmtResolution {
  return typeof value === "string" && (HMT_RESOLUTIONS as readonly string[]).includes(value);
}

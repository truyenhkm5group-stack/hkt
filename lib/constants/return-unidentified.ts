/**
 * ═══════════ HÀNG HOÀN CHƯA XÁC ĐỊNH NGUỒN ═══════════
 *
 * BA LỚP RIÊNG, KHÔNG SUY RA LẪN NHAU (cùng tinh thần luật 1 và luật 10 ở AGENTS.md):
 *
 *   LỚP 1 — KIỆN VẬT LÝ đã về tới kho.
 *   LỚP 2 — đã biết kiện đó thuộc đơn / vận đơn nào.
 *   LỚP 3 — đã đếm, đã kết luận, và đủ điều kiện bán lại.
 *
 * Đường hàng hoàn có mã vận đơn đã đi qua ba lớp ấy bằng `shipments` + `return_inspections`. Cái
 * thiếu là CA MẤT NHÃN: kiện nằm trên bàn, hàng còn nguyên, nhưng không có mã vận đơn nào để bắn.
 * Trước bản này ERP không có chỗ nào ghi nó, nên kho chỉ còn hai lựa chọn — cả hai đều sai:
 *
 *  · chọn đại một đơn gần giống ⇒ quy kết sai, và số liệu hoàn của một khách vô can bị bẩn;
 *  · lập một phiếu nhập kho thường ⇒ hàng hoàn đội lốt hàng nhập mới, giá vốn và tỷ lệ hoàn cùng sai.
 *
 * Nên bảng `return_unidentified` là LỚP 1 + LỚP 3 đứng RIÊNG khỏi lớp 2. Món hàng có thật, đếm
 * được, kết luận được — và vẫn KHÔNG vào tồn bán được cho tới khi có người đủ thẩm quyền quyết.
 *
 * ═══ VÌ SAO KHÔNG PHẢI MỘT DÒNG `stock_receipts` ═══
 *
 * `lib/queries/stock.ts` tính tồn bằng TỔNG mọi dòng `stock_receipt_items`. Ghi hàng chưa xác định
 * nguồn vào đó là cộng thẳng vào tồn bán được — đúng cái việc mà toàn bộ luồng kiểm đếm sinh ra để
 * ngăn. Hàng giữ tạm nằm ở bảng riêng và CHỈ chuyển thành một phiếu `RETURN` khi có người quyết,
 * nên "tồn thực tế" của ERP không bao giờ chứa hàng chưa ai chịu trách nhiệm.
 */

/**
 * VÌ SAO KIỆN NÀY KHÔNG CÓ MÃ VẬN ĐƠN.
 *
 * Ba lý do khác nhau dẫn tới ba việc khác nhau, nên chúng không được gộp thành "khác":
 *  · nhãn rách / mờ ⇒ còn hy vọng đọc lại một phần mã, đáng tra bằng mã vận đơn một phần;
 *  · mất hẳn nhãn ⇒ chỉ còn tra được bằng SĐT / mã hàng;
 *  · kiện lạ trong lô ⇒ có thể là hàng của shop khác, phải hỏi ĐVVC trước khi tính là của mình.
 */
export const UNIDENTIFIED_SOURCES = ["NO_TRACKING_LABEL", "DAMAGED_LABEL", "UNKNOWN_PARCEL"] as const;
export type UnidentifiedSource = (typeof UNIDENTIFIED_SOURCES)[number];

export const UNIDENTIFIED_SOURCE_LABEL: Record<UnidentifiedSource, string> = {
  NO_TRACKING_LABEL: "Mất nhãn vận đơn",
  DAMAGED_LABEL: "Nhãn rách / mờ, không đọc được",
  UNKNOWN_PARCEL: "Kiện lạ trong lô hàng về",
};

export const UNIDENTIFIED_SOURCE_HINT: Record<UnidentifiedSource, string> = {
  NO_TRACKING_LABEL: "Không còn mảnh nhãn nào. Chỉ tra được bằng SĐT khách, mã hàng, màu, size.",
  DAMAGED_LABEL: "Còn một phần mã đọc được — nhập phần đọc được vào ô mã vận đơn một phần để thu hẹp ứng viên.",
  UNKNOWN_PARCEL: "Kiện không thuộc lô hàng hoàn nào của shop. Hỏi ĐVVC trước khi kết luận là hàng của mình.",
};

/**
 * TRẠNG THÁI XÁC ĐỊNH NGUỒN — LỚP 2, và CHỈ lớp 2.
 *
 * Cố ý KHÔNG mang thông tin "đã vào tồn hay chưa": việc đó đọc ở `stock_receipt_id`. Hai nguồn cho
 * cùng một sự thật thì sớm muộn lệch nhau, và lúc đó không ai biết nguồn nào đúng (cùng lý do đã
 * ghi ở `lib/constants/return-lifecycle.ts`).
 */
export const UNIDENTIFIED_STATUSES = ["PENDING_IDENTIFICATION", "IDENTIFIED", "UNIDENTIFIABLE"] as const;
export type UnidentifiedStatus = (typeof UNIDENTIFIED_STATUSES)[number];

export const UNIDENTIFIED_STATUS_LABEL: Record<UnidentifiedStatus, string> = {
  PENDING_IDENTIFICATION: "Chờ xác định đơn",
  IDENTIFIED: "Đã xác định đơn",
  UNIDENTIFIABLE: "Không thể xác định",
};

export const UNIDENTIFIED_STATUS_HINT: Record<UnidentifiedStatus, string> = {
  PENDING_IDENTIFICATION: "Hàng đã có thật trong kho nhưng chưa biết của đơn nào. KHÔNG được cộng tồn bán được ở trạng thái này.",
  IDENTIFIED: "Đã nối được với một vận đơn / đơn hàng có thật. Từ đây hàng đi tiếp như mọi kiện hoàn khác.",
  UNIDENTIFIABLE: "Đã tra và kết luận không thể lần ra đơn. Muốn đưa vào tồn thì phải có người đủ thẩm quyền quyết, kèm lý do.",
};

export const UNIDENTIFIED_STATUS_TONE: Record<UnidentifiedStatus, "amber" | "green" | "rose"> = {
  PENDING_IDENTIFICATION: "amber",
  IDENTIFIED: "green",
  UNIDENTIFIABLE: "rose",
};

/**
 * AI / CÁI GÌ ĐÃ NỐI KIỆN NÀY VỚI ĐƠN.
 *
 * `MANUAL_MATCH` là con đường DUY NHẤT hiện có, và đó là chủ ý: máy KHÔNG tự nối. Khoá này tồn tại
 * để dòng dữ liệu tự khai ra căn cứ của nó — nếu sau này có một đường nối tự động (ví dụ ĐVVC gửi
 * lại mã), nó phải khai một khoá khác, và mọi báo cáo phân biệt được ngay hai loại quy kết.
 */
export const IDENTIFICATION_METHODS = ["MANUAL_MATCH"] as const;
export type IdentificationMethod = (typeof IDENTIFICATION_METHODS)[number];

export const IDENTIFICATION_METHOD_LABEL: Record<IdentificationMethod, string> = {
  MANUAL_MATCH: "Người kho đối chiếu và chọn",
};

/**
 * CĂN CỨ ĐỂ MỘT MÓN CHƯA XÁC ĐỊNH NGUỒN ĐƯỢC CỘNG VÀO TỒN.
 *
 * Hai căn cứ, hai mức quyền, và chúng phải phân biệt được MÃI VỀ SAU — không phải chỉ lúc bấm:
 *
 *  · `IDENTIFIED` — đã nối được với vận đơn thật. Đây là hàng hoàn bình thường, `inventory:write` đủ.
 *  · `MANAGER_OVERRIDE` — KHÔNG lần ra đơn, nhưng kho khẳng định nhận diện được mẫu mã và hàng còn
 *    bán được. Đây là một lời khẳng định không có chứng từ đối chiếu, nên nó cần quyền cao hơn
 *    (`inventory:restock-unidentified`) VÀ một lý do viết ra được.
 *
 * Giữ cờ này trên chính dòng dữ liệu để câu "tháng này có bao nhiêu món vào tồn mà không có chứng
 * từ đơn" trả lời được bằng một truy vấn, thay vì phải đọc ngược nhật ký.
 */
export const RESTOCK_AUTHORITIES = ["IDENTIFIED", "MANAGER_OVERRIDE"] as const;
export type RestockAuthority = (typeof RESTOCK_AUTHORITIES)[number];

export const RESTOCK_AUTHORITY_LABEL: Record<RestockAuthority, string> = {
  IDENTIFIED: "Đã nối được vận đơn",
  MANAGER_OVERRIDE: "Quản lý kho quyết, không có chứng từ đơn",
};

/** Quyền CAO HƠN `inventory:write` — chỉ để tái nhập hàng không lần ra được đơn. */
export const RESTOCK_UNIDENTIFIED_PERMISSION = "inventory:restock-unidentified";

/** Căn cứ của một lượt cộng tồn cho món không nhãn — suy từ TRẠNG THÁI XÁC ĐỊNH NGUỒN, không khai tay. */
export function restockAuthorityOf(status: string): RestockAuthority {
  return status === "IDENTIFIED" ? "IDENTIFIED" : "MANAGER_OVERRIDE";
}

export type UnidentifiedRestockCheck =
  | { ok: true; authority: RestockAuthority; reason: string }
  | { error: string; code: "NEEDS_PERMISSION" | "NEEDS_REASON" };

/**
 * LUẬT DUY NHẤT CHO MỌI LƯỢT CỘNG TỒN HÀNG HOÀN KHÔNG NHÃN — hàm THUẦN.
 *
 * Hai đường gọi nó, và chúng phải nói CÙNG một điều (Company OS · Agent R):
 *  · tái nhập nguyên món ở bàn hàng không nhãn (`restockUnidentifiedReturnAction`);
 *  · nhập lại SAU SỬA từ sổ kết cục (`setReturnDispositionCore`, grain `UNIDENTIFIED`).
 *
 * Chưa nối được đơn ⇒ lượt cộng tồn không chứng từ ⇒ cần `inventory:restock-unidentified` VÀ một lý do.
 * Đã nối được đơn ⇒ hàng hoàn bình thường, `inventory:write` (đã kiểm ở tầng action) là đủ.
 * Quyền kiểm TRƯỚC lý do: người không có quyền thì gõ lý do cũng vô ích — nói điều đó trước.
 */
export function checkUnidentifiedRestock(input: { status: string; reason: string; canOverride: boolean }): UnidentifiedRestockCheck {
  const authority = restockAuthorityOf(input.status);
  const reason = input.reason.trim();
  if (authority === "MANAGER_OVERRIDE" && !input.canOverride) {
    return {
      code: "NEEDS_PERMISSION",
      error:
        "Kiện này chưa lần ra được đơn nào, nên đưa nó vào tồn là một quyết định không có chứng từ đối chiếu — cần quyền “Tái nhập hàng hoàn không xác định nguồn” (quản lý kho / quản trị). Nhờ người có quyền bấm, hoặc tra thêm để nối được đơn trước.",
    };
  }
  if (authority === "MANAGER_OVERRIDE" && !reason) {
    return { code: "NEEDS_REASON", error: "Tái nhập hàng không lần ra được đơn thì bắt buộc ghi lý do (ví dụ: mất nhãn vận đơn, hàng còn nguyên tem)." };
  }
  return { ok: true, authority, reason };
}

/**
 * TIỀN TỐ MÃ NỘI BỘ. Đọc được bằng mắt, gõ lại được, và bắn được bằng máy quét sau khi in nhãn tạm.
 * Dạng: `UR-YYYYMMDD-NNNNN` (số thứ tự trong NGÀY, không phải toàn cục — người kho đọc "số 37 hôm
 * nay" dễ hơn "số 128.431").
 */
export const UNIDENTIFIED_CODE_PREFIX = "UR";

/** Số thứ tự trong ngày, đủ rộng cho một ngày dỡ hàng lớn mà vẫn ngắn để đọc. */
export const UNIDENTIFIED_SEQ_WIDTH = 5;

export function unidentifiedCode(date: Date, seq: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${UNIDENTIFIED_CODE_PREFIX}-${y}${m}${d}-${String(seq).padStart(UNIDENTIFIED_SEQ_WIDTH, "0")}`;
}

/** Nhận ra một mã nội bộ để ô bắn mã không đem nó đi tra vận đơn (và ngược lại). */
export function isUnidentifiedCode(value: string): boolean {
  return new RegExp(`^${UNIDENTIFIED_CODE_PREFIX}-\\d{8}-\\d{${UNIDENTIFIED_SEQ_WIDTH}}$`, "i").test(value.trim());
}

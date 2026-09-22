/**
 * ═══════════ KÉO RỘNG / THU HẸP MỘT CỘT — PHẦN TÍNH TOÁN, KHÔNG ĐỤNG DOM ═══════════
 *
 * Tách khỏi `components/data-table/column-resize.tsx` vì đây là phần DUY NHẤT quyết định một con
 * số: bề rộng mới của cột. Phần kia chỉ đọc chuột và ghi `style`. Hàm thuần thì kiểm được mà không
 * cần trình duyệt, và `tests/column-resize.test.ts` chạy chúng thay vì mô tả chúng bằng lời.
 *
 * ─── THU HẸP LÀ KHUẤT BỚT, KHÔNG PHẢI XUỐNG DÒNG (ĐỔI 22/09/2026) ───
 *
 * Bản đầu (21/09/2026) dựng cả tính năng trên lời hứa ngược lại: kéo hẹp thì chữ DỒN XUỐNG DÒNG,
 * không mất chữ nào. Lời hứa ấy do chính thuật toán bố cục bảng tự động giữ — bề rộng DÙNG của một
 * cột là `max(bề rộng khai, min-content)` — nên không ai lách được, kể cả khi người dùng MUỐN
 * lách. Chủ shop yêu cầu đổi: kéo một cột sát lại tới mức hai mép gần chạm nhau phải làm được, vì
 * đó là cách nhanh nhất để tạm bỏ qua một cột mà không phải mở nút "Cột".
 *
 * Nên bảng chuyển sang `table-layout: fixed` NGAY KHI có bề rộng người đặt: ở đó bề rộng khai
 * THẮNG nội dung, cột hẹp được tới sàn, phần tràn bị ô cắt đi.
 *
 * ─── VÀ ĐÂY LÀ GIÁ PHẢI TRẢ, CÙNG CÁCH TRẢ ───
 *
 * `table-layout` là thuộc tính của CẢ BẢNG, không của một cột. Bật `fixed` lên là MỌI cột đều mất
 * quyền nở ra theo nội dung — kể cả cột chưa ai chạm vào. Trang sau có một con số dài hơn thì nó
 * bị cắt, và `1.307.910.998 ₫` cắt còn `10.998 ₫` vẫn đọc được như một con số đầy đủ. Đó là đúng
 * cái lỗi §42 nói tới, chỉ khác là nó nằm ở tầng bố cục.
 *
 * Nên bề rộng chia làm HAI LOẠI, và chỉ một loại được lưu:
 *
 *   · CỘT ĐÃ KÉO — bề rộng do người dùng đặt, CỨNG, được phép cắt nội dung, và mép tràn được làm
 *     mờ (`clipFadeEdge`) để không ai đọc nhầm phần còn lại thành con số đủ.
 *   · MỌI CỘT CÒN LẠI — bề rộng ĐO LẠI từ chính bảng ở trạng thái không có bề rộng khai nào, mỗi
 *     khi dữ liệu đổi. Nghĩa là chúng bám sát nội dung y như khi tính năng này chưa tồn tại: không
 *     bao giờ cắt, và cũng không đóng băng ở con số của trang trước.
 *
 * Vì thế bản lưu chỉ chứa CỘT ĐÃ KÉO. Bản lưu cũ (`erp.colw`) chứa bề rộng của MỌI cột — lượt kéo
 * ngày ấy đóng băng cả bảng — nên khoá đổi sang `erp.colw2`: đọc bản cũ ra là kết luận "mọi cột
 * đều đã kéo" và mở ERP lên thấy cả bảng cắt chữ mà không ai bấm gì.
 */

/** Bề rộng vùng bắt chuột của tay kéo (px). Đủ rộng để trỏ trúng, đủ hẹp để không che chữ tiêu đề. */
export const RESIZE_HANDLE_WIDTH = 9;

/**
 * Sàn của thao tác KÉO, tính bằng px — "hai mép gần như chạm nhau".
 *
 * Không phải 0, và con số này KHÔNG được gõ tay: một cột hẹp hơn tay kéo thì tay kéo của nó tràn
 * sang đè lên tay kéo của cột bên trái, và người dùng mất khả năng kéo cột TRƯỚC đó trở lại — thu
 * một cột về 0 rồi không mở lại được là một cái bẫy một chiều. `+ 3` là khoảng thở để hai vùng bắt
 * chuột không chạm nhau.
 */
export const MIN_COLUMN_WIDTH = RESIZE_HANDLE_WIDTH + 3;

/** Trần của thao tác kéo. Rộng hơn nữa thì một cột nuốt cả bảng và người dùng mất phương hướng. */
export const MAX_COLUMN_WIDTH = 1200;

/**
 * Bề rộng dải làm mờ ở mép tràn (px).
 *
 * Phải LỚN HƠN phần đệm ngang của ô (`px-2.5` = 10px) thì mới ăn được vào chữ; nhỏ hơn thì mặt nạ
 * chỉ làm mờ phần đệm và chẳng nói với ai điều gì.
 */
export const CLIP_FADE_PX = 16;

/** Kẹp một bề rộng vào khoảng dùng được. Số không hữu hạn ⇒ `null` (KHÔNG quy về 0 — mục 42). */
export function clampColumnWidth(px: number): number | null {
  if (!Number.isFinite(px)) return null;
  return Math.round(Math.min(Math.max(px, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH));
}

/**
 * Bề rộng của MỌI cột sau một lượt kéo.
 *
 * ═══ VÌ SAO PHẢI TRẢ VỀ CẢ BẢNG CHỨ KHÔNG PHẢI MỖI CỘT ĐANG KÉO ═══
 *
 * `table-layout: fixed` đòi bề rộng cho mọi cột: cột nào không khai thì trình duyệt chia đều phần
 * còn lại, và người dùng kéo MỘT cột sẽ thấy cả bảng xếp lại. Nên trong suốt lượt kéo, bề rộng
 * ĐANG HIỂN THỊ của mọi cột được giữ nguyên tại con số lúc bấm chuột; chỉ đúng một cột đổi.
 *
 * ═══ SỐ 0 LÀ "CỘT ĐANG ẨN", KHÔNG PHẢI MỘT BỀ RỘNG QUÁ NHỎ ═══
 *
 * Nút "Cột" ẩn một cột bằng `display: none` trên từng ô. Với `table-layout: fixed`, cột ấy KHÔNG
 * tự biến mất — nó vẫn lấy đúng bề rộng đã khai trong `<colgroup>` và để lại một khoảng trắng.
 * Phép đo trả 0 cho cột như vậy, và số 0 phải đi thẳng qua đây: kẹp nó lên sàn 12px là ẩn 10 cột
 * thì được 120px khoảng trắng không ai giải thích nổi.
 */
export function resizedWidths(base: readonly number[], index: number, deltaPx: number): number[] {
  const out = base.map((w) => (w <= 0 ? 0 : (clampColumnWidth(w) ?? MIN_COLUMN_WIDTH)));
  if (index < 0 || index >= out.length || base[index] <= 0) return out;
  out[index] = clampColumnWidth(base[index] + deltaPx) ?? MIN_COLUMN_WIDTH;
  return out;
}

/**
 * MÉP NÀO SẼ TRÀN khi nội dung rộng hơn ô.
 *
 * ═══ `text-align` KHÔNG QUYẾT ĐỊNH ĐIỀU NÀY. ĐÃ ĐO. ═══
 *
 * Trực giác nói: ô canh phải (mọi ô tiền) giữ đuôi số sát mép phải, nên phần bị đẩy ra ngoài là
 * phần ĐẦU ⇒ làm mờ mép TRÁI. Bản đầu viết đúng như vậy, và nó SAI.
 *
 * ĐO TRÊN CHROME THẬT (22/09/2026, khối rộng 40px, nội dung 148px, `overflow: hidden`): với cả ba
 * giá trị `left` · `right` · `center`, phần tràn ra là **108px ở mép PHẢI và 0px ở mép trái**.
 * `text-align` chỉ xếp dòng khi dòng CÒN VỪA; dòng đã dài hơn ô thì nó bắt đầu ở mép đầu của chiều
 * viết và tràn về mép cuối, không có ngoại lệ. Nhìn thấy trên bảng Đơn hàng: cột "Tổng tiền" canh
 * phải thu còn 55px hiện `3.554.0` — phần ĐẦU, không phải phần đuôi.
 *
 * Nên câu hỏi duy nhất là CHIỀU VIẾT. Đặt nhầm mặt nạ sang mép không tràn thì nó chỉ làm mờ khoảng
 * trống — trông vẫn "có làm gì đó", mà con số bị cắt vẫn hiện ra sắc nét như một con số đầy đủ.
 * Một cảnh báo đặt sai chỗ tệ hơn không có cảnh báo.
 */
export function clipFadeEdge(direction: string): "left" | "right" {
  return direction.trim().toLowerCase() === "rtl" ? "left" : "right";
}

/** Mặt nạ chuyển sắc cho ô bị cắt. Trả chuỗi dùng được thẳng cho `mask-image`. */
export function clipFadeMask(edge: "left" | "right"): string {
  const f = `${CLIP_FADE_PX}px`;
  return edge === "left"
    ? `linear-gradient(to right, transparent 0, #000 ${f})`
    : `linear-gradient(to left, transparent 0, #000 ${f})`;
}

/**
 * KHOÁ LƯU BỀ RỘNG — dùng CHUNG một cách đặt khoá với nút ẩn/hiện cột.
 *
 * Chữ ký lấy từ NHÃN các cột, không phải từ số thứ tự: thêm hay bớt một cột thì chữ ký đổi, cấu
 * hình cũ không còn khớp và bảng trở về mặc định — thay vì đem bề rộng của cột "Doanh số" áp cho
 * cột "Vận chuyển" vừa chen vào giữa. Đường dẫn bỏ phần mã định danh để mọi đơn hàng dùng chung
 * một cấu hình bảng.
 */
export function tableConfigKey(prefix: string, pathname: string, tableId: string, labels: readonly string[]): string {
  const path = pathname.replace(/\/[0-9a-f-]{20,}/g, "/:id");
  const sig = labels.join("|");
  let hash = 0;
  for (let i = 0; i < sig.length; i++) hash = (hash * 31 + sig.charCodeAt(i)) | 0;
  return `${prefix}:${path}:${tableId}:${hash}`;
}

/**
 * Đọc cấu hình bề rộng đã lưu. Hỏng / lạ kiểu ⇒ COI NHƯ CHƯA ĐẶT, không ném lỗi ra màn hình.
 *
 * Mỗi khoá ở đây là một CỘT ĐÃ KÉO, tức một cột được phép cắt nội dung — xem khối đầu tệp về lý do
 * bản lưu cũ (`erp.colw`, chứa bề rộng của mọi cột) không được đọc bằng hàm này.
 */
export function parseStoredWidths(raw: string | null, columnCount: number): Record<number, number> {
  if (!raw) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const i = Number(k);
    // Chỉ nhận SỐ: `Number(null)` là 0, nên một giá trị `null` lọt qua sẽ hoá thành một bề rộng
    // hợp lệ (bị kẹp lên sàn) cho một cột chưa ai kéo.
    if (!Number.isInteger(i) || i < 0 || i >= columnCount || typeof v !== "number") continue;
    const w = clampColumnWidth(v);
    if (w !== null) out[i] = w;
  }
  return out;
}

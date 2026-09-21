/**
 * ═══════════ KÉO RỘNG / THU HẸP MỘT CỘT — PHẦN TÍNH TOÁN, KHÔNG ĐỤNG DOM ═══════════
 *
 * Tách khỏi `components/data-table/column-resize.tsx` vì đây là phần DUY NHẤT quyết định một con
 * số: bề rộng mới của cột. Phần kia chỉ đọc chuột và ghi `style`. Hàm thuần thì kiểm được mà không
 * cần trình duyệt, và `tests/column-resize.test.ts` chạy chúng thay vì mô tả chúng bằng lời.
 *
 * ─── VÌ SAO NỘI DUNG KHÔNG THỂ BỊ CẮT, DÙ KÉO HẸP TỚI ĐÂU ───
 *
 * Bề rộng đặt ở `<col>` chứ không ở từng ô, và bảng giữ nguyên `table-layout: auto`. Theo thuật
 * toán bố cục bảng tự động, bề rộng DÙNG của một cột là `max(bề rộng khai, min-content)` — trình
 * duyệt KHÔNG bao giờ thu một cột xuống dưới bề rộng tối thiểu của nội dung trong đó. Nghĩa là
 * hàng rào chống cắt chữ không nằm trong mã của chúng ta; nó nằm trong chính công cụ bố cục, nên
 * không có đường nào lách qua nó.
 *
 * Việc còn lại là cho `min-content` một giá trị HỢP LÝ:
 *
 *   · ô SỐ (`.numeric` — mọi ô tiền đi qua `<Money>` đều có)  ⇒ giữ `white-space: nowrap`.
 *     `min-content` = cả con số. "205.892.000 ₫" không bao giờ gãy làm đôi, và cột không bao giờ
 *     hẹp hơn nó. Một con số bị xuống dòng giữa chừng đọc ra một con số KHÁC.
 *   · ô CHỮ  ⇒ `white-space: normal` + `overflow-wrap: break-word`.
 *     Xuống dòng ở KHOẢNG TRẮNG, không bao giờ giữa một từ. `break-word` (khác `anywhere`) KHÔNG
 *     làm giảm `min-content`, nên cột vẫn không hẹp hơn TỪ DÀI NHẤT trong nó — mã vận đơn, SKU,
 *     số điện thoại vẫn nguyên vẹn.
 *
 * Nên "thu hẹp" ở đây nghĩa là CHỮ DỒN XUỐNG DÒNG, không phải chữ biến mất. Không `text-overflow`,
 * không `line-clamp`, không `overflow: hidden` — ba thứ đó đều là giấu nội dung đi, và một bảng
 * giấu nội dung thì người đọc không có cách nào biết là mình đang thiếu gì.
 */

/**
 * Sàn của thao tác KÉO, tính bằng px.
 *
 * Đây KHÔNG phải hàng rào chống cắt chữ (hàng rào đó là `min-content`, xem trên) — nó chỉ để con
 * trỏ không kéo được về 0 rồi cột biến thành một vạch. Trình duyệt vẫn có thể giữ cột rộng hơn
 * con số này khi nội dung đòi vậy; đó là đúng, không phải xung đột.
 */
export const MIN_COLUMN_WIDTH = 56;

/** Trần của thao tác kéo. Rộng hơn nữa thì một cột nuốt cả bảng và người dùng mất phương hướng. */
export const MAX_COLUMN_WIDTH = 1200;

/** Bề rộng vùng bắt chuột của tay kéo (px). Đủ rộng để trỏ trúng, đủ hẹp để không che chữ tiêu đề. */
export const RESIZE_HANDLE_WIDTH = 9;

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
 * Bố cục bảng tự động chia phần dư cho các cột chưa khai bề rộng. Nếu chỉ khai cột đang kéo, thu
 * hẹp nó sẽ làm SÁU cột khác giãn ra theo những tỷ lệ không ai đoán được — người dùng kéo một cột
 * và thấy cả bảng nhảy. Nên lúc bắt đầu kéo, bề rộng ĐANG HIỂN THỊ của mọi cột được ĐÓNG BĂNG;
 * từ đó trở đi chỉ đúng một cột đổi, và đóng băng ngay tại con số đang hiện nên không có cú nhảy
 * nào ở khoảnh khắc bấm chuột.
 */
export function resizedWidths(base: readonly number[], index: number, deltaPx: number): number[] {
  const out = base.map((w) => clampColumnWidth(w) ?? MIN_COLUMN_WIDTH);
  if (index < 0 || index >= out.length) return out;
  out[index] = clampColumnWidth(base[index] + deltaPx) ?? MIN_COLUMN_WIDTH;
  return out;
}

/**
 * Ô này được phép xuống dòng không? Xem khối chú thích đầu tệp cho lý do của từng nhánh.
 *
 * ═══ CHỈ `.numeric` MỚI LÀ LỜI KHAI, `whitespace-nowrap` THÌ KHÔNG ═══
 *
 * Cám dỗ đầu tiên là tôn trọng `whitespace-nowrap` như một ý định của người viết. Nhưng
 * `components/ui/table.tsx` đặt lớp ấy MẶC ĐỊNH cho **mọi** `<th>` và `<td>` của ERP — nó là một
 * mặc định bố cục, không phải một câu nói về ô này. Đọc nó thành ý định thì mọi ô đều "nowrap",
 * không cột nào hẹp lại được, và cả tính năng kéo cột thành ra chỉ nới rộng được.
 *
 * `.numeric` thì ngược lại: nó được gắn có chủ đích, ở đúng những ô mang một con số (mọi ô tiền đi
 * qua `<Money>` đều có). Đó mới là lời khai đáng nghe.
 */
export function wrapModeFor(cell: { className: string; containsNumeric: boolean }): "nowrap" | "wrap" {
  if (cell.containsNumeric || ` ${cell.className} `.includes(" numeric ")) return "nowrap";
  return "wrap";
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

/** Đọc cấu hình bề rộng đã lưu. Hỏng / lạ kiểu ⇒ COI NHƯ CHƯA ĐẶT, không ném lỗi ra màn hình. */
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
    if (!Number.isInteger(i) || i < 0 || i >= columnCount) continue;
    const w = clampColumnWidth(Number(v));
    if (w !== null) out[i] = w;
  }
  return out;
}

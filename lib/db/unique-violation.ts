/**
 * ═══════════ NHẬN RA MỘT LƯỢT GHI BỊ KHOÁ DUY NHẤT CHẶN ═══════════
 *
 * ─── VÌ SAO CẦN MỘT HÀM RIÊNG CHO MỘT CÂU TƯỞNG NHƯ ĐƠN GIẢN ───
 *
 * ĐÃ ĐO THẬT (20/09/2026, PGlite, trong bộ kiểm thử): drizzle **BỌC LẠI** lỗi của driver. Câu
 * `String(error)` trả về
 *
 *     Error: Failed query: insert into "tech_agent_runs" (...) values (...)
 *
 * — KHÔNG có tên ràng buộc, KHÔNG có mã SQLSTATE. Tên `tech_agent_runs_external_ref_uq` và mã
 * `23505` nằm ở `error.cause`, thấp hơn một tầng.
 *
 * Hậu quả nếu viết `String(error).includes("<tên khoá>")`: nhánh *"khoá duy nhất vừa chặn một lượt
 * ghi song song — đọc lại dòng của kẻ thắng"* KHÔNG BAO GIỜ chạy. Lượt gọi thua cuộc nhận một lỗi
 * ghi, trong khi CSDL vừa làm đúng việc của nó. Đúng loại sai không hiện ra cho tới ngày có hai
 * gói tin tới cùng một mili giây — tức là đúng ngày người ta cần nó chạy đúng nhất.
 *
 * Nên hàm này đi HẾT chuỗi `cause`, và hỏi cả hai vế: mã SQLSTATE `23505` (lời khai của Postgres,
 * không phụ thuộc câu chữ) HOẶC câu chữ chuẩn của Postgres. Có tên ràng buộc thì đòi ĐÚNG tên: hai
 * khoá duy nhất khác nhau trên cùng một bảng là hai sự việc khác nhau, và gộp chúng lại là lặng lẽ
 * bỏ qua một xung đột thật.
 */

/** Mã SQLSTATE của `unique_violation` — lời khai của Postgres, không đổi theo phiên bản hay ngôn ngữ. */
export const UNIQUE_VIOLATION = "23505";

type CoThe = { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };

/** Đi hết chuỗi `cause`, có trần — phòng một chuỗi tự trỏ vào chính nó. */
function chuoiNguyenNhan(error: unknown): CoThe[] {
  const ra: CoThe[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 10 && cur && typeof cur === "object"; i++) {
    ra.push(cur as CoThe);
    cur = (cur as CoThe).cause;
  }
  return ra;
}

/**
 * Lỗi này có phải "khoá duy nhất chặn" không?
 *
 * `constraint` để rỗng = hỏi về BẤT KỲ khoá duy nhất nào. Truyền tên thì chỉ đúng khoá ấy mới tính.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const chuoi = chuoiNguyenNhan(error);
  const laTrung = chuoi.some(
    (e) => String(e.code ?? "") === UNIQUE_VIOLATION || /duplicate key value violates unique constraint/i.test(String(e.message ?? "")),
  );
  if (!laTrung) return false;
  if (!constraint) return true;
  return chuoi.some((e) => String(e.constraint ?? "") === constraint || String(e.message ?? "").includes(constraint));
}

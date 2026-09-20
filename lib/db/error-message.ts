/**
 * ═══════════ LỖI CSDL PHẢI NÓI ĐƯỢC NGUYÊN NHÂN, KHÔNG PHẢI NGUYÊN VĂN CÂU SQL ═══════════
 *
 * ─── ĐO THẬT TRÊN PRODUCTION (20/09/2026) ───
 *
 * Hai lượt đồng bộ `PARTIAL` lưu lại đúng câu này trong `sync_runs.error`:
 *
 *     Đơn 4686: Failed query: insert into "shipments" ("id", "order_id", "attempt_no",
 *     "direction", "carrier", "partner_id", "tracking_code", "vtp_order_number",
 *     "order_reference", "partner_status", "stage", "vtp_status", … (còn 30 cột nữa)
 *
 * Người vận hành đọc xong vẫn **không biết vì sao**: trùng khoá? thiếu khoá ngoại? cột NOT NULL?
 * quá độ dài? Bốn nguyên nhân ấy dẫn tới bốn việc phải làm khác hẳn nhau, và câu trên không phân
 * biệt được cái nào — nó chỉ chép lại câu lệnh mà ai cũng đọc được trong mã nguồn.
 *
 * ─── VÌ SAO NÓ RA NÔNG NỖI ẤY ───
 *
 * drizzle **BỌC LẠI** lỗi của driver. `error.message` là chuỗi `Failed query: …` do drizzle dựng;
 * lời khai thật của Postgres — mã `SQLSTATE`, tên ràng buộc, dòng `detail` chỉ ra đúng giá trị gây
 * lỗi — nằm ở `error.cause`, thấp hơn một tầng. 29 chỗ trong kho này viết
 * `error instanceof Error ? error.message : String(error)`, nên 29 chỗ ấy đều vứt đúng phần có ích.
 *
 * Cùng cái bẫy đã làm nhánh chống-đua của `/api/tech/agent-run` không bao giờ chạy (xem
 * `lib/db/unique-violation.ts`). Lần này nó ăn vào nhật ký vận hành.
 *
 * ─── HÀM NÀY LÀM GÌ ───
 *
 * Đi hết chuỗi `cause`, lấy lời khai của Postgres, và **bỏ câu SQL dài** — chỉ giữ lại thao tác và
 * tên bảng, thứ duy nhất trong câu lệnh mà người đọc cần:
 *
 *     shipments: duplicate key value violates unique constraint
 *     "shipments_vtp_order_number_uq" [23505] · ràng buộc shipments_vtp_order_number_uq
 *     · Key (vtp_order_number)=(1234) already exists.
 *
 * ─── VÀ NÓ KHÔNG LÀM GÌ ───
 *
 * Không đoán, không phân loại lại, không rút gọn thành một nhãn. Nếu Postgres không nói gì thì hàm
 * trả về `error.message` nguyên trạng — CHƯA BIẾT vẫn là chưa biết (AGENTS.md mục 42), chứ không
 * bịa ra một nguyên nhân nghe hợp lý.
 */

type CoThe = { code?: unknown; constraint?: unknown; detail?: unknown; table?: unknown; message?: unknown; cause?: unknown };

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

const chu = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Rút gọn câu SQL của drizzle còn "thao tác + bảng".
 *
 * `insert into "shipments" ("id", "order_id", … 40 cột)` ⇒ `shipments`. Danh sách cột không nói
 * thêm được gì mà chiếm hết chỗ của phần có ích — và `sync_runs.error` bị cắt ở 2000 ký tự, nên
 * chỗ ấy là chỗ THẬT SỰ mất.
 */
function bangTuCauSql(message: string): string {
  const m = /(insert into|update|delete from|select .* from)\s+"?([\w.]+)"?/i.exec(message);
  return m ? m[2] : "";
}

/**
 * Mô tả một lỗi để NGƯỜI VẬN HÀNH đọc.
 *
 * Dùng ở mọi chỗ ghi lỗi vào `sync_runs`, nhật ký job, hay thông báo trả về màn hình. Lỗi không
 * phải lỗi CSDL thì hàm trả về `message` như cũ, nên thay thế `error.message` bằng hàm này không
 * bao giờ làm mất thông tin.
 */
export function moTaLoiCsdl(error: unknown, tranDoDai = 400): string {
  const chuoi = chuoiNguyenNhan(error);
  const goc = error instanceof Error ? error.message : String(error);

  /*
    TẦNG SÂU NHẤT CÓ LỜI KHAI CỦA POSTGRES MỚI LÀ TẦNG ĐÁNG ĐỌC.

    Tầng trên cùng luôn là lớp bọc của drizzle. Tìm tầng nào mang `code` (SQLSTATE) hoặc
    `constraint` — đó là nơi driver đặt sự thật.
  */
  const pg = chuoi.find((e) => chu(e.code) || chu(e.constraint) || chu(e.detail));
  if (!pg) return goc.slice(0, tranDoDai);

  const bang = chu(pg.table) || bangTuCauSql(goc);
  const phan: string[] = [];
  const loiPg = chu(pg.message);
  if (loiPg) phan.push(loiPg);
  const ma = chu(pg.code);
  if (ma) phan.push(`[${ma}]`);
  const rb = chu(pg.constraint);
  if (rb && !loiPg.includes(rb)) phan.push(`· ràng buộc ${rb}`);
  const ct = chu(pg.detail);
  if (ct) phan.push(`· ${ct}`);

  const than = phan.join(" ") || goc;
  return `${bang ? `${bang}: ` : ""}${than}`.slice(0, tranDoDai);
}

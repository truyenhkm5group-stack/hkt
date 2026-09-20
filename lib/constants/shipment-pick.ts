/**
 * ═══════════ MỘT ĐƠN CÓ THỂ CÓ NHIỀU VẬN ĐƠN — CHỌN ĐÚNG DÒNG ĐỂ GHÉP ═══════════
 *
 * Quan hệ `orders.shipment` khai là `one(...)`, nhưng khoá ngoại `shipments.order_id` KHÔNG duy
 * nhất: shop gửi lại một đơn bằng mã mới thì có thêm một dòng (`attempt_no` 2, 3…), và chiều hoàn
 * cũng là một dòng riêng (AGENTS.md mục 3.7). Drizzle khi ấy trả về MỘT dòng bất kỳ — không
 * `ORDER BY`, không lời hứa nào về việc đó là dòng nào.
 *
 * ─── ĐO THẬT, 21/09/2026, VÀ NÓ ĐANG LÀM HỎNG DỮ LIỆU THẬT ───
 *
 * `orders_reconcile` lượt 02:15 hỏng **23/492 đơn**, tất cả cùng một câu:
 *
 *     shipments: duplicate key value violates unique constraint "shipments_vtp_order_number_unique"
 *     [23505] · Key (vtp_order_number)=(PKE1523318522) already exists.
 *
 * Và `PKE1523318522` thuộc về CHÍNH đơn đang đồng bộ:
 *
 *     đơn 3459 → PKE1519955287 (lần gửi 1) · PKE1523318522 (lần gửi 2)
 *     đơn 3453 → PKE1519935701 (lần gửi 1) · PKE1523318525 (lần gửi 2)
 *     … 31/2.000 đơn có hai lần gửi, 23 trong số đó hỏng mỗi lượt đối chiếu.
 *
 * Chuỗi sự việc: `one()` nạp dòng lần gửi **1**; Pancake báo mã của lần gửi **2**; mã khác nhau nên
 * mã nguồn kết luận "đây là lần gửi mới" và INSERT — đâm vào chính dòng lần gửi 2 đã có. Cả lượt
 * ghi của đơn đó bị huỷ, nên **23 đơn ấy không nhận được bất kỳ cập nhật nào từ Pancake**, im lặng,
 * mỗi mười lăm phút, kể từ khi chúng có lần gửi thứ hai.
 *
 * ─── VÀ CÁI SAI THỨ HAI, KHÔNG KÊU THÀNH TIẾNG ───
 *
 * Kể cả khi không đâm khoá, dòng `one()` nạp về còn được dùng để GHÉP dữ liệu: `cod_collected`,
 * `delivered_at`, `is_final`, `vtp_status_date` của nó quyết định Pancake có được đụng vào chiều
 * logistics không. Ghép nhầm dòng là mang chứng từ của lần gửi này áp lên lần gửi kia — không lỗi,
 * không dấu vết, chỉ là số liệu sai.
 *
 * Nên luật ở đây trả lời đúng một câu: **trong các dòng vận đơn của đơn này, dòng nào là dòng mà
 * bản tin Pancake đang nói tới?**
 */

/** Chỉ những trường luật này thật sự đọc — để nơi gọi truyền gì cũng được, miễn có đủ bấy nhiêu. */
export type VanDonUngVien = {
  vtpOrderNumber: string | null;
  trackingCode: string | null;
  attemptNo: number | null;
  direction: string | null;
  createdAt: Date | null;
};

export type TinPancake = {
  vtpOrderNumber: string | null;
  trackingCode: string | null;
};

/**
 * Chọn dòng vận đơn để ghép với bản tin Pancake — HÀM THUẦN.
 *
 * Thứ tự KHÔNG tuỳ tiện, mỗi bậc là một mức chắc chắn khác hẳn:
 *
 *   1. **Trùng mã vận đơn ĐVVC** — danh tính do hãng vận chuyển cấp. Chắc chắn nhất, và chính là
 *      bậc chữa được lỗi 23505: mã Pancake đang báo đã nằm sẵn ở một dòng của đơn này.
 *   2. **Trùng mã tra cứu** — cùng một kiện, nhưng mã tra cứu do nhiều nguồn ghi nên yếu hơn bậc 1.
 *   3. **Lần gửi MỚI NHẤT** — bản tin không mang mã nào (đơn vừa tạo, chưa đẩy sang ĐVVC). Lần gửi
 *      đang chạy là lần mới nhất; ghép vào lần cũ là viết lên một lần gửi đã đóng.
 *
 * CHIỀU HOÀN KHÔNG BAO GIỜ LÀ ỨNG VIÊN. Dòng chiều về mang mã riêng (`<mã gốc>[số]P[số]`) và là
 * một vận đơn khác; để Pancake ghi lên đó là xoá chứng từ chiều hoàn bằng dữ liệu chiều đi — đúng
 * thứ AGENTS.md mục 3.7 cấm. `direction` rỗng/`null` (dòng cũ chưa khai) được coi là OUTBOUND: dữ
 * liệu cũ không khai chiều thì mặc định là chiều đi, và đó là phía HẸP hơn ở đây vì nó giữ nguyên
 * hành vi cho mọi đơn một-lần-gửi.
 */
export function chonVanDonDeGhep<T extends VanDonUngVien>(rows: readonly T[], tin: TinPancake): T | null {
  const diTiep = rows.filter((r) => (r.direction ?? "OUTBOUND") !== "RETURN");
  if (!diTiep.length) return null;

  const ma = (tin.vtpOrderNumber ?? "").trim();
  if (ma) {
    const trung = diTiep.find((r) => (r.vtpOrderNumber ?? "").trim() === ma);
    if (trung) return trung;
  }
  const tra = (tin.trackingCode ?? "").trim();
  if (tra) {
    const trung = diTiep.find((r) => (r.trackingCode ?? "").trim() === tra);
    if (trung) return trung;
  }

  /*
    MỚI NHẤT = `attempt_no` LỚN NHẤT, hoà thì lấy dòng tạo SAU.

    `attempt_no` là số thứ tự lần gửi do chính mã nguồn đặt; `created_at` chỉ là mốc ghi. Dùng mốc
    ghi làm căn cứ chính thì một lượt nhập lại dữ liệu cũ (tạo dòng lần gửi 1 sau dòng lần gửi 2)
    sẽ lật ngược thứ tự — và không có gì kêu lên.
  */
  return [...diTiep].sort((a, b) => {
    const d = (b.attemptNo ?? 1) - (a.attemptNo ?? 1);
    if (d !== 0) return d;
    return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  })[0];
}

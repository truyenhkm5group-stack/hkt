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

/** Thêm hai trường mà luật CHỌN LẦN GỬI ĐẠI DIỆN cần — `PRIMARY_ATTEMPT` đọc đúng bấy nhiêu. */
export type VanDonDaiDienUngVien = VanDonUngVien & { id: string; stage: string | null };

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
 * CHIỀU HOÀN KHÔNG BAO GIỜ LÀ ỨNG VIÊN — và nói cho đúng mức bảo vệ mà vế này đang cho.
 *
 * Dòng chiều về mang mã riêng (`<mã gốc>[số]P[số]`) và là một vận đơn KHÁC; để Pancake ghi lên đó
 * là xoá chứng từ chiều hoàn bằng dữ liệu chiều đi (AGENTS.md mục 3.7).
 *
 * **Đo production 21/09/2026, và kết quả không phải cái tôi tưởng:** có **297 vận đơn mang dạng mã
 * chiều hoàn**, nhưng **0 dòng nào có `direction = 'RETURN'`** — cột ấy chưa từng được ghi, mọi
 * dòng đứng ở giá trị mặc định. Thứ THẬT SỰ tách chiều hoàn ra khỏi đơn hôm nay là `order_id NULL`
 * (đúng mục 3.7), nên chúng không bao giờ nằm trong `order.attempts` ngay từ đầu.
 *
 * Nên vế lọc này hôm nay **không chặn được gì đang xảy ra** — nó là hàng rào cho ngày `direction`
 * bắt đầu được ghi, hoặc ngày một dòng chiều hoàn được gắn vào đơn. Giữ nó vì nhánh lỗi phải rơi
 * về phía HẸP hơn (mục 31); viết ra đây vì một hàng rào được mô tả mạnh hơn thực tế là thứ khiến
 * người sau thôi kiểm chỗ đó.
 *
 * `direction` rỗng/`null` được coi là OUTBOUND — dữ liệu chưa khai chiều thì mặc định là chiều đi,
 * và đó cũng là phía giữ nguyên hành vi cho mọi đơn một-lần-gửi.
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

/**
 * ═══════════ LẦN GỬI ĐẠI DIỆN CHO ĐƠN — BẢN TYPESCRIPT CỦA `PRIMARY_ATTEMPT` ═══════════
 *
 * ĐÂY LÀ MỘT CÂU HỎI KHÁC HẲN `chonVanDonDeGhep`, và gộp chúng là làm hỏng cả hai:
 *
 *   · `chonVanDonDeGhep` hỏi **"bản tin này nói về dòng nào?"** — dùng ở đường GHI. Câu trả lời
 *     phải là lần gửi ĐANG CHẠY, vì bản tin mô tả tình trạng hiện thời. Ghi nó lên một lần gửi đã
 *     giao xong là bôi lên chứng từ.
 *   · `vanDonDaiDien` hỏi **"lần gửi nào ĐẠI DIỆN cho đơn?"** — dùng ở đường ĐỌC. Câu trả lời là
 *     lần gửi TỚI TAY KHÁCH nếu có: khách đã nhận hàng ở lần nào thì đơn ấy là giao thành công,
 *     và một lần gửi thay thế sau đó không xoá được sự thật đó.
 *
 * Và nó phải khớp TỪNG BẬC với `PRIMARY_ATTEMPT` trong `lib/queries/return-rate.ts` — điều kiện
 * nối mà MỌI báo cáo tiền đang dùng:
 *
 *     order by (sh.stage = 'DELIVERED') desc, sh.attempt_no desc nulls last, sh.created_at desc, sh.id
 *
 * Lệch một bậc là màn hình danh sách in mã vận đơn của lần gửi này trong khi cột tiền ngay cạnh
 * tính theo lần gửi kia — cùng lớp bẫy với AGENTS.md mục 41, nơi SQL và TypeScript lặng lẽ nói hai
 * điều khác nhau. `tests/shipment-pick.test.ts` chạy cả hai bản trên cùng dữ liệu rồi so từng đơn.
 *
 * Đo 21/09/2026: 31 đơn hai lần gửi, 15 đơn có lần đã giao, và **0 đơn mà hai luật chọn khác nhau**
 * — nên khớp chúng lại hôm nay KHÔNG đổi một con số nào; nó chỉ chặn ngày chúng bắt đầu lệch.
 */
export function vanDonDaiDien<T extends VanDonDaiDienUngVien>(rows: readonly T[]): T | null {
  const diTiep = rows.filter((r) => (r.direction ?? "OUTBOUND") !== "RETURN");
  if (!diTiep.length) return null;
  return [...diTiep].sort((a, b) => {
    const giao = Number(b.stage === "DELIVERED") - Number(a.stage === "DELIVERED");
    if (giao !== 0) return giao;
    const lan = (b.attemptNo ?? 0) - (a.attemptNo ?? 0);
    if (lan !== 0) return lan;
    const moc = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
    if (moc !== 0) return moc;
    // Chốt bằng `id` để hai lần chạy ra cùng kết quả — số liệu không được đổi chỉ vì thứ tự trả về.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

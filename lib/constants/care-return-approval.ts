/**
 * ═══════════ "ĐỀ NGHỊ HOÀN" VÀ "ĐÃ DUYỆT HOÀN" LÀ HAI SỰ VIỆC, VÀ CHỈ MỘT LÀ ĐIỂM KHÔNG QUAY LẠI ═══════════
 *
 * ─── VÌ SAO KHÔNG ĐƯỢC ĐỌC `shipment_stage` ───
 *
 * `RETURNING` gộp cả ba mã lại làm một, trong khi chúng nói ba điều khác hẳn nhau về việc đội
 * chăm sóc CÒN LÀM ĐƯỢC GÌ KHÔNG:
 *
 *   505 "Yêu cầu chuyển hoàn"          — ĐVVC mới ĐỀ NGHỊ. Shop vẫn bấm được 508 "Đơn vị yêu cầu
 *                                        phát tiếp" hoặc 550 "Khách hàng yêu cầu phát tiếp".
 *                                        ⇒ CÒN CỨU ĐƯỢC. Chốt ca ở đây là giết việc đúng lúc nó
 *                                        còn làm được — đã có tiền lệ thật: PKE1521276709 nhận 505
 *                                        ngày 19/09/2026, shop xin phát tiếp ngày 20/09.
 *   515 "Bưu cục phát duyệt hoàn"      — ĐÃ DUYỆT. Đây chính là chữ "Đã duyệt hoàn" trên
 *                                        viettelpost.vn.
 *   502 "Chuyển hoàn bưu cục gốc"      — hàng đã lên đường về. Sau 515.
 *
 * ─── VÌ SAO CHỮ KHÔNG ĐƯỢC ĐÈ LÊN MÃ ───
 *
 * Tên của 505 là "Tồn - Thông báo chuyển hoàn bưu cục gốc" và tên của 502 là "Chuyển hoàn bưu cục
 * gốc" — chuỗi con GIỐNG HỆT NHAU. Nên khi có mã thì MÃ quyết định, không bao giờ hỏi tới chữ;
 * chữ chỉ dùng cho dòng tệp Danh sách vận đơn (không có cột mã), và chỉ với những câu mà 505 không
 * bao giờ mang: 505 không có chữ "duyệt".
 *
 * ─── VÌ SAO "CHỜ XỬ LÝ" KHÔNG NẰM Ở ĐÂY ───
 *
 * Dòng tệp "Chờ xử lý" + cột Trả hàng = x nghĩa là CHỜ xử lý hoàn — tức đang đợi một quyết định,
 * và quyết định đó có thể là phát tiếp. Nó là `RETURNING` nhưng KHÔNG phải đã duyệt.
 */

/** Hoàn ĐÃ ĐƯỢC DUYỆT — từ mốc này đội chăm sóc không còn cửa can thiệp. */
export const RETURN_APPROVED_CODES: readonly number[] = [502, 515];

/** Mới ĐỀ NGHỊ hoàn — vẫn còn cửa phát tiếp. Cố ý tách ra để không ai gộp nhầm vào danh sách trên. */
export const RETURN_PROPOSED_CODES: readonly number[] = [505];

/**
 * Câu chữ CHỈ xuất hiện khi hoàn đã được duyệt. Không câu nào trong đây là chuỗi con của tên mã
 * 505 — đó là điều kiện để danh sách này an toàn, và `tests/care-return-approval.test.ts` khoá nó.
 */
export const RETURN_APPROVED_TEXTS: readonly string[] = ["duyet hoan", "dang chuyen hoan", "don vi yeu cau hoan ve"];

function bodau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * ĐVVC đã duyệt hoàn chưa? Hàm THUẦN — cùng đầu vào cho cùng câu trả lời, không đọc CSDL.
 *
 * Có mã ⇒ chỉ mã quyết định (kể cả khi mã nói KHÔNG, vì chữ đi kèm mơ hồ). Không mã ⇒ xét chữ.
 */
export function returnApproved(input: { code?: number | null; text?: string | null }): boolean {
  const code = input.code ?? null;
  if (code !== null) return RETURN_APPROVED_CODES.includes(code);
  const text = bodau(String(input.text ?? "").trim());
  if (!text) return false;
  return RETURN_APPROVED_TEXTS.some((k) => text.includes(k));
}

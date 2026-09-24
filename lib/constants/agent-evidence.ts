/**
 * ═══════════ SỔ CHỨNG TỪ SỐ ĐO — NÓI RA CHO AGENT BIẾT NÓ CÓ ═══════════
 *
 * `docs/perf/` chứa số đo production thật, chép nguyên văn từ `ops perf-probe` / `ops verify`.
 * PR #145 đã khoá nó lại để agent không ghi vào. Nhưng khoá ghi không làm agent BIẾT nó tồn tại,
 * và đó là một lỗ khác hẳn.
 *
 * ─── ĐO BA LẦN, HỎNG BA LẦN, CÙNG MỘT KIỂU ───
 *
 * · TECH-5 (lượt #39): trích tệp số đo **0 lần**, rồi tự sinh `baseline-T1-example.json` với
 *   `orders: 1147 · shipments: 1302` — production có 1.401 và 2.572.
 * · TECH-7 (lượt #36): trích **0 lần**; số nó dùng là thật nhưng lấy từ chú thích trong mã, và
 *   mốc dòng lệch 250–450 dòng nên người đọc lần theo sẽ kết luận là bịa.
 * · TECH-6 (lượt #42): trích **0 lần**, trong khi `docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md`
 *   NẰM SẴN trong đúng cây nó đọc. Bảng "Hiện Tại" của nó ghi `Payload ~185KB` — số đo thật là
 *   `/orders` 276 kB · `/shipments` 1.333 kB · `/ads` 5.840 kB.
 *
 * Ba lần là một khuôn, không phải ba tai nạn. Phạm vi ĐỌC của agent có `docs/`, nên nó ĐƯỢC phép
 * đọc — nhưng không có gì nói cho nó biết đọc cái gì, và một agent không tự đi liệt kê thư mục
 * (`list_directory` cố ý không nằm trong bộ công cụ). Nó chỉ thấy đề bài.
 *
 * Nên đề bài phải KỂ TÊN. Đây là dữ liệu, không phải lời dặn: một danh sách tên tệp có thật, đọc
 * từ đĩa lúc dựng đề bài. Không có tệp nào thì KHÔNG in gì — một khối rỗng dạy agent rằng thư mục
 * ấy vô dụng.
 */

/** Hàm THUẦN: nhận danh sách tên tệp, trả về khối văn bản chèn vào đề bài. Rỗng ⇒ chuỗi rỗng. */
export function khoiSoChungTu(tep: readonly string[]): string {
  if (!tep.length) return "";
  const ds = [...tep].sort().map((t) => `· ${t}`).join("\n");
  return [
    "",
    "SỐ ĐO PRODUCTION ĐÃ CÓ SẴN TRONG KHO — ĐỌC TRƯỚC KHI VIẾT MỘT CON SỐ NÀO:",
    ds,
    "Những tệp này là CHỨNG TỪ: số trong đó đã được đo thật trên dữ liệu production.",
    "Bạn KHÔNG đo được production từ máy này, nên mọi con số bạn viết ra phải TRÍCH từ chúng,",
    "kèm tên tệp. Không có số cho điều bạn muốn nói thì viết là CHƯA ĐO ĐƯỢC — đừng ước lượng,",
    "và đừng đặt một con số nghe hợp lý vào một bảng mang tiêu đề \"Hiện Tại\".",
    "",
  ].join("\n");
}

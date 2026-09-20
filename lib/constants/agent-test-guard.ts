/**
 * ═══════════ AGENT GHI ĐƯỢC `tests/` THÌ NÓ LÀM XANH ĐƯỢC CỔNG BẰNG CÁCH XOÁ KHẲNG ĐỊNH ═══════════
 *
 * Nấc 2 cho vai QA quyền ghi `tests/`. Đó là bước nguy hiểm nhất trong cả lộ trình, và lý do thì
 * đơn giản đến mức khó chịu:
 *
 *     Mục tiêu của runner là "bốn cổng xanh". Cách ĐẮT là sửa mã cho đúng.
 *     Cách RẺ là xoá khẳng định đang đỏ.
 *
 * Một bộ tối ưu sẽ tìm ra cách rẻ. Không phải vì nó "gian" — mà vì ta đã định nghĩa mục tiêu như
 * vậy và quên khoá lối tắt.
 *
 * ─── HÀM NÀY LÀM GÌ ───
 *
 * Đếm khẳng định trong từng tệp kiểm thử, TRƯỚC và SAU lượt chạy. Giảm ⇒ lượt chạy KHÔNG ĐẠT.
 * Thêm hoặc giữ nguyên ⇒ đạt. Tệp mới hoàn toàn thì không có gì để giảm.
 *
 * ─── VÀ NÓ KHÔNG LÀM GÌ (nói thẳng, vì một hàng rào được mô tả quá lời còn tệ hơn không có) ───
 *
 * Nó bắt việc XOÁ. Nó KHÔNG bắt việc LÀM YẾU mà giữ nguyên số lượng:
 *
 *     assert.equal(tong, 1_250_000)   →   assert.ok(tong >= 0)
 *
 * vẫn là một khẳng định. Chặn được lớp đó thì phải so ngữ nghĩa, và một bộ so ngữ nghĩa sai sẽ
 * chặn cả những lần sửa bài kiểm hợp lệ. Nên lớp ấy vẫn thuộc về NGƯỜI ĐỌC DIFF — và đó chính là
 * lý do mọi thay đổi của agent phải đi qua pull request có người duyệt, không có đường tắt nào.
 */

/**
 * Những dạng khẳng định được đếm.
 *
 * `assert.*` là dạng duy nhất kho này dùng, nhưng `expect(` và `t.` được đếm luôn để hàng rào
 * không mất hiệu lực trong im lặng vào ngày ai đó thêm một thư viện kiểm thử khác.
 */
const MAU_KHANG_DINH = /\b(?:assert\s*\.\s*\w+\s*\(|assert\s*\(|expect\s*\(|t\s*\.\s*(?:is|not|true|false|deepEqual|throws)\s*\()/g;

/** Bỏ chú thích và chuỗi ký tự trước khi đếm — một đoạn GIẢI THÍCH về `assert.equal` không phải một khẳng định. */
function boNhieu(ma: string): string {
  return ma
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^\\"])*"/g, '""')
    .replace(/'(?:\\.|[^\\'])*'/g, "''");
}

/** Số khẳng định trong một tệp. */
export function demKhangDinh(ma: string): number {
  return (boNhieu(ma).match(MAU_KHANG_DINH) ?? []).length;
}

export type TepKiemThu = { path: string; truoc: string | null; sau: string | null };

export type KetLuanHangRao =
  | { ok: true; daXem: number; themVao: number }
  | { ok: false; viPham: { path: string; truoc: number; sau: number }[]; daXem: number };

/**
 * Lượt chạy có làm yếu bộ kiểm thử không.
 *
 * `truoc = null` ⇒ tệp MỚI (không có gì để giảm). `sau = null` ⇒ tệp bị XOÁ — luôn là vi phạm,
 * vì xoá cả tệp là cách xoá khẳng định triệt để nhất.
 */
export function kiemHangRaoBaiKiem(tep: readonly TepKiemThu[]): KetLuanHangRao {
  const viPham: { path: string; truoc: number; sau: number }[] = [];
  let themVao = 0;
  for (const t of tep) {
    const truoc = t.truoc === null ? 0 : demKhangDinh(t.truoc);
    if (t.sau === null) {
      // Xoá tệp: đếm là 0, và luôn vi phạm nếu tệp cũ từng có khẳng định nào.
      if (truoc > 0) viPham.push({ path: t.path, truoc, sau: 0 });
      continue;
    }
    const sau = demKhangDinh(t.sau);
    if (sau < truoc) viPham.push({ path: t.path, truoc, sau });
    else themVao += sau - truoc;
  }
  if (viPham.length) return { ok: false, viPham, daXem: tep.length };
  return { ok: true, daXem: tep.length, themVao };
}

/** Câu giải thích cho người đọc log — nêu ĐÚNG tệp và ĐÚNG con số, không nói chung chung. */
export function moTaViPham(k: KetLuanHangRao): string {
  if (k.ok) return `${k.daXem} tệp kiểm thử đã xem · +${k.themVao} khẳng định · không tệp nào bị làm yếu.`;
  return [
    `Lượt chạy LÀM YẾU bộ kiểm thử ở ${k.viPham.length}/${k.daXem} tệp:`,
    ...k.viPham.map((v) => `  · ${v.path}: ${v.truoc} → ${v.sau} khẳng định`),
    "Cổng xanh đạt được bằng cách xoá khẳng định KHÔNG phải cổng xanh.",
  ].join("\n");
}

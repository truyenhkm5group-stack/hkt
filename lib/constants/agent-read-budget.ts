/**
 * ═══════════ NGÂN SÁCH ĐỌC TỆP CỦA AGENT — TRẦN CỬA SỔ NGỮ CẢNH LÀ CÓ THẬT ═══════════
 *
 * ĐÃ CẮN THẬT, lượt chạy agent #22 — lần đầu vai **QA** chạy được:
 *
 *     ✗ FAILED
 *       lý do: 400 prompt is too long: 205.844 tokens > 200.000 maximum
 *       cổng: typecheck=UNKNOWN lint=UNKNOWN test=UNKNOWN build=UNKNOWN
 *
 * Cả lượt chạy mất trắng — không commit, không PR, không một cổng nào được chạy.
 *
 * ─── VÌ SAO NÓ CHỈ CẮN VAI QA, VÀ VÌ SAO ĐÓ KHÔNG PHẢI XUI ───
 *
 * Kết quả `run_command` ĐÃ được cắt còn 4.000 ký tự cuối từ lâu. Kết quả `read_file` thì KHÔNG —
 * nó trả về nguyên tệp. Người viết trần ấy nghĩ tới một chiều và bỏ sót chiều kia.
 *
 * Vai `DOCUMENTATION` không bao giờ chạm tới: `docs/` toàn tệp nhỏ. Vai `QA` thì BẮT BUỘC đọc
 * những tệp lớn nhất kho — đo thật 21/09/2026:
 *
 *     160.430 ký tự   tests/sync-fixtures.test.ts      ← bộ chạy chính, phải đọc để đăng ký bài kiểm
 *     121.663 ký tự   tests/migration-upgrade-path.test.ts
 *      66.632 ký tự   tests/tech-phase2a.test.ts
 *
 * Một mình `sync-fixtures` đã ~45.000 token. Hai ba tệp là chạm trần 200.000 — và lỗi ấy nổ ra ở
 * giữa lượt, sau khi tiền của những vòng trước đã tiêu xong.
 *
 * ─── CẮT THÌ PHẢI NÓI LÀ ĐÃ CẮT ───
 *
 * Cắt im lặng còn tệ hơn lỗi 400: agent đọc nửa tệp mà TƯỞNG mình đọc cả tệp, rồi kết luận về
 * phần nó chưa từng thấy — và kết luận ấy trông hợp lý y như thật. Nên mọi lần cắt đều chèn một
 * câu nói rõ đã bỏ đi bao nhiêu ký tự, ngay tại chỗ bị bỏ.
 *
 * ─── GIỮ ĐẦU **VÀ** ĐUÔI, KHÔNG PHẢI MỖI ĐẦU ───
 *
 * Tệp trong kho này có hình dạng rất đều: `import` và docblock ở ĐẦU, còn danh sách đăng ký / lời
 * gọi thật nằm ở CUỐI (`tests/sync-fixtures.test.ts` là ví dụ đúng nhất — `main()` ở đáy tệp).
 * Cắt mỗi phần đầu thì agent thấy hết import mà không thấy chỗ phải thêm dòng của mình; cắt mỗi
 * phần đuôi thì ngược lại. Nên giữ cả hai đầu và nói rõ khúc giữa đã mất.
 */

export const DOC_NGAN_SACH = {
  /** Trần cho MỘT lần đọc (~10.000 token). Đủ nguyên vẹn cho khoảng 95% tệp trong kho. */
  moiLan: 40_000,
  /**
   * Trần CỘNG DỒN cho cả lượt chạy (~60.000 token).
   *
   * Chừa chỗ cho đề bài, kết quả lệnh, và phần model tự viết ra — chứ không dùng hết 200.000.
   * Một lượt chạy đọc tới đây mà chưa kết luận được thì vấn đề là PHẠM VI VIỆC, không phải trần.
   */
  caLuot: 240_000,
  /** Phần ĐẦU giữ lại khi phải cắt; phần còn lại lấy từ ĐUÔI. */
  tyLeDau: 0.6,
} as const;

export type DocTepKetQua =
  | { ok: true; noiDung: string; daCat: boolean; daDungSau: number }
  | { ok: false; ma: "HET_NGAN_SACH"; ly: string };

/**
 * Cắt một tệp cho vừa ngân sách — HÀM THUẦN.
 *
 * `daDung` = tổng số ký tự đã đưa vào hội thoại từ đầu lượt chạy. Hết ngân sách thì trả về một
 * câu TỪ CHỐI đọc được, KHÔNG phải một chuỗi rỗng: agent phải biết nó đang bị chặn vì lý do gì,
 * nếu không nó sẽ đọc lại chính tệp ấy thêm vài lần nữa.
 */
export function catTepChoVua(input: { noiDung: string; daDung: number }): DocTepKetQua {
  const goc = input.noiDung;
  const conLai = DOC_NGAN_SACH.caLuot - input.daDung;
  if (conLai <= 0) {
    return {
      ok: false,
      ma: "HET_NGAN_SACH",
      ly: `Đã đọc hết ngân sách ${DOC_NGAN_SACH.caLuot.toLocaleString("vi-VN")} ký tự cho lượt chạy này. KHÔNG đọc thêm tệp nào nữa — hãy làm việc với những gì đã đọc, hoặc gọi finish và nói rõ còn thiếu gì.`,
    };
  }

  const tran = Math.min(DOC_NGAN_SACH.moiLan, conLai);
  if (goc.length <= tran) {
    return { ok: true, noiDung: goc, daCat: false, daDungSau: input.daDung + goc.length };
  }

  const soDau = Math.floor(tran * DOC_NGAN_SACH.tyLeDau);
  const soDuoi = tran - soDau;
  const boDi = goc.length - tran;
  const moc =
    `\n\n… ⚠ TỆP BỊ CẮT: tệp dài ${goc.length.toLocaleString("vi-VN")} ký tự; ở đây chỉ có ` +
    `${soDau.toLocaleString("vi-VN")} ký tự ĐẦU và ${soDuoi.toLocaleString("vi-VN")} ký tự CUỐI. ` +
    `${boDi.toLocaleString("vi-VN")} ký tự ở GIỮA không có mặt — đừng kết luận gì về phần đó. …\n\n`;

  return {
    ok: true,
    noiDung: goc.slice(0, soDau) + moc + goc.slice(goc.length - soDuoi),
    daCat: true,
    daDungSau: input.daDung + tran,
  };
}

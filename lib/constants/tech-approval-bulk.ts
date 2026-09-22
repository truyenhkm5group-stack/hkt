/**
 * ═══════════ KÝ DUYỆT NHIỀU VIỆC MỘT LƯỢT — LUẬT THUẦN ═══════════
 *
 * ─── VÌ SAO CÓ ───
 *
 * Chủ shop phải mở TỪNG việc ra mới ký được. Đo 22/09/2026: chín việc `TECH-4…TECH-12` cùng sinh
 * ra từ MỘT bản kế hoạch mà chủ shop đã đọc và duyệt cả bản — rồi vẫn phải mở chín trang để ký
 * chín chữ ký cho đúng cái quyết định vừa đưa ra. Một cổng bắt người ta lặp lại chính mình chín
 * lần không làm quyết định kỹ hơn; nó làm người ta bấm cho nhanh.
 *
 * ─── VÌ SAO NÓ KHÔNG PHẢI MỘT CÁI CỔNG BỊ NỚI ───
 *
 * Ký hàng loạt KHÔNG đổi ai được ký, không đổi việc nào cần ký, không đổi cái gì được ghi:
 *
 *  · vẫn đúng một quyền (`nguoiQuanTri`) như đường ký từng việc;
 *  · mỗi việc vẫn đi qua `decideTechApproval()` — MỘT dòng `APPROVAL` trong nhật ký cho MỖI việc,
 *    mang tên người ký và mốc ký. KHÔNG có một lượt `update ... where id in (...)` nào: một lệnh
 *    như thế ký chín việc mà chỉ để lại một vết, và sau này không ai tra được từng việc;
 *  · việc KHÔNG CẦN duyệt thì KHÔNG được ký — ký một thứ không ai hỏi là làm bẩn sổ chữ ký, và
 *    `decideTechApproval()` vốn đã từ chối ("đừng ký một thứ không ai hỏi");
 *  · việc đã ở đúng trạng thái đó thì BỎ QUA, không ghi lại lần hai (cùng lý lẽ mục 61: đóng một
 *    ca đã đóng không được ghi gì thêm).
 *
 * Thứ nó đổi là SỐ LẦN PHẢI ĐIỀU HƯỚNG, không phải bộ điều kiện.
 *
 * ─── VÀ NÓ PHẢI NÓI RA ĐÃ BỎ QUA GÌ ───
 *
 * Chọn chín dòng rồi thấy "đã ký 7" mà không biết hai dòng kia đi đâu là tệ hơn không có nút:
 * người dùng tưởng đã ký đủ. Mỗi việc bị bỏ qua phải kèm LÝ DO, và hai lý do khác nhau không được
 * gộp — "không cần duyệt" và "đã ký rồi" dẫn tới hai hành động khác nhau (mục 55).
 */

/**
 * Trần mỗi lượt.
 *
 * Không phải vì máy chậm — vì một lượt ký 500 việc là một thao tác không ai đọc hết được trước khi
 * bấm, và chữ ký mất nghĩa đúng lúc nó được dùng nhiều nhất. Trần này là một quyết định về CHẤT
 * LƯỢNG của sự đồng ý, không phải về hiệu năng.
 */
export const KY_LOAT_TOI_DA = 50;

export type ViecCanKy = {
  code: string;
  approvalRequired: boolean;
  approvalStatus: string;
};

export type LyDoBoQua = "KHONG_CAN" | "DA_QUYET_ROI";

export const LY_DO_BO_QUA: Record<LyDoBoQua, string> = {
  KHONG_CAN: "không cần phê duyệt",
  DA_QUYET_ROI: "đã ở đúng trạng thái này rồi",
};

export type LoatKy = {
  /** Mã việc sẽ được ký. */
  ky: string[];
  /** Mã việc bị bỏ qua, kèm lý do — không bao giờ im lặng. */
  boQua: { code: string; vi: LyDoBoQua }[];
};

/**
 * Trong một loạt việc được chọn, việc nào ký được — HÀM THUẦN.
 *
 * Nhận `quyet` vì "đã ở đúng trạng thái này rồi" phụ thuộc vào thứ đang định làm: một việc
 * `REJECTED` vẫn ký `APPROVED` được (người đổi ý), nhưng bấm `REJECTED` lần nữa thì không.
 */
export function xetLoatKy(ds: readonly ViecCanKy[], quyet: "APPROVED" | "REJECTED"): LoatKy {
  const out: LoatKy = { ky: [], boQua: [] };
  for (const v of ds) {
    if (!v.approvalRequired) {
      out.boQua.push({ code: v.code, vi: "KHONG_CAN" });
      continue;
    }
    if (v.approvalStatus === quyet) {
      out.boQua.push({ code: v.code, vi: "DA_QUYET_ROI" });
      continue;
    }
    out.ky.push(v.code);
  }
  return out;
}

/** Câu tổng kết cho màn hình — phần bỏ qua luôn đứng cạnh phần đã ký, không tách ra chỗ khác. */
export function nhanLoatKy(kq: { daKy: number; boQua: { code: string; vi: LyDoBoQua }[] }, quyet: "APPROVED" | "REJECTED"): string {
  const dong = quyet === "APPROVED" ? `Đã ký duyệt ${kq.daKy} việc` : `Đã từ chối ${kq.daKy} việc`;
  if (!kq.boQua.length) return dong;
  /* Gom theo lý do chứ không liệt kê phẳng: chín dòng cùng một lý do đọc thành một câu. */
  const theoLyDo = new Map<LyDoBoQua, string[]>();
  for (const b of kq.boQua) theoLyDo.set(b.vi, [...(theoLyDo.get(b.vi) ?? []), b.code]);
  const phan = [...theoLyDo.entries()].map(([vi, ms]) => `${ms.join(", ")} — ${LY_DO_BO_QUA[vi]}`);
  return `${dong} · bỏ qua ${kq.boQua.length}: ${phan.join(" · ")}`;
}

import type { AiTier } from "@/lib/ai/router";

/**
 * ═══════════ TRẦN CHI TIÊU AI MỖI NGÀY, VÀ BẬC MẶC ĐỊNH LÀ BẬC RẺ ═══════════
 *
 * ─── VÌ SAO TỆP NÀY TỒN TẠI: CHỦ SHOP PHÁT HIỆN BẰNG CÁCH HẾT TIỀN ───
 *
 * Ngày 22/09/2026 khoá API hết sạch tín dụng giữa một lượt chạy. Không một màn hình nào trong ERP
 * nói được "hôm nay AI đã tiêu bao nhiêu", dù `ai_interactions` đã ghi từng lượt gọi từ lâu.
 *
 * Tệ hơn: cột `cost_usd` lưu dạng CHỮ và có dòng để rỗng, nên một phép `sum(cost_usd::numeric)`
 * ĐỎ NGAY. Nghĩa là con số ấy **chưa từng được ai cộng một lần nào** — nếu có, họ đã vấp đúng chỗ.
 *
 * Hệ thống này đo tồn kho tới từng mẫu mã và COD tới từng vận đơn. Tiền AI của chính nó thì không.
 *
 * ─── PHANH, KHÔNG PHẢI CẢNH BÁO ───
 *
 * Một cảnh báo "sắp hết tiền" chỉ có tác dụng khi có người đang nhìn. Phần lớn lượt gọi AI đắt nhất
 * lại xảy ra lúc không ai nhìn — job định kỳ, lượt tự kiểm sau deploy, agent chạy đêm. Nên đây là
 * một cái PHANH: chạm trần thì DỪNG GỌI và nói rõ vì sao, chứ không chạy tiếp tới lúc hết sạch.
 *
 * Trần là một con số KINH DOANH, không phải hằng số kỹ thuật — chủ shop đổi được qua `settings`
 * (`ai.tran-ngay-usd`) mà không cần deploy. Mặc định ở đây chỉ là điểm khởi đầu an toàn.
 *
 * ─── VÀ BẬC MẶC ĐỊNH HẠ XUỐNG ───
 *
 * ĐO THẬT trên production, 68 lượt Copilot ERP ở `/shipments`:
 *
 *     số vòng | lượt | usd/lượt | tổng   | dùng công cụ | lỗi
 *        1    |  13  |  0,0000  |  0,000 |      0       | 13   ← hỏng hết, không tiêu tiền
 *        2    |  55  |  0,0722  |  3,969 |     55       |  5
 *
 * Mọi lượt THÀNH CÔNG đều cùng một hình dạng: hai vòng, đều gọi công cụ, câu hỏi trung bình 115
 * ký tự. **Không có lượt nào "đơn giản" theo nghĩa một vòng, không cần dữ liệu.**
 *
 * Nên KHÔNG có cách nào suy ra độ khó của câu hỏi từ lịch sử — 68 lượt cùng một hình dạng. Viết
 * một bộ định tuyến "đoán độ khó" lúc này là bịa ra một chỉ số, đúng thứ AGENTS.md mục 20 cấm.
 *
 * Thứ làm được ngay và đo được ngay: **hạ bậc mặc định xuống `routine`** ($0,0722 → ~$0,007 một
 * câu), và để NGƯỜI HỎI nâng bậc khi họ thấy cần — họ biết câu của mình khó hay không, máy thì
 * chưa. Mỗi lần nâng bậc đều vào sổ, nên sau vài chục lượt thật sẽ có dữ liệu để tự động hoá.
 */

/** Trần mặc định mỗi ngày. Chủ shop đổi qua `settings` — xem `KHOA_TRAN_NGAY`. */
export const TRAN_NGAY_USD_MAC_DINH = 2;

/** Khoá `settings` để chủ shop đổi trần mà không cần deploy. */
export const KHOA_TRAN_NGAY = "ai.tran-ngay-usd";

/** Bậc mặc định cho Copilot ERP. Người hỏi nâng lên khi cần; máy KHÔNG tự đoán. */
export const BAC_COPILOT_MAC_DINH: AiTier = "routine";

/** Bậc khi người hỏi bấm "hỏi kỹ". */
export const BAC_COPILOT_SAU: AiTier = "copilot";

export type PhanQuyetTran =
  | { choPhep: true; daTieu: number; tran: number; conLai: number }
  | { choPhep: false; daTieu: number; tran: number; ly: string };

/**
 * Còn trong trần hôm nay không — HÀM THUẦN.
 *
 * `daTieu` là `null` khi CHƯA ĐO ĐƯỢC (không đọc được sổ). Khi ấy **cho phép gọi**: chặn vì không
 * đo được là biến một lỗi đọc sổ thành một lần ERP mất trí nhớ. Chưa biết KHÔNG phải là đã vượt
 * trần (AGENTS.md mục 42) — nhưng cũng không được im lặng, nên nơi gọi phải nêu cảnh báo.
 */
export function xetTranNgay(input: { daTieu: number | null; tran: number }): PhanQuyetTran {
  const tran = input.tran > 0 ? input.tran : TRAN_NGAY_USD_MAC_DINH;
  if (input.daTieu === null) return { choPhep: true, daTieu: 0, tran, conLai: tran };
  if (input.daTieu >= tran) {
    return {
      choPhep: false,
      daTieu: input.daTieu,
      tran,
      ly:
        `AI đã tiêu $${input.daTieu.toFixed(4)} hôm nay, chạm trần $${tran.toFixed(2)}. ` +
        `Lượt gọi này bị DỪNG để khỏi tiêu tiếp. Đổi trần ở Cài đặt (khoá \`${KHOA_TRAN_NGAY}\`) nếu hôm nay thật sự cần thêm.`,
    };
  }
  return { choPhep: true, daTieu: input.daTieu, tran, conLai: Math.round((tran - input.daTieu) * 1_000_000) / 1_000_000 };
}

/**
 * Bậc dùng cho một lượt hỏi — HÀM THUẦN.
 *
 * Chỉ có MỘT đường nâng bậc: người hỏi yêu cầu. Không có nhánh nào đoán theo câu chữ, vì phép đo
 * 22/09 cho thấy 68 lượt thật đều cùng một hình dạng và không tách được khó/dễ.
 */
export function bacChoLuotHoi(input: { sauHon?: boolean }): AiTier {
  return input.sauHon ? BAC_COPILOT_SAU : BAC_COPILOT_MAC_DINH;
}

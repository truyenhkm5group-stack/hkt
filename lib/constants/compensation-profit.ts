/**
 * ═══════════ LỢI NHUẬN TÍNH LƯƠNG — MỘT CƠ SỞ CÓ TÊN, VÀ KHÔNG CÓ VÒNG LẶP ═══════════
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * Hoa hồng tính bằng **phần trăm của LỢI NHUẬN**. Nếu hoa hồng đồng thời là một khoản CHI PHÍ nằm
 * trong lợi nhuận ấy thì:
 *
 *     hoa hồng = r × lợi nhuận
 *     lợi nhuận = doanh thu − … − hoa hồng
 *
 * Hai dòng ấy định nghĩa lẫn nhau. Đó không phải một bài toán khó — nó là một phép khai KHÔNG XÁC
 * ĐỊNH, và mọi cách "giải" nó đều là chọn một điểm dừng tuỳ tiện rồi gọi đó là kết quả. ERP trước
 * bản này không chọn: nó bật cảnh báo `COMMISSION_BASIS_NEEDS_REVIEW` và để hoa hồng đi đường cũ.
 * Đúng, nhưng không xong — cảnh báo ấy nằm đó mãi mãi.
 *
 * ─── CÁCH THOÁT: ĐẶT TÊN CHO CÁI ĐIỂM DỪNG, VÀ KHAI NÓ RA ───
 *
 * Vòng lặp chỉ tồn tại khi cơ sở tính hoa hồng và lợi nhuận kế toán là CÙNG MỘT SỐ. Tách chúng ra
 * thì vòng lặp biến mất — không phải bằng một thủ thuật, mà bằng một lời khai:
 *
 *     LỢI NHUẬN TRƯỚC THÙ LAO BIẾN ĐỔI  (`PRE_VARIABLE_COMPENSATION_PROFIT`)
 *       = doanh thu giao thành công
 *       − giá vốn hàng ĐÃ GIAO
 *       − quảng cáo
 *       − cước vận chuyển và phí hoàn
 *       − chi phí vận hành đã ghi nhận (gồm LƯƠNG CỨNG — xem dưới)
 *       − phần chi phí cố định phân bổ
 *
 *     hoa hồng = r × (cơ sở ấy, sau bù lỗ lũy kế)
 *
 *     LỢI NHUẬN KẾ TOÁN = lợi nhuận trước thù lao biến đổi − hoa hồng
 *
 * Cái thứ nhất là CƠ SỞ TRẢ TIỀN. Cái thứ ba là KẾT QUẢ KINH DOANH. Chúng là hai con số khác nhau
 * và phải mang hai cái tên khác nhau — gộp lại chính là chỗ sinh ra vòng lặp.
 *
 * ─── VÌ SAO LƯƠNG CỨNG Ở TRONG CƠ SỞ, CÒN HOA HỒNG THÌ KHÔNG ───
 *
 * Không phải vì "lương nhỏ hơn". Vì lương cứng **không phải hàm của lợi nhuận**: nó là một con số
 * khai theo tháng, tính được trước khi biết lợi nhuận, nên đưa nó vào cơ sở không tạo phụ thuộc
 * vòng tròn nào. Hoa hồng thì có. Đó là ranh giới DUY NHẤT, và nó kiểm được bằng máy (xem
 * `assertNoCompensationCycle`) chứ không phải bằng cảm tính.
 *
 * Hệ quả đọc được: hai người cùng chính sách, một người ăn lương cứng cao hơn, thì cơ sở tính hoa
 * hồng của CẢ HAI đều thấp đi — vì lương cứng là chi phí chung của shop, không phải của riêng ai.
 *
 * ─── `profit1` THÔI LÀ MỘT KHÁI NIỆM NGHIỆP VỤ ───
 *
 * Nó chỉ còn là một giá trị tương thích ở URL và ở `payroll_periods.basis` của các kỳ ĐÃ CHỐT (đổi
 * giá trị lưu trữ là làm mồ côi chúng). Mọi chỗ NGƯỜI đọc dùng tên ở đây.
 */
import { COST_COMPONENTS, type CostComponent } from "@/lib/constants/cost-authority";

/** Khoá nghiệp vụ của cơ sở tính thù lao. Đây là tên chuẩn, không phải `profit1`. */
export const COMPENSATION_PROFIT_BASIS = "PRE_VARIABLE_COMPENSATION_PROFIT" as const;
export type CompensationProfitBasis = typeof COMPENSATION_PROFIT_BASIS;

export const COMPENSATION_PROFIT_LABEL = "Lợi nhuận trước thù lao biến đổi";
export const COMPENSATION_PROFIT_SHORT = "Lợi nhuận tính lương";

/**
 * ═══ MỘT DÒNG CHO MỖI THÀNH PHẦN CHI PHÍ: CÓ NẰM TRONG CƠ SỞ KHÔNG, VÀ VÌ SAO ═══
 *
 * Sổ này phải khai ĐỦ mọi thành phần trong `COST_COMPONENTS` — có kiểm thử chặn. Bỏ sót một thành
 * phần nghĩa là một khoản chi phí thật rơi ra ngoài cơ sở mà không ai quyết định điều đó, và cơ sở
 * ấy cao hơn sự thật đúng bằng khoản bị bỏ sót. Đó là con số dùng để trả tiền.
 *
 * `dependsOnCompensation = true` nghĩa là giá trị của thành phần này là HÀM của cơ sở. Một thành
 * phần như thế TUYỆT ĐỐI không được `included` — đó chính là vòng lặp, và `assertNoCompensationCycle`
 * chặn nó ở mức kiểu lẫn mức chạy.
 */
export type CompensationCostRule = {
  component: CostComponent;
  included: boolean;
  /** Giá trị của khoản này có phải hàm của chính cơ sở không. `true` ⇒ không bao giờ được `included`. */
  dependsOnCompensation: boolean;
  /** Câu trả lời cho "vì sao trong/ngoài" — in thẳng ra màn hình, không diễn giải lại. */
  why: string;
};

export const COMPENSATION_PROFIT_RULES: Record<CostComponent, CompensationCostRule> = {
  COGS: {
    component: "COGS",
    included: true,
    dependsOnCompensation: false,
    why: "Giá vốn của CHÍNH hàng đã giao. Là chi phí trực tiếp của doanh thu đang tính, và không phụ thuộc vào thù lao của ai.",
  },
  ADS: {
    component: "ADS",
    included: true,
    dependsOnCompensation: false,
    why: "Tiền quảng cáo đã chi, đọc từ tài khoản QC. Quy kết được tới từng người qua chiến dịch nên nó trừ đúng vào cơ sở của người tiêu nó.",
  },
  SHIPPING: {
    component: "SHIPPING",
    included: true,
    dependsOnCompensation: false,
    why: "Cước vận chuyển đọc từ vận đơn / bảng kê ĐVVC. Tiền thật đã trả cho đơn đang tính doanh thu.",
  },
  RETURN_COST: {
    component: "RETURN_COST",
    included: true,
    dependsOnCompensation: false,
    why: "Cước chiều hoàn đọc từ vận đơn chiều về. Đơn hoàn không sinh doanh thu nhưng vẫn tốn cước — bỏ nó ra là làm cơ sở cao hơn sự thật.",
  },
  SALARY: {
    component: "SALARY",
    included: true,
    dependsOnCompensation: false,
    why: "Lương CỨNG là con số khai theo tháng, tính được TRƯỚC khi biết lợi nhuận, nên đưa vào cơ sở không tạo phụ thuộc vòng tròn nào.",
  },
  COMMISSION: {
    component: "COMMISSION",
    included: false,
    dependsOnCompensation: true,
    why: "Hoa hồng và chia lợi nhuận là HÀM của chính cơ sở này. Đưa vào là định nghĩa vòng tròn — đây chính là ranh giới làm nên cái tên “trước thù lao biến đổi”. Nó vẫn bị trừ, nhưng ở BƯỚC SAU, để ra lợi nhuận kế toán.",
  },
  RENT: {
    component: "RENT",
    included: true,
    dependsOnCompensation: false,
    why: "Mặt bằng, điện nước — chi phí theo thời gian, chia theo số ngày chồng lấn của kỳ.",
  },
  SOFTWARE: {
    component: "SOFTWARE",
    included: true,
    dependsOnCompensation: false,
    why: "Phần mềm, dịch vụ theo tháng — chi phí theo thời gian, chia theo số ngày.",
  },
  UTILITIES: {
    component: "UTILITIES",
    included: true,
    dependsOnCompensation: false,
    why: "Tiện ích vận hành đã ghi nhận trong kỳ.",
  },
  INVENTORY_RISK: {
    component: "INVENTORY_RISK",
    included: true,
    dependsOnCompensation: false,
    why: "Dự phòng rủi ro tồn kho đi theo GIÁ VỐN HÀNG BÁN RA (AGENTS.md mục 14), nên nó là chi phí của chính doanh thu đang tính. Phần rủi ro của hàng CHƯA bán hiện riêng ở dòng “còn treo” và KHÔNG trừ vào cơ sở.",
  },
  OTHER_OPERATING: {
    component: "OTHER_OPERATING",
    included: true,
    dependsOnCompensation: false,
    why: "Mọi khoản vận hành còn lại mà bảng Chi phí có thẩm quyền, qua `getOperatingCost()`.",
  },
};

/** Thành phần nằm TRONG cơ sở tính thù lao. */
export const COMPENSATION_INCLUDED_COMPONENTS = COST_COMPONENTS.filter((c) => COMPENSATION_PROFIT_RULES[c].included);
/** Thành phần nằm NGOÀI — mỗi cái phải có lý do, và lý do ấy đọc được trên màn hình. */
export const COMPENSATION_EXCLUDED_COMPONENTS = COST_COMPONENTS.filter((c) => !COMPENSATION_PROFIT_RULES[c].included);

/**
 * ═══ CHẶN PHỤ THUỘC VÒNG TRÒN Ở MỨC LỜI KHAI ═══
 *
 * Trả về danh sách vi phạm, RỖNG nghĩa là sổ khai nhất quán. Hai điều kiện, và cả hai đều là "một
 * dòng khai mâu thuẫn với chính nó" chứ không phải một phép suy luận tinh vi:
 *
 *  1. Thành phần là HÀM của cơ sở mà lại được đưa VÀO cơ sở ⇒ vòng lặp.
 *  2. Thành phần bị loại mà KHÔNG phải vì phụ thuộc ⇒ một khoản chi phí thật đang rơi ra ngoài vì
 *     một lý do khác, và lý do ấy phải được nói to lên chứ không nằm im trong sổ.
 *
 * Hàm THUẦN, gọi được từ kiểm thử lẫn từ màn hình.
 */
export function compensationBasisViolations(rules: Record<CostComponent, CompensationCostRule> = COMPENSATION_PROFIT_RULES): string[] {
  const out: string[] = [];
  for (const c of COST_COMPONENTS) {
    const r = rules[c];
    if (!r) {
      out.push(`Thành phần chi phí “${c}” chưa khai trong sổ cơ sở tính lương — một khoản chi thật đang rơi ra ngoài mà không ai quyết định điều đó.`);
      continue;
    }
    if (r.dependsOnCompensation && r.included) {
      out.push(`“${c}” là hàm của chính cơ sở này nhưng lại được đưa VÀO cơ sở — đó là định nghĩa vòng tròn.`);
    }
    if (!r.included && !r.dependsOnCompensation) {
      out.push(`“${c}” bị loại khỏi cơ sở nhưng KHÔNG phải vì phụ thuộc vòng tròn. Một khoản chi thật nằm ngoài cơ sở trả tiền phải có lý do được nói to, không nằm im trong sổ.`);
    }
    if (!r.why || r.why.length < 30) {
      out.push(`“${c}” chưa khai LÝ DO đủ để người đọc bảng lương hiểu.`);
    }
  }
  return out;
}

/**
 * ═══ CHẶN VÒNG LẶP Ở MỨC CHÍNH SÁCH LƯƠNG ═══
 *
 * Một thành phần lương tính trên `PROFIT_PERSONAL` / `PROFIT_SHOP` là một khoản THÙ LAO BIẾN ĐỔI.
 * Vòng lặp xuất hiện nếu khoản ấy quay lại làm chi phí trong chính cơ sở của nó.
 *
 * Trong kho mã này điều đó KHÔNG THỂ xảy ra **do cấu trúc**, và đây là chỗ nói rõ vì sao thay vì
 * để nó là một sự thật ngẫu nhiên: đại lượng của một thành phần chỉ lấy được từ `PAYROLL_INPUTS`,
 * và không đại lượng nào trong sổ ấy đọc từ bảng lương. Hàm này khẳng định lại điều đó trên đúng
 * bộ thành phần đang khai — nên ngày nào có người thêm một đại lượng "chi phí nhân sự" vào sổ đầu
 * vào, nó đỏ ngay, chứ không đợi tới lúc một kỳ lương ra số vô nghĩa.
 */
export const VARIABLE_COMPENSATION_BASIS_KEYS = ["PROFIT_PERSONAL", "PROFIT_SHOP"] as const;

export function assertNoCompensationCycle(
  components: readonly { code: string; label: string; basisKey: string | null }[],
  /** Đại lượng nào đọc từ chính bảng lương — sổ đầu vào khai, không đoán ở đây. */
  payrollDerivedInputKeys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const c of components) {
    if (!c.basisKey) continue;
    if (payrollDerivedInputKeys.includes(c.basisKey)) {
      out.push(
        `Thành phần “${c.label}” tính trên đại lượng “${c.basisKey}” — mà đại lượng ấy đọc từ chính bảng lương. Khoản tiền này sẽ là đầu vào của chính nó; không có giá trị nào thoả.`,
      );
    }
  }
  return out;
}

import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { METRIC_BINDINGS, metricBinding } from "@/lib/constants/metric-bindings";

/**
 * ═══════════ MẪU OKR THEO PHÒNG — GỢI Ý, KHÔNG PHẢI MỤC TIÊU ═══════════
 *
 * ─── BA LUẬT, VÀ CẢ BA ĐỀU ĐƯỢC THỰC THI Ở MÃ, KHÔNG PHẢI Ở LỜI DẶN ───
 *
 * 1. **Không tự bật.** Mẫu chỉ chạy khi người dùng bấm, và mục tiêu sinh ra ở trạng thái `DRAFT`.
 *    Một mục tiêu tự bật ở trạng thái `ACTIVE` sẽ lập tức chảy vào mọi bảng tổng hợp và vào thẻ
 *    điểm cá nhân của người phụ trách — tức là chấm điểm người ta bằng một con số họ chưa từng
 *    đồng ý.
 *
 * 2. **Chủ sở hữu phải tự đặt đích.** `suggestedTarget` chỉ là số điền sẵn vào ô nhập; không có
 *    đường nào tạo được KR mà bỏ qua bước người nhập đích. Một đích mặc định được lưu lặng lẽ sẽ
 *    được đọc như thể có ai đó đã cân nhắc nó.
 *
 * 3. **KR tự động chỉ khi chỉ số có thẩm quyền.** `metricSource` phải là khoá trong
 *    `METRIC_BINDINGS` (đã có hàm đọc số thật) hoặc `"MANUAL"`. Chỉ số chưa đo được thì để
 *    `"MANUAL"` và nói rõ vì sao — không viết một truy vấn "gần đúng" rồi gọi nó là chỉ số.
 *
 * Danh sách này CỐ Ý ngắn: hai mục tiêu mỗi phòng. Một thư viện 20 mẫu là một cách khác để áp mô
 * hình kinh doanh của người viết mã lên shop, chỉ là kín đáo hơn.
 */

export type OkrTemplateKr = {
  title: string;
  /** Khoá trong `METRIC_BINDINGS`, hoặc `"MANUAL"` khi ERP chưa đo được. */
  metricSource: string;
  /** Số điền sẵn vào ô đích. `null` = không gợi ý gì, người phụ trách phải tự nghĩ. */
  suggestedTarget: number | null;
  /** Vì sao KR này, và vì sao đo bằng chỉ số này. */
  why: string;
};

export type OkrTemplate = {
  key: string;
  department: DepartmentCode;
  title: string;
  description: string;
  krs: OkrTemplateKr[];
};

export const OKR_TEMPLATES: OkrTemplate[] = [
  /* ───── Kinh doanh & CSKH ───── */
  {
    key: "sales-quality",
    department: "SALES",
    title: "Bán được nhiều hơn mà không bán ra đơn hoàn",
    description: "Doanh thu chỉ có nghĩa khi hàng tới tay khách. Mục tiêu này buộc hai con số đi cùng nhau.",
    krs: [
      { title: "Doanh thu GIAO THÀNH CÔNG trong kỳ", metricSource: "delivered_revenue", suggestedTarget: null, why: "Doanh thu đã tới tay khách, không phải số lên đơn — đây là con số duy nhất chi được lương." },
      { title: "Tỷ lệ giao thành công", metricSource: "delivery_success_rate", suggestedTarget: 85, why: "Đứng cạnh doanh thu để chặn cách đạt đích rẻ tiền nhất: chốt bừa cho nhiều đơn rồi hoàn." },
      { title: "Case CSKH đóng trong hạn", metricSource: "work_sla_on_time", suggestedTarget: 90, why: "Khách chờ lâu là mất đơn trước cả khi hàng rời kho." },
    ],
  },
  {
    key: "sales-backlog",
    department: "SALES",
    title: "Không để việc nào trôi không ai cầm",
    description: "Một case chưa ai nhận là một khách chưa ai trả lời.",
    krs: [
      { title: "Case chưa ai nhận (cuối kỳ)", metricSource: "work_unassigned", suggestedTarget: 0, why: "Đích 0 là đích đúng: một case có chủ vẫn có thể chậm, nhưng case vô chủ thì chắc chắn không ai làm." },
      { title: "Việc CSKH quá hạn", metricSource: "work_overdue", suggestedTarget: 0, why: "Đo cái tồn đọng thật, không đo số việc đã làm." },
    ],
  },

  /* ───── Giao vận ───── */
  {
    key: "logistics-recover",
    department: "LOGISTICS",
    title: "Cứu được kiện hàng trước khi nó thành đơn hoàn",
    description: "Cửa sổ cứu một kiện giao hụt tính bằng giờ. Mục tiêu này đo đúng cái cửa sổ đó.",
    krs: [
      { title: "Ca care đóng trong hạn", metricSource: "work_sla_on_time", suggestedTarget: 90, why: "Đây là thứ người care QUYẾT ĐƯỢC. Kết quả chuyến giao thì không — nên nó không nằm ở đây." },
      { title: "Tỷ lệ hoàn", metricSource: "return_rate", suggestedTarget: 12, why: "Kết quả chung của cả khâu giao; đặt ở cấp phòng chứ không chấm cho cá nhân nào." },
      { title: "COD đã giao mà tiền chưa về", metricSource: "cod_outstanding", suggestedTarget: 0, why: "Tiền của shop đang nằm ở ĐVVC — đòi được, nhưng phải có người theo." },
    ],
  },

  /* ───── Kho ───── */
  {
    key: "warehouse-flow",
    department: "WAREHOUSE",
    title: "Hàng không nằm lại: ra khỏi kho nhanh, về kho là đếm ngay",
    description: "Hai đầu của kho, hai con số. Hàng hoàn KHÔNG tự vào tồn nên đầu về cũng phải có đích.",
    krs: [
      { title: "Kiện hoàn chờ kiểm đếm (cuối kỳ)", metricSource: "return_inspection_backlog", suggestedTarget: 0, why: "Mỗi kiện chưa đếm là vốn đang nằm ở kho mà sổ sách không biết." },
      { title: "Việc kho quá hạn", metricSource: "work_overdue", suggestedTarget: 0, why: "Gồm cả đơn đã chốt chưa rời kho — nhóm cứu được trọn vẹn vì hàng còn trong tay shop." },
    ],
  },

  /* ───── Kế toán ───── */
  {
    key: "finance-clean",
    department: "FINANCE",
    title: "Mọi đồng tiền đều biết thuộc khoản nào",
    description: "Chưa phân loại thì khoản tiền đó không vào được báo cáo nào — số dư khớp nhưng lợi nhuận sai.",
    krs: [
      { title: "Dòng tiền chưa phân loại (cuối kỳ)", metricSource: "unclassified_bank_txns", suggestedTarget: 0, why: "Đích 0 là đích duy nhất có nghĩa: một dòng còn treo là một báo cáo còn sai." },
      { title: "Việc tài chính đóng trong hạn", metricSource: "work_sla_on_time", suggestedTarget: 90, why: "Đối soát muộn thì phải lục lại bảng kê cũ, tốn gấp mấy lần." },
    ],
  },

  /* ───── Marketing ───── */
  {
    key: "marketing-profit",
    department: "MARKETING",
    title: "Tiêu tiền quảng cáo ra lợi nhuận, không ra đơn hoàn",
    description: "Đơn về nhiều mà hoàn nhiều thì quảng cáo đang mua lỗ. Hai con số phải đi cùng nhau.",
    krs: [
      { title: "Lợi nhuận sau quảng cáo", metricSource: "profit_after_ads", suggestedTarget: null, why: "Trừ chi quảng cáo khỏi lợi nhuận góp — con số duy nhất nói quảng cáo có lời hay không." },
      { title: "Đơn giao thành công", metricSource: "delivered_orders", suggestedTarget: null, why: "Đếm đơn ĐÃ TỚI TAY khách, không đếm đơn lên." },
      {
        title: "Số thử nghiệm quảng cáo đã chạy xong",
        metricSource: "MANUAL",
        suggestedTarget: null,
        why: "ERP đọc Facebook Ads chứ không ghi, nên không biết ai đã chạy thử nghiệm nào. Người phụ trách tự khai — nói thật vẫn hơn một truy vấn nghe có vẻ đúng.",
      },
    ],
  },

  /* ───── Ban điều hành ───── */
  {
    key: "management-flow",
    department: "MANAGEMENT",
    title: "Công việc chảy: không phòng nào kẹt quá một ngày",
    description: "Mục tiêu của điều hành không phải làm nhiều việc hơn, mà là gỡ chỗ tắc của người khác.",
    krs: [
      { title: "Việc quá hạn toàn shop (cuối kỳ)", metricSource: "work_overdue", suggestedTarget: 0, why: "Thước duy nhất nói công việc có chảy hay không, và nó cắt ngang mọi phòng." },
      { title: "Lợi nhuận góp", metricSource: "delivered_contribution", suggestedTarget: null, why: "Doanh thu giao thành công trừ giá vốn. Ước tính vì độ phủ giá vốn chưa 100% — đọc kèm nhãn đó." },
    ],
  },

  /* ───── Nhân sự ───── */
  {
    key: "hr-basics",
    department: "HR",
    title: "Việc nhân sự chạy đúng nhịp",
    description: "Chấm công, chốt lương, đào tạo — việc lặp lại, và cái duy nhất đo được là nó có đúng hẹn không.",
    krs: [
      { title: "Việc nhân sự quá hạn", metricSource: "work_overdue", suggestedTarget: 0, why: "Chốt lương muộn là chuyện ai cũng nhớ, nên đây là chỉ số thật." },
      {
        title: "Số buổi đào tạo đã tổ chức",
        metricSource: "MANUAL",
        suggestedTarget: null,
        why: "ERP chưa có bảng nào ghi sự kiện đào tạo. Để MANUAL là nói thật rằng con số này do người khai.",
      },
    ],
  },
];

export function templatesOf(department: DepartmentCode): OkrTemplate[] {
  return OKR_TEMPLATES.filter((t) => t.department === department);
}

export function templateByKey(key: string): OkrTemplate | null {
  return OKR_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * Lá chắn khai báo — kiểm ở `tests/work-os.test.ts`:
 *  · mọi `metricSource` của mẫu phải có thật trong sổ đăng ký chỉ số (hoặc là `MANUAL`);
 *  · mọi phòng phải có ít nhất một mẫu, nếu không nút "Dùng mẫu" của phòng đó sẽ mở ra một hộp rỗng.
 */
export const TEMPLATE_KRS_WITH_UNKNOWN_METRIC: string[] = OKR_TEMPLATES.flatMap((t) =>
  t.krs.filter((k) => k.metricSource !== "MANUAL" && !METRIC_BINDINGS[k.metricSource]).map((k) => `${t.key}:${k.metricSource}`),
);

export const DEPARTMENTS_WITHOUT_TEMPLATE: DepartmentCode[] = DEPARTMENT_CODES.filter((d) => !OKR_TEMPLATES.some((t) => t.department === d));

/** Đơn vị và chiều của một KR mẫu — LẤY TỪ SỔ ĐĂNG KÝ, không gõ lại trong mẫu. */
export function krShapeOf(metricSource: string): { unit: "NUMBER" | "VND" | "PERCENT" | "COUNT" | "DAYS" | "HOURS"; direction: "UP" | "DOWN" } {
  const b = metricBinding(metricSource);
  return { unit: b?.unit ?? "NUMBER", direction: b?.direction ?? "UP" };
}

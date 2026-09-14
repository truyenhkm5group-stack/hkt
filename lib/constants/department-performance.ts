import { metricsOf } from "@/lib/constants/metric-catalog";
import type { PersonLinkage } from "@/lib/constants/metric-provenance";
import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ MỖI PHÒNG ĐƯỢC ĐO BẰNG THỨ HỌ QUYẾT ĐƯỢC ═══════════
 *
 * ─── HAI LUẬT ───
 *
 * 1. **Không trừ điểm ai vì thứ họ không quyết được.** Bưu tá giao hỏng không phải lỗi CSKH; ngân
 *    hàng về tiền chậm không phải lỗi kho. Thẻ điểm chỉ tính việc THUỘC PHÒNG của người đó
 *    (`lib/queries/work-performance.ts` lọc theo phòng của chính việc), và nguồn nào có kết quả do
 *    bên ngoài quyết thì đã khai `outcomeAttributable: false` từ sổ đăng ký nguồn.
 *
 * 2. **Chỉ số CHƯA ĐO ĐƯỢC phải nói là chưa đo được.** Bảng dưới liệt kê cả những chỉ số mà chủ
 *    shop muốn có nhưng ERP chưa đọc được Ở ĐỘ MỊN NGƯỜI — kèm lý do. Giấu chúng đi thì màn hình
 *    trông đầy đủ và không ai biết còn thiếu gì; bịa ra một con số thì tệ hơn nữa (AGENTS.md mục 8).
 *
 * Bảng này KHÔNG tự tính gì cả. Nó là phần chú giải có cấu trúc của màn hình hiệu suất, và là danh
 * sách việc còn phải làm cho những bản sau.
 */

export type MetricAvailability = "MEASURED" | "UNAVAILABLE";

export type DeptMetric = {
  label: string;
  availability: MetricAvailability;
  /** `MEASURED` ⇒ trục nào của thẻ điểm mang nó. `UNAVAILABLE` ⇒ thiếu đúng cái gì. */
  note: string;
};

export type DeptPerfSpec = {
  /** Một câu: phòng này được đánh giá bằng cái gì. */
  focus: string;
  /** Một câu: cái gì KHÔNG được tính cho người của phòng này, và vì sao. */
  notAttributed: string;
  metrics: DeptMetric[];
};

export const DEPT_PERF: Record<DepartmentCode, DeptPerfSpec> = {
  SALES: {
    focus: "Trả lời khách kịp và đưa case tới kết luận — hai thứ nằm trọn trong tay người bán.",
    notAttributed: "Đơn hoàn do bưu tá giao hỏng KHÔNG tính vào đây: việc đó thuộc care vận đơn và kết quả do ĐVVC quyết.",
    metrics: [
      { label: "Trả lời / xử lý case trong hạn", availability: "MEASURED", note: "Trục Đúng hạn, mẫu số là case CSKH có đặt hạn mà người này đã đóng." },
      { label: "Đưa case tới kết luận", availability: "MEASURED", note: "Trục Kết quả — case CSKH khai `outcomeAttributable`, đóng được là kết quả." },
      { label: "Case phải mở lại", availability: "MEASURED", note: "Trục Chất lượng." },
      {
        label: "Tỷ lệ chốt đơn từ tin nhắn",
        availability: "UNAVAILABLE",
        note: "Pancake không trả về NGƯỜI đã chốt của từng hội thoại, nên không quy được về cá nhân. Quy theo phòng thì đo được, quy theo người thì sẽ là đoán.",
      },
      {
        label: "Chất lượng đơn (tỷ lệ giao thành công của đơn mình chốt)",
        availability: "UNAVAILABLE",
        note: "Cần cột 'ai chốt đơn' trên `orders`; hiện chỉ có marketer, không có người chốt. Ghép bằng tên trong ghi chú là đoán, và đoán sai thì trừ điểm oan.",
      },
    ],
  },
  LOGISTICS: {
    focus: "Tốc độ và độ bền của việc CHĂM kiện hàng, cộng số tiền COD giữ lại được.",
    notAttributed:
      "KHÔNG tính kết quả chuyến giao. Người care không quyết được bưu tá có giao được hay không — họ chịu trách nhiệm về việc HỌ LÀM: gọi kịp, ghi nhận, gửi yêu cầu ĐVVC. Vì thế nguồn care vận đơn khai `outcomeAttributable: false`.",
    metrics: [
      { label: "Đóng ca care trong hạn", availability: "MEASURED", note: "Trục Đúng hạn — hạn đóng ca lấy từ cấu hình hạn xử lý." },
      { label: "Thời gian xử lý một ca", availability: "MEASURED", note: "Trung vị giờ từ lúc ca vào hàng đợi tới lúc đóng." },
      { label: "Tiền COD giữ lại được", availability: "MEASURED", note: "Cột 'Tiền cứu được' — chỉ cộng phần ĐO ĐƯỢC từ chứng từ vận đơn." },
      {
        label: "Tỷ lệ cứu được đơn (giao lại thành công sau khi care)",
        availability: "UNAVAILABLE",
        note: "Kết quả cuối của kiện hàng do ĐVVC quyết và tới sau khi ca đã đóng. Gắn nó vào người care là đúng thứ luật 1 cấm.",
      },
    ],
  },
  WAREHOUSE: {
    focus: "Kiểm đếm hàng hoàn đúng hẹn và không để đơn đã chốt nằm lại trong kho.",
    notAttributed: "Đơn thiếu SĐT / địa chỉ KHÔNG tính cho kho: việc đó phải gọi khách, và nó đã được xếp về phòng kinh doanh.",
    metrics: [
      { label: "Kiểm đếm hàng hoàn trong hạn", availability: "MEASURED", note: "Trục Đúng hạn trên nguồn hàng hoàn chờ kiểm đếm." },
      { label: "Đơn đã chốt rời kho đúng hạn", availability: "MEASURED", note: "Trục Đúng hạn trên nguồn nút thắt fulfillment (ba lý do thuộc kho)." },
      {
        label: "Độ chính xác tồn kho",
        availability: "UNAVAILABLE",
        note: "Chênh lệch kiểm kê đọc được ở SỔ KHO nhưng ở độ mịn MẪU MÃ, không phải người lập phiếu. Cần cột người kiểm trên phiếu kiểm kê mới quy được về cá nhân.",
      },
    ],
  },
  FINANCE: {
    focus: "Dòng tiền được phân loại hết và không có khoản nào nằm treo quá lâu.",
    notAttributed: "COD chưa về KHÔNG phải lỗi kế toán khi ĐVVC chưa lên bảng kê — trục Kết quả chỉ tính việc đã đóng được.",
    metrics: [
      { label: "Phân loại dòng tiền trong hạn", availability: "MEASURED", note: "Trục Đúng hạn trên nguồn dòng tiền chưa phân loại." },
      { label: "Tồn đọng chưa xử lý", availability: "MEASURED", note: "Cột 'Đang cầm' kèm số quá hạn — ảnh chụp hiện tại, không phải của kỳ." },
      {
        label: "Độ đầy đủ đối soát (bao nhiêu % dòng tiền đã khớp chứng từ)",
        availability: "UNAVAILABLE",
        note: "Đo được ở mức SỔ, chưa gắn được vào người: một dòng có thể do nhiều người chạm. Cần ghi người khớp trên `bank_transactions.linked_*`.",
      },
    ],
  },
  MARKETING: {
    focus: "Chất lượng quyết định quảng cáo: cắt đúng dòng đang lỗ, giữ đúng dòng đang lời.",
    notAttributed: "Không tính doanh thu của cả shop cho một người: doanh thu chịu ảnh hưởng của giá, hàng tồn và khâu giao — ba thứ marketing không quyết.",
    metrics: [
      { label: "Xử lý quyết định quảng cáo đang treo", availability: "MEASURED", note: "Cột 'Đang cầm' và trục Năng suất trên nguồn quyết định quảng cáo." },
      {
        label: "Đóng góp doanh thu / chất lượng quyết định",
        availability: "UNAVAILABLE",
        note:
          "Chi quảng cáo đọc được theo TÀI KHOẢN quảng cáo, không theo người bấm nút; và ERP đọc Facebook Ads chứ không ghi, nên không biết ai đã cắt dòng nào. " +
          "Đo được khi nào mỗi quyết định được ghi nhận kèm người quyết.",
      },
    ],
  },
  MANAGEMENT: {
    focus: "Gỡ nút thắt: việc bị chặn có được mở ra không, và mở sau bao lâu.",
    notAttributed: "Không quy kết quả vận hành của các phòng cho người điều hành ở thẻ điểm cá nhân — chỗ để đọc chuyện đó là OKR và BSC.",
    metrics: [
      { label: "Việc bị chặn được gỡ", availability: "MEASURED", note: "Trục Chất lượng và số 'bị chặn' ở cột Đang cầm." },
      { label: "Tiến độ OKR cá nhân", availability: "MEASURED", note: "Trục OKR — chỉ tính Key Result đo được." },
    ],
  },
  HR: {
    focus: "Việc nhân sự giao tay và việc định kỳ (chấm công, chốt lương) đúng hẹn.",
    notAttributed: "Không có nguồn việc tự động nào thuộc nhân sự, nên thẻ điểm ở đây chỉ nói về việc giao tay và việc định kỳ.",
    metrics: [
      { label: "Việc giao tay / định kỳ đúng hẹn", availability: "MEASURED", note: "Trục Đúng hạn trên việc do `work_items` sở hữu." },
      {
        label: "Chỉ số nhân sự (tuyển, đào tạo, nghỉ việc)",
        availability: "UNAVAILABLE",
        note: "ERP chưa có bảng nào ghi các sự kiện này. Chưa có nguồn thì chưa có chỉ số — không dựng một con số từ việc giao tay rồi gọi nó là chỉ số nhân sự.",
      },
    ],
  },
};

/** Lá chắn khai báo: mọi phòng phải có phần chú giải riêng. Kiểm ở `tests/work-os.test.ts`. */
export const DEPARTMENTS_WITHOUT_PERF: DepartmentCode[] = DEPARTMENT_CODES.filter((d) => !DEPT_PERF[d]);

/**
 * ═══════════ DANH MỤC CHỈ SỐ MÁY ĐỌC ĐƯỢC — ĐỂ "CHƯA ĐO ĐƯỢC" KHÁC "CHƯA CHẠY" ═══════════
 *
 * `DEPT_PERF` ở trên là bản chú giải cho người đọc. Bảng này là bản cho máy, và nó tồn tại vì một
 * lý do rất cụ thể:
 *
 * Các hàm đo chỉ trả về dòng cho người CÓ hoạt động trong kỳ. Nếu ảnh chụp cũng chỉ ghi từng ấy
 * dòng thì một kỳ trống sẽ không để lại dấu vết nào — và sau này không phân biệt được **"kỳ đó
 * người này chưa đo được gì"** với **"kỳ đó job chưa chạy"**. Hai chuyện khác hẳn nhau: cái thứ
 * nhất là một sự thật về công việc, cái thứ hai là một lỗ hổng dữ liệu.
 *
 * Có danh mục này thì ảnh chụp ghi đủ mọi chỉ số của phòng cho mọi người trong phòng, và kỳ trống
 * là một hàng `value = null` nói rõ điều đó.
 *
 * KHÔNG chứa chỉ số `UNAVAILABLE` — thứ ERP chưa đọc được ở độ mịn người thì không chụp, vì chụp
 * một cột rỗng vĩnh viễn chỉ làm bảng dài thêm.
 */
export type DeptMetricSpec = { key: string; label: string; unit: "PERCENT" | "COUNT" | "VND" | "HOURS" | "DAYS"; denominatorLabel: string; owner: "PERSON" | "DEPARTMENT" };

/**
 * ═══ DẪN XUẤT TỪ SỔ, KHÔNG PHẢI MỘT DANH SÁCH THỨ HAI ═══
 *
 * Trước đây đây là một mảng gõ tay, và nó là BẢN THỨ BA mô tả cùng một chỉ số (sau câu SQL tính
 * nó và `DEPT_PERF` chú giải nó). Ba bản thì tới ngày chúng nói khác nhau — và cái sai sẽ là cái
 * nói rằng CÓ số, trong khi thật ra không có.
 *
 * Nay nó đọc thẳng `METRIC_CATALOG`. Thêm một chỉ số vào sổ là nó tự vào ảnh chụp; khai một chỉ
 * số là `UNAVAILABLE` là nó tự biến mất khỏi đây — không phải nhớ sửa hai chỗ.
 */
export const DEPT_METRIC_KEYS: Partial<Record<DepartmentCode, DeptMetricSpec[]>> = Object.fromEntries(
  DEPARTMENT_CODES.map((code) => [code, metricsOf(code).map((m) => ({ key: m.key, label: m.label, unit: m.unit, denominatorLabel: m.denominator, owner: m.grain }))]).filter(([, list]) => (list as DeptMetricSpec[]).length > 0),
) as Partial<Record<DepartmentCode, DeptMetricSpec[]>>;

/**
 * Cách nối dòng dữ liệu về người, theo từng phòng — cũng dẫn xuất từ sổ.
 *
 * Phòng lấy cách nối YẾU NHẤT trong các chỉ số của nó. Một phòng có ba chỉ số nối bằng khoá và
 * một chỉ số nối bằng ô chữ thì thẻ điểm của phòng đó vẫn có thể quy nhầm người — lấy cái mạnh
 * nhất là tự khen mình.
 */
const LINKAGE_RANK: Record<PersonLinkage, number> = { FREE_TEXT: 0, EMAIL: 1, USER_ID: 2 };

export const DEPT_LINKAGE: Partial<Record<DepartmentCode, PersonLinkage>> = Object.fromEntries(
  DEPARTMENT_CODES.map((code) => {
    const list = metricsOf(code, "PERSON");
    if (!list.length) return [code, null];
    return [code, list.reduce<PersonLinkage>((yeu, m) => (LINKAGE_RANK[m.linkage] < LINKAGE_RANK[yeu] ? m.linkage : yeu), "USER_ID")];
  }).filter(([, v]) => v !== null),
) as Partial<Record<DepartmentCode, PersonLinkage>>;

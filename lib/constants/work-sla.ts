import { CASE_SLA_HOURS, CASE_TYPE_LABEL, CASE_TYPES, type CaseType } from "@/lib/constants/action-queue";
import { CARE_SLA } from "@/lib/constants/care";
import {
  BOTTLENECK_REASON_LABEL,
  BOTTLENECK_SLA_HOURS,
  FULFILLMENT_BLOCK_REASONS,
} from "@/lib/constants/fulfillment-bottleneck";
import type { DepartmentCode } from "@/lib/constants/departments";
import {
  ALERT_KINDS_OWNED_ELSEWHERE,
  departmentOfAlert,
  sourceOfAlert,
  WORK_SOURCES,
  WORK_SOURCE_SPEC,
  type WorkSource,
} from "@/lib/constants/work-sources";

/**
 * ═══════════ HẠN XỬ LÝ: MỘT BẢNG, SỬA ĐƯỢC, KHÔNG RẢI RÁC ═══════════
 *
 * Trước bản này, hạn nằm ở BỐN chỗ khác nhau và không chỗ nào sửa được nếu không deploy:
 * `CASE_SLA_HOURS` (23 loại cảnh báo) · `CARE_SLA` (care vận đơn) · hạn của hàng đợi nút thắt
 * fulfillment · `WORK_SOURCE_SPEC[].slaHours` (mức nguồn).
 *
 * Ở đây gom lại thành MỘT bảng có khoá, và bảng đó đọc thêm phần ghi đè từ `settings` nên chủ shop
 * / trưởng phòng đổi được mà không cần ai deploy.
 *
 * ─── MẶC ĐỊNH LÀ CHÍNH CON SỐ ĐANG CHẠY, KHÔNG PHẢI SỐ MỚI ───
 *
 * Mọi giá trị mặc định dưới đây được LẤY LẠI từ hằng số đang chạy, không gõ lại bằng tay. Nếu gõ
 * lại thì ngày nào đó hai nơi lệch nhau và không ai biết bên nào đúng — đúng thứ bảng này sinh ra
 * để chấm dứt. Đổi `CASE_SLA_HOURS` thì mặc định ở đây đổi theo, không phải sửa hai chỗ.
 *
 * ─── `null` LÀ CỐ Ý KHÔNG ĐẶT HẠN, KHÔNG PHẢI QUÊN ───
 *
 * Đặt hạn cho việc không ai làm gì được (đang chuyển hoàn, vận đơn chưa ghép được đơn) chỉ tạo ra
 * số trễ hạn giả, và số trễ hạn giả làm hỏng đúng cái thước mà trưởng phòng dùng để biết phòng
 * mình có đang kẹt hay không. Những luật như vậy giữ `null`, và giao diện in "không đặt hạn" chứ
 * không in 0. Chủ shop vẫn đặt được số cho chúng — nhưng phải là một quyết định có người ký.
 *
 * ─── ĐỘ PHỦ ĐƯỢC KIỂM Ở MỨC KIỂU ───
 *
 * `ALERT_SLA_WHY` là `Record<CaseType, string>`: thêm một loại việc mới vào `CaseType` mà quên
 * khai lý do thì `tsc` đỏ ngay, không đợi tới lúc một việc âm thầm rơi vào "không đặt hạn".
 */

/** Khoá một luật hạn: `<sourceType>` hoặc `<sourceType>:<kind>`. Càng cụ thể càng thắng. */
export type SlaKey = string;

export type SlaRule = {
  key: SlaKey;
  /** Nhãn tiếng Việt cho người cấu hình — không phải tên khoá. */
  label: string;
  /** `null` = CỐ Ý không đặt hạn. */
  hours: number | null;
  /** Vì sao là con số này. Bắt buộc: một ngưỡng không có lý do thì không ai dám sửa. */
  why: string;
  department: DepartmentCode | null;
  /**
   * Màn hình chuyên biệt CŨNG hiển thị một hạn cho cùng sự việc này.
   *
   * Đổi hạn ở đây đổi hàng đợi công việc và mọi báo cáo của nó; nhãn trên màn hình kia vẫn dùng
   * hằng số của miền. Nói thẳng ra ở giao diện cấu hình thay vì để người dùng tự phát hiện hai
   * con số — `''` nghĩa là không có màn hình nào khác nói về hạn này.
   */
  alsoShownOn: string;
};

export const WORK_SLA_KEY = "work.sla";

/** Loại cảnh báo → khoá SLA. Một cảnh báo giữ hạn RIÊNG của loại nó, không dùng hạn mức nguồn. */
export function alertSlaKey(type: CaseType): SlaKey {
  return `ALERT:${type}`;
}

/**
 * VÌ SAO mỗi loại cảnh báo có hạn như hiện tại. Một câu, nói về HẬU QUẢ của việc để trễ — không
 * nhắc lại tên loại việc.
 */
export const ALERT_SLA_WHY: Record<CaseType, string> = {
  NEW_ORDER_UNPROCESSED: "Khách vừa đặt và đang chờ ai đó xác nhận: để qua nửa ngày là họ đi hỏi chỗ khác.",
  ORDER_CONFIRMATION_STALE: "Đơn đã chốt mà chưa ra vận đơn — hàng còn trong tay shop nên còn cứu được trọn vẹn.",
  ORDER_INCOMPLETE: "Khách đã muốn mua, chỉ thiếu thông tin. Gọi bổ sung là cứu được nguyên đơn.",
  ORDER_ADDRESS_NOT_NORMALIZED: "Đơn trông đầy đủ nhưng đứng im vì hệ thống chưa ghép được địa chỉ. Mỗi giờ trôi qua là đối thủ giao trước.",
  DELIVERY_FAILED: "Cửa sổ gọi lại khách sau khi giao hụt rất ngắn — quá một ngày là mất đơn.",
  DELIVERY_STALE: "Còn kịp giục ĐVVC phát lại trước khi kiện rơi vào chiều hoàn.",
  CS_CASE: "Có một khách thật đang cầm điện thoại chờ trả lời.",
  CS_BACKLOG: "Việc tổng hợp không có hạn riêng: số case QUÁ HẠN nằm trong chính nội dung của nó, đặt thêm một hạn nữa là đếm đôi.",
  RISKY_ORDER: "Xin cọc hoặc xác nhận lại trước khi gửi thì rẻ hơn nhiều so với một đơn hoàn hai chiều cước.",
  RETURN_RECEIVED_PENDING_INSPECTION: "Hàng hoàn KHÔNG tự vào tồn. Mỗi kiện chưa đếm là vốn đang nằm ở kho mà sổ sách không biết.",
  CUSTOMER_RECOVERY: "Khách đã từng tin shop một lần. Qua hai ngày thì lời xin lỗi không còn nghĩa gì.",
  CANCELLED_BUT_SHIPPING: "Kiện đang chạy tới một người đã nói không mua. Tính bằng giờ, không phải ngày.",
  COD_OVERDUE: "Hàng đã giao nhưng tiền còn nằm ở ĐVVC. Đòi được, nhưng đòi muộn thì phải lục lại bảng kê cũ.",
  DATA_ERROR: "Không ai ngồi chờ, nhưng mọi báo cáo phía sau đều dựa vào con số này.",
  LOW_STOCK_RISK: "Đặt sản xuất kịp thì không mất doanh thu nào; muộn thì mất đúng phần bán chạy nhất.",
  STOCKOUT_RISK: "Dự báo cháy hàng gấp hơn ngưỡng tĩnh vì nó tính theo tốc độ bán thật — chậm là hết hàng giữa đợt quảng cáo.",
  ADS_BILLING: "Hết ngưỡng thanh toán là quảng cáo tắt giữa chừng, mất cả đà lẫn tiền đã mồi.",
  ADS_ANOMALY: "Tiền đang chảy lệch so với doanh thu giao thành công — tắt hoặc sửa kịp là chặn được phần chảy tiếp.",
  PROFITABILITY_ALERT: "Nhìn thấy sớm còn đổi được giá hoặc bỏ mẫu lỗ trước khi hết kỳ.",
  RETURNING: "Hàng đang trên đường về: không ai làm gì thay đổi được kết quả, nên đặt hạn ở đây chỉ tạo số trễ hạn giả.",
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: "Người phải quyết vận đơn thuộc đơn nào, máy cố ý không đoán — nhưng đây không phải việc có khách đang chờ.",
  ORPHAN_SHIPMENT: "Vận đơn chưa ghép được đơn nào: cần đối chiếu, không cần gấp.",
  OTHER: "Loại chưa phân định: chưa biết hậu quả của việc để trễ thì chưa được đặt một con số giả.",
};

function alertRule(type: CaseType): SlaRule {
  return {
    key: alertSlaKey(type),
    label: CASE_TYPE_LABEL[type],
    hours: CASE_SLA_HOURS[type],
    why: ALERT_SLA_WHY[type],
    department: departmentOfAlert(type),
    alsoShownOn: "Cần xử lý",
  };
}

/**
 * Luật mức NGUỒN. Chúng thắng khi việc không đi qua bảng `notifications` (case CSKH, care vận đơn,
 * dòng tiền, nút thắt kho) hoặc khi cảnh báo đã được ĐỔI TÊN NGUỒN — xem `ALERT_KIND_TO_SOURCE`.
 */
const SOURCE_RULES: SlaRule[] = [
  /* ───── Kinh doanh & CSKH ───── */
  {
    key: "CS_CASE",
    label: "Case CSKH (khách đang chờ trả lời)",
    hours: WORK_SOURCE_SPEC.CS_CASE.slaHours,
    why: ALERT_SLA_WHY.CS_CASE,
    department: "SALES",
    alsoShownOn: "CSKH & tin nhắn",
  },

  /* ───── Giao vận ───── */
  {
    key: "SHIPMENT_CARE",
    label: "Care vận đơn (đóng ca)",
    hours: CARE_SLA.resolveHours,
    why: "Đo trên dữ liệu shop: kiện giao hụt để quá một ngày rơi thành hoàn nhanh nhất.",
    department: "LOGISTICS",
    alsoShownOn: "Vận đơn & care",
  },

  /* ───── Kho ───── */
  {
    key: "RETURN_INSPECTION",
    label: "Hàng hoàn về · chưa kiểm đếm",
    hours: WORK_SOURCE_SPEC.RETURN_INSPECTION.slaHours,
    why: ALERT_SLA_WHY.RETURN_RECEIVED_PENDING_INSPECTION,
    department: "WAREHOUSE",
    alsoShownOn: "Kiểm đếm hàng hoàn",
  },
  /*
    BỐN LÝ DO TẮC, BỐN HẠN KHÁC NHAU — KHÔNG GỘP LÀM MỘT.

    `BOTTLENECK_SLA_HOURS` là bảng hạn thứ tư đang chạy rải rác, và nó KHÔNG đồng nhất: đơn thiếu
    dữ liệu có 24 giờ, còn bưu tá chưa tới lấy hàng có 48. Đặt một luật mức nguồn ở đây sẽ nuốt
    mất sự khác nhau đó và làm một nửa hàng đợi kho đỏ oan (hoặc xanh oan). Nên mỗi lý do là một
    luật theo `kind`, và mặc định lấy thẳng từ bảng gốc.
  */
  ...FULFILLMENT_BLOCK_REASONS.map((reason) => ({
    key: `FULFILLMENT_EXCEPTION:${reason}`,
    label: `Chưa rời kho · ${BOTTLENECK_REASON_LABEL[reason]}`,
    hours: BOTTLENECK_SLA_HOURS[reason] as number | null,
    why: ALERT_SLA_WHY.ORDER_CONFIRMATION_STALE,
    department: "WAREHOUSE" as DepartmentCode,
    alsoShownOn: "Nút thắt trước khi rời kho",
  })),
  {
    key: "INVENTORY_EXCEPTION:LOW_STOCK_RISK",
    label: "Sắp hết hàng (ngưỡng tĩnh)",
    hours: CASE_SLA_HOURS.LOW_STOCK_RISK,
    why: ALERT_SLA_WHY.LOW_STOCK_RISK,
    department: "WAREHOUSE",
    alsoShownOn: "Cần xử lý",
  },
  {
    // Cùng nguồn nhưng GẤP HƠN — một luật riêng theo `kind`, không để luật mức nguồn nuốt mất.
    key: "INVENTORY_EXCEPTION:STOCKOUT_RISK",
    label: "Hết trước khi sản xuất xong (dự báo theo tốc độ bán)",
    hours: CASE_SLA_HOURS.STOCKOUT_RISK,
    why: ALERT_SLA_WHY.STOCKOUT_RISK,
    department: "WAREHOUSE",
    alsoShownOn: "Kế hoạch sản xuất",
  },

  /* ───── Kế toán ───── */
  {
    key: "BANK_EXCEPTION",
    label: "Dòng tiền chưa phân loại",
    hours: WORK_SOURCE_SPEC.BANK_EXCEPTION.slaHours,
    why: "Chưa phân loại thì khoản tiền đó không vào được báo cáo nào — số dư khớp nhưng lợi nhuận sai.",
    department: "FINANCE",
    alsoShownOn: "Hàng đợi tác vụ tài chính",
  },
  {
    key: "COD_EXCEPTION",
    label: "COD quá hạn mà tiền chưa về",
    hours: WORK_SOURCE_SPEC.COD_EXCEPTION.slaHours,
    why: ALERT_SLA_WHY.COD_OVERDUE,
    department: "FINANCE",
    alsoShownOn: "Đối soát COD",
  },

  /* ───── Marketing ───── */
  {
    key: "ADS_DECISION",
    label: "Quyết định quảng cáo (cắt / tăng / sửa khâu giao)",
    hours: null,
    why:
      "CỐ Ý bỏ trống. Đây là một TÌNH TRẠNG ĐANG KÉO DÀI, không phải một sự kiện: mốc bắt đầu của nó " +
      "là đầu kỳ 30 ngày, nên một con số hạn đặt ở đây sẽ làm mọi dòng quảng cáo đỏ ngay hôm đặt. " +
      "Đặt được, nhưng phải hiểu nó đo 'dòng này đã ở trạng thái này bao lâu', không phải 'còn bao lâu nữa'.",
    department: "MARKETING",
    alsoShownOn: "Quảng cáo",
  },

  /* ───── Việc tay & định kỳ ───── */
  {
    key: "MANUAL_TASK",
    label: "Việc giao tay (khi người giao không đặt hạn riêng)",
    hours: null,
    why:
      "Việc tay có hạn RIÊNG do người giao đặt, và hạn đó luôn thắng. Con số ở đây chỉ dùng khi ô hạn " +
      "bỏ trống — mặc định không đặt, vì áp một hạn chung cho mọi việc tay là bịa.",
    department: null,
    alsoShownOn: "",
  },
  {
    key: "RECURRING_TASK",
    label: "Việc định kỳ (khi định nghĩa không đặt hạn riêng)",
    hours: null,
    why: "Mỗi định nghĩa việc lặp tự khai 'hạn sau bao nhiêu giờ'. Con số ở đây chỉ là dự phòng khi ô đó trống.",
    department: null,
    alsoShownOn: "Cấu hình · việc định kỳ",
  },
];

/**
 * BẢNG MẶC ĐỊNH ĐẦY ĐỦ = luật mức nguồn + luật của TỪNG loại cảnh báo còn thuộc nguồn `ALERT`.
 *
 * Loại cảnh báo đã có nguồn chuyên biệt (`ALERT_KINDS_OWNED_ELSEWHERE`, `ALERT_KIND_TO_SOURCE`)
 * KHÔNG sinh luật `ALERT:<type>`: hai luật cho cùng một việc thì người cấu hình sửa một cái và
 * tưởng đã xong.
 */
export const DEFAULT_SLA_RULES: SlaRule[] = [
  ...SOURCE_RULES,
  ...CASE_TYPES.filter((t) => !ALERT_KINDS_OWNED_ELSEWHERE.includes(t) && sourceOfAlert(t) === "ALERT").map(alertRule),
];

/** Bản đồ tra nhanh mặc định. */
export const DEFAULT_SLA_MAP: Record<SlaKey, SlaRule> = Object.fromEntries(DEFAULT_SLA_RULES.map((r) => [r.key, r]));

/** Phần chủ shop ghi đè, lưu ở `settings` khoá `work.sla`. Chỉ giữ số giờ — nhãn và lý do ở mã. */
export type SlaOverrides = Record<SlaKey, number | null>;

/**
 * Hạn của một việc, theo thứ tự CÀNG CỤ THỂ CÀNG THẮNG:
 *   1. ghi đè của chủ shop theo `<sourceType>:<kind>`
 *   2. ghi đè theo `<sourceType>`
 *   3. mặc định theo `<sourceType>:<kind>`
 *   4. mặc định theo `<sourceType>`
 *   5. không đặt hạn
 *
 * Trả `null` cho CẢ "cố ý không đặt hạn" lẫn "không có luật nào" — hai thứ đó giống nhau ở chỗ
 * không sinh ra trễ hạn, và `SLA_STATES.NONE` đã tách chúng khỏi "đúng hạn".
 */
export function slaHoursFor(sourceType: string, kind: string | null, overrides: SlaOverrides | null | undefined): number | null {
  const cuThe = kind ? `${sourceType}:${kind}` : null;
  if (cuThe && overrides && Object.hasOwn(overrides, cuThe)) return overrides[cuThe];
  if (overrides && Object.hasOwn(overrides, sourceType)) return overrides[sourceType];
  if (cuThe && DEFAULT_SLA_MAP[cuThe]) return DEFAULT_SLA_MAP[cuThe].hours;
  if (DEFAULT_SLA_MAP[sourceType]) return DEFAULT_SLA_MAP[sourceType].hours;
  return null;
}

/** Mốc hết hạn, hoặc `null` khi loại việc này không đặt hạn. */
export function slaDueAt(sourceType: string, kind: string | null, from: Date, overrides: SlaOverrides | null | undefined): Date | null {
  const h = slaHoursFor(sourceType, kind, overrides);
  return h === null ? null : new Date(from.getTime() + h * 3_600_000);
}

/** Luật đang hiệu lực (mặc định đã áp ghi đè), theo đúng thứ tự hiện trên màn hình cấu hình. */
export function effectiveSlaRules(overrides: SlaOverrides | null | undefined): (SlaRule & { overridden: boolean; defaultHours: number | null })[] {
  return DEFAULT_SLA_RULES.map((r) => {
    const co = Boolean(overrides && Object.hasOwn(overrides, r.key));
    return { ...r, defaultHours: r.hours, hours: co ? overrides![r.key] : r.hours, overridden: co };
  });
}

/** Số giờ hợp lệ cho một ô cấu hình: 1 giờ tới 90 ngày, hoặc bỏ trống = không đặt hạn. */
export const SLA_HOURS_MIN = 1;
export const SLA_HOURS_MAX = 2160;

/**
 * Nguồn việc CHƯA có luật hạn nào — lá chắn khai báo, kiểm ở `tests/work-os.test.ts`.
 * `ALERT` cố ý không có luật mức nguồn: mỗi loại cảnh báo giữ hạn riêng (`ALERT:<CaseType>`).
 */
export const SOURCES_WITHOUT_SLA: WorkSource[] = WORK_SOURCES.filter(
  (s) => s !== "ALERT" && !DEFAULT_SLA_MAP[s] && !DEFAULT_SLA_RULES.some((r) => r.key.startsWith(`${s}:`)),
);

/**
 * Loại cảnh báo còn thuộc nguồn `ALERT` mà CHƯA có luật hạn — phải luôn rỗng, kiểm ở kiểm thử.
 * Đây là lá chắn cho đúng cái bẫy đã suýt xảy ra: bảng luật viết tay chỉ phủ 11/23 loại.
 */
export const ALERT_TYPES_WITHOUT_SLA: CaseType[] = CASE_TYPES.filter(
  (t) => !ALERT_KINDS_OWNED_ELSEWHERE.includes(t) && sourceOfAlert(t) === "ALERT" && !DEFAULT_SLA_MAP[alertSlaKey(t)],
);

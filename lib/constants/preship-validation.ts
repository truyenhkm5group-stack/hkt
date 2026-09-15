/**
 * ═══════════ SOÁT ĐƠN TRƯỚC KHI GỬI: TRƯỜNG NÀO SAI, VÌ SAO, SỬA THẾ NÀO ═══════════
 *
 * ─── ĐIỀU PHẢI NÓI THẲNG NGAY TỪ ĐẦU: ERP KHÔNG CHẶN ĐƯỢC ───
 *
 * Yêu cầu của chủ shop viết là "không cho order chuyển sang Ready to Ship nếu thiếu dữ liệu".
 * ERP **không làm được đúng nghĩa đen câu đó**, và giả vờ làm được là cách hỏng tệ hơn.
 *
 * Trạng thái đơn do Pancake giữ; ERP đọc về qua đồng bộ và webhook, còn API Pancake KHÔNG có
 * `update-order` (AGENTS.md mục 3.11). Một "cổng chặn" dựng trong ERP sẽ là một cái cổng mà người
 * bấm nút READY_TO_SHIP trên POS không bao giờ đi qua — nó chặn đúng những người đã ở trong ERP,
 * tức là không chặn ai cả, trong khi vẫn tạo cảm giác đã có cổng.
 *
 * Nên tệp này làm thứ ERP LÀM ĐƯỢC và làm tốt: một **bản soát nêu đích danh trường nào chưa đạt,
 * vì sao, và phải làm gì** — hiện ngay trên đơn, và đẩy đơn chưa đạt lên hàng đợi. Người đóng gói
 * nhìn thấy trước khi dán mã vận đơn. Ngày nào Pancake mở đường ghi, phần "chặn" nối vào đây mà
 * không phải viết lại một luật nào: luật đã nằm sẵn ở một chỗ, dạng hàm thuần.
 *
 * ─── HAI MỨC, VÀ RANH GIỚI GIỮA CHÚNG LÀ "GỬI ĐI CÓ TỚI NƠI KHÔNG" ───
 *
 *  · `BLOCKER` — gửi đi thì gần như chắc chắn hỏng: bưu tá không tìm được nhà, không gọi được
 *    khách, hoặc kho không biết lấy hàng gì. Đơn mang lỗi này KHÔNG nên rời kho.
 *  · `WARNING` — gửi đi vẫn tới nơi, nhưng một con số nào đó sẽ sai về sau: thu sai tiền, sổ sách
 *    lệch. Người soát phải biết, nhưng không phải dừng dây chuyền.
 *
 * Xếp một lỗi tiền thành `BLOCKER` là dừng cả kho vì một ô nhập sai; xếp một địa chỉ thiếu thành
 * `WARNING` là gửi đi một gói chắc chắn quay về. Nên ranh giới đặt ở hậu quả, không ở "trường này
 * quan trọng hay không".
 *
 * ─── KHÔNG TRÙNG VỚI ĐIỂM RỦI RO ───
 *
 * `lib/constants/preship-risk.ts` trả lời câu **"đơn này gửi đi thì khả năng hoàn có cao hơn mặt
 * bằng không"** — một DỰ BÁO về hành vi con người, có điểm, có kiểm định. Tệp này trả lời câu khác
 * hẳn: **"chứng từ của đơn này đã đủ để gửi chưa"** — một phép soát dữ liệu, đúng/sai, không có
 * điểm. Một khách rủi ro cao với địa chỉ hoàn hảo vẫn gửi được; một khách ruột với địa chỉ trống
 * thì không.
 */

/** Ba nhóm theo đúng cách chủ shop chia việc, và cũng là ba nhóm người sửa khác nhau. */
export const VALIDATION_GROUPS = ["CUSTOMER", "PRODUCT", "MONEY"] as const;
export type ValidationGroup = (typeof VALIDATION_GROUPS)[number];

export const VALIDATION_GROUP_LABEL: Record<ValidationGroup, string> = {
  CUSTOMER: "Thông tin khách",
  PRODUCT: "Hàng hoá",
  MONEY: "Tiền",
};

export type ValidationSeverity = "BLOCKER" | "WARNING";

export const SEVERITY_LABEL: Record<ValidationSeverity, string> = {
  BLOCKER: "Chưa gửi được",
  WARNING: "Gửi được · số sẽ sai",
};

export const SEVERITY_TONE: Record<ValidationSeverity, string> = {
  BLOCKER: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  WARNING: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

export type ValidationCode =
  /* ── Khách ── */
  | "MISSING_RECEIVER_NAME"
  | "MISSING_PHONE"
  | "PHONE_MALFORMED"
  | "MISSING_ADDRESS"
  | "ADDRESS_TOO_SHORT"
  | "MISSING_PROVINCE"
  /* ── Hàng hoá ── */
  | "NO_ITEMS"
  | "ITEM_NOT_MAPPED"
  | "ITEM_MISSING_VARIATION"
  | "ITEM_BAD_QUANTITY"
  /* ── Tiền ── */
  | "TOTAL_MISSING"
  | "PREPAID_EXCEEDS_TOTAL"
  | "COD_MISMATCH";

export type ValidationSpec = {
  code: ValidationCode;
  group: ValidationGroup;
  severity: ValidationSeverity;
  /** Trường nghiệp vụ người sửa nhìn thấy trên màn hình Pancake — không phải tên cột CSDL. */
  field: string;
  /** Cột thật cấp dữ liệu, để người đọc mã tra ngược được. */
  source: string;
  /** VÌ SAO điều này làm hỏng việc gửi hàng. Bắt buộc — một luật soát không có hậu quả là một luật phiền. */
  why: string;
  /** Việc phải làm, cụ thể tới mức làm được ngay. */
  fix: string;
};

/**
 * SỔ LUẬT SOÁT. Thêm luật thì thêm ở đây, và `tsc` bắt buộc khai đủ sáu trường — một luật thiếu
 * câu "vì sao" hay câu "sửa thế nào" là một luật mà người đóng gói sẽ học cách bỏ qua.
 */
export const VALIDATION_RULES: Record<ValidationCode, ValidationSpec> = {
  MISSING_RECEIVER_NAME: {
    code: "MISSING_RECEIVER_NAME",
    group: "CUSTOMER",
    severity: "BLOCKER",
    field: "Tên người nhận",
    source: "orders.bill_full_name / ship_full_name",
    why: "Vận đơn không có tên người nhận thì bưu tá không biết hỏi ai khi tới nơi, và ĐVVC có thể từ chối nhận đơn.",
    fix: "Mở đơn trên Pancake, hỏi khách tên người nhận rồi điền vào.",
  },
  MISSING_PHONE: {
    code: "MISSING_PHONE",
    group: "CUSTOMER",
    severity: "BLOCKER",
    field: "Số điện thoại",
    source: "orders.bill_phone / ship_phone",
    why: "Không có số thì không ai gọi được khách: không xác nhận được trước khi gửi, và bưu tá cũng không gọi được khi tới nơi.",
    fix: "Hỏi lại khách trong chat Pancake. Khách cũ thì xem gợi ý SĐT đơn trước — GỢI Ý thôi, phải hỏi khách xác nhận, không tự điền.",
  },
  PHONE_MALFORMED: {
    code: "PHONE_MALFORMED",
    group: "CUSTOMER",
    severity: "BLOCKER",
    field: "Số điện thoại",
    source: "orders.bill_phone",
    why: "Dãy số sai hình dạng số Việt Nam thì gọi không được, và ĐVVC sẽ trả lại đơn ngay ở khâu tạo vận đơn.",
    fix: "Đọc lại số với khách từng chữ số rồi sửa trên Pancake. Thường là thiếu một số hoặc dính ký tự lạ khi chép từ chat.",
  },
  MISSING_ADDRESS: {
    code: "MISSING_ADDRESS",
    group: "CUSTOMER",
    severity: "BLOCKER",
    field: "Địa chỉ giao",
    source: "orders.ship_address",
    why: "Không có địa chỉ thì không tạo được vận đơn.",
    fix: "Hỏi khách địa chỉ đầy đủ: số nhà, đường, phường/xã, tỉnh/thành.",
  },
  ADDRESS_TOO_SHORT: {
    code: "ADDRESS_TOO_SHORT",
    group: "CUSTOMER",
    severity: "BLOCKER",
    field: "Địa chỉ giao",
    source: "orders.ship_address",
    why: "Địa chỉ quá ngắn (thường chỉ có tên xã hoặc một chữ) thì bưu tá không tìm được nhà, và kiện gần như chắc chắn quay về.",
    fix: "Hỏi khách số nhà và tên đường. Không đoán hộ khách — sai địa chỉ là mất cả hàng lẫn hai chiều cước.",
  },
  MISSING_PROVINCE: {
    code: "MISSING_PROVINCE",
    group: "CUSTOMER",
    severity: "BLOCKER",
    field: "Tỉnh / thành",
    source: "orders.ship_province",
    why: "Pancake chưa ghép được địa chỉ vào đơn vị hành chính nên POS không đẩy sang ĐVVC được. Đơn trông đầy đủ trên màn hình nhưng đứng im.",
    fix: "Mở đơn trên Pancake, CHỌN TAY tỉnh/xã cho địa chỉ khách rồi lưu. Địa chỉ chỉ có tỉnh + xã là ĐÚNG chuẩn hai cấp mới, không phải lỗi.",
  },

  NO_ITEMS: {
    code: "NO_ITEMS",
    group: "PRODUCT",
    severity: "BLOCKER",
    field: "Danh sách hàng",
    source: "order_items",
    why: "Đơn không có dòng hàng nào thì kho không biết đóng gói cái gì, và mọi phép tính giá vốn / tồn kho trên đơn này đều rỗng.",
    fix: "Mở đơn trên Pancake kiểm tra lại. Thường là đơn nháp chưa thêm hàng, hoặc đồng bộ hụt — bấm đồng bộ lại đơn.",
  },
  ITEM_NOT_MAPPED: {
    code: "ITEM_NOT_MAPPED",
    group: "PRODUCT",
    severity: "WARNING",
    field: "Mẫu mã (màu / size)",
    source: "order_items.variant_id",
    why:
      "Dòng hàng chưa nối được vào mẫu mã trong kho. Gửi vẫn gửi được vì người đóng gói đọc được tên hàng, nhưng TỒN KHO không bị trừ, giá vốn không tra được, và kế hoạch sản xuất thiếu đúng phần này.",
    fix: "Mở Sản phẩm → ghép mẫu mã cho dòng hàng này, hoặc sửa phân loại (màu/size) trên Pancake cho khớp mẫu mã đang có.",
  },
  ITEM_MISSING_VARIATION: {
    code: "ITEM_MISSING_VARIATION",
    group: "PRODUCT",
    severity: "BLOCKER",
    field: "Màu / size",
    source: "order_items.variation_detail",
    why: "Mẫu hàng có nhiều phân loại mà đơn không ghi màu/size thì kho phải ĐOÁN — và đoán sai là một đơn hoàn cộng hai chiều cước.",
    fix: "Hỏi khách màu và size rồi ghi vào đơn. KHÔNG tự chọn hộ khách.",
  },
  ITEM_BAD_QUANTITY: {
    code: "ITEM_BAD_QUANTITY",
    group: "PRODUCT",
    severity: "BLOCKER",
    field: "Số lượng",
    source: "order_items.quantity",
    why: "Số lượng 0 hoặc âm thì kho không biết lấy bao nhiêu, và dòng đó làm lệch mọi phép cộng tồn kho phía sau.",
    fix: "Sửa số lượng trên Pancake. Số lượng 0 thường là dòng cần xoá hẳn khỏi đơn.",
  },

  TOTAL_MISSING: {
    code: "TOTAL_MISSING",
    group: "MONEY",
    severity: "WARNING",
    field: "Tổng tiền đơn",
    source: "orders.total_price_after_discount",
    why: "Đơn không có tổng tiền vẫn gửi được, nhưng nó không đóng góp gì vào doanh thu và làm mọi báo cáo theo kỳ thiếu đúng phần này.",
    fix: "Kiểm tra lại giá trên Pancake. Nếu là đơn tặng / đổi hàng thì đúng là 0đ — ghi rõ vào ghi chú đơn để người đọc báo cáo biết.",
  },
  PREPAID_EXCEEDS_TOTAL: {
    code: "PREPAID_EXCEEDS_TOTAL",
    group: "MONEY",
    severity: "WARNING",
    field: "Tiền khách đã chuyển",
    source: "orders.prepaid vs total_price_after_discount",
    why: "Khách đã chuyển nhiều hơn giá trị đơn: hoặc đơn ghi thiếu hàng, hoặc shop đang nợ khách tiền thừa. Cả hai đều là một cuộc gọi.",
    fix: "Đối chiếu sao kê với đơn. Thiếu hàng thì bổ sung dòng hàng; thừa tiền thì hoàn lại cho khách và ghi vào sổ ngân hàng.",
  },
  COD_MISMATCH: {
    code: "COD_MISMATCH",
    group: "MONEY",
    severity: "WARNING",
    field: "Tiền thu hộ (COD)",
    source: "shipments.cod_amount vs (orders.total_price_after_discount − prepaid)",
    why:
      "Số ghi trên vận đơn khác số còn phải thu. Bưu tá thu theo VẬN ĐƠN, nên chênh lệch này là tiền shop thu thừa của khách hoặc thu hụt của chính mình — và nó chỉ lộ ra ở khâu đối soát, hàng tuần sau.",
    fix: "Sửa số thu hộ trên vận đơn Viettel Post trước khi bưu tá tới lấy. Đã lấy hàng rồi thì ghi nhận chênh lệch để đối soát COD không báo lệch.",
  },
};

/** Ngưỡng độ dài địa chỉ tối thiểu. Dưới mức này thì bưu tá gần như chắc chắn không tìm được nhà. */
export const MIN_ADDRESS_LENGTH = 10;

/**
 * Sai lệch COD được bỏ qua. 1.000đ: Pancake và Viettel Post làm tròn khác nhau ở phí, và báo động
 * vì một nghìn đồng là cách nhanh nhất để người soát học cách bỏ qua mọi cảnh báo COD.
 */
export const COD_TOLERANCE_VND = 1_000;

/** Hình dạng số điện thoại Việt Nam: 10 chữ số bắt đầu bằng 0, hoặc 11 chữ số bắt đầu bằng 84. */
export function phoneWellFormed(phone: string | null | undefined): boolean {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length === 10) return d.startsWith("0");
  if (d.length === 11) return d.startsWith("84");
  return false;
}

/* ═══════════════════ PHÉP SOÁT ═══════════════════ */

export type ValidationItem = {
  variantId: string | null;
  sku: string;
  productName: string;
  variationDetail: string;
  quantity: number;
  /** Mẫu hàng này có nhiều phân loại không. `null` = chưa tra được ⇒ KHÔNG kết luận thiếu màu/size. */
  hasVariations: boolean | null;
  isBonus: boolean;
};

export type ValidationInput = {
  receiverName: string;
  phone: string;
  address: string;
  province: string;
  total: number | null;
  prepaid: number | null;
  /** COD ghi trên vận đơn. `null` = chưa có vận đơn ⇒ chưa soát được, KHÔNG phải khớp. */
  shipmentCod: number | null;
  items: ValidationItem[];
};

export type ValidationFinding = ValidationSpec & {
  /** Chi tiết CỤ THỂ của đơn này — trường nào, giá trị nào — không phải câu chung của cả luật. */
  detail: string;
};

export type ValidationReport = {
  findings: ValidationFinding[];
  blockers: ValidationFinding[];
  warnings: ValidationFinding[];
  /** Chứng từ đã đủ để gửi chưa. `false` khi còn ít nhất một `BLOCKER`. */
  readyToShip: boolean;
};

function finding(code: ValidationCode, detail: string): ValidationFinding {
  return { ...VALIDATION_RULES[code], detail };
}

/**
 * SOÁT MỘT ĐƠN. Hàm THUẦN: không đọc CSDL, không đọc đồng hồ, cùng đầu vào ⇒ cùng kết quả.
 *
 * ─── HAI LUẬT VỀ "CHƯA BIẾT" ───
 *
 * 1. `MISSING_ADDRESS` và `ADDRESS_TOO_SHORT` loại trừ nhau, và `MISSING_PROVINCE` chỉ bật khi đã
 *    CÓ địa chỉ: đơn trống trơn thì lỗi là "chưa có địa chỉ", báo thêm "chưa chuẩn hoá" là đếm một
 *    chuyện thành hai việc. Cùng luật mà cảnh báo `ORDER_ADDRESS_NOT_NORMALIZED` đang dùng.
 * 2. Trường chưa TRA ĐƯỢC không sinh lỗi. `hasVariations = null` (chưa tra được mẫu hàng có phân
 *    loại hay không) và `shipmentCod = null` (chưa có vận đơn) đều là CHƯA BIẾT — và chưa biết thì
 *    im lặng, không phải kết luận đạt mà cũng không phải kết luận hỏng.
 */
export function validateForShipping(input: ValidationInput): ValidationReport {
  const findings: ValidationFinding[] = [];

  /* ───── Khách ───── */
  if (!input.receiverName.trim()) findings.push(finding("MISSING_RECEIVER_NAME", "Ô tên người nhận đang trống."));

  const phone = input.phone.trim();
  if (!phone) findings.push(finding("MISSING_PHONE", "Ô số điện thoại đang trống."));
  else if (!phoneWellFormed(phone)) findings.push(finding("PHONE_MALFORMED", `"${phone}" không đúng hình dạng số Việt Nam (10 số bắt đầu bằng 0, hoặc 11 số bắt đầu bằng 84).`));

  const address = input.address.trim();
  if (!address) {
    findings.push(finding("MISSING_ADDRESS", "Ô địa chỉ giao đang trống."));
  } else {
    if (address.length < MIN_ADDRESS_LENGTH) findings.push(finding("ADDRESS_TOO_SHORT", `Địa chỉ chỉ có ${address.length} ký tự: "${address}".`));
    if (!input.province.trim()) findings.push(finding("MISSING_PROVINCE", `Địa chỉ "${address}" chưa ghép được vào tỉnh/thành nào.`));
  }

  /* ───── Hàng hoá ───── */
  // Hàng TẶNG vẫn phải đúng mẫu mã (nó vẫn trừ tồn — AGENTS.md mục 3.10), nên không loại ra ở đây.
  if (!input.items.length) {
    findings.push(finding("NO_ITEMS", "Đơn không có dòng hàng nào."));
  } else {
    const chuaGhep = input.items.filter((i) => !i.variantId);
    if (chuaGhep.length) {
      const ten = chuaGhep.map((i) => i.productName || i.sku || "(không tên)").slice(0, 3).join(" · ");
      findings.push(finding("ITEM_NOT_MAPPED", `${chuaGhep.length}/${input.items.length} dòng chưa ghép mẫu mã: ${ten}${chuaGhep.length > 3 ? "…" : ""}.`));
    }
    // CHỈ báo thiếu màu/size khi ĐÃ TRA ĐƯỢC rằng mẫu hàng có nhiều phân loại. `null` là chưa biết.
    const thieuPhanLoai = input.items.filter((i) => i.hasVariations === true && !i.variationDetail.trim());
    if (thieuPhanLoai.length) {
      const ten = thieuPhanLoai.map((i) => i.productName || i.sku || "(không tên)").slice(0, 3).join(" · ");
      findings.push(finding("ITEM_MISSING_VARIATION", `${thieuPhanLoai.length} dòng chưa ghi màu/size dù mẫu hàng có nhiều phân loại: ${ten}.`));
    }
    const saiSoLuong = input.items.filter((i) => i.quantity <= 0);
    if (saiSoLuong.length) {
      findings.push(finding("ITEM_BAD_QUANTITY", `${saiSoLuong.length} dòng có số lượng ≤ 0: ${saiSoLuong.map((i) => `${i.productName || i.sku} = ${i.quantity}`).slice(0, 3).join(" · ")}.`));
    }
  }

  /* ───── Tiền ───── */
  const total = input.total;
  const prepaid = input.prepaid;
  if (total === null || total <= 0) {
    findings.push(finding("TOTAL_MISSING", total === null ? "Chưa có tổng tiền đơn." : "Tổng tiền đơn bằng 0đ."));
  }
  if (total !== null && total > 0 && prepaid !== null && prepaid > total) {
    findings.push(finding("PREPAID_EXCEEDS_TOTAL", `Khách đã chuyển ${prepaid.toLocaleString("vi-VN")}đ nhưng đơn chỉ ${total.toLocaleString("vi-VN")}đ — thừa ${(prepaid - total).toLocaleString("vi-VN")}đ.`));
  }
  // Chưa có vận đơn ⇒ chưa soát được COD. CHƯA BIẾT thì im lặng, không kết luận khớp.
  if (input.shipmentCod !== null && total !== null && total > 0) {
    const conPhaiThu = Math.max(0, total - (prepaid ?? 0));
    const lech = Math.abs(input.shipmentCod - conPhaiThu);
    if (lech > COD_TOLERANCE_VND) {
      findings.push(
        finding(
          "COD_MISMATCH",
          `Vận đơn ghi thu hộ ${input.shipmentCod.toLocaleString("vi-VN")}đ, còn phải thu theo đơn là ${conPhaiThu.toLocaleString("vi-VN")}đ — lệch ${lech.toLocaleString("vi-VN")}đ.`,
        ),
      );
    }
  }

  const blockers = findings.filter((f) => f.severity === "BLOCKER");
  return { findings, blockers, warnings: findings.filter((f) => f.severity === "WARNING"), readyToShip: blockers.length === 0 };
}

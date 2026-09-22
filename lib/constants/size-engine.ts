/**
 * ───────────── MÁY GỢI Ý SIZE ─────────────
 *
 * KẾT QUẢ KIỂM TRA DỮ LIỆU SIZE TRONG ERP (14/09/2026):
 *
 * ERP có NHÃN size (`product_variants.size` = S/M/L/XL, `production_orders.sizes`,
 * `landing_orders.size_text`) nhưng KHÔNG có bảng số đo nào. `product_variants.weight` là KHỐI
 * LƯỢNG KIỆN HÀNG tính cước, không phải cân nặng người mặc. `product_variants.attributes` là các
 * cặp tên–giá trị tự do đồng bộ từ Pancake ("Màu: Đỏ", "Size: L"), không phải số đo.
 *
 * Nghĩa là: **chưa có nguồn dữ liệu nào đủ tin để gợi ý size.** Vì vậy máy KHÔNG gợi ý — nó trả
 * `SIZE_DATA_MISSING` và hội thoại được chuyển cho người. Đoán size trên cơ thể một người thật
 * rồi gửi đi một kiện hàng là cách chắc chắn tạo ra một đơn đổi size và một khách mất niềm tin;
 * mô hình ngôn ngữ đoán rất trôi chảy, và đó chính là điều làm nó nguy hiểm ở đây.
 *
 * Khi chủ shop khai bảng số đo thật, nó được lưu ở `settings` khoá `ai.sizeRules` theo cấu trúc
 * dưới đây — CÓ PHIÊN BẢN và CÓ PHẠM VI, để một mẫu vải co giãn không bị áp bảng của mẫu vải cứng.
 */

export const SIZE_RESULT_CODES = ["OK", "SIZE_DATA_MISSING", "MEASUREMENTS_MISSING", "AMBIGUOUS", "OUT_OF_RANGE"] as const;
export type SizeResultCode = (typeof SIZE_RESULT_CODES)[number];

export const SIZE_RESULT_LABEL: Record<SizeResultCode, string> = {
  OK: "Có gợi ý size",
  SIZE_DATA_MISSING: "Chưa có bảng số đo cho mẫu này",
  MEASUREMENTS_MISSING: "Chưa có số đo của khách",
  AMBIGUOUS: "Số đo rơi vào nhiều size",
  OUT_OF_RANGE: "Số đo nằm ngoài bảng",
};

/** Chỉ `OK` mới được nói với khách. Mọi mã còn lại đều phải chuyển người. */
export function sizeNeedsHuman(code: SizeResultCode): boolean {
  return code !== "OK";
}

/** Số đo của khách. Mọi trường đều tuỳ chọn; thiếu = CHƯA BIẾT, không phải 0. */
export type BodyMeasurements = {
  heightCm?: number | null;
  weightKg?: number | null;
  bustCm?: number | null;
  waistCm?: number | null;
  hipCm?: number | null;
};

export const MEASUREMENT_KEYS = ["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export const MEASUREMENT_LABEL: Record<MeasurementKey, string> = {
  heightCm: "Chiều cao (cm)",
  weightKg: "Cân nặng (kg)",
  bustCm: "Vòng ngực (cm)",
  waistCm: "Vòng eo (cm)",
  hipCm: "Vòng mông (cm)",
};

/** Khoảng đóng [min, max]. Thiếu một chiều nghĩa là chiều đó KHÔNG ràng buộc, không phải bằng 0. */
export type Range = [number, number];

export type SizeRow = {
  size: string;
  heightCm?: Range;
  weightKg?: Range;
  bustCm?: Range;
  waistCm?: Range;
  hipCm?: Range;
};

/**
 * Phạm vi áp dụng của một bảng số đo, từ hẹp tới rộng. Hẹp THẮNG rộng — cùng một luật mà ERP đã
 * dùng cho đích chỉ số (công ty → phòng ban → chức danh).
 */
export const SIZE_SCOPES = ["VARIANT", "PRODUCT", "FAMILY", "GLOBAL"] as const;
export type SizeScope = (typeof SIZE_SCOPES)[number];

const SCOPE_RANK: Record<SizeScope, number> = { VARIANT: 0, PRODUCT: 1, FAMILY: 2, GLOBAL: 3 };

/** Độ co giãn của vải — cùng số đo, vải co giãn và vải cứng ra hai size khác nhau. */
export const FABRIC_STRETCH = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type FabricStretch = (typeof FABRIC_STRETCH)[number];

export type SizeRule = {
  /** Phiên bản bảng — đổi bảng là đổi phiên bản, để gợi ý cũ đọc lại vẫn hiểu theo bảng lúc đó. */
  version: string;
  /**
   * TÊN BẢNG cho người đọc ("Bảng nam", "Bảng nữ").
   *
   * Tách khỏi `version` vì hai thứ đổi theo hai nhịp khác nhau: tên là thứ chủ shop chọn trong ô
   * chọn trên màn hình và gần như không đổi; phiên bản đổi mỗi lần sửa một con số trong bảng.
   * Dùng `version` làm nhãn hiển thị thì mỗi lần sửa bảng là mọi lựa chọn đã lưu trỏ vào hư không.
   */
  label?: string;
  scope: SizeScope;
  /** Khoá của phạm vi: mã mẫu mã / mã sản phẩm / tên nhóm hàng. Bỏ trống với `GLOBAL`. */
  key?: string;
  /**
   * NHIỀU KHOÁ CHO CÙNG MỘT BẢNG — sáu mã hàng dùng chung hai bảng, không phải sáu bảng.
   *
   * Không có trường này thì mỗi mã hàng phải là một dòng `SizeRule` riêng, và bảng nữ bị chép ra
   * năm bản. Chép năm bản nghĩa là sửa một dòng size phải sửa đúng năm chỗ, và chỉ cần quên một
   * chỗ là hai mã hàng cùng loại tư vấn hai size khác nhau cho cùng một khách.
   *
   * `key` cũ vẫn dùng được và vẫn tính — bảng đã khai theo lối cũ không bị bỏ rơi.
   */
  keys?: string[];
  fabricStretch?: FabricStretch;
  rows: SizeRow[];
  note?: string;
};

export const SIZE_RULES_KEY = "ai.sizeRules";

/** MẶC ĐỊNH RỖNG — và KHÔNG được thêm bảng mẫu nào vào đây. Xem ghi chú đầu tệp. */
export const DEFAULT_SIZE_RULES: { version: string; rules: SizeRule[] } = { version: "", rules: [] };

export type SizeLookup = {
  variantId?: string | null;
  productId?: string | null;
  /**
   * MÃ HÀNG CỦA SHOP (`products.custom_id`, ví dụ "Q006") — khác `productId` là id nội bộ đồng bộ
   * từ Pancake.
   *
   * Phạm vi `PRODUCT` nhận CẢ HAI, và đó là điều cố ý. Chủ shop khai bằng mã hàng vì đó là thứ
   * người ta nói với nhau; id nội bộ thì không ai nhớ, và nó là dữ liệu của bên thứ ba nên một
   * lần đồng bộ lại là mọi lựa chọn đã lưu trỏ vào hư không mà không ai biết.
   */
  productCode?: string | null;
  family?: string | null;
};

/**
 * Bảng áp dụng cho một mẫu mã: phạm vi HẸP NHẤT khớp được. Không khớp gì ⇒ `null` ⇒
 * `SIZE_DATA_MISSING`. HÀM THUẦN.
 */
export function resolveSizeRule(rules: SizeRule[], lookup: SizeLookup): SizeRule | null {
  const matches = rules.filter((rule) => {
    if (rule.scope === "GLOBAL") return true;
    // `key` đơn và `keys` nhiều đứng chung một rổ — bảng khai theo lối cũ vẫn chạy y như trước.
    const keys = [rule.key ?? "", ...(rule.keys ?? [])].map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!keys.length) return false;
    if (rule.scope === "VARIANT") return keys.includes((lookup.variantId ?? "").toLowerCase());
    if (rule.scope === "PRODUCT") {
      // Khớp id nội bộ HOẶC mã hàng của shop. Xem ghi chú ở `SizeLookup.productCode`.
      return keys.includes((lookup.productId ?? "").toLowerCase()) || keys.includes((lookup.productCode ?? "").trim().toLowerCase());
    }
    return keys.includes((lookup.family ?? "").trim().toLowerCase());
  });
  if (!matches.length) return null;
  return matches.sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope])[0];
}

export type SizeRecommendation = {
  code: SizeResultCode;
  size: string | null;
  /** Vì sao ra kết quả đó, đọc được bằng tiếng Việt. */
  reason: string;
  /** Số đo còn thiếu để kết luận được (chỉ có nghĩa với `MEASUREMENTS_MISSING`). */
  missing: MeasurementKey[];
  /** Các size cùng khớp (chỉ có nghĩa với `AMBIGUOUS`). */
  candidates: string[];
  ruleVersion: string;
  scope: SizeScope | null;
};

function inRange(value: number | null | undefined, range: Range | undefined): boolean | null {
  if (!range) return null; // chiều này không ràng buộc
  if (value === null || value === undefined) return null; // chưa biết số đo
  return value >= range[0] && value <= range[1];
}

/**
 * Gợi ý size. HÀM THUẦN — không đọc CSDL, không gọi mô hình.
 *
 * Chỉ trả `OK` khi ĐÚNG MỘT size khớp mọi chiều có ràng buộc VÀ khách đã cung cấp đủ số đo cho
 * các chiều ấy. Hai size cùng khớp là CHƯA BIẾT, không phải "chọn cái đầu".
 */
export function recommendSize(rule: SizeRule | null, body: BodyMeasurements): SizeRecommendation {
  if (!rule || !rule.rows.length) {
    return {
      code: "SIZE_DATA_MISSING",
      size: null,
      reason: "ERP chưa có bảng số đo cho mẫu này — không có căn cứ nào để gợi ý size",
      missing: [],
      candidates: [],
      ruleVersion: rule?.version ?? "",
      scope: rule?.scope ?? null,
    };
  }

  // Những chiều mà bảng THẬT SỰ dùng — chỉ đòi khách các số đo đó, không đòi cho đủ bộ.
  const used = MEASUREMENT_KEYS.filter((key) => rule.rows.some((row) => row[key]));
  const missing = used.filter((key) => body[key] === null || body[key] === undefined);
  if (missing.length) {
    return {
      code: "MEASUREMENTS_MISSING",
      size: null,
      reason: `Cần thêm: ${missing.map((key) => MEASUREMENT_LABEL[key]).join(", ")}`,
      missing,
      candidates: [],
      ruleVersion: rule.version,
      scope: rule.scope,
    };
  }

  const fits = rule.rows.filter((row) => MEASUREMENT_KEYS.every((key) => inRange(body[key], row[key]) !== false));
  if (!fits.length) {
    return {
      code: "OUT_OF_RANGE",
      size: null,
      reason: "Số đo của khách nằm ngoài mọi size trong bảng — để nhân viên tư vấn",
      missing: [],
      candidates: [],
      ruleVersion: rule.version,
      scope: rule.scope,
    };
  }
  if (fits.length > 1) {
    return {
      code: "AMBIGUOUS",
      size: null,
      reason: "Số đo rơi vào nhiều size — để nhân viên hỏi thêm sở thích mặc rộng/ôm",
      missing: [],
      candidates: fits.map((row) => row.size),
      ruleVersion: rule.version,
      scope: rule.scope,
    };
  }
  return {
    code: "OK",
    size: fits[0].size,
    reason: rule.note || `Theo bảng số đo ${rule.version} (phạm vi ${rule.scope})`,
    missing: [],
    candidates: [],
    ruleVersion: rule.version,
    scope: rule.scope,
  };
}

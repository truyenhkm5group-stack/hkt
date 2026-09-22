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
  /** Các size cùng khớp (có nghĩa với `AMBIGUOUS`, và với `OK` khi đã nâng size). */
  candidates: string[];
  /**
   * SIZE NHỎ HƠN ĐÃ BỊ BỎ QUA khi số đo rơi đúng ranh giới hai size. `null` = không nâng.
   *
   * Khác `null` nghĩa là câu trả lời CÓ ĐIỀU KIỆN: máy đã chọn hộ theo luật "thà rộng còn hơn
   * chật", và câu chữ BẮT BUỘC phải nói ra để khách đổi lại được. Giấu đi thì khách nhận một
   * size mình không chọn và cũng không biết là mình có quyền chọn khác.
   */
  roundedUpFrom: string | null;
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
      roundedUpFrom: null,
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
      roundedUpFrom: null,
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
      roundedUpFrom: null,
      ruleVersion: rule.version,
      scope: rule.scope,
    };
  }
  if (fits.length > 1) {
    /*
      SỐ ĐO RƠI ĐÚNG RANH GIỚI ⇒ LẤY SIZE LỚN HƠN, VÀ NÓI RA.

      Luật của chủ shop (22/09/2026): "nâng size to hơn để không bị chật, hoặc hỏi lại khách xem
      muốn mặc ôm hay mặc vừa thoải mái". Hai vế ấy KHÔNG loại trừ nhau và bản này làm cả hai
      trong MỘT tin: chọn size lớn hơn để không ai nhận một cái áo chật, rồi nói thẳng rằng đã
      chọn hộ và khách đổi lại được.

      Vì sao không dừng lại ở hỏi: hỏi rồi chờ là mất một lượt, và trên dữ liệu thật phần lớn
      khách không quay lại trả lời một câu hỏi phụ. Vì sao không chọn im lặng: khách nhận một
      size mình không chọn và cũng không biết là mình có quyền chọn khác — `roundedUpFrom` khác
      `null` là một RÀNG BUỘC lên câu chữ, không phải một ghi chú.

      THỨ TỰ SIZE SUY TỪ CHÍNH BẢNG, không từ một danh sách tên ghi cứng. Một bảng có thể dùng
      XS/S/M/L/XL, bảng khác M/L/XL/2XL, bảng sau nữa dùng số — mọi vốn từ ghi cứng đều sẽ sai
      với một bảng nào đó. Ở đây "lớn hơn" = size có CẬN TRÊN cao nhất trên chiều đang ràng buộc,
      đọc trên toàn bộ các dòng của size ấy. Hoà nhau ⇒ không kết luận được ⇒ vẫn là CHƯA BIẾT.
    */
    const chieu = MEASUREMENT_KEYS.filter((k) => rule.rows.some((r) => r[k]));
    // Chiều để xếp hạng: chiều mà các ứng viên THẬT SỰ khác nhau. Cân nặng trước, vì đó là chiều
    // quyết định độ rộng của áo; chiều cao chỉ phân dải người.
    const xepTheo = (["weightKg", "bustCm", "hipCm", "waistCm", "heightCm"] as const).find((k) => chieu.includes(k));
    const tran = (size: string): number | null => {
      if (!xepTheo) return null;
      const cans = rule.rows.filter((r) => r.size === size && r[xepTheo]).map((r) => r[xepTheo]![1]);
      return cans.length ? Math.max(...cans) : null;
    };
    const ungVien = [...new Set(fits.map((r) => r.size))];
    const xep = ungVien.map((s2) => ({ size: s2, tran: tran(s2) })).filter((x) => x.tran !== null) as { size: string; tran: number }[];
    const caoNhat = xep.length === ungVien.length ? Math.max(...xep.map((x) => x.tran)) : null;
    const lon = caoNhat === null ? [] : xep.filter((x) => x.tran === caoNhat);

    if (lon.length === 1) {
      const nho = ungVien.filter((s2) => s2 !== lon[0].size);
      return {
        code: "OK",
        size: lon[0].size,
        reason: `Số đo nằm giữa ${ungVien.join(" và ")} — lấy size lớn hơn để không bị chật, và hỏi lại khách thích mặc ôm hay thoải mái`,
        missing: [],
        candidates: ungVien,
        roundedUpFrom: nho.join(", "),
        ruleVersion: rule.version,
        scope: rule.scope,
      };
    }

    // Không xếp được thứ tự (hoà cận trên, hoặc bảng không có chiều số nào để so) ⇒ CHƯA BIẾT.
    // Đoán ở đây là chọn hộ mà không có căn cứ nào, khác hẳn việc chọn size lớn hơn có căn cứ.
    return {
      code: "AMBIGUOUS",
      size: null,
      reason: "Số đo rơi vào nhiều size mà bảng không cho biết size nào lớn hơn — để nhân viên hỏi thêm",
      missing: [],
      candidates: ungVien,
      roundedUpFrom: null,
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
    roundedUpFrom: null,
    ruleVersion: rule.version,
    scope: rule.scope,
  };
}

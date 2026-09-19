/**
 * SỔ ĐĂNG KÝ MÔ HÌNH — BẢN KHAI NĂNG LỰC, KHÔNG PHẢI BẢNG GIÁ VÀ KHÔNG PHẢI BẢNG ĐIỂM.
 *
 * ═══ BA LOẠI SỰ THẬT, BA CHỖ Ở — VÀ ĐÂY LÀ QUYẾT ĐỊNH THIẾT KẾ QUAN TRỌNG NHẤT CỦA TỆP ═══
 *
 * Đặc tả liệt kê mười bốn trường cho mỗi mô hình: nhà cung cấp · tên · bật/tắt · vai trò · ba loại
 * đơn giá · trần ngữ cảnh · hai cờ năng lực · độ trễ p50/p95 · tỷ lệ lỗi · điểm chất lượng · lần
 * đo gần nhất. Nhét cả mười bốn vào một tệp hằng số là cách nhanh nhất để có một tệp NÓI DỐI, vì
 * chúng KHÔNG cùng loại:
 *
 *   1. KHAI BÁO (ở đây) — thứ chỉ người mới biết và không đo được: mô hình này tồn tại, nó đóng
 *      vai gì, nó đọc được ảnh không, trần ngữ cảnh bao nhiêu. Đổi khi nhà cung cấp ra bản mới.
 *
 *   2. GIÁ (ở `settings.pricing`, tức CSDL) — đổi theo hợp đồng và theo thời điểm, và `ai_runs`
 *      đã ghi `pricing_version` của từng lượt để một lần đổi giá không viết lại lịch sử. Ghi giá
 *      vào hằng số là ghim một con số vào ảnh Docker: sửa giá phải phát hành lại phần mềm, và
 *      những lượt chạy cũ lặng lẽ đổi nghĩa. Đặc tả cũng đòi đúng điều này — "giá phải update
 *      được bằng config/database".
 *
 *   3. QUAN SÁT (tính từ `ai_model_calls`) — độ trễ p50/p95, tỷ lệ lỗi, lần đo gần nhất. Những
 *      con số này ĐÃ NẰM SẴN trong sổ lượt gọi; chép chúng vào một hằng số là dựng nguồn sự thật
 *      thứ hai, và nó sai đi mỗi giờ kể từ lúc được gõ. `modelObserved()` trong
 *      `lib/queries/model-metrics.ts` đọc thẳng từ sổ.
 *
 * ĐIỂM CHẤT LƯỢNG cố tình KHÔNG có ở cả ba chỗ. Nó chỉ có nghĩa khi có người chấm, và hiện
 * 0/1006 lượt được chấm — khai một con số lúc này là bịa. Khi có nhãn người thì nó tới từ
 * `sales_review_labels`, cùng đường với mọi con số chất lượng khác.
 *
 * ═══ SỔ NÀY KHÔNG CHỌN MÔ HÌNH ═══
 *
 * Nó chỉ khai mô hình nào TỒN TẠI và làm được gì. Việc chọn là của bộ định tuyến
 * (`lib/ai-workforce/model-router.ts`) và của mô phỏng (`lib/constants/router-sim.ts`). Trộn hai
 * việc lại thì đổi một dòng khai báo sẽ âm thầm đổi hành vi định tuyến của production.
 */

/** Nhà cung cấp mà kho mã có adapter. Thêm một cái = thêm một tệp trong `lib/ai-workforce/providers/`. */
export const MODEL_PROVIDERS = ["erp", "anthropic", "google", "stub"] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

/**
 * VAI TRÒ — nấc việc mà mô hình này được khai để phục vụ.
 *
 * `ROUTINE` và `COMPLEX` khớp thẳng với hai nấc bộ định tuyến đang chạy (`ECONOMY` / `STRONG`).
 * `PREMIUM` là nấc THỨ BA và nó CỐ Ý không nằm trên đường mặc định của chat khách: đặc tả ghi rõ
 * "L3 không nằm trên đường mặc định của customer chat", nên nó chỉ dùng cho việc chạy ngoài giờ
 * (dựng lại nhãn, soi chất lượng). Khai nó ở đây để có chỗ nói ra điều đó, chứ không phải để bật.
 */
export const MODEL_ROLES = ["ROUTINE", "COMPLEX", "PREMIUM"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelEntry = {
  provider: ModelProviderName;
  /** Tên mô hình ĐÚNG như nhà cung cấp gọi — cũng là khoá tra giá `"<provider>:<model>"`. */
  model: string;
  role: ModelRole;
  /**
   * Có được phép dùng không. `false` = đã khai nhưng CHƯA bật — khác hẳn "chưa khai".
   * Một mô hình mới thêm luôn vào ở trạng thái tắt; bật nó là một quyết định, không phải một lượt
   * triển khai.
   */
  enabled: boolean;
  maxContextTokens: number;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  /** Vì sao mô hình này có mặt trong sổ — để người sau không phải đoán. */
  note: string;
};

/**
 * ═══ SỔ ═══
 *
 * Tên mô hình lấy từ CẤU HÌNH ĐANG CHẠY của kho mã (`aiEnv`, `lib/ai/*`), không phải từ trí nhớ
 * của tôi về danh mục của các nhà cung cấp. Khoá `model` rỗng nghĩa là "nấc này lấy tên mô hình
 * từ biến môi trường" — adapter `erp` và `anthropic` đều làm vậy, và ghi cứng một cái tên ở đây
 * sẽ ghi đè lên lựa chọn của người vận hành.
 */
export const MODEL_REGISTRY: ModelEntry[] = [
  {
    provider: "erp",
    model: "",
    role: "ROUTINE",
    enabled: true,
    maxContextTokens: 0,
    supportsStructuredOutput: true,
    supportsVision: false,
    note: "Nấc rẻ ĐANG CHẠY THẬT, tên mô hình do tầng AI của ERP quyết theo biến môi trường. Đây là CHAMPION hiện tại của nhóm việc thường.",
  },
  {
    provider: "erp",
    model: "",
    role: "COMPLEX",
    enabled: true,
    maxContextTokens: 0,
    supportsStructuredOutput: true,
    supportsVision: false,
    note: "Nấc mạnh ĐANG CHẠY THẬT, cùng tầng AI của ERP. Champion hiện tại của nhóm việc khó.",
  },
  {
    provider: "anthropic",
    model: "",
    role: "COMPLEX",
    enabled: false,
    maxContextTokens: 0,
    supportsStructuredOutput: true,
    supportsVision: true,
    note: "Đường lui khi chủ shop muốn tách hoá đơn khỏi tầng ERP. Tắt mặc định: bật là một quyết định về hoá đơn, không phải một lượt phát hành.",
  },
  {
    provider: "google",
    model: "",
    role: "ROUTINE",
    enabled: false,
    maxContextTokens: 0,
    supportsStructuredOutput: true,
    supportsVision: true,
    note: "CHALLENGER của nhóm việc thường. Tắt mặc định và KHÔNG BAO GIỜ là nhà cung cấp mặc định — nó chỉ chạy trong mẻ đối chứng ngầm, không đứng trước khách.",
  },
  {
    provider: "google",
    model: "",
    role: "COMPLEX",
    enabled: false,
    maxContextTokens: 0,
    supportsStructuredOutput: true,
    supportsVision: true,
    note: "CHALLENGER của nhóm việc khó, và là đường DUY NHẤT hiện có cho ảnh (khách gửi ảnh sản phẩm / ảnh quảng cáo). Kết quả nhìn ảnh vẫn phải đối chiếu lại danh mục ERP trước khi được dùng.",
  },
];

/** Khoá tra giá trong `settings.pricing`. Rỗng phần model ⇒ chỉ tra được khi biết tên lúc chạy. */
export function priceKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function registryFor(role: ModelRole): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.role === role);
}

/** Mô hình đang BẬT của một vai trò. Rỗng = chưa ai bật cái nào ⇒ nơi gọi phải xử lý, không đoán. */
export function enabledFor(role: ModelRole): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.role === role && m.enabled);
}

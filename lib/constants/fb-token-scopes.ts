/**
 * ═══════════ TOKEN FACEBOOK CÓ QUYỀN GÌ — HỎI FACEBOOK, KHÔNG ĐOÁN ═══════════
 *
 * Trước 24/09/2026 ERP không có cách nào biết token đang chạy mang quyền gì: `testConnection()` chỉ
 * trả lời "token còn sống", và tab Cấu hình của vòng mẫu in cứng một ô "chưa biết". Đo production
 * cùng ngày: `ADS_WRITE_ENABLED=true` từ 22/09, nhưng sổ `ads_budget_changes` và
 * `creative_fb_actions` đều TRỐNG — đường ghi đã mở hai ngày mà chưa từng có một lượt thử, nên câu
 * "token có `ads_management` chưa" không có câu trả lời nào ngoài lời kể. Tài liệu vòng mẫu thì ghi
 * "token chỉ có ads_read" trong khi secret đã được thay trước ngày viết câu đó. Hai lời kể trái nhau,
 * không lời nào là phép đo.
 *
 * Nay ERP HỎI: `GET /me/permissions` (chỉ đọc) trả về từng quyền kèm `granted` / `declined`. Tệp này
 * là phần THUẦN: nhận câu trả lời đó (hoặc lỗi) và kết luận.
 *
 * ─── BA CÂU TRẢ LỜI, VÀ CÂU THỨ BA KHÔNG ĐƯỢC TÔ XANH ───
 *
 *  · `READY`   — có `ads_management` ở trạng thái `granted`: đường ghi ngân sách KHÔNG còn bị chặn vì
 *                quyền token. (Vẫn còn chốt máy chủ, nấc COPILOT và phiếu duyệt — tệp này không nói
 *                thay chúng.)
 *  · `MISSING` — Facebook trả lời được, và `ads_management` không có hoặc bị `declined`.
 *  · `UNKNOWN` — chưa có token, hoặc Facebook không trả lời được. KHÔNG phải "thiếu": không hỏi được
 *                thì không kết luận (AGENTS.md mục 0.3).
 *
 * ─── MỘT ĐIỀU `/me/permissions` KHÔNG TRẢ LỜI ĐƯỢC ───
 *
 * Quyền của System User trên TỪNG TÀI SẢN (tài khoản quảng cáo "Quản lý chiến dịch", fanpage "Tạo
 * quảng cáo") là phân quyền trong Business Manager, không phải phạm vi của token. Token đủ phạm vi mà
 * fanpage chưa giao quyền thì lượt đăng mẫu vẫn bị từ chối. Nên `assetAccess` luôn là `UNKNOWN` ở đây
 * và màn hình phải nói ra — lượt ghi đầu tiên mới trả lời được câu đó.
 */

/** Phạm vi đường ghi ngân sách / bật tắt chiến dịch cần. */
export const FB_WRITE_SCOPE = "ads_management";

/** Phạm vi ERP đang dùng để ĐỌC (đồng bộ chi tiêu, tra mẩu quảng cáo, Business Manager). */
export const FB_READ_SCOPES = ["ads_read", "business_management"] as const;

export type FbPermissionRow = { permission: string; status: string };

export type FbScopeState = "READY" | "MISSING" | "UNKNOWN";

export const FB_SCOPE_STATE_LABEL: Record<FbScopeState, string> = {
  READY: "Token có quyền ghi quảng cáo",
  MISSING: "Token THIẾU quyền ghi quảng cáo",
  UNKNOWN: "Chưa biết token có quyền gì",
};

export type FbScopeAssessment = {
  state: FbScopeState;
  /** Quyền Facebook trả `granted`, đã sắp xếp. Rỗng khi `UNKNOWN`. */
  granted: string[];
  /** Quyền người dùng đã TỪ CHỐI khi cấp — có tên nhưng không dùng được. */
  declined: string[];
  /** Quyền đọc ERP đang dùng mà token không có (đồng bộ chi tiêu sẽ lỗi ở đâu đó). */
  missingRead: string[];
  /** Một câu cho người đọc: vì sao ra kết luận này, và việc phải làm nếu thiếu. */
  reason: string;
  /** Luôn `UNKNOWN` — xem chú thích đầu tệp. */
  assetAccess: "UNKNOWN";
};

/**
 * Che mọi thứ giống token trước khi in: tham số `access_token=` trong URL và chuỗi token Meta
 * (bắt đầu `EAA`). Kho mã PUBLIC và câu lỗi đi thẳng lên màn hình — một câu lỗi mạng có thể chép lại
 * URL, và URL Graph API mang token trong query.
 */
export function maskFbSecrets(text: string): string {
  return text.replace(/access_token=[^&\s"'<>]+/gi, "access_token=***").replace(/\bEAA[A-Za-z0-9]{16,}/g, "EAA***");
}

export function assessFbScopes(input: { hasToken: boolean; permissions: FbPermissionRow[] | null; error?: string | null }): FbScopeAssessment {
  const base = { granted: [] as string[], declined: [] as string[], missingRead: [] as string[], assetAccess: "UNKNOWN" as const };
  if (!input.hasToken) {
    return { ...base, state: "UNKNOWN", reason: "Máy chủ chưa có FACEBOOK_ACCESS_TOKEN — không có token thì không hỏi được quyền." };
  }
  if (input.permissions === null) {
    const loi = maskFbSecrets((input.error ?? "").trim()) || "không rõ lỗi";
    return { ...base, state: "UNKNOWN", reason: `Facebook không trả lời câu hỏi quyền (${loi}). Không kết luận là thiếu — hỏi lại sau.` };
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const granted = [...new Set(input.permissions.filter((p) => norm(p.status) === "granted").map((p) => norm(p.permission)))].sort();
  const declined = [...new Set(input.permissions.filter((p) => norm(p.status) === "declined").map((p) => norm(p.permission)))].sort();
  const missingRead = FB_READ_SCOPES.filter((s) => !granted.includes(s));
  if (granted.includes(FB_WRITE_SCOPE)) {
    return { ...base, state: "READY", granted, declined, missingRead, reason: `Facebook xác nhận token có ${FB_WRITE_SCOPE}.` };
  }
  const tuChoi = declined.includes(FB_WRITE_SCOPE);
  return {
    ...base,
    state: "MISSING",
    granted,
    declined,
    missingRead,
    reason: tuChoi
      ? `${FB_WRITE_SCOPE} có trong token nhưng ở trạng thái TỪ CHỐI — tạo lại token và tích quyền này.`
      : `Token không có ${FB_WRITE_SCOPE}. Quyền gắn vào token lúc TẠO: thêm quyền cho System User rồi phải tạo mã mới và dán vào secret FACEBOOK_ACCESS_TOKEN.`,
  };
}

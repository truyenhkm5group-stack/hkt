/**
 * ═══════════ SETUP CAMP CỦA "ĐĂNG CAMP" — TKQC · FANPAGE · MỤC TIÊU · NGÂN SÁCH · VỊ TRÍ · TUỔI · GIỚI TÍNH ═══════════
 *
 * Chủ shop 26/09/2026: "code thêm tính năng chọn TKQC, chọn fanpage, chọn mục tiêu chiến dịch, ngân sách quảng cáo, vị trí
 * địa lý… như những setup trên FB. Để mặc định theo những lựa chọn được sử dụng nhiều". Chốt cùng ngày: TKQC + fanpage lấy
 * từ dữ liệu ĐÃ ĐỒNG BỘ; ngân sách GIỮ trần cũ (`CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd`, 1 ngày).
 *
 * Tệp này là HÌNH DẠNG + nhãn (không import gì phía máy chủ — hộp soạn bài phía trình duyệt đọc được). Phép áp setup
 * lên quảng cáo mẫu là hàm thuần ở `lib/creative/campaign-setup.ts`.
 *
 * ─── VÌ SAO MỤC TIÊU CHỈ CÓ BA LỰA CHỌN ───
 *
 * Mỗi mục tiêu Facebook đi kèm một TỔ HỢP tham số nhóm (mục tiêu tối ưu · sự kiện tính tiền · điểm đến · đối tượng quảng
 * bá) — ghép sai là Facebook từ chối, hoặc tệ hơn là nhận và chạy sai chỗ. Vòng mẫu chỉ mở những tổ hợp đã rõ:
 *   · `TEMPLATE` — "Như quảng cáo mẫu": chép NGUYÊN mục tiêu + cài đặt nhóm của quảng cáo mẫu (tổ hợp shop đang chạy thật).
 *   · `MESSAGES` — "Tin nhắn": OUTCOME_ENGAGEMENT · tối ưu CONVERSATIONS · tính tiền IMPRESSIONS · điểm đến MESSENGER ·
 *                  đối tượng quảng bá = fanpage đã chọn (tổ hợp Click-to-Messenger chuẩn của Meta).
 *   · `REACH`    — "Tiếp cận": OUTCOME_AWARENESS · tối ưu REACH · tính tiền IMPRESSIONS · đối tượng quảng bá = fanpage.
 * Mục tiêu đòi pixel / dataset / sự kiện mua (Doanh số) KHÔNG mở: ERP không có dữ liệu để chọn đúng tập dữ liệu ấy.
 */

export const CAMPAIGN_OBJECTIVES = ["TEMPLATE", "MESSAGES", "REACH"] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];
export const CAMPAIGN_OBJECTIVE_LABEL: Record<CampaignObjective, string> = {
  TEMPLATE: "Như quảng cáo mẫu",
  MESSAGES: "Tin nhắn (Messenger)",
  REACH: "Tiếp cận / nhận biết",
};

export const CAMPAIGN_GENDERS = ["ALL", "FEMALE", "MALE"] as const;
export type CampaignGender = (typeof CAMPAIGN_GENDERS)[number];
export const CAMPAIGN_GENDER_LABEL: Record<CampaignGender, string> = { ALL: "Tất cả", FEMALE: "Nữ", MALE: "Nam" };

/** Một kết quả tìm vị trí địa lý (Graph `search?type=adgeolocation`) — khai ở đây để hộp soạn bài phía trình duyệt đọc được. */
export type GeoSearchHit = { key: string; name: string; type: "region" | "city"; region: string | null };

/** Một vị trí địa lý đã chọn (khoá Facebook trả về từ tìm kiếm `adgeolocation`). */
export type GeoPick = { key: string; name: string; type: "region" | "city" };

/**
 * `null` ở một ô = "NHƯ QUẢNG CÁO MẪU" (giữ nguyên thứ mẫu đang có). `geo = []` = toàn quốc Việt Nam; `geo` có phần tử =
 * đúng những tỉnh / thành ấy.
 */
export type CampaignSetup = {
  adAccountId: string;
  pageId: string;
  objective: CampaignObjective;
  budgetVnd: number;
  geo: GeoPick[] | null;
  ageMin: number | null;
  ageMax: number | null;
  gender: CampaignGender | null;
};

/** Giới hạn ô nhập — tuổi theo quy định của Facebook (13–65, 65 = "65+"); ngân sách tối thiểu để một ngày có phân phối. */
export const CAMPAIGN_SETUP_LIMITS = { minBudgetVnd: 20_000, minAge: 18, maxAge: 65, maxGeo: 25 } as const;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** Đọc lại setup từ JSON (lô `INSTANT` / bản nháp hàng đợi). Hỏng ⇒ `null` — đường đăng chạy như quảng cáo mẫu. Hàm THUẦN. */
export function parseCampaignSetup(raw: unknown): CampaignSetup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const adAccountId = typeof r.adAccountId === "string" ? r.adAccountId.trim() : "";
  const pageId = typeof r.pageId === "string" ? r.pageId.trim() : "";
  const objective = (CAMPAIGN_OBJECTIVES as readonly string[]).includes(r.objective as string) ? (r.objective as CampaignObjective) : null;
  const budgetVnd = num(r.budgetVnd);
  if (!adAccountId || !pageId || !objective || budgetVnd === null || budgetVnd <= 0) return null;
  const geo = Array.isArray(r.geo)
    ? r.geo
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .map((g) => ({ key: String(g.key ?? "").trim(), name: String(g.name ?? "").trim(), type: g.type === "city" ? ("city" as const) : ("region" as const) }))
        .filter((g) => g.key !== "")
    : null;
  const gender = (CAMPAIGN_GENDERS as readonly string[]).includes(r.gender as string) ? (r.gender as CampaignGender) : null;
  return { adAccountId, pageId, objective, budgetVnd, geo, ageMin: num(r.ageMin), ageMax: num(r.ageMax), gender };
}

/** Câu ngắn mô tả một setup — cho sổ ghi / hàng đợi. Hàm THUẦN. */
export function describeCampaignSetup(s: CampaignSetup, names: { account?: string; page?: string } = {}): string {
  const geo = s.geo === null ? "vị trí như mẫu" : s.geo.length === 0 ? "toàn quốc" : s.geo.map((g) => g.name).join(", ");
  const tuoi = s.ageMin === null && s.ageMax === null ? "tuổi như mẫu" : `${s.ageMin ?? "?"}–${s.ageMax === 65 ? "65+" : (s.ageMax ?? "?")}`;
  const gioi = s.gender === null ? "giới tính như mẫu" : CAMPAIGN_GENDER_LABEL[s.gender];
  return [`TKQC ${names.account || s.adAccountId}`, `page ${names.page || s.pageId}`, CAMPAIGN_OBJECTIVE_LABEL[s.objective], `${s.budgetVnd.toLocaleString("vi-VN")}đ`, geo, tuoi, gioi].join(" · ");
}

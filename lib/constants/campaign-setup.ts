/**
 * ═══════════ SETUP CAMP CỦA "ĐĂNG CAMP" — TKQC · FANPAGE · MỤC TIÊU · NGÂN SÁCH · VỊ TRÍ · TUỔI · GIỚI TÍNH ═══════════
 *
 * Chủ shop 26/09/2026: "code thêm tính năng chọn TKQC, chọn fanpage, chọn mục tiêu chiến dịch, ngân sách quảng cáo, vị trí
 * địa lý… như những setup trên FB. Để mặc định theo những lựa chọn được sử dụng nhiều". Chốt cùng ngày: TKQC + fanpage lấy
 * từ dữ liệu ĐÃ ĐỒNG BỘ; ngân sách GIỮ trần cũ (`CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd`).
 *
 * Chủ shop 27/09/2026: ngân sách là NGÂN SÁCH NGÀY, camp CHẠY LIÊN TỤC (không giờ kết thúc — luật tắt QC canh tới khi
 * tắt); chọn MKTer ⇒ mã MKTer (bí danh khai ở trang Lương) vào tên chiến dịch ngay sau tên TKQC để quy tiền ads; chọn
 * được thời gian bắt đầu ngay trong khối setup (và lưu cùng bản nháp hàng đợi).
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

import type { ModelState } from "@/lib/constants/model-lifecycle";

export const CAMPAIGN_OBJECTIVES = ["TEMPLATE", "MESSAGES", "REACH"] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];
export const CAMPAIGN_OBJECTIVE_LABEL: Record<CampaignObjective, string> = {
  TEMPLATE: "Như quảng cáo mẫu",
  MESSAGES: "Tin nhắn (Messenger)",
  REACH: "Tiếp cận / nhận biết",
};

/**
 * LOẠI CAMP — phần giữa tên chiến dịch (chủ shop 27/09/2026: "camp chạy mã win thì ghi tên mã"):
 *   · `TEST` — `..._TEST_...`: luật quy tiền ads tính là CHI PHÍ TEST, không thuộc mã nào.
 *   · `WIN`  — `..._<MÃ>_...` (vd Q005): tiền ads quy về đúng mã hàng của ảnh. Chỉ có khi ảnh thuộc một mã hàng có mã đọc
 *              được trong tên (`ProductWinCode`); mặc định chọn khi mẫu đã được KHAI "Thắng test" trở đi.
 */
export const CAMPAIGN_KINDS = ["TEST", "WIN"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

/** Trạng thái vòng đời (người khai) coi là "đã thắng test" — mặc định loại camp `WIN`. Chưa khai / đang test / thua ⇒ `TEST`. */
export const CAMPAIGN_WIN_STATES = ["WINNER", "PRODUCTION_DISCUSSION", "COSTING", "SAMPLING", "SAMPLE_REVIEW", "APPROVED", "PRODUCTION_PLANNING", "IN_PRODUCTION", "SELLING", "CLEARANCE"] as const satisfies readonly ModelState[];

/** Mã win của MỘT mã hàng — máy chủ dựng (`productWinCodes`), hộp soạn bài đọc. */
export type ProductWinCode = { productId: string; code: string; declaredWin: boolean; stateLabel: string };

/** Phần giữa tên chiến dịch theo loại camp. Hàm THUẦN. */
export function campaignKindLabel(kind: CampaignKind, win: Pick<ProductWinCode, "code"> | null): string {
  return kind === "WIN" && win ? win.code : "TEST";
}

/** Các phần của tên chiến dịch mà setup quyết định. `null` / rỗng = phần ấy không có trong tên. */
export type CampaignNameParts = { account: string | null; marketerCode: string | null; kindLabel: string; page: string | null };

/** Những giá trị mà một phần tên CÓ THỂ đang mang (mọi TKQC / fanpage / mã MKTer / loại camp chọn được) — để nhận ra phần cũ trong tên. */
export type CampaignNameKnown = { accounts: readonly string[]; pages: readonly string[]; marketerCodes: readonly string[]; kinds: readonly string[] };

/**
 * GHÉP LẠI TÊN CHIẾN DỊCH KHI SETUP ĐỔI — ngay lúc chọn, kể cả khi tên đã được lưu / sửa tay (chủ shop 27/09/2026: "khi chọn
 * MKTer thì tên camp sync realtime, chèn mã MKTer vào tên camp luôn"). Tên cắt theo `_`; phần nào trùng MỘT giá trị đã biết
 * của TKQC / fanpage / loại camp thì thay bằng giá trị mới; mã MKTer cũ bị gỡ và mã mới chèn ngay SAU tên TKQC (không có TKQC
 * trong tên thì trước ngày `dd/mm`, không có nữa thì đứng đầu). Phần người tự gõ khác đi (không trùng giá trị nào) giữ nguyên.
 * Hàm THUẦN.
 */
export function rewriteCampaignName(name: string, to: CampaignNameParts, known: CampaignNameKnown): string {
  const has = (list: readonly string[], seg: string) => list.some((x) => x.trim() !== "" && x.trim() === seg.trim());
  let segs = name.split("_");
  if (to.account) segs = segs.map((x) => (has(known.accounts, x) ? to.account as string : x));
  if (to.page) segs = segs.map((x) => (has(known.pages, x) ? to.page as string : x));
  segs = segs.map((x) => (has(known.kinds, x) ? to.kindLabel : x));
  segs = segs.filter((x) => !has(known.marketerCodes, x));
  if (to.marketerCode) {
    const acc = to.account ? segs.findIndex((x) => x.trim() === (to.account as string).trim()) : -1;
    const date = segs.findIndex((x) => /^\d{2}\/\d{2}$/.test(x.trim()));
    const at = acc >= 0 ? acc + 1 : date >= 0 ? date : 0;
    segs.splice(at, 0, to.marketerCode);
  }
  return segs.filter((x) => x !== "").join("_");
}

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
  /** MKTer của camp (`Employee.id` ở trang Lương). `null` = chưa chọn — tên chiến dịch không mang mã MKTer. */
  marketerId: string | null;
  /** Giờ bắt đầu đã chọn (ISO có múi giờ). `null` = chạy ngay lúc bấm. Chỉ để LƯU cùng bản nháp — lúc đăng, giờ hẹn gửi riêng. */
  startAt: string | null;
  /** `TEST` = tên mang chữ TEST · `WIN` = tên mang mã hàng của ảnh (tiền ads quy về mã). */
  campaignKind: CampaignKind;
};

/** Một MKTer chọn được trong khối setup: `code` = mã vào tên chiến dịch (dẫn xuất từ bí danh, máy chủ tính). */
export type MarketerOption = { id: string; name: string; code: string };

/**
 * MÃ MKTER TRONG TÊN CHIẾN DỊCH — dẫn xuất từ bí danh khai ở trang Lương (`Employee.aliases`), KHÔNG phải danh sách thứ
 * hai: luật quy tiền ads (`resolveMarketer`) nhận MKTer bằng đúng các bí danh ấy, nên mã lấy từ đó thì camp tự quy về đúng
 * người. Ưu tiên bí danh MỘT từ (vd "TRINH"), viết hoa, bỏ dấu. Không có bí danh ⇒ `null` (không đoán). Hàm THUẦN.
 */
export function marketerCampaignCode(aliases: readonly string[] | null | undefined): string | null {
  const norm = (a: string) =>
    a
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "D")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .toUpperCase();
  const all = (aliases ?? []).map(norm).filter((a) => a.length >= 2);
  return all.find((a) => !a.includes(" ")) ?? all[0] ?? null;
}

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
  const marketerId = typeof r.marketerId === "string" && r.marketerId.trim() ? r.marketerId.trim() : null;
  const startAt = typeof r.startAt === "string" && Number.isFinite(new Date(r.startAt).getTime()) ? r.startAt : null;
  const campaignKind: CampaignKind = r.campaignKind === "WIN" ? "WIN" : "TEST";
  return { adAccountId, pageId, objective, budgetVnd, geo, ageMin: num(r.ageMin), ageMax: num(r.ageMax), gender, marketerId, startAt, campaignKind };
}

/** Câu ngắn mô tả một setup — cho sổ ghi / hàng đợi. Hàm THUẦN. */
export function describeCampaignSetup(s: CampaignSetup, names: { account?: string; page?: string; marketer?: string } = {}): string {
  const geo = s.geo === null ? "vị trí như mẫu" : s.geo.length === 0 ? "toàn quốc" : s.geo.map((g) => g.name).join(", ");
  const tuoi = s.ageMin === null && s.ageMax === null ? "tuổi như mẫu" : `${s.ageMin ?? "?"}–${s.ageMax === 65 ? "65+" : (s.ageMax ?? "?")}`;
  const gioi = s.gender === null ? "giới tính như mẫu" : CAMPAIGN_GENDER_LABEL[s.gender];
  const mkt = s.marketerId ? `MKTer ${names.marketer || s.marketerId}` : "chưa chọn MKTer";
  return [`TKQC ${names.account || s.adAccountId}`, `page ${names.page || s.pageId}`, mkt, s.campaignKind === "WIN" ? "camp mã win" : "camp TEST", CAMPAIGN_OBJECTIVE_LABEL[s.objective], `${s.budgetVnd.toLocaleString("vi-VN")}đ/ngày`, geo, tuoi, gioi].join(" · ");
}

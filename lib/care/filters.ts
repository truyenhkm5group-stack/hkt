import { CARE_SLA_SOON_FRACTION, CARE_TERMINAL_STATUSES, CARE_WAITING_STATUSES } from "@/lib/constants/care";
import { CARE_DATE_KEYS, matchesCareDate, parseCareDateFilter, type CareDateFilter, type CareDateKey } from "@/lib/constants/care-dates";
import { followUpBucket, type FollowUpFilterKey, type ResolutionFilterKey } from "@/lib/constants/care-resolution";
import { careRoundBand, type CareRoundBand } from "@/lib/constants/care-rounds";
import type { CareCase } from "@/lib/care/contracts";
import { DEFAULT_CARE_SLA_HOURS, followUpStillHolds, teamResponded, teamWorkEnded, type CareSlaHours, type CareStateLike } from "@/lib/care/view";

/**
 * ═══════════ MỘT LUẬT LỌC, DÙNG CHO CẢ BẢNG LẪN CON SỐ TRÊN CHIP ═══════════
 *
 * Trước bản này bàn care có hai đoạn mã lọc song song: một đoạn dựng danh sách hiện ra, một đoạn
 * đếm số trên chip "ĐVVC báo". Hai đoạn phải được sửa cùng nhau mỗi lần thêm một bộ lọc — và lần
 * thêm nào quên một đoạn thì chip nói 12 còn bảng hiện 7, không ai biết con số nào đúng.
 *
 * Ở đây chỉ có MỘT vị từ `matchesCareFilters`. Chip đếm bằng `matchesExcept(...)` — chính vị từ đó
 * với ĐÚNG MỘT chiều bị tắt (chiều của chính cái chip), nên "số trên chip = số dòng bảng sẽ hiện
 * khi bấm" là tính chất của cấu trúc, không phải của sự cẩn thận.
 *
 * Toàn bộ tệp này THUẦN: không đọc CSDL, không đọc `Date.now()` ngầm (giờ luôn truyền vào). Máy chủ
 * và trình duyệt chạy cùng một hàm ra cùng một kết quả, và kiểm thử gọi thẳng được.
 */

/* ─────────────────────────── HẠN XỬ LÝ ─────────────────────────── */

export const CARE_SLA_BUCKETS = ["ok", "soon", "breached"] as const;
export type CareSlaBucket = (typeof CARE_SLA_BUCKETS)[number];
export const CARE_SLA_BUCKET_LABEL: Record<CareSlaBucket, string> = {
  ok: "Bình thường",
  soon: "Sắp quá hạn",
  breached: "Quá hạn",
};
/**
 * MÀU CỦA CHIP HẠN — CHỈ MÀU CHỮ, KHÔNG CÓ NỀN.
 *
 * Trạng thái xử lý (`CARE_STATUS_TONE`) và quyết định nghiệp vụ (`BUSINESS_ACTION_TONE`) là hai dải
 * NỀN ĐẶC trên từng dòng. Chip hạn là một BỘ ĐIỀU KHIỂN, không phải một nhãn của dòng — cho nó nền
 * đặc là dựng thêm một thứ trông hệt cái nhãn nhưng nói về chuyện khác. Viền + màu chữ giữ nó ở
 * đúng hạng mục của nó, và `tests/care-ui-contrast.test.ts` khoá điều đó lại.
 */
export const CARE_SLA_BUCKET_TONE: Record<CareSlaBucket, string> = {
  ok: "text-muted-foreground",
  soon: "text-amber-700 dark:text-amber-300",
  breached: "text-rose-700 dark:text-rose-300",
};

export const CARE_SLA_BUCKET_HINT: Record<CareSlaBucket, string> = {
  ok: "Còn thời gian, chưa tới vùng cảnh báo.",
  soon: `Đã dùng hết ${Math.round(CARE_SLA_SOON_FRACTION * 100)}% quỹ thời gian của cái hạn gần nhất còn sống — chưa vỡ, nhưng làm ngay thì còn kịp.`,
  breached: "Đã quá hạn phản hồi đầu hoặc quá hạn đóng ca.",
};

/**
 * GHÉP CHIỀU CARE VỚI LỊCH SỬ THÀNH MỘT ĐẦU VÀO CHO CÁC VỊ TỪ THUẦN.
 *
 * `CareState` (đợt care) và `CareHistory` (ba sổ chỉ-thêm) là hai nguồn khác nhau, nhưng ba vị từ
 * hạn xử lý cần cả hai. Ghép ở MỘT chỗ để không nơi nào quên truyền một nửa — quên `firstRoundAt`
 * thì `teamResponded` lặng lẽ lùi về cột cũ và bản vá "giao việc không phải phản hồi" biến mất mà
 * không ai thấy.
 *
 * `history` không có ⇒ CẢ HAI trường để `undefined`, tức là CHƯA ĐỌC ĐƯỢC ⇒ hành vi cũ. Không bao
 * giờ dịch nó thành `null` (= "đã đọc, không có lượt nào"), vì đó là một khẳng định (luật 42).
 */
export function careStateFor(c: Pick<CareCase, "care" | "history">): CareStateLike {
  const h = c.history;
  return h ? { ...c.care, firstRoundAt: h.firstRoundAt, carrierNewsAfterLastRound: h.carrierNewsAfterLastRound } : c.care;
}

/**
 * KIỆN ĐANG Ở ĐÂU TRONG QUỸ THỜI GIAN CỦA NÓ.
 *
 * "Quá hạn" lấy thẳng hai cờ mà `slaOf()` đã tính — không tính lại, vì tính lại là mở đường cho
 * màn hình nói khác con số "vỡ SLA" ở đầu trang.
 *
 * "Sắp quá hạn" chỉ xét những cái hạn CÒN SỐNG: hạn phản hồi đầu tắt khi đã có người chạm vào,
 * hạn đóng ca tắt khi ca đã đóng/escalate hoặc đang chờ với một cái hẹn còn ở phía trước (đội đã
 * làm phần mình — cùng luật tạm dừng với `slaOf`). Một ca đã đóng mà vẫn bị tô "sắp quá hạn" thì
 * người xem học cách bỏ qua màu, và cảnh báo mất tác dụng.
 */
export function careSlaBucket(c: Pick<CareCase, "queueSince" | "care" | "sla" | "history">, now: Date, hours: CareSlaHours = DEFAULT_CARE_SLA_HOURS): CareSlaBucket {
  if (c.sla.firstResponseBreached || c.sla.resolveBreached) return "breached";
  const care = careStateFor(c);
  const t = now.getTime();
  const since = c.queueSince.getTime();
  /*
    BA VỊ TỪ NÀY TỪNG ĐƯỢC CHÉP TAY Ở ĐÂY.

    `slaOf` kết luận "vỡ hạn", hàm này kết luận "sắp vỡ hạn" — hai câu về cùng một cái hạn của
    cùng một dòng. Bản trước mỗi bên tự viết lại `responded` và `paused`, nên bản vá 22/09/2026
    (thôi đếm cú bấm GIAO VIỆC là một lần phản hồi) sẽ chỉ tới được một trong hai nơi, và một ca
    hiện "bình thường" ngay cạnh con số nói nó đã quá hạn.
  */
  const responded = teamResponded(care, c.queueSince);
  const closed = CARE_TERMINAL_STATUSES.includes(care.status) || care.status === "ESCALATED" || teamWorkEnded(care);
  const paused = CARE_WAITING_STATUSES.includes(care.status) && followUpStillHolds(care, now);

  const live: number[] = [];
  if (!responded) live.push(hours.firstResponseHours);
  if (!closed && !paused) live.push(hours.resolveHours);
  if (!live.length) return "ok";
  // Vùng cảnh báo tỷ lệ THUẬN với chính cái hạn đang hiệu lực: chủ shop đổi hạn ở cấu hình thì
  // vùng cảnh báo đi theo, không có con số thứ hai phải nhớ sửa.
  return live.some((h) => t - since >= h * 3600_000 * CARE_SLA_SOON_FRACTION) ? "soon" : "ok";
}

/* ─────────────────────────── TIỀN COD TREO ─────────────────────────── */

/**
 * DẢI COD — MỐC CHIA ĐẶT VÀO KHE THẬT CỦA DỮ LIỆU, KHÔNG ĐẶT VÀO SỐ TRÒN CHO ĐẸP.
 *
 * Mốc chia ở đây là mốc TRÌNH BÀY (xếp việc theo tiền), KHÔNG phải ngưỡng nghiệp vụ kết luận đơn —
 * ngưỡng đó nằm ở `RETURN_RULE` và không được nhân bản ở chỗ này.
 *
 * Đo production 13/09/2026 trên 332 vận đơn đang đi (`PENDING`…`DELIVERY_FAILED`): chỉ có 22 mức
 * giá, và chúng đứng thành cụm rõ rệt — 0 (2 kiện) · 359K–470K (22) · 499K–524K (265, tức 80%) ·
 * 699K–999.999 (42) · 1.250.000 (1). Bản đầu tiên của bảng này chia 300K/600K theo trực giác: dải
 * "< 300K" RỖNG HOÀN TOÀN, còn 287/332 kiện dồn vào một dải — một bộ lọc chia 86% dữ liệu vào một
 * ô thì không lọc được gì, nó chỉ chiếm chỗ trên màn hình.
 *
 * Mốc hiện tại đặt vào khe: 500K (khe 470K→499K) và 600K (khe 524K→699K, khe rộng nhất). Kết quả
 * đo được: 2 · 98 · 189 · 42 · 1. Mix hàng đổi thì ĐO LẠI rồi sửa ở đây — đừng đoán, và đừng để
 * một dải rỗng nằm lại (màn hình giấu rổ 0 kiện, nên dải chết sẽ im lặng biến mất chứ không kêu).
 */
export const CARE_COD_BANDS = [
  { key: "0", label: "Không thu hộ", min: 0, max: 0 },
  { key: "lt500", label: "< 500K", min: 1, max: 499_999 },
  { key: "500-600", label: "500K – 600K", min: 500_000, max: 599_999 },
  { key: "600-1m", label: "600K – 1tr", min: 600_000, max: 999_999 },
  { key: "gte1m", label: "≥ 1tr", min: 1_000_000, max: Number.POSITIVE_INFINITY },
] as const;
export type CareCodBand = (typeof CARE_COD_BANDS)[number]["key"];
export const CARE_COD_BAND_KEYS = CARE_COD_BANDS.map((b) => b.key) as readonly CareCodBand[];

export function careCodBand(cod: number): CareCodBand {
  const b = CARE_COD_BANDS.find((x) => cod >= x.min && cod <= x.max);
  return b?.key ?? "0";
}

/* ─────────────────────────── SỐ LẦN PHÁT HỤT ─────────────────────────── */

/**
 * Số lần ĐVVC phát hụt — đọc từ chứng từ (`shipment_events` mã giao thất bại), không đọc câu chữ
 * trạng thái. Ba lần hụt là mốc thực tế: sau đó Viettel Post chuyển hoàn, nên "≥ 3" là một rổ
 * riêng chứ không phải đuôi của một thang liên tục.
 */
export const CARE_ATTEMPT_BANDS = [
  { key: "0", label: "Chưa hụt lần nào", min: 0, max: 0 },
  { key: "1", label: "Hụt 1 lần", min: 1, max: 1 },
  { key: "2", label: "Hụt 2 lần", min: 2, max: 2 },
  { key: "3plus", label: "Hụt ≥ 3 lần", min: 3, max: Number.POSITIVE_INFINITY },
] as const;
export type CareAttemptBand = (typeof CARE_ATTEMPT_BANDS)[number]["key"];
export const CARE_ATTEMPT_BAND_KEYS = CARE_ATTEMPT_BANDS.map((b) => b.key) as readonly CareAttemptBand[];

export function careAttemptBand(n: number): CareAttemptBand {
  const b = CARE_ATTEMPT_BANDS.find((x) => n >= x.min && n <= x.max);
  return b?.key ?? "0";
}

/* ─────────────────────────── SỐ LƯỢT ĐÃ XỬ LÝ ─────────────────────────── */

/**
 * "ĐÃ XỬ LÝ MẤY LẦN RỒI" — luật đếm sống ở `lib/constants/care-rounds.ts`; chỗ này chỉ NỐI nó vào
 * bộ lọc, để bàn care và báo cáo không có hai phép đếm.
 *
 * Kiện chưa đọc được lịch sử (`history` không có — một nơi gọi cũ của hợp đồng) rơi về 0 ở ĐÂY,
 * và đó là lựa chọn có chủ ý: `careRoundBand(0)` là rổ "Chưa xử lý lần nào", tức là rổ khiến người
 * ta MỞ RA XEM. Sai về phía bắt người nhìn lại thì tự sửa được; sai về phía xếp nó vào "đã xử lý 3
 * lượt" thì không ai đi kiểm lại.
 */
export function careRoundBandOf(c: Pick<CareCase, "history">): CareRoundBand {
  return careRoundBand(c.history?.rounds ?? 0);
}

/* ─────────────────────────── VỊ TỪ DÙNG CHUNG ─────────────────────────── */

/** Các chiều lọc. Mỗi khoá ứng với đúng một tham số trên URL, và đúng một chiều của `matchesExcept`. */
export type CareFilters = {
  /** Góc nhìn (Cần care / Chờ / Escalate / Đã xử lý) — luôn áp, không bao giờ bị `except` tắt. */
  view: CareCase["view"];
  q: string;
  /** `""` = mọi người · `"none"` = chưa ai nhận · còn lại = id người nhận. */
  owner: string;
  reason: string;
  substate: string;
  sla: CareSlaBucket | "";
  cod: CareCodBand | "";
  attempts: CareAttemptBand | "";
  /** Mã hàng / tên hàng — khớp một phần, không phân biệt hoa thường. */
  sku: string;
  /**
   * KẾT QUẢ XỬ LÝ người đã quyết. `""` = không lọc · `"none"` = CHƯA AI QUYẾT · còn lại là một
   * trong ba kết quả. `none` phải là một rổ riêng: đó là rổ mở đầu ca, và nếu nó lẫn vào "không
   * lọc" thì nó không tồn tại trên màn hình.
   */
  resolution: ResolutionFilterKey | "";
  /** Cái hẹn quay lại rơi vào rổ nào (quá hẹn · hôm nay · ngày mai · xa hơn · chưa hẹn). */
  followUp: FollowUpFilterKey | "";
  /**
   * ĐÃ XỬ LÝ MẤY LƯỢT — chiều RỜI HẲN khỏi `resolution` và `followUp`, cố ý.
   *
   * `resolution` nói đội đã QUYẾT gì (một trạng thái cuối cùng, ghi đè lẫn nhau); chiều này nói đội
   * đã LÀM BAO NHIÊU LẦN (một phép đếm, chỉ tăng). "Chưa quyết định" gộp chung một kiện chưa ai mở
   * ra với một kiện đã gọi khách hai lượt mà chưa chốt được — và đúng hai kiện đó là hai việc khác
   * hẳn nhau vào sáng hôm sau.
   */
  rounds: CareRoundBand | "";
} & /**
 * BỐN CHIỀU THỜI GIAN — giá trị THÔ y như trên URL (`YYYY-MM-DD..YYYY-MM-DD`, hở một đầu cũng
 * được, hoặc `none` cho nhóm chưa có mốc). Giải mã bằng `parseCareDateFilter`, sổ đăng ký ở
 * `lib/constants/care-dates.ts`.
 *
 * Giữ dạng CHUỖI ở đây, không giữ `Date` đã giải mã, vì `CareFilters` phải so sánh được bằng
 * `===` trong `useMemo` của trình duyệt: hai `Date` cùng giá trị là hai đối tượng khác nhau nên
 * bảng sẽ dựng lại mỗi lượt vẽ.
 */
Record<CareDateKey, string>;

const KHONG_LOC_NGAY = Object.fromEntries(CARE_DATE_KEYS.map((k) => [k, ""])) as Record<CareDateKey, string>;

export const EMPTY_CARE_FILTERS: Omit<CareFilters, "view"> = { q: "", owner: "", reason: "", substate: "", sla: "", cod: "", attempts: "", sku: "", resolution: "", followUp: "", rounds: "", ...KHONG_LOC_NGAY };

/**
 * ĐỆM GIẢI MÃ KHOẢNG NGÀY — vẫn là một hàm THUẦN, chỉ là không dựng lại cùng một `Date` vài nghìn
 * lần. `matchesCareFilters` chạy một lượt cho bảng và một lượt cho MỖI chiều chip, nên với hàng
 * đợi vài trăm kiện thì cùng một chuỗi `"2026-09-01..2026-09-20"` được giải mã hàng chục nghìn
 * lần. Khoá là chính chuỗi thô, nên đệm không bao giờ trả lời cho một câu hỏi khác.
 */
const DEM_NGAY = new Map<string, CareDateFilter | null>();
function locNgay(raw: string): CareDateFilter | null {
  if (DEM_NGAY.has(raw)) return DEM_NGAY.get(raw) ?? null;
  const f = parseCareDateFilter(raw);
  // Trần để một trình duyệt mở cả ngày không tích chuỗi rác: bộ lọc thực tế chỉ có vài giá trị sống.
  if (DEM_NGAY.size > 200) DEM_NGAY.clear();
  DEM_NGAY.set(raw, f);
  return f;
}

/** Các chiều có thể bị tắt khi đếm chip. `view` cố tình không nằm trong danh sách này. */
export type CareFilterDim = Exclude<keyof CareFilters, "view">;

function matchesTerm(c: CareCase, term: string): boolean {
  if (!term) return true;
  return [c.tracking, c.customer, c.phone, String(c.orderSystemId ?? "")].some((x) => x.toLowerCase().includes(term));
}

function matchesSku(c: CareCase, term: string): boolean {
  if (!term) return true;
  return c.products.some((p) => p.toLowerCase().includes(term));
}

/**
 * Một kiện có lọt qua bộ lọc không. `except` tắt ĐÚNG MỘT chiều — dùng để đếm chip của chính chiều đó.
 */
export function matchesCareFilters(c: CareCase, f: CareFilters, now: Date, hours: CareSlaHours = DEFAULT_CARE_SLA_HOURS, except?: CareFilterDim): boolean {
  if (c.view !== f.view) return false;
  const on = (dim: CareFilterDim) => except !== dim;
  if (on("owner") && f.owner && (f.owner === "none" ? Boolean(c.care.owner) : c.care.owner?.id !== f.owner)) return false;
  if (on("reason") && f.reason && c.reason !== f.reason) return false;
  if (on("substate") && f.substate && c.carrier.substate !== f.substate) return false;
  if (on("sla") && f.sla && careSlaBucket(c, now, hours) !== f.sla) return false;
  if (on("cod") && f.cod && careCodBand(c.codAmount) !== f.cod) return false;
  if (on("attempts") && f.attempts && careAttemptBand(c.carrier.failedAttempts) !== f.attempts) return false;
  /*
    KẾT QUẢ XỬ LÝ và CÁI HẸN là hai chiều RỜI NHAU, cố ý.

    "Xử lý sau hẹn tuần sau" và "Xử lý sau quá hẹn từ hôm qua" mang cùng một kết quả nhưng là hai
    việc khác hẳn: một cái chưa tới lượt, một cái đang trễ. Gộp hai chiều vào một bộ lọc thì rổ nào
    cũng trộn cả hai, và người trực lại phải đọc từng dòng — đúng thứ bộ lọc sinh ra để khỏi phải làm.
  */
  if (on("resolution") && f.resolution) {
    const r = c.care.lastDecision?.decision ?? null;
    if (f.resolution === "none" ? r !== null : r !== f.resolution) return false;
  }
  if (on("followUp") && f.followUp && followUpBucket(c.care.followUpAt, now) !== f.followUp) return false;
  if (on("rounds") && f.rounds && careRoundBandOf(c) !== f.rounds) return false;
  if (on("sku") && !matchesSku(c, f.sku.trim().toLowerCase())) return false;
  if (on("q") && !matchesTerm(c, f.q.trim().toLowerCase())) return false;
  /*
    BỐN MỐC THỜI GIAN, BỐN CHIỀU RỜI NHAU.

    Cố ý KHÔNG gộp hai mốc Viettel Post ("đổi trạng thái" và "tin cuối") thành một ô: một kiện có
    thể vừa có tin sáng nay vừa đứng nguyên một chỗ mười một ngày, và đúng nhóm đó là nhóm đắt
    tiền nhất (AGENTS.md mục 54). Lý lẽ đầy đủ ở `lib/constants/care-dates.ts`.

    Kiện chưa có mốc KHÔNG lọt qua một bộ lọc khoảng ngày — chưa biết thì chưa nằm trong khoảng
    nào. Màn hình đếm riêng nhóm ấy và cho bấm thẳng vào (`CARE_DATE_UNKNOWN`), thay vì để nó im
    lặng biến mất.
  */
  for (const k of CARE_DATE_KEYS) {
    if (!on(k)) continue;
    if (!matchesCareDate(c.dates?.[k] ?? null, locNgay(f[k]))) return false;
  }
  return true;
}

/**
 * Đếm theo một chiều trên tập đã áp MỌI chiều khác — con số trên chip bằng đúng số dòng sẽ hiện ra
 * khi bấm chip ấy. Rổ có 0 kiện không xuất hiện: một chip bấm vào ra bảng rỗng là một cái bẫy.
 */
export function careFacet<K extends string>(cases: CareCase[], f: CareFilters, dim: CareFilterDim, keyOf: (c: CareCase) => K, now: Date, hours: CareSlaHours = DEFAULT_CARE_SLA_HOURS): [K, number][] {
  const m = new Map<K, number>();
  for (const c of cases) if (matchesCareFilters(c, f, now, hours, dim)) m.set(keyOf(c), (m.get(keyOf(c)) ?? 0) + 1);
  return [...m.entries()];
}

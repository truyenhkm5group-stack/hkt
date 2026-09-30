import { boDau } from "@/lib/constants/return-reason";
import type { CreativeVerdict, SlotMode, VariantStatus } from "@/lib/constants/creative-loop";
import type { PeriodKey } from "@/lib/search-params";

/**
 * ═══════════ BẢNG ĐIỀU KHIỂN "④ ĐANG CHẠY" — HÀM THUẦN ═══════════
 *
 * Chủ shop 30/09/2026: "làm lại UI/UX cho dễ quản lý hơn, cần tên campaign sync với trình quản lý quảng cáo, bộ
 * lọc ngày tháng, tìm kiếm". Tệp này giữ mọi phép tính KHÔNG đọc CSDL của bảng — trạng thái camp, tên hiển thị,
 * lọc, tìm, sắp xếp, tổng hợp, link Ads Manager — để máy chủ, API xuất CSV và bài kiểm dùng CÙNG một luật.
 *
 * Ba điều phải giữ:
 *  1. TÊN lấy từ Facebook trước. `fb_ads` được lượt đồng bộ chi tiêu ghi lại MỖI LẦN thấy mẩu (tên mẩu · tên
 *     chiến dịch · nhóm), nên người đổi tên trên Trình quản lý quảng cáo thì bảng đổi theo ở lượt đồng bộ kế
 *     tiếp. Chưa thấy trên Facebook (camp chưa tiêu đồng nào) ⇒ tên ERP đặt lúc đăng, và NÓI RA là tên ERP.
 *  2. Bộ lọc kỳ chỉ đổi SỐ ĐO HIỂN THỊ. Phán quyết luôn chấm trên số đo TOÀN ĐỜI camp (cùng số mà luật tắt đã
 *     được duyệt đọc) — bộ lọc của người xem không được quyết thay luật.
 *  3. CHƯA BIẾT không phải 0 (mục 42): sắp xếp đẩy ô `null` xuống CUỐI ở cả hai chiều, tổng chỉ cộng ô có số và
 *     trả `null` khi không ô nào có số.
 */

/** Trạng thái camp như người quản lý nói — tách "chờ tới giờ" khỏi "đang chạy" (camp hẹn giờ đã lên Facebook). */
export const LIVE_STATES = ["RUNNING", "SCHEDULED", "PAUSED", "ENDED"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const LIVE_STATE_LABEL: Record<LiveState, string> = {
  RUNNING: "Đang chạy",
  SCHEDULED: "Chờ tới giờ",
  PAUSED: "Đã tắt",
  ENDED: "Hết khung test",
};

export function liveStateOf(status: VariantStatus, startAt: string, now: Date): LiveState {
  if (status === "LIVE") return new Date(startAt).getTime() > now.getTime() ? "SCHEDULED" : "RUNNING";
  return status === "PAUSED" ? "PAUSED" : "ENDED";
}

/** Tham số URL của bảng — khoá ngắn, không dấu (cùng kiểu `tt` của các trang khác). */
export const LIVE_BOARD_PARAMS = { state: "tt", verdict: "pq", product: "sp", mode: "kieu" } as const;

export const LIVE_BOARD_DEFAULT_PERIOD: PeriodKey = "7d";
export const LIVE_BOARD_PAGE_SIZE = 50;

/** Khoá sắp xếp = `id` cột của bảng (DataTable gửi đúng khoá này lên URL). */
export const LIVE_SORTABLE = ["start", "spend", "impressions", "messages", "orders", "costPerOrder"] as const;
export type LiveSortKey = (typeof LIVE_SORTABLE)[number];
export const LIVE_DEFAULT_SORT: LiveSortKey = "start";

/** Mọi khoá URL mà bảng đọc — thanh tab xoá hết khi chuyển tab, nút "Xoá lọc" xoá phần lọc. */
export const LIVE_BOARD_URL_KEYS = ["q", "period", "from", "to", "sort", "dir", "page", "pageSize", ...Object.values(LIVE_BOARD_PARAMS)] as const;

// ───────────────────────────── TÊN ─────────────────────────────

export type LiveNames = {
  campaign: string;
  adset: string;
  ad: string;
  /** `FACEBOOK` = tên đọc từ lượt đồng bộ gần nhất · `ERP` = tên ERP đặt lúc đăng (Facebook chưa báo về). */
  source: "FACEBOOK" | "ERP";
  /** Tên chiến dịch trên Facebook KHÁC tên ERP đặt lúc đăng — ai đó đã đổi tên trên Trình quản lý. */
  renamed: boolean;
  /** Tên ERP đặt lúc đăng — để hiện khi `renamed`. */
  erpCampaign: string;
  /** Lần cuối lượt đồng bộ ghi tên (ISO). `null` khi `source = ERP`. */
  syncedAt: string | null;
};

export type FbNameSnapshot = { campaign: string; adset: string; ad: string; syncedAt: string | null };

/** Ghép tên: từng trường lấy Facebook nếu Facebook có chữ, không thì ERP. Rỗng cả hai ⇒ chuỗi rỗng (màn hình in "—"). */
export function resolveLiveNames(fb: FbNameSnapshot | null, erp: { campaign: string; adset: string; ad: string }): LiveNames {
  const pick = (a: string | undefined, b: string) => (a ?? "").trim() || b.trim();
  const fromFb = !!fb && !!(fb.campaign.trim() || fb.ad.trim() || fb.adset.trim());
  const erpCampaign = erp.campaign.trim();
  const fbCampaign = (fb?.campaign ?? "").trim();
  return {
    campaign: pick(fb?.campaign, erp.campaign),
    adset: pick(fb?.adset, erp.adset),
    ad: pick(fb?.ad, erp.ad),
    source: fromFb ? "FACEBOOK" : "ERP",
    renamed: !!fbCampaign && !!erpCampaign && fbCampaign !== erpCampaign,
    erpCampaign,
    syncedAt: fromFb ? (fb?.syncedAt ?? null) : null,
  };
}

// ───────────────────────────── LINK TRÌNH QUẢN LÝ QUẢNG CÁO ─────────────────────────────

/**
 * Link mở ĐÚNG đối tượng trên Ads Manager: chiến dịch riêng của bài nếu có, không thì mẩu quảng cáo (lô cũ đăng
 * vào chiến dịch test chung — mở chiến dịch chung là bắt người tìm lại mẩu giữa hàng chục mẩu khác). Không có
 * TKQC hoặc không có id nào ⇒ `null`, màn hình không vẽ link (link thiếu `act` mở nhầm tài khoản mặc định).
 */
export function adsManagerUrl(x: { adAccountId: string | null; fbCampaignId: string | null; fbAdId: string | null }): string | null {
  const act = (x.adAccountId ?? "").replace(/^act_/, "").trim();
  if (!act) return null;
  const base = "https://adsmanager.facebook.com/adsmanager/manage";
  if (x.fbCampaignId) return `${base}/campaigns?act=${encodeURIComponent(act)}&selected_campaign_ids=${encodeURIComponent(x.fbCampaignId)}`;
  if (x.fbAdId) return `${base}/ads?act=${encodeURIComponent(act)}&selected_ad_ids=${encodeURIComponent(x.fbAdId)}`;
  return null;
}

// ───────────────────────────── DÒNG CỦA BẢNG ─────────────────────────────

export type LiveKeepCheck = { text: string; pass: boolean | null; value: number | null };

/** Một camp — chỉ chuỗi / số / boolean, đi qua ranh giới máy chủ → trình duyệt được. */
export type LiveBoardRow = {
  id: string;
  batchId: string;
  slot: number;
  headline: string;
  imageId: string | null;
  imageAvailable: boolean;
  productId: string | null;
  /** "mã · tên" — `null` = mẫu không gắn mã. */
  productLabel: string | null;
  mode: SlotMode;
  status: VariantStatus;
  state: LiveState;
  batchDay: string;
  startAt: string;
  endAt: string;
  pausedAt: string | null;
  pauseReason: string;
  dailyBudget: boolean;
  committedBudgetVnd: number | null;
  names: LiveNames;
  fbCampaignId: string | null;
  fbAdsetId: string | null;
  fbAdId: string | null;
  adAccountId: string | null;
  adsManagerUrl: string | null;
  /* ── Số đo TRONG KỲ đang lọc ── */
  spendVnd: number | null;
  impressions: number | null;
  clicks: number | null;
  messages: number | null;
  /** `null` = camp chưa có mẩu QC (không đếm được) — khác 0 đơn thật. */
  bookedOrders: number | null;
  deliveredOrders: number | null;
  returnedOrders: number | null;
  ordersDirect: number;
  ordersViaPost: number;
  bookedRevenueVnd: number | null;
  cpm: number | null;
  ctr: number | null;
  cpc: number | null;
  costPerMessage: number | null;
  costPerOrder: number | null;
  /** Ngày VN gần nhất có dòng chi (trong kỳ). */
  lastSpendDate: string | null;
  /* ── Phán quyết: số đo TOÀN ĐỜI ── */
  verdict: CreativeVerdict;
  reasons: string[];
  keepChecks: LiveKeepCheck[];
  lifetimeSpendVnd: number | null;
  lifetimeOrders: number;
};

// ───────────────────────────── LỌC · TÌM · SẮP XẾP ─────────────────────────────

export type LiveBoardFilter = { q: string; states: string[]; verdicts: string[]; products: string[]; modes: string[] };

/** Chuỗi để tìm: tên Facebook + tên ERP (đổi tên rồi vẫn tìm được bằng tên cũ) · tiêu đề · mã / tên SP · mọi id. */
export function liveSearchText(r: LiveBoardRow): string {
  return boDau(
    [r.names.campaign, r.names.adset, r.names.ad, r.names.erpCampaign, r.headline, r.productLabel ?? "", r.productId ?? "", r.fbCampaignId ?? "", r.fbAdsetId ?? "", r.fbAdId ?? "", `#${r.slot}`].join(" \u0001 "),
  );
}

/** Mọi từ khoá (cách nhau bởi dấu cách) đều phải có mặt — "dam q005" khớp "Đầm … Q005". Không dấu, không phân biệt hoa thường. */
export function matchesLiveQuery(r: LiveBoardRow, q: string): boolean {
  const words = boDau(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = liveSearchText(r);
  return words.every((w) => text.includes(w));
}

export function filterLiveRows(rows: LiveBoardRow[], f: LiveBoardFilter): LiveBoardRow[] {
  const inSet = (list: string[], v: string) => list.length === 0 || list.includes(v);
  return rows.filter((r) => inSet(f.states, r.state) && inSet(f.verdicts, r.verdict) && inSet(f.products, r.productId ?? "") && inSet(f.modes, r.mode) && matchesLiveQuery(r, f.q));
}

function sortValue(r: LiveBoardRow, key: LiveSortKey): number | null {
  switch (key) {
    case "start":
      return new Date(r.startAt).getTime();
    case "spend":
      return r.spendVnd;
    case "impressions":
      return r.impressions;
    case "messages":
      return r.messages;
    case "orders":
      return r.bookedOrders;
    case "costPerOrder":
      return r.costPerOrder;
  }
}

/** Ô CHƯA BIẾT xuống cuối ở CẢ HAI chiều — "chi/đơn thấp nhất" không được mở đầu bằng camp chưa có đơn nào. Hoà ⇒ mới đăng trước. */
export function sortLiveRows(rows: LiveBoardRow[], sort: string, dir: "asc" | "desc"): LiveBoardRow[] {
  const key: LiveSortKey = (LIVE_SORTABLE as readonly string[]).includes(sort) ? (sort as LiveSortKey) : LIVE_DEFAULT_SORT;
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return sign * (va - vb);
    const t = new Date(b.startAt).getTime() - new Date(a.startAt).getTime();
    return t !== 0 ? t : a.slot - b.slot;
  });
}

// ───────────────────────────── TỔNG HỢP ─────────────────────────────

export type LiveBoardSummary = {
  total: number;
  running: number;
  scheduled: number;
  /** Tổng chi TRONG KỲ của các camp có số chi; `null` khi không camp nào có. */
  spendVnd: number | null;
  messages: number | null;
  bookedOrders: number | null;
  bookedRevenueVnd: number | null;
  /** Chi / đơn của CẢ TẬP — tỷ số của hai tổng, không phải trung bình các tỷ số. `null` khi 0 đơn hoặc chi chưa biết. */
  costPerOrder: number | null;
  costPerMessage: number | null;
  promising: number;
  win: number;
  killed: number;
  /** Đang test · chờ đơn · chưa chạy · chưa kết luận được — chưa kết luận, không tô màu. */
  undecided: number;
};

export const UNDECIDED_VERDICTS: readonly CreativeVerdict[] = ["RUNNING", "AWAITING_ORDERS", "UNJUDGED", "PENDING"];

export function summarizeLive(rows: LiveBoardRow[]): LiveBoardSummary {
  const sumOf = (pick: (r: LiveBoardRow) => number | null) => rows.reduce<number | null>((s, r) => (pick(r) === null ? s : (s ?? 0) + (pick(r) as number)), null);
  const spend = sumOf((r) => r.spendVnd);
  const messages = sumOf((r) => r.messages);
  const orders = sumOf((r) => r.bookedOrders);
  // Tỷ số chỉ trên các camp có CẢ HAI vế — cộng chi của camp chưa đếm được đơn vào tử số là thổi phồng chi/đơn.
  const both = (num: (r: LiveBoardRow) => number | null, den: (r: LiveBoardRow) => number | null) => {
    const ok = rows.filter((r) => num(r) !== null && den(r) !== null);
    const n = ok.reduce((s, r) => s + (num(r) as number), 0);
    const d = ok.reduce((s, r) => s + (den(r) as number), 0);
    return ok.length === 0 || d === 0 ? null : Math.round(n / d);
  };
  return {
    total: rows.length,
    running: rows.filter((r) => r.state === "RUNNING").length,
    scheduled: rows.filter((r) => r.state === "SCHEDULED").length,
    spendVnd: spend,
    messages,
    bookedOrders: orders,
    bookedRevenueVnd: sumOf((r) => r.bookedRevenueVnd),
    costPerOrder: both((r) => r.spendVnd, (r) => r.bookedOrders),
    costPerMessage: both((r) => r.spendVnd, (r) => r.messages),
    promising: rows.filter((r) => r.verdict === "PROMISING").length,
    win: rows.filter((r) => r.verdict === "WIN").length,
    killed: rows.filter((r) => r.verdict === "KILL").length,
    undecided: rows.filter((r) => UNDECIDED_VERDICTS.includes(r.verdict)).length,
  };
}

// ───────────────────────────── CSV ─────────────────────────────

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV đúng tập đang lọc. Ô CHƯA BIẾT để TRỐNG, không ghi 0 (mục 42). */
export function liveRowsToCsv(rows: LiveBoardRow[], labels: { verdict: Record<CreativeVerdict, string> }): string {
  const header = [
    "Chiến dịch (Facebook)",
    "Nhóm quảng cáo",
    "Quảng cáo",
    "Tên ERP lúc đăng",
    "Nguồn tên",
    "ID chiến dịch",
    "ID quảng cáo",
    "Sản phẩm",
    "Tiêu đề",
    "Trạng thái",
    "Bắt đầu",
    "Chi (kỳ)",
    "Hiển thị",
    "Nhấp",
    "CTR %",
    "CPC",
    "Tin nhắn",
    "Chi/tin",
    "Đơn chốt",
    "Giao TC",
    "Hoàn",
    "Chi/đơn",
    "DT lên đơn",
    "Phán quyết (toàn đời)",
    "Lý do",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.names.campaign,
        r.names.adset,
        r.names.ad,
        r.names.erpCampaign,
        r.names.source === "FACEBOOK" ? "Facebook" : "ERP",
        r.fbCampaignId ?? "",
        r.fbAdId ?? "",
        r.productLabel ?? "",
        r.headline,
        LIVE_STATE_LABEL[r.state],
        r.startAt,
        r.spendVnd,
        r.impressions,
        r.clicks,
        r.ctr === null ? null : r.ctr.toFixed(2),
        r.cpc === null ? null : Math.round(r.cpc),
        r.messages,
        r.costPerMessage === null ? null : Math.round(r.costPerMessage),
        r.bookedOrders,
        r.deliveredOrders,
        r.returnedOrders,
        r.costPerOrder,
        r.bookedRevenueVnd,
        labels.verdict[r.verdict],
        r.reasons.join(" "),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

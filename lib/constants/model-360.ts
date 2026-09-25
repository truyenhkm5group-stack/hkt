import { ADS_ACTION_LABEL, type AdsAction } from "@/lib/constants/ads-decision";
import { DECISION_LABEL, type InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import { MODEL_STATE_LABELS, type ModelState } from "@/lib/constants/model-lifecycle";
import { MODEL_SIGNAL_LABEL, type ModelSignal, type SignalReason, type SignalSource } from "@/lib/constants/model-signal";
import { BEFORE_PRODUCTION_DISCUSSION_STATES, topicOpeningMode, type WinnerFollowUp } from "@/lib/constants/early-topic";
import { formatNumber, formatVND, MISSING_TEXT } from "@/lib/format";

/**
 * ═══════════ TRANG MODEL 360 — PHẦN THUẦN (Company OS · A2) ═══════════
 *
 * Mọi thứ ở đây không đọc CSDL và không đọc đồng hồ, để kiểm thử được mà không dựng trang:
 *
 *  · `loadSource` — mỗi khối của trang đọc nguồn của nó qua đây. Nguồn NÉM LỖI thì khối in "Không đọc
 *    được nguồn X" thay vì làm sập cả trang (một nguồn chậm / hỏng không được giữ cả trang làm con tin).
 *  · `deriveModelSuggestions` — khối "Đề xuất": CHỈ dựng từ quyết định ĐÃ CÓ của các bộ máy (quảng cáo,
 *    tồn kho, tín hiệu mẫu). Không có quyết định ⇒ không có đề xuất; thiếu dữ liệu ⇒ không có đề xuất.
 *    Mọi đề xuất là HIỂN THỊ — người bấm, không có gì tự áp (luật 23, target-architecture Q9).
 *  · `MODEL_360_PENDING_SOURCES` — ĐIỂM NỐI DUY NHẤT cho hàm đọc còn chờ (hôm nay rỗng).
 */

// ─────────────────────────── NGUỒN ĐỌC KHÔNG LÀM SẬP TRANG ───────────────────────────

export type Loaded<T> = { ok: true; data: T } | { ok: false; source: string; error: string };

/**
 * Đọc một nguồn; lỗi thì trả `{ ok: false }` kèm tên nguồn và câu lỗi. KHÔNG nuốt lỗi thành "không có
 * dữ liệu" — khối in đúng câu "Không đọc được nguồn …", khác hẳn "Chưa có dữ liệu".
 */
export async function loadSource<T>(source: string, fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, source, error: e instanceof Error ? e.message : String(e) };
  }
}

export function sourceFailedText(l: { ok: false; source: string }): string {
  return `Không đọc được nguồn ${l.source}`;
}

// ─────────────────────────── IN SỐ: CHƯA BIẾT ≠ 0 (luật 42) ───────────────────────────

/** Đếm: `null` ⇒ "—" (chưa biết); 0 thật ⇒ "0". */
export function countText(n: number | null | undefined): string {
  return formatNumber(n);
}

/** Tiền: `null` ⇒ "—"; 0 thật ⇒ "0 ₫". */
export function moneyText(n: number | null | undefined): string {
  return formatVND(n);
}

/** Tỷ lệ phần trăm đã ở thang 0–100: `null` ⇒ "—". */
export function pctText(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? MISSING_TEXT : `${n.toFixed(digits)}%`;
}

/** Hệ số (ROAS): `null` ⇒ "—". */
export function ratioText(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? MISSING_TEXT : `${n.toFixed(2)}×`;
}

// ─────────────────────────── QUYỀN THEO NGUỒN ───────────────────────────

/**
 * Mỗi nguồn của trang đọc được khi người xem có ĐÚNG quyền của MÀN HÌNH CHỦ nguồn đó — trang 360 không
 * được là cửa sau để người chỉ có "Vòng đời mẫu: xem" đọc lợi nhuận hay chi quảng cáo (luật 28–30).
 * `resource` là khoá sổ phạm vi (`data-scope-policy.ts`) của màn hình chủ, nếu nó có.
 */
export const MODEL_360_BLOCK_ACCESS = {
  ADS: { permission: "expenses:view", resource: "ADS", home: "/ads" },
  CREATIVE: { permission: "ideas:view", resource: null, home: "/marketing/creatives" },
  ORDERS: { permission: "reports:returns", resource: "REPORTS", home: "/products/performance" },
  STOCK: { permission: "products:view", resource: null, home: "/products" },
  ECONOMICS: { permission: "reports:nominal", resource: "REPORTS", home: "/reports?tab=nominal" },
  INVENTORY: { permission: "planning:view", resource: null, home: "/inventory/decisions" },
  PRODUCTION: { permission: "planning:view", resource: null, home: "/production" },
  RETURNS: { permission: "products:view", resource: "RETURNS", home: "/inventory/returns#hang-khong-tai-nhap" },
} as const;

export type Model360Block = keyof typeof MODEL_360_BLOCK_ACCESS;

/** Nguồn của tín hiệu ⇒ khối có quyền tương ứng (để che chi tiết lý do người xem không được đọc). */
export const SIGNAL_SOURCE_BLOCK: Record<SignalSource, Model360Block> = {
  ADS: "ADS",
  PRODUCT: "ORDERS",
  CREATIVE: "CREATIVE",
  DESIGN: "CREATIVE",
  INVENTORY: "INVENTORY",
};

/**
 * Lý do của tín hiệu mà người xem KHÔNG có quyền đọc nguồn: giữ nhãn phán quyết (không phải con số),
 * che câu chi tiết (có thể chứa biên lợi nhuận, chi QC).
 */
export function redactSignalReasons(reasons: readonly SignalReason[], allowed: (b: Model360Block) => boolean): SignalReason[] {
  return reasons.map((r) => (allowed(SIGNAL_SOURCE_BLOCK[r.source]) ? r : { ...r, detail: `Cần quyền xem ${MODEL_360_BLOCK_ACCESS[SIGNAL_SOURCE_BLOCK[r.source]].home} để đọc chi tiết.` }));
}

// ─────────────────────────── ĐIỂM NỐI CHO HÀM ĐỌC CHƯA CÓ ───────────────────────────

/**
 * ═══ ĐIỂM NỐI DUY NHẤT cho hàm đọc theo hợp đồng chung §6 mà trang còn CHỜ ═══
 *
 * Trang KHÔNG dựng thay thế cho một hàm chưa có (một bản "gần giống" là công thức thứ hai). Hàm nào còn
 * chờ thì khai ở đây; khi hàm có thật: gỡ dòng và gọi hàm qua `loadSource` trong khối `block` của
 * `app/(dashboard)/models/[id]/blocks.tsx`. `tests/company-os-model-360.test.ts` đỏ khi hàm đã được export
 * mà dòng vẫn còn — danh sách chờ phải nói thật.
 *
 * Hôm nay RỖNG: `getModelProductionSummary` (C) đã nối vào khối Sản xuất, `getModelReturnDispositions` (E)
 * vào khối Kết cục hàng hoàn.
 */
export type PendingSource = { fn: string; owner: string; block: Model360Block; what: string };
export const MODEL_360_PENDING_SOURCES: readonly PendingSource[] = [];

// ─────────────────────────── ĐỀ XUẤT ───────────────────────────

export type SuggestionLink = { label: string; href: string };

export type ModelSuggestion = {
  key: string;
  /** Nguồn quyết định sinh ra đề xuất — để che theo quyền và để người đọc truy về. */
  source: Model360Block | "SIGNAL";
  what: string;
  why: string;
  data: string;
  links: SuggestionLink[];
  /** Đề xuất chuyển trạng thái vòng đời — NGƯỜI bấm, lý do điền sẵn và sửa được. */
  transition: { to: ModelState; reason: string } | null;
  /** Lưu ý đi kèm (ví dụ cổng dữ liệu của trang quyết định tồn đang "chưa đủ"). */
  caveat: string | null;
};

export type SuggestionInventoryRow = {
  label: string;
  decision: InventoryDecisionKind;
  /** Số nên đặt SAU khi trừ hàng đã đặt xưởng (`suggestedNetOfOpenPo`); `null` = không tính được. */
  suggestedQty: number | null;
  capitalRequired: number | null;
  excessQty: number;
  capitalFreeable: number | null;
};

export type SuggestionInput = {
  modelId: string;
  declaredState: ModelState | null;
  signal: { signal: ModelSignal; summary: string } | null;
  /** `null` = nguồn không có / không đọc được ⇒ không đề xuất gì về quảng cáo. */
  ads: { status: "OK" | "NO_ROW" | "SPEND_UNMAPPED"; action: AdsAction | null; reason: string; spend: number | null; cpo: number | null; profitAfterAds: number | null } | null;
  inventory: { rows: SuggestionInventoryRow[]; dataGate: "BETA" | "DATA_INSUFFICIENT" } | null;
  /** Link tạo creative mới / thư viện creative của mẫu (nếu có sản phẩm). */
  creativeHref: string | null;
  /**
   * Topic sản xuất của mẫu (Agent C · `getModelProductionSummary`). `null` = không đọc được / người xem
   * không có quyền xem sản xuất ⇒ CHƯA BIẾT có topic hay chưa.
   */
  production: {
    /**
     * Số topic mang nghĩa "đường sản xuất đã có" (`countTopicsBlockingSuggestion` — mọi trạng thái trừ Đã
     * đóng, kể cả Đã chốt phương án; lib/constants/production-os.ts, Agent K). > 0 ⇒ không đề xuất mở topic.
     */
    trackTopics: number;
    /**
     * Sản xuất đã đi tới đâu (`winnerFollowUp` — lib/constants/early-topic.ts, Agent T). Mẫu ĐÃ KHAI THẮNG mà
     * sản xuất đi trước (topic mở sớm, giá thành, mẫu thử…) ⇒ đề xuất chuyển tiếp tới đúng chỗ đó thay cho
     * "mở trao đổi sản xuất". Không truyền / `null` = sản xuất chưa bắt đầu.
     */
    winnerFollowUp?: WinnerFollowUp | null;
  } | null;
  /** Người xem có `production:write` ⇒ đề xuất kèm link "Tạo topic sản xuất". */
  canCreateTopic: boolean;
  periodQuery: string;
};

/** Trạng thái khai mà ở đó "mở trao đổi sản xuất" là bước còn phía trước (một bản — lib/constants/early-topic.ts). */
export const BEFORE_PRODUCTION_DISCUSSION: readonly (ModelState | null)[] = BEFORE_PRODUCTION_DISCUSSION_STATES;

const sum = (xs: (number | null)[]): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));

/**
 * Dựng danh sách đề xuất. Hàm THUẦN. Mỗi đề xuất có ĐÚNG MỘT quyết định gốc; không có quyết định (hoặc
 * quyết định là "chưa đủ dữ liệu") thì không có đề xuất — trống là trống, không bịa việc.
 */
export function deriveModelSuggestions(i: SuggestionInput): ModelSuggestion[] {
  const out: ModelSuggestion[] = [];
  const adsHref = `/ads?dim=product${i.periodQuery ? `&${i.periodQuery}` : ""}`;

  // ── 1. Quảng cáo: chỉ khi số chi ĐÃ ghép (status OK) và bảng quyết định đã kết luận SCALE / CUT ──
  if (i.ads && i.ads.status === "OK" && (i.ads.action === "SCALE" || i.ads.action === "CUT")) {
    const scale = i.ads.action === "SCALE";
    out.push({
      key: `ads-${i.ads.action}`,
      source: "ADS",
      what: scale ? "Tăng ngân sách quảng cáo của mẫu" : "Cắt hoặc làm lại quảng cáo của mẫu",
      why: `Bảng quyết định /ads (chiều mã hàng) kết luận "${ADS_ACTION_LABEL[i.ads.action]}": ${i.ads.reason}`,
      data: `Chi ${formatVND(i.ads.spend)} · CPO ${formatVND(i.ads.cpo)} · LN góp sau QC ${formatVND(i.ads.profitAfterAds)}`,
      links: [{ label: "Mở bảng quyết định quảng cáo", href: adsHref }],
      transition: null,
      caveat: null,
    });
  }

  // ── 2. Tồn kho: đặt thêm (số ĐÃ trừ hàng đặt xưởng) · xả / đẩy tồn ──
  if (i.inventory) {
    const caveat = i.inventory.dataGate === "DATA_INSUFFICIENT" ? "Trang quyết định tồn đang tự xưng DỮ LIỆU CHƯA ĐỦ — chỉ tham khảo, đối chiếu kế hoạch trước khi đặt." : null;
    const reorder = i.inventory.rows.filter((r) => r.decision === "REORDER" || r.decision === "STOCKOUT_RISK");
    if (reorder.length) {
      const qty = sum(reorder.map((r) => r.suggestedQty));
      const capital = sum(reorder.map((r) => r.capitalRequired));
      const risk = reorder.some((r) => r.decision === "STOCKOUT_RISK");
      out.push({
        key: "inventory-reorder",
        source: "INVENTORY",
        what: risk ? "Đặt sản xuất thêm — có mẫu mã nguy cơ hết hàng" : "Đặt sản xuất thêm trong đợt chốt gần nhất",
        why: `Bộ máy quyết định tồn: ${reorder.map((r) => `${r.label} — ${DECISION_LABEL[r.decision]}`).join(" · ")}`,
        data: `Nên đặt thêm ${countText(qty)} sản phẩm (đã trừ hàng đã đặt xưởng chưa nhận) · vốn cần ${formatVND(capital, { missing: "chưa biết giá nhập" })}`,
        links: [
          { label: "Lập đơn đặt xưởng", href: "/inventory/planning/orders" },
          { label: "Xem quyết định tồn", href: "/inventory/decisions" },
        ],
        transition: null,
        caveat,
      });
    }
    const clear = i.inventory.rows.filter((r) => r.decision === "OVERSTOCK" || r.decision === "CLEARANCE_CANDIDATE");
    if (clear.length) {
      const excess = clear.reduce((a, r) => a + r.excessQty, 0);
      const freeable = sum(clear.map((r) => r.capitalFreeable));
      const links: SuggestionLink[] = [{ label: "Đẩy tồn qua chăm sóc khách cũ", href: "/outreach" }];
      if (i.creativeHref) links.push({ label: "Tạo creative mới cho mẫu", href: i.creativeHref });
      out.push({
        key: "inventory-clear",
        source: "INVENTORY",
        what: clear.some((r) => r.decision === "CLEARANCE_CANDIDATE") ? "Xả tồn / cân nhắc dừng mẫu mã chậm" : "Đẩy bán phần tồn đang chôn vốn",
        why: `Bộ máy quyết định tồn: ${clear.map((r) => `${r.label} — ${DECISION_LABEL[r.decision]}`).join(" · ")}`,
        data: `Vượt mức lành mạnh ${countText(excess)} sản phẩm · vốn giải phóng được ${formatVND(freeable, { missing: "chưa biết giá nhập" })}`,
        links,
        transition: null,
        caveat,
      });
    }
  }

  // ── 3. Mở topic sản xuất ──
  //    · Đã KHAI THẮNG mà sản xuất đi trước (topic mở sớm, giá thành, mẫu thử…) ⇒ đề xuất CHUYỂN TIẾP vòng
  //      đời tới đúng chỗ sản xuất đang đứng (Agent T) — thay cho "mở trao đổi", việc đó đã xảy ra rồi.
  //    · Tín hiệu THẮNG, vòng đời chưa tới bước trao đổi sản xuất ⇒ đề xuất mở trao đổi + CHUYỂN trạng thái.
  //    · Tín hiệu TRIỂN VỌNG (chỉ số tốt, chưa thắng — quy tắc chủ shop 25/09/2026) ⇒ đề xuất mở topic SỚM,
  //      luồng song song: KHÔNG kèm chuyển vòng đời (mẫu vẫn đang test quảng cáo).
  //    Đã có đường sản xuất (topic chưa đóng, KỂ CẢ đã chốt phương án — `TOPIC_BLOCKS_NEW_SUGGESTION`) ⇒ không
  //    đề xuất mở lần nữa: việc đó đang / đã diễn ra ở /production.
  const topicDangMo = (i.production?.trackTopics ?? 0) > 0;
  const followUp = i.production?.winnerFollowUp ?? null;
  const topicHref = `/production/topics/new?model=${encodeURIComponent(i.modelId)}`;
  const topicCaveat = i.production === null ? "Không đọc được topic sản xuất của mẫu (hoặc bạn không có quyền xem) — có thể đã có topic đang mở." : null;
  const stateText = i.declaredState ? MODEL_STATE_LABELS[i.declaredState] : "Chưa khai";
  const mode = i.signal ? topicOpeningMode(i.signal.signal, i.declaredState) : null;
  if (i.declaredState === "WINNER" && followUp) {
    out.push({
      key: "lifecycle-production-ahead",
      source: "SIGNAL",
      what: `Sản xuất đã đi trước — chuyển vòng đời tới “${MODEL_STATE_LABELS[followUp.to]}”`,
      why: `Mẫu đã khai ${MODEL_STATE_LABELS.WINNER} nhưng miền sản xuất đã tới “${MODEL_STATE_LABELS[followUp.to]}” (topic mở sớm chạy song song với test quảng cáo). Người bấm chuyển — không có gì tự áp.`,
      data: followUp.reason,
      links: [{ label: "Bàn sản xuất của mẫu", href: `/production/models/${encodeURIComponent(i.modelId)}` }],
      transition: { to: followUp.to, reason: followUp.reason },
      caveat: null,
    });
  } else if (i.signal && mode && !topicDangMo) {
    if (i.signal.signal === "WINNER") {
      out.push({
        key: "lifecycle-production-discussion",
        source: "SIGNAL",
        what: "Cân nhắc mở trao đổi sản xuất cho mẫu",
        why: `Tín hiệu mẫu là ${MODEL_SIGNAL_LABEL.WINNER} trong khi trạng thái khai là ${stateText}.`,
        data: i.signal.summary,
        links: i.canCreateTopic ? [{ label: "Tạo topic sản xuất", href: topicHref }] : [],
        transition: {
          to: "PRODUCTION_DISCUSSION",
          reason: `Tín hiệu mẫu: THẮNG (${i.signal.summary}) — mở trao đổi sản xuất.`,
        },
        caveat: topicCaveat,
      });
    } else if (mode === "EARLY") {
      out.push({
        key: "topic-open-early",
        source: "SIGNAL",
        what: "Cân nhắc mở topic sản xuất SỚM — luồng song song với test quảng cáo",
        why: `Tín hiệu mẫu là ${MODEL_SIGNAL_LABEL.PROMISING} (chỉ số tốt, chưa thắng) trong khi trạng thái khai là ${stateText}. Quy tắc chủ shop 25/09/2026: mẫu tiềm năng được mở topic để xưởng báo giá, làm mẫu song song — vòng đời mẫu KHÔNG đổi khi topic mở; khai THẮNG vẫn là việc của người.`,
        data: i.signal.summary,
        links: i.canCreateTopic ? [{ label: "Mở topic sản xuất sớm", href: topicHref }] : [],
        transition: null,
        caveat: topicCaveat,
      });
    } else {
      // TRIỂN VỌNG nhưng người ĐÃ khai THẮNG: mở topic là bước tiếp thường (vòng đời tự đi theo sang “Bàn sản xuất”).
      out.push({
        key: "topic-open",
        source: "SIGNAL",
        what: "Cân nhắc mở topic sản xuất cho mẫu",
        why: `Trạng thái khai là ${MODEL_STATE_LABELS.WINNER}; tín hiệu mẫu hiện là ${MODEL_SIGNAL_LABEL.PROMISING}. Mở topic thì vòng đời tự đi theo sang “${MODEL_STATE_LABELS.PRODUCTION_DISCUSSION}”.`,
        data: i.signal.summary,
        links: i.canCreateTopic ? [{ label: "Tạo topic sản xuất", href: topicHref }] : [],
        transition: null,
        caveat: topicCaveat,
      });
    }
  }
  return out;
}

// ─────────────────────────── DÒNG THỜI GIAN ───────────────────────────

/** Gộp hai dòng thời gian đã có (mốc của sổ mẫu + phép chiếu ý tưởng), mới nhất lên trước, bỏ trùng id. */
export function mergeTimelines<T extends { id: string; at: Date }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of lists.flat()) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

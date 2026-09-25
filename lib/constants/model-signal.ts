import { ADS_ACTION_LABEL, type AdsAction } from "@/lib/constants/ads-decision";
import { CREATIVE_VERDICT_LABEL, DESIGN_STATUS_LABEL, type CreativeVerdict, type DesignStatus } from "@/lib/constants/creative-loop";
import { DECISION_LABEL, type InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import { MODEL_STATE_LABELS, type ModelState } from "@/lib/constants/model-lifecycle";
import { VERDICT_LABEL, type ProductVerdict } from "@/lib/constants/product-verdict";

/**
 * ═══════════ TÍN HIỆU MẪU — PHÉP GỘP CÓ GIẢI THÍCH CÁC PHÁN QUYẾT ĐÃ CÓ (Company OS · A2) ═══════════
 *
 * target-architecture.md Q10: KHÔNG phải bộ chấm thứ năm. Tệp này không có một ngưỡng số nào (luật 27,
 * 38) — nó chỉ đọc NHÃN mà bốn bộ máy đã phán và ghép chúng theo một BẢNG CỐ ĐỊNH, khai ra dưới đây:
 *
 *   · QUẢNG CÁO  — `decideAction` chiều mã hàng (`getModelAdsSummary` của Agent B → bảng quyết định /ads).
 *   · MẪU MÃ     — `classifyProduct` (sáu chiều, /products/performance) chấm TỪNG mẫu mã của mẫu.
 *   · CREATIVE   — phán quyết ĐÃ CHỤP của vòng creative (`getModelCreativeSummary`).
 *   · THIẾT KẾ   — `design_concepts.status` (tab Thiết kế mới).
 *   · TỒN KHO    — `decideInventory` (/inventory/decisions) — CHỈ LÀ BỐI CẢNH, không bỏ phiếu (xem dưới).
 *
 * ─── BƯỚC 1: MỖI NGUỒN QUY VỀ MỘT LÁ PHIẾU ───
 *
 *   Quảng cáo: SCALE, HOLD (có lãi) → TỐT · WATCH (quanh hoà vốn) → TRUNG TÍNH · FIX_DELIVERY → ĐÁNG LO ·
 *              CUT → XẤU · INSUFFICIENT_DATA / NO_SPEND_DATA / không có dòng → CHƯA ĐỦ.
 *              Mã có đơn mà CHƯA TỪNG ghép chiến dịch (`SPEND_UNMAPPED`) → CHƯA ĐỦ, dù bảng quyết định
 *              có in hành động: hành động ấy đứng trên chi 0 ₫ (chưa ghép ≠ không tiêu — luật 42, 67).
 *   Mẫu mã:    gộp nhãn của các mẫu mã theo thứ tự THẬN TRỌNG: có mẫu mã LỖ → XẤU; có mẫu mã ĐÁNG LO →
 *              ĐÁNG LO; có mẫu mã ĐÁNG NHÂN BẢN → TỐT; có mẫu mã BÌNH THƯỜNG → TRUNG TÍNH; còn lại
 *              (mọi mẫu mã "chưa đủ căn cứ", hoặc không có dòng bán) → CHƯA ĐỦ. Một dấu hiệu xấu đủ
 *              nặng thắng mọi dấu hiệu tốt — cùng tinh thần `classifyProduct` ("bỏ sót mất tiền thật").
 *   Creative:  có mẩu THẮNG → TỐT · có mẩu HỨA HẸN → HỨA HẸN · còn mẩu chưa chạy / đang test / chờ đơn →
 *              ĐANG THỬ · mọi mẩu đã phán đều TẮT/LOẠI → XẤU · chỉ có "chưa kết luận được" / chưa phán →
 *              CHƯA ĐỦ · không có creative nào → KHÔNG CÓ NGUỒN.
 *   Thiết kế:  THẮNG / Đưa vào sản xuất → TỐT · Chờ test / Đang test → ĐANG THỬ · Loại → XẤU ·
 *              không có thiết kế → KHÔNG CÓ NGUỒN.
 *
 * ─── BƯỚC 2: HAI TẦNG — BẰNG CHỨNG THỊ TRƯỜNG ĐỨNG TRÊN NHÃN THỬ NGHIỆM ───
 *
 * Tầng THỊ TRƯỜNG = Quảng cáo + Mẫu mã (tiền thật và `ORDER_OUTCOME`). Tầng THỬ = Creative + Thiết kế.
 * Thứ tự THẬN TRỌNG (ít cam kết tiền nhất đứng trước):  LOẠI < CẦN THÊM DỮ LIỆU < ĐANG THỬ < TRIỂN VỌNG < THẮNG.
 *
 * Tầng thị trường, mỗi lá phiếu kết luận được quy về một mức: TỐT → THẮNG · TRUNG TÍNH / ĐÁNG LO → ĐANG
 * THỬ · XẤU → LOẠI. Kết quả = mức THẬN TRỌNG NHẤT trong các lá phiếu kết luận được; nếu một trong hai
 * nguồn CHƯA ĐỦ thì kết quả bị chặn trên ở TRIỂN VỌNG ("thiếu một nguồn thì không thể là THẮNG").
 *
 *                 Mẫu mã →  TỐT        TRUNG TÍNH   ĐÁNG LO      XẤU      CHƯA ĐỦ
 *   Quảng cáo ↓
 *   TỐT                     THẮNG      ĐANG THỬ     ĐANG THỬ ⚡   LOẠI ⚡   TRIỂN VỌNG
 *   TRUNG TÍNH              ĐANG THỬ   ĐANG THỬ     ĐANG THỬ     LOẠI     ĐANG THỬ
 *   ĐÁNG LO                 ĐANG THỬ ⚡ ĐANG THỬ     ĐANG THỬ     LOẠI     ĐANG THỬ
 *   XẤU                     LOẠI ⚡    LOẠI         LOẠI         LOẠI     LOẠI
 *   CHƯA ĐỦ                 TRIỂN VỌNG ĐANG THỬ     ĐANG THỬ     LOẠI     → xét tầng THỬ
 *   (⚡ = hai nguồn nói ngược nhau ⇒ ghi vào `conflicts`, kết quả là phía thận trọng.)
 *
 * Tầng thị trường CHƯA ĐỦ cả hai ⇒ xét tầng THỬ: TỐT / HỨA HẸN → TRIỂN VỌNG (nhãn thử không bao giờ đủ
 * để THẮNG) · ĐANG THỬ → ĐANG THỬ · XẤU → LOẠI; lấy mức thận trọng nhất; một bên tốt một bên xấu ⇒
 * xung đột. Không nguồn nào kết luận được ⇒ CẦN THÊM DỮ LIỆU — không đoán.
 *
 * Khi tầng thị trường ĐÃ kết luận, tầng THỬ chỉ được HẠ, không được nâng: kết quả THẮNG mà có nhãn thử
 * XẤU ⇒ hạ về TRIỂN VỌNG + xung đột; kết quả LOẠI mà có nhãn thử TỐT ⇒ giữ LOẠI + xung đột. (Lệch khỏi
 * câu chữ "lấy phía thận trọng" ở đúng một chỗ: một nhãn thử cũ KHÔNG kéo một mẫu đang có lãi thật
 * xuống LOẠI — nó chặn THẮNG và được nêu ra, người quyết.)
 *
 * ─── TỒN KHO VÀ TRẠNG THÁI KHAI: CHỈ NÊU XUNG ĐỘT ───
 *
 * `decideInventory` phán theo TỪNG mẫu mã và theo tốc độ bán — một size XXL tồn nhiều không nói gì về
 * việc mẫu có thắng không. Nên nó không bỏ phiếu; chỉ khi tín hiệu là THẮNG/TRIỂN VỌNG mà có mẫu mã
 * "chôn vốn"/"nên xả", hoặc tín hiệu là LOẠI mà kho kêu "đặt thêm"/"nguy cơ hết hàng", thì nêu xung
 * đột. Trạng thái NGƯỜI khai (WINNER / LOSER) ngược với tín hiệu cũng chỉ được nêu, không bị sửa.
 *
 * Hàm THUẦN: không đọc CSDL, không đọc đồng hồ. `tests/company-os-model-360.test.ts` duyệt toàn bảng.
 */

export const MODEL_SIGNALS = ["WINNER", "PROMISING", "TESTING", "LOSER", "NEEDS_MORE_DATA"] as const;
export type ModelSignal = (typeof MODEL_SIGNALS)[number];

export const MODEL_SIGNAL_LABEL: Record<ModelSignal, string> = {
  WINNER: "Thắng",
  PROMISING: "Triển vọng",
  TESTING: "Đang thử · chưa ngả",
  LOSER: "Loại",
  NEEDS_MORE_DATA: "Cần thêm dữ liệu",
};

export const MODEL_SIGNAL_HINT: Record<ModelSignal, string> = {
  WINNER: "Quảng cáo có lãi (Tăng ngân sách / Giữ nguyên) VÀ có mẫu mã đạt đủ sáu chiều, không nguồn nào nói ngược.",
  PROMISING: "Có bằng chứng tốt nhưng chưa đủ: thiếu một nguồn thị trường, hoặc mới chỉ thắng ở vòng thử creative / thiết kế.",
  TESTING: "Các nguồn đã kết luận nhưng chưa ngả về phía nào (quanh hoà vốn, đáng lo, hoặc đang trong vòng thử).",
  LOSER: "Ít nhất một nguồn thị trường kết luận xấu (quảng cáo nên cắt / mẫu mã đang lỗ), hoặc mọi nhãn thử đều loại.",
  NEEDS_MORE_DATA: "Không nguồn nào kết luận được — không đoán.",
};

/** Thứ tự THẬN TRỌNG: chỉ số nhỏ = ít cam kết tiền hơn. */
export const MODEL_SIGNAL_RANK: Record<ModelSignal, number> = { LOSER: 0, NEEDS_MORE_DATA: 1, TESTING: 2, PROMISING: 3, WINNER: 4 };

export const MODEL_SIGNAL_TONE: Record<ModelSignal, string> = {
  WINNER: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  PROMISING: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  TESTING: "bg-muted text-foreground",
  LOSER: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  NEEDS_MORE_DATA: "bg-muted text-muted-foreground italic",
};

export type SignalSource = "ADS" | "PRODUCT" | "CREATIVE" | "DESIGN" | "INVENTORY";

export const SIGNAL_SOURCE_LABEL: Record<SignalSource, string> = {
  ADS: "Quảng cáo",
  PRODUCT: "Mẫu mã (6 chiều)",
  CREATIVE: "Creative",
  DESIGN: "Thiết kế",
  INVENTORY: "Tồn kho",
};

/** Lá phiếu của một nguồn. `CONTEXT` = nguồn chỉ làm bối cảnh (tồn kho), không bỏ phiếu. */
export type SourceVote = "POSITIVE" | "PROMISING" | "NEUTRAL" | "CAUTION" | "NEGATIVE" | "TESTING" | "INSUFFICIENT" | "ABSENT" | "CONTEXT";

export const SOURCE_VOTE_LABEL: Record<SourceVote, string> = {
  POSITIVE: "tốt",
  PROMISING: "hứa hẹn",
  NEUTRAL: "trung tính",
  CAUTION: "đáng lo",
  NEGATIVE: "xấu",
  TESTING: "đang thử",
  INSUFFICIENT: "chưa đủ",
  ABSENT: "không có nguồn",
  CONTEXT: "bối cảnh",
};

export type SignalReason = { source: SignalSource; verdict: string; vote: SourceVote; detail: string };

export type ModelSignalResult = {
  signal: ModelSignal;
  /** Tầng quyết định: thị trường, vòng thử, hay không tầng nào kết luận được. */
  decidedBy: "MARKET" | "TESTING" | "NONE";
  reasons: SignalReason[];
  conflicts: string[];
};

// ─────────────────────────── ĐẦU VÀO ───────────────────────────

export type SignalAdsInput =
  | { kind: "NO_ROW" }
  | { kind: "SPEND_UNMAPPED"; action: AdsAction; reason: string }
  | { kind: "OK"; action: AdsAction; reason: string };

export type SignalCreativeInput = { total: number; byVerdict: Partial<Record<CreativeVerdict | "NO_VERDICT", number>> };

export type ModelSignalInputs = {
  /** `null` = nguồn không có (mẫu chưa lên Pancake) HOẶC không đọc được — lý do ở `unavailable`. */
  ads: SignalAdsInput | null;
  /** Nhãn `classifyProduct` của TỪNG mẫu mã có dòng bán trong kỳ; mảng rỗng = không có dòng nào. */
  productVerdicts: ProductVerdict[] | null;
  creative: SignalCreativeInput | null;
  design: DesignStatus | null;
  /** Kết luận `decideInventory` của các mẫu mã CẦN LÀM GÌ ĐÓ (không gồm "Giữ nguyên"). */
  inventory: InventoryDecisionKind[] | null;
  declaredState: ModelState | null;
  /** Nguồn không đọc được (lỗi) — lá phiếu thành CHƯA ĐỦ, kèm câu này. */
  unavailable?: Partial<Record<SignalSource, string>>;
};

// ─────────────────────────── BƯỚC 1: LÁ PHIẾU ───────────────────────────

export function adsVote(a: SignalAdsInput | null): { vote: SourceVote; verdict: string; detail: string } {
  if (!a) return { vote: "ABSENT", verdict: "—", detail: "Mẫu chưa có sản phẩm Pancake — không có dòng quảng cáo để đọc." };
  if (a.kind === "NO_ROW") return { vote: "INSUFFICIENT", verdict: "Không có dòng", detail: "Bảng quyết định /ads không có dòng nào của mã trong kỳ (không đơn, không chi đã ghép)." };
  if (a.kind === "SPEND_UNMAPPED") {
    return {
      vote: "INSUFFICIENT",
      verdict: `${ADS_ACTION_LABEL[a.action]} · chưa ghép chi`,
      detail: "Chưa từng ghép chiến dịch nào với mã: hành động của bảng quyết định đứng trên chi 0 ₫ — chưa ghép không phải không tiêu, nên không dùng làm căn cứ.",
    };
  }
  const verdict = ADS_ACTION_LABEL[a.action];
  const vote: SourceVote =
    a.action === "SCALE" || a.action === "HOLD"
      ? "POSITIVE"
      : a.action === "WATCH"
        ? "NEUTRAL"
        : a.action === "FIX_DELIVERY"
          ? "CAUTION"
          : a.action === "CUT"
            ? "NEGATIVE"
            : "INSUFFICIENT";
  return { vote, verdict, detail: a.reason };
}

/** Thứ tự gộp nhãn mẫu mã — thận trọng trước. */
const PRODUCT_AGG_ORDER: ProductVerdict[] = ["LOSER", "RISK", "WINNER", "NEUTRAL", "INSUFFICIENT_DATA"];

export function aggregateProductVerdicts(verdicts: readonly ProductVerdict[]): ProductVerdict | null {
  if (!verdicts.length) return null;
  for (const v of PRODUCT_AGG_ORDER) if (verdicts.includes(v)) return v;
  return null;
}

export function productVote(verdicts: readonly ProductVerdict[] | null): { vote: SourceVote; verdict: string; detail: string } {
  if (verdicts === null) return { vote: "ABSENT", verdict: "—", detail: "Mẫu chưa có sản phẩm Pancake — không có mẫu mã để chấm." };
  const agg = aggregateProductVerdicts(verdicts);
  if (agg === null) return { vote: "INSUFFICIENT", verdict: "Không có dòng bán", detail: "Không mẫu mã nào có đơn trong kỳ." };
  const dem = (v: ProductVerdict) => verdicts.filter((x) => x === v).length;
  const detail = PRODUCT_AGG_ORDER.filter((v) => dem(v) > 0)
    .map((v) => `${dem(v)} ${VERDICT_LABEL[v].toLowerCase()}`)
    .join(" · ");
  const vote: SourceVote = agg === "WINNER" ? "POSITIVE" : agg === "NEUTRAL" ? "NEUTRAL" : agg === "RISK" ? "CAUTION" : agg === "LOSER" ? "NEGATIVE" : "INSUFFICIENT";
  return { vote, verdict: VERDICT_LABEL[agg], detail: `${verdicts.length} mẫu mã: ${detail}` };
}

export function creativeVote(c: SignalCreativeInput | null): { vote: SourceVote; verdict: string; detail: string } {
  if (!c || c.total === 0) return { vote: "ABSENT", verdict: "—", detail: "Không có creative nào quảng bá mẫu này trong vòng creative." };
  const n = (k: CreativeVerdict | "NO_VERDICT") => c.byVerdict[k] ?? 0;
  const parts = (["WIN", "PROMISING", "RUNNING", "AWAITING_ORDERS", "PENDING", "KILL", "LOSE", "UNJUDGED"] as const)
    .filter((k) => n(k) > 0)
    .map((k) => `${n(k)} ${CREATIVE_VERDICT_LABEL[k].toLowerCase()}`);
  if (n("NO_VERDICT") > 0) parts.push(`${n("NO_VERDICT")} chưa phán`);
  const detail = `${c.total} creative: ${parts.join(" · ")}`;
  if (n("WIN") > 0) return { vote: "POSITIVE", verdict: CREATIVE_VERDICT_LABEL.WIN, detail };
  if (n("PROMISING") > 0) return { vote: "PROMISING", verdict: CREATIVE_VERDICT_LABEL.PROMISING, detail };
  if (n("RUNNING") + n("AWAITING_ORDERS") + n("PENDING") > 0) return { vote: "TESTING", verdict: CREATIVE_VERDICT_LABEL.RUNNING, detail };
  if (n("KILL") + n("LOSE") > 0) return { vote: "NEGATIVE", verdict: "Mọi mẩu đã phán đều tắt / loại", detail };
  return { vote: "INSUFFICIENT", verdict: CREATIVE_VERDICT_LABEL.UNJUDGED, detail };
}

export function designVote(d: DesignStatus | null): { vote: SourceVote; verdict: string; detail: string } {
  if (!d) return { vote: "ABSENT", verdict: "—", detail: "Mẫu không đi từ vòng thiết kế." };
  const verdict = DESIGN_STATUS_LABEL[d];
  const vote: SourceVote = d === "WIN" || d === "PRODUCTION" ? "POSITIVE" : d === "LOSE" ? "NEGATIVE" : "TESTING";
  return { vote, verdict, detail: `Trạng thái thiết kế: ${verdict}` };
}

// ─────────────────────────── BƯỚC 2: GỘP ───────────────────────────

const minSignal = (xs: ModelSignal[]): ModelSignal => xs.reduce((a, b) => (MODEL_SIGNAL_RANK[b] < MODEL_SIGNAL_RANK[a] ? b : a));

/** Tầng THỊ TRƯỜNG: mức của một lá phiếu kết luận được. `null` = chưa đủ. */
export function marketLevel(v: SourceVote): ModelSignal | null {
  if (v === "POSITIVE") return "WINNER";
  if (v === "NEUTRAL" || v === "CAUTION") return "TESTING";
  if (v === "NEGATIVE") return "LOSER";
  return null;
}

/** Tầng THỬ: mức của một lá phiếu kết luận được. `null` = chưa đủ / không có nguồn. */
export function testingLevel(v: SourceVote): ModelSignal | null {
  if (v === "POSITIVE" || v === "PROMISING") return "PROMISING";
  if (v === "TESTING") return "TESTING";
  if (v === "NEGATIVE") return "LOSER";
  return null;
}

/** Bảng tầng thị trường (hai lá phiếu ⇒ tín hiệu + có xung đột không). `null` = cả hai chưa đủ. */
export function combineMarket(ads: SourceVote, product: SourceVote): { signal: ModelSignal; conflict: boolean } | null {
  const levels = [marketLevel(ads), marketLevel(product)];
  const known = levels.filter((l): l is ModelSignal => l !== null);
  if (!known.length) return null;
  let signal = minSignal(known);
  if (known.length === 1 && MODEL_SIGNAL_RANK[signal] > MODEL_SIGNAL_RANK.PROMISING) signal = "PROMISING";
  const pos = ads === "POSITIVE" || product === "POSITIVE";
  const neg = ads === "NEGATIVE" || product === "NEGATIVE" || ads === "CAUTION" || product === "CAUTION";
  return { signal, conflict: pos && neg };
}

/** Bảng tầng THỬ. `null` = không nguồn thử nào kết luận được. */
export function combineTesting(creative: SourceVote, design: SourceVote): { signal: ModelSignal; conflict: boolean } | null {
  const known = [testingLevel(creative), testingLevel(design)].filter((l): l is ModelSignal => l !== null);
  if (!known.length) return null;
  const good = (v: SourceVote) => v === "POSITIVE" || v === "PROMISING";
  return { signal: minSignal(known), conflict: (good(creative) && design === "NEGATIVE") || (good(design) && creative === "NEGATIVE") };
}

export function deriveModelSignal(i: ModelSignalInputs): ModelSignalResult {
  const un = i.unavailable ?? {};
  const voteOf = (src: SignalSource, v: { vote: SourceVote; verdict: string; detail: string }): SignalReason =>
    un[src] ? { source: src, vote: "INSUFFICIENT", verdict: "Không đọc được nguồn", detail: un[src] as string } : { source: src, ...v };

  const ads = voteOf("ADS", adsVote(i.ads));
  const product = voteOf("PRODUCT", productVote(i.productVerdicts));
  const creative = voteOf("CREATIVE", creativeVote(i.creative));
  const design = voteOf("DESIGN", designVote(i.design));
  const reasons: SignalReason[] = [ads, product, creative, design];
  const conflicts: string[] = [];

  let signal: ModelSignal;
  let decidedBy: ModelSignalResult["decidedBy"];
  const market = combineMarket(ads.vote, product.vote);
  const testing = combineTesting(creative.vote, design.vote);

  if (market) {
    decidedBy = "MARKET";
    signal = market.signal;
    if (market.conflict) conflicts.push(`Quảng cáo nói "${ads.verdict}" nhưng phân loại mẫu mã nói "${product.verdict}" — lấy phía thận trọng.`);
    const testBad = creative.vote === "NEGATIVE" || design.vote === "NEGATIVE";
    const testGood = [creative.vote, design.vote].some((v) => v === "POSITIVE" || v === "PROMISING");
    if (signal === "WINNER" && testBad) {
      signal = "PROMISING";
      conflicts.push("Thị trường nói THẮNG nhưng vòng thử (creative / thiết kế) có nhãn loại — hạ về Triển vọng cho người xem lại.");
    } else if (signal === "LOSER" && testGood) {
      conflicts.push("Thị trường nói LOẠI nhưng vòng thử (creative / thiết kế) có nhãn thắng / hứa hẹn — giữ Loại, nhãn thử không nâng được kết luận tiền thật.");
    }
  } else if (testing) {
    decidedBy = "TESTING";
    signal = testing.signal;
    if (testing.conflict) conflicts.push(`Creative nói "${creative.verdict}" nhưng thiết kế nói "${design.verdict}" — lấy phía thận trọng.`);
  } else {
    decidedBy = "NONE";
    signal = "NEEDS_MORE_DATA";
  }

  // ── Tồn kho: bối cảnh, không bỏ phiếu ──
  if (un.INVENTORY) {
    reasons.push({ source: "INVENTORY", vote: "INSUFFICIENT", verdict: "Không đọc được nguồn", detail: un.INVENTORY });
  } else if (i.inventory === null) {
    reasons.push({ source: "INVENTORY", vote: "ABSENT", verdict: "—", detail: "Mẫu chưa có sản phẩm Pancake — không có mẫu mã để quyết định tồn." });
  } else {
    const kinds = [...new Set(i.inventory)];
    reasons.push({
      source: "INVENTORY",
      vote: "CONTEXT",
      verdict: kinds.length ? kinds.map((k) => DECISION_LABEL[k]).join(" · ") : "Không mẫu mã nào cần làm gì",
      detail: kinds.length ? `${i.inventory.length} mẫu mã có kết luận khác "Giữ nguyên"` : "Mọi mẫu mã đang ở Giữ nguyên (hoặc chưa vào bảng quyết định tồn).",
    });
    const has = (k: InventoryDecisionKind) => kinds.includes(k);
    if ((signal === "WINNER" || signal === "PROMISING") && (has("OVERSTOCK") || has("CLEARANCE_CANDIDATE"))) {
      conflicts.push("Tín hiệu tốt nhưng kho có mẫu mã đang chôn vốn / nên xả — xem mẫu mã nào trước khi đặt thêm.");
    }
    if (signal === "LOSER" && (has("REORDER") || has("STOCKOUT_RISK"))) {
      conflicts.push("Tín hiệu Loại nhưng kho đang đề xuất đặt thêm / cảnh báo hết hàng — xem lại trước khi đặt.");
    }
  }

  // ── Trạng thái NGƯỜI khai ngược với tín hiệu: nêu ra, không sửa ──
  if (i.declaredState === "WINNER" && signal === "LOSER") conflicts.push(`Trạng thái khai là "${MODEL_STATE_LABELS.WINNER}" nhưng tín hiệu là Loại.`);
  if (i.declaredState === "LOSER" && (signal === "WINNER" || signal === "PROMISING")) conflicts.push(`Trạng thái khai là "${MODEL_STATE_LABELS.LOSER}" nhưng tín hiệu là ${MODEL_SIGNAL_LABEL[signal]}.`);

  return { signal, decidedBy, reasons, conflicts };
}

import { ADS_ACTION_LABEL, type AdsAction } from "@/lib/constants/ads-decision";
import { DECISION_LABEL, type InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import type { ModelSuggestion } from "@/lib/constants/model-360";
import { formatDate, formatNumber, formatVND } from "@/lib/format";

/**
 * ═══════════ VÒNG PHẢN HỒI TỒN KHO → CREATIVE / QUẢNG CÁO (Company OS · Agent X · đặc tả §21 P4) ═══════════
 *
 * "Khi Slow / Dead: ERP tạo recommendation … Phải liên kết stock → Creative → Ads. Đây là feedback loop trở
 * lại đầu quy trình." Tệp THUẦN — không đọc CSDL, không đọc đồng hồ, client import được.
 *
 * ─── KHÔNG CÓ NGƯỠNG NÀO Ở ĐÂY (luật 27, 38) ───
 *
 * Hai đề xuất chỉ GHÉP kết luận mà các bộ máy ĐÃ đưa ra:
 *
 *  · tồn kho — `decideInventory` (OVERSTOCK · CLEARANCE_CANDIDATE · STOCKOUT_RISK), số nên đặt ĐÃ trừ hàng
 *    đặt xưởng (`suggestedNetOfOpenPo`), thời gian sản xuất của kế hoạch;
 *  · quảng cáo — hành động `decideAction` chiều mã hàng (`getAdsDecision(…, "product")`), CHỈ khi số chi đã
 *    ghép về mã (`summarizeModelAds` → `OK`, luật 67);
 *  · creative — ngày của mẫu gần nhất / lần vào thư viện gần nhất (sự kiện có thật, không chấm điểm).
 *
 * Phép so duy nhất tự viết — "đủ bán < thời gian sản xuất" — là ĐÚNG phép so `decideInventory` dùng để ra
 * STOCKOUT_RISK, hai vế lấy nguyên từ dòng kế hoạch.
 *
 * ─── CHỈ ĐỀ XUẤT ───
 *
 * Không đề xuất nào tự làm gì: không ghi Facebook, không đổi ngân sách, không gọi máy vẽ (vẽ ảnh tốn tiền —
 * NGƯỜI bấm "Gen"). Mỗi đề xuất là một câu + số + link tới màn hình chủ nơi người làm việc thật.
 *
 * ─── CHƯA BIẾT KHÔNG SINH ĐỀ XUẤT ───
 *
 * Tồn chưa biết (chưa phiếu nhập / sổ lệch ⇒ `DATA_INSUFFICIENT`) không bao giờ là căn cứ. Quảng cáo mà chi
 * CHƯA GHÉP về mã thì mọi phần phụ thuộc quảng cáo im lặng — đề xuất "đừng tăng ngân sách" không sinh ra, và
 * nếu đúng lúc ấy kho đang nguy cơ hết hàng thì trả một câu DỮ LIỆU CHƯA ĐỦ, không đoán.
 */

export const STOCK_FEEDBACK_KINDS = ["PUSH_STOCK", "SCALE_BLOCKED_BY_STOCK"] as const;
export type StockFeedbackKind = (typeof STOCK_FEEDBACK_KINDS)[number];

export const STOCK_FEEDBACK_LABEL: Record<StockFeedbackKind, string> = {
  PUSH_STOCK: "Đẩy tồn bằng creative / khách cũ",
  SCALE_BLOCKED_BY_STOCK: "Đừng tăng ngân sách — sắp hết hàng",
};

/** Kỳ quảng cáo mà vòng phản hồi đọc — cùng kỳ mặc định của cockpit và trang 360. */
export const STOCK_FEEDBACK_ADS_PERIOD = "30d" as const;

/** Một mẫu mã (dòng của `getInventoryDecisionReport`) ở dạng vòng phản hồi cần. */
export type StockFeedbackVariant = {
  variantId: string;
  /** "Màu/Size" để in. */
  label: string;
  decision: InventoryDecisionKind;
  /**
   * `false` ⇒ tồn CHƯA BIẾT (chưa phiếu nhập, hoặc sổ kho lệch — bộ máy tồn trả `DATA_INSUFFICIENT`).
   * Dòng này không bao giờ là căn cứ của một đề xuất.
   */
  stockKnown: boolean;
  available: number;
  /** Món/ngày — tốc độ bán của kế hoạch (đã chống nhiễu). */
  velocity: number;
  sold30: number;
  /** Khả dụng ÷ tốc độ; `null` = không bán được cái nào. */
  daysOfCover: number | null;
  /** Thời gian sản xuất của kế hoạch; `null` = không biết. */
  leadTimeDays: number | null;
  /** `null` = chưa biết giá nhập. */
  unitCost: number | null;
  /** Số nên đặt ĐÃ trừ hàng đặt xưởng chưa nhận (`suggestedNetOfOpenPo`); `null` = không tính được. */
  suggestedQty: number | null;
  /** Đã đặt xưởng (lệnh SENT + lô đang sản xuất) chưa nhận. */
  openPoQty: number;
  capitalFreeable: number | null;
  grossImpactEstimate: number | null;
  /** Hạn đặt của kế hoạch (`YYYY-MM-DD`); `null` = không có. */
  reorderByDate: string | null;
};

/** Quảng cáo của mã — nguyên tóm tắt `summarizeModelAds` (B). */
export type StockFeedbackAds = {
  status: "OK" | "NO_ROW" | "SPEND_UNMAPPED";
  action: AdsAction | null;
  /** `null` khi chi chưa ghép / không có dòng — CHƯA BIẾT, không phải 0 ₫. */
  spend: number | null;
  reason: string;
};

export type StockFeedbackInput = {
  productId: string;
  productCode: string;
  productName: string;
  modelId: string | null;
  variants: readonly StockFeedbackVariant[];
  /** Cổng dữ liệu của trang Quyết định vốn tồn. */
  inventoryGate: "BETA" | "DATA_INSUFFICIENT";
  /**
   * Người xem có quyền màn hình quảng cáo (và phạm vi ADS) không. `false` ⇒ không một phần quảng cáo nào
   * được đọc hay in — trang này không là cửa sau vào số chi.
   */
  adsVisible: boolean;
  /** `null` = không có quyền / không đọc được nguồn quảng cáo ⇒ CHƯA BIẾT. */
  ads: StockFeedbackAds | null;
  /** `null` = không đọc được nguồn creative. Hai ngày `null` bên trong = mã THẬT SỰ chưa có (đếm được). */
  creative: { lastCreativeAt: Date | null; lastLibraryAt: Date | null } | null;
};

/** Ô số liệu — `value = null` ⇒ CHƯA BIẾT, in "—" (luật 42). `estimate` ⇒ phải in nhãn ước tính. */
export type StockFeedbackDatum = { label: string; value: string | null; estimate?: boolean };
export type StockFeedbackLink = { label: string; href: string };

export type StockFeedback = {
  kind: StockFeedbackKind;
  productId: string;
  modelId: string | null;
  what: string;
  why: string;
  data: StockFeedbackDatum[];
  /** Việc chính — mở màn hình chủ. */
  action: StockFeedbackLink;
  /** Lối khác (creative / khách cũ / quảng cáo / kế hoạch) — người chọn. */
  alternatives: StockFeedbackLink[];
  /**
   * CĂN CỨ của đề xuất ở dạng chuẩn (không ngày, không số đếm trôi): đổi khi và chỉ khi các bộ máy nói một
   * điều khác. Cockpit băm chuỗi này làm khoá nguồn.
   */
  basis: string;
  impact: { amountVnd: number | null; basis: string };
  /** Lưu ý đi kèm (cổng dữ liệu tồn chưa đủ, mẫu mã chưa biết tồn bị bỏ ra). */
  caveat: string | null;
};

export type StockFeedbackResult = {
  recommendations: StockFeedback[];
  /** Câu DỮ LIỆU CHƯA ĐỦ: có dấu hiệu nhưng đầu vào chưa biết ⇒ không đề xuất, nói ra vì sao. */
  insufficient: string[];
};

const PUSH_DECISIONS: readonly InventoryDecisionKind[] = ["OVERSTOCK", "CLEARANCE_CANDIDATE"];

/** Tổng; một vế CHƯA BIẾT ⇒ cả tổng CHƯA BIẾT (cộng thiếu không in thành số). */
const sumOrNull = (xs: readonly (number | null)[]): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));

/** Mẫu mã có kết luận "hết trước khi lô mới về": STOCKOUT_RISK, hoặc đúng phép so của `decideInventory`. */
export function stockRunsOutBeforeRestock(v: StockFeedbackVariant): boolean {
  if (!v.stockKnown) return false;
  if (v.decision === "STOCKOUT_RISK") return true;
  return v.velocity > 0 && v.daysOfCover !== null && v.leadTimeDays !== null && v.daysOfCover < v.leadTimeDays;
}

/** Lệnh / lô đặt xưởng đang mở đã phủ đủ số nên đặt của mẫu mã (số nên đặt ĐÃ trừ hàng đặt xưởng = 0). */
export function openPoCovers(v: StockFeedbackVariant): boolean {
  return v.openPoQty > 0 && v.suggestedQty === 0;
}

function variantBasis(vs: readonly StockFeedbackVariant[]): string {
  return vs
    .map((v) => `${v.variantId}:${v.decision}`)
    .sort()
    .join(",");
}

function adsHref(): string {
  return `/ads?dim=product&period=${STOCK_FEEDBACK_ADS_PERIOD}`;
}

/** Link mở tab Duyệt của vòng mẫu với ẢNH của mã chọn sẵn ở khối "Gen ảnh bằng tay" — người vẫn phải bấm Gen. */
export function creativeGenHref(productId: string): string {
  return `/marketing/creatives?tab=duyet&product=${encodeURIComponent(productId)}#gen-tay`;
}

function gateCaveat(input: StockFeedbackInput, unknownCount: number): string | null {
  const parts: string[] = [];
  if (input.inventoryGate === "DATA_INSUFFICIENT") parts.push("Trang Quyết định vốn tồn đang tự xưng DỮ LIỆU CHƯA ĐỦ — chỉ tham khảo.");
  if (unknownCount > 0) parts.push(`${formatNumber(unknownCount)} mẫu mã khác của mã chưa biết tồn — không tính vào đây.`);
  return parts.length ? parts.join(" ") : null;
}

function creativeData(input: StockFeedbackInput): StockFeedbackDatum[] {
  const c = input.creative;
  const day = (d: Date | null) => (d ? formatDate(d) : "chưa có");
  return [
    { label: "Creative gần nhất", value: c ? day(c.lastCreativeAt) : null },
    { label: "Vào thư viện gần nhất", value: c ? day(c.lastLibraryAt) : null },
  ];
}

/** Chi QC 30 ngày: chỉ in khi người xem được đọc; chưa ghép / chưa đọc được ⇒ "—" (luật 67). */
function spendDatum(input: StockFeedbackInput): StockFeedbackDatum[] {
  if (!input.adsVisible) return [];
  const a = input.ads;
  return [{ label: "Chi QC 30 ngày", value: a && a.status === "OK" && a.spend !== null ? formatVND(a.spend) : null }];
}

function pushStock(input: StockFeedbackInput, known: readonly StockFeedbackVariant[], unknownCount: number): StockFeedback | null {
  const push = known.filter((v) => PUSH_DECISIONS.includes(v.decision));
  if (!push.length) return null;

  const ads = input.adsVisible ? input.ads : null;
  const adsCut = ads !== null && ads.status === "OK" && ads.action === "CUT";
  const available = push.reduce((a, v) => a + v.available, 0);
  const velocity = push.reduce((a, v) => a + Math.max(0, v.velocity), 0);
  const sold30 = push.reduce((a, v) => a + v.sold30, 0);
  // Cùng phép chia "khả dụng ÷ tốc độ" của kế hoạch, trên tổng các mẫu mã đang đẩy. Không bán ⇒ không tính.
  const cover = velocity > 0 ? Math.floor(available / velocity) : null;
  const stockValue = sumOrNull(push.map((v) => (v.unitCost === null ? null : Math.max(0, v.available) * v.unitCost)));
  const labels = push.map((v) => `${v.label || "—"} — ${DECISION_LABEL[v.decision]}`).join(" · ");

  let adsLine: string;
  if (!input.adsVisible) adsLine = "";
  else if (adsCut) adsLine = ` Quảng cáo đang lỗ (bảng quyết định /ads kết luận “${ADS_ACTION_LABEL.CUT}”) — đẩy tồn bằng ưu đãi / khách cũ thay vì tăng quảng cáo.`;
  else if (ads === null) adsLine = " Không đọc được quảng cáo của mã — chưa biết quảng cáo đang lời hay lỗ.";
  else if (ads.status !== "OK") adsLine = " Chi quảng cáo chưa ghép về mã — chưa biết quảng cáo đang lời hay lỗ; đừng dựa vào quảng cáo để đẩy tồn trước khi khai ánh xạ chiến dịch.";
  else adsLine = ads.action ? ` Quảng cáo của mã: “${ADS_ACTION_LABEL[ads.action]}”.` : "";

  const creativeLink: StockFeedbackLink = { label: "Làm creative mới cho mẫu tồn", href: creativeGenHref(input.productId) };
  const outreachLink: StockFeedbackLink = { label: "Đẩy qua chăm sóc khách cũ / combo", href: "/outreach" };
  const alternatives: StockFeedbackLink[] = [adsCut ? creativeLink : outreachLink];
  if (input.adsVisible) alternatives.push({ label: "Xem lại quảng cáo đang chạy", href: adsHref() });
  alternatives.push({ label: "Xem quyết định vốn tồn", href: "/inventory/decisions" });

  return {
    kind: "PUSH_STOCK",
    productId: input.productId,
    modelId: input.modelId,
    what: adsCut ? `${input.productCode || input.productName} · tồn chậm, quảng cáo đang lỗ — đẩy bằng ưu đãi / khách cũ` : `${input.productCode || input.productName} · tồn chậm — làm creative mới / đẩy qua khách cũ`,
    why: `Bộ máy quyết định tồn: ${labels}.${adsLine}`,
    data: [
      { label: "Khả dụng", value: formatNumber(available) },
      { label: "Đủ bán", value: cover === null ? null : `${formatNumber(cover)} ngày` },
      { label: "Bán 30 ngày", value: formatNumber(sold30) },
      { label: "Giá trị tồn (ước tính, giá nhập gần nhất)", value: stockValue === null ? null : formatVND(stockValue), estimate: true },
      ...creativeData(input),
      ...spendDatum(input),
    ],
    action: adsCut ? outreachLink : creativeLink,
    alternatives,
    basis: `PUSH_STOCK|${variantBasis(push)}`,
    impact: {
      amountVnd: sumOrNull(push.map((v) => v.capitalFreeable)),
      basis: "Vốn theo giá nhập giải phóng được nếu đẩy hết phần vượt mức (decideInventory). Chưa biết giá nhập ⇒ —.",
    },
    caveat: gateCaveat(input, unknownCount),
  };
}

function scaleBlocked(input: StockFeedbackInput, known: readonly StockFeedbackVariant[], unknownCount: number, insufficient: string[]): StockFeedback | null {
  if (!input.adsVisible) return null;
  const ads = input.ads;
  if (!ads || ads.action !== "SCALE") return null;
  const name = input.productCode || input.productName;
  const risk = known.filter(stockRunsOutBeforeRestock);

  if (ads.status !== "OK") {
    // Lá phiếu SCALE đứng trên số chi CHƯA GHÉP — không phải căn cứ (luật 67). Kho có nguy cơ thì nói ra.
    if (risk.length) insufficient.push(`${name}: quảng cáo đề nghị “${ADS_ACTION_LABEL.SCALE}” nhưng chi chưa ghép về mã — chưa kết luận được; kho của mã đang nguy cơ hết hàng.`);
    return null;
  }
  if (!risk.length) {
    if (input.variants.length > 0 && known.length === 0) insufficient.push(`${name}: quảng cáo đề nghị “${ADS_ACTION_LABEL.SCALE}” nhưng tồn của mã CHƯA BIẾT — chưa kết luận được có đủ hàng để tăng.`);
    return null;
  }

  const covered = risk.filter(openPoCovers);
  const allCovered = covered.length === risk.length;
  const labels = risk.map((v) => `${v.label || "—"} — ${v.decision === "STOCKOUT_RISK" ? DECISION_LABEL.STOCKOUT_RISK : "đủ bán ít hơn thời gian sản xuất"}`).join(" · ");
  const poLine = allCovered
    ? " Lệnh / lô đặt xưởng đang mở đã phủ đủ số nên đặt — không cần đặt thêm, nhưng hàng chưa về thì đơn tăng thêm sẽ phải chờ hàng."
    : covered.length
      ? ` ${formatNumber(covered.length)}/${formatNumber(risk.length)} mẫu mã đã có lệnh đặt xưởng phủ đủ; phần còn lại chưa — đặt sản xuất trước khi tăng ngân sách.`
      : " Chưa có lệnh đặt xưởng phủ đủ — đặt sản xuất trước khi tăng ngân sách.";
  const covers = risk.map((v) => v.daysOfCover).filter((x): x is number => x !== null);
  const leads = risk.map((v) => v.leadTimeDays).filter((x): x is number => x !== null);
  const reorderBy = risk
    .map((v) => v.reorderByDate)
    .filter((x): x is string => !!x)
    .sort()[0];
  const planLink: StockFeedbackLink = { label: "Mở kế hoạch đặt hàng sản xuất", href: "/inventory/planning" };
  const purchasingLink: StockFeedbackLink = { label: "Mở Mua hàng & xưởng", href: "/inventory/purchasing" };

  return {
    kind: "SCALE_BLOCKED_BY_STOCK",
    productId: input.productId,
    modelId: input.modelId,
    what: `${name} · đừng tăng ngân sách — sắp hết hàng`,
    why: `Bảng quyết định /ads (chiều mã hàng, 30 ngày) đề nghị “${ADS_ACTION_LABEL.SCALE}”, nhưng bộ máy tồn: ${labels}. Tăng quảng cáo lúc này là mua đơn cho hàng chưa có.${poLine}`,
    data: [
      { label: "Đủ bán (mẫu mã ngắn nhất)", value: covers.length ? `${formatNumber(Math.floor(Math.min(...covers)))} ngày` : null },
      { label: "Thời gian sản xuất", value: leads.length ? `${formatNumber(Math.max(...leads))} ngày` : null },
      { label: "Đã đặt xưởng", value: formatNumber(risk.reduce((a, v) => a + v.openPoQty, 0)) },
      { label: "Nên đặt thêm (đã trừ hàng đặt xưởng)", value: (() => {
        const q = sumOrNull(risk.map((v) => v.suggestedQty));
        return q === null ? null : formatNumber(q);
      })() },
      { label: "Hạn đặt sớm nhất", value: reorderBy ? formatDate(reorderBy) : null },
      ...spendDatum(input),
    ],
    action: allCovered ? purchasingLink : planLink,
    alternatives: [
      ...(allCovered ? [] : [{ label: "Lập đơn đặt xưởng", href: "/inventory/planning/orders" }]),
      { label: "Mở bảng quyết định quảng cáo", href: adsHref() },
      { label: "Xem quyết định vốn tồn", href: "/inventory/decisions" },
    ],
    basis: `SCALE_BLOCKED_BY_STOCK|SCALE|${allCovered ? "PO_COVERED" : covered.length ? "PO_PARTIAL" : "PO_NONE"}|${variantBasis(risk)}`,
    impact: {
      amountVnd: sumOrNull(risk.map((v) => v.grossImpactEstimate)),
      basis: "ƯỚC TÍNH lãi gộp mất nếu để hết hàng (decideInventory) — tăng ngân sách chỉ làm khoảng trống này lớn hơn. Chưa biết giá ⇒ —.",
    },
    caveat: gateCaveat(input, unknownCount),
  };
}

/**
 * Đề xuất vòng phản hồi cho MỘT mã hàng (= một mẫu). Hàm THUẦN: cùng đầu vào ⇒ cùng đầu ra.
 *
 *  · PUSH_STOCK — có mẫu mã BIẾT tồn mà bộ máy tồn kết luận Đang chôn vốn / Nên xả. Việc chính: làm
 *    creative mới cho mẫu tồn; quảng cáo của mã đang CẮT ⇒ việc chính đổi sang ưu đãi / khách cũ.
 *  · SCALE_BLOCKED_BY_STOCK — quảng cáo đề nghị TĂNG (chi đã ghép) VÀ có mẫu mã BIẾT tồn sẽ hết trước khi
 *    lô mới về. Nói rõ lệnh đặt xưởng đang mở đã phủ hay chưa.
 */
export function deriveStockFeedback(input: StockFeedbackInput): StockFeedbackResult {
  const known = input.variants.filter((v) => v.stockKnown);
  const unknownCount = input.variants.length - known.length;
  const insufficient: string[] = [];
  const recommendations: StockFeedback[] = [];
  const scale = scaleBlocked(input, known, unknownCount, insufficient);
  if (scale) recommendations.push(scale);
  const push = pushStock(input, known, unknownCount);
  if (push) recommendations.push(push);
  return { recommendations, insufficient };
}

/** In một dãy ô số liệu thành một dòng (trang 360): chưa biết ⇒ "—", ước tính mang nhãn. */
export function stockFeedbackDataLine(data: readonly StockFeedbackDatum[]): string {
  return data.map((d) => `${d.label} ${d.value === null || d.value === "" ? "—" : d.value}`).join(" · ");
}

// ─────────────────────────── TRANG MODEL 360: KHỐI "ĐỀ XUẤT" ───────────────────────────

/**
 * Đề xuất nào của `deriveModelSuggestions` (A2) mà một đề xuất vòng phản hồi THAY THẾ:
 *
 *  · SCALE_BLOCKED_BY_STOCK thay "ads-SCALE" — để nguyên thì cùng một khối vừa bảo "Tăng ngân sách" vừa bảo
 *    "Đừng tăng ngân sách". Lá phiếu quảng cáo vẫn được kể lại trong "vì sao" của đề xuất mới.
 *  · PUSH_STOCK thay "inventory-clear" — cùng MỘT kết luận tồn (chôn vốn / nên xả), đề xuất mới mang thêm
 *    creative · khách cũ · quảng cáo; để cả hai là nói một việc hai lần.
 */
export const STOCK_FEEDBACK_SUPERSEDES: Record<StockFeedbackKind, string> = {
  SCALE_BLOCKED_BY_STOCK: "ads-SCALE",
  PUSH_STOCK: "inventory-clear",
};

export function stockFeedbackToSuggestion(f: StockFeedback): ModelSuggestion {
  return {
    key: `stock-${f.kind}`,
    source: "INVENTORY",
    what: STOCK_FEEDBACK_LABEL[f.kind],
    why: f.why,
    data: stockFeedbackDataLine(f.data),
    links: [f.action, ...f.alternatives],
    transition: null,
    caveat: f.caveat,
  };
}

/**
 * Ghép đề xuất vòng phản hồi vào danh sách của trang 360: đề xuất bị thay đứng ĐÚNG chỗ cũ, còn lại nối
 * vào cuối. Hàm thuần, chỉ HIỂN THỊ — không đề xuất nào tự áp.
 */
export function mergeStockFeedbackSuggestions(base: readonly ModelSuggestion[], recs: readonly StockFeedback[]): ModelSuggestion[] {
  const out = [...base];
  for (const f of recs) {
    const s = stockFeedbackToSuggestion(f);
    const at = out.findIndex((x) => x.key === STOCK_FEEDBACK_SUPERSEDES[f.kind]);
    if (at >= 0) out[at] = s;
    else out.push(s);
  }
  return out;
}

// ─────────────────────────── ĐIỂM VÀO CREATIVE: CHỌN SẴN MÃ, KHÔNG TỰ VẼ ───────────────────────────

export type PreselectSource = { id: string; kind: "PRODUCT_PHOTO" | "OWN_AD"; productId: string; productLabel: string };

/**
 * `?product=<id>` trên trang vòng mẫu ⇒ ảnh sản phẩm thật nào được CHỌN SẴN ở khối "Gen ảnh bằng tay".
 * Chỉ là giá trị khởi đầu của một ô chọn — máy KHÔNG vẽ gì cho tới khi người bấm Gen (vẽ ảnh tốn tiền).
 * Mã chưa có ảnh sản phẩm thật ⇒ giữ mặc định cũ (ảnh đầu tiên) và NÓI RA, không lặng lẽ chọn mã khác.
 */
export function manualGenPreselect(sources: readonly PreselectSource[], productId: string | null): { photoId: string; note: string | null } {
  const photos = sources.filter((s) => s.kind === "PRODUCT_PHOTO");
  const fallback = photos[0]?.id ?? "";
  if (!productId) return { photoId: fallback, note: null };
  const hit = photos.find((s) => s.productId === productId);
  if (!hit) return { photoId: fallback, note: "Mã được chọn từ đề xuất chưa có ảnh sản phẩm thật — nhập ảnh ở tab Nguồn ảnh trước, rồi quay lại đây." };
  return { photoId: hit.id, note: `Đã chọn sẵn ảnh của ${hit.productLabel} (từ đề xuất đẩy tồn). Máy CHƯA vẽ gì — bấm Gen khi anh/chị muốn.` };
}

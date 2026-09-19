import {
  MARKETING_DIAGNOSIS as R,
  MARKETING_FINDING_ACTIONS,
  MARKETING_FINDING_BASIS,
  MARKETING_FINDING_LABEL,
  type FindingBasis,
  type FindingSeverity,
  type MarketingFindingKind,
} from "@/lib/constants/marketing-diagnosis";
import { MATURITY } from "@/lib/constants/marketing-daily";

/**
 * ═══════════ MÁY PHÂN TÍCH HIỆU QUẢ MARKETING — HÀM THUẦN ═══════════
 *
 * Không đọc CSDL, không ghi gì, chạy hai lần ra cùng kết quả. Nhờ vậy nó kiểm thử được bằng một
 * bảng chân lý thay vì bằng dữ liệu thật, và nó không bao giờ là nguyên nhân làm một job chậm.
 *
 * ─── VÌ SAO KHÔNG NHÌN TỪNG CHỈ SỐ RIÊNG LẺ ───
 *
 * "CPA tăng" một mình không nói được phải sửa gì: nó có thể là traffic đắt lên (việc của quảng
 * cáo) hoặc tỷ lệ chốt tụt (việc của đội chốt đơn). Hai nguyên nhân ấy sửa ở hai chỗ khác nhau và
 * do hai người khác nhau làm. Nên mỗi phát hiện ở đây là một TỔ HỢP, và câu kết luận phải nói được
 * khâu nào hỏng — nếu không nó chỉ đẩy người đọc đi sửa nhầm chỗ.
 *
 * ─── HAI CỬA TRƯỚC MỌI KẾT LUẬN ───
 *
 *   1. ĐỦ MẪU — dưới ngưỡng tin nhắn / đơn / tiền thì im lặng. Một tỷ lệ chốt tính trên 6 cuộc
 *      hội thoại không mô tả cái gì.
 *   2. ĐỦ ĐỘ CHÍN — phần lớn đơn còn đang đi thì KHÔNG kết luận về tiền. Ngày hôm nay luôn trông
 *      như đang lỗ, vì tiền quảng cáo đã tiêu hết còn hàng thì chưa tới tay ai.
 *
 * Cửa thứ hai là chỗ dễ quên nhất và đắt nhất: bỏ nó thì mỗi sáng ERP sẽ gửi một cảnh báo "hôm qua
 * lỗ" cho mọi ngày, và sau một tuần không ai đọc cảnh báo nữa.
 */

/** Số liệu một kỳ, đã quy về đúng những gì máy phân tích cần. `null` = CHƯA BIẾT, không phải 0. */
export type DiagnoseSnapshot = {
  adSpend: number | null;
  messages: number | null;
  orders: number;
  posRevenue: number;
  deliveredRevenue: number;
  deliveredOrders: number;
  returnedOrders: number;
  finishedOrders: number;
  pendingOrders: number;
  contributionProfit: number | null;
};

export type DiagnoseInput = {
  /** Ngày (hoặc kỳ) đang xét. */
  day: string;
  /** Phạm vi: "" = toàn shop, hoặc "marketer:abc" / "product:Q002". Đi vào khoá chống trùng. */
  scope?: string;
  scopeLabel?: string;
  current: DiagnoseSnapshot;
  /** Nền so sánh — TRUNG BÌNH NGÀY của `baselineDays` ngày liền trước. `null` = chưa đủ nền. */
  baseline: DiagnoseSnapshot | null;
  /** Số ngày lỗ liên tiếp tính tới ngày này (đã tính sẵn ở nơi gọi, nơi có cả dãy ngày). */
  lossStreak?: number;
  /** Nguồn dữ liệu đang cũ — tên nguồn, để nói thẳng thay vì im lặng vẽ biểu đồ. */
  staleSources?: string[];
};

export type MarketingFinding = {
  kind: MarketingFindingKind;
  severity: FindingSeverity;
  basis: FindingBasis;
  title: string;
  scope: string;
  scopeLabel: string;
  day: string;
  /** Câu bằng SỐ THẬT của chính dòng này. Không có câu nào chung chung. */
  evidence: string[];
  actions: string[];
};

/* ───────────────── tiện ích: mọi phép chia đều trả `null` khi mẫu số 0 ───────────────── */

function div(n: number | null, d: number | null): number | null {
  if (n === null || d === null) return null;
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  const v = n / d;
  return Number.isFinite(v) ? v : null;
}

/** Thay đổi TƯƠNG ĐỐI (%) giữa hai giá trị. `null` khi thiếu vế hoặc nền bằng 0. */
function changePct(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

function pct1(v: number | null): string {
  return v === null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 10) / 10}%`;
}

function vnd(v: number | null): string {
  return v === null ? "—" : `${Math.round(v).toLocaleString("vi-VN")}đ`;
}

function ratePoints(delivered: number, returned: number): number | null {
  const finished = delivered + returned;
  return finished ? (delivered / finished) * 100 : null;
}

/** Kết quả tiền của kỳ đã ngã ngũ chưa. Chưa chín ⇒ không kết luận về lãi/lỗ. */
export function isMature(s: DiagnoseSnapshot): boolean {
  const base = s.finishedOrders + s.pendingOrders;
  if (base === 0) return false;
  return s.finishedOrders / base >= MATURITY.tooEarly;
}

/* ───────────────── máy phân tích ───────────────── */

export function diagnose(input: DiagnoseInput): MarketingFinding[] {
  const { current: c, baseline: b } = input;
  const scope = input.scope ?? "";
  const scopeLabel = input.scopeLabel ?? "Toàn shop";
  const out: MarketingFinding[] = [];
  const push = (kind: MarketingFindingKind, severity: FindingSeverity, evidence: string[]) => {
    out.push({
      kind,
      severity,
      basis: MARKETING_FINDING_BASIS[kind],
      title: MARKETING_FINDING_LABEL[kind],
      scope,
      scopeLabel,
      day: input.day,
      evidence,
      actions: MARKETING_FINDING_ACTIONS[kind],
    });
  };

  /*
    NGUỒN CŨ ĐỨNG TRƯỚC MỌI KẾT LUẬN KHÁC.

    Nếu chi quảng cáo chưa đồng bộ thì mọi con số lợi nhuận bên dưới đang thiếu một vế, và một cảnh
    báo "hôm qua lỗ" dựng trên đó sẽ làm người đọc đi cắt đúng chiến dịch đang lãi. Nói ra trước,
    rồi mới nói tiếp.
  */
  if (input.staleSources?.length) {
    push("DATA_STALE", "WARNING", [`Nguồn đang cũ: ${input.staleSources.join(" · ")}.`, "Những con số phụ thuộc nguồn này chưa đầy đủ — đọc kèm cảnh báo, đừng ra quyết định cắt/tăng ngân sách."]);
  }

  /*
    TIÊU TIỀN MÀ KHÔNG RA ĐƠN — cảnh báo NÓNG, và cố ý KHÔNG chờ độ chín.

    Đây là phát hiện duy nhất không cần đơn nào ngã ngũ, vì nó không nói gì về kết quả giao hàng:
    nó nói rằng phễu đã đứt ngay ở đầu. Chờ cho chín là chờ mất trọn một ngày ngân sách.
  */
  if (c.adSpend !== null && c.adSpend >= R.spendNoOrderHot && c.orders === 0) {
    push("SPEND_NO_ORDERS", "CRITICAL", [
      `Đã chi ${vnd(c.adSpend)} nhưng chưa có đơn xác nhận nào.`,
      c.messages === null || c.messages === 0 ? "Cũng không có tin nhắn nào — nhiều khả năng luồng nhận tin đứt, không phải quảng cáo kém." : `Có ${c.messages} tin nhắn nhưng 0 đơn — phễu đứt ở khâu chốt, không phải ở quảng cáo.`,
    ]);
  }

  // Lỗ liên tiếp — chỉ tính trên những ngày ĐÃ ngã ngũ (nơi gọi chịu trách nhiệm lọc).
  if ((input.lossStreak ?? 0) >= R.consecutiveLossDays) {
    push("LOSS_STREAK", "CRITICAL", [`${input.lossStreak} ngày liên tiếp lợi nhuận góp âm (chỉ đếm ngày đã ngã ngũ).`, `Lợi nhuận góp ngày gần nhất: ${vnd(c.contributionProfit)}.`]);
  }

  if (!b) return out; // Chưa đủ nền so sánh ⇒ dừng ở các phát hiện tuyệt đối. Không bịa một nền.

  const enoughSpend = c.adSpend !== null && b.adSpend !== null && c.adSpend >= R.minSpend;
  const enoughMessages = (c.messages ?? 0) >= R.minMessages && (b.messages ?? 0) > 0;
  const enoughOrders = c.orders >= R.minOrders && b.orders > 0;
  const enoughFinished = c.finishedOrders >= R.minFinished && b.finishedOrders >= R.minFinished;

  const spendUp = changePct(c.adSpend, b.adSpend);
  const msgChange = changePct(c.messages, b.messages);
  const deliveredChange = changePct(c.deliveredRevenue, b.deliveredRevenue);

  /* CASE A — chi tăng mạnh mà đầu ra không tăng theo. Vấn đề ở khâu quảng cáo/traffic. */
  if (enoughSpend && spendUp !== null && spendUp >= R.spendSurgePct) {
    const laggards: string[] = [];
    if (msgChange !== null && msgChange < R.outputLagPct) laggards.push(`tin nhắn ${pct1(msgChange)}`);
    if (isMature(c) && deliveredChange !== null && deliveredChange < R.outputLagPct) laggards.push(`doanh thu thực ${pct1(deliveredChange)}`);
    if (laggards.length) {
      push("SPEND_UP_OUTPUT_FLAT", "CRITICAL", [`Chi quảng cáo ${pct1(spendUp)} so với trung bình ${R.baselineDays} ngày (${vnd(c.adSpend)} vs ${vnd(b.adSpend)}).`, `Nhưng ${laggards.join(" và ")} — tiền ra mà hàng không ra theo.`]);
    }
  }

  /* CASE A' — creative mỏi: một tin nhắn đắt lên rõ rệt trong khi tiền vẫn chảy. */
  const cpmNow = div(c.adSpend, c.messages);
  const cpmBase = div(b.adSpend, b.messages);
  const cpmUp = changePct(cpmNow, cpmBase);
  if (enoughSpend && enoughMessages && cpmUp !== null && cpmUp >= R.costPerMessageUpPct) {
    push("CREATIVE_FATIGUE", "WARNING", [`Giá một tin nhắn ${pct1(cpmUp)} (${vnd(cpmNow)} vs ${vnd(cpmBase)}).`, `Trên ${c.messages} tin nhắn của ngày — đủ mẫu để không phải nhiễu.`]);
  }

  /* CASE B — tin nhắn vẫn về nhưng ít đơn hơn hẳn. Vấn đề ở khâu CHỐT, không phải quảng cáo. */
  const closeNow = div(c.orders, c.messages);
  const closeBase = div(b.orders, b.messages);
  const closeDrop = changePct(closeNow, closeBase);
  if (enoughMessages && closeDrop !== null && closeDrop <= -R.closeRateDropPct) {
    push("CLOSE_RATE_DROP", "CRITICAL", [
      `Tỷ lệ chốt ${pct1(closeDrop)} so với nền (${closeNow === null ? "—" : Math.round(closeNow * 1000) / 10}% vs ${closeBase === null ? "—" : Math.round(closeBase * 1000) / 10}%).`,
      `Có ${c.messages} tin nhắn nhưng chỉ ${c.orders} đơn — traffic vẫn về, khâu chốt đang rơi.`,
    ]);
  }

  /* CPA đắt lên — kèm chẩn đoán phân biệt: traffic đắt hay chuyển đổi kém. */
  const cpaNow = div(c.adSpend, c.orders);
  const cpaBase = div(b.adSpend, b.orders);
  const cpaUp = changePct(cpaNow, cpaBase);
  if (enoughSpend && enoughOrders && cpaUp !== null && cpaUp >= R.cpaUpPct) {
    const trafficNormal = cpmUp === null || cpmUp < R.costPerMessageUpPct;
    push("CPA_UP", "WARNING", [
      `Chi phí một đơn ${pct1(cpaUp)} (${vnd(cpaNow)} vs ${vnd(cpaBase)}).`,
      trafficNormal ? "Giá tin nhắn KHÔNG tăng tương ứng ⇒ traffic không phải nguyên nhân chính; nghi ở chuyển đổi tin nhắn → đơn." : `Giá tin nhắn cũng ${pct1(cpmUp)} ⇒ traffic đang đắt lên, sửa ở khâu quảng cáo trước.`,
    ]);
  }

  /* CASE C — đơn vẫn ra nhưng mỗi đơn nhỏ đi. AOV / mix sản phẩm. */
  const aovNow = div(c.posRevenue, c.orders);
  const aovBase = div(b.posRevenue, b.orders);
  const aovDrop = changePct(aovNow, aovBase);
  if (enoughOrders && aovDrop !== null && aovDrop <= -R.aovDropPct) {
    push("AOV_DROP", "WARNING", [`Giá trị đơn trung bình ${pct1(aovDrop)} (${vnd(aovNow)} vs ${vnd(aovBase)}).`, `${c.orders} đơn, doanh số POS ${vnd(c.posRevenue)}.`]);
  }

  /* CASE D — chốt tốt nhưng không giao được. Chất lượng đơn / logistics, KHÔNG phải quảng cáo. */
  const delNow = ratePoints(c.deliveredOrders, c.returnedOrders);
  const delBase = ratePoints(b.deliveredOrders, b.returnedOrders);
  if (enoughFinished && delNow !== null && delBase !== null) {
    const drop = delBase - delNow;
    /*
      TỶ LỆ GIAO THÀNH CÔNG TỤT và TỶ LỆ HOÀN TĂNG là CÙNG MỘT PHÉP TRỪ trên cùng mẫu số — phát ra
      cả hai là gửi một vấn đề hai lần, và một hàng đợi nhân đôi là một hàng đợi không ai đọc.

      Nên chúng chia nhau theo PHẠM VI, đúng như hai tình huống khác nhau mà chúng mô tả:
       · toàn shop / marketer  ⇒ "khâu giao đang hỏng"      — người xử lý là vận hành & chốt đơn;
       · MỘT MÃ HÀNG           ⇒ "mã này đang bị trả về"     — người xử lý là marketing & sản phẩm
         (sai size, sai màu, mô tả quảng cáo không khớp hàng thật).
    */
    const isProductScope = scope.startsWith("product:");
    if (isProductScope && drop >= R.returnUpPoints) {
      push("RETURN_UP", "WARNING", [
        `Tỷ lệ hoàn của ${scopeLabel} tăng ${Math.round(drop * 10) / 10} điểm so với nền.`,
        `${c.returnedOrders}/${c.finishedOrders} đơn đã kết thúc là hoàn.`,
      ]);
    } else if (!isProductScope && drop >= R.deliveryDropPoints) {
      push("DELIVERY_DROP", "CRITICAL", [
        `Tỷ lệ giao thành công ${Math.round(delNow * 10) / 10}% so với nền ${Math.round(delBase * 10) / 10}% — tụt ${Math.round(drop * 10) / 10} điểm.`,
        `Trên ${c.finishedOrders} đơn đã kết thúc. Quảng cáo vẫn ra đơn; tiền đang chết ở khâu giao.`,
      ]);
    }
  }

  /* CASE E — doanh thu tăng mà lợi nhuận tụt: chi phí chạy nhanh hơn doanh thu. */
  const profitChange = changePct(c.contributionProfit, b.contributionProfit);
  if (isMature(c) && enoughOrders && deliveredChange !== null && deliveredChange > 0 && profitChange !== null && profitChange <= -R.profitDropPct) {
    const adsRatio = div(c.adSpend, c.deliveredRevenue);
    const adsRatioBase = div(b.adSpend, b.deliveredRevenue);
    push("COST_OUTRUNS_REVENUE", "CRITICAL", [
      `Doanh thu thực ${pct1(deliveredChange)} nhưng lợi nhuận góp ${pct1(profitChange)}.`,
      `Quảng cáo chiếm ${adsRatio === null ? "—" : `${Math.round(adsRatio * 1000) / 10}%`} doanh thu thực (nền: ${adsRatioBase === null ? "—" : `${Math.round(adsRatioBase * 1000) / 10}%`}).`,
    ]);
  }

  return out;
}

/** Xếp việc cần xử lý trước lên đầu. Cùng mức thì giữ thứ tự phát hiện (ổn định). */
const SEVERITY_ORDER: Record<FindingSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

export function sortFindings(findings: MarketingFinding[]): MarketingFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * SỐ NGÀY LỖ LIÊN TIẾP tính tới ngày cuối của dãy.
 *
 * CHỈ đếm ngày ĐÃ NGÃ NGŨ: một ngày mới, đơn còn đang đi, luôn trông như lỗ vì tiền quảng cáo đã
 * tiêu xong còn hàng chưa tới tay ai. Đếm cả những ngày đó thì chuỗi lỗ gần như không bao giờ đứt
 * và cảnh báo leo thang sẽ kêu mỗi ngày.
 *
 * Ngày CHƯA chín KHÔNG làm đứt chuỗi và cũng không kéo dài chuỗi — nó được bỏ qua, vì nó không
 * mang thông tin nào về việc ngày ấy lãi hay lỗ.
 */
export function lossStreakOf(days: { contributionProfit: number | null; finishedOrders: number; pendingOrders: number }[]): number {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const d = days[i];
    const base = d.finishedOrders + d.pendingOrders;
    const mature = base > 0 && d.finishedOrders / base >= MATURITY.tooEarly;
    if (!mature) continue;
    if (d.contributionProfit !== null && d.contributionProfit < 0) streak += 1;
    else break;
  }
  return streak;
}

/**
 * NỀN SO SÁNH = TRUNG BÌNH NGÀY của N ngày liền trước.
 *
 * Dùng TRUNG BÌNH chứ không phải tổng, vì kỳ so sánh có thể không đủ N ngày (đầu dữ liệu), và một
 * tổng trên 4 ngày đem so với một ngày sẽ luôn ra "hôm nay tụt 75%".
 *
 * Dưới ngưỡng số ngày tối thiểu thì trả `null` — KHÔNG phải một nền yếu. Nền yếu còn tệ hơn không
 * có nền: nó vẫn cho ra kết luận, chỉ là kết luận sai.
 */
export function baselineOf(days: DiagnoseSnapshot[], minDays = 3): DiagnoseSnapshot | null {
  if (days.length < minDays) return null;
  const n = days.length;
  const sum = (pick: (d: DiagnoseSnapshot) => number | null): number | null => {
    let total = 0;
    let seen = 0;
    for (const d of days) {
      const v = pick(d);
      if (v === null) continue;
      total += v;
      seen += 1;
    }
    return seen === 0 ? null : total;
  };
  const avg = (v: number | null) => (v === null ? null : v / n);
  return {
    adSpend: avg(sum((d) => d.adSpend)),
    messages: avg(sum((d) => d.messages)),
    orders: (sum((d) => d.orders) ?? 0) / n,
    posRevenue: (sum((d) => d.posRevenue) ?? 0) / n,
    deliveredRevenue: (sum((d) => d.deliveredRevenue) ?? 0) / n,
    deliveredOrders: (sum((d) => d.deliveredOrders) ?? 0) / n,
    returnedOrders: (sum((d) => d.returnedOrders) ?? 0) / n,
    finishedOrders: (sum((d) => d.finishedOrders) ?? 0) / n,
    pendingOrders: (sum((d) => d.pendingOrders) ?? 0) / n,
    contributionProfit: avg(sum((d) => d.contributionProfit)),
  };
}

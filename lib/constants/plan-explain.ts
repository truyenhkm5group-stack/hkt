import { DELIVERY_RATE_MEASURED, DELIVERY_RATE_SOURCE_LABEL, type DeliveryRateSource } from "@/lib/constants/delivery-rate";
import { computePlan, type PlanInput, type PlanOutput } from "@/lib/constants/planning";
import { formatNumber } from "@/lib/format";

/**
 * ═══════════ DIỄN GIẢI MỘT ĐỀ XUẤT ĐẶT HÀNG ═══════════
 *
 * Một con số "đặt 24 cái" không giúp ai quyết định: người đặt hàng cần biết 24 từ đâu ra, giả định
 * nào đứng sau nó, và nếu giả định sai thì con số đổi bao nhiêu.
 *
 * Hàm này KHÔNG có công thức riêng. Mỗi bước in ra là một trường của `computePlan` (đầu ra đã tính
 * sẵn), còn các kịch bản gọi lại CHÍNH `computePlan` với một đầu vào được đổi đúng một chỗ. Viết
 * lại phép tính ở đây là mở đường cho lời giải thích nói một số, bảng kế hoạch nói số khác —
 * `tests/plan-explain.test.ts` khoá rằng các bước cộng lại ĐÚNG bằng số đề xuất.
 */

/**
 * Các kịch bản độ nhạy. Biên độ (±30% nhịp bán, ±10 điểm GTC) là MINH HOẠ, KHÔNG phải ngưỡng nghiệp
 * vụ: chúng không quyết định màu, tình trạng hay xếp hạng nào — chỉ trả lời "nếu giả định này sai
 * thì phải đặt khác đi bao nhiêu".
 */
export const PLAN_SCENARIOS = [
  { key: "BASE", label: "Như hiện tại" },
  { key: "SLOW", label: "Bán chậm hơn 30%" },
  { key: "FAST", label: "Bán nhanh hơn 30%" },
  { key: "GTC_DOWN", label: "GTC thấp hơn 10 điểm" },
  { key: "GTC_UP", label: "GTC cao hơn 10 điểm" },
  { key: "NO_RESTOCK", label: "Kho không tái nhập kịp hàng hoàn" },
] as const;

export type PlanScenarioKey = (typeof PLAN_SCENARIOS)[number]["key"];

function scenarioInput(key: PlanScenarioKey, i: PlanInput): PlanInput | null {
  const q = i.returnRate ?? 0;
  const peak = i.peakDayQty ?? 0;
  switch (key) {
    case "BASE":
      return i;
    case "SLOW":
      return { ...i, soldInWindow: i.soldInWindow * 0.7, peakDayQty: peak * 0.7 };
    case "FAST":
      return { ...i, soldInWindow: i.soldInWindow * 1.3, peakDayQty: peak * 1.3 };
    // GTC thấp hơn ⇒ tỷ lệ hoàn CAO hơn ⇒ hàng quay về nhiều hơn ⇒ đặt ÍT hơn (và ngược lại).
    case "GTC_DOWN":
      return { ...i, returnRate: Math.min(1, q + 0.1) };
    case "GTC_UP":
      return { ...i, returnRate: Math.max(0, q - 0.1) };
    // Không trừ hàng hoàn của đơn tương lai = số đặt TỐI ĐA nếu kho chậm tái nhập.
    case "NO_RESTOCK":
      return i.returnLagDays === null || i.returnLagDays === undefined ? null : { ...i, returnLagDays: null };
  }
}

export type PlanStep = {
  key: string;
  /** "+" cộng vào · "−" trừ đi · "=" dòng tổng · "↑" điều chỉnh làm tròn / tối thiểu */
  op: "+" | "−" | "=" | "↑";
  label: string;
  qty: number;
  /** Phép tính ra con số, viết bằng chữ và số thật. */
  detail: string;
};

export type PlanScenario = {
  key: PlanScenarioKey;
  label: string;
  suggested: number;
  stockOutDate: string | null;
  reorderByDate: string | null;
};

export type PlanExplainContext = {
  /** GTC (%) của mã hàng theo thang bậc chung, và căn cứ của nó. */
  deliveryRate: number;
  deliverySource: DeliveryRateSource;
  /** ĐVVC trả hàng hoàn về shop sau bao nhiêu ngày — ĐO. `null` = chưa đủ mẫu. */
  vtpReturnLagDays: number | null;
  /** Giả định: kho tái nhập trong bao nhiêu ngày sau khi hàng về. */
  restockDays: number;
};

export type PlanExplanation = {
  /** false = chưa có phiếu nhập: không có đề xuất, chỉ có nhu cầu tham khảo. */
  known: boolean;
  /** Một câu khuyến nghị — đọc câu này là đủ để biết phải làm gì. */
  summary: string;
  /** Hai dòng căn cứ: tốc độ gửi đi, và hao kho ròng sau khi trừ hàng hoàn. */
  basis: string[];
  steps: PlanStep[];
  scenarios: PlanScenario[];
  /** Điều cần biết trước khi tin con số. */
  notes: string[];
  /** Chỉ khi `known = false`: nhu cầu cho kỳ kế hoạch, CHƯA trừ tồn. */
  demandIfUnknown: number | null;
};

const n = (v: number) => formatNumber(v);
const pct = (v: number) => `${formatNumber(Math.round(v * 1000) / 10)}%`;
const dec = (v: number) => formatNumber(Math.round(v * 10) / 10);

/** YYYY-MM-DD → dd/mm/yyyy */
export function fmtDateKey(key: string | null) {
  if (!key) return "—";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

function daysFrom(key: string, today: Date) {
  const t0 = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((new Date(`${key}T00:00:00Z`).getTime() - t0) / 86_400_000);
}

export function explainPlan(input: PlanInput, out: PlanOutput, ctx: PlanExplainContext, today = new Date()): PlanExplanation {
  const W = input.windowDays;
  const L = input.leadTimeDays;
  const C = input.coverDays;
  const S = input.safetyDays;
  const q = input.returnRate ?? 0;
  const r = input.returnRecoveryRate ?? 1;
  const lag = input.returnLagDays ?? null;
  const g = out.velocity;
  const gtcLabel = `GTC ${dec(ctx.deliveryRate)}% (${DELIVERY_RATE_SOURCE_LABEL[ctx.deliverySource].toLowerCase()})`;

  const basis = [
    out.velocityTrimmed
      ? `Gửi đi ${dec(g)} cái/ngày = (${n(Math.round(input.soldInWindow))} cái đơn đã chốt trong ${n(W)} ngày − ${n(Math.round(input.peakDayQty ?? 0))} cái của một ngày đột biến) ÷ ${n(W - 1)} ngày`
      : `Gửi đi ${dec(g)} cái/ngày = ${n(Math.round(input.soldInWindow))} cái của đơn đã chốt trong ${n(W)} ngày qua (gồm cả đơn đang giao và đơn đã hoàn; không tính đơn huỷ)`,
    `Mỗi 100 cái gửi đi: ${gtcLabel} ⇒ ~${n(Math.round(q * 100))} cái hoàn về, ${pct(r)} trong số đó bán lại được ⇒ kho hao ròng ${dec(out.netVelocity)} cái/ngày`,
  ];

  const scenarios: PlanScenario[] = [];
  for (const sc of PLAN_SCENARIOS) {
    const si = scenarioInput(sc.key, input);
    if (!si) continue;
    const o = sc.key === "BASE" ? out : computePlan(si, today);
    scenarios.push({ key: sc.key, label: sc.label, suggested: o.suggested, stockOutDate: o.stockOutDate, reorderByDate: o.reorderByDate });
  }

  // ─── Chưa có phiếu nhập: KHÔNG đề xuất (xem `computePlan`), chỉ nói nhu cầu và việc phải làm ───
  if (input.stockKnown === false) {
    const demand = computePlan({ ...input, stockKnown: true, stock: 0, committed: 0, inTransit: 0, awaitingReturn: 0, minOrderQty: 0, roundTo: 1 }, today).target;
    return {
      known: false,
      summary: `Chưa có phiếu nhập nào nên ERP không biết kho còn bao nhiêu — không đề xuất số đặt.${input.committed ? ` Đang có ${n(input.committed)} cái của đơn đã chốt chờ xuất.` : ""} Kiểm đếm kho rồi lập phiếu nhập để ERP tính được.`,
      basis,
      steps: [],
      scenarios: [],
      notes: [`Nhu cầu tham khảo cho ${n(L + C + S)} ngày tới, đã trừ hàng hoàn về kịp nhưng CHƯA trừ tồn (vì chưa biết tồn): ${n(demand)} cái.`],
      demandIfUnknown: demand,
    };
  }

  const steps: PlanStep[] = [];
  const coverPart = out.target + out.futureReturnCredit - out.safetyStock - out.leadTimeDemand;
  steps.push({ key: "lead", op: "+", label: `Sẽ gửi đi trong ${n(L)} ngày chờ xưởng sản xuất`, qty: out.leadTimeDemand, detail: `${dec(g)} × ${n(L)} ngày` });
  steps.push({ key: "cover", op: "+", label: `Sẽ gửi đi trong ${n(C)} ngày muốn đủ bán sau khi hàng về`, qty: coverPart, detail: `${dec(g)} × ${n(C)} ngày` });
  steps.push({ key: "safety", op: "+", label: `Dự phòng ${n(S)} ngày (bán vượt dự báo)`, qty: out.safetyStock, detail: `${dec(g)} × ${n(S)} ngày` });
  if (out.futureReturnCredit > 0 && lag !== null) {
    steps.push({
      key: "future-returns",
      op: "−",
      label: "Hàng của chính các đơn ấy hoàn về kịp bán lại",
      qty: out.futureReturnCredit,
      detail: `${dec(g)} × ${pct(q)} hoàn × ${pct(r)} bán lại được × ${dec(Math.max(0, L + C + S - lag))} ngày (đơn gửi trước khi hết kỳ ${dec(lag)} ngày mới kịp về)`,
    });
  }
  steps.push({ key: "target", op: "=", label: "Cần có trong tay", qty: out.target, detail: out.futureReturnCredit > 0 ? "gửi đi − hàng hoàn về kịp" : "tổng các dòng trên" });
  if (out.available >= 0) {
    steps.push({ key: "available", op: "−", label: "Đã có: khả dụng hôm nay", qty: out.available, detail: `tồn thực tế ${n(input.stock)} − chờ xuất ${n(input.committed)}` });
  } else {
    steps.push({ key: "available", op: "+", label: "Bù đơn đã chốt mà kho chưa có hàng", qty: -out.available, detail: `chờ xuất ${n(input.committed)} − tồn thực tế ${n(input.stock)}` });
  }
  if (input.countIncoming !== false) {
    if (out.incomingFromReturns) {
      steps.push({ key: "returns", op: "−", label: "Hàng hoàn đang chờ về kho", qty: out.incomingFromReturns, detail: `${n(input.awaitingReturn ?? 0)} cái × ${pct(r)} bán lại được` });
    }
    if (out.incomingFromTransit) {
      steps.push({ key: "transit", op: "−", label: "Hàng đang giao ước sẽ hoàn về", qty: out.incomingFromTransit, detail: `${n(input.inTransit ?? 0)} cái × ${pct(q)} hoàn × ${pct(r)} bán lại được` });
    }
  }
  const raw = Math.max(0, out.target - out.supply);
  steps.push({ key: "gap", op: "=", label: raw > 0 ? "Còn thiếu so với mức cần có" : "Đã đủ — không thiếu", qty: raw, detail: out.target - out.supply < 0 ? `đang dư ${n(out.supply - out.target)} cái so với mức cần có` : "cần có − đã có" });
  if (out.suggestedBeforeMoq !== raw) {
    steps.push({ key: "round", op: "↑", label: `Làm tròn lên bội số ${n(input.roundTo)}`, qty: out.suggestedBeforeMoq, detail: "theo Giả định kế hoạch" });
  }
  if (out.moqApplied) {
    steps.push({ key: "moq", op: "↑", label: "Nâng lên mức đặt tối thiểu của xưởng", qty: out.suggested, detail: `nhu cầu thật chỉ ${n(out.suggestedBeforeMoq)} cái — ${n(out.suggested - out.suggestedBeforeMoq)} cái chênh là do xưởng` });
  }

  // ─── Câu khuyến nghị ───
  let summary: string;
  if (out.suggested > 0) {
    const han = out.reorderByDate
      ? daysFrom(out.reorderByDate, today) < 0
        ? `ngay — hạn đặt để kịp hàng đã qua từ ${fmtDateKey(out.reorderByDate)}`
        : `trước ${fmtDateKey(out.reorderByDate)} (còn ${n(daysFrom(out.reorderByDate, today))} ngày)`
      : "khi thuận tiện";
    const het = out.available <= 0
      ? out.shortage > 0 ? ` Hiện đang thiếu ${n(out.shortage)} cái cho đơn đã chốt.` : " Hiện đã hết hàng bán."
      : out.stockOutDate ? ` Không đặt thì dự kiến hết hàng khoảng ${fmtDateKey(out.stockOutDate)}.` : "";
    summary = `Đặt ${n(out.suggested)} cái ${han}.${het}`;
  } else if (out.available < 0) {
    // Hôm nay đang THIẾU nhưng hàng hoàn đang về đủ bù: không cần đặt thêm, nhưng việc cần làm là
    // tái nhập hàng hoàn cho nhanh — nói cả hai, nếu không nhãn "Hết hàng" và câu "chưa cần đặt"
    // trông như mâu thuẫn nhau.
    summary = `Chưa cần đặt thêm: đang thiếu ${n(out.shortage)} cái cho đơn đã chốt, nhưng ${n(out.incoming)} cái hàng hoàn đang về đủ bù — việc cần làm là tái nhập hàng hoàn sớm.`;
  } else if (g <= 0) {
    summary = `Chưa cần đặt: không có đơn nào trong ${n(W)} ngày qua.`;
  } else {
    summary = `Chưa cần đặt: hàng đang có${out.incoming ? " cộng hàng hoàn sắp về" : ""} đã vượt mức cần có ${n(out.target)} cái${out.daysOfCoverWithIncoming !== null ? ` — đủ bán khoảng ${n(Math.floor(out.daysOfCoverWithIncoming))} ngày` : ""}.`;
  }

  const notes: string[] = [];
  if (!DELIVERY_RATE_MEASURED[ctx.deliverySource]) {
    notes.push(`GTC ${dec(ctx.deliveryRate)}% của mã này CHƯA phải số đo (${DELIVERY_RATE_SOURCE_LABEL[ctx.deliverySource].toLowerCase()}). Xem kịch bản GTC ±10 điểm trước khi chốt.`);
  }
  if (lag === null) {
    notes.push("Chưa đo được ĐVVC trả hàng hoàn mất bao lâu ⇒ CHƯA trừ hàng hoàn của đơn mới (thận trọng — có thể đặt dư một chút).");
  } else if (out.futureReturnCredit > 0) {
    const noRestock = scenarios.find((x) => x.key === "NO_RESTOCK");
    notes.push(`Đã trừ ${n(out.futureReturnCredit)} cái hàng hoàn của đơn mới, giả định ĐVVC trả về sau ${dec(ctx.vtpReturnLagDays ?? 0)} ngày (đo) và kho tái nhập trong ${n(ctx.restockDays)} ngày (Giả định). Kho chậm hơn thì cần đặt tới ${n(noRestock?.suggested ?? out.suggested)} cái.`);
  }
  if (out.velocityTrimmed) {
    notes.push(`Đã bỏ một ngày đột biến (${n(Math.round(input.peakDayQty ?? 0))} cái) khỏi tốc độ — nếu tính cả thì ${dec(out.rawVelocity)} cái/ngày. Nếu đó là nhịp mới (quảng cáo tăng, livestream đều) thì xem kịch bản "bán nhanh".`);
  }
  if (input.countIncoming !== false && out.incoming > 0) {
    notes.push(`${n(out.incoming)} cái hàng hoàn đang về là ƯỚC LƯỢNG theo tỷ lệ thật của shop — hàng về hỏng nhiều hơn thường lệ thì cần đặt thêm tối đa ${n(out.incoming)} cái.`);
  }
  if (out.moqApplied) notes.push(`Xưởng nhận tối thiểu ${n(out.suggested)} cái; nhu cầu thật ${n(out.suggestedBeforeMoq)} cái — phần dư sẽ nằm kho lâu hơn.`);
  const vals = scenarios.map((x) => x.suggested);
  if (vals.length > 1 && Math.min(...vals) !== Math.max(...vals)) {
    notes.push(`Qua các kịch bản, số đặt dao động ${n(Math.min(...vals))}–${n(Math.max(...vals))} cái.`);
  }

  return { known: true, summary, basis, steps, scenarios, notes, demandIfUnknown: null };
}

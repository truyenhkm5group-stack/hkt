import { OWN_AD_IMPORT } from "@/lib/constants/creative-loop";

/**
 * ═══════════ XẾP HẠNG TƯƠNG ĐỐI QUẢNG CÁO CŨ CỦA SHOP (hàm thuần, dùng được ở client) ═══════════
 *
 * Chủ nền tảng chốt 04/10/2026 cho tổ chức khách (Hải Sản Làng Chài trước tiên): mẫu thắng là mẩu có
 * «chi phí / tin nhắn rẻ, số tiền đã chi tiêu nhiều, có nhiều lượt mua, chi phí lượt mua rẻ (theo Meta)».
 *
 * ─── VÌ SAO KHÔNG DÙNG NGƯỠNG TIỀN ───
 *
 * `classifyOwnAd()` của nhà chấm bằng ngưỡng TUYỆT ĐỐI (chi / tin < 4.000đ, chi ≥ 50.000đ) — chỉnh cho
 * thời trang. Hải sản bán giá khác, tin nhắn đắt khác; mang con số đó sang là chấm "kém" mọi mẩu của họ
 * vì một ngành khác (AGENTS.md mục 38: đích là quyết định kinh doanh, không phải hằng số). Và nhánh
 * THẮNG của nhà cần đơn ERP mang `ad_id` — đơn của tổ chức khách không có.
 *
 * Nên ở đây chỉ có THỨ HẠNG: mỗi chỉ số đổi thành phần trăm thứ hạng TRONG CHÍNH các mẩu của tổ chức
 * (0 = kém nhất nhóm, 1 = tốt nhất nhóm, hoà chia đều), điểm = trung bình các phần trăm có được × 100.
 * Không có con số VND nào quyết định "đạt / không đạt".
 *
 * ─── CHƯA ĐỦ DỮ LIỆU ≠ KÉM (mục 39) ───
 *
 * Mẩu dưới `OWN_AD_IMPORT.minMessages` sự kiện (tin nhắn + lượt mua Meta) mang nhãn `INSUFFICIENT_DATA`
 * và KHÔNG có điểm — năm sự kiện là SÀN CỠ MẪU (tỷ lệ trên vài sự kiện là may rủi), không phải ngưỡng
 * hiệu quả. Chi / tin nhắn chỉ tính khi đủ chừng ấy tin; chi / lượt mua khi có ít nhất một lượt mua.
 * Chỉ số vắng ở một mẩu thì KHÔNG phạt mẩu đó (không điền 0 — mục 42): điểm của nó là trung bình các
 * chỉ số nó có. Chỉ số mà cả nhóm không phân biệt được (dưới 2 mẩu có số, hoặc mọi mẩu bằng nhau) bị bỏ
 * khỏi phép tính cho CẢ nhóm và được nêu tên ở `metricsSkipped`.
 */

export type OwnAdMode = "CLASSIFY" | "RANK";

/**
 * Chọn cách chọn mẫu. Tổ chức CÓ đơn quy về `ad_id` (tổ chức nhà) ⇒ giữ nguyên luật cũ `classifyOwnAd`
 * (THẮNG theo đơn ERP · TỐT theo chi / tin). Không có ⇒ xếp hạng tương đối — luật cũ ở đó chỉ còn lại
 * ngưỡng tiền của một ngành khác.
 */
export function decideOwnAdMode(hasErpAdAttribution: boolean): OwnAdMode {
  return hasErpAdAttribution ? "CLASSIFY" : "RANK";
}

export const OWN_AD_RANK_METRICS = ["spend", "costPerMessage", "metaPurchases", "costPerMetaPurchase"] as const;
export type OwnAdRankMetric = (typeof OWN_AD_RANK_METRICS)[number];

export const OWN_AD_RANK_METRIC_LABEL: Record<OwnAdRankMetric, string> = {
  spend: "Đã chi",
  costPerMessage: "Chi / tin nhắn",
  metaPurchases: "Lượt mua (Meta)",
  costPerMetaPurchase: "Chi / lượt mua (Meta)",
};

/** `UP` = càng cao càng tốt · `DOWN` = càng thấp càng tốt. */
export const OWN_AD_RANK_DIRECTION: Record<OwnAdRankMetric, "UP" | "DOWN"> = {
  spend: "UP",
  costPerMessage: "DOWN",
  metaPurchases: "UP",
  costPerMetaPurchase: "DOWN",
};

export type OwnAdRankStatus = "RANKED" | "INSUFFICIENT_DATA";

export const OWN_AD_RANK_STATUS_LABEL: Record<OwnAdRankStatus, string> = { RANKED: "Đã xếp hạng", INSUFFICIENT_DATA: "Chưa đủ dữ liệu" };

export type OwnAdRankInput = { id: string; spendVnd: number | null; messages: number | null; metaPurchases: number | null };

export type OwnAdRankValues = { spendVnd: number | null; costPerMessageVnd: number | null; metaPurchases: number | null; costPerMetaPurchaseVnd: number | null };

export type OwnAdRank = {
  status: OwnAdRankStatus;
  /** 0–100, `null` khi chưa đủ dữ liệu. */
  score: number | null;
  /** Hạng 1 = điểm cao nhất trong nhóm; `null` khi chưa đủ dữ liệu. */
  rank: number | null;
  /** Phần trăm thứ hạng 0–1 của từng chỉ số; `null` = mẩu không có chỉ số ấy hoặc chỉ số bị bỏ cho cả nhóm. */
  percentiles: Record<OwnAdRankMetric, number | null>;
  values: OwnAdRankValues;
  insufficientReason: string | null;
};

export type OwnAdRanking = {
  byId: Map<string, OwnAdRank>;
  /** Thứ tự hiển thị: mẩu đã xếp hạng theo hạng, rồi mẩu chưa đủ dữ liệu theo số chi giảm dần. */
  order: string[];
  metricsUsed: OwnAdRankMetric[];
  metricsSkipped: { metric: OwnAdRankMetric; reason: string }[];
  ranked: number;
  insufficient: number;
  /** Sàn cỡ mẫu đã dùng (tin nhắn + lượt mua). */
  minEvents: number;
};

function valuesOf(x: OwnAdRankInput, minEvents: number): OwnAdRankValues {
  const spend = x.spendVnd !== null && Number.isFinite(x.spendVnd) ? x.spendVnd : null;
  const messages = x.messages !== null && Number.isFinite(x.messages) ? x.messages : null;
  const purchases = x.metaPurchases !== null && Number.isFinite(x.metaPurchases) ? x.metaPurchases : null;
  return {
    spendVnd: spend,
    costPerMessageVnd: spend !== null && messages !== null && messages >= minEvents ? Math.round(spend / messages) : null,
    metaPurchases: purchases,
    costPerMetaPurchaseVnd: spend !== null && purchases !== null && purchases > 0 ? Math.round(spend / purchases) : null,
  };
}

function metricValue(v: OwnAdRankValues, m: OwnAdRankMetric): number | null {
  if (m === "spend") return v.spendVnd;
  if (m === "costPerMessage") return v.costPerMessageVnd;
  if (m === "metaPurchases") return v.metaPurchases;
  return v.costPerMetaPurchaseVnd;
}

/**
 * Phần trăm thứ hạng của từng giá trị trong nhóm: (số mẩu KÉM hơn + nửa số mẩu hoà) / (n − 1).
 * Kém hơn theo chiều của chỉ số. Hoà ⇒ cùng phần trăm (trung bình hạng), để thứ tự trong mảng đầu vào
 * không đổi được điểm.
 */
function percentileRanks(entries: { id: string; value: number }[], direction: "UP" | "DOWN"): Map<string, number> {
  const out = new Map<string, number>();
  const n = entries.length;
  for (const e of entries) {
    let worse = 0;
    let ties = 0;
    for (const o of entries) {
      if (o.id === e.id) continue;
      if (o.value === e.value) ties += 1;
      else if (direction === "UP" ? o.value < e.value : o.value > e.value) worse += 1;
    }
    out.set(e.id, (worse + ties / 2) / (n - 1));
  }
  return out;
}

export function rankOwnAds(inputs: readonly OwnAdRankInput[], opts: { minEvents?: number } = {}): OwnAdRanking {
  const minEvents = opts.minEvents ?? OWN_AD_IMPORT.minMessages;
  const byId = new Map<string, OwnAdRank>();
  const vals = new Map<string, OwnAdRankValues>();
  const sufficient: string[] = [];
  for (const x of inputs) {
    const v = valuesOf(x, minEvents);
    vals.set(x.id, v);
    const events = (x.messages ?? 0) + (x.metaPurchases ?? 0);
    const reason =
      v.spendVnd === null || v.spendVnd <= 0
        ? "Chưa có số chi của mẩu này."
        : events < minEvents
          ? `Mới có ${events} sự kiện (tin nhắn + lượt mua Meta), dưới ${minEvents} — tỷ lệ trên vài sự kiện là may rủi.`
          : null;
    if (reason === null) sufficient.push(x.id);
    byId.set(x.id, {
      status: "INSUFFICIENT_DATA",
      score: null,
      rank: null,
      percentiles: { spend: null, costPerMessage: null, metaPurchases: null, costPerMetaPurchase: null },
      values: v,
      insufficientReason: reason,
    });
  }

  const metricsUsed: OwnAdRankMetric[] = [];
  const metricsSkipped: { metric: OwnAdRankMetric; reason: string }[] = [];
  for (const m of OWN_AD_RANK_METRICS) {
    const entries = sufficient.map((id) => ({ id, value: metricValue(vals.get(id) as OwnAdRankValues, m) })).filter((e): e is { id: string; value: number } => e.value !== null);
    if (entries.length < 2) {
      metricsSkipped.push({ metric: m, reason: `Dưới 2 mẩu có số đo này (${entries.length}) — chưa có gì để so.` });
      continue;
    }
    if (entries.every((e) => e.value === entries[0].value)) {
      metricsSkipped.push({ metric: m, reason: "Mọi mẩu bằng nhau ở chỉ số này — không phân biệt được." });
      continue;
    }
    metricsUsed.push(m);
    for (const [id, p] of percentileRanks(entries, OWN_AD_RANK_DIRECTION[m])) (byId.get(id) as OwnAdRank).percentiles[m] = p;
  }

  for (const id of sufficient) {
    const r = byId.get(id) as OwnAdRank;
    const ps = metricsUsed.map((m) => r.percentiles[m]).filter((p): p is number => p !== null);
    if (ps.length === 0) {
      r.insufficientReason = "Chưa có mẩu khác đủ số đo để so.";
      continue;
    }
    r.status = "RANKED";
    r.insufficientReason = null;
    r.score = Math.round((ps.reduce((t, p) => t + p, 0) / ps.length) * 100);
  }

  const spendOf = (id: string) => (byId.get(id) as OwnAdRank).values.spendVnd ?? -1;
  const ranked = [...byId.entries()]
    .filter(([, r]) => r.status === "RANKED")
    .sort(([a, ra], [b, rb]) => (rb.score ?? 0) - (ra.score ?? 0) || spendOf(b) - spendOf(a) || a.localeCompare(b))
    .map(([id]) => id);
  ranked.forEach((id, i) => ((byId.get(id) as OwnAdRank).rank = i + 1));
  const rest = [...byId.entries()]
    .filter(([, r]) => r.status !== "RANKED")
    .map(([id]) => id)
    .sort((a, b) => spendOf(b) - spendOf(a) || a.localeCompare(b));

  return { byId, order: [...ranked, ...rest], metricsUsed, metricsSkipped, ranked: ranked.length, insufficient: rest.length, minEvents };
}

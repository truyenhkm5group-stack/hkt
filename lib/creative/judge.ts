import {
  RULE_METRIC_LABEL,
  type CreativeLoopConfig,
  type CreativeRule,
  type CreativeVerdict,
  type RuleMetric,
  type VariantStatus,
} from "@/lib/constants/creative-loop";

/**
 * ═══════════ CHẤM MỘT MẪU — HÀM THUẦN ═══════════
 *
 * Vào: số đo của MỘT mẫu + cấu hình + giờ hiện tại. Ra: phán quyết + lý do đọc được.
 * Không đọc CSDL, không gọi mạng, không đọc đồng hồ ngoài `now` — chạy hai lần ra cùng kết quả.
 *
 * ─── THỨ TỰ XÉT, VÀ VÌ SAO ───
 *
 *  1. `WIN` trước mọi thứ, và đã vào thư viện thì KHÔNG tự rơi ra. Một mẫu đã đạt ngưỡng rồi bị huỷ
 *     vài đơn không làm nó hết là mẫu đã chứng minh được — màn hình in số hiện tại bên cạnh.
 *  2. Chưa đăng ⇒ `PENDING`. Không có số chi (CHƯA BIẾT) ⇒ không luật nào được xét.
 *  3. `KILL` xét ĐƯỢC trong khung test — đó là cả mục đích của luật tắt sớm. Luật tắt đọc
 *     `killRuleOrders` thay cho `bookedOrders` khi có (hàng rào của lượt ghi Facebook tự động).
 *  4. Hết khung test nhưng chưa qua `verdictSettleHours` ⇒ `AWAITING_ORDERS`: khách nhắn tin hôm nay
 *     chốt đơn ngày mai, và kết luận LOẠI ở nửa đêm là loại một mẫu trước khi đơn của nó kịp về.
 *  5. Đã ngã ngũ: không có luật GIỮ ⇒ `UNJUDGED` (thiếu căn cứ, KHÔNG phải mẫu kém); qua hết luật
 *     giữ ⇒ `PROMISING`; còn lại ⇒ `LOSE`.
 *
 * ─── CHƯA BIẾT KHÔNG PHẢI 0 (mục 42) ───
 *
 * Tỷ số có mẫu số 0 là `null`, và luật trên chỉ số `null` KHÔNG kích hoạt — kể cả luật tắt. Muốn
 * tắt mẫu "tiêu 150K mà 0 tin nhắn" thì viết luật trên SỐ ĐẾM `messages`, không trên tỷ số.
 */

export type VariantMetrics = {
  /** `null` = chưa có dòng chi cấp mẩu nào (chưa đồng bộ, hoặc chưa chạy) — CHƯA BIẾT, không phải 0. */
  spendVnd: number | null;
  impressions: number | null;
  clicks: number | null;
  messages: number | null;
  /** Đơn chốt (không huỷ) quy về mẩu QC này qua `ORDER_AD_ID` (ad_id Pancake gửi, hoặc bài viết chỉ thuộc đúng MỘT mẩu). */
  bookedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  /**
   * SỐ ĐƠN MÀ LUẬT TẮT ĐƯỢC NHÌN — tách khỏi `bookedOrders`, và đó là một hàng rào tiền.
   *
   * Luật tắt là đường DUY NHẤT mà số đơn tự dẫn tới một lượt GHI Facebook (tạm dừng nhóm QC) không
   * có người bấm ở từng lượt. Người duyệt lô đã cho phép luật ấy khi "đơn" còn nghĩa là đơn mang
   * `ad_id`. Đổi định nghĩa đơn (thêm đường qua bài viết, 25/09/2026) thì một luật `costPerOrder`
   * đang ở trạng thái CHƯA BIẾT (0 đơn ⇒ mẫu số 0) có thể bỗng kích hoạt — tức máy tự tắt một mẫu
   * theo một định nghĩa người duyệt chưa từng thấy. Nên luật tắt đọc con số này; `undefined` ⇒
   * dùng `bookedOrders` (hành vi cũ của mọi nơi gọi không truyền nó).
   *
   * Chuyển luật tắt sang định nghĩa mới là QUYẾT ĐỊNH của chủ shop (HUMAN GATE), không phải một
   * lần tái cấu trúc — xem `KILL_RULE_ORDER_BASIS` trong `lib/queries/creative-loop.ts`.
   */
  killRuleOrders?: number;
};

export type JudgeInput = {
  status: VariantStatus;
  /** Khung test của lô. `null` khi mẫu chưa được đăng. */
  startAt: Date | null;
  endAt: Date | null;
  /** Đã vào thư viện (chốt `WIN`) từ lúc nào. */
  libraryAt: Date | null;
  metrics: VariantMetrics;
};

export type JudgeResult = {
  verdict: CreativeVerdict;
  /** Câu tiếng Việt cho người đọc — không in công thức. */
  reasons: string[];
  /** Luật tắt đã kích hoạt (nếu có) — để máy tắt đúng mẫu và ghi đúng lý do. */
  firedKillRule: CreativeRule | null;
  /** Kết quả từng luật giữ, để màn hình nói mẫu hụt ở luật nào. */
  keepChecks: { rule: CreativeRule; value: number | null; pass: boolean | null }[];
};

/** Giá trị của một chỉ số. Mẫu số 0 hoặc thiếu ⇒ `null`. */
export function metricValue(m: VariantMetrics, metric: RuleMetric): number | null {
  const div = (a: number | null, b: number | null, k = 1) => (a === null || b === null || b === 0 ? null : (a / b) * k);
  switch (metric) {
    case "spend":
      return m.spendVnd;
    case "impressions":
      return m.impressions;
    case "clicks":
      return m.clicks;
    case "messages":
      return m.messages;
    case "orders":
      return m.bookedOrders;
    case "cpm":
      return div(m.spendVnd, m.impressions, 1000);
    case "ctr":
      return div(m.clicks, m.impressions, 100);
    case "cpc":
      return div(m.spendVnd, m.clicks);
    case "costPerMessage":
      return div(m.spendVnd, m.messages);
    case "costPerOrder":
      return div(m.spendVnd, m.bookedOrders);
  }
}

/**
 * CHI / ĐƠN CHỐT làm BẰNG CHỨNG cạnh phán quyết — CHÍNH `metricValue(…, "costPerOrder")` mà luật dùng,
 * làm tròn về đồng. Chỉ để hiển thị; không ngưỡng nào đọc hàm này. `null` = chi CHƯA BIẾT hoặc 0 đơn.
 */
export function costPerOrderOf(m: VariantMetrics): number | null {
  const v = metricValue(m, "costPerOrder");
  return v === null ? null : Math.round(v);
}

/** `true` / `false` / `null` (chưa đủ chi để xét, hoặc chỉ số CHƯA BIẾT). */
export function evalRule(m: VariantMetrics, rule: CreativeRule): { value: number | null; pass: boolean | null } {
  const value = metricValue(m, rule.metric);
  if (m.spendVnd === null || m.spendVnd < rule.minSpendVnd || value === null) return { value, pass: null };
  const pass = rule.op === "gt" ? value > rule.value : rule.op === "gte" ? value >= rule.value : rule.op === "lt" ? value < rule.value : value <= rule.value;
  return { value, pass };
}

const OP_TEXT = { gt: ">", gte: "≥", lt: "<", lte: "≤" } as const;

export function describeRule(rule: CreativeRule): string {
  return rule.label || `${RULE_METRIC_LABEL[rule.metric]} ${OP_TEXT[rule.op]} ${rule.value.toLocaleString("vi-VN")} (sau khi chi ${rule.minSpendVnd.toLocaleString("vi-VN")}đ)`;
}

export function judgeVariant(input: JudgeInput, cfg: Pick<CreativeLoopConfig, "killRules" | "keepRules" | "winOrdersAbove" | "verdictSettleHours">, now: Date): JudgeResult {
  const m = input.metrics;
  const keepChecks = cfg.keepRules.map((rule) => ({ rule, ...evalRule(m, rule) }));
  const out = (verdict: CreativeVerdict, reasons: string[], firedKillRule: CreativeRule | null = null): JudgeResult => ({ verdict, reasons, firedKillRule, keepChecks });

  if (input.libraryAt) {
    const note = m.bookedOrders > cfg.winOrdersAbove ? [] : [`Hiện đếm được ${m.bookedOrders} đơn chốt quy về mẫu — ít hơn lúc vào thư viện (đơn bị huỷ, đổi quy kết, hoặc chưa đồng bộ; máy không biết là cái nào).`];
    return out("WIN", [`Đã vào thư viện: vượt ${cfg.winOrdersAbove} đơn chốt.`, ...note]);
  }
  if (m.bookedOrders > cfg.winOrdersAbove) return out("WIN", [`${m.bookedOrders} đơn chốt — vượt ngưỡng ${cfg.winOrdersAbove}.`]);

  if (!input.startAt || !input.endAt || !["LIVE", "PAUSED", "ENDED"].includes(input.status)) return out("PENDING", ["Mẫu chưa được đăng."]);
  if (now < input.startAt) return out("PENDING", ["Chưa tới giờ chạy."]);
  if (m.spendVnd === null) {
    const ended = now >= input.endAt;
    return out(ended ? "UNJUDGED" : "RUNNING", ["Chưa có số chi cấp mẩu cho mẫu này — CHƯA BIẾT, không kết luận."]);
  }

  // Luật TẮT: xét cả trong lẫn sau khung test. Mẫu đã bị tắt thì vẫn trả KILL để lịch sử đọc được.
  // Luật tắt đọc `killRuleOrders` (xem kiểu `VariantMetrics`) — đổi định nghĩa đơn không được tự
  // sinh một lượt ghi Facebook mà người duyệt lô chưa từng cho phép.
  const killView: VariantMetrics = m.killRuleOrders === undefined ? m : { ...m, bookedOrders: m.killRuleOrders };
  for (const rule of cfg.killRules) {
    const r = evalRule(killView, rule);
    if (r.pass === true) return out("KILL", [`Kích hoạt luật tắt: ${describeRule(rule)}.`], rule);
  }
  // Mẫu do NGƯỜI tắt (hoặc tắt bởi một luật đã bị gỡ khỏi cấu hình) đi tiếp để kết luận theo luật giữ.
  const ended = input.status !== "LIVE" || now >= input.endAt;
  if (!ended) return out("RUNNING", ["Đang trong khung test."]);

  // Đợi đơn về tính từ cuối KHUNG, kể cả mẫu tắt sớm: tin nhắn trước lúc tắt vẫn đang chốt dần.
  const settleAt = input.endAt.getTime() + cfg.verdictSettleHours * 3_600_000;
  if (now.getTime() < settleAt) return out("AWAITING_ORDERS", [`Hết khung test — đợi ${cfg.verdictSettleHours} giờ cho đơn từ tin nhắn về rồi mới kết luận.`]);

  if (cfg.keepRules.length === 0) return out("UNJUDGED", ["Chưa khai luật GIỮ — máy không được tự kết luận mẫu tốt hay kém."]);
  const unknown = keepChecks.filter((c) => c.pass === null);
  if (keepChecks.every((c) => c.pass === true)) return out("PROMISING", ["Qua mọi luật giữ — đề nghị cho tiêu thêm."]);
  const failed = keepChecks.filter((c) => c.pass === false);
  if (failed.length > 0) return out("LOSE", failed.map((c) => `Hụt luật giữ: ${describeRule(c.rule)}.`));
  return out("UNJUDGED", unknown.map((c) => `Chưa đủ căn cứ cho luật: ${describeRule(c.rule)}.`));
}

/**
 * ═══════════ PHÁT LẠI HỘI THOẠI CŨ (HISTORICAL REPLAY) — HÀM THUẦN, DÙNG ĐƯỢC Ở CLIENT ═══════════
 *
 * Câu hỏi của màn này: "nếu AI (cấu hình + lời nhắc + sổ tay HÔM NAY) đứng ở đúng chỗ ấy của một hội thoại thật, nó sẽ nói
 * gì — và câu đó có căn cứ không?". Chấm bằng LUẬT TẤT ĐỊNH đọc được, không dùng một AI thứ hai làm giám khảo:
 *  · `ERROR` — lượt AI hỏng (không có câu trả lời);
 *  · `EMPTY_REPLY` — AI không nói gì với khách;
 *  · `PRICE_UNGROUNDED` — câu AI có số tiền KHÔNG nằm trong tập căn cứ (giá bảng của mẫu mã · số do công cụ trả trong
 *    lượt · phí ship đã khai · số shop đã nói trước đó trong hội thoại). Đây là dấu hiệu bịa giá — không phải bằng chứng
 *    chắc chắn (AI có thể cộng hai số có căn cứ), nên nó là CỜ ĐỂ NGƯỜI ĐỌC, không phải điểm trừ tự động;
 *  · `TOOL_ERROR` — một công cụ trong lượt báo lỗi;
 *  · `AI_HANDOFF` / `HISTORY_HUMAN` — AI chuyển người · thực tế người của shop trả lời câu này. Hai cờ đứng riêng để đọc
 *    ma trận đồng thuận chuyển người, không gộp thành một nhãn "đúng / sai".
 * KHÔNG có ngưỡng "đạt / chưa đạt" trong mã (AGENTS §38): báo cáo in số đo + độ phủ; quyết định bật tự động là của người.
 */

export const REPLAY_FLAGS = ["ERROR", "EMPTY_REPLY", "PRICE_UNGROUNDED", "TOOL_ERROR", "AI_HANDOFF", "HISTORY_HUMAN"] as const;
export type ReplayFlag = (typeof REPLAY_FLAGS)[number];

export const REPLAY_FLAG_LABEL: Record<ReplayFlag, string> = {
  ERROR: "AI hỏng",
  EMPTY_REPLY: "Không trả lời",
  PRICE_UNGROUNDED: "Giá không có căn cứ",
  TOOL_ERROR: "Công cụ lỗi",
  AI_HANDOFF: "AI chuyển người",
  HISTORY_HUMAN: "Thực tế: người trả lời",
};

/** Người nói câu kế tiếp trong hội thoại THẬT: bot của ERP · người / page (tin mang tiền tố «[Shop đã nhắn]») · không ai. */
export type HistoricalSpeaker = "BOT" | "SHOP" | "NONE";

export const REPLAY_LIMITS = {
  /** Số điểm phát lại tối đa mỗi lượt — mỗi điểm là một lượt AI thật (tốn token của shop). */
  pointChoices: [5, 10, 20] as const,
  dayChoices: [7, 30, 90] as const,
  /** Tối đa điểm lấy từ MỘT hội thoại — để một hội thoại dài không chiếm cả lượt. */
  perConversation: 3,
  /** Số tin lịch sử tối đa nạp trước điểm phát lại (giữ lượt AI rẻ và gần với lúc thật). */
  historyMessages: 20,
  /** Lượt chạy treo quá chừng này phút ⇒ lượt sau được chạy lại. */
  runStaleMinutes: 30,
  /** Mẫu dưới ngưỡng ⇒ tỷ lệ `null` (không in 1/2 = 50%). */
  minSample: 5,
} as const;

// ─────────────────────────── Số tiền trong câu ───────────────────────────

/**
 * Số tiền VND trong một câu tiếng Việt: «400.000», «400.000đ», «1.250.000 ₫», «400k», «1,5tr», «2 triệu». Bỏ số < 1.000 (số
 * lượng, cân nặng, ngày). Không đọc SĐT (chuỗi 9–11 chữ số liền không dấu chấm) — chúng không có dạng nhóm nghìn.
 */
export function extractMoneyAmounts(text: string): number[] {
  const out = new Set<number>();
  const s = text.toLowerCase();
  for (const m of s.matchAll(/(\d{1,3}(?:[.,]\d{3})+)(?!\d)/g)) {
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (n >= 1_000) out.add(n);
  }
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(k|nghìn|ngàn|tr|triệu)(?![a-zà-ỹ])/g)) {
    const base = Number(m[1].replace(",", "."));
    if (!Number.isFinite(base)) continue;
    const n = Math.round(base * (m[2] === "tr" || m[2] === "triệu" ? 1_000_000 : 1_000));
    if (n >= 1_000) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Số tiền KHÔNG có trong tập căn cứ. */
export function ungroundedAmounts(reply: string, grounded: ReadonlySet<number>): number[] {
  return extractMoneyAmounts(reply).filter((n) => !grounded.has(n));
}

// ─────────────────────────── Chọn điểm phát lại ───────────────────────────

export type SourceMessage = { seq: number; role: "user" | "assistant"; text: string };
export type SourceConversation = { id: string; channel: string; createdAt: Date; messages: SourceMessage[] };
export type ReplayPoint = { conversationId: string; channel: string; seq: number; customerText: string; history: SourceMessage[]; historicalReply: string | null; historicalSpeaker: HistoricalSpeaker };

export const SHOP_SAID_PREFIX = "[Shop đã nhắn]";

function speakerOf(m: SourceMessage | undefined): HistoricalSpeaker {
  if (!m) return "NONE";
  return m.text.startsWith(SHOP_SAID_PREFIX) ? "SHOP" : "BOT";
}

/**
 * Chọn điểm phát lại: mỗi hội thoại tối đa `perConversation` tin KHÁCH (tin đầu, tin giữa, tin cuối — rải đều thay vì lấy
 * dồn đầu), tổng tối đa `max`, hội thoại mới trước. Tất định: cùng đầu vào ⇒ cùng điểm (chạy lại so được).
 */
export function pickReplayPoints(conversations: readonly SourceConversation[], max: number, perConversation: number = REPLAY_LIMITS.perConversation): ReplayPoint[] {
  const out: ReplayPoint[] = [];
  const sorted = [...conversations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const c of sorted) {
    if (out.length >= max) break;
    const msgs = [...c.messages].sort((a, b) => a.seq - b.seq);
    const customerIdx = msgs.map((m, i) => (m.role === "user" && m.text.trim() ? i : -1)).filter((i) => i >= 0);
    if (!customerIdx.length) continue;
    const pick = new Set<number>();
    const want = Math.min(perConversation, customerIdx.length);
    for (let k = 0; k < want; k++) pick.add(customerIdx[want === 1 ? 0 : Math.round((k * (customerIdx.length - 1)) / (want - 1))]);
    for (const i of [...pick].sort((a, b) => a - b)) {
      if (out.length >= max) break;
      const next = msgs.slice(i + 1).find((m) => m.role === "assistant");
      const nextUser = msgs.slice(i + 1).findIndex((m) => m.role === "user");
      // Câu trả lời thật chỉ tính khi nó đứng TRƯỚC tin khách kế tiếp — nếu khách nhắn tiếp trước, chỗ ấy không ai trả lời.
      const nextIdx = next ? msgs.indexOf(next) : -1;
      const answered = next && (nextUser < 0 || nextIdx < i + 1 + nextUser);
      out.push({
        conversationId: c.id,
        channel: c.channel,
        seq: msgs[i].seq,
        customerText: msgs[i].text.trim(),
        history: msgs.slice(Math.max(0, i - REPLAY_LIMITS.historyMessages), i),
        historicalReply: answered ? next!.text.replace(SHOP_SAID_PREFIX, "").trim() : null,
        historicalSpeaker: answered ? speakerOf(next) : "NONE",
      });
    }
  }
  return out;
}

// ─────────────────────────── Chấm một điểm ───────────────────────────

export type PointOutcome = {
  ok: boolean;
  aiReply: string;
  aiStatus: string | null;
  tools: { name: string; ok: boolean; summary: string }[];
};

export function judgePoint(point: Pick<ReplayPoint, "historicalSpeaker">, outcome: PointOutcome, grounded: ReadonlySet<number>): { flags: ReplayFlag[]; ungrounded: number[] } {
  const flags: ReplayFlag[] = [];
  if (!outcome.ok) flags.push("ERROR");
  else if (!outcome.aiReply.trim()) flags.push("EMPTY_REPLY");
  const toolAmounts = outcome.tools.flatMap((t) => extractMoneyAmounts(t.summary));
  const all = new Set<number>([...grounded, ...toolAmounts]);
  const ungrounded = outcome.ok ? ungroundedAmounts(outcome.aiReply, all) : [];
  if (ungrounded.length) flags.push("PRICE_UNGROUNDED");
  if (outcome.tools.some((t) => !t.ok)) flags.push("TOOL_ERROR");
  if (outcome.aiStatus === "HANDOFF") flags.push("AI_HANDOFF");
  if (point.historicalSpeaker === "SHOP") flags.push("HISTORY_HUMAN");
  return { flags, ungrounded };
}

// ─────────────────────────── Tổng hợp một lượt ───────────────────────────

export type ReplaySummary = {
  points: number;
  conversations: number;
  answered: number;
  /** Tỷ lệ trên các điểm AI trả lời được; `null` khi mẫu < `minSample`. */
  errorRate: number | null;
  priceUngroundedRate: number | null;
  toolErrorRate: number | null;
  aiHandoffRate: number | null;
  /** Ma trận chuyển người: AI chuyển × thực tế người trả lời. */
  handoff: { bothHuman: number; aiOnly: number; historyOnly: number; neither: number };
  /** Số điểm có tiền trong câu AI — mẫu số thật của cờ giá (điểm không nói tới tiền không chứng minh gì). */
  pointsWithAmounts: number;
  flagCounts: Record<ReplayFlag, number>;
};

export function rateOrNull(num: number, den: number, min: number = REPLAY_LIMITS.minSample): number | null {
  return den >= min ? num / den : null;
}

export function summarizeReplay(points: readonly { conversationId: string; flags: readonly ReplayFlag[]; aiReply: string | null }[]): ReplaySummary {
  const flagCounts = Object.fromEntries(REPLAY_FLAGS.map((f) => [f, 0])) as Record<ReplayFlag, number>;
  const handoff = { bothHuman: 0, aiOnly: 0, historyOnly: 0, neither: 0 };
  let answered = 0;
  let withAmounts = 0;
  for (const p of points) {
    for (const f of p.flags) flagCounts[f] += 1;
    if (!p.flags.includes("ERROR")) answered += 1;
    if (p.aiReply && extractMoneyAmounts(p.aiReply).length) withAmounts += 1;
    const ai = p.flags.includes("AI_HANDOFF");
    const hist = p.flags.includes("HISTORY_HUMAN");
    if (ai && hist) handoff.bothHuman += 1;
    else if (ai) handoff.aiOnly += 1;
    else if (hist) handoff.historyOnly += 1;
    else handoff.neither += 1;
  }
  return {
    points: points.length,
    conversations: new Set(points.map((p) => p.conversationId)).size,
    answered,
    errorRate: rateOrNull(flagCounts.ERROR, points.length),
    priceUngroundedRate: rateOrNull(flagCounts.PRICE_UNGROUNDED, withAmounts),
    toolErrorRate: rateOrNull(flagCounts.TOOL_ERROR, answered),
    aiHandoffRate: rateOrNull(flagCounts.AI_HANDOFF, answered),
    handoff,
    pointsWithAmounts: withAmounts,
    flagCounts,
  };
}

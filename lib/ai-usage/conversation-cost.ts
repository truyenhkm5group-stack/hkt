/**
 * ═══════════ TIỀN AI THEO HỘI THOẠI — ÁNH XẠ `ref` → HỘI THOẠI DÙNG CHUNG — CHỈ MÁY CHỦ ═══════════
 *
 * Sổ dùng AI (`platform_ai_usage`, đọc qua `aiUsageByRef` — luôn lọc `org_code`) ghi `ref` cho mỗi lượt của chatbot bán hàng:
 *  · `<mã hội thoại>`            — lượt bot trả lời / đọc ảnh khách gửi / viết lời nhắc follow-up của chính hội thoại;
 *  · `order-sync:<mã hội thoại>` — lượt AI đọc hội thoại của NHÂN VIÊN để ghi đơn hộ («AI ghi đơn hộ nhân viên»).
 * `conversationOfRef` là phép ánh xạ DUY NHẤT: khung «Chi phí AI & ROI» (lib/sales-chatbot/performance.ts) và so AI vs người
 * theo nhánh thử nghiệm (lib/sales-chatbot/experiment-report.ts) cùng gọi — hai khối trên một trang không được hiểu một dòng
 * sổ theo hai cách.
 *
 * Tiền là ƯỚC TÍNH (token × bảng giá model × tỷ giá). Lượt chưa định giá KHÔNG cộng 0: tổng là CẬN DƯỚI và số lượt thiếu giá
 * đi kèm; chưa lượt nào định giá ⇒ `null` (CHƯA BIẾT — luật 42).
 *
 * GIỚI HẠN ĐÃ BIẾT — mốc tính tiền cắt theo NGÀY: sổ gom theo (ngày giờ VN × `ref`), nên «chỉ tính từ mốc X của hội thoại»
 * cắt được ở ĐẦU NGÀY của mốc X, không cắt giữa ngày. Lượt AI cùng ngày nhưng TRƯỚC mốc vẫn bị tính — hướng sai luôn là chi
 * phí CAO hơn thật, không bao giờ thấp hơn. (Tập hội thoại có mốc sớm nhất thì cắt đúng tới mốc: sổ đọc từ chính mốc ấy.)
 */
import { aiUsageByRef, type AiUsageRefRow } from "@/lib/ai-usage/ledger";
import { vnDayKey, type AiUsageFeature } from "@/lib/ai-usage/types";

export const ORDER_SYNC_REF_PREFIX = "order-sync:";

/** Tính năng của sổ AI mà `ref` là hội thoại bán hàng (bot trả lời · đọc ảnh · follow-up · ghi đơn hộ nhân viên). */
export const SALES_CONVERSATION_FEATURES: readonly AiUsageFeature[] = ["sales_chatbot"];

export type RefConversation = { conversationId: string; orderSync: boolean };

/** `ref` của sổ AI ⇒ hội thoại + loại lượt (`orderSync` = lượt AI ghi đơn hộ nhân viên). `null` = lượt không gắn hội thoại. HÀM THUẦN. */
export function conversationOfRef(ref: string | null | undefined): RefConversation | null {
  if (!ref) return null;
  return ref.startsWith(ORDER_SYNC_REF_PREFIX) ? { conversationId: ref.slice(ORDER_SYNC_REF_PREFIX.length), orderSync: true } : { conversationId: ref, orderSync: false };
}

/** Cộng một khoản USD (quy ₫) vào tổng. Khoản `null` (chưa định giá) KHÔNG cộng 0 — tổng giữ `null` tới khoản đã định giá đầu tiên. HÀM THUẦN. */
export function addUsdAsVnd(acc: number | null, usd: number | null, rateVndPerUsd: number): number | null {
  return usd === null ? acc : (acc ?? 0) + usd * rateVndPerUsd;
}

export type ConversationsAiCost = {
  /** ₫ ƯỚC TÍNH, đã làm tròn; `null` = chưa lượt nào định giá (CHƯA BIẾT, không phải 0). */
  costVnd: number | null;
  /** Lượt AI đã dùng (lượt bị hạn mức chặn không tính — sổ không gọi model). */
  turns: number;
  /** Lượt chưa định giá — > 0 ⇒ `costVnd` là CẬN DƯỚI. */
  unknownTurns: number;
};

/**
 * Tiền AI của MỘT tập hội thoại. `fromDay` = hội thoại ⇒ ngày (giờ VN, `YYYY-MM-DD`) bắt đầu tính tiền của nó; dòng sổ của
 * hội thoại ngoài tập, hoặc của ngày trước ngày ấy, bị bỏ. Lượt `order-sync:` tính cho chính hội thoại nó đọc. HÀM THUẦN.
 */
export function sumConversationsAiCost(rows: readonly AiUsageRefRow[], fromDay: ReadonlyMap<string, string>, rateVndPerUsd: number): ConversationsAiCost {
  let cost: number | null = null;
  let turns = 0;
  let unknownTurns = 0;
  for (const r of rows) {
    const conv = conversationOfRef(r.ref);
    const from = conv ? fromDay.get(conv.conversationId) : undefined;
    if (from === undefined || r.day < from) continue;
    cost = addUsdAsVnd(cost, r.costUsd, rateVndPerUsd);
    turns += r.turns;
    unknownTurns += r.unknownCost;
  }
  return { costVnd: cost === null ? null : Math.round(cost), turns, unknownTurns };
}

/**
 * Tiền AI của NHIỀU tập hội thoại (vd hai nhánh thử nghiệm) trong MỘT lần đọc sổ của tổ chức `orgCode`. Mỗi hội thoại mang
 * mốc RIÊNG (vd lúc được ghim vào nhánh) và chỉ tính từ NGÀY (giờ VN) của mốc ấy; sổ đọc từ mốc sớm nhất. Không hội thoại nào
 * ⇒ không đọc sổ.
 */
export async function aiCostOfConversationSets<K extends string>(orgCode: string, sets: Readonly<Record<K, ReadonlyMap<string, Date>>>, rateVndPerUsd: number): Promise<Record<K, ConversationsAiCost>> {
  const keys = Object.keys(sets) as K[];
  let earliest: Date | null = null;
  for (const k of keys) for (const at of sets[k].values()) if (!earliest || at < earliest) earliest = at;
  const rows = earliest ? await aiUsageByRef(orgCode, SALES_CONVERSATION_FEATURES, earliest) : [];
  const out = {} as Record<K, ConversationsAiCost>;
  for (const k of keys) out[k] = sumConversationsAiCost(rows, new Map([...sets[k]].map(([id, at]) => [id, vnDayKey(at)])), rateVndPerUsd);
  return out;
}

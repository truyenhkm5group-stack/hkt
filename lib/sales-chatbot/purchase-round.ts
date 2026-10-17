import type { ChatState } from "@/lib/sales-chatbot/tools";

/**
 * Mốc bắt đầu LƯỢT MUA HIỆN TẠI: muộn nhất giữa lúc chốt của đơn gần nhất đã sang `pastOrders` và `roundStartAt` (lượt mua mới mở vì khách
 * quay lại sau thời gian dài / bình luận mua lại mang sang hộp thư — engine.ts); chưa có ⇒ `null` (cả hội thoại). MỘT định nghĩa cho
 * engine (lời mua của lượt), next-best-action (cửa sổ upsell) và khoá đơn (tools.ts). HÀM THUẦN.
 */
export function purchaseRoundStart(st: Pick<ChatState, "pastOrders" | "roundStartAt">): Date | null {
  const at = Math.max(...[...(st.pastOrders ?? []).map((o) => o.at), st.roundStartAt ?? ""].map((s) => Date.parse(s)).filter((n) => Number.isFinite(n)), -Infinity);
  return Number.isFinite(at) ? new Date(at) : null;
}

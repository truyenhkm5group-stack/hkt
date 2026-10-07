/**
 * ═══════════ BENCHMARK PHÁT LẠI SALES AGENT — OFFLINE (07/10/2026 · docs/platform/ai-model-control.md §9) ═══════════
 *
 * AI dùng chung hôm nay KHÔNG có hội thoại bán hàng với khách để đo A/B ⇒ phát lại lịch sử chat THẬT của một shop đang chạy
 * bot (đúng đường «Phát lại hội thoại cũ»: `shadowTurn` — kênh THỬ, công cụ ghi CHỈ MÔ PHỎNG, không khách / đơn / tin nào rời
 * máy, hội thoại tạm bị xoá) với từng cấu hình model, rồi chấm bằng LUẬT TẤT ĐỊNH (không AI chấm AI):
 *
 *   đúng giá        không có số tiền nào ngoài bảng giá / kết quả công cụ / lời shop đã nói (`judgePoint` · PRICE_UNGROUNDED)
 *   không bịa tồn   nói «còn / hết / sẵn hàng» mà lượt đó không có công cụ tra hàng thành công
 *   đúng công cụ    khách hỏi giá ⇒ có gọi công cụ giá (search_products · get_current_price · calculate_cart)
 *   SĐT / địa chỉ   khách đưa SĐT hoặc địa chỉ ⇒ bot lưu khách (create_customer) HOẶC hỏi nốt phần thiếu
 *   không chốt ẩu   confirm_order thành công khi câu khách không có lời xác nhận
 *   handoff         khách phàn nàn / đòi người ⇒ chuyển người; không phàn nàn mà chuyển ⇒ chuyển thừa
 *   không lộ suy nghĩ   tên công cụ / lời lẩm bẩm trong câu gửi khách
 *   upsell          câu trả lời có lời mời mua thêm (chỉ để tham khảo — nhiều lượt KHÔNG nên mời)
 *   ngắn gọn        độ dài câu trả lời
 *   tiền / độ trễ / token   bắt từ sổ AI của chính lượt (không ghi vào sổ thật của shop — `setAiUsageCaptureForBench`)
 */
import type { ShadowResult } from "@/lib/sales-chatbot/shadow";
import { judgePoint, pickReplayPoints, type ReplayFlag, type ReplayPoint, type SourceConversation } from "@/lib/sales-chatbot/replay-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

export const SALES_SITUATIONS = ["price", "variant", "advice", "refuse", "discount", "phone", "address", "upsell", "recap", "confirm", "change", "complaint", "image"] as const;
export type SalesSituation = (typeof SALES_SITUATIONS)[number];

const RE: Record<SalesSituation, RegExp> = {
  price: /\b(gia|bao nhieu|bn tien|nhieu tien|bao tien|mbn|bnhieu)\b/,
  variant: /\b(size|mau|mau sac|co do|loai nao|kich thuoc|kg|hop|goi|vi)\b/,
  advice: /\b(tu van|nen mua|loai nao ngon|an the nao|che bien|bao quan|ship may ngay|giao bao lau)\b/,
  refuse: /\b(thoi|khong mua|de sau|chua can|khong lay|de minh nghi)\b/,
  discount: /\b(giam gia|bot|re hon|khuyen mai|freeship|mien phi ship|chiet khau)\b/,
  phone: /(0|\+84)\d{8,10}\b/,
  address: /\b(duong|phuong|quan|xa|huyen|tinh|thanh pho|tp|so nha|ngo|ngach|thon|ap)\b/,
  upsell: /\b(them|combo|kem|lay them|mua them)\b/,
  recap: /\b(tong|tat ca bao nhieu|het bao nhieu|tinh tien)\b/,
  confirm: /\b(chot|ok|oke|dong y|xac nhan|len don|lay nhe|dat nhe|gui nhe)\b/,
  change: /\b(doi|sua|thay|nham|khong phai)\b/,
  complaint: /\b(khieu nai|te qua|lua dao|hoan tien|that vong|kem chat luong|bi hong|gap nhan vien|nguoi that|admin)\b/,
  image: /\[(anh|hinh|image)/,
};

/** Tình huống của MỘT lượt khách (có thể nhiều). HÀM THUẦN. */
export function situationsOf(text: string): SalesSituation[] {
  const t = foldVi(text).toLowerCase();
  return SALES_SITUATIONS.filter((s) => RE[s].test(t));
}

/** Chọn `max` điểm phủ đều tình huống: ưu tiên tình huống còn ít mẫu. HÀM THUẦN. */
export function pickBenchPoints(sources: readonly SourceConversation[], max: number): ReplayPoint[] {
  const pool = pickReplayPoints(sources, max * 4);
  const count = new Map<SalesSituation | "other", number>();
  const picked: ReplayPoint[] = [];
  const tagged = pool.map((p) => ({ p, s: situationsOf(p.customerText) as (SalesSituation | "other")[] })).map((x) => ({ ...x, s: x.s.length ? x.s : (["other"] as const).slice() }));
  while (picked.length < max && tagged.length) {
    tagged.sort((a, b) => Math.min(...a.s.map((k) => count.get(k) ?? 0)) - Math.min(...b.s.map((k) => count.get(k) ?? 0)));
    const next = tagged.shift()!;
    picked.push(next.p);
    for (const k of next.s) count.set(k, (count.get(k) ?? 0) + 1);
  }
  return picked;
}

const PRICE_TOOLS = new Set(["search_products", "get_current_price", "calculate_cart"]);
const STOCK_TOOLS = new Set(["check_inventory", "search_products", "calculate_cart", "get_current_price"]);
// Tên công cụ đọc trên câu GỐC (bộ gấp dấu tiếng Việt có thể đổi dấu gạch dưới); lời lẩm bẩm đọc trên câu đã gấp dấu.
const LEAK_TOOL = /\b(search_products|get_current_price|calculate_cart|check_inventory|create_customer|create_draft_order|confirm_order|handoff_to_human|get_order_status|tool_use|function_call)\b/i;
const LEAK_PHRASE = /khach vua nhan|ta dap|suy nghi:|thinking/i;
const STOCK_CLAIM = /\b(con hang|het hang|san hang|co san|con \d+)\b/;
const ASKS_INFO = /\b(sdt|so dien thoai|dia chi|ten nguoi nhan)\b/;
const UPSELL = /\b(mua them|lay them|them .{0,20}(nua|khong)|combo|kem theo|tang kem)\b/;

export type SalesPointScore = {
  situations: SalesSituation[];
  ok: boolean;
  flags: ReplayFlag[];
  priceGrounded: boolean;
  stockFabricated: boolean;
  /** `null` = lượt không cần công cụ giá. */
  rightTool: boolean | null;
  infoCaptured: boolean | null;
  confirmWithoutConsent: boolean;
  handoff: boolean;
  handoffExpected: boolean;
  leak: boolean;
  upsell: boolean;
  replyChars: number;
};

/** Chấm MỘT điểm. HÀM THUẦN. */
export function scoreSalesPoint(point: Pick<ReplayPoint, "customerText" | "historicalSpeaker">, shadow: ShadowResult, grounded: ReadonlySet<number>): SalesPointScore {
  const situations = situationsOf(point.customerText);
  const { flags } = judgePoint(point, { ok: shadow.ok, aiReply: shadow.reply, aiStatus: shadow.status, tools: shadow.tools }, grounded);
  const reply = foldVi(shadow.reply).toLowerCase();
  const toolOk = (set: ReadonlySet<string>) => shadow.tools.some((t) => set.has(t.name) && t.ok);
  const called = (name: string) => shadow.tools.some((t) => t.name === name);
  const hasConsent = /\b(chot|ok|oke|dong y|xac nhan|len don|lay nhe|dat nhe|gui nhe|uh|u|vang|duoc)\b/.test(foldVi(point.customerText).toLowerCase());
  const gaveInfo = situations.includes("phone") || situations.includes("address");
  return {
    situations,
    ok: shadow.ok,
    flags,
    priceGrounded: !flags.includes("PRICE_UNGROUNDED"),
    stockFabricated: STOCK_CLAIM.test(reply) && !toolOk(STOCK_TOOLS),
    rightTool: situations.includes("price") ? shadow.tools.some((t) => PRICE_TOOLS.has(t.name)) : null,
    infoCaptured: gaveInfo ? called("create_customer") || ASKS_INFO.test(reply) : null,
    confirmWithoutConsent: shadow.tools.some((t) => t.name === "confirm_order" && t.ok) && !hasConsent,
    handoff: shadow.status === "HANDOFF",
    handoffExpected: situations.includes("complaint"),
    leak: LEAK_TOOL.test(shadow.reply) || LEAK_PHRASE.test(reply),
    upsell: UPSELL.test(reply),
    replyChars: shadow.reply.length,
  };
}

export type SalesCallObs = { calls: number; inputTokens: number; outputTokens: number; thinkingTokens: number; latencyMs: number; costUsd: number; unpriced: boolean };
export type SalesBenchResult = { config: string; score: SalesPointScore; obs: SalesCallObs };

/** Gộp một cấu hình. HÀM THUẦN. */
export function summarizeSalesBench(rows: readonly SalesBenchResult[]) {
  const n = rows.length;
  const r = (k: number, d: number) => (d > 0 ? k / d : null);
  const where = <T>(f: (s: SalesPointScore) => T | null) => rows.map((x) => f(x.score)).filter((v): v is T => v !== null);
  const rightTool = where((s) => s.rightTool);
  const info = where((s) => s.infoCaptured);
  const complaint = rows.filter((x) => x.score.handoffExpected);
  const nonComplaint = rows.filter((x) => !x.score.handoffExpected);
  const ok = rows.filter((x) => x.score.ok);
  const chars = ok.map((x) => x.score.replyChars).sort((a, b) => a - b);
  const lat = rows.filter((x) => x.obs.calls > 0).map((x) => x.obs.latencyMs).sort((a, b) => a - b);
  const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))] : null);
  const sum = (f: (o: SalesCallObs) => number) => rows.reduce((t, x) => t + f(x.obs), 0);
  return {
    points: n,
    errors: n - ok.length,
    empty: rows.filter((x) => x.score.flags.includes("EMPTY_REPLY")).length,
    priceGrounded: r(rows.filter((x) => x.score.priceGrounded).length, n),
    stockFabricated: rows.filter((x) => x.score.stockFabricated).length,
    rightTool: { ok: rightTool.filter(Boolean).length, n: rightTool.length },
    toolErrors: rows.filter((x) => x.score.flags.includes("TOOL_ERROR")).length,
    infoCaptured: { ok: info.filter(Boolean).length, n: info.length },
    confirmWithoutConsent: rows.filter((x) => x.score.confirmWithoutConsent).length,
    handoffOnComplaint: { ok: complaint.filter((x) => x.score.handoff).length, n: complaint.length },
    unnecessaryHandoff: { k: nonComplaint.filter((x) => x.score.handoff).length, n: nonComplaint.length },
    leaks: rows.filter((x) => x.score.leak).length,
    upsellRate: r(rows.filter((x) => x.score.upsell).length, ok.length),
    replyCharsP50: q(chars, 0.5),
    calls: sum((o) => o.calls),
    inputPerPoint: n ? sum((o) => o.inputTokens) / n : null,
    outputPerPoint: n ? sum((o) => o.outputTokens) / n : null,
    thinkingPerPoint: n ? sum((o) => o.thinkingTokens) / n : null,
    costPerPointUsd: n && !rows.some((x) => x.obs.unpriced) ? sum((o) => o.costUsd) / n : null,
    turnP50Ms: q(lat, 0.5),
    turnP95Ms: q(lat, 0.95),
  };
}

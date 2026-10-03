/**
 * ═══════════ CHI PHÍ AI CỦA CHATBOT THEO NGÀY — trên ĐƠN CHỐT và trên SĐT KHÁCH ĐỂ LẠI (02/10/2026) ═══════════
 *
 * Chủ shop muốn thấy, mỗi ngày, bot tốn bao nhiêu tiền AI để ra MỘT đơn và MỘT số điện thoại — cùng câu hỏi màn «Bot chat
 * bán hàng» của nhà trả lời. Ba nguồn, mỗi nguồn một sự thật:
 *
 *  · TIỀN — sổ dùng AI `platform_ai_usage` (CSDL nhà, lọc theo `org_code`), tính năng `sales_chatbot`, mỗi dòng mang
 *    `ref` = mã hội thoại. Hội thoại KHUNG THỬ (kênh TEST) tách riêng: tiền thử không phải tiền bán hàng. Dòng có `ref` không
 *    còn hội thoại ⇒ vẫn là tiền thật đã trả, tính vào phần bán hàng (thà chia cho đơn nhiều hơn còn hơn giấu đi). Học hội
 *    thoại (`sales_playbook`) là chi phí MỘT LẦN — in riêng, KHÔNG chia vào đơn của ngày chạy học.
 *  · ĐƠN — đơn bot CHỐT thật (`state.confirmed`, không mô phỏng, có mã đơn), theo ngày của mốc chốt.
 *  · SĐT — SĐT khách để lại qua bot (`state.customer`, không mô phỏng), ĐẾM KHÔNG TRÙNG trong ngày, theo mốc lần đầu để
 *    lại. Hội thoại trước 02/10/2026 không có mốc ⇒ KHÔNG đoán ngày (không backfill, AGENTS 8.8) — đếm riêng và in ra.
 *
 * Tiền là ƯỚC TÍNH (token × bảng giá × tỷ giá `FACEBOOK_USD_VND`) — nhãn «ước tính» luôn đi kèm. Lượt chưa định giá (model
 * lạ) KHÔNG cộng 0: tổng ngày đó là CẬN DƯỚI và số lượt thiếu giá in cạnh (luật 42). Chia cho 0 đơn / 0 SĐT ⇒ `null`.
 */
import { gte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { aiUsageByRef } from "@/lib/ai-usage/ledger";
import { vnDayKey } from "@/lib/ai-usage/types";
import { env } from "@/lib/env";
import { normalizeCustomerPhone } from "@/lib/records/customer-create";
import type { ChatState } from "@/lib/sales-chatbot/tools";

/** Một nhóm dòng sổ AI: (ngày VN, hội thoại, tính năng). */
export type UsageCell = { day: string; ref: string | null; feature: string; turns: number; costUsd: number | null; unknownCost: number };
/** Một sự kiện kết quả của bot trong ngày. */
export type OutcomeEvent = { day: string; kind: "ORDER" | "PHONE"; key: string };

export type ChatCostDay = {
  day: string;
  /** Lượt AI của phần bán hàng (fanpage + web). */
  turns: number;
  /** ₫ ước tính, bán hàng; `null` = mọi lượt đều chưa định giá. */
  costVnd: number | null;
  /** Lượt có tiền CHƯA BIẾT ⇒ `costVnd` là cận dưới. */
  unknownCost: number;
  orders: number;
  phones: number;
  costPerOrder: number | null;
  costPerPhone: number | null;
  /** Khung thử + học hội thoại — tiền thật nhưng không chia vào đơn / SĐT. */
  testCostVnd: number | null;
  learnCostVnd: number | null;
};

export type ChatCostReport = {
  days: ChatCostDay[];
  total: ChatCostDay;
  rateVndPerUsd: number;
  /** SĐT để lại trước khi ERP ghi mốc (không có ngày) — không vào bảng theo ngày. */
  phonesWithoutDate: number;
};

const addVnd = (a: number | null, usd: number | null, rate: number): number | null => (usd === null ? a : (a ?? 0) + usd * rate);
const per = (cost: number | null, n: number): number | null => (cost === null || n <= 0 ? null : Math.round(cost / n));
const round = (v: number | null): number | null => (v === null ? null : Math.round(v));

/**
 * HÀM THUẦN: dựng bảng theo ngày từ sổ AI đã gom + kênh của từng hội thoại + sự kiện đơn / SĐT. `dayKeys` theo thứ tự
 * hiển thị; ngày không có dòng nào vẫn có mặt với 0 lượt (0 lượt là SỐ ĐO thật — sổ ghi mọi lượt), tiền `null`.
 */
export function buildChatCostDays(input: { dayKeys: readonly string[]; usage: readonly UsageCell[]; channelOf: ReadonlyMap<string, string>; events: readonly OutcomeEvent[]; rate: number }): { days: ChatCostDay[]; total: ChatCostDay } {
  const blank = (day: string): ChatCostDay => ({ day, turns: 0, costVnd: null, unknownCost: 0, orders: 0, phones: 0, costPerOrder: null, costPerPhone: null, testCostVnd: null, learnCostVnd: null });
  const byDay = new Map(input.dayKeys.map((d) => [d, blank(d)]));
  for (const u of input.usage) {
    const row = byDay.get(u.day);
    if (!row) continue;
    if (u.feature === "sales_playbook") {
      row.learnCostVnd = addVnd(row.learnCostVnd, u.costUsd, input.rate);
      continue;
    }
    if (u.feature !== "sales_chatbot") continue;
    if (u.ref && input.channelOf.get(u.ref) === "TEST") {
      row.testCostVnd = addVnd(row.testCostVnd, u.costUsd, input.rate);
      continue;
    }
    row.turns += u.turns;
    row.unknownCost += u.unknownCost;
    row.costVnd = addVnd(row.costVnd, u.costUsd, input.rate);
  }
  const orderKeys = new Map<string, Set<string>>();
  const phoneKeys = new Map<string, Set<string>>();
  for (const e of input.events) {
    if (!byDay.has(e.day)) continue;
    const m = e.kind === "ORDER" ? orderKeys : phoneKeys;
    if (!m.has(e.day)) m.set(e.day, new Set());
    m.get(e.day)!.add(e.key);
  }
  const days = input.dayKeys.map((d) => {
    const row = byDay.get(d)!;
    row.orders = orderKeys.get(d)?.size ?? 0;
    row.phones = phoneKeys.get(d)?.size ?? 0;
    row.costVnd = round(row.costVnd);
    row.testCostVnd = round(row.testCostVnd);
    row.learnCostVnd = round(row.learnCostVnd);
    row.costPerOrder = per(row.costVnd, row.orders);
    row.costPerPhone = per(row.costVnd, row.phones);
    return row;
  });
  const sumOrNull = (vals: (number | null)[]) => (vals.every((v) => v === null) ? null : vals.reduce<number>((a, v) => a + (v ?? 0), 0));
  const total: ChatCostDay = {
    day: "total",
    turns: days.reduce((a, r) => a + r.turns, 0),
    costVnd: sumOrNull(days.map((r) => r.costVnd)),
    unknownCost: days.reduce((a, r) => a + r.unknownCost, 0),
    orders: days.reduce((a, r) => a + r.orders, 0),
    // SĐT trong cả kỳ: KHÔNG cộng số từng ngày (một khách để lại số hai ngày khác nhau vẫn là một SĐT).
    phones: new Set([...phoneKeys.values()].flatMap((s) => [...s])).size,
    costPerOrder: null,
    costPerPhone: null,
    testCostVnd: sumOrNull(days.map((r) => r.testCostVnd)),
    learnCostVnd: sumOrNull(days.map((r) => r.learnCostVnd)),
  };
  total.costPerOrder = per(total.costVnd, total.orders);
  total.costPerPhone = per(total.costVnd, total.phones);
  return { days, total };
}

/** Sự kiện đơn chốt / SĐT để lại đọc từ trạng thái hội thoại (bỏ mô phỏng). HÀM THUẦN. */
export function outcomeEventsOf(conversations: readonly { id: string; state: ChatState }[]): { events: OutcomeEvent[]; phonesWithoutDate: number } {
  const events: OutcomeEvent[] = [];
  const undated = new Set<string>();
  for (const c of conversations) {
    for (const conf of [...(c.state.pastOrders ?? []), ...(c.state.confirmed ? [c.state.confirmed] : [])]) {
      if (!conf.simulated && conf.orderId && conf.at) events.push({ day: vnDayKey(new Date(conf.at)), kind: "ORDER", key: conf.orderId });
    }
    const cust = c.state.customer;
    const phone = cust && !cust.simulated ? normalizeCustomerPhone(cust.phone) : null;
    if (!phone) continue;
    if (cust?.at) events.push({ day: vnDayKey(new Date(cust.at)), kind: "PHONE", key: phone });
    else undated.add(phone);
  }
  return { events, phonesWithoutDate: undated.size };
}

/** `n` ngày gần nhất theo giờ VN, mới nhất trước. */
export function lastVnDays(n: number, now: Date = new Date()): string[] {
  const today = dauNgayVN(now).getTime();
  return Array.from({ length: n }, (_, i) => vnDayKey(new Date(today - i * 86_400_000)));
}

/** Báo cáo cho tổ chức đang đăng nhập — sổ AI lọc đúng `org_code`, hội thoại từ CSDL của chính tổ chức. */
export async function loadChatCostReport(orgCode: string, days = 30, now: Date = new Date()): Promise<ChatCostReport> {
  const dayKeys = lastVnDays(days, now);
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  // Sổ AI nằm ở CSDL nhà — đọc qua đường của chính sổ (luôn lọc `org_code`), không mở CSDL nền tảng từ mã nghiệp vụ (S17).
  const usage: UsageCell[] = await aiUsageByRef(orgCode, ["sales_chatbot", "sales_playbook"], since);

  const db = await getDb();
  const c = schema.salesChatConversations;
  const [channels, recent] = await Promise.all([
    db.select({ id: c.id, channel: c.channel }).from(c),
    // Đơn / SĐT của kỳ nằm ở hội thoại có cập nhật trong kỳ (chốt / lưu khách đều ghi lại hội thoại).
    db.select({ id: c.id, state: c.state }).from(c).where(gte(c.updatedAt, since)),
  ]);
  const { events, phonesWithoutDate } = outcomeEventsOf(recent.map((r) => ({ id: r.id, state: (r.state ?? {}) as ChatState })));
  const rate = env.facebook.usdToVnd;
  const built = buildChatCostDays({ dayKeys, usage, channelOf: new Map(channels.map((r) => [r.id, r.channel])), events, rate });
  return { ...built, rateVndPerUsd: rate, phonesWithoutDate };
}

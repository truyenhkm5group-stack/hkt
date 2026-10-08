/**
 * ═══════════ BỘ ĐO ĐƠN VÀNG v2 — KHUNG CHẠY (sứ mệnh saas-order-accuracy · lát C1) ═══════════
 *
 * Phát lại `ORDER_GOLDEN_CASES` qua ĐÚNG khung của hội thoại vàng (`runGoldenCases` ⇒ `chatTurn` thật, model kịch bản tất định,
 * tổ chức PGlite thật, không gọi mạng — luật 65) — KHÔNG phải khung thứ hai. Hai móc thêm vào khung đó:
 *  · trước mỗi ca: đặt công tắc của tổ chức theo BIẾN THỂ + gieo dữ liệu của ca, chụp tập đơn đang có;
 *  · sau mỗi ca: đọc ĐƠN THẬT ghi trong lúc ca chạy (dòng `orders` mới, `order_items`, sự kiện `order.confirmed`), công cụ máy chủ
 *    đã từ chối, và số vòng engine hỏi model so với kịch bản.
 * Điểm số do hàm THUẦN tính (`lib/sales-chatbot/order-golden-metrics.ts`).
 *
 * Hai BIẾN THỂ, mỗi biến thể một tổ chức thử MỚI TINH (khách / đơn / tồn của biến thể này không lọt sang biến thể kia):
 *  · `AUTO_CONFIRM_OFF` — mặc định của tổ chức;
 *  · `AUTO_CONFIRM_ON`  — bật «đơn đủ thông tin = đã xác nhận» (`orders.autoConfirmComplete` — `lib/records/order-create.ts`).
 * Không ghi tệp nào: `update-baseline.ts` mới ghi số đo hiện trạng.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { scoreOrderCase, summarizeOrderGolden, type ObservedOrder, type OrderCaseObservation, type OrderCaseScore, type OrderGoldenSummary } from "@/lib/sales-chatbot/order-golden-metrics";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, type GoldenCase, type GoldenTranscript } from "../sales-agent-golden/harness";
import { ORDER_GOLDEN_CASES, type OrderGoldenCase } from "./cases";

export const ORDER_GOLDEN_VARIANTS = ["AUTO_CONFIRM_OFF", "AUTO_CONFIRM_ON"] as const;
export type OrderGoldenVariant = (typeof ORDER_GOLDEN_VARIANTS)[number];

export const ORDER_GOLDEN_VARIANT_LABEL: Record<OrderGoldenVariant, string> = {
  AUTO_CONFIRM_OFF: "Công tắc «đơn đủ thông tin = đã xác nhận» TẮT (mặc định của tổ chức)",
  AUTO_CONFIRM_ON: "Công tắc «đơn đủ thông tin = đã xác nhận» BẬT (orders.autoConfirmComplete)",
};

export type OrderGoldenCaseRun = {
  key: string;
  observation: OrderCaseObservation;
  score: OrderCaseScore;
  /** Trạng thái hội thoại cuối (OPEN · HANDOFF · …) — bối cảnh, không chấm. */
  status: string;
  /** Công cụ máy chủ đã từ chối, theo thứ tự gọi. */
  toolErrors: string[];
  /** Engine hỏi model nhiều / ít vòng hơn kịch bản — kịch bản không còn đi đúng đường đã định. Rỗng = khớp. */
  scriptIssues: string[];
};

export type OrderGoldenRun = { variant: OrderGoldenVariant; cases: OrderGoldenCaseRun[]; summary: OrderGoldenSummary };

/** Khoá hội thoại trong khung vàng mang biến thể — mã khách (visitor key) của hai biến thể khác nhau. */
const goldenKey = (variant: OrderGoldenVariant, key: string) => `${variant === "AUTO_CONFIRM_ON" ? "on" : "off"}~${key}`;

/** Đơn THẬT ghi từ lúc chụp `before` — xếp theo lúc tạo (sớm nhất trước), dòng hàng theo SKU. */
async function ordersSince(before: ReadonlySet<string>, ids: ReadonlyMap<string, string>): Promise<ObservedOrder[]> {
  const db = await getDb();
  const o = schema.orders;
  const all = await db
    .select({ id: o.id, stage: o.stage, phone: o.shipPhone, province: o.shipProvince, ward: o.shipCommune, address: o.shipAddress, fee: o.shippingFee, net: o.totalPriceAfterDiscount })
    .from(o)
    .orderBy(asc(o.insertedAt), asc(o.id));
  const rows = all.filter((r) => !before.has(r.id));
  if (!rows.length) return [];
  const orderIds = rows.map((r) => r.id);
  const it = schema.orderItems;
  const items = await db.select({ orderId: it.orderId, variantId: it.variantId, quantity: it.quantity, unitPrice: it.unitPrice }).from(it).where(inArray(it.orderId, orderIds));
  const ev = schema.domainEvents;
  const events = await db.select({ subjectId: ev.subjectId }).from(ev).where(and(eq(ev.name, "order.confirmed"), inArray(ev.subjectId, orderIds)));
  const skuOf = new Map([...ids].map(([sku, id]) => [id, sku]));
  return rows.map((r) => ({
    id: r.id,
    stage: r.stage,
    lines: items
      .filter((i) => i.orderId === r.id)
      .map((i) => ({ sku: skuOf.get(i.variantId ?? "") ?? `?${i.variantId ?? ""}`, quantity: i.quantity, unitPrice: i.unitPrice }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
    phone: r.phone,
    province: r.province,
    ward: r.ward,
    addressLine: r.address,
    shippingFee: r.fee,
    total: r.net + r.fee,
    confirmedEvents: events.filter((e) => e.subjectId === r.id).length,
  }));
}

/** Tên công cụ có kết quả lỗi (máy chủ từ chối), theo thứ tự gọi. */
function toolErrorsOf(t: GoldenTranscript): string[] {
  const out: string[] = [];
  for (const turn of t.turns)
    for (const round of turn.rounds)
      round.tools.forEach((call, i) => {
        const r = round.results[i];
        if (r && typeof r === "object" && "error" in r) out.push(call.name);
      });
  return out;
}

function scriptIssuesOf(c: OrderGoldenCase, t: GoldenTranscript): string[] {
  const out: string[] = [];
  if (t.turns.length !== c.turns.length) out.push(`${t.turns.length} lượt chạy ≠ ${c.turns.length} lượt kịch bản`);
  t.turns.forEach((turn, i) => {
    const want = c.turns[i]?.ai.length ?? 0;
    if (turn.rounds.length !== want) out.push(`lượt ${i + 1} «${turn.customer.slice(0, 40)}»: engine hỏi model ${turn.rounds.length} vòng, kịch bản có ${want}`);
  });
  return out;
}

/** Chạy dataset (mặc định trọn bộ) cho MỘT biến thể trên tổ chức thử mới tinh. Không ghi tệp. */
export async function runOrderGolden(variant: OrderGoldenVariant, cases: readonly OrderGoldenCase[] = ORDER_GOLDEN_CASES): Promise<OrderGoldenRun> {
  const byGoldenKey = new Map(cases.map((c) => [goldenKey(variant, c.key), c]));
  const caseOf = (g: GoldenCase): OrderGoldenCase => {
    const c = byGoldenKey.get(g.key);
    if (!c) throw new Error(`khung vàng trả về hội thoại lạ ${g.key}`);
    return c;
  };
  const golden: GoldenCase[] = cases.map((c) => ({ key: goldenKey(variant, c.key), title: c.title, shop: "order-food", channel: c.channel, turns: c.turns }));
  const runs = new Map<string, OrderGoldenCaseRun>();
  let before: ReadonlySet<string> = new Set();
  await runGoldenCases(golden, {
    // Mỗi biến thể một tổ chức thử RIÊNG (`og-food-off` · `og-food-on`) — xem `GoldenRunOptions.orgSuffix`.
    orgSuffix: variant === "AUTO_CONFIRM_ON" ? "-on" : "-off",
    beforeCase: async (g, ctx) => {
      const c = caseOf(g);
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: variant === "AUTO_CONFIRM_ON" });
      if (c.seed) await c.seed(ctx);
      before = new Set((await (await getDb()).select({ id: schema.orders.id }).from(schema.orders)).map((r) => r.id));
    },
    afterCase: async (g, ctx, transcript) => {
      const c = caseOf(g);
      const observation: OrderCaseObservation = { key: c.key, orders: await ordersSince(before, ctx.ids) };
      runs.set(c.key, { key: c.key, observation, score: scoreOrderCase(c.label, observation), status: transcript.final.status, toolErrors: toolErrorsOf(transcript), scriptIssues: scriptIssuesOf(c, transcript) });
    },
  });
  const list = cases.map((c) => {
    const r = runs.get(c.key);
    if (!r) throw new Error(`ca ${c.key} không chạy`);
    return r;
  });
  return { variant, cases: list, summary: summarizeOrderGolden(list.map((r) => r.score)) };
}

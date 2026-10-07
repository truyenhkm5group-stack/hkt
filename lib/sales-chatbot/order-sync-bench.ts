/**
 * ═══════════ BENCHMARK PHÁT LẠI «GHI ĐƠN TỪ HỘI THOẠI» — OFFLINE, CHỈ ĐỌC (07/10/2026 · docs/platform/ai-model-control.md §9) ═══════════
 *
 * Câu hỏi: model + mức suy nghĩ nào ghi đơn ĐÚNG với chi phí THẤP nhất. Không chờ 200 hội thoại production: dựng lại đúng
 * đầu vào mà máy ghi đơn đã thấy ở những thời điểm có KẾT QUẢ THẬT, cho từng cấu hình trả lời, rồi chấm bằng luật tất định.
 *
 *  · ĐẦU VÀO = ĐÚNG đường ghi đơn: tin của hội thoại từ sổ `sales_chat_inbound` (`inboundThreadProfile` — không gọi Pancake)
 *    tới trước mốc của ca, `orderSyncPrompt` (cùng prompt), danh mục đang bán, mốc cắt = đơn trước đó của hội thoại.
 *    `returning = null` (không đọc khách cũ: sổ khách HÔM NAY đã chứa chính đơn của ca ⇒ rò đáp án) — mọi cấu hình cùng chịu.
 *  · NHÃN = KẾT QUẢ THẬT, không AI chấm AI:
 *      ORDER          đơn còn sống gắn hội thoại (mọi nguồn) ⇒ PHẢI ra đơn; đối chiếu SĐT · địa chỉ · tên · món · mẫu · SL
 *      DELETED_ORDER  đơn máy ghi (`AI_ORDER_SYNC`) mà NGƯỜI đã xoá ⇒ KHÔNG được ra đơn
 *      NO_ORDER       hội thoại có tin khách mà không có đơn nào ⇒ KHÔNG được ra đơn (tách «có SĐT» — ca dễ ghi sai —
 *                     với «không SĐT»; nhãn này là "có thể": shop có thể đã lên đơn ngoài ERP)
 *  · KHÔNG ghi gì: không tạo khách, không tạo đơn, không chuông, không nhật ký hội thoại — chỉ đọc + gọi model.
 *  · Giá do MÁY CHỦ tính từ danh mục (không phải model) ⇒ «đúng giá» = đúng món + đúng mẫu + đúng SL.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AiProvider, AiRequest } from "@/lib/ai/provider";
import { estimateCostUsd } from "@/lib/ai/provider";
import { sellableCatalog, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import { decideOrderSync, inboundThreadProfile, numberMessages, ORDER_SYNC_READ_LIMITS, orderSyncPrompt, parseOrderSyncReply, phonesInText, syncCutoff, type SyncDecision, type SyncMessage } from "@/lib/sales-chatbot/order-sync";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { foldVi } from "@/lib/sales-chatbot/text";

export const SYNC_BENCH_LABELS = ["ORDER", "DELETED_ORDER", "NO_ORDER_PHONE", "NO_ORDER"] as const;
export type SyncBenchLabel = (typeof SYNC_BENCH_LABELS)[number];

export type SyncBenchTruth = { phone: string; address: string; name: string; lines: { variantId: string | null; productId: string | null; quantity: number }[] };
export type SyncBenchCase = { id: string; label: SyncBenchLabel; at: string; system: string; user: string; messages: SyncMessage[]; cutoffMs: number; knownPhones: string[]; fallbackName: string; truth: SyncBenchTruth | null };
export type SyncBenchConfig = { key: string; model: string; reasoning: AiRequest["reasoning"]; maxTokens: number };

const digits = (s: string) => (normalizeVnPhone(s) ?? s.replace(/\D/g, "")).slice(-9);
const words = (s: string) => foldVi(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/** Địa chỉ khớp khi ≥ 60% từ của địa chỉ thật có trong địa chỉ máy đọc. HÀM THUẦN. */
export function addressMatches(predicted: string, truth: string): boolean {
  const t = words(truth);
  if (!t.length) return false;
  const p = new Set(words(predicted));
  return t.filter((w) => p.has(w)).length / t.length >= 0.6;
}

export type SyncCaseScore = {
  label: SyncBenchLabel;
  schemaValid: boolean;
  created: boolean;
  /** Chỉ khi nhãn ORDER và máy ra đơn. `null` = không áp dụng. */
  phoneOk: boolean | null;
  addressOk: boolean | null;
  nameOk: boolean | null;
  productOk: boolean | null;
  variantOk: boolean | null;
  quantityOk: boolean | null;
};

/** Chấm MỘT ca. HÀM THUẦN. */
export function scoreSyncCase(c: Pick<SyncBenchCase, "label" | "truth">, parsed: boolean, decision: SyncDecision | null, productOf: (variantId: string) => string | null): SyncCaseScore {
  const created = decision?.kind === "CREATE";
  const base: SyncCaseScore = { label: c.label, schemaValid: parsed, created, phoneOk: null, addressOk: null, nameOk: null, productOk: null, variantOk: null, quantityOk: null };
  if (c.label !== "ORDER" || !c.truth || decision?.kind !== "CREATE") return base;
  const t = c.truth;
  const truthVariants = new Map<string, number>();
  for (const l of t.lines) if (l.variantId) truthVariants.set(l.variantId, (truthVariants.get(l.variantId) ?? 0) + l.quantity);
  const got = new Map<string, number>();
  for (const l of decision.lines) got.set(l.variantId, (got.get(l.variantId) ?? 0) + l.quantity);
  const sameKeys = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
  const truthProducts = new Set(t.lines.map((l) => l.productId).filter((x): x is string => Boolean(x)));
  const gotProducts = new Set([...got.keys()].map(productOf).filter((x): x is string => Boolean(x)));
  const variantOk = truthVariants.size ? sameKeys(new Set(truthVariants.keys()), new Set(got.keys())) : null;
  return {
    ...base,
    phoneOk: t.phone ? digits(decision.recipient.phone) === digits(t.phone) : null,
    addressOk: t.address ? addressMatches(`${decision.recipient.address} ${decision.recipient.province}`, t.address) : null,
    nameOk: t.name ? foldVi(t.name).toLowerCase().includes(foldVi(decision.recipient.name).toLowerCase().trim()) || foldVi(decision.recipient.name).toLowerCase().includes(foldVi(t.name).toLowerCase().trim()) : null,
    productOk: truthProducts.size ? sameKeys(truthProducts, gotProducts) : null,
    variantOk,
    quantityOk: variantOk ? [...truthVariants].every(([k, q]) => got.get(k) === q) : variantOk === false ? false : null,
  };
}

export type SyncCallObs = { inputTokens: number; candidateTokens: number; thinkingTokens: number; latencyMs: number; costUsd: number | null; error: string | null };
export type SyncBenchResult = { config: string; score: SyncCaseScore; obs: SyncCallObs };

const rate = (n: number, d: number) => (d > 0 ? n / d : null);

/** Gộp một cấu hình. HÀM THUẦN. */
export function summarizeSyncBench(rows: readonly SyncBenchResult[]) {
  const by = (l: SyncBenchLabel) => rows.filter((r) => r.score.label === l);
  const pos = by("ORDER");
  const negs = rows.filter((r) => r.score.label !== "ORDER");
  const created = pos.filter((r) => r.score.created);
  const field = (k: "phoneOk" | "addressOk" | "nameOk" | "productOk" | "variantOk" | "quantityOk") => {
    const xs = created.map((r) => r.score[k]).filter((v): v is boolean => v !== null);
    return { ok: xs.filter(Boolean).length, n: xs.length, rate: rate(xs.filter(Boolean).length, xs.length) };
  };
  const exact = created.filter((r) => r.score.phoneOk !== false && r.score.addressOk !== false && r.score.variantOk === true && r.score.quantityOk === true).length;
  const ok = rows.filter((r) => !r.obs.error);
  const lat = ok.map((r) => r.obs.latencyMs).sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))] : null);
  const cost = ok.reduce((t, r) => t + (r.obs.costUsd ?? 0), 0);
  const correctDecision = rows.filter((r) => (r.score.label === "ORDER" ? r.score.created : !r.score.created)).length;
  return {
    cases: rows.length,
    errors: rows.length - ok.length,
    schemaValid: rate(rows.filter((r) => r.score.schemaValid).length, rows.length),
    decisionAccuracy: rate(correctDecision, rows.length),
    recall: rate(created.length, pos.length),
    falseNegative: pos.length - created.length,
    falsePositive: negs.filter((r) => r.score.created).length,
    falsePositiveByLabel: Object.fromEntries((["DELETED_ORDER", "NO_ORDER_PHONE", "NO_ORDER"] as const).map((l) => [l, `${by(l).filter((r) => r.score.created).length}/${by(l).length}`])),
    exactOrderRate: rate(exact, pos.length),
    phone: field("phoneOk"),
    address: field("addressOk"),
    name: field("nameOk"),
    product: field("productOk"),
    variant: field("variantOk"),
    quantity: field("quantityOk"),
    avgInput: ok.length ? ok.reduce((t, r) => t + r.obs.inputTokens, 0) / ok.length : null,
    avgCandidate: ok.length ? ok.reduce((t, r) => t + r.obs.candidateTokens, 0) / ok.length : null,
    avgThinking: ok.length ? ok.reduce((t, r) => t + r.obs.thinkingTokens, 0) / ok.length : null,
    costPerCaseUsd: ok.length ? cost / ok.length : null,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
  };
}

/**
 * Dựng ca từ CSDL của tổ chức ngữ cảnh — CHỈ ĐỌC. `limit` chia: mọi ca ORDER / DELETED_ORDER (tới trần), rồi NO_ORDER có SĐT,
 * rồi NO_ORDER không SĐT (tối đa 1/5 phần còn lại). Ca không còn tin khách nào trước mốc bị bỏ (đếm trong `skipped`).
 */
export async function buildSyncBenchCases(opts: { days: number; limit: number; now: Date; shop: string }): Promise<{ cases: SyncBenchCase[]; catalog: CatalogItem[]; skipped: Record<string, number> }> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const o = schema.orders;
  const from = new Date(opts.now.getTime() - opts.days * 86_400_000);
  const catalog = await sellableCatalog([]);
  const skipped: Record<string, number> = { noThread: 0, noCustomerMessage: 0 };
  const convs = await db
    .select({ id: c.id, pageId: c.pageId, threadId: c.threadId })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), isNotNull(c.pageId), isNotNull(c.threadId), gte(c.updatedAt, from)))
    .limit(5000);
  const convById = new Map(convs.map((x) => [x.id, x]));
  const ids = convs.map((x) => x.id);
  const orders = ids.length
    ? await db
        .select({ id: o.id, convId: o.salesConversationId, at: o.insertedAt, stage: o.stage, origin: o.origin, phone: o.shipPhone, bill: o.billPhone, address: o.shipFullAddress, addr2: o.shipAddress, name: o.billFullName })
        .from(o)
        .where(and(inArray(o.salesConversationId, ids), gte(o.insertedAt, from)))
        .orderBy(asc(o.insertedAt))
    : [];
  const items = orders.length ? await db.select({ orderId: schema.orderItems.orderId, variantId: schema.orderItems.variantId, productId: schema.orderItems.productId, quantity: schema.orderItems.quantity }).from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((x) => x.id))) : [];
  const itemsBy = new Map<string, typeof items>();
  for (const it of items) itemsBy.set(it.orderId, [...(itemsBy.get(it.orderId) ?? []), it]);
  const ordersByConv = new Map<string, typeof orders>();
  for (const x of orders) if (x.convId) ordersByConv.set(x.convId, [...(ordersByConv.get(x.convId) ?? []), x]);

  type Seed = { conv: (typeof convs)[number]; label: SyncBenchLabel; at: Date; prevAt: Date | null; truth: SyncBenchTruth | null; key: string };
  const seeds: Seed[] = [];
  for (const [convId, list] of ordersByConv) {
    const conv = convById.get(convId);
    if (!conv) continue;
    let prev: Date | null = null;
    for (const x of list) {
      const deleted = x.stage === "DELETED";
      if (deleted && x.origin !== "AI_ORDER_SYNC") continue;
      seeds.push({
        conv,
        label: deleted ? "DELETED_ORDER" : "ORDER",
        at: x.at,
        prevAt: prev,
        key: x.id,
        truth: deleted ? null : { phone: x.phone || x.bill || "", address: x.address || x.addr2 || "", name: x.name || "", lines: (itemsBy.get(x.id) ?? []).map((i) => ({ variantId: i.variantId, productId: i.productId, quantity: i.quantity })) },
      });
      if (!deleted) prev = x.at;
    }
  }
  const pos = seeds.slice(-Math.ceil(opts.limit * 0.6));
  const remaining = Math.max(0, opts.limit - pos.length);
  // NO_ORDER: hội thoại không có đơn nào trong cửa sổ — mốc = tin cuối + 1 phút.
  const t = schema.salesChatInbound;
  const noOrder = convs.filter((x) => !ordersByConv.has(x.id)).slice(0, 4000);
  const negSeeds: Seed[] = [];
  for (const conv of noOrder) {
    if (negSeeds.length >= remaining * 3) break;
    const [last] = await db.select({ at: t.createdAt }).from(t).where(and(eq(t.pageId, conv.pageId!), eq(t.threadId, conv.threadId!), gte(t.createdAt, from))).orderBy(desc(t.createdAt)).limit(1);
    if (!last) continue;
    negSeeds.push({ conv, label: "NO_ORDER", at: new Date(last.at.getTime() + 60_000), prevAt: null, truth: null, key: `no:${conv.id}` });
  }
  const cases: SyncBenchCase[] = [];
  const pushCase = async (s: Seed) => {
    if (!s.conv.pageId || !s.conv.threadId) {
      skipped.noThread += 1;
      return null;
    }
    const profile = await inboundThreadProfile(s.conv.pageId, s.conv.threadId, s.at, s.at, ORDER_SYNC_READ_LIMITS);
    const messages = numberMessages(profile.prior);
    const cutoffMs = syncCutoff([s.prevAt]);
    if (!messages.some((m) => m.from === "customer" && new Date(m.at).getTime() > cutoffMs)) {
      skipped.noCustomerMessage += 1;
      return null;
    }
    const prompt = orderSyncPrompt({ shop: opts.shop, catalog, messages, cutoffMs, returning: null, lastRecorded: s.prevAt ? `đơn trước lúc ${s.prevAt.toISOString()}` : null });
    let label = s.label;
    if (label === "NO_ORDER" && messages.some((m) => m.from === "customer" && phonesInText(m.text).length)) label = "NO_ORDER_PHONE";
    return { id: s.key, label, at: s.at.toISOString(), system: prompt.system, user: prompt.user, messages, cutoffMs, knownPhones: profile.phones, fallbackName: "Khách fanpage", truth: s.truth } satisfies SyncBenchCase;
  };
  for (const s of pos) {
    const x = await pushCase(s);
    if (x) cases.push(x);
  }
  const withPhone: SyncBenchCase[] = [];
  const noPhone: SyncBenchCase[] = [];
  for (const s of negSeeds) {
    if (withPhone.length + Math.min(noPhone.length, Math.floor(remaining / 5)) >= remaining) break;
    const x = await pushCase(s);
    if (!x) continue;
    (x.label === "NO_ORDER_PHONE" ? withPhone : noPhone).push(x);
  }
  const noPhoneQuota = Math.max(0, Math.min(noPhone.length, remaining - withPhone.length, Math.floor(remaining / 5)));
  cases.push(...withPhone.slice(0, remaining), ...noPhone.slice(0, noPhoneQuota));
  return { cases, catalog, skipped };
}

/** Chạy MỘT ca với MỘT cấu hình — không ghi gì. `make(cfg)` dựng provider (khoá nền tảng). */
export async function runSyncCase(c: SyncBenchCase, cfg: SyncBenchConfig, provider: AiProvider, catalog: readonly CatalogItem[]): Promise<SyncBenchResult> {
  const productOf = (v: string) => catalog.find((x) => x.variantId === v)?.productId ?? null;
  try {
    const res = await provider.complete({ system: c.system, messages: [{ role: "user", content: [{ type: "text", text: c.user }] }], tools: [], maxTokens: cfg.maxTokens, reasoning: cfg.reasoning });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
    const reply = parseOrderSyncReply(text);
    const decision = reply ? decideOrderSync({ reply, messages: c.messages, cutoffMs: c.cutoffMs, catalogIds: new Set(catalog.map((x) => x.variantId)), returning: null, knownPhones: c.knownPhones, fallbackName: c.fallbackName }) : null;
    const thinking = res.usage.thoughtTokens ?? 0;
    return {
      config: cfg.key,
      score: scoreSyncCase(c, Boolean(reply), decision, productOf),
      obs: { inputTokens: res.usage.inputTokens + res.usage.cacheReadTokens, candidateTokens: res.usage.outputTokens - thinking, thinkingTokens: thinking, latencyMs: res.latencyMs, costUsd: estimateCostUsd(res.model || cfg.model, res.usage), error: null },
    };
  } catch (e) {
    return { config: cfg.key, score: scoreSyncCase(c, false, null, productOf), obs: { inputTokens: 0, candidateTokens: 0, thinkingTokens: 0, latencyMs: 0, costUsd: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) } };
  }
}

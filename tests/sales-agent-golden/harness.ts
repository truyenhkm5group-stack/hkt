/**
 * ═══════════ BỘ HỘI THOẠI VÀNG — KHUNG CHẠY (M1 · docs/productization/MIGRATION_PLAN.md) ═══════════
 *
 * Phát lại những hội thoại có kịch bản qua ĐÚNG `chatTurn` của chatbot bán hàng, với model GIẢ (không gọi mạng — luật 65),
 * trên tổ chức PGlite thật, rồi chụp lại ba thứ:
 *  · LỜI NHẮC hệ thống mà engine dựng gửi model (mỗi bản khác nhau một lần);
 *  · CHUỖI CÔNG CỤ model gọi và KẾT QUẢ máy chủ trả về cho từng lượt (đã chuẩn hoá id / mốc giờ);
 *  · TRẠNG THÁI CUỐI: chữ khách thấy, trạng thái hội thoại, giai đoạn bán, đơn nháp / đơn chốt trong CSDL.
 *
 * Model giả KHÔNG đoán: mỗi lượt khách có một danh sách bước, mỗi bước là một lần engine hỏi model — bước nhận kết quả công
 * cụ của vòng trước. Engine hỏi nhiều vòng hơn kịch bản ⇒ model giả trả «[HẾT KỊCH BẢN]» và điều đó nằm TRONG ảnh chụp.
 *
 * Ảnh chụp nằm ở `tests/sales-agent-golden/snapshots/<khoá>.json`, vào kho cùng mã. Sửa engine / công cụ / lời nhắc mà đổi
 * hành vi ⇒ bài kiểm đỏ và in ĐÚNG chỗ khác; nếu thay đổi là cố ý: `npx tsx tests/sales-agent-golden/update.ts` rồi đọc
 * diff của ảnh chụp trong PR — người duyệt nhìn thấy hành vi bot đổi thế nào, không phải đoán.
 */
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createProductCore } from "@/lib/records/product-create";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { chatTurn, nowPromptLine, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { promptStampOf, type PromptStamp } from "@/lib/sales-chatbot/prompt-stamp";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";

// ═══ KỊCH BẢN ═══

export type StepCtx = {
  /** Mã mẫu mã (SKU) ⇒ id thật của tổ chức thử. */
  v: (sku: string) => string;
  /** Kết quả công cụ của vòng trước (đã parse JSON) — rỗng ở bước đầu của một lượt. */
  results: Record<string, unknown>[];
};
export type Step = (ctx: StepCtx) => AiBlock[];
/**
 * Ngữ cảnh của móc chạy TRONG tổ chức thử (bộ đo đơn vàng v2 — `tests/order-golden`): mã hội thoại THÔ (chưa chuẩn hoá),
 * bảng SKU ⇒ id, và quản trị của tổ chức để làm thao tác của NGƯỜI giữa hai lượt (tiếp quản · trả lại AI).
 */
export type GoldenHookCtx = { conversationId: string; ids: ReadonlyMap<string, string>; admin: () => Promise<SessionUser> };
/** `before` = việc xảy ra NGOÀI lượt của khách, ngay trước lượt này (nhân viên tiếp quản / trả lại AI). Bộ hội thoại vàng không dùng. */
export type GoldenTurn = { say: string; ai: Step[]; before?: (ctx: GoldenHookCtx) => Promise<void> };
/** `order-food` thuộc bộ đo đơn vàng v2 (`tests/order-golden`) — hội thoại vàng (M1) chỉ dùng `food` / `fashion`. */
export type GoldenShop = "food" | "fashion" | "order-food";
export type GoldenChannel = "WEB" | "TEST" | "FANPAGE" | "ZALO";
/**
 * `config` = phần ĐÈ lên cấu hình bot của cửa hàng thử CHỈ trong hội thoại này (vd kiến thức của shop — sổ AIS-05); trả lại
 * cấu hình gốc ngay sau hội thoại, nên hội thoại khác của cùng cửa hàng không bị ảnh hưởng. Bỏ trống ⇒ như trước.
 */
export type GoldenCase = { key: string; title: string; shop: GoldenShop; channel: GoldenChannel; turns: GoldenTurn[]; config?: Partial<SalesChatbotConfig> };
/**
 * Tuỳ chọn của một lượt chạy (bộ đo đơn vàng v2). `beforeCase` chạy TRONG tổ chức thử trước khi mở hội thoại (bật công tắc của
 * tổ chức, gieo hồ sơ khách); `afterCase` chạy TRONG tổ chức thử sau lượt cuối, khi CSDL còn nguyên (đọc đơn, sự kiện).
 * `orgSuffix` = hậu tố mã tổ chức thử: handle PGlite của tổ chức đã dọn vẫn mở trong tiến trình (`db/index.ts` chỉ đóng theo
 * LRU), nên cấp lại CÙNG mã trong một tiến trình đọc lại dữ liệu cũ — lượt cần tổ chức mới tinh thì dùng hậu tố riêng.
 * Bỏ trống mọi thứ ⇒ hành vi và ảnh chụp của hội thoại vàng y như trước.
 */
export type GoldenRunOptions = {
  orgSuffix?: string;
  beforeCase?: (c: GoldenCase, ctx: Omit<GoldenHookCtx, "conversationId">) => Promise<void>;
  afterCase?: (c: GoldenCase, ctx: GoldenHookCtx, transcript: GoldenTranscript) => Promise<void>;
};

let toolSeq = 0;
export const say = (text: string): AiBlock => ({ type: "text", text });
export const tool = (name: string, input: unknown): AiBlock => ({ type: "tool_use", id: `tu-${++toolSeq}`, name, input });

// ═══ CỬA HÀNG THỬ ═══

type ProductSeed = { name: string; sku: string; price: number; size: string; stock: number };

/** `shippingFee` khai ⇒ đè phí ship của cấu hình bot (mặc định `null` = «nhân viên báo sau»). */
export const GOLDEN_SHOPS: Record<GoldenShop, { code: string; name: string; templateKey: string; products: ProductSeed[]; shippingFee?: number }> = {
  food: {
    code: "gd-food",
    name: "Hải sản thử vàng",
    templateKey: "food-commerce",
    products: [
      { name: "Chả mực giã tay", sku: "CHA-MUC", price: 400_000, size: "1kg", stock: 10 },
      { name: "Ruốc bông tôm 100%", sku: "RUOC-TOM", price: 350_000, size: "250g", stock: 10 },
      { name: "Mực khô câu", sku: "MUC-KHO", price: 1_200_000, size: "500g", stock: 2 },
    ],
  },
  fashion: {
    code: "gd-fashion",
    name: "Thời trang thử vàng",
    templateKey: "fashion-commerce",
    products: [{ name: "Đầm suông linen", sku: "DAM-LINEN-M", price: 459_000, size: "M", stock: 5 }],
  },
  // Bộ đo đơn vàng v2: tồn RỘNG (mỗi lượt chạy chốt hàng chục đơn — tồn không được là thứ đổi kết quả), có MỘT sản phẩm hai quy
  // cách (chọn đúng biến thể), một mẫu mã bán theo gói nhỏ (quy đổi đơn vị), phí ship cố định (tổng = tiền hàng + ship).
  "order-food": {
    code: "og-food",
    name: "Hải sản thử đơn vàng",
    templateKey: "food-commerce",
    shippingFee: 30_000,
    products: [
      { name: "Chả mực giã tay", sku: "CHA-MUC", price: 400_000, size: "1kg", stock: 1000 },
      { name: "Chả cá thu", sku: "CHA-CA-500", price: 180_000, size: "500g", stock: 1000 },
      { name: "Chả cá thu", sku: "CHA-CA-1KG", price: 340_000, size: "1kg", stock: 1000 },
      { name: "Ruốc bông tôm 100%", sku: "RUOC-TOM", price: 350_000, size: "250g", stock: 1000 },
    ],
  },
};

const ADMIN = (code: string) => `chu@${code}.local`;

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(code: string): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN(code)) });
  if (!u) throw new Error(`thiếu quản trị ${code}`);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false }, modules: [...(await getEnabledModules(code))] };
}

/** Cấu hình bot gốc của cửa hàng thử (bật, khoá riêng — model giả thay thế). */
function shopBotConfig(shop: GoldenShop): SalesChatbotConfig {
  return { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: GOLDEN_SHOPS[shop].shippingFee ?? null };
}

/** Cấp tổ chức `code`, nạp sản phẩm + tồn, bật bot (khoá riêng — model giả thay thế). Trả bảng SKU ⇒ id mẫu mã. */
async function setupShop(shop: GoldenShop, code: string): Promise<Map<string, string>> {
  const spec = GOLDEN_SHOPS[shop];
  await cleanupOrg(code);
  await provisionOrganization({ code, name: spec.name, plan: "trial", templateKey: spec.templateKey, modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN(code), name: "Chủ shop", password: "HoiThoaiVang@2026!" }, source: "TEST", actor: null });
  return withOrganization(code, async () => {
    const db = await getDb();
    const admin = await adminOf(code);
    const ids = new Map<string, string>();
    for (const p of spec.products) {
      const r = await createProductCore(admin, { name: p.name, code: p.sku, unit: "cái", retailPrice: p.price, cost: null, variants: [{ sku: p.sku, size: p.size, color: "", retailPrice: p.price, cost: null, selling: true }] });
      if (!r.ok) throw new Error(`không tạo được ${p.sku}: ${JSON.stringify(r)}`);
      const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, r.id) });
      if (!v) throw new Error(`thiếu mẫu mã ${p.sku}`);
      ids.set(p.sku, v.id);
    }
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: `PN-${code}`, totalQuantity: spec.products.reduce((s, p) => s + p.stock, 0), createdBy: ADMIN(code) }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values(spec.products.map((p) => ({ receiptId: rc.id, variantId: ids.get(p.sku)!, quantity: p.stock, unitCost: Math.round(p.price / 2) })));
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, shopBotConfig(shop));
    return ids;
  });
}

// ═══ CHUẨN HOÁ ẢNH CHỤP ═══

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const SHORT_CODE_RE = /#[0-9A-F]{8}\b/g;

/**
 * NGỮ CẢNH mà lời nhắc in NGÀY CHẠY (giờ VN) — ngày chạy chỉ được nhãn hoá ở đúng các chỗ này, không ở mọi chuỗi trùng ngày.
 * «gần nhất <ngày>»: khối KHÁCH CŨ (lib/sales-chatbot/returning.ts) in ngày đơn cũ vừa gieo = hôm nay. Dòng «bây giờ» đi đường
 * riêng (`nowLines`). Lời nhắc thêm một chỗ in ngày động mới ⇒ thêm tiền tố ở đây (ảnh chụp sẽ đỏ, chỉ đúng chỗ đó).
 */
export const RUN_DATE_CONTEXTS = ["gần nhất "] as const;

/** Ngày theo giờ Việt Nam đúng dạng lời nhắc in («05/10/2026»). */
const vnDate = (d: Date) => new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);

/**
 * Thay id / mốc giờ / mã đơn ngắn / dòng «bây giờ» / NGÀY CHẠY bằng nhãn ổn định — cùng một id luôn ra cùng một nhãn trong
 * một hội thoại. Ngày chạy (giờ VN, của chính lượt chạy) phải thành nhãn: khối KHÁCH CŨ in «gần nhất <ngày đơn vừa gieo>», nên
 * ảnh chụp ghi ngày thật thì bài kiểm đỏ lúc 0 giờ hôm sau (05/10/2026 — chặn mọi PR và mọi deploy; AGENTS.md mục 50).
 *
 * Ngày chạy CHỈ thay trong `RUN_DATE_CONTEXTS`: ngày CỐ ĐỊNH trong chữ tĩnh của lời nhắc («MỤC TIÊU (chủ shop 09/10/2026)», #701)
 * trùng ngày ghi ảnh chụp thì bản cũ (thay MỌI chuỗi trùng) nhãn hoá luôn chữ tĩnh ⇒ main đỏ từ 0 giờ hôm sau (10/10/2026).
 */
export function normalizer(nowLines: Set<string>, skuOfId: Map<string, string>, runDates: Set<string>) {
  const ids = new Map<string, string>();
  const str = (s: string): string => {
    let out = s;
    for (const line of nowLines) out = out.split(line).join("<BÂY GIỜ>");
    for (const d of runDates) for (const ctx of RUN_DATE_CONTEXTS) out = out.split(`${ctx}${d}`).join(`${ctx}<NGÀY CHẠY>`);
    // Mã mẫu mã có thể mang tiền tố trước phần UUID — thay NGUYÊN mã trước, rồi mới tới UUID trần.
    for (const [id, sku] of skuOfId) out = out.split(id).join(`<mẫu ${sku}>`);
    out = out.replace(UUID_RE, (m) => {
      if (!ids.has(m.toLowerCase())) ids.set(m.toLowerCase(), `<id ${ids.size + 1}>`);
      return ids.get(m.toLowerCase())!;
    });
    return out.replace(ISO_RE, "<mốc giờ>").replace(SHORT_CODE_RE, "#<MÃ ĐƠN>");
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return str(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk;
}

// ═══ CHẠY ═══

export type GoldenTranscript = {
  key: string;
  title: string;
  shop: GoldenShop;
  channel: GoldenChannel;
  /** Lời nhắc hệ thống KHÁC NHAU theo thứ tự xuất hiện; mỗi vòng model trỏ vào một chỉ số. */
  prompts: string[];
  turns: {
    customer: string;
    rounds: { prompt: number; tools: { name: string; input: unknown }[]; text: string; results: unknown[] }[];
    shown: string[];
    status: string;
  }[];
  final: {
    status: string;
    handoffReason: string | null;
    stage: string | null;
    customer: { name: string; phone: string; address: string; simulated: boolean } | null;
    draft: { lines: { sku: string; quantity: number; unitPrice: number | null }[]; simulated: boolean } | null;
    /**
     * `stamp` (Order Truth): dấu lời nhắc trên đơn chốt — `promptHashOk` = băm của ĐÚNG lời nhắc + tập công cụ mà lượt ra lệnh
     * `confirm_order` đã gửi model (tính lại từ bản thô ở đây, không chép số băm vào ảnh chụp vì lời nhắc có ngày chạy).
     */
    confirmed: { total: number; simulated: boolean; stamp: { promptHashOk: boolean; model: string | null; codeVersion: string | null } | null } | null;
    declined: string | null;
    /** Sổ chi phí AI của hội thoại: mọi dòng `ref` = hội thoại có mang `conversation_id` = hội thoại (ALL) — không còn phải tra qua `ref`. */
    aiUsageConversation: "ALL" | "SOME" | "NONE" | "NO_ROWS";
    order: { stage: string; total: number; source: string; shipAddress: string; items: { sku: string; quantity: number; price: number }[] } | null;
  };
};

async function runCase(c: GoldenCase, ids: Map<string, string>, code: string, hooks: GoldenRunOptions): Promise<GoldenTranscript> {
  const skuOfId = new Map([...ids.entries()].map(([sku, id]) => [id.toLowerCase(), sku]));
  const nowLines = new Set<string>();
  // Ngày VN từ lúc gieo dữ liệu tới lượt cuối — chạy vắt qua nửa đêm thì cả hai ngày đều là «ngày chạy».
  const runDates = new Set<string>([vnDate(new Date())]);
  const promptsRaw: string[] = [];
  let steps: Step[] = [];
  let stepIdx = 0;
  let rounds: GoldenTranscript["turns"][number]["rounds"] = [];
  // Bản THÔ của mỗi vòng (không vào ảnh chụp): lời nhắc + tên công cụ gửi model + công cụ model gọi — để kiểm dấu lời nhắc.
  const rawRounds: { system: string; toolNames: string[]; calls: string[] }[] = [];
  const provider: AiProvider = {
    name: "golden-fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      const last = req.messages[req.messages.length - 1];
      const results = last && last.role === "user" ? last.content.filter((b): b is Extract<AiBlock, { type: "tool_result" }> => b.type === "tool_result").map((b) => JSON.parse(b.content) as Record<string, unknown>) : [];
      if (rounds.length) rounds[rounds.length - 1].results = results;
      let pi = promptsRaw.indexOf(req.system);
      if (pi < 0) pi = promptsRaw.push(req.system) - 1;
      const step = steps[stepIdx++];
      const content = step ? step({ v: (sku) => ids.get(sku) ?? `KHÔNG-CÓ-${sku}`, results }) : [say("[HẾT KỊCH BẢN]")];
      rounds.push({ prompt: pi, tools: content.filter((b): b is Extract<AiBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input })), text: content.filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n"), results: [] });
      rawRounds.push({ system: req.system, toolNames: req.tools.map((t) => t.name), calls: content.filter((b): b is Extract<AiBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => b.name) });
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };

  return withOrganization(code, async () => {
    const db = await getDb();
    const admin = () => adminOf(code);
    if (hooks.beforeCase) await hooks.beforeCase(c, { ids, admin });
    if (c.config) await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...shopBotConfig(c.shop), ...c.config });
    setSalesChatProviderForTests(() => provider);
    try {
      // Web / fanpage là kênh công khai: hội thoại khoá theo mã khách. Fanpage ở đây KHÔNG qua Pancake — chỉ chạy lượt của engine
      // trên kênh FANPAGE / ZALO để khoá các luật riêng của kênh nhắn tin (vd chuyển người thì bot im).
      const visitorKey = c.channel === "TEST" ? null : visitorKeyOf(`hoi-thoai-vang-${c.key}-0123456789abcdef`);
      const conv = await openConversation(c.channel, c.channel === "TEST" ? { createdBy: ADMIN(code) } : { visitorKey });
      const turns: GoldenTranscript["turns"] = [];
      let seen = 0;
      for (const t of c.turns) {
        if (t.before) await t.before({ conversationId: conv.id, ids, admin });
        steps = t.ai;
        stepIdx = 0;
        rounds = [];
        const now = new Date();
        nowLines.add(nowPromptLine(now));
        runDates.add(vnDate(now));
        const res = await chatTurn(conv.id, t.say, { channel: c.channel, visitorKey, now });
        if (!res.ok) throw new Error(`[${c.key}] lượt «${t.say}» lỗi: ${res.error}`);
        const msgs = res.view.messages;
        const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
        const shown = msgs.slice(Math.max(lastUser + 1, seen)).filter((m) => m.role === "assistant" && m.text.trim()).map((m) => m.text);
        seen = msgs.length;
        turns.push({ customer: t.say, rounds, shown, status: res.view.status });
      }
      const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conv.id));
      const st = (row.state ?? {}) as ChatState;
      const stampOf = (stamp: PromptStamp | undefined) =>
        stamp
          ? {
              promptHashOk: rawRounds.some((r) => r.calls.includes("confirm_order") && promptStampOf({ system: r.system, tools: r.toolNames, config: null, model: null, codeVersion: null }).promptHash === stamp.promptHash),
              model: stamp.model,
              codeVersion: stamp.codeVersion,
            }
          : null;
      const u = schema.platformAiUsage;
      const usageRows = await (await getPlatformDb()).select({ conversationId: u.conversationId }).from(u).where(and(eq(u.orgCode, code), eq(u.ref, conv.id)));
      const withConv = usageRows.filter((r) => r.conversationId === conv.id).length;
      const aiUsageConversation = usageRows.length === 0 ? "NO_ROWS" : withConv === usageRows.length ? "ALL" : withConv === 0 ? "NONE" : "SOME";
      let order: GoldenTranscript["final"]["order"] = null;
      const orderId = row.orderId ?? row.draftOrderId;
      if (orderId) {
        const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
        const items = await db.select({ variantId: schema.orderItems.variantId, quantity: schema.orderItems.quantity, price: schema.orderItems.unitPrice }).from(schema.orderItems).where(and(eq(schema.orderItems.orderId, orderId)));
        if (o) order = { stage: o.stage, total: o.totalPriceAfterDiscount, source: o.source ?? "", shipAddress: o.shipAddress, items: items.map((i) => ({ sku: skuOfId.get(String(i.variantId).toLowerCase()) ?? String(i.variantId), quantity: i.quantity, price: Number(i.price) })).sort((a, b) => a.sku.localeCompare(b.sku)) };
      }
      const transcript: GoldenTranscript = {
        key: c.key,
        title: c.title,
        shop: c.shop,
        channel: c.channel,
        prompts: promptsRaw,
        turns,
        final: {
          status: row.status,
          handoffReason: row.handoffReason,
          stage: st.stage ?? null,
          customer: st.customer ? { name: st.customer.name, phone: st.customer.phone, address: st.customer.address, simulated: st.customer.simulated } : null,
          draft: st.draft ? { lines: st.draft.lines.map((l) => ({ sku: skuOfId.get(l.variantId.toLowerCase()) ?? l.variantId, quantity: l.quantity, unitPrice: st.draft?.unitPrices[l.variantId] ?? null })), simulated: st.draft.simulated } : null,
          confirmed: st.confirmed ? { total: st.confirmed.total, simulated: st.confirmed.simulated, stamp: stampOf(st.confirmed.stamp) } : null,
          declined: st.declined?.reason ?? null,
          aiUsageConversation,
          order,
        },
      };
      const normalized = normalizer(nowLines, skuOfId, runDates)(transcript) as GoldenTranscript;
      if (hooks.afterCase) await hooks.afterCase(c, { conversationId: conv.id, ids, admin }, normalized);
      return normalized;
    } finally {
      setSalesChatProviderForTests(null);
      if (c.config) await setSettingJson(SALES_CHATBOT_SETTING_KEY, shopBotConfig(c.shop));
    }
  });
}

/**
 * Chạy mọi hội thoại vàng trên tổ chức thử mới tinh (dọn trước và sau). Trả ảnh chụp đã chuẩn hoá theo khoá. `opts` (bộ đo đơn
 * vàng v2) — hậu tố mã tổ chức + móc quanh từng hội thoại; bỏ trống ⇒ đúng hành vi của hội thoại vàng.
 */
export async function runGoldenCases(cases: readonly GoldenCase[], opts: GoldenRunOptions = {}): Promise<Map<string, GoldenTranscript>> {
  const out = new Map<string, GoldenTranscript>();
  const shops = [...new Set(cases.map((c) => c.shop))];
  const codeOf = (shop: GoldenShop) => `${GOLDEN_SHOPS[shop].code}${opts.orgSuffix ?? ""}`;
  try {
    for (const shop of shops) {
      const ids = await setupShop(shop, codeOf(shop));
      for (const c of cases.filter((x) => x.shop === shop)) out.set(c.key, await runCase(c, ids, codeOf(shop), opts));
    }
  } finally {
    for (const shop of shops) await cleanupOrg(codeOf(shop));
  }
  return out;
}

/** Đường dẫn ĐẦU TIÊN hai giá trị khác nhau (để thông điệp đỏ đọc được, không phải hai cục JSON dài). */
export function firstDiff(a: unknown, b: unknown, path = "$"): { path: string; expected: unknown; actual: unknown } | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return JSON.stringify(a) === JSON.stringify(b) ? null : { path, expected: a, actual: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, expected: a, actual: b };
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
  for (const k of keys) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

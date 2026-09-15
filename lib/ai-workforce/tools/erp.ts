/**
 * CÔNG CỤ ERP cho nhân sự AI.
 *
 * Mỗi công cụ là một lớp mỏng bọc quanh LOGIC ĐANG CHẠY của ERP — không có một công thức nghiệp
 * vụ nào được viết lại ở đây. Tồn kho đi qua `lib/queries/stock.ts`, phí ship đi qua
 * `landingShippingFee()`, địa chỉ đi qua `addressIssue()`, ghép mẫu mã đi qua `matchVariant()`,
 * tạo đơn đi qua `PancakeClient.createOrder()`. Viết lại một trong số đó là tạo ra nguồn sự thật
 * thứ hai, và hai nguồn sẽ lệch nhau đúng vào ngày cần chúng khớp.
 *
 * GIÁ VÀ TỒN LUÔN DO MÁY CHỦ TÍNH. Con số do mô hình nói ra chỉ là văn bản; dây chuyền đối chiếu
 * nó với số ở đây và lệch thì chuyển người.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { defineTool, registeredTools, type ToolContext } from "@/lib/ai-workforce/tools/gateway";
import { DEFAULT_LANDING_CONFIG, LANDING_CONFIG_KEY, addressIssue, landingShippingFee, normalizePhone, type LandingConfig } from "@/lib/constants/landing";
import { availableStockExpr, erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { normalize } from "@/lib/text";
import { getSettingJson } from "@/lib/settings";
import { getPancakeClient } from "@/lib/integrations/pancake/client";
import { SALES_STALE_HOURS } from "@/lib/constants/sales-agent";
import { DEFAULT_SIZE_RULES, recommendSize, resolveSizeRule, SIZE_RULES_KEY, sizeNeedsHuman, type SizeRule } from "@/lib/constants/size-engine";
import type { ToolName } from "@/lib/constants/ai-tools";

const p = schema.products;
const pv = schema.productVariants;

async function landingConfig(): Promise<LandingConfig> {
  return getSettingJson<LandingConfig>(LANDING_CONFIG_KEY, DEFAULT_LANDING_CONFIG);
}


// ───────────────────────── product.search ─────────────────────────

/**
 * Chấm điểm một sản phẩm so với câu khách nhắn. Cùng một ý tưởng với `matchVariant()` của trang
 * Landing — mã hàng nặng điểm nhất, rồi tới tên đầy đủ, rồi tới các từ của tên — nhưng chấm ở
 * mức SẢN PHẨM, vì tin nhắn đầu tiên của khách thường chưa có size/màu để khoá mẫu mã.
 *
 * HÀM THUẦN, tách riêng để kiểm thử được từng luật chấm điểm.
 */
export function scoreProductMatch(text: string, name: string, code: string): number {
  const haystack = normalize(text);
  const c = normalize(code).trim();
  if (c && haystack.includes(` ${c} `)) return 5;
  const n = normalize(name).trim();
  if (n && haystack.includes(n)) return 4;
  const words = n.split(" ").filter((w) => w.length >= 3);
  if (!words.length) return 0;
  const hit = words.filter((w) => haystack.includes(` ${w} `)).length;
  if (hit === words.length) return 3;
  if (words.length >= 2 && hit >= 2) return 2;
  return 0;
}

export const productSearchTool = defineTool({
  name: "product.search",
  describe: "Tìm sản phẩm đang bán từ câu khách nhắn (hoặc từ khoá / mã hàng). Trả về các ứng viên kèm điểm khớp và cờ cho biết ứng viên đầu có duy nhất hay không.",
  input: z.object({ query: z.string().trim().min(1, "Phải có từ khoá tìm"), limit: z.number().int().min(1).max(10).optional() }),
  async handler({ query, limit }) {
    const db = await getDb();
    const rows = await db
      .select({
        id: p.id,
        name: p.name,
        code: p.customId,
        variants: sql<number>`count(${pv.id})`,
        minPrice: sql<number>`coalesce(min(nullif(${pv.retailPrice}, 0)), 0)`,
        maxPrice: sql<number>`coalesce(max(${pv.retailPrice}), 0)`,
      })
      .from(p)
      .innerJoin(pv, eq(pv.productId, p.id))
      .where(and(eq(p.isRemoved, false), eq(p.isHidden, false), eq(pv.isRemoved, false)))
      .groupBy(p.id, p.name, p.customId)
      .limit(3000);

    const scored = rows
      .map((r) => ({ row: r, score: scoreProductMatch(query, r.name, r.code ?? "") }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));

    const top = scored.slice(0, limit ?? 5);
    return {
      query,
      // Hai ứng viên bằng điểm = CHƯA BIẾT khách hỏi mẫu nào; dây chuyền phải hỏi lại, không đoán.
      bestIsUnique: scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score),
      products: top.map((x) => ({
        productId: x.row.id,
        name: x.row.name,
        code: x.row.code ?? "",
        score: x.score,
        variantCount: Number(x.row.variants),
        priceFrom: Number(x.row.minPrice) || null,
        priceTo: Number(x.row.maxPrice) || null,
      })),
    };
  },
});

// ───────────────────────── product.get ─────────────────────────

export const productGetTool = defineTool({
  name: "product.get",
  describe: "Chi tiết một sản phẩm theo mã sản phẩm ERP.",
  input: z.object({ productId: z.string().trim().min(1) }),
  async handler({ productId }) {
    const db = await getDb();
    const row = await db.query.products.findFirst({ where: eq(p.id, productId), columns: { id: true, name: true, customId: true, image: true, isHidden: true, isRemoved: true } });
    if (!row) throw new Error(`Không có sản phẩm ${productId} trong ERP`);
    return { productId: row.id, name: row.name, code: row.customId ?? "", image: row.image ?? "", selling: !row.isHidden && !row.isRemoved };
  },
});

// ───────────────────────── product.get_variants ─────────────────────────

export const productVariantsTool = defineTool({
  name: "product.get_variants",
  describe: "Danh sách mẫu mã (size + màu) của một sản phẩm, kèm giá niêm yết của từng mẫu.",
  input: z.object({ productId: z.string().trim().min(1) }),
  async handler({ productId }) {
    const db = await getDb();
    const rows = await db
      .select({ id: pv.id, sku: pv.sku, size: pv.size, color: pv.color, price: pv.retailPrice, hidden: pv.isHidden, removed: pv.isRemoved })
      .from(pv)
      .where(and(eq(pv.productId, productId), eq(pv.isRemoved, false)))
      .orderBy(pv.size, pv.color)
      .limit(200);
    const selling = rows.filter((r) => !r.hidden && !r.removed);
    const sizes = [...new Set(selling.map((r) => r.size).filter(Boolean))];
    const colors = [...new Set(selling.map((r) => r.color).filter(Boolean))];
    return {
      productId,
      variants: selling.map((r) => ({ variantId: r.id, sku: r.sku, size: r.size, color: r.color, price: Number(r.price) || null })),
      sizes,
      colors,
      /** Còn phải hỏi khách size / màu hay không — dây chuyền dùng đúng hai cờ này, không tự suy. */
      needsSize: sizes.length > 1,
      needsColor: colors.length > 1,
    };
  },
});

// ───────────────────────── pricing.get ─────────────────────────

/**
 * ĐƠN GIÁ CỦA MỘT MẪU MÃ — một bậc thẩm quyền, dùng chung cho cả giá mẫu mã lẫn giá sản phẩm.
 *
 * Giá niêm yết 0đ trên Pancake là CHƯA KHAI, không phải "cho không" — rơi về giá lẻ mặc định của
 * cấu hình landing, đúng như quy tắc đang áp cho đơn landing page.
 */
function donGia(row: { price: unknown; discounted: unknown }, giaMacDinh: number): { unit: number; source: string } {
  if (Number(row.discounted)) return { unit: Number(row.discounted), source: "variant_discounted" };
  if (Number(row.price)) return { unit: Number(row.price), source: "variant_retail" };
  return { unit: giaMacDinh, source: "landing_default" };
}

export const pricingGetTool = defineTool({
  name: "pricing.get",
  describe: "Giá bán do MÁY CHỦ tính. Nhận `variantId` (giá của đúng mẫu mã đó) HOẶC `productId` (giá của sản phẩm, chỉ khi mọi mẫu mã cùng một giá). Đây là con số duy nhất được phép nói với khách.",
  /*
    NHẬN CẢ `productId`, VÌ KHÁCH HỎI GIÁ TRƯỚC KHI CHỌN SIZE.

    ĐO 15/09/2026 trên mẻ sạch 18 hội thoại: 0/18 câu trả lời nêu được một con số tiền. Nguyên nhân
    không nằm ở mô hình mà nằm ở đây — giá chỉ tính được khi đã có `variantId`, còn khách thì hỏi
    "bao nhiêu một đằm vậy" NGAY TỪ TIN ĐẦU. Máy buộc phải đáp "chị cho em xin size để em báo giá",
    tức là bắt khách trả lời trước khi được trả lời. Một người bán hàng không ai làm thế.

    VÀ VẪN KHÔNG ĐƯỢC ĐOÁN: giá sản phẩm chỉ có nghĩa khi MỌI mẫu mã đang bán cùng một đơn giá.
    Lệch giá giữa các size là chuyện có thật (size lớn đắt hơn), nên ở đó câu trả lời đúng là
    `ambiguous` kèm dải giá — để dây chuyền hỏi tiếp, chứ không phải lấy bừa giá thấp nhất rồi hứa
    một con số shop không bán.
  */
  input: z
    .object({
      variantId: z.string().trim().min(1).optional(),
      productId: z.string().trim().min(1).optional(),
      quantity: z.number().int().min(1).max(20).optional(),
    })
    .refine((v) => Boolean(v.variantId) !== Boolean(v.productId), "Phải truyền ĐÚNG MỘT trong variantId / productId"),
  async handler({ variantId, productId, quantity }) {
    const db = await getDb();
    const cfg = await landingConfig();
    const qty = quantity ?? 1;
    const shippingFee = landingShippingFee(qty, cfg.shippingFee);

    if (variantId) {
      const row = await db
        .select({ id: pv.id, price: pv.retailPrice, discounted: pv.retailPriceAfterDiscount, name: p.name, sku: pv.sku, size: pv.size, color: pv.color })
        .from(pv)
        .innerJoin(p, eq(p.id, pv.productId))
        .where(eq(pv.id, variantId))
        .limit(1);
      const variant = row[0];
      if (!variant) throw new Error(`Không có mẫu mã ${variantId} trong ERP`);
      const { unit, source } = donGia(variant, cfg.singlePrice);
      const goodsTotal = unit * qty;
      return {
        scope: "VARIANT" as const,
        ambiguous: false,
        variantId,
        label: `${variant.name} · ${[variant.size, variant.color].filter(Boolean).join(" ")}`.trim(),
        quantity: qty,
        unitPrice: unit,
        goodsTotal,
        shippingFee,
        total: goodsTotal + shippingFee,
        priceSource: source,
        currency: "VND",
      };
    }

    const rows = await db
      .select({ price: pv.retailPrice, discounted: pv.retailPriceAfterDiscount, name: p.name })
      .from(pv)
      .innerJoin(p, eq(p.id, pv.productId))
      .where(eq(pv.productId, productId!));
    if (!rows.length) throw new Error(`Không có mẫu mã nào của sản phẩm ${productId} trong ERP`);
    const gia = rows.map((r) => donGia(r, cfg.singlePrice));
    const dat = [...new Set(gia.map((g) => g.unit))];
    const ten = rows[0].name ?? "";
    if (dat.length > 1) {
      // CHƯA BIẾT một con số, và nói thẳng là chưa biết. Dải giá đi kèm để dây chuyền còn hỏi được
      // câu tiếp theo cho đúng chỗ, KHÔNG phải để in ra cho khách như một lời chào giá.
      return {
        scope: "PRODUCT" as const,
        ambiguous: true,
        productId,
        label: ten,
        quantity: qty,
        unitPrice: null,
        goodsTotal: null,
        shippingFee,
        total: null,
        minUnitPrice: Math.min(...dat),
        maxUnitPrice: Math.max(...dat),
        variantCount: rows.length,
        priceSource: "variant_mixed",
        currency: "VND",
      };
    }
    const unit = dat[0];
    const goodsTotal = unit * qty;
    return {
      scope: "PRODUCT" as const,
      ambiguous: false,
      productId,
      label: ten,
      quantity: qty,
      unitPrice: unit,
      goodsTotal,
      shippingFee,
      total: goodsTotal + shippingFee,
      variantCount: rows.length,
      priceSource: gia[0].source,
      currency: "VND",
    };
  },
});

// ───────────────────────── promotion.get ─────────────────────────

export const promotionGetTool = defineTool({
  name: "promotion.get",
  describe: "Ưu đãi đang chạy theo cấu hình shop (giá gói, miễn phí ship từ N sản phẩm). Không có cấu hình thì trả về chưa khai.",
  input: z.object({ quantity: z.number().int().min(1).max(20).optional() }),
  async handler({ quantity }) {
    const cfg = await landingConfig();
    const qty = quantity ?? 1;
    const freeShip = landingShippingFee(qty, cfg.shippingFee) === 0 && cfg.shippingFee > 0;
    return {
      configured: cfg.shippingFee > 0 || cfg.singlePrice > 0,
      quantity: qty,
      freeShipping: freeShip,
      freeShippingFrom: 2,
      shippingFee: landingShippingFee(qty, cfg.shippingFee),
      note: freeShip ? "Mua từ 2 sản phẩm được miễn phí vận chuyển" : `Đơn 1 sản phẩm chịu phí vận chuyển ${cfg.shippingFee}đ`,
    };
  },
});

// ───────────────────────── inventory.check ─────────────────────────

export const inventoryCheckTool = defineTool({
  name: "inventory.check",
  describe: "Tồn khả dụng của một mẫu mã theo SỔ KHO ERP. Mẫu mã chưa có phiếu nhập nào thì tồn là CHƯA BIẾT, không phải 0.",
  input: z.object({ variantId: z.string().trim().min(1) }),
  async handler({ variantId }) {
    const db = await getDb();
    const sales = variantSalesSubquery(db);
    const receipts = variantReceiptsSubquery(db);
    const rows = await db
      .select({
        id: pv.id,
        known: stockKnownExpr(receipts),
        onHand: erpStockExpr(sales, receipts),
        available: availableStockExpr(sales, receipts),
      })
      .from(pv)
      .leftJoin(sales, eq(sales.variantId, pv.id))
      .leftJoin(receipts, eq(receipts.variantId, pv.id))
      .where(eq(pv.id, variantId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Không có mẫu mã ${variantId} trong ERP`);
    const known = Boolean(row.known);
    // CHƯA BIẾT không được in ra thành 0: chưa có phiếu nhập nào thì mọi con số tồn đều là bịa.
    return {
      variantId,
      stockKnown: known,
      onHand: known ? Number(row.onHand ?? 0) : null,
      available: known ? Number(row.available ?? 0) : null,
      /** Có nên hứa với khách là còn hàng không. Chưa biết ⇒ KHÔNG hứa. */
      canPromise: known && Number(row.available ?? 0) > 0,
      note: known ? "" : "Mẫu mã chưa có phiếu nhập trong ERP — chưa xác định được tồn, không hứa còn hàng với khách",
    };
  },
});

// ───────────────────────── size.recommend ─────────────────────────

export const sizeRecommendTool = defineTool({
  name: "size.recommend",
  describe:
    "Gợi ý size theo BẢNG SỐ ĐO của shop. Nhận chiều cao, cân nặng, vòng ngực, vòng eo, vòng mông. Chưa khai bảng số đo thì trả SIZE_DATA_MISSING — KHÔNG đoán.",
  input: z.object({
    variantId: z.string().trim().optional(),
    productId: z.string().trim().optional(),
    heightCm: z.number().min(80).max(230).nullable().optional(),
    weightKg: z.number().min(20).max(200).nullable().optional(),
    bustCm: z.number().min(40).max(200).nullable().optional(),
    waistCm: z.number().min(30).max(200).nullable().optional(),
    hipCm: z.number().min(40).max(220).nullable().optional(),
  }),
  async handler(args) {
    const stored = await getSettingJson<{ version: string; rules: SizeRule[] }>(SIZE_RULES_KEY, DEFAULT_SIZE_RULES);
    const rules = Array.isArray(stored.rules) ? stored.rules : [];
    // Nhóm hàng lấy từ mã hàng của sản phẩm (Q002 → Q) — đủ để một bảng áp cho cả dòng đầm.
    let family: string | null = null;
    let productId = args.productId ?? null;
    if (args.variantId) {
      const db = await getDb();
      const row = await db
        .select({ productId: pv.productId, code: p.customId })
        .from(pv)
        .innerJoin(p, eq(p.id, pv.productId))
        .where(eq(pv.id, args.variantId))
        .limit(1);
      if (row[0]) {
        productId = productId ?? row[0].productId;
        family = /^([A-Za-z]{1,2})\d{3}$/.exec(row[0].code ?? "")?.[1]?.toUpperCase() ?? null;
      }
    }
    const rule = resolveSizeRule(rules, { variantId: args.variantId ?? null, productId, family });
    const result = recommendSize(rule, {
      heightCm: args.heightCm ?? null,
      weightKg: args.weightKg ?? null,
      bustCm: args.bustCm ?? null,
      waistCm: args.waistCm ?? null,
      hipCm: args.hipCm ?? null,
    });
    return {
      ...result,
      // Chỉ mã OK mới được nói với khách; mọi mã khác phải chuyển người.
      needsHuman: sizeNeedsHuman(result.code),
      rulesDeclared: rules.length,
    };
  },
});

// ───────────────────────── shipping.policy / shipping.calculate ─────────────────────────

export const shippingPolicyTool = defineTool({
  name: "shipping.policy",
  describe: "Chính sách vận chuyển của shop (phí ship đơn lẻ, mốc miễn phí ship).",
  input: z.object({}),
  async handler() {
    const cfg = await landingConfig();
    return { carrier: "Viettel Post", shippingFeeSingle: cfg.shippingFee, freeShippingFromQuantity: 2, codSupported: true };
  },
});

export const shippingCalculateTool = defineTool({
  name: "shipping.calculate",
  describe: "Phí vận chuyển do máy chủ tính cho một số lượng và một địa chỉ. Dùng chung hàm với trang Đơn landing page.",
  input: z.object({ quantity: z.number().int().min(1).max(20), address: z.string().trim().optional(), province: z.string().trim().optional() }),
  async handler({ quantity, address, province }) {
    const cfg = await landingConfig();
    const fee = landingShippingFee(quantity, cfg.shippingFee);
    const issue = address ? addressIssue(address, province ?? "") : "EMPTY";
    return { quantity, shippingFee: fee, addressIssue: issue, addressUsable: issue === null };
  },
});

// ───────────────────────── customer.get / customer.update ─────────────────────────

export const customerGetTool = defineTool({
  name: "customer.get",
  describe: "Thông tin khách đã có trong ERP theo SĐT hoặc mã khách Pancake: tên, số đơn đã mua, địa chỉ lần gần nhất. Chỉ để GỢI Ý, không tự điền vào đơn.",
  input: z.object({ phone: z.string().trim().optional(), pancakeCustomerId: z.string().trim().optional() }).refine((v) => v.phone || v.pancakeCustomerId, { message: "Phải có SĐT hoặc mã khách" }),
  async handler({ phone, pancakeCustomerId }) {
    const db = await getDb();
    const normalized = phone ? normalizePhone(phone) : "";
    const customer = pancakeCustomerId
      ? await db.query.customers.findFirst({ where: or(eq(schema.customers.pancakeId, pancakeCustomerId), eq(schema.customers.id, pancakeCustomerId)) })
      : normalized
        ? await db.query.customers.findFirst({ where: or(eq(schema.customers.phone, normalized), sql`${normalized} = any(${schema.customers.phones})`) })
        : null;
    if (!customer) return { found: false, name: "", orderCount: 0, lastAddress: "", lastProvince: "", suggestion: "Khách mới — phải xin lại SĐT và địa chỉ" };
    const lastOrder = await db.query.orders.findFirst({
      where: eq(schema.orders.customerId, customer.id),
      orderBy: (o, { desc: d }) => [d(o.insertedAt)],
      columns: { billPhone: true, shipAddress: true, shipProvince: true, insertedAt: true },
    });
    return {
      found: true,
      customerId: customer.id,
      name: customer.name ?? "",
      orderCount: Number(customer.orderCount ?? 0),
      lastPhone: lastOrder?.billPhone ?? "",
      lastAddress: lastOrder?.shipAddress ?? "",
      lastProvince: lastOrder?.shipProvince ?? "",
      // Khách cũ mua lại: chỉ GỢI Ý địa chỉ cũ, không bao giờ tự điền vào đơn.
      suggestion: lastOrder?.shipAddress ? "Có địa chỉ lần trước — hỏi lại khách xem có giữ nguyên không, KHÔNG tự điền" : "Chưa có địa chỉ cũ, phải xin của khách",
    };
  },
});

export const customerUpdateTool = defineTool({
  name: "customer.update",
  describe: "Ghi lại tên / SĐT / địa chỉ khách VÀO HỘI THOẠI BÁN HÀNG của ERP. KHÔNG ghi đè dữ liệu khách đồng bộ từ Pancake.",
  input: z.object({ name: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional(), address: z.string().trim().max(400).optional(), province: z.string().trim().max(80).optional() }),
  async handler(args, ctx: ToolContext) {
    if (!ctx.conversationId) throw new Error("Công cụ này cần một hội thoại đang xử lý");
    const db = await getDb();
    const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, ctx.conversationId) });
    if (!conversation) throw new Error("Không tìm thấy hội thoại");
    const state = (conversation.state ?? {}) as Record<string, unknown>;
    const phone = args.phone ? normalizePhone(args.phone) : "";
    const next = {
      ...state,
      ...(args.name ? { customerName: args.name } : {}),
      ...(phone ? { phone } : {}),
      ...(args.address ? { address: args.address } : {}),
      ...(args.province ? { province: args.province } : {}),
    };
    await db
      .update(schema.salesConversations)
      .set({ state: next, ...(args.name ? { customerName: args.name } : {}), ...(phone ? { phone } : {}), updatedAt: new Date() })
      .where(eq(schema.salesConversations.id, ctx.conversationId));
    return { updated: true, pancakeWritten: false, note: "Chỉ ghi trong ERP; dữ liệu khách trên Pancake không bị đụng tới" };
  },
});

// ───────────────────────── conversation.tag / conversation.handoff ─────────────────────────

export const conversationTagTool = defineTool({
  name: "conversation.tag",
  describe: "Gắn nhãn nội bộ cho hội thoại trong ERP (không ghi ngược lên Pancake).",
  input: z.object({ tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8) }),
  async handler({ tags }, ctx: ToolContext) {
    if (!ctx.conversationId) throw new Error("Công cụ này cần một hội thoại đang xử lý");
    const db = await getDb();
    const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, ctx.conversationId), columns: { tags: true } });
    if (!conversation) throw new Error("Không tìm thấy hội thoại");
    const merged = [...new Set([...(conversation.tags ?? []), ...tags])].slice(0, 20);
    await db.update(schema.salesConversations).set({ tags: merged, updatedAt: new Date() }).where(eq(schema.salesConversations.id, ctx.conversationId));
    return { tags: merged };
  },
});

export const conversationHandoffTool = defineTool({
  name: "conversation.handoff",
  describe: "Chuyển hội thoại cho người. Sau lời gọi này mọi hành động tự động trên hội thoại dừng lại.",
  input: z.object({ reason: z.string().trim().min(1).max(200) }),
  async handler({ reason }, ctx: ToolContext) {
    if (!ctx.conversationId) throw new Error("Công cụ này cần một hội thoại đang xử lý");
    const db = await getDb();
    const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, ctx.conversationId), columns: { humanTakeoverAt: true } });
    if (!conversation) throw new Error("Không tìm thấy hội thoại");
    // Đã chuyển rồi thì giữ nguyên MỐC ĐẦU TIÊN: đè lại sẽ làm mất thời điểm người thực sự nhận việc.
    if (conversation.humanTakeoverAt) return { handedOff: true, alreadyHandedOff: true, at: conversation.humanTakeoverAt };
    const at = new Date();
    await db
      .update(schema.salesConversations)
      .set({ humanTakeoverAt: at, takeoverReason: reason, stage: "HUMAN_TAKEOVER", updatedAt: at })
      .where(eq(schema.salesConversations.id, ctx.conversationId));
    return { handedOff: true, alreadyHandedOff: false, at };
  },
});

// ───────────────────────── followup.schedule ─────────────────────────

export const followupScheduleTool = defineTool({
  name: "followup.schedule",
  describe: "Đưa hội thoại vào danh sách hẹn nhắn lại. CHỈ xếp hàng chờ — không có đường nào từ đây tự gửi tin cho khách.",
  input: z.object({ hours: z.number().min(1).max(24 * 30).optional(), reason: z.string().trim().min(1).max(200), suggestedMessage: z.string().trim().max(1000).optional() }),
  async handler({ hours, reason, suggestedMessage }, ctx: ToolContext) {
    if (!ctx.conversationId) throw new Error("Công cụ này cần một hội thoại đang xử lý");
    const db = await getDb();
    const dueAt = new Date(Date.now() + (hours ?? SALES_STALE_HOURS) * 3_600_000);
    const existing = await db.query.salesFollowups.findFirst({
      where: and(eq(schema.salesFollowups.conversationId, ctx.conversationId), eq(schema.salesFollowups.status, "PENDING")),
    });
    // Một hội thoại chỉ có MỘT hẹn đang chờ; nếu không mỗi tin nhắn lại đẻ thêm một dòng.
    if (existing) {
      await db.update(schema.salesFollowups).set({ dueAt, reason, suggestedMessage: suggestedMessage ?? existing.suggestedMessage, updatedAt: new Date() }).where(eq(schema.salesFollowups.id, existing.id));
      return { id: existing.id, dueAt, created: false };
    }
    const [row] = await db
      .insert(schema.salesFollowups)
      .values({ conversationId: ctx.conversationId, dueAt, reason, suggestedMessage: suggestedMessage ?? "" })
      .returning({ id: schema.salesFollowups.id });
    return { id: row.id, dueAt, created: true };
  },
});

// ───────────────────────── order.create_draft / order.confirm ─────────────────────────

/** Điều kiện máy chủ BẮT BUỘC đủ trước khi có thể lên đơn. Thiếu một điều là chặn, không phải cảnh báo. */
export const ORDER_REQUIREMENTS = ["VARIANT", "QUANTITY", "PHONE", "ADDRESS", "PRICE", "CONFIRMATION"] as const;
export type OrderRequirement = (typeof ORDER_REQUIREMENTS)[number];

export const ORDER_REQUIREMENT_LABEL: Record<OrderRequirement, string> = {
  VARIANT: "Mẫu mã hợp lệ (đúng size / màu)",
  QUANTITY: "Số lượng",
  PHONE: "Số điện thoại dùng được",
  ADDRESS: "Địa chỉ đủ để ĐVVC định tuyến",
  PRICE: "Giá do máy chủ tính",
  CONFIRMATION: "Khách xác nhận có ngữ cảnh",
};

export const orderCreateDraftTool = defineTool({
  name: "order.create_draft",
  describe: "Tạo ĐƠN NHÁP trên Pancake POS (trạng thái Mới) sau khi máy chủ đã kiểm đủ mẫu mã, số lượng, SĐT, địa chỉ, giá và xác nhận của khách.",
  input: z.object({
    variantId: z.string().trim().min(1),
    quantity: z.number().int().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(8).max(30),
    address: z.string().trim().min(1).max(400),
    province: z.string().trim().max(80).optional(),
    note: z.string().trim().max(500).optional(),
    /** Bằng chứng khách đã xác nhận đúng bản chốt — dây chuyền tính, không phải mô hình khẳng định. */
    confirmationEvidence: z.object({ reviewSentAt: z.string(), customerRepliedAt: z.string(), quote: z.string().max(500) }),
  }),
  async handler(args, ctx: ToolContext) {
    if (!ctx.conversationId) throw new Error("Công cụ này cần một hội thoại đang xử lý");
    const db = await getDb();
    const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, ctx.conversationId) });
    if (!conversation) throw new Error("Không tìm thấy hội thoại");
    // Đã có đơn cho hội thoại này thì KHÔNG tạo đơn thứ hai — một tin nhắn gửi lại không được
    // biến thành hai đơn cho khách.
    if (conversation.orderId) return { created: false, duplicate: true, orderId: conversation.orderId, note: "Hội thoại đã có đơn" };

    const missing: OrderRequirement[] = [];
    const phone = normalizePhone(args.phone);
    if (!phone) missing.push("PHONE");
    if (addressIssue(args.address, args.province ?? "")) missing.push("ADDRESS");
    const variant = await db
      .select({ id: pv.id, price: pv.retailPrice, discounted: pv.retailPriceAfterDiscount, hidden: pv.isHidden, removed: pv.isRemoved })
      .from(pv)
      .where(eq(pv.id, args.variantId))
      .limit(1);
    if (!variant[0] || variant[0].removed || variant[0].hidden) missing.push("VARIANT");
    if (missing.length) throw new Error(`Thiếu điều kiện bắt buộc: ${missing.map((m) => ORDER_REQUIREMENT_LABEL[m]).join(", ")}`);

    const cfg = await landingConfig();
    // GIÁ LÊN ĐƠN LÀ GIÁ MÁY CHỦ TÍNH, không nhận từ tham số — mô hình không được đặt giá.
    const unit = Number(variant[0].discounted) || Number(variant[0].price) || cfg.singlePrice;
    const client = getPancakeClient();
    const created = await client.createOrder({
      name: args.name,
      phone,
      address: args.address,
      province: args.province,
      note: args.note ?? cfg.posNote,
      items: [{ variationId: args.variantId, quantity: args.quantity, price: unit }],
      shippingFee: landingShippingFee(args.quantity, cfg.shippingFee),
      warehouseId: cfg.warehouseId || undefined,
      source: "AI Sales Agent",
    });
    await db
      .update(schema.salesConversations)
      .set({ orderId: created.id || null, stage: "ORDER_CREATED", updatedAt: new Date() })
      .where(eq(schema.salesConversations.id, ctx.conversationId));
    return { created: true, duplicate: false, orderId: created.id, systemId: created.systemId, unitPrice: unit, evidence: args.confirmationEvidence };
  },
});

export const orderConfirmTool = defineTool({
  name: "order.confirm",
  describe: "Ghi nhận khách đã chốt đơn. CHỈ ghi trong ERP — Pancake POS không có API sửa đơn nên nhân viên vẫn phải bấm chốt trên POS.",
  input: z.object({ orderId: z.string().trim().min(1), note: z.string().trim().max(300).optional() }),
  async handler({ orderId, note }, ctx: ToolContext) {
    if (!ctx.conversationId) throw new Error("Công cụ này cần một hội thoại đang xử lý");
    const db = await getDb();
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId), columns: { id: true, stage: true } });
    if (!order) throw new Error(`Không có đơn ${orderId} trong ERP`);
    const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, ctx.conversationId), columns: { state: true } });
    const state = (conversation?.state ?? {}) as Record<string, unknown>;
    await db
      .update(schema.salesConversations)
      .set({ state: { ...state, confirmedOrderId: orderId, confirmedAt: new Date().toISOString(), confirmNote: note ?? "" }, updatedAt: new Date() })
      .where(eq(schema.salesConversations.id, ctx.conversationId));
    return {
      confirmedInErp: true,
      posUpdated: false,
      orderStage: order.stage,
      note: "Pancake POS không có API cập nhật đơn — nhân viên phải chốt trên POS; ERP chỉ ghi lại rằng khách đã đồng ý",
    };
  },
});


/**
 * Các công cụ ở trên tự đăng ký vào cổng ngay khi mô-đun này được tải (mỗi `defineTool` là một
 * lời gọi ở cấp cao nhất). Hàm này tồn tại để nơi gọi có một lý do TƯỜNG MINH để import mô-đun —
 * dựa vào tác dụng phụ của import là cách chắc chắn để một ngày nào đó cổng chạy với danh sách rỗng.
 */
export function registerErpTools(): ToolName[] {
  return registeredTools();
}

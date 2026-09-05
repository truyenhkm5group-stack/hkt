// Shop Control ERP — Drizzle schema (PostgreSQL)
// Tiền tệ: VND, lưu dạng integer. Thời gian: timestamptz (UTC).
import { relations, sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, bigint } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const ts = (name: string) => timestamp(name, { withTimezone: true });
const money = (name: string) => integer(name).notNull().default(0);

// ───────────────────────── Enums ─────────────────────────

export const roleEnum = pgEnum("role", ["ADMIN", "MANAGER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"]);
export type Role = (typeof roleEnum.enumValues)[number];

export const orderStageEnum = pgEnum("order_stage", [
  "NEW",
  "WAITING",
  "CONFIRMED",
  "PACKING",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "PAID",
  "RETURNING",
  "PARTIAL_RETURN",
  "RETURNED",
  "CANCELLED",
  "DELETED",
]);
export type OrderStage = (typeof orderStageEnum.enumValues)[number];

export const shipmentStageEnum = pgEnum("shipment_stage", [
  "PENDING",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "DELIVERY_FAILED",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
]);
export type ShipmentStage = (typeof shipmentStageEnum.enumValues)[number];

export const codStatusEnum = pgEnum("cod_status", ["NOT_APPLICABLE", "PENDING", "COLLECTED", "RECONCILED", "PAID_TO_BANK", "DISPUTED"]);
export type CodStatus = (typeof codStatusEnum.enumValues)[number];

export const expenseCategoryEnum = pgEnum("expense_category", ["ADS", "SHIPPING", "RETURN_FEE", "SALARY", "RENT", "SOFTWARE", "PACKAGING", "PURCHASE", "OTHER"]);
export type ExpenseCategory = (typeof expenseCategoryEnum.enumValues)[number];

// ───────────────────────── Người dùng ─────────────────────────

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("VIEWER"),
  /** Quyền tuỳ chỉnh riêng (danh sách khoá quyền); null = dùng mẫu quyền của vai trò */
  permissions: jsonb("permissions").$type<string[] | null>(),
  active: boolean("active").notNull().default(true),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Case chăm sóc khách hàng: đổi size / đổi màu / sai địa chỉ / sai SĐT / trả hàng / khiếu nại… */
export const csCases = pgTable(
  "cs_cases",
  {
    id: id(),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** EXCHANGE_SIZE · EXCHANGE_COLOR · WRONG_ADDRESS · WRONG_PHONE · RETURN · COMPLAINT · OTHER */
    kind: text("kind").notNull().default("OTHER"),
    /** OPEN · IN_PROGRESS · DONE · CANCELLED */
    status: text("status").notNull().default("OPEN"),
    /** PANCAKE_TAG · PANCAKE_NOTE · PANCAKE_RETURN · PANCAKE_CHAT · MANUAL */
    source: text("source").notNull().default("MANUAL"),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    customerPhone: text("customer_phone").notNull().default(""),
    assignee: text("assignee").notNull().default(""),
    resolution: text("resolution").notNull().default(""),
    /** Khoá chống tạo trùng khi tự phát hiện */
    dedupeKey: text("dedupe_key").unique(),
    /** Link hội thoại Pancake (case từ chat) */
    chatUrl: text("chat_url").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("cs_cases_status_idx").on(t.status, t.createdAt), index("cs_cases_order_idx").on(t.orderId)],
);

/** Danh sách khách cần nhắn: chăm sóc khách băn khoăn chưa mua (NURTURE) / bán chéo cho khách đã nhận hàng (CROSS_SELL) */
export const outreachTargets = pgTable(
  "outreach_targets",
  {
    id: id(),
    segment: text("segment").notNull(),
    pageId: text("page_id").notNull().default(""),
    conversationId: text("conversation_id").notNull().default(""),
    pancakeCustomerId: text("pancake_customer_id").notNull().default(""),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull().default(""),
    phone: text("phone").notNull().default(""),
    /** Sản phẩm đã mua (bán chéo) hoặc tin nhắn cuối của khách (băn khoăn) */
    context: text("context").notNull().default(""),
    /** Gợi ý sản phẩm bán chéo (tên, cách nhau bằng dấu phẩy) */
    suggestions: text("suggestions").notNull().default(""),
    /** Nội dung đã dựng sẵn từ mẫu */
    message: text("message").notNull().default(""),
    /** Ảnh / video gửi kèm sau tin chữ (URL công khai) */
    mediaUrls: jsonb("media_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Ưu đãi áp dụng cho khách này: STANDARD (khách cũ giảm 50K) · CLEARANCE (mã hoàn cao / tồn nhiều, giảm 100K) · '' */
    offer: text("offer").notNull().default(""),
    /** PENDING · SENT · FAILED · SKIPPED */
    /** PENDING · SENT (đã gửi hết kịch bản) · FAILED · SKIPPED · CONVERTED (khách đã đặt đơn) · REPLIED (khách trả lời, nhân viên tiếp quản) */
    status: text("status").notNull().default("PENDING"),
    error: text("error").notNull().default(""),
    /** Bước kịch bản tiếp theo sẽ gửi (0-based); băn khoăn nhiều bước, bán chéo một bước */
    step: integer("step").notNull().default(0),
    /** Số tin đã gửi cho khách này */
    sentCount: integer("sent_count").notNull().default(0),
    /** Thời điểm sớm nhất được gửi bước tiếp theo (null = gửi được ngay) */
    nextAt: ts("next_at"),
    lastActivityAt: ts("last_activity_at"),
    sentAt: ts("sent_at"),
    sentBy: text("sent_by").notNull().default(""),
    dedupeKey: text("dedupe_key").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outreach_segment_status_idx").on(t.segment, t.status, t.createdAt)],
);

/** Dư nợ & ngưỡng thanh toán của từng tài khoản quảng cáo Facebook (cập nhật từ Marketing API, cảnh báo Lark khi sắp tới ngưỡng) */
export const adAccountBilling = pgTable("ad_account_billing", {
  accountId: text("account_id").primaryKey(),
  name: text("name").notNull().default(""),
  currency: text("currency").notNull().default("VND"),
  relation: text("relation").notNull().default("owned"),
  /** 1 hoạt động · 2 vô hiệu hoá · 3 chưa thanh toán · 7 chờ xét duyệt · 9 ân hạn · 100 chờ đóng · 101 đã đóng */
  accountStatus: integer("account_status").notNull().default(0),
  disableReason: integer("disable_reason").notNull().default(0),
  /** Dư nợ hiện tại (đơn vị tiền tệ tài khoản, đã quy đổi khỏi minor unit) */
  balance: bigint("balance", { mode: "number" }).notNull().default(0),
  amountSpent: bigint("amount_spent", { mode: "number" }).notNull().default(0),
  spendCap: bigint("spend_cap", { mode: "number" }).notNull().default(0),
  fundingSource: text("funding_source").notNull().default(""),
  isPrepay: boolean("is_prepay").notNull().default(false),
  nextBillDate: text("next_bill_date").notNull().default(""),
  /** Ngưỡng thanh toán do người dùng nhập (từ Trung tâm thanh toán Meta) */
  threshold: bigint("threshold", { mode: "number" }),
  /** Ngưỡng tự học: dư nợ ngay trước lần Meta thu tiền gần nhất */
  learnedThreshold: bigint("learned_threshold", { mode: "number" }),
  prevBalance: bigint("prev_balance", { mode: "number" }).notNull().default(0),
  lastPaidAt: ts("last_paid_at"),
  fetchedAt: ts("fetched_at"),
  updatedAt: updatedAt(),
});

/** Bảng chốt số lượng đặt hàng sản xuất theo mã (ma trận màu × size) gửi xưởng may */
export const productionOrders = pgTable(
  "production_orders",
  {
    id: id(),
    code: text("code").notNull().unique(),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    productCode: text("product_code").notNull().default(""),
    productName: text("product_name").notNull().default(""),
    /** DRAFT · SENT (đã gửi xưởng) · RECEIVED (đã nhận hàng) · CANCELLED */
    status: text("status").notNull().default("DRAFT"),
    colors: jsonb("colors").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    sizes: jsonb("sizes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Số lượng theo ô "màu|size" */
    cells: jsonb("cells").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    /** Ảnh mẫu theo màu: { color, url } */
    images: jsonb("images").$type<{ color: string; url: string }[]>().notNull().default(sql`'[]'::jsonb`),
    totalQty: integer("total_qty").notNull().default(0),
    unitCost: integer("unit_cost").notNull().default(0),
    supplier: text("supplier").notNull().default(""),
    note: text("note").notNull().default(""),
    dueDate: ts("due_date"),
    sentAt: ts("sent_at"),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("production_orders_product_idx").on(t.productId, t.createdAt)],
);

/** Thông báo / cảnh báo vận hành (đơn chờ xử lý, giao thất bại chờ phát lại, đơn treo…) */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    /** Loại: SHIPMENT_FAILED · ORDER_PENDING · SHIPMENT_STALE · SHIPMENT_RETURNING · SYSTEM */
    kind: text("kind").notNull(),
    /** info · warning · critical */
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    href: text("href").notNull().default(""),
    entityType: text("entity_type").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    /** Khoá chống tạo trùng (vd ship-failed:<id>:<mốc>) */
    dedupeKey: text("dedupe_key").notNull().unique(),
    /** Danh sách userId đã đọc */
    readBy: jsonb("read_by").$type<string[]>().notNull().default([]),
    /** Tự đóng khi điều kiện không còn (đơn đã giao / đã xử lý) */
    resolvedAt: ts("resolved_at"),
    /** Đã gửi Telegram lúc */
    notifiedAt: ts("notified_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_open_idx").on(t.resolvedAt, t.createdAt), index("notifications_kind_idx").on(t.kind)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    userEmail: text("user_email").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull().default(""),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_created_idx").on(t.entity, t.createdAt), index("audit_created_idx").on(t.createdAt)],
);

// ───────────────────────── Danh mục Pancake ─────────────────────────

export const warehouses = pgTable("warehouses", {
  id: text("id").primaryKey(), // Pancake warehouse uuid
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  fullAddress: text("full_address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  provinceId: text("province_id"),
  districtId: text("district_id"),
  communeId: text("commune_id"),
  customId: text("custom_id"),
  allowCreateOrder: boolean("allow_create_order").notNull().default(true),
  raw: jsonb("raw"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable(
  "customers",
  {
    id: id(),
    pancakeId: text("pancake_id").unique(),
    name: text("name").notNull(),
    phone: text("phone"),
    phones: text("phones").array().notNull().default(sql`'{}'::text[]`),
    emails: text("emails").array().notNull().default(sql`'{}'::text[]`),
    gender: text("gender"),
    dateOfBirth: ts("date_of_birth"),
    level: text("level"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    orderCount: integer("order_count").notNull().default(0),
    succeedOrderCount: integer("succeed_order_count").notNull().default(0),
    returnedOrderCount: integer("returned_order_count").notNull().default(0),
    purchasedAmount: money("purchased_amount"),
    rewardPoint: integer("reward_point").notNull().default(0),
    address: text("address").notNull().default(""),
    province: text("province").notNull().default(""),
    addresses: jsonb("addresses"),
    fbId: text("fb_id"),
    conversationLink: text("conversation_link"),
    isBlock: boolean("is_block").notNull().default(false),
    lastOrderAt: ts("last_order_at"),
    insertedAt: ts("inserted_at"),
    updatedAtExternal: ts("updated_at_external"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customers_phone_idx").on(t.phone), index("customers_name_idx").on(t.name), index("customers_updated_ext_idx").on(t.updatedAtExternal)],
);

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(), // Pancake product uuid
    name: text("name").notNull(),
    customId: text("custom_id"),
    displayId: integer("display_id"),
    image: text("image"),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    isPublished: boolean("is_published"),
    isHidden: boolean("is_hidden").notNull().default(false),
    isRemoved: boolean("is_removed").notNull().default(false),
    note: text("note").notNull().default(""),
    insertedAt: ts("inserted_at"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("products_name_idx").on(t.name)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: text("id").primaryKey(), // Pancake variation uuid
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: text("sku").notNull().default(""),
    barcode: text("barcode"),
    customId: text("custom_id"),
    attributes: jsonb("attributes"),
    detail: text("detail").notNull().default(""),
    color: text("color").notNull().default(""),
    size: text("size").notNull().default(""),
    images: text("images").array().notNull().default(sql`'{}'::text[]`),
    weight: integer("weight").notNull().default(0),
    retailPrice: money("retail_price"),
    retailPriceAfterDiscount: money("retail_price_after_discount"),
    lastImportedPrice: money("last_imported_price"),
    avgImportedPrice: doublePrecision("avg_imported_price").notNull().default(0),
    remainQuantity: integer("remain_quantity").notNull().default(0),
    actualRemainQuantity: integer("actual_remain_quantity").notNull().default(0),
    isHidden: boolean("is_hidden").notNull().default(false),
    isLocked: boolean("is_locked").notNull().default(false),
    isRemoved: boolean("is_removed").notNull().default(false),
    insertedAt: ts("inserted_at"),
    updatedAtExternal: ts("updated_at_external"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("variants_sku_idx").on(t.sku), index("variants_product_idx").on(t.productId), index("variants_remain_idx").on(t.remainQuantity)],
);

export const variantStocks = pgTable(
  "variant_stocks",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    remainQuantity: integer("remain_quantity").notNull().default(0),
    actualRemainQuantity: integer("actual_remain_quantity").notNull().default(0),
    totalQuantity: integer("total_quantity").notNull().default(0),
    pendingQuantity: integer("pending_quantity").notNull().default(0),
    returningQuantity: integer("returning_quantity").notNull().default(0),
    waitingQuantity: integer("waiting_quantity").notNull().default(0),
    sellingAvg: doublePrecision("selling_avg"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("variant_stocks_variant_warehouse_uq").on(t.variantId, t.warehouseId), index("variant_stocks_warehouse_idx").on(t.warehouseId)],
);

export const inventoryHistories = pgTable(
  "inventory_histories",
  {
    id: text("id").primaryKey(), // Pancake id (int64 → text)
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    warehouseId: text("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull().default(0),
    remainQuantity: integer("remain_quantity").notNull().default(0),
    avgPrice: doublePrecision("avg_price"),
    type: text("type").notNull().default(""),
    tableName: text("table_name"),
    refDisplayId: text("ref_display_id"),
    editorName: text("editor_name"),
    insertedAt: ts("inserted_at").notNull(),
    raw: jsonb("raw"),
    createdAt: createdAt(),
  },
  (t) => [index("inv_hist_variant_idx").on(t.variantId, t.insertedAt), index("inv_hist_inserted_idx").on(t.insertedAt)],
);

// ───────────────────────── Đơn hàng ─────────────────────────

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(), // Pancake order id (text vì có thể > 2^53)
    systemId: integer("system_id"),
    displayId: integer("display_id"),
    customId: text("custom_id"),
    shopId: text("shop_id"),
    status: integer("status").notNull().default(0),
    statusName: text("status_name").notNull().default(""),
    stage: orderStageEnum("stage").notNull().default("NEW"),
    subStatus: integer("sub_status"),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    billFullName: text("bill_full_name").notNull().default(""),
    billPhone: text("bill_phone").notNull().default(""),
    billEmail: text("bill_email").notNull().default(""),
    shipFullName: text("ship_full_name").notNull().default(""),
    shipPhone: text("ship_phone").notNull().default(""),
    shipAddress: text("ship_address").notNull().default(""),
    shipFullAddress: text("ship_full_address").notNull().default(""),
    shipProvince: text("ship_province").notNull().default(""),
    shipDistrict: text("ship_district").notNull().default(""),
    shipCommune: text("ship_commune").notNull().default(""),
    totalPrice: money("total_price"),
    totalPriceAfterDiscount: money("total_price_after_discount"),
    totalDiscount: money("total_discount"),
    shippingFee: money("shipping_fee"),
    partnerFee: money("partner_fee"),
    customerPayFee: boolean("customer_pay_fee").notNull().default(false),
    isFreeShipping: boolean("is_free_shipping").notNull().default(false),
    cod: money("cod"),
    moneyToCollect: money("money_to_collect"),
    prepaid: money("prepaid"),
    transferMoney: money("transfer_money"),
    cash: money("cash"),
    surcharge: money("surcharge"),
    tax: money("tax"),
    feeMarketplace: money("fee_marketplace"),
    returnFee: money("return_fee"),
    exchangeValue: money("exchange_value"),
    isExchangeOrder: boolean("is_exchange_order").notNull().default(false),
    isLivestream: boolean("is_livestream").notNull().default(false),
    source: text("source").notNull().default("Khác"),
    accountName: text("account_name").notNull().default(""),
    pageId: text("page_id"),
    postId: text("post_id"),
    /** Hội thoại Pancake (để mở chat: https://pancake.vn/<page_id>?c_id=<conversation_id>) */
    conversationId: text("conversation_id"),
    adId: text("ad_id"),
    marketplaceId: text("marketplace_id"),
    sellerName: text("seller_name").notNull().default(""),
    careName: text("care_name").notNull().default(""),
    marketerName: text("marketer_name").notNull().default(""),
    creatorName: text("creator_name").notNull().default(""),
    warehouseId: text("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    notePrint: text("note_print").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    itemsCount: integer("items_count").notNull().default(0),
    totalQuantity: integer("total_quantity").notNull().default(0),
    cogs: money("cogs"),
    returnedReason: text("returned_reason"),
    insertedAt: ts("inserted_at").notNull(),
    updatedAtExternal: ts("updated_at_external"),
    lastUpdateStatusAt: ts("last_update_status_at"),
    timeSendPartner: ts("time_send_partner"),
    estimateDeliveryDate: ts("estimate_delivery_date"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_status_idx").on(t.status),
    index("orders_stage_inserted_idx").on(t.stage, t.insertedAt),
    index("orders_inserted_idx").on(t.insertedAt),
    index("orders_updated_ext_idx").on(t.updatedAtExternal),
    index("orders_customer_idx").on(t.customerId),
    index("orders_source_idx").on(t.source),
    index("orders_system_idx").on(t.systemId),
    index("orders_bill_phone_idx").on(t.billPhone),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    productId: text("product_id"),
    productName: text("product_name").notNull().default(""),
    variationDetail: text("variation_detail").notNull().default(""),
    sku: text("sku").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: money("unit_price"),
    unitCost: money("unit_cost"),
    discountEach: money("discount_each"),
    totalDiscount: money("total_discount"),
    isBonus: boolean("is_bonus").notNull().default(false),
    returnQuantity: integer("return_quantity").notNull().default(0),
    lineTotal: money("line_total"),
    weight: integer("weight").notNull().default(0),
    image: text("image"),
  },
  (t) => [index("order_items_order_idx").on(t.orderId), index("order_items_variant_idx").on(t.variantId), index("order_items_product_idx").on(t.productId)],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: integer("status").notNull(),
    oldStatus: integer("old_status"),
    editorName: text("editor_name").notNull().default(""),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("order_status_history_uq").on(t.orderId, t.status, t.updatedAt), index("order_status_history_order_idx").on(t.orderId)],
);

export const orderReturns = pgTable(
  "order_returns",
  {
    id: text("id").primaryKey(),
    displayId: integer("display_id"),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    orderToReturnedId: text("order_to_returned_id"),
    status: integer("status").notNull().default(0),
    statusName: text("status_name").notNull().default(""),
    returnedFee: money("returned_fee"),
    discount: money("discount"),
    isExchange: boolean("is_exchange").notNull().default(false),
    billFullName: text("bill_full_name").notNull().default(""),
    billPhone: text("bill_phone").notNull().default(""),
    items: jsonb("items"),
    insertedAt: ts("inserted_at").notNull(),
    updatedAtExternal: ts("updated_at_external"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("order_returns_inserted_idx").on(t.insertedAt)],
);

// ───────────────────────── Vận chuyển & COD ─────────────────────────

export const codBatches = pgTable(
  "cod_batches",
  {
    id: id(),
    reference: text("reference").notNull(),
    carrier: text("carrier").notNull().default("Viettel Post"),
    receivedAt: ts("received_at").notNull(),
    /** Tiền thực nhận về tài khoản (tiền thu về sau khi trừ cước) */
    totalAmount: money("total_amount"),
    /** Tiền COD gộp trên bảng kê ĐVVC (trước khi trừ cước / dư nợ) */
    codGross: money("cod_gross"),
    /** Cước / dư nợ COD ĐVVC đã trừ trên bảng kê */
    feeTotal: money("fee_total"),
    /** MANUAL (đánh dấu tay) · VTP_STATEMENT (bảng kê Viettel Post) */
    source: text("source").notNull().default("MANUAL"),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("cod_batches_received_idx").on(t.receivedAt), uniqueIndex("cod_batches_reference_uq").on(t.reference)],
);

export const shipments = pgTable(
  "shipments",
  {
    id: id(),
    orderId: text("order_id")
      .unique()
      .references(() => orders.id, { onDelete: "cascade" }),
    carrier: text("carrier").notNull().default(""),
    partnerId: integer("partner_id"),
    trackingCode: text("tracking_code"),
    vtpOrderNumber: text("vtp_order_number").unique(),
    orderReference: text("order_reference"),
    partnerStatus: text("partner_status"),
    stage: shipmentStageEnum("stage").notNull().default("PENDING"),
    vtpStatus: integer("vtp_status"),
    vtpStatusName: text("vtp_status_name"),
    vtpStatusDate: ts("vtp_status_date"),
    vtpLocation: text("vtp_location"),
    vtpNote: text("vtp_note"),
    vtpReasonCode: integer("vtp_reason_code"),
    service: text("service"),
    weight: integer("weight"),
    expectedDelivery: text("expected_delivery"),
    codAmount: money("cod_amount"),
    codCollected: money("cod_collected"),
    codFee: money("cod_fee"),
    shippingFee: money("shipping_fee"),
    codStatus: codStatusEnum("cod_status").notNull().default("PENDING"),
    codReconciledAt: ts("cod_reconciled_at"),
    codPaidToBankAt: ts("cod_paid_to_bank_at"),
    codBatchId: text("cod_batch_id").references(() => codBatches.id, { onDelete: "set null" }),
    receiverName: text("receiver_name").notNull().default(""),
    receiverPhone: text("receiver_phone").notNull().default(""),
    receiverAddress: text("receiver_address").notNull().default(""),
    pickedUpAt: ts("picked_up_at"),
    firstDeliveryAt: ts("first_delivery_at"),
    deliveredAt: ts("delivered_at"),
    returnedAt: ts("returned_at"),
    cancelledAt: ts("cancelled_at"),
    isFinal: boolean("is_final").notNull().default(false),
    lastVtpSyncAt: ts("last_vtp_sync_at"),
    lastPancakeSyncAt: ts("last_pancake_sync_at"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shipments_order_idx").on(t.orderId),
    index("shipments_vtp_number_idx").on(t.vtpOrderNumber),
    index("shipments_stage_idx").on(t.stage),
    index("shipments_cod_status_idx").on(t.codStatus),
    index("shipments_carrier_idx").on(t.carrier),
    index("shipments_tracking_idx").on(t.trackingCode),
    index("shipments_final_sync_idx").on(t.isFinal, t.lastVtpSyncAt),
  ],
);

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // PANCAKE | VTP_WEBHOOK | VTP_POLL | VTP_IMPORT | MANUAL
    status: text("status").notNull(),
    statusName: text("status_name").notNull().default(""),
    location: text("location").notNull().default(""),
    note: text("note").notNull().default(""),
    occurredAt: ts("occurred_at").notNull(),
    raw: jsonb("raw"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shipment_events_uq").on(t.shipmentId, t.source, t.status, t.occurredAt), index("shipment_events_shipment_idx").on(t.shipmentId, t.occurredAt)],
);

// ───────────────────────── Nhập hàng & kiểm kê (ERP tự quản lý tồn) ─────────────────────────

export const stockReceipts = pgTable(
  "stock_receipts",
  {
    id: id(),
    kind: text("kind").notNull().default("RECEIPT"), // RECEIPT (nhập hàng) | ADJUSTMENT (điều chỉnh sau kiểm kê)
    receivedAt: ts("received_at").notNull(),
    reference: text("reference").notNull().default(""),
    supplier: text("supplier").notNull().default(""),
    note: text("note").notNull().default(""),
    totalQuantity: integer("total_quantity").notNull().default(0),
    totalCost: money("total_cost"),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("stock_receipts_received_idx").on(t.receivedAt)],
);

export const stockReceiptItems = pgTable(
  "stock_receipt_items",
  {
    id: id(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => stockReceipts.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(), // âm khi điều chỉnh giảm
    unitCost: money("unit_cost"),
  },
  (t) => [index("stock_receipt_items_receipt_idx").on(t.receiptId), index("stock_receipt_items_variant_idx").on(t.variantId)],
);

// ───────────────────────── Chi phí & marketing ─────────────────────────

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    category: expenseCategoryEnum("category").notNull().default("OTHER"),
    description: text("description").notNull(),
    amount: integer("amount").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    reference: text("reference").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("expenses_cat_occurred_idx").on(t.category, t.occurredAt), index("expenses_occurred_idx").on(t.occurredAt)],
);

export const adSpends = pgTable(
  "ad_spends",
  {
    id: id(),
    platform: text("platform").notNull(),
    campaign: text("campaign").notNull().default(""),
    spend: integer("spend").notNull(),
    leads: integer("leads").notNull().default(0),
    orders: integer("orders").notNull().default(0),
    revenue: money("revenue"),
    spendDate: ts("spend_date").notNull(),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    /** Khoá đồng bộ tự động (vd fb:<account>:<campaign>:<ngày>); null với dòng nhập tay */
    externalKey: text("external_key"),
    accountId: text("account_id"),
    accountName: text("account_name"),
    campaignId: text("campaign_id"),
    /** Sản phẩm (mã hàng) được ghép từ tên chiến dịch, dùng cho báo cáo lợi nhuận theo mã */
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    messages: integer("messages").notNull().default(0),
    currency: text("currency"),
    /** Không tính vào chi phí (chiến dịch của shop khác trong cùng Business Manager) */
    excluded: boolean("excluded").notNull().default(false),
    /** Marketer phụ trách chiến dịch (id nhân sự trong cấu hình lương) */
    marketerId: text("marketer_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ad_spends_platform_date_idx").on(t.platform, t.spendDate), index("ad_spends_date_idx").on(t.spendDate), uniqueIndex("ad_spends_external_key_uq").on(t.externalKey), index("ad_spends_product_idx").on(t.productId), index("ad_spends_marketer_idx").on(t.marketerId)],
);

// ───────────────────────── Đồng bộ & tích hợp ─────────────────────────

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    source: text("source").notNull(),
    job: text("job").notNull(),
    status: text("status").notNull().default("RUNNING"),
    trigger: text("trigger").notNull().default("MANUAL"),
    actor: text("actor").notNull().default("system"),
    imported: integer("imported").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    detail: text("detail").notNull().default(""),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("sync_runs_source_started_idx").on(t.source, t.startedAt), index("sync_runs_started_idx").on(t.startedAt)],
);

export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    source: text("source").notNull(),
    eventType: text("event_type").notNull().default(""),
    externalId: text("external_id"),
    payload: jsonb("payload").notNull(),
    headers: jsonb("headers"),
    status: text("status").notNull().default("RECEIVED"),
    error: text("error"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [index("webhook_events_source_received_idx").on(t.source, t.receivedAt), index("webhook_events_status_idx").on(t.status)],
);

export const integrationTokens = pgTable("integration_tokens", {
  provider: text("provider").primaryKey(),
  token: text("token").notNull(),
  expiresAt: ts("expires_at"),
  meta: jsonb("meta"),
  updatedAt: updatedAt(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});

// ───────────────────────── Relations ─────────────────────────

export const usersRelations = relations(users, ({ many }) => ({ auditLogs: many(auditLogs) }));
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({ user: one(users, { fields: [auditLogs.userId], references: [users.id] }) }));

export const customersRelations = relations(customers, ({ many }) => ({ orders: many(orders) }));
export const warehousesRelations = relations(warehouses, ({ many }) => ({ stocks: many(variantStocks), orders: many(orders) }));

export const productsRelations = relations(products, ({ many }) => ({ variants: many(productVariants) }));
export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  stocks: many(variantStocks),
  orderItems: many(orderItems),
  inventoryHistories: many(inventoryHistories),
  receiptItems: many(stockReceiptItems),
}));
export const stockReceiptsRelations = relations(stockReceipts, ({ many }) => ({ items: many(stockReceiptItems) }));
export const stockReceiptItemsRelations = relations(stockReceiptItems, ({ one }) => ({
  receipt: one(stockReceipts, { fields: [stockReceiptItems.receiptId], references: [stockReceipts.id] }),
  variant: one(productVariants, { fields: [stockReceiptItems.variantId], references: [productVariants.id] }),
}));
export const variantStocksRelations = relations(variantStocks, ({ one }) => ({
  variant: one(productVariants, { fields: [variantStocks.variantId], references: [productVariants.id] }),
  warehouse: one(warehouses, { fields: [variantStocks.warehouseId], references: [warehouses.id] }),
}));
export const inventoryHistoriesRelations = relations(inventoryHistories, ({ one }) => ({
  variant: one(productVariants, { fields: [inventoryHistories.variantId], references: [productVariants.id] }),
  warehouse: one(warehouses, { fields: [inventoryHistories.warehouseId], references: [warehouses.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  warehouse: one(warehouses, { fields: [orders.warehouseId], references: [warehouses.id] }),
  items: many(orderItems),
  statusHistory: many(orderStatusHistory),
  shipment: one(shipments, { fields: [orders.id], references: [shipments.orderId] }),
  returns: many(orderReturns),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(productVariants, { fields: [orderItems.variantId], references: [productVariants.id] }),
}));
export const orderStatusHistoryRelations = relations(orderStatusHistory, ({ one }) => ({ order: one(orders, { fields: [orderStatusHistory.orderId], references: [orders.id] }) }));
export const orderReturnsRelations = relations(orderReturns, ({ one }) => ({ order: one(orders, { fields: [orderReturns.orderId], references: [orders.id] }) }));

export const csCasesRelations = relations(csCases, ({ one }) => ({
  order: one(orders, { fields: [csCases.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [csCases.customerId], references: [customers.id] }),
}));

export const outreachTargetsRelations = relations(outreachTargets, ({ one }) => ({
  order: one(orders, { fields: [outreachTargets.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [outreachTargets.customerId], references: [customers.id] }),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  codBatch: one(codBatches, { fields: [shipments.codBatchId], references: [codBatches.id] }),
  events: many(shipmentEvents),
}));
export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({ shipment: one(shipments, { fields: [shipmentEvents.shipmentId], references: [shipments.id] }) }));
export const codBatchesRelations = relations(codBatches, ({ many }) => ({ shipments: many(shipments) }));

// ───────────────────────── Types ─────────────────────────

export type User = typeof users.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type VariantStock = typeof variantStocks.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type AdSpend = typeof adSpends.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type CodBatch = typeof codBatches.$inferSelect;
export type OrderReturn = typeof orderReturns.$inferSelect;
export type InventoryHistory = typeof inventoryHistories.$inferSelect;

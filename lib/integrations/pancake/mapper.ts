import type { CodStatus, OrderStage, ShipmentStage } from "@/db/schema";

type Json = unknown;
import { PANCAKE_ORDER_SOURCES, PANCAKE_PARTNER_STATUS, pancakeStatusName, pancakeStatusToStage } from "@/lib/constants/pancake";
import { asArray, asRecord, bool, int, normalizePhone, num, pancakeDate, str } from "@/lib/integrations/http";

export type MappedCustomer = {
  pancakeId: string;
  name: string;
  phone: string | null;
  phones: string[];
  emails: string[];
  gender: string | null;
  dateOfBirth: Date | null;
  level: string | null;
  tags: string[];
  orderCount: number;
  succeedOrderCount: number;
  returnedOrderCount: number;
  purchasedAmount: number;
  rewardPoint: number;
  address: string;
  province: string;
  addresses: Json | null;
  fbId: string | null;
  conversationLink: string | null;
  isBlock: boolean;
  lastOrderAt: Date | null;
  insertedAt: Date | null;
  updatedAtExternal: Date | null;
  raw: Json;
};

export type MappedOrderItem = {
  id: string;
  variantId: string | null;
  productId: string | null;
  productName: string;
  variationDetail: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  discountEach: number;
  totalDiscount: number;
  isBonus: boolean;
  returnQuantity: number;
  lineTotal: number;
  weight: number;
  image: string | null;
  /** thông tin mẫu mã để tự tạo variant nếu chưa đồng bộ sản phẩm */
  variation: {
    id: string;
    productId: string;
    name: string;
    sku: string;
    barcode: string;
    detail: string;
    fields: { name: string; value: string }[];
    images: string[];
    retailPrice: number;
    lastImportedPrice: number;
    avgPrice: number;
    weight: number;
  } | null;
};

export type MappedShipment = {
  carrier: string;
  partnerId: number | null;
  trackingCode: string | null;
  vtpOrderNumber: string | null;
  partnerStatus: string | null;
  stage: ShipmentStage;
  codAmount: number;
  codCollected: number;
  codStatus: CodStatus;
  codReconciledAt: Date | null;
  shippingFee: number;
  pickedUpAt: Date | null;
  firstDeliveryAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  cancelledAt: Date | null;
  isFinal: boolean;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  partnerUpdatedAt: Date | null;
  events: { status: string; statusName: string; note: string; occurredAt: Date; raw: Json }[];
  raw: Json;
};

export type MappedOrder = {
  id: string;
  systemId: number | null;
  displayId: number | null;
  customId: string | null;
  shopId: string | null;
  status: number;
  statusName: string;
  stage: OrderStage;
  subStatus: number | null;
  billFullName: string;
  billPhone: string;
  billEmail: string;
  shipFullName: string;
  shipPhone: string;
  shipAddress: string;
  shipFullAddress: string;
  shipProvince: string;
  shipDistrict: string;
  shipCommune: string;
  totalPrice: number;
  totalPriceAfterDiscount: number;
  totalDiscount: number;
  shippingFee: number;
  partnerFee: number;
  customerPayFee: boolean;
  isFreeShipping: boolean;
  cod: number;
  moneyToCollect: number;
  prepaid: number;
  transferMoney: number;
  cash: number;
  surcharge: number;
  tax: number;
  feeMarketplace: number;
  returnFee: number;
  exchangeValue: number;
  isExchangeOrder: boolean;
  isLivestream: boolean;
  source: string;
  accountName: string;
  pageId: string | null;
  postId: string | null;
  adId: string | null;
  marketplaceId: string | null;
  sellerName: string;
  careName: string;
  marketerName: string;
  creatorName: string;
  warehouseId: string | null;
  warehouse: { id: string; name: string; fullAddress: string; phone: string } | null;
  note: string;
  notePrint: string;
  tags: string[];
  itemsCount: number;
  totalQuantity: number;
  cogs: number;
  returnedReason: string | null;
  insertedAt: Date;
  updatedAtExternal: Date | null;
  lastUpdateStatusAt: Date | null;
  timeSendPartner: Date | null;
  estimateDeliveryDate: Date | null;
  raw: Json;
  items: MappedOrderItem[];
  customer: MappedCustomer | null;
  shipment: MappedShipment | null;
  statusHistory: { status: number; oldStatus: number | null; editorName: string; updatedAt: Date }[];
};

export function mapCustomer(value: unknown): MappedCustomer | null {
  const c = asRecord(value);
  const pancakeId = str(c.id, c.customer_id);
  if (!pancakeId) return null;
  const phones = asArray(c.phone_numbers)
    .map((p) => normalizePhone(str(p, asRecord(p).phone_number)))
    .filter(Boolean);
  const addresses = asArray(c.shop_customer_addresses).map(asRecord);
  const primaryAddress = addresses[0] ?? {};
  return {
    pancakeId,
    name: str(c.name, primaryAddress.full_name, "Khách hàng"),
    phone: phones[0] ?? null,
    phones,
    emails: asArray(c.emails).map((e) => str(e)).filter(Boolean),
    gender: str(c.gender) || null,
    dateOfBirth: pancakeDate(c.date_of_birth),
    level: str(asRecord(c.level).name, c.level) || null,
    tags: asArray(c.tags).map((t) => str(asRecord(t).name, t)).filter(Boolean),
    orderCount: int(c.order_count),
    succeedOrderCount: int(c.succeed_order_count),
    returnedOrderCount: int(c.returned_order_count),
    purchasedAmount: int(c.purchased_amount),
    rewardPoint: int(c.reward_point),
    address: str(primaryAddress.full_address, primaryAddress.address),
    province: str(primaryAddress.province_name),
    addresses: addresses.length ? (addresses as Json) : null,
    fbId: str(c.fb_id) || null,
    conversationLink: str(c.conversation_link) || null,
    isBlock: bool(c.is_block),
    lastOrderAt: pancakeDate(c.last_order_at),
    insertedAt: pancakeDate(c.inserted_at),
    updatedAtExternal: pancakeDate(c.updated_at),
    raw: c as Json,
  };
}

function extractAttributes(fields: unknown, detail: string) {
  const attrs = asArray(fields)
    .map((f) => {
      const r = asRecord(f);
      return { name: str(r.name, r.field_name), value: str(r.value, r.field_value) };
    })
    .filter((f) => f.name || f.value);
  if (!attrs.length && detail) {
    for (const part of detail.split(/[,;|]/)) {
      const [name, ...rest] = part.split(":");
      if (rest.length) attrs.push({ name: name.trim(), value: rest.join(":").trim() });
    }
  }
  let color = "";
  let size = "";
  for (const attr of attrs) {
    const key = attr.name.toLowerCase();
    if (!color && /(màu|mau|color|colour)/.test(key)) color = attr.value;
    else if (!size && /(size|cỡ|co|kích)/.test(key)) size = attr.value;
  }
  if (!color && !size && attrs.length) {
    // đoán theo giá trị
    for (const attr of attrs) {
      if (!size && /^(xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|free ?size|\d{2,3})$/i.test(attr.value)) size = attr.value;
      else if (!color) color = attr.value;
    }
  }
  return { attrs, color, size };
}

export function mapOrderItem(value: unknown, orderId: string, index: number): MappedOrderItem {
  const item = asRecord(value);
  const variation = asRecord(item.variation_info);
  const quantity = Math.max(0, int(item.quantity));
  const unitPrice = Math.max(0, int(variation.retail_price, variation.exact_price, item.price));
  const unitCost = Math.max(0, int(variation.last_imported_price, variation.avg_price, item.cost_price));
  const discountEach = Math.max(0, int(item.discount_each_product));
  const isPercent = bool(item.is_discount_percent);
  const totalDiscount = Math.max(0, int(item.total_discount, isPercent ? Math.round((unitPrice * discountEach * quantity) / 100) : discountEach * quantity));
  const detail = str(variation.detail);
  const { attrs } = extractAttributes(variation.fields, detail);
  const variationId = str(item.variation_id, variation.id) || null;
  const productId = str(item.product_id, variation.product_id) || null;
  const sku = str(variation.display_id, variation.barcode, variation.product_display_id);
  const images = asArray(variation.images).map((i) => str(i)).filter(Boolean);
  const isBonus = bool(item.is_bonus_product);
  const lineTotal = isBonus ? 0 : Math.max(0, unitPrice * quantity - totalDiscount);
  const productName = str(variation.name, asRecord(item.one_time_product).name, `Sản phẩm ${sku || variationId || index + 1}`);

  return {
    id: str(item.id) || `${orderId}-${index + 1}`,
    variantId: variationId,
    productId,
    productName,
    variationDetail: detail || attrs.map((a) => `${a.name}: ${a.value}`).join(", "),
    sku,
    quantity,
    unitPrice,
    unitCost,
    discountEach,
    totalDiscount,
    isBonus,
    returnQuantity: int(item.return_quantity, item.returned_count),
    lineTotal,
    weight: int(variation.weight),
    image: images[0] ?? null,
    variation:
      variationId && productId
        ? {
            id: variationId,
            productId,
            name: productName,
            sku,
            barcode: str(variation.barcode),
            detail,
            fields: attrs,
            images,
            retailPrice: unitPrice,
            lastImportedPrice: Math.max(0, int(variation.last_imported_price)),
            avgPrice: num(variation.avg_price),
            weight: int(variation.weight),
          }
        : null,
  };
}

function resolveSource(order: Record<string, unknown>): string {
  const byName = str(order.order_sources_name);
  if (byName) return normalizeSourceName(byName);
  const marketplace = str(order.marketplace_id);
  if (marketplace && PANCAKE_ORDER_SOURCES[marketplace]) return PANCAKE_ORDER_SOURCES[marketplace];
  const sourceCode = str(order.order_sources);
  if (sourceCode && PANCAKE_ORDER_SOURCES[sourceCode]) return PANCAKE_ORDER_SOURCES[sourceCode];
  if (str(order.page_id) || str(order.conversation_id) || str(order.post_id)) return "Facebook";
  if (bool(order.is_livestream)) return "Livestream";
  if (bool(order.is_from_ecommerce)) return "Sàn TMĐT";
  return "Khác";
}

function normalizeSourceName(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("tiktok")) return "TikTok Shop";
  if (lower.includes("shopee")) return "Shopee";
  if (lower.includes("lazada")) return "Lazada";
  if (lower.includes("facebook") || lower === "fb") return "Facebook";
  if (lower.includes("instagram")) return "Instagram";
  if (lower.includes("zalo")) return "Zalo";
  if (lower.includes("web")) return "Website";
  return name;
}

function personName(value: unknown) {
  const r = asRecord(value);
  return str(r.name, r.full_name, r.email);
}

function mapShipment(order: Record<string, unknown>, stage: OrderStage, statusAt: Date | null): MappedShipment | null {
  const partner = asRecord(order.partner);
  const hasPartner = Object.keys(partner).length > 0;
  const additional = asRecord(order.additional_info);
  const shipping = asRecord(order.shipping_address);
  if (!hasPartner && !["SHIPPED", "DELIVERED", "PAID", "RETURNING", "RETURNED", "PARTIAL_RETURN"].includes(stage)) return null;

  const partnerName = str(partner.partner_name, asRecord(additional.service_partner).name, additional.service_partner);
  const vtpNumber = str(partner.order_number_vtp) || null;
  const carrier = vtpNumber || /viettel/i.test(partnerName) ? "Viettel Post" : partnerName || "Khác";
  const trackingCode = str(partner.extend_code, partner.order_id_ghn, vtpNumber) || null;
  const partnerStatus = str(partner.partner_status) || null;
  const partnerMeta = partnerStatus ? PANCAKE_PARTNER_STATUS[partnerStatus] : undefined;

  let shipmentStage: ShipmentStage = partnerMeta?.stage ?? "PENDING";
  if (!partnerMeta) {
    if (stage === "DELIVERED" || stage === "PAID") shipmentStage = "DELIVERED";
    else if (stage === "RETURNING") shipmentStage = "RETURNING";
    else if (stage === "RETURNED" || stage === "PARTIAL_RETURN") shipmentStage = "RETURNED";
    else if (stage === "CANCELLED" || stage === "DELETED") shipmentStage = hasPartner ? "CANCELLED" : "PENDING";
    else if (stage === "SHIPPED") shipmentStage = "PICKED_UP";
  } else if (partnerMeta.stage === "PENDING" && (stage === "DELIVERED" || stage === "PAID")) {
    shipmentStage = "DELIVERED";
  }

  const codAmount = Math.max(0, int(order.money_to_collect, order.cod));
  const reconciledCod = Math.max(0, int(partner.cod));
  const paidAt = pancakeDate(partner.paid_at);
  const deliveredLike = shipmentStage === "DELIVERED" || stage === "DELIVERED" || stage === "PAID";
  let codStatus: CodStatus = codAmount > 0 ? "PENDING" : "NOT_APPLICABLE";
  if (codAmount > 0) {
    if (paidAt || partnerStatus === "delivered_cod" || partnerStatus === "returned_cod") codStatus = "RECONCILED";
    else if (deliveredLike) codStatus = "COLLECTED";
  }

  const events = asArray(partner.extend_update)
    .map((e) => {
      const r = asRecord(e);
      const occurredAt = pancakeDate(r.update_at ?? r.updated_at ?? r.time);
      if (!occurredAt) return null;
      const status = str(r.status, r.key);
      return { status: status || "update", statusName: str(r.note, r.status_name, status), note: str(r.note), occurredAt, raw: r as Json };
    })
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  return {
    carrier,
    partnerId: int(partner.partner_id) || null,
    trackingCode,
    vtpOrderNumber: vtpNumber,
    partnerStatus,
    stage: shipmentStage,
    codAmount,
    codCollected: codStatus === "COLLECTED" || codStatus === "RECONCILED" ? (reconciledCod || codAmount) : 0,
    codStatus,
    codReconciledAt: paidAt,
    shippingFee: Math.max(0, int(partner.total_fee, order.partner_fee)),
    pickedUpAt: pancakeDate(partner.picked_up_at),
    firstDeliveryAt: pancakeDate(partner.first_delivery_at),
    deliveredAt: deliveredLike ? statusAt : null,
    returnedAt: shipmentStage === "RETURNED" ? statusAt : null,
    cancelledAt: shipmentStage === "CANCELLED" ? statusAt : null,
    isFinal: ["DELIVERED", "RETURNED", "CANCELLED"].includes(shipmentStage),
    receiverName: str(shipping.full_name, order.bill_full_name),
    receiverPhone: normalizePhone(str(shipping.phone_number, order.bill_phone_number)),
    receiverAddress: str(shipping.full_address, shipping.new_full_address, shipping.address),
    partnerUpdatedAt: pancakeDate(partner.updated_at),
    events,
    raw: (hasPartner ? partner : {}) as Json,
  };
}

export function mapOrder(value: unknown): MappedOrder | null {
  const order = asRecord(value);
  const id = str(order.id, order.system_id);
  if (!id) return null;
  const status = int(order.status);
  const stage = pancakeStatusToStage(status);
  const shipping = asRecord(order.shipping_address);
  const warehouseInfo = asRecord(order.warehouse_info);
  const items = asArray(order.items).map((item, index) => mapOrderItem(item, id, index));
  const insertedAt = pancakeDate(order.inserted_at) ?? new Date();
  const statusHistory = asArray(order.status_history)
    .map((h) => {
      const r = asRecord(h);
      const updatedAt = pancakeDate(r.updated_at);
      if (!updatedAt) return null;
      return { status: int(r.status), oldStatus: r.old_status === null || r.old_status === undefined ? null : int(r.old_status), editorName: str(r.name, asRecord(r.editor).name), updatedAt };
    })
    .filter((h): h is NonNullable<typeof h> => Boolean(h));
  const lastStatusAt = pancakeDate(order.last_update_status_at) ?? statusHistory.filter((h) => h.status === status).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.updatedAt ?? null;
  // giá vốn gồm cả sản phẩm tặng kèm (vẫn tốn hàng)
  const cogs = items.reduce((sum, item) => sum + item.unitCost * item.quantity, 0);
  const totalPrice = int(order.total_price);
  const totalDiscount = Math.max(0, int(order.total_discount));
  const totalPriceAfterDiscount = int(order.total_price_after_sub_discount, totalPrice - totalDiscount);
  const warehouseId = str(order.warehouse_id) || null;

  return {
    id,
    systemId: int(order.system_id) || null,
    displayId: int(order.display_id) || null,
    customId: str(order.custom_id) || null,
    shopId: str(order.shop_id) || null,
    status,
    statusName: pancakeStatusName(status),
    stage,
    subStatus: order.sub_status === null || order.sub_status === undefined ? null : int(order.sub_status),
    billFullName: str(order.bill_full_name, shipping.full_name),
    billPhone: normalizePhone(str(order.bill_phone_number, shipping.phone_number)),
    billEmail: str(order.bill_email),
    shipFullName: str(shipping.full_name, order.bill_full_name),
    shipPhone: normalizePhone(str(shipping.phone_number, order.bill_phone_number)),
    shipAddress: str(shipping.address),
    shipFullAddress: str(shipping.full_address, shipping.new_full_address),
    shipProvince: str(shipping.province_name),
    shipDistrict: str(shipping.district_name),
    shipCommune: str(shipping.commune_name, shipping.commnue_name),
    totalPrice,
    totalPriceAfterDiscount,
    totalDiscount,
    shippingFee: Math.max(0, int(order.shipping_fee)),
    partnerFee: Math.max(0, int(order.partner_fee, asRecord(order.partner).total_fee)),
    customerPayFee: bool(order.customer_pay_fee),
    isFreeShipping: bool(order.is_free_shipping),
    cod: Math.max(0, int(order.cod)),
    moneyToCollect: Math.max(0, int(order.money_to_collect, order.cod)),
    prepaid: Math.max(0, int(order.prepaid)),
    transferMoney: Math.max(0, int(order.transfer_money)),
    cash: Math.max(0, int(order.cash)),
    surcharge: int(order.surcharge),
    tax: int(order.tax),
    feeMarketplace: int(order.fee_marketplace),
    returnFee: Math.max(0, int(order.return_fee)),
    exchangeValue: int(order.exchange_value),
    isExchangeOrder: bool(order.is_exchange_order),
    isLivestream: bool(order.is_livestream),
    source: resolveSource(order),
    accountName: str(order.account_name, asRecord(order.page).name),
    pageId: str(order.page_id) || null,
    postId: str(order.post_id) || null,
    adId: str(order.ad_id) || null,
    marketplaceId: str(order.marketplace_id) || null,
    sellerName: personName(order.assigning_seller),
    careName: personName(order.assigning_care),
    marketerName: personName(order.marketer),
    creatorName: personName(order.creator),
    warehouseId,
    warehouse: warehouseId ? { id: warehouseId, name: str(warehouseInfo.name, "Kho"), fullAddress: str(warehouseInfo.full_address, warehouseInfo.address), phone: str(warehouseInfo.phone_number) } : null,
    note: str(order.note),
    notePrint: str(order.note_print),
    tags: asArray(order.tags).map((t) => str(asRecord(t).name, t)).filter(Boolean),
    itemsCount: int(order.items_length) || items.length,
    totalQuantity: int(order.total_quantity) || items.reduce((sum, i) => sum + i.quantity, 0),
    cogs,
    returnedReason: str(order.returned_reason_name) || null,
    insertedAt,
    updatedAtExternal: pancakeDate(order.updated_at),
    lastUpdateStatusAt: lastStatusAt,
    timeSendPartner: pancakeDate(order.time_send_partner),
    estimateDeliveryDate: pancakeDate(order.estimate_delivery_date),
    raw: order as Json,
    items,
    customer: mapCustomer(order.customer),
    shipment: mapShipment(order, stage, lastStatusAt),
    statusHistory,
  };
}

// ───────── Products ─────────

export type MappedVariant = {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  customId: string | null;
  attributes: Json | null;
  detail: string;
  color: string;
  size: string;
  images: string[];
  weight: number;
  retailPrice: number;
  retailPriceAfterDiscount: number;
  lastImportedPrice: number;
  avgImportedPrice: number;
  remainQuantity: number;
  actualRemainQuantity: number;
  isHidden: boolean;
  isLocked: boolean;
  isRemoved: boolean;
  insertedAt: Date | null;
  updatedAtExternal: Date | null;
  raw: Json;
  stocks: { warehouseId: string; remainQuantity: number; actualRemainQuantity: number; totalQuantity: number; pendingQuantity: number; returningQuantity: number; waitingQuantity: number; sellingAvg: number | null }[];
};

export type MappedProduct = {
  id: string;
  name: string;
  customId: string | null;
  displayId: number | null;
  image: string | null;
  categories: string[];
  tags: string[];
  isPublished: boolean | null;
  isHidden: boolean;
  isRemoved: boolean;
  note: string;
  insertedAt: Date | null;
  raw: Json;
  variants: MappedVariant[];
};

export function mapVariant(value: unknown, productIdFallback?: string): MappedVariant | null {
  const v = asRecord(value);
  const id = str(v.id);
  const productId = str(v.product_id, productIdFallback, asRecord(v.product).id);
  if (!id || !productId) return null;
  const { attrs, color, size } = extractAttributes(v.fields, str(v.detail));
  const stocks = asArray(v.variations_warehouses)
    .map(asRecord)
    .filter((w) => str(w.warehouse_id))
    .map((w) => ({
      warehouseId: str(w.warehouse_id),
      remainQuantity: int(w.remain_quantity),
      actualRemainQuantity: int(w.actual_remain_quantity),
      totalQuantity: int(w.total_quantity),
      pendingQuantity: int(w.pending_quantity),
      returningQuantity: int(w.returning_quantity),
      waitingQuantity: int(w.waiting_quantity),
      sellingAvg: w.selling_avg === null || w.selling_avg === undefined ? null : num(w.selling_avg),
    }));
  const remain = stocks.length ? stocks.reduce((s, w) => s + w.remainQuantity, 0) : int(v.remain_quantity);
  const actual = stocks.length ? stocks.reduce((s, w) => s + w.actualRemainQuantity, 0) : int(v.remain_quantity);
  const detail = str(v.detail) || attrs.map((a) => `${a.name}: ${a.value}`).join(", ");
  return {
    id,
    productId,
    sku: str(v.display_id, v.custom_id, v.barcode),
    barcode: str(v.barcode) || null,
    customId: str(v.custom_id) || null,
    attributes: attrs.length ? (attrs as Json) : null,
    detail,
    color,
    size,
    images: asArray(v.images).map((i) => str(i)).filter(Boolean),
    weight: int(v.weight),
    retailPrice: int(v.retail_price),
    retailPriceAfterDiscount: int(v.retail_price_after_discount, v.retail_price),
    lastImportedPrice: int(v.last_imported_price),
    avgImportedPrice: num(v.average_imported_price, v.avg_price),
    remainQuantity: remain,
    actualRemainQuantity: actual,
    isHidden: bool(v.is_hidden),
    isLocked: bool(v.is_locked),
    isRemoved: bool(v.is_removed),
    insertedAt: pancakeDate(v.inserted_at),
    updatedAtExternal: pancakeDate(v.updated_at),
    raw: v as Json,
    stocks,
  };
}

export function mapProduct(value: unknown): MappedProduct | null {
  const p = asRecord(value);
  const id = str(p.id);
  if (!id) return null;
  const variants = asArray(p.variations)
    .map((v) => mapVariant(v, id))
    .filter((v): v is MappedVariant => Boolean(v));
  return {
    id,
    name: str(p.name, `Sản phẩm ${str(p.display_id, id)}`),
    customId: str(p.custom_id) || null,
    displayId: int(p.display_id) || null,
    image: str(p.image, variants[0]?.images[0]) || null,
    categories: asArray(p.categories).map((c) => str(asRecord(c).name, c)).filter(Boolean),
    tags: asArray(p.tags).map((t) => str(asRecord(t).name, t)).filter(Boolean),
    isPublished: typeof p.is_published === "boolean" ? p.is_published : null,
    isHidden: bool(p.is_hidden),
    isRemoved: bool(p.is_removed),
    note: str(p.note, p.note_product),
    insertedAt: pancakeDate(p.inserted_at),
    raw: p as Json,
    variants,
  };
}

export function mapWarehouse(value: unknown) {
  const w = asRecord(value);
  const id = str(w.id);
  if (!id) return null;
  return {
    id,
    name: str(w.name, "Kho"),
    address: str(w.address),
    fullAddress: str(w.full_address),
    phone: str(w.phone_number),
    provinceId: str(w.province_id) || null,
    districtId: str(w.district_id) || null,
    communeId: str(w.commune_id) || null,
    customId: str(w.custom_id) || null,
    allowCreateOrder: bool(w.allow_create_order, true),
    raw: w as Json,
  };
}

export function mapInventoryHistory(value: unknown) {
  const h = asRecord(value);
  const id = str(h.id);
  const insertedAt = pancakeDate(h.inserted_at);
  if (!id || !insertedAt) return null;
  const variationNow = asRecord(h.variation_now);
  const warehouse = asRecord(h.warehouse);
  return {
    id,
    variantId: str(h.variation_id, variationNow.id) || null,
    warehouseId: str(h.warehouse_id, warehouse.id) || null,
    quantity: int(h.quantity),
    remainQuantity: int(h.remain_quantity),
    avgPrice: h.avg_price === null || h.avg_price === undefined ? null : num(h.avg_price),
    type: str(h.type),
    tableName: str(h.table_name) || null,
    refDisplayId: str(h.ref_display_id) || null,
    editorName: str(asRecord(h.editor).name, h.editor_name) || null,
    insertedAt,
    raw: h as Json,
  };
}

export function mapOrderReturn(value: unknown) {
  const r = asRecord(value);
  const id = str(r.id);
  const insertedAt = pancakeDate(r.inserted_at);
  if (!id || !insertedAt) return null;
  const status = int(r.status);
  return {
    id,
    displayId: int(r.display_id) || null,
    orderId: str(r.order_id, asRecord(r.order).id) || null,
    orderToReturnedId: str(r.order_id_to_returned, asRecord(r.order_to_returned).id) || null,
    status,
    statusName: str(r.status_name) || (status === 0 ? "Mới" : `Trạng thái ${status}`),
    returnedFee: int(r.returned_fee),
    discount: int(r.discount),
    isExchange: bool(r.is_exchange, bool(asRecord(r.order).is_exchange_order)),
    billFullName: str(r.bill_full_name),
    billPhone: normalizePhone(str(r.bill_phone_number)),
    items: asArray(r.returned_items).length ? (asArray(r.returned_items) as Json) : null,
    insertedAt,
    updatedAtExternal: pancakeDate(r.updated_at),
    raw: r as Json,
  };
}

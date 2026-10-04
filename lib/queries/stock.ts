import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema, type Db } from "@/db";
import { ORDER_LEFT_WAREHOUSE, ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, REPORTABLE_ORDER, SHIPMENT_LEFT_WAREHOUSE, VTP_DESTROYED } from "@/lib/queries/return-rate";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { CANONICAL_OUTCOME_VERSION } from "@/lib/constants/canonical-outcome";
import { validateOrdersForShipping } from "@/lib/queries/preship-validation";

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;
const ri = schema.stockReceiptItems;
const r = schema.stockReceipts;
const pv = schema.productVariants;
const p = schema.products;
const coo = schema.canonicalOrderOutcome;

/**
 * ───────────── BẢNG DẪN XUẤT SINH RA ĐỂ **NỐI**, KHÔNG PHẢI ĐỂ TRA TỪNG DÒNG ─────────────
 *
 * `ORDER_OUTCOME_FAST` là truy vấn con TƯƠNG QUAN. Dùng nó trong một câu gộp trên 2.495 dòng hàng
 * thì Postgres gắn cả chuỗi dự phòng vào phép quét `orders`, và `EXPLAIN ANALYZE` trên production
 * (10/09/2026) cho thấy chính phép quét đó mất **9.053ms cho 2.443 dòng** — chỉ 350 buffer, tức
 * không phải đọc đĩa mà là biểu thức chạy trên từng dòng. Cả câu sổ kho: **39.960ms**, chạy hai lần
 * mỗi lần mở trang chủ.
 *
 * Ở đây nối thẳng vào bảng dẫn xuất: một phép nối băm, tính một lần cho tất cả. Điều kiện tươi mới
 * đặt NGAY TRONG phép nối, nên dòng cũ không khớp và `coalesce` rơi về biểu thức chuẩn — vẫn đúng
 * luật "chậm chứ không sai", chỉ khác là phần chậm nay chỉ trả cho những dòng thật sự cũ.
 */
const OUTCOME_JOINED = sql`coalesce(${coo.outcome}, ${ORDER_OUTCOME_FAST})`;

/** Điều kiện nối bảng dẫn xuất kết quả đơn — dòng CŨ hơn đơn / vận đơn không khớp, rơi về biểu thức chuẩn. */
const COO_FRESH = and(
  eq(coo.orderId, o.id),
  sql`coalesce(${coo.shipmentId}, '') = coalesce(${s.id}, '')`,
  eq(coo.logicVersion, CANONICAL_OUTCOME_VERSION),
  sql`${coo.computedAt} >= ${o.updatedAt}`,
  sql`(${s.id} is null or ${coo.computedAt} >= ${s.updatedAt})`,
);

/**
 * DÒNG ĐƠN ĐƯỢC TÍNH VÀO TỶ LỆ GIAO THÀNH CÔNG — ĐÚNG tập mà báo cáo Tỷ lệ hoàn dùng (`baseWhere`
 * trong return-rate.ts): bỏ dòng HÀNG TẶNG (đơn 0đ của món tặng không phải một lần bán) và bỏ đơn
 * `NEW` (chưa chốt). Khác vế tồn kho ở trên — hàng tặng vẫn trừ tồn vì nó vẫn rời kho.
 */
const GTC_ORDER_LINE = sql`(${oi.isBonus} = false and ${REPORTABLE_ORDER})`;

/**
 * SỔ KHO — mọi con số tồn của ERP đều ra từ một phương trình duy nhất:
 *
 *   Tồn thực tế   = (tổng phiếu kho) − (đã xuất qua ĐVVC)
 *   Tồn khả dụng  = Tồn thực tế − (đã chốt đơn nhưng chưa xuất)
 *
 * Phiếu kho quy ước DƯƠNG = vào kho (nhập mới, tái nhập hàng hoàn, điều chỉnh tăng),
 * ÂM = ra kho (xuất tay không qua ĐVVC, điều chỉnh giảm).
 *
 * ĐÃ XUẤT đếm theo VẬN ĐƠN, không theo tiền: hàng rời kho lúc bưu tá lấy hàng, không phải lúc
 * khách trả tiền. Vì vậy tồn kho KHÔNG dùng ORDER_OUTCOME (định nghĩa theo COD thực thu, dành cho
 * doanh thu / lợi nhuận). Hàng hoàn vẫn nằm trong "đã xuất" cho tới khi kho lập phiếu tái nhập —
 * ĐVVC báo "đã hoàn" chỉ là hàng đang trên đường về, không phải hàng đã có trong kho.
 *
 * Hàng tặng kèm (is_bonus) vẫn trừ tồn như hàng bán: lên đơn 0đ nhưng vẫn rời kho.
 */

/** Số món của một dòng đơn — hàng tặng tính như hàng bán vì cũng rời kho. */
const QTY = sql<number>`${oi.quantity}`;

/**
 * Đã chốt đơn nhưng CHƯA rời kho: hàng còn trong kho nhưng đã hứa cho khách.
 * Gồm đơn đã xác nhận/đang đóng/chờ chuyển và cả vận đơn đã tạo mã mà bưu tá chưa lấy.
 *
 * `coalesce(…, false)` KHÔNG phải trang trí. Đơn CHƯA CÓ DÒNG VẬN ĐƠN NÀO thì phép nối trái cho
 * `shipments.*` = NULL, `SHIPMENT_LEFT_WAREHOUSE` = `false or NULL` = NULL, và `not NULL` = NULL —
 * bộ lọc gộp coi NULL là "không", nên đúng những đơn mới chốt, chưa kịp tạo mã (hàng CHẮC CHẮN còn
 * trong kho) lại rơi khỏi "chờ xuất". Đo production 23/09/2026: 105 đơn CONFIRMED · 108 món ·
 * 17 mẫu mã rơi như vậy (100 đơn trong 14 ngày gần nhất) ⇒ khả dụng bị báo DƯ 108 món, "còn thiếu"
 * và đề xuất đặt bị báo THIẾU tương ứng. Chưa có vận đơn nghĩa là CHƯA rời kho, không phải "chưa biết".
 */
export const RESERVED_IN_WAREHOUSE = sql`(not ${ORDER_LEFT_WAREHOUSE}
  and ${o.stage} in ('CONFIRMED','PACKING','READY_TO_SHIP','SHIPPED'))`;

/** Hàng đã rời kho và đang trên đường (chưa kết thúc) — nằm ngoài kho, chưa biết về hay không. */
const OUT_IN_TRANSIT = sql`(${SHIPMENT_LEFT_WAREHOUSE} and ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED'))`;

/**
 * Hàng phải quay về kho mà kho CHƯA lập phiếu tái nhập.
 * Gồm đơn hoàn (theo kết quả đơn) và đơn huỷ sau khi đã xuất — chủ shop yêu cầu xử lý như hàng hoàn.
 */
const OUT_AWAITING_RETURN = sql`(${SHIPMENT_LEFT_WAREHOUSE} and ${s.returnReceivedAt} is null
  and ((${OUTCOME_JOINED} in (${sql.raw(RETURNED_OUTCOMES_SQL)}) and ${s.returnReceivedAt} is null) or ${s.stage} in ('RETURNING','RETURNED','CANCELLED') or ${o.stage} in ('CANCELLED','DELETED'))
  and not ${VTP_DESTROYED})`;

/** Hàng hoàn kho ĐÃ xử lý (đã có phiếu tái nhập) — dùng để đối chiếu với số thực nhập, ra phần hụt. */
const OUT_RETURN_HANDLED = sql`(${SHIPMENT_LEFT_WAREHOUSE} and ${s.returnReceivedAt} is not null)`;

/**
 * Số lượng theo mẫu mã ở phía ĐƠN HÀNG (grain: dòng đơn × vận đơn của đơn đó).
 * `shipped` là số THỰC SỰ RỜI KHO — trụ cột của phương trình tồn kho.
 *
 * `onlyVariantIds` (tuỳ chọn) lọc NGAY TRONG phép gộp, trước `group by` — cho nơi chỉ cần vài mẫu
 * (bảng thiếu hàng: đúng các mẫu đang có đơn giữ). Không truyền thì câu lệnh y hệt như cũ. Lọc ở
 * NGOÀI (nối xong rồi `where pv.id in …`) không cứu được: Postgres vẫn gộp toàn bộ dòng đơn của
 * shop rồi mới vứt đi phần không dùng. Giá trị từng mẫu không đổi, vì phép gộp là theo mẫu.
 */
/** `db` có thể là một GIAO DỊCH (`lib/commerce/stock.ts` đọc tồn trong cùng giao dịch ghi đơn) — chỉ dùng `select`. */
export function variantSalesSubquery(db: Pick<Db, "select">, onlyVariantIds?: string[]) {
  return db
    .select({
      variantId: oi.variantId,
      /** ĐÃ XUẤT KHO — qua ĐVVC (trạng thái vận đơn dựng từ sự kiện Viettel Post) hoặc phiếu giao ký nhận của đơn tay. */
      shipped: sql<number>`coalesce(sum(${QTY}) filter (where ${ORDER_LEFT_WAREHOUSE}), 0)`.as("out_shipped"),
      /** Đã xuất, đang trên đường, chưa kết thúc. */
      inTransit: sql<number>`coalesce(sum(${QTY}) filter (where ${OUT_IN_TRANSIT}), 0)`.as("out_in_transit"),
      /** Đã xuất, phải quay về, kho chưa lập phiếu tái nhập. */
      awaitingReturn: sql<number>`coalesce(sum(${QTY}) filter (where ${OUT_AWAITING_RETURN}), 0)`.as("out_awaiting_return"),
      /** Đã xuất và đã lập phiếu tái nhập — đối chiếu với số thực nhập để ra phần hụt. */
      returnHandled: sql<number>`coalesce(sum(${QTY}) filter (where ${OUT_RETURN_HANDLED}), 0)`.as("out_return_handled"),
      /** Đã chốt đơn, hàng còn trong kho — trừ khỏi tồn KHẢ DỤNG, không trừ khỏi tồn thực tế. */
      reserved: sql<number>`coalesce(sum(${QTY}) filter (where ${RESERVED_IN_WAREHOUSE}), 0)`.as("out_reserved"),
      /** Giao thành công theo TIỀN (ORDER_OUTCOME) — chỉ để đối chiếu, KHÔNG dùng tính tồn. */
      delivered: sql<number>`coalesce(sum(${QTY}) filter (where ${OUTCOME_JOINED} = 'DELIVERED'), 0)`.as("sold_delivered"),
      /** Hoàn theo kết quả đơn — chỉ để đối chiếu. */
      returned: sql<number>`coalesce(sum(${QTY}) filter (where ${OUTCOME_JOINED} in (${sql.raw(RETURNED_OUTCOMES_SQL)})), 0)`.as("sold_returned"),
      /**
       * SỐ ĐƠN giao thành công / hoàn — grain ĐƠN, không phải số cái: đơn mua 2 cái cùng mẫu vẫn là
       * MỘT đơn. Hai vế của `successRate()`; đơn chưa kết thúc không nằm ở vế nào.
       */
      deliveredOrders: sql<number>`count(distinct ${o.id}) filter (where ${GTC_ORDER_LINE} and ${OUTCOME_JOINED} = 'DELIVERED')`.as("gtc_delivered_orders"),
      returnedOrders: sql<number>`count(distinct ${o.id}) filter (where ${GTC_ORDER_LINE} and ${OUTCOME_JOINED} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`.as("gtc_returned_orders"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    // Kết quả đơn lấy bằng PHÉP NỐI, không bằng truy vấn con cho từng dòng — xem OUTCOME_JOINED.
    .leftJoin(coo, COO_FRESH)
    .where(onlyVariantIds ? inArray(oi.variantId, onlyVariantIds) : undefined)
    .groupBy(oi.variantId)
    .as("vsales");
}

/**
 * SỐ ĐƠN GIAO THÀNH CÔNG / HOÀN THEO MÃ HÀNG — gộp THEO ĐƠN ở máy chủ, không cộng các dòng mẫu mã.
 *
 * Một đơn mua hai mẫu của cùng một mã (gói 2 chiếc khác màu/size) có mặt ở CẢ HAI dòng mẫu mã; cộng
 * hai dòng lại là đếm đơn đó hai lần và tỷ lệ của mã bị cân lệch về phía đơn nhiều món. Khoá mã hàng
 * là ĐÚNG biểu thức của báo cáo Tỷ lệ hoàn (`productKey` trong `getReturnRateByVariant`).
 * Chỉ gộp các mã được hỏi — trang Sản phẩm hỏi đúng các mã đang hiện.
 */
export async function productOutcomeOrders(productIds: string[]): Promise<Map<string, { deliveredOrders: number; returnedOrders: number }>> {
  const map = new Map<string, { deliveredOrders: number; returnedOrders: number }>();
  if (!productIds.length) return map;
  const db = await getDb();
  const productKey = sql<string>`coalesce(${pv.productId}, ${oi.productId}, '')`;
  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        productId: productKey,
        deliveredOrders: sql<number>`count(distinct ${o.id}) filter (where ${OUTCOME_JOINED} = 'DELIVERED')`,
        returnedOrders: sql<number>`count(distinct ${o.id}) filter (where ${OUTCOME_JOINED} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
      })
      .from(oi)
      .innerJoin(o, eq(o.id, oi.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(coo, COO_FRESH)
      .leftJoin(pv, eq(pv.id, oi.variantId))
      .where(and(GTC_ORDER_LINE, inArray(productKey, productIds)))
      .groupBy(productKey),
  );
  for (const r of rows) map.set(r.productId, { deliveredOrders: Number(r.deliveredOrders ?? 0), returnedOrders: Number(r.returnedOrders ?? 0) });
  return map;
}

/** Một dòng đơn ĐÃ CHỐT mà hàng CHƯA rời kho — chi tiết của ô "chờ xuất" trên trang Sản phẩm. */
export type ReservedOrderLine = {
  orderId: string;
  systemId: number | null;
  orderStage: string;
  /** Khoá để dựng liên kết POS / chat Pancake — `null` thì trang không vẽ liên kết đó. */
  shopId: string | null;
  /** `orders.raw.order_link` — đường dẫn POS chính thức Pancake gửi kèm đơn (mang MÃ NỘI BỘ của POS). */
  posOrderLink: string | null;
  pageId: string | null;
  conversationId: string | null;
  insertedAt: Date;
  promisedAt: Date | null;
  customer: string;
  phone: string;
  /** `null` = Pancake không ghi giá trị đơn — CHƯA BIẾT, không in thành 0 ₫. */
  orderValue: number | null;
  variantId: string;
  sku: string;
  variantLabel: string;
  quantity: number;
  isBonus: boolean;
  shipmentCode: string | null;
  shipmentStage: string | null;
};

/** Mã hàng (và mẫu mã, nếu mở theo mẫu) mà danh sách chờ xuất đang nói tới. */
export type ReservedScope = { productId: string; productName: string; variant: { sku: string; label: string } | null };

/**
 * DANH SÁCH ĐƠN CHỜ XUẤT — ĐÚNG vị ngữ `RESERVED_IN_WAREHOUSE` và ĐÚNG phép nối vận đơn
 * (`PRIMARY_ATTEMPT`) của cột `reserved` trong `variantSalesSubquery`, nên tổng `quantity` của danh
 * sách BẰNG số "chờ xuất" in trên bảng (bài kiểm khoá điều đó). Hàng tặng vẫn có mặt vì nó cũng
 * đang giữ hàng trong kho. Đơn chờ LÂU NHẤT lên đầu.
 */
export async function listReservedOrderLines(filter: { variantId: string } | { productId: string }): Promise<{ scope: ReservedScope | null; lines: ReservedOrderLine[] }> {
  const db = await getDb();
  const byVariant = "variantId" in filter;
  const scope = byVariant ? eq(oi.variantId, filter.variantId) : eq(pv.productId, filter.productId);
  const [head] = await db
    .select({ productId: p.id, productName: p.name, sku: pv.sku, color: pv.color, size: pv.size })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .where(byVariant ? eq(pv.id, filter.variantId) : eq(pv.productId, filter.productId))
    .limit(1);
  if (!head) return { scope: null, lines: [] };
  const rows = await db
    .select({
      orderId: o.id,
      systemId: o.systemId,
      orderStage: sql<string>`${o.stage}::text`,
      shopId: o.shopId,
      posOrderLink: sql<string | null>`${o.raw}->>'order_link'`,
      pageId: o.pageId,
      conversationId: o.conversationId,
      insertedAt: o.insertedAt,
      promisedAt: o.customerPromisedAt,
      customer: o.billFullName,
      phone: o.billPhone,
      orderValue: o.totalPriceAfterDiscount,
      variantId: oi.variantId,
      sku: sql<string>`coalesce(nullif(${pv.sku}, ''), ${oi.sku})`,
      color: pv.color,
      size: pv.size,
      variationDetail: oi.variationDetail,
      quantity: oi.quantity,
      isBonus: oi.isBonus,
      shipmentCode: s.vtpOrderNumber,
      shipmentStage: sql<string | null>`${s.stage}::text`,
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .innerJoin(pv, eq(pv.id, oi.variantId))
    .where(and(RESERVED_IN_WAREHOUSE, scope))
    .orderBy(asc(o.insertedAt), asc(o.id));
  const lines = rows.map((r) => ({
    orderId: r.orderId,
    systemId: r.systemId ?? null,
    orderStage: r.orderStage,
    shopId: r.shopId ?? null,
    posOrderLink: r.posOrderLink ?? null,
    pageId: r.pageId ?? null,
    conversationId: r.conversationId ?? null,
    insertedAt: new Date(r.insertedAt),
    promisedAt: r.promisedAt ? new Date(r.promisedAt) : null,
    customer: r.customer || "Khách",
    phone: r.phone ?? "",
    orderValue: r.orderValue === null || r.orderValue === undefined ? null : Number(r.orderValue),
    variantId: r.variantId as string,
    sku: r.sku ?? "",
    variantLabel: [r.color, r.size].filter(Boolean).join(" / ") || r.variationDetail || "",
    quantity: Number(r.quantity ?? 0),
    isBonus: Boolean(r.isBonus),
    shipmentCode: r.shipmentCode ?? null,
    shipmentStage: r.shipmentStage ?? null,
  }));
  return {
    scope: {
      productId: head.productId,
      productName: head.productName,
      variant: byVariant ? { sku: head.sku ?? "", label: [head.color, head.size].filter(Boolean).join(" / ") } : null,
    },
    lines,
  };
}

/** Một lỗi soát của đơn, rút gọn cho danh sách: mã luật + trường người sửa nhìn thấy trên Pancake. */
export type ReservedLineFinding = { code: string; field: string };

export type ReservedQueueLine = ReservedOrderLine & {
  /** `false` = đơn còn lỗi CHẶN GỬI (`validateForShipping`) ⇒ chưa đủ điều kiện vào hàng đợi xuất. */
  readyToShip: boolean;
  blockers: ReservedLineFinding[];
  /** Gửi được nhưng một con số sẽ sai về sau (chưa ghép mẫu mã, lệch tiền) — nêu ra, KHÔNG loại. */
  warnings: ReservedLineFinding[];
};

/**
 * HÀNG ĐỢI XUẤT CỦA MỘT MẪU MÃ / MÃ HÀNG — danh sách chờ xuất TÁCH theo bản soát trước khi gửi.
 *
 * Chủ shop chốt 27/09/2026: đơn THIẾU THÔNG TIN (SĐT, địa chỉ, thông tin hàng) chưa đủ điều kiện
 * vào hàng đợi chờ xuất. "Thiếu" = còn lỗi mức `BLOCKER` của `validateForShipping()` — ĐÚNG bộ luật
 * của trang Soát đơn trước khi gửi, không phải một định nghĩa thứ hai. Lỗi mức `WARNING` không loại.
 *
 * CỐ Ý KHÔNG đổi sổ kho: đơn thiếu thông tin vẫn là đơn ĐÃ CHỐT và vẫn giữ hàng (`reserved` →
 * Khả dụng bán). Bỏ nó khỏi phần giữ hàng là báo khả dụng DƯ rồi bán trùng đúng những cái đã hứa.
 * Nên `ready` + `incomplete` cộng lại luôn bằng số "chờ xuất" trên trang Sản phẩm.
 */
export async function listReservedQueue(filter: { variantId: string } | { productId: string }): Promise<{ scope: ReservedScope | null; ready: ReservedQueueLine[]; incomplete: ReservedQueueLine[] }> {
  const { scope, lines } = await listReservedOrderLines(filter);
  const reports = await validateOrdersForShipping(lines.map((l) => l.orderId));
  const rut = (fs: { code: string; field: string }[]) => fs.map((f) => ({ code: f.code, field: f.field }));
  const all: ReservedQueueLine[] = lines.map((l) => {
    const r = reports.get(l.orderId);
    // Không soát được (đơn biến mất giữa hai câu lệnh) ⇒ KHÔNG coi là đủ: chưa biết thì chưa xếp vào hàng đợi.
    return { ...l, readyToShip: r ? r.readyToShip : false, blockers: r ? rut(r.blockers) : [{ code: "NOT_VALIDATED", field: "Chưa soát được đơn" }], warnings: r ? rut(r.warnings) : [] };
  });
  return { scope, ready: all.filter((l) => l.readyToShip), incomplete: all.filter((l) => !l.readyToShip) };
}

/** Tổng các phiếu kho theo mẫu mã, tách theo loại phiếu để theo dõi riêng nhập mới / tái nhập / điều chỉnh / xuất tay. `onlyVariantIds`: như `variantSalesSubquery`. */
export function variantReceiptsSubquery(db: Pick<Db, "select">, onlyVariantIds?: string[]) {
  return db
    .select({
      variantId: ri.variantId,
      /** Tổng ròng mọi phiếu (đã tính dấu) — vế "vào kho" của phương trình tồn. */
      received: sql<number>`coalesce(sum(${ri.quantity}), 0)`.as("received"),
      /** Nhập hàng mới từ xưởng / NCC. */
      receiptIn: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${r.kind} = 'RECEIPT'), 0)`.as("receipt_in"),
      /** Tái nhập hàng hoàn — số kho ĐẾM THỰC TẾ, không phải số suy ra từ vận đơn. */
      returnIn: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${r.kind} = 'RETURN'), 0)`.as("return_in"),
      /** Điều chỉnh sau kiểm kê (âm hoặc dương). */
      adjust: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${r.kind} = 'ADJUSTMENT'), 0)`.as("adjust_qty"),
      /** Xuất kho tay không qua ĐVVC (khách tới lấy, ship nội thành) — lưu số âm, đổi dấu để hiển thị. */
      manualOut: sql<number>`coalesce(-sum(${ri.quantity}) filter (where ${r.kind} = 'ISSUE'), 0)`.as("manual_out"),
      receiptCount: sql<number>`count(distinct ${ri.receiptId})`.as("receipt_count"),
      /** Số phiếu NHẬP HÀNG — mẫu mã chưa có phiếu nào thì tồn là THIẾU DỮ LIỆU, không phải 0. */
      receiptDocs: sql<number>`count(distinct ${ri.receiptId}) filter (where ${r.kind} = 'RECEIPT')`.as("receipt_docs"),
    })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .where(onlyVariantIds ? inArray(ri.variantId, onlyVariantIds) : undefined)
    .groupBy(ri.variantId)
    .as("vreceipts");
}

/** Giá nhập gần nhất ghi trên phiếu (nếu có), dùng thay giá vốn Pancake khi Pancake = 0 */
export const LAST_RECEIPT_COST = sql<number>`(select ri2.unit_cost from stock_receipt_items ri2 join stock_receipts r2 on r2.id = ri2.receipt_id where ri2.variant_id = ${pv.id} and ri2.unit_cost > 0 and r2.kind = 'RECEIPT' order by r2.received_at desc, r2.created_at desc limit 1)`;

/**
 * CÙNG MỘT CON SỐ với `LAST_RECEIPT_COST`, nhưng tính MỘT LẦN CHO MỖI MẪU MÃ thay vì một lần cho
 * mỗi dòng đọc nó.
 *
 * BẰNG CHỨNG (EXPLAIN ANALYZE, bộ dữ liệu 12.894 đơn — xem docs/erp-performance-p0-report.md):
 * dùng ở cấp DÒNG ĐƠN HÀNG, truy vấn con tương quan này chạy 4.260 lần, mỗi lần 4,8 ms, ngốn
 * 10.350.750 khối đệm — 99,3% toàn bộ chi phí của truy vấn "Hiệu quả mẫu mã". Bộ tối ưu chọn quét
 * từ phía PHIẾU KHO nên vòng lặp trong chạy 2.556.000 lượt (600 phiếu × 4.260 dòng): chi phí tăng
 * theo TÍCH của số dòng đơn và số phiếu kho.
 *
 * `distinct on (variant_id)` quét bảng phiếu đúng MỘT LẦN rồi để các truy vấn nối vào. Thứ tự sắp
 * xếp và bộ lọc giữ y nguyên (`unit_cost > 0`, `kind = 'RECEIPT'`, mới nhất trước) nên giá trị
 * từng mẫu mã không đổi một đồng — khoá bằng tests/metric-shape-consistency.test.ts.
 *
 * Nối vào bằng `pv.id` (KHÔNG phải `order_items.variant_id`): mẫu mã đã bị xoá khỏi ERP thì
 * `LAST_RECEIPT_COST` trả NULL, và bản nối phải trả NULL y hệt.
 */
export function variantLastCostSubquery(db: Db) {
  return db
    .selectDistinctOn([ri.variantId], { variantId: ri.variantId, lastCost: ri.unitCost })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .where(sql`${ri.unitCost} > 0 and ${r.kind} = 'RECEIPT'`)
    .orderBy(ri.variantId, desc(r.receivedAt), desc(r.createdAt))
    .as("vlastcost");
}

export type VariantLastCost = ReturnType<typeof variantLastCostSubquery>;

export type StockAggregates = ReturnType<typeof variantSalesSubquery>;
export type ReceiptAggregates = ReturnType<typeof variantReceiptsSubquery>;

/**
 * Tồn ERP có ĐÁNG TIN hay không: chỉ khi mẫu mã đã có ít nhất một PHIẾU NHẬP HÀNG.
 * Chưa có phiếu nhập nào thì "nhập = 0" là THIẾU DỮ LIỆU, không phải "nhập 0 cái";
 * lấy 0 trừ đi số đã xuất sẽ ra tồn âm bịa ra và đẩy kế hoạch sản xuất đặt thừa.
 * Những mẫu mã này phải hiển thị "Chưa có phiếu nhập", không hiển thị số.
 */
export function stockKnownExpr(receipts: ReceiptAggregates) {
  return sql<boolean>`coalesce(${receipts.receiptDocs}, 0) > 0`;
}

/**
 * TỒN THỰC TẾ = tổng phiếu kho (nhập mới + tái nhập + điều chỉnh − xuất tay) − đã xuất qua ĐVVC.
 * Hàng hoàn chỉ quay lại tồn khi kho lập PHIẾU TÁI NHẬP với số đếm thực tế.
 */
export function erpStockExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`coalesce(${receipts.received}, 0) - coalesce(${sales.shipped}, 0)`;
}

/** TỒN KHẢ DỤNG để bán = tồn thực tế − hàng đã chốt đơn còn nằm trong kho chờ xuất. */
export function availableStockExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`coalesce(${receipts.received}, 0) - coalesce(${sales.shipped}, 0) - coalesce(${sales.reserved}, 0)`;
}

/** Hàng hoàn đã lập phiếu nhưng đếm thiếu so với số đã xuất = hàng hụt / hỏng không nhập lại được. */
export function stockShrinkageExpr(sales: StockAggregates, receipts: ReceiptAggregates) {
  return sql<number>`greatest(coalesce(${sales.returnHandled}, 0) - coalesce(${receipts.returnIn}, 0), 0)`;
}

export type VariantPickerRow = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  image: string | null;
  currentStock: number;
  lastCost: number;
  retailPrice: number;
  selling: boolean;
};

/** Danh sách mẫu mã để chọn khi lập phiếu (kèm tồn ERP hiện tại và giá nhập gần nhất) */
export async function listVariantsForReceipt(): Promise<VariantPickerRow[]> {
  const db = await getDb();
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const rows = await db
    .select({
      id: pv.id,
      productId: pv.productId,
      productName: p.name,
      sku: pv.sku,
      color: pv.color,
      size: pv.size,
      images: pv.images,
      productImage: p.image,
      currentStock: erpStockExpr(sales, receipts),
      lastCost: sql<number>`coalesce(${LAST_RECEIPT_COST}, ${pv.lastImportedPrice}, 0)`,
      retailPrice: pv.retailPrice,
      selling: sql<boolean>`(${pv.isRemoved} = false and ${pv.isHidden} = false and ${p.isRemoved} = false)`,
    })
    .from(pv)
    .innerJoin(p, eq(pv.productId, p.id))
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(eq(pv.isRemoved, false))
    .orderBy(asc(p.name), asc(pv.sku), asc(pv.color), asc(pv.size))
    .limit(3000);
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productName: r.productName,
    sku: r.sku,
    color: r.color,
    size: r.size,
    image: r.images?.[0] || r.productImage || null,
    currentStock: Number(r.currentStock ?? 0),
    lastCost: Number(r.lastCost ?? 0),
    retailPrice: Number(r.retailPrice ?? 0),
    selling: Boolean(r.selling),
  }));
}

export async function listStockReceipts(limit = 100) {
  const db = await getDb();
  return db.query.stockReceipts.findMany({
    orderBy: [desc(schema.stockReceipts.receivedAt), desc(schema.stockReceipts.createdAt)],
    limit,
    with: {
      items: { with: { variant: { columns: { id: true, sku: true, color: true, size: true }, with: { product: { columns: { name: true } } } } } },
      // Company OS · Agent D (0133): phiếu nhập nối về lệnh SX / lô xưởng — NULL = chưa khai.
      productionOrder: { columns: { id: true, code: true } },
      productionBatch: { columns: { id: true, productCode: true, batchNo: true } },
    },
  });
}

export type ProductionLinkOption = {
  kind: "ORDER" | "BATCH";
  id: string;
  label: string;
  /** Ảnh chụp tên xưởng — để lọc theo ô "Nhà cung cấp" trên form. */
  supplier: string;
};

/**
 * Lệnh sản xuất ĐÃ GỬI XƯỞNG và lô xưởng ĐANG MỞ — ứng viên cho ô "Hàng của lệnh / lô" trên phiếu
 * nhập. Cùng định nghĩa "đang mở" với `openPoQtyByVariant` (lệnh `SENT`, lô `OPEN`).
 */
export async function listOpenProductionLinks(): Promise<ProductionLinkOption[]> {
  const db = await getDb();
  const po = schema.productionOrders;
  const { openBatchLinkOptions } = await import("@/lib/queries/workshop-ledger");
  const [orders, batches] = await Promise.all([
    db.select({ id: po.id, code: po.code, productName: po.productName, productCode: po.productCode, supplier: po.supplier, totalQty: po.totalQty }).from(po).where(eq(po.status, "SENT")).orderBy(desc(po.createdAt)).limit(300),
    // Bảng lô thuộc sổ đặt xưởng — chỉ đọc qua hàm của sổ (tests/workshop-ledger.test.ts).
    openBatchLinkOptions(300),
  ]);
  return [
    ...orders.map((o) => ({ kind: "ORDER" as const, id: o.id, label: `Lệnh ${o.code} · ${o.productCode || o.productName} · ${o.totalQty} cái`, supplier: o.supplier })),
    ...batches.map((b) => ({ kind: "BATCH" as const, id: b.id, label: `Lô ${b.productCode} #${b.batchNo} · ${b.orderedQty} cái`, supplier: b.supplier })),
  ];
}

export type StockReceiptRow = Awaited<ReturnType<typeof listStockReceipts>>[number];

export async function stockReceiptSummary() {
  const db = await getDb();
  const [row] = await db
    .select({
      receipts: sql<number>`count(*) filter (where ${schema.stockReceipts.kind} = 'RECEIPT')`,
      adjustments: sql<number>`count(*) filter (where ${schema.stockReceipts.kind} = 'ADJUSTMENT')`,
      received: sql<number>`coalesce(sum(${schema.stockReceipts.totalQuantity}) filter (where ${schema.stockReceipts.kind} = 'RECEIPT'), 0)`,
      adjusted: sql<number>`coalesce(sum(${schema.stockReceipts.totalQuantity}) filter (where ${schema.stockReceipts.kind} = 'ADJUSTMENT'), 0)`,
      cost: sql<number>`coalesce(sum(${schema.stockReceipts.totalCost}), 0)`,
      lastAt: sql<string | null>`max(${schema.stockReceipts.receivedAt})`,
    })
    .from(schema.stockReceipts);
  return { receipts: Number(row?.receipts ?? 0), adjustments: Number(row?.adjustments ?? 0), received: Number(row?.received ?? 0), adjusted: Number(row?.adjusted ?? 0), cost: Number(row?.cost ?? 0), lastAt: row?.lastAt ? new Date(row.lastAt) : null };
}

/**
 * TỔNG HỢP NĂM TRẠNG THÁI CỦA HÀNG + RỦI RO HẾT HÀNG.
 *
 * Dùng cho Tổng quan để thay ngưỡng cứng `tồn <= 5`: mẫu mã bán 20 cái/ngày còn 8 cái là sắp
 * cháy hàng, mẫu mã bán 1 cái/tháng còn 3 cái thì vẫn dư. Rủi ro tính theo `days of cover` so với
 * thời gian sản xuất — cùng một bộ máy với trang Kế hoạch SX và cảnh báo vận hành, nên ba nơi
 * không thể ra ba con số khác nhau.
 */
export async function stockRiskSummary() {
  const { getReplenishmentPlan } = await import("@/lib/queries/planning");
  const [plan, db] = await Promise.all([getReplenishmentPlan(), getDb()]);
  const salesAgg = variantSalesSubquery(db);
  const receiptsAgg = variantReceiptsSubquery(db);
  // HÀNG HỤT: đã lập phiếu tái nhập nhưng đếm được ít hơn số đã xuất — hỏng, mất, hoặc không
  // bán lại được. Đây là số ĐO ĐƯỢC từ chênh lệch phiếu, không phải ước lượng.
  // Cùng dạng truy vấn với `vsales`, cùng bệnh JIT: 8.578ms → 26ms khi tắt. Xem `chayKhongJit`.
  const [shrink] = await chayKhongJit(db, (tx) =>
    tx
      .select({ n: sql<number>`coalesce(sum(${stockShrinkageExpr(salesAgg, receiptsAgg)}), 0)` })
      .from(pv)
      .leftJoin(salesAgg, eq(salesAgg.variantId, pv.id))
      .leftJoin(receiptsAgg, eq(receiptsAgg.variantId, pv.id)),
  );
  const rows = plan.rows;
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const signed = splitSignedStock(rows.map((r) => ({ stockKnown: r.stockKnown, stock: r.stock, available: r.available })));
  return {
    states: {
      /*
        CHỈ CỘNG DÒNG DƯƠNG (Company OS · Agent D). Trước đây tổng này cộng CẢ dòng âm, nên một mẫu
        âm sổ −30 lặng lẽ xoá 30 món có thật của mẫu khác và con số trên trang chủ trông "vừa phải".
        Tồn âm là SAI LỆCH CẦN KIỂM (thiếu phiếu nhập, xuất hai lần…), không phải kho đang nợ hàng —
        nên nó đứng riêng ở `negativeRows` / `negativeQty`. Mẫu chưa có phiếu nhập vẫn là CHƯA BIẾT,
        không vào tổng, không vào số âm.
      */
      ON_HAND: signed.onHandPositive,
      RESERVED: sum((r) => r.committed),
      AVAILABLE: signed.availablePositive,
      INBOUND: plan.summary.incomingUnits,
      UNSELLABLE: Number(shrink?.n ?? 0),
    },
    /** Mẫu mã hết hàng hoặc sẽ hết TRƯỚC khi lô mới về — việc phải xử lý ngay. */
    atRisk: plan.summary.out + plan.summary.critical,
    out: plan.summary.out,
    critical: plan.summary.critical,
    low: plan.summary.low,
    /** Mẫu mã chưa có phiếu nhập nào ⇒ tồn là CHƯA BIẾT, không phải 0 — không được đếm là hết hàng. */
    unknown: plan.summary.unknown,
    suggestedUnits: plan.summary.suggestedUnits,
    orderCost: plan.summary.orderCost,
    /** Mẫu mã ÂM SỔ (tồn thực tế < 0, đã biết tồn) — cần kiểm, KHÔNG cộng vào ON_HAND. */
    negativeRows: signed.negativeRows,
    /** Tổng phần âm (số dương, món) của các mẫu âm sổ. */
    negativeQty: signed.negativeQty,
    /** Mẫu mã khả dụng < 0 (đã chốt nhiều hơn tồn) — đơn chờ hàng, xem /inventory/shortage. */
    oversoldRows: signed.oversoldRows,
    oversoldQty: signed.oversoldQty,
  };
}

export type SignedStockRow = { stockKnown: boolean; stock: number; available: number };

/**
 * Tách tồn có dấu thành tổng DƯƠNG + phần ÂM đếm riêng. Hàm THUẦN (kiểm thử được không cần CSDL).
 *
 * Luật: mẫu CHƯA BIẾT tồn (`stockKnown = false`) không vào vế nào — chưa biết không phải 0, cũng
 * không phải âm. `max(khả dụng, 0) ≤ max(tồn, 0)` vì khả dụng ≤ tồn, nên bất biến "khả dụng không
 * lớn hơn tồn thực tế" vẫn giữ trên hai tổng.
 */
export function splitSignedStock(rows: readonly SignedStockRow[]) {
  let onHandPositive = 0;
  let availablePositive = 0;
  let negativeRows = 0;
  let negativeQty = 0;
  let oversoldRows = 0;
  let oversoldQty = 0;
  for (const r of rows) {
    if (!r.stockKnown) continue;
    const stock = Number(r.stock);
    const available = Number(r.available);
    if (stock > 0) onHandPositive += stock;
    else if (stock < 0) {
      negativeRows += 1;
      negativeQty += -stock;
    }
    if (available > 0) availablePositive += available;
    else if (available < 0) {
      oversoldRows += 1;
      oversoldQty += -available;
    }
  }
  return { onHandPositive, availablePositive, negativeRows, negativeQty, oversoldRows, oversoldQty };
}

export type StockRiskSummary = Awaited<ReturnType<typeof stockRiskSummary>>;

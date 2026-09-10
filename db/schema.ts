// VNXcommerce ERP — Drizzle schema (PostgreSQL)
// Tiền tệ: VND, lưu dạng integer. Thời gian: timestamptz (UTC).
import { relations, sql } from "drizzle-orm";
import { boolean, check, doublePrecision, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, bigint } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const ts = (name: string) => timestamp(name, { withTimezone: true });
const money = (name: string) => integer(name).notNull().default(0);

// ───────────────────────── Enums ─────────────────────────

export const roleEnum = pgEnum("role", ["ADMIN", "MANAGER", "LEADER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"]);
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
    /**
     * AI ĐÓNG VIỆC NÀY — `NULL` nghĩa là HỆ THỐNG tự đóng, không phải người.
     *
     * Vì sao phải tách: trước đây cả hai đường đều chỉ ghi `resolved_at`, nên "điều kiện tự hết"
     * và "có người ngồi làm xong" trông y hệt nhau. Production 09/09/2026 có 3.896 việc đã đóng mà
     * không ai trả lời được bao nhiêu trong đó là công của đội. Lấy con số đó đo năng suất là đo
     * nhầm.
     */
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * VÌ SAO ĐÓNG:
     *  · `MANUAL` — người bấm đóng, đã làm xong.
     *  · `AUTO`   — điều kiện phát hiện không còn (đơn đã giao, hàng đã về, tiền đã về).
     *  · `STALE`  — loại cảnh báo này bị tắt nên việc cũ không còn ai theo dõi. KHÔNG phải đã xử lý.
     *  · `UNKNOWN`— việc đã đóng TRƯỚC khi có cột này (3.896 dòng lịch sử). Không suy đoán ngược:
     *               chưa biết ai đóng thì ghi là chưa biết, không gán bừa cho hệ thống hay cho người.
     */
    resolution: text("resolution"),
    /** Đã gửi Telegram lúc */
    notifiedAt: ts("notified_at"),
    /** Thời điểm cập nhật gần nhất của đối tượng (trạng thái vận đơn, đơn, case…) lúc tạo cảnh báo */
    occurredAt: ts("occurred_at"),
    /**
     * HÀNG ĐỢI VIỆC: ai đang cầm việc này. Không có người nhận thì việc trôi — đó là lý do
     * "Cần xử lý" cũ chỉ là danh sách đọc rồi bỏ.
     */
    assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedAt: ts("assigned_at"),
    /** ĐÃ TIẾP NHẬN: có người nhìn thấy và nhận xử lý — khác "đã đọc" và khác "đã xong". */
    acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: ts("acknowledged_at"),
    /** ĐANG LÀM: đã bắt tay vào việc. Khác "đã tiếp nhận" — giơ tay không phải là đang chạy. */
    startedAt: ts("started_at"),
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * BỎ QUA: đã xem và quyết định KHÔNG làm. Bắt buộc kèm lý do (ràng buộc CHECK ở migration
     * 0037) — gạt một việc đi mà không nói vì sao là xoá bằng chứng lặng lẽ.
     */
    ignoredAt: ts("ignored_at"),
    ignoredBy: text("ignored_by").references(() => users.id, { onDelete: "set null" }),
    ignoredReason: text("ignored_reason").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_open_idx").on(t.resolvedAt, t.createdAt),
    index("notifications_kind_idx").on(t.kind),
    index("notifications_assigned_idx").on(t.assignedTo, t.resolvedAt),
    index("notifications_workflow_idx").on(t.resolvedAt, t.ignoredAt, t.startedAt),
    check("notifications_resolution_check", sql`${t.resolution} IS NULL OR ${t.resolution} IN ('MANUAL', 'AUTO', 'STALE', 'UNKNOWN')`),
    // Đã đóng thì phải nói được VÌ SAO đóng; và chỉ đóng tay mới có người đóng.
    check("notifications_resolution_shape_check", sql`(${t.resolvedAt} IS NULL) = (${t.resolution} IS NULL)`),
    check("notifications_resolver_check", sql`${t.resolvedBy} IS NULL OR ${t.resolution} = 'MANUAL'`),
  ],
);

/**
 * ───────────── KẾT QUẢ ĐƠN ĐÃ VẬT CHẤT HOÁ ─────────────
 *
 * Đây là LỚP TĂNG TỐC, KHÔNG phải nguồn sự thật. Nguồn sự thật vẫn là biểu thức `ORDER_OUTCOME`
 * trong `lib/queries/return-rate.ts`; bảng này chỉ lưu lại kết quả của chính biểu thức đó để báo cáo
 * khỏi tính lại.
 *
 * VÌ SAO CẦN: đo trên production 09/09/2026 — `ORDER_OUTCOME` là một biểu thức CASE chứa nhiều truy
 * vấn con tương quan, tốn ~2,4ms cho mỗi đơn. Với 2.426 đơn, MỖI báo cáo phải trả ~6 giây chỉ để
 * dựng lại cùng một kết luận; trang chủ vì thế mất 30–47 giây. Rào `OUTCOME_FENCE` đã hạ số lần tính
 * từ "mỗi cột một lần" xuống "mỗi dòng một lần" — đây là bước tiếp theo: mỗi đơn một lần, và chỉ
 * tính lại khi đầu vào đổi.
 *
 * GRAIN LÀ (ĐƠN × VẬN ĐƠN), CỐ Ý:
 * mọi báo cáo hiện nay đều `orders LEFT JOIN shipments` rồi tính kết quả cho TỪNG dòng. Vật chất hoá
 * ở grain khác sẽ đổi con số (một đơn hai vận đơn đang được đếm hai lần). Muốn đổi grain thì phải là
 * một quyết định nghiệp vụ riêng, không phải hệ quả phụ của việc tăng tốc.
 *
 * `logic_version` để khi luật đổi thì phát hiện được dòng cũ và dựng lại có kiểm soát, thay vì trộn
 * lẫn hai ngữ nghĩa mà không ai biết.
 */
export const canonicalOrderOutcome = pgTable(
  "canonical_order_outcome",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** `NULL` = đơn chưa có vận đơn nào. Đúng dòng mà `LEFT JOIN` sinh ra. */
    shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "cascade" }),
    /** Kết quả do chính `ORDER_OUTCOME` sinh ra — chép lại, không diễn giải. */
    outcome: text("outcome").notNull(),
    /**
     * Giá vốn cả đơn, do chính `ORDER_COGS` sinh ra.
     *
     * Đo trên production sau khi vật chất hoá kết quả đơn: đọc kết quả đã tính sẵn cho toàn bộ 2.431
     * dòng chỉ mất **48ms**, nhưng báo cáo vẫn mất 5–10 giây. Thủ phạm còn lại là `ORDER_COGS` — một
     * truy vấn con LỒNG HAI TẦNG: mỗi đơn duyệt từng dòng hàng, mỗi dòng hàng lại tra ngược phiếu
     * nhập gần nhất. Cùng một bệnh, cùng một cách chữa, và ở cùng một bảng để chỉ có MỘT nơi phải
     * dựng lại và MỘT phép đối chiếu.
     */
    cogs: money("cogs"),
    /**
     * ───────────── GIÁ VỐN ĐÃ CHỐT CHO KỲ ĐÃ GHI NHẬN ─────────────
     *
     * Ghi MỘT LẦN lúc đơn được ghi nhận là giao thành công, rồi **không đổi nữa**. Đây là thứ chặn
     * việc lợi nhuận kỳ đã chốt tự đổi khi kho nhập lô mới — chuyện đang xảy ra vì `ORDER_COGS` lấy
     * "phiếu nhập gần nhất tính theo hôm nay".
     *
     * `NULL` = đơn chưa được ghi nhận giao thành công. Không phải 0.
     */
    recognizedCogs: integer("recognized_cogs"),
    /** Mốc ghi nhận doanh thu (ngày giao). `NULL` khi chưa giao. */
    recognizedAt: ts("recognized_at"),
    /**
     * CĂN CỨ của giá vốn đã chốt — và đây là chỗ phải nói thật:
     *
     *  · `RECEIPT_BEFORE` — có phiếu nhập TRƯỚC ngày giao. Căn cứ vững.
     *  · `RECEIPT_AFTER`  — giá vốn suy ngược từ phiếu lập SAU ngày giao. **CHƯA XÁC MINH.**
     *  · `NONE`           — không có nguồn giá vốn nào. Đang là 0 nhưng nghĩa thật là CHƯA BIẾT.
     *
     * Đo trên production 09/09/2026: shop chỉ có 2 phiếu nhập, cả hai ngày 03/09, trong khi đơn giao
     * sớm nhất từ 22/01; 0/2.495 dòng hàng có giá vốn Pancake, 0/37 mẫu mã có giá nhập. Nên
     * **368/407 đơn đã giao mang căn cứ `RECEIPT_AFTER`** — 58 triệu giá vốn suy ngược. Con số đó
     * phải HIỆN RA, không được lẫn vào lợi nhuận như thể đã kiểm chứng.
     */
    cogsBasis: text("cogs_basis"),
    /** Phiên bản luật đã dùng để tính dòng này. Luật đổi ⇒ dòng cũ thành cũ, phát hiện được. */
    logicVersion: integer("logic_version").notNull().default(1),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [
    index("canonical_outcome_order_idx").on(t.orderId),
    index("canonical_outcome_value_idx").on(t.outcome),
    index("canonical_outcome_version_idx").on(t.logicVersion),
  ],
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

export const approvalStatusEnum = pgEnum("approval_status", ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "EXECUTED"]);

/**
 * ───────────── YÊU CẦU PHÊ DUYỆT HAI BƯỚC ─────────────
 *
 * Việc rủi ro không được thực hiện ngay: nó thành một YÊU CẦU, và chỉ chạy khi có người khác gật.
 * Danh sách nhóm nào cần duyệt nằm ở `lib/constants/approval.ts`, không nằm rải rác trong từng trang.
 *
 * Bảng này là SỔ, không phải hàng đợi tạm: yêu cầu bị từ chối vẫn nằm lại. Ai xin làm gì, ai không
 * cho, lúc nào — đó chính là thứ có giá trị khi cần nhìn lại, và xoá đi là mất sạch.
 *
 * `payload` giữ nguyên đầu vào đã được kiểm tra, để lúc duyệt chạy ĐÚNG việc đã xin — không phải một
 * việc khác được sửa lại trong lúc chờ.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    /** Nhóm việc (`ApprovalGroup`) — quyết định luật áp dụng. */
    group: text("group").notNull(),
    /** Thao tác cụ thể, ví dụ "stock.adjustment" — để chạy lại đúng hàm khi được duyệt. */
    action: text("action").notNull(),
    entity: text("entity").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    /** Số tiền liên quan, dùng để đối chiếu ngưỡng. NULL = chưa biết, và chưa biết thì coi như vượt. */
    amount: bigint("amount", { mode: "number" }),
    /** Mô tả bằng tiếng Việt để người duyệt hiểu mình đang gật cái gì mà không phải đọc JSON. */
    summary: text("summary").notNull(),
    payload: jsonb("payload"),
    status: approvalStatusEnum("status").notNull().default("PENDING"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    requestedByEmail: text("requested_by_email").notNull().default(""),
    // Khai tường minh, KHÔNG dùng helper createdAt(): helper gắn cứng tên cột "created_at", còn
    // migration khai "requested_at" — lệch tên là mọi phép chèn hỏng ngay ở câu lệnh đầu tiên.
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** NGƯỜI DUYỆT PHẢI KHÁC NGƯỜI XIN — cưỡng chế ở tầng ứng dụng và ở đây. */
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedByEmail: text("decided_by_email"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Lý do từ chối, hoặc ghi chú khi duyệt. */
    note: text("note"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionError: text("execution_error"),
  },
  (t) => [
    index("approval_status_idx").on(t.status, t.requestedAt),
    index("approval_group_idx").on(t.group, t.status),
    // Người xin không được tự duyệt. Ứng dụng đã chặn; đây là hàng rào cuối, vì hàng rào ở tầng
    // ứng dụng có thể bị một đường ghi mới nào đó đi vòng qua.
    check("approval_khac_nguoi", sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
  ],
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
    /**
     * ───────────── ĐỊNH DANH QUY KẾT THÔ, GIỮ NGUYÊN NHƯ NGUỒN GỬI ─────────────
     *
     * Đo trên production 09/09/2026: Pancake gửi `p_utm_campaign`, `p_utm_source` và
     * `customer_referral_code` trên **mọi đơn** (2.425/2.425) nhưng cả ba **đều rỗng** — vì hiện
     * chưa có gì gắn mã theo dõi vào liên kết quảng cáo. Ngày shop bắt đầu gắn, dữ liệu sẽ chảy về
     * qua đúng ba trường này.
     *
     * Nên ERP giữ chúng NGAY TỪ BÂY GIỜ, thô, không diễn giải. Không có cột thì ngày đó dữ liệu
     * chảy qua rồi mất, và độ phủ quy kết vẫn nằm ở trần cũ mà không ai hiểu vì sao.
     *
     * KHÔNG suy diễn: rỗng là rỗng, không bịa từ trường khác.
     */
    utmCampaign: text("utm_campaign"),
    utmSource: text("utm_source"),
    referralCode: text("referral_code"),
    /** Mốc nguồn ghi nhận quy kết (nếu nguồn có gửi) — khác thời điểm ERP đọc được. */
    attributionCapturedAt: ts("attribution_captured_at"),
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

/**
 * Ý TƯỞNG MARKETING — bảng ý tưởng để marketer đăng bài mẫu và nhận nhận xét của quản lý.
 *
 * Mỗi dòng là một ý tưởng: ai phụ trách, ngày, nội dung, ảnh minh hoạ và quá trình trao đổi với
 * quản lý. Cố ý KHÔNG dính gì tới đơn hàng / tiền — đây là chỗ làm việc của đội marketing, không
 * phải một chiều báo cáo, nên không được lẫn vào các con số nghiệp vụ.
 */
export const ideaStatusEnum = pgEnum("idea_status", ["NEW", "REVIEWING", "CHANGES", "APPROVED", "REJECTED"]);

export const marketingIdeas = pgTable(
  "marketing_ideas",
  {
    id: id(),
    /** Marketer phụ trách — id nhân sự trong cấu hình lương (có thể trống nếu nhập tay). */
    marketerId: text("marketer_id"),
    /** Tên marketer hiển thị; giữ lại tên tại thời điểm đăng để đổi cấu hình nhân sự không mất dấu. */
    marketerName: text("marketer_name").notNull().default(""),
    /** Ngày của ý tưởng (YYYY-MM-DD) — do người đăng chọn, không phải giờ hệ thống. */
    ideaDate: text("idea_date").notNull(),
    /** Nội dung ý tưởng; dòng đầu được dùng làm tiêu đề khi hiển thị danh sách. */
    content: text("content").notNull().default(""),
    status: ideaStatusEnum("status").notNull().default("NEW"),
    createdBy: text("created_by").notNull().default(""),
    createdByName: text("created_by_name").notNull().default(""),
    /** Lần quản lý chốt trạng thái gần nhất. */
    reviewedAt: ts("reviewed_at"),
    reviewedBy: text("reviewed_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("marketing_ideas_date_idx").on(t.ideaDate), index("marketing_ideas_status_idx").on(t.status), index("marketing_ideas_marketer_idx").on(t.marketerId)],
);

/**
 * Ảnh của ý tưởng, lưu thẳng trong CSDL.
 *
 * Máy chủ chỉ có ổ đĩa của CSDL là bền qua mỗi lần deploy nên ảnh nằm ở đây thay vì trên đĩa ứng
 * dụng. Ảnh được thu nhỏ ngay trên trình duyệt trước khi gửi lên, và để BẢNG RIÊNG để truy vấn
 * danh sách ý tưởng không bao giờ phải kéo theo dữ liệu ảnh.
 */
export const marketingIdeaImages = pgTable(
  "marketing_idea_images",
  {
    id: id(),
    ideaId: text("idea_id")
      .notNull()
      .references(() => marketingIdeas.id, { onDelete: "cascade" }),
    contentType: text("content_type").notNull().default("image/jpeg"),
    bytes: integer("bytes").notNull().default(0),
    /** Nội dung ảnh dạng base64. */
    data: text("data").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("marketing_idea_images_idea_idx").on(t.ideaId, t.sortOrder)],
);

/** Trao đổi giữa marketer và quản lý về một ý tưởng; giữ nguyên cả quá trình, không ghi đè. */
export const marketingIdeaComments = pgTable(
  "marketing_idea_comments",
  {
    id: id(),
    ideaId: text("idea_id")
      .notNull()
      .references(() => marketingIdeas.id, { onDelete: "cascade" }),
    authorEmail: text("author_email").notNull().default(""),
    authorName: text("author_name").notNull().default(""),
    body: text("body").notNull(),
    /** Trạng thái mà nhận xét này đặt (nếu có) — để đọc lại vì sao ý tưởng đổi trạng thái. */
    statusSet: ideaStatusEnum("status_set"),
    createdAt: createdAt(),
  },
  (t) => [index("marketing_idea_comments_idea_idx").on(t.ideaId, t.createdAt)],
);

export const marketingIdeasRelations = relations(marketingIdeas, ({ many }) => ({
  images: many(marketingIdeaImages),
  comments: many(marketingIdeaComments),
}));

/**
 * TỆP BẢNG KÊ GỐC — giữ nguyên nội dung tệp Viettel Post gửi qua email.
 *
 * Vì sao cần: Apps Script trong Gmail chỉ gửi thư CHƯA gắn nhãn "đã nhập", nên khi ERP đọc sai
 * một lần thì muốn đọc lại phải vào Gmail gỡ nhãn thủ công — ERP không tự chữa được. Giữ lại tệp
 * gốc ở đây thì mọi lần sửa cách đọc chỉ cần chạy lại trên dữ liệu đã có, không phải xin lại thư.
 *
 * Nội dung lưu dạng base64 đúng như lúc nhận; tệp trùng tên ghi đè bằng bản mới nhất.
 */
export const vtpStatementFiles = pgTable(
  "vtp_statement_files",
  {
    id: id(),
    filename: text("filename").notNull(),
    /** Nội dung tệp, base64 — nguyên vẹn như lúc Apps Script gửi sang. */
    content: text("content").notNull(),
    bytes: integer("bytes").notNull().default(0),
    /** ORDER_LIST | STATEMENT_DETAIL | ERROR — loại ERP nhận ra khi nhập. */
    kind: text("kind").notNull().default(""),
    /** Danh tính bảng kê (xem `codStatementLines.statementKey`) — hai tệp cùng khoá là cùng một bảng kê. */
    statementKey: text("statement_key").notNull().default(""),
    /** Ai/luồng nào đưa tệp vào (GMAIL:… hoặc email người bấm nhập tay). */
    actor: text("actor").notNull().default(""),
    rows: integer("rows").notNull().default(0),
    receivedAt: createdAt(),
    lastImportedAt: ts("last_imported_at"),
  },
  (t) => [uniqueIndex("vtp_statement_files_name_uq").on(t.filename), index("vtp_statement_files_received_idx").on(t.receivedAt)],
);

/**
 * SỔ CHI TIẾT BẢNG KÊ — mỗi dòng của mỗi file bảng kê Viettel Post được giữ nguyên ở đây.
 *
 * Vì sao cần: trước đây tiền thực thu được ghi thẳng lên `shipments` theo từng file, không có
 * thứ tự nào bảo vệ. Cùng một vận đơn xuất hiện ở nhiều bảng kê (chiều đi có tiền, chiều hoàn chỉ
 * có cước) nên file nhập SAU — mà luồng email lại xử lý từ thư mới về thư cũ — ghi đè mất số của
 * file mới hơn: 334 vận đơn giao thành công bị đưa tiền về 0 và gần 80 triệu biến mất khỏi đối soát.
 *
 * Sổ này là chứng từ, không bị ghi đè: một dòng cho mỗi (file, mã vận đơn). Số trên `shipments`
 * chỉ là kết quả DỰNG LẠI từ sổ, nên nhập lại bao nhiêu lần, theo thứ tự nào cũng ra một kết quả.
 */
export const codStatementLines = pgTable(
  "cod_statement_lines",
  {
    id: id(),
    /**
     * DANH TÍNH BẢNG KÊ — khoá chống trùng thật sự, KHÔNG dùng tên file.
     *
     * Cùng một bảng kê tải tay từ web Viettel Post và nhận qua email có tên file khác nhau; khoá
     * theo tên file thì hai bản đó thành hai chứng từ và tiền bị cộng hai lần. Khoá là "BK-<ngày
     * chốt>" lấy từ phần KẾT LUẬN ĐỐI SOÁT in trong tệp, hoặc vân tay nội dung khi tệp không có
     * phần đó — cả hai đều không đổi theo tên file.
     */
    statementKey: text("statement_key").notNull(),
    /** Tên file bảng kê — chỉ để truy nguyên, không dùng làm khoá. */
    sourceFile: text("source_file").notNull(),
    batchId: text("batch_id").references(() => codBatches.id, { onDelete: "set null" }),
    /** Mã vận đơn ghi trên bảng kê (đã viết hoa). */
    trackingCode: text("tracking_code").notNull(),
    /** Tiền COD ĐVVC báo đã thu cho dòng này. */
    cod: money("cod"),
    /** Cước / dư nợ trừ trên dòng này. */
    fee: money("fee"),
    /** Thực nhận của dòng = COD − cước. */
    net: money("net"),
    /**
     * Dòng này có nói về COD của vận đơn không. Dòng chỉ liệt kê cước (thường là chiều hoàn)
     * KHÔNG phải bằng chứng "thu được 0 đồng" nên không được hạ số đã có về 0.
     */
    codReported: boolean("cod_reported").notNull().default(true),
    /** Ngày phát thành công / ngày ghi trên bảng kê. */
    paidDate: text("paid_date"),
    /** Mốc chứng từ của cả file — dùng để chọn dòng mới nhất khi một vận đơn có nhiều dòng. */
    statementAt: ts("statement_at").notNull(),
    statusText: text("status_text").notNull().default(""),
    /** Vận đơn ghép được trong ERP; null = bảng kê có dòng này mà ERP chưa có vận đơn. */
    shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cod_statement_lines_key_code_uq").on(t.statementKey, t.trackingCode),
    index("cod_statement_lines_file_idx").on(t.sourceFile),
    index("cod_statement_lines_shipment_idx").on(t.shipmentId),
    index("cod_statement_lines_batch_idx").on(t.batchId),
    index("cod_statement_lines_code_idx").on(t.trackingCode),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: id(),
    /**
     * MỘT ĐƠN CÓ THỂ CÓ NHIỀU LẦN GỬI.
     *
     * Trước 10/09/2026 cột này mang ràng buộc `UNIQUE` từ migration 0000, ép một đơn chỉ có một vận
     * đơn. Cái giá không nhìn thấy: khi Pancake báo một mã vận đơn MỚI cho đơn đã có vận đơn, đường
     * đồng bộ **ghi đè lên dòng cũ** — lần gửi đầu tiên biến mất khỏi sổ, không cảnh báo. Giao thất
     * bại rồi gửi lại, huỷ rồi tạo lại, gửi hàng thay thế: cả ba đều mất dấu.
     *
     * Bỏ ràng buộc đó đi kèm một nghĩa vụ: **mọi đường tính TIỀN phải chuyển sang grain ĐƠN**. Báo
     * cáo nối đơn với vận đơn rồi cộng trên từng dòng sẽ đếm đơn hai lần ngay lần gửi lại đầu tiên —
     * và đếm sai trong im lặng. Hai việc đó cố ý đi cùng một lần phát hành.
     */
    orderId: text("order_id").references(() => orders.id, { onDelete: "cascade" }),
    /** Lần gửi thứ mấy của đơn. 1 = lần đầu. Vận đơn không gắn đơn để `NULL`. */
    attemptNo: integer("attempt_no"),
    /**
     * CHIỀU của lần gửi:
     *  · `OUTBOUND`    — gửi tới khách;
     *  · `RETURN`      — chiều hoàn về shop;
     *  · `REPLACEMENT` — gửi hàng thay thế sau đổi/lỗi.
     *
     * Chiều KHÔNG được suy từ trạng thái: "phát thành công" của chiều hoàn nghĩa là hàng về tới
     * shop, không phải tới tay khách. Nhầm chỗ này là thổi tỷ lệ giao thành công.
     */
    direction: text("direction"),
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
    /**
     * CHỨNG TỪ GỐC: vận đơn này có mặt trên file chi tiết bảng kê tải từ Viettel Post.
     * Đây mới là bằng chứng tiền, độc lập với việc đã ghép được vào "đợt tiền về" hay chưa —
     * đợt là số tổng do shop nhập tay, còn file chi tiết là chứng từ thật của ĐVVC.
     */
    codStatementRef: text("cod_statement_ref"),
    codStatementAt: ts("cod_statement_at"),
    receiverName: text("receiver_name").notNull().default(""),
    receiverPhone: text("receiver_phone").notNull().default(""),
    receiverAddress: text("receiver_address").notNull().default(""),
    pickedUpAt: ts("picked_up_at"),
    firstDeliveryAt: ts("first_delivery_at"),
    deliveredAt: ts("delivered_at"),
    returnedAt: ts("returned_at"),
    // Kho THỰC NHẬN hàng hoàn: chỉ khi có mốc này hàng mới được cộng lại tồn ERP.
    // ĐVVC báo "đã hoàn" không đồng nghĩa hàng đã về kho.
    returnReceivedAt: ts("return_received_at"),
    returnReceivedBy: text("return_received_by"),
    returnReceivedNote: text("return_received_note"),
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
    index("shipments_return_received_idx").on(t.returnReceivedAt),
    // Đối soát COD quét "đã giao, có thu hộ, chưa thấy tiền" trên toàn bảng vận đơn mỗi lần mở
    // trang Cần xử lý và mỗi lần chạy cảnh báo.
    index("shipments_cod_overdue_idx").on(t.deliveredAt).where(sql`${t.stage} = 'DELIVERED' and ${t.codCollected} = 0`),
    index("shipments_cod_statement_idx").on(t.codStatementRef),
    // Vận đơn CHIỀU VỀ (quy tắc 2 của ORDER_OUTCOME) được dò bằng một truy vấn con tương quan
    // chạy cho từng dòng; không có index này thì mỗi dòng quét toàn bảng shipments → O(n²).
    // Điều kiện lọc cố ý KHÔNG chứa ngưỡng nghiệp vụ (10K) để index không phải sửa khi shop đổi ngưỡng.
    index("shipments_return_leg_idx").on(t.orderReference, t.vtpOrderNumber).where(sql`${t.stage} = 'DELIVERED' and ${t.codAmount} = 0`),
    // HÀNG ĐÃ QUAY VỀ SHOP (`HAS_RETURN_LEG` trong ORDER_OUTCOME) hỏi "có vận đơn nào trỏ ngược
    // về mã này không?" cho TỪNG dòng, và KHÔNG kèm điều kiện stage/COD nên index riêng phần ở
    // trên không dùng được. Đo trên bộ dữ liệu 4.802 vận đơn: mỗi lần dựng trang Chất lượng dữ
    // liệu chạy 7 lần "Seq Scan on shipments" × 3.245 vòng = 15,6 triệu lượt so sánh, 460.790
    // khối đệm cho MỘT truy vấn — chi phí tăng theo BÌNH PHƯƠNG số vận đơn.
    index("shipments_order_reference_lookup_idx").on(t.orderReference).where(sql`${t.orderReference} is not null`),
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
    normalizedStage: shipmentStageEnum("normalized_stage"),
    legType: text("leg_type"),
    verificationStatus: text("verification_status"),
    sourceReference: text("source_reference"),
    verifiedAt: ts("verified_at"),
    verifiedBy: text("verified_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shipment_events_uq").on(t.shipmentId, t.source, t.status, t.occurredAt), index("shipment_events_shipment_idx").on(t.shipmentId, t.occurredAt),
    // ORDER_OUTCOME dò "doanh thu bị sửa sau khi giao" bằng truy vấn con tương quan chạy cho
    // từng dòng; không có index riêng phần này thì mỗi dòng quét toàn bảng shipment_events.
    index("shipment_events_revenue_edit_idx").on(t.shipmentId, t.occurredAt).where(sql`${t.statusName} like 'Nhập doanh thu%'`),
    // Hai luật đối soát mức NGHIÊM TRỌNG hỏi cùng một câu cho TỪNG vận đơn: "có sự kiện phát
    // thành công nào của ĐVVC không?". Không có index riêng phần này thì mỗi vận đơn quét toàn
    // bảng sự kiện — chi phí tăng theo bình phương khi shop lớn dần.
    index("shipment_events_delivered_idx").on(t.shipmentId).where(sql`${t.normalizedStage} = 'DELIVERED'`),
    check("shipment_events_leg_check", sql`${t.legType} IN ('OUTBOUND', 'RETURN', 'UNKNOWN')`),
    check("shipment_events_verification_check", sql`${t.verificationStatus} IN ('PENDING', 'VERIFIED', 'REJECTED', 'DISPUTED')`),
    check("shipment_events_verified_check", sql`${t.verificationStatus} IS DISTINCT FROM 'VERIFIED' OR (
      ${t.normalizedStage} IS NOT NULL AND ${t.normalizedStage} <> 'UNKNOWN'
      AND ${t.legType} IS NOT NULL AND ${t.legType} IN ('OUTBOUND', 'RETURN')
      AND ${t.source} IN ('VTP_WEBHOOK', 'VTP_POLL', 'VTP_IMPORT', 'MANUAL', 'VTP_UI_MANUAL_VERIFICATION')
      AND ${t.sourceReference} IS NOT NULL AND length(trim(${t.sourceReference})) > 0
      AND ${t.verifiedAt} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL AND length(trim(${t.verifiedBy})) > 0)`),
  ],
);

// P0.1: độc lập với COD và KPI legacy. Ràng buộc chéo bảng/audit ở migration mới.
export const paymentTransactions = pgTable("payment_transactions", {
  id: id(),
  orderId: text("order_id").references(() => orders.id, { onDelete: "restrict" }),
  shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "restrict" }),
  transactionType: text("transaction_type").notNull(),
  amount: bigint("amount", { mode: "bigint" }), // NULL chưa biết; 0 chỉ xác minh khi có chứng từ.
  currency: text("currency").notNull().default("VND"),
  direction: text("direction").notNull(),
  verificationStatus: text("verification_status").notNull().default("PENDING"),
  source: text("source").notNull(),
  sourceNamespace: text("source_namespace").notNull(),
  sourceReference: text("source_reference").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  verifiedAt: ts("verified_at"),
  verifiedBy: text("verified_by"),
  reversesTransactionId: text("reverses_transaction_id"),
  reason: text("reason"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  metadata: jsonb("metadata").notNull().default({}),
}, (t) => [
  index("payment_transactions_order_idx").on(t.orderId),
  index("payment_transactions_shipment_idx").on(t.shipmentId),
  uniqueIndex("payment_transactions_idempotency_uq").on(t.idempotencyKey),
  uniqueIndex("payment_transactions_reversal_uq").on(t.reversesTransactionId),
  foreignKey({ columns: [t.reversesTransactionId], foreignColumns: [t.id], name: "payment_transactions_reversal_fk" }).onDelete("restrict"),
  check("payment_transactions_target_check", sql`${t.orderId} IS NOT NULL OR ${t.shipmentId} IS NOT NULL`),
  check("payment_transactions_amount_check", sql`${t.amount} >= 0`),
  check("payment_transactions_currency_check", sql`${t.currency} = 'VND'`),
  check("payment_transactions_type_check", sql`${t.transactionType} IN ('COD_RECEIVED', 'PREPAID', 'BANK_TRANSFER', 'REFUND', 'ADJUSTMENT', 'REVERSAL')`),
  check("payment_transactions_direction_check", sql`${t.direction} IN ('INFLOW', 'OUTFLOW') AND (${t.transactionType} <> 'REFUND' OR ${t.direction} = 'OUTFLOW') AND (${t.transactionType} NOT IN ('COD_RECEIVED', 'PREPAID', 'BANK_TRANSFER') OR ${t.direction} = 'INFLOW')`),
  check("payment_transactions_status_check", sql`${t.verificationStatus} IN ('PENDING', 'VERIFIED', 'REJECTED', 'DISPUTED')`),
  check("payment_transactions_verified_check", sql`${t.verificationStatus} <> 'VERIFIED' OR (${t.amount} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL AND length(trim(${t.verifiedBy})) > 0)`),
  check("payment_transactions_reversal_check", sql`(${t.transactionType} = 'REVERSAL') = (${t.reversesTransactionId} IS NOT NULL) AND ${t.reversesTransactionId} IS DISTINCT FROM ${t.id}`),
  check("payment_transactions_reason_check", sql`(${t.transactionType} NOT IN ('REFUND', 'ADJUSTMENT', 'REVERSAL') AND ${t.verificationStatus} <> 'DISPUTED') OR (${t.reason} IS NOT NULL AND length(trim(${t.reason})) > 0)`),
  check("payment_transactions_identity_check", sql`length(trim(${t.source})) > 0 AND length(trim(${t.sourceNamespace})) > 0 AND length(trim(${t.sourceReference})) > 0 AND length(trim(${t.idempotencyKey})) > 0 AND length(trim(${t.createdBy})) > 0 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`),
]);

export const paymentEvidence = pgTable("payment_evidence", {
  id: id(),
  transactionId: text("transaction_id").notNull().references(() => paymentTransactions.id, { onDelete: "restrict" }),
  source: text("source").notNull(),
  sourceNamespace: text("source_namespace").notNull(),
  sourceReference: text("source_reference").notNull(),
  sourceLineKey: text("source_line_key").notNull(),
  documentLocator: text("document_locator").notNull(),
  documentHash: text("document_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("payment_evidence_transaction_idx").on(t.transactionId),
  uniqueIndex("payment_evidence_source_uq").on(t.source, t.sourceNamespace, t.sourceReference, t.sourceLineKey),
  uniqueIndex("payment_evidence_document_uq").on(t.documentHash, t.sourceLineKey),
  check("payment_evidence_source_check", sql`${t.source} IN ('BANK_STATEMENT', 'VTP_COD_STATEMENT', 'MANUAL_DOCUMENT')`),
  check("payment_evidence_identity_check", sql`length(trim(${t.sourceNamespace})) > 0 AND length(trim(${t.sourceReference})) > 0 AND length(trim(${t.sourceLineKey})) > 0 AND length(trim(${t.documentLocator})) > 0 AND length(trim(${t.createdBy})) > 0 AND ${t.documentHash} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.payload}) = 'object'`),
]);

export const paymentReviews = pgTable("payment_reviews", {
  id: id(),
  orderId: text("order_id").references(() => orders.id, { onDelete: "restrict" }),
  shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "restrict" }),
  coverage: text("coverage").notNull(),
  coveredThrough: ts("covered_through").notNull(),
  ledgerFingerprint: text("ledger_fingerprint").notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  reviewedBy: text("reviewed_by").notNull(),
  reviewedAt: ts("reviewed_at").notNull().defaultNow(),
  note: text("note").notNull(),
}, (t) => [
  index("payment_reviews_order_idx").on(t.orderId, t.reviewedAt),
  index("payment_reviews_shipment_idx").on(t.shipmentId, t.reviewedAt),
  check("payment_reviews_target_check", sql`${t.orderId} IS NOT NULL OR ${t.shipmentId} IS NOT NULL`),
  check("payment_reviews_coverage_check", sql`${t.coverage} IN ('PARTIAL', 'COMPLETE', 'DISPUTED')`),
  check("payment_reviews_identity_check", sql`length(trim(${t.evidenceReference})) > 0 AND length(trim(${t.reviewedBy})) > 0 AND length(trim(${t.note})) > 0 AND ${t.ledgerFingerprint} ~ '^[a-f0-9]{64}$'`),
]);

// ───────────────────────── Nhập hàng & kiểm kê (ERP tự quản lý tồn) ─────────────────────────

export const stockReceipts = pgTable(
  "stock_receipts",
  {
    id: id(),
    // RECEIPT (nhập hàng mới) | RETURN (tái nhập hàng hoàn) | ISSUE (xuất kho tay, không qua ĐVVC) | ADJUSTMENT (điều chỉnh sau kiểm kê).
    // Quy ước dấu của stock_receipt_items.quantity: DƯƠNG = vào kho, ÂM = ra kho. Tồn = tổng quantity − hàng đã xuất qua ĐVVC.
    kind: text("kind").notNull().default("RECEIPT"),
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
    quantity: integer("quantity").notNull(), // DƯƠNG = vào kho; ÂM = ra kho (xuất tay / điều chỉnh giảm)
    unitCost: money("unit_cost"),
    /** Vận đơn được tái nhập (chỉ phiếu RETURN) — để truy nguyên hàng hoàn nào đã thực sự về kho. */
    shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "set null" }),
  },
  (t) => [
    index("stock_receipt_items_receipt_idx").on(t.receiptId),
    index("stock_receipt_items_variant_idx").on(t.variantId),
    index("stock_receipt_items_shipment_idx").on(t.shipmentId),
  ],
);

// ───────────────────────── Chi phí & marketing ─────────────────────────

/**
 * ───────────── KIỂM HÀNG HOÀN ─────────────
 *
 * "ĐVVC báo đã hoàn" KHÔNG có nghĩa là hàng đã về tồn. Giữa hai mốc đó là một quy trình có thật mà
 * trước đây ERP nén thành một ô ngày duy nhất (`shipments.return_received_at`):
 *
 *   ĐÃ NHẬN  →  CHỜ KIỂM  →  ĐÃ KIỂM  →  {BÁN LẠI ĐƯỢC · KHÔNG BÁN ĐƯỢC · HỎNG · THIẾU}
 *
 * Vì sao phải tách: một kiện hàng về có thể thiếu món, rách, bẩn. Đánh dấu "đã nhận" rồi cộng
 * nguyên số đã xuất trở lại tồn là ghi vào sổ một lượng hàng không có thật — và phần chênh đó sẽ
 * không bao giờ ai tìm ra, vì nó nằm im trong số tồn.
 *
 * CHỈ khi kết luận BÁN LẠI ĐƯỢC với SỐ ĐẾM THỰC TẾ thì mới sinh phiếu tái nhập. Số không bán được
 * ghi riêng để nhìn thấy phần mất, thay vì giấu nó bằng cách không cộng vào.
 */
export const returnInspections = pgTable(
  "return_inspections",
  {
    id: id(),
    /** Một vận đơn hoàn chỉ có MỘT phiếu kiểm — chống tạo trùng khi bấm hai lần. */
    shipmentId: text("shipment_id")
      .notNull()
      .unique()
      .references(() => shipments.id, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    /** RECEIVED (đã nhận, chờ kiểm) · INSPECTED (đã kiểm xong) */
    status: text("status").notNull().default("RECEIVED"),
    receivedAt: ts("received_at").notNull(),
    receivedBy: text("received_by").notNull().default(""),
    inspectedAt: ts("inspected_at"),
    inspectedBy: text("inspected_by"),
    /** RESTOCKABLE · UNSELLABLE · DAMAGED · MISSING — chỉ có khi đã kiểm. */
    condition: text("condition"),
    /** Số món ĐẾM ĐƯỢC và bán lại được — đây là số duy nhất được cộng vào tồn. */
    restockQty: integer("restock_qty").notNull().default(0),
    /** Số món về nhưng không bán lại được (rách, bẩn, thiếu phụ kiện). */
    unsellableQty: integer("unsellable_qty").notNull().default(0),
    /** Bằng chứng: ảnh, ghi chú của người kiểm. Bắt buộc khi kết luận không bán được. */
    note: text("note").notNull().default(""),
    /** Phiếu tái nhập được sinh ra khi kết luận bán lại được — để truy nguyên hai chiều. */
    stockReceiptId: text("stock_receipt_id").references(() => stockReceipts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("return_inspections_status_idx").on(t.status, t.receivedAt),
    index("return_inspections_order_idx").on(t.orderId),
    check("return_inspections_status_check", sql`${t.status} IN ('RECEIVED', 'INSPECTED')`),
    /*
      Danh sách này PHẢI khớp `RETURN_CONDITIONS` ở lib/constants/returns-condition.ts.

      Đã lệch một lần: `WRONG_ITEM` (khách trả về một món KHÁC với món đã gửi) được thêm vào hằng
      số và vào nút bấm của trạm kiểm đếm, nhưng ràng buộc này thì không — nên người kho bấm
      "Không đúng hàng" là gặp lỗi ràng buộc, đúng lúc đang đứng đếm hàng. `tsc` không thấy được
      loại lệch này vì một bên là TypeScript, một bên là chuỗi SQL.
    */
    check("return_inspections_condition_check", sql`${t.condition} IS NULL OR ${t.condition} IN ('RESTOCKABLE', 'UNSELLABLE', 'DAMAGED', 'MISSING', 'WRONG_ITEM')`),
    // Đã kiểm thì PHẢI có kết luận, người kiểm và mốc kiểm — không có "đã kiểm" mà không biết ai kiểm.
    check(
      "return_inspections_inspected_check",
      sql`${t.status} <> 'INSPECTED' OR (${t.condition} IS NOT NULL AND ${t.inspectedAt} IS NOT NULL AND ${t.inspectedBy} IS NOT NULL AND length(trim(${t.inspectedBy})) > 0)`,
    ),
    // Kết luận KHÔNG bán được thì phải nói vì sao — nếu không, phần hàng mất biến mất không dấu vết.
    check(
      "return_inspections_reason_check",
      sql`${t.condition} IS NULL OR ${t.condition} = 'RESTOCKABLE' OR length(trim(${t.note})) > 0`,
    ),
    check("return_inspections_qty_check", sql`${t.restockQty} >= 0 AND ${t.unsellableQty} >= 0`),
  ],
);

/**
 * ═══════ BẰNG CHỨNG HÀNH ĐỘNG — CÔNG CỦA ĐỘI, ĐO ĐƯỢC ═══════
 *
 * Câu chưa trả lời được: *CSKH đã cứu bao nhiêu doanh thu? Kế toán đòi về bao nhiêu COD? Kho giải
 * phóng bao nhiêu vốn?*
 *
 * Không suy ngược từ lịch sử. Đo trên production 10/09/2026: 96 việc đã đóng có kết quả đơn, **cả
 * 96 đều mang `resolution = 'UNKNOWN'`** — đóng từ trước khi có cột ghi nguồn gốc, không ca nào
 * chứng minh được là có người xử lý. Lấy chúng tính "hiệu quả hành động" là đo một thứ khác rồi dán
 * nhãn sai.
 *
 * Nên bảng này bắt đầu từ HÔM NAY, ghi một dòng mỗi lần MỘT NGƯỜI đóng một việc:
 *
 *   · ai đóng, lúc nào, mất bao lâu kể từ khi phát hiện;
 *   · TIỀN ĐANG TREO tại thời điểm đóng — chụp lại, vì giá trị đơn có thể đổi sau;
 *   · KẾT QUẢ ĐƠN tại thời điểm đóng — mốc để so về sau.
 *
 * `recovered_value` cố ý để TRỐNG lúc ghi. Lúc đóng việc thì đơn thường chưa ngã ngũ; điền một con
 * số ở đó là đoán. Nó được tính sau, khi đơn đã có kết quả cuối, bằng cách so `outcome_at_close`
 * với kết quả hiện tại. Chưa tính được thì là `NULL` = CHƯA BIẾT, không phải 0.
 */
export const actionEvidence = pgTable(
  "action_evidence",
  {
    id: id(),
    /** Việc trong hàng đợi. Không `references` để giữ bằng chứng khi việc cũ bị dọn. */
    notificationId: text("notification_id").notNull(),
    caseType: text("case_type").notNull(),
    team: text("team").notNull().default(""),
    entityType: text("entity_type").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    /** Ai đóng. `NULL` nghĩa là dòng hỏng — bảng này chỉ ghi việc CÓ NGƯỜI đóng. */
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    detectedAt: ts("detected_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at").notNull(),
    /** Số giờ từ lúc phát hiện tới lúc đóng. Chụp lại để khỏi tính lại từ hai mốc có thể bị sửa. */
    hoursToClose: integer("hours_to_close"),
    /**
     * Tiền đang treo TẠI THỜI ĐIỂM ĐÓNG (đồng). Ảnh chụp, không phải giá trị hôm nay.
     *
     * Cố ý KHÔNG dùng helper `money()` (notNull default 0): việc không gắn với đơn hay vận đơn thì
     * không có tiền để tra, và đó là CHƯA BIẾT — ghi 0 sẽ kéo mọi con số trung bình xuống bằng
     * những dòng vốn không có gì để đo.
     */
    moneyAtRisk: bigint("money_at_risk", { mode: "number" }),
    /** Kết quả đơn tại thời điểm đóng — mốc so sánh về sau. `NULL` = việc không gắn với đơn. */
    outcomeAtClose: text("outcome_at_close"),
    /**
     * Tiền THẬT SỰ thu về, tính sau khi đơn ngã ngũ. `NULL` = CHƯA BIẾT, không phải 0.
     */
    recoveredValue: integer("recovered_value"),
    recoveredAt: ts("recovered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("action_evidence_actor_idx").on(t.actorId, t.completedAt),
    index("action_evidence_type_idx").on(t.caseType, t.completedAt),
    // Một việc đóng một lần: bấm hai lần không được đếm thành hai công.
    uniqueIndex("action_evidence_notification_idx").on(t.notificationId),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    category: expenseCategoryEnum("category").notNull().default("OTHER"),
    description: text("description").notNull(),
    amount: integer("amount").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    /**
     * KỲ HIỆU LỰC của khoản chi — chỉ dùng khi `allocationMethod = 'PERIOD_PRORATA'`.
     * Có kỳ thì báo cáo lấy đúng phần ngày chồng lấn, thay vì cộng nguyên khoản vào bất kỳ khoảng
     * nào chứa `occurred_at`. Xem `lib/constants/cost-allocation.ts`.
     */
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    allocationMethod: text("allocation_method").notNull().default("EVENT_DATE"),
    /** Khoản theo kỳ nhưng CHƯA khai kỳ — nêu ở Chất lượng dữ liệu, KHÔNG tự đoán kỳ giúp. */
    needsAllocationReview: boolean("needs_allocation_review").notNull().default(false),
    reference: text("reference").notNull().default(""),
    /**
     * NGUỒN của khoản chi — quyết định nó có được tính vào lợi nhuận hay không khi nhóm của nó đã
     * có nguồn chuyên biệt (cước, phí hoàn). `MANUAL_ADJUSTMENT` là khoản ĐIỀU CHỈNH có chứng cứ:
     * đền bù, phí ngoại lệ, cước chuyến gom hàng không gắn được vận đơn nào — tiền thật, phải tính.
     * Khoản `MANUAL` thông thường trong các nhóm đó bị loại vì vận đơn đã bao trọn.
     */
    costSource: text("cost_source").notNull().default("MANUAL"),
    /** Bắt buộc với `MANUAL_ADJUSTMENT`: vì sao khoản này KHÔNG nằm trong cước theo vận đơn */
    reason: text("reason").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("expenses_cat_occurred_idx").on(t.category, t.occurredAt), index("expenses_occurred_idx").on(t.occurredAt),
    check("expenses_cost_source_check", sql`${t.costSource} IN ('MANUAL', 'MANUAL_ADJUSTMENT', 'BANK_IMPORT', 'PAYROLL')`),
    // Khoản điều chỉnh mà không nói vì sao thì không kiểm chứng được ⇒ chặn ngay ở CSDL.
    check("expenses_adjustment_reason_check", sql`${t.costSource} <> 'MANUAL_ADJUSTMENT' OR length(trim(${t.reason})) > 0`),
    index("expenses_period_idx").on(t.periodStart, t.periodEnd),
    check("expenses_allocation_check", sql`${t.allocationMethod} IN ('EVENT_DATE', 'PERIOD_PRORATA', 'ORDER_ATTRIBUTED', 'ACTUAL_DATED_SPEND')`),
    // Chia theo ngày thì BẮT BUỘC có kỳ hợp lệ — không có kỳ mà đòi chia là không tính được.
    check("expenses_period_check", sql`${t.allocationMethod} <> 'PERIOD_PRORATA' OR (
      ${t.periodStart} IS NOT NULL AND ${t.periodEnd} IS NOT NULL AND ${t.periodEnd} >= ${t.periodStart})`),
  ],
);

/**
 * ═══════════ SỔ GIAO DỊCH NGÂN HÀNG — DÒNG TIỀN THU / CHI THỰC ═══════════
 *
 * Sao kê là nguồn TIỀN THẬT: mọi đồng vào ra tài khoản đều có một dòng ở đây, kể cả những dòng
 * không ảnh hưởng lãi lỗ (chuyển giữa tài khoản của mình, trả nợ gốc, rút vốn).
 *
 * Bảng này CHỈ ghi nhận và phân loại. Việc một dòng có được trừ vào lợi nhuận hay không do
 * `lib/constants/bank.ts::BANK_GROUP_SPEC` quyết định, dựa trên hợp đồng nguồn sự thật ở
 * `lib/constants/cost-sources.ts` — tiền quảng cáo, tiền hàng, cước ĐVVC đã có nguồn chuyên biệt
 * nên dòng sao kê tương ứng chỉ tính vào DÒNG TIỀN, không trừ lần thứ hai vào lãi lỗ.
 */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: id(),
    /** Mốc giao dịch. Sao kê ghi giờ Việt Nam; mapper đổi sang UTC trước khi lưu. */
    txnAt: ts("txn_at").notNull(),
    /** DƯƠNG = tiền vào, ÂM = tiền ra. Một cột có dấu thay vì hai cột, để không bao giờ cộng nhầm cả hai. */
    amount: integer("amount").notNull(),
    description: text("description").notNull().default(""),
    counterparty: text("counterparty").notNull().default(""),
    /** Mã giao dịch của ngân hàng — KHOÁ TỰ NHIÊN chống nhập trùng khi tải lại sao kê. */
    bankRef: text("bank_ref").notNull(),
    /** Tài khoản / ngân hàng phát sinh (để sau này gộp nhiều tài khoản) */
    account: text("account").notNull().default(""),
    /** Nhóm kế toán — quyết định giao dịch này đi vào báo cáo nào */
    accountingGroup: text("accounting_group").notNull().default("UNCLASSIFIED"),
    /** Mã danh mục chi tiết của app sao kê (LUONG, THUE_MAT_BANG…) — giữ nguyên để truy nguyên */
    categoryCode: text("category_code").notNull().default(""),
    note: text("note").notNull().default(""),
    /** Quy tắc đã tự gán nhãn dòng này (nếu có) — sửa tay thì xoá về NULL để quy tắc không ghi đè */
    ruleId: text("rule_id"),
    /** "" = chưa ai phân loại; "rule" = do quy tắc; còn lại là email người phân loại */
    classifiedBy: text("classified_by").notNull().default(""),
    classifiedAt: ts("classified_at"),
    /** IMPORT = từ file sao kê, MANUAL = gõ tay (tiền mặt, ví điện tử…) */
    source: text("source").notNull().default("IMPORT"),
    /**
     * ĐỐI CHIẾU, KHÔNG PHẢI GHI NHẬN.
     *
     * Một dòng tiền ra KHÔNG tự sinh chi phí trong lãi lỗ — trả lương qua ngân hàng là tiền đi ra,
     * nhưng chi phí lương đã được ghi nhận theo kỳ ở nguồn có thẩm quyền. Liên kết ở đây chỉ để nối
     * TIỀN THẬT với CHỨNG TỪ đã có, phục vụ đối chiếu; không nhân đôi chi phí.
     */
    linkedType: text("linked_type").notNull().default(""),
    linkedId: text("linked_id").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bank_txn_ref_idx").on(t.bankRef),
    index("bank_txn_at_idx").on(t.txnAt),
    index("bank_txn_group_idx").on(t.accountingGroup, t.txnAt),
    index("bank_txn_linked_idx").on(t.linkedType, t.linkedId),
    check("bank_txn_linked_check", sql`${t.linkedType} IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND')`),
    // Có loại thì phải có mã, và ngược lại — nửa vời thì đối chiếu không lần ra được gì.
    check("bank_txn_linked_pair_check", sql`(${t.linkedType} = '' AND ${t.linkedId} = '') OR (${t.linkedType} <> '' AND length(${t.linkedId}) > 0)`),
    // Số tiền 0 không phải giao dịch; chiều tiền phải rõ ràng.
    check("bank_txn_amount_check", sql`${t.amount} <> 0`),
    check("bank_txn_source_check", sql`${t.source} IN ('IMPORT', 'MANUAL')`),
  ],
);

/**
 * QUY TẮC GÁN NHÃN TỰ ĐỘNG cho giao dịch sao kê.
 *
 * Quy tắc chỉ chạm vào dòng CHƯA ai sửa tay (`classified_by` rỗng hoặc = 'rule'). Người đã phân
 * loại tay thì quy tắc không được ghi đè — nếu không, mỗi lần nhập sao kê mới lại xoá công sức
 * phân loại của chủ shop.
 */
export const bankRules = pgTable(
  "bank_rules",
  {
    id: id(),
    name: text("name").notNull(),
    /** Số nhỏ chạy trước. Quy tắc đầu tiên khớp sẽ thắng — không cộng dồn nhiều quy tắc lên một dòng. */
    priority: integer("priority").notNull().default(100),
    /** IN = chỉ tiền vào, OUT = chỉ tiền ra, ANY = cả hai */
    direction: text("direction").notNull().default("ANY"),
    /** Khớp CHỨA, không phân biệt hoa thường và dấu tiếng Việt (chuẩn hoá bằng lib/text.ts) */
    matchCounterparty: text("match_counterparty").notNull().default(""),
    matchDescription: text("match_description").notNull().default(""),
    /** Khoảng số tiền theo TRỊ TUYỆT ĐỐI (₫). `maxAmount` = 0 nghĩa là không giới hạn trên. */
    minAmount: integer("min_amount").notNull().default(0),
    maxAmount: integer("max_amount").notNull().default(0),
    accountingGroup: text("accounting_group").notNull(),
    categoryCode: text("category_code").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bank_rules_priority_idx").on(t.enabled, t.priority),
    check("bank_rules_direction_check", sql`${t.direction} IN ('IN', 'OUT', 'ANY')`),
    // Quy tắc không có điều kiện nào sẽ khớp MỌI dòng — chặn ngay ở CSDL.
    check("bank_rules_match_check", sql`length(${t.matchCounterparty}) > 0 OR length(${t.matchDescription}) > 0 OR ${t.minAmount} > 0 OR ${t.maxAmount} > 0`),
    check("bank_rules_amount_check", sql`${t.maxAmount} = 0 OR ${t.maxAmount} >= ${t.minAmount}`),
  ],
);

/** Đơn landing page (khách điền form → Google Sheet → ERP): theo dõi trạng thái, lọc trùng, gửi đơn nháp lên Pancake POS */
export const landingOrders = pgTable(
  "landing_orders",
  {
    id: id(),
    /** Khoá dòng trong sheet: <gid>:<số dòng dữ liệu> */
    rowKey: text("row_key").notNull().unique(),
    sheetGid: text("sheet_gid").notNull().default(""),
    rowIndex: integer("row_index").notNull().default(0),
    /** Thời gian khách đặt (trên sheet) */
    submittedAt: ts("submitted_at"),
    customerName: text("customer_name").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull().default(""),
    province: text("province").notNull().default(""),
    productText: text("product_text").notNull().default(""),
    variantText: text("variant_text").notNull().default(""),
    sizeText: text("size_text").notNull().default(""),
    colorText: text("color_text").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    price: money("price"),
    total: money("total"),
    note: text("note").notNull().default(""),
    source: text("source").notNull().default(""),
    sheetStatus: text("sheet_status").notNull().default(""),
    /** ad_id Facebook (utm_term) → chiến dịch → marketer */
    adId: text("ad_id"),
    /** NEW · CONFIRMED · PUSHED · CANCELLED (ERP quản lý) */
    status: text("status").notNull().default("NEW"),
    /** Mẫu mã Pancake đã ghép (tự dò hoặc chọn tay) */
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    variantMatchScore: integer("variant_match_score").notNull().default(0),
    /** Lý do dòng này CHƯA gửi POS được (thiếu mẫu mã / SĐT / địa chỉ không đủ). Tính lại mỗi lần
     *  rà soát để bộ lọc "Chưa gửi POS được" và cảnh báo trên dòng luôn khớp nhau. */
    pushBlock: text("push_block"),
    /** Đơn Pancake tương ứng (sau khi gửi POS hoặc tự ghép theo SĐT) */
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    pancakeOrderId: text("pancake_order_id"),
    pancakeSystemId: integer("pancake_system_id"),
    pushedAt: ts("pushed_at"),
    pushError: text("push_error").notNull().default(""),
    /** Trùng với: [{kind, id, label, at}] */
    duplicates: jsonb("duplicates"),
    /** Đánh giá rủi ro hoàn theo lịch sử khách (Pancake + ERP) */
    risk: jsonb("risk"),
    assignee: text("assignee").notNull().default(""),
    internalNote: text("internal_note").notNull().default(""),
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("landing_orders_phone_idx").on(t.phone), index("landing_orders_status_idx").on(t.status, t.submittedAt), index("landing_orders_order_idx").on(t.orderId)],
);
export type LandingOrder = typeof landingOrders.$inferSelect;

/** Danh mục quảng cáo Facebook (ad_id → adset / chiến dịch / tài khoản) để ghi nhận đơn Pancake có ad_id cho đúng marketer */
export const fbAds = pgTable(
  "fb_ads",
  {
    /** ad_id Facebook (khớp orders.ad_id) */
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    adsetId: text("adset_id"),
    campaignId: text("campaign_id"),
    campaignName: text("campaign_name").notNull().default(""),
    accountId: text("account_id"),
    status: text("status").notNull().default(""),
    /** Không tra được trên Facebook (đã xoá / không có quyền) */
    missing: boolean("missing").notNull().default(false),
    /**
     * BÀI VIẾT mà mẩu quảng cáo này quảng bá — mắt xích nối đơn chỉ có `post_id` về chiến dịch.
     * Pancake ghi `orders.post_id` cho 82% đơn nhưng chỉ ghi `ad_id` cho 46%; nối qua bài viết là
     * cách DUY NHẤT tăng độ phủ mà không phải suy đoán.
     */
    postId: text("post_id"),
    /** Chuỗi gốc "<page_id>_<post_id>" của Facebook — giữ để truy nguyên. */
    storyId: text("story_id"),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("fb_ads_campaign_idx").on(t.campaignId), index("fb_ads_post_idx").on(t.postId)],
);
export type FbAd = typeof fbAds.$inferSelect;

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
    /**
     * MỐC CỦA SỰ KIỆN (giờ ĐVVC / Pancake), khác hẳn `received_at` là giờ ERP nhận gói tin.
     * Thiếu nó thì một gói tin xử lý lỗi không tra được nó thuộc thời điểm nào nếu không mở payload.
     */
    occurredAt: ts("occurred_at"),
    /**
     * KHOÁ CHỐNG TRÙNG của gói tin: nguồn + mã vận đơn + trạng thái + mốc sự kiện.
     * Viettel Post thử lại tối đa 5 lần nên cùng một sự việc tới nhiều lần; không có khoá này thì
     * mỗi lần thử lại đẻ thêm một dòng và con số "đã nhận / đã xử lý" trên trang Kết nối dữ liệu
     * không còn đọc được. NULL = gói tin không đủ thông tin để nhận dạng, vẫn được lưu.
     */
    dedupeKey: text("dedupe_key"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    /** Số lần cùng một gói tin được gửi lại (1 = lần đầu). */
    deliveryCount: integer("delivery_count").notNull().default(1),
  },
  (t) => [
    index("webhook_events_source_received_idx").on(t.source, t.receivedAt),
    index("webhook_events_status_idx").on(t.status),
    uniqueIndex("webhook_events_dedupe_uq").on(t.dedupeKey),
  ],
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
export const landingOrdersRelations = relations(landingOrders, ({ one }) => ({
  variant: one(productVariants, { fields: [landingOrders.variantId], references: [productVariants.id] }),
  order: one(orders, { fields: [landingOrders.orderId], references: [orders.id] }),
}));

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
  /**
   * GIỮ quan hệ một-vận-đơn cho các đường đã có (nó lấy MỘT dòng bất kỳ), nhưng từ 10/09/2026 một
   * đơn có thể có NHIỀU lần gửi — dùng `attempts` khi cần đủ.
   */
  shipment: one(shipments, { fields: [orders.id], references: [shipments.orderId] }),
  /** Mọi lần gửi của đơn, gồm cả lần đã huỷ và lần gửi lại. */
  attempts: many(shipments),
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
export const codBatchesRelations = relations(codBatches, ({ many }) => ({ shipments: many(shipments), statementLines: many(codStatementLines) }));

export const codStatementLinesRelations = relations(codStatementLines, ({ one }) => ({
  batch: one(codBatches, { fields: [codStatementLines.batchId], references: [codBatches.id] }),
  shipment: one(shipments, { fields: [codStatementLines.shipmentId], references: [shipments.id] }),
}));

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
export type CodStatementLine = typeof codStatementLines.$inferSelect;
export type VtpStatementFile = typeof vtpStatementFiles.$inferSelect;
export type MarketingIdea = typeof marketingIdeas.$inferSelect;
export type IdeaStatus = MarketingIdea["status"];
export type OrderReturn = typeof orderReturns.$inferSelect;
export type InventoryHistory = typeof inventoryHistories.$inferSelect;

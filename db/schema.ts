// VNXcommerce ERP — Drizzle schema (PostgreSQL)
// Tiền tệ: VND, lưu dạng integer. Thời gian: timestamptz (UTC).
import { relations, sql } from "drizzle-orm";
import { boolean, check, doublePrecision, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, bigint, type AnyPgColumn } from "drizzle-orm/pg-core";

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

/**
 * VAI TRÒ TUỲ CHỈNH — bó quyền do chủ shop tự đặt tên.
 *
 * Tám vai trò hệ thống (`roleEnum`) KHÔNG nằm trong bảng này: chúng là hằng số trong mã nguồn nên
 * không ai xoá được, và mẫu quyền của chúng vẫn ở `settings["auth.rolePermissions"]` như cũ. Bảng
 * này chỉ chứa vai trò SINH THÊM. Tách như vậy thì "vai trò hệ thống được bảo vệ" là một tính
 * chất của CẤU TRÚC, không phải một cờ `is_system` mà một câu UPDATE nhỡ tay là mất.
 *
 * `base_role` là vai trò nền: `users.role` vẫn phải giữ một giá trị enum hợp lệ (mọi chỗ kiểm tra
 * `requireUser([...])` và mọi nhãn hiển thị đang đọc nó), và nếu vai trò tuỳ chỉnh bị TẮT thì
 * người dùng rơi về đúng mẫu quyền của vai trò nền — không bao giờ rơi về "toàn quyền".
 */
export const accessRoles = pgTable(
  "access_roles",
  {
    id: id(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Vai trò hệ thống dùng làm nền. KHÔNG được là `ADMIN` (xem `lib/auth/access.ts`). */
    baseRole: roleEnum("base_role").notNull().default("VIEWER"),
    /** Bó quyền của vai trò này (danh sách khoá quyền). */
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    /** Phạm vi dữ liệu gợi ý khi gán vai trò này cho một người; người dùng vẫn đặt riêng được. */
    defaultScope: text("default_scope").notNull().default("ALL"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("access_roles_active_idx").on(t.active, t.sortOrder)],
);

/**
 * CHỨC DANH — nhãn tổ chức. KHÔNG SINH QUYỀN, không bao giờ.
 *
 * Gắn được với một phòng ban để hiển thị và để gợi ý khi xếp người, nhưng bản thân việc có chức
 * danh "Kế toán trưởng" không mở thêm một quyền nào. Xem phần đầu `lib/constants/access-scope.ts`.
 */
export const positions = pgTable(
  "positions",
  {
    id: id(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Phòng ban thường gắn với chức danh này (chỉ để hiển thị / gợi ý). */
    departmentId: text("department_id").references((): AnyPgColumn => departments.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("positions_active_idx").on(t.active, t.sortOrder)],
);


export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("VIEWER"),
  /** Quyền tuỳ chỉnh riêng (danh sách khoá quyền); null = dùng mẫu quyền của vai trò */
  permissions: jsonb("permissions").$type<string[] | null>(),
  /** Vai trò tuỳ chỉnh (`access_roles`); null = dùng mẫu quyền của vai trò hệ thống ở `role`. */
  accessRoleId: text("access_role_id").references((): AnyPgColumn => accessRoles.id, { onDelete: "set null" }),
  /** Chức danh (`positions`). Chỉ là nhãn — KHÔNG tham gia vào phép tính quyền. */
  positionId: text("position_id").references((): AnyPgColumn => positions.id, { onDelete: "set null" }),
  /**
   * Phạm vi dữ liệu: `SELF` · `ASSIGNED` · `TEAM` · `DEPARTMENT` · `ALL`
   * (`lib/constants/access-scope.ts`). Mặc định `ALL` để bản này không đổi hành vi của tài khoản
   * nào đang chạy; thu hẹp là một quyết định chủ shop phải bấm.
   */
  dataScope: text("data_scope").notNull().default("ALL"),
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
    /**
     * TÊN HIỂN THỊ của người phụ trách — GIỮ NGUYÊN, không xoá.
     *
     * Ô chữ này là dữ liệu lịch sử có thật: phần lớn case đang mở mang tên ở đây và nhiều dòng đến
     * từ Pancake chứ không từ một tài khoản ERP. Xoá nó là xoá thứ duy nhất nói ai đã làm case đó.
     * Nhưng nó KHÔNG phải danh tính: trùng tên, viết tắt, sai chính tả đều nối nhầm người.
     */
    assignee: text("assignee").notNull().default(""),
    /**
     * DANH TÍNH của người phụ trách. `NULL` = CHƯA NỐI ĐƯỢC VỀ MỘT TÀI KHOẢN, không phải "không có ai".
     *
     * Đây là cột quyết định độ tin cậy: chỉ số tính trên cột này đạt `USER_ID`, còn tính trên
     * `assignee` thì trần là `LOW` dù mẫu bao nhiêu (xem `metricConfidence`). Dòng cũ chỉ được điền
     * khi ánh xạ là XÁC ĐỊNH (đúng một tài khoản khớp) — không đoán để lấp chỗ trống.
     */
    assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    resolution: text("resolution").notNull().default(""),
    /** Khoá chống tạo trùng khi tự phát hiện */
    dedupeKey: text("dedupe_key").unique(),
    /** Link hội thoại Pancake (case từ chat) */
    chatUrl: text("chat_url").notNull().default(""),
    /**
     * Hội thoại Pancake sinh ra case. Tách khỏi `chat_url` vì URL là để NGƯỜI bấm, còn cái này là
     * để MÁY ghép: nối case với đơn được tạo sau đó (`orders.conversation_id`).
     */
    conversationId: text("conversation_id"),
    /**
     * ═══ LÚC KHÁCH CHO ĐỦ SĐT VÀ ĐỊA CHỈ ═══
     *
     * KHÁC `created_at`: case được phát hiện lúc job quét (có thể vài giờ sau), còn mốc này là lúc
     * khách thật sự đã đưa đủ thông tin để lên đơn. Đo "bao lâu từ đủ thông tin tới lúc có đơn" mà
     * lấy `created_at` thì con số đó đo tốc độ của JOB QUÉT, không đo tốc độ của CSKH.
     *
     * `NULL` với case thuộc loại khác hoặc case sinh bởi luật cũ — CHƯA BIẾT, không phải 0.
     */
    infoCompleteAt: ts("info_complete_at"),
    /**
     * ═══ HẸN QUAY LẠI CASE ═══
     *
     * `NULL` = CHƯA HẸN, không phải "hẹn ngay bây giờ". Hàng đợi phân biệt hai thứ đó: case chưa
     * hẹn xếp theo tuổi, case đã hẹn chỉ nổi lên khi tới giờ. Gộp lại thì mọi case đều "đến hạn"
     * và cái hẹn mất hết ý nghĩa.
     */
    followUpAt: ts("follow_up_at"),
    createdBy: text("created_by").notNull().default(""),
    /** Danh tính người tạo case. `NULL` với case do JOB tự phát hiện — đó là sự thật, không phải lỗ hổng. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * ═══ KẾT LUẬN CỦA TẦNG NGỮ NGHĨA, LƯU LẠI ĐỂ KIỂM CHỨNG ═══
     *
     * Máy phân loại chạy TRONG JOB QUÉT, không chạy lúc dựng trang (200 dòng × một lượt gọi model
     * là một trang không bao giờ mở xong). Nên kết luận phải được lưu, nếu không màn hình và báo
     * cáo đối chiếu chỉ còn "case này từ đâu ra thì không ai biết".
     *
     * Lưu ĐÚNG phần kiểm chứng được: loại việc, mức tin cậy, phạm vi thời gian, ý định người nói,
     * một câu lý do, và TRÍCH NGUYÊN VĂN thuận / nghịch. **KHÔNG lưu dòng suy nghĩ riêng của
     * model** — nó không kiểm chứng được, không ai đọc, và là chỗ dữ liệu khách hàng rò ra nhiều
     * nhất. Hình dạng khai ở `lib/cs/semantic-case.ts::SemanticRecord`.
     *
     * `NULL` = case sinh trước bản này hoặc sinh bởi đường xác định (không qua model) — CHƯA BIẾT,
     * không phải "model đã xem và không nói gì".
     */
    semantic: jsonb("semantic").$type<Record<string, unknown> | null>(),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("cs_cases_status_idx").on(t.status, t.createdAt), index("cs_cases_order_idx").on(t.orderId), index("cs_cases_follow_up_idx").on(t.followUpAt)],
);

/**
 * ═══════════ LỊCH SỬ MỘT CASE CSKH — CHỈ THÊM, KHÔNG SỬA, KHÔNG XOÁ ═══════════
 *
 * Trước bảng này, toàn bộ thứ một người CSKH làm với case chỉ để lại DUY NHẤT trạng thái cuối
 * cùng: ai gọi, gọi lúc nào, khách nói gì, vì sao hẹn lại — mất sạch. `resolution` là một ô chữ bị
 * ghi đè mỗi lần, nên hai lần liên hệ trong một ngày chỉ còn lại lần sau.
 *
 * Cùng hình dạng với `care_case_events` của care vận đơn (actor · nguồn · hành động · trạng thái
 * trước/sau · người trước/sau · hẹn) để hai bàn làm việc đọc được như nhau — và để một case đi qua
 * cả hai miền vẫn kể được một câu chuyện liền mạch.
 *
 * `audit_logs` KHÔNG thay được bảng này: audit là nhật ký AN NINH (ai đụng vào cái gì), còn đây là
 * nhật ký NGHIỆP VỤ mà người xử lý ca sau phải đọc được ngay trên dòng.
 */
export const csCaseEvents = pgTable(
  "cs_case_events",
  {
    id: id(),
    caseId: text("case_id")
      .notNull()
      .references(() => csCases.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    /** Tên hiển thị lúc xảy ra — ảnh chụp, vì người dùng có thể đổi tên hoặc nghỉ việc. */
    actorName: text("actor_name").notNull().default(""),
    /** `UI` · `API` · `AI` · `SYSTEM`. */
    source: text("source").notNull().default("UI"),
    /** `NOTE` · `STATUS` · `ASSIGN` · `FOLLOW_UP` — xem `CS_EVENT_ACTIONS`. */
    action: text("action").notNull(),
    note: text("note").notNull().default(""),
    previousStatus: text("previous_status"),
    nextStatus: text("next_status"),
    previousAssignee: text("previous_assignee"),
    nextAssignee: text("next_assignee"),
    followUpAt: ts("follow_up_at"),
    createdAt: createdAt(),
  },
  (t) => [index("cs_case_events_case_idx").on(t.caseId, t.createdAt), index("cs_case_events_actor_idx").on(t.actorEmail, t.createdAt)],
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
    /** `PENDING` · `SENDING` (đang giữ chỗ) · `SENT` · `FAILED` · `SKIPPED` · `CONVERTED` · `REPLIED`. */
    status: text("status").notNull().default("PENDING"),
    error: text("error").notNull().default(""),
    /** Nguyên văn lỗi đã được phân loại (`lib/constants/outreach-errors.ts`). `NULL` = chưa lỗi lần nào. */
    errorKind: text("error_kind"),
    /** Mã tin nhắn do nhà cung cấp trả về. CÓ mã = họ đã NHẬN tin, không phải ta đoán là đã gửi. */
    providerMessageId: text("provider_message_id"),
    /** Lúc nhà cung cấp chấp nhận. Khác `sent_at` (lúc ta bấm) — hai mốc, hai ý nghĩa. */
    acceptedAt: ts("accepted_at"),
    /** Đã thử mấy lần. Phân biệt "lỗi một lần" với "lỗi mãi" — `0` = chưa thử lần nào. */
    attemptCount: integer("attempt_count").notNull().default(0),
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
     * CĂN CỨ của giá vốn đã chốt — và đây là chỗ phải nói thật. Xếp theo độ mạnh giảm dần:
     *
     *  · `RECEIPT_BEFORE` — có phiếu nhập TRƯỚC hoặc ĐÚNG ngày giao. Căn cứ vững (có chứng từ).
     *  · `RECEIPT_AFTER`  — chỉ có phiếu nhập lập SAU ngày giao: giá vốn suy ngược từ phiếu gần
     *                       ngày giao nhất. Tạm tính, nhưng có chứng từ để bấu víu.
     *  · `PROVISIONAL`    — chưa có phiếu nhập nào; lấy giá vốn Pancake ghi trên dòng hàng hoặc giá
     *                       nhập lưu ở mẫu mã. Tạm tính, chưa có chứng từ kho.
     *  · `NONE`           — không có nguồn nào. `recognized_cogs` là NULL = CHƯA BIẾT, **không phải 0**.
     *
     * Chủ shop chốt 11/09/2026: đơn đã giao KHÔNG được giữ giá vốn 0 chỉ vì phiếu nhập đến sau. Khi
     * xuất hiện căn cứ MẠNH HƠN (phiếu nhập kho), giá vốn được chốt lại ĐÚNG MỘT LẦN, có nhật ký
     * (`trued_up_*`), rồi đóng băng hẳn. Xem `rematerializeOutcomes()`.
     *
     * Đo trên production 09/09/2026: shop chỉ có 2 phiếu nhập, cả hai ngày 03/09, trong khi đơn giao
     * sớm nhất từ 22/01; 0/2.495 dòng hàng có giá vốn Pancake, 0/37 mẫu mã có giá nhập. Nên
     * **368/407 đơn đã giao mang căn cứ `RECEIPT_AFTER`** — 58 triệu giá vốn suy ngược. Con số đó
     * phải HIỆN RA, không được lẫn vào lợi nhuận như thể đã kiểm chứng.
     */
    cogsBasis: text("cogs_basis"),
    /**
     * LẦN CHỐT LẠI DUY NHẤT. `NULL` = chưa từng chốt lại (vẫn còn quyền chốt lại một lần khi có chứng
     * từ mạnh hơn). Khác NULL = đã dùng quyền đó, từ nay giá vốn đóng băng tuyệt đối.
     */
    truedUpAt: ts("trued_up_at"),
    /** Giá vốn TRƯỚC lần chốt lại (để truy nguyên; NULL nếu trước đó là CHƯA BIẾT). */
    truedUpFrom: integer("trued_up_from"),
    /** Căn cứ TRƯỚC lần chốt lại. */
    truedUpFromBasis: text("trued_up_from_basis"),
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
  (t) => [
    index("audit_entity_created_idx").on(t.entity, t.createdAt),
    index("audit_created_idx").on(t.createdAt),
    // Dòng thời gian của đơn tra nhật ký theo `entity_id` (mã đơn + mã các vận đơn). Không có chỉ mục
    // này là quét tuần tự bảng tăng nhanh nhất CSDL mỗi lần mở chi tiết đơn.
    index("audit_entity_id_idx").on(t.entityId, t.createdAt),
  ],
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

/**
 * ═══════════ GHI CHÚ VẬN HÀNH CHO SẢN PHẨM / MẪU MÃ ═══════════
 *
 * Cột `products.note` đã có, nhưng nó là ô ghi chú ĐỒNG BỘ TỪ PANCAKE: màn hình hiện nó ra và
 * không có đường nào để người trong shop viết vào. Viết đè lên cột đó sai hai lần — lần đồng bộ
 * sau ghi đè mất, và không ai biết ai viết lúc nào.
 *
 * Bảng này CHỈ THÊM. Ghi chú là thứ người ta đọc để hiểu bối cảnh ("lô này vải mỏng hơn mẫu",
 * "size L hay bị chật"), nên sửa đè lên một dòng cũ là xoá mất điều ai đó đã quan sát được.
 *
 * ─── GHI CHÚ KHÔNG ĐƯỢC CHẠM VÀO MỘT CON SỐ NÀO ───
 *
 * Không truy vấn báo cáo nào được đọc bảng này. Một ô chữ tự do mà ảnh hưởng tới tồn kho, giá vốn
 * hay lợi nhuận là đường ngắn nhất để một câu ghi vội thành một con số trong báo cáo tài chính.
 * `tests/product-notes.test.ts` quét mã nguồn và khoá điều đó lại.
 */
export const productNotes = pgTable(
  "product_notes",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** `NULL` = ghi chú cho cả sản phẩm; có giá trị = ghi chú riêng cho một mẫu mã. */
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** Danh sách ĐÓNG — ô gõ tự do sẽ sinh ra ba cách viết cho cùng một nhóm. */
    category: text("category").notNull().default("OTHER"),
    body: text("body").notNull(),
    /** `users.id`. `NULL` = job/nhập liệu máy, KHÁC HẲN "chưa biết ai" (lib/constants/actor.ts). */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP TÊN để người đọc. Do MÁY CHỦ đọc từ `users`, không nhận từ client. */
    actorName: text("actor_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("product_notes_product_idx").on(t.productId, t.createdAt),
    check("product_notes_category_check", sql`${t.category} IN ('QUALITY', 'SIZING', 'SUPPLIER', 'PRICING', 'PACKAGING', 'OTHER')`),
    // Ghi chú rỗng là nhiễu vĩnh viễn: nó chiếm chỗ "ghi chú mới nhất" và đẩy ghi chú thật xuống.
    check("product_notes_body_check", sql`length(btrim(${t.body})) > 0`),
  ],
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
    // Do migration 0065 tạo (chấm rủi ro theo tỉnh); khai ở đây để drizzle-kit không đề nghị xoá.
    index("orders_ship_province_idx").on(t.shipProvince).where(sql`${t.shipProvince} <> ''`),
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
    /**
     * ═══ TÀI KHOẢN API CÓ ĐỌC ĐƯỢC VẬN ĐƠN NÀY KHÔNG ═══
     *
     * `API_TRACKABLE` · `WEBHOOK_ONLY` · `UNKNOWN_CAPABILITY` (xem lib/constants/logistics-freshness.ts).
     *
     * Đo được 11/09/2026: nguồn `VTP_POLL` sinh ra **0 sự kiện** từ trước tới nay, trong khi
     * `sync_runs` ghi "tài khoản API không thấy vận đơn nào — lượt thứ 548 liên tiếp". Vận đơn do
     * Pancake tạo thuộc một tài khoản Viettel Post khác. ERP vẫn đều đặn gọi một API không bao giờ
     * trả về gì: không sai số liệu, nhưng tốn request và làm log đầy tiếng ồn che mất lỗi thật.
     *
     * Kết luận theo TỪNG VẬN ĐƠN chứ không theo tài khoản — để ngày shop trỏ ERP về đúng tài khoản
     * thì vận đơn mới tự được xếp lại đúng mà không cần sửa gì.
     */
    trackingCapability: text("tracking_capability").notNull().default("UNKNOWN_CAPABILITY"),
    /** Số lần đã tra mà API trả "không thấy". Tới ngưỡng thì kết luận `WEBHOOK_ONLY`. */
    capabilityProbes: integer("capability_probes").notNull().default(0),
    lastPancakeSyncAt: ts("last_pancake_sync_at"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shipments_order_idx").on(t.orderId),
    // Trang Vận đơn lọc kỳ và sắp mặc định theo ngày tạo; năm bộ đếm facet dùng cùng vị ngữ.
    index("shipments_created_idx").on(t.createdAt),
    index("shipments_vtp_number_idx").on(t.vtpOrderNumber),
    index("shipments_stage_idx").on(t.stage),
    index("shipments_cod_status_idx").on(t.codStatus),
    index("shipments_carrier_idx").on(t.carrier),
    index("shipments_tracking_idx").on(t.trackingCode),
    index("shipments_final_sync_idx").on(t.isFinal, t.lastVtpSyncAt),
    index("shipments_capability_idx").on(t.trackingCapability, t.isFinal),
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
    /** Danh tính người kho nhận kiện. `NULL` = chưa nối được về tài khoản (dòng cũ, hoặc job ghi hộ). */
    receivedByUserId: text("received_by_user_id").references(() => users.id, { onDelete: "set null" }),
    inspectedAt: ts("inspected_at"),
    inspectedBy: text("inspected_by"),
    /** Danh tính người đếm. Ràng buộc `inspected_check` vẫn đứng trên cột CHỮ vì dòng lịch sử không có id. */
    inspectedByUserId: text("inspected_by_user_id").references(() => users.id, { onDelete: "set null" }),
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
 * ───────────── KẾT QUẢ ĐẾM THEO TỪNG MÓN ─────────────
 *
 * VÌ SAO PHẢI LÀ BẢNG RIÊNG. `return_inspections` có grain MỘT DÒNG MỘT KIỆN: một `condition`, một
 * `restock_qty` cho cả kiện. Một kiện ba món hoàn toàn có thể vừa đủ một món, vừa thiếu một món,
 * vừa hỏng một món — ép cả kiện về một kết luận là vứt đúng phần thông tin mà người kho vừa bỏ
 * công đếm ra, và sau đó không ai trả lời được "mã nào hay bị trả về hỏng".
 *
 * Nhét kết quả từng món vào cột `note` dạng JSON thì không đếm được, không lọc được, không ràng
 * buộc được — và biến một cột đang có nghĩa "lý do người kiểm ghi" thành hai nghĩa. Nên là bảng.
 *
 * QUAN HỆ VỚI TỒN KHO: bảng này KHÔNG đụng tồn. Nó chỉ ghi lại người kho đã thấy gì. Tồn vẫn chỉ
 * đổi qua `stock_receipts` / `stock_receipt_items` như mọi đường khác, và chỉ cho món kết luận `OK`.
 *
 * HÀNG KỲ VỌNG ĐƯỢC CHỤP LẠI TẠI LÚC KIỂM, không đọc sống từ đơn: đơn có thể bị sửa, mẫu mã có thể
 * bị xoá hoặc đổi tên sau đó. Muốn biết "lúc đếm, kho tưởng sẽ nhận được gì" thì phải giữ đúng ảnh
 * chụp ấy — nếu không, phần lệch sẽ tự biến mất khi dữ liệu gốc đổi.
 */
export const returnInspectionItems = pgTable(
  "return_inspection_items",
  {
    id: id(),
    inspectionId: text("inspection_id")
      .notNull()
      .references(() => returnInspections.id, { onDelete: "cascade" }),
    /** Lặp lại để lọc/đếm theo kiện mà không phải nối bảng — kiện là thứ người kho cầm trên tay. */
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),

    // ── Hàng KỲ VỌNG (ảnh chụp tại lúc kiểm) ──
    expectedVariantId: text("expected_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    expectedSku: text("expected_sku").notNull().default(""),
    expectedName: text("expected_name").notNull().default(""),
    expectedColor: text("expected_color").notNull().default(""),
    expectedSize: text("expected_size").notNull().default(""),
    expectedQty: integer("expected_qty").notNull().default(0),

    // ── Hàng THỰC NHẬN ──
    /** Khác `expected_variant_id` khi khách trả về nhầm mẫu mã. */
    actualVariantId: text("actual_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    actualSku: text("actual_sku").notNull().default(""),
    actualQty: integer("actual_qty").notNull().default(0),

    /** OK · SHORT · WRONG_ITEM · DAMAGED · DIRTY · UNSELLABLE · OTHER */
    condition: text("condition").notNull(),
    note: text("note").notNull().default(""),
    inspectedBy: text("inspected_by").notNull().default(""),
    inspectedByUserId: text("inspected_by_user_id").references(() => users.id, { onDelete: "set null" }),
    inspectedAt: ts("inspected_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("return_inspection_items_inspection_idx").on(t.inspectionId),
    index("return_inspection_items_shipment_idx").on(t.shipmentId),
    /** Hỏi "mã Q002 bị trả về bao nhiêu, hỏng mấy cái" phải quét được theo mẫu mã. */
    index("return_inspection_items_variant_idx").on(t.expectedVariantId),
    /*
      Danh sách PHẢI khớp `ITEM_CONDITIONS` ở lib/constants/return-lifecycle.ts.
      Đã có tiền lệ lệch giữa hằng số TypeScript và ràng buộc SQL (`WRONG_ITEM` của bảng kiểm cả
      kiện): người kho bấm một nút hợp lệ và nhận lỗi ràng buộc, đúng lúc đang đứng đếm hàng.
    */
    check("return_inspection_items_condition_check", sql`${t.condition} IN ('OK', 'SHORT', 'WRONG_ITEM', 'DAMAGED', 'DIRTY', 'UNSELLABLE', 'OTHER')`),
    check("return_inspection_items_qty_check", sql`${t.expectedQty} >= 0 AND ${t.actualQty} >= 0`),
    // Không "đủ" mà không nói vì sao thì phần hàng mất biến mất không dấu vết.
    check("return_inspection_items_reason_check", sql`${t.condition} = 'OK' OR length(trim(${t.note})) > 0`),
  ],
);

/**
 * ═══════ CHỨNG CỨ ĐỐI SOÁT SỔ HÀNG HOÀN VIẾT TAY (một lần) ═══════
 *
 * Một lượt đối soát giữa bảng tính hàng hoàn của kho và ERP để lại một dòng cho MỖI dòng nguồn —
 * kể cả dòng KHÔNG khớp. Dòng không khớp mới là phần đáng đọc: nó nói hai sổ lệch nhau ở đâu, và
 * nếu chỉ lưu dòng khớp thì lần sau lại phải mở bảng tính ra mới biết đã bỏ qua những gì.
 *
 * `idempotency_key` bám vào NỘI DUNG dòng (bảng tính · sheet · mã vận đơn · dòng chữ sản phẩm ·
 * lần xuất hiện thứ mấy), KHÔNG bám vào số dòng: chèn thêm một dòng ở đầu tệp không được biến cả
 * lượt chạy lại thành một lượt ghi mới.
 *
 * BẢNG NÀY KHÔNG ĐỤNG TỒN KHO và không đụng vòng đời kiện. Nó chỉ ghi lại lượt đối soát đã kết
 * luận gì. Việc ghi nhận kiện đã về vẫn đi qua `return_inspections` như mọi đường khác.
 */
export const hmtReturnReconciliation = pgTable(
  "hmt_return_reconciliation",
  {
    id: id(),
    /** Nhãn bảng tính nguồn — nhiều lượt đối soát từ nhiều tệp phải phân biệt được. */
    workbook: text("workbook").notNull(),
    sheet: text("sheet").notNull(),
    sheetRole: text("sheet_role").notNull(),
    /** Số dòng như Excel hiện, để người mở tệp nhảy được tới đúng chỗ. */
    sourceRow: integer("source_row").notNull().default(0),
    trackingRaw: text("tracking_raw").notNull().default(""),
    trackingKey: text("tracking_key").notNull().default(""),
    /** OWN_CELL · MERGED_CELL · NONE — vì sao dòng này mang mã vận đơn đó. */
    inheritance: text("inheritance").notNull().default("OWN_CELL"),
    productText: text("product_text").notNull().default(""),
    productCode: text("product_code").notNull().default(""),
    color: text("color").notNull().default(""),
    size: text("size").notNull().default(""),
    /** Mẫu mã lần ra được. `NULL` = chưa lần ra — KHÁC hẳn với "không có mẫu mã nào". */
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    sku: text("sku").notNull().default(""),
    quantity: integer("quantity").notNull().default(0),
    shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "cascade" }),
    matchStatus: text("match_status").notNull(),
    detail: text("detail").notNull().default(""),
    /** Dòng này có dẫn tới một lượt ghi vào ERP hay không. Chỉ `MATCHED` được `true`. */
    written: boolean("written").notNull().default(false),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull().default(""),
    processedAt: ts("processed_at").notNull().defaultNow(),

    /*
      ═══ KẾT LUẬN CỦA NGƯỜI, TÁCH HẲN KHỎI KẾT LUẬN CỦA MÁY ═══

      `match_status` là MÁY đọc sổ giấy ra được gì. Bảy cột dưới đây là NGƯỜI nhìn hàng thật kết
      luận gì. Ghi đè cái sau lên cái trước là mất dấu vì sao máy không khớp được — và lần sau
      không ai sửa được luật đọc.

      `NULL` = CHƯA AI XỬ LÝ, và đó là phần lớn. Nó KHÔNG phải "đã xem xong".

      Ràng buộc ở CSDL (0083) giữ bốn điều: danh sách cách gỡ là ĐÓNG · gỡ rồi thì phải có người +
      mốc + lý do · "đã nối kiện" phải chỉ đích danh một kiện và "đã chọn mẫu mã" phải chỉ đích
      danh một mẫu mã · và dòng ĐÃ GHI (`written`) thì không gắn kết luận người lên được.
    */
    /** `LINKED_SHIPMENT` · `RESOLVED_SKU` · `DISMISSED` — xem `HMT_RESOLUTIONS`. */
    resolution: text("resolution"),
    resolvedShipmentId: text("resolved_shipment_id").references(() => shipments.id, { onDelete: "set null" }),
    resolvedVariantId: text("resolved_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** Ảnh chụp TÊN người gỡ — người nghỉ việc thì dòng vẫn đọc được. */
    resolvedBy: text("resolved_by").notNull().default(""),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** BẮT BUỘC khi có kết luận: một dòng biến mất không lời giải thích sẽ quay lại làm phiền người sau. */
    resolutionNote: text("resolution_note").notNull().default(""),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("hmt_return_rec_shipment_idx").on(t.shipmentId),
    index("hmt_return_rec_status_idx").on(t.matchStatus),
    index("hmt_return_rec_tracking_idx").on(t.trackingKey),
    /* Danh sách PHẢI khớp `HMT_MATCH_STATUSES` ở lib/constants/hmt-returns.ts — đã có tiền lệ lệch
       giữa hằng số TypeScript và ràng buộc SQL (`WRONG_ITEM` của bảng kiểm cả kiện). */
    check(
      "hmt_return_rec_status_check",
      sql`${t.matchStatus} IN ('MATCHED', 'ALREADY_RECEIVED', 'AMBIGUOUS_TRACKING', 'AMBIGUOUS_SKU', 'SKU_MISMATCH', 'QUANTITY_CONFLICT', 'UNMATCHED_TRACKING', 'DUPLICATE_SOURCE_ROW', 'CONFLICT')`,
    ),
    check("hmt_return_rec_inheritance_check", sql`${t.inheritance} IN ('OWN_CELL', 'MERGED_CELL', 'NONE')`),
    /* Chỉ dòng KHỚP mới được đánh dấu đã ghi. Chặn ở CSDL vì đây là ranh giới giữa "đã đối chiếu"
       và "đã đổi dữ liệu" — một dòng `written = true` mang trạng thái khác là một lượt ghi không
       ai giải thích được. */
    check("hmt_return_rec_written_check", sql`${t.written} = false OR ${t.matchStatus} = 'MATCHED'`),
    index("hmt_return_rec_resolution_idx").on(t.resolution, t.matchStatus),
    check("hmt_return_rec_resolution_check", sql`${t.resolution} IS NULL OR ${t.resolution} IN ('LINKED_SHIPMENT', 'RESOLVED_SKU', 'DISMISSED')`),
    check("hmt_return_rec_resolution_actor_check", sql`${t.resolution} IS NULL OR (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} <> '' AND ${t.resolutionNote} <> '')`),
    check("hmt_return_rec_resolution_target_check", sql`${t.resolution} IS DISTINCT FROM 'LINKED_SHIPMENT' OR ${t.resolvedShipmentId} IS NOT NULL`),
    check("hmt_return_rec_resolution_sku_check", sql`${t.resolution} IS DISTINCT FROM 'RESOLVED_SKU' OR ${t.resolvedVariantId} IS NOT NULL`),
    /* 724 dòng đã ghi là chứng cứ nhận hàng của 672 kiện — không viết đè lên chúng. */
    check("hmt_return_rec_resolution_written_check", sql`${t.resolution} IS NULL OR ${t.written} = false`),
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
/**
 * ════════════ TÀI KHOẢN NGÂN HÀNG ════════════
 *
 * Trước đây `bank_transactions.account` là một ô chữ tự do và luôn rỗng, vì sao kê tải tay không
 * nói tài khoản nào — người nhập tự biết. Realtime thì không: một webhook SePay có thể tới từ bất
 * kỳ tài khoản nào đã nối, nên phải có thực thể tài khoản thì mới trả lời được "đồng tiền này ở
 * tài khoản nào" và "số dư từng tài khoản là bao nhiêu".
 *
 * KHOÁ TỰ NHIÊN = nhà cung cấp + cổng ngân hàng + số tài khoản + tài khoản phụ. `sub_account` là
 * tài khoản ảo (VA) của SePay: cùng một số tài khoản gốc có thể sinh nhiều VA, và tiền vào VA là
 * tiền vào tài khoản gốc — nhưng phải phân biệt được thì mới đối chiếu đơn hàng theo VA.
 *
 * `UNCONFIRMED` = ERP tự tạo khi thấy một tài khoản lạ trong gói tin đã xác thực chữ ký. Không
 * chặn tiền lại: gói tin qua được HMAC nghĩa là nó đến từ chính tài khoản SePay của shop, nên tài
 * khoản đó có thật. Việc của người là ĐẶT TÊN và xác nhận, không phải đi cứu giao dịch bị chặn.
 */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: id(),
    /** '' = tài khoản khai tay (sao kê tải về), 'SEPAY' = nhận diện từ gói tin SePay */
    provider: text("provider").notNull().default(""),
    /** Tên ngân hàng do nhà cung cấp đặt: MBBank, Vietcombank, ACB… KHÔNG hard-code ngân hàng nào. */
    gateway: text("gateway").notNull().default(""),
    accountNumber: text("account_number").notNull(),
    /** Tài khoản ảo (VA) nếu có — '' là tài khoản gốc. */
    subAccount: text("sub_account").notNull().default(""),
    /** Tên người đọc hiểu. ERP tự sinh khi mới thấy, người sửa lại sau. */
    label: text("label").notNull().default(""),
    currency: text("currency").notNull().default("VND"),
    /** ACTIVE = đã xác nhận · UNCONFIRMED = ERP tự thấy, chờ người đặt tên · DISABLED = ngừng dùng */
    status: text("status").notNull().default("UNCONFIRMED"),
    note: text("note").notNull().default(""),
    /** Gói tin gần nhất chạm tới tài khoản này — để biết tài khoản còn sống hay đã ngừng đổ dữ liệu. */
    lastSeenAt: ts("last_seen_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bank_accounts_natural_uq").on(t.provider, t.gateway, t.accountNumber, t.subAccount),
    index("bank_accounts_status_idx").on(t.status),
    check("bank_accounts_status_check", sql`${t.status} IN ('ACTIVE', 'UNCONFIRMED', 'DISABLED')`),
  ],
);

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
    /**
     * NGUỒN GỐC, KHÔNG PHẢI DANH TÍNH.
     *
     * Đường vào đã TẠO dòng này. Bất biến sau khi tạo. Cùng một giao dịch ngân hàng có thể được
     * nhiều đường xác nhận (webhook báo trước, sao kê tải về sau) — nhưng chỉ có MỘT dòng, và
     * `seen_sources` mới là nơi ghi đủ các đường đã xác nhận nó.
     *
     * IMPORT = sao kê · MANUAL = gõ tay · WEBHOOK = SePay đẩy realtime · API = truy vấn đối chiếu
     */
    source: text("source").notNull().default("IMPORT"),
    /** Nhà cung cấp đã đẩy dòng này về: '' (sao kê tải tay) hoặc 'SEPAY'. */
    provider: text("provider").notNull().default(""),
    /**
     * DANH TÍNH GIAO HÀNG của nhà cung cấp (`id` trong gói tin SePay) — KHÁC danh tính kinh tế.
     *
     * SePay gửi lại tối đa 7 lần trong 5 giờ. Ràng buộc DUY NHẤT trên cột này là thứ khiến gửi lại
     * KHÔNG THỂ đẻ dòng thứ hai, kể cả hai gói tin tới cùng lúc — chống trùng bằng mã ứng dụng
     * thôi thì vẫn thua điều kiện tranh chấp.
     *
     * NGƯỜI ĐẦU TIÊN THẮNG: đã có mã rồi thì gói tin sau không ghi đè. Hai mã SePay khác nhau cùng
     * trỏ về một giao dịch ngân hàng là bất thường — phải nêu ra, không được im lặng thay mã.
     */
    providerTxnId: text("provider_txn_id").notNull().default(""),
    /** Tài khoản ngân hàng phát sinh. NULL = chưa nhận diện được (sao kê tải tay đời cũ). */
    bankAccountId: text("bank_account_id"),
    /** Đường vào xác nhận dòng này gần nhất. */
    lastSeenSource: text("last_seen_source").notNull().default(""),
    /** Toàn bộ provenance: [{source, provider, at, ref}] — mỗi lần một đường xác nhận thì thêm một mục. */
    seenSources: jsonb("seen_sources").notNull().default(sql`'[]'::jsonb`),
    /**
     * Số dư luỹ kế sau giao dịch, theo ngân hàng.
     *
     * NULL = CHƯA BIẾT, không phải 0. Đây là mỏ neo đối chiếu mạnh nhất của cả sổ: xếp theo thời
     * gian thì `balance_after[i] − balance_after[i−1]` phải bằng `amount[i]`. Đứt chuỗi = thiếu
     * giao dịch; bước không khớp = trùng giao dịch.
     */
    balanceAfter: integer("balance_after"),
    /**
     * LƯỚI AN TOÀN, KHÔNG PHẢI KHOÁ. Cố ý KHÔNG unique.
     *
     * Hai dòng cùng `match_key` mà khác `bank_ref` thì ERP nêu ra để người xem, TUYỆT ĐỐI không tự
     * gộp: hai lần chuyển cùng số tiền cho cùng một người trong cùng một phút là chuyện có thật, và
     * tự gộp là xoá tiền thật.
     */
    matchKey: text("match_key").notNull().default(""),
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
    // ẢNH CHỤP MỐI NỐI CHÍNH, KHÔNG PHẢI NGUỒN SỰ THẬT. Nguồn là `bank_transaction_links` (nhiều–nhiều,
    // có số tiền). Hai cột này giữ mối nối LỚN NHẤT để màn hình cũ và bộ lọc cũ chạy y nguyên; chúng
    // được một hàm duy nhất ghi lại (`syncPrimaryLink`) và một bài kiểm khoá chúng luôn khớp bảng nối.
    check("bank_txn_linked_check", sql`${t.linkedType} IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION')`),
    // Có loại thì phải có mã, và ngược lại — nửa vời thì đối chiếu không lần ra được gì.
    check("bank_txn_linked_pair_check", sql`(${t.linkedType} = '' AND ${t.linkedId} = '') OR (${t.linkedType} <> '' AND length(${t.linkedId}) > 0)`),
    // Số tiền 0 không phải giao dịch; chiều tiền phải rõ ràng.
    check("bank_txn_amount_check", sql`${t.amount} <> 0`),
    check("bank_txn_source_check", sql`${t.source} IN ('IMPORT', 'MANUAL', 'WEBHOOK', 'API')`),
    // CHỐNG TRÙNG Ở TẦNG CSDL, không phải ở tầng ứng dụng: gói tin gửi lại (SePay thử tối đa 7 lần)
    // hoặc hai gói tin cùng lúc đều không thể đẻ dòng thứ hai cho cùng một mã giao dịch nhà cung cấp.
    uniqueIndex("bank_txn_provider_uq").on(t.provider, t.providerTxnId).where(sql`${t.providerTxnId} <> ''`),
    index("bank_txn_match_idx").on(t.matchKey),
    index("bank_txn_account_idx").on(t.bankAccountId, t.txnAt),
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

/**
 * ═══════════ MỐI NỐI GIỮA TIỀN THẬT VÀ CHỨNG TỪ ═══════════
 *
 * Hợp đồng: `docs/finance-truth-contract.md`. Hằng số: `lib/constants/finance-truth.ts`.
 *
 * VÌ SAO KHÔNG DÙNG `bank_transactions.linked_type/linked_id`. Hai cột đó chỉ chứa được MỘT mối nối
 * không mang số tiền, nên ba tình huống thường ngày của shop không diễn tả được:
 *
 *   · một khoản chi 20 triệu trả làm ba lần → ba dòng tiền cùng trỏ về một khoản chi, mỗi dòng một phần;
 *   · một chuyển khoản 30 triệu trả hai phiếu nhập 20 + 10 → một dòng tiền, hai chứng từ;
 *   · trả một phần rồi còn nợ → phải biết đã trả bao nhiêu mới nói được "còn nợ bao nhiêu".
 *
 * Không có số tiền phân bổ thì "khoản chi này đã trả chưa" chỉ có hai câu trả lời đúng/sai, trong
 * khi thực tế là một con số. Bảng này là quan hệ NHIỀU–NHIỀU CÓ SỐ TIỀN.
 *
 * MỐI NỐI KHÔNG TẠO RA TIỀN VÀ KHÔNG TẠO RA CHI PHÍ. Nó chỉ nói "đồng tiền này ứng với khoản kia".
 * Không báo cáo nào được cộng số tiền ở đây vào doanh thu, chi phí, hay lợi nhuận — chúng đã được
 * ghi nhận ở sổ có thẩm quyền của chúng. Cộng vào là đếm đôi, đúng thứ bảng này sinh ra để chặn.
 *
 * MỖI DÒNG LÀ MỘT KHẲNG ĐỊNH CÓ NGƯỜI CHỊU TRÁCH NHIỆM: `confirmed_by` không bao giờ rỗng. Máy tự
 * nối thì ghi `auto:exact`, và CHỈ mức `EXACT` (có mã chứng từ trong nội dung chuyển khoản) mới
 * được tự nối — mọi mức thấp hơn phải có người bấm. Lịch sử thay đổi nằm ở `audit_logs`.
 */
export const bankTransactionLinks = pgTable(
  "bank_transaction_links",
  {
    id: id(),
    txnId: text("txn_id").notNull(),
    /** EXPENSE · COD_BATCH · STOCK_RECEIPT · AD_SPEND · PAYROLL_PERIOD · BANK_TRANSACTION */
    targetType: text("target_type").notNull(),
    /**
     * Mã chứng từ đích. Với `PAYROLL_PERIOD` là tháng `YYYY-MM` — bảng Lương là cấu hình chứ không
     * phải bảng dữ liệu nên khoá tự nhiên của một kỳ lương chính là tháng của nó.
     */
    targetId: text("target_id").notNull(),
    /**
     * Phần số tiền CỦA DÒNG TIỀN NÀY được phân bổ cho chứng từ kia. Luôn DƯƠNG: chiều tiền đã nằm ở
     * dấu của `bank_transactions.amount`, lặp lại dấu ở đây chỉ tạo thêm một chỗ để cộng sai dấu.
     *
     * Tổng phân bổ của một dòng tiền không được vượt trị tuyệt đối số tiền của nó — vượt nghĩa là
     * cùng một đồng đang đánh dấu hai nghĩa vụ đã trả. Ràng buộc này cần đọc các dòng anh em nên
     * nằm ở tầng dịch vụ (`lib/queries/finance-linkage.ts`), có kiểm thử khoá.
     */
    amount: integer("amount").notNull(),
    /** EXACT · HIGH_CONFIDENCE · MANUAL. Nhập nhằng KHÔNG được lưu — mối nối là một khẳng định. */
    confidence: text("confidence").notNull().default("MANUAL"),
    /** IDENTIFIER_MATCH · AMOUNT_DATE_MATCH · MANUAL · TRANSFER_PAIR */
    method: text("method").notNull().default("MANUAL"),
    /** Email người xác nhận, hoặc `auto:exact` khi máy tự nối. KHÔNG BAO GIỜ rỗng. */
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: ts("confirmed_at").notNull().defaultNow(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Một dòng tiền nối tới cùng một chứng từ HAI lần là đếm đôi ngay trong chính bảng chống đếm đôi.
    uniqueIndex("bank_txn_links_uq").on(t.txnId, t.targetType, t.targetId),
    index("bank_txn_links_txn_idx").on(t.txnId),
    // "Khoản chi này đã trả bao nhiêu" phải tra được từ phía CHỨNG TỪ, không chỉ từ phía dòng tiền.
    index("bank_txn_links_target_idx").on(t.targetType, t.targetId),
    check("bank_txn_links_amount_check", sql`${t.amount} > 0`),
    check("bank_txn_links_target_type_check", sql`${t.targetType} IN ('EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION')`),
    check("bank_txn_links_confidence_check", sql`${t.confidence} IN ('EXACT', 'HIGH_CONFIDENCE', 'MANUAL')`),
    check("bank_txn_links_method_check", sql`${t.method} IN ('IDENTIFIER_MATCH', 'AMOUNT_DATE_MATCH', 'MANUAL', 'TRANSFER_PAIR')`),
    // Khẳng định không có người chịu trách nhiệm thì không kiểm chứng được.
    check("bank_txn_links_actor_check", sql`length(trim(${t.confirmedBy})) > 0`),
    // Kỳ lương phải là tháng YYYY-MM; nối vào một chuỗi tự do thì không bao giờ tổng hợp lại được.
    check("bank_txn_links_payroll_period_check", sql`${t.targetType} <> 'PAYROLL_PERIOD' OR ${t.targetId} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    // Chân kia của một lần chuyển nội bộ không thể là chính nó.
    check("bank_txn_links_self_check", sql`${t.targetType} <> 'BANK_TRANSACTION' OR ${t.targetId} <> ${t.txnId}`),
    foreignKey({ columns: [t.txnId], foreignColumns: [bankTransactions.id], name: "bank_txn_links_txn_fk" }).onDelete("cascade"),
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
    /** NULL = CHƯA CÓ GIÁ, máy không được báo giá cho mẫu test này. */
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

// ───────────────────────── NỀN TẢNG NHÂN SỰ AI ─────────────────────────
//
// Mười ba bảng dưới đây là hạ tầng DÙNG CHUNG cho mọi nhân sự AI sau này, không phải hạ tầng
// riêng của bán hàng: bốn bảng đầu (`ai_agents` … `ai_runs`) không có một cột nào nhắc tới đơn
// hàng hay hội thoại. Miền bán hàng nằm gọn trong nhóm `sales_*` ở cuối.
//
// Nguyên tắc chung với phần còn lại của ERP: nền tảng AI KHÔNG giữ sự thật nghiệp vụ. Không bảng
// nào ở đây được dùng làm nguồn cho giá, tồn, tiền, kết quả đơn hay trạng thái vận đơn.

/** Sổ đăng ký nhân sự AI. Mỗi dòng là một "nhân viên máy" với nấc quyền hạn riêng. */
export const aiAgents = pgTable(
  "ai_agents",
  {
    id: id(),
    /** Khoá ổn định dùng trong mã nguồn (`sales`), KHÔNG đổi — lượt chạy cũ đã lưu nó. */
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** OFF · SHADOW · COPILOT · AUTO — xem `lib/constants/ai.ts`. Mặc định phải là nấc an toàn. */
    mode: text("mode").notNull().default("SHADOW"),
    enabled: boolean("enabled").notNull().default(true),
    /** Bản đang chạy; đổi bản là một dòng mới ở `ai_agent_versions`, không sửa đè. */
    activeVersionId: text("active_version_id"),
    /** Loại sự kiện mà nhân sự này nhận việc (theo `AI_EVENT_TYPES`). */
    subscribes: text("subscribes").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_agents_mode_idx").on(t.mode)],
);

/**
 * Bản của một nhân sự AI: lời dặn, danh sách công cụ được phép, cách định tuyến mô hình.
 * BẤT BIẾN sau khi tạo — lượt chạy trỏ tới bản cụ thể nên đọc lại lịch sử mới đúng bối cảnh.
 */
export const aiAgentVersions = pgTable(
  "ai_agent_versions",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Lời dặn hệ thống (không chứa bí mật, không chứa dữ liệu khách). */
    systemPrompt: text("system_prompt").notNull().default(""),
    /** Công cụ được phép gọi — cổng công cụ đối chiếu với đúng danh sách này. */
    allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`),
    /** Cấu hình định tuyến mô hình (nấc, tên mô hình, trần token) dạng JSON. */
    routing: jsonb("routing"),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ai_agent_versions_uq").on(t.agentId, t.version)],
);

/**
 * SỰ KIỆN NỘI BỘ — lớp chiếu từ miền nghiệp vụ sang nền tảng AI.
 * Chỉ mang khoá tra cứu, không mang bản sao trạng thái (xem `lib/constants/ai-events.ts`).
 */
export const aiEvents = pgTable(
  "ai_events",
  {
    id: id(),
    type: text("type").notNull(),
    source: text("source").notNull().default(""),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: jsonb("payload"),
    /** PENDING · DISPATCHED · IGNORED · FAILED */
    status: text("status").notNull().default("PENDING"),
    error: text("error"),
    /** Trùng khoá = cùng một sự việc, dù được đẩy lại bao nhiêu lần. NULL = không nhận dạng được. */
    dedupeKey: text("dedupe_key"),
    /** Mốc sự việc theo bên gửi, khác `created_at` là mốc ERP ghi nhận. */
    occurredAt: ts("occurred_at"),
    dispatchedAt: ts("dispatched_at"),
    /** Số lần cùng sự việc được đẩy tới (1 = lần đầu). */
    deliveryCount: integer("delivery_count").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ai_events_dedupe_uq").on(t.dedupeKey),
    index("ai_events_status_idx").on(t.status, t.createdAt),
    index("ai_events_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

/** Một việc giao cho nhân sự AI. Tách khỏi `ai_runs` vì một việc có thể chạy lại nhiều lượt. */
export const aiTasks = pgTable(
  "ai_tasks",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => aiEvents.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** PENDING · RUNNING · DONE · FAILED · CANCELLED */
    status: text("status").notNull().default("PENDING"),
    payload: jsonb("payload"),
    dedupeKey: text("dedupe_key"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_tasks_dedupe_uq").on(t.dedupeKey),
    index("ai_tasks_status_idx").on(t.status, t.createdAt),
    index("ai_tasks_agent_idx").on(t.agentId, t.createdAt),
  ],
);

/**
 * MỘT LƯỢT CHẠY — đơn vị quan sát. Mọi thứ cần để dựng lại một quyết định đều nằm ở đây hoặc
 * trỏ về đây: tin nhắn vào, trạng thái trước, ý định / thực thể bóc được, quyết định, câu gợi ý,
 * trạng thái sau, mô hình, token, chi phí, độ trễ, lỗi.
 */
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    agentVersionId: text("agent_version_id").references(() => aiAgentVersions.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => aiTasks.id, { onDelete: "set null" }),
    eventId: text("event_id").references(() => aiEvents.id, { onDelete: "set null" }),
    /** Nấc quyền hạn TẠI LÚC CHẠY — đọc lại sau này mới biết vì sao lượt đó không gửi tin. */
    mode: text("mode").notNull().default("SHADOW"),
    /** RUNNING · SUCCEEDED · FAILED · SKIPPED · HANDED_OFF */
    status: text("status").notNull().default("RUNNING"),
    subjectType: text("subject_type").notNull().default(""),
    subjectId: text("subject_id").notNull().default(""),
    /** Tin nhắn / dữ kiện đầu vào của lượt chạy. */
    input: jsonb("input"),
    stateBefore: jsonb("state_before"),
    stateAfter: jsonb("state_after"),
    /** Ý định và thực thể bóc được (đã qua kiểm lược đồ). */
    understanding: jsonb("understanding"),
    /** QUYẾT ĐỊNH — kết quả của hàm thuần, không phải văn bản mô hình. */
    decision: jsonb("decision"),
    /** Câu gợi ý cho nhân viên. Ở nấc SHADOW đây là TOÀN BỘ đầu ra, không gửi đi đâu cả. */
    suggestedReply: text("suggested_reply").notNull().default(""),
    /** Nấc xử lý cao nhất đã dùng: RULE · ECONOMY · STRONG · HUMAN. */
    tier: text("tier").notNull().default("RULE"),
    /** Vì sao phải leo nấc (nếu có). */
    escalationReason: text("escalation_reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** Chi phí ƯỚC TÍNH (VND). NULL = chưa khai đơn giá mô hình ⇒ CHƯA BIẾT, không phải 0đ. */
    costVnd: integer("cost_vnd"),
    /** Phiên bản bảng giá đã dùng cho tổng chi phí ở trên. Rỗng = không gọi mô hình / chưa khai giá. */
    pricingVersion: text("pricing_version").notNull().default(""),
    latencyMs: integer("latency_ms").notNull().default(0),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_runs_agent_started_idx").on(t.agentId, t.startedAt),
    index("ai_runs_subject_idx").on(t.subjectType, t.subjectId),
    index("ai_runs_status_idx").on(t.status, t.startedAt),
  ],
);

/** Mỗi lần nhân sự AI chạm vào ERP. Kể cả lần BỊ TỪ CHỐI — đó là dòng đáng giá nhất. */
export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(0),
    tool: text("tool").notNull(),
    /** OK · DENIED · ERROR · TIMEOUT */
    outcome: text("outcome").notNull().default("OK"),
    args: jsonb("args"),
    result: jsonb("result"),
    error: text("error"),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ai_tool_calls_run_idx").on(t.runId, t.seq), index("ai_tool_calls_tool_idx").on(t.tool, t.createdAt)],
);

/**
 * SỔ CHI PHÍ MÔ HÌNH. Một dòng cho mỗi lần gọi nhà cung cấp — kể cả lần lỗi, vì lần lỗi vẫn có
 * thể đã tính tiền token vào. `cost_vnd` NULL nghĩa là chưa khai đơn giá cho mô hình đó.
 */
export const aiModelCalls = pgTable(
  "ai_model_calls",
  {
    id: id(),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    tier: text("tier").notNull().default("ECONOMY"),
    /** Bước trong dây chuyền: understand · generate … */
    step: text("step").notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Token đầu vào đọc lại từ bộ nhớ đệm của nhà cung cấp (rẻ hơn). 0 = không dùng / không báo. */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    costVnd: integer("cost_vnd"),
    /**
     * Phiên bản bảng giá đã dùng để ra con số trên. Không có nó thì một lần đổi giá làm mọi con
     * số lịch sử đổi nghĩa mà không ai biết. Rỗng = chưa khai giá ⇒ `cost_vnd` phải là NULL.
     */
    pricingVersion: text("pricing_version").notNull().default(""),
    latencyMs: integer("latency_ms").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_model_calls_run_idx").on(t.runId), index("ai_model_calls_created_idx").on(t.createdAt)],
);

/** Phiếu duyệt của NGƯỜI cho một hành động của máy (dùng từ nấc COPILOT trở lên). */
export const aiApprovals = pgTable(
  "ai_approvals",
  {
    id: id(),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull().default(""),
    subjectId: text("subject_id").notNull().default(""),
    /** PENDING · APPROVED · REJECTED · EXPIRED */
    status: text("status").notNull().default("PENDING"),
    payload: jsonb("payload"),
    /** Khoá tài khoản người duyệt — quy kết đi bằng khoá, không bằng ô chữ. */
    decidedByUserId: text("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedByName: text("decided_by_name").notNull().default(""),
    decidedAt: ts("decided_at"),
    note: text("note").notNull().default(""),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_approvals_status_idx").on(t.status, t.createdAt)],
);

/** Lỗi của nền tảng AI, kể cả lỗi xảy ra NGOÀI một lượt chạy (gói tin hỏng, nạp hội thoại lỗi). */
export const aiErrors = pgTable(
  "ai_errors",
  {
    id: id(),
    /** WEBHOOK · INGEST · PIPELINE · TOOL · MODEL · OUTBOUND */
    scope: text("scope").notNull(),
    agentKey: text("agent_key").notNull().default(""),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    subjectType: text("subject_type").notNull().default(""),
    subjectId: text("subject_id").notNull().default(""),
    message: text("message").notNull(),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_errors_scope_idx").on(t.scope, t.createdAt)],
);

// ───────────────────────── Miền bán hàng ─────────────────────────

/**
 * HỘI THOẠI BÁN HÀNG. Trạng thái bán hàng do ERP giữ, không do mô hình nhớ.
 * `human_takeover_at` khác NULL là một cái phanh cứng: mọi hành động tự động dừng lại.
 */
export const salesConversations = pgTable(
  "sales_conversations",
  {
    id: id(),
    /** PANCAKE · LANDING · MANUAL */
    channel: text("channel").notNull().default("PANCAKE"),
    pageId: text("page_id").notNull().default(""),
    /** Mã hội thoại phía kênh — khoá tự nhiên cùng với `page_id`. */
    externalId: text("external_id").notNull(),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    pancakeCustomerId: text("pancake_customer_id").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    phone: text("phone").notNull().default(""),
    /** Giai đoạn bán hàng (`SALES_STAGES`). */
    stage: text("stage").notNull().default("NEW_LEAD"),
    /** Trạng thái chuẩn tắc của hội thoại: sản phẩm, mẫu mã, số lượng, địa chỉ, bản chốt đang chờ. */
    state: jsonb("state"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Đơn POS gắn với hội thoại (nếu đã lên đơn). */
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    /** Khác NULL = NGƯỜI đang cầm; máy không được hành động. */
    humanTakeoverAt: ts("human_takeover_at"),
    takeoverReason: text("takeover_reason").notNull().default(""),
    takeoverByUserId: text("takeover_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * ẢNH CHỤP NGỮ CẢNH BÁN — chốt một lần lúc hội thoại đủ điều kiện, sau đó BẤT BIẾN.
     *
     * Đây là điểm mấu chốt của cả mô hình: page đổi mẫu thắng Q004 → Q017 thì hội thoại CŨ vẫn
     * thuộc Q004. Đọc lại cấu hình hiện hành để diễn giải chuyện đã xảy ra là viết lại quá khứ —
     * khách được tư vấn mẫu nào, giá nào, là chuyện đã rồi.
     */
    sourceType: text("source_type").notNull().default(""),
    sourceKind: text("source_kind").notNull().default(""),
    sourceId: text("source_id").notNull().default(""),
    salesProfileId: text("sales_profile_id").references(() => fanpageSalesProfiles.id, { onDelete: "set null" }),
    /** Số phiên bản hồ sơ LÚC CHỤP, không phải số hiện tại. */
    salesProfileVersion: integer("sales_profile_version"),
    activeProductId: text("active_product_id").references(() => products.id, { onDelete: "set null" }),
    testProductId: text("test_product_id").references(() => testProductProfiles.id, { onDelete: "set null" }),
    /**
     * ĐIỀU KIỆN BÁN LÚC CHỤP — giá, phí ship, combo, màu, các chính sách.
     *
     * Chụp cả phần này chứ không chỉ mã hàng: khách được báo 499k thì cuộc ấy thuộc mức 499k, dù
     * hôm sau page đổi giá. Đọc lại bảng giá hiện hành để giải thích một câu đã nói là viết lại
     * quá khứ, y như với mã hàng.
     */
    offerSnapshot: jsonb("offer_snapshot"),
    /**
     * BẢN BẢNG SỐ ĐO LÚC CHỤP — chuỗi, vì máy gợi ý size đánh số bằng chuỗi ("dam-q004-2026-09").
     * Đổi bảng sau này không làm đổi lời tư vấn đã đưa.
     */
    sizeRuleVersion: text("size_rule_version").notNull().default(""),
    /** Bản CHÍNH SÁCH lúc chụp — khách được hứa đổi trong 7 ngày thì cuộc ấy thuộc mức 7 ngày. */
    policyVersion: integer("policy_version"),
    /** Sổ dữ kiện đã duyệt ở phiên bản nào — để dựng lại được vì sao máy nói câu đó. */
    knowledgeVersion: integer("knowledge_version"),
    /** Luật nguồn nào đã áp (nếu có). NULL = rơi về mặc định của fanpage. */
    sourceRuleId: text("source_rule_id").references(() => salesSourceRules.id, { onDelete: "set null" }),
    /** SNAPSHOT · SOURCE_RULE · AD_MAP · FANPAGE_DEFAULT · NONE */
    classificationSource: text("classification_source").notNull().default(""),
    classificationConfidence: doublePrecision("classification_confidence"),
    classifiedAt: ts("classified_at"),
    lastCustomerMessageAt: ts("last_customer_message_at"),
    lastShopMessageAt: ts("last_shop_message_at"),
    lastRunAt: ts("last_run_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_conversations_external_uq").on(t.pageId, t.externalId),
    index("sales_conversations_stage_idx").on(t.stage, t.updatedAt),
    index("sales_conversations_takeover_idx").on(t.humanTakeoverAt),
  ],
);

/**
 * TIN NHẮN. `external_id` là khoá chống trùng: webhook gửi lại, job nạp lại, cả hai cùng chạy —
 * đều không được đẻ thêm dòng. `from_page` = tin của shop; máy KHÔNG BAO GIỜ phản ứng với nó
 * (đó là cách một con bot tự nói chuyện với chính mình).
 */
export const salesMessages = pgTable(
  "sales_messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull().default(""),
    /** IN = khách gửi · OUT = shop gửi */
    direction: text("direction").notNull().default("IN"),
    fromPage: boolean("from_page").notNull().default(false),
    /** Tin này do nhân sự AI gửi (chỉ có thể xảy ra từ nấc COPILOT trở lên). */
    fromAgent: boolean("from_agent").notNull().default(false),
    fromName: text("from_name").notNull().default(""),
    text: text("text").notNull().default(""),
    hasAttachment: boolean("has_attachment").notNull().default(false),
    /** Số tệp đính kèm. 0 với `has_attachment = true` nghĩa là biết CÓ mà chưa đếm được. */
    attachmentCount: integer("attachment_count").notNull().default(0),
    /**
     * AI GỬI: CUSTOMER · PAGE_HUMAN (nhân viên) · PAGE_BOT (Botcake/tự động) · UNKNOWN.
     * Tách PAGE_HUMAN khỏi PAGE_BOT là điều kiện để so sánh AI với NGƯỜI: gộp chúng lại thì
     * một tin do bot cũ gửi sẽ bị tính là "câu nhân viên trả lời" và mọi phép đo đều sai.
     */
    senderType: text("sender_type").notNull().default("UNKNOWN"),
    /** facebook · instagram · … theo khai báo của page. Rỗng = chưa biết. */
    platform: text("platform").notNull().default(""),
    /** WEBHOOK · POLL · MANUAL — đường nào đã ghi dòng này. */
    ingestSource: text("ingest_source").notNull().default(""),
    /**
     * Dấu vân tay NỘI DUNG (hội thoại + chiều + mốc giây + chữ). Chống trùng CHÉO KÊNH: nếu
     * webhook và API đọc bù đánh mã tin nhắn khác nhau cho cùng một tin, khoá `external_id`
     * không bắt được, nhưng vân tay này bắt được. Không đặt UNIQUE vì khách hoàn toàn có thể
     * nhắn lại đúng câu cũ ở một thời điểm khác — xem `findCrossChannelDuplicate()`.
     */
    contentHash: text("content_hash").notNull().default(""),
    /**
     * MÃ QUẢNG CÁO khách đã bấm để mở hội thoại (`attachments[].ad_id` của Pancake).
     *
     * Đây là tín hiệu nhận diện sản phẩm MẠNH NHẤT có thật trong dữ liệu page này — đo ngày
     * 14/09/2026 trên 80 tin: 11 tin mang `ad_id`, trong khi `post_id` ở mức hội thoại NULL
     * 20/20 và `parent_id` (tin được trích dẫn) NULL 80/80. Không suy ra được từ chữ khách gõ.
     */
    adId: text("ad_id").notNull().default(""),
    /** Đường dẫn bài viết / quảng cáo (`attachments[].post_attachments[].url`). */
    postUrl: text("post_url").notNull().default(""),
    /**
     * NỘI DUNG BÀI QUẢNG CÁO (`attachments[].post_attachments[].description`) — chữ của SHOP,
     * không phải của khách. Chính nó chứa tên mẫu ("🤍 TINH…", "❤️ ĐẦM Đ…"), nên khớp danh mục
     * bằng câu quảng cáo cho kết quả tốt hơn hẳn khớp bằng "chị ơi còn hàng không ạ".
     */
    adDescription: text("ad_description").notNull().default(""),
    /** ad_click · photo · share · video_inline … — loại đính kèm, để biết vì sao có/không có ad_id. */
    attachmentTypes: text("attachment_types").array().notNull().default(sql`'{}'::text[]`),
    /**
     * Ảnh / đường dẫn của chính đính kèm (`attachments[].url`). Dùng để NGƯỜI nhìn ra mẫu hàng
     * trên màn hình ánh xạ — danh mục chỉ có tên dạng mã ("Đầm Q004") nên đọc chữ không đủ để
     * biết quảng cáo đang bán cái gì; nhìn ảnh thì biết ngay.
     */
    adMediaUrl: text("ad_media_url").notNull().default(""),
    sentAt: ts("sent_at"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_messages_external_uq").on(t.conversationId, t.externalId),
    index("sales_messages_conv_idx").on(t.conversationId, t.sentAt),
    index("sales_messages_hash_idx").on(t.conversationId, t.contentHash),
    index("sales_messages_ad_idx").on(t.adId),
  ],
);

/**
 * GỢI Ý CỦA MÁY, đặt cạnh CÂU NHÂN VIÊN THỰC SỰ ĐÃ TRẢ LỜI.
 * Đây là bảng để trả lời câu hỏi duy nhất đáng hỏi ở nấc SHADOW: máy có làm được việc không.
 * Ô `human_reply` được điền SAU, khi nhân viên trả lời — không đoán trước.
 */
export const salesSuggestions = pgTable(
  "sales_suggestions",
  {
    id: id(),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    /** Tin của khách đã kích hoạt lượt chạy này. */
    triggerMessageId: text("trigger_message_id").references(() => salesMessages.id, { onDelete: "set null" }),
    stageBefore: text("stage_before").notNull().default(""),
    stageAfter: text("stage_after").notNull().default(""),
    /**
     * HÀNH ĐỘNG ĐỂ CHẤM ĐIỂM: máy ĐỀ XUẤT làm gì nếu nó được làm.
     * Tách khỏi `production_action` bên dưới. Trước đây hai nghĩa này nằm chung một ô, nên hội
     * thoại đã có nhân viên vào đều ra `NO_ACTION` và mất sạch phần đáng so sánh nhất.
     */
    action: text("action").notNull().default("NO_ACTION"),
    /**
     * HÀNH ĐỘNG THẬT SỰ ĐƯỢC PHÉP: `NO_SEND` ở nấc SHADOW — không bao giờ chạm tới khách.
     * Ô này là thứ nói về AN TOÀN; ô `action` nói về CHẤT LƯỢNG. Gộp chúng lại một lần nữa là
     * quay về đúng chỗ vừa sửa.
     */
    productionAction: text("production_action").notNull().default("NO_SEND"),
    /**
     * Gợi ý này chỉ sinh ra ĐỂ CHẤM: nhân viên đã cầm hội thoại nên máy đứng ngoài, nhưng vẫn
     * soạn câu để đặt cạnh câu người. Sản xuất KHÔNG làm gì với dòng này.
     */
    evaluationOnly: boolean("evaluation_only").notNull().default(false),
    suggestedReply: text("suggested_reply").notNull().default(""),
    /**
     * ẢNH CHỤP DỮ KIỆN máy chủ đã dùng lúc soạn câu — giá, phí ship, màu, size, chính sách, tồn.
     *
     * Là ẢNH CHỤP chứ không phải tính lại lúc đọc: tính lại thì ra con số của HÔM NAY, không phải
     * con số câu ấy đã dùng, và khi hai con số lệch nhau thì người soát không kiểm được gì nữa.
     */
    factsJson: jsonb("facts_json").$type<Record<string, unknown>>(),
    /** Độ tin của quyết định (0–1). NULL = không đo được, không phải 0. */
    confidence: doublePrecision("confidence"),
    /** Đã gửi cho khách chưa — ở nấc SHADOW luôn là false. */
    sent: boolean("sent").notNull().default(false),
    /**
     * Câu ĐẦU TIÊN nhân viên gửi trong cùng lượt (ảnh chụp để bảng danh sách đọc nhanh).
     * KHÔNG phải toàn bộ câu trả lời: một lượt khách có thể được trả lời bằng nhiều tin. Bản
     * đầy đủ dựng lại từ `sales_messages` theo cấu trúc lượt — xem `lib/queries/sales-review.ts`.
     */
    humanReply: text("human_reply").notNull().default(""),
    humanRepliedAt: ts("human_replied_at"),
    /** Tổng số tin nhân viên gửi trong lượt này. 0 = chưa ai trả lời. */
    humanReplyCount: integer("human_reply_count").notNull().default(0),
    /** Giây từ tin khách tới câu trả lời đầu tiên. NULL = CHƯA CÓ câu trả lời, không phải 0 giây. */
    humanResponseSeconds: integer("human_response_seconds"),
    /** Người phụ trách chấm: AGREE · DIFFERENT · WRONG · null (chưa chấm). */
    verdict: text("verdict"),
    verdictNote: text("verdict_note").notNull().default(""),
    verdictByUserId: text("verdict_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_suggestions_conv_idx").on(t.conversationId, t.createdAt),
    index("sales_suggestions_verdict_idx").on(t.verdict, t.createdAt),
  ],
);

/**
 * MỐC ĐỌC CỦA BỘ NẠP TIN SỐNG — một dòng cho mỗi page.
 *
 * Hai việc trong một bảng, và chúng đi cùng nhau có lý do: MỐC (đọc tới đâu rồi) và SỨC KHOẺ (vòng
 * gần nhất chạy lúc nào, hỏng mấy lần liền). Người trực mở màn hình ra hỏi "hệ thống có đang sống
 * không" — câu trả lời phải là một con số đọc được, không phải một dòng log.
 *
 * `lastOkAt` là mốc của vòng CHẠY ĐƯỢC gần nhất, khác `lastRunAt` (vòng gần nhất, kể cả hỏng).
 * Gộp hai cái thì một bộ nạp hỏng liên tục vẫn trông như đang sống, vì nó vẫn "chạy" đều đặn.
 *
 * Dựng lại container KHÔNG mất mốc: nó nằm ở CSDL chứ không trong bộ nhớ tiến trình. Và mất mốc
 * cũng không sinh ra bản sao — `ingestMessage` chống trùng bằng mã tin và vân tay nội dung.
 */
export const salesIngestCursors = pgTable("sales_ingest_cursors", {
  pageId: text("page_id").primaryKey(),
  /** Mốc tin mới nhất ĐÃ ĐỌC ĐƯỢC. Dùng để tính cửa sổ hỏi lại cho vòng sau. */
  lastMessageAt: ts("last_message_at"),
  /** Mã tin ngoài của tin mới nhất đã đọc — để đối chiếu khi nghi ngờ mốc bị nhảy. */
  lastMessageExternalId: text("last_message_external_id").notNull().default(""),
  /** Vòng gần nhất, KỂ CẢ vòng hỏng. */
  lastRunAt: ts("last_run_at"),
  /** Vòng CHẠY ĐƯỢC gần nhất. Đây mới là con số trả lời "có đang sống không". */
  lastOkAt: ts("last_ok_at"),
  lastError: text("last_error").notNull().default(""),
  /** Hỏng mấy vòng liền — quyết định nghỉ dài dần, và về 0 ngay khi có một vòng chạy được. */
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  /** Cộng dồn, để biết bộ nạp đã mang về bao nhiêu kể từ lúc dựng. */
  messagesIngested: integer("messages_ingested").notNull().default(0),
  conversationsSeen: integer("conversations_seen").notNull().default(0),
  updatedAt: updatedAt(),
});

/**
 * SỔ THAO TÁC CỦA NHÂN VIÊN TRÊN NẤC TRỢ LÝ — một dòng cho mỗi lần bấm.
 *
 * ĐÂY LÀ NƠI DUY NHẤT GHI LẠI "AI ĐÃ GỬI GÌ CHO KHÁCH". Mỗi tin rời khỏi ERP ở nấc COPILOT đều
 * phải để lại đúng một dòng ở đây, mang KHOÁ TÀI KHOẢN của người bấm (luật 34: quy kết đi bằng
 * khoá, không bằng ô chữ).
 *
 * BA CỘT CHỮ, BA NGHĨA KHÁC NHAU — và tách chúng ra là toàn bộ giá trị học được từ nấc này:
 *   `suggestedText` — câu MÁY soạn. Bất biến, chụp lại tại thời điểm bấm.
 *   `finalText`     — câu THẬT SỰ đi tới khách. Bằng câu trên nếu bấm "Gửi nguyên văn".
 *   `editDistance`  — sửa bao nhiêu. Gộp hai cột kia làm một thì không bao giờ trả lời được câu
 *                     "nhân viên có dùng được câu máy soạn không", tức là câu hỏi lớn nhất của
 *                     cả giai đoạn thí điểm.
 *
 * CHỐNG GỬI HAI LẦN nằm ở ràng buộc `sales_copilot_actions_terminal_uq`: một câu gợi ý chỉ được
 * KẾT THÚC (gửi / sửa rồi gửi / từ chối) đúng một lần. Hai tab cùng bấm thì CSDL cho đúng một cái
 * thắng — không phải một phép kiểm ở tầng ứng dụng, vốn luôn thua một cuộc đua thật.
 */
export const salesCopilotActions = pgTable(
  "sales_copilot_actions",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    /** Câu gợi ý bị tác động. NULL chỉ với việc ở mức HỘI THOẠI (nhận việc / trả lại). */
    suggestionId: text("suggestion_id").references(() => salesSuggestions.id, { onDelete: "set null" }),
    /** Lượt chạy đã sinh ra câu ấy — để lần ngược về mô hình, token và chi phí. */
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    pageId: text("page_id").notNull().default(""),
    /** SEND · EDIT_SEND · REJECT · REGENERATE · TAKEOVER · RELEASE. */
    action: text("action").notNull(),
    /** Ảnh chụp câu MÁY soạn tại thời điểm bấm. */
    suggestedText: text("suggested_text").notNull().default(""),
    /** Câu THẬT SỰ gửi đi. Rỗng với REJECT / REGENERATE / TAKEOVER / RELEASE. */
    finalText: text("final_text").notNull().default(""),
    /** Nhân viên có sửa không, và sửa bao nhiêu. NULL = không áp dụng cho việc này. */
    edited: boolean("edited"),
    editDistance: integer("edit_distance"),
    /** Từ chối thì vì sao — danh sách đóng ở `lib/constants/copilot.ts`. */
    rejectReason: text("reject_reason"),
    note: text("note").notNull().default(""),
    /** NONE · PENDING · SENT · FAILED. Chỉ có nghĩa với SEND / EDIT_SEND. */
    sendStatus: text("send_status").notNull().default("NONE"),
    /** Mã tin nhắn Pancake trả về — bằng chứng tin đã thật sự đi. */
    pancakeMessageId: text("pancake_message_id").notNull().default(""),
    sendError: text("send_error").notNull().default(""),
    /** Bao lâu từ lúc máy soạn xong tới lúc người bấm. NULL = chưa đo được. */
    reviewSeconds: integer("review_seconds"),
    /**
     * LÚC BẤM GỬI, HỆ THỐNG ĐANG BÁO THIẾU NHỮNG GÌ (`COPILOT_WARNINGS`).
     *
     * Máy không đoán size, không hứa còn hàng, không tự cam kết đổi trả — nhưng nhân viên sửa tay
     * rồi gửi thì được. Cột này ghi lại rằng họ đã bấm TRONG LÚC đang thiếu. Không phải để trách
     * ai; để sau này lần ra được vì sao một lời hứa sai đã ra khỏi cửa.
     */
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    /**
     * Gửi xong, đọc lại hội thoại từ Pancake: tin ấy có mặt ĐÚNG MỘT LẦN không.
     * `null` = CHƯA KIỂM ĐƯỢC (mạng hỏng, API từ chối) — khác hẳn `false` (đã kiểm và thấy sai).
     */
    verified: boolean("verified"),
    verifyNote: text("verify_note").notNull().default(""),
    /** QUY KẾT BẰNG KHOÁ. Không có đường nào ghi dòng này mà không có khoá tài khoản. */
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Ảnh chụp TÊN để người đọc — máy chủ đọc từ `users`, không nhận từ client. */
    actorName: text("actor_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_copilot_actions_conv_idx").on(t.conversationId, t.createdAt),
    index("sales_copilot_actions_actor_idx").on(t.actorUserId, t.createdAt),
    index("sales_copilot_actions_action_idx").on(t.action, t.createdAt),
  ],
);

/**
 * CHẤM TAY MỘT LƯỢT CHẠY — nơi DUY NHẤT sự thật nền (ground truth) được ghi.
 *
 * Mọi ô ở đây đều cho phép NULL và NULL nghĩa là **CHƯA AI CHẤM**, không phải "sai". Không một
 * dòng mã nào được tự điền các ô này: máy tự chấm chính nó thì con số đẹp lên mà không ai biết
 * nó có đúng không. Tỷ lệ chính xác chỉ được tính trên phần ĐÃ CHẤM, và độ phủ luôn hiện cạnh.
 *
 * Một dòng cho mỗi gợi ý (tức mỗi lượt khách nhắn), do người phụ trách bấm trên màn hình soát.
 */
export const salesReviewLabels = pgTable(
  "sales_review_labels",
  {
    id: id(),
    suggestionId: text("suggestion_id")
      .notNull()
      .references(() => salesSuggestions.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    /** true = máy nhận đúng · false = sai · NULL = chưa chấm / không áp dụng cho lượt này. */
    productOk: boolean("product_ok"),
    colorOk: boolean("color_ok"),
    sizeOk: boolean("size_ok"),
    phoneOk: boolean("phone_ok"),
    addressOk: boolean("address_ok"),
    intentOk: boolean("intent_ok"),
    purchaseIntentOk: boolean("purchase_intent_ok"),
    confirmationOk: boolean("confirmation_ok"),
    /** Hành động kế tiếp máy chọn: GOOD · ACCEPTABLE · WRONG · NULL chưa chấm. */
    nextActionQuality: text("next_action_quality"),
    /** Máy nói điều không có thật hoặc phá luật nghiệp vụ (bịa giá, hứa còn hàng, tự giảm giá…). */
    hallucination: boolean("hallucination"),
    hallucinationNote: text("hallucination_note").notNull().default(""),
    /** Câu gợi ý có dùng được không nếu nhân viên gửi nguyên văn. */
    replyUsable: boolean("reply_usable"),
    /**
     * KẾT LUẬN CHUNG cho cả lượt: GOOD · ACCEPTABLE · BAD · NULL chưa chấm.
     *
     * Khác hẳn `nextActionQuality`, vốn chỉ chấm VIỆC máy chọn làm. Máy có thể chọn đúng việc
     * (hỏi size) mà câu chữ vẫn không gửi được — gộp hai câu hỏi ấy lại thì mất đúng một trong hai.
     */
    verdict: text("verdict"),
    /**
     * VÌ SAO — theo danh sách ĐÓNG ở `lib/constants/sales-review-tags.ts`, mỗi nhãn khai luôn ai
     * phải đi sửa (MODEL · DATA · POLICY). Nhãn để ĐẾM, ghi chú bên dưới để HIỂU.
     */
    reasonTags: jsonb("reason_tags").$type<string[]>().notNull().default([]),
    note: text("note").notNull().default(""),
    /** Quy kết đi bằng KHOÁ TÀI KHOẢN, không bằng ô chữ. */
    reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: ts("reviewed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_review_labels_suggestion_uq").on(t.suggestionId),
    index("sales_review_labels_conv_idx").on(t.conversationId, t.createdAt),
  ],
);

/**
 * BỘ CA HỒI QUY — ẢNH CHỤP BẤT BIẾN CỦA MỘT TÌNH HUỐNG, KHÔNG PHẢI MỘT CON TRỎ TỚI HỘI THOẠI.
 *
 * Người soát mở `/ai/review`, thấy một lượt máy xử lý sai (hoặc xử lý đúng một ca khó), bấm THÊM
 * VÀO BỘ HỒI QUY và khai kỳ vọng. Từ giây ấy ca này phải cho cùng một kết quả mãi mãi — nên nó
 * KHÔNG đọc lại hội thoại gốc lúc chạy.
 *
 * Ba lý do, và mỗi lý do là một cách ca sẽ hỏng nếu làm ngược:
 *   1. Hội thoại thật đi tiếp — khách nhắn thêm, nhân viên nhận việc, trạng thái đổi. Đọc lại thì
 *      ca đo một tình huống KHÁC tình huống người soát đã chấm.
 *   2. Tồn kho và giá đổi mỗi ngày. Một ca đỏ vì kho vừa bán hết hàng là một ca người ta đi gia
 *      hạn con số thay vì đọc thông điệp (AGENTS.md mục 50).
 *   3. Dữ liệu khách có thể bị xoá. Khoá ngoại vì thế là `set null`: ca sống sót, dấu vết mất đi
 *      thì in ra là mất, không giả vờ còn.
 *
 * `input` giữ: tin của khách (mốc TƯƠNG ĐỐI theo phút), trạng thái trước, kết quả công cụ ERP đã
 * chụp, bối cảnh. `expected` giữ kỳ vọng của NGƯỜI. Hình dạng của cả hai khai ở
 * `lib/constants/sales-regression.ts` — bảng này chỉ là chỗ cất.
 */
export const salesRegressionCases = pgTable(
  "sales_regression_cases",
  {
    id: id(),
    /** Khoá đọc được, dùng làm danh tính trong báo cáo. DUY NHẤT — chạy lại không đẻ ca trùng. */
    caseKey: text("case_key").notNull(),
    title: text("title").notNull().default(""),
    pageId: text("page_id").notNull().default(""),
    /** Dấu vết về nơi ca sinh ra. `set null` vì ca phải sống lâu hơn dữ liệu khách. */
    sourceSuggestionId: text("source_suggestion_id").references(() => salesSuggestions.id, { onDelete: "set null" }),
    sourceConversationId: text("source_conversation_id").references(() => salesConversations.id, { onDelete: "set null" }),
    /** `RegressionCase["input"]`: messages · priorState · priorStage · toolResults · context. */
    input: jsonb("input").notNull(),
    /** `RegressionExpectation`. Ô `null` = NGƯỜI SOÁT CHƯA QUYẾT chiều ấy ⇒ không kiểm. */
    expected: jsonb("expected").notNull(),
    note: text("note").notNull().default(""),
    /**
     * Tắt một ca thay vì xoá: một ca sai cũng là một quyết định đã có người đưa ra, và lý do tắt
     * nó đáng giữ lại hơn là biến mất.
     */
    active: boolean("active").notNull().default(true),
    /** Quy kết đi bằng KHOÁ TÀI KHOẢN, không bằng ô chữ (AGENTS.md mục 34). */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_regression_cases_key_uq").on(t.caseKey),
    index("sales_regression_cases_active_idx").on(t.active, t.createdAt),
  ],
);

/** Hẹn nhắn lại. CHỈ là danh sách chờ — không có đường nào từ bảng này tự gửi tin cho khách. */
/**
 * BẢN ĐỒ QUẢNG CÁO / BÀI VIẾT → SẢN PHẨM.
 *
 * VÌ SAO PHẢI CÓ BẢNG NÀY. Kiểm kê API Pancake ngày 14/09/2026 (80 tin thật của page
 * 1117899664739453): `post_id` ở mức hội thoại NULL 20/20, `parent_id` NULL 80/80, và KHÔNG có
 * một trường product / SKU / order / cart nào. Tín hiệu sản phẩm DUY NHẤT tồn tại là
 * `attachments[].ad_id` cùng câu quảng cáo đi kèm — 11/80 tin có.
 *
 * Một mã quảng cáo trỏ tới một mẫu hàng trong suốt đời chiến dịch, nên đoán lại ở mỗi hội thoại
 * vừa tốn vừa cho kết quả khác nhau giữa các lần. Ghi một lần, dùng mãi.
 *
 * `source` nói bản đồ này từ đâu ra, và đó là thứ quyết định được tin tới đâu:
 *   · `AD_DESCRIPTION` — máy tự khớp câu quảng cáo với danh mục. Suy luận, có thể sai.
 *   · `HUMAN`          — người bấm trên màn hình. Là sự thật, đè lên mọi suy luận của máy.
 * Máy KHÔNG BAO GIỜ được ghi đè một dòng `HUMAN` — đó là lý do tồn tại của cột này.
 */
export const salesAdProductMap = pgTable(
  "sales_ad_product_map",
  {
    id: id(),
    pageId: text("page_id").notNull(),
    /** Khoá tự nhiên: mã quảng cáo, hoặc đường dẫn bài viết khi không có mã. Không rỗng. */
    adKey: text("ad_key").notNull(),
    /** AD · POST — khoá trên là mã quảng cáo hay đường dẫn bài viết. */
    keyKind: text("key_kind").notNull().default("AD"),
    productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
    /** Mẫu mã cụ thể nếu quảng cáo chỉ chạy đúng một mẫu; NULL = chỉ biết tới mức sản phẩm. */
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** AD_DESCRIPTION · HUMAN — xem chú thích của bảng. */
    source: text("source").notNull().default("AD_DESCRIPTION"),
    /** 0..1. Dòng do người đặt luôn là 1. */
    confidence: doublePrecision("confidence").notNull().default(0),
    /** Câu quảng cáo (hoặc lý do) đã dẫn tới kết luận này — để người đọc kiểm lại được. */
    evidence: text("evidence").notNull().default(""),
    /** Ảnh chụp câu quảng cáo, giữ để khớp lại khi danh mục đổi. */
    adDescription: text("ad_description").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_ad_product_map_uq").on(t.pageId, t.adKey),
    index("sales_ad_product_map_product_idx").on(t.productId),
  ],
);

/**
 * MỖI LẦN MÁY KẾT LUẬN "khách đang hỏi mẫu nào" — ghi lại KÈM CĂN CỨ.
 *
 * Mẻ 20 hội thoại đầu chỉ nói được "nhận ra sản phẩm: 0/20" mà không nói được VÌ SAO, nên không
 * sửa được gì từ con số ấy. Bảng này trả lời: tầng nào đã kết luận, tin tới đâu, dựa vào cái gì.
 *
 * `source` là một trong `PRODUCT_RESOLUTION_SOURCES`. `product_id` NULL nghĩa là KHÔNG kết luận
 * được — và đó là một kết quả hợp lệ, khác hẳn với việc chọn bừa một mẫu cho có.
 */
export const salesProductResolutions = pgTable(
  "sales_product_resolutions",
  {
    id: id(),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => salesMessages.id, { onDelete: "set null" }),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** Ảnh chụp mã hàng lúc kết luận — danh mục đổi thì vẫn đọc lại được máy đã chọn gì. */
    productCode: text("product_code").notNull().default(""),
    /** Tầng nào kết luận — xem `PRODUCT_RESOLUTION_SOURCES`. */
    source: text("source").notNull(),
    /** 0..1. Dưới ngưỡng thì KHÔNG được nhận, dù đây là ứng viên tốt nhất. */
    confidence: doublePrecision("confidence").notNull().default(0),
    /** Câu/khoá đã dẫn tới kết luận, cắt ngắn. Không có căn cứ thì không được kết luận. */
    evidence: text("evidence").notNull().default(""),
    /** Số ứng viên ngang điểm — > 1 nghĩa là CHƯA BIẾT, phải hỏi lại chứ không được chọn bừa. */
    candidateCount: integer("candidate_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_product_resolutions_conv_idx").on(t.conversationId, t.createdAt),
    index("sales_product_resolutions_source_idx").on(t.source),
  ],
);

/**
 * HỒ SƠ BÁN HÀNG CỦA MỘT FANPAGE — mẫu thắng đang chạy và toàn bộ điều kiện bán của nó.
 *
 * Đây là ĐƯỜNG BÌNH THƯỜNG để biết một hội thoại đang bán mẫu gì. Bản trước đi đoán từ chữ khách
 * và từ quảng cáo, đo được 17%; cách vận hành thật là một page bán một mẫu thắng, nên mẫu hàng là
 * thứ ĐÃ BIẾT TỪ TRƯỚC, không phải thứ phải suy ra.
 *
 * `version` tăng mỗi lần đổi mẫu / đổi giá. Hội thoại chụp lại số này lúc gắn hồ sơ, nên đổi cấu
 * hình về sau KHÔNG viết lại quá khứ: page chuyển Q004 → Q017 thì cuộc cũ vẫn thuộc Q004.
 */
export const fanpageSalesProfiles = pgTable(
  "fanpage_sales_profiles",
  {
    id: id(),
    /** Khoá tự nhiên: page bên Pancake. */
    pancakePageId: text("pancake_page_id").notNull(),
    facebookPageId: text("facebook_page_id").notNull().default(""),
    name: text("name").notNull().default(""),
    /** OFF · SHADOW · COPILOT · AUTO — nấc quyền hạn riêng cho page này. */
    aiMode: text("ai_mode").notNull().default("SHADOW"),
    active: boolean("active").notNull().default(true),
    /** Tăng mỗi lần đổi mẫu hoặc đổi điều kiện bán. Hội thoại chụp lại số này. */
    version: integer("version").notNull().default(1),
    effectiveFrom: ts("effective_from"),

    /** MẪU THẮNG đang chạy. NULL = chưa khai ⇒ hội thoại thường rơi về UNKNOWN, KHÔNG đoán bừa. */
    activeProductId: text("active_product_id").references(() => products.id, { onDelete: "set null" }),

    // ── Điều kiện bán (có thể ĐÈ giá gốc của ERP cho riêng kênh này) ──
    /** NULL = CHƯA KHAI GIÁ ⇒ máy KHÔNG được báo giá. `money()` mặc định 0 nên không dùng được ở đây. */
    unitPrice: integer("unit_price"),
    shippingFee: integer("shipping_fee"),
    /** [{ quantity, price, freeShipping }] — giá combo. */
    comboPricing: jsonb("combo_pricing"),
    /** Tổng tiền từ mức này trở lên thì miễn ship. NULL = không có luật miễn ship. */
    freeShipFrom: integer("free_ship_from"),
    availableColors: text("available_colors").array().notNull().default(sql`'{}'::text[]`),
    /** Chất liệu — TUYÊN BỐ về sản phẩm, không được suy từ ảnh. Rỗng = chưa khai ⇒ máy phải né. */
    material: text("material").notNull().default(""),
    codPolicy: text("cod_policy").notNull().default(""),
    inspectionPolicy: text("inspection_policy").notNull().default(""),
    deliveryEstimate: text("delivery_estimate").notNull().default(""),
    /** `SalesPolicy` — chính sách đổi/trả CÓ CẤU TRÚC. NULL = chưa khai nhánh nào. */
    exchangePolicyJson: jsonb("exchange_policy_json"),
    /** Đổi CAM KẾT là một bản khác hẳn đổi CÁCH NÓI — nên nó có số riêng. */
    policyVersion: integer("policy_version").notNull().default(1),
    /** `ApprovedFact[]` — câu ĐÃ DUYỆT máy được phép nói, kèm nhóm và người duyệt. */
    approvedFactsJson: jsonb("approved_facts_json"),
    /**
     * Phiên bản SỔ DỮ KIỆN — tách khỏi `version` vì hai thứ khác nhau: đổi GIÁ là đổi điều kiện
     * bán, đổi CÂU ĐÃ DUYỆT là đổi thứ máy được phép nói. Hội thoại chụp cả hai.
     */
    knowledgeVersion: integer("knowledge_version").notNull().default(1),
    /*
     * KHÔNG có cột bảng số đo ở đây. Bảng số đo là của MÁY GỢI Ý SIZE
     * (`lib/constants/size-engine.ts` + `settings["ai.sizeRules"]`), tra theo mã sản phẩm với
     * phạm vi hẹp-thắng-rộng. Thêm một cột trỏ bảng khác ở đây là dựng lại đúng bản thứ hai mà
     * migration 0091 vừa gỡ đi.
     */

    note: text("note").notNull().default(""),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("fanpage_sales_profiles_page_uq").on(t.pancakePageId)],
);

/*
 * BẢNG SỐ ĐO KHÔNG Ở ĐÂY, VÀ ĐÓ LÀ CÓ CHỦ Ý.
 *
 * Nó nằm ở `settings["ai.sizeRules"]`, đọc qua `lib/constants/size-engine.ts` — có phiên bản, có
 * phạm vi (mẫu mã → sản phẩm → nhóm hàng → toàn shop, hẹp thắng rộng), có mã AMBIGUOUS /
 * OUT_OF_RANGE, có script nhập kiểm tra trước khi ghi. 0088 từng dựng một bảng thứ hai ở đây;
 * 0091 gỡ nó. Hai bảng số đo là hai câu trả lời khác nhau cho "khách này mặc size gì", và cái sai
 * không lộ ra ở màn hình mà lộ ra ở một kiện hàng không vừa.
 */

/**
 * LUẬT NGUỒN — CHỈ KHAI NGOẠI LỆ.
 *
 * Quảng cáo bán đúng mẫu thắng của page thì KHÔNG cần khai gì: hồ sơ fanpage đã lo. Chỉ những
 * nguồn KHÁC mẫu thắng mới phải có dòng ở đây — hàng test, hoặc nguồn chỉ người được trả lời.
 * Nhờ vậy khối lượng khai giảm từ "mọi quảng cáo" xuống "vài ngoại lệ".
 *
 * Luật nguồn ĐÈ mặc định của fanpage. Đó là toàn bộ lý do nó tồn tại.
 */
export const salesSourceRules = pgTable(
  "sales_source_rules",
  {
    id: id(),
    pancakePageId: text("pancake_page_id").notNull(),
    /** AD · POST */
    sourceKind: text("source_kind").notNull().default("AD"),
    /** Mã quảng cáo hoặc mã/đường dẫn bài viết. */
    sourceId: text("source_id").notNull(),
    /** WIN · TEST · HUMAN_ONLY */
    sourceType: text("source_type").notNull(),
    /** Khi WIN và khác mẫu thắng mặc định. */
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Khi TEST. */
    testProductId: text("test_product_id").references(() => testProductProfiles.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sales_source_rules_uq").on(t.pancakePageId, t.sourceId)],
);

/**
 * HỒ SƠ MỘT MẪU ĐANG TEST — tồn tại ĐƯỢC mà chưa cần mã hàng trong ERP.
 *
 * Mẫu test đang đo phản ứng thị trường: chưa có mã, chưa dựng xong sản phẩm, nhưng khách vẫn nhắn
 * và vẫn phải được trả lời. Máy chỉ được dùng ĐÚNG những dữ kiện khai ở đây; thiếu thì nói chưa có
 * chứ không bịa, và TUYỆT ĐỐI không mượn số đo hay giá của mẫu thắng.
 */
export const testProductProfiles = pgTable(
  "test_product_profiles",
  {
    id: id(),
    /** Mã tạm, ví dụ TEST-2026-091. Khoá tự nhiên. */
    testCode: text("test_code").notNull(),
    name: text("name").notNull().default(""),
    pancakePageId: text("pancake_page_id").notNull().default(""),
    sourceId: text("source_id").notNull().default(""),
    images: text("images").array().notNull().default(sql`'{}'::text[]`),
    description: text("description").notNull().default(""),
    material: text("material").notNull().default(""),
    colors: text("colors").array().notNull().default(sql`'{}'::text[]`),
    /** Số đo đã biết — thiếu thì để trống, không suy từ mẫu khác. */
    measurements: jsonb("measurements"),
    /** Giá test. NULL = CHƯA CÓ GIÁ, máy không được báo giá. */
    /** NULL = CHƯA CÓ GIÁ, máy không được báo giá cho mẫu test này. */
    price: integer("price"),
    /** NULL = CHƯA KHAI PHÍ SHIP. Không mượn phí ship của mẫu thắng. */
    shippingFee: integer("shipping_fee"),
    /** [{ quantity, price, freeShipping }] — combo riêng của mẫu test. */
    comboPricing: jsonb("combo_pricing"),
    freeShipFrom: integer("free_ship_from"),
    /**
     * Bốn chính sách, khai RIÊNG cho mẫu test.
     *
     * Không có bốn ô này thì cổng năng lực chỉ còn hai lối, cả hai đều sai: cho mẫu test mượn
     * chính sách của mẫu thắng, hoặc miễn kiểm tra cho mẫu test. Ô riêng là lối thứ ba.
     */
    codPolicy: text("cod_policy").notNull().default(""),
    inspectionPolicy: text("inspection_policy").notNull().default(""),
    deliveryEstimate: text("delivery_estimate").notNull().default(""),
    exchangePolicyJson: jsonb("exchange_policy_json"),
    policyVersion: integer("policy_version").notNull().default(1),
    promotion: text("promotion").notNull().default(""),
    shippingPolicy: text("shipping_policy").notNull().default(""),
    knowledgeVersion: integer("knowledge_version").notNull().default(1),
    approvedFactsJson: jsonb("approved_facts_json"),
    note: text("note").notNull().default(""),
    startAt: ts("start_at"),
    endAt: ts("end_at"),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** DRAFT · RUNNING · ENDED · PROMOTED */
    status: text("status").notNull().default("DRAFT"),
    /** Khi mẫu test được nâng lên hàng thắng — hội thoại CŨ vẫn giữ nguyên là TEST. */
    promotedProductId: text("promoted_product_id").references(() => products.id, { onDelete: "set null" }),

    // ── Quyền của máy trên mẫu này. Mặc định an toàn hơn hàng thắng. ──
    aiReplyEnabled: boolean("ai_reply_enabled").notNull().default(true),
    allowQuotePrice: boolean("allow_quote_price").notNull().default(true),
    allowAnswerMaterial: boolean("allow_answer_material").notNull().default(true),
    allowAskSize: boolean("allow_ask_size").notNull().default(true),
    allowCollectPreference: boolean("allow_collect_preference").notNull().default(true),
    allowCollectIntent: boolean("allow_collect_intent").notNull().default(true),
    allowCollectPhone: boolean("allow_collect_phone").notNull().default(true),
    allowCollectAddress: boolean("allow_collect_address").notNull().default(true),
    allowOfferProduct: boolean("allow_offer_product").notNull().default(true),
    /** Nhóm dưới TẮT cho tới khi mẫu test có mã hàng và cấu hình đơn hợp lệ. */
    allowAutoOrderCreate: boolean("allow_auto_order_create").notNull().default(false),
    allowConfirmOrder: boolean("allow_confirm_order").notNull().default(false),
    allowPromotion: boolean("allow_promotion").notNull().default(false),
    allowUpsell: boolean("allow_upsell").notNull().default(false),
    allowFollowUp: boolean("allow_follow_up").notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("test_product_profiles_code_uq").on(t.testCode)],
);

/**
 * TÍN HIỆU THỊ TRƯỜNG THU TỪ HỘI THOẠI HÀNG TEST.
 *
 * Mục tiêu của hàng test KHÔNG phải là chốt nhiều đơn nhất, mà là biết thị trường có muốn mẫu này
 * không. Vì vậy phễu của nó phải đứng RIÊNG, không trộn vào tỷ lệ chốt của hàng thắng — trộn vào
 * thì một mẫu test tốt trông như một mẫu thắng tồi.
 *
 * `NULL` ở mọi ô nghĩa là CHƯA ĐO ĐƯỢC, không phải "không".
 */
export const testMarketSignals = pgTable(
  "test_market_signals",
  {
    id: id(),
    testProductId: text("test_product_id")
      .notNull()
      .references(() => testProductProfiles.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    customerInterest: boolean("customer_interest"),
    purchaseIntent: boolean("purchase_intent"),
    askedPrice: boolean("asked_price"),
    priceObjection: boolean("price_objection"),
    requestedColor: text("requested_color").notNull().default(""),
    requestedSize: text("requested_size").notNull().default(""),
    heightCm: integer("height_cm"),
    weightKg: integer("weight_kg"),
    bustCm: integer("bust_cm"),
    waistCm: integer("waist_cm"),
    hipCm: integer("hip_cm"),
    materialQuestion: boolean("material_question"),
    sizeQuestion: boolean("size_question"),
    shippingQuestion: boolean("shipping_question"),
    likedDesign: boolean("liked_design"),
    dislikedDesign: boolean("disliked_design"),
    readyToBuy: boolean("ready_to_buy"),
    customerFeedback: text("customer_feedback").notNull().default(""),
    objectionCategory: text("objection_category").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("test_market_signals_conv_uq").on(t.conversationId),
    index("test_market_signals_test_idx").on(t.testProductId),
  ],
);

export const salesFollowups = pgTable(
  "sales_followups",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesConversations.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => aiRuns.id, { onDelete: "set null" }),
    dueAt: ts("due_at").notNull(),
    reason: text("reason").notNull().default(""),
    /** PENDING · DONE · CANCELLED */
    status: text("status").notNull().default("PENDING"),
    suggestedMessage: text("suggested_message").notNull().default(""),
    doneAt: ts("done_at"),
    doneByUserId: text("done_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sales_followups_due_idx").on(t.status, t.dueAt)],
);

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

export const csCasesRelations = relations(csCases, ({ one, many }) => ({
  order: one(orders, { fields: [csCases.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [csCases.customerId], references: [customers.id] }),
  events: many(csCaseEvents),
}));
export const csCaseEventsRelations = relations(csCaseEvents, ({ one }) => ({ case: one(csCases, { fields: [csCaseEvents.caseId], references: [csCases.id] }) }));

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
export type HmtWorkbookRow = typeof hmtWorkbooks.$inferSelect;
export type MarketingIdea = typeof marketingIdeas.$inferSelect;
export type IdeaStatus = MarketingIdea["status"];
export type OrderReturn = typeof orderReturns.$inferSelect;
export type InventoryHistory = typeof inventoryHistories.$inferSelect;

/**
 * ═══════════ BẢNG TÍNH HÀNG HOÀN VIẾT TAY, ĐƯA VÀO BẰNG CHÍNH ERP ═══════════
 *
 * ─── VÌ SAO CÓ BẢNG NÀY ───
 *
 * Sổ hàng hoàn của kho là một tệp Excel nằm trên máy của chủ shop. Để đối soát nó với ERP, tệp
 * phải tới được nơi có CSDL production. Ba đường từng thử và vì sao đều sai:
 *
 *  · **`scp` lên máy chủ** — cần khoá SSH mà máy của chủ shop không có, và bắt người vận hành mở
 *    terminal cho một việc hàng tuần là cách chắc chắn nhất để việc đó không bao giờ được làm.
 *  · **đường dẫn tải công khai** (`HMT_WORKBOOK_URL`) — "ai có link cũng xem được" là một cách nói
 *    khác của "dữ liệu khách hàng nằm trên Internet".
 *  · **đưa tệp vào kho mã** — kho mã này PUBLIC.
 *
 * Đường đúng là đường ERP **đã có sẵn** cho bảng kê Viettel Post (`vtp_statement_files`): người
 * dùng đã đăng nhập kéo tệp vào màn hình của chính họ, tệp đi qua HTTPS bằng phiên của họ, và nằm
 * lại trong CSDL production. Không SSH, không console, không khoá, không link công khai.
 *
 * ─── KHOÁ TỰ NHIÊN LÀ NỘI DUNG, KHÔNG PHẢI TÊN TỆP ───
 *
 * `sha256` là UNIQUE. Cùng một tệp tải lên mười lần vẫn là MỘT dòng — kể cả khi người dùng đổi tên
 * tệp, mà họ luôn đổi ("Bản sao của…", "… (1).xlsx"). Ngược lại, hai tệp khác nội dung mà trùng
 * tên là hai dòng khác nhau, đúng như phải thế: đối soát bằng nhầm bản là sai số tồn kho.
 *
 * Băm do MÁY CHỦ tính lại từ chính các byte đã nhận, KHÔNG nhận từ client (AGENTS.md mục 34: cột
 * chữ đi kèm chỉ là ảnh chụp, khoá mới là danh tính).
 */
export const hmtWorkbooks = pgTable(
  "hmt_workbooks",
  {
    id: id(),
    filename: text("filename").notNull(),
    /** Băm SHA-256 của NỘI DUNG, do máy chủ tính. Đây là danh tính của bản đối soát. */
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull().default(0),
    /** Nội dung tệp, base64 — nguyên vẹn như lúc người dùng kéo vào, giống `vtp_statement_files`. */
    content: text("content").notNull(),
    /** Danh tính người tải lên. `NULL` = đưa vào bằng đường khác (script), không phải "không ai". */
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Ảnh chụp TÊN lúc tải lên — người nghỉ việc thì dòng vẫn đọc được. */
    uploadedBy: text("uploaded_by").notNull().default(""),
    /** Lượt đối soát gần nhất ĐỌC bản này. `NULL` = đã tải lên nhưng chưa đối soát lần nào. */
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("hmt_workbooks_sha_uq").on(t.sha256), index("hmt_workbooks_created_idx").on(t.createdAt)],
);

/**
 * ═══════════ SỔ CHĂM SÓC ĐƠN GIAO HỤT ═══════════
 *
 * Câu hỏi bảng này sinh ra để trả lời: **gọi khách có cứu được đơn không, và cứu được bao nhiêu?**
 *
 * Trước đây không trả lời được. Bot tự nhắn thì có case CSKH, nhưng người nhấc máy gọi xong thì
 * không có chỗ nào ghi — nên "đội CSKH cứu được bao nhiêu đơn" là một câu hỏi không có dữ liệu.
 *
 * ĐO TỪ HÔM NAY. Không dựng lại cohort quá khứ: dữ liệu cũ không mang actor, và suy ngược sẽ đẻ ra
 * một tỷ lệ hiệu quả nghe rất thuyết phục mà không có gì đứng sau.
 */
/**
 * ═══════════ TRẠNG THÁI CARE NỘI BỘ CỦA MỘT KIỆN — KHÔNG PHẢI TRẠNG THÁI VẬN CHUYỂN ═══════════
 *
 * `shipments.stage` là ĐVVC nói gì về kiện (chứng từ). Bảng này là ĐỘI nói gì về việc của mình với
 * kiện đó: chưa xử lý · đang xử lý · chờ kết quả · escalate · đã xong. Hai chiều tách rời cố ý:
 * đội bấm "đã xong" KHÔNG làm kiện thành "đã giao", và kiện được giao KHÔNG tự đóng việc của đội —
 * kiện chỉ RỜI hàng đợi mặc định (điều kiện cần care hết), còn lịch sử ở đây và ở `care_actions`.
 *
 * Một dòng cho một kiện (khoá tự nhiên `shipment_id`). Không có dòng = CHƯA XỬ LÝ.
 */
export const shipmentCare = pgTable(
  "shipment_care",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    /**
     * ĐỢT THỨ MẤY. Ràng buộc UNIQUE cũ trên `shipment_id` đã được gỡ (migration 0075): kiện hỏng
     * lần hai thì đội xử lý lần hai, và lần đó KHÔNG được ghi đè lên lần trước.
     *
     * Tối đa MỘT đợt đang mở cho mỗi kiện — do chỉ mục duy nhất từng phần `shipment_care_active_uidx`
     * giữ, không do mã nguồn tự canh. Nhờ vậy webhook phát lại không thể sinh đợt thứ hai: lệnh chèn
     * bị CSDL từ chối, chứ không phải bị một câu `if` nào đó bỏ sót.
     */
    episodeNo: integer("episode_no").notNull().default(1),
    active: boolean("active").notNull().default(true),
    /** Vòng đời ở `lib/constants/care.ts::CARE_TRANSITIONS` — chỉ đi theo bảng chuyển trạng thái. */
    careStatus: text("care_status").notNull().default("NEW"),
    /** Bối cảnh LÚC MỞ ĐỢT, cố ý không tính lại: "đợt này bắt đầu vì ĐVVC báo gì". */
    entryCarrierState: text("entry_carrier_state"),
    sourceTrigger: text("source_trigger"),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    trackingNumber: text("tracking_number"),
    priority: text("priority"),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    ownerEmail: text("owner_email").notNull().default(""),
    /** Hẹn theo dõi lại. Tới hạn thì kiện quay về "Cần care" dù đang "chờ kết quả". */
    followUpAt: ts("follow_up_at"),
    lastNote: text("last_note").notNull().default(""),
    lastNoteAt: ts("last_note_at"),
    lastNoteBy: text("last_note_by").notNull().default(""),
    /** Lần đầu có NGƯỜI động vào (đổi trạng thái / ghi note / gọi). Đo thời gian phản hồi đầu. */
    firstResponseAt: ts("first_response_at"),
    doneAt: ts("done_at"),
    escalatedAt: ts("escalated_at"),
    /*
      MỖI BÁO CÁO HỎI MỘT CÂU KHÁC NHAU NÊN PHẢI CÓ ĐỦ MỐC.

        khối lượng việc  → `openedAt`    (đợt mở lúc nào)
        hiệu suất người  → `outcomeAt`   (kết cục chốt lúc nào)
        số thao tác      → mốc của từng dòng `care_business_actions`

      Dùng chung một cột cho cả ba là cách chắc chắn nhất để một báo cáo trả lời câu hỏi của báo
      cáo khác mà không ai nhận ra.
    */
    openedAt: ts("opened_at"),
    assignedAt: ts("assigned_at"),
    firstActionAt: ts("first_action_at"),
    lastActionAt: ts("last_action_at"),
    outcomeAt: ts("outcome_at"),
    /**
     * `resolution` là QUYẾT ĐỊNH của shop; `finalCarrierState` / `finalLogisticsOutcome` là CHỨNG
     * TỪ của ĐVVC. Hai cột riêng, cố ý: "duyệt hoàn" KHÔNG phải "đã hoàn".
     */
    resolution: text("resolution"),
    finalCarrierState: text("final_carrier_state"),
    finalLogisticsOutcome: text("final_logistics_outcome"),
    /** `RESCUED_DIRECT` · `RESCUED_EXCHANGE` · `RESCUE_FAILED` · `PENDING` · `UNATTRIBUTED`. */
    careOutcome: text("care_outcome"),
    /** Người CHỊU TRÁCH NHIỆM lúc chốt kết quả — khác `ownerId` (người đang cầm ca). */
    ownerAtResolution: text("owner_at_resolution").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    initialOwnerId: text("initial_owner_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    /** Đơn đổi nối với ca này. Không có nó thì "cứu bằng đơn đổi" chỉ đoán được, không đo được. */
    replacementOrderId: text("replacement_order_id").references((): AnyPgColumn => orders.id, { onDelete: "set null" }),
    replacementShipmentId: text("replacement_shipment_id").references((): AnyPgColumn => shipments.id, { onDelete: "set null" }),
    /** Số lần kiện quay lại hàng đợi SAU khi đã đóng. */
    reopenCount: integer("reopen_count").notNull().default(0),
    updatedBy: text("updated_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shipment_care_status_idx").on(t.careStatus, t.followUpAt),
    index("shipment_care_owner_idx").on(t.ownerId, t.careStatus),
    // TỐI ĐA MỘT ĐỢT ĐANG MỞ cho mỗi kiện — ràng buộc nằm ở CSDL, không ở mã nguồn.
    uniqueIndex("shipment_care_active_uidx").on(t.shipmentId).where(sql`${t.active}`),
    index("shipment_care_outcome_idx").on(t.careOutcome, t.outcomeAt),
    index("shipment_care_resolution_owner_idx").on(t.ownerAtResolution, t.outcomeAt),
    check("shipment_care_outcome_check", sql`${t.careOutcome} IS NULL OR ${t.careOutcome} IN ('RESCUED_DIRECT', 'RESCUED_EXCHANGE', 'RESCUE_FAILED', 'PENDING', 'UNATTRIBUTED')`),
    check("shipment_care_status_check", sql`${t.careStatus} IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_CARRIER', 'WAITING_REDELIVERY', 'RESOLVED', 'ESCALATED', 'CANCELLED')`),
  ],
);

/**
 * ═══════════ YÊU CẦU GỬI ĐVVC: VÒNG ĐỜI ĐẦY ĐỦ, KHÔNG GIẢ VỜ THÀNH CÔNG ═══════════
 *
 *   PENDING → SENT → ACKNOWLEDGED (API nhận) → SUCCESS (sự kiện ĐVVC xác nhận) | FAILED | UNSUPPORTED
 *   MANUAL_REQUIRED (tài khoản API không có quyền trên kiện này) → MANUAL_DONE (người xác nhận đã làm tay)
 *
 * Mỗi yêu cầu có khoá idempotent, payload gửi đi, phản hồi nhận về, ai gửi, lúc nào. "Đã xử lý"
 * không bao giờ được ghi trước khi ĐVVC xác nhận.
 */
export const carrierActionRequests = pgTable(
  "carrier_action_requests",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    orderNumber: text("order_number").notNull().default(""),
    /** `redeliver` · `approve-return` · `resend` · `approve` · `cancel` · `edit` — xem `lib/constants/care.ts`. */
    actionKey: text("action_key").notNull(),
    status: text("status").notNull().default("PENDING"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** Dữ liệu nghiệp vụ của yêu cầu (loại, ghi chú, trường sửa). */
    payload: jsonb("payload"),
    /** Thân gói tin THÔ gửi đi và phản hồi THÔ nhận về — để truy lại đúng những gì ĐVVC nhìn thấy. */
    rawRequest: jsonb("raw_request"),
    response: jsonb("response"),
    error: text("error"),
    /** Số lần đã gọi API (retry hữu hạn, chỉ khi lỗi tạm thời). */
    attempts: integer("attempts").notNull().default(0),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    note: text("note").notNull().default(""),
    sentAt: ts("sent_at"),
    ackAt: ts("ack_at"),
    /** Mốc ĐVVC xác nhận bằng SỰ KIỆN (không phải bằng phản hồi API). */
    confirmedAt: ts("confirmed_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("carrier_action_shipment_idx").on(t.shipmentId, t.createdAt),
    index("carrier_action_status_idx").on(t.status, t.createdAt),
    check("carrier_action_status_check", sql`${t.status} IN ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SUCCESS', 'FAILED', 'UNSUPPORTED', 'MANUAL_REQUIRED', 'MANUAL_DONE')`),
  ],
);

/**
 * ═══════════ LỊCH SỬ CASE — CHỈ THÊM, KHÔNG SỬA, KHÔNG XOÁ ═══════════
 *
 * Mỗi lần đổi trạng thái / giao người / note / hẹn / gửi ĐVVC là MỘT dòng: ai, lúc nào, làm gì, từ
 * trạng thái nào sang trạng thái nào, SLA lúc đó ra sao, nguồn (UI / API / AI / hệ thống). Bảng này
 * là nguồn cho "thời gian phản hồi đầu", "mở lại", "workload" — không ai được viết lại quá khứ.
 */
/**
 * ═══════════ BỐN QUYẾT ĐỊNH NGHIỆP VỤ — GHI THÊM, KHÔNG BAO GIỜ GHI ĐÈ ═══════════
 *
 * Khác `care_actions` (ghi việc chăm sóc thô: đã gọi, đã nhắn) và khác `care_case_events` (ghi mọi
 * lần đổi trạng thái / giao người / ghi chú). Bảng này ghi đúng bốn QUYẾT ĐỊNH mà người xử lý đưa
 * ra — Duyệt hoàn · Phát tiếp · Đổi · Theo dõi tiếp — kèm đủ bối cảnh để nhật ký trả lời được:
 *
 *   ai · lúc nào · trên kiện nào · quyết định gì · trạng thái xử lý trước và sau ·
 *   gửi lệnh gì sang ĐVVC · ĐVVC trả lời ra sao · ghi chú gì.
 *
 * `ownerIdAtAction` là ẢNH CHỤP người đang cầm ca lúc đó, không tính lại theo người cầm hôm nay:
 * A nhận ca rồi chuyển B thì việc A đã làm vẫn là của A.
 */
export const careBusinessActions = pgTable(
  "care_business_actions",
  {
    id: id(),
    careCaseId: text("care_case_id")
      .notNull()
      .references(() => shipmentCare.id, { onDelete: "cascade" }),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    ownerIdAtAction: text("owner_id_at_action").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    /** `APPROVE_RETURN` · `REQUEST_REDELIVERY` · `EXCHANGE` · `CONTINUE_MONITORING`. */
    actionType: text("action_type").notNull(),
    /** Lý do theo DANH MỤC (đếm được) — tách khỏi `reasonNote` là ô chữ tự do (không đếm được). */
    reasonCode: text("reason_code"),
    reasonNote: text("reason_note").notNull().default(""),
    requestedAt: ts("requested_at").notNull().defaultNow(),
    /** Nối sang sổ lệnh ĐVVC. NULL với hai hành động không gửi lệnh (Đổi, Theo dõi tiếp). */
    carrierCommandId: text("carrier_command_id").references(() => carrierActionRequests.id, { onDelete: "set null" }),
    carrierResult: text("carrier_result"),
    previousCareStatus: text("previous_care_status"),
    nextCareStatus: text("next_care_status"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    index("care_business_actions_case_idx").on(t.careCaseId, t.createdAt),
    index("care_business_actions_actor_idx").on(t.actorUserId, t.createdAt),
    index("care_business_actions_shipment_idx").on(t.shipmentId, t.createdAt),
    check("care_business_actions_type_check", sql`${t.actionType} IN ('APPROVE_RETURN', 'REQUEST_REDELIVERY', 'EXCHANGE', 'CONTINUE_MONITORING')`),
  ],
);

export const careCaseEvents = pgTable(
  "care_case_events",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    /** `UI` · `API` · `AI` · `SYSTEM` — xem `CARE_EVENT_SOURCES`. */
    source: text("source").notNull().default("UI"),
    /** `STATUS` · `ASSIGN` · `NOTE` · `FOLLOW_UP` · `RESOLVE` · `REOPEN` · `CANCEL` · `CARRIER_*` — xem `CARE_EVENT_ACTIONS`. */
    action: text("action").notNull(),
    note: text("note").notNull().default(""),
    previousStatus: text("previous_status"),
    nextStatus: text("next_status"),
    previousOwner: text("previous_owner"),
    nextOwner: text("next_owner"),
    /**
     * CHỦ VIỆC BẰNG KHOÁ. Hai cột `*_owner` ở trên lưu EMAIL — đọc được nhưng người đổi email là
     * mất dấu, và `""` với `NULL` trông giống nhau. `NULL` ở đây nghĩa là CHƯA AI NHẬN (UNASSIGNED).
     */
    previousOwnerId: text("previous_owner_id").references(() => users.id, { onDelete: "set null" }),
    nextOwnerId: text("next_owner_id").references(() => users.id, { onDelete: "set null" }),
    followUpAt: ts("follow_up_at"),
    /** Ảnh chụp SLA lúc xảy ra: mốc vào hàng đợi, hạn phản hồi đầu, hạn đóng, đã vỡ chưa. */
    sla: jsonb("sla"),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [
    index("care_case_events_shipment_idx").on(t.shipmentId, t.createdAt),
    index("care_case_events_actor_idx").on(t.actorEmail, t.createdAt),
    check("care_case_events_source_check", sql`${t.source} IN ('UI', 'API', 'AI', 'SYSTEM')`),
  ],
);

/**
 * ═══════════ NHẬT KÝ TƯƠNG TÁC AI — AI KHÔNG ĐƯỢC LÀM GÌ MÀ KHÔNG ĐỂ LẠI DẤU ═══════════
 *
 * Mỗi lượt hỏi/đáp một dòng: ai hỏi, ở màn hình nào, model nào, gọi tool gì với input gì, hành
 * động nào ĐƯỢC ĐỀ NGHỊ và hành động nào ĐÃ CHẠY (chỉ sau khi người xác nhận), token / chi phí /
 * độ trễ. Không ghi secret, không ghi nguyên gói dữ liệu — chỉ tên tool + input + tóm tắt kết quả.
 */
export const aiInteractions = pgTable(
  "ai_interactions",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    userEmail: text("user_email").notNull().default(""),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Bối cảnh màn hình: route + đối tượng đang xem. */
    route: text("route").notNull().default(""),
    entityType: text("entity_type").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    /** Câu hỏi của người dùng (cắt 4000 ký tự). */
    prompt: text("prompt").notNull().default(""),
    /** Câu trả lời cuối của AI (cắt 8000 ký tự). */
    answer: text("answer").notNull().default(""),
    /** [{ name, input, kind, executed, ok, summary }] */
    toolCalls: jsonb("tool_calls"),
    /** Hành động ghi AI đề nghị, chờ người xác nhận: [{ token, name, input }]. */
    actionsProposed: jsonb("actions_proposed"),
    /** Hành động ghi ĐÃ chạy sau khi người xác nhận: [{ token, name, input, result }]. */
    actionsExecuted: jsonb("actions_executed"),
    usage: jsonb("usage"),
    /** USD, 6 chữ số thập phân — ước tính theo bảng giá trong mã, không phải hoá đơn. */
    costUsd: text("cost_usd").notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    rounds: integer("rounds").notNull().default(0),
    status: text("status").notNull().default("OK"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_interactions_user_idx").on(t.userId, t.createdAt),
    index("ai_interactions_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    check("ai_interactions_status_check", sql`${t.status} IN ('OK', 'NEEDS_CONFIRMATION', 'REFUSED', 'ERROR')`),
  ],
);

export const careActions = pgTable(
  "care_actions",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    /** Loại hành động — xem `CARE_ACTION_KINDS`. Ghi nhận việc ĐÃ LÀM, không phải việc định làm. */
    kind: text("kind").notNull(),
    note: text("note").notNull().default(""),
    /*
      ẢNH CHỤP BỐI CẢNH LÚC HÀNH ĐỘNG — cố ý không tính lại về sau.

      So sánh "trước / sau khi có người chăm" phải đứng trên trạng thái LÚC ĐÓ. Tính lại theo trạng
      thái hôm nay là hỏi "kiện này giờ ra sao" chứ không phải "việc chăm có tác dụng gì".
    */
    stageAtAction: text("stage_at_action").notNull().default(""),
    bucketAtAction: text("bucket_at_action").notNull().default(""),
    /** `NULL` = CHƯA BIẾT (vận đơn không gắn đơn), không phải 0đ. */
    codAtAction: bigint("cod_at_action", { mode: "number" }),
    eventAgeHoursAtAction: integer("event_age_hours_at_action"),
    failedAttemptsAtAction: integer("failed_attempts_at_action"),
    createdAt: createdAt(),
  },
  (t) => [index("care_actions_shipment_idx").on(t.shipmentId, t.createdAt), index("care_actions_created_idx").on(t.createdAt)],
);

/**
 * ═══════════ PHỄU HỘI THOẠI — GIỮ LẠI BẰNG CHỨNG ĐANG BỊ NÉM ĐI ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` · hằng số: `lib/constants/conversion.ts`.
 *
 * ─── VÌ SAO BẢNG NÀY CẦN TỒN TẠI ───
 *
 * `docs/sales-funnel-contract.md` kết luận hai bước đầu của phễu là KHÔNG ĐO ĐƯỢC vì "ERP không
 * đồng bộ hội thoại Pancake". `lib/constants/operating-funnel.ts` nói ở khâu `LEAD`: *"Không có
 * mốc phản hồi đầu tiên cho từng lead, nên tỷ lệ và thời gian phản hồi CHƯA đo được."*
 *
 * Nhưng job `cs-chat` vẫn gọi Pancake Pages API mỗi 15 phút, đọc hội thoại và tới 50 tin nhắn mỗi
 * hội thoại, tính ra lúc khách cho SĐT và lúc khách cho địa chỉ — rồi **ném đi tất cả** trừ những
 * ca sinh ra case CSKH.
 *
 * Hệ quả là MẪU SỐ BIẾN MẤT: `cs_cases` chỉ giữ ca đủ thông tin mà CHƯA có đơn (ca đã có đơn không
 * sinh case). Không có mẫu số thì không có tỷ lệ chuyển đổi — chính `getOrderIntakeMetrics` phải tự
 * cảnh báo rằng con số của nó "KHÔNG phải tỷ lệ chuyển của cả khâu". Đo trên chính lượt quét ngày
 * 11/09/2026: 157 khách đủ thông tin, 136 đã có đơn, chỉ 21 ca thành case — nghĩa là 87% bằng chứng
 * bị mất ngay tại chỗ.
 *
 * Bảng này KHÔNG thêm suy diễn nào. Nó chỉ ghi lại thứ job đã đọc được.
 *
 * ─── NULL LÀ CHƯA BIẾT ───
 *
 * Mọi mốc thời gian ở đây `NULL` nghĩa là **chưa quan sát được trong cửa sổ quét**, KHÔNG phải
 * "không xảy ra". Hội thoại có thể đã có SĐT từ trước cửa sổ 48 giờ. Vì thế `scan_window_from` lưu
 * mốc sớm nhất ta THẬT SỰ nhìn thấy — không có nó thì không phân biệt được "khách chưa cho số" với
 * "ta chưa đọc tới đoạn khách cho số".
 */
export const conversationFunnel = pgTable(
  "conversation_funnel",
  {
    id: id(),
    /** Page Facebook của hội thoại. Khoá tự nhiên là (page_id, conversation_id). */
    pageId: text("page_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    /** `customer_id` của Pancake trong hội thoại — cần để gọi lại API tin nhắn. */
    pancakeCustomerId: text("pancake_customer_id").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    /** SĐT khách đã cho (chỉ chữ số). `NULL` = chưa thấy trong cửa sổ quét. */
    phone: text("phone"),

    /* ───── MỐC THỜI GIAN: NGUỒN DUY NHẤT CHO THỜI GIAN PHẢN HỒI ───── */
    /** Tin ĐẦU TIÊN của khách mà ta nhìn thấy. Bước 1 của phễu. */
    firstCustomerMessageAt: ts("first_customer_message_at"),
    /**
     * Tin ĐẦU TIÊN của shop SAU tin đầu của khách. Đây là thứ làm "thời gian phản hồi" đo được —
     * mốc mà cả hai đặc tả phễu trước đây đều nói là không có.
     */
    firstShopReplyAt: ts("first_shop_reply_at"),
    lastCustomerMessageAt: ts("last_customer_message_at"),
    lastShopMessageAt: ts("last_shop_message_at"),
    customerMessageCount: integer("customer_message_count").notNull().default(0),
    shopMessageCount: integer("shop_message_count").notNull().default(0),

    /*
      ───── KHÔNG CÓ CỘT "Ý ĐỊNH MUA", VÀ ĐÓ LÀ MỘT QUYẾT ĐỊNH ─────

      Kế hoạch ban đầu có một bước phễu "đủ điều kiện / có ý định mua". ERP KHÔNG có nguồn nào cho
      nó. Mọi căn cứ nghĩ ra được đều là một trong hai thứ:

       · chính SĐT hoặc địa chỉ khách đã cho — tức là ĐÚNG hai cột dưới đây, chỉ đổi tên. Đếm nó
         thành một bước riêng là nhân đôi cùng một sự thật rồi gọi là hai bước;
       · máy tìm từ khoá trong câu chữ — đúng loại suy diễn đã dựng ra 181 case sai
         (xem `lib/cs/chat-detect.ts`).

      Nên bước đó được khai là KHÔNG ĐO ĐƯỢC ở `UNMEASURABLE_STAGES`
      (`lib/constants/conversion.ts`) và hiện thành một dòng "KHÔNG ĐO ĐƯỢC" có lý do trên màn hình.
      Thứ ĐO ĐƯỢC và có ích hơn nằm ngay trên: `first_shop_reply_at` — khách đã được trả lời chưa.
    */

    /* ───── SĐT VÀ ĐỊA CHỈ ───── */
    phoneAt: ts("phone_at"),
    addressAt: ts("address_at"),
    /** Nguyên văn đoạn khách gửi địa chỉ — người xử lý dán thẳng vào đơn, khỏi mở lại chat. */
    addressText: text("address_text").notNull().default(""),
    /** Lúc có ĐỦ cả SĐT và địa chỉ = mốc muộn hơn trong hai mốc trên. */
    infoCompleteAt: ts("info_complete_at"),

    /** Thẻ hội thoại Pancake — bằng chứng do NGƯỜI gắn, mạnh hơn máy suy từ câu chữ. */
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Nhân viên đã trả lời hội thoại này (tên trên tin của page). '' = chưa ai trả lời. */
    ownerName: text("owner_name").notNull().default(""),

    /* ───── GHÉP SANG ĐƠN ───── */
    matchedOrderId: text("matched_order_id").references(() => orders.id, { onDelete: "set null" }),
    /** `BY_CONVERSATION` · `BY_PHONE_UNIQUE` · `AMBIGUOUS` · `NONE` — ba mức của `matchOrderForConversation`. */
    matchBasis: text("match_basis").notNull().default("NONE"),
    /** Số đơn ứng viên khi ghép bằng SĐT. > 1 ⇒ nhập nhằng, KHÔNG kết luận. */
    matchCandidates: integer("match_candidates").notNull().default(0),
    /** Mốc lên đơn của đơn đã ghép — để đo "từ đủ thông tin tới có đơn" không phải join lại. */
    matchedOrderAt: ts("matched_order_at"),
    /**
     * Lượt quét chạm TRẦN 200 hội thoại/page ⇒ page đó còn hội thoại chưa đọc. Không ghi cờ này thì
     * một con số bị cắt trông y hệt một con số đầy đủ.
     */
    truncated: boolean("truncated").notNull().default(false),

    /* ───── ĐỘ PHỦ: KHÔNG CÓ NÓ THÌ MỌI TỶ LỆ ĐỀU BỊA ───── */
    /** Lần đầu ERP ghi được hội thoại này. */
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastScanAt: ts("last_scan_at").notNull().defaultNow(),
    /**
     * Mốc SỚM NHẤT ta thật sự đọc được tin trong hội thoại này. Tin cũ hơn mốc này chưa bao giờ
     * được đọc, nên `NULL` ở các mốc trên có thể chỉ là chưa đọc tới — không phải chưa xảy ra.
     */
    scanWindowFrom: ts("scan_window_from"),
    /** Nguyên văn đoạn làm căn cứ cho từng mốc: `{ intent, phone, address }`. Để người kiểm chứng được. */
    evidence: jsonb("evidence"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversation_funnel_uq").on(t.pageId, t.conversationId),
    index("conversation_funnel_first_msg_idx").on(t.firstCustomerMessageAt),
    index("conversation_funnel_info_idx").on(t.infoCompleteAt),
    index("conversation_funnel_order_idx").on(t.matchedOrderId),
    index("conversation_funnel_unanswered_idx").on(t.firstShopReplyAt, t.lastCustomerMessageAt),
    check("conversation_funnel_match_basis_check", sql`${t.matchBasis} IN ('BY_CONVERSATION','BY_PHONE_UNIQUE','AMBIGUOUS','NONE')`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   HỆ ĐIỀU HÀNH CÔNG VIỆC (Work OS) — đặc tả: docs/work-management-os.md

   Bảy bảng dưới đây KHÔNG chép dữ liệu nghiệp vụ. Chúng thêm đúng ba thứ ERP chưa từng có:
   tầng tổ chức (phòng ban), lớp công việc (giao/hạn/hoãn/chặn cho việc đã tồn tại ở miền khác),
   và tầng mục tiêu (OKR / BSC / kỳ review).

   Việc sinh ra từ `cs_cases`, `shipment_care`, `bank_transactions`… KHÔNG có dòng ở đây trừ khi
   có người chạm vào (giao cho ai, đặt hạn, hoãn, ghi chú). Hàng đợi là PHÉP CHIẾU, không phải bản
   sao — xem `lib/queries/work-adapters.ts`.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

export const departments = pgTable(
  "departments",
  {
    id: id(),
    /** `MANAGEMENT` · `MARKETING` · `SALES` · `LOGISTICS` · `WAREHOUSE` · `FINANCE` · `HR` — hoặc mã do chủ shop đặt. */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    leadUserId: text("lead_user_id").references(() => users.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(100),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("departments_active_idx").on(t.active, t.sortOrder)],
);

export const departmentMembers = pgTable(
  "department_members",
  {
    id: id(),
    departmentId: text("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `LEAD` · `MEMBER`. Trưởng phòng thấy toàn bộ việc của phòng. */
    roleInDept: text("role_in_dept").notNull().default("MEMBER"),
    /** Chức danh hiển thị, tự do. Không dùng để phân quyền. */
    title: text("title").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Một người ở một phòng đúng một dòng. Muốn ở hai phòng thì hai dòng — điều đó hợp lệ ở shop nhỏ.
    uniqueIndex("department_members_uq").on(t.departmentId, t.userId),
    index("department_members_user_idx").on(t.userId, t.active),
    check("department_members_role_check", sql`${t.roleInDept} IN ('LEAD', 'MEMBER')`),
  ],
);

/**
 * ═══════════ LỚP CÔNG VIỆC ═══════════
 *
 * Bảng này giữ HAI loại dòng, và cột `authority` nói rõ dòng nào là loại nào:
 *
 *  · `authority = 'WORK'`   — việc tay / việc định kỳ. Không miền nào sở hữu, nên bảng này LÀ
 *    nguồn: `status` bắt buộc có giá trị.
 *  · `authority = 'SOURCE'` — LỚP GHI CHÚ cho một việc đã tồn tại ở miền nghiệp vụ (case CSKH,
 *    kiện care, dòng tiền chưa phân loại…). Chỉ giữ thứ miền kia không có: người nhận ở tầng công
 *    việc, ưu tiên đặt tay, hạn đặt tay, hoãn tới, lý do chặn. `status` bắt buộc `NULL`.
 *
 * Ràng buộc `work_items_authority_check` làm điều đó thành BẤT KHẢ THI ở mức CSDL, không phải một
 * quy ước người ta nhớ hay quên. Nếu không có nó, một ngày nào đó `cs_cases.status = 'DONE'` sẽ
 * đứng cạnh `work_items.status = 'IN_PROGRESS'` và không ai biết bên nào đúng.
 *
 * `(source_type, source_key)` UNIQUE: `source_key` là khoá tự nhiên TẠI NGUỒN, nên "hai việc cho
 * cùng một gốc" là điều không biểu diễn được. Chống trùng ở đây là tính chất cấu trúc.
 */
export const workItems = pgTable(
  "work_items",
  {
    id: id(),
    /** Xem `lib/constants/work-sources.ts::WORK_SOURCES`. */
    sourceType: text("source_type").notNull(),
    /** Khoá tự nhiên tại nguồn (`cs_cases.id`, `shipment_care.shipment_id`, `bank_transactions.id`…). */
    sourceKey: text("source_key").notNull(),
    /** `SOURCE` | `WORK` — phải khớp `WORK_SOURCE_SPEC[sourceType].statusAuthority`; contract test khoá. */
    authority: text("authority").notNull(),

    /* ───── Nội dung: CHỈ điền cho dòng `WORK`. Dòng `SOURCE` đọc tiêu đề từ nguồn. ───── */
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),

    departmentId: text("department_id").references(() => departments.id, { onDelete: "set null" }),
    /** Người ĐANG CẦM việc ở tầng công việc. Khác người phụ trách ở nguồn — xem chú thích bảng. */
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: ts("assigned_at"),
    /** Người chịu trách nhiệm cuối (thường là trưởng phòng). Khác người làm. */
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),

    /** `NULL` với dòng `SOURCE` — trạng thái nằm ở miền nghiệp vụ. Ràng buộc CHECK ép điều đó. */
    status: text("status"),
    /** Mức ưu tiên ĐẶT TAY, đè lên mức tính được. `NULL` = dùng mức tính được. */
    priority: text("priority"),
    /** Hạn cam kết của người làm. Khác SLA của loại việc: SLA là luật, cái này là lời hứa. */
    dueAt: ts("due_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    completedBy: text("completed_by").references(() => users.id, { onDelete: "set null" }),
    /** Hoãn tới. Việc không biến mất, chỉ thôi nổi lên trước giờ này. */
    snoozedUntil: ts("snoozed_until"),
    /** Bắt buộc khi `status = 'BLOCKED'` — chặn mà không nói vì sao thì không ai gỡ được. */
    blockedReason: text("blocked_reason").notNull().default(""),

    /* ───── Việc định kỳ ───── */
    recurrenceId: text("recurrence_id"),
    /** Kỳ mà dòng này đại diện (`2026-09-12`, `2026-W37`…). Cùng `recurrence_id` là khoá chống sinh hai lần. */
    occurrenceKey: text("occurrence_key").notNull().default(""),

    /* ───── Liên kết nghiệp vụ (CHỈ để mở đúng chỗ, không phải bản sao dữ liệu) ───── */
    businessEntity: text("business_entity").notNull().default("NONE"),
    businessEntityId: text("business_entity_id").notNull().default(""),

    /**
     * Tiền do NGƯỜI khai cho việc tay. `NULL` = CHƯA BIẾT, không phải 0đ (AGENTS.md mục 0.3).
     * Việc chiếu từ miền nghiệp vụ KHÔNG dùng hai cột này — tiền của chúng tính sống từ nguồn.
     */
    moneyAtRisk: bigint("money_at_risk", { mode: "number" }),
    moneyRecoverable: bigint("money_recoverable", { mode: "number" }),
    /** `MEASURED` · `ESTIMATED` · `UNKNOWN`. Khác `UNKNOWN` thì `money_basis` bắt buộc có chữ. */
    moneyConfidence: text("money_confidence").notNull().default("UNKNOWN"),
    moneyBasis: text("money_basis").notNull().default(""),

    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    checklist: jsonb("checklist").$type<{ text: string; done: boolean }[]>().notNull().default([]),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    /** `AUTO` · `MANUAL` · `RECURRING`. */
    creationSource: text("creation_source").notNull().default("MANUAL"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("work_items_source_uq").on(t.sourceType, t.sourceKey),
    index("work_items_assignee_idx").on(t.assigneeId, t.status),
    index("work_items_department_idx").on(t.departmentId, t.status),
    index("work_items_due_idx").on(t.dueAt),
    index("work_items_recurrence_idx").on(t.recurrenceId, t.occurrenceKey),
    check("work_items_authority_enum_check", sql`${t.authority} IN ('SOURCE', 'WORK')`),
    /*
      ĐÂY LÀ RÀNG BUỘC QUAN TRỌNG NHẤT CỦA BẢNG.

      Một dòng chiếu từ miền nghiệp vụ KHÔNG được giữ trạng thái, và một việc tay BẮT BUỘC phải
      giữ. Viết bằng CHECK chứ không bằng quy ước, vì quy ước sẽ bị phá vào lúc không ai nhìn.
    */
    check("work_items_authority_check", sql`(${t.authority} = 'WORK') = (${t.status} IS NOT NULL)`),
    check("work_items_status_check", sql`${t.status} IS NULL OR ${t.status} IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'WAITING', 'DONE', 'CANCELLED')`),
    check("work_items_priority_check", sql`${t.priority} IS NULL OR ${t.priority} IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')`),
    check("work_items_money_confidence_check", sql`${t.moneyConfidence} IN ('MEASURED', 'ESTIMATED', 'UNKNOWN')`),
    // Nói một con số là đo được / ước tính thì phải nói ĐO BẰNG GÌ.
    check("work_items_money_basis_check", sql`${t.moneyConfidence} = 'UNKNOWN' OR length(btrim(${t.moneyBasis})) > 0`),
    // Chặn mà không nói vì sao là xoá bằng chứng lặng lẽ — cùng luật với `notifications.ignored_reason`.
    check("work_items_blocked_reason_check", sql`${t.status} IS DISTINCT FROM 'BLOCKED' OR length(btrim(${t.blockedReason})) > 0`),
    check("work_items_creation_source_check", sql`${t.creationSource} IN ('AUTO', 'MANUAL', 'RECURRING')`),
  ],
);

/**
 * Lịch sử một việc — CHỈ THÊM, KHÔNG SỬA, KHÔNG XOÁ.
 *
 * Cùng hình dạng với `cs_case_events` và `care_case_events` để ba bàn làm việc đọc được như nhau.
 * `audit_logs` không thay được: audit là nhật ký AN NINH (ai đụng vào cái gì), đây là nhật ký
 * NGHIỆP VỤ mà người nhận ca sau phải đọc được ngay trên dòng.
 *
 * Ghi được cho CẢ việc chiếu: `work_key` là `<sourceType>:<sourceKey>`, nên một ghi chú gắn vào
 * một case CSKH không cần bảng `work_items` phải có dòng.
 */
export const workItemEvents = pgTable(
  "work_item_events",
  {
    id: id(),
    /** `<sourceType>:<sourceKey>` — ổn định kể cả khi chưa có dòng `work_items`. */
    workKey: text("work_key").notNull(),
    workItemId: text("work_item_id").references(() => workItems.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    /** Ảnh chụp tên lúc xảy ra — người dùng có thể đổi tên hoặc nghỉ việc. */
    actorName: text("actor_name").notNull().default(""),
    /** `UI` · `API` · `SYSTEM` · `RECURRENCE`. */
    source: text("source").notNull().default("UI"),
    /** `CREATE` · `STATUS` · `ASSIGN` · `NOTE` · `SNOOZE` · `DUE` · `PRIORITY` · `BLOCK` · `DOMAIN_ACTION`. */
    action: text("action").notNull(),
    note: text("note").notNull().default(""),
    previousStatus: text("previous_status"),
    nextStatus: text("next_status"),
    previousAssignee: text("previous_assignee"),
    nextAssignee: text("next_assignee"),
    /** Với `DOMAIN_ACTION`: tên hành động miền đã gọi và kết quả tóm tắt. */
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [
    index("work_item_events_key_idx").on(t.workKey, t.createdAt),
    index("work_item_events_actor_idx").on(t.actorEmail, t.createdAt),
    check("work_item_events_source_check", sql`${t.source} IN ('UI', 'API', 'SYSTEM', 'RECURRENCE')`),
  ],
);

/**
 * Định nghĩa việc lặp: đối soát hằng ngày, review quảng cáo, kiểm kê, chốt công.
 *
 * KHÔNG dùng cron string. Bốn nhịp cố định phủ hết nhu cầu thật của shop và đọc được bằng tiếng
 * Việt trên màn hình; một ô nhập cron là mời gọi sai lịch mà không ai phát hiện.
 */
export const workRecurrences = pgTable(
  "work_recurrences",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    departmentId: text("department_id").references(() => departments.id, { onDelete: "set null" }),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    priority: text("priority").notNull().default("NORMAL"),
    /** `DAILY` · `WEEKDAYS` · `WEEKLY` · `MONTHLY`. */
    cadence: text("cadence").notNull(),
    /** Với `WEEKLY`: 1=thứ Hai … 7=Chủ nhật. Với `MONTHLY`: ngày trong tháng (1–28). */
    cadenceDay: integer("cadence_day"),
    /** Giờ trong ngày (0–23, giờ Việt Nam) mà việc của kỳ đó xuất hiện. */
    hourOfDay: integer("hour_of_day").notNull().default(8),
    /** Số giờ kể từ lúc sinh tới hạn. */
    dueInHours: integer("due_in_hours").notNull().default(24),
    checklist: jsonb("checklist").$type<{ text: string; done: boolean }[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    lastGeneratedKey: text("last_generated_key").notNull().default(""),
    lastGeneratedAt: ts("last_generated_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_recurrences_active_idx").on(t.active),
    check("work_recurrences_cadence_check", sql`${t.cadence} IN ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY')`),
    check("work_recurrences_priority_check", sql`${t.priority} IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')`),
    check("work_recurrences_hour_check", sql`${t.hourOfDay} BETWEEN 0 AND 23`),
    // Ngày 29–31 không tồn tại ở mọi tháng: chặn ở CSDL thay vì để việc tháng 2 im lặng không sinh.
    check("work_recurrences_day_check", sql`${t.cadenceDay} IS NULL OR (${t.cadence} = 'WEEKLY' AND ${t.cadenceDay} BETWEEN 1 AND 7) OR (${t.cadence} = 'MONTHLY' AND ${t.cadenceDay} BETWEEN 1 AND 28)`),
  ],
);

/* ───────────────────────── MỤC TIÊU: OKR ───────────────────────── */

/**
 * Objective — ĐỊNH TÍNH. Ba tầng: công ty → phòng ban → cá nhân, nối bằng `parent_id`.
 * Objective KHÔNG có số; số nằm ở Key Result. Trộn hai thứ là cách nhanh nhất biến OKR thành
 * một danh sách KPI đội lốt.
 */
/**
 * ═══════════ ĐÍCH CỦA CHỈ SỐ — BA TẦNG, KHÔNG HARD-CODE ═══════════
 *
 * "Đóng case trong hạn phải đạt 90%" là một quyết định KINH DOANH. Viết 90 vào mã nguồn có hai
 * hậu quả: chủ shop muốn đổi thì phải chờ deploy, và không ai còn biết con số đó do AI đặt, đặt
 * lúc nào, vì sao.
 *
 * Ba tầng, tầng sau đè tầng trước:
 *   1. CÔNG TY   — mặc định cho mọi người
 *   2. PHÒNG BAN — phòng có đặc thù riêng
 *   3. CHỨC DANH — trưởng phòng và nhân viên mới không cùng một thước đo
 *
 * KHÔNG có đích thì màn hình hiện THỰC TẾ và không kết luận đạt/không đạt. Một chỉ số không có
 * đích vẫn là một con số đọc được; bịa ra đích để có màu xanh đỏ mới là cái sai.
 */
export const metricTargets = pgTable(
  "metric_targets",
  {
    id: id(),
    /** Khoá trong `lib/constants/metric-catalog.ts::METRIC_CATALOG`. Không nhận khoá lạ. */
    metricKey: text("metric_key").notNull(),
    /** `COMPANY` · `DEPARTMENT` · `POSITION` — tầng của đích này. */
    scope: text("scope").notNull(),
    /**
     * Mã phòng ban (`DepartmentCode`) hoặc `positions.id`. `NULL` với tầng công ty.
     * KHÔNG đặt khoá ngoại tới `positions`: đích đã đặt phải sống sót khi chức danh bị đổi tên.
     */
    scopeRef: text("scope_ref"),
    /** Đích. Đơn vị lấy từ danh mục, không lưu lại ở đây — hai chỗ lưu là hai chỗ lệch nhau. */
    target: doublePrecision("target").notNull(),
    /**
     * Cận TRÊN của một đích dạng DẢI (số ngày đủ bán, tồn khoẻ mạnh…). `NULL` = đích một chiều.
     * Chiều `RANGE` được SUY RA từ chỗ cột này có giá trị hay không, không khai thêm một cột
     * `direction` thứ hai: chiều của chỉ số đã nằm trong sổ, ghi lại là mở đường cho hai nơi nói
     * hai điều khác nhau (AGENTS.md mục 23).
     */
    targetMax: doublePrecision("target_max"),
    /** Bắt đầu đáng lo. `NULL` = chủ shop chưa khai, và màn hình KHÔNG tự nghĩ ra một ngưỡng. */
    warningAt: doublePrecision("warning_at"),
    /** Đã hỏng. Cùng nguyên tắc: không có mặc định do người viết code đặt. */
    criticalAt: doublePrecision("critical_at"),
    /**
     * Đích này áp cho kỳ hình dạng nào: `ANY` · `WEEK` · `MONTH` · `QUARTER` · `YEAR`.
     *
     * Một đích "500 đơn" không có nghĩa nếu không nói 500 đơn MỘT TUẦN hay MỘT THÁNG. `ANY` nghĩa
     * là CHƯA KHAI (áp cho mọi kỳ) — không phải "mỗi tháng"; đoán hộ một kỳ còn tệ hơn để trống.
     */
    periodKind: text("period_kind").notNull().default("ANY"),
    /** Hết hiệu lực. `NULL` = còn hiệu lực tới khi có bản mới hơn thay. */
    effectiveTo: ts("effective_to"),
    /** Lần đổi thứ mấy của CÙNG một đích. Để đọc lại lịch sử quyết định, không chỉ con số cuối. */
    version: integer("version").notNull().default(1),
    /**
     * Phòng ban CHỊU TRÁCH NHIỆM về đích này — khác người ĐẶT đích (`set_by`).
     *
     * Trỏ tới PHÒNG BAN, không bao giờ tới một cá nhân: máy không biết hôm nay ai nghỉ, và một
     * đích mang tên người đã nghỉ việc sẽ biến mất khỏi mọi màn hình (AGENTS.md mục 22).
     */
    ownerDepartment: text("owner_department"),
    /** Vì sao đặt con số này. Bắt buộc: một đích không có lý do thì kỳ sau không ai dám sửa. */
    note: text("note").notNull().default(""),
    /** Có hiệu lực từ. Kỳ đã chốt trước mốc này KHÔNG bị chấm lại theo đích mới. */
    effectiveFrom: ts("effective_from").notNull(),
    setBy: text("set_by").references(() => users.id, { onDelete: "set null" }),
    setByEmail: text("set_by_email").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /*
      Một tầng · một chỉ số · một HÌNH DẠNG KỲ · một mốc hiệu lực = MỘT đích. Hai dòng trùng thì
      không ai biết cái nào thắng.

      `period_kind` PHẢI nằm trong khoá. Thiếu nó thì "500 đơn mỗi TUẦN" và "2.000 đơn mỗi THÁNG"
      của cùng một chỉ số không thể cùng tồn tại — dòng thứ hai bị ràng buộc chặn, và tệ hơn: lượt
      ghi thứ hai tra dòng cũ KHÔNG theo kỳ nên nó SỬA ĐÈ đích tuần thành đích tháng. Chủ shop mất
      một đích đã đặt mà không có một dòng cảnh báo nào.
    */
    uniqueIndex("metric_targets_uq").on(t.metricKey, t.scope, sql`coalesce(${t.scopeRef}, '')`, t.periodKind, t.effectiveFrom),
    index("metric_targets_lookup_idx").on(t.metricKey, t.effectiveFrom),
    check("metric_targets_scope_check", sql`${t.scope} IN ('COMPANY', 'DEPARTMENT', 'POSITION', 'USER')`),
    check("metric_targets_period_check", sql`${t.periodKind} IN ('ANY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR')`),
    // Khoảng hiệu lực rỗng thì đích không áp cho kỳ nào, và người đặt sẽ đi tìm xem vì sao thẻ
    // điểm không thấy đích mình vừa đặt.
    check("metric_targets_window_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("metric_targets_range_check", sql`${t.targetMax} IS NULL OR ${t.targetMax} > ${t.target}`),
    check("metric_targets_version_check", sql`${t.version} >= 1`),
    // Tầng công ty KHÔNG được có tham chiếu; hai tầng kia BẮT BUỘC có.
    check("metric_targets_ref_check", sql`(${t.scope} = 'COMPANY' AND ${t.scopeRef} IS NULL) OR (${t.scope} <> 'COMPANY' AND ${t.scopeRef} IS NOT NULL AND length(trim(${t.scopeRef})) > 0)`),
  ],
);

export const okrObjectives = pgTable(
  "okr_objectives",
  {
    id: id(),
    /** `COMPANY` · `DEPARTMENT` · `INDIVIDUAL`. */
    level: text("level").notNull(),
    departmentId: text("department_id").references(() => departments.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Kỳ: `2026-Q3` · `2026-09` · `2026`. Chuỗi để so sánh và nhóm được mà không cần bảng kỳ riêng. */
    period: text("period").notNull(),
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    /** `DRAFT` · `ACTIVE` · `CLOSED` · `CANCELLED`. */
    status: text("status").notNull().default("DRAFT"),
    sortOrder: integer("sort_order").notNull().default(100),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("okr_objectives_period_idx").on(t.period, t.level),
    index("okr_objectives_dept_idx").on(t.departmentId, t.period),
    index("okr_objectives_owner_idx").on(t.ownerUserId, t.period),
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: "okr_objectives_parent_fk" }).onDelete("set null"),
    check("okr_objectives_level_check", sql`${t.level} IN ('COMPANY', 'DEPARTMENT', 'INDIVIDUAL')`),
    check("okr_objectives_status_check", sql`${t.status} IN ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED')`),
    // Objective cấp phòng / cá nhân phải nói rõ của phòng nào / của ai.
    check("okr_objectives_scope_check", sql`${t.level} = 'COMPANY' OR ${t.departmentId} IS NOT NULL OR ${t.ownerUserId} IS NOT NULL`),
  ],
);

/**
 * Key Result — ĐỊNH LƯỢNG, và đây là chỗ dễ bịa nhất trong toàn bộ hệ OKR.
 *
 * `metric_source` chỉ nhận `MANUAL` hoặc một khoá CÓ THẬT trong `lib/constants/metric-bindings.ts`.
 * Nối vào một khoá không tồn tại thì `current` sẽ mãi mãi là `NULL` và giao diện nói thẳng "chưa
 * đo được" — KHÔNG rơi về 0, vì một KR hiện 0% trông hệt như một KR đang thất bại.
 *
 * `current` để `NULL` khi CHƯA ĐO: `NULL` là CHƯA BIẾT (AGENTS.md mục 0.3).
 */
export const okrKeyResults = pgTable(
  "okr_key_results",
  {
    id: id(),
    objectiveId: text("objective_id")
      .notNull()
      .references(() => okrObjectives.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** `MANUAL` hoặc khoá trong `METRIC_BINDINGS`. */
    metricSource: text("metric_source").notNull().default("MANUAL"),
    /** `NUMBER` · `VND` · `PERCENT` · `COUNT` · `DAYS` · `HOURS`. */
    unit: text("unit").notNull().default("NUMBER"),
    /** `UP` = càng cao càng tốt; `DOWN` = càng thấp càng tốt (tỷ lệ hoàn, số dòng chưa phân loại…). */
    direction: text("direction").notNull().default("UP"),
    baseline: doublePrecision("baseline"),
    target: doublePrecision("target").notNull(),
    /** Giá trị hiện tại. `NULL` = CHƯA ĐO ĐƯỢC, khác hẳn 0. */
    current: doublePrecision("current"),
    currentAt: ts("current_at"),
    /** `ON_TRACK` · `AT_RISK` · `OFF_TRACK` · `UNKNOWN` — do người chấm, không suy máy móc từ %. */
    confidence: text("confidence").notNull().default("UNKNOWN"),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("okr_key_results_objective_idx").on(t.objectiveId, t.sortOrder),
    check("okr_key_results_unit_check", sql`${t.unit} IN ('NUMBER', 'VND', 'PERCENT', 'COUNT', 'DAYS', 'HOURS')`),
    check("okr_key_results_direction_check", sql`${t.direction} IN ('UP', 'DOWN')`),
    check("okr_key_results_confidence_check", sql`${t.confidence} IN ('ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'UNKNOWN')`),
    // Đích bằng mốc xuất phát thì phần trăm hoàn thành chia cho 0 — chặn ngay ở CSDL.
    check("okr_key_results_target_check", sql`${t.baseline} IS NULL OR ${t.target} <> ${t.baseline}`),
  ],
);

/** Lịch sử chấm KR — để có ĐƯỜNG XU HƯỚNG, không chỉ một con số hiện tại. Chỉ thêm. */
export const okrCheckins = pgTable(
  "okr_checkins",
  {
    id: id(),
    keyResultId: text("key_result_id")
      .notNull()
      .references(() => okrKeyResults.id, { onDelete: "cascade" }),
    value: doublePrecision("value"),
    confidence: text("confidence").notNull().default("UNKNOWN"),
    note: text("note").notNull().default(""),
    /** `MANUAL` = người nhập; `AUTO` = đọc từ chỉ số ERP. Trộn hai nguồn thì không ai biết số từ đâu. */
    source: text("source").notNull().default("MANUAL"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("okr_checkins_kr_idx").on(t.keyResultId, t.createdAt),
    check("okr_checkins_source_check", sql`${t.source} IN ('MANUAL', 'AUTO')`),
  ],
);

/* ───────────────────────── BSC ───────────────────────── */

/**
 * Thẻ điểm cân bằng. Bốn góc nhìn là cố định (đó là định nghĩa của BSC), nhưng chỉ số và TRỌNG SỐ
 * do chủ shop khai — không hard-code "Marketing thì đo ROAS" thành chân lý.
 */
export const bscScorecards = pgTable(
  "bsc_scorecards",
  {
    id: id(),
    /** `COMPANY` · `DEPARTMENT`. */
    scope: text("scope").notNull(),
    departmentId: text("department_id").references(() => departments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    period: text("period").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bsc_scorecards_uq").on(t.scope, t.departmentId, t.period),
    check("bsc_scorecards_scope_check", sql`${t.scope} IN ('COMPANY', 'DEPARTMENT')`),
    check("bsc_scorecards_dept_check", sql`(${t.scope} = 'COMPANY') = (${t.departmentId} IS NULL)`),
  ],
);

export const bscMetrics = pgTable(
  "bsc_metrics",
  {
    id: id(),
    scorecardId: text("scorecard_id")
      .notNull()
      .references(() => bscScorecards.id, { onDelete: "cascade" }),
    /** `FINANCIAL` · `CUSTOMER` · `INTERNAL_PROCESS` · `LEARNING_GROWTH`. */
    perspective: text("perspective").notNull(),
    label: text("label").notNull(),
    /** `MANUAL` hoặc khoá trong `METRIC_BINDINGS` — cùng sổ đăng ký với KR. */
    metricSource: text("metric_source").notNull().default("MANUAL"),
    unit: text("unit").notNull().default("NUMBER"),
    direction: text("direction").notNull().default("UP"),
    target: doublePrecision("target"),
    /** Giá trị nhập tay khi `metric_source = 'MANUAL'`. `NULL` = chưa nhập. */
    manualValue: doublePrecision("manual_value"),
    manualValueAt: ts("manual_value_at"),
    /** Trọng số trong góc nhìn. Tổng KHÔNG bắt buộc bằng 100 — chuẩn hoá lúc tính. */
    weight: doublePrecision("weight").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bsc_metrics_card_idx").on(t.scorecardId, t.perspective, t.sortOrder),
    check("bsc_metrics_perspective_check", sql`${t.perspective} IN ('FINANCIAL', 'CUSTOMER', 'INTERNAL_PROCESS', 'LEARNING_GROWTH')`),
    check("bsc_metrics_unit_check", sql`${t.unit} IN ('NUMBER', 'VND', 'PERCENT', 'COUNT', 'DAYS', 'HOURS')`),
    check("bsc_metrics_direction_check", sql`${t.direction} IN ('UP', 'DOWN')`),
    check("bsc_metrics_weight_check", sql`${t.weight} > 0`),
  ],
);

/**
 * Kỳ review — và cột `snapshot` là lý do bảng này tồn tại.
 *
 * AGENTS.md mục 8.9: *không silent correction kỳ đã chốt*. Nếu báo cáo tháng 9 được tính lại bằng
 * truy vấn của tháng 11 thì con số tháng 9 sẽ ÂM THẦM đổi mỗi lần ai đó sửa một công thức — và
 * cuộc họp tháng 10 đã diễn ra trên một con số không còn tồn tại.
 *
 * Nên: `FINAL` là đóng băng. Sau đó mọi thứ đọc từ `snapshot`, không truy vấn lại.
 */
export const reviewCycles = pgTable(
  "review_cycles",
  {
    id: id(),
    /** `WEEKLY` · `MONTHLY` · `QUARTERLY`. */
    kind: text("kind").notNull(),
    /** `COMPANY` · `DEPARTMENT`. */
    scope: text("scope").notNull(),
    departmentId: text("department_id").references(() => departments.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    /** `DRAFT` = tính sống mỗi lần mở; `FINAL` = đọc `snapshot`, không tính lại. */
    status: text("status").notNull().default("DRAFT"),
    /** Ảnh chụp toàn bộ số của kỳ. Bất biến sau khi `FINAL`. */
    snapshot: jsonb("snapshot"),
    /** Phiên bản logic lúc chụp — để biết ảnh cũ được dựng bằng công thức nào. */
    snapshotVersion: integer("snapshot_version").notNull().default(1),
    highlights: text("highlights").notNull().default(""),
    issues: text("issues").notNull().default(""),
    nextActions: text("next_actions").notNull().default(""),
    finalizedAt: ts("finalized_at"),
    finalizedBy: text("finalized_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("review_cycles_uq").on(t.kind, t.scope, t.departmentId, t.period),
    index("review_cycles_period_idx").on(t.periodStart),
    check("review_cycles_kind_check", sql`${t.kind} IN ('WEEKLY', 'MONTHLY', 'QUARTERLY')`),
    check("review_cycles_scope_check", sql`${t.scope} IN ('COMPANY', 'DEPARTMENT')`),
    check("review_cycles_dept_check", sql`(${t.scope} = 'COMPANY') = (${t.departmentId} IS NULL)`),
    check("review_cycles_status_check", sql`${t.status} IN ('DRAFT', 'FINAL')`),
    // Chốt kỳ mà không có ảnh chụp thì "chốt" không có nghĩa gì: lần mở sau vẫn tính lại.
    check("review_cycles_final_check", sql`${t.status} = 'DRAFT' OR (${t.snapshot} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL)`),
  ],
);

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  lead: one(users, { fields: [departments.leadUserId], references: [users.id] }),
  members: many(departmentMembers),
}));

export const departmentMembersRelations = relations(departmentMembers, ({ one }) => ({
  department: one(departments, { fields: [departmentMembers.departmentId], references: [departments.id] }),
  user: one(users, { fields: [departmentMembers.userId], references: [users.id] }),
}));

export const workItemsRelations = relations(workItems, ({ one, many }) => ({
  department: one(departments, { fields: [workItems.departmentId], references: [departments.id] }),
  assignee: one(users, { fields: [workItems.assigneeId], references: [users.id] }),
  events: many(workItemEvents),
}));

export const workItemEventsRelations = relations(workItemEvents, ({ one }) => ({
  item: one(workItems, { fields: [workItemEvents.workItemId], references: [workItems.id] }),
}));

export const okrObjectivesRelations = relations(okrObjectives, ({ one, many }) => ({
  department: one(departments, { fields: [okrObjectives.departmentId], references: [departments.id] }),
  owner: one(users, { fields: [okrObjectives.ownerUserId], references: [users.id] }),
  keyResults: many(okrKeyResults),
}));

export const okrKeyResultsRelations = relations(okrKeyResults, ({ one, many }) => ({
  objective: one(okrObjectives, { fields: [okrKeyResults.objectiveId], references: [okrObjectives.id] }),
  checkins: many(okrCheckins),
}));

export const bscScorecardsRelations = relations(bscScorecards, ({ one, many }) => ({
  department: one(departments, { fields: [bscScorecards.departmentId], references: [departments.id] }),
  metrics: many(bscMetrics),
}));

export const bscMetricsRelations = relations(bscMetrics, ({ one }) => ({
  scorecard: one(bscScorecards, { fields: [bscMetrics.scorecardId], references: [bscScorecards.id] }),
}));

/**
 * ẢNH CHỤP HIỆU SUẤT — SỐ LỊCH SỬ KHÔNG ĐƯỢC ĐỔI VÌ TRUY VẤN HÔM NAY ĐỔI.
 *
 * Thẻ điểm sống (`lib/queries/dept-performance.ts`) tính lại mỗi lần mở. Điều đó đúng cho "tuần
 * này đang thế nào", và SAI cho "quý trước chị Lan đạt bao nhiêu": chỉ cần ai đó sửa một mệnh đề
 * `WHERE` là con số của quý trước đổi theo — lặng lẽ, và không ai đối chiếu được với bản in ra
 * hồi đó. Một kỳ đã chốt mà số còn trôi thì mọi cuộc nói chuyện về hiệu suất đều mất căn cứ.
 *
 * Nên mỗi kỳ được chụp lại thành DÒNG, không phải một khối JSON: có dòng thì so được kỳ này với
 * kỳ trước ngay trong SQL, mà đó chính là thứ "xu hướng" cần.
 *
 * ─── BẤT BIẾN: GHI MỘT LẦN, KHÔNG GHI ĐÈ ───
 *
 * Khoá duy nhất `(period, subject_type, subject_id, metric_key)` cộng với `onConflictDoNothing`:
 * chạy lại job bao nhiêu lần cũng không đổi được số đã chụp. Đổi công thức thì `definition_version`
 * của những kỳ SAU sẽ khác — và chênh lệch đó đọc được, thay vì biến mất.
 */
export const performanceSnapshots = pgTable(
  "performance_snapshots",
  {
    id: id(),
    /** `WEEKLY` · `MONTHLY`. */
    kind: text("kind").notNull(),
    /** Khoá kỳ người đọc được: `2026-W37`, `2026-09`. */
    period: text("period").notNull(),
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    /** `PERSON` · `DEPARTMENT` — chủ thể của con số. */
    subjectType: text("subject_type").notNull(),
    /** Khoá người dùng hoặc khoá phòng ban. KHÔNG đặt khoá ngoại: ảnh chụp phải sống sót cả khi tài khoản bị xoá. */
    subjectId: text("subject_id").notNull(),
    /** Tên tại thời điểm chụp — người đổi tên sau đó không làm sai lịch sử. */
    subjectLabel: text("subject_label").notNull().default(""),
    departmentCode: text("department_code").notNull().default(""),

    metricKey: text("metric_key").notNull(),
    metricLabel: text("metric_label").notNull(),
    /** `null` = CHƯA ĐO ĐƯỢC trong kỳ đó. Không bao giờ là 0. */
    value: doublePrecision("value"),
    unit: text("unit").notNull(),
    sample: integer("sample").notNull().default(0),
    denominatorLabel: text("denominator_label").notNull().default(""),

    /** `HIGH` · `MEDIUM` · `LOW` · `UNKNOWN`. */
    confidence: text("confidence").notNull(),
    /** `USER_ID` · `EMAIL` · `FREE_TEXT` — cách nối dòng dữ liệu về người, tại thời điểm chụp. */
    linkage: text("linkage").notNull(),
    shared: boolean("shared").notNull().default(false),
    /** Câu quy kết đang có hiệu lực lúc chụp. */
    attribution: text("attribution").notNull().default(""),
    /** Nguồn số liệu lúc chụp. */
    basis: text("basis").notNull().default(""),

    calculatedAt: ts("calculated_at").notNull().defaultNow(),
    /** Phiên bản công thức lúc chụp — `lib/constants/metric-provenance.ts::METRIC_DEFINITION_VERSION`. */
    definitionVersion: integer("definition_version").notNull().default(1),
    /**
     * PHIÊN BẢN NGUỒN lúc chụp — `lib/constants/metric-catalog.ts::METRIC_SOURCE_VERSION`.
     *
     * TÁCH KHỎI `definition_version` vì hai thứ hỏng theo hai kiểu khác nhau:
     *   · đổi CÔNG THỨC  — cùng dữ liệu, ra số khác (sửa mệnh đề WHERE, đổi mẫu số)
     *   · đổi NGUỒN      — cùng công thức, đọc chỗ khác (case nối bằng `assignee_user_id` thay vì
     *                      ô chữ `assignee`)
     *
     * Kỳ trước đo trên ô chữ và kỳ này đo trên khoá tài khoản là HAI TẬP NGƯỜI KHÁC NHAU. Vẽ một
     * mũi tên xu hướng giữa hai kỳ đó là nói dối bằng đồ thị. Hai cột này cho màn hình biết khi
     * nào phải in "đổi nguồn giữa hai kỳ" thay vì một mũi tên.
     */
    sourceVersion: integer("source_version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("performance_snapshots_uq").on(t.period, t.subjectType, t.subjectId, t.metricKey),
    index("performance_snapshots_subject_idx").on(t.subjectType, t.subjectId, t.metricKey, t.periodStart),
    index("performance_snapshots_period_idx").on(t.kind, t.periodStart),
  ],
);

export type PerformanceSnapshot = typeof performanceSnapshots.$inferSelect;

/**
 * ═══════════ LÝ DO HOÀN DO NGƯỜI XÁC ĐỊNH — GHI ĐÈ SUY LUẬN, CÓ VẾT ═══════════
 *
 * Lý do hoàn mặc định được SUY từ chứng từ ĐVVC (`lib/queries/return-reason.ts`). Đo trên
 * production 13/09/2026: chỉ **208/956** vận đơn hoàn có sự kiện "Tồn - …" mang lý do thật; phần
 * còn lại ĐVVC không nêu lý do nào. Đó là một sự thật về dữ liệu, không phải một lỗi cần giấu.
 *
 * Người xử lý thường BIẾT lý do — họ vừa gọi cho khách xong. Bảng này là chỗ ghi lại điều đó, và
 * nó ghi đè suy luận vì bằng chứng của con người mạnh hơn suy luận của máy.
 *
 * ─── VÌ SAO KHÔNG GHI THẲNG VÀO `shipments` ───
 *
 * Một cột `return_reason` trên `shipments` sẽ không phân biệt được "máy suy ra" với "người xác
 * nhận", và mỗi lần sửa là mất giá trị cũ. Bảng riêng giữ được cả hai vế: lý do cũ, lý do mới, ai
 * đổi, lúc nào, vì sao. Với một con số đi vào báo cáo hiệu suất mã hàng, vết đó là bắt buộc.
 */
export const shipmentReturnReasons = pgTable(
  "shipment_return_reasons",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .unique()
      .references(() => shipments.id, { onDelete: "cascade" }),
    /** Khoá trong `lib/constants/return-reason.ts::RETURN_REASONS`. */
    reason: text("reason").notNull(),
    /**
     * NHÓM LỚN, LƯU KÈM chứ không chỉ suy từ `reason` lúc đọc.
     *
     * Suy lúc đọc thì ngày nào đó một lý do được xếp sang nhóm khác là toàn bộ LỊCH SỬ đổi theo,
     * lặng lẽ: báo cáo quý trước in ra hồi đó không còn khớp với chính nó nữa. Lưu kèm thì dòng
     * cũ giữ nhóm nó được xếp lúc ghi, và đổi cách xếp nhóm chỉ ảnh hưởng dòng mới.
     */
    reasonGroup: text("reason_group").notNull().default("UNKNOWN"),
    /**
     * GHI CHÚ TỰ DO — TÁCH HẲN KHỎI `reason`.
     *
     * `reason` là DANH MỤC để đếm; `note` là câu chuyện để người sau đọc. Gộp hai thứ vào một ô
     * chữ là cách chắc chắn nhất để không bao giờ đếm được gì: "vải xấu, khách bảo mỏng quá, đã
     * xin lỗi" không nhóm được với "vải xấu".
     */
    note: text("note").notNull().default(""),
    /** Lý do máy suy ra tại thời điểm ghi đè, chép lại để so được. */
    inferredReason: text("inferred_reason").notNull().default(""),
    /**
     * `MANUAL` — người của shop hỏi khách rồi ghi. CÓ THẨM QUYỀN.
     * `AUTO`   — máy suy từ chứng từ ĐVVC. Chỉ với tới được lý do THÔ.
     * `IMPORT` — nhập một lần từ tệp lịch sử, có đối chiếu định danh mạnh.
     */
    source: text("source").notNull().default("MANUAL"),
    /** `CONFIRMED` · `CARRIER_CODE` · `CARRIER_TEXT` · `IMPORTED` — xem `ReasonConfidence`. */
    confidence: text("confidence").notNull().default("CONFIRMED"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shipment_return_reasons_reason_idx").on(t.reason),
    index("shipment_return_reasons_group_idx").on(t.reasonGroup),
    check("shipment_return_reasons_source_check", sql`${t.source} IN ('MANUAL', 'AUTO', 'IMPORT')`),
  ],
);

export type ShipmentReturnReason = typeof shipmentReturnReasons.$inferSelect;

export type Department = typeof departments.$inferSelect;
export type DepartmentMember = typeof departmentMembers.$inferSelect;
export type WorkItemRow = typeof workItems.$inferSelect;
export type WorkItemEvent = typeof workItemEvents.$inferSelect;
export type WorkRecurrence = typeof workRecurrences.$inferSelect;
export type OkrObjective = typeof okrObjectives.$inferSelect;
export type OkrKeyResult = typeof okrKeyResults.$inferSelect;
export type OkrCheckin = typeof okrCheckins.$inferSelect;
export type BscScorecard = typeof bscScorecards.$inferSelect;
export type BscMetric = typeof bscMetrics.$inferSelect;
export type ReviewCycle = typeof reviewCycles.$inferSelect;
export type AccessRole = typeof accessRoles.$inferSelect;
export type Position = typeof positions.$inferSelect;

// ───────────────────────── Quan hệ & kiểu: nền tảng nhân sự AI ─────────────────────────

export const aiAgentsRelations = relations(aiAgents, ({ many }) => ({ versions: many(aiAgentVersions), runs: many(aiRuns), tasks: many(aiTasks) }));
export const aiAgentVersionsRelations = relations(aiAgentVersions, ({ one }) => ({ agent: one(aiAgents, { fields: [aiAgentVersions.agentId], references: [aiAgents.id] }) }));
export const aiTasksRelations = relations(aiTasks, ({ one, many }) => ({
  agent: one(aiAgents, { fields: [aiTasks.agentId], references: [aiAgents.id] }),
  event: one(aiEvents, { fields: [aiTasks.eventId], references: [aiEvents.id] }),
  runs: many(aiRuns),
}));
export const aiRunsRelations = relations(aiRuns, ({ one, many }) => ({
  agent: one(aiAgents, { fields: [aiRuns.agentId], references: [aiAgents.id] }),
  version: one(aiAgentVersions, { fields: [aiRuns.agentVersionId], references: [aiAgentVersions.id] }),
  task: one(aiTasks, { fields: [aiRuns.taskId], references: [aiTasks.id] }),
  event: one(aiEvents, { fields: [aiRuns.eventId], references: [aiEvents.id] }),
  toolCalls: many(aiToolCalls),
  modelCalls: many(aiModelCalls),
}));
export const aiToolCallsRelations = relations(aiToolCalls, ({ one }) => ({ run: one(aiRuns, { fields: [aiToolCalls.runId], references: [aiRuns.id] }) }));
export const aiModelCallsRelations = relations(aiModelCalls, ({ one }) => ({ run: one(aiRuns, { fields: [aiModelCalls.runId], references: [aiRuns.id] }) }));
export const aiApprovalsRelations = relations(aiApprovals, ({ one }) => ({
  run: one(aiRuns, { fields: [aiApprovals.runId], references: [aiRuns.id] }),
  agent: one(aiAgents, { fields: [aiApprovals.agentId], references: [aiAgents.id] }),
}));

export const salesConversationsRelations = relations(salesConversations, ({ one, many }) => ({
  customer: one(customers, { fields: [salesConversations.customerId], references: [customers.id] }),
  order: one(orders, { fields: [salesConversations.orderId], references: [orders.id] }),
  messages: many(salesMessages),
  suggestions: many(salesSuggestions),
  followups: many(salesFollowups),
}));
export const salesMessagesRelations = relations(salesMessages, ({ one }) => ({
  conversation: one(salesConversations, { fields: [salesMessages.conversationId], references: [salesConversations.id] }),
}));
export const salesSuggestionsRelations = relations(salesSuggestions, ({ one }) => ({
  conversation: one(salesConversations, { fields: [salesSuggestions.conversationId], references: [salesConversations.id] }),
  run: one(aiRuns, { fields: [salesSuggestions.runId], references: [aiRuns.id] }),
}));
export const salesReviewLabelsRelations = relations(salesReviewLabels, ({ one }) => ({
  suggestion: one(salesSuggestions, { fields: [salesReviewLabels.suggestionId], references: [salesSuggestions.id] }),
  conversation: one(salesConversations, { fields: [salesReviewLabels.conversationId], references: [salesConversations.id] }),
  reviewer: one(users, { fields: [salesReviewLabels.reviewerUserId], references: [users.id] }),
}));
export const salesFollowupsRelations = relations(salesFollowups, ({ one }) => ({
  conversation: one(salesConversations, { fields: [salesFollowups.conversationId], references: [salesConversations.id] }),
}));

export type AiAgent = typeof aiAgents.$inferSelect;
export type AiAgentVersion = typeof aiAgentVersions.$inferSelect;
export type AiEvent = typeof aiEvents.$inferSelect;
export type AiTask = typeof aiTasks.$inferSelect;
export type AiRun = typeof aiRuns.$inferSelect;
export type AiToolCall = typeof aiToolCalls.$inferSelect;
export type AiModelCall = typeof aiModelCalls.$inferSelect;
export type AiApproval = typeof aiApprovals.$inferSelect;
export type AiErrorRow = typeof aiErrors.$inferSelect;
export type SalesConversation = typeof salesConversations.$inferSelect;
export type SalesMessage = typeof salesMessages.$inferSelect;
export type SalesSuggestion = typeof salesSuggestions.$inferSelect;
export type SalesFollowup = typeof salesFollowups.$inferSelect;
export type SalesReviewLabel = typeof salesReviewLabels.$inferSelect;

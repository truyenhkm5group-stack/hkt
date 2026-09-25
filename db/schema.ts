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
  /**
   * THU HỒI PHIÊN — mốc CHỈ TIẾN, KHÔNG BAO GIỜ LÙI.
   *
   * Token được ký hợp lệ vẫn bị TỪ CHỐI nếu mốc đăng nhập gốc của nó (`lgn`) CŨ HƠN giá trị này.
   * So với `lgn` chứ không phải `iat`: gia hạn trượt đẩy `iat` lên ở mỗi lượt, nên so với `iat`
   * thì lần gia hạn kế tiếp sẽ HỒI SINH đúng phiên vừa bị thu hồi.
   *
   * `NULL` = CHƯA TỪNG THU HỒI, không phải "thu hồi từ năm 1970". Không backfill, không mặc định.
   */
  sessionInvalidBefore: ts("session_invalid_before"),
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

/*
  DANH MỤC XƯỞNG / NHÀ CUNG CẤP (24/09/2026).

  Trước bảng này, "xưởng" là Ô CHỮ TỰ DO ở hai nơi (`production_orders.supplier`, `stock_receipts.supplier`)
  và trang Mua hàng ghép chúng bằng cách hạ chữ thường — "Xưởng Hà" và "Chị Hà may" là hai xưởng. Nên
  thời gian giao và giá nhập theo TỪNG xưởng chỉ là phép nối yếu (AGENTS.md mục 39).

  `aliases` là các cách gõ khác của cùng một xưởng. Chúng làm LỊCH SỬ quy về đúng xưởng lúc ĐỌC mà
  không sửa một dòng cũ nào (mục 35: không backfill, chỉ ánh xạ khi XÁC ĐỊNH — đúng một xưởng khớp).
*/
export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    name: text("name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    phone: text("phone").notNull().default(""),
    note: text("note").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("suppliers_name_uq").on(sql`lower(${t.name})`)],
);

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
    /**
     * Giá gia công / nhập mỗi sản phẩm. `NULL` = CHƯA BIẾT (nháp máy dựng khi thiết kế mới đủ MOQ không có căn
     * cứ giá — `docs/creative-loop.md` §5h, mục 42). Đường lập tay vẫn ghi 0 khi bỏ trống ô; mọi chỗ đọc coi
     * 0 và `NULL` đều là "chưa nhập", `sum()` bỏ qua `NULL`.
     */
    unitCost: integer("unit_cost").default(0),
    /** ẢNH CHỤP tên xưởng lúc ghi. Khoá thật là `supplier_id` (`NULL` = lô cũ / chưa chọn trong danh mục). */
    supplier: text("supplier").notNull().default(""),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    dueDate: ts("due_date"),
    sentAt: ts("sent_at"),
    /*
      MỐC NHẬN THẬT — cái thiếu làm không đo được "xưởng giao trễ mấy ngày".

      Trước 23/09/2026 bảng này có mốc HẸN (`due_date`) và mốc GỬI (`sent_at`), còn lúc hàng về thì
      `status` đổi sang `RECEIVED` mà KHÔNG ghi thời điểm. Nên hai câu hỏi khác hẳn nhau — "hết hàng
      vì bán nhanh" và "hết hàng vì xưởng giao trễ" — cùng hiện ra là một dòng cảnh báo tồn kho.

      Chủ shop chốt quy trình: KHO là người bấm, và bấm LÚC ĐẾM XONG (không phải lúc xe tới cổng).
      Vì thế mốc này là lời khai của người đếm, không phải một sự kiện tự suy ra.
    */
    receivedAt: ts("received_at"),
    /** Khoá tài khoản người bấm (AGENTS.md mục 34) — cột chữ bên dưới chỉ là ảnh chụp tên để đọc. */
    receivedByUserId: text("received_by_user_id").references(() => users.id, { onDelete: "set null" }),
    receivedBy: text("received_by").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    /*
      Company OS · Agent C (shared-contracts.md mục 5). Ba cột, cả ba NULL được và KHÔNG backfill
      (mục 35): lệnh cũ không có bản duyệt, không có gợi ý đã lưu — màn hình in "—".

      · `design_version_id`: bản thiết kế ĐÃ DUYỆT mà xưởng may theo (Q8). Bắt buộc hay chỉ cảnh báo
        do cờ `production.requireApprovedDesign` quyết, và chỉ xét lúc DRAFT → SENT.
      · `suggested_cells`: ẢNH CHỤP gợi ý của máy (`buildMatrixForProduct`, tính ở MÁY CHỦ) kèm căn cứ
        kế hoạch và mốc tính — để "máy gợi ý bao nhiêu, người chốt bao nhiêu" đọc lại được về sau.
      · `override_reason`: vì sao người chốt khác máy. Có gợi ý mà số chốt lệch dù MỘT ô ⇒ bắt buộc.
    */
    designVersionId: text("design_version_id").references((): AnyPgColumn => designVersions.id, { onDelete: "restrict" }),
    suggestedCells: jsonb("suggested_cells").$type<{
      cells: Record<string, number>;
      basis: { source: "buildMatrixForProduct"; coverDays: number; countIncoming: boolean; leadTimeDays: number };
      computedAt: string;
    }>(),
    overrideReason: text("override_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("production_orders_product_idx").on(t.productId, t.createdAt),
    index("production_orders_design_version_idx").on(t.designVersionId).where(sql`${t.designVersionId} IS NOT NULL`),
  ],
);

/*
  ═══════════ SỔ ĐẶT XƯỞNG: LÔ SẢN XUẤT · ĐỢT TRẢ HÀNG · ĐỢT VẢI · ĐỢT THANH TOÁN ═══════════

  Thay bảng tính "BÁO CÁO ĐẶT HÀNG" (hai trang Thành phẩm + Vải). Bốn bảng trả lời bốn câu khác nhau:
  đặt xưởng bao nhiêu (lô) · xưởng đã trả bao nhiêu (đợt trả hàng) · vải mua bao nhiêu tiền (đợt vải) ·
  đã trả xưởng / nhà vải bao nhiêu (đợt thanh toán).

  ĐÂY LÀ SỔ CÔNG NỢ VÀ GIÁ THÀNH, KHÔNG PHẢI SỔ CHI PHÍ. Giá vốn có ĐÚNG MỘT nguồn được vào lợi nhuận là
  phiếu kho (AGENTS.md mục 15, `COST_AUTHORITY.COGS = "INVENTORY"`); tiền trả xưởng ghi ở đây mà cũng
  trừ vào lợi nhuận thì mỗi chiếc áo bị tính giá vốn hai lần. `tests/workshop-ledger.test.ts` quét mã
  nguồn: không truy vấn lợi nhuận / chi phí / dòng tiền nào được đọc bốn bảng này.

  Chi tiết luật tính ở `lib/constants/workshop-ledger.ts`.
*/

/** Một lô đặt xưởng may cho một mã hàng — một dòng của trang "Thành phẩm". Khoá tự nhiên: mã hàng + số lô. */
export const productionBatches = pgTable(
  "production_batches",
  {
    id: id(),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Mã hàng đã chuẩn hoá (cắt khoảng trắng, IN HOA) — cùng với `batch_no` là danh tính của lô. */
    productCode: text("product_code").notNull(),
    productName: text("product_name").notNull().default(""),
    batchNo: integer("batch_no").notNull(),
    /** Ảnh chụp tên xưởng may; khoá thật là `supplier_id` (NULL = chưa vào danh mục xưởng). */
    supplier: text("supplier").notNull().default(""),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /** Bảng chốt màu × size đã gửi xưởng (nếu có) — nối để hai sổ nói về cùng một lần đặt. */
    productionOrderId: text("production_order_id").references(() => productionOrders.id, { onDelete: "set null" }),
    orderedAt: ts("ordered_at").notNull(),
    orderedQty: integer("ordered_qty").notNull(),
    /** SL CHỐT THANH TOÁN với xưởng. NULL = CHƯA CHỐT — tiền công tạm tính theo số xưởng đã trả, có nhãn. */
    agreedQty: integer("agreed_qty"),
    dueDate: ts("due_date"),
    /** Đơn giá công (hoặc giá trọn gói khi xưởng lo vải). NULL = CHƯA BIẾT, không phải 0đ. */
    laborUnitPrice: integer("labor_unit_price"),
    /** Thưởng (+) / phạt (−) với xưởng, cộng thẳng vào tiền công. */
    adjustment: integer("adjustment").notNull().default(0),
    adjustmentNote: text("adjustment_note").notNull().default(""),
    /**
     * PHẠT XƯỞNG ("Hoàn phạt MKT" trên bảng tính): tiền phạt xưởng khi sai sót hoặc trả hàng chậm.
     * Luôn ≥ 0 và TRỪ vào tiền công phải trả xưởng. Tách khỏi `adjustment` vì chủ shop theo dõi riêng
     * khoản này (bảng tính có hai cột), và nó phải kèm lý do.
     */
    workshopPenalty: integer("workshop_penalty").notNull().default(0),
    penaltyNote: text("penalty_note").notNull().default(""),
    /**
     * NGÀY GHI PHẠT — quyết định tiền phạt được CỘNG cho MKT phụ trách mã ở kỳ lương nào (chủ shop chốt
     * 25/09/2026: "Hoàn phạt MKT" cộng lại cho MKT). NULL khi có phạt = CHƯA KHAI NGÀY ⇒ chưa cộng cho
     * ai, và màn hình nói ra; không đoán ngày giúp (AGENTS.md mục 35).
     */
    penaltyAt: ts("penalty_at"),
    /**
     * Ai lo vải: SHOP (shop mua vải, xưởng may công — tiền vải lấy từ các đợt vải gán vào lô) ·
     * WORKSHOP (xưởng lo vải, đơn giá là giá trọn gói — tiền vải 0đ là THẬT). Phải khai, vì
     * "chưa gán đợt vải nào" và "vải do xưởng lo" cho ra cùng một con số 0 mà nghĩa ngược nhau.
     */
    fabricSource: text("fabric_source").notNull().default("SHOP"),
    /**
     * SỐ ĐẶT THEO TỪNG MẪU (màu/size): `{ [product_variants.id]: số cái }`. Rỗng = lô chỉ ghi TỔNG của
     * mã. Khoá là mã mẫu chứ không phải chữ "màu|size", để trừ vào đúng mẫu đang thiếu hàng mà không
     * phải đoán theo tên màu. Có bảng này thì SL đặt = tổng các ô, và mỗi đợt trả hàng phải chia theo mẫu.
     */
    cells: jsonb("cells").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    /** OPEN (xưởng đang trả hàng) · DONE (xưởng đã trả xong — do người bấm) · CANCELLED */
    status: text("status").notNull().default("OPEN"),
    doneAt: ts("done_at"),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("production_batches_code_no_uq").on(t.productCode, t.batchNo),
    index("production_batches_ordered_idx").on(t.orderedAt),
    check("production_batches_status_check", sql`${t.status} IN ('OPEN', 'DONE', 'CANCELLED')`),
    check("production_batches_fabric_source_check", sql`${t.fabricSource} IN ('SHOP', 'WORKSHOP')`),
    check("production_batches_qty_check", sql`${t.orderedQty} >= 0 AND ${t.batchNo} > 0 AND (${t.agreedQty} IS NULL OR ${t.agreedQty} >= 0)`),
    check("production_batches_price_check", sql`(${t.laborUnitPrice} IS NULL OR ${t.laborUnitPrice} >= 0) AND ${t.workshopPenalty} >= 0`),
    check("production_batches_code_check", sql`length(trim(${t.productCode})) > 0`),
  ],
);

/**
 * ═══════════ GIÁ BÁO MKT — MỘT GIÁ CHO MỖI MÃ, CÓ NGÀY HIỆU LỰC ═══════════
 *
 * Giá chốt tính cho marketer thay cho giá vốn thật, ở ĐÚNG hai chỗ: lợi nhuận danh nghĩa theo MKT và
 * cơ sở tính lương (chủ shop chốt 25/09/2026). Lợi nhuận SHOP vẫn đứng trên giá vốn phiếu kho; phần
 * chênh là một dòng đối soát riêng. Luật: `lib/constants/marketer-price.ts`.
 *
 * "Một mã một giá từ đầu tới cuối, gần hết vòng đời có thể giảm cho MKT để xả tồn" ⇒ mỗi lần đổi giá
 * là một DÒNG MỚI có ngày hiệu lực; đơn lấy giá đang hiệu lực vào NGÀY LÊN ĐƠN. Hạ giá hôm nay không
 * làm đổi lợi nhuận của đơn đã lên trước đó.
 */
export const marketerPrices = pgTable(
  "marketer_prices",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Ảnh chụp mã hàng lúc ghi — để đọc; khoá thật là `product_id`. */
    productCode: text("product_code").notNull().default(""),
    price: integer("price").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    reason: text("reason").notNull().default(""),
    setByUserId: text("set_by_user_id").references(() => users.id, { onDelete: "set null" }),
    setBy: text("set_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("marketer_prices_product_from_uq").on(t.productId, t.effectiveFrom), check("marketer_prices_price_check", sql`${t.price} >= 0`)],
);

/** Một lần xưởng trả hàng cho một lô ("14/08: 240"). Âm = shop trả lại xưởng hàng lỗi. */
export const productionDeliveries = pgTable(
  "production_deliveries",
  {
    id: id(),
    batchId: text("batch_id")
      .notNull()
      .references(() => productionBatches.id, { onDelete: "cascade" }),
    deliveredAt: ts("delivered_at").notNull(),
    quantity: integer("quantity").notNull(),
    /** Số trả theo từng mẫu `{ [variantId]: số cái }` — bắt buộc khi lô có chia màu/size; `quantity` = tổng các ô. */
    cells: jsonb("cells").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("production_deliveries_batch_idx").on(t.batchId, t.deliveredAt), check("production_deliveries_qty_check", sql`${t.quantity} <> 0`)],
);

/** Một lần đặt / nhập vải — một dòng của trang "Vải". Gán vào lô sản xuất nào thì tiền vải vào giá thành lô đó. */
export const fabricOrders = pgTable(
  "fabric_orders",
  {
    id: id(),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    productCode: text("product_code").notNull().default(""),
    /** Lô sản xuất dùng vải này. NULL = chưa gán — tiền vải chỉ vào giá thành cấp MÃ, không vào lô nào. */
    batchId: text("batch_id").references(() => productionBatches.id, { onDelete: "set null" }),
    supplier: text("supplier").notNull().default(""),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /** Vải chính / lót / màu… */
    description: text("description").notNull().default(""),
    orderedAt: ts("ordered_at").notNull(),
    /** Ngày vải về. NULL = CHƯA VỀ. */
    receivedAt: ts("received_at"),
    /** Số lượng vải theo `unit` (m, kg, cây…) — có thể lẻ. NULL = không khai. */
    quantity: doublePrecision("quantity"),
    unit: text("unit").notNull().default(""),
    unitPrice: integer("unit_price"),
    /** Thành tiền theo hoá đơn nhà vải — con số đi vào giá thành và công nợ. */
    amount: integer("amount").notNull(),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("fabric_orders_batch_idx").on(t.batchId),
    index("fabric_orders_code_idx").on(t.productCode, t.orderedAt),
    check("fabric_orders_amount_check", sql`${t.amount} >= 0 AND (${t.quantity} IS NULL OR ${t.quantity} >= 0) AND (${t.unitPrice} IS NULL OR ${t.unitPrice} >= 0)`),
  ],
);

/**
 * Một đợt trả tiền cho xưởng may (gắn LÔ) hoặc cho nhà vải (gắn ĐỢT VẢI) — đúng MỘT trong hai.
 * DEPOSIT (cọc) và PAYMENT cộng vào "đã trả"; REFUND (bên kia trả lại tiền) trừ ra. Số tiền luôn dương.
 */
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: id(),
    batchId: text("batch_id").references(() => productionBatches.id, { onDelete: "restrict" }),
    fabricOrderId: text("fabric_order_id").references(() => fabricOrders.id, { onDelete: "restrict" }),
    kind: text("kind").notNull().default("PAYMENT"),
    amount: integer("amount").notNull(),
    paidAt: ts("paid_at").notNull(),
    method: text("method").notNull().default("BANK"),
    reference: text("reference").notNull().default(""),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("supplier_payments_batch_idx").on(t.batchId),
    index("supplier_payments_fabric_idx").on(t.fabricOrderId),
    index("supplier_payments_paid_idx").on(t.paidAt),
    check("supplier_payments_target_check", sql`(${t.batchId} IS NULL) <> (${t.fabricOrderId} IS NULL)`),
    check("supplier_payments_kind_check", sql`${t.kind} IN ('DEPOSIT', 'PAYMENT', 'REFUND')`),
    check("supplier_payments_method_check", sql`${t.method} IN ('BANK', 'CASH', 'OTHER')`),
    check("supplier_payments_amount_check", sql`${t.amount} > 0`),
  ],
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
    /*
      ═══ Company OS · Agent G · ba cột truy vết nâng từ `detail` ═══

      Trước bản này "ai làm (người hay máy)", "vì sao" và "thuộc lần chạy nào" chỉ nằm trong jsonb
      `detail` — lọc được nhưng không chỉ mục được, và dòng không ghi thì không ai biết là THIẾU.
      Cả ba cột NULL được: dòng cũ KHÔNG backfill (AGENTS.md mục 35) — `NULL` nghĩa là CHƯA BIẾT,
      không phải "người dùng". `detail` vẫn được ghi y như cũ để mọi chỗ đang đọc nó không gãy.
    */
    /** `USER` · `SYSTEM` · `AGENT` · `WEBHOOK` — `NULL` = chưa biết (dòng cũ, hoặc không suy được). */
    actorKind: text("actor_kind"),
    /** Nối các dòng cùng một lần chạy / một yêu cầu duyệt / một gói tin. */
    correlationId: text("correlation_id"),
    /** VÌ SAO — lý do người nhập hoặc luật đã áp. */
    reason: text("reason"),
  },
  (t) => [
    index("audit_entity_created_idx").on(t.entity, t.createdAt),
    index("audit_created_idx").on(t.createdAt),
    // Dòng thời gian của đơn tra nhật ký theo `entity_id` (mã đơn + mã các vận đơn). Không có chỉ mục
    // này là quét tuần tự bảng tăng nhanh nhất CSDL mỗi lần mở chi tiết đơn.
    index("audit_entity_id_idx").on(t.entityId, t.createdAt),
    // Chỉ mục MỘT PHẦN: gần như mọi dòng không có mã lần chạy, và chỉ mục đầy đủ sẽ gánh hàng triệu NULL.
    index("audit_correlation_idx").on(t.correlationId).where(sql`${t.correlationId} is not null`),
    check("audit_logs_actor_kind_check", sql`${t.actorKind} is null or ${t.actorKind} in ('USER','SYSTEM','AGENT','WEBHOOK')`),
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
    /**
     * Company OS · Agent G — DẤU VÂN TAY của việc đã xin: sha256 của JSON CHUẨN HOÁ (khoá sắp xếp)
     * gồm nhóm · thao tác · thực thể · payload. Người xin thực hiện lại đúng việc đó thì yêu cầu đã
     * duyệt được TIÊU THỤ (một lần); đổi một con số là một việc khác, phải xin lại.
     * `NULL` ở dòng cũ (trước 0134): không tiêu thụ được — không đoán lại dấu vân tay từ payload đã lưu.
     */
    payloadFingerprint: text("payload_fingerprint"),
  },
  (t) => [
    index("approval_status_idx").on(t.status, t.requestedAt),
    index("approval_group_idx").on(t.group, t.status),
    index("approval_requester_idx").on(t.requestedBy, t.group, t.status),
    // Bấm lại một việc đang chờ duyệt KHÔNG đẻ yêu cầu thứ hai — chặn ở CSDL, không chỉ ở ứng dụng,
    // vì hai lượt bấm đồng thời cùng đi qua được bước "đã có chưa?".
    uniqueIndex("approval_pending_fingerprint_uq")
      .on(t.requestedBy, t.group, t.payloadFingerprint)
      .where(sql`${t.status} = 'PENDING' and ${t.payloadFingerprint} is not null`),
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
    /**
     * ═══ NGÀY KHÁCH HẸN GIAO ═══
     *
     * Khách đã CHỐT MUA nhưng xin giao vào một ngày sau: "gửi giúp em ngày 20 nhé, giờ em đi công
     * tác". Trước cột này, ERP không phân biệt được đơn đó với một đơn bị bỏ quên — cả hai đều là
     * "đã xác nhận mà chưa gửi", nên đơn có hẹn bị đếm là trễ hạn từ ngày thứ hai.
     *
     * KHÔNG PHẢI `expected_delivery` của vận đơn: cột kia là ETA do Viettel Post trả về, tức DỰ BÁO
     * CỦA ĐVVC về chuyến hàng. Cột này là LỜI HỨA VỚI KHÁCH, có trước khi vận đơn tồn tại.
     *
     * LƯU MỘT MỐC THẬT, KHÔNG LƯU MỘT NGÀY TRẦN. Khách hẹn "ngày 20" nghĩa là "phải tới tay trong
     * ngày 20 giờ Việt Nam", nên giá trị lưu là CUỐI ngày 20 theo giờ VN (`vnEndOfDay`). Lưu kiểu
     * `date` trần thì mỗi nơi đọc lại phải tự chọn múi giờ, và nửa đêm là chỗ sai đầu tiên.
     *
     * `NULL` = khách KHÔNG hẹn ngày nào, không phải "hẹn hôm nay".
     */
    customerPromisedAt: ts("customer_promised_at"),
    /** Khách nói gì khi xin hẹn. Ô chữ cho người đọc — KHÔNG đầu vào của phép tính nào. */
    customerPromisedNote: text("customer_promised_note").notNull().default(""),
    /**
     * AI ghi lời hẹn này. Quy kết đi bằng KHOÁ TÀI KHOẢN (AGENTS.md mục 34), không bằng ô chữ.
     * `NULL` ở dòng cũ nghĩa là CHƯA BIẾT — migration KHÔNG backfill (mục 35).
     */
    customerPromisedByUserId: text("customer_promised_by_user_id").references(() => users.id, { onDelete: "set null" }),
    customerPromisedSetAt: ts("customer_promised_set_at"),
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
    /*
      Đơn CÓ hẹn ngày giao là thiểu số tuyệt đối, nên chỉ mục RIÊNG PHẦN: nó chỉ chứa những dòng
      thật sự có lời hẹn. Hàng đợi nhắc hẹn lọc đúng vị ngữ này, và chỉ mục đầy đủ sẽ tốn chỗ cho
      hàng nghìn dòng `NULL` mà không câu nào hỏi tới.
    */
    index("orders_promised_idx").on(t.customerPromisedAt).where(sql`${t.customerPromisedAt} is not null`),
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

/**
 * ═══ SỔ ĐƠN CHỜ HÀNG (`lib/alerts/stock-wait-log.ts`) ═══
 *
 * Phép phân bổ thiếu hàng (`allocateStock`) chỉ trả lời "BÂY GIỜ đơn nào chờ hàng". Không ghi lại thì
 * không bao giờ trả lời được "hôm qua bao nhiêu đơn chờ" hay "đơn từng chờ hàng có hay hoàn không".
 * Job `alerts` ghi sổ này mỗi lượt: một dòng cho MỘT đơn, mở lần đầu ERP thấy đơn chờ hàng, đóng
 * (`cleared_at`) khi đơn hết chờ. Đơn chờ lại sau khi đã đóng thì mở lại (`episodes` + 1), giữ mốc đầu.
 *
 * Chỉ là SỔ QUAN SÁT: không phép tính tồn kho / kết quả đơn nào đọc nó. KHÔNG backfill — ngày trước
 * lần ghi đầu tiên là CHƯA ĐO (AGENTS.md mục 35, 42).
 */
export const stockWaitLog = pgTable(
  "stock_wait_log",
  {
    orderId: text("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "cascade" }),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    /** `NULL` = đơn vẫn đang chờ hàng ở lượt ghi gần nhất. */
    clearedAt: ts("cleared_at"),
    /** Số cái thiếu LỚN NHẤT từng thấy. */
    maxShortUnits: integer("max_short_units").notNull().default(0),
    /** Ảnh chụp nhãn mẫu thiếu lần gần nhất — để người đọc, không phải đầu vào phép tính. */
    shortLabels: text("short_labels").notNull().default(""),
    episodes: integer("episodes").notNull().default(1),
  },
  (t) => [index("stock_wait_log_first_seen_idx").on(t.firstSeenAt), index("stock_wait_log_open_idx").on(t.orderId).where(sql`${t.clearedAt} is null`)],
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
    /**
     * Company OS · A2 (0138): mẫu được đăng ký TỪ ý tưởng này (nút "Đăng ký thành mẫu"). `NULL` = chưa
     * đăng ký — KHÔNG backfill theo nội dung chữ (mục 35). Xoá mẫu thì ý tưởng còn nguyên, chỉ mất liên
     * kết. Không đổi trạng thái hay quyền của ý tưởng.
     */
    modelId: text("model_id").references((): AnyPgColumn => productModels.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("marketing_ideas_date_idx").on(t.ideaDate),
    index("marketing_ideas_status_idx").on(t.status),
    index("marketing_ideas_marketer_idx").on(t.marketerId),
    index("marketing_ideas_model_idx").on(t.modelId),
  ],
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
    /**
     * ═══════════ CHỮ GỐC CỦA ĐVVC — GHI NGUYÊN VĂN, KỂ CẢ KHI ERP CHƯA HIỂU ═══════════
     *
     * `vtp_status` / `vtp_status_name` ở trên là ẢNH CHỤP ĐÃ DỊCH: chúng do
     * `materializeShipmentState()` dựng từ lịch sử, và hàm đó **bỏ qua** mọi sự kiện không dịch
     * được (`stage = UNKNOWN`). Đó là quyết định đúng cho chiều logistics — không đoán thì không
     * kết luận — nhưng nó để lại một lỗ: Viettel Post vừa nói một câu mới, ERP không hiểu, và màn
     * hình vẫn hiện trạng thái CŨ **không kèm một dấu hiệu nào**.
     *
     * Bốn cột này là lời khai THÔ, ghi ở MỌI lượt nạp (webhook · đối chiếu · nhập tệp) theo mốc
     * của ĐVVC, độc lập hoàn toàn với việc dịch được hay không. Chúng KHÔNG tham gia vào bất kỳ
     * phép tính nghiệp vụ nào — không `ORDER_OUTCOME`, không sổ kho, không tiền — chúng chỉ để
     * hiển thị và để đối chiếu với màn hình Viettel Post.
     */
    vtpRawStatusCode: integer("vtp_raw_status_code"),
    vtpRawStatusName: text("vtp_raw_status_name"),
    vtpRawStatusAt: ts("vtp_raw_status_at"),
    /** `false` = ERP chưa dịch được câu này ⇒ ảnh chụp đã dịch ở trên đang CŨ HƠN lời khai thô. */
    vtpRawMapped: boolean("vtp_raw_mapped").notNull().default(true),
    /**
     * NGUỒN QUYẾT ĐỊNH ẢNH CHỤP hiện tại: `VTP_WEBHOOK` · `VTP_POLL` · `VTP_IMPORT` · `MANUAL` …
     * `deriveShipmentState()` vẫn luôn tính ra `decidedBy` nhưng trước đây vứt đi; ghi xuống để
     * khi một con số bị nghi ngờ thì tra được nguồn mà không phải mở bảng sự kiện.
     */
    vtpSyncSource: text("vtp_sync_source"),
    /*
      ═══════════ SỔ ĐỐI CHIẾU RIÊNG CHO TỪNG KIỆN ═══════════

      `last_vtp_sync_at` chỉ nói "lần cuối ERP hỏi". Nó không nói bao giờ phải hỏi lại, đã hỏi hụt
      mấy lần, hỏng vì lý do gì. Thiếu ba thứ đó thì bộ đối chiếu chỉ biết xếp hàng theo "lâu chưa
      hỏi" — và một kiện ĐANG ĐI GIAO (kết quả phải có trong ngày) đứng ngang hàng với một kiện
      CHỜ LẤY HÀNG (chậm vài ngày là bình thường).

      Nhịp hỏi lại nằm ở `lib/constants/vtp-reconcile.ts`, không nằm ở đây.
    */
    vtpNextSyncAt: ts("vtp_next_sync_at"),
    vtpSyncAttempts: integer("vtp_sync_attempts").notNull().default(0),
    vtpLastError: text("vtp_last_error"),
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
    // Bộ đối chiếu hỏi "kiện nào tới hạn hỏi lại" mỗi vài phút trên toàn bảng vận đơn.
    index("shipments_next_sync_idx").on(t.vtpNextSyncAt).where(sql`${t.isFinal} = false`),
    // Kiện mà ĐVVC vừa nói một câu ERP chưa dịch được — trang sức khoẻ và bộ lọc đọc thẳng cột này.
    index("shipments_raw_unmapped_idx").on(t.vtpRawStatusAt).where(sql`${t.vtpRawMapped} = false`),
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

/**
 * ═══════════ SỔ ĐĂNG KÝ TRẠNG THÁI VIETTEL POST — MỖI CÂU ĐVVC TỪNG NÓI, MỘT DÒNG ═══════════
 *
 * ─── VÌ SAO CẦN MỘT BẢNG, KHI ĐÃ CÓ BẢNG MÃ TRONG MÃ NGUỒN ───
 *
 * `lib/constants/viettelpost.ts::VTP_STATUS` là những gì ERP **đã biết**. Bảng này là những gì
 * Viettel Post **đã thật sự gửi** — hai tập khác nhau, và chênh lệch giữa chúng chính là việc phải
 * làm. Trước bản này, muốn biết chênh lệch đó phải `group by` trên hàng chục nghìn dòng sự kiện,
 * và một mã mới xuất hiện hôm nay trông y hệt một mã đã quen từ tháng trước.
 *
 * ─── KHÔNG BAO GIỜ LÀ CHỖ TÍNH TOÁN ───
 *
 * Bảng này KHÔNG được tham gia vào `ORDER_OUTCOME`, sổ kho, hay bất kỳ phép tính tiền nào. Nó là
 * SỔ QUAN SÁT: đếm, ghi mốc, giữ một mẫu gói tin thô để người đọc kiểm chứng. Việc dịch trạng thái
 * vẫn chỉ có một chỗ (`resolveVtpStatus`), và cách sửa một mã lạ vẫn là bổ sung vào `VTP_STATUS` —
 * không phải sửa dòng ở đây.
 *
 * Khoá tự nhiên là `status_key` = mã số nếu có, ngược lại là tên đã chuẩn hoá. Cố ý KHÔNG dùng
 * `(code, name)`: Viettel Post đổi câu chữ cho cùng một mã (đã gặp với 501) và ghép cả hai vào
 * khoá sẽ đẻ ra một dòng "mã mới" mỗi lần họ sửa chính tả.
 */
export const vtpStatusRegistry = pgTable(
  "vtp_status_registry",
  {
    id: id(),
    /** Mã số nếu ĐVVC gửi, ngược lại tên trạng thái đã chuẩn hoá (chữ thường, bỏ dấu). */
    statusKey: text("status_key").notNull().unique(),
    statusCode: integer("status_code"),
    /** Câu chữ ĐVVC dùng gần đây nhất cho khoá này — giữ nguyên dấu, nguyên hoa thường. */
    statusName: text("status_name").notNull().default(""),
    /** Chặng ERP dịch ra, hoặc `UNKNOWN`. Dịch lại mỗi lần gặp: bổ sung bảng mã là nó tự đúng. */
    normalizedStage: text("normalized_stage"),
    /** Căn cứ đã dùng để dịch: `code` · `text` · `code-group` · `unknown` (xem `resolveVtpStatus`). */
    resolveBasis: text("resolve_basis").notNull().default("unknown"),
    /** `false` ⇒ đây là việc phải làm: bổ sung mã vào `VTP_STATUS`. */
    mapped: boolean("mapped").notNull().default(false),
    occurrences: integer("occurrences").notNull().default(0),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    /** Nguồn gần nhất đã mang câu này tới: `VTP_WEBHOOK` · `VTP_POLL` · `VTP_IMPORT` · `MANUAL`. */
    lastSource: text("last_source").notNull().default(""),
    lastShipmentId: text("last_shipment_id").references((): AnyPgColumn => shipments.id, { onDelete: "set null" }),
    /** Một mẫu gói tin thô để người đọc kiểm chứng — không phải toàn bộ lịch sử. */
    sampleRaw: jsonb("sample_raw"),
    /**
     * Người đã XEM và quyết định: hoặc đã bổ sung vào bảng mã, hoặc kết luận không cần. Cột này
     * chỉ tắt cảnh báo, KHÔNG đổi cách dịch — dịch vẫn do `VTP_STATUS` quyết.
     */
    acknowledgedAt: ts("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgeNote: text("acknowledge_note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vtp_status_registry_unmapped_idx").on(t.lastSeenAt).where(sql`${t.mapped} = false`),
    index("vtp_status_registry_seen_idx").on(t.lastSeenAt),
  ],
);

/**
 * ═══════════ KHOẢNG HỤT CỦA WEBHOOK — ĐO BẰNG NGUỒN ĐỘC LẬP, KHÔNG BẰNG LỜI HỨA ═══════════
 *
 * ─── VÌ SAO BẢNG NÀY TỒN TẠI ───
 *
 * Đo production 16/09/2026: **2.138/2.151 vận đơn là `WEBHOOK_ONLY`**. Với chúng webhook là NGUỒN
 * TIN DUY NHẤT, và một nguồn duy nhất mà không ai biết nó rơi bao nhiêu phần trăm thì không dùng
 * để ra quyết định được.
 *
 * ERP không thể tự phát hiện mình đang thiếu một gói tin CHƯA TỪNG TỚI. Chỗ hụt chỉ lộ ra khi một
 * nguồn ĐỘC LẬP nói lại cùng một sự việc — hôm nay là tệp "Danh sách vận đơn" tải từ
 * viettelpost.vn. Nên mỗi lần nhập tệp, ngoài việc vá dữ liệu, ERP ghi lại một PHÉP ĐO.
 *
 * ─── MỖI DÒNG LÀ MỘT BẰNG CHỨNG, KHÔNG PHẢI MỘT CẢNH BÁO ───
 *
 * Dòng ở đây nói: "ĐVVC ghi nhận việc này lúc T, mà tới lúc nhập tệp I thì ERP vẫn chưa biết".
 * Nó KHÔNG tự thành việc phải làm và KHÔNG tham gia bất kỳ phép tính nghiệp vụ nào — trạng thái
 * vận đơn vẫn do `shipment_events` quyết. Đây là sổ QUAN SÁT về chất lượng đường truyền.
 *
 * Ngưỡng và cách xếp mức nằm ở `lib/constants/webhook-gap.ts`, không nằm ở đây.
 */
export const vtpWebhookGaps = pgTable(
  "vtp_webhook_gaps",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    trackingCode: text("tracking_code").notNull().default(""),
    /** Lần nhập tệp đã phát hiện ra khoảng hụt này. */
    batchId: text("batch_id").references((): AnyPgColumn => vtpImportBatches.id, { onDelete: "set null" }),
    /** Câu chữ ĐVVC ghi trên dòng tệp — nguyên văn. */
    carrierStatusText: text("carrier_status_text").notNull().default(""),
    carrierStage: text("carrier_stage"),
    /** Mốc ĐVVC ghi nhận sự việc. */
    carrierEventAt: ts("carrier_event_at").notNull(),
    /**
     * Mốc ĐVVC mà ERP đang giữ TRƯỚC lần nhập. `NULL` = ERP chưa biết gì về kiện này —
     * CHƯA BIẾT, không phải "biết từ lúc 0".
     */
    erpKnewAt: ts("erp_knew_at"),
    /** Nguồn đã quyết định ảnh chụp trước đó (`VTP_WEBHOOK` · `VTP_IMPORT` …). */
    erpKnewSource: text("erp_knew_source"),
    detectedAt: ts("detected_at").notNull().defaultNow(),
    /** Số phút ERP đi sau ĐVVC, tính tới lúc nhập tệp. */
    gapMinutes: integer("gap_minutes").notNull(),
    /** `MINOR` · `MAJOR` · `CRITICAL` — theo ĐỘ DÀI khoảng hụt, không theo chặng. */
    severity: text("severity").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Cùng một sự việc phát hiện lại ở lần nhập sau KHÔNG được đếm thành hai lần rơi.
    uniqueIndex("vtp_webhook_gaps_uq").on(t.shipmentId, t.carrierEventAt, t.carrierStatusText),
    index("vtp_webhook_gaps_detected_idx").on(t.detectedAt),
    index("vtp_webhook_gaps_shipment_idx").on(t.shipmentId, t.carrierEventAt),
    index("vtp_webhook_gaps_batch_idx").on(t.batchId),
    check("vtp_webhook_gaps_severity_check", sql`${t.severity} IN ('MINOR', 'MAJOR', 'CRITICAL')`),
  ],
);

/**
 * ═══════════ SỔ LẦN NHẬP TỆP VIETTEL POST ═══════════
 *
 * Mỗi lần người bấm "Nhập trạng thái VTP" là một dòng — kể cả lần CHẠY THỬ. Chạy thử được ghi
 * cố ý: nó trả lời câu "hôm qua ai đã xem trước tệp này và thấy gì" khi con số sau đó gây tranh cãi.
 *
 * ─── IDEMPOTENT ĐI BẰNG CHECKSUM, KHÔNG BẰNG TÊN TỆP ───
 *
 * Viettel Post đặt tên tệp theo khoảng ngày nên hai lần tải cùng một khoảng cho ra CÙNG tên với
 * nội dung khác nhau, và cùng nội dung có thể mang hai tên (người dùng đổi tên khi tải lại).
 * `checksum` (SHA-256 của nội dung tệp) là danh tính thật. Nhập lại đúng tệp cũ ⇒ không dòng lịch
 * sử nào được sinh thêm, vì tầng dưới (`applyVtpOrderList`) đã idempotent theo
 * `(vận đơn, nguồn, trạng thái, mốc ĐVVC)`; sổ này chỉ nói thẳng ra điều đó cho người dùng.
 */
export const vtpImportBatches = pgTable(
  "vtp_import_batches",
  {
    id: id(),
    filename: text("filename").notNull(),
    /** SHA-256 của nội dung tệp — danh tính thật, không phụ thuộc tên. */
    checksum: text("checksum").notNull(),
    bytes: integer("bytes").notNull().default(0),
    /** `ORDER_LIST` (trạng thái giao) · `STATEMENT_DETAIL` (tiền thực thu) · `ERROR`. */
    kind: text("kind").notNull(),
    /** `PREVIEW` = chạy thử, không ghi gì. `APPLY` = đã ghi. */
    mode: text("mode").notNull(),
    uploadedBy: text("uploaded_by").notNull().default(""),
    uploadedById: text("uploaded_by_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    rows: integer("rows").notNull().default(0),
    matched: integer("matched").notNull().default(0),
    applied: integer("applied").notNull().default(0),
    /** Dòng bị bỏ vì CHỨNG TỪ TRONG TỆP CŨ HƠN trạng thái đang lưu — không phải lỗi. */
    stale: integer("stale").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    conflicts: integer("conflicts").notNull().default(0),
    unmatched: integer("unmatched").notNull().default(0),
    /** Dòng mang trạng thái ERP chưa dịch được. Vẫn vào sổ đăng ký, không bị ném đi. */
    unknownStatus: integer("unknown_status").notNull().default(0),
    /*
      ═══ PHÉP ĐO CHẤT LƯỢNG WEBHOOK CỦA CHÍNH LẦN NHẬP NÀY ═══

      `checked`   — dòng ghép được về một vận đơn ERP đã biết (mẫu số).
      `webhookOk` — trong số đó, ERP ĐÃ BIẾT bằng hoặc mới hơn ⇒ webhook làm đúng việc.
      `webhookGaps` — ERP chưa hề biết dù ĐVVC ghi nhận đã lâu ⇒ webhook đã rơi.

      Ba con số này là lý do lần nhập nào cũng đáng chạy, kể cả khi nó không đổi một vận đơn nào.
    */
    checked: integer("checked").notNull().default(0),
    webhookOk: integer("webhook_ok").notNull().default(0),
    webhookGaps: integer("webhook_gaps").notNull().default(0),
    invalid: integer("invalid").notNull().default(0),
    error: text("error"),
    /** Bảng kê chi tiết trước/sau của lần chạy — đủ để dựng lại màn hình xem trước. */
    summary: jsonb("summary"),
    createdAt: createdAt(),
  },
  (t) => [
    index("vtp_import_batches_checksum_idx").on(t.checksum, t.createdAt),
    index("vtp_import_batches_created_idx").on(t.createdAt),
    check("vtp_import_batches_mode_check", sql`${t.mode} IN ('PREVIEW', 'APPLY')`),
    check("vtp_import_batches_kind_check", sql`${t.kind} IN ('ORDER_LIST', 'STATEMENT_DETAIL', 'ERROR')`),
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
    /** ẢNH CHỤP tên xưởng / nơi mua lúc ghi. Khoá thật là `supplier_id` (`NULL` = phiếu cũ / chưa chọn trong danh mục). */
    supplier: text("supplier").notNull().default(""),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /**
     * Company OS · Agent D (0133): phiếu NHẬP HÀNG này nhận hàng của lệnh sản xuất / lô xưởng nào.
     * `NULL` = chưa khai — KHÔNG backfill (AGENTS.md mục 35): đoán lô cho phiếu cũ theo tên xưởng là
     * bịa một quy kết. Chỉ phiếu `RECEIPT` được gắn; kiểm tồn tại ở server action.
     */
    productionOrderId: text("production_order_id").references(() => productionOrders.id, { onDelete: "set null" }),
    productionBatchId: text("production_batch_id").references(() => productionBatches.id, { onDelete: "set null" }),
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
 * ═══════════ HÀNG HOÀN CHƯA XÁC ĐỊNH NGUỒN (kiện mất nhãn vận đơn) ═══════════
 *
 * Ca có thật ở kho: một kiện nằm trong lô hàng hoàn, hàng còn nguyên, nhưng nhãn vận đơn đã rách
 * hoặc bong mất. Không có mã để bắn, nên không có `shipments.id` để trỏ tới — và
 * `return_inspections.shipment_id` là NOT NULL. Trước bản này ERP không có chỗ nào ghi kiện ấy.
 *
 * Kho khi đó chỉ còn hai đường, cả hai đều làm hỏng sổ:
 *  · chọn đại một đơn "gần giống" ⇒ một khách vô can mang tiếng trả hàng, và tỷ lệ hoàn của mã đó sai;
 *  · lập phiếu nhập kho thường ⇒ hàng hoàn đội lốt hàng nhập mới, giá vốn lẫn tỷ lệ hoàn cùng sai.
 *
 * ─── BA LỚP, KHÔNG SUY RA LẪN NHAU ───
 *
 *   LỚP 1 (kiện vật lý có thật)  ·  LỚP 2 (thuộc đơn nào)  ·  LỚP 3 (đếm xong, còn bán được)
 *
 * Bảng này giữ LỚP 1 và LỚP 3 mà KHÔNG cần lớp 2. Món hàng tồn tại, đếm được, kết luận được — và
 * vẫn nằm NGOÀI tồn bán được cho tới khi có người đủ thẩm quyền quyết.
 *
 * ─── VÌ SAO KHÔNG GHI THẲNG VÀO `stock_receipts` ───
 *
 * `lib/queries/stock.ts` tính tồn bằng TỔNG mọi dòng `stock_receipt_items`. Một dòng ở đó là một
 * món đã bán được — đúng cái mà toàn bộ luồng kiểm đếm sinh ra để ngăn. Hàng giữ tạm nằm riêng ở
 * đây và chỉ SINH RA một phiếu `RETURN` khi có người quyết; `stock_receipt_id` chính là cây cầu
 * một chiều ấy, và vì nó là cột DUY NHẤT nói "đã vào tồn" nên không thể vào tồn hai lần.
 */
export const returnUnidentified = pgTable(
  "return_unidentified",
  {
    id: id(),
    /**
     * Mã nội bộ đọc được bằng mắt: `UR-YYYYMMDD-NNNNN`. Người kho viết nó lên kiện bằng bút, nên
     * nó phải ngắn và không có ký tự dễ đọc nhầm. DUY NHẤT — đây là thứ thay cho mã vận đơn.
     */
    code: text("code").notNull().unique(),
    /** PENDING_IDENTIFICATION · IDENTIFIED · UNIDENTIFIABLE — xem `UNIDENTIFIED_STATUSES`. */
    status: text("status").notNull().default("PENDING_IDENTIFICATION"),
    /** NO_TRACKING_LABEL · DAMAGED_LABEL · UNKNOWN_PARCEL — vì sao kiện này không có mã. */
    source: text("source").notNull().default("NO_TRACKING_LABEL"),

    // ── LỚP 1: kiện đã về tới kho ──
    receivedAt: ts("received_at").notNull(),
    /** Ảnh chụp TÊN người nhận, do MÁY CHỦ đọc từ `users` (luật 34) — không nhận từ trình duyệt. */
    receivedBy: text("received_by").notNull().default(""),
    receivedByUserId: text("received_by_user_id").references(() => users.id, { onDelete: "set null" }),
    warehouseNote: text("warehouse_note").notNull().default(""),

    // ── LỚP 3: kho đếm được gì ──
    /**
     * Mẫu mã kho nhận diện được. `NULL` = CHƯA NHẬN DIỆN ĐƯỢC, khác hẳn "không có mẫu mã".
     * Không có nó thì không bao giờ cộng được vào tồn — cộng vào đâu?
     */
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** Ảnh chụp lúc nhận: mẫu mã có thể bị đổi tên hoặc xoá sau đó, phần đã đếm thì không được đổi. */
    sku: text("sku").notNull().default(""),
    productName: text("product_name").notNull().default(""),
    color: text("color").notNull().default(""),
    size: text("size").notNull().default(""),
    quantity: integer("quantity").notNull(),
    /** Một khoá trong `ITEM_CONDITIONS` — DÙNG CHUNG với kiểm từng món, không dựng danh sách thứ hai. */
    condition: text("condition").notNull(),
    note: text("note").notNull().default(""),

    // ── LỚP 2: nối được với đơn nào (có thể mãi không có) ──
    /** `MANUAL_MATCH` — xem `IDENTIFICATION_METHODS`. `NULL` = chưa ai nối. */
    identificationMethod: text("identification_method"),
    identifiedAt: ts("identified_at"),
    identifiedBy: text("identified_by").notNull().default(""),
    identifiedByUserId: text("identified_by_user_id").references(() => users.id, { onDelete: "set null" }),
    linkedOrderId: text("linked_order_id").references(() => orders.id, { onDelete: "set null" }),
    linkedShipmentId: text("linked_shipment_id").references(() => shipments.id, { onDelete: "set null" }),
    /** Ảnh chụp mã vận đơn lúc nối — vận đơn có thể bị đổi mã, dòng quy kết thì không được đổi. */
    linkedTrackingNumber: text("linked_tracking_number").notNull().default(""),
    /** Vì sao kết luận không thể xác định. BẮT BUỘC khi `status = 'UNIDENTIFIABLE'`. */
    unidentifiableReason: text("unidentifiable_reason").notNull().default(""),

    // ── CÂY CẦU MỘT CHIỀU SANG TỒN KHO ──
    /**
     * Phiếu `RETURN` sinh ra khi món này được cộng vào tồn. `NULL` = CHƯA VÀO TỒN.
     *
     * Đây là cột DUY NHẤT trả lời câu "đã cộng chưa", và mọi đường ghi đều đặt nó bằng một lượt
     * `UPDATE ... WHERE stock_receipt_id IS NULL`. Nên hai tab, hai lần bấm, hay một lượt thử lại
     * của mạng đều chỉ cộng được đúng một lần — chặn ở CSDL, không phải ở trình duyệt.
     */
    stockReceiptId: text("stock_receipt_id").references(() => stockReceipts.id, { onDelete: "restrict" }),
    restockedAt: ts("restocked_at"),
    restockedBy: text("restocked_by").notNull().default(""),
    restockedByUserId: text("restocked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** IDENTIFIED · MANAGER_OVERRIDE — căn cứ để món này được vào tồn. Xem `RESTOCK_AUTHORITIES`. */
    restockAuthority: text("restock_authority"),
    /** Lý do BẮT BUỘC khi vào tồn mà không có chứng từ đơn. */
    restockReason: text("restock_reason").notNull().default(""),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("return_unidentified_status_idx").on(t.status, t.receivedAt),
    index("return_unidentified_variant_idx").on(t.variantId),
    index("return_unidentified_shipment_idx").on(t.linkedShipmentId),
    /** "Món nào còn đang giữ tạm" là câu hỏi mỗi lần mở trang — quét bảng cho nó là lãng phí. */
    index("return_unidentified_holding_idx").on(t.stockReceiptId, t.status),

    /* Ba danh sách dưới đây PHẢI khớp hằng số ở lib/constants/return-unidentified.ts. Đã có tiền
       lệ lệch giữa hằng số TypeScript và ràng buộc SQL (`WRONG_ITEM` của bảng kiểm cả kiện):
       người kho bấm một nút hợp lệ và nhận lỗi ràng buộc, đúng lúc đang đứng đếm hàng. */
    check("return_unidentified_status_check", sql`${t.status} IN ('PENDING_IDENTIFICATION', 'IDENTIFIED', 'UNIDENTIFIABLE')`),
    check("return_unidentified_source_check", sql`${t.source} IN ('NO_TRACKING_LABEL', 'DAMAGED_LABEL', 'UNKNOWN_PARCEL')`),
    /* Dùng CHUNG danh sách với `return_inspection_items` — một món hoàn là một món hoàn, dù nó đến
       kèm mã vận đơn hay không. */
    check("return_unidentified_condition_check", sql`${t.condition} IN ('OK', 'SHORT', 'WRONG_ITEM', 'DAMAGED', 'DIRTY', 'UNSELLABLE', 'OTHER')`),
    /* Không có hàng thì không có việc gì để ghi. Số 0 ở đây là một dòng rác vĩnh viễn. */
    check("return_unidentified_qty_check", sql`${t.quantity} > 0`),
    /* Đã nối đơn thì phải nói NỐI VỚI CÁI GÌ, AI nối, LÚC NÀO — một dòng "đã xác định" mà không chỉ
       được đích danh vận đơn hay đơn nào là một lời khẳng định không kiểm chứng được. */
    check(
      "return_unidentified_identified_check",
      sql`${t.status} <> 'IDENTIFIED' OR (${t.identificationMethod} IS NOT NULL AND ${t.identifiedAt} IS NOT NULL AND length(trim(${t.identifiedBy})) > 0 AND (${t.linkedShipmentId} IS NOT NULL OR ${t.linkedOrderId} IS NOT NULL))`,
    ),
    check("return_unidentified_method_check", sql`${t.identificationMethod} IS NULL OR ${t.identificationMethod} IN ('MANUAL_MATCH')`),
    /* Kết luận "không thể xác định" phải có lý do: nếu không, nó chỉ là một cách bỏ việc lại cho
       người sau mà trông như đã xử lý xong. */
    check("return_unidentified_unidentifiable_check", sql`${t.status} <> 'UNIDENTIFIABLE' OR length(trim(${t.unidentifiableReason})) > 0`),
    /* ĐÃ VÀO TỒN thì phải đủ: ai cộng, lúc nào, CĂN CỨ nào, và cộng vào MẪU MÃ nào. Thiếu bất kỳ
       phần nào thì một món hàng xuất hiện trong tồn mà không ai giải thích được từ đâu ra. */
    check(
      "return_unidentified_restock_check",
      sql`${t.stockReceiptId} IS NULL OR (${t.restockedAt} IS NOT NULL AND length(trim(${t.restockedBy})) > 0 AND ${t.restockAuthority} IS NOT NULL AND ${t.variantId} IS NOT NULL)`,
    ),
    check("return_unidentified_authority_check", sql`${t.restockAuthority} IS NULL OR ${t.restockAuthority} IN ('IDENTIFIED', 'MANAGER_OVERRIDE')`),
    /* Vào tồn mà KHÔNG có chứng từ đơn thì bắt buộc có lý do viết ra được — đây là toàn bộ khác
       biệt giữa một quyết định của quản lý kho và một lượt cộng tồn không nguồn gốc. */
    check(
      "return_unidentified_override_reason_check",
      sql`${t.restockAuthority} IS DISTINCT FROM 'MANAGER_OVERRIDE' OR length(trim(${t.restockReason})) > 0`,
    ),
    /* Căn cứ `IDENTIFIED` chỉ đứng được khi thật sự đã nối đơn — nếu không, nó là `MANAGER_OVERRIDE`
       đội lốt căn cứ mạnh hơn, và lượt tái nhập không chứng từ ấy biến mất khỏi mọi báo cáo. */
    check(
      "return_unidentified_authority_status_check",
      sql`${t.restockAuthority} IS DISTINCT FROM 'IDENTIFIED' OR ${t.status} = 'IDENTIFIED'`,
    ),
    /* MỖI PHIẾU KHO CHỈ PHỤC VỤ MỘT MÓN GIỮ TẠM. Không có ràng buộc này thì một lỗi lập trình có
       thể trỏ hai dòng vào cùng một phiếu, và "đã vào tồn" trở thành một lời nói dối có vẻ hợp lệ. */
    uniqueIndex("return_unidentified_receipt_uk").on(t.stockReceiptId),
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
    check("bank_txn_linked_check", sql`${t.linkedType} IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION', 'SUPPLIER_PAYMENT')`),
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
    check("bank_txn_links_target_type_check", sql`${t.targetType} IN ('EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION', 'SUPPLIER_PAYMENT')`),
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
/**
 * NHÓM QUẢNG CÁO (ADSET) — MẮT XÍCH CÒN THIẾU GIỮA TRACKING LANDING VÀ CHIẾN DỊCH.
 *
 * ─── VÌ SAO PHẢI CÓ BẢNG NÀY ───
 *
 * Form landing ghi `utm_source` bằng **adset_id**, không phải tên chiến dịch (đo production
 * 15/09/2026: 29 đơn treo, 10 mã, Graph khai cả 10 là ADSET). Trong khi ERP:
 *   · `fb_ads` chỉ tra những `ad_id` XUẤT HIỆN TRONG `orders.ad_id` — mà đơn landing thì Pancake
 *     không gửi `ad_id`, nên các nhóm ấy KHÔNG BAO GIỜ được tra;
 *   · `ad_spends` chỉ giữ số liệu ở mức CHIẾN DỊCH (campaign insights), nên một `adset_id` không
 *     bao giờ khớp được ở đó — không phải lỗi dữ liệu, mà là sai CẤP.
 *
 * Bảng này giữ đúng một việc: `adset_id → campaign_id` (+ tài khoản quảng cáo), tra thẳng từ
 * Graph theo ĐÚNG những mã đang cần. Có nó thì chuỗi `tracking → adset → chiến dịch → TKQC →
 * marketer` khép kín mà không phải đoán một chữ nào.
 */
export const fbAdsets = pgTable(
  "fb_adsets",
  {
    /** adset_id Facebook. */
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    campaignId: text("campaign_id"),
    accountId: text("account_id"),
    /** Trạng thái hiệu lực (`PAUSED`, `CAMPAIGN_PAUSED`…) — nhóm đã tắt vẫn phải tra được. */
    status: text("status").notNull().default(""),
    /** Không tra được trên Facebook (đã xoá / không có quyền). Giữ dòng để khỏi tra lại mỗi giờ. */
    missing: boolean("missing").notNull().default(false),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("fb_adsets_campaign_idx").on(t.campaignId), index("fb_adsets_account_idx").on(t.accountId)],
);

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

    /**
     * ───────── HẠT CỦA DÒNG NÀY, VÀ VÌ SAO NÓ PHẢI ĐƯỢC KHAI RA ─────────
     *
     * `CAMPAIGN` = một dòng cho mỗi (chiến dịch × ngày) — hạt gốc từ 2025.
     * `AD`       = một dòng cho mỗi (mẩu × ngày); cấp nhóm và cấp chiến dịch khi ấy là PHÉP CỘNG
     *              của các dòng này, không phải một phép chia.
     * `MANUAL`   = người gõ tay ở trang Chi phí.
     *
     * Hai hạt CÙNG TỒN TẠI trong bảng là bình thường và bắt buộc: Facebook chỉ giữ insights khoảng
     * 37 tháng và lượt đồng bộ chỉ chạm N ngày gần nhất, nên ngày cũ mãi mãi ở hạt `CAMPAIGN`. Điều
     * PHẢI giữ là **một (tài khoản × ngày) chỉ có MỘT hạt**: trộn hai hạt trong cùng một ngày là
     * cộng đúp toàn bộ chi phí quảng cáo của ngày ấy, tức làm sai mọi con số lợi nhuận và lương
     * cùng lúc. `lib/integrations/facebook/sync.ts` bảo đảm điều đó bằng XOÁ-RỒI-GHI trong một
     * giao dịch, và `tests/ads-grain.test.ts` khoá lại ở mức mã nguồn.
     *
     * Mọi phép `sum(spend)` đang có KHÔNG cần đổi: tổng của các dòng cấp mẩu đúng bằng dòng cấp
     * chiến dịch mà chúng thay thế — đó chính là điều `ads-level-probe` đi đo trước khi bật.
     */
    grain: text("grain").notNull().default("CAMPAIGN"),
    /** Chỉ có ở hạt `AD`. `NULL` ở hạt `CAMPAIGN` nghĩa là CHƯA BIẾT, không phải "không có nhóm". */
    adsetId: text("adset_id"),
    adsetName: text("adset_name").notNull().default(""),
    adId: text("ad_id"),
    adName: text("ad_name").notNull().default(""),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ad_spends_platform_date_idx").on(t.platform, t.spendDate),
    index("ad_spends_date_idx").on(t.spendDate),
    uniqueIndex("ad_spends_external_key_uq").on(t.externalKey),
    index("ad_spends_product_idx").on(t.productId),
    index("ad_spends_marketer_idx").on(t.marketerId),
    index("ad_spends_adset_idx").on(t.adsetId, t.spendDate),
    index("ad_spends_ad_idx").on(t.adId, t.spendDate),
    check("ad_spends_grain_check", sql`${t.grain} IN ('CAMPAIGN', 'AD', 'MANUAL')`),
    // Hạt `AD` mà không có mã mẩu là một dòng tự mâu thuẫn — nó sẽ rơi khỏi mọi phép gộp cấp mẩu
    // trong khi vẫn được cộng vào tổng, tức mất dấu tiền ở đúng cấp vừa dựng ra để nhìn thấy nó.
    check("ad_spends_ad_grain_check", sql`${t.grain} <> 'AD' OR ${t.adId} IS NOT NULL`),
  ],
);

/**
 * ───────────────────── SỔ QUYẾT ĐỊNH QUẢNG CÁO ─────────────────────
 *
 * Luật, kỳ chuẩn và mọi ngưỡng: `lib/constants/marketing-decision-ledger.ts`.
 * Đặc tả phòng: `docs/marketing-ai-department.md`.
 *
 * MỘT dòng = *"ngày ấy, trên kỳ chuẩn ấy, ERP kết luận gì về mục này, và bằng chứng nào"*.
 *
 * Bảng này **không sinh ra một con số nào**: nó chép lại đầu ra của `decideAction()`. Không có
 * công thức thứ hai ở đây, và không báo cáo tiền nào được đọc từ bảng này — tiền vẫn tính ở
 * `lib/queries/ads-decision.ts`. Việc của sổ là TRÍ NHỚ: hôm qua ERP nghĩ gì, và nó có đổi ý không.
 *
 * Khoá tự nhiên `(decision_day, dimension, entity_key)`: chạy lại job trong cùng một ngày là CẬP
 * NHẬT đúng dòng ấy, không đẻ dòng thứ hai. Job chạy nhiều lượt/ngày vẫn để lại một dòng mỗi ngày.
 */
export const adsDecisionLedger = pgTable(
  "ads_decision_ledger",
  {
    id: id(),
    /** Ngày Việt Nam ERP đưa ra kết luận (`YYYY-MM-DD`) — KHÔNG phải ngày cuối kỳ dữ liệu. */
    decisionDay: text("decision_day").notNull(),
    /** `campaign` · `product` · `adset` · `ad` — xem `ADS_DIMENSION_LABEL`. */
    dimension: text("dimension").notNull(),
    entityKey: text("entity_key").notNull(),
    /** ẢNH CHỤP tên lúc kết luận: tên chiến dịch đổi được, dòng sổ cũ vẫn phải đọc được. */
    entityName: text("entity_name").notNull().default(""),

    action: text("action").notNull(),
    /** `ACTIONABLE` · `NO_CHANGE` · `NO_OPINION` — dẫn xuất từ `action`, lưu để lọc rẻ. */
    actionClass: text("action_class").notNull(),
    /**
     * `ACTUAL` = kết luận đứng trên SỐ ĐO · `PROJECTED` = đứng trên lợi nhuận TẠM TÍNH.
     *
     * Phải nằm trong sổ chứ không tính lại lúc đọc: bàn tay ghi ngân sách gác theo trường này, và
     * số liệu của một ngày đã qua sẽ chín thêm theo thời gian — tính lại hôm nay sẽ cho ra căn cứ
     * KHÁC với căn cứ mà kết luận hôm ấy thật sự đứng trên. Dòng sổ là một lời khai, không phải
     * một khung nhìn (AGENTS.md mục 21).
     *
     * Mặc định `ACTUAL` cho các dòng ghi TRƯỚC khi có cột này — đó đúng là cách chúng được sinh ra:
     * luật cũ chỉ kết luận khi đã đủ độ chín. Không backfill gì khác (mục 8.8).
     */
    basis: text("basis").notNull().default("ACTUAL"),
    reason: text("reason").notNull().default(""),

    /** Kỳ dữ liệu sinh ra kết luận — đọc lại được mà không phải suy từ `decision_day`. */
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    /** Tăng khi công thức/ngưỡng đổi. Hai phiên bản khác nhau KHÔNG nối thành một chuỗi. */
    ruleVersion: integer("rule_version").notNull(),
    /** Toàn bộ ngưỡng đang chạy lúc kết luận — "vì sao hôm ấy nó nói CẮT" trả lời được mãi mãi. */
    ruleSnapshot: jsonb("rule_snapshot").notNull(),

    // ── BẰNG CHỨNG: đúng những con số `decideAction` đã nhìn, không nhiều hơn ──
    spendKnown: boolean("spend_known").notNull(),
    spend: money("spend"),
    bookedOrders: integer("booked_orders").notNull().default(0),
    deliveredOrders: integer("delivered_orders").notNull().default(0),
    returnedOrders: integer("returned_orders").notNull().default(0),
    openOrders: integer("open_orders").notNull().default(0),
    deliveredRevenue: money("delivered_revenue"),
    profitAfterAds: integer("profit_after_ads").notNull().default(0),
    /**
     * Bốn tỷ số dưới đây NULLABLE, và `NULL` nghĩa là CHƯA BIẾT (mục 42): chưa đơn nào ngã ngũ thì
     * tỷ lệ giao thành công không phải 0%, nó là chưa đo được.
     */
    successRate: doublePrecision("success_rate"),
    maturity: doublePrecision("maturity"),
    headroom: doublePrecision("headroom"),
    breakEvenBookedRoas: doublePrecision("break_even_booked_roas"),
    /*
      ─── Company OS · Agent F · ẢNH CHỤP DỰ PHÓNG (migration 0135) ───

      Lợi nhuận TẠM TÍNH mà dòng đứng trên lúc kết luận — chép từ ĐÚNG dòng `buildDecisionRow` đã
      dựng, không tính lại. Có nó thì vài tuần sau mới so được "hôm ấy máy dự phóng bao nhiêu" với
      số đo khi cohort đã chín; thiếu nó thì mọi phép đo độ chính xác dự báo phải dựng lại quá khứ.

      NULLABLE và KHÔNG BACKFILL (mục 35, 8.8): dòng ghi trước 0135 mang `NULL` = CHƯA CHỤP, không
      phải 0 ₫. Dựng lại số của một ngày đã qua là tính trên dữ liệu đã chín thêm — một con số khác.
    */
    projectedProfitAfterAds: integer("projected_profit_after_ads"),
    projectedHeadroom: doublePrecision("projected_headroom"),
    /** Tỷ lệ GTC (%) đã áp cho phần đang treo của dòng. `NULL` = không có gì treo, hoặc dòng ghi trước 0135. */
    appliedDeliveryRate: doublePrecision("applied_delivery_rate"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ads_decision_ledger_day_uq").on(t.decisionDay, t.dimension, t.entityKey),
    // Đọc chuỗi của MỘT mục — đường truy vấn nóng nhất (`stabilityOf`).
    index("ads_decision_ledger_entity_idx").on(t.dimension, t.entityKey, t.decisionDay),
    index("ads_decision_ledger_day_idx").on(t.decisionDay, t.actionClass),
    check("ads_decision_ledger_class_check", sql`${t.actionClass} IN ('ACTIONABLE', 'NO_CHANGE', 'NO_OPINION')`),
    // Danh sách ĐÓNG: một chuỗi lạ ở đây làm cổng ghi ngân sách so sánh nhầm và mở ra cho cái nó định chặn.
    check("ads_decision_ledger_basis_check", sql`${t.basis} IN ('ACTUAL', 'PROJECTED')`),
    // Ngày phải là ngày. Một chuỗi lạ ở đây làm mọi phép so chuỗi theo thứ tự nói sai mà không gì đỏ.
    check("ads_decision_ledger_day_format_check", sql`${t.decisionDay} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ],
);

/**
 * ───────────────────── SỔ LƯỢT GHI NGÂN SÁCH QUẢNG CÁO ─────────────────────
 *
 * Hàng rào và mọi con số: `lib/constants/ads-write.ts`. Đặc tả: `docs/marketing-ai-department.md` mục 5.
 *
 * MỘT dòng = một lượt XIN ghi vào Facebook, **kể cả lượt bị chặn**.
 *
 * ─── VÌ SAO LƯỢT BỊ CHẶN CŨNG VÀO SỔ ───
 *
 * *"Máy đã ĐỊNH làm gì"* là thông tin quý nhất khi đánh giá một cỗ máy tự chủ, và nó chỉ tồn tại
 * nếu lượt bị chặn cũng để lại dấu. Một sổ chỉ ghi lượt thành công sẽ khiến một luật sai trông như
 * một luật thận trọng: nó xin sai hai mươi lần mỗi ngày và hàng rào chặn hết, nhưng không ai biết.
 *
 * ─── HAI ẢNH CHỤP TIỀN, VÀ CHÚNG TRẢ LỜI HAI CÂU ───
 *
 * `budget_before` / `budget_after` là NGÂN SÁCH — thứ lượt ghi này đổi.
 * `profit_before` là lợi nhuận góp sau quảng cáo TẠI THỜI ĐIỂM bấm, chép từ dòng sổ quyết định đã
 * sinh ra đề nghị. Nó là mốc để PHANH so về sau; không có nó thì "lượt đổi ấy tốt hay xấu" là một
 * câu không trả lời được, và phanh thành một cái tên không có nội dung.
 */
export const adsBudgetChanges = pgTable(
  "ads_budget_changes",
  {
    id: id(),
    /** Ngày Việt Nam của lượt bấm (`YYYY-MM-DD`) — trần theo ngày đếm trên cột này. */
    changeDay: text("change_day").notNull(),
    campaignId: text("campaign_id").notNull(),
    /** ẢNH CHỤP tên lúc bấm: tên chiến dịch đổi được, dòng sổ cũ vẫn phải đọc được. */
    campaignName: text("campaign_name").notNull().default(""),

    /** `SET_DAILY_BUDGET` · `PAUSE_CAMPAIGN`. */
    action: text("action").notNull(),
    /** `APPLIED` · `DENIED` · `FAILED` — ba thứ khác nhau, không gộp. */
    outcome: text("outcome").notNull(),
    /** Mã lý do bị chặn (`AdsWriteDenial`). Rỗng khi không bị chặn. */
    denial: text("denial").notNull().default(""),
    /** Câu giải thích cho người đọc — lý do chặn, hoặc lỗi Facebook trả về. */
    detail: text("detail").notNull().default(""),

    /** Khuyến nghị đã sinh ra lượt này, và dòng sổ quyết định của nó. */
    decision: text("decision").notNull(),
    ledgerId: text("ledger_id").references(() => adsDecisionLedger.id, { onDelete: "set null" }),
    /** Số ngày khuyến nghị đã giữ lúc bấm — đọc lại được "nó chín tới đâu khi ta tin nó". */
    heldDays: integer("held_days").notNull().default(0),

    /** `NULL` = CHƯA BIẾT, không phải 0 (mục 42). Với `PAUSE_CAMPAIGN` thì `budget_after` vô nghĩa. */
    budgetBefore: integer("budget_before"),
    budgetAfter: integer("budget_after"),
    /** Lợi nhuận góp sau QC lúc bấm — mốc để PHANH so về sau. */
    profitBefore: integer("profit_before"),

    /** QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (mục 34). `NULL` = MÁY làm, khác hẳn "chưa biết ai". */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP TÊN do MÁY CHỦ đọc từ `users` — không nhận từ client. */
    actorEmail: text("actor_email").notNull().default(""),
    /** `COPILOT` (người bấm) · `AUTO` (máy tự) — để về sau phân biệt được hai nguồn trong cùng một sổ. */
    mode: text("mode").notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    index("ads_budget_changes_day_idx").on(t.changeDay, t.outcome),
    index("ads_budget_changes_campaign_idx").on(t.campaignId, t.changeDay),
    index("ads_budget_changes_actor_idx").on(t.actorUserId, t.createdAt),
    check("ads_budget_changes_outcome_check", sql`${t.outcome} IN ('APPLIED', 'DENIED', 'FAILED')`),
    check("ads_budget_changes_action_check", sql`${t.action} IN ('SET_DAILY_BUDGET', 'PAUSE_CAMPAIGN')`),
    check("ads_budget_changes_day_format_check", sql`${t.changeDay} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    // Lượt ĐÃ ÁP phải nói được nó bị chặn bởi cái gì — tức là KHÔNG bị chặn. Một dòng vừa APPLIED
    // vừa mang mã chặn là một dòng không ai đọc được, và nó sẽ làm mọi phép đếm nói sai.
    check("ads_budget_changes_denial_check", sql`${t.outcome} <> 'APPLIED' OR ${t.denial} = ''`),
  ],
);

// ───────────────────── Vòng mẫu quảng cáo (Nấc 4 — NỘI DUNG) ─────────────────────
//
// Hợp đồng, từ vựng, trần: `lib/constants/creative-loop.ts`. Đặc tả: `docs/creative-loop.md`.
// Bảy bảng, bảy việc: ẢNH (điểm ảnh) · NGUỒN (ảnh đầu vào) · LÔ (một ngày test) · MẪU (một ô) ·
// SỔ GHI FACEBOOK · SỔ PHÁN QUYẾT (ảnh chụp theo ngày) · SỔ HỌC (thống kê gen theo ngày).
//
// Không bảng nào ở đây là nguồn của tiền: chi quảng cáo vẫn là `ad_spends` (hạt `AD`), kết quả đơn
// vẫn là `ORDER_OUTCOME`. Các bảng này chỉ nhớ MẪU NÀO là mẩu QC nào, và máy đã quyết gì.

/**
 * Điểm ảnh, lưu thẳng trong CSDL như `marketing_idea_images` — ổ đĩa của CSDL là thứ duy nhất bền
 * qua mỗi lần deploy. Bảng riêng để mọi truy vấn danh sách không bao giờ kéo theo dữ liệu ảnh.
 *
 * Ảnh của mẫu bị LOẠI bị XOÁ ĐIỂM ẢNH sau hạn giữ (`data = ''`, `purged_at`), còn dòng thì ở lại:
 * mẫu thua vẫn là một quan sát của việc học, chỉ là không cần giữ tấm ảnh nữa.
 */
export const creativeImages = pgTable(
  "creative_images",
  {
    id: id(),
    /** Băm của CHÍNH các byte đã nhận — không nhận băm do client gửi. */
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull().default("image/jpeg"),
    bytes: integer("bytes").notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    /** Base64. Rỗng khi đã xoá điểm ảnh. */
    data: text("data").notNull().default(""),
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("creative_images_sha_idx").on(t.sha256),
    check("creative_images_purge_check", sql`${t.purgedAt} IS NULL OR ${t.data} = ''`),
  ],
);

/** Ảnh đầu vào: ảnh sản phẩm thật · quảng cáo cũ của shop · tham khảo tay · spy · R&D. */
export const creativeSources = pgTable(
  "creative_sources",
  {
    id: id(),
    /** `PRODUCT_PHOTO` · `OWN_AD` · `MANUAL` · `SPY` · `RND` (`CreativeSourceKind`). */
    kind: text("kind").notNull(),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    note: text("note").notNull().default(""),
    /** Nơi lấy ảnh (bài đối thủ, thư viện quảng cáo) — để người đọc lần lại được. */
    sourceUrl: text("source_url").notNull().default(""),
    imageId: text("image_id").references(() => creativeImages.id, { onDelete: "set null" }),
    /** Gen ĐỌC ĐƯỢC từ ảnh (một phần, chỉ giá trị trong từ vựng). */
    genes: jsonb("genes").$type<Record<string, string>>().notNull().default({}),
    /** Mô tả chữ do mô hình đọc ảnh — thứ DUY NHẤT của ảnh SPY được đi tiếp vào câu lệnh. */
    visionSummary: text("vision_summary").notNull().default(""),
    visionModel: text("vision_model").notNull().default(""),
    visionAt: ts("vision_at"),
    active: boolean("active").notNull().default(true),
    /** QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (mục 34). `NULL` = máy tạo. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    /**
     * Mẩu quảng cáo Facebook mà nguồn `OWN_AD` được nhập từ — khoá LŨY ĐẲNG (duy nhất khi có) và là
     * danh tính "quảng cáo của chính shop": không có nó thì không phải `OWN_AD` (ràng buộc bên dưới).
     */
    fbAdId: text("fb_ad_id"),
    /** Số đo lúc nhập (`OwnAdMetrics`: chi, tin nhắn, chi/tin, CTR, CPC, đơn, kỳ đo). Nguồn khác: `{}`. */
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    /** Câu chữ đã chạy của quảng cáo cũ — máy viết học giọng văn đã bán được từ đây. */
    primaryText: text("primary_text").notNull().default(""),
    headline: text("headline").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("creative_sources_kind_idx").on(t.kind, t.active),
    index("creative_sources_product_idx").on(t.productId),
    uniqueIndex("creative_sources_fb_ad_uq").on(t.fbAdId).where(sql`${t.fbAdId} IS NOT NULL`),
    check("creative_sources_kind_check", sql`${t.kind} IN ('PRODUCT_PHOTO', 'OWN_AD', 'MANUAL', 'SPY', 'RND')`),
    // Ảnh sản phẩm thật mà không biết là sản phẩm nào thì không làm gốc cho mẫu nào được.
    check("creative_sources_product_photo_check", sql`${t.kind} <> 'PRODUCT_PHOTO' OR ${t.productId} IS NOT NULL`),
    // Quảng cáo cũ của shop PHẢI truy được về một mẩu trên tài khoản của shop — điểm ảnh của nó được gửi
    // sang máy sinh ảnh, nên danh tính ấy không thể là một ô chọn loại trên form.
    check("creative_sources_own_ad_check", sql`${t.kind} <> 'OWN_AD' OR ${t.fbAdId} IS NOT NULL`),
  ],
);

/** Một LÔ = một ngày chạy test. Khoá tự nhiên `batch_day` ⇒ job chạy lại không đẻ lô thứ hai. */
export const creativeBatches = pgTable(
  "creative_batches",
  {
    id: id(),
    /** Ngày CHẠY, giờ Việt Nam (`YYYY-MM-DD`). */
    batchDay: text("batch_day").notNull(),
    status: text("status").notNull().default("PLANNED"),
    slotCount: integer("slot_count").notNull().default(0),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    approvalDeadline: ts("approval_deadline").notNull(),
    /** Đầu ra của `planBatch()` — các ô và phần thiếu, chụp nguyên. */
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull().default({}),
    /** Cấu hình lúc lập lô — luật tắt/giữ và ngân sách của lô này KHÔNG đổi theo cấu hình về sau. */
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    ruleVersion: integer("rule_version").notNull(),
    error: text("error").notNull().default(""),
    /** Băm nội dung đã duyệt (ảnh · câu chữ · ngân sách · khung giờ · luật tắt) — phiếu duyệt khoá trên nó. */
    approvalDigest: text("approval_digest").notNull().default(""),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedByName: text("approved_by_name").notNull().default(""),
    approvedAt: ts("approved_at"),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("creative_batches_day_uq").on(t.batchDay),
    index("creative_batches_status_idx").on(t.status),
    check("creative_batches_status_check", sql`${t.status} IN ('PLANNED', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'EXPIRED', 'REJECTED', 'FAILED')`),
    check("creative_batches_day_format_check", sql`${t.batchDay} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    // Không có lô nào được ĐĂNG mà không có dấu duyệt — ràng buộc ở CSDL, không chỉ ở mã.
    check("creative_batches_approval_check", sql`${t.status} NOT IN ('APPROVED', 'PUBLISHED') OR (${t.approvedAt} IS NOT NULL AND ${t.approvalDigest} <> '')`),
  ],
);

/** Một MẪU = một ô trong lô: bản giao việc → câu lệnh → ảnh → mẩu QC → phán quyết. */
export const creativeVariants = pgTable(
  "creative_variants",
  {
    id: id(),
    batchId: text("batch_id")
      .notNull()
      .references(() => creativeBatches.id),
    slot: integer("slot").notNull(),
    /** `EXPLOIT` (mockup mẫu thắng) · `EXPLORE` · `MANUAL` · `DESIGN` (thiết kế sản phẩm mới). */
    mode: text("mode").notNull(),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    productPhotoSourceId: text("product_photo_source_id").references(() => creativeSources.id, { onDelete: "set null" }),
    inspirationSourceId: text("inspiration_source_id").references(() => creativeSources.id, { onDelete: "set null" }),
    parentVariantId: text("parent_variant_id").references((): AnyPgColumn => creativeVariants.id, { onDelete: "set null" }),
    genes: jsonb("genes").$type<Record<string, string>>().notNull(),
    genesVersion: integer("genes_version").notNull(),
    mutatedGene: text("mutated_gene").notNull().default(""),
    why: text("why").notNull().default(""),

    imagePrompt: text("image_prompt").notNull().default(""),
    primaryText: text("primary_text").notNull().default(""),
    headline: text("headline").notNull().default(""),
    writerModel: text("writer_model").notNull().default(""),
    /** USD dạng chuỗi; `""` = CHƯA BIẾT (cùng quy ước `ai_interactions.cost_usd`). */
    writerCostUsd: text("writer_cost_usd").notNull().default(""),
    imageId: text("image_id").references(() => creativeImages.id, { onDelete: "set null" }),
    genModel: text("gen_model").notNull().default(""),
    genCostUsd: text("gen_cost_usd").notNull().default(""),
    genError: text("gen_error").notNull().default(""),

    status: text("status").notNull().default("PLANNED"),
    rejectReason: text("reject_reason").notNull().default(""),
    rejectedByUserId: text("rejected_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Người tải mẫu TỰ LÀM (mục 34). `NULL` = mẫu do máy lập. Tên là ảnh chụp do máy chủ đọc. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),

    fbImageHash: text("fb_image_hash").notNull().default(""),
    fbCreativeId: text("fb_creative_id").notNull().default(""),
    /** Bài ẩn trên fanpage mà Facebook dựng từ creative (`effective_object_story_id`). */
    fbPostId: text("fb_post_id").notNull().default(""),
    fbAdsetId: text("fb_adset_id"),
    fbAdId: text("fb_ad_id"),
    /** Ngân sách trọn đời ĐÃ CAM KẾT trên Facebook (test + mọi lượt tiêu thêm). `NULL` = chưa đăng. */
    committedBudgetVnd: integer("committed_budget_vnd"),
    publishedAt: ts("published_at"),
    pausedAt: ts("paused_at"),
    pauseReason: text("pause_reason").notNull().default(""),
    /** Vào thư viện (THẮNG) lúc nào, với bao nhiêu đơn — chốt một lần, không tự rơi ra. */
    libraryAt: ts("library_at"),
    libraryOrders: integer("library_orders"),
    lostAt: ts("lost_at"),
    /** Ô `DESIGN` ⇒ thiết kế mà mẩu này quảng cáo. Ô khác: `NULL`. */
    designConceptId: text("design_concept_id").references((): AnyPgColumn => designConcepts.id, { onDelete: "set null" }),
    /**
     * Luật RIÊNG của ô (`VariantRulesSnapshot`, chụp lúc lập lô) — ô mockup của mã cũ chấm bằng lịch sử
     * của chính mã (chủ shop 24/09/2026). `NULL` = ô dùng luật chung của lô. Phiếu duyệt khoá cả cột này.
     */
    rulesSnapshot: jsonb("rules_snapshot").$type<Record<string, unknown>>(),
    /**
     * TÊN chiến dịch · nhóm · quảng cáo sẽ đăng (chủ shop 25/09/2026, §5i). Máy điền theo khuôn mặc định,
     * người sửa được trước khi duyệt; cả ba nằm trong phiếu duyệt. Rỗng = mẫu của lô cũ (tên `VM <ngày> #<ô>`).
     */
    campaignName: text("campaign_name").notNull().default(""),
    adsetName: text("adset_name").notNull().default(""),
    adName: text("ad_name").notNull().default(""),
    /** Số thứ tự của bài trong NGÀY ĐĂNG (một lô mỗi ngày) — duy nhất trong lô. `NULL` = chưa đặt tên. */
    nameSeq: integer("name_seq"),
    /**
     * CHIẾN DỊCH RIÊNG của bài (mỗi bài một chiến dịch, §5i). `NULL` = chưa tạo, hoặc mẫu của lô cũ đăng
     * vào chiến dịch test chung. Có id mà mẫu chưa `LIVE` ⇒ chiến dịch vẫn TẮT.
     */
    fbCampaignId: text("fb_campaign_id"),
    /**
     * Bước ghi Facebook ĐANG GỬI (ghi NGAY TRƯỚC lời gọi, xoá cùng giao dịch lưu id). Còn chữ ở đây lúc lượt
     * sau đọc ⇒ lời gọi trước có thể đã tạo đối tượng mà phản hồi rơi mất ⇒ KHÔNG gửi lại (cùng lý do
     * `creative_scale_drafts.copy_attempted_at`).
     */
    fbPendingStep: text("fb_pending_step").notNull().default(""),
    fbPendingAt: ts("fb_pending_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("creative_variants_batch_slot_uq").on(t.batchId, t.slot),
    uniqueIndex("creative_variants_batch_name_seq_uq").on(t.batchId, t.nameSeq).where(sql`${t.nameSeq} IS NOT NULL`),
    index("creative_variants_design_idx").on(t.designConceptId),
    uniqueIndex("creative_variants_fb_ad_uq").on(t.fbAdId),
    index("creative_variants_status_idx").on(t.status),
    index("creative_variants_product_idx").on(t.productId),
    index("creative_variants_library_idx").on(t.libraryAt),
    check("creative_variants_mode_check", sql`${t.mode} IN ('EXPLOIT', 'EXPLORE', 'MANUAL', 'DESIGN')`),
    check("creative_variants_status_check", sql`${t.status} IN ('PLANNED', 'GENERATED', 'GEN_FAILED', 'REJECTED', 'LIVE', 'PAUSED', 'ENDED', 'PUBLISH_FAILED')`),
    // "Đang chạy" mà không có mẩu QC nào là một khẳng định không có chứng từ.
    check("creative_variants_live_check", sql`${t.status} NOT IN ('LIVE', 'PAUSED', 'ENDED') OR ${t.fbAdId} IS NOT NULL`),
    check("creative_variants_library_check", sql`${t.libraryAt} IS NULL OR ${t.libraryOrders} IS NOT NULL`),
  ],
);

/**
 * SỔ GHI FACEBOOK của vòng mẫu. Mọi lượt xin ghi vào sổ, KỂ CẢ lượt bị CHẶN — "máy đã ĐỊNH làm gì"
 * là thông tin quý nhất khi đánh giá một cỗ máy tiêu tiền (cùng lý do với `ads_budget_changes`).
 * Trần tiền theo ngày đếm trên sổ này, không đếm trên cấu hình.
 */
export const creativeFbActions = pgTable(
  "creative_fb_actions",
  {
    id: id(),
    /** Ngày CHẠY của lô mà lượt này phục vụ (`YYYY-MM-DD`) — trần theo ngày đếm trên cột này. */
    actionDay: text("action_day").notNull(),
    batchId: text("batch_id").references(() => creativeBatches.id),
    variantId: text("variant_id").references(() => creativeVariants.id),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    denial: text("denial").notNull().default(""),
    detail: text("detail").notNull().default(""),
    /** Id Facebook được tạo ra hoặc bị tác động. */
    targetId: text("target_id").notNull().default(""),
    /** Tiền được CAM KẾT bởi lượt này (tạo nhóm / tiêu thêm). `NULL` với lượt không chạm tiền. */
    amountVnd: integer("amount_vnd"),
    /** Các trường đã gửi, KHÔNG kèm token. */
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    mode: text("mode").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("creative_fb_actions_day_idx").on(t.actionDay, t.action, t.outcome),
    index("creative_fb_actions_variant_idx").on(t.variantId, t.createdAt),
    check(
      "creative_fb_actions_action_check",
      sql`${t.action} IN ('UPLOAD_IMAGE', 'CREATE_CREATIVE', 'CREATE_ADSET', 'CREATE_AD', 'PAUSE_ADSET', 'EXTEND_ADSET', 'CREATE_CAMPAIGN', 'ACTIVATE_CAMPAIGN', 'COPY_SCALE_CAMPAIGN', 'CREATE_SCALE_CREATIVE', 'SET_SCALE_AD_CREATIVE', 'SET_SCALE_BUDGET', 'ACTIVATE_SCALE', 'PAUSE_SCALE')`,
    ),
    check("creative_fb_actions_outcome_check", sql`${t.outcome} IN ('APPLIED', 'DENIED', 'FAILED')`),
    check("creative_fb_actions_denial_check", sql`${t.outcome} <> 'APPLIED' OR ${t.denial} = ''`),
    check("creative_fb_actions_day_format_check", sql`${t.actionDay} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ],
);

/**
 * SỔ PHÁN QUYẾT: ảnh chụp theo ngày của `judgeVariant()`. Phán quyết SỐNG luôn tính lại lúc đọc;
 * sổ trả lời "hôm ấy máy nghĩ gì và vì sao" — kể cả khi luật về sau đổi.
 */
export const creativeVerdicts = pgTable(
  "creative_verdicts",
  {
    id: id(),
    verdictDay: text("verdict_day").notNull(),
    variantId: text("variant_id")
      .notNull()
      .references(() => creativeVariants.id),
    verdict: text("verdict").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    ruleVersion: integer("rule_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("creative_verdicts_day_variant_uq").on(t.verdictDay, t.variantId),
    check("creative_verdicts_verdict_check", sql`${t.verdict} IN ('PENDING', 'RUNNING', 'AWAITING_ORDERS', 'KILL', 'PROMISING', 'WIN', 'LOSE', 'UNJUDGED')`),
  ],
);

/** SỔ HỌC: thống kê gen theo ngày + bản tin mô hình viết lại (tuỳ chọn, không bao giờ chặn vòng). */
export const creativeLearnings = pgTable(
  "creative_learnings",
  {
    id: id(),
    learningDay: text("learning_day").notNull(),
    geneStats: jsonb("gene_stats").$type<Record<string, unknown>[]>().notNull().default([]),
    observations: integer("observations").notNull().default(0),
    /** Số quan sát đứng trên căn cứ TƯƠNG ĐỐI (chưa có luật giữ) — phải in cạnh mọi tỷ lệ. */
    relativeObservations: integer("relative_observations").notNull().default(0),
    narrative: text("narrative").notNull().default(""),
    narrativeModel: text("narrative_model").notNull().default(""),
    ruleVersion: integer("rule_version").notNull(),
    genesVersion: integer("genes_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("creative_learnings_day_uq").on(t.learningDay)],
);

/**
 * THIẾT KẾ SẢN PHẨM MỚI (chủ shop 24/09/2026): một mẫu áo / váy CHƯA TỪNG CÓ, lai DNA của các mã bán tốt
 * (`lib/creative/design.ts::planDesigns`). Mã `TK-YYMMDD-NN` là mã chủ shop tạo trên Pancake để nhân viên
 * chốt đơn như hàng thường; đơn quy về thiết kế đi bằng `orders.ad_id` của các mẩu mang nó — bảng này
 * KHÔNG phải nguồn của đơn hay tiền.
 */
export const designConcepts = pgTable(
  "design_concepts",
  {
    id: id(),
    code: text("code").notNull(),
    batchId: text("batch_id").references(() => creativeBatches.id, { onDelete: "set null" }),
    /** DNA ĐỦ mười thuộc tính (`DesignDna`) theo từ vựng phiên bản `dna_version`. */
    dna: jsonb("dna").$type<Record<string, string>>().notNull(),
    dnaVersion: integer("dna_version").notNull(),
    /** Mã cha (trội nhất đứng đầu) — thứ duy nhất thiết kế "thừa kế". */
    parentProductIds: text("parent_product_ids").array().notNull().default(sql`'{}'::text[]`),
    why: text("why").notNull().default(""),
    /** Ảnh thiết kế đầu tiên máy vẽ được (ảnh của ô `DESIGN`). */
    imageId: text("image_id").references(() => creativeImages.id, { onDelete: "set null" }),
    status: text("status").notNull().default("DRAFT"),
    /** Giá đề nghị = giá của mã cha trội nhất. `NULL` = không suy được — câu chữ không ghi giá, không đoán. */
    priceVnd: integer("price_vnd"),
    /** Người đánh dấu "đưa vào sản xuất" (mục 34). Máy không bao giờ đặt trạng thái ấy. */
    productionByUserId: text("production_by_user_id").references(() => users.id, { onDelete: "set null" }),
    productionAt: ts("production_at"),
    /**
     * MOQ (§5h): lệnh sản xuất nối với thiết kế — nháp máy dựng khi đủ `DESIGN_MOQ.minOrders` đơn, hoặc lệnh
     * người đã lập sẵn cho đúng mã TK. Người xoá nháp ⇒ `NULL`, nhưng `moq_reached_at` vẫn giữ nên máy KHÔNG
     * dựng lại (xoá nháp là một quyết định).
     */
    productionOrderId: text("production_order_id").references(() => productionOrders.id, { onDelete: "set null" }),
    /** Mốc máy thấy đủ MOQ và dựng / nối lệnh — khoá lũy đẳng "một thiết kế một nháp". */
    moqReachedAt: ts("moq_reached_at"),
    /** Tin báo đủ MOQ đã gửi được (hoặc sổ chống lặp nói đã gửi). */
    moqNotifiedAt: ts("moq_notified_at"),
    /** Căn cứ lúc dựng (`DesignMoqSnapshot`): số đơn theo từng đường đếm, số lượng biết / chưa biết. */
    moqSnapshot: jsonb("moq_snapshot").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_concepts_code_uq").on(t.code),
    uniqueIndex("design_concepts_production_order_uq").on(t.productionOrderId).where(sql`${t.productionOrderId} IS NOT NULL`),
    index("design_concepts_status_idx").on(t.status, t.createdAt),
    check("design_concepts_status_check", sql`${t.status} IN ('DRAFT', 'TESTING', 'WIN', 'LOSE', 'PRODUCTION')`),
    check("design_concepts_code_check", sql`${t.code} ~ '^TK-[0-9]{6}-[0-9]{2,}$'`),
    check("design_concepts_price_check", sql`${t.priceVnd} IS NULL OR ${t.priceVnd} > 0`),
  ],
);

/**
 * DNA của sản phẩm ĐANG CÓ — đọc bằng mô hình đọc ảnh từ ảnh sản phẩm (`lib/creative/dna.ts`), kể cả mã
 * đã gỡ (lịch sử bán tốt vẫn là DNA quý). Một dòng mỗi mã; đọc lại khi đổi phiên bản từ vựng. Đọc hỏng
 * ⇒ `error` + `read_at`, thử lại sau `PRODUCT_DNA_RETRY_HOURS`.
 */
export const productDna = pgTable(
  "product_dna",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** DNA MỘT PHẦN — thuộc tính mô hình không đọc rõ là CHƯA BIẾT (vắng khoá), không phải một giá trị. */
    dna: jsonb("dna").$type<Record<string, string>>().notNull().default({}),
    dnaVersion: integer("dna_version").notNull(),
    /** Ảnh đã đọc: `PRODUCT_PHOTO` · `OWN_AD` · `PANCAKE_URL` (ảnh `products.image`). */
    imageSource: text("image_source").notNull().default(""),
    imageSha256: text("image_sha256").notNull().default(""),
    summary: text("summary").notNull().default(""),
    model: text("model").notNull().default(""),
    /** Rỗng = đọc được. Có chữ = lần đọc gần nhất hỏng (DNA cũ, nếu có, vẫn giữ). */
    error: text("error").notNull().default(""),
    readAt: ts("read_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("product_dna_product_uq").on(t.productId)],
);

/**
 * NHÁP SCALE MẪU THẮNG (`docs/creative-loop.md` §5f). Một dòng = một (mẫu thắng, loại chiến dịch):
 * đề nghị → nháp (bản sao chiến dịch MẪU, đang TẮT) → người duyệt ⇒ bật. Khoá duy nhất (mẫu, loại)
 * ⇒ không bao giờ có nháp thứ hai cho cùng một cặp. Không phải nguồn tiền: chi của chiến dịch scale
 * vẫn đọc từ `ad_spends` như mọi chiến dịch.
 */
export const creativeScaleDrafts = pgTable(
  "creative_scale_drafts",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references(() => creativeVariants.id),
    batchId: text("batch_id").references(() => creativeBatches.id),
    /** `PURCHASE_MESSAGING` · `LEADS` (`ScaleKind`). */
    kind: text("kind").notNull(),
    /** `ScaleDraftStatus`. */
    status: text("status").notNull().default("PROPOSED"),
    /** Phán quyết + số đo lúc máy đề nghị — để người đọc biết đề nghị đứng trên gì. */
    proposedVerdict: text("proposed_verdict").notNull().default(""),
    proposalMetrics: jsonb("proposal_metrics").$type<Record<string, unknown>>().notNull().default({}),
    /** Chiến dịch MẪU đã sao chép (chụp lúc sao chép — cấu hình có thể đổi về sau). */
    sourceCampaignId: text("source_campaign_id").notNull().default(""),
    fbCampaignId: text("fb_campaign_id"),
    fbAdsetId: text("fb_adset_id"),
    fbAdId: text("fb_ad_id"),
    fbCreativeId: text("fb_creative_id"),
    /** `CAMPAIGN` (CBO) · `ADSET` (ABO) — đọc từ chính bản sao. Rỗng = chưa đọc. */
    budgetLevel: text("budget_level").notNull().default(""),
    dailyBudgetVnd: integer("daily_budget_vnd"),
    currency: text("currency").notNull().default("VND"),
    error: text("error").notNull().default(""),
    /** Ghi NGAY TRƯỚC lời gọi sao chép: có mốc này mà không có id bản sao ⇒ có thể đã có bản sao mồ côi. */
    copyAttemptedAt: ts("copy_attempted_at"),
    /** QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (mục 34); tên là ảnh chụp do máy chủ đọc. */
    draftedByUserId: text("drafted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    draftedByName: text("drafted_by_name").notNull().default(""),
    draftedAt: ts("drafted_at"),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedByName: text("approved_by_name").notNull().default(""),
    approvedAt: ts("approved_at"),
    pausedAt: ts("paused_at"),
    dismissedByUserId: text("dismissed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    dismissedAt: ts("dismissed_at"),
    /** Tin báo "có đề nghị scale mới" đã gửi được lúc nào. */
    notifiedAt: ts("notified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("creative_scale_drafts_variant_kind_uq").on(t.variantId, t.kind),
    index("creative_scale_drafts_status_idx").on(t.status),
    check("creative_scale_drafts_kind_check", sql`${t.kind} IN ('PURCHASE_MESSAGING', 'LEADS')`),
    check("creative_scale_drafts_status_check", sql`${t.status} IN ('PROPOSED', 'DRAFTING', 'DRAFT', 'ACTIVE', 'PAUSED', 'FAILED', 'DISMISSED')`),
    // Trần cứng 500.000đ/ngày một chiến dịch (chủ shop 24/09/2026) — nhắc lại ở CSDL.
    check("creative_scale_drafts_budget_check", sql`${t.dailyBudgetVnd} IS NULL OR (${t.dailyBudgetVnd} > 0 AND ${t.dailyBudgetVnd} <= 500000)`),
    // "Đang chạy" phải có bản sao và dấu duyệt của người — không có chứng từ thì không phải đang chạy.
    check("creative_scale_drafts_active_check", sql`${t.status} NOT IN ('ACTIVE', 'PAUSED') OR (${t.fbCampaignId} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`),
    check("creative_scale_drafts_draft_check", sql`${t.status} <> 'DRAFT' OR (${t.fbCampaignId} IS NOT NULL AND ${t.fbAdId} IS NOT NULL AND ${t.fbCreativeId} IS NOT NULL AND ${t.dailyBudgetVnd} IS NOT NULL)`),
  ],
);

/**
 * GEN ẢNH BẰNG TAY (chủ shop 25/09/2026, `docs/creative-loop.md` §5i): một LƯỢT = một cú bấm "Gen ảnh" —
 * người chọn ảnh sản phẩm thật (+ tuỳ chọn quảng cáo cũ của shop cùng mã) và ý tưởng tự do; máy vẽ
 * `MANUAL_GEN.imagesPerRun` ảnh vào khu "Kết quả gen tay" (KHÔNG vào lô). Ảnh được người duyệt mới được
 * soạn câu chữ + tên và đưa vào lô chờ duyệt đăng. Chi phí vẽ tính vào CÙNG trần ảnh / ngày với lô.
 */
export const creativeManualGens = pgTable(
  "creative_manual_gens",
  {
    id: id(),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Ảnh sản phẩm THẬT làm gốc — bắt buộc (ranh giới 3). */
    productPhotoSourceId: text("product_photo_source_id").references(() => creativeSources.id, { onDelete: "set null" }),
    /** Quảng cáo cũ của shop (`OWN_AD`, cùng mã) làm tham chiếu bố cục — tuỳ chọn. */
    ownAdSourceId: text("own_ad_source_id").references(() => creativeSources.id, { onDelete: "set null" }),
    idea: text("idea").notNull().default(""),
    requested: integer("requested").notNull(),
    model: text("model").notNull(),
    size: text("size").notNull(),
    quality: text("quality").notNull(),
    /** Vì sao một phần không được vẽ ngay lúc bấm (chạm trần). Rỗng = xin đủ. */
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("creative_manual_gens_created_idx").on(t.createdAt)],
);

/** Một ẢNH của lượt gen tay: câu lệnh · gen · ảnh · duyệt / loại · câu chữ + tên · mẫu đã vào lô. */
export const creativeManualGenImages = pgTable(
  "creative_manual_gen_images",
  {
    id: id(),
    genId: text("gen_id")
      .notNull()
      .references(() => creativeManualGens.id),
    seq: integer("seq").notNull(),
    /** Bộ gen ĐỦ sáu khoá — máy học được từ bài này như mọi mẫu. */
    genes: jsonb("genes").$type<Record<string, string>>().notNull(),
    prompt: text("prompt").notNull().default(""),
    /** `ManualGenImageStatus`. */
    status: text("status").notNull().default("PLANNED"),
    imageId: text("image_id").references(() => creativeImages.id, { onDelete: "set null" }),
    /** USD dạng chuỗi; `""` = CHƯA BIẾT (cùng quy ước `creative_variants.gen_cost_usd`). */
    costUsd: text("cost_usd").notNull().default(""),
    error: text("error").notNull().default(""),
    claimedAt: ts("claimed_at"),
    drawnAt: ts("drawn_at"),
    headline: text("headline").notNull().default(""),
    primaryText: text("primary_text").notNull().default(""),
    captionModel: text("caption_model").notNull().default(""),
    captionError: text("caption_error").notNull().default(""),
    /** QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (mục 34); tên là ảnh chụp do máy chủ đọc. */
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedByName: text("reviewed_by_name").notNull().default(""),
    reviewedAt: ts("reviewed_at"),
    rejectReason: text("reject_reason").notNull().default(""),
    /** Mẫu (ô của lô) mà ảnh đã được đưa vào. */
    variantId: text("variant_id").references(() => creativeVariants.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("creative_manual_gen_images_gen_seq_uq").on(t.genId, t.seq),
    index("creative_manual_gen_images_status_idx").on(t.status),
    index("creative_manual_gen_images_image_idx").on(t.imageId),
    check("creative_manual_gen_images_status_check", sql`${t.status} IN ('PLANNED', 'DRAWING', 'GENERATED', 'GEN_FAILED', 'APPROVED', 'REJECTED', 'PROMOTED')`),
    // "Có ảnh" mà không có điểm ảnh là một khẳng định không có chứng từ.
    check("creative_manual_gen_images_image_check", sql`${t.status} NOT IN ('GENERATED', 'APPROVED', 'PROMOTED') OR ${t.imageId} IS NOT NULL`),
    check("creative_manual_gen_images_promoted_check", sql`${t.status} <> 'PROMOTED' OR ${t.variantId} IS NOT NULL`),
  ],
);

// ───────────────────── Quy kết fanpage → marketer ─────────────────────
//
// Hợp đồng, lý lẽ và mọi ngưỡng: `lib/constants/fanpage-attribution.ts`. Ba bảng, ba việc rời nhau:
// SỔ FANPAGE (page nào tồn tại) · SỔ PHÂN CÔNG (ai phụ trách, TỪ KHI NÀO ĐẾN KHI NÀO) · ẢNH CHỤP
// QUY KẾT (đơn nào đã được tính cho ai, bằng dòng phân công nào).

/**
 * SỔ FANPAGE — một dòng cho mỗi Page Facebook từng tạo ra đơn.
 *
 * Khoá tự nhiên là `external_page_id` (Facebook Page ID), KHÔNG phải tên: tên page đổi được bất cứ
 * lúc nào và shop này đã đổi. `name` chỉ là ảnh chụp tên để người đọc nhận ra, không tham gia vào
 * bất kỳ phép so khớp nào.
 *
 * Dòng được MÁY phát hiện từ `orders.page_id` (job `fanpage-attribution`), không ai phải gõ tay.
 */
export const fanpages = pgTable(
  "fanpages",
  {
    id: id(),
    /** Facebook Page ID — khoá tự nhiên, bất biến. */
    externalPageId: text("external_page_id").notNull(),
    /** Tên page tại lần đồng bộ gần nhất. Rỗng = chưa đọc được tên từ Pancake (chỉ có ID). */
    name: text("name").notNull().default(""),
    /**
     * TÊN DO NGƯỜI ĐẶT — tách hẳn khỏi `name` của API, và KHÔNG bao giờ bị đồng bộ ghi đè.
     *
     * Vì sao phải tách: page shop không còn quyền đọc thì API không trả tên, nên màn hình chỉ còn
     * một dãy 15 chữ số mà không ai nhận ra. Chủ shop gõ tên mình nhớ vào đây. Ngày nào lấy lại
     * được quyền, `name` của API cập nhật trở lại mà KHÔNG xoá mất tên người đã đặt — hai trường,
     * hai nguồn, không trường nào đè trường nào.
     */
    alias: text("alias").notNull().default(""),
    /**
     * LẦN GẦN NHẤT PANCAKE CÒN LIỆT KÊ PAGE NÀY.
     *
     * `NULL` = chưa bao giờ thấy trong danh sách API (page lịch sử, hoặc API chưa từng gọi được).
     * So mốc này với mốc LỚN NHẤT của cả bảng là biết page có nằm trong lần liệt kê gần nhất hay
     * không — không cần thêm một bảng trạng thái nào, và không bao giờ khẳng định "mất quyền" chỉ
     * vì một lần API lỗi (lúc đó KHÔNG page nào được cập nhật, nên mốc lớn nhất cũng không đổi).
     */
    lastSeenInApiAt: ts("last_seen_in_api_at"),
    platform: text("platform").notNull().default("facebook"),
    /**
     * `false` = page không còn dùng. KHÔNG ảnh hưởng tới đơn cũ: quy kết đã chụp vẫn giữ nguyên,
     * vì tắt một page không làm doanh thu tháng trước biến mất.
     */
    active: boolean("active").notNull().default(true),
    /** Đơn sớm nhất / muộn nhất từng thấy trên page — để người khai biết nên đặt mốc hiệu lực từ đâu. */
    firstOrderAt: ts("first_order_at"),
    lastOrderAt: ts("last_order_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("fanpages_external_uq").on(t.externalPageId), index("fanpages_active_idx").on(t.active)],
);

/**
 * SỔ PHÂN CÔNG — ai phụ trách fanpage nào, TRONG KHOẢNG NÀO.
 *
 * `marketer_id` là id nhân sự trong `settings["payroll.employees"]` — CÙNG không gian khoá với
 * `ad_spends.marketer_id` và `marketing_ideas.marketer_id`. Dựng một không gian khoá thứ hai ở đây
 * sẽ làm báo cáo quảng cáo và báo cáo fanpage nói về hai tập "marketer" khác nhau mà nhìn thì
 * giống hệt. Người bấm nút thì lưu bằng `users.id` (`created_by_user_id`) — đó là quy kết THAO TÁC,
 * khác hẳn quy kết NGHIỆP VỤ (AGENTS.md mục 34).
 *
 * `effective_to = NULL` nghĩa là CÒN HIỆU LỰC, không phải "hết hạn ngay". Khoảng là nửa mở
 * `[from, to)`: người cũ kết thúc đúng lúc người mới bắt đầu thì không có giây nào thuộc về cả hai.
 */
export const fanpageMarketerAssignments = pgTable(
  "fanpage_marketer_assignments",
  {
    id: id(),
    fanpageId: text("fanpage_id")
      .notNull()
      .references(() => fanpages.id, { onDelete: "cascade" }),
    /** Id nhân sự (sổ lương). Không đặt khoá ngoại vì sổ nhân sự nằm trong `settings`, không phải bảng. */
    marketerId: text("marketer_id").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    /** `NULL` = còn hiệu lực. */
    effectiveTo: ts("effective_to"),
    /** `false` = dòng khai SAI, bị thu hồi. Không tham gia quy kết; không xoá để còn truy được. */
    active: boolean("active").notNull().default(true),
    note: text("note").notNull().default(""),
    /** Người BẤM NÚT (tài khoản ERP), đọc từ phiên đăng nhập ở máy chủ — không nhận từ client. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("fanpage_assign_page_idx").on(t.fanpageId, t.effectiveFrom),
    index("fanpage_assign_marketer_idx").on(t.marketerId),
    // Khoảng phải có chiều xuôi. `to <= from` không mô tả khoảng nào cả nhưng vẫn lọt qua mọi phép
    // đọc, và âm thầm làm đơn trong khoảng đó mất người phụ trách.
    check("fanpage_assign_period_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    check("fanpage_assign_marketer_check", sql`${t.marketerId} <> ''`),
    // Một fanpage chỉ có MỘT dòng đang mở tại một thời điểm. Chồng lấn có mốc kết thúc được chặn
    // trong `lib/attribution/fanpage.ts`; chồng lấn ở khoảng MỞ thì chặn ngay ở CSDL, vì đó là ca
    // duy nhất mà hai lượt ghi chạy song song có thể cùng lọt qua phép kiểm ở tầng ứng dụng.
    uniqueIndex("fanpage_assign_open_uq").on(t.fanpageId).where(sql`effective_to is null and active`),
  ],
);

/**
 * ẢNH CHỤP QUY KẾT — mỗi đơn ĐÚNG MỘT dòng.
 *
 * Vì sao là bảng riêng chứ không phải cột trên `orders`: `orders` là bảng ĐỒNG BỘ từ Pancake, mỗi
 * lượt `pancake-reconcile` ghi đè cả dòng. Kết quả TÍNH RA không được nằm chung chỗ với dữ liệu
 * CHÉP VỀ. Cùng lý do và cùng hình dạng với `canonical_order_outcome`.
 *
 * Khoá duy nhất trên `order_id` là thứ làm phép đối soát IDEMPOTENT: chạy lại bao nhiêu lần cũng
 * chỉ có một dòng, nên không có đường nào để doanh thu bị cộng hai lần.
 */
export const orderAttributions = pgTable(
  "order_attributions",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Page của đơn tại lúc quy kết — chép từ `orders.page_id`, KHÔNG diễn giải. `NULL` = đơn không có page. */
    sourcePageId: text("source_page_id"),
    fanpageId: text("fanpage_id").references(() => fanpages.id, { onDelete: "set null" }),
    /** `NULL` = CHƯA QUY KẾT ĐƯỢC (chưa gán, không có page, hoặc trùng đơn) — không phải "không ai". */
    marketerId: text("marketer_id"),
    /** CHÍNH dòng phân công đã dùng. Giữ lại để truy nguyên: vì sao đơn này về tay người này. */
    assignmentId: text("assignment_id").references(() => fanpageMarketerAssignments.id, { onDelete: "set null" }),
    /** Một trong `ATTRIBUTION_STATUSES`. */
    status: text("status").notNull(),
    /** MỐC ĐƠN PHÁT SINH TẠI NGUỒN đã dùng để chọn dòng phân công (`orders.inserted_at`). */
    sourceOrderAt: ts("source_order_at").notNull(),
    /** Khoá gộp trùng đơn. `NULL` = không đủ căn cứ để xét trùng ⇒ đơn KHÔNG bao giờ bị loại vì trùng. */
    dedupeKey: text("dedupe_key"),
    /** Đơn thắng quy kết khi dòng này là bản nhập lại. `NULL` với mọi tình trạng khác. */
    duplicateOfOrderId: text("duplicate_of_order_id").references(() => orders.id, { onDelete: "set null" }),
    /**
     * ĐIỂM CHỨNG CỨ và CÁC DẤU HIỆU đã dùng để kết luận trùng đơn (`DUPLICATE_SIGNALS`).
     *
     * Một kết luận "trùng đơn" đang lấy doanh thu khỏi tên một người thật. Không lưu lại căn cứ thì
     * sáu tháng sau không ai kiểm chứng được, và người bị mất đơn không có gì để cãi. `NULL` với
     * mọi tình trạng khác — chỉ dòng `DUPLICATE` mới có căn cứ để ghi.
     */
    duplicateScore: integer("duplicate_score"),
    duplicateReason: text("duplicate_reason"),
    /** Phiên bản luật đã dùng. Luật đổi ⇒ dòng cũ thành cũ và TÌM RA ĐƯỢC. */
    ruleVersion: integer("rule_version").notNull().default(1),
    /**
     * ĐƯỜNG NÀO ĐÃ KẾT LUẬN ĐƠN NÀY: `PANCAKE_PAGE` (page_id của Pancake — đường Messenger, không
     * đổi) hay `LANDING_UTM` (tracking quảng cáo của form landing). Hai đường trả lời cùng một câu
     * hỏi bằng hai loại chứng cứ khác nhau, nên độ tin cậy của chúng phải đọc được ngay trên dòng.
     */
    attributionSource: text("attribution_source").notNull().default("PANCAKE_PAGE"),
    /**
     * FANPAGE SUY RA TỪ QUẢNG CÁO — KHÁC HẲN `sourcePageId`.
     *
     * `sourcePageId` chép thẳng `orders.page_id` của Pancake và KHÔNG được phép giả mạo. Ô này là
     * kết luận của ERP ("mẩu quảng cáo mang đơn này chạy trên page X"), nên nó đứng riêng: đọc
     * nhầm cái này thành cái kia là biến một suy luận thành một chứng từ.
     */
    attributedPageId: text("attributed_page_id"),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_attribution_order_uq").on(t.orderId),
    check("order_attribution_source_check", sql`${t.attributionSource} IN ('PANCAKE_PAGE', 'LANDING_UTM')`),
    check("order_attribution_inferred_page_check", sql`${t.attributedPageId} IS NULL OR ${t.attributionSource} = 'LANDING_UTM'`),
    index("order_attribution_source_idx").on(t.attributionSource),
    index("order_attribution_marketer_idx").on(t.marketerId),
    check("order_attribution_status_check", sql`${t.status} IN ('ATTRIBUTED', 'NO_PAGE', 'NO_ASSIGNMENT', 'DUPLICATE')`),
    /*
      CHỈ MỘT TÌNH TRẠNG ĐƯỢC MANG TÊN MỘT NGƯỜI, và tình trạng ấy BẮT BUỘC phải có tên. Không có
      ràng buộc này thì một lỗi lập trình ghi được `marketer_id` lên một dòng `DUPLICATE` và doanh
      thu bị đếm hai lần, trong khi báo cáo trông vẫn hoàn toàn bình thường.
    */
    check("order_attribution_marketer_check", sql`(${t.status} = 'ATTRIBUTED') = (${t.marketerId} IS NOT NULL)`),
    check("order_attribution_duplicate_check", sql`(${t.status} = 'DUPLICATE') = (${t.duplicateOfOrderId} IS NOT NULL)`),
    check("order_attribution_self_check", sql`${t.duplicateOfOrderId} IS NULL OR ${t.duplicateOfOrderId} <> ${t.orderId}`),
    // Căn cứ đi CÙNG kết luận: dòng trùng đơn phải có điểm, dòng không trùng thì không được có.
    check("order_attribution_evidence_check", sql`(${t.status} = 'DUPLICATE') = (${t.duplicateScore} IS NOT NULL)`),
    index("order_attribution_page_idx").on(t.sourcePageId),
    index("order_attribution_status_idx").on(t.status),
    index("order_attribution_dedupe_idx").on(t.dedupeKey),
    index("order_attribution_version_idx").on(t.ruleVersion),
  ],
);

/**
 * ẢNH CHỤP QUY KẾT ĐƠN LANDING — BẰNG CHỨNG, KHÔNG PHẢI KẾT LUẬN RỖNG.
 *
 * `order_attributions` giữ KẾT LUẬN (ai được tính đơn này). Bảng này giữ CĂN CỨ của riêng đường
 * landing: ô tracking đã đọc, mẩu quảng cáo / nhóm / chiến dịch / tài khoản quảng cáo đã tra ra,
 * và câu giải thích đọc được. Tách hai bảng vì hai vòng đời khác nhau — kết luận phải có cho MỌI
 * đơn, còn căn cứ landing chỉ tồn tại với đơn sinh ra từ form landing.
 *
 * Một đơn MỘT dòng (`landing_attribution_order_uq`): chạy lại đối soát bao nhiêu lần cũng không có
 * đường nào cộng doanh thu hai lần.
 */
export const landingAttributions = pgTable(
  "landing_attributions",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Dòng landing đã sinh ra đơn này. `NULL` = dòng landing đã bị gỡ, kết luận vẫn còn tra được. */
    landingOrderId: text("landing_order_id").references(() => landingOrders.id, { onDelete: "set null" }),
    /** Bậc bằng chứng đã dùng (`LANDING_EVIDENCE_TIERS`). `NULL` = chưa kết luận được. */
    tier: text("tier"),
    /** Vì sao chưa quy kết được (`LANDING_GAP_REASONS`). `NULL` = đã quy kết. */
    gap: text("gap"),
    /** Id nhân sự (sổ lương) — CÙNG không gian khoá với `ad_spends.marketer_id`. */
    marketerId: text("marketer_id"),
    /** Tài khoản quảng cáo (TKQC) đã chạy mẩu này, đọc tại MỐC ĐƠN, không lấy chủ sở hữu hôm nay. */
    adAccountId: text("ad_account_id"),
    campaignId: text("campaign_id"),
    adsetId: text("adset_id"),
    adId: text("ad_id"),
    /** Fanpage suy ra từ `fb_ads.story_id`. `NULL` là câu trả lời hợp lệ, không phải thiếu sót. */
    pageId: text("page_id"),
    /** Ảnh chụp nguyên văn các ô tracking đã đọc từ dòng landing. */
    utm: jsonb("utm"),
    landingUrl: text("landing_url"),
    /** Mã hàng mà TÊN CHIẾN DỊCH nói tới — chỉ để đối chiếu, không bao giờ ghi đè mã hàng của đơn. */
    campaignProductCode: text("campaign_product_code"),
    /** Chiến dịch nói một mã, đơn lại là mã khác. Đánh dấu để rà; KHÔNG sửa đơn. */
    productMismatch: boolean("product_mismatch").notNull().default(false),
    evidence: text("evidence").notNull().default(""),
    ruleVersion: integer("rule_version").notNull().default(1),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("landing_attribution_order_uq").on(t.orderId),
    index("landing_attribution_marketer_idx").on(t.marketerId),
    index("landing_attribution_campaign_idx").on(t.campaignId),
    index("landing_attribution_tier_idx").on(t.tier),
    /*
      HAI DANH SÁCH NÀY PHẢI ĐI CÙNG `LANDING_EVIDENCE_TIERS` / `LANDING_GAP_REASONS`.

      Bản 0091 chốt cứng danh sách cũ; bản sau mở rộng danh sách ở MÃ NGUỒN mà quên nới ràng buộc,
      và lượt đối soát hỏng ngay ở dòng đầu tiên mang lý do mới (sự cố 15/09/2026, migration 0093).
      `tests/landing-attribution.test.ts` nay ghi thử TỪNG giá trị xuống CSDL để hai nơi không lệch
      được nữa mà vẫn xanh.
    */
    check("landing_attribution_tier_check", sql`${t.tier} IS NULL OR ${t.tier} IN ('AD_ID', 'ADSET_ID', 'CAMPAIGN_ID', 'CAMPAIGN_NAME')`),
    check(
      "landing_attribution_gap_check",
      sql`${t.gap} IS NULL OR ${t.gap} IN ('NO_TRACKING', 'NO_AD_SOURCE', 'META_ADSET_NOT_SYNCED', 'META_AD_NOT_SYNCED', 'CAMPAIGN_NOT_SYNCED', 'AD_ACCOUNT_UNRESOLVED', 'HISTORICAL_OWNER_UNKNOWN', 'AMBIGUOUS_MARKETER', 'NO_MARKETER_DECLARED', 'NO_MATCH')`,
    ),
    /*
      KẾT LUẬN ĐI CÙNG CĂN CỨ. Có người ⇒ phải có bậc bằng chứng VÀ câu giải thích; chưa có người
      ⇒ phải nói được vì sao. Không dòng nào được vừa trống người vừa trống lý do — đó đúng là
      dòng mà sáu tháng sau không ai kiểm chứng nổi.
    */
    check(
      "landing_attribution_evidence_check",
      sql`(${t.marketerId} IS NOT NULL AND ${t.tier} IS NOT NULL AND ${t.evidence} <> '' AND ${t.gap} IS NULL) OR (${t.marketerId} IS NULL AND ${t.gap} IS NOT NULL)`,
    ),
  ],
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
export const fanpagesRelations = relations(fanpages, ({ many }) => ({ assignments: many(fanpageMarketerAssignments) }));
export const fanpageMarketerAssignmentsRelations = relations(fanpageMarketerAssignments, ({ one }) => ({
  fanpage: one(fanpages, { fields: [fanpageMarketerAssignments.fanpageId], references: [fanpages.id] }),
}));
export const orderAttributionsRelations = relations(orderAttributions, ({ one }) => ({
  order: one(orders, { fields: [orderAttributions.orderId], references: [orders.id] }),
  fanpage: one(fanpages, { fields: [orderAttributions.fanpageId], references: [fanpages.id] }),
  assignment: one(fanpageMarketerAssignments, { fields: [orderAttributions.assignmentId], references: [fanpageMarketerAssignments.id] }),
}));
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
export const stockReceiptsRelations = relations(stockReceipts, ({ many, one }) => ({
  items: many(stockReceiptItems),
  // Company OS · Agent D (0133): phiếu nhập nối về lệnh sản xuất / lô xưởng — NULL = chưa khai.
  productionOrder: one(productionOrders, { fields: [stockReceipts.productionOrderId], references: [productionOrders.id] }),
  productionBatch: one(productionBatches, { fields: [stockReceipts.productionBatchId], references: [productionBatches.id] }),
}));
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
  /*
    KHÔNG CÓ `shipment: one(...)` Ở ĐÂY, VÀ ĐÓ LÀ CÓ CHỦ Ý.

    `shipments.order_id` KHÔNG duy nhất: một đơn gửi lại có nhiều dòng (`attempt_no` 2, 3…) và
    chiều hoàn là dòng riêng (AGENTS.md mục 3.7). Khai `one(...)` lên một khoá ngoại như vậy thì
    Drizzle trả về MỘT dòng bất kỳ — không `ORDER BY`, không lời hứa nào — và mọi nơi gọi đều tin
    rằng đó là "vận đơn của đơn".

    Nó đã tốn 23 đơn không đồng bộ được mỗi mười lăm phút (đo 21/09/2026, xem
    `lib/constants/shipment-pick.ts`). Nên quan hệ ấy bị GỠ HẲN thay vì được chú thích là nguy
    hiểm: dùng `attempts` rồi chọn bằng `chonVanDonDeGhep()`, một cái bẫy đã gỡ thì không ai rơi
    vào lần thứ hai. `tests/schema-relations.test.ts` chặn mọi `one(...)` trỏ vào cột không phải
    khoá chính, để cái bẫy này không mọc lại ở bảng khác.
  */
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
export type VtpStatusRegistryRow = typeof vtpStatusRegistry.$inferSelect;
export type VtpImportBatch = typeof vtpImportBatches.$inferSelect;
export type VtpWebhookGap = typeof vtpWebhookGaps.$inferSelect;
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

/**
 * ═══════════ KẾT QUẢ XỬ LÝ CASE CỦA NGƯỜI — KHÔNG PHẢI MỘT LỆNH GỬI ĐVVC ═══════════
 *
 * ─── VÌ SAO BẢNG NÀY PHẢI ĐỨNG RIÊNG (chủ shop chốt 19/09/2026) ───
 *
 * `care_business_actions` (bảng ngay trên) ghi BỐN quyết định GẮN LIỀN với một lệnh gửi Viettel
 * Post: nó có `carrier_command_id`, có `carrier_result`, và đường ghi của nó từ chối hành động khi
 * ĐVVC không nhận lệnh (kiện đã kết thúc · chưa có mã VTP · ERP chưa khai tài khoản API).
 *
 * Nhưng ba lựa chọn mà người trực vận đơn dùng cả ngày — **Đã hoàn · Phát tiếp · Xử lý sau** — là
 * KẾT QUẢ CÔNG VIỆC CHĂM SÓC của họ, không phải một lệnh gửi đi đâu cả. Chúng phải ghi được
 * **LUÔN LUÔN**:
 *
 *   · ERP chưa khai `VIETTELPOST_API_KEY` ⇒ vẫn ghi được;
 *   · API Viettel Post đang lỗi ⇒ vẫn ghi được;
 *   · kiện chưa có mã vận đơn ⇒ vẫn ghi được;
 *   · kiện đã giao / đã hoàn / đã huỷ ⇒ vẫn ghi được (người trực còn phải đóng case);
 *   · kiện đi hãng khác ⇒ vẫn ghi được.
 *
 * Dùng chung một bảng cho hai thứ đó nghĩa là năng lực API của ERP quyết định xem NHÂN VIÊN có ghi
 * nhận được việc mình vừa làm hay không — một lỗi đường ống chặn mất một phép đo về con người.
 *
 * ─── BA CHIỀU, KHÔNG CHIỀU NÀO SUY RA CHIỀU NÀO ───
 *
 *   `shipments.stage` / `carrierSubstate`  — GÓI HÀNG ở đâu. Chỉ ĐVVC đổi được.
 *   `shipment_care.care_status`            — ĐỘI đang ở đâu với việc của mình.
 *   bảng này                               — ĐỘI đã QUYẾT gì.
 *
 * `decision = 'CARE_RETURN'` KHÔNG có nghĩa hàng đã về shop: nó là "shop thôi không cứu kiện này
 * nữa". Tên `CARE_*` cố ý mang tiền tố để không lập trình viên nào đọc nhầm thành trạng thái ĐVVC
 * — bài học từ chính `APPROVE_RETURN` / `REQUEST_REDELIVERY`, hai cái tên nghe như lệnh gửi đi.
 *
 * Để chứng minh điều đó ĐỌC LẠI ĐƯỢC sau nhiều tháng, mỗi dòng chụp luôn trạng thái ĐVVC LÚC BẤM
 * (`carrier_stage_at_decision`, `carrier_substate_at_decision`): tra một dòng "Đã hoàn" ghi lúc
 * ĐVVC còn đang "Đang chuyển hoàn" thì thấy ngay hai chiều là hai chiều.
 *
 * CHỈ THÊM. Không lệnh `update` nào chạm vào dòng đã ghi; "kết quả hiện tại" là dòng MỚI NHẤT của
 * ĐÚNG đợt (`care_case_id`), đọc ra lúc xem.
 */
export const careDecisions = pgTable(
  "care_decisions",
  {
    id: id(),
    careCaseId: text("care_case_id")
      .notNull()
      .references(() => shipmentCare.id, { onDelete: "cascade" }),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    /** `CARE_RETURN` (Đã hoàn) · `CARE_CONTINUE_DELIVERY` (Phát tiếp) · `CARE_FOLLOW_UP` (Xử lý sau). */
    decision: text("decision").notNull(),
    /** Lý do theo DANH MỤC (đếm được) — tách khỏi `note` là ô chữ tự do (không đếm được). */
    reasonCode: text("reason_code"),
    note: text("note").notNull().default(""),
    /** Chỉ `CARE_FOLLOW_UP` bắt buộc có: một cái hẹn không có giờ không phải một cái hẹn. */
    followUpAt: ts("follow_up_at"),
    /** QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (luật 34). `NULL` = MÁY làm, khác hẳn "chưa biết ai". */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    /** ẢNH CHỤP người đang cầm ca lúc đó — A nhận ca rồi chuyển B thì việc A đã làm vẫn là của A. */
    ownerIdAtDecision: text("owner_id_at_decision").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    /** Kết quả TRƯỚC đó của cùng đợt — đọc được "đổi ý mấy lần" mà không phải tự nối dòng. */
    previousDecision: text("previous_decision"),
    previousCareStatus: text("previous_care_status"),
    nextCareStatus: text("next_care_status"),
    /** ẢNH CHỤP CHIỀU ĐVVC LÚC BẤM — bằng chứng đọc lại được rằng hai chiều không suy ra nhau. */
    carrierStageAtDecision: text("carrier_stage_at_decision").notNull().default(""),
    carrierSubstateAtDecision: text("carrier_substate_at_decision").notNull().default(""),
    decidedAt: ts("decided_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("care_decisions_case_idx").on(t.careCaseId, t.decidedAt),
    index("care_decisions_shipment_idx").on(t.shipmentId, t.decidedAt),
    index("care_decisions_actor_idx").on(t.actorUserId, t.decidedAt),
    check("care_decisions_kind_check", sql`${t.decision} IN ('CARE_RETURN', 'CARE_CONTINUE_DELIVERY', 'CARE_FOLLOW_UP')`),
    // "Xử lý sau" mà không có giờ thì ca chìm khỏi hàng đợi — CSDL chặn, không để mã nguồn tự canh.
    check("care_decisions_follow_up_check", sql`${t.decision} <> 'CARE_FOLLOW_UP' OR ${t.followUpAt} IS NOT NULL`),
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

/**
 * KẾT LUẬN NGỮ NGHĨA ĐÃ TRẢ TIỀN — một câu hỏi y hệt thì không hỏi model lần hai.
 *
 * Job `cs-chat` quét lại mọi hội thoại trong 48 giờ gần nhất mỗi 15 phút. Hội thoại không có tin
 * mới, chứng từ không đổi ⇒ câu hỏi gửi model giống hệt lượt trước, và câu trả lời cũng vậy. Khoá
 * là DẤU VÂN TAY của toàn bộ đầu vào (model · lời dặn · lược đồ · khách · thẻ · chứng từ · hội
 * thoại) — đổi bất kỳ vế nào thì khoá đổi và model được hỏi lại. Xem `lib/cs/semantic-cache.ts`.
 *
 * Bảng này KHÔNG phải nguồn sự thật của case nào: case vẫn ghi kết luận của nó ở `cs_cases`. Xoá
 * sạch bảng này chỉ tốn một lượt hỏi lại model, không mất dữ liệu nghiệp vụ nào.
 */
export const csSemanticVerdicts = pgTable(
  "cs_semantic_verdicts",
  {
    fingerprint: text("fingerprint").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    model: text("model").notNull(),
    /** `SemanticVerdict` đã qua `parseVerdict` — đọc lại vẫn phải qua `parseVerdict` lần nữa. */
    verdict: jsonb("verdict").notNull(),
    /** Số lượt quét đã dùng lại kết luận này thay vì gọi model. */
    hits: integer("hits").notNull().default(0),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
  },
  (t) => [index("cs_semantic_verdicts_last_used_idx").on(t.lastUsedAt), index("cs_semantic_verdicts_conversation_idx").on(t.conversationId)],
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
    /*
      NĂM TẦNG, và `PRODUCT` là một TRỤC RIÊNG chứ không phải tầng hẹp hơn `USER`: bốn giá trị kia
      nói về CON NGƯỜI, `PRODUCT` nói về MỘT MÃ HÀNG (`scope_ref` = `products.custom_id`). Danh
      sách ĐÓNG ở đây vì một chuỗi lạ buộc `resolveTarget` phải chọn giữa bỏ sót đích và áp nhầm.
    */
    check("metric_targets_scope_check", sql`${t.scope} IN ('COMPANY', 'DEPARTMENT', 'POSITION', 'USER', 'PRODUCT')`),
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

/**
 * ═══════════ KỲ LƯƠNG: NHÁP THÌ TÍNH SỐNG, ĐÃ CHỐT THÌ BẤT BIẾN ═══════════
 *
 * ─── VÌ SAO PHẢI CÓ BẢNG NÀY ───
 *
 * Trước bản này bảng lương KHÔNG có danh tính kỳ: mở `/payroll` là tính lại từ đầu, mỗi lần. Hệ
 * quả là mọi thứ nằm sau con số đều trôi — đổi một tỷ lệ thưởng, đổi người phụ trách một fanpage,
 * nhập thêm một phiếu kho, và bảng lương của THÁNG TRƯỚC đổi theo, sau khi tiền đã trả. Không có
 * chỗ nào ghi lại shop đã trả bao nhiêu, theo cơ sở nào, với tỷ lệ nào.
 *
 * Cùng hình dạng, cùng lý do và cùng bộ ràng buộc với `review_cycles` (AGENTS.md mục 21):
 * `DRAFT` tính sống mỗi lần mở · `FINAL` đọc `snapshot`, KHÔNG truy vấn lại.
 *
 * ─── ẢNH CHỤP PHẢI ĐỦ ĐỂ DỰNG LẠI CÂU TRẢ LỜI, KHÔNG CHỈ ĐỦ ĐỂ IN MỘT CON SỐ ───
 *
 * Nên `snapshot` giữ cả: cơ sở lợi nhuận đã dùng, tỷ lệ của từng người TẠI LÚC CHỐT, lương cứng
 * khai và phần thuộc kỳ, độ phủ nguồn quy kết, và nguyên văn cảnh báo của máy chi phí. Sáu tháng
 * sau có người hỏi "vì sao tháng ấy trả chừng này", câu trả lời phải nằm trong chính dòng đó.
 *
 * `calc_version` tách khỏi nội dung: đổi CÔNG THỨC thì ảnh cũ vẫn đọc được và biết nó được dựng
 * bằng công thức nào — không lặng lẽ so hai kỳ tính bằng hai luật khác nhau.
 */
export const payrollPeriods = pgTable(
  "payroll_periods",
  {
    id: id(),
    /** Khoá tự nhiên của kỳ, đọc được bằng mắt: `2026-09-01..2026-09-30`. */
    periodKey: text("period_key").notNull(),
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    /**
     * Cơ sở lợi nhuận đã dùng. CSDL chỉ chặn giá trị lạ; việc "cơ sở nào ĐƯỢC PHÉP chốt lương" do
     * `lib/constants/payroll.ts::PAYROLL_BASIS_ELIGIBILITY` quyết — khai luật ấy ở hai nơi là mở
     * đường cho hai nơi nói hai điều khác nhau.
     */
    basis: text("basis").notNull(),
    /**
     * VÒNG ĐỜI SÁU TRẠNG THÁI — `lib/constants/payroll-lifecycle.ts`.
     *
     * `DRAFT` · `CALCULATED` · `UNDER_REVIEW` · `APPROVED` · `LOCKED` · `PAID`.
     *
     * `FINAL` là giá trị CŨ còn nằm trên production, và nó Ở LẠI trong ràng buộc `CHECK`: viết đè
     * cột trạng thái của những kỳ ĐÃ TRẢ TIỀN để "cho sạch bảng" là đúng thứ AGENTS.md mục 21 cấm.
     * Nó được ĐỌC như `LOCKED` (`normalizePayrollStatus`) — không mất gì, không đụng một dòng nào.
     */
    status: text("status").notNull().default("DRAFT"),
    /** Người ĐÃ DUYỆT con số này. Tách khỏi `finalizedBy`: khai số và duyệt số là hai vai. */
    approvedAt: ts("approved_at"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    /** Người khoá kỳ (đóng băng ảnh chụp). */
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
    /** Mốc khẳng định tiền ĐÃ RA KHỎI TÀI KHOẢN. Khác hẳn "phải trả". */
    paidAt: ts("paid_at"),
    paidBy: text("paid_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Lý do của lần chuyển trạng thái gần nhất CẦN lý do (trả lại để sửa · mở khoá).
     * Rỗng khi lần chuyển gần nhất không đòi lý do — KHÔNG phải "chưa ai ghi".
     */
    statusReason: text("status_reason").notNull().default(""),
    /**
     * SỐ LẦN ĐÃ TÍNH LẠI. Một kỳ tính lại năm lần trước khi duyệt là một tín hiệu đáng đọc; không
     * đếm thì nó biến mất sau lượt cuối.
     */
    calcRuns: integer("calc_runs").notNull().default(0),
    /** Ảnh chụp toàn bộ số + căn cứ của kỳ. Bất biến sau khi `FINAL`. */
    snapshot: jsonb("snapshot"),
    /** Phiên bản phép tính lúc chụp (`PAYROLL_CALC_VERSION`). */
    calcVersion: integer("calc_version").notNull().default(1),
    note: text("note").notNull().default(""),
    finalizedAt: ts("finalized_at"),
    finalizedBy: text("finalized_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // MỘT kỳ + MỘT cơ sở = MỘT dòng. Hai bản chốt cùng kỳ bằng hai cơ sở là hai câu trả lời khác
    // nhau cho cùng một câu hỏi, và không ai biết cái nào đã dùng để trả tiền.
    uniqueIndex("payroll_periods_uq").on(t.periodKey, t.basis),
    index("payroll_periods_start_idx").on(t.periodStart),
    // `FINAL` ở lại vì production đang có nó — xem chú thích ở cột `status`.
    check("payroll_periods_status_check", sql`${t.status} IN ('DRAFT', 'CALCULATED', 'UNDER_REVIEW', 'APPROVED', 'LOCKED', 'PAID', 'FINAL')`),
    check("payroll_periods_basis_check", sql`${t.basis} IN ('profit1', 'profit2', 'cash', 'nominal')`),
    check("payroll_periods_range_check", sql`${t.periodEnd} >= ${t.periodStart}`),
    // Chốt mà không có ảnh chụp thì "chốt" không có nghĩa gì: lần mở sau vẫn tính lại.
    check("payroll_periods_final_check", sql`${t.status} = 'DRAFT' OR (${t.snapshot} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL)`),
    // Đã duyệt / khoá / trả thì phải biết AI và LÚC NÀO — một chữ ký không có tên là chữ ký trống.
    check("payroll_periods_approved_check", sql`${t.status} NOT IN ('APPROVED', 'LOCKED', 'PAID') OR ${t.approvedAt} IS NOT NULL`),
    check("payroll_periods_locked_check", sql`${t.status} NOT IN ('LOCKED', 'PAID') OR ${t.lockedAt} IS NOT NULL`),
    check("payroll_periods_paid_check", sql`${t.status} <> 'PAID' OR ${t.paidAt} IS NOT NULL`),
  ],
);

/**
 * ═══════════ SỔ LỖ LŨY KẾ THEO TỪNG MKTer ═══════════
 *
 * Chủ shop chốt 15/09/2026: lợi nhuận âm của một MKTer phải chuyển sang tháng sau, và tháng sau
 * bù hết phần âm ấy trước khi tính hoa hồng được trả. Muốn thế thì con số âm phải TỒN TẠI ở đâu
 * đó — bảng lương hôm nay tính `max(LN, 0) × %` nên nó không tồn tại ở bất cứ đâu.
 *
 * ─── VÌ SAO LÀ MỘT BẢNG CHỨ KHÔNG PHẢI TÍNH LẠI TỪ ĐẦU MỖI LẦN MỞ ───
 *
 * Tính lại được, nhưng chỉ khi mọi tháng trước đều còn tính ra đúng con số cũ. Mà chính đó là thứ
 * không giữ được: đổi một tỷ lệ, sửa một quy kết fanpage, nhập thêm một phiếu kho — số dư của
 * tháng đã TRẢ TIỀN đổi theo. Số dư mang sang là một NGHĨA VỤ đã phát sinh, không phải một phép
 * tính chạy lại được.
 *
 * ─── GRAIN: MỘT NGƯỜI, MỘT THÁNG LỊCH VIỆT NAM ───
 *
 * `month_key` dạng `YYYY-MM`. Cố ý KHÔNG theo kỳ lương tuỳ ý: xem 7 ngày hay một quý không được
 * tạo thêm số dư, vì số dư là chuỗi TUẦN TỰ theo tháng. Khoá duy nhất là (nhân sự, tháng) —
 * KHÔNG kèm `calc_version`: đổi phiên bản phép tính không được sinh thêm một dòng chính thức thứ
 * hai cho cùng một nghĩa vụ.
 *
 * `employee_id` là khoá nhân sự trong sổ lương (`settings: payroll.employees`), không phải
 * `users.id` — sổ lương là nơi khai % hoa hồng, và một MKTer có thể chưa có tài khoản ERP.
 * AGENTS.md mục 34 đòi khoá chứ không đòi ô chữ: đây là khoá ổn định, đổi tên không đụng tới nó.
 */
export const marketerProfitCarryover = pgTable(
  "marketer_profit_carryover",
  {
    id: id(),
    /** Khoá nhân sự trong sổ lương. Đổi tên / email / fanpage không được chuyển lỗ sang người khác. */
    employeeId: text("employee_id").notNull(),
    /** Tháng lịch Việt Nam, `YYYY-MM`. */
    monthKey: text("month_key").notNull(),
    /*
      KHOÁ THÀNH PHẦN BẬT BÙ LỖ.

      Trước bản chính sách lương chung, sổ này chỉ phục vụ ĐÚNG MỘT khoản: hoa hồng theo lợi nhuận
      cá nhân của MKTer — nên (nhân sự, tháng) là đủ. Nay một người có thể mang hai thành phần cùng
      bật bù lỗ (vd hoa hồng lợi nhuận cá nhân và chia lợi nhuận nhóm), và hai nghĩa vụ ấy là hai
      chuỗi số dư RIÊNG. Gộp chúng vào một dòng là bù lỗ của khoản này bằng lãi của khoản kia.

      Mặc định `MARKETING_PROFIT` để mọi dòng ĐÃ CÓ giữ nguyên ý nghĩa và mọi chuỗi số dư đang chạy
      không đứt — migration không backfill gì khác, không đoán gì (AGENTS.md mục 35).
    */
    componentCode: text("component_code").notNull().default("MARKETING_PROFIT"),
    /** Số dư lỗ ĐẦU tháng (≤ 0). */
    openingBalance: integer("opening_balance").notNull(),
    /**
     * Số dư đầu tháng LẤY TỪ ĐÂU: `PREV_MONTH` (tháng trước đã chốt) · `OPENING_DECLARATION`
     * (chủ shop khai số dư mở sổ, có nguồn). Không có giá trị nào nghĩa là "đoán".
     */
    openingSource: text("opening_source").notNull(),
    /** LN thực phát sinh của tháng, đã trừ đủ chi phí thuộc tháng. Âm/dương/0 đều hợp lệ. */
    realProfit: integer("real_profit").notNull(),
    /** Phần lỗ cũ được bù trong tháng (≥ 0). */
    lossApplied: integer("loss_applied").notNull().default(0),
    /** `max(LN thực + số dư đầu, 0)` — cơ sở tính hoa hồng được trả (≥ 0). */
    commissionBase: integer("commission_base").notNull(),
    /** Tỷ lệ hoa hồng cá nhân có hiệu lực lúc chốt, nhân 100 để giữ nguyên số nguyên (10% ⇒ 1000). */
    commissionRateBp: integer("commission_rate_bp").notNull(),
    /** `r × (LN thực + số dư đầu)`, GIỮ DẤU — chỉ để theo dõi, KHÔNG phải khoản phải trả. */
    signedCommission: integer("signed_commission").notNull(),
    /** Tiền hoa hồng phải trả (≥ 0). */
    payableCommission: integer("payable_commission").notNull(),
    /** Số dư lỗ CUỐI tháng, chuyển sang tháng sau (≤ 0). */
    closingBalance: integer("closing_balance").notNull(),
    /** `DRAFT` = mô phỏng, tính sống; `FINAL` = đã chốt, đọc `snapshot`. */
    status: text("status").notNull().default("DRAFT"),
    /** Ảnh chụp căn cứ đủ để dựng lại con số. Bất biến sau khi `FINAL`. */
    snapshot: jsonb("snapshot"),
    /** Phiên bản phép tính lúc chụp (`PAYROLL_CALC_VERSION`). */
    calcVersion: integer("calc_version").notNull().default(1),
    note: text("note").notNull().default(""),
    finalizedAt: ts("finalized_at"),
    finalizedBy: text("finalized_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // MỘT người + MỘT tháng = MỘT dòng. Mở trang, xuất CSV, chạy lại job hay hai yêu cầu chốt
    // đồng thời đều không được sinh dòng thứ hai cho cùng một nghĩa vụ.
    // MỘT người + MỘT tháng + MỘT thành phần = MỘT dòng.
    uniqueIndex("marketer_carryover_uq").on(t.employeeId, t.monthKey, t.componentCode),
    index("marketer_carryover_month_idx").on(t.monthKey),
    check("marketer_carryover_status_check", sql`${t.status} IN ('DRAFT', 'FINAL')`),
    check("marketer_carryover_month_format", sql`${t.monthKey} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("marketer_carryover_source_check", sql`${t.openingSource} IN ('PREV_MONTH', 'OPENING_DECLARATION')`),
    // Số dư là LỖ chưa bù, theo định nghĩa ≤ 0. Một số dương ở đây nghĩa là "lãi mang sang" — mà
    // lãi đã được trả hoa hồng ở tháng nó phát sinh, chuyển tiếp là trả hai lần.
    check("marketer_carryover_opening_check", sql`${t.openingBalance} <= 0`),
    check("marketer_carryover_closing_check", sql`${t.closingBalance} <= 0`),
    check("marketer_carryover_base_check", sql`${t.commissionBase} >= 0`),
    check("marketer_carryover_payable_check", sql`${t.payableCommission} >= 0`),
    check("marketer_carryover_applied_check", sql`${t.lossApplied} >= 0`),
    // Chốt mà không có ảnh chụp thì "chốt" không có nghĩa gì (cùng luật với `payroll_periods`).
    check(
      "marketer_carryover_final_check",
      sql`${t.status} = 'DRAFT' OR (${t.snapshot} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * ═══════════════ CHÍNH SÁCH LƯƠNG CHUNG CHO TOÀN CÔNG TY ═══════════════
 *
 * ─── VÌ SAO CÓ PHẦN NÀY ───
 *
 * Bảng lương cũ khai cơ chế trả tiền bằng đúng bốn ô trên hồ sơ nhân sự ở `settings`
 * (`payroll.employees`): lương cứng, % LN tổng, % LN cá nhân, % doanh thu. Bốn ô ấy sinh ra cho
 * MKTer. Một bạn kho ăn theo ngày công, một thợ may ăn theo sản phẩm, một bạn CSKH ăn lương cứng +
 * KPI — không ai khai được bằng bốn ô đó, nên cách duy nhất để đỡ họ là thêm `if` vào lõi. Mỗi
 * chức danh mới là một lần sửa lõi, và mỗi lần sửa lõi là một lần có thể làm sai tiền của người
 * khác.
 *
 * Nên cơ chế trả tiền chuyển thành DỮ LIỆU: chính sách → phiên bản → thành phần. Luật khai ở
 * `lib/constants/payroll-components.ts`; máy tính ở `lib/payroll/engine.ts`; mấy bảng dưới đây chỉ
 * giữ lời khai.
 *
 * ─── SỔ CŨ KHÔNG BỊ ĐỘNG ĐẾN ───
 *
 * `settings: payroll.employees` VẪN là nơi khai % hoa hồng của MKTer và vẫn chạy y như trước cho
 * người chưa gán chính sách. Không dòng dữ liệu nào bị chuyển, không con số nào của kỳ đã chốt bị
 * đụng vào (yêu cầu mục 31 · AGENTS.md mục 21). Chuyển sang máy mới là việc chủ shop bấm từng
 * người, không phải một lượt migration im lặng.
 */
export const salaryPolicies = pgTable(
  "salary_policies",
  {
    id: id(),
    /** Khoá đọc được: `MKT_PROFIT`, `SALES_COMMISSION`, `WAREHOUSE_HOURLY`… */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Phòng ban thường áp chính sách này (CHỈ để gợi ý khi xếp người — không sinh quyền, không tự gán). */
    departmentId: text("department_id").references((): AnyPgColumn => departments.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("salary_policies_active_idx").on(t.active, t.sortOrder)],
);

/**
 * PHIÊN BẢN CỦA MỘT CHÍNH SÁCH — ĐÂY LÀ THỨ LÀM "ĐỔI TỶ LỆ THÁNG NÀY" THÔI VIẾT LẠI THÁNG TRƯỚC.
 *
 * Sửa tỷ lệ hoa hồng từ 01/09 KHÔNG được sửa dòng đang có; nó phải tạo một phiên bản MỚI có
 * `effective_from = 2026-09-01`, và đóng phiên bản cũ lại ở 31/08. Kỳ tháng 8 mở lại sau đó vẫn
 * đọc bản cũ và vẫn ra đúng con số đã trả.
 *
 * Ba trạng thái, và sự khác nhau giữa chúng là chuyện tiền bạc:
 *   · `DRAFT`  — đang soạn. TUYỆT ĐỐI không dùng để tính tiền (máy tính bỏ qua).
 *   · `ACTIVE` — đang hiệu lực.
 *   · `RETIRED`— đã rút, nhưng VẪN phủ các kỳ nằm trong khoảng hiệu lực cũ của nó.
 */
export const salaryPolicyVersions = pgTable(
  "salary_policy_versions",
  {
    id: id(),
    policyId: text("policy_id")
      .notNull()
      .references(() => salaryPolicies.id, { onDelete: "cascade" }),
    /** Số thứ tự tăng dần trong phạm vi một chính sách. */
    version: integer("version").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    /** `NULL` = CÒN HIỆU LỰC (khác hẳn "chưa biết"). */
    effectiveTo: ts("effective_to"),
    status: text("status").notNull().default("DRAFT"),
    note: text("note").notNull().default(""),
    activatedAt: ts("activated_at"),
    activatedBy: text("activated_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("salary_policy_versions_uq").on(t.policyId, t.version),
    index("salary_policy_versions_eff_idx").on(t.policyId, t.effectiveFrom),
    check("salary_policy_versions_status_check", sql`${t.status} IN ('DRAFT', 'ACTIVE', 'RETIRED')`),
    check("salary_policy_versions_range_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/**
 * THÀNH PHẦN LƯƠNG — một dòng ở đây là một dòng trên phiếu lương.
 *
 * `calc` giữ tham số phép tính dưới dạng JSON, nhưng KHÔNG phải một ô tự do: hình dạng của nó là
 * `PayrollCalcParams` — một tập ĐÓNG, kiểm bằng zod ở server action. Cố ý không có `EXPRESSION`:
 * một ô gõ công thức rồi `eval` là cách nhanh nhất để một dòng chữ trong CSDL chạy mã tuỳ ý trên
 * máy chủ (xem `lib/constants/payroll-components.ts`).
 *
 * `basis_key` trỏ vào SỔ ĐĂNG KÝ ĐẦU VÀO (`PAYROLL_INPUTS`) — không phải một tên cột tuỳ ý. Đại
 * lượng nào ERP chưa đo được thì sổ khai `MANUAL` và người phải nhập; không có đường nào để một
 * truy vấn gần đúng lẻn vào làm "số đo" (AGENTS.md mục 20 · 37 · 45).
 */
export const salaryPolicyComponents = pgTable(
  "salary_policy_components",
  {
    id: id(),
    versionId: text("version_id")
      .notNull()
      .references(() => salaryPolicyVersions.id, { onDelete: "cascade" }),
    /** Khoá ổn định trong phạm vi một chính sách — phiếu lương và sổ lỗ lưu khoá này, không lưu tên. */
    code: text("code").notNull(),
    label: text("label").notNull(),
    /** `PAYROLL_COMPONENT_KINDS` — quyết định DẤU và chỗ đứng trên phiếu, không quyết định phép tính. */
    kind: text("kind").notNull(),
    /** `PAYROLL_CALC_TYPES`. */
    calcType: text("calc_type").notNull(),
    /** Đại lượng trong `PAYROLL_INPUTS`; `NULL` cho khoản cố định / nhập tay. */
    basisKey: text("basis_key"),
    /** Tham số của phép tính (`PayrollCalcParams`) — hình dạng do `calc_type` quyết định. */
    calc: jsonb("calc").notNull(),
    /** `PERIOD_DAYS` · `NONE`. */
    prorate: text("prorate").notNull().default("NONE"),
    /** `ROUND` · `FLOOR` · `CEIL` · `ROUND_1000`. */
    rounding: text("rounding").notNull().default("ROUND"),
    minAmount: integer("min_amount"),
    maxAmount: integer("max_amount"),
    /** Bù lỗ lũy kế. CHỈ bật cho thành phần tính trên lợi nhuận — KHÔNG mặc định cho mọi chức danh. */
    carryForward: boolean("carry_forward").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(100),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // MỘT khoá thành phần trong MỘT phiên bản. Hai dòng cùng `code` là hai khoản cùng tên trên một
    // phiếu lương, và phần gộp theo `code` ở máy tính sẽ cộng chúng thành một dòng không ai đối
    // chiếu lại được.
    uniqueIndex("salary_policy_components_uq").on(t.versionId, t.code),
    index("salary_policy_components_version_idx").on(t.versionId, t.sortOrder),
    check("salary_policy_components_carry_check", sql`${t.carryForward} = false OR ${t.basisKey} IN ('PROFIT_PERSONAL', 'PROFIT_SHOP')`),
    check("salary_policy_components_bound_check", sql`${t.minAmount} IS NULL OR ${t.maxAmount} IS NULL OR ${t.maxAmount} >= ${t.minAmount}`),
  ],
);

/**
 * ═══ PHÂN CÔNG LAO ĐỘNG — CÓ MỐC HIỆU LỰC ═══
 *
 * HÌNH THỨC LÀM VIỆC và NƠI LÀM VIỆC nằm ở đây, và chúng KHÔNG phải công thức lương. Một người làm
 * từ xa vẫn có thể ăn lương cứng, ăn theo giờ, ăn hoa hồng hay ăn khoán — máy tính lương tuyệt đối
 * không được đọc hai cột này để đoán ra công thức (xem `lib/constants/payroll-components.ts`).
 *
 * `employee_id` là khoá nhân sự trong sổ lương (`settings: payroll.employees`), cùng khoá mà
 * `marketer_profit_carryover` dùng — sổ lương là nơi khai người, và một cộng tác viên có thể chưa
 * có tài khoản ERP. `user_id` là cột NỐI về tài khoản khi có, để quy kết đi bằng khoá chứ không
 * bằng ô chữ (AGENTS.md mục 34).
 */
export const employmentAssignments = pgTable(
  "employment_assignments",
  {
    id: id(),
    employeeId: text("employee_id").notNull(),
    /** Tài khoản ERP tương ứng. `NULL` = CHƯA NỐI ĐƯỢC, không phải "không có ai". */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    departmentId: text("department_id").references((): AnyPgColumn => departments.id, { onDelete: "set null" }),
    positionId: text("position_id").references((): AnyPgColumn => positions.id, { onDelete: "set null" }),
    /** Quản lý trực tiếp — khoá tài khoản, không phải tên. */
    managerUserId: text("manager_user_id").references(() => users.id, { onDelete: "set null" }),
    /** `FULL_TIME` · `PART_TIME` · `CONTRACTOR`. */
    employmentType: text("employment_type").notNull().default("FULL_TIME"),
    /** `ONSITE` · `REMOTE` · `HYBRID`. */
    workMode: text("work_mode").notNull().default("ONSITE"),
    /** `ACTIVE` · `ON_LEAVE` · `TERMINATED`. */
    status: text("status").notNull().default("ACTIVE"),
    /** Ngày công chuẩn của tháng theo hợp đồng; `NULL` = dùng số ngày thật của tháng. */
    standardWorkDays: integer("standard_work_days"),
    costCenter: text("cost_center").notNull().default(""),
    effectiveFrom: ts("effective_from").notNull(),
    /** `NULL` = CÒN HIỆU LỰC. */
    effectiveTo: ts("effective_to"),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("employment_assignments_emp_idx").on(t.employeeId, t.effectiveFrom),
    index("employment_assignments_dept_idx").on(t.departmentId, t.effectiveFrom),
    check("employment_assignments_type_check", sql`${t.employmentType} IN ('FULL_TIME', 'PART_TIME', 'CONTRACTOR')`),
    check("employment_assignments_mode_check", sql`${t.workMode} IN ('ONSITE', 'REMOTE', 'HYBRID')`),
    check("employment_assignments_status_check", sql`${t.status} IN ('ACTIVE', 'ON_LEAVE', 'TERMINATED')`),
    check("employment_assignments_range_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** Gán CHÍNH SÁCH cho một người, có mốc hiệu lực. Đổi chính sách = thêm dòng, không sửa dòng cũ. */
export const employeePolicyAssignments = pgTable(
  "employee_policy_assignments",
  {
    id: id(),
    employeeId: text("employee_id").notNull(),
    policyId: text("policy_id")
      .notNull()
      .references(() => salaryPolicies.id, { onDelete: "restrict" }),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("employee_policy_assignments_emp_idx").on(t.employeeId, t.effectiveFrom),
    index("employee_policy_assignments_policy_idx").on(t.policyId),
    check("employee_policy_assignments_range_check", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/**
 * ═══ ĐẦU VÀO NHẬP TAY — CHẤM CÔNG, KPI, SẢN LƯỢNG ═══
 *
 * ERP KHÔNG có bảng chấm công, không có bảng nghiệm thu sản lượng theo người, và chấm KPI là một
 * quyết định của người quản lý chứ không phải một truy vấn. Ba thứ ấy vào đây, mỗi dòng mang TÊN
 * NGƯỜI NHẬP và MỐC THỜI GIAN.
 *
 * Đây là chỗ thay thế cho cám dỗ "viết một truy vấn gần đúng rồi gọi nó là số đo". Một ô trống
 * nhìn thấy được, có tên người phải điền, tốt hơn một con số không ai kiểm lại được (AGENTS.md
 * mục 45: con số CHƯA BIẾT tăng lên sau khi thôi khẳng định thứ không chứng minh được là ĐÚNG
 * HƯỚNG).
 *
 * Khoá tự nhiên (nhân sự, kỳ, đại lượng): nhập lại là SỬA, không phải thêm một dòng thứ hai —
 * nếu không, tính lại sẽ cộng dồn (yêu cầu mục 28).
 */
export const payrollInputs = pgTable(
  "payroll_inputs",
  {
    id: id(),
    employeeId: text("employee_id").notNull(),
    /** Cùng khoá kỳ với `payroll_periods.period_key`: `2026-09-01..2026-09-30`. */
    periodKey: text("period_key").notNull(),
    /** Khoá trong `PAYROLL_INPUTS` (chỉ những đại lượng khai `MANUAL`). */
    inputKey: text("input_key").notNull(),
    /** Giá trị. Đơn vị do sổ đăng ký quy định (giờ / ngày / cái / %). */
    value: doublePrecision("value").notNull(),
    /** Chứng cứ đọc được: bảng công tháng nào, ai duyệt, số phiếu nào. */
    evidence: text("evidence").notNull().default(""),
    /**
     * ĐƠN VỊ, CHỤP LẠI TẠI LÚC NHẬP.
     *
     * Sổ đăng ký (`PAYROLL_INPUTS`) đã khai đơn vị của từng đại lượng, nên cột này KHÔNG phải một
     * nguồn thứ hai — nó là ẢNH CHỤP. Ngày nào sổ đổi đơn vị của một đại lượng (giờ → ca chẳng
     * hạn), những dòng cũ vẫn đọc được đúng thứ người nhập đã nhập, thay vì lặng lẽ đổi nghĩa.
     */
    unit: text("unit").notNull().default(""),
    /**
     * `ENTERED` = đã nhập · `APPROVED` = đã có người duyệt.
     *
     * Chính sách nào đòi duyệt thì đòi ở tầng chính sách; cột này chỉ GHI LẠI việc đã duyệt hay
     * chưa. Mặc định `ENTERED` — không tự coi một con số vừa gõ là đã được ai đó soát.
     */
    status: text("status").notNull().default("ENTERED"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedByName: text("approved_by_name").notNull().default(""),
    approvedAt: ts("approved_at"),
    enteredBy: text("entered_by").references(() => users.id, { onDelete: "set null" }),
    /** Ảnh chụp TÊN người nhập, do MÁY CHỦ đọc từ `users` — không nhận từ client (AGENTS.md mục 34). */
    enteredByName: text("entered_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payroll_inputs_uq").on(t.employeeId, t.periodKey, t.inputKey),
    index("payroll_inputs_period_idx").on(t.periodKey),
    check("payroll_inputs_status_check", sql`${t.status} IN ('ENTERED', 'APPROVED')`),
    // Đã duyệt thì phải biết AI và LÚC NÀO — cùng luật với kỳ lương.
    check("payroll_inputs_approved_check", sql`${t.status} <> 'APPROVED' OR ${t.approvedAt} IS NOT NULL`),
  ],
);

/**
 * ═══ ĐIỀU CHỈNH TAY: THƯỞNG NÓNG · TẠM ỨNG · KHẤU TRỪ ═══
 *
 * Mỗi dòng bắt buộc có LÝ DO và NGƯỜI TẠO. Số tiền luôn lưu DƯƠNG; dấu do `kind` quyết định
 * (`PAYROLL_COMPONENT_SIGN`) — để người nhập không phải nhớ gõ dấu trừ, và để một dấu trừ gõ nhầm
 * không biến một khoản khấu trừ thành một khoản thưởng.
 *
 * `applies_to_period_key` là kỳ mà khoản này được tính vào. Chứng từ về SAU khi kỳ đã chốt thì ghi
 * vào kỳ SAU (yêu cầu mục 24) — kỳ đã chốt là bất biến, và đường duy nhất để sửa nó là một dòng
 * điều chỉnh ở kỳ kế tiếp, có dấu vết.
 */
export const payrollAdjustments = pgTable(
  "payroll_adjustments",
  {
    id: id(),
    employeeId: text("employee_id").notNull(),
    periodKey: text("period_key").notNull(),
    /** `BONUS` · `ALLOWANCE` · `ADJUSTMENT` · `ADVANCE` · `DEDUCTION` · `REIMBURSEMENT`. */
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    /** LUÔN DƯƠNG. Dấu do `kind` quyết định. */
    amount: integer("amount").notNull(),
    /** Bắt buộc — một khoản tiền không có lý do là một khoản không ai duyệt lại được. */
    reason: text("reason").notNull(),
    /** Chứng từ / đường dẫn tham chiếu nếu có. */
    reference: text("reference").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedByName: text("approved_by_name").notNull().default(""),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payroll_adjustments_period_idx").on(t.periodKey, t.employeeId),
    check("payroll_adjustments_amount_check", sql`${t.amount} >= 0`),
    check(
      "payroll_adjustments_kind_check",
      sql`${t.kind} IN ('BONUS', 'ALLOWANCE', 'ADJUSTMENT', 'ADVANCE', 'DEDUCTION', 'REIMBURSEMENT')`,
    ),
  ],
);

/**
 * ═══ HỘP THƯ CÁ NHÂN (migration 0126) ═══
 *
 * `notifications` là hàng đợi CHUNG của cả shop. Phiếu lương là tin của MỘT người — không được nằm
 * trong hàng đợi chung và không được gửi vào nhóm Lark. Mỗi dòng thuộc đúng một tài khoản.
 */
export const userMessages = pgTable(
  "user_messages",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** PAYSLIP_SENT · PAYSLIP_PAID · PAYROLL_READY · PAYROLL_DISPUTE · PAYROLL_BLOCKED · PAYROLL_PAYDAY */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    href: text("href").notNull().default(""),
    /** Khoá chống gửi trùng — job chạy mỗi giờ, một tin chỉ được đẻ ra một lần. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
    readAt: ts("read_at"),
  },
  (t) => [uniqueIndex("user_messages_dedupe_uq").on(t.dedupeKey), index("user_messages_inbox_idx").on(t.userId, t.readAt, t.createdAt)],
);

/**
 * ═══ PHIẾU LƯƠNG ĐÃ GỬI VÀ LỜI XÁC NHẬN (migration 0126) ═══
 *
 * Một dòng = một người trong MỘT LƯỢT GỬI (`round` = `payroll_periods.calc_runs` lúc gửi). "Hết hạn
 * không trả lời" KHÔNG ghi vào đây — nó tính lúc đọc từ `deadline_at` (`confirmationState`).
 */
export const payrollConfirmations = pgTable(
  "payroll_confirmations",
  {
    id: id(),
    periodKey: text("period_key").notNull(),
    basis: text("basis").notNull(),
    round: integer("round").notNull(),
    employeeId: text("employee_id").notNull(),
    employeeName: text("employee_name").notNull().default(""),
    /** Máy chủ khớp email hồ sơ ↔ tài khoản. `NULL` = chưa nối được tài khoản nên không gửi được. */
    recipientUserId: text("recipient_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Thực nhận lúc gửi (ảnh chụp). */
    amount: integer("amount"),
    /** PENDING · CONFIRMED · DISPUTED */
    status: text("status").notNull().default("PENDING"),
    sentAt: ts("sent_at").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    respondedAt: ts("responded_at"),
    respondedBy: text("responded_by").references(() => users.id, { onDelete: "set null" }),
    /** Lý do khiếu nại (bắt buộc khi DISPUTED) hoặc lời nhắn kèm xác nhận. */
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payroll_confirmations_uq").on(t.periodKey, t.basis, t.round, t.employeeId),
    index("payroll_confirmations_recipient_idx").on(t.recipientUserId, t.sentAt),
    check("payroll_confirmations_status_check", sql`${t.status} IN ('PENDING', 'CONFIRMED', 'DISPUTED')`),
    check("payroll_confirmations_response_check", sql`(${t.status} = 'PENDING') = (${t.respondedAt} IS NULL)`),
    check("payroll_confirmations_dispute_check", sql`${t.status} <> 'DISPUTED' OR length(trim(${t.note})) >= 3`),
  ],
);

/**
 * ═══ LỆNH CHUYỂN LƯƠNG (migration 0126) ═══
 *
 * Một dòng = một người trong một kỳ đã KHOÁ. Tài khoản nhận CHỤP LẠI lúc lập. "Đã trả" chỉ có khi một
 * dòng sao kê chứng minh tiền đã đi (`bank_txn_id`) — AGENTS.md mục 8.7.
 */
export const payrollPayoutLines = pgTable(
  "payroll_payout_lines",
  {
    id: id(),
    periodKey: text("period_key").notNull(),
    basis: text("basis").notNull(),
    employeeId: text("employee_id").notNull(),
    employeeName: text("employee_name").notNull().default(""),
    amount: integer("amount").notNull(),
    bankBin: text("bank_bin").notNull().default(""),
    bankName: text("bank_name").notNull().default(""),
    accountNumber: text("account_number").notNull().default(""),
    accountName: text("account_name").notNull().default(""),
    transferNote: text("transfer_note").notNull(),
    accountChanged: boolean("account_changed").notNull().default(false),
    /** PENDING · PAID · CANCELLED */
    status: text("status").notNull().default("PENDING"),
    bankTxnId: text("bank_txn_id").references(() => bankTransactions.id, { onDelete: "set null" }),
    paidAt: ts("paid_at"),
    matchedBy: text("matched_by").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payroll_payout_lines_uq").on(t.periodKey, t.basis, t.employeeId),
    uniqueIndex("payroll_payout_lines_note_uq").on(t.transferNote),
    uniqueIndex("payroll_payout_lines_txn_uq").on(t.bankTxnId).where(sql`${t.bankTxnId} IS NOT NULL`),
    check("payroll_payout_lines_amount_check", sql`${t.amount} > 0`),
    check("payroll_payout_lines_status_check", sql`${t.status} IN ('PENDING', 'PAID', 'CANCELLED')`),
    check("payroll_payout_lines_paid_check", sql`${t.status} <> 'PAID' OR (${t.paidAt} IS NOT NULL AND ${t.bankTxnId} IS NOT NULL)`),
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
     * NHÓM LÚC GHI — ẢNH CHỤP, KHÔNG PHẢI NGUỒN CỦA PHÉP GỘP.
     *
     * Cột này trả lời câu "hồi đó báo cáo xếp ca này vào đâu". Mọi TỔNG HỢP đi qua
     * `lib/constants/return-reason-mapping.ts::effectiveGroupOf`, suy lúc đọc từ bảng tra cộng
     * phần ghi đè của chủ shop — nhờ vậy chỉnh cách xếp nhóm là sửa MỘT dòng cấu hình, không phải
     * chạy `UPDATE` viết lại hàng trăm dòng lịch sử. Quan sát (`reason`, `raw_reason`) không bao
     * giờ bị sửa; cách xếp thì được phép đổi.
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
     * CHỮ GỐC CỦA ĐVVC tại thời điểm người bấm xác nhận — NGUYÊN VĂN, không chuẩn hoá.
     *
     * Người đè lên máy thì chữ của ĐVVC biến mất khỏi màn hình, và cùng với nó là đường kiểm
     * chứng: một ca xếp "vải xấu" mà ĐVVC ghi "khách hẹn giao lại" là một ca đáng hỏi lại — nhưng
     * chỉ thấy được nếu chữ gốc còn đó. Rỗng = chưa có chứng từ nào (dòng ghi trước 0085 cũng
     * rỗng: KHÔNG backfill, vì đoán hộ chữ gốc là bịa ra một chứng từ).
     */
    rawReason: text("raw_reason").notNull().default(""),
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

/**
 * ═══════════ QUAN SÁT LÝ DO HOÀN — MỘT DÒNG CHO MỘT LẦN AI ĐÓ NÓI RA ═══════════
 *
 * Hợp đồng và lý lẽ ở `lib/constants/return-reason-source.ts`.
 *
 * ─── VÌ SAO CẦN MỘT BẢNG RIÊNG, KHÔNG NHÉT THÊM CỘT VÀO `shipment_return_reasons` ───
 *
 * `shipment_return_reasons` khai `shipment_id` là UNIQUE: nó trả lời "kiện này CUỐI CÙNG được xếp
 * vào lý do nào", một kết luận cho một kiện. Đó là hình dạng đúng cho kết luận, nhưng sai cho
 * quan sát: một kiện có thể có ĐVVC nói một câu lúc 9h, khách nhắn một câu lúc 14h, và kho ghi
 * nhận xét lúc hôm sau. Nhét cả ba vào một dòng thì hai cái sau ghi đè hai cái trước, và không ai
 * còn thấy chúng từng mâu thuẫn nhau.
 *
 * Bảng này CHỈ THÊM, không bao giờ sửa. Kết luận vẫn ở bảng kia; đây là chứng cứ dẫn tới nó.
 *
 * ─── KHOÁ CHỐNG TRÙNG LÀ NỘI DUNG, KHÔNG PHẢI MỘT SỐ THỨ TỰ ───
 *
 * `dedupe_key` = (kiện · nguồn · mốc · vân tay chữ gốc). Nhờ vậy chạy lại lượt rút quan sát KHÔNG
 * sinh thêm dòng nào — điều kiện để một lượt backfill chạy được nhiều lần mà vẫn an toàn, và để
 * webhook Viettel Post gửi trùng (họ thử lại tối đa 5 lần) không nhân bản chứng cứ.
 */
export const returnReasonObservations = pgTable(
  "return_reason_observations",
  {
    id: id(),
    shipmentId: text("shipment_id").references(() => shipments.id, { onDelete: "cascade" }),
    /** Đơn liên quan. Giữ riêng vì có quan sát đến từ ĐƠN (ghi chú Pancake) chứ không từ kiện. */
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    /** `ReasonSource`. Ai nói ra điều này. */
    source: text("source").notNull(),
    /**
     * CHỮ GỐC, NGUYÊN VĂN, KHÔNG CHUẨN HOÁ, KHÔNG CẮT NGHĨA.
     *
     * Đây là thứ duy nhất trong bảng được coi là SỰ THẬT. Mọi cột còn lại là cách đọc nó, và cách
     * đọc thì được phép đổi.
     */
    rawText: text("raw_text").notNull(),
    /**
     * Lý do đã xếp được tại thời điểm GHI — ẢNH CHỤP, không phải nguồn của phép gộp.
     *
     * Báo cáo suy lại lý do lúc ĐỌC từ `rawText` qua bảng luật đang chạy, nên sửa luật là số đổi
     * theo mà không phải viết lại một dòng lịch sử nào. Cột này để trả lời "hồi đó máy đọc ra gì",
     * và để so xem một lần sửa luật đã đổi những ca nào.
     */
    reasonAtWrite: text("reason_at_write").notNull().default("UNKNOWN"),
    /** Mốc của chính sự việc (giờ ĐVVC ghi, giờ người gõ) — KHÔNG phải giờ dòng này được tạo. */
    occurredAt: ts("occurred_at").notNull(),
    /** Chứng từ gốc: id sự kiện, id ca CSKH, id phiếu kiểm… để lần ngược được. */
    sourceRef: text("source_ref").notNull().default(""),
    /** Người gõ, nếu là quan sát của người. `NULL` = MÁY rút ra (AGENTS.md mục 34). */
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull().default(""),
    /** Ghi chú chi tiết người viết thêm — KHÁC `rawText`, và không bao giờ thay nó. */
    note: text("note").notNull().default(""),
    /** Khoá tự nhiên chống trùng: kiện · nguồn · mốc · vân tay chữ. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("return_reason_obs_uq").on(t.dedupeKey),
    index("return_reason_obs_shipment_idx").on(t.shipmentId),
    index("return_reason_obs_order_idx").on(t.orderId),
    index("return_reason_obs_source_idx").on(t.source),
    // Chữ gốc RỖNG không phải một quan sát — nó là một dòng trống giả vờ là chứng cứ.
    check("return_reason_obs_raw_check", sql`length(btrim(${t.rawText})) > 0`),
    // Quan sát phải gắn được vào ÍT NHẤT một trong hai: kiện hoặc đơn. Không có cả hai thì nó
    // không nói về cái gì cả.
    check("return_reason_obs_link_check", sql`${t.shipmentId} is not null or ${t.orderId} is not null`),
  ],
);

export type ReturnReasonObservation = typeof returnReasonObservations.$inferSelect;

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
export type PayrollPeriod = typeof payrollPeriods.$inferSelect;
export type SalaryPolicy = typeof salaryPolicies.$inferSelect;
export type SalaryPolicyVersion = typeof salaryPolicyVersions.$inferSelect;
export type SalaryPolicyComponentRow = typeof salaryPolicyComponents.$inferSelect;
export type EmploymentAssignment = typeof employmentAssignments.$inferSelect;
export type EmployeePolicyAssignment = typeof employeePolicyAssignments.$inferSelect;
export type PayrollInputRow = typeof payrollInputs.$inferSelect;
export type PayrollAdjustmentRow = typeof payrollAdjustments.$inferSelect;
export type AccessRole = typeof accessRoles.$inferSelect;
export type Position = typeof positions.$inferSelect;

/* ═══════════════════════════════════════════════════════════════════════════
   PHÒNG TECH AI — MẶT PHẲNG ĐIỀU KHIỂN (Phase 1)

   Từ vựng, phép chuyển trạng thái và luật rủi ro ở `lib/constants/tech.ts` +
   `lib/constants/tech-risk.ts`. Ở đây chỉ có nơi CHỨA.

   VÌ SAO LÀ BẢNG MỚI CHỨ KHÔNG PHẢI `work_items`: xem chú thích đầu `lib/constants/tech.ts`.
   Tóm tắt: việc Tech là một MIỀN có trạng thái riêng, nên theo đúng AGENTS.md mục 19 nó phải tự
   giữ trạng thái của mình; `/work` sẽ CHIẾU lên nó ở Phase 2, không chép nó.

   PHASE 1 KHÔNG CÓ MÁY THI HÀNH. Không bảng nào ở đây kích hoạt một lượt deploy, một lượt merge
   hay một lượt ghi vào production. `tech_deployments` là LỚP QUAN SÁT — GitHub Actions vẫn là bên
   có thẩm quyền về deploy, và commit đang chạy đọc từ `/api/health`.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * SỔ AGENT — DỮ LIỆU ĐIỀU KHIỂN, KHÔNG PHẢI MỘT CON NGƯỜI.
 *
 * `tech_agents` KHÔNG tham chiếu `users`, và đó là cả điểm của nó (AGENTS.md mục 36): một job hay
 * một agent đứng ở cột "là máy", tách hẳn khỏi "có người làm" LẪN "chưa ai nhận". Gộp agent vào
 * bảng người là để một ngày nào đó báo cáo nói có 12 nhân viên Tech trong khi con số thật là 0.
 *
 * Bảng này TRỐNG sau migration. Mẫu ở `TECH_AGENT_TEMPLATES` chỉ chạy khi có người bấm — mẫu không
 * tự kích hoạt (mục 23).
 */
export const techAgents = pgTable(
  "tech_agents",
  {
    id: id(),
    /** Khoá ổn định do mã nguồn đặt (`ai-cto`, `backend`…). Đổi khoá là làm mồ côi mọi lượt chạy cũ. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** `lib/constants/tech.ts::TECH_AGENT_ROLES`. */
    role: text("role").notNull(),
    description: text("description").notNull().default(""),
    /**
     * TẮT LÀ MẶC ĐỊNH. Một agent bật sẵn lúc cài đặt là một agent chưa ai quyết định cho chạy —
     * cùng lý do phân việc tự động mặc định TẮT ở mọi phòng (mục 25).
     */
    enabled: boolean("enabled").notNull().default(false),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    /** Mức rủi ro agent được phép đụng (`R0` · `R1` · `R2`). Phase 1 không mẫu nào khai `R2`. */
    allowedRisks: jsonb("allowed_risks").$type<string[]>().notNull().default([]),
    canCode: boolean("can_code").notNull().default(false),
    canReview: boolean("can_review").notNull().default(false),
    canMerge: boolean("can_merge").notNull().default(false),
    canDeploy: boolean("can_deploy").notNull().default(false),
    canRunProdRead: boolean("can_run_prod_read").notNull().default(false),
    canRunProdWrite: boolean("can_run_prod_write").notNull().default(false),
    /** `lib/constants/tech.ts::TECH_AGENT_STATUSES`. */
    status: text("status").notNull().default("IDLE"),
    /** `NULL` = CHƯA TỪNG chạy. Không phải "chạy lúc 0 giờ". */
    lastSeenAt: ts("last_seen_at"),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_agents_key_uq").on(t.key),
    index("tech_agents_role_idx").on(t.role),
    check(
      "tech_agents_role_check",
      sql`${t.role} IN ('AI_CTO','ARCHITECT','BACKEND','FRONTEND','DATA','INTEGRATION','QA','SECURITY','DEVOPS_SRE','DATA_QUALITY','INCIDENT','DOCUMENTATION')`,
    ),
    check(
      "tech_agents_status_check",
      sql`${t.status} IN ('IDLE','PLANNING','WORKING','REVIEWING','TESTING','DEPLOYING','OBSERVING','BLOCKED','ERROR')`,
    ),
  ],
);

/**
 * VIỆC TECH.
 *
 * `code` (`TECH-12`) là mã ĐỌC ĐƯỢC để người nói chuyện với nhau; `id` vẫn là khoá. Hai thứ tồn tại
 * cùng lúc vì một UUID không đọc lên điện thoại được, còn một số đếm thì không an toàn làm khoá.
 */
export const techTasks = pgTable(
  "tech_tasks",
  {
    id: id(),
    code: text("code").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** `lib/constants/tech.ts::TECH_TASK_TYPES`. */
    taskType: text("task_type").notNull().default("BUGFIX"),
    /** `lib/constants/tech.ts::TECH_MODULES`. */
    module: text("module").notNull().default("PLATFORM"),
    /** `lib/constants/tech.ts::TECH_TASK_STATUSES`. Phép chuyển ở `TECH_TASK_TRANSITIONS`. */
    status: text("status").notNull().default("NEW"),
    priority: text("priority").notNull().default("P2"),
    risk: text("risk").notNull().default("R0"),
    /** Khoá các luật đã đẩy mức rủi ro lên — ẢNH CHỤP lúc xếp, để đọc lại được "hồi đó máy nghĩ gì". */
    riskRules: jsonb("risk_rules").$type<string[]>().notNull().default([]),
    /**
     * Người đè mức rủi ro của máy. Đè được là cần thiết; đè mà không ký tên thì cổng không tồn tại.
     * Có người đè ⇒ BẮT BUỘC có lý do (ràng buộc CHECK bên dưới).
     */
    riskOverriddenBy: text("risk_overridden_by").references(() => users.id, { onDelete: "set null" }),
    riskOverrideReason: text("risk_override_reason").notNull().default(""),
    /** `lib/constants/tech.ts::TECH_TASK_SOURCES`. */
    source: text("source").notNull().default("OWNER"),
    /** Chứng từ gốc: id sự cố, id lượt deploy, mã lỗi kiểm thử, đường dẫn màn hình. */
    sourceRef: text("source_ref").notNull().default(""),

    /** Agent được giao. `NULL` = CHƯA GIAO — khác hẳn "giao cho máy". */
    agentId: text("agent_id").references(() => techAgents.id, { onDelete: "set null" }),
    /** Nhánh git và cây làm việc (AGENTS.md mục 9: mỗi phiên một cây, một nhánh). */
    branch: text("branch").notNull().default(""),
    worktree: text("worktree").notNull().default(""),

    /* ───── PHÉP CHIẾU PULL REQUEST — GITHUB LÀ BÊN CÓ THẨM QUYỀN ─────
       ERP KHÔNG quyết định PR mở hay đóng, check xanh hay đỏ, merge được hay chưa. Nó chỉ CHÉP
       lại để người mở `/tech` thấy việc đang nằm ở đâu mà không phải sang GitHub. Mọi cột dưới
       đây được lượt đồng bộ ghi đè tự do; đừng ai gõ tay vào chúng.

       Rỗng / NULL = CHƯA BIẾT, không phải "không có PR" và cũng không phải "check đỏ". */
    prNumber: integer("pr_number"),
    prUrl: text("pr_url").notNull().default(""),
    prState: text("pr_state").notNull().default(""),
    /** SHA đỉnh nhánh PR lúc đồng bộ gần nhất — neo mọi kết luận về check vào một bản mã cụ thể. */
    headSha: text("head_sha").notNull().default(""),
    baseSha: text("base_sha").notNull().default(""),
    /** Tổng hợp check của GitHub: `PENDING` · `SUCCESS` · `FAILURE` · `` (chưa biết). */
    ciState: text("ci_state").notNull().default(""),
    /** `APPROVED` · `CHANGES_REQUESTED` · `REVIEW_REQUIRED` · `` (chưa biết). */
    reviewState: text("review_state").notNull().default(""),
    /** `MERGED` · `MERGEABLE` · `CONFLICT` · `` (chưa biết). */
    mergeState: text("merge_state").notNull().default(""),
    prSyncedAt: ts("pr_synced_at"),

    parentTaskId: text("parent_task_id").references((): AnyPgColumn => techTasks.id, { onDelete: "set null" }),
    /** `tech_tasks.id` của những việc phải xong trước. Danh sách, không phải một khoá ngoại. */
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),

    /* ───── Cổng phê duyệt của NGƯỜI ───── */
    approvalRequired: boolean("approval_required").notNull().default(false),
    /** `NOT_REQUIRED` · `PENDING` · `APPROVED` · `REJECTED`. */
    approvalStatus: text("approval_status").notNull().default("NOT_REQUIRED"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP TÊN do MÁY CHỦ đọc từ `users` — không nhận từ client (AGENTS.md mục 34). */
    approvedByName: text("approved_by_name").notNull().default(""),
    approvedAt: ts("approved_at"),
    approvalNote: text("approval_note").notNull().default(""),

    /* ───── Xác minh trên production ───── */
    /** `NULL` = CHƯA AI XÁC MINH. Đây KHÔNG phải "đã xác minh và thấy hỏng". */
    productionVerifiedAt: ts("production_verified_at"),
    productionVerifiedBy: text("production_verified_by").references(() => users.id, { onDelete: "set null" }),
    /** Bằng chứng: câu truy vấn đã chạy, số trước/sau, đường dẫn màn hình đã mở. */
    productionEvidence: text("production_evidence").notNull().default(""),

    /* ───── Ai tạo ───── */
    /** `HUMAN` · `SYSTEM` · `AI_AGENT` — ba loại, không bao giờ gộp. */
    createdByKind: text("created_by_kind").notNull().default("HUMAN"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),

    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    blockedReason: text("blocked_reason").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_tasks_code_uq").on(t.code),
    index("tech_tasks_status_idx").on(t.status, t.priority),
    index("tech_tasks_created_idx").on(t.createdAt),
    index("tech_tasks_agent_idx").on(t.agentId),
    index("tech_tasks_module_idx").on(t.module),
    check(
      "tech_tasks_status_check",
      sql`${t.status} IN ('NEW','TRIAGED','SPEC_READY','BUILDING','REVIEW','QA','READY_TO_DEPLOY','DEPLOYING','OBSERVING','DONE','BLOCKED','FAILED','ROLLED_BACK')`,
    ),
    check("tech_tasks_priority_check", sql`${t.priority} IN ('P0','P1','P2','P3')`),
    check("tech_tasks_risk_check", sql`${t.risk} IN ('R0','R1','R2')`),
    check("tech_tasks_approval_check", sql`${t.approvalStatus} IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')`),
    check("tech_tasks_actor_kind_check", sql`${t.createdByKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    /*
      "Không cần duyệt" và "đang chờ duyệt" không được cùng đúng một lúc. Thiếu ràng buộc này thì
      một việc R2 có thể mang `approval_required = false` kèm `approval_status = 'PENDING'`, và màn
      hình sẽ hiện nó ở cả hai nhóm — hoặc tệ hơn, ở nhóm "đi tiếp được".
    */
    check(
      "tech_tasks_approval_consistency_check",
      sql`(${t.approvalRequired} = false AND ${t.approvalStatus} = 'NOT_REQUIRED') OR (${t.approvalRequired} = true AND ${t.approvalStatus} <> 'NOT_REQUIRED')`,
    ),
    /* Đè mức rủi ro mà không nói vì sao thì không ai đọc lại được quyết định đó. */
    check(
      "tech_tasks_risk_override_check",
      sql`${t.riskOverriddenBy} IS NULL OR length(btrim(${t.riskOverrideReason})) >= 10`,
    ),
    /* `BLOCKED` mà không nói bị chặn bởi cái gì thì không ai gỡ được — cùng luật với `work_items`. */
    check("tech_tasks_blocked_reason_check", sql`${t.status} <> 'BLOCKED' OR length(btrim(${t.blockedReason})) > 0`),
    /* Xong thì phải có mốc xong. Một việc `DONE` không mốc là một dòng không đo được thời gian. */
    check("tech_tasks_completed_check", sql`${t.status} <> 'DONE' OR ${t.completedAt} IS NOT NULL`),
    /* Phép chiếu PR: giá trị lạ lọt vào là màn hình vẽ một trạng thái không tồn tại. Rỗng = CHƯA BIẾT. */
    check("tech_tasks_pr_state_check", sql`${t.prState} IN ('','OPEN','CLOSED','MERGED')`),
    check("tech_tasks_ci_state_check", sql`${t.ciState} IN ('','PENDING','SUCCESS','FAILURE')`),
    check("tech_tasks_review_state_check", sql`${t.reviewState} IN ('','REVIEW_REQUIRED','CHANGES_REQUESTED','APPROVED')`),
    check("tech_tasks_merge_state_check", sql`${t.mergeState} IN ('','MERGEABLE','CONFLICT','MERGED')`),
  ],
);

/**
 * NHẬT KÝ VIỆC TECH — CHỈ THÊM, KHÔNG SỬA.
 *
 * Mỗi dòng trả lời: ai (loại nào), làm gì, từ giá trị nào sang giá trị nào, vì sao. Cột `actor_name`
 * là ẢNH CHỤP TÊN do máy chủ đọc từ `users`, không nhận từ client (AGENTS.md mục 34).
 */
export const techTaskEvents = pgTable(
  "tech_task_events",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => techTasks.id, { onDelete: "cascade" }),
    /** `lib/constants/tech.ts::TECH_EVENT_KINDS`. */
    kind: text("kind").notNull(),
    note: text("note").notNull().default(""),
    previousValue: text("previous_value").notNull().default(""),
    nextValue: text("next_value").notNull().default(""),
    /** `HUMAN` · `SYSTEM` · `AI_AGENT`. */
    actorKind: text("actor_kind").notNull().default("HUMAN"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Agent đã làm, khi `actor_kind = 'AI_AGENT'`. */
    actorAgentId: text("actor_agent_id").references(() => techAgents.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull().default(""),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tech_task_events_task_idx").on(t.taskId, t.createdAt),
    check("tech_task_events_actor_kind_check", sql`${t.actorKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    /* Một người thật không bao giờ được ghi dưới danh nghĩa agent, và ngược lại. */
    check("tech_task_events_actor_link_check", sql`${t.actorKind} = 'AI_AGENT' OR ${t.actorAgentId} IS NULL`),
    check("tech_task_events_human_link_check", sql`${t.actorKind} = 'HUMAN' OR ${t.actorId} IS NULL`),
  ],
);

/**
 * LƯỢT CHẠY CỦA AGENT — HÀNH ĐỘNG, BẰNG CHỨNG, KẾT QUẢ. KHÔNG LƯU DÒNG SUY NGHĨ.
 *
 * `summary` là một câu kết luận có kiểm chứng được ("đã sửa 3 tệp, `npm test` xanh"), không phải
 * bản ghi quá trình lập luận. Lý do giống hệt `ai_interactions` (migration 0062): dòng suy nghĩ
 * dài, không kiểm chứng được, và lưu nó là mời người đọc tin vào một thứ không phải bằng chứng.
 *
 * Bốn cổng (`typecheck` · `lint` · `test` · `build`) mặc định `UNKNOWN`. CHƯA CHẠY KHÔNG PHẢI ĐẠT.
 */
export const techAgentRuns = pgTable(
  "tech_agent_runs",
  {
    id: id(),
    agentId: text("agent_id").references(() => techAgents.id, { onDelete: "set null" }),
    /** Ảnh chụp khoá agent: agent bị xoá khỏi sổ thì vẫn đọc được lượt chạy này là của ai. */
    agentKey: text("agent_key").notNull().default(""),
    taskId: text("task_id").references(() => techTasks.id, { onDelete: "set null" }),
    startedAt: ts("started_at").notNull().defaultNow(),
    /** `NULL` = ĐANG CHẠY (hoặc đã chết mà không ai đóng). Không phải "chạy 0 giây". */
    endedAt: ts("ended_at"),
    /**
     * `RUNNING` · `SUCCEEDED` · `FAILED` · `CANCELLED` · `BLOCKED`.
     *
     * `BLOCKED` = lượt chạy KHÔNG LÀM ĐƯỢC việc này ở môi trường của nó (thiếu khoá API, sai
     * quyền, hoặc chính agent khai đề bài đòi thứ máy dùng-một-lần không có). Nó KHÔNG phải một
     * kiểu thất bại: `FAILED` bảo đi sửa MÃ, `BLOCKED` bảo đi sửa ĐỀ BÀI hoặc MÔI TRƯỜNG.
     */
    status: text("status").notNull().default("RUNNING"),
    branch: text("branch").notNull().default(""),
    /**
     * Cây làm việc riêng của lượt chạy (AGENTS.md mục 9: mỗi phiên một cây, một nhánh). Hai lượt
     * chạy KHÔNG BAO GIỜ dùng chung một thư mục — đó là thứ đã làm `main` đỏ bốn lần trong một
     * buổi chiều. Giữ lại cả sau khi dọn cây, để đọc ngược được lượt chạy đã diễn ra ở đâu.
     */
    worktree: text("worktree").notNull().default(""),
    /**
     * NHỊP TIM. Runner cập nhật trong lúc chạy; tiến trình chết thì mốc này đứng im và lượt chạy
     * trở thành CŨ (`STALE`) thay vì nằm mãi ở "đang chạy". `NULL` = chưa đập nhịp nào.
     */
    heartbeatAt: ts("heartbeat_at"),
    baseCommit: text("base_commit").notNull().default(""),
    /*
      KHOÁ TỰ NHIÊN CỦA LƯỢT CHẠY ĐẾN TỪ MÁY NGOÀI — `provider:runId:attempt`.

      Runner chạy trên máy GitHub Actions, không nối được CSDL production, nên lượt chạy được CHÉP
      về qua một cửa hẹp (`/api/tech/agent-run`). Cửa ấy hướng ra Internet, nên "chép hai lần
      không đẻ hai dòng" phải là một BẢO ĐẢM của CSDL, không phải một mệnh đề `where not exists`
      trong mã — mệnh đề ấy luôn có cửa sổ đua giữa lúc đọc và lúc ghi.

      `NULL` = lượt chạy NỘI BỘ (chạy tay, chạy trong bộ kiểm thử). Postgres cho nhiều `NULL` cùng
      tồn tại dưới một khoá duy nhất, nên lượt chạy nội bộ không đụng gì tới nhau.

      `attempt` nằm TRONG khoá: chạy lại một workflow là một sự việc mới đáng xem, gộp hai lần
      thành một dòng là giấu mất đúng cái lần người ta quan tâm (cùng luật với `tech_deployments`).
    */
    externalRef: text("external_ref"),
    resultCommit: text("result_commit").notNull().default(""),
    summary: text("summary").notNull().default(""),
    /** Lệnh đã chạy, nguyên văn: `npm run typecheck && npm test`. */
    testsRun: text("tests_run").notNull().default(""),
    typecheckResult: text("typecheck_result").notNull().default("UNKNOWN"),
    lintResult: text("lint_result").notNull().default("UNKNOWN"),
    testResult: text("test_result").notNull().default("UNKNOWN"),
    buildResult: text("build_result").notNull().default("UNKNOWN"),
    filesChanged: jsonb("files_changed").$type<string[]>().notNull().default([]),
    error: text("error").notNull().default(""),
    metadata: jsonb("metadata"),
    /*
      PHÁN QUYẾT CỦA NGƯỜI REVIEW — cơ sở của chuỗi "lượt chạy sạch" (lib/constants/agent-clean-streak.ts).

      `NULL` = CHƯA REVIEW, không phải "sạch" và không phải "có lỗi" (AGENTS.md mục 42). Bốn cổng
      xanh KHÔNG đồng nghĩa với sạch: cổng bắt được thứ hỏng, không bắt được thứ sai — nên chỉ một
      người đã đọc mới ghi được cột này.

      Quy kết bằng KHOÁ tài khoản (mục 34). Không backfill (mục 8.8): không ai biết lượt cũ nào sạch.
    */
    reviewVerdict: text("review_verdict"),
    reviewNote: text("review_note").notNull().default(""),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: ts("reviewed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tech_agent_runs_agent_idx").on(t.agentId, t.startedAt),
    index("tech_agent_runs_task_idx").on(t.taskId, t.startedAt),
    index("tech_agent_runs_started_idx").on(t.startedAt),
    /* Chép hai lần KHÔNG đẻ hai dòng — bảo đảm ở CSDL, xem chú thích của `external_ref`. */
    uniqueIndex("tech_agent_runs_external_ref_uq").on(t.externalRef),
    check("tech_agent_runs_status_check", sql`${t.status} IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED')`),
    /* Danh sách ĐÓNG (mục 30): chuỗi lạ buộc mã phải đoán giữa "sạch" và "có lỗi". */
    check("tech_agent_runs_review_verdict_check", sql`${t.reviewVerdict} IS NULL OR ${t.reviewVerdict} IN ('SACH','CO_LOI')`),
    /* Có phán quyết thì phải biết AI và KHI NÀO. Một phán quyết không chủ là một phán quyết không ai chịu. */
    check("tech_agent_runs_review_attrib_check", sql`${t.reviewVerdict} IS NULL OR ${t.reviewedAt} IS NOT NULL`),
    check("tech_agent_runs_typecheck_check", sql`${t.typecheckResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    check("tech_agent_runs_lint_check", sql`${t.lintResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    check("tech_agent_runs_test_check", sql`${t.testResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    check("tech_agent_runs_build_check", sql`${t.buildResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    /* Lượt chạy đã kết thúc thì phải có mốc kết thúc — và ngược lại. */
    check(
      "tech_agent_runs_ended_check",
      sql`(${t.status} = 'RUNNING' AND ${t.endedAt} IS NULL) OR (${t.status} <> 'RUNNING' AND ${t.endedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * DEPLOYMENT — LỚP QUAN SÁT, KHÔNG PHẢI BÊN CÓ THẨM QUYỀN.
 *
 * GitHub Actions quyết định một bản có lên máy chủ hay không. Bảng này chỉ ghi lại để `/tech` trả
 * lời được "lần deploy gần nhất là commit nào, do ai, kết quả ra sao". Commit ĐANG CHẠY vẫn đọc từ
 * `/api/health` — không nhân đôi nguồn sự thật.
 */
export const techDeployments = pgTable(
  "tech_deployments",
  {
    id: id(),
    commitSha: text("commit_sha").notNull(),
    branch: text("branch").notNull().default("main"),
    /**
     * `MANUAL` (người gõ tay — đường của Phase 1) hoặc `GITHUB_ACTIONS` (ERP đọc lại workflow).
     * Hai nguồn có độ tin cậy khác nhau: một dòng gõ tay là LỜI KỂ, một dòng đọc từ Actions là
     * CHỨNG TỪ. Gộp thì không phân biệt được "chưa ai ghi" với "workflow chưa chạy".
     */
    provider: text("provider").notNull().default("MANUAL"),
    /** Tệp workflow (`deploy-vps.yml`). Rỗng với dòng gõ tay. */
    workflow: text("workflow").notNull().default(""),
    /**
     * KHOÁ TỰ NHIÊN của lượt chạy bên GitHub. Đây là thứ làm cho đồng bộ IDEMPOTENT: chạy lại job
     * mười lần vẫn đúng một dòng cho một lượt chạy. Rỗng với dòng gõ tay — và chỉ mục duy nhất
     * dưới đây CỐ Ý loại chuỗi rỗng, nếu không hai dòng gõ tay sẽ đụng nhau.
     */
    externalRunId: text("external_run_id").notNull().default(""),
    /** Lượt chạy lại (`run_attempt`). Chạy lại là một sự việc đáng xem, không phải một bản sao. */
    externalRunAttempt: integer("external_run_attempt").notNull().default(1),
    /** Chữ GitHub dùng: `success` · `failure` · `cancelled` · `timed_out`… Giữ NGUYÊN VĂN để đọc lại được. */
    externalConclusion: text("external_conclusion").notNull().default(""),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    /** `PENDING` · `RUNNING` · `SUCCEEDED` · `FAILED` · `ROLLED_BACK`. */
    status: text("status").notNull().default("PENDING"),
    /** `HUMAN` · `SYSTEM` · `AI_AGENT` — Phase 1 chỉ có `HUMAN` và `SYSTEM`. */
    actorKind: text("actor_kind").notNull().default("HUMAN"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull().default(""),
    taskId: text("task_id").references(() => techTasks.id, { onDelete: "set null" }),
    /** Ba cổng sau khi lên. Mặc định `UNKNOWN` — chưa đo KHÔNG phải đã đạt. */
    healthResult: text("health_result").notNull().default("UNKNOWN"),
    smokeResult: text("smoke_result").notNull().default("UNKNOWN"),
    observationResult: text("observation_result").notNull().default("UNKNOWN"),
    /**
     * Commit mà PRODUCTION đang chạy tại lúc đối chiếu — lời khai của chính tiến trình đang sống
     * (`lib/version.ts`), không phải của GitHub. `NULL` = chưa đối chiếu lần nào.
     */
    productionCommit: text("production_commit"),
    /** `UNKNOWN` · `VERIFIED` · `MISMATCH` · `SUPERSEDED` — xem `verifyDeployment()`. */
    verification: text("verification").notNull().default("UNKNOWN"),
    verifiedAt: ts("verified_at"),
    rollbackOfId: text("rollback_of_id").references((): AnyPgColumn => techDeployments.id, { onDelete: "set null" }),
    /** Đường dẫn lượt chạy GitHub Actions — để đối chiếu với bên có thẩm quyền. */
    externalRef: text("external_ref").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tech_deployments_started_idx").on(t.startedAt),
    index("tech_deployments_commit_idx").on(t.commitSha),
    /*
      MỘT LƯỢT CHẠY GITHUB = MỘT DÒNG. Chỉ mục duy nhất CÓ ĐIỀU KIỆN: dòng gõ tay mang
      `external_run_id = ''` và phải được phép trùng nhau, nếu không người chỉ ghi tay được một lần.
    */
    uniqueIndex("tech_deployments_external_uq").on(t.provider, t.externalRunId, t.externalRunAttempt).where(sql`${t.externalRunId} <> ''`),
    check("tech_deployments_provider_check", sql`${t.provider} IN ('MANUAL','GITHUB_ACTIONS')`),
    check("tech_deployments_verification_check", sql`${t.verification} IN ('UNKNOWN','VERIFIED','MISMATCH','SUPERSEDED')`),
    check("tech_deployments_status_check", sql`${t.status} IN ('PENDING','RUNNING','SUCCEEDED','FAILED','ROLLED_BACK')`),
    check("tech_deployments_actor_kind_check", sql`${t.actorKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    check("tech_deployments_health_check", sql`${t.healthResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    check("tech_deployments_smoke_check", sql`${t.smokeResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    check("tech_deployments_observation_check", sql`${t.observationResult} IN ('PASSED','FAILED','SKIPPED','UNKNOWN')`),
    /* Một lượt quay lui phải trỏ tới lượt nó quay lui — nếu không thì nó chỉ là một lượt deploy nữa. */
    check("tech_deployments_rollback_check", sql`${t.status} <> 'ROLLED_BACK' OR ${t.rollbackOfId} IS NOT NULL`),
  ],
);

/**
 * SỰ CỐ.
 *
 * `root_cause` để RỖNG là trạng thái hợp lệ và thường gặp: AGENTS.md mục 45 — chỗ trống loại
 * `TRUE_UNKNOWN` phải được giữ nguyên, không lấp bằng một câu nghe hợp lý. Cái BẮT BUỘC khi đóng
 * là `resolution` (đã làm gì để nó hết), vì việc đó luôn có thật.
 */
/**
 * ═══════════ ĐỀ XUẤT CỦA AI CTO — MỘT BẢN KẾ HOẠCH, KHÔNG PHẢI MỘT VIỆC ═══════════
 *
 * AI CTO đọc một MỤC TIÊU rồi đề nghị chia nó thành nhiều việc. Bản đề nghị đó nằm ở đây và
 * KHÔNG phải là `tech_tasks`: chừng nào chưa có người bấm duyệt, nó không có mặt ở hàng đợi nào,
 * không ai bị giao, không agent nào chạy được nó.
 *
 * ─── VÌ SAO KHÔNG NHÉT VÀO MỘT Ô CHỮ ───
 *
 * Một khối JSON trong `notes` thì không truy vấn được, không đếm được, và không trả lời được câu
 * "đề xuất này đã sinh ra những việc nào" sau khi đã duyệt. Mỗi việc đề nghị là một DÒNG, và
 * `applied_task_id` nối nó với việc thật — đó là thứ duy nhất làm phép duyệt KIỂM CHỨNG LẠI được.
 *
 * ─── MỨC RỦI RO Ở ĐÂY CHỈ LÀ Ý KIẾN ───
 *
 * `suggested_risk` là AI *nghĩ*. Nó KHÔNG bao giờ trở thành `tech_tasks.risk`: lúc duyệt, từng
 * việc chạy lại `classifyTechRisk()` và lấy kết quả của MÁY. Giữ cả hai để đọc được "AI đoán gì,
 * máy xếp gì" — hai con số lệch nhau là một tín hiệu đáng xem, không phải một lỗi cần giấu.
 */
export const techProposals = pgTable(
  "tech_proposals",
  {
    id: id(),
    /** Mục tiêu gốc — một `tech_tasks` đang mở, thường là việc "hãy xem xét X". */
    sourceTaskId: text("source_task_id")
      .notNull()
      .references(() => techTasks.id, { onDelete: "cascade" }),
    /** `DRAFT` · `READY_FOR_REVIEW` · `APPROVED` · `REJECTED` · `SUPERSEDED`. */
    status: text("status").notNull().default("DRAFT"),
    /** Vai agent đã lập kế hoạch. Luôn là `ai-cto` ở Phase 2B. */
    createdByAgentId: text("created_by_agent_id").references(() => techAgents.id, { onDelete: "set null" }),
    createdByAgentKey: text("created_by_agent_key").notNull().default(""),
    /** Nhà cung cấp + model đã sinh ra bản này — để đọc lại được "hồi đó ai nghĩ". */
    provider: text("provider").notNull().default(""),
    model: text("model").notNull().default(""),
    summary: text("summary").notNull().default(""),
    /** Điều AI TỰ NHẬN là đã giả định. Đọc được thì mới cãi lại được. */
    assumptions: jsonb("assumptions").$type<string[]>().notNull().default([]),
    /** Câu AI không tự trả lời được — chỗ nó thiếu dữ liệu, không phải chỗ nó lười. */
    questions: jsonb("questions").$type<string[]>().notNull().default([]),
    /** Nguyên văn JSON model trả về, sau khi đã qua zod. Bằng chứng thô, không dùng để tính. */
    rawOutput: jsonb("raw_output").$type<unknown>(),
    error: text("error").notNull().default(""),
    /*
      ═══ MỘT LƯỢT SỬA CÓ KIỂM SOÁT, VÀ ĐẾM ĐƯỢC ═══

      Model trả về đúng định dạng là chuyện thường, KHÔNG PHẢI luôn luôn. Đã xảy ra thật trên
      production 19/09/2026: nó trả 13 việc cho một hợp đồng tối đa 12. Bản đề xuất bị từ chối,
      đúng — nhưng nếu ta chỉ lưu "hỏng" thì lần sau không ai biết nó hỏng ở bước nào.

      Ba cột, ba câu hỏi khác nhau:
        · `modelCalls`    — đã gọi model mấy lượt (0 = bị chặn trước khi gọi, 1 = không phải sửa,
                            2 = đã sửa một lần). Trần là 2; không có lượt thứ ba.
        · `initialError`  — lượt ĐẦU sai cái gì. Rỗng nghĩa là lượt đầu đã đạt.
        · `repairOutcome` — lượt sửa kết thúc ra sao: `NONE` chưa cần sửa · `PASS` sửa xong đạt ·
                            `FAIL` sửa rồi vẫn không đạt.

      KHÔNG lưu dòng suy nghĩ của model — chỉ lưu lỗi kiểm tra và kết quả cuối.
    */
    modelCalls: integer("model_calls").notNull().default(1),
    initialError: text("initial_error").notNull().default(""),
    repairOutcome: text("repair_outcome").notNull().default("NONE"),
    /* Ai duyệt / từ chối. `NULL` = chưa ai. */
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP TÊN do MÁY CHỦ đọc từ `users` (AGENTS.md mục 34). */
    decidedByName: text("decided_by_name").notNull().default(""),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note").notNull().default(""),
    /** Bản đề xuất đã thay thế bản này (lập lại kế hoạch). */
    supersededById: text("superseded_by_id").references((): AnyPgColumn => techProposals.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tech_proposals_source_idx").on(t.sourceTaskId),
    index("tech_proposals_status_idx").on(t.status, t.createdAt),
    check("tech_proposals_model_calls_check", sql`${t.modelCalls} BETWEEN 0 AND 2`),
    /*
      Hai cột phải kể CÙNG MỘT câu chuyện. `repair_outcome` khác `NONE` mà `model_calls` không
      phải 2 nghĩa là một lượt sửa đã xảy ra nhưng không ai đếm nó — và lúc đó con số "bao nhiêu
      phần trăm bản đề xuất cần sửa" sai mà không có gì báo.
    */
    check(
      "tech_proposals_repair_check",
      sql`(${t.repairOutcome} = 'NONE' AND ${t.modelCalls} <= 1) OR (${t.repairOutcome} IN ('PASS','FAIL') AND ${t.modelCalls} = 2)`,
    ),
    check(
      "tech_proposals_status_check",
      sql`${t.status} IN ('DRAFT','READY_FOR_REVIEW','APPROVED','REJECTED','SUPERSEDED')`,
    ),
    /*
      Đã quyết thì phải biết AI NÀO quyết và LÚC NÀO. Một bản `APPROVED` không mốc, không tên là
      một quyết định không ai chịu trách nhiệm — đúng thứ cổng phê duyệt sinh ra để chặn.
    */
    check(
      "tech_proposals_decided_check",
      sql`${t.status} NOT IN ('APPROVED','REJECTED') OR ${t.decidedAt} IS NOT NULL`,
    ),
    /* Từ chối mà không nói vì sao thì lần lập lại kế hoạch sau lặp đúng sai lầm cũ. */
    check(
      "tech_proposals_reject_reason_check",
      sql`${t.status} <> 'REJECTED' OR length(btrim(${t.decisionNote})) >= 10`,
    ),
  ],
);

/**
 * TỪNG VIỆC TRONG BẢN KẾ HOẠCH.
 *
 * `applied_task_id` là bằng chứng của phép duyệt: có khoá ⇒ việc thật đã được tạo từ dòng này.
 * Nó cũng là thứ làm phép duyệt IDEMPOTENT — bấm duyệt lần thứ hai thấy khoá đã có thì bỏ qua,
 * chứ không tạo thêm một việc trùng.
 */
export const techProposalTasks = pgTable(
  "tech_proposal_tasks",
  {
    id: id(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => techProposals.id, { onDelete: "cascade" }),
    /** Khoá AI tự đặt trong bản kế hoạch (`T1`, `T2`…) — `depends_on` trỏ bằng khoá này. */
    key: text("key").notNull(),
    /** Thứ tự thực thi AI đề nghị. Nhỏ hơn = làm trước. */
    seq: integer("seq").notNull().default(0),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    taskType: text("task_type").notNull().default("BUGFIX"),
    module: text("module").notNull().default("PLATFORM"),
    suggestedPriority: text("suggested_priority").notNull().default("P2"),
    /** AI *nghĩ* là rủi ro này. KHÔNG bao giờ thành `tech_tasks.risk` — xem chú thích bảng trên. */
    suggestedRisk: text("suggested_risk").notNull().default("R0"),
    riskExplanation: text("risk_explanation").notNull().default(""),
    /** Vai agent đề nghị, theo `TECH_AGENT_TEMPLATES`. Vai lạ ⇒ bản đề xuất bị từ chối lúc parse. */
    suggestedAgentKey: text("suggested_agent_key").notNull().default(""),
    /** Khoá (`T1`…) của những việc phải xong trước — trong CÙNG bản kế hoạch. */
    dependsOnKeys: jsonb("depends_on_keys").$type<string[]>().notNull().default([]),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    /** Tệp/mô-đun AI nghĩ sẽ phải chạm. Là GỢI Ý để người soát phạm vi, không phải hàng rào. */
    expectedScope: jsonb("expected_scope").$type<string[]>().notNull().default([]),
    needsHumanDecision: boolean("needs_human_decision").notNull().default(false),
    humanDecisionNote: text("human_decision_note").notNull().default(""),
    /** Việc thật được tạo ra từ dòng này. `NULL` = CHƯA duyệt / chưa áp. */
    appliedTaskId: text("applied_task_id").references(() => techTasks.id, { onDelete: "set null" }),
    /** Mức rủi ro MÁY xếp lúc áp. Để cạnh `suggested_risk` cho người đọc so hai con số. */
    appliedRisk: text("applied_risk").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("tech_proposal_tasks_key_uq").on(t.proposalId, t.key),
    index("tech_proposal_tasks_applied_idx").on(t.appliedTaskId),
    check("tech_proposal_tasks_priority_check", sql`${t.suggestedPriority} IN ('P0','P1','P2','P3')`),
    check("tech_proposal_tasks_risk_check", sql`${t.suggestedRisk} IN ('R0','R1','R2')`),
    check("tech_proposal_tasks_applied_risk_check", sql`${t.appliedRisk} IN ('','R0','R1','R2')`),
  ],
);

export const techIncidents = pgTable(
  "tech_incidents",
  {
    id: id(),
    code: text("code").notNull(),
    title: text("title").notNull(),
    /** Ai / cái gì phát hiện: `MONITOR` · `OWNER` · `STAFF` · `DEPLOY` · `TEST_FAILURE` · `AI_AGENT`. */
    source: text("source").notNull().default("MONITOR"),
    /** Mốc SỰ CỐ BẮT ĐẦU (đo được), không phải mốc dòng này được tạo. */
    detectedAt: ts("detected_at").notNull().defaultNow(),
    severity: text("severity").notNull().default("SEV2"),
    status: text("status").notNull().default("OPEN"),
    module: text("module").notNull().default("PLATFORM"),
    /** Bằng chứng: log, số đo, ảnh màn hình, câu truy vấn. Không có bằng chứng thì không có sự cố. */
    evidence: text("evidence").notNull().default(""),
    taskId: text("task_id").references(() => techTasks.id, { onDelete: "set null" }),
    deploymentId: text("deployment_id").references(() => techDeployments.id, { onDelete: "set null" }),
    rootCause: text("root_cause").notNull().default(""),
    mitigation: text("mitigation").notNull().default(""),
    resolution: text("resolution").notNull().default(""),
    resolvedAt: ts("resolved_at"),
    openedByKind: text("opened_by_kind").notNull().default("HUMAN"),
    openedById: text("opened_by_id").references(() => users.id, { onDelete: "set null" }),
    openedByName: text("opened_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_incidents_code_uq").on(t.code),
    index("tech_incidents_status_idx").on(t.status, t.severity),
    index("tech_incidents_detected_idx").on(t.detectedAt),
    check("tech_incidents_severity_check", sql`${t.severity} IN ('SEV0','SEV1','SEV2','SEV3')`),
    check("tech_incidents_status_check", sql`${t.status} IN ('OPEN','INVESTIGATING','MITIGATED','MONITORING','RESOLVED')`),
    check("tech_incidents_actor_kind_check", sql`${t.openedByKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    /* Đóng sự cố thì phải có mốc đóng VÀ phải kể được đã làm gì. */
    check(
      "tech_incidents_resolved_check",
      sql`${t.status} <> 'RESOLVED' OR (${t.resolvedAt} IS NOT NULL AND length(btrim(${t.resolution})) >= 10)`,
    ),
  ],
);

export const techTasksRelations = relations(techTasks, ({ one, many }) => ({
  agent: one(techAgents, { fields: [techTasks.agentId], references: [techAgents.id] }),
  parent: one(techTasks, { fields: [techTasks.parentTaskId], references: [techTasks.id], relationName: "techTaskParent" }),
  children: many(techTasks, { relationName: "techTaskParent" }),
  events: many(techTaskEvents),
  runs: many(techAgentRuns),
  deployments: many(techDeployments),
  incidents: many(techIncidents),
}));

export const techTaskEventsRelations = relations(techTaskEvents, ({ one }) => ({
  task: one(techTasks, { fields: [techTaskEvents.taskId], references: [techTasks.id] }),
  agent: one(techAgents, { fields: [techTaskEvents.actorAgentId], references: [techAgents.id] }),
}));

export const techAgentsRelations = relations(techAgents, ({ many }) => ({
  tasks: many(techTasks),
  runs: many(techAgentRuns),
}));

export const techAgentRunsRelations = relations(techAgentRuns, ({ one }) => ({
  agent: one(techAgents, { fields: [techAgentRuns.agentId], references: [techAgents.id] }),
  task: one(techTasks, { fields: [techAgentRuns.taskId], references: [techTasks.id] }),
}));

export const techDeploymentsRelations = relations(techDeployments, ({ one }) => ({
  task: one(techTasks, { fields: [techDeployments.taskId], references: [techTasks.id] }),
  rollbackOf: one(techDeployments, { fields: [techDeployments.rollbackOfId], references: [techDeployments.id], relationName: "techDeployRollback" }),
}));

export const techIncidentsRelations = relations(techIncidents, ({ one }) => ({
  task: one(techTasks, { fields: [techIncidents.taskId], references: [techTasks.id] }),
  deployment: one(techDeployments, { fields: [techIncidents.deploymentId], references: [techDeployments.id] }),
}));

export type TechAgentRow = typeof techAgents.$inferSelect;
export type TechTaskRow = typeof techTasks.$inferSelect;
export type TechTaskEventRow = typeof techTaskEvents.$inferSelect;
export type TechAgentRunRow = typeof techAgentRuns.$inferSelect;
export type TechDeploymentRow = typeof techDeployments.$inferSelect;
export type TechIncidentRow = typeof techIncidents.$inferSelect;

// ═══ Company OS · Agent A · sổ mẫu, vòng đời, sự kiện ═══
//
// Hợp đồng: docs/company-os/shared-contracts.md mục 1–2 (kiến trúc: target-architecture.md Q1–Q5).
//
// `product_models` là SỔ DANH TÍNH, không phải chủ dữ liệu sản phẩm (Q1): `products` (uuid Pancake) vẫn
// là chủ. Sổ này biến phép nối ngầm `products.custom_id = design_concepts.code` thành một dòng có khoá,
// có vòng đời do NGƯỜI khai và có người phụ trách — vì một mẫu có thể tồn tại TRƯỚC khi lên Pancake.
//
// `lifecycle_state = NULL` nghĩa là CHƯA KHAI, không phải "đang bán" (Q3, mục 42): không backfill trạng
// thái cho mẫu cũ (mục 8.8, 35). Đường DUY NHẤT đổi cột ấy là `transitionModelCore` (lib/models/service.ts),
// và mỗi lượt đổi là một dòng lịch sử APPEND-ONLY.

/** Mã chủ shop (`Q001`, `TK-260925-01`) đã chuẩn hoá — `normalizeModelCode` (lib/constants/model-lifecycle.ts). */
export const productModels = pgTable(
  "product_models",
  {
    id: id(),
    code: text("code").notNull().unique(),
    name: text("name").notNull().default(""),
    /** `NULL` khi mẫu chưa lên Pancake. Một sản phẩm thuộc tối đa MỘT mẫu. */
    productId: text("product_id")
      .unique()
      .references(() => products.id, { onDelete: "set null" }),
    /** `NULL` khi mẫu không đi từ vòng thiết kế. */
    designConceptId: text("design_concept_id")
      .unique()
      .references(() => designConcepts.id, { onDelete: "set null" }),
    /** Trạng thái vòng đời do NGƯỜI khai. `NULL` = CHƯA KHAI. Máy không bao giờ tự điền từ phép quan sát. */
    lifecycleState: text("lifecycle_state"),
    stateChangedAt: ts("state_changed_at"),
    /** Người phụ trách do NGƯỜI chọn (mục 34: khoá tài khoản, không phải ô chữ). */
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** `SYNC` = máy đăng ký từ sản phẩm / thiết kế đang có · `USER` = người gõ mã (mẫu ở giai đoạn ý tưởng). */
    registeredBy: text("registered_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("product_models_state_idx").on(t.lifecycleState),
    check(
      "product_models_state_check",
      sql`${t.lifecycleState} IS NULL OR ${t.lifecycleState} IN ('IDEA', 'CREATIVE', 'ADS_TESTING', 'WINNER', 'LOSER', 'PRODUCTION_DISCUSSION', 'COSTING', 'SAMPLING', 'SAMPLE_REVIEW', 'APPROVED', 'PRODUCTION_PLANNING', 'IN_PRODUCTION', 'SELLING', 'CLEARANCE', 'DISCONTINUED')`,
    ),
    check("product_models_registered_by_check", sql`${t.registeredBy} IN ('SYNC', 'USER')`),
    // Mã rỗng là một dòng không ai gọi được tên — chuẩn hoá xong mà rỗng thì không đăng ký.
    check("product_models_code_check", sql`length(${t.code}) > 0`),
  ],
);

/**
 * SỔ SỰ KIỆN cho những miền MỚI của Company OS (Q5). Miền cũ (đơn, vận đơn, hoàn, phiếu kho) đã có nhật
 * ký riêng và được CHIẾU lúc đọc — không bao giờ chép sang đây. APPEND-ONLY: không UPDATE / DELETE ở đâu
 * cả (`tests/company-os-models.test.ts` quét mã nguồn). Tên sự kiện phải có trong sổ khai
 * `lib/constants/domain-events.ts`.
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: id(),
    name: text("name").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    modelId: text("model_id").references(() => productModels.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actorKind: text("actor_kind").notNull(),
    /** `users.id`. `NULL` = máy / webhook / agent (lib/constants/actor.ts). */
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    correlationId: text("correlation_id"),
    /** Id sự kiện đã gây ra sự kiện này. */
    causationId: text("causation_id"),
    /** Khoá chống ghi hai lần khi nguồn có thể gửi lại. `NULL` = không chống trùng. */
    dedupeKey: text("dedupe_key").unique(),
    /** Giờ NGHIỆP VỤ của sự việc. */
    occurredAt: ts("occurred_at").notNull(),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
  },
  (t) => [
    index("domain_events_model_idx").on(t.modelId, t.occurredAt),
    index("domain_events_name_idx").on(t.name, t.occurredAt),
    index("domain_events_subject_idx").on(t.subjectType, t.subjectId),
    check("domain_events_name_check", sql`${t.name} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check("domain_events_actor_kind_check", sql`${t.actorKind} IN ('USER', 'SYSTEM', 'AGENT', 'WEBHOOK')`),
    // Mục 34: một sự kiện "người làm" mà không có khoá tài khoản là một quy kết không kiểm được.
    check("domain_events_user_actor_check", sql`${t.actorKind} <> 'USER' OR ${t.actorId} IS NOT NULL`),
  ],
);

/** Lịch sử vòng đời mẫu — APPEND-ONLY. Mỗi lượt đổi `product_models.lifecycle_state` là đúng một dòng. */
export const productModelStateHistory = pgTable(
  "product_model_state_history",
  {
    id: id(),
    modelId: text("model_id")
      .notNull()
      .references(() => productModels.id, { onDelete: "restrict" }),
    /** `NULL` = trước đó CHƯA KHAI. */
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP tên để người đọc — do MÁY CHỦ đọc, không nhận từ client. */
    actorName: text("actor_name").notNull().default(""),
    /** Rỗng được với cạnh "tiến" trong bảng; lùi bước / nhảy cóc / khai lần đầu thì bắt buộc (kiểm ở lõi dịch vụ). */
    reason: text("reason").notNull(),
    /** Nơi phát sinh: `ui:/models`, `event:sample.approved`… */
    source: text("source").notNull(),
    sourceEventId: text("source_event_id").references(() => domainEvents.id, { onDelete: "set null" }),
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("product_model_state_history_model_idx").on(t.modelId, t.occurredAt),
    check(
      "product_model_state_history_to_check",
      sql`${t.toState} IN ('IDEA', 'CREATIVE', 'ADS_TESTING', 'WINNER', 'LOSER', 'PRODUCTION_DISCUSSION', 'COSTING', 'SAMPLING', 'SAMPLE_REVIEW', 'APPROVED', 'PRODUCTION_PLANNING', 'IN_PRODUCTION', 'SELLING', 'CLEARANCE', 'DISCONTINUED')`,
    ),
    check("product_model_state_history_actor_kind_check", sql`${t.actorKind} IN ('USER', 'SYSTEM', 'AGENT', 'WEBHOOK')`),
    check("product_model_state_history_user_actor_check", sql`${t.actorKind} <> 'USER' OR ${t.actorId} IS NOT NULL`),
  ],
);

export type ProductModelRow = typeof productModels.$inferSelect;
export type DomainEventRow = typeof domainEvents.$inferSelect;
export type ProductModelStateHistoryRow = typeof productModelStateHistory.$inferSelect;

// ═══ Company OS · Agent C · sản xuất nửa đầu ═══
//
// Hợp đồng: docs/company-os/shared-contracts.md mục 5 · kiến trúc: target-architecture.md Q7, Q8, §4.
// Bước 4–7 của chủ shop: topic hỏi giá xưởng → bảng giá thành có phiên bản → mẫu (sample) có phiên bản
// → duyệt mẫu ⇒ bản thiết kế BẤT BIẾN → lệnh sản xuất trỏ vào nó (cột trên `production_orders`).
//
// Luật (lib/constants/production-os.ts):
//  · `production_topic_messages`, `sample_reviews`, `design_versions` là APPEND-ONLY — chỉ INSERT.
//  · `cost_sheets` FINAL không sửa được: mọi UPDATE mang điều kiện `status = 'DRAFT'` và dòng chi phí chỉ
//    thay khi bảng cha còn DRAFT (khoá dòng cha trong cùng giao dịch). CHECK dưới đây buộc FINAL có
//    người chốt + mốc chốt.
//  · Người quyết (chốt giá thành, duyệt / loại mẫu) là một `users.id` NOT NULL, FK RESTRICT: chữ ký
//    không được biến mất theo một tài khoản.
//  · Sổ xưởng (`production_batches`…) KHÔNG đổi nghĩa và các bảng ở đây KHÔNG vào lợi nhuận: giá thành
//    tạm tính chỉ đi vào giá ước tính qua ĐÚNG đường `setEstimatedCost` có sẵn (người bấm).

/** Topic hỏi giá / bàn phương án với xưởng cho MỘT mẫu. */
export const productionTopics = pgTable(
  "production_topics",
  {
    id: id(),
    modelId: text("model_id")
      .notNull()
      .references(() => productModels.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    /** `TopicRequirements` — chất liệu, màu, size, phụ liệu, ghi chú thiết kế, giá mục tiêu, SL dự kiến, hạn. */
    requirements: jsonb("requirements").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("WAITING_QUOTE"),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /** Phương án đã chốt — bắt buộc khi `SELECTED` (CHECK). */
    selectedOption: text("selected_option"),
    /** ẢNH CHỤP chứng cứ lúc mở topic (`TopicEvidenceSnapshot`): có `basis` + `capturedAt`, không cập nhật về sau. */
    evidenceSnapshot: jsonb("evidence_snapshot").$type<Record<string, unknown>>().notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP tên người mở — do MÁY CHỦ đọc (mục 34). */
    createdBy: text("created_by").notNull().default(""),
    statusChangedAt: ts("status_changed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("production_topics_model_idx").on(t.modelId, t.createdAt),
    index("production_topics_status_idx").on(t.status),
    check("production_topics_status_check", sql`${t.status} IN ('WAITING_QUOTE', 'DISCUSSING', 'OPTIONS_READY', 'WAITING_DECISION', 'SELECTED', 'CLOSED')`),
    check("production_topics_title_check", sql`length(btrim(${t.title})) > 0`),
    check("production_topics_selected_check", sql`${t.status} <> 'SELECTED' OR length(btrim(coalesce(${t.selectedOption}, ''))) > 0`),
  ],
);

/** Lượt trao đổi trong topic — APPEND-ONLY. `author_user_id NULL` = máy. */
export const productionTopicMessages = pgTable(
  "production_topic_messages",
  {
    id: id(),
    topicId: text("topic_id")
      .notNull()
      .references(() => productionTopics.id, { onDelete: "restrict" }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull().default(""),
    kind: text("kind").notNull().default("NOTE"),
    body: text("body").notNull(),
    /** Link ảnh / tài liệu (URL http/https). Không có kho ảnh chung phù hợp — xem handoff-c.md. */
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    /** Giá xưởng báo mỗi sản phẩm (VND) — chỉ ở lượt `QUOTE`; `NULL` = lượt không mang giá. */
    quotedUnitPrice: integer("quoted_unit_price"),
    createdAt: createdAt(),
  },
  (t) => [
    index("production_topic_messages_topic_idx").on(t.topicId, t.createdAt),
    check("production_topic_messages_kind_check", sql`${t.kind} IN ('NOTE', 'QUOTE', 'OPTION', 'DECISION')`),
    check("production_topic_messages_body_check", sql`length(btrim(${t.body})) > 0`),
    check("production_topic_messages_price_check", sql`${t.quotedUnitPrice} IS NULL OR ${t.quotedUnitPrice} >= 0`),
  ],
);

/** Bảng giá thành — mỗi dòng là MỘT phiên bản của một mẫu. FINAL bất biến. */
export const costSheets = pgTable(
  "cost_sheets",
  {
    id: id(),
    modelId: text("model_id")
      .notNull()
      .references(() => productModels.id, { onDelete: "restrict" }),
    topicId: text("topic_id").references(() => productionTopics.id, { onDelete: "set null" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("DRAFT"),
    /** Tổng các dòng (VND/sp) — TÍNH ở máy chủ bằng `computeCostSheet`, lưu lại để phiên bản chốt không đổi số. */
    totalUnitCost: integer("total_unit_cost").notNull().default(0),
    notes: text("notes").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    finalizedAt: ts("finalized_at"),
    finalizedByUserId: text("finalized_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    finalizedBy: text("finalized_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cost_sheets_model_version_uq").on(t.modelId, t.version),
    index("cost_sheets_topic_idx").on(t.topicId),
    check("cost_sheets_status_check", sql`${t.status} IN ('DRAFT', 'FINAL')`),
    check("cost_sheets_version_check", sql`${t.version} > 0`),
    check("cost_sheets_total_check", sql`${t.totalUnitCost} >= 0`),
    check(
      "cost_sheets_final_check",
      sql`(${t.status} = 'DRAFT' AND ${t.finalizedAt} IS NULL AND ${t.finalizedByUserId} IS NULL) OR (${t.status} = 'FINAL' AND ${t.finalizedAt} IS NOT NULL AND ${t.finalizedByUserId} IS NOT NULL)`,
    ),
  ],
);

/** Dòng chi phí của một phiên bản. `unit = '%'` chỉ cho dòng WASTAGE: `qty` là số phần trăm (xem `computeCostSheet`). */
export const costSheetLines = pgTable(
  "cost_sheet_lines",
  {
    id: id(),
    costSheetId: text("cost_sheet_id")
      .notNull()
      .references(() => costSheets.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    description: text("description").notNull().default(""),
    qty: doublePrecision("qty").notNull().default(0),
    unit: text("unit").notNull().default(""),
    unitCost: integer("unit_cost").notNull().default(0),
    amount: integer("amount").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("cost_sheet_lines_sheet_idx").on(t.costSheetId, t.sortOrder),
    check("cost_sheet_lines_kind_check", sql`${t.kind} IN ('FABRIC', 'LABOR', 'TRIM', 'PRINTING', 'PACKING', 'FACTORY_TRANSPORT', 'INBOUND', 'WASTAGE', 'OTHER')`),
    check("cost_sheet_lines_money_check", sql`${t.qty} >= 0 AND ${t.unitCost} >= 0 AND ${t.amount} >= 0`),
    check("cost_sheet_lines_percent_check", sql`${t.unit} <> '%' OR (${t.kind} = 'WASTAGE' AND ${t.qty} <= 100)`),
  ],
);

/** Mẫu xưởng làm — mỗi dòng là MỘT phiên bản (V1, V2…) của một mẫu. */
export const samples = pgTable(
  "samples",
  {
    id: id(),
    modelId: text("model_id")
      .notNull()
      .references(() => productModels.id, { onDelete: "restrict" }),
    topicId: text("topic_id").references(() => productionTopics.id, { onDelete: "set null" }),
    version: integer("version").notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /** Tiền làm mẫu (VND). `NULL` = chưa biết. */
    costVnd: integer("cost_vnd"),
    /** Link ảnh mẫu (URL http/https). */
    images: jsonb("images").$type<string[]>().notNull().default([]),
    notes: text("notes").notNull().default(""),
    problems: text("problems").notNull().default(""),
    /** Ghi chú "yêu cầu sửa" của lượt duyệt — chép từ `sample_reviews.note` để phiên bản sau đọc ngay. */
    requestedChanges: text("requested_changes").notNull().default(""),
    status: text("status").notNull().default("IN_PROGRESS"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    submittedAt: ts("submitted_at"),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("samples_model_version_uq").on(t.modelId, t.version),
    index("samples_status_idx").on(t.status),
    check("samples_status_check", sql`${t.status} IN ('IN_PROGRESS', 'SUBMITTED', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED')`),
    check("samples_version_check", sql`${t.version} > 0`),
    check("samples_cost_check", sql`${t.costVnd} IS NULL OR ${t.costVnd} >= 0`),
    check("samples_submitted_check", sql`${t.status} = 'IN_PROGRESS' OR ${t.submittedAt} IS NOT NULL`),
    check("samples_decided_check", sql`${t.status} IN ('IN_PROGRESS', 'SUBMITTED') OR ${t.decidedAt} IS NOT NULL`),
  ],
);

/** Lượt duyệt mẫu — APPEND-ONLY, mỗi phiên bản mẫu đúng MỘT phán quyết (UNIQUE). */
export const sampleReviews = pgTable(
  "sample_reviews",
  {
    id: id(),
    sampleId: text("sample_id")
      .notNull()
      .unique()
      .references(() => samples.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    note: text("note").notNull().default(""),
    reviewerUserId: text("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewerName: text("reviewer_name").notNull().default(""),
    reviewedAt: ts("reviewed_at").notNull().defaultNow(),
  },
  (t) => [
    check("sample_reviews_decision_check", sql`${t.decision} IN ('REQUEST_CHANGES', 'REJECT', 'APPROVE')`),
    // Yêu cầu sửa / loại mà không nói vì sao thì xưởng không biết sửa gì, lần sau không ai học được gì.
    check("sample_reviews_note_check", sql`${t.decision} = 'APPROVE' OR length(btrim(${t.note})) > 0`),
  ],
);

/** Bản thiết kế đã duyệt — ẢNH CHỤP BẤT BIẾN, sinh ra DUY NHẤT bởi lượt duyệt mẫu (Q8). */
export const designVersions = pgTable(
  "design_versions",
  {
    id: id(),
    modelId: text("model_id")
      .notNull()
      .references(() => productModels.id, { onDelete: "restrict" }),
    sampleId: text("sample_id")
      .notNull()
      .unique()
      .references(() => samples.id, { onDelete: "restrict" }),
    reviewId: text("review_id")
      .notNull()
      .unique()
      .references(() => sampleReviews.id, { onDelete: "restrict" }),
    /** Bảng giá thành CHỐT mới nhất của mẫu lúc duyệt. `NULL` = lúc duyệt CHƯA có bảng chốt nào (ảnh chụp nói rõ). */
    costSheetId: text("cost_sheet_id").references(() => costSheets.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    /** Ảnh chụp: trường của mẫu + yêu cầu topic + bản sao dòng giá thành. Không cập nhật về sau. */
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    approvedByUserId: text("approved_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedBy: text("approved_by").notNull().default(""),
    approvedAt: ts("approved_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("design_versions_model_version_uq").on(t.modelId, t.version),
    check("design_versions_version_check", sql`${t.version} > 0`),
  ],
);

// ═══ Company OS · Agent E · kết cục hàng hoàn không tái nhập ═══

/**
 * ───────────── KẾT CỤC CỦA HÀNG HOÀN KHÔNG VÀO LẠI TỒN (APPEND-ONLY) ─────────────
 *
 * Trạm kiểm đếm cho món `OK` một phiếu tái nhập; mọi kết luận khác (hỏng · bẩn · sai hàng · không bán
 * được) trước đây không có trạng thái tiếp theo nào — hàng nằm trên kệ mà sổ không biết nó đi đâu.
 * Bảng này là SỔ GHI THÊM: mỗi dòng là một quyết định của một NGƯỜI (khoá tài khoản bắt buộc, luật
 * 34). Không UPDATE, không DELETE ở đâu cả — tình trạng hiện tại gập từ sổ
 * (`lib/constants/return-disposition.ts::foldDispositions`).
 *
 * Đối tượng: một dòng kiểm từng món (`inspection_item_id`), HOẶC phần "không bán được" của một kiện
 * kiểm cả kiện (`inspection_item_id` NULL). `subject_key` là khoá chung của hai loại, CHECK buộc nó
 * khớp đúng cột nguồn.
 *
 * Tồn kho: CHỈ `RESTOCK_AFTER_REWORK` đổi tồn, và qua một phiếu `RETURN` (`stock_receipt_id`, bắt
 * buộc với đúng kết cục ấy và cấm với mọi kết cục khác). `WRITE_OFF` ghi GIÁ TRỊ ƯỚC TÍNH, không ghi
 * sổ kho. Khoá ngoại tới phiếu kiểm / dòng kiểm / phiếu kho là RESTRICT: xoá chúng là xoá chứng từ
 * của một quyết định đã ghi.
 */
export const returnDispositions = pgTable(
  "return_dispositions",
  {
    id: id(),
    inspectionId: text("inspection_id")
      .notNull()
      .references(() => returnInspections.id, { onDelete: "restrict" }),
    /** `NULL` = đối tượng là CẢ KIỆN (kiện kiểm nhanh, không có dòng từng món). */
    inspectionItemId: text("inspection_item_id").references(() => returnInspectionItems.id, { onDelete: "restrict" }),
    /** `item:<id dòng kiểm>` hoặc `parcel:<id phiếu kiểm>`. */
    subjectKey: text("subject_key").notNull(),
    /** PENDING_DECISION · REWORK · RESTOCK_AFTER_REWORK · WRITE_OFF · RETURN_TO_SUPPLIER */
    disposition: text("disposition").notNull(),
    /** Số món dòng này nói tới. Kết cục cuối tiêu đúng bấy nhiêu từ phần còn mở. */
    qty: integer("qty").notNull(),
    /** Mẫu mã dòng này nói tới — đích nhập lại, hoặc mẫu dùng để định giá khi huỷ. `NULL` = không biết. */
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** Phiếu tái nhập sinh ra — CHỈ với `RESTOCK_AFTER_REWORK`. */
    stockReceiptId: text("stock_receipt_id").references(() => stockReceipts.id, { onDelete: "restrict" }),
    /** Chỉ với `WRITE_OFF`: đơn giá vốn ƯỚC TÍNH lúc huỷ, bậc căn cứ, và giá trị = đơn giá × số món. `NULL` = CHƯA BIẾT. */
    unitCostEstimate: integer("unit_cost_estimate"),
    costBasis: text("cost_basis"),
    valueEstimate: integer("value_estimate"),
    note: text("note").notNull().default(""),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** ẢNH CHỤP tên người làm — do MÁY CHỦ đọc từ `users`, không nhận từ client. */
    actorName: text("actor_name").notNull().default(""),
    /** Khoá chống bấm đúp / gửi lại: cùng khoá ⇒ trả lại dòng đã ghi, không ghi dòng thứ hai. */
    requestKey: text("request_key").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index("return_dispositions_subject_idx").on(t.subjectKey, t.createdAt),
    index("return_dispositions_inspection_idx").on(t.inspectionId),
    index("return_dispositions_variant_idx").on(t.variantId),
    check("return_dispositions_disposition_check", sql`${t.disposition} IN ('PENDING_DECISION', 'REWORK', 'RESTOCK_AFTER_REWORK', 'WRITE_OFF', 'RETURN_TO_SUPPLIER')`),
    check("return_dispositions_qty_check", sql`${t.qty} > 0`),
    check(
      "return_dispositions_subject_check",
      sql`(${t.inspectionItemId} IS NULL AND ${t.subjectKey} = 'parcel:' || ${t.inspectionId}) OR (${t.inspectionItemId} IS NOT NULL AND ${t.subjectKey} = 'item:' || ${t.inspectionItemId})`,
    ),
    check("return_dispositions_receipt_check", sql`(${t.disposition} = 'RESTOCK_AFTER_REWORK') = (${t.stockReceiptId} IS NOT NULL)`),
    check("return_dispositions_note_check", sql`${t.disposition} <> 'WRITE_OFF' OR length(trim(${t.note})) > 0`),
    check(
      "return_dispositions_value_check",
      sql`(${t.disposition} = 'WRITE_OFF' OR (${t.unitCostEstimate} IS NULL AND ${t.valueEstimate} IS NULL AND ${t.costBasis} IS NULL)) AND (${t.valueEstimate} IS NULL OR ${t.valueEstimate} >= 0) AND (${t.costBasis} IS NULL OR ${t.costBasis} IN ('RECEIPT', 'ORDER_SNAPSHOT', 'VARIANT_DEFAULT', 'UNKNOWN'))`,
    ),
  ],
);

export type ProductionTopicRow = typeof productionTopics.$inferSelect;
export type ProductionTopicMessageRow = typeof productionTopicMessages.$inferSelect;
export type CostSheetRow = typeof costSheets.$inferSelect;
export type CostSheetLineRow = typeof costSheetLines.$inferSelect;
export type SampleRow = typeof samples.$inferSelect;
export type SampleReviewRow = typeof sampleReviews.$inferSelect;
export type DesignVersionRow = typeof designVersions.$inferSelect;
export type ReturnDispositionRow = typeof returnDispositions.$inferSelect;

// ═══ Company OS · Agent H · sổ phản ứng với đề xuất của buồng lái chủ shop ═══
//
// Kiến trúc: docs/company-os/target-architecture.md mục 6 · luật thuần: lib/constants/owner-decisions.ts.
//
// Hàng đợi "Cần anh quyết" là PHÉP CHIẾU (luật 19) — nó không lưu đề xuất nào. Bảng này chỉ lưu PHẢN ỨNG
// của người đọc với một đề xuất (chấp nhận / bỏ qua / nhắc lại sau) kèm ẢNH CHỤP đề xuất lúc quyết, để
// sau này đo được đề xuất nào được nghe theo và đề xuất nào sai. APPEND-ONLY: chỉ INSERT, ở đâu cũng
// không UPDATE / DELETE (bài kiểm quét mã nguồn). Phản ứng có hiệu lực = dòng MỚI NHẤT của khoá.
export const recommendationDecisions = pgTable(
  "recommendation_decisions",
  {
    id: id(),
    /** Khoá ổn định của đề xuất (vd `ads:CUT:campaign:<id>:ACTUAL`, `sample:<id>`). */
    sourceKey: text("source_key").notNull(),
    /** `OwnerDecisionKind`. */
    kind: text("kind").notNull(),
    /** ACCEPTED · DISMISSED · SNOOZED */
    decision: text("decision").notNull(),
    /** Bắt buộc khi DISMISSED (CHECK + ứng dụng đòi ≥ 5 ký tự). */
    reason: text("reason").notNull().default(""),
    /** Chỉ khi SNOOZED: ẩn tới mốc này. */
    snoozeUntil: ts("snooze_until"),
    /** Luật 34: người quyết là MỘT tài khoản — máy không có phản ứng với đề xuất. */
    decidedByUserId: text("decided_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** ẢNH CHỤP tên — do MÁY CHỦ đọc từ phiên, không nhận từ client. */
    decidedBy: text("decided_by").notNull().default(""),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    /** Đề xuất ĐÚNG như người đọc thấy lúc quyết (CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG · NÚT), do máy chủ dựng lại. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index("recommendation_decisions_key_idx").on(t.sourceKey, t.decidedAt),
    index("recommendation_decisions_at_idx").on(t.decidedAt),
    check("recommendation_decisions_source_key_check", sql`length(btrim(${t.sourceKey})) > 0`),
    check("recommendation_decisions_decision_check", sql`${t.decision} IN ('ACCEPTED', 'DISMISSED', 'SNOOZED')`),
    check(
      "recommendation_decisions_kind_check",
      sql`${t.kind} IN ('APPROVAL', 'SAMPLE_REVIEW', 'TOPIC_DECISION', 'ADS_CUT', 'INVENTORY_STOCKOUT', 'PRODUCTION_LATE', 'INVENTORY_REORDER', 'MODEL_SCALE', 'INVENTORY_CLEARANCE')`,
    ),
    check("recommendation_decisions_reason_check", sql`${t.decision} <> 'DISMISSED' OR length(btrim(${t.reason})) > 0`),
    check("recommendation_decisions_snooze_check", sql`(${t.decision} = 'SNOOZED') = (${t.snoozeUntil} IS NOT NULL)`),
  ],
);

export type RecommendationDecisionDbRow = typeof recommendationDecisions.$inferSelect;

// VNXcommerce ERP — Drizzle schema (PostgreSQL)
// Tiền tệ: VND, lưu dạng integer. Thời gian: timestamptz (UTC).
import { relations, sql } from "drizzle-orm";
import { boolean, check, customType, date, doublePrecision, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, bigint, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";

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
  /**
   * Số điện thoại DI ĐỘNG Việt Nam đã chuẩn hoá `84xxxxxxxxx` (0193, `lib/auth/identity-shared.ts::normalizePhone`) —
   * đăng nhập được bằng SĐT thay email. `NULL` = chưa khai. Duy nhất TRONG tổ chức.
   */
  phone: text("phone"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_phone_key").on(t.phone).where(sql`${t.phone} IS NOT NULL`)]);

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

/**
 * ═══════════ GỬI TIN HÀNG LOẠT THEO BỘ LỌC (chủ shop 26/09/2026) ═══════════
 *
 * Thay bookmarklet bấm tuần tự vị trí 14–16 của cột trái Pancake: bookmarklet không nhớ đã gửi cho
 * ai, nên cùng một khách có thể nhận nhiều lần, và không để lại dấu vết nào để đo khách có mua hay
 * không. Ở đây mỗi lượt bấm là MỘT dòng `outreach_broadcasts`. Danh sách người nhận được CHỤP LẠI lúc bấm
 * (`outreach_broadcast_recipients`), mỗi hội thoại đúng một dòng. Kết quả gửi ghi vào chính dòng đó.
 *
 * Luật chọn và luật cửa sổ 24 giờ của Meta nằm ở `lib/constants/outreach-broadcast.ts`. Đường gửi ở
 * `lib/outreach/broadcast.ts`. Bảng này KHÔNG tham gia phép tính doanh thu hay kết quả đơn nào.
 */
export const outreachBroadcasts = pgTable(
  "outreach_broadcasts",
  {
    id: id(),
    name: text("name").notNull().default(""),
    /** Bộ lọc người bấm đã chọn — để đọc lại "lượt này nhắm ai" khi con số gây tranh cãi. */
    filters: jsonb("filters").notNull(),
    /** Các tin gửi lần lượt cho mỗi khách (mẫu, chưa thay biến). */
    messages: jsonb("messages").$type<string[]>().notNull(),
    mediaUrls: jsonb("media_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Giãn cách giữa hai khách (giây). */
    gapSeconds: integer("gap_seconds").notNull().default(2),
    /** Số người nhận chụp được lúc bấm. */
    total: integer("total").notNull().default(0),
    /** `RUNNING` · `STOPPED` (người bấm dừng — còn dòng chờ thì tiếp tục được) · `DONE`. */
    status: text("status").notNull().default("RUNNING"),
    /** Khoá tài khoản người bấm (AGENTS.md mục 34). Tên là ảnh chụp để đọc. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    stoppedByUserId: text("stopped_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Nhịp tim của vòng gửi. RUNNING mà nhịp tim cũ ⇒ tiến trình đã chết (deploy / khởi động lại). */
    heartbeatAt: ts("heartbeat_at"),
    /** Vòng gửi đang giữ lượt. Vòng nào thấy mã khác mã của mình thì thoát — mỗi lượt đúng MỘT vòng chạy. */
    runId: text("run_id"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outreach_broadcasts_created_idx").on(t.createdAt), check("outreach_broadcasts_status_check", sql`${t.status} IN ('RUNNING','STOPPED','DONE')`)],
);

export const outreachBroadcastRecipients = pgTable(
  "outreach_broadcast_recipients",
  {
    id: id(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => outreachBroadcasts.id, { onDelete: "cascade" }),
    /** Thứ tự gửi (0-based): khách GẦN HẠN 24 giờ nhất đi trước, vì họ là người sắp không nhắn được nữa. */
    seq: integer("seq").notNull(),
    pageId: text("page_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    pancakeCustomerId: text("pancake_customer_id").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    phone: text("phone"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Ảnh chụp mốc từ `conversation_funnel` lúc bấm. Lúc gửi còn kiểm lại bằng tin nhắn thật. */
    lastCustomerMessageAt: ts("last_customer_message_at"),
    lastShopMessageAt: ts("last_shop_message_at"),
    /** `PENDING` · `SENDING` (đang giữ chỗ) · `SENT` · `SKIPPED` · `FAILED`. */
    status: text("status").notNull().default("PENDING"),
    /** Mã lý do bỏ qua (`BROADCAST_SKIP_REASONS`) hoặc loại lỗi (`OUTREACH_ERROR_KINDS`). */
    reason: text("reason"),
    error: text("error").notNull().default(""),
    /** Số tin chữ đã được nhà cung cấp nhận. Nhỏ hơn số tin của lượt ⇒ gửi dở. */
    messagesSent: integer("messages_sent").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    claimedAt: ts("claimed_at"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("outreach_broadcast_recipients_uq").on(t.broadcastId, t.pageId, t.conversationId),
    index("outreach_broadcast_recipients_queue_idx").on(t.broadcastId, t.status, t.seq),
    index("outreach_broadcast_recipients_conv_idx").on(t.pageId, t.conversationId, t.sentAt),
    check("outreach_broadcast_recipients_status_check", sql`${t.status} IN ('PENDING','SENDING','SENT','SKIPPED','FAILED')`),
  ],
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
    /** Đã gửi Telegram / Lark lúc (ít nhất một kênh nhận) */
    notifiedAt: ts("notified_at"),
    /**
     * GỬI LẠI TIN HỎNG (0146 · Company OS · Agent N — `lib/constants/notification-retry.ts`).
     * Số lần job `alerts` đã NHẬN gửi dòng này (kể cả lần đầu). `NULL` = chưa từng thử — dòng cũ trước
     * 0146, hoặc dòng không có kênh nào để gửi; những dòng đó KHÔNG BAO GIỜ được gửi lại.
     */
    notifyAttempts: integer("notify_attempts"),
    /** Lúc nhận lượt thử gần nhất — cũng là "khoá giữ chỗ" chống hai lượt chạy gửi trùng. */
    notifyLastAttemptAt: ts("notify_last_attempt_at"),
    /** Câu lỗi lần gửi hỏng gần nhất, ĐÃ CHE URL / token. Không bao giờ chứa webhook. */
    notifyLastError: text("notify_last_error"),
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
    /**
     * NGUỒN TẠO ĐƠN (0202 · docs/productization/TARGET_ARCHITECTURE.md ⑤) — `AI_AGENT` chatbot lên đơn · `AI_ORDER_SYNC` AI
     * ghi đơn hộ nhân viên chốt. `NULL` = trước khi có cột, hoặc đường tạo chưa khai — KHÔNG đoán ngược cho dòng cũ (luật 35).
     */
    origin: text("origin"),
    /** Hội thoại chatbot sinh ra đơn (0202) — khoá thay cho chuỗi `source`. Không FK: hội thoại có thể bị dọn, đơn thì không. */
    salesConversationId: text("sales_conversation_id"),
    raw: jsonb("raw"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("orders_origin_check", sql`${t.origin} IS NULL OR ${t.origin} IN ('PANCAKE_POS','ERP_FORM','AI_AGENT','AI_ORDER_SYNC','IMPORT')`),
    index("orders_sales_conversation_idx").on(t.salesConversationId).where(sql`${t.salesConversationId} is not null`),
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
 * ═══ PHIẾU GIAO CÓ KÝ NHẬN CỦA ĐƠN TẠO TAY (G-ORDER — docs/business-rules/ORDER_OUTCOME.md mục 11) ═══
 *
 * Đơn không qua ĐVVC không có sự kiện Viettel Post nào để kết luận "đã giao". Chủ nền tảng quyết 29/09/2026: phiếu giao
 * có chữ ký người nhận là chứng cứ giao thành công, ngang mã cuối 501 chiều đi — và CHỈ cho chiều logistics + tồn kho.
 * Phiếu KHÔNG phải chứng từ tiền: không phép tính doanh thu / thanh toán nào đọc nó.
 *
 *  · CHỈ đơn tạo tay (`order_id LIKE 'erp-%'` — CHECK ở CSDL, không chỉ ở action).
 *  · MỘT phiếu còn hiệu lực mỗi đơn (chỉ mục duy nhất một phần trên `voided_at IS NULL`).
 *  · Ghi nhầm ⇒ HUỶ phiếu (mốc + người + lý do, CHECK bắt buộc lý do), KHÔNG xoá cứng: phiếu đã huỷ vẫn là vết.
 *  · Người ghi / người huỷ đi bằng KHOÁ `users.id` (AGENTS 34); cột tên chỉ là ảnh chụp do máy chủ đọc từ `users`.
 *  · `receiver_name` là ẢNH CHỤP chữ trên phiếu (người ký nhận) — không phải khoá, người nhận thường không có tài khoản.
 */
export const orderDeliveryNotes = pgTable(
  "order_delivery_notes",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Mốc người nhận ký trên phiếu (người ghi khai theo phiếu giấy) — KHÁC `recorded_at` (lúc nhập vào ERP). */
    signedAt: ts("signed_at").notNull(),
    receiverName: text("receiver_name").notNull(),
    note: text("note").notNull().default(""),
    recordedByUserId: text("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    recordedByName: text("recorded_by_name").notNull().default(""),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
    voidedAt: ts("voided_at"),
    voidedByUserId: text("voided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    voidedByName: text("voided_by_name").notNull().default(""),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("order_delivery_notes_order_idx").on(t.orderId),
    uniqueIndex("order_delivery_notes_active_uq").on(t.orderId).where(sql`${t.voidedAt} IS NULL`),
    check("order_delivery_notes_manual_check", sql`${t.orderId} LIKE 'erp-%'`),
    check("order_delivery_notes_receiver_check", sql`length(btrim(${t.receiverName})) > 0`),
    check("order_delivery_notes_void_check", sql`(${t.voidedAt} IS NULL AND ${t.voidReason} IS NULL) OR (${t.voidedAt} IS NOT NULL AND length(btrim(coalesce(${t.voidReason}, ''))) >= 3)`),
  ],
);

/**
 * ═══ ĐIỀU PHỐI GIAO CỦA ĐƠN TẠO TAY — NGƯỜI GIAO + LƯỢT MÁY TỰ TẠO VẬN ĐƠN (0216 · docs/verticals/pos-tu-chu.md P7) ═══
 *
 * TUYẾN của đơn (tự giao / hãng / giữ lại) KHÔNG lưu ở đây: nó là hàm THUẦN của đơn + cấu hình `shipping.routing` đọc LÚC
 * XEM (`lib/shipping/route.ts`) — sửa cấu hình thì mọi đơn chưa giao đổi tuyến ngay, không có cột nào phải backfill. Bảng
 * chỉ giữ hai thứ KHÔNG suy ra được:
 *  · NGƯỜI GIAO của đơn tự giao — KHOÁ `users.id` (AGENTS 34); `courier_name` chỉ là ảnh chụp tên do máy chủ đọc từ `users`.
 *  · LƯỢT MÁY TỰ TẠO VẬN ĐƠN gần nhất (job `shipping-route`): số lần hỏng liên tiếp + mốc + câu lỗi — để máy KHÔNG dội hãng
 *    mỗi 5 phút bằng cùng một đơn hãng đã từ chối. Vận đơn thật vẫn chỉ ở `shipments` (lõi `lib/carriers/engine.ts`).
 * Không phép tính nghiệp vụ nào (ORDER_OUTCOME, tồn kho, doanh thu) đọc bảng này.
 */
export const orderDispatch = pgTable(
  "order_dispatch",
  {
    orderId: text("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "cascade" }),
    courierUserId: text("courier_user_id").references(() => users.id, { onDelete: "set null" }),
    courierName: text("courier_name").notNull().default(""),
    assignedAt: ts("assigned_at"),
    assignedByUserId: text("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    autoAttempts: integer("auto_attempts").notNull().default(0),
    autoLastAt: ts("auto_last_at"),
    autoLastResult: text("auto_last_result"),
    autoLastCarrier: text("auto_last_carrier"),
    autoLastMessage: text("auto_last_message"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("order_dispatch_courier_idx").on(t.courierUserId),
    check("order_dispatch_manual_check", sql`${t.orderId} LIKE 'erp-%'`),
    check("order_dispatch_auto_result_check", sql`${t.autoLastResult} IS NULL OR ${t.autoLastResult} IN ('CREATED', 'FAILED')`),
  ],
);

/**
 * ═══ CHỨNG TỪ THANH TOÁN CỦA ĐƠN TẠO TAY — PHIẾU THU / PHIẾU HOÀN TIỀN (ORDER_OUTCOME.md mục 11, 0181) ═══
 *
 * Chiều TIỀN của đơn không qua ĐVVC. Phiếu giao (bảng trên) nói hàng đã tới tay khách; bảng này nói tiền đã vào / ra
 * bao nhiêu — hai chiều tách bạch (mục 1), không dòng nào suy ra dòng kia. "Tổ chức" của chứng từ là CSDL chứa nó
 * (đa tổ chức SILO): không có cột mã tổ chức, lượt ghi chỉ chạy trong CSDL của phiên.
 *
 *  · CHỈ đơn tạo tay (`order_id LIKE 'erp-%'` — CHECK ở CSDL): đơn Pancake đi theo bảng kê ĐVVC / sao kê.
 *  · `kind`: `RECEIPT` thu của khách · `REFUND` trả lại khách. Số tiền LUÔN dương; chiều nằm ở `kind`.
 *  · `method`: `CASH` · `BANK_TRANSFER` · `COD` (shipper CỦA SHOP thu hộ — chỉ tính khi có phiếu thu này) · `OTHER`.
 *  · Ghi nhầm ⇒ HUỶ (`status = 'VOIDED'` + mốc + người + lý do, CHECK), KHÔNG xoá cứng: phiếu đã huỷ vẫn là vết và
 *    không vào phép tính nào.
 *  · Người ghi / người huỷ đi bằng KHOÁ `users.id` (AGENTS 34); cột tên chỉ là ảnh chụp do máy chủ đọc.
 *  · Trạng thái thanh toán của đơn KHÔNG lưu: tính lúc đọc (`lib/constants/order-payments.ts` + `manual-order-sql.ts`).
 */
export const orderPayments = pgTable(
  "order_payments",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    method: text("method").notNull(),
    /** Số nguyên VND, > 0. */
    amount: integer("amount").notNull(),
    /** Mốc tiền đổi tay (theo chứng từ) — KHÁC `created_at` (lúc nhập vào ERP). Mốc của mọi báo cáo thực thu. */
    paidAt: ts("paid_at").notNull(),
    status: text("status").notNull().default("CONFIRMED"),
    /** Số tham chiếu trên chứng từ: mã giao dịch ngân hàng, số phiếu thu… */
    reference: text("reference").notNull().default(""),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    voidedAt: ts("voided_at"),
    voidedByUserId: text("voided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    voidedByName: text("voided_by_name").notNull().default(""),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("order_payments_order_idx").on(t.orderId),
    index("order_payments_paid_at_idx").on(t.paidAt),
    check("order_payments_manual_check", sql`${t.orderId} LIKE 'erp-%'`),
    check("order_payments_amount_check", sql`${t.amount} > 0`),
    check("order_payments_kind_check", sql`${t.kind} IN ('RECEIPT', 'REFUND')`),
    check("order_payments_method_check", sql`${t.method} IN ('CASH', 'BANK_TRANSFER', 'COD', 'OTHER')`),
    check(
      "order_payments_void_check",
      sql`(${t.status} = 'CONFIRMED' AND ${t.voidedAt} IS NULL AND ${t.voidReason} IS NULL) OR (${t.status} = 'VOIDED' AND ${t.voidedAt} IS NOT NULL AND length(btrim(coalesce(${t.voidReason}, ''))) >= 3)`,
    ),
  ],
);
/**
 * BẢNG GIÁ (0188) — giá theo NHÓM KHÁCH + BẬC SỐ LƯỢNG. Khách gán bảng ở `customer_trade_terms`; khách chưa gán ⇒ bảng
 * `is_default` (tối đa một bảng đang bật); không bảng nào có dòng cho mẫu mã ⇒ giá lẻ của mẫu mã. Luật chọn giá là hàm
 * thuần `quoteUnitPrice` (`lib/constants/price-lists.ts`) — form đơn tay, máy chủ và chatbot dùng chung.
 */
export const priceLists = pgTable(
  "price_lists",
  {
    id: id(),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("price_lists_one_default").on(t.isDefault).where(sql`${t.isDefault} AND ${t.active}`), check("price_lists_name_check", sql`length(trim(${t.name})) BETWEEN 1 AND 80`)],
);

/** Một bậc giá: mua từ `min_quantity` trở lên thì đơn giá là `unit_price`. Bậc cao nhất ≤ số lượng thắng. */
export const priceListItems = pgTable(
  "price_list_items",
  {
    id: id(),
    priceListId: text("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "cascade" }),
    variantId: text("variant_id").notNull(),
    minQuantity: integer("min_quantity").notNull().default(1),
    unitPrice: integer("unit_price").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("price_list_items_tier_key").on(t.priceListId, t.variantId, t.minQuantity),
    index("price_list_items_variant_idx").on(t.variantId),
    check("price_list_items_min_quantity_check", sql`${t.minQuantity} BETWEEN 1 AND 100000`),
    check("price_list_items_unit_price_check", sql`${t.unitPrice} > 0`),
  ],
);

/**
 * ĐIỀU KHOẢN BÁN CỦA MỘT KHÁCH (0188): bảng giá · hạn mức nợ · số ngày được nợ. Bảng RIÊNG — `customers` là bảng đồng bộ
 * từ Pancake ở tổ chức nhà. `credit_limit` / `payment_terms_days` NULL = CHƯA KHAI (không chặn, không tính quá hạn),
 * không phải 0. Công nợ không lưu ở đây: nó tính lúc đọc từ chứng từ thanh toán (`lib/queries/receivables.ts`).
 */
/**
 * SỔ LIÊN HỆ KHÁCH (0189) — mỗi lần gọi / nhắn / gặp khách một dòng, chỉ thêm. Người làm đi bằng khoá `users.id`, tên là
 * ảnh chụp do máy chủ đọc (luật 34). "Đến hạn mua lại" KHÔNG lưu ở đâu: tính lúc đọc từ lịch sử đơn (lib/constants/reorder.ts).
 */
export const customerTouchpoints = pgTable(
  "customer_touchpoints",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    outcome: text("outcome").notNull(),
    note: text("note").notNull().default(""),
    nextContactOn: date("next_contact_on", { mode: "string" }),
    at: ts("at").notNull().defaultNow(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    userName: text("user_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_touchpoints_customer_at_idx").on(t.customerId, t.at),
    check("customer_touchpoints_kind_check", sql`${t.kind} IN ('CALL','MESSAGE','VISIT','OTHER')`),
    check("customer_touchpoints_outcome_check", sql`${t.outcome} IN ('WILL_ORDER','NOT_NOW','NO_ANSWER','DECLINED','OTHER')`),
  ],
);

/**
 * LIỆU TRÌNH (0190) — gói N buổi khách trả trước. Số buổi đã dùng / đang giữ chỗ KHÔNG lưu: đếm lúc đọc từ `appointments`
 * gắn gói (lib/constants/appointments.ts::packageBalance).
 */
export const customerPackages = pgTable(
  "customer_packages",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    variantId: text("variant_id"),
    name: text("name").notNull(),
    totalSessions: integer("total_sessions").notNull(),
    orderId: text("order_id"),
    expiresOn: date("expires_on", { mode: "string" }),
    status: text("status").notNull().default("ACTIVE"),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("customer_packages_customer_idx").on(t.customerId),
    check("customer_packages_sessions_check", sql`${t.totalSessions} BETWEEN 1 AND 500`),
    check("customer_packages_status_check", sql`${t.status} IN ('ACTIVE','CLOSED')`),
    check("customer_packages_name_check", sql`length(trim(${t.name})) BETWEEN 1 AND 120`),
  ],
);

/**
 * LỊCH HẸN (0190). Kỹ thuật viên đi bằng khoá tài khoản (luật 34). Một kỹ thuật viên không có hai lịch ĐANG HIỆU LỰC
 * chồng giờ — chặn ở lib/records/appointments.ts trong giao dịch có khoá tư vấn theo người. Huỷ bắt buộc lý do.
 */
/**
 * PHIẾU BẢO HÀNH (0196, module `warranty`). Một serial chỉ thuộc MỘT phiếu đang hiệu lực (chỉ mục duy nhất có điều kiện, không
 * phân biệt hoa thường). Hạn = ngày mua + số tháng, tính lúc GHI (lib/constants/warranty.ts::warrantyExpiry). Huỷ cần lý do.
 */
export const warrantyCards = pgTable(
  "warranty_cards",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    variantId: text("variant_id"),
    productName: text("product_name").notNull(),
    serial: text("serial"),
    orderId: text("order_id"),
    purchasedOn: date("purchased_on", { mode: "string" }).notNull(),
    months: integer("months").notNull(),
    expiresOn: date("expires_on", { mode: "string" }).notNull(),
    status: text("status").notNull().default("ACTIVE"),
    voidReason: text("void_reason"),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("warranty_cards_customer_idx").on(t.customerId),
    uniqueIndex("warranty_cards_serial_active_uq").on(sql`lower(${t.serial})`).where(sql`${t.serial} IS NOT NULL AND ${t.status} = 'ACTIVE'`),
    check("warranty_cards_months_check", sql`${t.months} BETWEEN 1 AND 120`),
    check("warranty_cards_expiry_check", sql`${t.expiresOn} > ${t.purchasedOn}`),
    check("warranty_cards_status_check", sql`${t.status} IN ('ACTIVE','VOID')`),
    check("warranty_cards_void_check", sql`${t.status} <> 'VOID' OR length(btrim(coalesce(${t.voidReason}, ''))) >= 3`),
    check("warranty_cards_serial_check", sql`${t.serial} IS NULL OR length(btrim(${t.serial})) BETWEEN 1 AND 80`),
    check("warranty_cards_name_check", sql`length(trim(${t.productName})) BETWEEN 1 AND 200`),
  ],
);

/**
 * CA BẢO HÀNH (0196). «Còn bảo hành» KHÔNG lưu — tính lúc đọc từ `opened_at` so với hạn của phiếu. Người nhận / người mở đi bằng
 * khoá tài khoản (luật 34); tên là ảnh chụp do máy chủ đọc. Chi phí / tiền thu khách `NULL` = chưa biết (luật 42).
 */
export const warrantyClaims = pgTable(
  "warranty_claims",
  {
    id: id(),
    cardId: text("card_id")
      .notNull()
      .references(() => warrantyCards.id, { onDelete: "cascade" }),
    openedAt: ts("opened_at").notNull().defaultNow(),
    issue: text("issue").notNull(),
    status: text("status").notNull().default("OPEN"),
    resolution: text("resolution"),
    rejectReason: text("reject_reason"),
    costVnd: integer("cost_vnd"),
    chargedVnd: integer("charged_vnd"),
    assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    closedAt: ts("closed_at"),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("warranty_claims_card_idx").on(t.cardId),
    index("warranty_claims_status_idx").on(t.status, t.openedAt),
    check("warranty_claims_issue_check", sql`length(btrim(${t.issue})) BETWEEN 5 AND 1000`),
    check("warranty_claims_status_check", sql`${t.status} IN ('OPEN','IN_PROGRESS','DONE','REJECTED')`),
    check("warranty_claims_resolution_check", sql`${t.resolution} IS NULL OR ${t.resolution} IN ('REPAIRED','REPLACED','REFUNDED','RETURNED_TO_SUPPLIER','NO_FAULT')`),
    check("warranty_claims_done_check", sql`${t.status} <> 'DONE' OR ${t.resolution} IS NOT NULL`),
    check("warranty_claims_reject_check", sql`${t.status} <> 'REJECTED' OR length(btrim(coalesce(${t.rejectReason}, ''))) >= 3`),
    check("warranty_claims_money_check", sql`(${t.costVnd} IS NULL OR ${t.costVnd} >= 0) AND (${t.chargedVnd} IS NULL OR ${t.chargedVnd} >= 0)`),
  ],
);

/**
 * PHÒNG / CĂN CHO THUÊ NGẮN NGÀY (0198, module `stays`). `ical_token` là phần bí mật của đường dẫn lịch .ics ERP phát cho kênh
 * (`/api/ical/<mã tổ chức>.<token>`) — đổi được khi lộ.
 */
export const stayUnits = pgTable(
  "stay_units",
  {
    id: id(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    capacity: integer("capacity"),
    address: text("address").notNull().default(""),
    ownerName: text("owner_name").notNull().default(""),
    icalToken: text("ical_token").notNull(),
    active: boolean("active").notNull().default(true),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stay_units_code_uq").on(sql`lower(${t.code})`),
    uniqueIndex("stay_units_ical_token_uq").on(t.icalToken),
    check("stay_units_name_check", sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check("stay_units_code_check", sql`length(btrim(${t.code})) BETWEEN 1 AND 20`),
    check("stay_units_capacity_check", sql`${t.capacity} IS NULL OR ${t.capacity} BETWEEN 1 AND 100`),
    check("stay_units_token_check", sql`length(${t.icalToken}) >= 24`),
  ],
);

/**
 * ĐẶT PHÒNG (0198): khoảng NỬA MỞ [check_in, check_out). `source = 'ICAL'` ⇒ khoá tự nhiên (phòng, kênh, UID của kênh).
 * Trùng phòng KHÔNG chặn ở CSDL — hai kênh bán trùng là chuyện thật, phải hiện ra; đường ghi tay tự chặn. Tiền `NULL` = chưa
 * biết (luật 42).
 */
export const stayBookings = pgTable(
  "stay_bookings",
  {
    id: id(),
    unitId: text("unit_id")
      .notNull()
      .references(() => stayUnits.id, { onDelete: "cascade" }),
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("CONFIRMED"),
    source: text("source").notNull().default("MANUAL"),
    externalUid: text("external_uid"),
    summary: text("summary").notNull().default(""),
    guestName: text("guest_name").notNull().default(""),
    guestPhone: text("guest_phone").notNull().default(""),
    guests: integer("guests"),
    amountVnd: integer("amount_vnd"),
    note: text("note").notNull().default(""),
    cancelReason: text("cancel_reason"),
    cancelledAt: ts("cancelled_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stay_bookings_uid_uq").on(t.unitId, t.channel, t.externalUid).where(sql`${t.externalUid} IS NOT NULL`),
    index("stay_bookings_unit_dates_idx").on(t.unitId, t.checkIn, t.checkOut),
    index("stay_bookings_checkout_idx").on(t.checkOut),
    check("stay_bookings_dates_check", sql`${t.checkOut} > ${t.checkIn} AND ${t.checkOut} - ${t.checkIn} <= 365`),
    check("stay_bookings_channel_check", sql`${t.channel} IN ('AIRBNB','BOOKING','AGODA','TRAVELOKA','DIRECT','OTHER')`),
    check("stay_bookings_status_check", sql`${t.status} IN ('CONFIRMED','BLOCKED','CANCELLED')`),
    check("stay_bookings_source_check", sql`${t.source} IN ('MANUAL','ICAL')`),
    check("stay_bookings_uid_check", sql`(${t.source} = 'ICAL') = (${t.externalUid} IS NOT NULL)`),
    check("stay_bookings_cancel_check", sql`${t.status} <> 'CANCELLED' OR length(btrim(coalesce(${t.cancelReason}, ''))) >= 3`),
    check("stay_bookings_money_check", sql`${t.amountVnd} IS NULL OR ${t.amountVnd} >= 0`),
    check("stay_bookings_guests_check", sql`${t.guests} IS NULL OR ${t.guests} BETWEEN 1 AND 100`),
  ],
);

/** DỌN PHÒNG xong cho (phòng, ngày) (0198). Người dọn đi bằng khoá tài khoản (luật 34). */
export const stayTurnovers = pgTable(
  "stay_turnovers",
  {
    unitId: text("unit_id")
      .notNull()
      .references(() => stayUnits.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    doneAt: ts("done_at").notNull().defaultNow(),
    doneByUserId: text("done_by_user_id").references(() => users.id, { onDelete: "set null" }),
    doneByName: text("done_by_name").notNull().default(""),
    note: text("note").notNull().default(""),
  },
  (t) => [primaryKey({ name: "stay_turnovers_pk", columns: [t.unitId, t.day] })],
);

/** Sổ mỗi lượt nhập lịch .ics (0198), kể cả CHẠY THỬ — «ai đã nhập tệp nào, nó đổi gì». */
export const stayIcalImports = pgTable(
  "stay_ical_imports",
  {
    id: id(),
    unitId: text("unit_id")
      .notNull()
      .references(() => stayUnits.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    applied: boolean("applied").notNull(),
    checksum: text("checksum").notNull(),
    events: integer("events").notNull(),
    skipped: integer("skipped").notNull(),
    created: integer("created").notNull(),
    updated: integer("updated").notNull(),
    cancelled: integer("cancelled").notNull(),
    unchanged: integer("unchanged").notNull(),
    byUserId: text("by_user_id").references(() => users.id, { onDelete: "set null" }),
    byName: text("by_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("stay_ical_imports_unit_idx").on(t.unitId, t.createdAt)],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    variantId: text("variant_id"),
    serviceName: text("service_name").notNull(),
    staffUserId: text("staff_user_id").references(() => users.id, { onDelete: "set null" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    status: text("status").notNull().default("BOOKED"),
    packageId: text("package_id").references(() => customerPackages.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    cancelReason: text("cancel_reason"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    statusChangedAt: ts("status_changed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("appointments_starts_idx").on(t.startsAt),
    index("appointments_staff_starts_idx").on(t.staffUserId, t.startsAt),
    index("appointments_customer_idx").on(t.customerId, t.startsAt),
    index("appointments_package_idx").on(t.packageId),
    check("appointments_time_check", sql`${t.endsAt} > ${t.startsAt}`),
    check("appointments_status_check", sql`${t.status} IN ('BOOKED','CONFIRMED','CHECKED_IN','DONE','NO_SHOW','CANCELLED')`),
    check("appointments_cancel_check", sql`${t.status} <> 'CANCELLED' OR length(btrim(coalesce(${t.cancelReason}, ''))) >= 3`),
  ],
);

export const customerTradeTerms = pgTable(
  "customer_trade_terms",
  {
    customerId: text("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    priceListId: text("price_list_id").references(() => priceLists.id, { onDelete: "set null" }),
    creditLimit: integer("credit_limit"),
    paymentTermsDays: integer("payment_terms_days"),
    updatedByUserId: text("updated_by_user_id"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("customer_trade_terms_price_list_idx").on(t.priceListId),
    check("customer_trade_terms_credit_check", sql`${t.creditLimit} IS NULL OR ${t.creditLimit} >= 0`),
    check("customer_trade_terms_terms_check", sql`${t.paymentTermsDays} IS NULL OR ${t.paymentTermsDays} BETWEEN 0 AND 365`),
  ],
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

/**
 * LÔ & HẠN DÙNG (0199, module `lots`): lớp gắn thêm lên MỘT dòng phiếu kho dương. KHÔNG tham gia phép tính tồn nào (luật 10) —
 * «lô còn bao nhiêu» là ước tính lúc đọc (`lib/constants/lots.ts::estimateLotRemaining`).
 */
export const stockLots = pgTable(
  "stock_lots",
  {
    id: id(),
    receiptItemId: text("receipt_item_id")
      .notNull()
      .references(() => stockReceiptItems.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    lotCode: text("lot_code").notNull(),
    expiresOn: date("expires_on", { mode: "string" }).notNull(),
    producedOn: date("produced_on", { mode: "string" }),
    quantity: integer("quantity").notNull(),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("stock_lots_item_code_uq").on(t.receiptItemId, sql`lower(${t.lotCode})`),
    index("stock_lots_variant_idx").on(t.variantId, t.expiresOn),
    check("stock_lots_qty_check", sql`${t.quantity} > 0`),
    check("stock_lots_code_check", sql`length(btrim(${t.lotCode})) BETWEEN 1 AND 60`),
    check("stock_lots_dates_check", sql`${t.producedOn} IS NULL OR ${t.producedOn} <= ${t.expiresOn}`),
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
    /*
      Company OS · Agent U (0144): AI XÁC NHẬN MẪU MÃ, LÚC NÀO — tách hẳn khỏi `identified_*` (đó là LỚP 2:
      nối ĐƠN). Mẫu mã là lời xác nhận của NGƯỜI cầm món hàng (luật 34: khoá tài khoản + ảnh chụp tên do
      máy chủ đọc). NULL ở dòng cũ = CHƯA BIẾT ai chọn (không backfill — luật 35), không phải "máy chọn".
      Mốc và tên đi cùng nhau (CHECK `return_unidentified_variant_identified_check`).
    */
    variantIdentifiedAt: ts("variant_identified_at"),
    variantIdentifiedBy: text("variant_identified_by"),
    variantIdentifiedByUserId: text("variant_identified_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Ghi chú của lượt xác nhận — BẮT BUỘC khi ĐỔI mẫu đã gán (lý do), không bắt buộc khi gán lần đầu. */
    variantIdentifyNote: text("variant_identify_note"),

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
    /* Agent U (0144): một lượt xác nhận mẫu mã phải nói AI và LÚC NÀO — thiếu một trong hai là một lời
       khẳng định không truy được về người (luật 34). Dòng cũ có cả hai NULL ⇒ vẫn hợp lệ (không backfill). */
    check("return_unidentified_variant_identified_check", sql`(${t.variantIdentifiedAt} IS NULL) = (${t.variantIdentifiedBy} IS NULL)`),
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
    /**
     * Chuỗi "<page_id>_<post_id>" ĐÃ DÙNG để ra `post_id` — theo thứ tự `effective_object_story_id`
     * → `object_story_id` (`pickStoryFromCreative`). Cột nguồn ghi trường nào đã thắng.
     */
    storyId: text("story_id"),
    /**
     * ─── MẮT XÍCH MẪU → BÀI → MẨU (migration 0173) ───
     *
     * Cùng dòng với mẩu quảng cáo, không phải bảng mới: khoá tự nhiên là `ad_id`, và mọi truy vấn
     * quy kết đang đọc bảng này. `story_id` KHÔNG unique — một bài có sẵn được nhiều mẩu dùng lại,
     * đó chính là cách nối "một mẫu ảnh → nhiều mẩu → nhiều chiến dịch".
     *
     * `fetched_at` là "lần cuối hỏi Meta" (last synced); `post_resolved_at` là lần cuối RA ĐƯỢC bài.
     */
    creativeId: text("creative_id"),
    /** Fanpage tách từ `story_id`. `NULL` = chưa ra được bài — KHÔNG phải "không có fanpage". */
    pageId: text("page_id"),
    /** Hai trường THÔ của creative, lưu nguyên văn để truy nguyên kể cả khi hai trường khác nhau. */
    effectiveObjectStoryId: text("effective_object_story_id"),
    objectStoryId: text("object_story_id"),
    /** `EFFECTIVE_OBJECT_STORY_ID` · `OBJECT_STORY_ID` (`POST_RESOLUTION_SOURCES`). `NULL` = chưa ra bài. */
    postResolutionSource: text("post_resolution_source"),
    /** Tên fanpage lúc tra (Meta, hoặc sổ `fanpages` của ERP khi Meta không cho đọc). Ảnh chụp để đọc, không phải khoá. */
    pageName: text("page_name"),
    /** `permalink_url` do META trả. Link DỰNG từ page_id + post_id không bao giờ được ghi vào đây. */
    permalinkUrl: text("permalink_url"),
    postResolvedAt: ts("post_resolved_at"),
    /** Lỗi có cấu trúc của lần tra gần nhất (mã ổn định + mã Graph, ĐÃ CHE token). `NULL` = lần gần nhất không lỗi. */
    resolveError: jsonb("resolve_error").$type<{ code: string; graphCode: number | null; graphSubcode: number | null; message: string; fbtraceId: string; at: string }>(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("fb_ads_campaign_idx").on(t.campaignId),
    index("fb_ads_post_idx").on(t.postId),
    index("fb_ads_story_idx").on(t.storyId),
    index("fb_ads_page_post_idx").on(t.pageId, t.postId),
    index("fb_ads_creative_idx").on(t.creativeId),
    check("fb_ads_post_source_check", sql`${t.postResolutionSource} IS NULL OR ${t.postResolutionSource} IN ('EFFECTIVE_OBJECT_STORY_ID', 'OBJECT_STORY_ID')`),
  ],
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
    /**
     * `CreativeBatchKind` (migration 0145): `LOOP` = lô hằng ngày, MỘT lô mỗi ngày chạy (chỉ mục duy nhất
     * từng phần bên dưới); `INSTANT` = MỘT bài người bấm "Đăng camp" (ngay / hẹn giờ) — nhiều lô mỗi ngày,
     * khung giờ do người chọn, người bấm chính là lượt duyệt.
     */
    kind: text("kind").notNull().default("LOOP"),
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
    // Một lô HẰNG NGÀY mỗi ngày chạy; lô đăng lẻ (`INSTANT`) không chung khoá này.
    uniqueIndex("creative_batches_day_uq").on(t.batchDay).where(sql`${t.kind} = 'LOOP'`),
    index("creative_batches_status_idx").on(t.status),
    check("creative_batches_kind_check", sql`${t.kind} IN ('LOOP', 'INSTANT')`),
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
    /**
     * BÀI VIDEO (migration 0179, chủ shop 29/09/2026 — "ảnh/video tự tải lên"): video người tải lên (`video_scale_assets`
     * loại `AD_UPLOAD`). `NULL` = bài ảnh. Bài video vẫn có `image_id` — đó là ẢNH BÌA (khung hình người chọn), Facebook
     * bắt buộc có ảnh bìa cho `video_data`. Phiếu duyệt khoá cả băm của video.
     */
    videoAssetId: text("video_asset_id").references((): AnyPgColumn => videoScaleAssets.id, { onDelete: "set null" }),
    /** Id video trong thư viện của TKQC đăng bài (`act_x/advideos`). Rỗng = bài ảnh / chưa tải. */
    fbVideoId: text("fb_video_id").notNull().default(""),
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
    /**
     * `ManualGenKind` (migration 0143): `DESIGN` = mỗi ảnh là một THIẾT KẾ MỚI lai DNA của các mã cảm hứng;
     * `MOCKUP` = ảnh mới cho ĐÚNG sản phẩm của ảnh gốc (kiểu duy nhất trước 0143).
     */
    kind: text("kind").notNull().default("MOCKUP"),
    /** Lượt `DESIGN`: các mã bán tốt người chọn làm cảm hứng (theo thứ tự người chọn). */
    inspirationProductIds: text("inspiration_product_ids").array().notNull().default(sql`'{}'::text[]`),
    /**
     * Ảnh đầu vào NGƯỜI TẢI LÊN ngay trong khối gen tay (migration 0145, chủ shop 26/09/2026) — `creative_images.id`,
     * gửi máy vẽ KÈM ảnh sản phẩm thật (không thay nó: ranh giới 3 vẫn cần một ảnh sản phẩm thật). Chỉ đường ghi
     * của nút bấm điền cột này, cùng lúc lưu điểm ảnh — không nhận id ảnh có sẵn từ trình duyệt, để không ai
     * trỏ được một ảnh spy vào máy vẽ.
     */
    uploadImageIds: text("upload_image_ids").array().notNull().default(sql`'{}'::text[]`),
    /**
     * Lượt `EDIT` (migration 0156, chủ shop 27/09/2026): ẢNH GEN TAY được sửa — máy vẽ nhận đúng ảnh ấy + yêu cầu sửa
     * (`idea`). `NULL` ở mọi kiểu khác, và khi ảnh gốc bị xoá (lượt sửa vẫn còn).
     */
    sourceGenImageId: text("source_gen_image_id").references((): AnyPgColumn => creativeManualGenImages.id, { onDelete: "set null" }),
    idea: text("idea").notNull().default(""),
    requested: integer("requested").notNull(),
    model: text("model").notNull(),
    size: text("size").notNull(),
    quality: text("quality").notNull(),
    /** Vì sao một phần không được vẽ ngay lúc bấm (chạm trần). Rỗng = xin đủ. */
    note: text("note").notNull().default(""),
    /**
     * Studio (migration 0174, chủ shop 29/09/2026): tuỳ chọn người chọn lúc bấm — số mẫu, kiểu ảnh đầu ra, biến thể màu, khổ,
     * chất lượng (`StudioOptions` + `units`). Để "Tạo lại tương tự" điền lại đúng form. `{}` = lượt trước khi có studio.
     */
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("creative_manual_gens_created_idx").on(t.createdAt), check("creative_manual_gens_kind_check", sql`${t.kind} IN ('MOCKUP', 'DESIGN', 'UPLOAD', 'EDIT')`)],
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
    /** Biến thể màu người chọn cho ảnh này (migration 0174). Rỗng = giữ màu gốc / màu DNA. */
    color: text("color").notNull().default(""),
    /** Kiểu ảnh đầu ra (`OutputStyle`, migration 0174). Rỗng = lượt trước khi có studio; `AUTO` = máy tự chọn. */
    outputStyle: text("output_style").notNull().default(""),
    /**
     * Lượt `DESIGN`: bản mô tả THIẾT KẾ MỚI của ảnh này (`ManualDesignSpec` — DNA đủ mười thuộc tính, mã cha,
     * nguồn ảnh tham chiếu, giá đề nghị, lý do). `NULL` ở lượt `MOCKUP`. Mã `TK-…` chỉ cấp khi đưa vào lô.
     */
    design: jsonb("design").$type<Record<string, unknown>>(),
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
    /**
     * HÀNG ĐỢI ĐĂNG CAMP (migration 0148, chủ shop 26/09/2026): người soạn xong câu chữ + ba tên rồi bấm "Lưu" ⇒
     * bài nằm ở hàng đợi, bấm "Đăng camp" lúc nào cũng được. Ba tên rỗng = tên mặc định theo khuôn lúc đăng.
     * `queued_at` có ⇔ bài đang ở hàng đợi (còn `APPROVED`); đăng / đưa vào lô xong ⇒ `PROMOTED`, tự rời hàng đợi.
     */
    campaignName: text("campaign_name").notNull().default(""),
    adsetName: text("adset_name").notNull().default(""),
    adName: text("ad_name").notNull().default(""),
    queuedAt: ts("queued_at"),
    /** QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (mục 34); tên là ảnh chụp do máy chủ đọc. */
    queuedByUserId: text("queued_by_user_id").references(() => users.id, { onDelete: "set null" }),
    queuedByName: text("queued_by_name").notNull().default(""),
    /**
     * SETUP CAMP đã chọn cho bài ở hàng đợi (migration 0150): TKQC · fanpage · mục tiêu · ngân sách · vị trí · tuổi ·
     * giới tính (`CampaignSetup`). `NULL` = chưa chọn ⇒ hộp đăng điền mặc định theo lựa chọn dùng nhiều.
     */
    campaignSetup: jsonb("campaign_setup").$type<Record<string, unknown>>(),
    /**
     * MẪU TỰ LÀM LÀ VIDEO (migration 0179): video người tải lên; `image_id` là ảnh bìa (khung hình trích ở trình duyệt) — AI viết
     * content nhìn ảnh bìa này. `NULL` = mẫu ảnh.
     */
    videoAssetId: text("video_asset_id").references((): AnyPgColumn => videoScaleAssets.id, { onDelete: "set null" }),
    /**
     * Video đã tải lên thư viện TKQC nào: `{ "<id TKQC>": "<id video>" }`. Một video tải lên TKQC này không dùng được ở
     * TKQC khác — đăng lại sang TKQC mới thì tải thêm một lần, bấm lại cùng TKQC thì KHÔNG tải lại.
     */
    fbVideos: jsonb("fb_videos").$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("creative_manual_gen_images_gen_seq_uq").on(t.genId, t.seq),
    index("creative_manual_gen_images_queue_idx").on(t.queuedAt),
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

// ═══ NỀN TẢNG — mặt phẳng điều khiển (docs/platform/shared-contracts.md mục 2) ═══
//
// Bốn bảng này CHỈ có nghĩa trong CSDL NHÀ (`DATABASE_URL`) và chỉ được đọc/ghi qua
// `getPlatformDb()`. Vì mọi tổ chức dùng CÙNG một bộ migration, CSDL của tổ chức khác cũng có bốn
// bảng này nhưng RỖNG và không ai đọc — `/platform/health` kiểm điều đó. Dữ liệu nghiệp vụ không
// có cột tổ chức nào: mỗi tổ chức một CSDL, CSDL chính là ranh giới (target-architecture P1).

/** Sổ tổ chức. `code` BẤT BIẾN — nó nằm trong JWT, khoá đệm và tên CSDL. */
export const platformOrganizations = pgTable(
  "platform_organizations",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** `ACTIVE` · `SUSPENDED` · `ARCHIVED` · `SETUP_FAILED` (dựng dở, 0169) — chỉ `ACTIVE` đăng nhập / chạy job được. */
    status: text("status").notNull().default("ACTIVE"),
    /** ĐÚNG MỘT dòng `true`: tổ chức có CSDL là `DATABASE_URL` (tổ chức có từ trước nền tảng). */
    isHome: boolean("is_home").notNull().default(false),
    /** Dòng module THIẾU nghĩa là gì: `ENABLED` (tổ chức nhà — như trước nền tảng) · `DISABLED` (tổ chức mới). */
    moduleDefault: text("module_default").notNull().default("DISABLED"),
    /** Khoá gói (`platform_plans.key`, 0169). Tổ chức nhà LUÔN là `internal` trong mã; tổ chức khác thiếu ⇒ `trial` (lib/entitlements). */
    plan: text("plan"),
    templateKey: text("template_key"),
    settings: jsonb("settings").notNull().default({}),
    /**
     * Vòng đời khách pilot (0177): `CREATED` · `CONFIGURING` · `READY_FOR_UAT` · `ACTIVE`. TÁCH khỏi `status` — `status`
     * nói "có được chạy không" (SUSPENDED là công tắc khẩn), cột này nói "khách đang ở bước nào". `NULL` = không theo
     * dõi (tổ chức nhà / tổ chức có từ trước 0177) — không backfill. Chỉ `lib/platform/pilot.ts` ghi.
     */
    pilotStage: text("pilot_stage"),
    /**
     * Tên miền con do KHÁCH chọn (0180): `<domain_slug>.<PLATFORM_BASE_DOMAIN>`. Khác `code` (bất biến, nằm trong JWT
     * và tên CSDL): slug đổi được tới lúc xuất bản. UNIQUE khi có. Chỉ `lib/platform/publish.ts` ghi.
     */
    domainSlug: text("domain_slug"),
    /** `NULL` = không theo dõi (nhà / tổ chức có từ trước 0180) · `DRAFT` · `PUBLISHED`. Chỉ `lib/platform/publish.ts` ghi. */
    publishState: text("publish_state"),
    publishedAt: ts("published_at"),
    publishedBy: text("published_by"),
    /**
     * Thương hiệu nơi khách TỰ đăng ký (0215): `vnx` · `chotdon` — quyết định liên kết gửi cho người của tổ chức về phần mềm
     * nào (`organizationBaseUrl`). `NULL` = không theo dõi (nhà, tổ chức cũ, người vận hành tạo hộ) ⇒ như trước. Ghi MỘT
     * lần lúc tạo (lib/platform/provision.ts), không backfill.
     */
    brand: text("brand"),
    /**
     * TÀI KHOẢN THƯƠNG MẠI sở hữu workspace này (0224 · docs/saas/README.md). Workspace = tổ chức = ranh giới cô lập (một CSDL).
     * Backfill 0224: mỗi workspace có từ trước một tài khoản riêng; gộp là việc tay của người vận hành. `NULL` chỉ tồn tại
     * trước khi migration chạy — đọc như "chưa gắn tài khoản", không đoán. Chỉ `lib/saas/*` ghi.
     */
    accountId: text("account_id").references((): AnyPgColumn => platformAccounts.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("platform_organizations_code_key").on(t.code),
    index("platform_organizations_account_idx").on(t.accountId),
    check("platform_organizations_brand_check", sql`${t.brand} IS NULL OR ${t.brand} IN ('vnx','chotdon')`),
    uniqueIndex("platform_organizations_domain_slug_key").on(t.domainSlug).where(sql`${t.domainSlug} IS NOT NULL`),
    check("platform_organizations_domain_slug_check", sql`${t.domainSlug} IS NULL OR ${t.domainSlug} ~ '^[a-z][a-z0-9-]{1,30}$'`),
    check("platform_organizations_publish_state_check", sql`${t.publishState} IS NULL OR ${t.publishState} IN ('DRAFT','PUBLISHED')`),
    uniqueIndex("platform_organizations_one_home").on(t.isHome).where(sql`${t.isHome}`),
    check("platform_organizations_status_check", sql`${t.status} in ('ACTIVE','SUSPENDED','ARCHIVED','SETUP_FAILED')`),
    check("platform_organizations_module_default_check", sql`${t.moduleDefault} in ('ENABLED','DISABLED')`),
    check("platform_organizations_code_check", sql`${t.code} ~ '^[a-z][a-z0-9-]{1,30}$'`),
    check("platform_organizations_pilot_stage_check", sql`${t.pilotStage} IS NULL OR ${t.pilotStage} IN ('CREATED','CONFIGURING','READY_FOR_UAT','ACTIVE')`),
  ],
);

/**
 * Gói dịch vụ + hạn mức (Phase 10 · §5, 0169). `limits` = `{ users, pages, objects, records, workflows, aiDraftsPerDay,
 * storageMb }`, mỗi ô là số hoặc `null` (= không giới hạn). Ba gói gieo bằng migration — dữ liệu cấu hình của nền tảng.
 */
export const platformPlans = pgTable(
  "platform_plans",
  {
    key: text("key").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /** Ô số (`null` = không giới hạn) + khoá `ai` (0176) là một đối tượng — `lib/ai-usage/types.ts::parseAiLimits`. */
    limits: jsonb("limits").$type<Record<string, unknown>>().notNull().default({}),
    position: integer("position").notNull().default(0),
    /** Giá MỘT THÁNG, nguyên VND (0187). `NULL` = gói KHÔNG BÁN — không phải giá 0; khách chỉ tự chọn được gói có giá. */
    priceVnd: integer("price_vnd"),
    /**
     * Đơn giá MUA THÊM (0192): `{ <hạng mục>: VND cho MỘT bước / tháng }` — bước nằm ở `lib/billing/addons.ts::ADDON_STEP`.
     * Thiếu khoá = gói này KHÔNG bán thêm hạng mục đó. Không gieo giá nào: giá là quyết định của chủ nền tảng (luật 38).
     */
    addonPrices: jsonb("addon_prices").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Trả 12 tháng thì TẶNG bấy nhiêu tháng (0194): tiền của lần gia hạn 12 tháng = giá tháng × (12 − số này). 0 = không
     * giảm. Giảm giá là quyết định kinh doanh nên nó là MỘT CỘT đọc được, không phải một phép nhân giấu trong mã (luật 38).
     */
    yearlyFreeMonths: integer("yearly_free_months").notNull().default(0),
    /**
     * Gói phủ SẢN PHẨM nào (0224, khoá trong `lib/saas/catalog.ts`). `NULL` = gói GỘP — phủ mọi sản phẩm của workspace, như
     * mọi gói bán từ trước 0224 ("phần mềm bán hàng + chatbot AI trong một gói"). Gói riêng một sản phẩm khai mảng.
     */
    productKeys: text("product_keys").array(),
    /**
     * Phần THƯƠNG MẠI của gói (0222 · docs/platform/pricing-billing-foundation.md): số ngày dùng thử, hiện ở /pricing không,
     * «Liên hệ», hạn mức theo THÁNG (fanpage · hội thoại AI · tin AI · đơn), tính năng (entitlement), chính sách vượt, mức áp
     * hạn mức. Đọc DUY NHẤT qua `lib/pricing/catalog.ts::parseCommercial` — ô thiếu = CHƯA KHAI (màn hình nói ra), không đoán.
     */
    commercial: jsonb("commercial").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("platform_plans_key_check", sql`${t.key} ~ '^[a-z][a-z0-9-]{1,30}$'`),
    check("platform_plans_price_check", sql`${t.priceVnd} IS NULL OR ${t.priceVnd} > 0`),
    check("platform_plans_yearly_free_check", sql`${t.yearlyFreeMonths} BETWEEN 0 AND 3`),
  ],
);

/** Mã mời tự đăng ký (Phase 10 · §1). Chỉ lưu BĂM sha256 — mã thô hiện đúng một lần lúc tạo. Dùng một lần, có hạn. */
export const platformSignupInvites = pgTable(
  "platform_signup_invites",
  {
    id: id(),
    codeHash: text("code_hash").notNull(),
    note: text("note"),
    planKey: text("plan_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    createdByOrg: text("created_by_org"),
    createdByUserId: text("created_by_user_id"),
    createdByEmail: text("created_by_email"),
    usedAt: ts("used_at"),
    organizationCode: text("organization_code"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("platform_signup_invites_hash_key").on(t.codeHash),
    check("platform_signup_invites_hash_check", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check("platform_signup_invites_used_check", sql`(${t.usedAt} IS NULL) = (${t.organizationCode} IS NULL)`),
  ],
);

/**
 * MÃ XÁC MINH SĐT KHI ĐĂNG KÝ (0214 · lib/onboarding/phone-otp.ts): mỗi lần gửi một dòng. Mã KHÔNG lưu thô — chỉ băm có khoá
 * (`AUTH_SECRET`); IP chỉ lưu băm. Bảng này cũng là nguồn ĐẾM của trần gửi (theo SĐT / theo IP / toàn nền tảng) — mỗi tin
 * Zalo ZNS là tiền thật.
 */
export const platformPhoneOtps = pgTable(
  "platform_phone_otps",
  {
    id: id(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    ipHash: text("ip_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** `SENT` · `FAILED` (Zalo từ chối — vẫn tính vào trần, vì một lượt gọi hỏng vẫn có thể là lượt dò). */
    status: text("status").notNull(),
    error: text("error"),
  },
  (t) => [
    index("platform_phone_otps_phone_at_idx").on(t.phone, t.createdAt),
    index("platform_phone_otps_ip_at_idx").on(t.ipHash, t.createdAt),
    check("platform_phone_otps_status_check", sql`${t.status} in ('SENT','FAILED')`),
  ],
);

/** Mỗi lượt thử đăng ký / nhập mã mời — nguồn ĐẾM của trần theo IP (băm) và theo ngày. Không giữ IP thô. */
export const platformSignupAttempts = pgTable(
  "platform_signup_attempts",
  {
    id: id(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    mode: text("mode").notNull(),
    ipHash: text("ip_hash").notNull(),
    organizationCode: text("organization_code"),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
  },
  (t) => [
    index("platform_signup_attempts_ip_at_idx").on(t.ipHash, t.at),
    index("platform_signup_attempts_at_idx").on(t.at),
    check("platform_signup_attempts_mode_check", sql`${t.mode} in ('invite','open','operator')`),
    check("platform_signup_attempts_outcome_check", sql`${t.outcome} in ('CREATED','FAILED','REJECTED','INVITE_REJECTED')`),
  ],
);

/** Cấu hình module theo tổ chức. Khoá module khai ở `lib/constants/platform-modules.ts` và BẤT BIẾN. */
export const platformOrganizationModules = pgTable(
  "platform_organization_modules",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => platformOrganizations.id),
    moduleKey: text("module_key").notNull(),
    enabled: boolean("enabled").notNull(),
    /** `{ "<module>.<feature>": boolean }` — ghi đè mặc định của feature. */
    features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
    config: jsonb("config").notNull().default({}),
    enabledAt: ts("enabled_at"),
    disabledAt: ts("disabled_at"),
    /** `"<mã tổ chức>:<id tài khoản>"` hoặc `"system:<nguồn>"`. */
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("platform_organization_modules_pk").on(t.organizationId, t.moduleKey)],
);

/** Cờ NỀN TẢNG theo tổ chức (khác cấu hình module — target-architecture P11). */
export const platformFlagOverrides = pgTable(
  "platform_flag_overrides",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => platformOrganizations.id),
    flagKey: text("flag_key").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("platform_flag_overrides_pk").on(t.organizationId, t.flagKey)],
);

/**
 * Cài đặt của NỀN TẢNG (không thuộc tổ chức nào) — 0172. Khoá dạng `platform.<miền>.<tên>`, giá trị jsonb.
 *
 * Mục đầu tiên: `platform.signup.mode` (`off` · `invite` · `open`) — người vận hành bật `/start` ở `/platform` mà KHÔNG
 * cần deploy. Hiệu lực = min(trần môi trường `PLATFORM_SIGNUP_MODE`, cài đặt này) — `lib/onboarding/signup-mode.ts`.
 * THIẾU dòng ⇒ `off`. Ràng buộc CHECK giữ giá trị trong tập đóng, để một lượt ghi tay sai chính tả không mở cửa.
 * Mọi lượt đổi ghi `platform_audit_log` (`SIGNUP_MODE_SET`).
 */
export const platformSettings = pgTable(
  "platform_settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedAt: updatedAt(),
    /** `"<mã tổ chức>:<id tài khoản>"` — cùng khuôn `platform_organization_modules.updated_by`. */
    updatedBy: text("updated_by"),
    updatedByEmail: text("updated_by_email"),
  },
  () => [check("platform_settings_signup_mode_check", sql`"key" <> 'platform.signup.mode' OR ("value" #>> '{}') IN ('off','invite','open')`)],
);

/**
 * SỔ DÙNG AI THỐNG NHẤT (0176 · docs/platform/ai-usage.md) — mặt phẳng điều khiển, chỉ thật ở CSDL NHÀ. Một dòng cho MỘT
 * lượt AI (một bản nháp AI Builder = một dòng, `requests` = số lời gọi model của lượt đó; một câu hỏi Copilot = một dòng).
 * Ghi DUY NHẤT qua `recordAiUsage()` (`lib/ai-usage/ledger.ts`). Không lưu prompt, câu trả lời hay khoá.
 *
 *  · `billing_source` — AI TRẢ TIỀN: `BYOK` (khoá của chính tổ chức) · `PLATFORM` (credit của nền tảng) · `HOME` (khoá
 *    `.env` của tổ chức nhà). Hạn mức đếm RIÊNG theo nguồn: BYOK của A không bao giờ trừ vào credit nền tảng.
 *  · `cost_usd` / token `NULL` = CHƯA BIẾT (model chưa có trong bảng giá, lời gọi hỏng giữa chừng) — không phải 0 (luật 42).
 *  · `status` `BLOCKED_QUOTA` = hạn mức chặn TRƯỚC khi gọi model: `requests = 0`, không token, không tiền.
 */
export const platformAiUsage = pgTable(
  "platform_ai_usage",
  {
    id: id(),
    at: ts("at").notNull().defaultNow(),
    orgCode: text("org_code").notNull(),
    feature: text("feature").notNull(),
    billingSource: text("billing_source").notNull(),
    provider: text("provider"),
    model: text("model"),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),
    status: text("status").notNull(),
    /** Khoá tài khoản người bấm (luật 34) — `NULL` = máy. */
    actorId: text("actor_id"),
    /** Id dòng của miền sinh ra lượt (bản nháp AI, lượt Copilot) — để tra ngược, không mang nội dung. */
    ref: text("ref"),
    /**
     * KHOÁ SỰ KIỆN (0222): cùng tổ chức + cùng khoá ⇒ chỉ MỘT dòng. Lượt thử lại của cùng một lời gọi AI mang cùng khoá nên
     * không bị tính tiền hai lần. `NULL` = nơi gọi chưa truyền khoá (dòng cũ, đường ghi chưa nối) — vẫn ghi như trước.
     */
    eventKey: text("event_key"),
    /** Hội thoại khách sinh ra lượt (0222) — để tính chi phí AI / hội thoại chính xác. `NULL` = chưa biết. */
    conversationId: text("conversation_id"),
    /** `TEXT` · `VISION` (đọc ảnh khách gửi) · `IMAGE` (vẽ ảnh) — 0222. `NULL` = nơi gọi chưa khai. */
    modality: text("modality"),
    /**
     * QUAN SÁT (0231) — KHÔNG đổi nghĩa `input_tokens` / `output_tokens` / `cost_usd`. `thinking_tokens` ⊂ `output_tokens` (phần
     * suy nghĩ); `cached_tokens` ⊂ `input_tokens` (đọc từ bộ đệm); `latency_ms` = thời gian lời gọi model; `workload` = loại việc
     * của Platform AI Policy. `NULL` = chưa đo (dòng cũ / nhà cung cấp không tách), không phải 0.
     */
    cachedTokens: integer("cached_tokens"),
    thinkingTokens: integer("thinking_tokens"),
    latencyMs: integer("latency_ms"),
    workload: text("workload"),
  },
  (t) => [
    uniqueIndex("platform_ai_usage_org_event_key").on(t.orgCode, t.eventKey).where(sql`${t.eventKey} IS NOT NULL`),
    check("platform_ai_usage_modality_check", sql`${t.modality} IS NULL OR ${t.modality} IN ('TEXT','VISION','IMAGE')`),
    check("platform_ai_usage_workload_check", sql`${t.workload} IS NULL OR ${t.workload} IN ('sales_chatbot','order_sync','quick_extract','vision')`),
    check("platform_ai_usage_event_key_check", sql`${t.eventKey} IS NULL OR length(${t.eventKey}) BETWEEN 1 AND 200`),
    index("platform_ai_usage_org_at_idx").on(t.orgCode, t.at),
    index("platform_ai_usage_at_idx").on(t.at),
    check("platform_ai_usage_source_check", sql`${t.billingSource} in ('BYOK','PLATFORM','HOME')`),
    check("platform_ai_usage_status_check", sql`${t.status} in ('OK','ERROR','BLOCKED_QUOTA')`),
    check("platform_ai_usage_feature_check", sql`${t.feature} ~ '^[a-z][a-z0-9_]{1,40}$'`),
    check("platform_ai_usage_requests_check", sql`${t.requests} >= 0`),
  ],
);

/**
 * THU PHÍ THUÊ BAO (0187 · docs/platform/billing.md) — mặt phẳng điều khiển, chỉ thật ở CSDL NHÀ.
 *
 * MỘT dòng cho mỗi tổ chức ĐÃ BẬT thu phí. Tình trạng (còn hạn · sắp hết · quá hạn · chỉ xem) KHÔNG lưu: nó là hàm thuần
 * của `paid_through` + `grace_days` + hôm nay (`lib/billing/rules.ts::billingStanding`), nên đúng tới từng ngày mà không
 * cần job nào chạy đúng giờ (cùng tinh thần luật 26). Thiếu dòng / `billing_enabled = false` ⇒ KHÔNG thu phí, không bao
 * giờ khoá — tổ chức có từ trước 0187 (khách pilot) không đổi gì sau lần deploy này.
 */
/**
 * CHỈ MỤC DANH TÍNH TOÀN NỀN TẢNG (0193, docs/platform/quick-start.md). Tài khoản sống trong CSDL của TỪNG tổ chức
 * (SILO), nên trước bảng này muốn đăng nhập phải biết mã tổ chức hoặc vào đúng tên miền con. Một dòng = «danh tính này
 * là tài khoản `user_id` của tổ chức `org_code`»:
 *  · `EMAIL` / `PHONE` — ghi khi đăng nhập thành công (mọi đường đi qua `verifyLogin`) và khi đăng ký nhanh;
 *  · `GOOGLE` / `FACEBOOK` — `value` = mã người dùng của nhà cung cấp (`sub` / `id`), ghi khi đăng nhập bằng nút đó.
 * Chỉ là CHỈ MỤC: mật khẩu, quyền, trạng thái khoá vẫn đọc ở CSDL tổ chức mỗi lượt. Dòng trỏ tới tài khoản đã xoá / tổ
 * chức đã đình chỉ thì bị bỏ qua lúc đọc, không bao giờ mở được phiên.
 */
export const platformIdentities = pgTable(
  "platform_identities",
  {
    id: id(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    orgCode: text("org_code").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [
    uniqueIndex("platform_identities_kind_value_org_key").on(t.kind, t.value, t.orgCode),
    index("platform_identities_org_user_idx").on(t.orgCode, t.userId),
    check("platform_identities_kind_check", sql`${t.kind} IN ('EMAIL','PHONE','GOOGLE','FACEBOOK')`),
  ],
);

/**
 * PAGE MESSENGER ⇒ TỔ CHỨC (0207 · lib/sales-chatbot/messenger.ts). Webhook Messenger của Meta tới MỘT địa chỉ chung cho
 * mọi page — mã page trong gói tin là chứng cứ duy nhất «tin này của ai». Một page chỉ thuộc MỘT tổ chức (khoá chính):
 * tổ chức khác nối cùng page ⇒ bị từ chối, không cướp. Chỉ là chỉ mục: token page nằm (mã hoá) ở CSDL của tổ chức.
 */
export const platformMessengerPages = pgTable("platform_messenger_pages", {
  pageId: text("page_id").primaryKey(),
  orgCode: text("org_code").notNull(),
  pageName: text("page_name"),
  connectedByEmail: text("connected_by_email"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const platformSubscriptions = pgTable(
  "platform_subscriptions",
  {
    orgCode: text("org_code").primaryKey(),
    billingEnabled: boolean("billing_enabled").notNull().default(false),
    /** Ngày CUỐI CÙNG đã trả (giờ Việt Nam, tính cả ngày đó). Bật thu phí bắt buộc khai — đó cũng là hạn dùng thử. */
    paidThrough: date("paid_through", { mode: "string" }),
    graceDays: integer("grace_days").notNull().default(7),
    note: text("note"),
    /**
     * Hạn mức ĐÃ MUA THÊM (0192): `{ <hạng mục>: số đơn vị }` theo đơn vị của hạn mức (người dùng, MB…). Cộng vào hạn
     * mức gói ở `lib/entitlements/check.ts::resolvePlan`; giữ qua các lần gia hạn / đổi gói. Chỉ `lib/billing/service.ts` ghi.
     */
    addons: jsonb("addons").$type<Record<string, unknown>>().notNull().default({}),
    /** Thông tin xuất hoá đơn VAT khách khai (0192, `lib/billing/addons.ts::InvoiceInfo`). `NULL` = chưa khai. */
    invoiceInfo: jsonb("invoice_info").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("platform_subscriptions_grace_check", sql`${t.graceDays} BETWEEN 0 AND 60`),
    check("platform_subscriptions_enabled_check", sql`${t.billingEnabled} = false OR ${t.paidThrough} IS NOT NULL`),
  ],
);

/**
 * HOÁ ĐƠN GIA HẠN (0187). Một yêu cầu trả tiền cho `months` tháng của gói `plan_key`, kỳ `period_start` → `period_end`.
 * Trả đủ ⇒ `paid_through = period_end` và gói của tổ chức đổi sang `plan_key` NGAY. `credit_vnd` = phần chưa dùng của gói
 * cũ khi NÂNG gói giữa kỳ. Tối đa MỘT hoá đơn `OPEN` mỗi tổ chức — tạo cái mới thì cái cũ thành `VOID` (kèm lý do).
 */
export const platformInvoices = pgTable(
  "platform_invoices",
  {
    id: id(),
    orgCode: text("org_code").notNull(),
    planKey: text("plan_key").notNull(),
    months: integer("months").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    listAmountVnd: integer("list_amount_vnd").notNull(),
    creditVnd: integer("credit_vnd").notNull().default(0),
    amountVnd: integer("amount_vnd").notNull(),
    /** Nội dung chuyển khoản `ERPHD` + 6 ký tự — khoá để khớp tiền về với hoá đơn. */
    transferCode: text("transfer_code").notNull(),
    status: text("status").notNull().default("OPEN"),
    createdByEmail: text("created_by_email"),
    paidAt: ts("paid_at"),
    paidAmountVnd: integer("paid_amount_vnd"),
    /** `BANK` = khớp tự động từ sổ ngân hàng của nhà · `MANUAL` = người vận hành xác nhận tay (bắt buộc lý do). */
    paidSource: text("paid_source"),
    paidRef: text("paid_ref"),
    paidByEmail: text("paid_by_email"),
    voidReason: text("void_reason"),
    /**
     * Loại hoá đơn (0192): `RENEWAL` = gia hạn / đổi gói (như 0187) · `ADDON` = mua thêm hạn mức giữa kỳ — `months = 0`,
     * kỳ = hôm nay → `paid_through`, trả xong CỘNG `addon_units` vào `platform_subscriptions.addons`, KHÔNG đổi ngày trả tới
     * hay gói.
     */
    kind: text("kind").notNull().default("RENEWAL"),
    addonKind: text("addon_kind"),
    addonUnits: integer("addon_units"),
    /** Ảnh chụp phần mua thêm đã tính vào giá của hoá đơn GIA HẠN (để đọc lại vì sao số tiền là vậy). */
    addons: jsonb("addons").$type<Record<string, unknown>>().notNull().default({}),
    /** Ảnh chụp thông tin xuất hoá đơn VAT lúc tạo — `NULL` = khách không yêu cầu hoá đơn VAT cho lần trả này. */
    invoiceInfo: jsonb("invoice_info").$type<Record<string, unknown>>(),
    /** Người vận hành đã xuất hoá đơn VAT bên ngoài ERP: lúc nào, số hoá đơn, ai ghi. */
    vatIssuedAt: ts("vat_issued_at"),
    vatRef: text("vat_ref"),
    vatIssuedByEmail: text("vat_issued_by_email"),
    /** Phiên bản giá của hoá đơn (0228). `NULL` = hoá đơn trước 0228 = giá legacy. */
    priceVersionKey: text("price_version_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("platform_invoices_transfer_code_key").on(t.transferCode),
    uniqueIndex("platform_invoices_one_open").on(t.orgCode).where(sql`${t.status} = 'OPEN'`),
    index("platform_invoices_org_idx").on(t.orgCode, t.createdAt),
    check("platform_invoices_status_check", sql`${t.status} IN ('OPEN','PAID','VOID')`),
    check("platform_invoices_kind_check", sql`${t.kind} IN ('RENEWAL','ADDON')`),
    check(
      "platform_invoices_months_check",
      sql`(${t.kind} = 'RENEWAL' AND ${t.months} BETWEEN 1 AND 12 AND ${t.addonKind} IS NULL) OR (${t.kind} = 'ADDON' AND ${t.months} = 0 AND ${t.addonKind} IS NOT NULL AND ${t.addonUnits} > 0)`,
    ),
    check("platform_invoices_vat_check", sql`${t.vatIssuedAt} IS NULL OR (${t.invoiceInfo} IS NOT NULL AND ${t.status} = 'PAID' AND ${t.vatRef} IS NOT NULL)`),
    check("platform_invoices_amount_check", sql`${t.amountVnd} > 0 AND ${t.listAmountVnd} > 0 AND ${t.creditVnd} >= 0 AND ${t.amountVnd} = ${t.listAmountVnd} - ${t.creditVnd}`),
    check("platform_invoices_period_check", sql`${t.periodEnd} >= ${t.periodStart}`),
    check("platform_invoices_paid_check", sql`(${t.status} = 'PAID') = (${t.paidAt} IS NOT NULL)`),
    check("platform_invoices_source_check", sql`${t.paidSource} IS NULL OR ${t.paidSource} IN ('BANK','MANUAL')`),
    check("platform_invoices_code_check", sql`${t.transferCode} ~ '^ERPHD[0-9A-Z]{6}$'`),
  ],
);

/**
 * TIỀN VÀO MANG MÃ THANH TOÁN (0187). Mọi giao dịch có mã `ERPHD…` trong sổ ngân hàng của nhà được ghi ĐÚNG MỘT dòng ở
 * đây (khoá `bank_ref`), khớp được hay không: `MATCHED` · `UNDERPAID` (thiếu tiền — chưa gia hạn) · `INVOICE_NOT_OPEN`
 * (hoá đơn đã trả / đã huỷ) · `NO_INVOICE`. Ba loại sau là việc của người vận hành — tiền không khớp không được biến mất.
 */
export const platformBillingPayments = pgTable(
  "platform_billing_payments",
  {
    id: id(),
    bankRef: text("bank_ref").notNull(),
    txnAt: ts("txn_at").notNull(),
    amountVnd: integer("amount_vnd").notNull(),
    description: text("description").notNull().default(""),
    transferCode: text("transfer_code").notNull(),
    invoiceId: text("invoice_id"),
    orgCode: text("org_code"),
    outcome: text("outcome").notNull(),
    resolvedAt: ts("resolved_at"),
    resolvedByEmail: text("resolved_by_email"),
    resolvedNote: text("resolved_note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("platform_billing_payments_bank_ref_key").on(t.bankRef), check("platform_billing_payments_outcome_check", sql`${t.outcome} IN ('MATCHED','UNDERPAID','INVOICE_NOT_OPEN','NO_INVOICE')`)],
);

/**
 * SỔ KINH TẾ SAAS (0203 · docs/productization/11_SAAS_METRICS_SPEC.md) — mặt phẳng điều khiển, chỉ thật ở CSDL NHÀ.
 * MỘT ảnh chụp mỗi (ngày giờ VN, tổ chức). Dòng hôm nay còn ghi lại được trong ngày; ngày đã qua ĐÓNG BĂNG — chỉ
 * `lib/platform/saas-ledger.ts` ghi, và nó không bao giờ ghi ngày cũ. `mrr_vnd` NULL = CHƯA BIẾT, khác 0.
 */
export const platformSaasDaily = pgTable(
  "platform_saas_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    orgCode: text("org_code").notNull(),
    orgStatus: text("org_status").notNull(),
    isHome: boolean("is_home").notNull().default(false),
    planKey: text("plan_key").notNull(),
    billingEnabled: boolean("billing_enabled").notNull().default(false),
    /** `lib/billing/rules.ts::BillingStandingKind` của ngày chụp. */
    standing: text("standing").notNull(),
    /** Tính vào MRR (tổ chức chạy · đang thu phí · chưa khoá · gói có giá). */
    paying: boolean("paying").notNull().default(false),
    mrrVnd: integer("mrr_vnd"),
    /** Vì sao MRR chưa biết / thiếu một phần (phần mua thêm không còn giá…). */
    mrrNote: text("mrr_note"),
    capturedAt: ts("captured_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "platform_saas_daily_pkey", columns: [t.day, t.orgCode] }),
    index("platform_saas_daily_org_day_idx").on(t.orgCode, t.day),
    check("platform_saas_daily_mrr_check", sql`${t.mrrVnd} IS NULL OR ${t.mrrVnd} >= 0`),
    check("platform_saas_daily_paying_check", sql`${t.paying} = false OR ${t.mrrVnd} IS NULL OR ${t.mrrVnd} > 0`),
    check("platform_saas_daily_standing_check", sql`${t.standing} IN ('NOT_BILLED','ACTIVE','DUE_SOON','OVERDUE','LOCKED')`),
  ],
);

/**
 * MỐC KÍCH HOẠT (0203): GHI MỘT LẦN. `reached_at` = thời điểm của chứng từ có thật trong CSDL tổ chức (min created_at),
 * không phải lúc máy quét thấy — `observed_at` mới là lúc thấy. Định nghĩa từng mốc: `lib/platform/saas-metrics.ts`.
 */
export const platformOrgMilestones = pgTable(
  "platform_org_milestones",
  {
    orgCode: text("org_code").notNull(),
    milestone: text("milestone").notNull(),
    reachedAt: ts("reached_at").notNull(),
    observedAt: ts("observed_at").notNull().defaultNow(),
    source: text("source").notNull(),
  },
  (t) => [primaryKey({ name: "platform_org_milestones_pkey", columns: [t.orgCode, t.milestone] }), check("platform_org_milestones_key_check", sql`${t.milestone} ~ '^[A-Z][A-Z0-9_]{1,40}$'`)],
);

/**
 * SỔ DÙNG THEO NGÀY (0204 · lib/platform/saas-ledger.ts) — mặt phẳng điều khiển. Đếm từ chứng từ có mốc thời gian trong CSDL
 * tổ chức (kênh THỬ không bao giờ tính). Lượt chụp tính lại hôm nay + hôm qua; ngày cũ hơn đóng băng.
 */
export const platformTenantUsageDaily = pgTable(
  "platform_tenant_usage_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    orgCode: text("org_code").notNull(),
    conversationsStarted: integer("conversations_started").notNull().default(0),
    customerMessages: integer("customer_messages").notNull().default(0),
    botMessages: integer("bot_messages").notNull().default(0),
    aiActiveConversations: integer("ai_active_conversations").notNull().default(0),
    aiOrders: integer("ai_orders").notNull().default(0),
    /** Fanpage đang hoạt động LÚC CHỤP (0222, `org_channel_pages` · ACTIVE · PAGE). `NULL` = CHƯA ĐO được — không phải 0. */
    fanpagesActive: integer("fanpages_active"),
    capturedAt: ts("captured_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "platform_tenant_usage_daily_pkey", columns: [t.day, t.orgCode] }),
    index("platform_tenant_usage_daily_org_day_idx").on(t.orgCode, t.day),
    check("platform_tenant_usage_daily_fanpages_check", sql`${t.fanpagesActive} IS NULL OR ${t.fanpagesActive} >= 0`),
    check("platform_tenant_usage_daily_nonneg_check", sql`${t.conversationsStarted} >= 0 AND ${t.customerMessages} >= 0 AND ${t.botMessages} >= 0 AND ${t.aiActiveConversations} >= 0 AND ${t.aiOrders} >= 0`),
  ],
);

/**
 * GHI ĐÈ GIÁ / TÍNH NĂNG / MỨC ÁP THEO TỔ CHỨC (0222 · lib/pricing/entitlements.ts) — mặt phẳng điều khiển, chỉ thật ở CSDL NHÀ.
 *  · `grandfathered` — tổ chức có từ trước 0222: giữ ĐỦ tính năng bất kể gói khai gì (không ai mất tính năng vì một deploy).
 *  · `feature_overrides` `{ <tính năng>: boolean }` · `quota_overrides` `{ <hạn mức>: số | null }` — ô có mặt thì thắng gói.
 *  · `enforcement` — `OFF` (không nhắc) · `SOFT` (mặc định: nhắc, KHÔNG chặn) · `HARD` (chặn — chỉ khi công tắc trần cứng của
 *    nền tảng cũng bật). Thiếu dòng = `SOFT`, không grandfathered. Chỉ `lib/pricing/admin.ts` ghi, bắt buộc lý do + nhật ký.
 */
export const platformOrgPricing = pgTable(
  "platform_org_pricing",
  {
    orgCode: text("org_code").primaryKey(),
    grandfathered: boolean("grandfathered").notNull().default(false),
    featureOverrides: jsonb("feature_overrides").$type<Record<string, unknown>>().notNull().default({}),
    quotaOverrides: jsonb("quota_overrides").$type<Record<string, unknown>>().notNull().default({}),
    enforcement: text("enforcement").notNull().default("SOFT"),
    reason: text("reason"),
    updatedByEmail: text("updated_by_email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("platform_org_pricing_enforcement_check", sql`${t.enforcement} IN ('OFF','SOFT','HARD')`)],
);

// ═══ SAAS CONTROL PLANE (0224 · docs/saas/README.md) — Account → Workspace → Product Subscription ═══
//
// Mặt phẳng điều khiển: chỉ thật ở CSDL NHÀ (`getPlatformDb()`), xoá sạch ở CSDL tổ chức (db/migrate.ts). Danh mục SẢN PHẨM
// là mã nguồn (`lib/saas/catalog.ts`, như sổ module — P6); bảng dưới đây chỉ giữ CẤU HÌNH + SỔ.

/**
 * KHÁCH HÀNG THƯƠNG MẠI. Khách nội bộ (VNXCommerce) và khách ngoài đi CÙNG một mô hình — khác nhau CHỈ ở `account_type` +
 * `billing_mode`, không ở nhánh mã. Thông tin pháp nhân (tên pháp lý, MST) là hồ sơ thanh toán của tài khoản.
 */
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** `INTERNAL` · `EXTERNAL`. KHÔNG cấp quyền gì — quyền vận hành nền tảng là `platform:operate`, tường minh. */
    accountType: text("account_type").notNull().default("EXTERNAL"),
    /** `INTERNAL_CHARGEBACK` (bảng kê nội bộ, không thu tiền) · `EXTERNAL_INVOICE` (hoá đơn + thu tiền như 0187). */
    billingMode: text("billing_mode").notNull().default("EXTERNAL_INVOICE"),
    status: text("status").notNull().default("ACTIVE"),
    legalName: text("legal_name"),
    taxCode: text("tax_code"),
    billingEmail: text("billing_email"),
    note: text("note"),
    source: text("source").notNull().default("OPERATOR"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("platform_accounts_code_key").on(t.code),
    check("platform_accounts_code_check", sql`${t.code} ~ '^[a-z][a-z0-9-]{1,40}$'`),
    check("platform_accounts_type_check", sql`${t.accountType} IN ('INTERNAL','EXTERNAL')`),
    check("platform_accounts_billing_mode_check", sql`${t.billingMode} IN ('INTERNAL_CHARGEBACK','EXTERNAL_INVOICE')`),
    check("platform_accounts_status_check", sql`${t.status} IN ('ACTIVE','SUSPENDED','CLOSED')`),
    check("platform_accounts_source_check", sql`${t.source} IN ('BACKFILL_0224','OPERATOR','PROVISIONING','SIGNUP','TEST')`),
  ],
);

/**
 * THUÊ BAO SẢN PHẨM: workspace × sản phẩm. `plan_key NULL` = theo gói của workspace (gói gộp, `platform_organizations.plan`)
 * — không chép gói sang chỗ thứ hai. `state` là LỰA CHỌN của người vận hành (đang dùng · tạm dừng · đã huỷ); tình trạng HIỆU
 * LỰC (dùng thử · quá hạn · hết hạn) là hàm thuần của `state` + thu phí (`lib/saas/policy.ts::effectiveSubscriptionStatus`).
 * Huỷ rồi thuê lại = dòng MỚI (dòng cũ giữ làm lịch sử).
 */
export const platformProductSubscriptions = pgTable(
  "platform_product_subscriptions",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => platformAccounts.id),
    orgCode: text("org_code").notNull(),
    productKey: text("product_key").notNull(),
    planKey: text("plan_key"),
    state: text("state").notNull().default("ACTIVE"),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    endReason: text("end_reason"),
    scheduledPlanKey: text("scheduled_plan_key"),
    scheduledAt: date("scheduled_at", { mode: "string" }),
    source: text("source").notNull().default("OPERATOR"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("platform_product_subscriptions_live_key").on(t.orgCode, t.productKey).where(sql`${t.endedAt} IS NULL`),
    index("platform_product_subscriptions_account_idx").on(t.accountId),
    check("platform_product_subscriptions_product_check", sql`${t.productKey} ~ '^[a-z][a-z0-9_]{1,30}$'`),
    check("platform_product_subscriptions_state_check", sql`${t.state} IN ('ACTIVE','PAUSED','CANCELED')`),
    check("platform_product_subscriptions_ended_check", sql`(${t.state} = 'CANCELED') = (${t.endedAt} IS NOT NULL)`),
    check("platform_product_subscriptions_schedule_check", sql`(${t.scheduledPlanKey} IS NULL) = (${t.scheduledAt} IS NULL)`),
    check("platform_product_subscriptions_source_check", sql`${t.source} IN ('BACKFILL_0224','OPERATOR','PROVISIONING','SIGNUP','TEST')`),
  ],
);

/**
 * SỔ DÙNG CHUNG — chỉ thêm. Khoá idempotent (tổ chức, `event_key`): gói tin trùng / thử lại không ghi dòng thứ hai. Lượt gọi
 * model KHÔNG ghi ở đây (chúng ở `platform_ai_usage` — một nguồn cho một khoản); sổ này cho chỉ số sản phẩm khai trong
 * `lib/saas/catalog.ts` với nguồn `EVENT_LEDGER`. Ghi DUY NHẤT qua `lib/saas/usage.ts::recordUsage`.
 */
export const platformUsageEvents = pgTable(
  "platform_usage_events",
  {
    id: id(),
    occurredAt: ts("occurred_at").notNull(),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
    accountId: text("account_id"),
    orgCode: text("org_code").notNull(),
    productKey: text("product_key").notNull(),
    subscriptionId: text("subscription_id"),
    metric: text("metric").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    source: text("source").notNull(),
    eventKey: text("event_key").notNull(),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("platform_usage_events_org_key").on(t.orgCode, t.eventKey),
    index("platform_usage_events_org_at_idx").on(t.orgCode, t.occurredAt),
    check("platform_usage_events_metric_check", sql`${t.metric} ~ '^[a-z][a-z0-9_]{1,60}$'`),
    check("platform_usage_events_product_check", sql`${t.productKey} ~ '^[a-z][a-z0-9_]{1,30}$'`),
    check("platform_usage_events_quantity_check", sql`${t.quantity} >= 0`),
    check("platform_usage_events_key_check", sql`length(${t.eventKey}) BETWEEN 1 AND 200`),
  ],
);

/**
 * SỔ CHI PHÍ NGOÀI AI. Mỗi dòng khai CĂN CỨ PHÂN BỔ trước khi nhân (cùng tinh thần luật 14). Chi phí AI chỉ ở
 * `platform_ai_usage`; hạ tầng / hỗ trợ NỀN theo tháng chỉ ở `platform_settings['platform.economics.costs']` — sổ này không
 * nhận hai hạng mục đó (CHECK hạng mục), nên không khoản nào được cộng hai lần. Huỷ = `voided_at` + lý do, không xoá.
 */
export const platformCostEntries = pgTable(
  "platform_cost_entries",
  {
    id: id(),
    periodMonth: date("period_month", { mode: "string" }).notNull(),
    category: text("category").notNull(),
    scope: text("scope").notNull(),
    productKey: text("product_key"),
    accountId: text("account_id"),
    orgCode: text("org_code"),
    allocationBasis: text("allocation_basis").notNull(),
    amountVnd: bigint("amount_vnd", { mode: "number" }).notNull(),
    description: text("description").notNull(),
    entryKey: text("entry_key").notNull(),
    createdByEmail: text("created_by_email"),
    createdAt: createdAt(),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("platform_cost_entries_key").on(t.entryKey),
    index("platform_cost_entries_month_idx").on(t.periodMonth),
    check("platform_cost_entries_month_check", sql`extract(day from ${t.periodMonth}) = 1`),
    check("platform_cost_entries_category_check", sql`${t.category} IN ('EXTERNAL_API','MESSAGING','STORAGE','INFRA_DIRECT','OTHER')`),
    check(
      "platform_cost_entries_scope_check",
      sql`(${t.scope} = 'PLATFORM' AND ${t.productKey} IS NULL AND ${t.accountId} IS NULL AND ${t.orgCode} IS NULL) OR (${t.scope} = 'PRODUCT' AND ${t.productKey} IS NOT NULL AND ${t.accountId} IS NULL AND ${t.orgCode} IS NULL) OR (${t.scope} = 'ACCOUNT' AND ${t.accountId} IS NOT NULL AND ${t.orgCode} IS NULL) OR (${t.scope} = 'WORKSPACE' AND ${t.orgCode} IS NOT NULL)`,
    ),
    check("platform_cost_entries_basis_check", sql`${t.allocationBasis} IN ('DIRECT','EQUAL_ACTIVE_WORKSPACES','AI_COST_SHARE')`),
    check("platform_cost_entries_direct_check", sql`${t.allocationBasis} <> 'DIRECT' OR ${t.scope} IN ('ACCOUNT','WORKSPACE')`),
    check("platform_cost_entries_amount_check", sql`${t.amountVnd} > 0`),
    check("platform_cost_entries_void_check", sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`),
  ],
);

/**
 * BẢNG KÊ KỲ ĐÃ CHỐT của một tài khoản: hoá đơn (khách ngoài) hoặc chargeback (khách nội bộ). Bảng kê NHÁP không lưu — tính
 * lúc đọc. Chốt = đóng băng `snapshot` (dòng, nguồn, độ phủ); sửa công thức sau đó KHÔNG đổi số kỳ đã chốt (luật 21).
 * Thu tiền khách ngoài vẫn đi đường hoá đơn gia hạn 0187 (`platform_invoices`) — bảng kê không phải lệnh thu thứ hai.
 */
export const platformBillingStatements = pgTable(
  "platform_billing_statements",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => platformAccounts.id),
    periodMonth: date("period_month", { mode: "string" }).notNull(),
    billingMode: text("billing_mode").notNull(),
    status: text("status").notNull().default("FINAL"),
    totalKnownVnd: bigint("total_known_vnd", { mode: "number" }).notNull(),
    unknownLines: integer("unknown_lines").notNull().default(0),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    engineVersion: text("engine_version").notNull(),
    finalizedAt: ts("finalized_at").notNull().defaultNow(),
    finalizedByEmail: text("finalized_by_email"),
  },
  (t) => [
    uniqueIndex("platform_billing_statements_account_month_key").on(t.accountId, t.periodMonth),
    check("platform_billing_statements_month_check", sql`extract(day from ${t.periodMonth}) = 1`),
    check("platform_billing_statements_mode_check", sql`${t.billingMode} IN ('INTERNAL_CHARGEBACK','EXTERNAL_INVOICE')`),
    check("platform_billing_statements_status_check", sql`${t.status} IN ('FINAL')`),
    check("platform_billing_statements_unknown_check", sql`${t.unknownLines} >= 0`),
  ],
);

/**
 * JOB CẤP PHÁT: tạo khách (tài khoản + workspace + thuê bao + quản trị), thuê / huỷ một sản phẩm. Khoá idempotent: gửi lại
 * cùng khoá ⇒ trả job cũ; job FAILED chạy lại được (mỗi bước tự idempotent). `steps` = nhật ký từng bước (không bí mật).
 */
export const platformProvisioningJobs = pgTable(
  "platform_provisioning_jobs",
  {
    id: id(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    accountId: text("account_id"),
    orgCode: text("org_code"),
    productKey: text("product_key"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    steps: jsonb("steps").$type<unknown[]>().notNull().default([]),
    lastError: text("last_error"),
    requestedByEmail: text("requested_by_email"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("platform_provisioning_jobs_key").on(t.idempotencyKey),
    index("platform_provisioning_jobs_status_idx").on(t.status, t.createdAt),
    check("platform_provisioning_jobs_kind_check", sql`${t.kind} IN ('CREATE_CUSTOMER','SUBSCRIBE_PRODUCT','CANCEL_SUBSCRIPTION')`),
    check("platform_provisioning_jobs_status_check", sql`${t.status} IN ('PENDING','RUNNING','SUCCEEDED','FAILED')`),
    check("platform_provisioning_jobs_error_check", sql`${t.status} <> 'FAILED' OR ${t.lastError} IS NOT NULL`),
    check("platform_provisioning_jobs_key_check", sql`length(${t.idempotencyKey}) BETWEEN 1 AND 200`),
  ],
);

// ═══ BẢNG GIÁ CÓ PHIÊN BẢN (0228 · docs/saas/PRICING_V1.md) — giá tương lai đổi = THÊM phiên bản, không sửa dòng cũ ═══

/**
 * MỘT phiên bản bảng giá. `LEGACY_SNAPSHOT` = ảnh chụp giá đang thu lúc 0228 (chỉ tới bằng ghim); `CATALOG` = bảng giá
 * niêm yết, hiệu lực từ `effective_from` (phiên bản CATALOG mới nhất đã hiệu lực = giá cho tổ chức chưa ghim). Ngưỡng cảnh
 * báo dùng (80 · 100 · 120 · 150) đi theo phiên bản; thuế `UNDECLARED` = không giả định VAT.
 */
export const platformPriceVersions = pgTable(
  "platform_price_versions",
  {
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    effectiveFrom: ts("effective_from"),
    taxMode: text("tax_mode").notNull().default("UNDECLARED"),
    taxNote: text("tax_note"),
    alertThresholds: jsonb("alert_thresholds").$type<Record<string, unknown>>().notNull().default({}),
    note: text("note"),
    createdByEmail: text("created_by_email"),
    createdAt: createdAt(),
  },
  (t) => [
    check("platform_price_versions_key_check", sql`${t.key} ~ '^[a-z0-9][a-z0-9-]{1,40}$'`),
    check("platform_price_versions_kind_check", sql`${t.kind} IN ('LEGACY_SNAPSHOT','CATALOG')`),
    check("platform_price_versions_effective_check", sql`(${t.kind} = 'CATALOG') = (${t.effectiveFrom} IS NOT NULL)`),
    check("platform_price_versions_tax_check", sql`${t.taxMode} IN ('UNDECLARED','EXCLUSIVE','INCLUSIVE')`),
  ],
);

/**
 * Giá của MỘT gói trong MỘT phiên bản. Đọc DUY NHẤT qua `lib/pricing/versions.ts::parsePlanPrice` — ô thiếu = CHƯA KHAI,
 * `null` trong `included` = không giới hạn. Dòng LEGACY chép nguyên `platform_plans` lúc 0228.
 */
export const platformPlanPrices = pgTable(
  "platform_plan_prices",
  {
    versionKey: text("version_key")
      .notNull()
      .references(() => platformPriceVersions.key),
    planKey: text("plan_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    listed: boolean("listed").notNull().default(false),
    highlight: boolean("highlight").notNull().default(false),
    contactSales: boolean("contact_sales").notNull().default(false),
    monthlyVnd: bigint("monthly_vnd", { mode: "number" }),
    /** Giá trả 12 tháng TƯỜNG MINH. `NULL` = giá tháng × (12 − `yearly_free_months`) như 0194. */
    yearlyVnd: bigint("yearly_vnd", { mode: "number" }),
    yearlyFreeMonths: integer("yearly_free_months").notNull().default(0),
    /** Gói hợp đồng: «Từ … ₫» — không tự mua, không tự tính phần vượt. */
    priceFromVnd: bigint("price_from_vnd", { mode: "number" }),
    trialDays: integer("trial_days"),
    included: jsonb("included").$type<Record<string, unknown>>().notNull().default({}),
    overage: jsonb("overage").$type<Record<string, unknown>>().notNull().default({}),
    features: jsonb("features").$type<unknown[]>(),
    addonPrices: jsonb("addon_prices").$type<Record<string, unknown>>().notNull().default({}),
    limits: jsonb("limits").$type<Record<string, unknown>>().notNull().default({}),
    commercial: jsonb("commercial").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ name: "platform_plan_prices_pk", columns: [t.versionKey, t.planKey] }),
    check("platform_plan_prices_amount_check", sql`(${t.monthlyVnd} IS NULL OR ${t.monthlyVnd} > 0) AND (${t.yearlyVnd} IS NULL OR ${t.yearlyVnd} > 0) AND (${t.priceFromVnd} IS NULL OR ${t.priceFromVnd} > 0)`),
    check("platform_plan_prices_free_months_check", sql`${t.yearlyFreeMonths} BETWEEN 0 AND 6`),
    check("platform_plan_prices_trial_check", sql`${t.trialDays} IS NULL OR ${t.trialDays} BETWEEN 1 AND 90`),
  ],
);

/** Tổ chức đang ở phiên bản giá nào. Không có dòng ⇒ phiên bản CATALOG đang hiệu lực; hoá đơn đầu tiên được trả thì ghim. */
export const platformPricePins = pgTable(
  "platform_price_pins",
  {
    orgCode: text("org_code").primaryKey(),
    versionKey: text("version_key")
      .notNull()
      .references(() => platformPriceVersions.key),
    source: text("source").notNull(),
    reason: text("reason"),
    pinnedByEmail: text("pinned_by_email"),
    pinnedAt: ts("pinned_at").notNull().defaultNow(),
  },
  (t) => [index("platform_price_pins_version_idx").on(t.versionKey), check("platform_price_pins_source_check", sql`${t.source} IN ('MIGRATION_0228','INVOICE_PAID','OPERATOR','TEST')`)],
);

/** Nhật ký nền tảng: ai đổi module / cờ / tổ chức nào, trước → sau, vì sao. Chỉ THÊM. */
export const platformAuditLog = pgTable(
  "platform_audit_log",
  {
    id: id(),
    at: ts("at").notNull().defaultNow(),
    /** Ba cột người làm cùng `NULL` ⇒ MÁY làm (migration, script, kiểm thử) — khác "chưa biết ai". */
    actorOrgCode: text("actor_org_code"),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    targetOrgCode: text("target_org_code").notNull(),
    /** Thao tác ở cấp TÀI KHOẢN (0224) — `target_org_code` khi đó là workspace nhà (cùng quy ước thao tác cấp nền tảng). */
    targetAccountId: text("target_account_id"),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    source: text("source").notNull(),
  },
  (t) => [index("platform_audit_log_target_at_idx").on(t.targetOrgCode, t.at)],
);

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
    /**
     * Khách đã ĐỌC tới mốc này — `read_watermarks` của Pancake (mốc đọc Messenger), xem
     * `customerReadWatermark()`. `NULL` = Pancake không cho biết / chưa quét từ 0151 — KHÔNG phải "chưa xem".
     * Chỉ TIẾN lên (`greatest`): mốc đọc không bao giờ lùi, và một lượt quét thiếu trường không được xoá nó.
     */
    customerSeenAt: ts("customer_seen_at"),
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
    check("work_items_creation_source_check", sql`${t.creationSource} IN ('AUTO', 'MANUAL', 'RECURRING', 'WORKFLOW')`),
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
    check("work_item_events_source_check", sql`${t.source} IN ('UI', 'API', 'SYSTEM', 'RECURRENCE', 'WORKFLOW')`),
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
 * ĐĂNG KÝ NHẬN THÔNG BÁO ĐẨY của một trình duyệt / máy (0213 · lib/push/service.ts). Mỗi `endpoint` (máy chủ đẩy của trình
 * duyệt) là MỘT dòng, thuộc người đang đăng nhập trên máy đó lúc bấm bật. Tin vào hộp thư cá nhân (`user_messages`) ⇒ đẩy
 * tới mọi đăng ký của người nhận. Máy chủ đẩy báo đăng ký đã chết (404 / 410 / 401 / 403) ⇒ xoá dòng.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastOkAt: ts("last_ok_at"),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_key").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
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

    /* ───── Mặt phẳng điều khiển công ty (0226, docs/tech-control-plane/README.md) ───── */
    /** Sứ mệnh chứa việc này. `NULL` = việc lẻ (sự cố, việc tay) — vẫn hợp lệ. */
    missionId: text("mission_id").references((): AnyPgColumn => techMissions.id, { onDelete: "set null" }),
    /** Dự án kỹ thuật. `NULL` = chưa khai — KHÔNG ngầm hiểu là ERP. */
    projectId: text("project_id").references((): AnyPgColumn => techProjects.id, { onDelete: "set null" }),
    /** Khi `NEEDS_OWNER`: một trong chín lý do (`TECH_OWNER_ESCALATIONS`). Rời trạng thái đó thì xoá về rỗng. */
    ownerEscalation: text("owner_escalation").notNull().default(""),
    /** Khi `NEEDS_OWNER`: ĐÚNG việc chủ shop phải làm, đủ để làm theo mà không phải hỏi lại. */
    ownerAction: text("owner_action").notNull().default(""),

    /* ───── Hàng đợi worker (0229, docs/tech-control-plane/README.md mục 4) ───── */
    /** Năng lực việc cần (`TECH_CAPABILITIES`). Rỗng = suy theo loại việc (`CAPABILITY_BY_TASK_TYPE`). */
    capability: text("capability").notNull().default(""),
    /** Worker đang giữ lease. `NULL` ⇔ `lease_expires_at NULL` (CHECK) — không ai giữ. */
    leaseWorkerId: text("lease_worker_id").references((): AnyPgColumn => techWorkers.id, { onDelete: "set null" }),
    leaseExpiresAt: ts("lease_expires_at"),
    /** FENCING TOKEN: tăng mỗi lần nhận. Kết quả mang generation cũ ⇒ bị từ chối. */
    leaseGeneration: integer("lease_generation").notNull().default(0),
    /** Số lần đã nhận (gồm lần đang chạy). Có trần — không vòng thử lại vô hạn. */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Lùi dần: chưa tới mốc này thì không worker nào nhận lại. */
    nextAttemptAt: ts("next_attempt_at"),
    lastError: text("last_error").notNull().default(""),
    /**
     * Mức chính sách R0–R4 (0230, `classifyTechPolicy`) — tính lúc GHI (tạo việc, đè rủi ro). `NULL` = CHƯA XẾP ⇒
     * không bao giờ tự động (đóng khi thiếu); dòng cũ không backfill, người bấm "Xếp lại chính sách".
     */
    policyLevel: text("policy_level"),
    policyReasons: jsonb("policy_reasons").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_tasks_code_uq").on(t.code),
    index("tech_tasks_mission_idx").on(t.missionId),
    index("tech_tasks_project_idx").on(t.projectId),
    index("tech_tasks_claim_idx").on(t.status, t.priority, t.createdAt).where(sql`${t.status} = 'SPEC_READY'`),
    index("tech_tasks_lease_idx").on(t.leaseExpiresAt).where(sql`${t.leaseWorkerId} IS NOT NULL`),
    check("tech_tasks_lease_pair_check", sql`(${t.leaseWorkerId} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
    check("tech_tasks_attempts_check", sql`${t.attempts} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 10 AND ${t.leaseGeneration} >= 0`),
    check("tech_tasks_policy_check", sql`${t.policyLevel} IS NULL OR ${t.policyLevel} IN ('R0','R1','R2','R3','R4')`),
    index("tech_tasks_status_idx").on(t.status, t.priority),
    index("tech_tasks_created_idx").on(t.createdAt),
    index("tech_tasks_agent_idx").on(t.agentId),
    index("tech_tasks_module_idx").on(t.module),
    check(
      "tech_tasks_status_check",
      sql`${t.status} IN ('NEW','TRIAGED','SPEC_READY','BUILDING','REVIEW','QA','READY_TO_DEPLOY','DEPLOYING','OBSERVING','DONE','BLOCKED','FAILED','ROLLED_BACK','NEEDS_OWNER','CANCELLED')`,
    ),
    /* Chờ chủ shop mà không nói chờ vì sao và phải làm gì thì việc nằm đó mãi — cùng tinh thần `blocked_reason`. */
    check(
      "tech_tasks_needs_owner_check",
      sql`${t.status} <> 'NEEDS_OWNER' OR (${t.ownerEscalation} IN ('APPROVAL_REQUIRED','CREDENTIAL_REQUIRED','PAYMENT_REQUIRED','EXTERNAL_AUTH_REQUIRED','IRREVERSIBLE_BUSINESS_DECISION','PRODUCTION_INCIDENT','SECURITY_INCIDENT','POLICY_CONFLICT','UNKNOWN_HIGH_RISK_STATE') AND length(btrim(${t.ownerAction})) >= 10)`,
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
    /* ───── Lượt chạy của worker hàng đợi (0229) ───── */
    /** Worker đã chạy lượt này. `NULL` = lượt cũ (GitHub Actions / chạy tay). */
    workerId: text("worker_id").references((): AnyPgColumn => techWorkers.id, { onDelete: "set null" }),
    /** `TECH_EXECUTION_PROVIDERS`. Rỗng = lượt cũ, chưa khai. */
    provider: text("provider").notNull().default(""),
    model: text("model").notNull().default(""),
    /** Generation của lease lúc nhận việc — fencing của mọi lời gọi về sau. */
    leaseGeneration: integer("lease_generation"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tech_agent_runs_agent_idx").on(t.agentId, t.startedAt),
    index("tech_agent_runs_worker_idx").on(t.workerId, t.status),
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

/* ═══════════ MẶT PHẲNG ĐIỀU KHIỂN CÔNG TY (0226) — docs/tech-control-plane/README.md ═══════════

   Bốn bảng, cộng thêm vào nền `/tech` đang chạy:
     tech_projects  — dự án KỸ THUẬT của công ty (ERP · ChotDonTuDong · HSLC · SaaS …), không phải khách thuê.
     tech_goals     — mục tiêu chủ shop đặt. Lưu QUYẾT ĐỊNH; tiến độ suy ra từ sứ mệnh / việc.
     tech_missions  — một nhóm việc giao được. Lưu QUYẾT ĐỊNH; trạng thái thi hành suy ra từ việc.
     tech_events    — luồng sự kiện của mặt phẳng điều khiển (append-only) cho thứ CHƯA có nhật ký riêng.
   Trạng thái thi hành ("đang chạy", "chờ chủ shop") KHÔNG có cột: `deriveMissionExecution` tính lúc đọc. */

export const techProjects = pgTable(
  "tech_projects",
  {
    id: id(),
    /** Khoá ổn định (`erp`, `chotdon`…) — `TECH_PROJECT_KEY_PATTERN`. Đổi khoá là đổi tên nhánh và đường dẫn. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Kho mã (`owner/repo`). Rỗng = cùng kho với ERP. */
    repo: text("repo").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_projects_key_uq").on(t.key),
    check("tech_projects_key_check", sql`${t.key} ~ '^[a-z][a-z0-9-]{1,31}$'`),
  ],
);

export const techGoals = pgTable(
  "tech_goals",
  {
    id: id(),
    /** `GOAL-3` — mã đọc được trên điện thoại; `id` vẫn là khoá. */
    code: text("code").notNull(),
    projectId: text("project_id").references(() => techProjects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Câu mục tiêu đầy đủ của chủ shop — giữ nguyên lời. */
    description: text("description").notNull().default(""),
    /** Đạt được nghĩa là gì, đo bằng gì. Rỗng = CHƯA KHAI, màn hình nói ra. */
    successCriteria: text("success_criteria").notNull().default(""),
    /** `TECH_GOAL_STATUSES`. Chỉ lưu QUYẾT ĐỊNH của người. */
    status: text("status").notNull().default("DRAFT"),
    priority: text("priority").notNull().default("P2"),
    /** Câu chốt khi ACHIEVED / ABANDONED. */
    outcomeNote: text("outcome_note").notNull().default(""),
    createdByKind: text("created_by_kind").notNull().default("HUMAN"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    activatedAt: ts("activated_at"),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_goals_code_uq").on(t.code),
    index("tech_goals_status_idx").on(t.status, t.priority),
    index("tech_goals_project_idx").on(t.projectId),
    check("tech_goals_status_check", sql`${t.status} IN ('DRAFT','ACTIVE','PAUSED','ACHIEVED','ABANDONED')`),
    check("tech_goals_priority_check", sql`${t.priority} IN ('P0','P1','P2','P3')`),
    check("tech_goals_actor_kind_check", sql`${t.createdByKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    /* Đóng mục tiêu mà không nói kết quả thì lần sau không ai biết lần này đã học được gì. */
    check(
      "tech_goals_closed_check",
      sql`${t.status} NOT IN ('ACHIEVED','ABANDONED') OR (${t.closedAt} IS NOT NULL AND length(btrim(${t.outcomeNote})) >= 10)`,
    ),
  ],
);

export const techMissions = pgTable(
  "tech_missions",
  {
    id: id(),
    /** `MIS-7`. */
    code: text("code").notNull(),
    /** `NULL` = sứ mệnh lẻ (sửa sự cố, việc kỹ thuật không thuộc mục tiêu nào) — hợp lệ. */
    goalId: text("goal_id").references(() => techGoals.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => techProjects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    objective: text("objective").notNull().default(""),
    /** Xong nghĩa là gì — kiểm được. */
    definitionOfDone: text("definition_of_done").notNull().default(""),
    /** `TECH_MISSION_STATUSES`. Chỉ lưu QUYẾT ĐỊNH; thi hành suy ra từ việc. */
    status: text("status").notNull().default("PLANNING"),
    priority: text("priority").notNull().default("P2"),
    /** Mã sứ mệnh tương ứng trên sổ AI Tech Room (`ai-control/registry`, `scripts/ai-tech.ts`). Rỗng = chưa nối. */
    registryId: text("registry_id").notNull().default(""),
    outcomeNote: text("outcome_note").notNull().default(""),
    createdByKind: text("created_by_kind").notNull().default("HUMAN"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    activatedAt: ts("activated_at"),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_missions_code_uq").on(t.code),
    uniqueIndex("tech_missions_registry_uq").on(t.registryId).where(sql`${t.registryId} <> ''`),
    index("tech_missions_goal_idx").on(t.goalId),
    index("tech_missions_status_idx").on(t.status, t.priority),
    check("tech_missions_status_check", sql`${t.status} IN ('PLANNING','ACTIVE','PAUSED','DONE','CANCELLED')`),
    check("tech_missions_priority_check", sql`${t.priority} IN ('P0','P1','P2','P3')`),
    check("tech_missions_actor_kind_check", sql`${t.createdByKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    check(
      "tech_missions_closed_check",
      sql`${t.status} NOT IN ('DONE','CANCELLED') OR (${t.closedAt} IS NOT NULL AND length(btrim(${t.outcomeNote})) >= 10)`,
    ),
  ],
);

/**
 * LUỒNG SỰ KIỆN CỦA MẶT PHẲNG ĐIỀU KHIỂN — CHỈ THÊM. Tên khai ở `TECH_EVENT_NAMES`.
 * Việc có nhật ký riêng (`tech_task_events`) nên sự kiện của VIỆC không chép sang đây; cột `task_id` chỉ để
 * nối một sự kiện của thứ khác (worker nhận việc, CI đỏ) về việc nó nói tới.
 */
export const techEvents = pgTable(
  "tech_events",
  {
    id: id(),
    name: text("name").notNull(),
    /** `TECH_EVENT_SUBJECTS`. */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    taskId: text("task_id").references(() => techTasks.id, { onDelete: "set null" }),
    missionId: text("mission_id").references(() => techMissions.id, { onDelete: "set null" }),
    goalId: text("goal_id").references(() => techGoals.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Agent đã làm, khi `actor_kind = 'AI_AGENT'` — khoá, không chỉ tên (AGENTS.md mục 34). */
    actorAgentId: text("actor_agent_id").references(() => techAgents.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull().default(""),
    /** Gửi lại cùng khoá (job chạy lại, bấm hai lần) không đẻ dòng thứ hai. */
    dedupeKey: text("dedupe_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tech_events_dedupe_uq").on(t.dedupeKey),
    index("tech_events_subject_idx").on(t.subjectType, t.subjectId, t.occurredAt),
    index("tech_events_occurred_idx").on(t.occurredAt),
    index("tech_events_mission_idx").on(t.missionId, t.occurredAt),
    check("tech_events_name_check", sql`${t.name} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check("tech_events_subject_check", sql`${t.subjectType} IN ('GOAL','MISSION','TASK','WORKER','RUN','DEPLOYMENT','INCIDENT','BUDGET')`),
    check("tech_events_actor_kind_check", sql`${t.actorKind} IN ('HUMAN','SYSTEM','AI_AGENT')`),
    check("tech_events_human_link_check", sql`${t.actorKind} = 'HUMAN' OR ${t.actorId} IS NULL`),
    check("tech_events_agent_link_check", sql`${t.actorKind} = 'AI_AGENT' OR ${t.actorAgentId} IS NULL`),
  ],
);

/**
 * WORKER — một tiến trình thi hành CÓ DANH TÍNH (0229). Khoá bí mật chỉ lưu BĂM (sha256); "sống / chập chờn /
 * mất" là hàm của `last_heartbeat_at` và đồng hồ (`workerLiveness`), không có cột trạng thái.
 */
export const techWorkers = pgTable(
  "tech_workers",
  {
    id: id(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    host: text("host").notNull().default(""),
    /** `SUBSCRIPTION_CLAUDE_CODE` · `ANTHROPIC_API` — ranh giới thanh toán đi theo worker. */
    provider: text("provider").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason").notNull().default(""),
    secretHash: text("secret_hash").notNull(),
    version: text("version").notNull().default(""),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_workers_key_uq").on(t.key),
    check("tech_workers_key_check", sql`${t.key} ~ '^[a-z][a-z0-9-]{2,39}$'`),
    check("tech_workers_provider_check", sql`${t.provider} IN ('SUBSCRIPTION_CLAUDE_CODE','ANTHROPIC_API')`),
    check("tech_workers_concurrency_check", sql`${t.maxConcurrency} BETWEEN 1 AND 4`),
    check("tech_workers_secret_check", sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** NHẬT KÝ LƯỢT CHẠY — có TRẦN (`TECH_LEASE.maxLogLinesPerRun` dòng, mỗi dòng ≤ 2000 ký tự). */
export const techRunLogs = pgTable(
  "tech_run_logs",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => techAgentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    level: text("level").notNull().default("info"),
    line: text("line").notNull(),
  },
  (t) => [
    uniqueIndex("tech_run_logs_run_seq_uq").on(t.runId, t.seq),
    check("tech_run_logs_level_check", sql`${t.level} IN ('info','warn','error')`),
    check("tech_run_logs_line_check", sql`length(${t.line}) <= 2000`),
  ],
);

/**
 * NGÂN SÁCH THEO PHẠM VI (0230). Một dòng mỗi (phạm vi, id); ô `NULL` = CHƯA KHAI. Tầng hẹp đè tầng rộng TỪNG Ô
 * (`resolveBudget`). Tiền API CHƯA KHAI trần ngày ⇒ worker API không chạy (đóng khi thiếu).
 */
export const techBudgets = pgTable(
  "tech_budgets",
  {
    id: id(),
    /** `TECH_BUDGET_SCOPES`: COMPANY · PROJECT · GOAL · MISSION. */
    scopeKind: text("scope_kind").notNull(),
    /** Rỗng cho COMPANY. */
    scopeId: text("scope_id").notNull().default(""),
    apiUsdDaily: doublePrecision("api_usd_daily"),
    apiUsdTotal: doublePrecision("api_usd_total"),
    maxRunMinutes: integer("max_run_minutes"),
    maxAttempts: integer("max_attempts"),
    maxConcurrentRuns: integer("max_concurrent_runs"),
    note: text("note").notNull().default(""),
    updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tech_budgets_scope_uq").on(t.scopeKind, t.scopeId),
    check("tech_budgets_scope_check", sql`${t.scopeKind} IN ('COMPANY','PROJECT','GOAL','MISSION')`),
    check("tech_budgets_company_check", sql`(${t.scopeKind} = 'COMPANY') = (${t.scopeId} = '')`),
    check(
      "tech_budgets_values_check",
      sql`(${t.apiUsdDaily} IS NULL OR ${t.apiUsdDaily} >= 0) AND (${t.apiUsdTotal} IS NULL OR ${t.apiUsdTotal} >= 0) AND (${t.maxRunMinutes} IS NULL OR ${t.maxRunMinutes} BETWEEN 5 AND 240) AND (${t.maxAttempts} IS NULL OR ${t.maxAttempts} BETWEEN 1 AND 10) AND (${t.maxConcurrentRuns} IS NULL OR ${t.maxConcurrentRuns} BETWEEN 1 AND 16)`,
    ),
  ],
);

export const techWorkersRelations = relations(techWorkers, ({ many }) => ({
  runs: many(techAgentRuns),
}));

export const techProjectsRelations = relations(techProjects, ({ many }) => ({
  goals: many(techGoals),
  missions: many(techMissions),
}));

export const techGoalsRelations = relations(techGoals, ({ one, many }) => ({
  project: one(techProjects, { fields: [techGoals.projectId], references: [techProjects.id] }),
  missions: many(techMissions),
}));

export const techMissionsRelations = relations(techMissions, ({ one, many }) => ({
  goal: one(techGoals, { fields: [techMissions.goalId], references: [techGoals.id] }),
  project: one(techProjects, { fields: [techMissions.projectId], references: [techProjects.id] }),
  tasks: many(techTasks),
}));

export const techTasksRelations = relations(techTasks, ({ one, many }) => ({
  agent: one(techAgents, { fields: [techTasks.agentId], references: [techAgents.id] }),
  mission: one(techMissions, { fields: [techTasks.missionId], references: [techMissions.id] }),
  project: one(techProjects, { fields: [techTasks.projectId], references: [techProjects.id] }),
  leaseWorker: one(techWorkers, { fields: [techTasks.leaseWorkerId], references: [techWorkers.id] }),
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

export const techAgentRunsRelations = relations(techAgentRuns, ({ one, many }) => ({
  agent: one(techAgents, { fields: [techAgentRuns.agentId], references: [techAgents.id] }),
  worker: one(techWorkers, { fields: [techAgentRuns.workerId], references: [techWorkers.id] }),
  logs: many(techRunLogs),
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
export type TechProjectRow = typeof techProjects.$inferSelect;
export type TechGoalRow = typeof techGoals.$inferSelect;
export type TechMissionRow = typeof techMissions.$inferSelect;
export type TechEventRow = typeof techEvents.$inferSelect;
export type TechWorkerDbRow = typeof techWorkers.$inferSelect;
export type TechRunLogRow = typeof techRunLogs.$inferSelect;
export type TechBudgetRow = typeof techBudgets.$inferSelect;

export const techRunLogsRelations = relations(techRunLogs, ({ one }) => ({
  run: one(techAgentRuns, { fields: [techRunLogs.runId], references: [techAgentRuns.id] }),
}));

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
    /**
     * TOPIC RIÊNG (0153 · chủ shop 27/09/2026): `true` ⇒ chỉ người mở, người được tag
     * (`production_topic_members`) và ADMIN xem được. Topic mở TRƯỚC 0153 mang `false` và giữ nguyên tầm
     * nhìn cũ (ai có quyền xem sản xuất cũng xem) — không đoán ngược ai "lẽ ra" được tag (mục 35).
     */
    restricted: boolean("restricted").notNull().default(false),
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
/**
 * NGƯỜI ĐƯỢC TAG VÀO TOPIC (0153 · chủ shop 27/09/2026). Một dòng = một tài khoản được mời vào trao đổi:
 * nhận tin ở hộp thư cá nhân và — với topic `restricted` — là một trong những người DUY NHẤT xem được
 * topic. Người mở topic KHÔNG cần dòng ở đây (`production_topics.created_by_user_id` đã nói điều đó).
 * Quy kết bằng khoá tài khoản (mục 34); `added_by` chỉ là ảnh chụp tên.
 */
export const productionTopicMembers = pgTable(
  "production_topic_members",
  {
    id: id(),
    topicId: text("topic_id")
      .notNull()
      .references(() => productionTopics.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    addedBy: text("added_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("production_topic_members_uq").on(t.topicId, t.userId), index("production_topic_members_user_idx").on(t.userId)],
);

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

/**
 * `bytea` — nhị phân thật, không base64 (base64 phình 33%, và video là thứ lớn nhất ERP từng lưu). `pg`
 * trả `Buffer`, PGlite trả `Uint8Array` ⇒ quy về `Buffer` ở một chỗ.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (v) => v,
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});

/**
 * Ảnh / video đính kèm một topic sản xuất (chủ shop 26/09/2026). Tệp nằm trong CSDL — cùng lối với ảnh ý
 * tưởng — vì máy chủ không có ổ lưu tệp riêng được sao lưu. Nội dung chia KHÚC (`production_topic_file_chunks`,
 * mỗi khúc ≤ `TOPIC_FILE_CHUNK_BYTES`) để: tải lên qua Server Action không vượt trần thân yêu cầu; phát video
 * theo `Range` chỉ đọc đúng khúc cần, không nạp cả tệp vào RAM của một VPS ~2 GB.
 *
 * `UPLOADING` = đang tải dở (không hiện ở đâu cả); `READY` = đủ khúc, đã kiểm tổng số byte.
 */
export const productionTopicFiles = pgTable(
  "production_topic_files",
  {
    id: id(),
    topicId: text("topic_id")
      .notNull()
      .references(() => productionTopics.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull().default(""),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    status: text("status").notNull().default("UPLOADING"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP tên người tải — do MÁY CHỦ đọc (mục 34). */
    uploadedBy: text("uploaded_by").notNull().default(""),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("production_topic_files_topic_idx").on(t.topicId, t.createdAt),
    check("production_topic_files_kind_check", sql`${t.kind} IN ('IMAGE', 'VIDEO')`),
    check("production_topic_files_status_check", sql`${t.status} IN ('UPLOADING', 'READY')`),
    check("production_topic_files_size_check", sql`${t.bytes} > 0 AND ${t.chunkCount} > 0`),
    check("production_topic_files_ready_check", sql`${t.status} <> 'READY' OR ${t.completedAt} IS NOT NULL`),
  ],
);

/** Một khúc nội dung của tệp đính kèm topic. `seq` từ 0. */
export const productionTopicFileChunks = pgTable(
  "production_topic_file_chunks",
  {
    id: id(),
    fileId: text("file_id")
      .notNull()
      .references(() => productionTopicFiles.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    data: bytea("data").notNull(),
  },
  (t) => [uniqueIndex("production_topic_file_chunks_seq_uq").on(t.fileId, t.seq), check("production_topic_file_chunks_seq_check", sql`${t.seq} >= 0`)],
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
    /**
     * Neo vào phiếu kiểm của kiện CÓ mã vận đơn. `NULL` ⇔ dòng neo vào một món hàng hoàn KHÔNG NHÃN
     * (`unidentified_id`) — Company OS · Agent R, 0142. CHECK `return_dispositions_anchor_check`: đúng MỘT neo.
     */
    inspectionId: text("inspection_id").references(() => returnInspections.id, { onDelete: "restrict" }),
    /** Company OS · Agent R (0142): món hàng hoàn KHÔNG NHÃN (`return_unidentified`). Xoá món là xoá chứng từ ⇒ RESTRICT. */
    unidentifiedId: text("unidentified_id").references(() => returnUnidentified.id, { onDelete: "restrict" }),
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
    /**
     * Company OS · Agent R (0142): CĂN CỨ của lượt nhập lại sau sửa cho món KHÔNG NHÃN — `IDENTIFIED` (đã
     * nối vận đơn) hay `MANAGER_OVERRIDE` (không chứng từ đơn, cần quyền `inventory:restock-unidentified`
     * + lý do). Cùng từ vựng với `return_unidentified.restock_authority`. CHỈ có ở đúng loại dòng ấy (CHECK).
     */
    restockAuthority: text("restock_authority"),
    /** Khoá chống bấm đúp / gửi lại: cùng khoá ⇒ trả lại dòng đã ghi, không ghi dòng thứ hai. */
    requestKey: text("request_key").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index("return_dispositions_subject_idx").on(t.subjectKey, t.createdAt),
    index("return_dispositions_inspection_idx").on(t.inspectionId),
    index("return_dispositions_unidentified_idx").on(t.unidentifiedId),
    index("return_dispositions_variant_idx").on(t.variantId),
    check("return_dispositions_disposition_check", sql`${t.disposition} IN ('PENDING_DECISION', 'REWORK', 'RESTOCK_AFTER_REWORK', 'WRITE_OFF', 'RETURN_TO_SUPPLIER')`),
    check("return_dispositions_qty_check", sql`${t.qty} > 0`),
    // 0142: ĐÚNG MỘT neo — phiếu kiểm (kiện có mã) HOẶC món không nhãn. Không cả hai, không thiếu cả hai.
    check("return_dispositions_anchor_check", sql`num_nonnulls(${t.inspectionId}, ${t.unidentifiedId}) = 1`),
    check(
      "return_dispositions_subject_check",
      sql`(${t.unidentifiedId} IS NULL AND ${t.inspectionId} IS NOT NULL AND ((${t.inspectionItemId} IS NULL AND ${t.subjectKey} = 'parcel:' || ${t.inspectionId}) OR (${t.inspectionItemId} IS NOT NULL AND ${t.subjectKey} = 'item:' || ${t.inspectionItemId}))) OR (${t.unidentifiedId} IS NOT NULL AND ${t.inspectionId} IS NULL AND ${t.inspectionItemId} IS NULL AND ${t.subjectKey} = 'unidentified:' || ${t.unidentifiedId})`,
    ),
    check(
      "return_dispositions_restock_authority_check",
      sql`((${t.unidentifiedId} IS NOT NULL AND ${t.disposition} = 'RESTOCK_AFTER_REWORK') = (${t.restockAuthority} IS NOT NULL)) AND (${t.restockAuthority} IS NULL OR ${t.restockAuthority} IN ('IDENTIFIED', 'MANAGER_OVERRIDE'))`,
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
      sql`${t.kind} IN ('APPROVAL', 'SAMPLE_REVIEW', 'TOPIC_DECISION', 'ADS_CUT', 'SCALE_STOCK_RISK', 'INVENTORY_STOCKOUT', 'PRODUCTION_LATE', 'INVENTORY_REORDER', 'MODEL_SCALE', 'MODEL_EARLY_TOPIC', 'INVENTORY_CLEARANCE', 'STOCK_PUSH')`,
    ),
    check("recommendation_decisions_reason_check", sql`${t.decision} <> 'DISMISSED' OR length(btrim(${t.reason})) > 0`),
    check("recommendation_decisions_snooze_check", sql`(${t.decision} = 'SNOOZED') = (${t.snoozeUntil} IS NOT NULL)`),
  ],
);

export type RecommendationDecisionDbRow = typeof recommendationDecisions.$inferSelect;

// ═══ PHASE 2 — METADATA & TUỲ BIẾN THEO TỔ CHỨC (docs/platform/phase-2-contracts.md mục 2) ═══
//
// Bảy bảng này nằm trong CSDL CỦA TỔ CHỨC (M1): định nghĩa field / form / danh sách / trạng thái và
// giá trị custom là dữ liệu của tổ chức, nên silo cô lập chúng miễn phí. Không bảng nghiệp vụ nào bị
// đổi: giá trị custom nằm ở MỘT dòng mở rộng mỗi bản ghi (`custom_values`) — đồng bộ Pancake upsert
// cả dòng `customers` / `products` mà không bao giờ chạm bảng này (M3).

/** Định nghĩa field custom. `field_key` BẤT BIẾN; không xoá — `ARCHIVED` (M4). */
export const metaCustomFields = pgTable(
  "meta_custom_fields",
  {
    id: id(),
    objectKey: text("object_key").notNull(),
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    required: boolean("required").notNull().default(false),
    defaultValue: jsonb("default_value"),
    options: jsonb("options").notNull().default([]),
    validation: jsonb("validation").notNull().default({}),
    transitions: jsonb("transitions").notNull().default({}),
    relationObject: text("relation_object"),
    helpText: text("help_text"),
    viewPermission: text("view_permission"),
    editPermission: text("edit_permission"),
    listable: boolean("listable").notNull().default(true),
    filterable: boolean("filterable").notNull().default(false),
    position: integer("position").notNull().default(0),
    status: text("status").notNull().default("ACTIVE"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meta_custom_fields_object_key_uq").on(t.objectKey, t.fieldKey),
    check("meta_custom_fields_status_check", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
    check("meta_custom_fields_key_check", sql`${t.fieldKey} ~ '^[a-z][a-z0-9_]{1,40}$'`),
  ],
);

/** Giá trị custom: MỘT dòng mỗi bản ghi, mọi field trong `values` (M3). */
export const customValues = pgTable(
  "custom_values",
  {
    objectKey: text("object_key").notNull(),
    recordId: text("record_id").notNull(),
    values: jsonb("values").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("custom_values_pk").on(t.objectKey, t.recordId)],
);

/** Tệp của field kiểu `file` — cùng lối các tệp đính kèm khác (bytea, không base64). Trần 5 MB ở dịch vụ. */
export const customFiles = pgTable(
  "custom_files",
  {
    id: id(),
    objectKey: text("object_key").notNull(),
    recordId: text("record_id").notNull(),
    fieldKey: text("field_key").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("custom_files_record_idx").on(t.objectKey, t.recordId)],
);

/** Form metadata: Nháp / Đã xuất bản (M7). Người dùng chỉ thấy `published`. */
export const metaForms = pgTable(
  "meta_forms",
  {
    objectKey: text("object_key").notNull(),
    formKey: text("form_key").notNull(),
    draft: jsonb("draft"),
    published: jsonb("published"),
    publishedVersion: integer("published_version").notNull().default(0),
    publishedAt: ts("published_at"),
    publishedBy: text("published_by"),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("meta_forms_pk").on(t.objectKey, t.formKey)],
);

/** Danh sách metadata — cùng mô hình Nháp / Đã xuất bản (M9). */
export const metaListViews = pgTable(
  "meta_list_views",
  {
    objectKey: text("object_key").notNull(),
    viewKey: text("view_key").notNull(),
    draft: jsonb("draft"),
    published: jsonb("published"),
    publishedVersion: integer("published_version").notNull().default(0),
    publishedAt: ts("published_at"),
    publishedBy: text("published_by"),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("meta_list_views_pk").on(t.objectKey, t.viewKey)],
);

/** Trạng thái HỆ THỐNG: tổ chức chỉ đổi nhãn / thứ tự / ẩn khỏi bộ lọc (M10). */
export const metaStatusOverrides = pgTable(
  "meta_status_overrides",
  {
    objectKey: text("object_key").notNull(),
    fieldKey: text("field_key").notNull(),
    value: text("value").notNull(),
    label: text("label"),
    position: integer("position"),
    active: boolean("active").notNull().default(true),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("meta_status_overrides_pk").on(t.objectKey, t.fieldKey, t.value)],
);

/** Ảnh chụp BẤT BIẾN của mỗi lượt xuất bản (M12). Chỉ thêm. */
export const metaConfigVersions = pgTable(
  "meta_config_versions",
  {
    id: id(),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    configKey: text("config_key").notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    createdAt: createdAt(),
  },
  (t) => [index("meta_config_versions_key_idx").on(t.kind, t.objectKey, t.configKey, t.version)],
);

// ═══════════════════════════ VIDEO SCALE CHO MÃ WIN (docs/video-scale.md) ═══════════════════════════
//
// Hợp đồng: `lib/constants/video-scale.ts`. Tệp video nằm trong CSDL (khúc `bytea`) — cùng lối với tệp topic sản xuất,
// vì máy chủ không có ổ lưu tệp riêng được sao lưu.

/** Cấu hình THEO MÃ của Video Scale — một dòng mỗi mã người đã đưa vào module. Không có dòng = chưa bật cho mã ấy. */
export const videoScaleSkus = pgTable(
  "video_scale_skus",
  {
    productId: text("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "restrict" }),
    /** `MANUAL` · `AUTO_ON_PASS` (`VIDEO_REVIEW_MODES`). */
    reviewMode: text("review_mode").notNull().default("MANUAL"),
    /**
     * FANPAGE ĐƯỢC DUYỆT cho mã (Facebook Page ID, khoá của `fanpages.external_page_id`). Người có quyền chọn trong danh
     * sách fanpage ERP đã biết — máy KHÔNG đoán fanpage theo tên gần giống. `NULL` = chưa gán ⇒ không đăng được.
     */
    pageId: text("page_id"),
    /** `NULL` = theo cấu hình fanpage · `MANUAL_REVIEW` = mã này luôn chờ người bấm đăng (kể cả khi fanpage bật tự động). */
    publishMode: text("publish_mode"),
    /** Dừng khẩn cấp CẤP MÃ: có mốc ⇒ không đăng / không tạo quảng cáo mới cho mã này. */
    automationPausedAt: ts("automation_paused_at"),
    automationPausedReason: text("automation_paused_reason").notNull().default(""),
    /** Tài khoản quảng cáo của mã (số, không `act_`). `NULL` = chưa gán ⇒ không dựng quảng cáo. */
    adAccountId: text("ad_account_id"),
    /** `DRAFT` · `PUBLISH_PAUSED` · `AUTO_LAUNCH` (`VIDEO_ADS_MODES`). Mặc định chỉ lập nháp. */
    adsMode: text("ads_mode").notNull().default("DRAFT"),
    /** Ngân sách NGÀY mỗi quảng cáo (VND). `NULL` = chưa khai ⇒ không bật được. */
    dailyBudgetPerAdVnd: integer("daily_budget_per_ad_vnd"),
    /** Trần tổng ngân sách ngày các quảng cáo ĐANG CHẠY của mã (VND). `NULL` = chưa khai. */
    skuDailyCapVnd: integer("sku_daily_cap_vnd"),
    /** Cho máy TĂNG ngân sách quảng cáo tốt trong trần (PR 4). Mặc định tắt: tăng tiền phải có người bấm. */
    autoScale: boolean("auto_scale").notNull().default(false),
    /** Mỗi ngày máy TỰ tạo một vòng biến thể mới cho mã (dùng bài học đã rút) — mặc định tắt: sinh video là tiêu tiền. */
    autoNextRound: boolean("auto_next_round").notNull().default(false),
    /** Người bật chế độ quảng cáo hiện tại (mục 34) — `AUTO_LAUNCH` là một lần duyệt có người đứng tên. */
    adsModeByUserId: text("ads_mode_by_user_id").references(() => users.id, { onDelete: "set null" }),
    adsModeBy: text("ads_mode_by").notNull().default(""),
    adsModeAt: ts("ads_mode_at"),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** ẢNH CHỤP tên — do MÁY CHỦ đọc (mục 34). */
    updatedBy: text("updated_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("video_scale_skus_review_mode_check", sql`${t.reviewMode} IN ('MANUAL', 'AUTO_ON_PASS')`),
    check("video_scale_skus_publish_mode_check", sql`${t.publishMode} IS NULL OR ${t.publishMode} = 'MANUAL_REVIEW'`),
    check("video_scale_skus_ads_mode_check", sql`${t.adsMode} IN ('DRAFT', 'PUBLISH_PAUSED', 'AUTO_LAUNCH')`),
    // Tự bật quảng cáo chỉ khi đã khai ĐỦ tiền và có người đứng tên — không có phong bì tiền thì không có "tự".
    check(
      "video_scale_skus_auto_launch_check",
      sql`${t.adsMode} <> 'AUTO_LAUNCH' OR (${t.adAccountId} IS NOT NULL AND ${t.dailyBudgetPerAdVnd} > 0 AND ${t.skuDailyCapVnd} > 0 AND ${t.adsModeByUserId} IS NOT NULL)`,
    ),
    check("video_scale_skus_budget_check", sql`(${t.dailyBudgetPerAdVnd} IS NULL OR ${t.dailyBudgetPerAdVnd} BETWEEN 20000 AND 500000) AND (${t.skuDailyCapVnd} IS NULL OR ${t.skuDailyCapVnd} BETWEEN 20000 AND 2000000)`),
  ],
);

/**
 * Cấu hình ĐĂNG theo fanpage. Không có dòng = fanpage CHƯA CẤU HÌNH ⇒ mặc định an toàn: chờ người duyệt từng bài.
 * `AUTO_PUBLISH` ⇒ video đã duyệt + câu chữ qua kiểm được máy đăng không cần người bấm từng bài (trong trần bài / ngày).
 */
export const videoScalePages = pgTable(
  "video_scale_pages",
  {
    pageId: text("page_id").primaryKey(),
    publishMode: text("publish_mode").notNull().default("MANUAL_REVIEW"),
    maxPostsPerDay: integer("max_posts_per_day").notNull().default(3),
    /** Dừng khẩn cấp CẤP FANPAGE. */
    pausedAt: ts("paused_at"),
    pausedReason: text("paused_reason").notNull().default(""),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("video_scale_pages_mode_check", sql`${t.publishMode} IN ('MANUAL_REVIEW', 'AUTO_PUBLISH')`),
    check("video_scale_pages_max_check", sql`${t.maxPostsPerDay} BETWEEN 1 AND 10`),
  ],
);

/** Một lượt "Tạo chiến dịch media" cho một mã win. */
export const videoScaleRuns = pgTable(
  "video_scale_runs",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    /** Id `creative_sources` (loại `PRODUCT_PHOTO`, CÙNG mã) người đã chọn làm ảnh gốc — người chọn = người duyệt ảnh. */
    sourceIds: jsonb("source_ids").$type<string[]>().notNull(),
    status: text("status").notNull().default("SCRIPTING"),
    promptVersion: integer("prompt_version").notNull(),
    angleVocabVersion: integer("angle_vocab_version").notNull(),
    variantsRequested: integer("variants_requested").notNull(),
    /** Góc người chỉ định (rỗng = máy chọn theo sổ học). */
    anglesRequested: jsonb("angles_requested").$type<string[]>().notNull().default([]),
    /** Ảnh chụp cấu hình lúc bấm (nhà cung cấp, model, độ phân giải, số cảnh, giọng đọc…) — lượt chạy sau không đổi theo cấu hình mới. */
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    musicId: text("music_id"),
    /** Đoạn BẢNG MÀU cuối video (`ShowcaseItem[]`, migration 0175): ảnh thật từng màu của mã. `[]` = không có đoạn ấy. */
    showcase: jsonb("showcase").$type<Record<string, unknown>[]>().notNull().default([]),
    /** Ghi chú / ý tưởng của người bấm — đi vào bản giao việc cho người viết kịch bản. */
    brief: text("brief").notNull().default(""),
    scriptModel: text("script_model").notNull().default(""),
    /** `NULL` = CHƯA BIẾT (mục 42). */
    scriptCostUsd: doublePrecision("script_cost_usd"),
    /** Dữ liệu THỬ (bộ sinh giả) — không đăng, không quảng cáo, màn hình gắn nhãn. */
    isTest: boolean("is_test").notNull().default(false),
    error: text("error").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("video_scale_runs_product_idx").on(t.productId, t.createdAt),
    check("video_scale_runs_status_check", sql`${t.status} IN ('SCRIPTING', 'PRODUCING', 'REVIEW', 'DONE', 'FAILED', 'CANCELLED')`),
    check("video_scale_runs_sources_check", sql`jsonb_typeof(${t.sourceIds}) = 'array' AND jsonb_array_length(${t.sourceIds}) > 0`),
    check("video_scale_runs_variants_check", sql`${t.variantsRequested} BETWEEN 1 AND 6`),
  ],
);

/** Tệp của module (clip nguồn, giọng đọc, nhạc, bản hoàn chỉnh, ảnh bìa). */
export const videoScaleAssets = pgTable(
  "video_scale_assets",
  {
    id: id(),
    kind: text("kind").notNull(),
    runId: text("run_id").references(() => videoScaleRuns.id, { onDelete: "set null" }),
    variantId: text("variant_id"),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    durationMs: integer("duration_ms"),
    width: integer("width"),
    height: integer("height"),
    chunkCount: integer("chunk_count").notNull(),
    status: text("status").notNull().default("UPLOADING"),
    isTest: boolean("is_test").notNull().default(false),
    /** Người tải lên (migration 0179) — chỉ người xin chỗ mới gửi khúc / hoàn tất được lượt tải `AD_UPLOAD` (mục 34). */
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
    purgedAt: ts("purged_at"),
  },
  (t) => [
    index("video_scale_assets_variant_idx").on(t.variantId),
    check("video_scale_assets_kind_check", sql`${t.kind} IN ('SOURCE_CLIP', 'VOICE', 'MUSIC', 'FINAL', 'THUMBNAIL', 'AD_UPLOAD')`),
    check("video_scale_assets_status_check", sql`${t.status} IN ('UPLOADING', 'READY', 'PURGED')`),
    check("video_scale_assets_size_check", sql`${t.bytes} > 0 AND ${t.chunkCount} > 0`),
    check("video_scale_assets_ready_check", sql`${t.status} <> 'READY' OR ${t.completedAt} IS NOT NULL`),
  ],
);

export const videoScaleAssetChunks = pgTable(
  "video_scale_asset_chunks",
  {
    id: id(),
    assetId: text("asset_id")
      .notNull()
      .references(() => videoScaleAssets.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    data: bytea("data").notNull(),
  },
  (t) => [uniqueIndex("video_scale_asset_chunks_seq_uq").on(t.assetId, t.seq), check("video_scale_asset_chunks_seq_check", sql`${t.seq} >= 0`)],
);

/** Một biến thể video của một lượt — một kịch bản, một bản hoàn chỉnh. */
export const videoScaleVariants = pgTable(
  "video_scale_variants",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => videoScaleRuns.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    angle: text("angle").notNull(),
    angleVocabVersion: integer("angle_vocab_version").notNull(),
    /** `VideoScript` — móc câu, cảnh (câu lệnh Veo + chữ trên hình + lời đọc), CTA. */
    script: jsonb("script").$type<Record<string, unknown>>().notNull(),
    /** Tập từ chống lặp (`scriptTokens`), nối bằng dấu cách — so Jaccard với các biến thể trước của cùng mã. */
    fingerprint: text("fingerprint").notNull().default(""),
    /** Ảnh gốc của biến thể (một trong `run.source_ids`). */
    sourceId: text("source_id").notNull(),
    status: text("status").notNull().default("SCRIPTED"),
    qcVerdict: text("qc_verdict"),
    /** Chi tiết QC: `technical` (ffprobe) + `visual` (mô hình, từng điểm) + `model` + `costUsd`. */
    qc: jsonb("qc").$type<Record<string, unknown>>().notNull().default({}),
    qcAt: ts("qc_at"),
    finalAssetId: text("final_asset_id").references(() => videoScaleAssets.id, { onDelete: "set null" }),
    thumbnailAssetId: text("thumbnail_asset_id").references(() => videoScaleAssets.id, { onDelete: "set null" }),
    durationMs: integer("duration_ms"),
    /** Người duyệt / loại (mục 34). `auto_approved = true` và người `NULL` = MÁY duyệt theo `AUTO_ON_PASS`. */
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedBy: text("reviewed_by").notNull().default(""),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note").notNull().default(""),
    autoApproved: boolean("auto_approved").notNull().default(false),
    isTest: boolean("is_test").notNull().default(false),
    error: text("error").notNull().default(""),
    /** Các phương án content máy viết (`CaptionOption[]`: móc câu · thân · CTA · hashtag). */
    captionOptions: jsonb("caption_options").$type<Record<string, unknown>[]>().notNull().default([]),
    /** Content SẼ ĐĂNG (người sửa được). */
    caption: text("caption").notNull().default(""),
    /** `''` chưa có · `DRAFTED` máy viết, chưa ai chốt · `READY` đã chốt (người, hoặc máy khi đăng tự động). */
    captionState: text("caption_state").notNull().default(""),
    captionModel: text("caption_model").notNull().default(""),
    captionCostUsd: doublePrecision("caption_cost_usd"),
    /** Người chốt content (mục 34). `NULL` + `READY` = máy chốt khi đăng tự động. */
    captionByUserId: text("caption_by_user_id").references(() => users.id, { onDelete: "set null" }),
    captionBy: text("caption_by").notNull().default(""),
    captionAt: ts("caption_at"),
    /** Tuỳ chọn dựng RIÊNG của video (`VideoRenderOptions`) — ghi đè cấu hình lượt khi người sửa video. */
    renderOptions: jsonb("render_options").$type<Record<string, unknown>>().notNull().default({}),
    /** Số lần NGƯỜI dựng lại video (0 = bản đầu). Đi vào khoá việc dựng để mỗi lần sửa là một việc mới. */
    renderRev: integer("render_rev").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("video_scale_variants_caption_state_check", sql`${t.captionState} IN ('', 'DRAFTED', 'READY')`),
    uniqueIndex("video_scale_variants_run_seq_uq").on(t.runId, t.seq),
    index("video_scale_variants_product_idx").on(t.productId, t.createdAt),
    index("video_scale_variants_status_idx").on(t.status),
    check(
      "video_scale_variants_status_check",
      sql`${t.status} IN ('SCRIPTED', 'GENERATING', 'RENDERING', 'QC', 'REVIEW', 'APPROVED', 'REJECTED', 'QC_FAILED', 'FAILED', 'CANCELLED')`,
    ),
    check("video_scale_variants_qc_check", sql`${t.qcVerdict} IS NULL OR ${t.qcVerdict} IN ('PASS', 'FLAG', 'FAIL')`),
    // Ranh giới 4: video QC loại không bao giờ ở trạng thái ĐÃ DUYỆT; duyệt phải có bản hoàn chỉnh và mốc duyệt.
    check(
      "video_scale_variants_approve_check",
      sql`${t.status} <> 'APPROVED' OR (${t.qcVerdict} IN ('PASS', 'FLAG') AND ${t.finalAssetId} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
    // Máy chỉ tự duyệt video QC ĐẠT; video "nghi ngờ" phải có người.
    check("video_scale_variants_auto_check", sql`${t.autoApproved} = false OR (${t.qcVerdict} = 'PASS' AND ${t.reviewedByUserId} IS NULL)`),
  ],
);

/**
 * HÀNG ĐỢI VIỆC của Video Scale. Mỗi việc có khoá chống trùng (`idempotency_key`, duy nhất) — dựng lại việc cho cùng cảnh
 * cùng lượt không đẻ dòng thứ hai. Cầm việc bằng `UPDATE … WHERE status IN (…) AND (locked_until IS NULL OR locked_until < now())`.
 */
export const videoScaleJobs = pgTable(
  "video_scale_jobs",
  {
    id: id(),
    kind: text("kind").notNull(),
    runId: text("run_id").references(() => videoScaleRuns.id, { onDelete: "set null" }),
    variantId: text("variant_id").references(() => videoScaleVariants.id, { onDelete: "set null" }),
    sceneIndex: integer("scene_index"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    lockToken: text("lock_token").notNull().default(""),
    provider: text("provider").notNull().default(""),
    model: text("model").notNull().default(""),
    /** Mã thao tác ở nhà cung cấp (Veo: `models/…/operations/…`). Có mã ⇒ lượt sau chỉ HỎI, không tạo lại. */
    providerRef: text("provider_ref").notNull().default(""),
    /** Ghi NGAY TRƯỚC lời gọi tạo tốn tiền, xoá cùng lúc lưu `provider_ref` (ranh giới 3). */
    providerPendingAt: ts("provider_pending_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    /** Hạn chót của cả việc (vd clip chờ Veo tối đa `VIDEO_CLIP_DEADLINE_MS`). */
    deadlineAt: ts("deadline_at"),
    /** Tiền của lượt (USD). `NULL` = CHƯA BIẾT / chưa phát sinh — không phải 0. */
    costUsd: doublePrecision("cost_usd"),
    /** `ESTIMATED` (theo bảng giá công bố) — nhà cung cấp không trả số tiền. `''` khi chưa có tiền. */
    costBasis: text("cost_basis").notNull().default(""),
    /** Tiền GIỮ CHỖ trong trần ngày khi việc đang bay — tránh vượt trần vì nhiều việc cùng lúc. */
    reservedUsd: doublePrecision("reserved_usd"),
    /** Ngày (giờ VN, `YYYY-MM-DD`) mà tiền / giữ chỗ tính vào trần. */
    costDay: text("cost_day").notNull().default(""),
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error").notNull().default(""),
    errorKind: text("error_kind").notNull().default(""),
    outputAssetId: text("output_asset_id").references(() => videoScaleAssets.id, { onDelete: "set null" }),
    /** Bài Reel mà việc `PUBLISH_REEL` phục vụ. */
    postId: text("post_id"),
    /** Quảng cáo mà việc `CREATE_AD` / `PAUSE_AD` phục vụ. */
    adId: text("ad_id"),
    isTest: boolean("is_test").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("video_scale_jobs_idem_uq").on(t.idempotencyKey),
    index("video_scale_jobs_due_idx").on(t.status, t.nextRunAt),
    index("video_scale_jobs_variant_idx").on(t.variantId),
    index("video_scale_jobs_cost_day_idx").on(t.costDay),
    check("video_scale_jobs_kind_check", sql`${t.kind} IN ('SCRIPT', 'CLIP', 'TTS', 'RENDER', 'QC', 'CAPTION', 'PUBLISH_REEL', 'CREATE_AD', 'PAUSE_AD')`),
    check("video_scale_jobs_status_check", sql`${t.status} IN ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')`),
    check("video_scale_jobs_error_kind_check", sql`${t.errorKind} IN ('', 'TRANSIENT', 'PERMANENT', 'AMBIGUOUS', 'TIMEOUT', 'BLOCKED')`),
    check("video_scale_jobs_cost_basis_check", sql`${t.costBasis} IN ('', 'ESTIMATED')`),
    check("video_scale_jobs_attempts_check", sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
  ],
);

/**
 * THƯ VIỆN NHẠC CÓ QUYỀN SỬ DỤNG. Không có dòng nào ⇒ video không có nhạc nền (không bao giờ tự lấy nhạc ở đâu khác).
 * `license_note` bắt buộc: người tải khai nguồn + quyền (mua gói, nhạc tự làm, thư viện miễn phí bản quyền…).
 */
export const videoScaleMusic = pgTable(
  "video_scale_music",
  {
    id: id(),
    title: text("title").notNull(),
    licenseNote: text("license_note").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => videoScaleAssets.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    uploadedBy: text("uploaded_by").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [check("video_scale_music_license_check", sql`length(btrim(${t.licenseNote})) >= 10`), check("video_scale_music_title_check", sql`length(btrim(${t.title})) > 0`)],
);

/**
 * BÀI REEL trên fanpage — một dòng cho một (biến thể, fanpage). Thử lại dùng lại ĐÚNG dòng này, nên một biến thể không bao
 * giờ thành hai bài trên cùng fanpage. `pending_step` ghi NGAY TRƯỚC lời gọi ghi Facebook (cùng lối `fb_pending_step`).
 */
export const videoScalePosts = pgTable(
  "video_scale_posts",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references(() => videoScaleVariants.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    pageId: text("page_id").notNull(),
    /** `QUEUED` · `UPLOADING` · `PROCESSING` · `SCHEDULED` · `PUBLISHED` · `FAILED` · `CANCELLED`. */
    status: text("status").notNull().default("QUEUED"),
    /** Content ĐÚNG như đã gửi Facebook (ảnh chụp lúc duyệt đăng). */
    caption: text("caption").notNull(),
    /** Hẹn giờ đăng. `NULL` = đăng ngay. */
    publishAt: ts("publish_at"),
    fbVideoId: text("fb_video_id").notNull().default(""),
    fbPostId: text("fb_post_id").notNull().default(""),
    permalink: text("permalink").notNull().default(""),
    publishedAt: ts("published_at"),
    uploadedAt: ts("uploaded_at"),
    pendingStep: text("pending_step").notNull().default(""),
    pendingAt: ts("pending_at"),
    error: text("error").notNull().default(""),
    /** Ai cho phép đăng (mục 34). `auto = true` và người `NULL` = MÁY đăng theo `AUTO_PUBLISH` của fanpage. */
    authorizedByUserId: text("authorized_by_user_id").references(() => users.id, { onDelete: "set null" }),
    authorizedBy: text("authorized_by").notNull().default(""),
    auto: boolean("auto").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("video_scale_posts_variant_page_uq").on(t.variantId, t.pageId),
    index("video_scale_posts_page_idx").on(t.pageId, t.createdAt),
    check("video_scale_posts_status_check", sql`${t.status} IN ('QUEUED', 'UPLOADING', 'PROCESSING', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED')`),
    check("video_scale_posts_published_check", sql`${t.status} <> 'PUBLISHED' OR (${t.fbVideoId} <> '' AND ${t.publishedAt} IS NOT NULL)`),
    check("video_scale_posts_caption_check", sql`length(btrim(${t.caption})) > 0`),
    check("video_scale_posts_auto_check", sql`${t.auto} = false OR ${t.authorizedByUserId} IS NULL`),
  ],
);

/**
 * QUẢNG CÁO của một video — một dòng cho một (biến thể, tài khoản quảng cáo). Mỗi quảng cáo một chiến dịch riêng (ABO: ngân
 * sách ở NHÓM), dựng TẮT; chỉ bật ở bước cuối. `pending_step` ghi NGAY TRƯỚC lời gọi tạo, xoá cùng lúc lưu id.
 */
export const videoScaleAds = pgTable(
  "video_scale_ads",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references(() => videoScaleVariants.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    postId: text("post_id").references(() => videoScalePosts.id, { onDelete: "set null" }),
    pageId: text("page_id").notNull(),
    adAccountId: text("ad_account_id").notNull(),
    /** Chế độ lúc lập (`VIDEO_ADS_MODES`) — `AUTO_LAUNCH` ⇒ máy bật khi dựng xong và cổng cho phép. */
    mode: text("mode").notNull(),
    status: text("status").notNull().default("DRAFT"),
    dailyBudgetVnd: integer("daily_budget_vnd").notNull(),
    campaignName: text("campaign_name").notNull(),
    adsetName: text("adset_name").notNull(),
    adName: text("ad_name").notNull(),
    message: text("message").notNull(),
    templateAdId: text("template_ad_id").notNull(),
    fbVideoId: text("fb_video_id").notNull().default(""),
    fbImageHash: text("fb_image_hash").notNull().default(""),
    fbCreativeId: text("fb_creative_id").notNull().default(""),
    fbCampaignId: text("fb_campaign_id").notNull().default(""),
    fbAdsetId: text("fb_adset_id").notNull().default(""),
    fbAdId: text("fb_ad_id").notNull().default(""),
    pendingStep: text("pending_step").notNull().default(""),
    pendingAt: ts("pending_at"),
    error: text("error").notNull().default(""),
    /** Ai cho phép dựng (mục 34). `NULL` = máy theo chế độ của mã. */
    authorizedByUserId: text("authorized_by_user_id").references(() => users.id, { onDelete: "set null" }),
    authorizedBy: text("authorized_by").notNull().default(""),
    activatedAt: ts("activated_at"),
    activatedBy: text("activated_by").notNull().default(""),
    stoppedAt: ts("stopped_at"),
    stopReason: text("stop_reason").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("video_scale_ads_variant_account_uq").on(t.variantId, t.adAccountId),
    uniqueIndex("video_scale_ads_fb_ad_uq").on(t.fbAdId).where(sql`${t.fbAdId} <> ''`),
    index("video_scale_ads_product_idx").on(t.productId, t.status),
    check("video_scale_ads_mode_check", sql`${t.mode} IN ('DRAFT', 'PUBLISH_PAUSED', 'AUTO_LAUNCH')`),
    check("video_scale_ads_status_check", sql`${t.status} IN ('DRAFT', 'QUEUED', 'CREATING', 'PAUSED', 'ACTIVE', 'FAILED', 'STOPPED')`),
    check("video_scale_ads_budget_check", sql`${t.dailyBudgetVnd} BETWEEN 20000 AND 500000`),
    // "Đang chạy" / "đang tắt" mà không có quảng cáo trên Facebook là một khẳng định không có chứng từ.
    check("video_scale_ads_live_check", sql`${t.status} NOT IN ('PAUSED', 'ACTIVE') OR (${t.fbAdId} <> '' AND ${t.fbCampaignId} <> '')`),
  ],
);

/**
 * SỔ GHI QUẢNG CÁO của Video Scale — mọi lượt xin tạo / bật / tắt / đổi ngân sách, KỂ CẢ lượt bị chặn (cùng lý do
 * `creative_fb_actions`): "máy đã ĐỊNH làm gì" là thông tin quý nhất khi đánh giá một cỗ máy tiêu tiền.
 */
export const videoScaleAdActions = pgTable(
  "video_scale_ad_actions",
  {
    id: id(),
    adId: text("ad_id").references(() => videoScaleAds.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    denial: text("denial").notNull().default(""),
    detail: text("detail").notNull().default(""),
    budgetBeforeVnd: integer("budget_before_vnd"),
    budgetAfterVnd: integer("budget_after_vnd"),
    /** Người (mục 34). `NULL` = máy (tự bật / tự tắt / tự tăng theo cấu hình người đã duyệt). */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actor: text("actor").notNull().default(""),
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("video_scale_ad_actions_ad_idx").on(t.adId, t.createdAt),
    check("video_scale_ad_actions_action_check", sql`${t.action} IN ('CREATE', 'ACTIVATE', 'PAUSE', 'SET_BUDGET')`),
    check("video_scale_ad_actions_outcome_check", sql`${t.outcome} IN ('APPLIED', 'DENIED', 'FAILED')`),
  ],
);

/**
 * PHÁN QUYẾT hằng ngày của một quảng cáo video (`judgeVariant` của vòng mẫu ảnh — cùng luật tắt / luật giữ) + hành động máy
 * đã làm. Một dòng / (quảng cáo, ngày VN) — lượt tối ưu chạy lại trong ngày chỉ cập nhật.
 */
export const videoScaleVerdicts = pgTable(
  "video_scale_verdicts",
  {
    id: id(),
    adId: text("ad_id")
      .notNull()
      .references(() => videoScaleAds.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    verdict: text("verdict").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    /** Số đo lúc chấm: chi (sổ `ad_spends`), hiển thị, nhấp, tin nhắn, đơn chốt / giao / hoàn, doanh thu. */
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    action: text("action").notNull().default("NONE"),
    actionResult: text("action_result").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("video_scale_verdicts_ad_day_uq").on(t.adId, t.day), check("video_scale_verdicts_action_check", sql`${t.action} IN ('NONE', 'PAUSE', 'SCALE', 'RECOMMEND_SCALE')`)],
);

/**
 * SỐ ĐO VIDEO CỦA META theo quảng cáo × ngày — lượt xem 3 giây, ThruPlay, 25/50/75/100%. Đây là số của META, KHÔNG phải
 * tiền: tiền quảng cáo có MỘT nguồn (`ad_spends`, mục 15). `NULL` = Meta không trả chỉ số đó (chưa biết), không phải 0.
 */
export const videoScaleAdMetrics = pgTable(
  "video_scale_ad_metrics",
  {
    id: id(),
    adId: text("ad_id")
      .notNull()
      .references(() => videoScaleAds.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    videoPlays: integer("video_plays"),
    thruplays: integer("thruplays"),
    p25: integer("p25"),
    p50: integer("p50"),
    p75: integer("p75"),
    p100: integer("p100"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("video_scale_ad_metrics_ad_day_uq").on(t.adId, t.day)],
);

/** Ảnh chụp số đo BÀI REEL (không trả tiền) — lượt phát, người xem, cảm xúc, bình luận, chia sẻ. Lỗi đọc ghi vào `error`. */
export const videoScaleReelMetrics = pgTable(
  "video_scale_reel_metrics",
  {
    id: id(),
    postId: text("post_id")
      .notNull()
      .references(() => videoScalePosts.id, { onDelete: "cascade" }),
    plays: integer("plays"),
    reach: integer("reach"),
    reactions: integer("reactions"),
    comments: integer("comments"),
    shares: integer("shares"),
    error: text("error").notNull().default(""),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("video_scale_reel_metrics_post_idx").on(t.postId, t.capturedAt)],
);

/**
 * BÀI HỌC của một biến thể — thứ người viết kịch bản đọc ở vòng sau, và thứ sổ học theo góc đếm. Một dòng / (biến thể,
 * nguồn): `AD` = kết luận từ số đo quảng cáo · `REVIEW` = người loại video kèm lý do. Chữ là câu ĐÃ ĐẾM, không phải ý kiến
 * của mô hình.
 */
export const videoScaleLessons = pgTable(
  "video_scale_lessons",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references(() => videoScaleVariants.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    angle: text("angle").notNull(),
    angleVocabVersion: integer("angle_vocab_version").notNull(),
    hook: text("hook").notNull().default(""),
    verdict: text("verdict").notNull(),
    success: boolean("success"),
    summary: text("summary").notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("video_scale_lessons_variant_source_uq").on(t.variantId, t.source),
    index("video_scale_lessons_product_idx").on(t.productId, t.createdAt),
    check("video_scale_lessons_source_check", sql`${t.source} IN ('AD', 'REVIEW')`),
  ],
);

// ═══ PHASE 3 — WORKFLOW FOUNDATION (docs/platform/phase-3-contracts.md mục 1) ═══
//
// Luật là metadata của tổ chức (CSDL tổ chức). Luật MỚI luôn DRAFT + DRY_RUN (W1 — luật 23, 25): không
// luật nào tự chạy thật khi vừa tạo. `workflow_runs.dedupe_key` UNIQUE ⇒ chạy lại không nhân đôi (W6).

export const workflowRules = pgTable(
  "workflow_rules",
  {
    id: id(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("DRAFT"),
    mode: text("mode").notNull().default("DRY_RUN"),
    trigger: jsonb("trigger").notNull(),
    conditions: jsonb("conditions"),
    actions: jsonb("actions").notNull().default([]),
    gate: jsonb("gate"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    activatedBy: text("activated_by"),
    activatedAt: ts("activated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workflow_rules_key_uq").on(t.key),
    check("workflow_rules_status_check", sql`${t.status} in ('DRAFT','ACTIVE','PAUSED','ARCHIVED')`),
    check("workflow_rules_mode_check", sql`${t.mode} in ('DRY_RUN','LIVE')`),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    mode: text("mode").notNull(),
    triggerKind: text("trigger_kind").notNull(),
    triggerRef: text("trigger_ref").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull(),
    steps: jsonb("steps").notNull().default([]),
    causationDepth: integer("causation_depth").notNull().default(0),
    approvalRequestId: text("approval_request_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts("finished_at"),
    // Phase 3.1 (0162): hạn giữ của tiến trình đang thực thi. `attempt` = số lần đã CHIẾM lượt chạy; PENDING mà
    // quá `lease_until` ⇒ tiến trình đã chết, lượt sau chiếm lại (lib/workflow/engine.ts). Dòng cũ: 0 / NULL.
    attempt: integer("attempt").notNull().default(0),
    leaseUntil: ts("lease_until"),
    lastHeartbeatAt: ts("last_heartbeat_at"),
  },
  (t) => [
    uniqueIndex("workflow_runs_dedupe_uq").on(t.dedupeKey),
    index("workflow_runs_rule_idx").on(t.ruleId, t.createdAt),
    index("workflow_runs_status_idx").on(t.status),
    check("workflow_runs_status_check", sql`${t.status} in ('DRY_RUN','PENDING','WAITING_APPROVAL','DONE','SKIPPED','FAILED','REJECTED')`),
  ],
);

/** Con trỏ tiêu thụ (vd `domain_events`) — chỉ tiến. */
export const workflowCursors = pgTable("workflow_cursors", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});

/**
 * LƯỢT MỞ TRANG THEO NGÀY (`lib/constants/page-usage.ts`). Một dòng = (ngày VN, mục trang đã khai) —
 * KHÔNG có cột người: câu hỏi là "màn hình có được dùng không", không phải "ai mở". `page_key` là
 * mục menu / trang con đã khai (hoặc `(khác)`), không bao giờ là đường dẫn thô mang mã đơn / mã mẫu.
 */
export const pageVisitDaily = pgTable(
  "page_visit_daily",
  {
    day: text("day").notNull(),
    pageKey: text("page_key").notNull(),
    visits: integer("visits").notNull().default(0),
    lastAt: ts("last_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_visit_daily_pk").on(t.day, t.pageKey),
    check("page_visit_daily_day_check", sql`${t.day} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    check("page_visit_daily_visits_check", sql`${t.visits} >= 0`),
    check("page_visit_daily_key_check", sql`length(${t.pageKey}) between 1 and 120`),
  ],
);

// ═══ PHASE 4 — DYNAMIC PAGE RUNTIME (docs/platform/phase-4-contracts.md mục 2) ═══
//
// Trang là metadata của tổ chức (CSDL tổ chức). Người dùng CHỈ thấy `published`; `draft` là của trình soạn.
// Không mã riêng cho trang nào: một schema (section → khối), một renderer (`app/(dashboard)/p/[slug]`).

export const metaPages = pgTable(
  "meta_pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    moduleKey: text("module_key").notNull(),
    requiredPermission: text("required_permission"),
    nav: jsonb("nav").notNull().default({ enabled: false, label: "", zone: null, order: 0 }),
    status: text("status").notNull().default("ACTIVE"),
    draft: jsonb("draft"),
    published: jsonb("published"),
    publishedVersion: integer("published_version").notNull().default(0),
    publishedAt: ts("published_at"),
    publishedBy: text("published_by"),
    /** Phase 5 · chống ghi đè nháp: mỗi lượt lưu nháp +1; trình soạn gửi `baseRevision`, lệch ⇒ CONFLICT (migration 0167). */
    draftRevision: integer("draft_revision").notNull().default(0),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meta_pages_slug_uq").on(t.slug),
    check("meta_pages_status_check", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
    check("meta_pages_slug_check", sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,60}$'`),
  ],
);

// ═══ PHASE 9 — KẾT NỐI THEO TỔ CHỨC (docs/platform/phase-9-contracts.md §2) ═══
//
// Bảng trong CSDL CỦA TỔ CHỨC — không có cột tổ chức nào để lọc sai, vì mỗi tổ chức một CSDL (X6). `org_code` chỉ là
// dây bẫy: dòng chép sang CSDL khác sẽ lệch mã với ngữ cảnh và bị từ chối. Bí mật nằm ở `secrets_enc` (AES-256-GCM,
// khoá HKDF từ PLATFORM_SECRETS_KEY, AAD gắn mã tổ chức + khoá connector — lib/connectors/secrets.ts); `secret_hints`
// chỉ giữ `••••` + 4 ký tự cuối để hiện mà không phải giải mã. Credential của tổ chức nhà KHÔNG chuyển vào đây (X7).
export const orgConnections = pgTable(
  "org_connections",
  {
    id: id(),
    orgCode: text("org_code").notNull(),
    connectorKey: text("connector_key").notNull(),
    status: text("status").notNull().default("DRAFT"),
    settings: jsonb("settings").notNull().default({}),
    secretsEnc: bytea("secrets_enc"),
    secretsKeyId: text("secrets_key_id"),
    secretHints: jsonb("secret_hints").notNull().default({}),
    lastTestAt: ts("last_test_at"),
    lastTestOk: boolean("last_test_ok"),
    lastTestMessage: text("last_test_message"),
    activatedAt: ts("activated_at"),
    activatedBy: text("activated_by"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("org_connections_connector_uq").on(t.connectorKey),
    check("org_connections_status_check", sql`${t.status} in ('DRAFT','ACTIVE','DISABLED')`),
    check("org_connections_active_tested_check", sql`${t.status} <> 'ACTIVE' or ${t.lastTestOk} = true`),
    check("org_connections_key_check", sql`${t.connectorKey} ~ '^[a-z][a-z0-9-]{1,60}$'`),
  ],
);

// ═══ NHIỀU PAGE DƯỚI MỘT KẾT NỐI (0220 · docs/messaging-providers.md §7) ═══
//
// `org_connections` giữ MỘT hàng mỗi loại kết nối (UNIQUE connector_key) ⇒ Messenger trực tiếp từng chỉ giữ được một page: nối
// page B ghi đè page A. Bảng con này là các TÀI KHOẢN KÊNH (Facebook page · Instagram gắn với page) dưới một kết nối — mỗi page
// một hàng, token mã hoá RIÊNG (AAD gắn tổ chức + kết nối + page, nên token của page này không giải được ở hàng page khác),
// trạng thái người chọn (`status`), bật / tắt AI theo page, và sức khoẻ MÁY ghi (mốc tin gần nhất, lỗi gần nhất). Lỗi của page A
// không đụng page B. Chỉ đọc / ghi qua lib/connectors/service.ts (cùng luật với org_connections). Tổ chức nối từ trước không có
// hàng nào ⇒ đọc như cũ từ hàng kết nối đơn — không backfill.
export const orgChannelPages = pgTable(
  "org_channel_pages",
  {
    id: id(),
    orgCode: text("org_code").notNull(),
    connectorKey: text("connector_key").notNull(),
    pageId: text("page_id").notNull(),
    kind: text("kind").notNull().default("PAGE"),
    /** Instagram: page Facebook mà tài khoản gắn vào. */
    parentPageId: text("parent_page_id"),
    name: text("name").notNull().default(""),
    status: text("status").notNull().default("ACTIVE"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    secretsEnc: bytea("secrets_enc"),
    secretsKeyId: text("secrets_key_id"),
    lastEventAt: ts("last_event_at"),
    lastError: text("last_error"),
    lastErrorAt: ts("last_error_at"),
    connectedByUserId: text("connected_by_user_id"),
    connectedByName: text("connected_by_name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("org_channel_pages_key").on(t.connectorKey, t.pageId),
    check("org_channel_pages_status_check", sql`${t.status} in ('ACTIVE','DISABLED')`),
    check("org_channel_pages_kind_check", sql`${t.kind} in ('PAGE','INSTAGRAM')`),
  ],
);

// ═══ PHASE 7 — BLUEPRINT + MẪU NGÀNH (docs/platform/phase-7-contracts.md mục 3) ═══
//
// Sổ cài đặt của gói metadata trong CSDL tổ chức. `blueprint_items` giữ hai băm của phép so ba chiều X4: băm của mục
// trong GÓI (`template_hash`) và băm của thực thể ngay sau khi cài (`applied_hash`). Chỉ `lib/blueprints/ledger.ts` ghi
// hai bảng này; bộ cài không ghi thẳng bảng metadata nào (đi qua dịch vụ sẵn có).

export const blueprintInstalls = pgTable(
  "blueprint_installs",
  {
    id: id(),
    blueprintKey: text("blueprint_key").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("RUNNING"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    installedBy: text("installed_by"),
    installedByEmail: text("installed_by_email"),
    plan: jsonb("plan").notNull().default({}),
    result: jsonb("result"),
    error: text("error"),
  },
  (t) => [
    index("blueprint_installs_key_idx").on(t.blueprintKey, t.installedAt),
    check("blueprint_installs_status_check", sql`${t.status} in ('RUNNING','DONE','FAILED')`),
    check("blueprint_installs_key_check", sql`${t.blueprintKey} ~ '^[a-z][a-z0-9-]{1,40}$'`),
    check("blueprint_installs_version_check", sql`${t.version} ~ '^[0-9]{1,5}\\.[0-9]{1,5}\\.[0-9]{1,5}$'`),
  ],
);

export const blueprintItems = pgTable(
  "blueprint_items",
  {
    installId: text("install_id")
      .notNull()
      .references(() => blueprintInstalls.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    templateHash: text("template_hash").notNull(),
    appliedHash: text("applied_hash"),
    action: text("action").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("blueprint_items_pk").on(t.installId, t.kind, t.key),
    check("blueprint_items_kind_check", sql`${t.kind} in ('module','role','object','field','status','form','list','page','workflow','setting','ai')`),
    check("blueprint_items_action_check", sql`${t.action} in ('CREATE','UPDATE','UNCHANGED','SKIP_CUSTOMIZED','SKIP_DELETED','CONFLICT')`),
  ],
);

// ═══ PHASE 6 — ĐỐI TƯỢNG TUỲ BIẾN (docs/platform/phase-6-contracts.md mục 1) ═══
//
// KHÔNG có bảng vật lý cho mỗi đối tượng (X5): định nghĩa đối tượng ở `meta_objects`, bản ghi (CỘT HỆ THỐNG) ở
// `custom_records`, giá trị field ở `custom_values` (như mọi field tuỳ biến của Phase 2), định nghĩa field ở
// `meta_custom_fields` với `object_key = x_…`. Tiền tố `x_` ⇒ khoá tuỳ biến không bao giờ trùng khoá hệ thống.

/** Định nghĩa đối tượng tuỳ biến. Khoá BẤT BIẾN; không xoá — `ARCHIVED` (dữ liệu giữ nguyên). */
export const metaObjects = pgTable(
  "meta_objects",
  {
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    labelPlural: text("label_plural").notNull(),
    icon: text("icon").notNull().default("box"),
    /** Nhóm menu (khoá module có thật). Module đó tắt ⇒ đối tượng ẩn. */
    moduleKey: text("module_key").notNull().default("apps"),
    titleLabel: text("title_label").notNull().default("Tên"),
    description: text("description"),
    viewPermission: text("view_permission").notNull().default("records:view"),
    writePermission: text("write_permission").notNull().default("records:write"),
    status: text("status").notNull().default("ACTIVE"),
    /** Dấu gốc (`template:<khoá>@<phiên bản>` — X4). `null` = tổ chức tự tạo. */
    origin: text("origin"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("meta_objects_key_check", sql`${t.key} ~ '^x_[a-z][a-z0-9_]{1,40}$'`),
    check("meta_objects_status_check", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
  ],
);

/** Bản ghi của đối tượng tuỳ biến — chỉ cột hệ thống; mọi field khác ở `custom_values`. Xoá = `deleted_at`. */
export const customRecords = pgTable(
  "custom_records",
  {
    id: id(),
    objectKey: text("object_key")
      .notNull()
      .references(() => metaObjects.key),
    title: text("title").notNull(),
    /** Chủ bản ghi (`users.id`) — phạm vi dữ liệu SELF / phòng ban lọc theo cột này (luật 34). */
    ownerId: text("owner_id"),
    /** Phiên bản của cột hệ thống — khoá lạc quan + khoá chống trùng của sự kiện `custom_record.updated`. */
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("custom_records_object_idx").on(t.objectKey, t.deletedAt, t.updatedAt),
    index("custom_records_owner_idx").on(t.ownerId),
    // Phase 11 · H2 (migration 0171): đúng thứ tự xếp của `/o/<khoá>` (updated_at) và bảng / kanban trang động
    // (created_at) trên bản ghi CÒN SỐNG — đo trước/sau ở drizzle/0171_custom_records_live_sort.sql.
    index("custom_records_live_updated_idx").on(t.objectKey, t.updatedAt.desc().nullsLast(), t.id).where(sql`${t.deletedAt} is null`),
    index("custom_records_live_created_idx").on(t.objectKey, t.createdAt.desc().nullsLast(), t.id.desc()).where(sql`${t.deletedAt} is null`),
    check("custom_records_title_check", sql`length(btrim(${t.title})) > 0`),
  ],
);

// ═══ PHASE 8 — AI ERP BUILDER (docs/platform/phase-8-contracts.md mục 3) ═══
//
// Bản nháp AI soạn trong CSDL tổ chức. AI không có đường ghi nào của riêng nó: áp dụng = bộ cài Phase 7
// (`installBlueprint` với `expectedPlanHash`). Chỉ `lib/ai-builder/service.ts` ghi bảng này.

export const aiBlueprintDrafts = pgTable(
  "ai_blueprint_drafts",
  {
    id: id(),
    mode: text("mode").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("DRAFT"),
    blueprint: jsonb("blueprint"),
    contextKeys: jsonb("context_keys").notNull().default([]),
    valid: boolean("valid").notNull().default(false),
    validation: jsonb("validation").notNull().default({}),
    error: text("error"),
    excludedKeys: jsonb("excluded_keys").notNull().default([]),
    planHash: text("plan_hash"),
    installId: text("install_id"),
    aiSource: text("ai_source"),
    provider: text("provider"),
    model: text("model"),
    aiCalls: integer("ai_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
    createdBy: text("created_by"),
    createdByEmail: text("created_by_email"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: ts("applied_at"),
    appliedBy: text("applied_by"),
    discardedAt: ts("discarded_at"),
    discardedBy: text("discarded_by"),
  },
  (t) => [
    index("ai_blueprint_drafts_created_idx").on(t.createdAt),
    check("ai_blueprint_drafts_mode_check", sql`${t.mode} in ('new','edit')`),
    check("ai_blueprint_drafts_status_check", sql`${t.status} in ('DRAFT','APPLIED','DISCARDED')`),
    check("ai_blueprint_drafts_applied_check", sql`${t.status} <> 'APPLIED' or ${t.installId} is not null`),
    // 0176: thêm `PLATFORM` (AI do nền tảng trả tiền) — tập LỚN hơn, mọi dòng cũ vẫn hợp lệ.
    check("ai_blueprint_drafts_source_check", sql`${t.aiSource} is null or ${t.aiSource} in ('ORG_CONNECTION','HOME','PLATFORM')`),
  ],
);

/**
 * SỔ GỬI TIN RA NHÓM CHAT CỦA TỔ CHỨC (0180 · lib/messaging/service.ts). Dòng chèn TRƯỚC lượt gửi với `dedupe_key`
 * UNIQUE: lượt làm lại (luật chạy lại, người bấm hai lần) gặp dòng cũ và KHÔNG gửi lần hai. `PENDING` quá hạn mà không
 * biết đã tới nhà cung cấp chưa ⇒ `UNKNOWN`, không tự gửi lại (at-most-once — thà thiếu một tin còn hơn hai tin).
 */
export const messagingDeliveries = pgTable(
  "messaging_deliveries",
  {
    id: id(),
    dedupeKey: text("dedupe_key").notNull(),
    connectorKey: text("connector_key").notNull(),
    destination: text("destination"),
    event: text("event"),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    runId: text("run_id"),
    isTest: boolean("is_test").notNull().default(false),
    title: text("title"),
    body: text("body").notNull(),
    status: text("status").notNull().default("PENDING"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
    /** Số lần đã thử (0186). */
    attempts: integer("attempts").notNull().default(1),
    /** Mốc gửi lại tin hỏng vì mạng TRƯỚC KHI yêu cầu rời máy (0186) — `null` = không gửi lại. */
    nextRetryAt: ts("next_retry_at"),
  },
  (t) => [
    uniqueIndex("messaging_deliveries_dedupe_uq").on(t.dedupeKey),
    index("messaging_deliveries_retry_idx").on(t.status, t.nextRetryAt),
    index("messaging_deliveries_created_idx").on(t.createdAt),
    index("messaging_deliveries_subject_idx").on(t.subjectType, t.subjectId),
    check("messaging_deliveries_status_check", sql`${t.status} IN ('PENDING','SENT','FAILED','UNKNOWN')`),
  ],
);

/** Hội thoại của chatbot bán hàng theo tổ chức (0180 · lib/sales-chatbot/*). `TEST` = khung thử trong ERP; `WEB` = trang chat công khai. */
export const salesChatConversations = pgTable(
  "sales_chat_conversations",
  {
    id: id(),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("OPEN"),
    /** Băm của mã khách truy cập (kênh WEB) / của (page, hội thoại Pancake) (kênh FANPAGE, 0182 — UNIQUE) — không lưu IP. */
    visitorKey: text("visitor_key"),
    customerId: text("customer_id"),
    draftOrderId: text("draft_order_id"),
    orderId: text("order_id"),
    handoffReason: text("handoff_reason"),
    turns: integer("turns").notNull().default(0),
    aiCalls: integer("ai_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Số lượt trả lời bằng CÂU TRẢ LỜI MẪU (0183) — không tốn lượt AI chính. */
    quickReplies: integer("quick_replies").notNull().default(0),
    /** Fanpage (0185): địa chỉ gửi lại của hội thoại + mốc tin cuối hai phía + lịch follow-up khi khách im lặng. */
    pageId: text("page_id"),
    threadId: text("thread_id"),
    lastCustomerAt: ts("last_customer_at"),
    lastBotAt: ts("last_bot_at"),
    waitingSince: ts("waiting_since"),
    followupsSent: integer("followups_sent").notNull().default(0),
    nextFollowupAt: ts("next_followup_at"),
    lastError: text("last_error"),
    /**
     * Hộp thư người (0209 · lib/sales-chatbot/inbox.ts): người đang CẦM hội thoại (khoá `users.id`, luật 34 — không lưu tên)
     * và mốc tin cuối nhân viên gửi TỪ ERP. «Chờ trả lời» = tin khách mới hơn cả tin bot lẫn tin nhân viên.
     */
    assigneeUserId: text("assignee_user_id"),
    assignedAt: ts("assigned_at"),
    lastStaffAt: ts("last_staff_at"),
    /** 0212: lần cuối một NHÂN VIÊN mở hội thoại trong hộp thư — «chưa đọc» = tin khách mới hơn mốc này. */
    staffSeenAt: ts("staff_seen_at"),
    /**
     * 0217: level khách (`lib/sales-chatbot/levels-shared.ts::CUSTOMER_LEVELS`) + SĐT khách của hội thoại — KẾT QUẢ ĐỌC do job làm
     * mới (`refreshConversationLevels`) để lọc / đếm nhanh; `level_at` = lần tính gần nhất. Không phải nguồn sự thật.
     */
    customerLevel: text("customer_level"),
    customerPhone: text("customer_phone"),
    levelAt: ts("level_at"),
    /**
     * 0221 · NHẬP LỊCH SỬ (lib/sales-chatbot/history.ts): mốc tin MỚI NHẤT (mọi phía) đã nhập từ lịch sử kênh — tin khách tới
     * mốc này là LỊCH SỬ, không phải «chờ trả lời»; và lần cuối lượt nhập đọc XONG hội thoại này.
     */
    historyUntil: ts("history_until"),
    historyImportedAt: ts("history_imported_at"),
    /**
     * 0225 · QUẢNG CÁO DẪN KHÁCH VÀO HỘI THOẠI (lib/sales-chatbot/ad-referral-shared.ts): mã mẩu quảng cáo Meta đọc từ gói tin
     * của KHÁCH (Pancake: `ad_clicks` / `ads` / `ad_id` · Messenger: `referral` có `source = ADS`), mốc khách bấm (thiếu ⇒ mốc
     * tin), và nguồn. Chỉ ghi khi mã MỚI khác mã đang lưu. Đơn bot / ghi đơn từ hội thoại đọc ba cột này để ghi `orders.ad_id`
     * nếu mốc nằm trong cửa sổ quy kết (`lib/constants/chat-ad-attribution.ts`). NULL = chưa thấy mã nào, không phải "không
     * đến từ quảng cáo".
     */
    adId: text("ad_id"),
    adSeenAt: ts("ad_seen_at"),
    adSource: text("ad_source"),
    /** Giỏ nháp của khung THỬ (không ghi đơn thật) + mốc tóm tắt đã đọc cho khách — lib/sales-chatbot/engine.ts. */
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sales_chat_conversations_created_idx").on(t.createdAt),
    // ZALO (migration zalo_oa_channel · lib/sales-chatbot/zalo.ts): tin nhắn Zalo OA của CHÍNH shop — khoá hội thoại băm (OA, người dùng Zalo).
    check("sales_chat_conversations_channel_check", sql`${t.channel} IN ('TEST','WEB','FANPAGE','ZALO')`),
    uniqueIndex("sales_chat_conversations_fanpage_key").on(t.visitorKey).where(sql`${t.channel} = 'FANPAGE'`),
    uniqueIndex("sales_chat_conversations_zalo_key").on(t.visitorKey).where(sql`${t.channel} = 'ZALO'`),
    check("sales_chat_conversations_status_check", sql`${t.status} IN ('OPEN','WAITING','HANDOFF','CLOSED')`),
    index("sales_chat_conversations_followup_idx").on(t.status, t.nextFollowupAt),
    index("sales_chat_conversations_inbox_idx").on(t.lastCustomerAt),
    index("sales_chat_conversations_assignee_idx").on(t.assigneeUserId).where(sql`${t.assigneeUserId} is not null`),
    check("sales_chat_conversations_level_check", sql`${t.customerLevel} IS NULL OR ${t.customerLevel} IN ('ORDERED','UPSELL_REPLY','FULL_INFO_ORDER','FULL_INFO_NO_ITEM','PHONE_ONLY','ADDRESS_ONLY','PICKED_ITEM','MEASUREMENTS','NEW_MESSAGE','DECLINED')`),
    index("sales_chat_conversations_level_idx").on(t.customerLevel).where(sql`${t.customerLevel} is not null`),
    index("sales_chat_conversations_phone_idx").on(t.customerPhone).where(sql`${t.customerPhone} is not null`),
    check("sales_chat_conversations_ad_source_check", sql`${t.adSource} IS NULL OR ${t.adSource} IN ('PANCAKE','MESSENGER')`),
  ],
);

/**
 * TIN NHÂN VIÊN GỬI TỪ HỘP THƯ ERP (0209 · lib/sales-chatbot/inbox.ts). Một dòng cho MỘT lượt bấm «Gửi»: ai gửi (khoá
 * `users.id` + ảnh chụp tên do MÁY CHỦ đọc — luật 34), gửi gì, kênh nào, kết quả. `request_key` do form sinh mỗi lần soạn ⇒
 * bấm hai lần / trình duyệt gửi lại không gửi khách hai tin. Đây là nguồn quy kết theo NGƯỜI mà tin nhân viên gõ ngoài ERP
 * (Pancake / Hộp thư Meta / Zalo OA) không bao giờ có.
 */
export const salesChatStaffMessages = pgTable(
  "sales_chat_staff_messages",
  {
    id: id(),
    conversationId: text("conversation_id").notNull(),
    requestKey: text("request_key").notNull(),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull().default(""),
    channel: text("channel").notNull(),
    text: text("text").notNull(),
    /** SENDING ⇒ SENT | FAILED. FAILED không vào lịch sử của bot và không tính là «đã trả lời». */
    status: text("status").notNull().default("SENDING"),
    error: text("error"),
    sentAt: ts("sent_at"),
    /** 0211: phần CHỮ đã tới khách — gửi lại một tin hỏng giữa chừng chỉ gửi phần còn thiếu (ảnh), không gửi chữ lần hai. */
    textSentAt: ts("text_sent_at"),
    imageCount: integer("image_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_chat_staff_messages_request_key").on(t.conversationId, t.requestKey),
    index("sales_chat_staff_messages_conv_idx").on(t.conversationId, t.createdAt),
    check("sales_chat_staff_messages_status_check", sql`${t.status} IN ('SENDING','SENT','FAILED')`),
  ],
);

/** Ảnh nhân viên gửi kèm tin từ hộp thư (0211). Lưu bản gốc để hộp thư hiện lại ĐÚNG ảnh đã gửi; loại ảnh nhận diện từ byte. */
export const salesChatStaffImages = pgTable(
  "sales_chat_staff_images",
  {
    id: id(),
    staffMessageId: text("staff_message_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    position: integer("position").notNull().default(0),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_chat_staff_images_msg_idx").on(t.staffMessageId, t.position),
    check("sales_chat_staff_images_type_check", sql`${t.contentType} IN ('image/jpeg','image/png','image/webp')`),
    check("sales_chat_staff_images_size_check", sql`${t.bytes} > 0`),
  ],
);

/**
 * NHÃN HỘI THOẠI (0211 · lib/sales-chatbot/inbox-labels.ts): bộ nhãn của tổ chức (tên + màu trong bảng màu đóng). Nhãn chỉ để
 * NGƯỜI phân loại / lọc hộp thư — không tham gia phép tính nào. Gỡ nhãn = lưu trữ (`archived_at`), không xoá dòng đã gắn.
 */
export const salesChatLabels = pgTable(
  "sales_chat_labels",
  {
    id: id(),
    name: text("name").notNull(),
    color: text("color").notNull().default("gray"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [
    uniqueIndex("sales_chat_labels_name_key").on(sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
    check("sales_chat_labels_color_check", sql`${t.color} IN ('gray','red','orange','amber','green','teal','blue','violet','pink')`),
  ],
);

export const salesChatConversationLabels = pgTable(
  "sales_chat_conversation_labels",
  {
    conversationId: text("conversation_id").notNull(),
    labelId: text("label_id").notNull(),
    addedBy: text("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.labelId] }), index("sales_chat_conversation_labels_label_idx").on(t.labelId)],
);

/**
 * GHI CHÚ NỘI BỘ của hội thoại (0211): nhân viên ghi cho nhau — KHÔNG gửi khách, KHÔNG vào lịch sử của bot, KHÔNG phép tính nào
 * đọc. Mang khoá tài khoản + ảnh chụp tên do máy chủ đọc (luật 34). Xoá = đánh dấu (`deleted_at`), không xoá dòng.
 */
/**
 * GÓP Ý CHO AI của nhân viên trên MỘT hội thoại (0216 · lib/sales-chatbot/inbox-feedback.ts): chữ góp ý + bài học «Khi … ⇒ …»
 * AI rút ra (đã nhập vào bộ bài học của bot). Append-only; `FAILED` giữ lại câu góp ý để thử lại.
 */
export const salesChatFeedback = pgTable(
  "sales_chat_feedback",
  {
    id: id(),
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull().default(""),
    text: text("text").notNull(),
    lessons: jsonb("lessons").$type<string[]>().notNull().default([]),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("sales_chat_feedback_conv_idx").on(t.conversationId, t.createdAt), check("sales_chat_feedback_status_check", sql`${t.status} IN ('APPLIED','FAILED')`)],
);

export const salesChatNotes = pgTable(
  "sales_chat_notes",
  {
    id: id(),
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull().default(""),
    text: text("text").notNull(),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (t) => [index("sales_chat_notes_conv_idx").on(t.conversationId, t.createdAt)],
);

/**
 * CÂU TRẢ LỜI MẪU (Q&A) của chatbot bán hàng (0183 · lib/sales-chatbot/quick-replies.ts): câu hỏi phổ biến trả lời bằng câu
 * soạn sẵn — không tốn token AI. Giá / tồn / phí ship trong câu trả lời CHỈ là chỗ trống (`{{giá:SKU}}` · `{{tồn:SKU}}` ·
 * `{{ship}}`) — máy đọc ERP lúc gửi. `LEARNED` = AI gợi ý từ hội thoại cũ, luôn tạo ở trạng thái tắt.
 */
export const salesChatQuickReplies = pgTable(
  "sales_chat_quick_replies",
  {
    id: id(),
    title: text("title").notNull(),
    triggers: text("triggers").array().notNull().default(sql`'{}'::text[]`),
    answer: text("answer").notNull(),
    active: boolean("active").notNull().default(false),
    source: text("source").notNull().default("MANUAL"),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: ts("last_used_at"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sales_chat_quick_replies_active_idx").on(t.active), check("sales_chat_quick_replies_source_check", sql`${t.source} IN ('MANUAL','LEARNED')`)],
);

/** Ảnh gửi kèm một câu trả lời mẫu (0183). `pancake_*` = mã nội dung đã tải lên một page Pancake (dùng lại 12 giờ). */
export const salesChatQuickReplyImages = pgTable(
  "sales_chat_quick_reply_images",
  {
    id: id(),
    quickReplyId: text("quick_reply_id")
      .notNull()
      .references(() => salesChatQuickReplies.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    data: bytea("data").notNull(),
    pancakePageId: text("pancake_page_id"),
    pancakeContentId: text("pancake_content_id"),
    pancakeUploadedAt: ts("pancake_uploaded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_chat_quick_reply_images_reply_idx").on(t.quickReplyId, t.position),
    check("sales_chat_quick_reply_images_type_check", sql`${t.contentType} IN ('image/jpeg','image/png','image/webp')`),
    check("sales_chat_quick_reply_images_size_check", sql`${t.bytes} > 0`),
  ],
);

/**
 * Tin khách gửi tới FANPAGE (0182 · lib/sales-chatbot/fanpage.ts): ghi ngay khi webhook Pancake tới, xử lý sau. `message_id`
 * UNIQUE ⇒ gửi lại / gửi trùng không sinh câu trả lời thứ hai; tin liên tiếp của một hội thoại gom thành một lượt (giành
 * bằng `claim_id` + `claimed_at`).
 */
export const salesChatInbound = pgTable(
  "sales_chat_inbound",
  {
    id: id(),
    pageId: text("page_id").notNull(),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    text: text("text").notNull(),
    customerName: text("customer_name"),
    status: text("status").notNull().default("PENDING"),
    claimId: text("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    note: text("note"),
    /** `INBOX` · `COMMENT` (0184 — bình luận trả lời bằng tin nhắn riêng, không bao giờ công khai). */
    kind: text("kind").notNull().default("INBOX"),
    /** Bình luận: bài viết + người bình luận — Pancake `private_replies` đòi cả hai. */
    postId: text("post_id"),
    fromId: text("from_id"),
    /** Ảnh khách gửi trong tin (0195) — chờ bot đọc. Đọc xong ⇒ mô tả ghép vào `text`, cột về `NULL`. */
    imageUrls: jsonb("image_urls").$type<string[]>(),
    /** 0216: dòng do LƯỢT NHẬP LỊCH SỬ ghi (lib/sales-chatbot/history.ts) — `NULL` = tin sống (webhook / quét lại). */
    importedAt: timestamp("imported_at", { withTimezone: true }),
    /**
     * 0222 — THỬ LẠI + DEAD-LETTER (sau sự cố P0 06/10/2026, lib/sales-chatbot/inbound-retry.ts): số lượt xử lý đã hỏng, mốc
     * được thử lại sớm nhất (lùi dần 2 · 4 · 8 phút), câu lỗi cuối. `status = 'DEAD'` = tin khách bot KHÔNG trả lời được (AI
     * hỏng · gửi hỏng · hết lượt thử) — việc của người, hiện ở cockpit; trước đây chúng bị chốt `DONE` lẫn với tin đã xử lý.
     */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_chat_inbound_message_key").on(t.messageId),
    index("sales_chat_inbound_thread_idx").on(t.pageId, t.threadId, t.status),
    index("sales_chat_inbound_created_idx").on(t.createdAt),
    check("sales_chat_inbound_status_check", sql`${t.status} IN ('PENDING','DONE','SKIPPED','DEAD')`),
    check("sales_chat_inbound_kind_check", sql`${t.kind} IN ('INBOX','COMMENT')`),
  ],
);

/** Tin nhắn của hội thoại chatbot — append-only, `seq` tăng trong hội thoại. `content` = khối `AiBlock[]` (chữ / gọi công cụ / kết quả). */
export const salesChatMessages = pgTable(
  "sales_chat_messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesChatConversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sales_chat_messages_seq_uq").on(t.conversationId, t.seq), check("sales_chat_messages_role_check", sql`${t.role} IN ('user','assistant')`)],
);

/**
 * SỔ SỰ KIỆN HỘI THOẠI BÁN HÀNG (0202 · lib/sales-chatbot/events.ts) — APPEND-ONLY. Mỗi bước có ý nghĩa bán hàng để lại MỘT
 * dòng có mốc: khách nhắn, AI trả lời, chuyển bước, báo giá, khách để lại SĐT, mời / nhận upsell, đơn nháp / chốt, chuyển
 * người, nhân viên nhận, trả lại AI, nhắc khách. Trước sổ này phễu chỉ sống trong `state` jsonb và bị xoá khi sang lượt mua
 * mới — không đo được «AI tự chốt bao nhiêu», «upsell mang thêm bao nhiêu». Không có dòng = chưa đo (trước ngày bật), KHÔNG
 * phải 0. `dedupe_key` UNIQUE: chạy lại không đẻ dòng thứ hai. `payload` là bối cảnh cho người đọc, không vào phép tính tiền.
 */
export const salesConversationEvents = pgTable(
  "sales_conversation_events",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesChatConversations.id, { onDelete: "cascade" }),
    /** Lượt mua trong hội thoại (0 = lượt đầu; khách quay lại mua sau khi chốt ⇒ +1). */
    cycle: integer("cycle").notNull().default(0),
    type: text("type").notNull(),
    actorKind: text("actor_kind").notNull(),
    /** `users.id` khi người làm được biết THẬT (luật 34); Pancake không cho biết nhân viên nào gõ ⇒ `NULL`. */
    actorUserId: text("actor_user_id"),
    channel: text("channel").notNull(),
    /** Mốc của chính sự việc (giờ tin được ghi), không phải lúc dòng sự kiện được ghi. */
    occurredAt: ts("occurred_at").notNull(),
    orderId: text("order_id"),
    /** Số nguyên VND. `NULL` = không áp dụng / chưa biết. */
    amountVnd: bigint("amount_vnd", { mode: "number" }),
    reasonCode: text("reason_code"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_conversation_events_dedupe_uq").on(t.dedupeKey),
    index("sales_conversation_events_conv_idx").on(t.conversationId, t.occurredAt),
    index("sales_conversation_events_type_idx").on(t.type, t.occurredAt),
    check(
      "sales_conversation_events_type_check",
      sql`${t.type} IN ('conversation.opened','message.received','ai.replied','stage.changed','quote.given','customer.identified','upsell.offered','upsell.accepted','upsell.declined','order.drafted','order.confirmed','appointment.booked','handoff.requested','human.took_over','human.replied','ai.resumed','followup.sent','conversation.declined')`,
    ),
    check("sales_conversation_events_actor_check", sql`${t.actorKind} IN ('CUSTOMER','AI','HUMAN','SYSTEM')`),
    check("sales_conversation_events_channel_check", sql`${t.channel} ~ '^[A-Z_]{2,20}$'`),
    check("sales_conversation_events_amount_check", sql`${t.amountVnd} IS NULL OR ${t.amountVnd} >= 0`),
  ],
);

/**
 * PHÁT LẠI HỘI THOẠI CŨ (migration sales_replay · lib/sales-chatbot/replay.ts): một lượt do người bấm + từng điểm (tin khách thật · câu AI sẽ
 * nói ở kênh THỬ · câu thật đã nói · cờ chấm tất định). Tóm tắt là ảnh chụp lúc xong — đổi cấu hình bot sau đó không đổi số cũ.
 */
export const salesReplayRuns = pgTable(
  "sales_replay_runs",
  {
    id: id(),
    status: text("status").notNull().default("RUNNING"),
    targetPoints: integer("target_points").notNull(),
    days: integer("days").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    error: text("error"),
    createdByUserId: text("created_by_user_id"),
    createdByEmail: text("created_by_email"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("sales_replay_runs_started_idx").on(t.startedAt),
    check("sales_replay_runs_status_check", sql`${t.status} IN ('RUNNING','DONE','FAILED')`),
    check("sales_replay_runs_points_check", sql`${t.targetPoints} BETWEEN 1 AND 50`),
  ],
);

export const salesReplayPoints = pgTable(
  "sales_replay_points",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => salesReplayRuns.id, { onDelete: "cascade" }),
    sourceConversationId: text("source_conversation_id").notNull(),
    sourceChannel: text("source_channel").notNull(),
    sourceSeq: integer("source_seq").notNull(),
    customerText: text("customer_text").notNull(),
    historyMessages: integer("history_messages").notNull().default(0),
    historicalReply: text("historical_reply"),
    historicalSpeaker: text("historical_speaker").notNull(),
    aiReply: text("ai_reply"),
    aiStatus: text("ai_status"),
    tools: jsonb("tools").$type<{ name: string; ok: boolean; summary: string }[]>().notNull().default([]),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    ungroundedAmounts: integer("ungrounded_amounts").array().notNull().default(sql`'{}'::integer[]`),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("sales_replay_points_run_idx").on(t.runId), check("sales_replay_points_speaker_check", sql`${t.historicalSpeaker} IN ('BOT','SHOP','NONE')`)],
);

/**
 * QUYẾT ĐỊNH RÀ LỖI AI (0219 · lib/sales-chatbot/quality.ts) — lớp GHI CHÚ của người lên một phát hiện TÍNH LÚC ĐỌC
 * (`quality-shared.ts::scanConversation`). Không có dòng = «chờ rà»; phát hiện không lưu ở đâu cả (phép chiếu, AGENTS §19).
 * Khoá tự nhiên (hội thoại, seq, loại): rà lại một phát hiện là SỬA dòng ấy, không đẻ dòng thứ hai. Người rà mang `users.id`
 * + tên do máy chủ đọc (AGENTS §34).
 */
export const salesAiReviews = pgTable(
  "sales_ai_reviews",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => salesChatConversations.id, { onDelete: "cascade" }),
    messageSeq: integer("message_seq").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    note: text("note"),
    reviewerUserId: text("reviewer_user_id"),
    reviewerName: text("reviewer_name"),
    reviewedAt: ts("reviewed_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_ai_reviews_key").on(t.conversationId, t.messageSeq, t.kind),
    check("sales_ai_reviews_kind_check", sql`${t.kind} IN ('PRICE_UNGROUNDED','TOOL_ERROR','REPEATED_QUESTION')`),
    check("sales_ai_reviews_status_check", sql`${t.status} IN ('CONFIRMED','DISMISSED')`),
  ],
);

/**
 * GỢI Ý COPILOT (migration sales_copilot · lib/sales-chatbot/operating-mode.ts): câu bot soạn ở hội thoại bóng, KHÔNG gửi, ở
 * chế độ COPILOT; câu thật của page tới sau thì máy ghi kèm độ giống + phán quyết. Đo "người dùng lại gợi ý tới đâu".
 */
export const salesCopilotSuggestions = pgTable(
  "sales_copilot_suggestions",
  {
    id: id(),
    conversationId: text("conversation_id").notNull(),
    pageId: text("page_id").notNull(),
    threadId: text("thread_id").notNull(),
    customerText: text("customer_text").notNull(),
    suggestion: text("suggestion"),
    aiStatus: text("ai_status"),
    tools: jsonb("tools").$type<{ name: string; ok: boolean; summary: string }[]>().notNull().default([]),
    error: text("error"),
    humanReply: text("human_reply"),
    humanReplyAt: ts("human_reply_at"),
    similarity: doublePrecision("similarity"),
    verdict: text("verdict"),
    scoredAt: ts("scored_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_copilot_suggestions_thread_idx").on(t.pageId, t.threadId, t.createdAt),
    index("sales_copilot_suggestions_unscored_idx").on(t.createdAt).where(sql`${t.scoredAt} IS NULL`),
    check("sales_copilot_suggestions_verdict_check", sql`${t.verdict} IS NULL OR ${t.verdict} IN ('SAME','EDITED','DIFFERENT','NO_REPLY')`),
    check("sales_copilot_suggestions_similarity_check", sql`${t.similarity} IS NULL OR (${t.similarity} >= 0 AND ${t.similarity} <= 1)`),
  ],
);

/** Lời mời người dùng vào tổ chức (0180 · lib/users/invites.ts). Chỉ lưu BĂM của mã; mã thô hiện đúng một lần. */
/**
 * LIÊN KẾT ĐẶT LẠI MẬT KHẨU (0191) — dùng MỘT lần, hết hạn 24 giờ, chỉ lưu `sha256` của mã. Người tạo: quản trị tổ chức
 * (`ORG_ADMIN`) hoặc người vận hành nền tảng (`PLATFORM`). Đường ghi duy nhất: lib/users/password-reset.ts.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdVia: text("created_via").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByEmail: text("created_by_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("password_reset_tokens_token_uq").on(t.tokenHash), index("password_reset_tokens_user_idx").on(t.userId), check("password_reset_tokens_via_check", sql`${t.createdVia} IN ('ORG_ADMIN','PLATFORM')`)],
);

export const userInvites = pgTable(
  "user_invites",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    accessRoleCode: text("access_role_code"),
    invitedBy: text("invited_by"),
    invitedByEmail: text("invited_by_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedUserId: text("accepted_user_id"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_invites_token_uq").on(t.tokenHash), index("user_invites_email_idx").on(t.email)],
);

// ═══════════ SĂN KHÁCH SỈ (0197, module `wholesale_leads`) ═══════════
// Hai loại dữ liệu tách bảng: `wholesale_place_snapshots` = trường NGUỒN GOOGLE có hạn lưu (`expires_at`); các bảng
// còn lại = dữ liệu CỦA tổ chức (trạng thái bán, người phụ trách, ghi chú, cơ hội…). Xem docs/verticals/wholesale-lead-hunter.md.

export const wholesaleCampaigns = pgTable(
  "wholesale_campaigns",
  {
    id: id(),
    name: text("name").notNull(),
    productFocus: text("product_focus").notNull().default(""),
    status: text("status").notNull().default("DRAFT"),
    pauseReason: text("pause_reason"),
    isTemplate: boolean("is_template").notNull().default(false),
    templateKey: text("template_key"),
    provinces: jsonb("provinces").notNull().default(sql`'[]'::jsonb`),
    keywordGroups: jsonb("keyword_groups").notNull().default(sql`'[]'::jsonb`),
    excludeKeywords: text("exclude_keywords").array().notNull().default(sql`'{}'::text[]`),
    targetSegments: text("target_segments").array().notNull().default(sql`'{}'::text[]`),
    maxLeads: integer("max_leads").notNull().default(500),
    minRating: doublePrecision("min_rating"),
    minReviews: integer("min_reviews"),
    requirePhone: boolean("require_phone").notNull().default(true),
    requireWebsite: boolean("require_website").notNull().default(false),
    searchMode: text("search_mode").notNull().default("TEXT"),
    nearbyLat: doublePrecision("nearby_lat"),
    nearbyLng: doublePrecision("nearby_lng"),
    radiusM: integer("radius_m"),
    discoveryTier: text("discovery_tier").notNull().default("PRO"),
    note: text("note").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    startedAt: ts("started_at"),
    pausedAt: ts("paused_at"),
    stoppedAt: ts("stopped_at"),
    completedAt: ts("completed_at"),
    lastTickAt: ts("last_tick_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("wholesale_campaigns_template_uq").on(t.templateKey),
    index("wholesale_campaigns_status_idx").on(t.status),
    check("wholesale_campaigns_status_check", sql`${t.status} IN ('DRAFT','RUNNING','PAUSED','STOPPED','COMPLETED')`),
    check("wholesale_campaigns_mode_check", sql`${t.searchMode} IN ('TEXT','NEARBY')`),
    check("wholesale_campaigns_tier_check", sql`${t.discoveryTier} IN ('IDS_ONLY','PRO','ENTERPRISE')`),
  ],
);

export const wholesaleSearchCells = pgTable(
  "wholesale_search_cells",
  {
    id: id(),
    cellKey: text("cell_key").notNull(),
    keyword: text("keyword").notNull(),
    provinceKey: text("province_key").notNull(),
    provinceLabel: text("province_label").notNull(),
    areaCode: text("area_code").notNull(),
    areaName: text("area_name").notNull(),
    queryText: text("query_text").notNull(),
    searchMode: text("search_mode").notNull().default("TEXT"),
    scanCount: integer("scan_count").notNull().default(0),
    lastScannedAt: ts("last_scanned_at"),
    lastStatus: text("last_status"),
    lastCampaignId: text("last_campaign_id").references(() => wholesaleCampaigns.id, { onDelete: "set null" }),
    resultsFound: integer("results_found").notNull().default(0),
    newLeadsFound: integer("new_leads_found").notNull().default(0),
    totalNewLeads: integer("total_new_leads").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("wholesale_search_cells_key_uq").on(t.cellKey), index("wholesale_search_cells_province_idx").on(t.provinceKey, t.areaCode)],
);

export const wholesaleCampaignCells = pgTable(
  "wholesale_campaign_cells",
  {
    id: id(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => wholesaleCampaigns.id, { onDelete: "cascade" }),
    cellId: text("cell_id")
      .notNull()
      .references(() => wholesaleSearchCells.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("PENDING"),
    priority: integer("priority").notNull().default(0),
    pageToken: text("page_token"),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    resultsFound: integer("results_found").notNull().default(0),
    newPlaces: integer("new_places").notNull().default(0),
    newLeads: integer("new_leads").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("wholesale_campaign_cells_uq").on(t.campaignId, t.cellId),
    index("wholesale_campaign_cells_queue_idx").on(t.campaignId, t.status, t.priority),
    check("wholesale_campaign_cells_status_check", sql`${t.status} IN ('PENDING','RUNNING','DONE','SKIPPED_FRESH','FAILED','CANCELLED')`),
  ],
);

export const wholesalePlaceSnapshots = pgTable(
  "wholesale_place_snapshots",
  {
    placeId: text("place_id").primaryKey(),
    displayName: text("display_name"),
    formattedAddress: text("formatted_address"),
    nationalPhone: text("national_phone"),
    internationalPhone: text("international_phone"),
    websiteUri: text("website_uri"),
    googleMapsUri: text("google_maps_uri"),
    primaryType: text("primary_type"),
    types: text("types").array().notNull().default(sql`'{}'::text[]`),
    rating: doublePrecision("rating"),
    userRatingCount: integer("user_rating_count"),
    businessStatus: text("business_status"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    normalizedPhone: text("normalized_phone"),
    phoneKind: text("phone_kind"),
    websiteDomain: text("website_domain"),
    nameKey: text("name_key"),
    fieldsTier: text("fields_tier").notNull(),
    fetchedAt: ts("fetched_at").notNull(),
    detailsFetchedAt: ts("details_fetched_at"),
    expiresAt: ts("expires_at").notNull(),
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("wholesale_place_snapshots_expires_idx").on(t.expiresAt).where(sql`${t.purgedAt} IS NULL`),
    index("wholesale_place_snapshots_phone_idx").on(t.normalizedPhone),
    index("wholesale_place_snapshots_domain_idx").on(t.websiteDomain),
    index("wholesale_place_snapshots_name_idx").on(t.nameKey),
    check("wholesale_place_snapshots_tier_check", sql`${t.fieldsTier} IN ('IDS_ONLY','PRO','ENTERPRISE','DETAILS')`),
  ],
);

export const wholesaleLeads = pgTable(
  "wholesale_leads",
  {
    id: id(),
    placeId: text("place_id"),
    source: text("source").notNull(),
    businessName: text("business_name"),
    address: text("address"),
    phoneRaw: text("phone_raw"),
    normalizedPhone: text("normalized_phone"),
    phoneKind: text("phone_kind"),
    phoneCountryCode: text("phone_country_code"),
    phoneSource: text("phone_source"),
    website: text("website"),
    websiteDomain: text("website_domain"),
    email: text("email"),
    facebookUrl: text("facebook_url"),
    zaloUrl: text("zalo_url"),
    /** Lời khai của nhân viên sau khi mở Zalo theo SĐT: FOUND · NOT_FOUND. NULL = chưa biết (ERP không tự tra được). */
    zaloStatus: text("zalo_status"),
    zaloCheckedAt: ts("zalo_checked_at"),
    nameKey: text("name_key"),
    provinceKey: text("province_key"),
    provinceLabel: text("province_label"),
    areaCode: text("area_code"),
    areaName: text("area_name"),
    segment: text("segment").notNull().default("UNCLASSIFIED"),
    segmentEvidence: text("segment_evidence"),
    leadScore: integer("lead_score"),
    leadGrade: text("lead_grade"),
    scoreReasons: jsonb("score_reasons"),
    scoredAt: ts("scored_at"),
    sourceQuery: text("source_query"),
    sourceCampaignId: text("source_campaign_id").references(() => wholesaleCampaigns.id, { onDelete: "set null" }),
    sourceCellId: text("source_cell_id").references(() => wholesaleSearchCells.id, { onDelete: "set null" }),
    enrichmentStatus: text("enrichment_status").notNull().default("READY"),
    filterReason: text("filter_reason"),
    duplicateOfLeadId: text("duplicate_of_lead_id").references((): AnyPgColumn => wholesaleLeads.id, { onDelete: "set null" }),
    detailsAttempts: integer("details_attempts").notNull().default(0),
    detailsNextAt: ts("details_next_at"),
    websiteStatus: text("website_status").notNull().default("NONE"),
    websiteCheckedAt: ts("website_checked_at"),
    contactStatus: text("contact_status").notNull().default("NEW"),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedToName: text("assigned_to_name"),
    assignedAt: ts("assigned_at"),
    firstContactAt: ts("first_contact_at"),
    firstResponseAt: ts("first_response_at"),
    lastContactAt: ts("last_contact_at"),
    nextFollowupAt: ts("next_followup_at"),
    nextAction: text("next_action"),
    contactAttemptCount: integer("contact_attempt_count").notNull().default(0),
    response: text("response"),
    qualifiedAt: ts("qualified_at"),
    wonAt: ts("won_at"),
    lostAt: ts("lost_at"),
    lostReason: text("lost_reason"),
    opportunityValue: bigint("opportunity_value", { mode: "number" }),
    opportunityNote: text("opportunity_note"),
    opportunityAt: ts("opportunity_at"),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    convertedAt: ts("converted_at"),
    staffEditedFields: text("staff_edited_fields").array().notNull().default(sql`'{}'::text[]`),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastRefreshedAt: ts("last_refreshed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("wholesale_leads_place_uq").on(t.placeId),
    index("wholesale_leads_phone_idx").on(t.normalizedPhone),
    index("wholesale_leads_domain_idx").on(t.websiteDomain),
    index("wholesale_leads_name_idx").on(t.nameKey),
    index("wholesale_leads_score_idx").on(t.leadScore),
    index("wholesale_leads_status_idx").on(t.contactStatus),
    index("wholesale_leads_assignee_idx").on(t.assignedToUserId),
    index("wholesale_leads_enrichment_idx").on(t.enrichmentStatus, t.detailsNextAt),
    index("wholesale_leads_campaign_idx").on(t.sourceCampaignId),
    index("wholesale_leads_customer_idx").on(t.customerId),
    check(
      "wholesale_leads_status_check",
      sql`${t.contactStatus} IN ('NEW','QUALIFIED','READY_TO_CONTACT','CONTACTED','NO_ANSWER','INTERESTED','CATALOG_SENT','PRICE_SENT','SAMPLE_REQUESTED','NEGOTIATING','WON','LOST','DO_NOT_CONTACT')`,
    ),
    check("wholesale_leads_enrichment_check", sql`${t.enrichmentStatus} IN ('PENDING_DETAILS','READY','FILTERED','DUPLICATE','FAILED')`),
    check("wholesale_leads_lost_check", sql`${t.contactStatus} <> 'LOST' OR length(btrim(coalesce(${t.lostReason}, ''))) >= 3`),
    check("wholesale_leads_zalo_status_check", sql`${t.zaloStatus} IS NULL OR ${t.zaloStatus} IN ('FOUND','NOT_FOUND')`),
  ],
);

export const wholesalePlaceHits = pgTable(
  "wholesale_place_hits",
  {
    id: id(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => wholesaleCampaigns.id, { onDelete: "cascade" }),
    cellId: text("cell_id").references(() => wholesaleSearchCells.id, { onDelete: "set null" }),
    placeId: text("place_id").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    leadId: text("lead_id").references(() => wholesaleLeads.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("wholesale_place_hits_uq").on(t.campaignId, t.placeId), check("wholesale_place_hits_outcome_check", sql`${t.outcome} IN ('NEW_LEAD','EXISTING_LEAD','FILTERED','SUPPRESSED','DUPLICATE')`)],
);

export const wholesaleLeadCampaigns = pgTable(
  "wholesale_lead_campaigns",
  {
    leadId: text("lead_id")
      .notNull()
      .references(() => wholesaleLeads.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => wholesaleCampaigns.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "wholesale_lead_campaigns_pk", columns: [t.leadId, t.campaignId] }), index("wholesale_lead_campaigns_campaign_idx").on(t.campaignId)],
);

export const wholesaleLeadActivities = pgTable(
  "wholesale_lead_activities",
  {
    id: id(),
    leadId: text("lead_id")
      .notNull()
      .references(() => wholesaleLeads.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    channel: text("channel"),
    outcome: text("outcome"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note").notNull().default(""),
    meta: jsonb("meta"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("wholesale_lead_activities_lead_idx").on(t.leadId, t.createdAt)],
);

export const wholesaleLeadEnrichments = pgTable(
  "wholesale_lead_enrichments",
  {
    id: id(),
    leadId: text("lead_id")
      .notNull()
      .references(() => wholesaleLeads.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wholesale_lead_enrichments_uq").on(t.leadId, t.kind, t.value)],
);

export const wholesaleOutreachItems = pgTable(
  "wholesale_outreach_items",
  {
    id: id(),
    leadId: text("lead_id")
      .notNull()
      .references(() => wholesaleLeads.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("DRAFT"),
    message: text("message").notNull().default(""),
    preparedBy: text("prepared_by").notNull(),
    aiModel: text("ai_model"),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    sentByUserId: text("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),
    sentAt: ts("sent_at"),
    result: text("result"),
    resultNote: text("result_note"),
    resultAt: ts("result_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("wholesale_outreach_open_uq").on(t.leadId, t.channel).where(sql`${t.status} IN ('DRAFT','APPROVED')`),
    index("wholesale_outreach_status_idx").on(t.status, t.createdAt),
    check("wholesale_outreach_status_check", sql`${t.status} IN ('DRAFT','APPROVED','SENT','DONE','CANCELLED')`),
  ],
);

export const wholesaleSuppressions = pgTable(
  "wholesale_suppressions",
  {
    id: id(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    reason: text("reason").notNull(),
    leadId: text("lead_id").references(() => wholesaleLeads.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("wholesale_suppressions_uq").on(t.kind, t.value), check("wholesale_suppressions_kind_check", sql`${t.kind} IN ('PHONE','DOMAIN','PLACE')`)],
);

export const wholesaleApiUsage = pgTable(
  "wholesale_api_usage",
  {
    id: id(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider").notNull(),
    method: text("method").notNull(),
    sku: text("sku"),
    campaignId: text("campaign_id").references(() => wholesaleCampaigns.id, { onDelete: "set null" }),
    cellId: text("cell_id").references(() => wholesaleSearchCells.id, { onDelete: "set null" }),
    leadId: text("lead_id").references(() => wholesaleLeads.id, { onDelete: "set null" }),
    query: text("query"),
    httpStatus: integer("http_status"),
    ok: boolean("ok").notNull(),
    billable: boolean("billable").notNull().default(false),
    attempts: integer("attempts").notNull().default(1),
    resultCount: integer("result_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    error: text("error"),
  },
  (t) => [index("wholesale_api_usage_at_idx").on(t.at), index("wholesale_api_usage_campaign_idx").on(t.campaignId, t.at)],
);

// ═══════════ PHIẾU CÔNG VIỆC HIỆN TRƯỜNG (0200, module `field_jobs` — docs/verticals/home-service.md) ═══════════

/**
 * Một việc tại nhà khách. Tổng / đã thu / còn nợ / hạn bảo hành dịch vụ KHÔNG lưu cột — tính lúc đọc
 * (`lib/constants/field-jobs.ts`). Người thao tác đi bằng khoá tài khoản (luật 34); người ký nghiệm thu là TÊN gõ lại từ biên bản.
 */
export const fieldJobs = pgTable(
  "field_jobs",
  {
    id: id(),
    code: text("code").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    parentJobId: text("parent_job_id").references((): AnyPgColumn => fieldJobs.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    address: text("address").notNull().default(""),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("QUOTED"),
    acceptedAt: ts("accepted_at"),
    acceptedNote: text("accepted_note").notNull().default(""),
    assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    scheduledStart: ts("scheduled_start"),
    scheduledEnd: ts("scheduled_end"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    signedByName: text("signed_by_name"),
    completionNote: text("completion_note").notNull().default(""),
    warrantyMonths: integer("warranty_months"),
    cancelReason: text("cancel_reason"),
    cancelledAt: ts("cancelled_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("field_jobs_code_uq").on(t.code),
    index("field_jobs_customer_idx").on(t.customerId),
    index("field_jobs_assignee_slot_idx").on(t.assigneeUserId, t.scheduledStart),
    index("field_jobs_status_idx").on(t.status, t.updatedAt),
    check("field_jobs_status_check", sql`${t.status} IN ('QUOTED','ACCEPTED','SCHEDULED','IN_PROGRESS','DONE','CANCELLED')`),
    check("field_jobs_title_check", sql`length(btrim(${t.title})) BETWEEN 1 AND 200`),
    check("field_jobs_slot_check", sql`(${t.scheduledStart} IS NULL) = (${t.scheduledEnd} IS NULL) AND (${t.scheduledEnd} IS NULL OR ${t.scheduledEnd} > ${t.scheduledStart})`),
    check("field_jobs_scheduled_check", sql`${t.status} NOT IN ('SCHEDULED','IN_PROGRESS') OR (${t.assigneeUserId} IS NOT NULL AND ${t.scheduledStart} IS NOT NULL)`),
    check("field_jobs_done_check", sql`${t.status} <> 'DONE' OR (${t.completedAt} IS NOT NULL AND length(btrim(coalesce(${t.signedByName}, ''))) >= 1)`),
    check("field_jobs_cancel_check", sql`${t.status} <> 'CANCELLED' OR length(btrim(coalesce(${t.cancelReason}, ''))) >= 3`),
    check("field_jobs_warranty_check", sql`${t.warrantyMonths} IS NULL OR ${t.warrantyMonths} BETWEEN 1 AND 120`),
  ],
);

/** Dòng báo giá của phiếu (0200): chữ tự do · số lượng nguyên · đơn giá VND. */
export const fieldJobLines = pgTable(
  "field_job_lines",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => fieldJobs.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("field_job_lines_job_idx").on(t.jobId, t.position),
    check("field_job_lines_qty_check", sql`${t.quantity} BETWEEN 1 AND 10000`),
    check("field_job_lines_price_check", sql`${t.unitPrice} >= 0`),
    check("field_job_lines_text_check", sql`length(btrim(${t.description})) BETWEEN 1 AND 300`),
  ],
);

/** Phiếu thu theo đợt của phiếu công việc (0200). Huỷ phiếu thu bắt buộc lý do, không xoá. */
export const fieldJobReceipts = pgTable(
  "field_job_receipts",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => fieldJobs.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    method: text("method").notNull(),
    paidAt: ts("paid_at").notNull(),
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("CONFIRMED"),
    voidReason: text("void_reason"),
    voidedAt: ts("voided_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("field_job_receipts_job_idx").on(t.jobId),
    check("field_job_receipts_amount_check", sql`${t.amount} > 0`),
    check("field_job_receipts_method_check", sql`${t.method} IN ('CASH','BANK','OTHER')`),
    check("field_job_receipts_status_check", sql`${t.status} IN ('CONFIRMED','VOIDED')`),
    check("field_job_receipts_void_check", sql`${t.status} <> 'VOIDED' OR length(btrim(coalesce(${t.voidReason}, ''))) >= 3`),
  ],
);

/** Ảnh trước / sau của phiếu công việc (0200) — đã thu nhỏ ở trình duyệt, ≤ 2 MB. */
export const fieldJobPhotos = pgTable(
  "field_job_photos",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => fieldJobs.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    data: bytea("data").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    uploadedByName: text("uploaded_by_name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("field_job_photos_job_idx").on(t.jobId, t.phase),
    check("field_job_photos_phase_check", sql`${t.phase} IN ('BEFORE','AFTER')`),
    check("field_job_photos_type_check", sql`${t.contentType} IN ('image/jpeg','image/png','image/webp')`),
    check("field_job_photos_bytes_check", sql`${t.bytes} BETWEEN 1 AND 2000000`),
  ],
);

// ═══════════ BẢNG HÀNG BẤT ĐỘNG SẢN (0201, module `real_estate` — docs/verticals/real-estate.md) ═══════════

/** Dự án. `hold_hours` BẮT BUỘC khai — số giờ một lượt giữ chỗ còn hiệu lực (quyết định kinh doanh, không mặc định). */
export const reProjects = pgTable(
  "re_projects",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    holdHours: integer("hold_hours").notNull(),
    note: text("note").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("re_projects_code_uq").on(sql`lower(${t.code})`),
    check("re_projects_hold_check", sql`${t.holdHours} BETWEEN 1 AND 720`),
    check("re_projects_name_check", sql`length(btrim(${t.name})) BETWEEN 1 AND 160`),
    check("re_projects_code_check", sql`length(btrim(${t.code})) BETWEEN 1 AND 40`),
  ],
);

/** Căn của dự án. Giá / diện tích NULL = chưa công bố. Trạng thái căn KHÔNG lưu cột — `lib/constants/real-estate.ts::unitState`. */
export const reUnits = pgTable(
  "re_units",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => reProjects.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    block: text("block").notNull().default(""),
    floor: text("floor").notNull().default(""),
    areaM2: doublePrecision("area_m2"),
    listPrice: bigint("list_price", { mode: "number" }),
    note: text("note").notNull().default(""),
    lockedAt: ts("locked_at"),
    lockedReason: text("locked_reason"),
    soldAt: ts("sold_at"),
    soldContract: text("sold_contract"),
    soldByUserId: text("sold_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("re_units_project_code_uq").on(t.projectId, sql`lower(${t.code})`),
    check("re_units_code_check", sql`length(btrim(${t.code})) BETWEEN 1 AND 40`),
    check("re_units_area_check", sql`${t.areaM2} IS NULL OR ${t.areaM2} > 0`),
    check("re_units_price_check", sql`${t.listPrice} IS NULL OR ${t.listPrice} >= 0`),
    check("re_units_lock_check", sql`${t.lockedAt} IS NULL OR length(btrim(coalesce(${t.lockedReason}, ''))) >= 3`),
    check("re_units_sold_check", sql`${t.soldAt} IS NULL OR length(btrim(coalesce(${t.soldContract}, ''))) >= 1`),
  ],
);

/** Lượt giữ chỗ có hạn — mỗi căn nhiều nhất MỘT dòng ACTIVE (chỉ mục duy nhất có điều kiện). */
export const reHolds = pgTable(
  "re_holds",
  {
    id: id(),
    unitId: text("unit_id")
      .notNull()
      .references(() => reUnits.id, { onDelete: "cascade" }),
    saleUserId: text("sale_user_id").references(() => users.id, { onDelete: "set null" }),
    saleName: text("sale_name").notNull().default(""),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull().default(""),
    heldAt: ts("held_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    closedAt: ts("closed_at"),
    closeReason: text("close_reason"),
  },
  (t) => [
    uniqueIndex("re_holds_one_active_uq").on(t.unitId).where(sql`${t.status} = 'ACTIVE'`),
    index("re_holds_sale_idx").on(t.saleUserId, t.status),
    check("re_holds_status_check", sql`${t.status} IN ('ACTIVE','RELEASED','EXPIRED','CONVERTED')`),
    check("re_holds_window_check", sql`${t.expiresAt} > ${t.heldAt}`),
    check("re_holds_customer_check", sql`length(btrim(${t.customerName})) BETWEEN 1 AND 160`),
  ],
);

/** Cọc — mỗi căn nhiều nhất MỘT khoản ACTIVE. Hoàn / khách bỏ cọc cần lý do. */
export const reDeposits = pgTable(
  "re_deposits",
  {
    id: id(),
    unitId: text("unit_id")
      .notNull()
      .references(() => reUnits.id, { onDelete: "cascade" }),
    holdId: text("hold_id").references(() => reHolds.id, { onDelete: "set null" }),
    saleUserId: text("sale_user_id").references(() => users.id, { onDelete: "set null" }),
    saleName: text("sale_name").notNull().default(""),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull().default(""),
    amount: bigint("amount", { mode: "number" }).notNull(),
    depositedAt: ts("deposited_at").notNull().defaultNow(),
    status: text("status").notNull().default("ACTIVE"),
    closedAt: ts("closed_at"),
    closeReason: text("close_reason"),
  },
  (t) => [
    uniqueIndex("re_deposits_one_active_uq").on(t.unitId).where(sql`${t.status} = 'ACTIVE'`),
    check("re_deposits_amount_check", sql`${t.amount} > 0`),
    check("re_deposits_status_check", sql`${t.status} IN ('ACTIVE','REFUNDED','FORFEITED','CONVERTED')`),
    check("re_deposits_close_check", sql`${t.status} NOT IN ('REFUNDED','FORFEITED') OR length(btrim(coalesce(${t.closeReason}, ''))) >= 3`),
    check("re_deposits_customer_check", sql`length(btrim(${t.customerName})) BETWEEN 1 AND 160`),
  ],
);

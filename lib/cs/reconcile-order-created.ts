import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * ═══════════ "CHƯA TẠO ĐƠN" TRONG KHI ĐƠN ĐÃ NẰM ĐÓ ═══════════
 *
 * ─── LỖI ───
 *
 * Case `ORDER_NOT_CREATED` nghĩa là: đã đủ thông tin để lên đơn, và đơn CHƯA tồn tại. Vế thứ hai
 * là một điều kiện SỐNG — nó đúng lúc case được tạo, rồi hết đúng ngay khi ai đó lên đơn. Nhưng
 * không có đường nào tắt case khi điều kiện đó hết đúng, nên nó nằm lại hàng đợi mãi.
 *
 * ĐO PRODUCTION 13/09/2026
 *   29 case `ORDER_NOT_CREATED` đang mở
 *     25 đã có `order_id` NGAY TRÊN CASE, và hội thoại của chúng ĐÃ sinh ra đơn
 *     27 có số điện thoại đã từng lên đơn
 *     19 có số điện thoại đã có VẬN ĐƠN
 *      0 thật sự còn treo
 *
 * 25/29 là việc giả. Người trực CSKH mở hàng đợi, thấy 29 việc, gọi cho khách đã mua hàng tuần
 * trước để hỏi "chị có muốn đặt hàng không". Đó là cái giá thật của một case không tự tắt.
 *
 * ─── SỬA CẢ NƠI SINH LẪN NƠI ĐỌC ───
 *
 * Không chỉ ẩn ở giao diện. Case được ĐÓNG MỀM với lý do đọc được, nên hàng đợi sạch và lịch sử
 * vẫn tra được. Và `chat-detect` không tạo lại case cho hội thoại đã có đơn.
 *
 * ─── BA BẬC CHỨNG CỨ, KHÔNG SUY BẰNG CHỮ ───
 *
 *   1. `CONVERSATION_HAS_ORDER` — hội thoại sinh ra case đã sinh ra đơn SAU đó
 *                                 (`orders.conversation_id`). Đây là mối nối MÁY, đúng thứ cột đó
 *                                 sinh ra để làm.
 *   2. `PHONE_ORDERED_AFTER`    — số điện thoại của case đã lên đơn SAU khi case đủ thông tin.
 *
 * ─── VÌ SAO `cs_cases.order_id` KHÔNG PHẢI MỘT BẬC CHỨNG CỨ ───
 *
 * Bản đầu của hàm này coi "case có `order_id`" là bằng chứng chắc chắn nhất. SAI, và sai theo
 * hướng nguy hiểm nhất: nó đóng đúng những case đáng làm.
 *
 * `lib/cs/chat-detect.ts` gán `orderId: order?.id ?? null` cho MỌI case nó tạo, và với loại này
 * thì `order` là đơn GẦN NHẤT CỦA KHÁCH — chính nội dung case viết ra điều đó: *"Đơn gần nhất
 * #… là của lần mua trước."* Case chỉ được tạo KHI đã đối chiếu và KHÔNG thấy đơn tương ứng.
 *
 * Nên `order_id` ở đây nghĩa là "khách này từng mua", KHÔNG phải "đơn đang chờ đã được tạo".
 * Đóng case theo nó là kết luận ngược hẳn với thứ nó nói.
 *
 * ─── MỌI BẬC ĐỀU RÀNG BUỘC THỜI GIAN ───
 *
 * Một khách mua tháng trước rồi tháng này nhắn muốn mua tiếp thì case MỚI là thật, và đơn CŨ
 * không được dùng để đóng nó. Thiếu vế "tạo SAU khi case đủ thông tin", luật này lại đóng đúng
 * những case đáng làm nhất — cùng một cái bẫy, chỉ ở một cột khác.
 *
 * KHÔNG có bậc nào đóng case chỉ vì số điện thoại từng xuất hiện ở đâu đó.
 */

export const RECONCILE_REASONS = ["CONVERSATION_HAS_ORDER", "PHONE_ORDERED_AFTER"] as const;
export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

export const RECONCILE_REASON_LABEL: Record<ReconcileReason, string> = {
  CONVERSATION_HAS_ORDER: "Hội thoại đã sinh ra đơn sau khi case mở",
  PHONE_ORDERED_AFTER: "Số điện thoại đã lên đơn sau khi case đủ thông tin",
};

/** Người/máy đứng tên thao tác này. KHÔNG phải một tài khoản người — đây là máy đối chiếu. */
export const RECONCILE_ACTOR = "SYSTEM_RECONCILIATION";

export type ReconcileResult = {
  openBefore: number;
  /** Đóng được, tách theo bậc chứng cứ — để đọc lại được vì sao từng case bị đóng. */
  closed: Record<ReconcileReason, number>;
  closedTotal: number;
  /** Có người nhận hoặc đã ghi kết luận ⇒ GIỮ NGUYÊN, máy không quyết thay người. */
  humanTouched: number;
  /** Không có chứng cứ nào ⇒ vẫn là việc thật. */
  stillPending: number;
};

const c = schema.csCases;

/**
 * Hội thoại của case đã sinh ra một đơn SAU khi case đủ thông tin.
 *
 * Vế thời gian là bắt buộc: case chỉ được tạo khi đã đối chiếu và không thấy đơn, nên một đơn của
 * cùng hội thoại tạo TRƯỚC đó là đơn của lượt mua trước — không phải đơn mà case này đang chờ.
 */
const HOI_THOAI_CO_DON = sql`(${c.conversationId} is not null and exists (
  select 1 from orders o
  where o.conversation_id = ${c.conversationId}
    and o.inserted_at >= coalesce(${c.infoCompleteAt}, ${c.createdAt})
))`;

/**
 * Số điện thoại của case đã lên đơn SAU khi case đủ thông tin.
 *
 * Mốc so sánh là `info_complete_at` nếu có, không thì `created_at` của case. Dùng `>=` chứ không
 * `>`: đơn được tạo trong cùng giây với lúc case sinh ra vẫn là đơn của chính hội thoại đó.
 */
const SDT_LEN_DON_SAU = sql`(${c.customerPhone} <> '' and exists (
  select 1 from orders o
  where o.bill_phone = ${c.customerPhone}
    and o.inserted_at >= coalesce(${c.infoCompleteAt}, ${c.createdAt})
))`;

const CO_CHUNG_CU = sql`(${HOI_THOAI_CO_DON} or ${SDT_LEN_DON_SAU})`;
// Chưa ai chạm vào = chưa ai nhận VÀ chưa ai ghi kết luận. Hai điều kiện, không phải một.
const CHUA_AI_CHAM = and(or(sql`${c.assignee} = ''`, sql`${c.assignee} is null`), eq(c.resolution, ""));

/**
 * Đối chiếu và đóng mềm các case `ORDER_NOT_CREATED` đã hết lý do tồn tại.
 *
 * `dryRun` mặc định TRUE. Đổi dữ liệu production phải là quyết định tường minh, không phải tác
 * dụng phụ của việc chạy một lệnh xem thử.
 */
export async function reconcileOrderNotCreated(options: { dryRun?: boolean; actor?: string } = {}): Promise<ReconcileResult> {
  const dryRun = options.dryRun !== false;
  const db = await getDb();
  const dangMo = and(eq(c.kind, "ORDER_NOT_CREATED"), inArray(c.status, ["OPEN", "IN_PROGRESS"]));

  const [dem] = await db
    .select({
      openBefore: sql<number>`count(*)`,
      // Bậc chứng cứ xếp theo thứ tự ƯU TIÊN: một case có cả ba chỉ được đếm ở bậc mạnh nhất,
      // nếu không tổng các bậc sẽ lớn hơn số case và bảng báo cáo tự mâu thuẫn.
      convHasOrder: sql<number>`count(*) filter (where ${HOI_THOAI_CO_DON} and ${CHUA_AI_CHAM})`,
      phoneAfter: sql<number>`count(*) filter (where not ${HOI_THOAI_CO_DON} and ${SDT_LEN_DON_SAU} and ${CHUA_AI_CHAM})`,
      humanTouched: sql<number>`count(*) filter (where ${CO_CHUNG_CU} and not (${CHUA_AI_CHAM}))`,
      stillPending: sql<number>`count(*) filter (where not ${CO_CHUNG_CU})`,
    })
    .from(c)
    .where(dangMo);

  const closed: Record<ReconcileReason, number> = {
    CONVERSATION_HAS_ORDER: Number(dem?.convHasOrder ?? 0),
    PHONE_ORDERED_AFTER: Number(dem?.phoneAfter ?? 0),
  };
  const ket: ReconcileResult = {
    openBefore: Number(dem?.openBefore ?? 0),
    closed,
    closedTotal: closed.CONVERSATION_HAS_ORDER + closed.PHONE_ORDERED_AFTER,
    humanTouched: Number(dem?.humanTouched ?? 0),
    stillPending: Number(dem?.stillPending ?? 0),
  };
  if (dryRun || !ket.closedTotal) return ket;

  // Ghi theo TỪNG BẬC để `resolution` nói đúng chứng cứ đã dùng cho chính case đó — một lý do
  // chung cho cả ba bậc thì sáu tháng sau không ai biết case này đóng vì cái gì.
  const buoc: { reason: ReconcileReason; cond: ReturnType<typeof and> }[] = [
    { reason: "CONVERSATION_HAS_ORDER", cond: and(dangMo, HOI_THOAI_CO_DON, CHUA_AI_CHAM) },
    { reason: "PHONE_ORDERED_AFTER", cond: and(dangMo, sql`not ${HOI_THOAI_CO_DON}`, SDT_LEN_DON_SAU, CHUA_AI_CHAM) },
  ];
  for (const b of buoc) {
    if (!closed[b.reason]) continue;
    await db
      .update(c)
      .set({
        // `AUTO_RESOLVED`, KHÔNG phải `DONE`: `DONE` là công của người. Đóng 25 case bằng `DONE`
        // sẽ làm bảng năng suất CSKH trông như 25 lần có người gọi khách.
        status: "AUTO_RESOLVED",
        resolution: `${b.reason} · ${RECONCILE_REASON_LABEL[b.reason]} · ${options.actor ?? RECONCILE_ACTOR}`,
        resolvedAt: new Date(),
      })
      .where(b.cond);
  }
  return ket;
}

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { rowsOf } from "@/lib/sql-rows";
import { getDb, schema } from "@/db";
import { ORDER_MATCH_WINDOW_DAYS, ORDER_MATERIALIZED_STAGES_SQL } from "@/lib/constants/order-materialized";

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
 * ─── BỐN BẬC CHỨNG CỨ, KHÔNG SUY BẰNG CHỮ ───
 *
 *   1. `CONVERSATION_HAS_ORDER` — hội thoại sinh ra case đã sinh ra đơn SAU đó
 *                                 (`orders.conversation_id`). Đây là mối nối MÁY, đúng thứ cột đó
 *                                 sinh ra để làm.
 *   2. `PHONE_ORDERED_AFTER`    — số điện thoại của case đã lên đơn SAU khi case đủ thông tin.
 *   3. `SHIPMENT_CREATED`       — có VẬN ĐƠN gửi tới chính số điện thoại đó, tạo SAU khi case đủ
 *                                 thông tin. Hàng đã rời kho thì đơn chắc chắn đã tồn tại — kể cả
 *                                 khi đơn được lên bằng một số khác (số người nhận hộ) nên hai bậc
 *                                 trên không lần ra.
 *
 * ─── "CÓ VẬN ĐƠN THÌ ĐÓNG" — ĐÚNG MỘT NỬA, VÀ NỬA CÒN LẠI LÀ CÁI BẪY ───
 *
 * Trên màn hình, một case `ORDER_NOT_CREATED` có thể hiện kèm cả `Đơn #xxxx` LẪN một mã `PKE15…`.
 * Đọc nguyên văn thì "đã có vận đơn ⇒ đóng". Nhưng cả hai thứ đó đến từ `cs_cases.order_id`, mà
 * cột ấy là ĐƠN GẦN NHẤT CỦA KHÁCH — tức lần mua TRƯỚC (xem khối bên dưới). Đóng theo nó là đóng
 * đúng những case đáng làm.
 *
 * Nên bậc 3 KHÔNG đọc `cs_cases.order_id` và KHÔNG đọc vận đơn của đơn ấy. Nó đọc
 * `shipments.receiver_phone` — số điện thoại người nhận trên chính chứng từ ĐVVC — và vẫn ràng
 * buộc thời gian y hệt hai bậc trên.
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
 *   4. `POS_CONFIRMED`           — POS đã XÁC NHẬN một đơn của CHÍNH hội thoại ấy, trong cửa sổ
 *                                 khớp. Chủ shop chốt 14/09/2026: "Đã xác nhận" nghĩa là đơn đã
 *                                 được tạo. Bậc này sinh ra vì ba bậc trên đóng được 0/10 case
 *                                 trên production — lý do đo được viết ngay tại chỗ khai nó.
 *
 * ─── MỌI BẬC ĐỀU RÀNG BUỘC THỜI GIAN ───
 *
 * Một khách mua tháng trước rồi tháng này nhắn muốn mua tiếp thì case MỚI là thật, và đơn CŨ
 * không được dùng để đóng nó. Thiếu vế thời gian, luật này lại đóng đúng những case đáng làm nhất
 * — cùng một cái bẫy, chỉ ở một cột khác.
 *
 * Ba bậc đầu ràng buộc MỘT PHÍA ("tạo SAU khi case đủ thông tin"). Bậc 4 ràng buộc HAI PHÍA (cửa
 * sổ `ORDER_MATCH_WINDOW_DAYS` về cả trước lẫn sau), vì chứng cứ của nó là TRẠNG THÁI đơn chứ
 * không phải thứ tự thời gian — và không có vế "trước" thì một đơn `DELIVERED` từ hai tuần trước
 * trong cùng hội thoại sẽ đóng mất một case thật. Đo được đúng một ca như thế trên production.
 *
 * KHÔNG có bậc nào đóng case chỉ vì số điện thoại từng xuất hiện ở đâu đó.
 */

export const RECONCILE_REASONS = ["CONVERSATION_HAS_ORDER", "PHONE_ORDERED_AFTER", "SHIPMENT_CREATED", "POS_CONFIRMED"] as const;
export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

export const RECONCILE_REASON_LABEL: Record<ReconcileReason, string> = {
  CONVERSATION_HAS_ORDER: "Hội thoại đã sinh ra đơn sau khi case mở",
  PHONE_ORDERED_AFTER: "Số điện thoại đã lên đơn sau khi case đủ thông tin",
  SHIPMENT_CREATED: "Đã có vận đơn gửi tới số điện thoại này sau khi case đủ thông tin",
  POS_CONFIRMED: "POS đã xác nhận đơn của chính hội thoại này, trong cửa sổ khớp",
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
 * ═══════════ BỐN BẬC CHỨNG CỨ, SINH RA TỪ MỘT NƠI ═══════════
 *
 * Hai nơi hỏi CÙNG một câu "đơn của case này đã tồn tại chưa": máy đối chiếu (đọc cột của
 * `cs_cases`) và lá chắn lúc GHI (`stillPendingOrderNotCreated`, đọc cột của một bảng `values`
 * dựng tại chỗ). Cột khác nhau, câu hỏi giống hệt.
 *
 * Trước 14/09/2026 mỗi nơi giữ một bản chép tay. Chúng đang đồng ý với nhau — nhưng thêm bậc thứ
 * tư là một lượt sửa hai chỗ, và cả kho mã này đã mất một bản phát hành vì đúng hình dạng lỗi đó
 * ("Đã gửi" gõ nguyên văn ở bốn chỗ). Nay nơi gọi truyền vào BIỂU THỨC CỘT của chính nó, còn LUẬT
 * thì chỉ có một bản.
 */
type EvidenceCols = {
  /** Khoá hội thoại. Rỗng/`NULL` ⇒ mọi bậc dựa vào hội thoại tự tắt. */
  conversationId: SQL;
  /** Số điện thoại của case. Rỗng ⇒ mọi bậc dựa vào SĐT tự tắt. */
  phone: SQL;
  /** Mốc "đủ thông tin" của chính ứng viên đó. */
  moc: SQL;
};

function evidenceParts(k: EvidenceCols): Record<ReconcileReason, SQL> {
  const co = (x: SQL) => sql`coalesce(${x}, '') <> ''`;
  const cua = sql.raw(`interval '${ORDER_MATCH_WINDOW_DAYS} days'`);
  return {
    /**
     * Hội thoại của case đã sinh ra một đơn SAU khi case đủ thông tin.
     *
     * Vế thời gian là bắt buộc: case chỉ được tạo khi đã đối chiếu và không thấy đơn, nên một đơn
     * của cùng hội thoại tạo TRƯỚC đó là đơn của lượt mua trước — không phải đơn case đang chờ.
     */
    CONVERSATION_HAS_ORDER: sql`(${co(k.conversationId)} and exists (
      select 1 from orders o where o.conversation_id = ${k.conversationId} and o.inserted_at >= ${k.moc}
    ))`,
    /** Số điện thoại của case đã lên đơn SAU khi case đủ thông tin. */
    PHONE_ORDERED_AFTER: sql`(${co(k.phone)} and exists (
      select 1 from orders o where o.bill_phone = ${k.phone} and o.inserted_at >= ${k.moc}
    ))`,
    /**
     * Có VẬN ĐƠN gửi tới chính số điện thoại của case, tạo SAU khi case đủ thông tin.
     *
     * Đọc `shipments.receiver_phone` (chứng từ ĐVVC), KHÔNG đọc vận đơn của `cs_cases.order_id`:
     * cột đó trỏ tới lần mua TRƯỚC, và mọi khách mua lần hai đều có sẵn một vận đơn cũ ở đó.
     */
    SHIPMENT_CREATED: sql`(${co(k.phone)} and exists (
      select 1 from shipments sh where sh.receiver_phone = ${k.phone} and sh.created_at >= ${k.moc}
    ))`,
    /**
     * ─── BẬC 4: POS ĐÃ XÁC NHẬN ĐƠN CỦA CHÍNH HỘI THOẠI ẤY ───
     *
     * Chủ shop chốt 14/09/2026: **POS "Đã xác nhận" nghĩa là đơn ĐÃ ĐƯỢC TẠO.** Luật khai một chỗ
     * ở `lib/constants/order-materialized.ts`, bám vào MÃ TRẠNG THÁI ổn định của Pancake chứ không
     * so chuỗi hiển thị.
     *
     * VÌ SAO BA BẬC CŨ ĐÓNG ĐƯỢC 0/10. Đo production 14/09/2026 trên 10 case đang mở: cả 10 đều có
     * đơn mang chính số điện thoại ấy, nhưng **0 case** có đơn tạo SAU mốc `info_complete_at`. Vì
     * mốc đó là lúc MÁY QUÉT nhận ra hội thoại đã đủ thông tin, không phải lúc KHÁCH đưa thông tin
     * — máy quét chạy sau, nên đơn gần như luôn ra đời TRƯỚC mốc và điều kiện `>=` không bao giờ
     * đúng. Ba bậc cũ đúng về lý, đóng được đúng 0 case về thực tế.
     *
     * BẬC NÀY ĐỔI TRỤC: TỪ THỜI GIAN SANG ĐỊNH DANH + ĐỘ GẦN. Đòi CẢ BA, không chỉ một:
     *   1. đơn nằm trong CÙNG hội thoại với case — không phải "cùng SĐT", vì SĐT nối cả những
     *      lượt mua chẳng liên quan;
     *   2. đơn ở trạng thái "Đã xác nhận" trở đi;
     *   3. mốc tạo đơn cách mốc case không quá `ORDER_MATCH_WINDOW_DAYS`, tính về CẢ HAI PHÍA.
     *
     * Vế 3 giữ lại đúng những case đáng làm. Đo trên chính 10 case ấy: một case ngày 09-11 có đơn
     * cùng hội thoại ngày **08-29** trạng thái `DELIVERED` — lệch 13 ngày. Đó là KHÁCH MUA LẠI, và
     * đóng nó là đóng một việc thật. Cửa sổ ba ngày loại nó ra.
     *
     * Cố ý KHÔNG có bậc "số điện thoại từng có đơn đã xác nhận": 10/10 case thoả điều kiện đó, tức
     * nó đóng sạch hàng đợi mà không phân biệt được gì — một luật đúng với mọi dòng không nói gì cả.
     */
    POS_CONFIRMED: sql`(${co(k.conversationId)} and exists (
      select 1 from orders o
      where o.conversation_id = ${k.conversationId}
        and o.stage::text in (${sql.raw(ORDER_MATERIALIZED_STAGES_SQL)})
        and o.inserted_at >= ${k.moc} - ${cua}
        and o.inserted_at <= ${k.moc} + ${cua}
    ))`,
  };
}

/** Bậc chứng cứ tính trên cột của `cs_cases`. */
const BAC = evidenceParts({
  conversationId: sql`${c.conversationId}`,
  phone: sql`${c.customerPhone}`,
  moc: sql`coalesce(${c.infoCompleteAt}, ${c.createdAt})`,
});

const HOI_THOAI_CO_DON = BAC.CONVERSATION_HAS_ORDER;


const SDT_LEN_DON_SAU = BAC.PHONE_ORDERED_AFTER;
const CO_VAN_DON_SAU = BAC.SHIPMENT_CREATED;
const POS_DA_XAC_NHAN = BAC.POS_CONFIRMED;

const CO_CHUNG_CU = sql`(${HOI_THOAI_CO_DON} or ${SDT_LEN_DON_SAU} or ${CO_VAN_DON_SAU} or ${POS_DA_XAC_NHAN})`;
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
      shipmentCreated: sql<number>`count(*) filter (where not ${HOI_THOAI_CO_DON} and not ${SDT_LEN_DON_SAU} and ${CO_VAN_DON_SAU} and ${CHUA_AI_CHAM})`,
      posConfirmed: sql<number>`count(*) filter (where not ${HOI_THOAI_CO_DON} and not ${SDT_LEN_DON_SAU} and not ${CO_VAN_DON_SAU} and ${POS_DA_XAC_NHAN} and ${CHUA_AI_CHAM})`,
      humanTouched: sql<number>`count(*) filter (where ${CO_CHUNG_CU} and not (${CHUA_AI_CHAM}))`,
      stillPending: sql<number>`count(*) filter (where not ${CO_CHUNG_CU})`,
    })
    .from(c)
    .where(dangMo);

  const closed: Record<ReconcileReason, number> = {
    CONVERSATION_HAS_ORDER: Number(dem?.convHasOrder ?? 0),
    PHONE_ORDERED_AFTER: Number(dem?.phoneAfter ?? 0),
    SHIPMENT_CREATED: Number(dem?.shipmentCreated ?? 0),
    POS_CONFIRMED: Number(dem?.posConfirmed ?? 0),
  };
  const ket: ReconcileResult = {
    openBefore: Number(dem?.openBefore ?? 0),
    closed,
    closedTotal: RECONCILE_REASONS.reduce((t, r) => t + closed[r], 0),
    humanTouched: Number(dem?.humanTouched ?? 0),
    stillPending: Number(dem?.stillPending ?? 0),
  };
  if (dryRun || !ket.closedTotal) return ket;

  // Ghi theo TỪNG BẬC để `resolution` nói đúng chứng cứ đã dùng cho chính case đó — một lý do
  // chung cho cả ba bậc thì sáu tháng sau không ai biết case này đóng vì cái gì.
  const buoc: { reason: ReconcileReason; cond: ReturnType<typeof and> }[] = [
    { reason: "CONVERSATION_HAS_ORDER", cond: and(dangMo, HOI_THOAI_CO_DON, CHUA_AI_CHAM) },
    { reason: "PHONE_ORDERED_AFTER", cond: and(dangMo, sql`not ${HOI_THOAI_CO_DON}`, SDT_LEN_DON_SAU, CHUA_AI_CHAM) },
    { reason: "SHIPMENT_CREATED", cond: and(dangMo, sql`not ${HOI_THOAI_CO_DON}`, sql`not ${SDT_LEN_DON_SAU}`, CO_VAN_DON_SAU, CHUA_AI_CHAM) },
    { reason: "POS_CONFIRMED", cond: and(dangMo, sql`not ${HOI_THOAI_CO_DON}`, sql`not ${SDT_LEN_DON_SAU}`, sql`not ${CO_VAN_DON_SAU}`, POS_DA_XAC_NHAN, CHUA_AI_CHAM) },
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

/**
 * ═══════════ MỘT LUẬT, HAI NƠI ĐỌC: SỬA CẢ NƠI ĐỌC LẪN NƠI SINH ═══════════
 *
 * Đóng mềm case cũ mới chỉ dọn hậu quả. Nếu `chat-detect` vẫn tạo lại case cho hội thoại đã có đơn
 * thì mỗi lượt quét lại đẻ ra đúng những case vừa đóng — `dedupe_key` của loại này mang NGÀY, nên
 * hôm sau là một khoá mới và không có gì chặn.
 *
 * Hàm này là ĐÚNG vị từ ở trên, chạy ngược: cho một danh sách ứng viên, trả về những ứng viên THẬT
 * SỰ CÒN TREO. `lib/cs/chat-detect.ts` gọi nó ngay trước khi ghi.
 *
 * ─── ĐUA GIỮA MÁY QUÉT VÀ NGƯỜI LÊN ĐƠN ───
 *
 * Kịch bản có thật: máy quét thấy đủ thông tin lúc 10:00:00, nhân viên lên đơn lúc 10:00:01, case
 * được ghi lúc 10:00:02. Vị từ này chạy TẠI THỜI ĐIỂM GHI nên nó thấy đơn vừa tạo và loại ứng viên
 * đó ra — case không bao giờ ra đời. Nếu vẫn lọt (đơn về sau khi ghi), lượt đối chiếu ngay sau đó
 * trong cùng job sẽ đóng nó, và lượt quét kế tiếp không tạo lại.
 *
 * MỘT truy vấn cho cả danh sách — không đặt truy vấn trong vòng lặp hội thoại.
 */
export type OrderNotCreatedCandidate = { key: string; conversationId: string | null; phone: string; infoCompleteAt: Date | null };

export async function stillPendingOrderNotCreated(candidates: OrderNotCreatedCandidate[]): Promise<Set<string>> {
  const out = new Set<string>();
  const hopLe = candidates.filter((x) => x.conversationId || x.phone);
  if (!hopLe.length) return out;
  const db = await getDb();

  /*
    Mốc so sánh phải là mốc của CHÍNH ứng viên, không phải một mốc chung: hai hội thoại đủ thông
    tin cách nhau ba ngày mà dùng chung một mốc thì một trong hai bị kết luận sai.

    Dựng bằng `values` để cả danh sách đi trong MỘT câu lệnh. Mọi giá trị đều là tham số ràng buộc
    (drizzle `sql` nội suy thành placeholder), không nối chuỗi.
  */
  const dong = hopLe.map(
    (x) => sql`(${x.key}, ${x.conversationId ?? ""}::text, ${x.phone}::text, ${x.infoCompleteAt ?? new Date(0)}::timestamptz)`,
  );
  /*
    CÙNG MỘT LUẬT VỚI MÁY ĐỐI CHIẾU, KHÔNG PHẢI MỘT BẢN CHÉP TAY.

    Trước 14/09/2026 khối này gõ lại ba vị từ bằng tay. Chúng đang đồng ý với máy đối chiếu, nhưng
    thêm bậc thứ tư (`POS_CONFIRMED`) là một lượt sửa hai chỗ — và quên một chỗ ở ĐÂY là kiểu hỏng
    tệ nhất: máy quét vẫn đẻ ra đúng những case mà lượt đối chiếu ngay sau đó phải đóng, mỗi ngày
    một lần, mãi mãi.

    Nay `evidenceParts` sinh cả bốn bậc từ cột của bảng `values` này.
  */
  const bac = evidenceParts({
    conversationId: sql`uv.conversation_id`,
    phone: sql`uv.phone`,
    moc: sql`uv.moc`,
  });
  const rows = await db.execute<{ key: string; co_chung_cu: boolean }>(sql`
    with ung_vien(key, conversation_id, phone, moc) as (values ${sql.join(dong, sql`, `)})
    select uv.key,
           (${sql.join(RECONCILE_REASONS.map((r) => bac[r]), sql` or `)}) as co_chung_cu
      from ung_vien uv`);
  const list = rowsOf<{ key: string; co_chung_cu: boolean }>(rows);
  const coChungCu = new Set(list.filter((r) => r.co_chung_cu).map((r) => r.key));
  for (const x of hopLe) if (!coChungCu.has(x.key)) out.add(x.key);
  return out;
}

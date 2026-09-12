import { RECEIVE_SLA_DAYS } from "@/lib/constants/return-lifecycle";
import { and, asc, desc, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { IS_RETURN_NOT_RECEIVED } from "@/lib/queries/return-rate";
import { returnProductContext, summarizeReturnItems, EMPTY_CONTEXT, type ReturnProductContext } from "@/lib/returns/product-context";

/**
 * ═══════════ HÀNG ĐỢI "CHỜ KHO NHẬN", KÈM HÀNG GÌ TRONG KIỆN ═══════════
 *
 * Trước đây danh sách này chỉ có mã vận đơn, tên khách và COD. Người đứng ở kho đọc xong vẫn không
 * biết kiện đang cầm lẽ ra chứa món gì, nên phải mở từng kiện ra đoán hoặc tra tay sang trang đơn.
 *
 * Ở đây mỗi dòng mang theo BỐI CẢNH SẢN PHẨM dựng bằng định danh (xem `product-context.ts`), kèm
 * mức độ tin cậy của chính nó. Kiện chưa ghép được đơn vẫn hiện — nhưng hiện thành "chưa xác định",
 * không phải hiện thành hàng của một đơn nào đó.
 *
 * TIỀN: trang này CỐ Ý không tự tính "giá trị hàng đang kẹt". Con số đó đã có một chủ duy nhất là
 * `lib/queries/return-pipeline.ts` (`capitalLocked`, lấy giá vốn từ `canonical_order_outcome`).
 * Dựng thêm một phép cộng giá vốn ở đây là tạo ra con số thứ hai cho cùng một thứ, và hai con số
 * cạnh nhau lệch nhau thì cả hai mất giá trị.
 */

const s = schema.shipments;

export type ReceiveQueueRow = {
  shipmentId: string;
  /** Mã đọc được trên kiện. */
  code: string | null;
  receiverName: string;
  receiverPhone: string;
  /** COD khai báo trên vận đơn — để nhận ra kiện, KHÔNG phải tiền đã thu. */
  codAmount: number;
  stage: string;
  /** Ngày ĐVVC báo trả về shop. */
  returnedAt: Date | null;
  /** Số ngày kể từ khi ĐVVC báo trả về — kiện càng cũ thì sổ càng sai lâu. */
  ageDays: number | null;
  ctx: ReturnProductContext;
};

export type ReceiveQueue = {
  rows: ReceiveQueueRow[];
  /** Tổng số kiện đang chờ kho nhận (toàn bộ, không giới hạn ở phần đang hiện). */
  total: number;
  /** Số kiện thực sự nạp về để dựng bối cảnh — phần còn lại nằm ngoài trần `limit`. */
  loaded: number;
  summary: ReturnType<typeof summarizeReturnItems> & { overdue: number; oldestDays: number | null };
};

/** Quá hạn: ĐVVC đã trả về shop chừng này ngày mà kho vẫn chưa bấm nhận. */
export { RECEIVE_SLA_DAYS };

const days = (d: Date | null) => (d ? Math.floor((Date.now() - d.getTime()) / 86_400_000) : null);

/**
 * Nạp hàng đợi rồi ghép sản phẩm MỘT LƯỢT cho cả danh sách.
 *
 * Số truy vấn không đổi theo số kiện: 2 cho danh sách + đếm, cộng đúng 4 của bước ghép sản phẩm.
 * Không có truy vấn nào nằm trong vòng lặp dòng.
 */
export async function receiveQueue({ limit = 400, q = "" }: { limit?: number; q?: string } = {}): Promise<ReceiveQueue> {
  const db = await getDb();
  const term = q.trim();
  const conds: SQL[] = [IS_RETURN_NOT_RECEIVED as SQL];
  // Lọc ở CSDL những gì CSDL biết (mã, tên, SĐT). Mã hàng / tên sản phẩm nằm ở đơn nối qua nhiều
  // bước nên lọc sau khi đã ghép — xem bên dưới.
  if (term) {
    const like = `%${term}%`;
    conds.push(
      sql`(${s.vtpOrderNumber} ilike ${like} or ${s.trackingCode} ilike ${like} or ${s.orderReference} ilike ${like} or ${s.receiverName} ilike ${like} or ${s.receiverPhone} ilike ${like})`,
    );
  }
  const where = and(...conds);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: s.id,
        vtpOrderNumber: s.vtpOrderNumber,
        trackingCode: s.trackingCode,
        receiverName: s.receiverName,
        receiverPhone: s.receiverPhone,
        codAmount: s.codAmount,
        stage: s.stage,
        returnedAt: s.returnedAt,
      })
      .from(s)
      .where(where)
      // Cũ nhất trước: kiện nằm lâu nhất là kiện làm sổ sai lâu nhất.
      .orderBy(asc(sql`coalesce(${s.returnedAt}, ${s.updatedAt})`), desc(s.updatedAt))
      .limit(limit),
    db.select({ n: sql<number>`count(*)` }).from(s).where(where),
  ]);

  const ctxMap = await returnProductContext(rows.map((r) => r.id));

  let list: ReceiveQueueRow[] = rows.map((r) => ({
    shipmentId: r.id,
    code: r.vtpOrderNumber ?? r.trackingCode ?? null,
    receiverName: r.receiverName ?? "",
    receiverPhone: r.receiverPhone ?? "",
    codAmount: Number(r.codAmount ?? 0),
    stage: r.stage ?? "",
    returnedAt: r.returnedAt ?? null,
    ageDays: days(r.returnedAt ?? null),
    ctx: ctxMap.get(r.id) ?? EMPTY_CONTEXT(r.id),
  }));

  /*
    TÌM THEO MÃ HÀNG / TÊN SẢN PHẨM / MÃ ĐƠN sau khi đã ghép.
    Ba thứ này chỉ tồn tại sau bước ghép định danh, nên lọc ở đây thay vì nhồi thêm một phép nối
    nữa vào câu truy vấn chính. Danh sách đã bị chặn bởi `limit` nên đây là lọc trên vài trăm dòng
    trong bộ nhớ, không phải quét bảng.
  */
  if (term) {
    const t = term.toLowerCase();
    const daKhopODb = (r: ReceiveQueueRow) =>
      [r.code, r.receiverName, r.receiverPhone].some((v) => (v ?? "").toLowerCase().includes(t));
    list = list.filter(
      (r) =>
        daKhopODb(r) ||
        (r.ctx.orderCode ?? "").toLowerCase().includes(t) ||
        r.ctx.items.some((it) => it.sku.toLowerCase().includes(t) || it.name.toLowerCase().includes(t)),
    );
  }

  const base = summarizeReturnItems(list.map((r) => r.ctx));
  const ages = list.map((r) => r.ageDays).filter((x): x is number => x !== null);
  return {
    rows: list,
    total: Number(total?.n ?? 0),
    loaded: rows.length,
    summary: {
      ...base,
      overdue: list.filter((r) => (r.ageDays ?? 0) >= RECEIVE_SLA_DAYS).length,
      oldestDays: ages.length ? Math.max(...ages) : null,
    },
  };
}

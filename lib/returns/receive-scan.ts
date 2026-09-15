import { eq, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { markReturnsArrived } from "@/lib/returns/inspection";
import { EMPTY_CONTEXT, returnProductContext, type ReturnProductContext } from "@/lib/returns/product-context";

/**
 * ═══════════ BẮN MÃ VẬN ĐƠN ĐỂ NHẬN KIỆN HOÀN ═══════════
 *
 * Người kho cầm kiện, bắn mã, kiện được ghi là ĐÃ VỀ TỚI KHO. Hết. KHÔNG cộng một món nào vào tồn.
 *
 * ─── TIẾNG "BÍP" CỦA MÁY QUÉT KHÔNG PHẢI BẰNG CHỨNG ───
 *
 * Máy quét kêu khi nó ĐỌC ĐƯỢC vạch — trước khi ERP nhận được ký tự nào, và bất kể ERP có ghi nổi
 * hay không. Người kho bắn 40 kiện, nghe 40 tiếng bíp, và tin rằng 40 kiện đã vào sổ. Nên mọi kết
 * quả ở đây đều mang một `outcome` mà màn hình phải dịch thành màu và âm báo RIÊNG của ERP: xanh
 * chỉ dành cho lượt ghi thật sự thành công.
 *
 * ─── VÌ SAO BẮN LẠI KHÔNG PHẢI LÀ LỖI ───
 *
 * Máy quét HID gửi `<mã><ENTER>`, và một cú bấm cò hơi lâu gửi hai lần. Kiện trượt tay, bắn lại.
 * Hai người cùng dỡ một xe. Cả ba đều bình thường ở kho. `markReturnsArrived` idempotent
 * (`shipment_id` UNIQUE), nên lần hai không tạo phiếu mới — và ở đây nó trả `ALREADY`, một kết quả
 * VÀNG kèm "ai nhận, lúc nào", chứ không phải một dòng đỏ. Báo đỏ cho một thao tác đã thành công
 * là cách dạy người ta bấm thêm lần nữa cho tới khi nó "xanh".
 */

const s = schema.shipments;

/**
 * KẾT QUẢ MỘT LƯỢT BẮN — bốn kết cục, ba màu.
 *
 *  · `RECEIVED`   xanh  — vừa ghi nhận xong, kiện xuống hàng đợi đếm.
 *  · `ALREADY`    vàng  — đã nhận từ trước (ai, lúc nào). Không ghi gì thêm.
 *  · `NEEDS_CONFIRM` vàng — tìm thấy kiện nhưng ĐVVC không nói nó đang hoàn. Chờ người xác nhận.
 *  · `NOT_FOUND`  đỏ    — không mã nào khớp.
 */
export type ScanOutcome = "RECEIVED" | "ALREADY" | "NEEDS_CONFIRM" | "NOT_FOUND";

export type ScanParcel = {
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  receiverName: string;
  receiverPhone: string;
  stage: string;
  stageName: string;
  returnedAt: Date | null;
  ctx: ReturnProductContext;
  /** Đã có phiếu kiểm: kiện từng được nhận. */
  receivedAt: Date | null;
  receivedBy: string;
  /** Đã ĐẾM XONG — kiện này đã vào tồn (hoặc đã kết luận không vào tồn). */
  inspected: boolean;
};

export type ScanReceiveResult =
  | { outcome: "RECEIVED" | "ALREADY" | "NEEDS_CONFIRM"; parcel: ScanParcel; message: string }
  | { outcome: "NOT_FOUND"; parcel: null; message: string };

/** Máy quét hay chèn khoảng trắng / gạch nối; so mã thì bỏ mọi thứ không phải chữ-số. */
const alnum = (v: string | null | undefined) => (v ?? "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "");

/**
 * CHẶNG NÀO THÌ MỘT KIỆN VỀ TỚI KHO LÀ CHUYỆN BÌNH THƯỜNG.
 *
 * `RETURNED` / `RETURNING` là ca thường. `CANCELLED` cũng có thật: đơn bị huỷ sau khi đã lấy hàng,
 * kiện quay về. Ngoài ba chặng ấy — nhất là `DELIVERED` — thì kiện đang nằm trên bàn mâu thuẫn với
 * điều ĐVVC nói, và đó là thứ người kho phải NHÌN THẤY trước khi ghi, không phải thứ ERP lặng lẽ
 * bỏ qua.
 */
const CHANG_HOAN = new Set(["RETURNED", "RETURNING", "CANCELLED"]);

/**
 * Tra một mã bắn được về đúng một vận đơn.
 *
 * Bốn đường tra, theo thứ tự chắc dần xuống: mã Viettel Post · mã tracking · mã gốc ghi trên vận
 * đơn chiều về (luật 7) · khoá vận đơn · mã đơn Pancake. Tất cả so trên dạng đã bỏ ký tự thừa, vì
 * nhãn in có gạch nối mà máy quét thì không luôn gửi kèm.
 *
 * KHÔNG có đường "khớp gần đúng": ở đây một lần trả nhầm kiện là một lần ghi nhận sai kiện.
 */
export async function findShipmentByScan(code: string): Promise<ScanParcel | null> {
  const q = code.trim();
  const key = alnum(q);
  if (!key) return null;

  const db = await getDb();
  const norm = (col: unknown) => sql`upper(regexp_replace(coalesce(${col}, ''), '[^0-9A-Za-z]', '', 'g'))`;

  /*
    NỐI BẢNG, KHÔNG DÙNG TRUY VẤN CON TƯƠNG QUAN Ở DANH SÁCH CỘT.

    SỰ CỐ ĐÃ BẮT ĐƯỢC BẰNG KIỂM THỬ (15/09/2026). Viết `(select ri.received_by from
    return_inspections ri where ri.shipment_id = ${s.id})` trong danh sách cột thì drizzle sinh ra
    `... where ri.shipment_id = "id"` — KHÔNG kèm tên bảng, vì ở danh sách cột nó ánh xạ theo vị
    trí chứ không theo tên. Postgres giải `"id"` vào bảng TRONG cùng, tức `return_inspections.id`,
    nên điều kiện thành `ri.shipment_id = ri.id` và không bao giờ khớp.

    Hỏng theo kiểu tệ nhất: không lỗi, không cảnh báo — chỉ là "kiện này chưa ai nhận" cho MỌI
    kiện, kể cả kiện vừa nhận xong. Người kho sẽ nhận lại nó lần thứ hai.

    Phép nối không có cái bẫy đó vì nó viết ra quan hệ một lần, ở đúng chỗ Postgres đòi tên bảng.
  */
  const ri = schema.returnInspections;
  const o = schema.orders;

  const [row] = await db
    .select({
      id: s.id,
      vtpOrderNumber: s.vtpOrderNumber,
      trackingCode: s.trackingCode,
      orderId: s.orderId,
      orderCode: sql<string | null>`${o.systemId}::text`,
      receiverName: s.receiverName,
      receiverPhone: s.receiverPhone,
      stage: sql<string>`${s.stage}::text`,
      stageName: s.vtpStatusName,
      returnedAt: s.returnedAt,
      receivedAt: ri.receivedAt,
      receivedBy: ri.receivedBy,
      inspected: sql<boolean>`${ri.status} = 'INSPECTED'`,
    })
    .from(s)
    .leftJoin(ri, eq(ri.shipmentId, s.id))
    .leftJoin(o, eq(o.id, s.orderId))
    .where(
      or(
        eq(norm(s.vtpOrderNumber), key),
        eq(norm(s.trackingCode), key),
        eq(norm(s.orderReference), key),
        eq(s.id, q),
        sql`${o.systemId}::text = ${q}`,
      ),
    )
    /*
      MỘT MÃ CÓ THỂ RA HAI DÒNG: vận đơn chiều đi (mã gốc) và vận đơn chiều về (mã gốc + 1P1, mang
      mã gốc ở `order_reference`). Kiện đang nằm trên bàn là CHIỀU VỀ, nên ưu tiên dòng có mốc
      `returned_at` mới nhất. Đây là thứ tự, không phải phỏng đoán: cả hai dòng đều có thật và đều
      đúng, chỉ một trong hai là kiện đang cầm.
    */
    .orderBy(sql`(${s.returnedAt} is null), ${s.returnedAt} desc, ${s.updatedAt} desc`)
    .limit(1);

  if (!row) return null;
  const ctx = (await returnProductContext([row.id])).get(row.id) ?? EMPTY_CONTEXT(row.id);
  return {
    shipmentId: row.id,
    code: row.vtpOrderNumber ?? row.trackingCode ?? null,
    orderId: row.orderId ?? null,
    orderCode: row.orderCode ?? null,
    receiverName: row.receiverName ?? "",
    receiverPhone: row.receiverPhone ?? "",
    stage: row.stage ?? "",
    stageName: row.stageName ?? "",
    returnedAt: row.returnedAt ?? null,
    ctx,
    receivedAt: row.receivedAt ? new Date(row.receivedAt) : null,
    receivedBy: row.receivedBy ?? "",
    inspected: Boolean(row.inspected),
  };
}

/**
 * BẮN MÃ → GHI NHẬN KIỆN ĐÃ VỀ. Không cộng tồn, không kết luận gì về hàng bên trong.
 *
 * `confirmUnexpected` là lượt bấm THỨ HAI của người kho cho một kiện mà ĐVVC không nói là đang
 * hoàn. Mặc định `false` — ghi luôn thì ERP đang tự khẳng định một kiện `DELIVERED` thật ra đã
 * quay về, mà bằng chứng duy nhất là ai đó vừa bắn một mã.
 */
export async function scanReceiveReturn(input: { code: string; actor: Actor; note?: string; confirmUnexpected?: boolean }): Promise<ScanReceiveResult> {
  const q = input.code.trim();
  if (!q) return { outcome: "NOT_FOUND", parcel: null, message: "Chưa có mã nào" };

  const parcel = await findShipmentByScan(q);
  if (!parcel) {
    return {
      outcome: "NOT_FOUND",
      parcel: null,
      message: `Không thấy vận đơn “${q}” trong ERP. Kiểm tra lại mã, hoặc nếu nhãn đã mất thì dùng “Không có mã vận đơn”.`,
    };
  }

  if (parcel.receivedAt) {
    const luc = parcel.receivedAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    return {
      outcome: "ALREADY",
      parcel,
      message: parcel.inspected
        ? `${parcel.code ?? parcel.shipmentId}: kiện này ĐÃ ĐẾM XONG lúc ${luc}. Không ghi lại lần hai — hàng đã vào sổ.`
        : `${parcel.code ?? parcel.shipmentId}: đã nhận lúc ${luc}${parcel.receivedBy ? ` bởi ${parcel.receivedBy}` : ""}, đang chờ đếm.`,
    };
  }

  if (!CHANG_HOAN.has(parcel.stage.toUpperCase()) && !input.confirmUnexpected) {
    return {
      outcome: "NEEDS_CONFIRM",
      parcel,
      message: `${parcel.code ?? parcel.shipmentId}: ĐVVC đang báo “${parcel.stageName || parcel.stage}”, không phải chiều hoàn. Kiện vẫn đang trên tay bạn thì bấm xác nhận để ghi nhận — lượt ghi sẽ mang dấu “nhận ngoài chặng hoàn”.`,
    };
  }

  const ngoaiChang = !CHANG_HOAN.has(parcel.stage.toUpperCase());
  const note = [input.note?.trim(), ngoaiChang ? `Nhận ngoài chặng hoàn (ĐVVC báo ${parcel.stageName || parcel.stage})` : ""].filter(Boolean).join(" · ");
  const { count } = await markReturnsArrived([parcel.shipmentId], input.actor, note);

  if (!count) {
    /*
      Một lượt khác vừa chen vào giữa lúc tra và lúc ghi (hai tab, hai người, một lượt thử lại của
      mạng). `onConflictDoNothing` nuốt nó êm — nhưng người bấm phải biết đây là lượt THỨ HAI,
      không phải lượt đầu, nếu không họ đếm nhầm số kiện đã xử lý.
    */
    const lai = await findShipmentByScan(q);
    return { outcome: "ALREADY", parcel: lai ?? parcel, message: `${parcel.code ?? parcel.shipmentId}: vừa được người khác ghi nhận cùng lúc — không ghi lại lần hai.` };
  }

  const mon = parcel.ctx.expectedQty;
  const tomTat = mon === null ? "chưa ghép được đơn nên chưa biết trong kiện có gì" : `${mon} món dự kiến`;
  return {
    outcome: "RECEIVED",
    parcel: { ...parcel, receivedAt: new Date(), receivedBy: input.actor.label },
    message: `Đã nhận ${parcel.code ?? parcel.shipmentId} · ${tomTat}. CHỜ ĐẾM — hàng chưa vào tồn.`,
  };
}

import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { ITEM_CONDITION_LABEL, ITEM_CONDITION_RESTOCKS, type ItemCondition } from "@/lib/constants/return-lifecycle";
import {
  unidentifiedCode,
  type IdentificationMethod,
  type RestockAuthority,
  type UnidentifiedSource,
  type UnidentifiedStatus,
} from "@/lib/constants/return-unidentified";
import { markReturnsArrived } from "@/lib/returns/inspection";

/**
 * ═══════════ HÀNG HOÀN CHƯA XÁC ĐỊNH NGUỒN — LỚP 1 VÀ LỚP 3, KHÔNG CẦN LỚP 2 ═══════════
 *
 * Tệp này là đường ghi DUY NHẤT cho kiện hoàn không còn mã vận đơn. Ba việc nó làm, và điều duy
 * nhất nối chúng lại: **món hàng chỉ được cộng vào tồn ĐÚNG MỘT LẦN, dù đi bằng đường nào.**
 *
 *   `createUnidentifiedReturn` — kiện có thật đã về kho. KHÔNG cộng tồn.
 *   `identifyUnidentifiedReturn` — nối với một vận đơn có thật. VẪN KHÔNG cộng tồn.
 *   `restockUnidentifiedReturn` — cộng tồn. Chỉ ở đây, và chỉ một lần.
 *
 * ─── CÁI CHỐT CHỐNG CỘNG HAI LẦN ───
 *
 * `return_unidentified.stock_receipt_id` là cột DUY NHẤT nói "đã vào tồn". Mọi lượt tái nhập đều
 * chạy `UPDATE ... WHERE id = ? AND stock_receipt_id IS NULL` bên trong MỘT giao dịch cùng với
 * phiếu kho. Không khớp ⇒ 0 dòng ⇒ giao dịch huỷ ⇒ phiếu kho vừa lập cũng biến mất.
 *
 * Nên: hai tab, hai lần Enter của máy quét, một lượt thử lại của mạng, hay hai người kho cùng bấm
 * — tất cả đều ra đúng một phiếu. Chốt nằm ở CSDL, không ở trình duyệt; trình duyệt chỉ làm cho
 * người bấm đỡ khó chịu.
 *
 * ─── VÌ SAO NỐI ĐƠN KHÔNG CỘNG TỒN ───
 *
 * Nối đơn trả lời câu "kiện này của ai". Cộng tồn trả lời câu "hàng có bán lại được không". Gộp
 * hai câu là quay lại đúng sai lầm mà `return_inspections` sinh ra để sửa: ERP tự khẳng định một
 * kiện về đủ và còn tốt chỉ vì đã biết nó thuộc đơn nào.
 */

const u = schema.returnUnidentified;
const s = schema.shipments;
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type UnidentifiedRow = {
  id: string;
  code: string;
  status: UnidentifiedStatus;
  source: UnidentifiedSource;
  receivedAt: Date;
  receivedBy: string;
  warehouseNote: string;
  variantId: string | null;
  sku: string;
  productName: string;
  color: string;
  size: string;
  quantity: number;
  condition: ItemCondition;
  note: string;
  identificationMethod: IdentificationMethod | null;
  identifiedAt: Date | null;
  identifiedBy: string;
  linkedOrderId: string | null;
  linkedShipmentId: string | null;
  linkedTrackingNumber: string;
  unidentifiableReason: string;
  /** `null` = CHƯA VÀO TỒN. Đây là cột duy nhất trả lời câu đó. */
  stockReceiptId: string | null;
  restockedAt: Date | null;
  restockedBy: string;
  restockAuthority: RestockAuthority | null;
  restockReason: string;
};

// ───────────────────────── 1. KIỆN VẬT LÝ ĐÃ VỀ ─────────────────────────

export type CreateUnidentifiedInput = {
  source: UnidentifiedSource;
  variantId: string | null;
  quantity: number;
  condition: ItemCondition;
  note: string;
  warehouseNote: string;
  actor: Actor;
};

export type CreateUnidentifiedResult = { ok: true; row: UnidentifiedRow } | { error: string };

/**
 * SỐ THỨ TỰ TRONG NGÀY, SINH TRONG GIAO DỊCH.
 *
 * Đếm số dòng đã có của hôm nay rồi +1 là đủ vì mã chỉ để NGƯỜI đọc — nhưng nó phải chạy trong
 * cùng giao dịch với lượt chèn, và cột `code` phải UNIQUE, để hai người kho bấm cùng lúc không ra
 * hai kiện cùng mã. Trùng thì lượt sau hỏng ràng buộc và thử lại — thà lỗi còn hơn hai kiện khác
 * nhau mang cùng một cái nhãn viết tay.
 */
async function nextCode(tx: DbLike, now: Date): Promise<string> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(u)
    .where(sql`${u.receivedAt} >= date_trunc('day', ${now.toISOString()}::timestamptz) and ${u.receivedAt} < date_trunc('day', ${now.toISOString()}::timestamptz) + interval '1 day'`);
  return unidentifiedCode(now, Number(row?.n ?? 0) + 1);
}

/**
 * GHI NHẬN MỘT KIỆN HOÀN KHÔNG CÓ MÃ VẬN ĐƠN.
 *
 * Đây là LỚP 1: hàng có thật, nằm trên bàn, đếm được. KHÔNG cộng tồn — kể cả khi kết luận là còn
 * bán được. Muốn vào tồn thì phải qua `restockUnidentifiedReturn`, nơi có người chịu trách nhiệm.
 */
export async function createUnidentifiedReturn(input: CreateUnidentifiedInput): Promise<CreateUnidentifiedResult> {
  const qty = Math.trunc(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Số lượng phải lớn hơn 0 — không có hàng thì không có gì để ghi" };
  const label = input.actor.label.trim();
  if (!label) return { error: "Thiếu người nhận hàng" };

  const db = await getDb();
  const now = new Date();

  /*
    ẢNH CHỤP MẪU MÃ, KHÔNG ĐỌC SỐNG VỀ SAU.
    Mẫu mã có thể bị đổi tên, đổi màu, hoặc xoá khỏi danh mục sau đó. Dòng này là biên bản nhận
    hàng — nó phải giữ đúng thứ người kho nhìn thấy lúc nhận, không phải thứ danh mục nói hôm nay.
  */
  let snapshot = { sku: "", productName: "", color: "", size: "" };
  if (input.variantId) {
    const [v] = await db
      .select({ sku: schema.productVariants.sku, color: schema.productVariants.color, size: schema.productVariants.size, name: schema.products.name })
      .from(schema.productVariants)
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, input.variantId))
      .limit(1);
    if (!v) return { error: "Mẫu mã không có trong danh mục ERP" };
    snapshot = { sku: v.sku ?? "", productName: v.name ?? "", color: v.color ?? "", size: v.size ?? "" };
  }

  const row = await db.transaction(async (tx) => {
    const code = await nextCode(tx, now);
    const [created] = await tx
      .insert(u)
      .values({
        code,
        status: "PENDING_IDENTIFICATION",
        source: input.source,
        receivedAt: now,
        receivedBy: label,
        receivedByUserId: input.actor.id,
        warehouseNote: input.warehouseNote.trim(),
        variantId: input.variantId,
        ...snapshot,
        quantity: qty,
        condition: input.condition,
        note: input.note.trim(),
      })
      .returning();
    return created;
  });

  return { ok: true, row: toRow(row) };
}

// ───────────────────────── 2. NỐI VỚI MỘT VẬN ĐƠN CÓ THẬT ─────────────────────────

export type IdentifyResult = { ok: true; row: UnidentifiedRow; code: string } | { error: string };

/**
 * NGƯỜI KHO ĐỐI CHIẾU RỒI CHỌN — máy không chọn hộ bao giờ.
 *
 * Ba điều được chặn ở đây, và cả ba đều là đường dẫn tới tồn kho sai:
 *
 *  1. Kiện ĐÃ VÀO TỒN rồi thì không đổi được quy kết nữa. Đổi đích của một phiếu đã cộng tồn là
 *     sửa lịch sử; muốn sửa thì lập phiếu điều chỉnh có người ký.
 *  2. Vận đơn ĐÃ ĐƯỢC ĐẾM rồi thì không nối vào được: kiện vật lý ấy đã cộng tồn một lần qua
 *     `return_inspections`, nối thêm món này là cộng lần hai cho cùng một món hàng.
 *  3. Một vận đơn chỉ nhận MỘT món giữ tạm chưa vào tồn. Hai kiện mất nhãn cùng trỏ vào một vận
 *     đơn thì ít nhất một cái sai — và cái sai ấy sẽ cộng tồn cho hàng của người khác.
 *
 * ĐỒNG THỜI ghi nhận kiện đã về trên chính vận đơn đó (`markReturnsArrived`, idempotent): hàng
 * ĐANG nằm ở kho thật, nên để vận đơn ấy tiếp tục hiện ở "chờ kho nhận" là mời người kho nhận nó
 * lần thứ hai.
 */
export async function identifyUnidentifiedReturn(input: { id: string; shipmentId: string; actor: Actor }): Promise<IdentifyResult> {
  const label = input.actor.label.trim();
  if (!label) return { error: "Thiếu người xác định" };

  const db = await getDb();
  const [row] = await db.select().from(u).where(eq(u.id, input.id)).limit(1);
  if (!row) return { error: "Không thấy kiện hàng hoàn chưa xác định này" };
  if (row.stockReceiptId) return { error: `${row.code} đã vào tồn rồi — muốn đổi quy kết thì lập phiếu điều chỉnh kho, không sửa ngược lịch sử` };

  /*
    PHÉP NỐI, KHÔNG PHẢI TRUY VẤN CON TƯƠNG QUAN ở danh sách cột (xem `lib/returns/receive-scan.ts`):
    ở đó drizzle sinh cột không kèm tên bảng, và `ri.shipment_id = "id"` tự khớp vào chính
    `return_inspections.id` — "chưa ai đếm" cho mọi kiện, lặng lẽ. Ở ĐÂY nó còn nguy hiểm hơn: đó
    là lá chắn duy nhất ngăn nối một kiện mất nhãn vào vận đơn ĐÃ cộng tồn.
  */
  const ri = schema.returnInspections;
  const [sh] = await db
    .select({
      id: s.id,
      orderId: s.orderId,
      code: sql<string | null>`coalesce(nullif(${s.vtpOrderNumber}, ''), nullif(${s.trackingCode}, ''))`,
      inspected: sql<boolean>`${ri.status} = 'INSPECTED'`,
    })
    .from(s)
    .leftJoin(ri, eq(ri.shipmentId, s.id))
    .where(eq(s.id, input.shipmentId))
    .limit(1);
  if (!sh) return { error: "Vận đơn không có trong ERP" };
  if (sh.inspected) {
    return { error: `Vận đơn ${sh.code ?? sh.id} đã được đếm và đã vào tồn — nối kiện này vào đó là cộng tồn lần thứ hai cho cùng một món hàng` };
  }

  const [khac] = await db
    .select({ code: u.code })
    .from(u)
    .where(and(eq(u.linkedShipmentId, input.shipmentId), isNull(u.stockReceiptId), sql`${u.id} <> ${input.id}`))
    .limit(1);
  if (khac) return { error: `Vận đơn ${sh.code ?? sh.id} đã được nối với ${khac.code} và món đó chưa vào tồn — hai kiện không thể cùng là một vận đơn` };

  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [x] = await tx
      .update(u)
      .set({
        status: "IDENTIFIED",
        identificationMethod: "MANUAL_MATCH" satisfies IdentificationMethod,
        identifiedAt: now,
        identifiedBy: label,
        identifiedByUserId: input.actor.id,
        linkedOrderId: sh.orderId,
        linkedShipmentId: sh.id,
        linkedTrackingNumber: sh.code ?? "",
        /* Nối được đơn thì lý do "không xác định được" của lần trước không còn đúng — nhưng nó là
           một kết luận đã ghi, nên xoá ở đây là xoá đúng phần giải thích vì sao trước đó bó tay.
           Giữ lại: dòng vẫn đọc được cả hai giai đoạn. */
        updatedAt: now,
      })
      // Chặn ở CSDL: một lượt khác vừa cộng tồn cho dòng này thì lượt nối không được đè lên.
      .where(and(eq(u.id, input.id), isNull(u.stockReceiptId)))
      .returning();
    if (!x) throw new Error("VUA_DOI");
    // Hàng đang ở kho thật ⇒ vận đơn thôi nằm ở "chờ kho nhận". Idempotent nên nối lại không sao.
    // Truyền `tx`: gọi hàm tự mở kết nối riêng từ trong giao dịch là khoá chết (xem chú thích ở
    // `markReturnsArrived`).
    await markReturnsArrived([sh.id], input.actor, `Nhận qua kiện mất nhãn ${row.code}`, tx);
    return x;
  });

  return { ok: true, row: toRow(updated), code: sh.code ?? sh.id };
}

/** Kết luận KHÔNG THỂ lần ra đơn. Vẫn không cộng tồn — chỉ mở đường cho quyết định của quản lý kho. */
export async function markUnidentifiable(input: { id: string; reason: string; actor: Actor }): Promise<IdentifyResult> {
  const reason = input.reason.trim();
  if (!reason) return { error: "Phải ghi rõ đã tra những gì và vì sao bó tay — nếu không, người sau lại tra lại từ đầu" };

  const db = await getDb();
  const [row] = await db.select({ code: u.code, receipt: u.stockReceiptId }).from(u).where(eq(u.id, input.id)).limit(1);
  if (!row) return { error: "Không thấy kiện hàng hoàn chưa xác định này" };
  if (row.receipt) return { error: `${row.code} đã vào tồn rồi — không đổi kết luận ngược lại được` };

  const [x] = await db
    .update(u)
    .set({ status: "UNIDENTIFIABLE", unidentifiableReason: reason, updatedAt: new Date() })
    .where(and(eq(u.id, input.id), isNull(u.stockReceiptId)))
    .returning();
  if (!x) return { error: "Kiện vừa được người khác xử lý — mở lại danh sách để xem trạng thái mới" };
  return { ok: true, row: toRow(x), code: x.code };
}

// ───────────────────────── 3. CỘNG TỒN — CHỖ DUY NHẤT, MỘT LẦN DUY NHẤT ─────────────────────────

export type RestockResult = { ok: true; row: UnidentifiedRow; restocked: number; receiptId: string; already: false } | { ok: true; row: UnidentifiedRow; restocked: 0; receiptId: string; already: true } | { error: string };

/**
 * ĐƯA MỘT MÓN GIỮ TẠM VÀO TỒN BÁN ĐƯỢC.
 *
 * Hai căn cứ, và chúng KHÔNG tương đương nhau — xem `RESTOCK_AUTHORITIES`:
 *
 *  · `IDENTIFIED` — đã nối được vận đơn thật. Hàng hoàn bình thường.
 *  · `MANAGER_OVERRIDE` — không lần ra đơn, nhưng kho khẳng định nhận diện được mẫu mã và hàng còn
 *    bán được. Lời khẳng định không có chứng từ đối chiếu, nên nó cần quyền cao hơn VÀ một lý do.
 *
 * Quyền được kiểm ở Server Action (nơi có `user`); ở đây kiểm cái mà CHỈ dữ liệu trả lời được:
 * căn cứ `IDENTIFIED` chỉ đứng được khi dòng thật sự đã `IDENTIFIED`. Ràng buộc CSDL
 * `return_unidentified_authority_status_check` khoá lại lần nữa — hai lớp, vì đây là đúng chỗ một
 * lượt cộng tồn không chứng từ có thể đội lốt một lượt có chứng từ.
 *
 * GỌI LẠI LẦN HAI TRẢ VỀ `already: true`, KHÔNG PHẢI LỖI. Máy quét gửi hai lần Enter, mạng thử
 * lại, người bấm đúp — đó là chuyện bình thường ở kho, và trả lỗi đỏ cho một thao tác ĐÃ THÀNH
 * CÔNG dạy người ta bấm thêm lần nữa.
 */
export async function restockUnidentifiedReturn(input: { id: string; reason: string; actor: Actor }): Promise<RestockResult> {
  const label = input.actor.label.trim();
  if (!label) return { error: "Thiếu người tái nhập" };

  const db = await getDb();
  const [row] = await db.select().from(u).where(eq(u.id, input.id)).limit(1);
  if (!row) return { error: "Không thấy kiện hàng hoàn chưa xác định này" };

  // ĐÃ CỘNG RỒI: nói ra, đừng cộng thêm và cũng đừng báo đỏ.
  if (row.stockReceiptId) return { ok: true, row: toRow(row), restocked: 0, receiptId: row.stockReceiptId, already: true };

  if (!row.variantId) return { error: `${row.code} chưa nhận diện được mẫu mã — không biết cộng vào đâu. Chọn mẫu mã trước.` };
  const condition = row.condition as ItemCondition;
  if (!ITEM_CONDITION_RESTOCKS[condition]) {
    return { error: `${row.code} đang ở kết luận “${ITEM_CONDITION_LABEL[condition]}” nên không vào tồn bán được. Làm sạch / sửa xong thì đổi kết luận sang “Đủ” rồi tái nhập.` };
  }

  const authority: RestockAuthority = row.status === "IDENTIFIED" ? "IDENTIFIED" : "MANAGER_OVERRIDE";
  const reason = input.reason.trim();
  if (authority === "MANAGER_OVERRIDE" && !reason) {
    return { error: "Tái nhập hàng không lần ra được đơn thì bắt buộc ghi lý do — đây là toàn bộ khác biệt giữa một quyết định của quản lý kho và một lượt cộng tồn không nguồn gốc" };
  }

  const now = new Date();
  const qty = row.quantity;

  try {
    const out = await db.transaction(async (tx) => {
      /*
        PHIẾU KHO TRƯỚC, CHỐT SAU — và cả hai trong MỘT giao dịch.

        Lượt `UPDATE ... WHERE stock_receipt_id IS NULL` bên dưới là cái chốt. Nếu một lượt khác
        vừa cộng tồn cho dòng này thì nó khớp 0 dòng, ta ném lỗi, giao dịch huỷ, và phiếu kho vừa
        lập biến mất cùng nó. Không có đường nào để lại một phiếu mồ côi đã cộng tồn.
      */
      const [receipt] = await tx
        .insert(schema.stockReceipts)
        .values({
          kind: "RETURN",
          receivedAt: now,
          reference: `Hàng hoàn không mã vận đơn ${row.code}`,
          note: [authority === "MANAGER_OVERRIDE" ? "Tái nhập không xác định nguồn" : "Tái nhập sau khi xác định được đơn", reason].filter(Boolean).join(" · "),
          totalQuantity: qty,
          totalCost: 0,
          createdBy: label,
        })
        .returning({ id: schema.stockReceipts.id });

      await tx.insert(schema.stockReceiptItems).values({
        receiptId: receipt.id,
        variantId: row.variantId as string,
        quantity: qty,
        unitCost: 0,
        /* Nối được vận đơn thì ghi vào dòng phiếu: sổ kho tra ngược được về đúng kiện. Không nối
           được thì để `NULL` — ghi một vận đơn "gần đúng" ở đây là đúng kiểu nói dối gọn gàng mà
           `settleReturnsForReceipt` đã phải gỡ bỏ. */
        shipmentId: row.linkedShipmentId,
      });

      const [locked] = await tx
        .update(u)
        .set({
          stockReceiptId: receipt.id,
          restockedAt: now,
          restockedBy: label,
          restockedByUserId: input.actor.id,
          restockAuthority: authority,
          restockReason: reason,
          updatedAt: now,
        })
        .where(and(eq(u.id, input.id), isNull(u.stockReceiptId)))
        .returning();
      if (!locked) throw new Error("DA_VAO_TON");
      return { receiptId: receipt.id, row: locked };
    });
    return { ok: true, row: toRow(out.row), restocked: qty, receiptId: out.receiptId, already: false };
  } catch (e) {
    if (e instanceof Error && e.message === "DA_VAO_TON") {
      const [lai] = await db.select().from(u).where(eq(u.id, input.id)).limit(1);
      if (lai?.stockReceiptId) return { ok: true, row: toRow(lai), restocked: 0, receiptId: lai.stockReceiptId, already: true };
      return { error: "Kiện vừa được người khác xử lý — mở lại danh sách để xem trạng thái mới" };
    }
    throw e;
  }
}

/** Đổi kết luận kiểm hàng (ví dụ giặt xong thì từ “Bẩn” sang “Đủ”). Đã vào tồn thì khoá. */
export async function setUnidentifiedCondition(input: { id: string; condition: ItemCondition; note: string; variantId?: string | null; actor: Actor }): Promise<IdentifyResult> {
  const db = await getDb();
  const [row] = await db.select({ code: u.code, receipt: u.stockReceiptId }).from(u).where(eq(u.id, input.id)).limit(1);
  if (!row) return { error: "Không thấy kiện hàng hoàn chưa xác định này" };
  if (row.receipt) return { error: `${row.code} đã vào tồn rồi — sửa số phải qua phiếu điều chỉnh kho` };
  const note = input.note.trim();
  if (!ITEM_CONDITION_RESTOCKS[input.condition] && !note) return { error: "Kết luận không vào tồn thì phải ghi rõ vì sao" };

  let snapshot: Record<string, string> = {};
  if (input.variantId) {
    const [v] = await db
      .select({ sku: schema.productVariants.sku, color: schema.productVariants.color, size: schema.productVariants.size, name: schema.products.name })
      .from(schema.productVariants)
      .leftJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, input.variantId))
      .limit(1);
    if (!v) return { error: "Mẫu mã không có trong danh mục ERP" };
    snapshot = { sku: v.sku ?? "", productName: v.name ?? "", color: v.color ?? "", size: v.size ?? "" };
  }

  const [x] = await db
    .update(u)
    .set({ condition: input.condition, note, ...(input.variantId ? { variantId: input.variantId, ...snapshot } : {}), updatedAt: new Date() })
    .where(and(eq(u.id, input.id), isNull(u.stockReceiptId)))
    .returning();
  if (!x) return { error: "Kiện vừa được người khác xử lý — mở lại danh sách để xem trạng thái mới" };
  return { ok: true, row: toRow(x), code: x.code };
}

// ───────────────────────── Đọc ─────────────────────────

function toRow(r: typeof schema.returnUnidentified.$inferSelect): UnidentifiedRow {
  return {
    id: r.id,
    code: r.code,
    status: r.status as UnidentifiedStatus,
    source: r.source as UnidentifiedSource,
    receivedAt: r.receivedAt,
    receivedBy: r.receivedBy,
    warehouseNote: r.warehouseNote,
    variantId: r.variantId,
    sku: r.sku,
    productName: r.productName,
    color: r.color,
    size: r.size,
    quantity: r.quantity,
    condition: r.condition as ItemCondition,
    note: r.note,
    identificationMethod: (r.identificationMethod as IdentificationMethod | null) ?? null,
    identifiedAt: r.identifiedAt,
    identifiedBy: r.identifiedBy,
    linkedOrderId: r.linkedOrderId,
    linkedShipmentId: r.linkedShipmentId,
    linkedTrackingNumber: r.linkedTrackingNumber,
    unidentifiableReason: r.unidentifiableReason,
    stockReceiptId: r.stockReceiptId,
    restockedAt: r.restockedAt,
    restockedBy: r.restockedBy,
    restockAuthority: (r.restockAuthority as RestockAuthority | null) ?? null,
    restockReason: r.restockReason,
  };
}

export async function listUnidentifiedReturns({ limit = 100, holdingOnly = false }: { limit?: number; holdingOnly?: boolean } = {}): Promise<UnidentifiedRow[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(u)
    .where(holdingOnly ? isNull(u.stockReceiptId) : sql`true`)
    // Chưa vào tồn lên trước: đó là phần còn phải làm. Trong đó, cũ nhất trước — nằm lâu nhất là
    // nằm ngoài sổ lâu nhất.
    .orderBy(sql`(${u.stockReceiptId} is not null)`, u.receivedAt)
    .limit(limit);
  return rows.map(toRow);
}

export async function findUnidentifiedByCode(code: string): Promise<UnidentifiedRow | null> {
  const q = code.trim();
  if (!q) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(u)
    .where(or(eq(sql`upper(${u.code})`, q.toUpperCase()), eq(u.id, q)))
    .limit(1);
  return row ? toRow(row) : null;
}

export type UnidentifiedSummary = {
  /** Kiện chưa vào tồn — hàng có thật trong kho mà sổ tồn chưa có. */
  holding: number;
  holdingUnits: number;
  pending: number;
  identified: number;
  unidentifiable: number;
  /** Đã vào tồn sau khi xác định được đơn. */
  restockedIdentified: number;
  /** Đã vào tồn bằng quyết định của quản lý kho, KHÔNG có chứng từ đơn — phải nhìn thấy được. */
  restockedOverride: number;
  restockedUnits: number;
  /** Kiện chờ xác định lâu nhất (ngày). `null` = không có kiện nào chờ. */
  oldestPendingDays: number | null;
};

/**
 * BÁO CÁO TỐI THIỂU — mỗi con số trả lời một câu hỏi vận hành, không có con số trang trí.
 *
 * `restockedOverride` đứng riêng và cố ý: đó là lượng hàng đã vào tồn mà KHÔNG có chứng từ đơn nào
 * đối chiếu. Gộp nó vào tổng "đã tái nhập" là làm biến mất đúng con số mà chủ shop cần nhìn.
 */
export async function unidentifiedSummary(): Promise<UnidentifiedSummary> {
  const db = await getDb();
  const [r] = await db
    .select({
      holding: sql<number>`count(*) filter (where ${u.stockReceiptId} is null)`,
      holdingUnits: sql<number>`coalesce(sum(${u.quantity}) filter (where ${u.stockReceiptId} is null), 0)`,
      pending: sql<number>`count(*) filter (where ${u.stockReceiptId} is null and ${u.status} = 'PENDING_IDENTIFICATION')`,
      identified: sql<number>`count(*) filter (where ${u.stockReceiptId} is null and ${u.status} = 'IDENTIFIED')`,
      unidentifiable: sql<number>`count(*) filter (where ${u.stockReceiptId} is null and ${u.status} = 'UNIDENTIFIABLE')`,
      restockedIdentified: sql<number>`count(*) filter (where ${u.restockAuthority} = 'IDENTIFIED')`,
      restockedOverride: sql<number>`count(*) filter (where ${u.restockAuthority} = 'MANAGER_OVERRIDE')`,
      restockedUnits: sql<number>`coalesce(sum(${u.quantity}) filter (where ${u.stockReceiptId} is not null), 0)`,
      oldest: sql<Date | null>`min(${u.receivedAt}) filter (where ${u.stockReceiptId} is null)`,
    })
    .from(u);

  const oldest = r?.oldest ? new Date(r.oldest) : null;
  return {
    holding: Number(r?.holding ?? 0),
    holdingUnits: Number(r?.holdingUnits ?? 0),
    pending: Number(r?.pending ?? 0),
    identified: Number(r?.identified ?? 0),
    unidentifiable: Number(r?.unidentifiable ?? 0),
    restockedIdentified: Number(r?.restockedIdentified ?? 0),
    restockedOverride: Number(r?.restockedOverride ?? 0),
    restockedUnits: Number(r?.restockedUnits ?? 0),
    oldestPendingDays: oldest ? Math.floor((Date.now() - oldest.getTime()) / 86_400_000) : null,
  };
}

/** Lịch sử một kiện, dựng từ chính các mốc đã ghi — không có bảng nhật ký thứ hai để lệch nhau. */
export type UnidentifiedTimelineStep = { at: Date; title: string; detail: string; by: string };

export function unidentifiedTimeline(r: UnidentifiedRow): UnidentifiedTimelineStep[] {
  const steps: UnidentifiedTimelineStep[] = [
    {
      at: r.receivedAt,
      title: "Kho nhận kiện không có mã vận đơn",
      detail: [r.sku ? `${r.sku}${[r.color, r.size].filter(Boolean).length ? ` · ${[r.color, r.size].filter(Boolean).join(" / ")}` : ""}` : "Chưa nhận diện mẫu mã", `× ${r.quantity}`, ITEM_CONDITION_LABEL[r.condition], r.warehouseNote]
        .filter(Boolean)
        .join(" · "),
      by: r.receivedBy,
    },
  ];
  if (r.identifiedAt) {
    steps.push({
      at: r.identifiedAt,
      title: "Xác định được đơn",
      detail: [r.linkedTrackingNumber ? `Vận đơn ${r.linkedTrackingNumber}` : "", r.linkedOrderId ? `Đơn ${r.linkedOrderId}` : "", "Người kho đối chiếu và chọn"].filter(Boolean).join(" · "),
      by: r.identifiedBy,
    });
  }
  if (r.status === "UNIDENTIFIABLE" && r.unidentifiableReason) {
    steps.push({ at: r.restockedAt ?? r.receivedAt, title: "Kết luận không thể xác định", detail: r.unidentifiableReason, by: r.receivedBy });
  }
  if (r.restockedAt && r.stockReceiptId) {
    steps.push({
      at: r.restockedAt,
      title: `Vào tồn: +${r.quantity} ${r.sku || "mẫu mã đã chọn"}`,
      detail: [r.restockAuthority === "MANAGER_OVERRIDE" ? "Quản lý kho quyết, KHÔNG có chứng từ đơn" : "Đã nối được vận đơn", r.restockReason, `Phiếu kho ${r.stockReceiptId}`].filter(Boolean).join(" · "),
      by: r.restockedBy,
    });
  }
  return steps.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Kiện giữ tạm gộp theo mẫu mã — để người đọc sổ kho biết phần "có thật nhưng chưa vào tồn" nằm ở đâu. */
export async function unidentifiedHoldingByVariant() {
  const db = await getDb();
  const rows = await db
    .select({ variantId: u.variantId, sku: u.sku, color: u.color, size: u.size, qty: sql<number>`coalesce(sum(${u.quantity}), 0)`, parcels: sql<number>`count(*)` })
    .from(u)
    .where(and(isNull(u.stockReceiptId), isNotNull(u.variantId)))
    .groupBy(u.variantId, u.sku, u.color, u.size)
    .orderBy(desc(sql`sum(${u.quantity})`))
    .limit(20);
  return rows.map((r) => ({ variantId: r.variantId as string, sku: r.sku, color: r.color, size: r.size, qty: Number(r.qty ?? 0), parcels: Number(r.parcels ?? 0) }));
}

export async function findUnidentifiedById(id: string): Promise<UnidentifiedRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(u).where(eq(u.id, id)).limit(1);
  return row ? toRow(row) : null;
}

export type VariantOption = { id: string; sku: string; name: string; color: string; size: string };

/**
 * TRA MẪU MÃ ĐỂ NGƯỜI KHO CHỌN — tra theo từ khoá, KHÔNG tải cả danh mục.
 *
 * `listVariantsForReceipt()` đã làm việc này ở trang Nhập kho, nhưng nó kéo về toàn bộ mẫu mã kèm
 * tồn hiện tại và giá nhập gần nhất — hai truy vấn con nặng mà bàn nhận hàng hoàn không dùng tới
 * một con số nào. Ở đây chỉ cần đủ để nhận ra đúng cái áo đang cầm trên tay.
 *
 * Mẫu mã đã ẩn / đã xoá VẪN hiện: hàng hoàn của một mã vừa ngừng bán vẫn quay về, và không tìm
 * thấy nó trong danh sách là lý do người kho bỏ qua luôn việc ghi nhận.
 */
export async function searchVariants(term: string, limit = 20): Promise<VariantOption[]> {
  const q = term.trim();
  if (q.length < 2) return [];
  const db = await getDb();
  const like = `%${q.toLowerCase()}%`;
  const rows = await db
    .select({
      id: schema.productVariants.id,
      sku: schema.productVariants.sku,
      name: schema.products.name,
      color: schema.productVariants.color,
      size: schema.productVariants.size,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(
      sql`lower(coalesce(${schema.productVariants.sku}, '') || ' ' || coalesce(${schema.products.name}, '') || ' ' || coalesce(${schema.productVariants.color}, '') || ' ' || coalesce(${schema.productVariants.size}, '')) like ${like}`,
    )
    .orderBy(schema.productVariants.sku)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, sku: r.sku ?? "", name: r.name ?? "", color: r.color ?? "", size: r.size ?? "" }));
}

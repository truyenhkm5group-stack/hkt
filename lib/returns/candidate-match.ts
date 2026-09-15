import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  EMPTY_CANDIDATE_QUERY,
  MIN_PARTIAL_TRACKING,
  MIN_PHONE,
  phoneKey,
  scoreCandidate,
  up,
  alnum,
  type Candidate,
  type CandidateQuery,
} from "@/lib/constants/return-match";
import { EMPTY_CONTEXT, returnProductContext } from "@/lib/returns/product-context";

/**
 * ═══════════ TÌM ĐƠN CHO MỘT KIỆN KHÔNG CÒN MÃ VẬN ĐƠN — PHẦN CHẠM CSDL ═══════════
 *
 * Luật chấm điểm và toàn bộ hằng số nằm ở `lib/constants/return-match.ts`, vì màn hình kho cũng
 * phải vẽ đúng những nhãn ấy. Ở đây chỉ còn một việc: khoanh đúng tập vận đơn đáng xét, rồi giao
 * cho hàm thuần chấm điểm.
 *
 * KHÔNG có đường nào tự nối — xem lời giải thích đầy đủ ở tệp hằng số.
 */

const s = schema.shipments;

export type CandidateSearch =
  | { ok: true; rows: Candidate[]; scanned: number; capped: boolean }
  | { error: string };

/** Trần số vận đơn nạp về để chấm điểm. Đủ rộng để không bỏ sót, đủ hẹp để trang phản hồi ngay. */
export const CANDIDATE_SCAN_CAP = 80;
/** Số ứng viên trả về màn hình — dài hơn thì người kho không đọc, và đọc lướt là nguồn của chọn nhầm. */
export const CANDIDATE_LIMIT = 12;

/**
 * TÌM ỨNG VIÊN. Trả về danh sách đã xếp hạng kèm bằng chứng — KHÔNG nối gì cả.
 *
 * Bắt buộc có ít nhất MỘT dấu hiệu khoanh vùng được: mã vận đơn (một phần cũng được), mã đơn, SĐT,
 * hoặc mã hàng. Tra bằng riêng màu + size là quét gần như cả bảng để trả về một danh sách vô nghĩa
 * — và một danh sách vô nghĩa dài 12 dòng vẫn mời người ta chọn đại một dòng.
 */
export async function searchReturnCandidates(input: Partial<CandidateQuery>): Promise<CandidateSearch> {
  const q: CandidateQuery = { ...EMPTY_CANDIDATE_QUERY, ...input };
  const tracking = alnum(q.tracking);
  const orderCode = up(q.orderCode);
  const phone = phoneKey(q.phone);
  const sku = up(q.sku);

  const coTracking = tracking.length >= MIN_PARTIAL_TRACKING;
  const coPhone = (q.phone ?? "").replace(/\D/g, "").length >= MIN_PHONE && phone.length === 9;
  if (!coTracking && !orderCode && !coPhone && !sku) {
    return { error: `Cần ít nhất một trong: mã vận đơn (≥ ${MIN_PARTIAL_TRACKING} ký tự), mã đơn, số điện thoại, hoặc mã hàng. Riêng màu và size thì trăm đơn cũng khớp.` };
  }

  const db = await getDb();
  const oi = schema.orderItems;

  /*
    MỖI DẤU HIỆU MỘT MỆNH ĐỀ, NỐI BẰNG `OR`.

    Cố ý KHÔNG bắt tất cả cùng khớp: người kho hiếm khi có đủ, và bắt đủ thì kết quả luôn rỗng —
    màn hình rỗng ở kho được đọc thành "hệ thống không có đơn này", đúng cái bẫy đã mô tả ở
    `app/(dashboard)/inventory/returns/page.tsx`.
  */
  const conds = [];
  if (coTracking) {
    const like = `%${tracking}%`;
    conds.push(
      sql`upper(regexp_replace(coalesce(${s.vtpOrderNumber}, '') || '|' || coalesce(${s.trackingCode}, '') || '|' || coalesce(${s.orderReference}, ''), '[^0-9A-Za-z|]', '', 'g')) like ${like}`,
    );
  }
  if (orderCode) {
    conds.push(sql`(${s.orderId} = ${orderCode} or exists (select 1 from orders o2 where o2.id = ${s.orderId} and o2.system_id::text = ${orderCode}))`);
  }
  if (coPhone) conds.push(sql`right(regexp_replace(coalesce(${s.receiverPhone}, ''), '\\D', '', 'g'), 9) = ${phone}`);
  if (sku) {
    /*
      ĐƯỜNG THEO MÃ HÀNG BỊ BÓ VỀ ĐÚNG LOẠI KIỆN ĐANG CẦM.

      Không bó thì "Q004" trúng mọi đơn từng bán mã đó — hàng nghìn dòng, và 99% trong đó là đơn
      giao thành công từ lâu, không bao giờ là kiện đang nằm trên bàn. Bó theo chặng hoàn / huỷ /
      giao hỏng là bó theo ĐÚNG câu hỏi, không phải cắt bớt cho nhanh.
    */
    conds.push(
      sql`(${s.stage} in ('RETURNING','RETURNED','DELIVERY_FAILED','CANCELLED') and exists (
            select 1 from ${oi} where ${oi.orderId} = ${s.orderId} and (upper(${oi.sku}) = ${sku} or upper(${oi.sku}) like ${`${sku}-%`} or upper(${oi.productName}) like ${`%${sku}%`})
          ))`,
    );
  }

  const where = conds.reduce((acc, c) => sql`${acc} or ${c}`);

  /*
    NỐI BẢNG, KHÔNG DÙNG TRUY VẤN CON TƯƠNG QUAN Ở DANH SÁCH CỘT — xem lời giải thích đầy đủ ở
    `lib/returns/receive-scan.ts`. Tóm tắt: ở danh sách cột drizzle sinh cột KHÔNG kèm tên bảng,
    nên `ri.shipment_id = ${s.id}` thành `ri.shipment_id = "id"`, và Postgres giải `"id"` vào
    chính `return_inspections` — điều kiện không bao giờ khớp, im lặng, không lỗi.
  */
  const o = schema.orders;
  const ri = schema.returnInspections;

  const rows = await db
    .select({
      id: s.id,
      vtpOrderNumber: s.vtpOrderNumber,
      trackingCode: s.trackingCode,
      orderReference: s.orderReference,
      orderId: s.orderId,
      orderCode: sql<string | null>`${o.systemId}::text`,
      receiverName: s.receiverName,
      receiverPhone: s.receiverPhone,
      stage: sql<string>`${s.stage}::text`,
      returnedAt: s.returnedAt,
      orderedAt: o.insertedAt,
      /** Đã đếm rồi thì không nối được — nhưng vẫn hiện, kèm lý do. */
      inspected: sql<boolean>`${ri.status} = 'INSPECTED'`,
    })
    .from(s)
    .leftJoin(o, eq(o.id, s.orderId))
    .leftJoin(ri, eq(ri.shipmentId, s.id))
    .where(where)
    .orderBy(sql`coalesce(${s.returnedAt}, ${s.updatedAt}) desc`)
    .limit(CANDIDATE_SCAN_CAP);

  if (!rows.length) return { ok: true, rows: [], scanned: 0, capped: false };

  const ctxMap = await returnProductContext(rows.map((r) => r.id));
  const now = new Date();

  const scored: Candidate[] = rows.map((r) => {
    const ctx = ctxMap.get(r.id) ?? EMPTY_CONTEXT(r.id);
    const { score, confidence, signals } = scoreCandidate(
      q,
      {
        code: r.vtpOrderNumber ?? r.trackingCode ?? null,
        trackingCode: r.trackingCode,
        orderReference: r.orderReference,
        orderId: r.orderId,
        orderCode: r.orderCode,
        receiverName: r.receiverName ?? "",
        receiverPhone: r.receiverPhone ?? "",
        stage: r.stage ?? "",
        returnedAt: r.returnedAt ?? null,
        orderedAt: r.orderedAt ? new Date(r.orderedAt) : null,
        items: ctx.items.map((it) => ({ sku: it.sku, name: it.name, color: it.color, size: it.size })),
      },
      now,
    );
    return {
      shipmentId: r.id,
      code: r.vtpOrderNumber ?? r.trackingCode ?? null,
      orderId: r.orderId ?? null,
      orderCode: r.orderCode ?? null,
      receiverName: r.receiverName ?? "",
      receiverPhone: r.receiverPhone ?? "",
      stage: r.stage ?? "",
      returnedAt: r.returnedAt ?? null,
      orderedAt: r.orderedAt ? new Date(r.orderedAt) : null,
      ctx,
      score,
      confidence,
      signals,
      alreadyInspected: Boolean(r.inspected),
    };
  });

  scored.sort((a, b) => b.score - a.score || (b.returnedAt?.getTime() ?? 0) - (a.returnedAt?.getTime() ?? 0));
  return { ok: true, rows: scored.slice(0, CANDIDATE_LIMIT), scanned: rows.length, capped: rows.length >= CANDIDATE_SCAN_CAP };
}

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import {
  HMT_EXCEPTION_QUEUES,
  HMT_MATCH,
  HMT_SETTLED_STATUSES,
  queueOfStatus,
  type HmtExceptionQueue,
  type HmtMatchStatus,
} from "@/lib/constants/hmt-returns";
import { latestHmtWorkbook, latestHmtWorkbookMeta } from "@/lib/returns/hmt-source";
import { readHmtWorkbook } from "@/lib/returns/hmt-workbook";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ BỐN HÀNG ĐỢI NGOẠI LỆ — TỪ CON SỐ THÀNH VIỆC LÀM ĐƯỢC ═══════════
 *
 * Lượt đối soát 14/09/2026 ghi 724/750 dòng và để lại 26 dòng không khớp, cộng 144 mã chỉ có ở
 * sheet tổng. Trước bản này tất cả chúng là bốn con số trên một thẻ tóm tắt — đếm được, nhưng
 * không ai LÀM được gì với chúng.
 *
 * ─── VÌ SAO BỐN HÀNG ĐỢI, KHÔNG PHẢI MỘT DANH SÁCH "CẦN XEM LẠI" ───
 *
 * Bốn nhóm cần bốn thao tác khác nhau:
 *
 *  · **Cần đối chiếu mẫu mã** — mở kiện, nhìn hàng, chọn đúng mẫu mã trong danh mục.
 *  · **Cần xác minh mã vận đơn** — tra sổ giấy, nối tay với đúng kiện.
 *  · **Mã không có trong ERP** — kiểm tra vận đơn đã đồng bộ chưa (Excel hay đổi mã dài thành
 *    dạng khoa học: `1.5089E+11`).
 *  · **Chỉ có mã, chưa có chi tiết hàng** — KHÔNG phải việc của ERP: kho phải ghi bổ sung dòng món
 *    vào sổ giấy rồi tải lại.
 *
 * Gộp bốn thứ đó thành một danh sách là cách chắc chắn nhất để không ai xem.
 *
 * ─── ỨNG VIÊN MẪU MÃ ĐI KÈM, VÌ KHÔNG AI NHỚ ĐƯỢC 62 MÃ ───
 *
 * Dòng "cần đối chiếu mẫu mã" mang theo DANH SÁCH HÀNG KỲ VỌNG của chính kiện đó. Người gỡ không
 * phải mở tab khác tra đơn — và quan trọng hơn, họ thấy ngay vì sao máy từ chối: mẫu mã sổ ghi
 * KHÔNG nằm trong danh sách ấy.
 */

export type HmtExceptionRow = {
  id: string;
  queue: HmtExceptionQueue;
  matchStatus: HmtMatchStatus;
  matchLabel: string;
  sheet: string;
  sourceRow: number;
  trackingRaw: string;
  trackingKey: string;
  productText: string;
  /** Mẫu mã MÁY đọc ra từ ô chữ. Rỗng = không đọc được mã hàng — đó là lý do ở nhiều dòng. */
  parsedSku: string;
  productCode: string;
  color: string;
  size: string;
  quantity: number;
  /** Kiện máy lần ra (nếu có). `null` ở nhóm "mã không có trong ERP". */
  shipmentId: string | null;
  tracking: string | null;
  orderSystemId: number | null;
  customerName: string;
  customerPhone: string;
  detail: string;
  /** Hàng KỲ VỌNG của kiện — ứng viên để người chọn. Rỗng khi chưa lần ra kiện. */
  candidates: { variantId: string; sku: string; name: string; color: string; size: string; qty: number }[];
};

/** Mã chỉ có ở sheet tổng: bằng chứng tới mức KIỆN, không tới mức MÓN. Không ghi gì từ đây. */
export type HmtTrackingOnlyRow = { trackingRaw: string; trackingKey: string; sourceRow: number; status: string };

export type HmtExceptionQueues = {
  workbook: string;
  lastRunAt: Date | null;
  counts: Record<HmtExceptionQueue, number>;
  /** Đã có người gỡ — để màn hình nói được "còn lại bao nhiêu", không chỉ "có bao nhiêu". */
  resolved: number;
  rows: HmtExceptionRow[];
  trackingOnly: HmtTrackingOnlyRow[];
  /** Mã ở sheet chi tiết mà sheet tổng KHÔNG có — chiều ngược lại, cũng là một lỗ hổng sổ sách. */
  detailOnly: number;
};

type Row = {
  id: string;
  sheet: string;
  sheet_role: string;
  source_row: number;
  tracking_raw: string;
  tracking_key: string;
  product_text: string;
  product_code: string;
  color: string;
  size: string;
  sku: string;
  quantity: number;
  shipment_id: string | null;
  match_status: string;
  detail: string;
  tracking: string | null;
  order_system_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
};

/**
 * MỘT TRUY VẤN CHO CẢ BỐN HÀNG ĐỢI, rồi một truy vấn nữa cho ứng viên mẫu mã.
 *
 * Không đặt truy vấn trong vòng lặp: 26 dòng hôm nay là ít, nhưng lượt đối soát sau có thể để lại
 * hàng trăm, và một màn hình N+1 chỉ lộ ra đúng lúc nó đông nhất.
 */
async function loadExceptionRows(): Promise<Row[]> {
  const db = await getDb();
  const boQua = HMT_SETTLED_STATUSES.map((s) => `'${s}'`).join(",");
  return rowsOf<Row>(
    await db.execute(sql`
      select h.id,
             h.sheet,
             h.sheet_role,
             h.source_row,
             h.tracking_raw,
             h.tracking_key,
             h.product_text,
             h.product_code,
             h.color,
             h.size,
             h.sku,
             h.quantity,
             h.shipment_id,
             h.match_status,
             h.detail,
             coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, '')) as tracking,
             o.system_id as order_system_id,
             o.bill_full_name as customer_name,
             o.bill_phone as customer_phone
        from hmt_return_reconciliation h
        left join shipments s on s.id = h.shipment_id
        left join orders o on o.id = s.order_id
       where h.resolution is null
         and h.match_status not in (${sql.raw(boQua)})
       order by h.sheet_role, h.source_row`),
  );
}

/** Hàng KỲ VỌNG của từng kiện — một lượt cho cả trang. */
async function loadCandidates(shipmentIds: string[]) {
  const out = new Map<string, HmtExceptionRow["candidates"]>();
  if (!shipmentIds.length) return out;
  const db = await getDb();
  const rows = rowsOf<{ shipment_id: string; variant_id: string; sku: string; name: string; color: string; size: string; qty: number }>(
    await db.execute(sql`
      select s.id as shipment_id,
             v.id as variant_id,
             coalesce(nullif(v.sku, ''), nullif(v.custom_id, ''), v.id) as sku,
             p.name as name,
             coalesce(v.color, '') as color,
             coalesce(v.size, '') as size,
             sum(oi.quantity)::int as qty
        from shipments s
        join order_items oi on oi.order_id = s.order_id
        join product_variants v on v.id = oi.variant_id
        join products p on p.id = v.product_id
       where s.id in ${shipmentIds}
       group by s.id, v.id, v.sku, v.custom_id, p.name, v.color, v.size
       order by s.id, sum(oi.quantity) desc`),
  );
  for (const r of rows) {
    const cur = out.get(r.shipment_id) ?? [];
    cur.push({ variantId: r.variant_id, sku: r.sku, name: r.name, color: r.color, size: r.size, qty: Number(r.qty) });
    out.set(r.shipment_id, cur);
  }
  return out;
}

/**
 * ═══════════ "CÓ MÃ, CHƯA CÓ CHI TIẾT HÀNG" ĐỌC LẠI TỪ CHÍNH BẢNG TÍNH ═══════════
 *
 * 144 mã này KHÔNG nằm trong bảng chứng cứ — bảng đó chỉ có dòng MÓN. Chúng là phép trừ giữa sheet
 * tổng và hai sheet chi tiết, nên phải đọc lại tệp.
 *
 * Cố ý KHÔNG lưu chúng thành một bảng thứ hai: con số này là HÀM của tệp đang có, và một bản sao
 * lưu sẵn sẽ nói dối ngay lần đầu ai đó tải bản sổ mới. Đọc lại 45 KB có đệm 120 giây là rẻ hơn
 * một con số sai.
 */
/**
 * ĐỆM THEO BĂM, KHÔNG THEO ĐỒNG HỒ — VÌ BẢN SỔ LÀ BẤT BIẾN.
 *
 * Quy ước chung là đệm báo cáo 60–120 giây (AGENTS.md mục 2), vì số liệu báo cáo cũ đi khi dữ
 * liệu đổi. Phần dưới đây KHÔNG cũ đi được: đầu vào của nó là một bản sổ có khoá tự nhiên là
 * SHA256 CỦA CHÍNH NỘI DUNG. Cùng một băm thì vĩnh viễn cùng một kết quả; tải bản mới lên là một
 * băm khác, tức một khoá đệm khác. Nên hạn ở đây dài, và nó không làm ai đọc phải số cũ.
 *
 * VÌ SAO PHẢI SỬA. Trước đây mỗi lần hết hạn đệm 120 giây, hàm này kéo lại ~80 KB base64 từ CSDL,
 * giải mã, rồi PHÂN TÍCH TOÀN BỘ tệp .xlsx (3 sheet, hơn 750 dòng) — tất cả đều ĐỒNG BỘ, ngay
 * trong lượt dựng trang. Node chạy một luồng, nên việc đó không chỉ làm chậm trang Kiểm đếm hàng
 * hoàn mà CHẶN mọi yêu cầu khác đang chờ trên cùng tiến trình.
 */
const TRACKING_ONLY_TTL_MS = 6 * 60 * 60 * 1000;

async function loadTrackingOnly(): Promise<{ rows: HmtTrackingOnlyRow[]; detailOnly: number; workbook: string }> {
  const meta = await latestHmtWorkbookMeta();
  if (!meta) return { rows: [], detailOnly: 0, workbook: "" };
  return memo(`hmt-tracking-only:${meta.sha256}`, TRACKING_ONLY_TTL_MS, () => parseTrackingOnly());
}

/** Phần đắt: đọc nội dung và phân tích. Chạy MỘT LẦN cho mỗi bản sổ, không phải mỗi lượt mở trang. */
async function parseTrackingOnly(): Promise<{ rows: HmtTrackingOnlyRow[]; detailOnly: number; workbook: string }> {
  const nguon = await latestHmtWorkbook();
  if (!nguon) return { rows: [], detailOnly: 0, workbook: "" };
  const wb = readHmtWorkbook(nguon.buffer, nguon.filename);
  const chiTiet = new Set<string>();
  for (const role of ["FULL_RETURN_ITEMS", "PARTIAL_RETURN_ITEMS"] as const) {
    for (const r of wb.rows.filter((x) => x.role === role)) if (r.trackingKey) chiTiet.add(r.trackingKey);
  }
  const tong = wb.rows.filter((x) => x.role === "TRACKING_INDEX");
  const thay = new Set<string>();
  const rows: HmtTrackingOnlyRow[] = [];
  for (const r of tong) {
    if (!r.trackingKey || chiTiet.has(r.trackingKey) || thay.has(r.trackingKey)) continue;
    thay.add(r.trackingKey);
    rows.push({ trackingRaw: r.trackingRaw, trackingKey: r.trackingKey, sourceRow: r.rowNumber, status: r.statusText });
  }
  const tongKey = new Set(tong.map((r) => r.trackingKey).filter(Boolean));
  const detailOnly = [...chiTiet].filter((k) => !tongKey.has(k)).length;
  return { rows, detailOnly, workbook: nguon.filename };
}

export async function returnExceptionQueues(): Promise<HmtExceptionQueues> {
  return memo("return-exceptions", 120_000, async () => {
    const db = await getDb();
    const [thuong, chiMa, [daGo], [moc]] = await Promise.all([
      loadExceptionRows(),
      loadTrackingOnly(),
      db.select({ n: sql<number>`count(*)` }).from(schema.hmtReturnReconciliation).where(sql`${schema.hmtReturnReconciliation.resolution} is not null`),
      db.select({ at: sql<Date | null>`max(${schema.hmtReturnReconciliation.processedAt})` }).from(schema.hmtReturnReconciliation),
    ]);
    const candidates = await loadCandidates([...new Set(thuong.map((r) => r.shipment_id).filter((x): x is string => Boolean(x)))]);

    const rows: HmtExceptionRow[] = [];
    for (const r of thuong) {
      const status = r.match_status as HmtMatchStatus;
      const queue = queueOfStatus(status);
      // Trạng thái chưa khai hàng đợi ⇒ BỎ QUA, không nhét đại vào một nhóm: một dòng nằm nhầm
      // nhóm sẽ được xử lý bằng thao tác sai.
      if (!queue) continue;
      rows.push({
        id: r.id,
        queue,
        matchStatus: status,
        matchLabel: HMT_MATCH[status].label,
        sheet: r.sheet,
        sourceRow: Number(r.source_row),
        trackingRaw: r.tracking_raw,
        trackingKey: r.tracking_key,
        productText: r.product_text,
        parsedSku: r.sku,
        productCode: r.product_code,
        color: r.color,
        size: r.size,
        quantity: Number(r.quantity),
        shipmentId: r.shipment_id,
        tracking: r.tracking,
        orderSystemId: r.order_system_id === null ? null : Number(r.order_system_id),
        customerName: r.customer_name ?? "",
        customerPhone: r.customer_phone ?? "",
        detail: r.detail,
        candidates: r.shipment_id ? (candidates.get(r.shipment_id) ?? []) : [],
      });
    }

    const counts = Object.fromEntries(HMT_EXCEPTION_QUEUES.map((q) => [q, 0])) as Record<HmtExceptionQueue, number>;
    for (const r of rows) counts[r.queue] += 1;
    counts.TRACKING_ONLY = chiMa.rows.length;

    return {
      workbook: chiMa.workbook,
      lastRunAt: moc?.at ?? null,
      counts,
      resolved: Number(daGo?.n ?? 0),
      rows,
      trackingOnly: chiMa.rows,
      detailOnly: chiMa.detailOnly,
    };
  });
}

/**
 * ═══════════ BỘ ĐẾM CHẤT LƯỢNG DỮ LIỆU — CHƯA BIẾT KHÔNG ĐƯỢC IN THÀNH 0 ═══════════
 *
 * Sáu con số, mỗi con số một loại lỗ hổng có tên. `OVER_QTY` và `DUPLICATE_RECEIPT` luôn phải là 0
 * và được đếm CHÍNH VÌ THẾ: một con số luôn bằng 0 mà không ai đếm là một con số không ai biết khi
 * nó thôi bằng 0.
 */
export type ReturnDataQuality = { key: string; label: string; count: number; queue: HmtExceptionQueue | null; why: string }[];

export async function returnDataQuality(): Promise<ReturnDataQuality> {
  return memo("return-data-quality", 120_000, async () => {
    const db = await getDb();
    const t = schema.hmtReturnReconciliation;
    const theoTrangThai = await db
      .select({ status: t.matchStatus, n: sql<number>`count(*)` })
      .from(t)
      .where(isNull(t.resolution))
      .groupBy(t.matchStatus);
    const dem = new Map(theoTrangThai.map((r) => [r.status as HmtMatchStatus, Number(r.n)]));

    /*
      HAI BẤT BIẾN ĐỌC THẲNG TỪ DỮ LIỆU, KHÔNG TIN VÀO KỶ LUẬT MÃ NGUỒN.

      · `OVER_QTY`          — dòng ĐÃ GHI mà số lượng vượt số món kỳ vọng của kiện.
      · `DUPLICATE_RECEIPT` — kiện có nhiều hơn một phiếu kiểm đếm. Ràng buộc UNIQUE trên
        `return_inspections.shipment_id` khiến nó không xảy ra được; đếm ở đây để ngày ràng buộc ấy
        bị gỡ thì con số kêu lên, chứ không im lặng.
    */
    const [vuot] = rowsOf<{ n: number }>(
      await db.execute(sql`
        select count(*)::int as n
          from hmt_return_reconciliation h
          join shipments s on s.id = h.shipment_id
         where h.written
           and h.quantity > coalesce((select sum(oi.quantity) from order_items oi where oi.order_id = s.order_id), 0)`),
    );
    const [trung] = rowsOf<{ n: number }>(
      await db.execute(sql`select count(*)::int as n from (select shipment_id from return_inspections group by shipment_id having count(*) > 1) x`),
    );
    const chiMa = await loadTrackingOnly();

    return [
      { key: "SKU_MISMATCH", label: "Mẫu mã không nằm trong hàng kỳ vọng", count: (dem.get("SKU_MISMATCH") ?? 0) + (dem.get("AMBIGUOUS_SKU") ?? 0), queue: "SKU_REVIEW" as const, why: "Kiện đúng, mã vận đơn đúng, nhưng mẫu mã sổ ghi không có trong đơn của kiện." },
      { key: "AMBIGUOUS_TRACKING", label: "Mã vận đơn không xác định được", count: dem.get("AMBIGUOUS_TRACKING") ?? 0, queue: "TRACKING_REVIEW" as const, why: "Ô mã trống mà bảng tính không gộp ô, hoặc mã lần ra nhiều kiện." },
      { key: "UNMATCHED_TRACKING", label: "Mã không có trong ERP", count: dem.get("UNMATCHED_TRACKING") ?? 0, queue: "NOT_IN_ERP" as const, why: "Không kiện nào mang mã này — vận đơn chưa đồng bộ, hoặc sổ ghi sai mã." },
      { key: "NO_ITEM_DETAIL", label: "Có mã, chưa có chi tiết hàng", count: chiMa.rows.length, queue: "TRACKING_ONLY" as const, why: "Mã có ở sheet tổng nhưng không có dòng món nào. Mã chứng minh danh tính KIỆN, không chứng minh trong kiện có gì." },
      { key: "OVER_QTY", label: "Số lượng ghi vượt số món kỳ vọng", count: Number(vuot?.n ?? 0), queue: null, why: "Phải luôn bằng 0: máy chỉ ghi dòng có số lượng trong ngưỡng kỳ vọng của kiện." },
      { key: "DUPLICATE_RECEIPT", label: "Kiện có hơn một phiếu kiểm đếm", count: Number(trung?.n ?? 0), queue: null, why: "Phải luôn bằng 0: ràng buộc UNIQUE trên return_inspections.shipment_id chặn. Đếm để ngày ràng buộc bị gỡ thì con số kêu lên." },
    ];
  });
}

/** Một dòng ngoại lệ cụ thể — cho Server Action kiểm tra trước khi ghi. */
export async function hmtExceptionRow(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.hmtReturnReconciliation).where(and(eq(schema.hmtReturnReconciliation.id, id), isNull(schema.hmtReturnReconciliation.resolution))).limit(1);
  return row ?? null;
}

/** Kiện gần đây mang mã gần giống — gợi ý cho người nối tay, KHÔNG tự chọn. */
export async function suggestShipmentsByTracking(fragment: string, limit = 8) {
  const so = fragment.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (so.length < 4) return [];
  const db = await getDb();
  const like = `%${so}%`;
  return db
    .select({
      id: schema.shipments.id,
      tracking: sql<string>`coalesce(nullif(${schema.shipments.vtpOrderNumber}, ''), nullif(${schema.shipments.trackingCode}, ''), ${schema.shipments.id})`,
      stage: sql<string>`${schema.shipments.stage}::text`,
      createdAt: schema.shipments.createdAt,
    })
    .from(schema.shipments)
    .where(sql`upper(regexp_replace(coalesce(${schema.shipments.vtpOrderNumber}, '') || coalesce(${schema.shipments.trackingCode}, ''), '[^0-9A-Za-z]', '', 'g')) like ${like}`)
    .orderBy(desc(schema.shipments.createdAt))
    .limit(limit);
}

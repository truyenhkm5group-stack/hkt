import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { pctOrNull } from "@/lib/format";
import {
  AGE_BUCKETS,
  RECEIVE_TO_INSPECT_SLA_HOURS,
  INSPECT_TO_RESTOCK_SLA_HOURS,
  type AgeBucketKey,
} from "@/lib/constants/return-kpi";
import { CONDITION_LABEL, RETURN_CONDITIONS, type ReturnCondition } from "@/lib/constants/returns-condition";
import { IS_RETURN_AWAITING_WAREHOUSE } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ HIỆU SUẤT KHO HÀNG HOÀN — ĐO TRÊN THỨ CÓ THẬT ═══════════
 *
 * Tất cả con số ở đây đứng trên `return_inspections` (grain: MỘT DÒNG MỘT KIỆN, `shipment_id`
 * UNIQUE) và `stock_receipts` loại `RETURN`. Hai bảng ấy là nơi việc của kho thực sự để lại dấu.
 *
 * ─── BA THỨ CỐ Ý KHÔNG ĐO Ở ĐÂY ───
 *
 * Xem `RETURN_KPI_GAPS`: kết luận theo từng món, danh tính người NHẬN, và trạng thái "đang kiểm".
 * Cả ba đều thiếu nguồn thật trên production, nên màn hình hiện "chưa đo được" kèm lý do thay vì
 * một con số gần đúng (AGENTS.md mục 37 và 45).
 *
 * ─── KHÔNG ĐẾM HAI LẦN ───
 *
 * KIỆN đếm từ `return_inspections` — một dòng một kiện, nên một kiện ba món vẫn là MỘT kiện.
 * MÓN đếm từ `restock_qty` / `unsellable_qty` (cột của chính dòng kiện ấy) và từ
 * `stock_receipt_items.quantity`. Hai đơn vị không bao giờ được cộng vào nhau.
 *
 * Vận đơn chiều về (`order_id` NULL, luật 7) vẫn là một kiện thật và vẫn được đếm — nó là kiện kho
 * cầm trên tay. Nó KHÔNG nhân đôi đơn gốc vì ở đây không có phép nối nào về `orders`.
 */

const ins = schema.returnInspections;

/** Tuổi tính bằng GIỜ của một kiện còn chờ đếm. */
const AGE_HOURS = sql<number>`extract(epoch from (now() - ${ins.receivedAt})) / 3600`;

function bucketCase() {
  // Dựng `case` từ chính `AGE_BUCKETS` — thêm một nhóm ở hằng số là có ngay ở SQL, không phải sửa
  // hai chỗ rồi quên một chỗ.
  const nhanh = AGE_BUCKETS.map((b) =>
    b.toHours === null
      ? sql`when ${AGE_HOURS} >= ${b.fromHours} then ${b.key}`
      : sql`when ${AGE_HOURS} >= ${b.fromHours} and ${AGE_HOURS} < ${b.toHours} then ${b.key}`,
  );
  return sql`case ${sql.join(nhanh, sql` `)} end`;
}

export type AgeBucketRow = {
  key: AgeBucketKey;
  label: string;
  parcels: number;
  /** Kiện cũ nhất trong nhóm, tính bằng giờ. `null` = nhóm rỗng — KHÔNG phải 0 giờ. */
  oldestHours: number | null;
};

export type ConditionRow = {
  condition: ReturnCondition;
  label: string;
  parcels: number;
  /** Tỷ lệ trên tổng kiện ĐÃ ĐẾM. `null` khi chưa đếm kiện nào. */
  share: number | null;
};

export type ReturnWarehouseKpi = {
  /** ĐVVC đã trả về shop, kho CHƯA bấm nhận. Dùng đúng vị ngữ của bàn nhận hàng. */
  awaitingArrival: number;
  /** Kiện đã về kho (có dòng kiểm đếm). */
  receivedParcels: number;
  pendingInspection: number;
  inspectedParcels: number;
  restockableParcels: number;
  nonRestockableParcels: number;
  restockedParcels: number;
  restockedQty: number;
  unsellableQty: number;
  /** Kiện chờ đếm đã quá hạn chặng (A). */
  slaBreach: number;
  aging: AgeBucketRow[];
  conditions: ConditionRow[];
  /** Kiện kết luận bán lại được ÷ kiện đã đếm. `null` = chưa đếm kiện nào. */
  restockableRate: number | null;
  /** Món vào lại tồn ÷ món đếm được. `null` = chưa đếm được món nào. */
  recoveryRate: number | null;
  today: {
    received: number;
    inspected: number;
    restockedParcels: number;
    restockedQty: number;
  };
  slaHours: { receiveToInspect: number; inspectToRestock: number };
};

type KpiRow = {
  received_parcels: number;
  pending: number;
  inspected: number;
  restockable: number;
  restocked: number;
  restock_qty: string | number;
  unsellable_qty: string | number;
  sla_breach: number;
  today_received: number;
  today_inspected: number;
  today_restocked: number;
  today_restock_qty: string | number;
};

const n = (v: unknown) => Number(v ?? 0);

export async function returnWarehouseKpi(): Promise<ReturnWarehouseKpi> {
  return memo("return-warehouse-kpi", 120_000, async () => {
    const db = await getDb();
    const gio = RECEIVE_TO_INSPECT_SLA_HOURS;
    /*
      "HÔM NAY" theo GIỜ VIỆT NAM, không theo UTC.

      `now()` trên máy chủ là UTC; một kiện đếm lúc 8 giờ sáng giờ VN là 01:00 UTC cùng ngày, nhưng
      kiện đếm lúc 6 giờ sáng giờ VN (23:00 UTC HÔM TRƯỚC) vẫn phải nằm trong "hôm nay" của người
      kho. Cắt theo UTC là mỗi sáng lại mất một mẩu ca làm.
    */
    const homNay = sql`date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh')`;
    const vnNgay = (col: unknown) => sql`date_trunc('day', ${col} at time zone 'Asia/Ho_Chi_Minh')`;

    const [[row], [choNhan], nhomTuoi, theoKetLuan] = await Promise.all([
      db
        .select({
          received_parcels: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED')`,
          inspected: sql<number>`count(*) filter (where ${ins.status} = 'INSPECTED')`,
          restockable: sql<number>`count(*) filter (where ${ins.condition} = 'RESTOCKABLE')`,
          restocked: sql<number>`count(*) filter (where ${ins.stockReceiptId} is not null)`,
          restock_qty: sql<number>`coalesce(sum(${ins.restockQty}), 0)`,
          unsellable_qty: sql<number>`coalesce(sum(${ins.unsellableQty}), 0)`,
          sla_breach: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${AGE_HOURS} > ${gio})`,
          today_received: sql<number>`count(*) filter (where ${vnNgay(ins.receivedAt)} = ${homNay})`,
          today_inspected: sql<number>`count(*) filter (where ${ins.inspectedAt} is not null and ${vnNgay(ins.inspectedAt)} = ${homNay})`,
          today_restocked: sql<number>`count(*) filter (where ${ins.stockReceiptId} is not null and ${ins.inspectedAt} is not null and ${vnNgay(ins.inspectedAt)} = ${homNay})`,
          today_restock_qty: sql<number>`coalesce(sum(${ins.restockQty}) filter (where ${ins.inspectedAt} is not null and ${vnNgay(ins.inspectedAt)} = ${homNay}), 0)`,
        })
        .from(ins),
      db.select({ n: sql<number>`count(*)` }).from(schema.shipments).where(IS_RETURN_AWAITING_WAREHOUSE),
      db
        .select({
          bucket: sql<string>`${bucketCase()}`,
          parcels: sql<number>`count(*)`,
          oldest: sql<number>`max(${AGE_HOURS})`,
        })
        .from(ins)
        .where(sql`${ins.status} = 'RECEIVED'`)
        .groupBy(sql`1`),
      db
        .select({ condition: ins.condition, parcels: sql<number>`count(*)` })
        .from(ins)
        .where(sql`${ins.status} = 'INSPECTED' and ${ins.condition} is not null`)
        .groupBy(ins.condition),
    ]);

    const r = row as unknown as KpiRow | undefined;
    const inspected = n(r?.inspected);
    const restockQty = n(r?.restock_qty);
    const unsellableQty = n(r?.unsellable_qty);

    const demTuoi = new Map(nhomTuoi.map((x) => [String(x.bucket), x]));
    const aging: AgeBucketRow[] = AGE_BUCKETS.map((b) => {
      const hit = demTuoi.get(b.key);
      return {
        key: b.key,
        label: b.label,
        parcels: n(hit?.parcels),
        // Nhóm rỗng ⇒ CHƯA BIẾT kiện cũ nhất, không phải "0 giờ".
        oldestHours: hit ? Number(hit.oldest) : null,
      };
    });

    const demKetLuan = new Map(theoKetLuan.map((x) => [String(x.condition), n(x.parcels)]));
    const conditions: ConditionRow[] = RETURN_CONDITIONS.map((c) => ({
      condition: c,
      label: CONDITION_LABEL[c],
      parcels: demKetLuan.get(c) ?? 0,
      share: pctOrNull(demKetLuan.get(c) ?? 0, inspected),
    }));

    return {
      awaitingArrival: n(choNhan?.n),
      receivedParcels: n(r?.received_parcels),
      pendingInspection: n(r?.pending),
      inspectedParcels: inspected,
      restockableParcels: n(r?.restockable),
      nonRestockableParcels: Math.max(0, inspected - n(r?.restockable)),
      restockedParcels: n(r?.restocked),
      restockedQty: restockQty,
      unsellableQty,
      slaBreach: n(r?.sla_breach),
      aging,
      conditions,
      // Mẫu số là kiện ĐÃ ĐẾM — kiện chưa đếm thì chưa ai biết nó thuộc về đâu.
      restockableRate: pctOrNull(n(r?.restockable), inspected),
      // Mẫu số là MÓN ĐẾM ĐƯỢC, không phải vận đơn mang trạng thái RETURNED.
      recoveryRate: pctOrNull(restockQty, restockQty + unsellableQty),
      today: {
        received: n(r?.today_received),
        inspected: n(r?.today_inspected),
        restockedParcels: n(r?.today_restocked),
        restockedQty: n(r?.today_restock_qty),
      },
      slaHours: { receiveToInspect: RECEIVE_TO_INSPECT_SLA_HOURS, inspectToRestock: INSPECT_TO_RESTOCK_SLA_HOURS },
    };
  });
}

/* ═══════════════════ NĂNG SUẤT THEO NGÀY ═══════════════════ */

export type ThroughputDay = {
  /** `YYYY-MM-DD` theo giờ Việt Nam. */
  day: string;
  receivedParcels: number;
  inspectedParcels: number;
  restockedQty: number;
};

type TpRow = { day: string; received: number; inspected: number; restock_qty: string | number };

/**
 * NHẬN và ĐẾM là hai lượt khác nhau của cùng một kiện, nên chúng được đếm trên HAI MỐC khác nhau
 * của cùng một dòng — không phải hai bảng, và không cộng vào nhau.
 *
 * Ngày cắt theo giờ Việt Nam: ca làm của kho kết thúc theo giờ VN, không theo UTC.
 */
export async function returnThroughput(days = 30): Promise<ThroughputDay[]> {
  const gioiHan = Math.min(180, Math.max(1, Math.trunc(days)));
  // Số ngày ĐỔI kết quả ⇒ phải nằm trong khoá đệm (AGENTS.md mục 2).
  return memo(`return-throughput:${gioiHan}`, 120_000, async () => {
    const db = await getDb();
    const rows = rowsOf<TpRow>(
      await db.execute(sql`
        with ngay as (
          select generate_series(
            (date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') - ((${gioiHan} - 1) || ' days')::interval)::date,
            (date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh'))::date,
            '1 day'::interval
          )::date as d
        ),
        nhan as (
          select date_trunc('day', received_at at time zone 'Asia/Ho_Chi_Minh')::date as d, count(*)::int as n
          from return_inspections group by 1
        ),
        dem as (
          select date_trunc('day', inspected_at at time zone 'Asia/Ho_Chi_Minh')::date as d,
                 count(*)::int as n,
                 coalesce(sum(restock_qty), 0)::int as q
          from return_inspections where inspected_at is not null group by 1
        )
        select to_char(ngay.d, 'YYYY-MM-DD') as day,
               coalesce(nhan.n, 0)::int as received,
               coalesce(dem.n, 0)::int as inspected,
               coalesce(dem.q, 0)::int as restock_qty
        from ngay
        left join nhan on nhan.d = ngay.d
        left join dem on dem.d = ngay.d
        order by ngay.d
      `),
    );
    return rows.map((x) => ({
      day: String(x.day),
      receivedParcels: n(x.received),
      inspectedParcels: n(x.inspected),
      restockedQty: n(x.restock_qty),
    }));
  });
}

/* ═══════════════════ THEO NGƯỜI ĐẾM ═══════════════════ */

export type InspectorRow = {
  userId: string;
  name: string;
  inspectedParcels: number;
  restockQty: number;
  unsellableQty: number;
  /** Kiểm xong trong hạn ÷ kiện đã kiểm. `null` khi chưa kiểm kiện nào. */
  onTimeRate: number | null;
  /** Giờ trung vị từ lúc nhận tới lúc đếm xong. `null` = chưa đo được. */
  medianHours: number | null;
  /** Kiện có lệch (hàng không bán lại được). KẾT QUẢ CHUNG — không phải điểm chấm người. */
  withIssue: number;
};

type InsRow = {
  who: string;
  name: string | null;
  inspected: number;
  on_time: number;
  with_issue: number;
  restock_qty: string | number;
  unsellable_qty: string | number;
  median_hours: string | number | null;
};

/**
 * ═══ ĐO ĐÚNG VIỆC HỌ LÀM, KHÔNG ĐO THỨ HỌ KHÔNG QUYẾT ĐƯỢC ═══
 *
 * `onTimeRate` dùng ĐÚNG vị ngữ của thẻ điểm phòng ban (`lib/queries/dept-performance.ts`):
 * `inspected_at <= received_at + <hạn>`, cùng một hằng số giờ. Hai màn hình nói về cùng một việc
 * thì không được ra hai con số.
 *
 * `withIssue` đếm kiện về không nguyên vẹn. Nó KHÔNG phải lỗi người đếm — hàng hỏng trên đường về
 * do ĐVVC và do khách đóng gói. Cột này mang nhãn "kết quả chung" ở màn hình (AGENTS.md mục 27):
 * đọc làm bối cảnh để biết ai đang gặp lô xấu, không dùng để xếp hạng người.
 *
 * Người chưa nối được về tài khoản KHÔNG vào bảng này (AGENTS.md mục 35: không đoán người cho dòng
 * lịch sử). Phần đó hiện riêng thành "chưa quy kết được".
 */
export async function returnByInspector(days = 30): Promise<{ rows: InspectorRow[]; unattributed: number }> {
  const gioiHan = Math.min(180, Math.max(1, Math.trunc(days)));
  return memo(`return-inspector:${gioiHan}`, 120_000, async () => {
    const db = await getDb();
    const gio = RECEIVE_TO_INSPECT_SLA_HOURS;
    const tu = sql`now() - (${gioiHan} || ' days')::interval`;
    const [rows, [chua]] = await Promise.all([
      db.execute(sql`
        select i.inspected_by_user_id as who,
               u.name as name,
               count(*)::int as inspected,
               count(*) filter (where i.inspected_at <= i.received_at + (${gio} || ' hours')::interval)::int as on_time,
               count(*) filter (where i.unsellable_qty > 0 or coalesce(i.condition, 'OK') <> 'OK')::int as with_issue,
               coalesce(sum(i.restock_qty), 0)::int as restock_qty,
               coalesce(sum(i.unsellable_qty), 0)::int as unsellable_qty,
               percentile_cont(0.5) within group (
                 order by extract(epoch from (i.inspected_at - i.received_at)) / 3600
               ) as median_hours
        from return_inspections i
        left join users u on u.id = i.inspected_by_user_id
        where i.status = 'INSPECTED' and i.inspected_at >= ${tu} and i.inspected_by_user_id is not null
        group by i.inspected_by_user_id, u.name
        order by inspected desc
      `),
      db
        .select({ n: sql<number>`count(*)` })
        .from(ins)
        .where(sql`${ins.status} = 'INSPECTED' and ${ins.inspectedAt} >= ${tu} and ${ins.inspectedByUserId} is null`),
    ]);
    return {
      rows: rowsOf<InsRow>(rows).map((x) => ({
        userId: String(x.who),
        // Tên do MÁY CHỦ đọc từ `users` (AGENTS.md mục 34) — không nhận từ nơi gọi.
        name: x.name?.trim() || "(không tên)",
        inspectedParcels: n(x.inspected),
        restockQty: n(x.restock_qty),
        unsellableQty: n(x.unsellable_qty),
        onTimeRate: pctOrNull(n(x.on_time), n(x.inspected)),
        medianHours: x.median_hours === null || x.median_hours === undefined ? null : Number(x.median_hours),
        withIssue: n(x.with_issue),
      })),
      unattributed: n(chua?.n),
    };
  });
}

/* ═══════════════════ THEO MẪU MÃ ═══════════════════ */

export type SkuRecoveryRow = {
  variantId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  /** Món ĐÃ vào lại tồn qua phiếu tái nhập — số thật, đo từ phiếu kho. */
  restockedQty: number;
  /** Số KIỆN mang mẫu mã này đã tái nhập. Khác hẳn số món. */
  parcels: number;
};

type SkuRow = { variant_id: string; sku: string | null; name: string | null; color: string | null; size: string | null; qty: string | number; parcels: number };

/**
 * ═══ MẪU MÃ NÀO THỰC SỰ QUAY LẠI TỒN ═══
 *
 * Đọc từ `stock_receipt_items` của phiếu `RETURN` — tức là từ CHỨNG TỪ KHO, thứ duy nhất thay đổi
 * tồn thật, chứ không phải từ hàng kỳ vọng của đơn.
 *
 * ─── VÌ SAO KHÔNG CÓ CỘT "HỎNG / THIẾU / SAI HÀNG" THEO MẪU MÃ ───
 *
 * Muốn tách phần hỏng theo mẫu mã thì phải biết MÓN NÀO hỏng, mà kết luận hiện chỉ có ở mức CẢ
 * KIỆN (`return_inspections.condition`). Một kiện ba mẫu mã kết luận "hỏng" không nói được mẫu nào
 * hỏng. Chia đều cho ba mẫu là bịa ra một con số trông như đo được — xem `RETURN_KPI_GAPS`.
 *
 * `parcels` đếm DISTINCT vận đơn, không phải số dòng phiếu: một kiện hai dòng cùng mẫu mã vẫn là
 * MỘT kiện (§11).
 */
export async function returnBySku(days = 90, limit = 30): Promise<SkuRecoveryRow[]> {
  const gioiHan = Math.min(365, Math.max(1, Math.trunc(days)));
  const soDong = Math.min(200, Math.max(1, Math.trunc(limit)));
  return memo(`return-by-sku:${gioiHan}:${soDong}`, 120_000, async () => {
    const db = await getDb();
    const rows = rowsOf<SkuRow>(
      await db.execute(sql`
        select ri.variant_id,
               v.sku as sku,
               p.name as name,
               v.color as color,
               v.size as size,
               coalesce(sum(ri.quantity), 0)::int as qty,
               count(distinct ri.shipment_id)::int as parcels
        from stock_receipt_items ri
        join stock_receipts r on r.id = ri.receipt_id
        left join product_variants v on v.id = ri.variant_id
        left join products p on p.id = v.product_id
        where r.kind = 'RETURN' and r.received_at >= now() - (${gioiHan} || ' days')::interval
        group by ri.variant_id, v.sku, p.name, v.color, v.size
        order by qty desc
        limit ${soDong}
      `),
    );
    return rows.map((x) => ({
      variantId: String(x.variant_id),
      sku: x.sku?.trim() || "—",
      productName: x.name?.trim() || "—",
      color: x.color?.trim() ?? "",
      size: x.size?.trim() ?? "",
      restockedQty: n(x.qty),
      parcels: n(x.parcels),
    }));
  });
}

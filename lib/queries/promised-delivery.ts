import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { OrderStage } from "@/db/schema";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
import { toDate } from "@/lib/format";
import { DEAD_ORDER_STAGES, PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import { promisedVerdict, type PromisedState, type PromisedVerdict } from "@/lib/constants/promised-delivery";

/**
 * ═══════════ ĐƠN CÓ HẸN NGÀY GIAO ═══════════
 *
 * Luật ở `lib/constants/promised-delivery.ts`. Tệp này chỉ đọc và xếp.
 *
 * ─── LẤY CẢ ĐƠN CÒN TRONG HẸN, KHÔNG CHỈ ĐƠN TỚI HẠN ───
 *
 * Cám dỗ là chỉ trả về đơn `DUE` / `BREACHED` — tức đúng phần "việc phải làm hôm nay". Nhưng khi đó
 * không màn hình nào trả lời được câu **"shop đang hứa những gì?"**, và một lời hứa mà không ai
 * nhìn thấy cho tới hôm đến hạn là một lời hứa sắp lỡ.
 *
 * Nên truy vấn trả về MỌI đơn có hẹn còn chưa gửi, kèm trạng thái của từng cái. Màn hình lọc lấy
 * phần nó cần; phép đếm theo trạng thái nằm trong `summary` để không ai phải cộng lại.
 */

/** Trần an toàn. Đơn có hẹn là thiểu số tuyệt đối nên con số này rất rộng so với thực tế. */
const MAX_PROMISED_SCAN = 2_000;

export type PromisedRow = {
  orderId: string;
  systemId: number | null;
  orderLabel: string;
  stage: OrderStage;
  customer: string;
  phone: string;
  total: number | null;
  /** Lý do khách xin hẹn, do người trực ghi lại. Ô chữ cho người đọc. */
  note: string;
  /** Ai ghi lời hẹn — TÊN do máy chủ đọc từ `users`, không nhận từ client. */
  recordedBy: string | null;
  recordedAt: Date | null;
  hasShipment: boolean;
  verdict: PromisedVerdict;
};

export type PromisedQueue = {
  rows: PromisedRow[];
  /** Đếm theo trạng thái. `FUTURE` là con số TỐT — shop đang giữ đúng hẹn. */
  byState: Record<PromisedState, number>;
  /** Số đơn phải làm hôm nay: tới hạn + đã lỡ. Con số duy nhất được gọi là việc. */
  actionable: number;
  breached: number;
  capped: boolean;
  measuredAt: Date;
};

type Raw = {
  id: string;
  system_id: number | null;
  bill_full_name: string;
  bill_phone: string;
  total: string | number | null;
  stage: OrderStage;
  promised_at: string | Date | null;
  note: string;
  recorded_by: string | null;
  recorded_at: string | Date | null;
  has_shipment: boolean;
};

export async function getPromisedDeliveryQueue(): Promise<PromisedQueue> {
  return memo("promised-delivery", 60_000, async () => {
    const db = await getDb();
    const now = new Date();
    const preship = PRE_SHIP_STAGES.map((s) => `'${s}'`).join(",");
    const dead = DEAD_ORDER_STAGES.map((s) => `'${s}'`).join(",");

    /*
      TÊN NGƯỜI GHI ĐỌC TỪ BẢNG `users` QUA KHOÁ, không lấy từ một ô chữ nào (AGENTS.md mục 34).
      Dòng cũ không có khoá thì trả `NULL` — CHƯA BIẾT, không phải một cái tên bịa ra.

      Chỉ mục riêng phần `orders_promised_idx` phục vụ đúng vị ngữ `is not null` ở đây.
    */
    const raw = rowsOf<Raw>(
      await db.execute(sql`
        select o.id,
               o.system_id,
               o.bill_full_name,
               o.bill_phone,
               o.total_price_after_discount as total,
               o.stage::text as stage,
               o.customer_promised_at as promised_at,
               o.customer_promised_note as note,
               u.name as recorded_by,
               o.customer_promised_set_at as recorded_at,
               exists (
                 select 1 from shipments s
                  where s.order_id = o.id
                    and coalesce(s.direction, 'OUTBOUND') <> 'RETURN'
                    and s.stage::text not in ('PENDING','CANCELLED')
               ) as has_shipment
          from orders o
          left join users u on u.id = o.customer_promised_by_user_id
         where o.customer_promised_at is not null
           and o.stage::text in (${sql.raw(preship)})
           and o.stage::text not in (${sql.raw(dead)})
         order by o.customer_promised_at asc
         limit ${MAX_PROMISED_SCAN + 1}
      `),
    );

    const capped = raw.length > MAX_PROMISED_SCAN;
    const list = capped ? raw.slice(0, MAX_PROMISED_SCAN) : raw;

    const byState: Record<PromisedState, number> = { NONE: 0, FUTURE: 0, DUE_SOON: 0, DUE: 0, BREACHED: 0 };
    const rows: PromisedRow[] = list.map((r) => {
      const verdict = promisedVerdict(toDate(r.promised_at), now, Boolean(r.has_shipment));
      byState[verdict.state] += 1;
      return {
        orderId: r.id,
        systemId: r.system_id,
        orderLabel: r.system_id ? `#${r.system_id}` : r.id,
        stage: r.stage,
        customer: r.bill_full_name ?? "",
        phone: r.bill_phone ?? "",
        total: r.total === null || r.total === undefined ? null : Number(r.total),
        note: r.note ?? "",
        recordedBy: r.recorded_by,
        recordedAt: toDate(r.recorded_at),
        hasShipment: Boolean(r.has_shipment),
        verdict,
      };
    });

    // Lỡ hẹn trước, rồi tới hạn, rồi sắp tới — trong cùng nhóm thì hẹn sớm nhất đứng trên.
    const rank: Record<PromisedState, number> = { BREACHED: 0, DUE: 1, DUE_SOON: 2, FUTURE: 3, NONE: 4 };
    rows.sort((a, b) => {
      const d = rank[a.verdict.state] - rank[b.verdict.state];
      if (d !== 0) return d;
      return (a.verdict.promisedAt?.getTime() ?? 0) - (b.verdict.promisedAt?.getTime() ?? 0);
    });

    return {
      rows,
      byState,
      actionable: byState.DUE + byState.BREACHED,
      breached: byState.BREACHED,
      capped,
      measuredAt: now,
    };
  });
}

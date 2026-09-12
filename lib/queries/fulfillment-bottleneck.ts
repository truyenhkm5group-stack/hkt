import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ageLabel, TEAM_LABEL, type CaseTeam } from "@/lib/constants/action-queue";
import { CARRIER_EVENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";
import {
  BOTTLENECK_NEXT_ACTION,
  BOTTLENECK_REASON_LABEL,
  BOTTLENECK_SLA_HOURS,
  BOTTLENECK_TEAM,
  type FulfillmentBlockReason,
} from "@/lib/constants/fulfillment-bottleneck";
import { formatVND } from "@/lib/format";
import { rowsOf } from "@/lib/sql-rows";
import type { OrderStage, ShipmentStage } from "@/db/schema";

/**
 * ═══════════ NÚT THẮT FULFILLMENT NỘI BỘ ═══════════
 *
 * Xem `lib/constants/fulfillment-bottleneck.ts` cho đặc tả bốn lý do. Tệp này CHỈ đọc trực tiếp từ
 * `orders` / `shipments` / `shipment_events` (KHÔNG qua bảng `notifications`), vì mục tiêu là một
 * lát cắt LUÔN ĐÚNG NGAY BÂY GIỜ của đúng một đoạn hẹp trong dòng chảy — không phụ thuộc việc job
 * cảnh báo (`lib/alerts/rules.ts`) đã chạy lần gần nhất khi nào hay đã tạo/đóng việc hay chưa.
 *
 * KHÔNG ĐỤNG: logic chat Sales Funnel, lõi tích hợp Viettel Post (`lib/integrations/viettelpost/*`),
 * Care Engine (`lib/cs/*`). Tệp này chỉ SELECT từ các bảng đã có, không ghi, không gọi API nào.
 *
 * "Rời kho" dùng ĐÚNG định nghĩa `SHIPMENT_LEFT_WAREHOUSE` của `lib/queries/return-rate.ts`
 * (`picked_up_at is not null or stage in (PICKED_UP, IN_TRANSIT, ...)`) — vận đơn `PENDING` KHÔNG
 * được coi là đã rời kho dù đã có mã vận đơn / mã tra cứu. Đơn tới đây coi là XONG việc của nút thắt
 * này (không phải một "case" nữa) ngay khi vận đơn của nó thoát khỏi `PENDING`.
 */

const CARRIER_SOURCES_SQL = sqlSourceList(CARRIER_EVENT_SOURCES);

/**
 * ĐƠN ĐANG CÓ VẬN ĐƠN "SỐNG" (không phải chiều hoàn, không phải lần gửi đã huỷ). Một đơn có thể có
 * nhiều lần gửi (xem `PRIMARY_ATTEMPT` ở return-rate.ts) nhưng ở đây câu hỏi khác: "đơn này còn cần
 * kho làm gì nữa không", nên lấy LẦN GỬI MỚI NHẤT còn sống — lần gửi bị huỷ không tính, vì đơn vẫn
 * cần một vận đơn mới (rơi về NOT_YET_SHIPPED) chứ không phải "đã có vận đơn, đang chờ ĐVVC".
 */
const ACTIVE_SHIPMENT_CTE = sql`
  active_shipment as (
    select distinct on (s.order_id)
      s.id, s.order_id, s.stage, s.vtp_order_number, s.tracking_code, s.picked_up_at,
      s.created_at, s.cod_amount
    from shipments s
    where s.order_id is not null
      and coalesce(s.direction, 'OUTBOUND') <> 'RETURN'
      and s.stage <> 'CANCELLED'
    order by s.order_id, s.created_at desc
  )
`;

type Row = {
  order_id: string;
  system_id: number | null;
  bill_full_name: string;
  bill_phone: string;
  ship_address: string;
  ship_province: string;
  total_price_after_discount: string | number | null;
  order_stage: OrderStage;
  inserted_at: string | Date;
  last_update_status_at: string | Date | null;
  page_id: string | null;
  conversation_id: string | null;
  shipment_id: string | null;
  shipment_stage: ShipmentStage | null;
  vtp_order_number: string | null;
  tracking_code: string | null;
  shipment_created_at: string | Date | null;
  cod_amount: string | number | null;
  carrier_acked: boolean;
};

export type FulfillmentBottleneckCase = {
  orderId: string;
  systemId: number | null;
  orderLabel: string;
  orderStage: OrderStage;
  shipmentId: string | null;
  shipmentStage: ShipmentStage | null;
  vtpOrderNumber: string | null;
  trackingCode: string | null;
  reason: FulfillmentBlockReason;
  reasonLabel: string;
  /** Chi tiết CỤ THỂ của dòng này — trường nào thiếu, mấy giờ rồi — không phải câu chung chung của cả loại. */
  reasonDetail: string;
  nextAction: string;
  team: CaseTeam;
  teamLabel: string;
  /** Mốc đơn/vận đơn bắt đầu đứng ở trạng thái này. */
  detectedAt: Date;
  ageHours: number;
  ageLabel: string;
  sla: { hours: number; dueAt: Date; hoursRemaining: number; breached: boolean };
  /** Tiền/COD đang treo nếu nút thắt này không được gỡ — KHAI BÁO, chưa phải tiền đã xác minh (xem ORDER_OUTCOME.md mục 8). */
  moneyAtRisk: number;
  href: string;
  chatHref: string | null;
};

export type FulfillmentBottleneckQueue = {
  cases: FulfillmentBottleneckCase[];
  byReason: { reason: FulfillmentBlockReason; label: string; count: number; moneyAtRisk: number; breached: number }[];
  total: number;
  moneyAtRisk: number;
  breached: number;
  measuredAt: Date;
  /** `false` = đọc trực tiếp không dùng được (lỗi CSDL) — để trang gọi biết mà báo thay vì hiện danh sách rỗng như thể mọi thứ đều thông. */
  ok: boolean;
};

/** Trường nào thiếu / sai khiến ERP KHÔNG THỂ tạo vận đơn — cùng tín hiệu với ORDER_INCOMPLETE / ORDER_ADDRESS_NOT_NORMALIZED (lib/alerts/rules.ts), tính lại trực tiếp thay vì đọc qua notifications. */
function dataBlockReason(r: Row): string | null {
  const missing: string[] = [];
  if (!r.bill_phone) missing.push("số điện thoại");
  if (!r.ship_address) missing.push("địa chỉ");
  if (missing.length) return `Thiếu ${missing.join(" và ")} — chưa đủ để tạo vận đơn.`;
  // Khách đã cho địa chỉ nhưng Pancake không ghép được vào tỉnh/xã: POS từ chối đẩy sang ĐVVC.
  if (r.ship_address && !r.ship_province) return `Địa chỉ "${r.ship_address}" chưa được chuẩn hoá về tỉnh/xã — Pancake sẽ từ chối đẩy sang Viettel Post.`;
  return null;
}

function orderLabelOf(r: Row): string {
  return `#${r.system_id ?? "?"} · ${r.bill_full_name || "Khách"}${r.bill_phone ? ` · ${r.bill_phone}` : ""}`;
}

/**
 * MỐC "ĐỨNG Ở TRẠNG THÁI NÀY TỪ KHI NÀO" — cố ý KHÔNG dùng `inserted_at` (lúc đơn được TẠO).
 *
 * `lib/alerts/rules.ts::ORDER_CONFIRMED_STALE` dùng `insertedAt` để tính tuổi, và hệ quả đã đo được
 * (`lib/queries/stage-health.ts`, chú thích "HẠN XỬ LÝ TÍNH TỪ LÚC ERP GIAO VIỆC"): một đơn nằm bên
 * CSKH 9 ngày rồi vừa được xác nhận 10 phút trước sẽ hiện tuổi "9 ngày" — TRỄ HẠN ngay khi vừa sinh
 * ra, và mọi đơn xác nhận-chưa-gửi đều trông như đã trễ như nhau. Đúng loại cảnh báo giả mà việc
 * này bị cấm tạo ra.
 *
 * `orders.last_update_status_at` là mốc Pancake tự ghi lúc TRẠNG THÁI (mã `status` thô) đổi gần
 * nhất — với một đơn đang ở CONFIRMED/PACKING/READY_TO_SHIP, đó chính là lúc nó bước vào trạng thái
 * hiện tại, không phải lúc nó được tạo. Chỉ khi trường này trống (đơn cũ, đồng bộ trước khi Pancake
 * gửi trường đó) mới lùi về `inserted_at`.
 */
function sinceStage(r: Row): Date {
  return new Date(r.last_update_status_at ?? r.inserted_at);
}

function classify(r: Row): { reason: FulfillmentBlockReason; detail: string; detectedAt: Date } {
  if (!r.shipment_id) {
    const blocked = dataBlockReason(r);
    if (blocked) return { reason: "DATA_BLOCKED", detail: blocked, detectedAt: sinceStage(r) };
    return { reason: "NOT_YET_SHIPPED", detail: "Đơn đã chốt, dữ liệu đủ, nhưng chưa có vận đơn nào.", detectedAt: sinceStage(r) };
  }
  const since = new Date(r.shipment_created_at as string | Date);
  if (!r.carrier_acked) {
    return { reason: "AWAITING_CARRIER_ACCEPT", detail: `Đã tạo vận đơn ${r.vtp_order_number ?? r.tracking_code ?? r.shipment_id} nhưng chưa thấy sự kiện nào từ Viettel Post xác nhận đã nhận đơn.`, detectedAt: since };
  }
  return { reason: "AWAITING_PICKUP", detail: `Viettel Post đã xác nhận nhận đơn ${r.vtp_order_number ?? r.tracking_code} nhưng bưu tá chưa quét lấy hàng.`, detectedAt: since };
}

/**
 * HÀNG ĐỢI. Không đọc từ `notifications` — xem lý do ở đầu tệp. Vì vậy KHÔNG có khái niệm "ai đã
 * nhận việc" ở đây (bảng phân công việc là của hệ thống cảnh báo chung, việc gán người nằm ngoài
 * phạm vi được giao cho nút thắt fulfillment này) — `team` chỉ nói BỘ PHẬN chịu trách nhiệm.
 */
export async function getFulfillmentBottleneckQueue(): Promise<FulfillmentBottleneckQueue> {
  const db = await getDb();
  let rows: Row[];
  try {
    rows = rowsOf<Row>(
      await db.execute(sql`
        with ${ACTIVE_SHIPMENT_CTE}
        select
          o.id as order_id, o.system_id, o.bill_full_name, o.bill_phone, o.ship_address, o.ship_province,
          o.total_price_after_discount, o.stage as order_stage, o.inserted_at, o.last_update_status_at, o.page_id, o.conversation_id,
          a.id as shipment_id, a.stage as shipment_stage, a.vtp_order_number, a.tracking_code,
          a.created_at as shipment_created_at, a.cod_amount,
          -- Truy vấn con TƯƠNG QUAN theo TỪNG vận đơn đang xét (phạm vi ngoài đã lọc rất hẹp), thay
          -- vì DISTINCT một lần trên toàn bộ shipment_events — bảng đó lớn hơn nhiều so với số vận
          -- đơn còn PENDING cần kiểm tra ở đây.
          exists (select 1 from shipment_events e where e.shipment_id = a.id and e.source in (${sql.raw(CARRIER_SOURCES_SQL)})) as carrier_acked
        from orders o
        left join active_shipment a on a.order_id = o.id
        -- Phạm vi: order confirmed → ready to fulfill. NEW/WAITING (chưa xác nhận) là việc của
        -- Sales Funnel/CSKH, không thuộc nút thắt này. CANCELLED/DELETED bị loại tuyệt đối — không
        -- được tạo cảnh báo giả cho đơn đã huỷ hoặc chưa sẵn sàng.
        where o.stage in ('CONFIRMED','PACKING','READY_TO_SHIP')
          -- ĐƠN RỖNG KHÔNG PHẢI VIỆC KHO: đối chiếu production 12/09/2026 thấy 9/214 ca là đơn
          -- CONFIRMED không có dòng hàng nào và giá trị 0 (lên nhầm / chưa chọn hàng) — không có gì
          -- để đóng gói hay tạo vận đơn, đưa vào hàng đợi chỉ tạo việc giả. Đơn có dòng hàng nhưng
          -- giá 0 (tặng, đổi hàng) VẪN là việc kho.
          and (coalesce(o.total_price_after_discount, 0) > 0 or exists (select 1 from order_items oi where oi.order_id = o.id))
          -- "Chưa rời kho": không có vận đơn nào, HOẶC vận đơn còn PENDING. Vận đơn đã qua PENDING
          -- (PICKED_UP trở lên) nghĩa là đã rời kho — không phải việc của nút thắt này nữa, dù
          -- order.stage trên Pancake có kịp cập nhật hay chưa (đồng bộ có độ trễ vài phút).
          and (a.id is null or a.stage = 'PENDING')
        order by o.inserted_at asc
      `),
    );
  } catch {
    // Đọc thẳng từ CSDL, không qua cache/notifications — lỗi câu SQL (vd. thiếu bảng ở môi trường
    // chưa migrate xong) phải báo THẲNG là chưa đo được, không được hiện "0 việc" như thể đã thông.
    return { cases: [], byReason: [], total: 0, moneyAtRisk: 0, breached: 0, measuredAt: new Date(), ok: false };
  }

  const now = Date.now();
  const cases: FulfillmentBottleneckCase[] = rows.map((r) => {
    const { reason, detail, detectedAt } = classify(r);
    const hours = BOTTLENECK_SLA_HOURS[reason];
    const dueAt = new Date(detectedAt.getTime() + hours * 3_600_000);
    const hoursRemaining = (dueAt.getTime() - now) / 3_600_000;
    const ageHours = Math.max(0, (now - detectedAt.getTime()) / 3_600_000);
    const codAmount = Number(r.cod_amount ?? 0);
    const orderValue = Number(r.total_price_after_discount ?? 0);
    // "Money/COD at risk" = số tiền khai báo đang treo NẾU nút thắt này không được gỡ hôm nay —
    // KHÔNG phải tiền đã xác minh (đặc tả ORDER_OUTCOME.md mục 8: COD khai báo không phải bằng
    // chứng thu tiền). Vận đơn có COD khai báo thì lấy đúng số đó (đây là đơn thu hộ); ngược lại
    // lấy giá trị đơn (đơn trả trước / chưa rõ COD).
    const moneyAtRisk = codAmount > 0 ? codAmount : orderValue;
    return {
      orderId: r.order_id,
      systemId: r.system_id,
      orderLabel: orderLabelOf(r),
      orderStage: r.order_stage,
      shipmentId: r.shipment_id,
      shipmentStage: r.shipment_stage,
      vtpOrderNumber: r.vtp_order_number,
      trackingCode: r.tracking_code,
      reason,
      reasonLabel: BOTTLENECK_REASON_LABEL[reason],
      reasonDetail: detail,
      nextAction: BOTTLENECK_NEXT_ACTION[reason],
      team: BOTTLENECK_TEAM[reason],
      teamLabel: TEAM_LABEL[BOTTLENECK_TEAM[reason]],
      detectedAt,
      ageHours,
      ageLabel: ageLabel(ageHours),
      sla: { hours, dueAt, hoursRemaining, breached: hoursRemaining < 0 },
      moneyAtRisk,
      href: r.shipment_id ? `/shipments/${r.shipment_id}` : `/orders/${r.order_id}`,
      chatHref: r.page_id && r.conversation_id ? `https://pancake.vn/${r.page_id}?c_id=${r.conversation_id}` : null,
    };
  });

  // HÀNG ĐỢI ACTION-FIRST: trễ hạn trước, rồi tiền nhiều trước, rồi để lâu nhất trước. Cố ý KHÔNG
  // dùng lại `caseScore` của lib/constants/action-queue.ts — bốn lý do ở đây không map 1-1 vào một
  // CaseType có sẵn nào, và ép một map sai sẽ cho một điểm số trông có vẻ có căn cứ mà không phải.
  cases.sort((a, b) => Number(b.sla.breached) - Number(a.sla.breached) || b.moneyAtRisk - a.moneyAtRisk || b.ageHours - a.ageHours);

  const byReasonMap = new Map<FulfillmentBlockReason, { count: number; moneyAtRisk: number; breached: number }>();
  for (const c of cases) {
    const cur = byReasonMap.get(c.reason) ?? { count: 0, moneyAtRisk: 0, breached: 0 };
    cur.count += 1;
    cur.moneyAtRisk += c.moneyAtRisk;
    if (c.sla.breached) cur.breached += 1;
    byReasonMap.set(c.reason, cur);
  }
  const byReason = [...byReasonMap.entries()]
    .map(([reason, v]) => ({ reason, label: BOTTLENECK_REASON_LABEL[reason], ...v }))
    .sort((a, b) => b.moneyAtRisk - a.moneyAtRisk);

  return {
    cases,
    byReason,
    total: cases.length,
    moneyAtRisk: cases.reduce((t, c) => t + c.moneyAtRisk, 0),
    breached: cases.filter((c) => c.sla.breached).length,
    measuredAt: new Date(),
    ok: true,
  };
}

/** Dòng tóm tắt dùng cho log / báo cáo backtest — không định dạng tiền tệ (đó là việc của giao diện). */
export function summarizeFulfillmentBottleneck(q: FulfillmentBottleneckQueue): string {
  if (!q.ok) return "Không đọc được (lỗi câu truy vấn hoặc CSDL chưa có đủ bảng).";
  return `${q.total} đơn đang kẹt · ${formatVND(q.moneyAtRisk)} đang treo · ${q.breached} trễ hạn — ` + q.byReason.map((r) => `${r.label}: ${r.count}`).join(" · ");
}

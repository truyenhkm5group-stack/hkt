import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { OrderStage } from "@/db/schema";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
import { toDate } from "@/lib/format";
import { DEAD_ORDER_STAGES, PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import { ageLabel, TEAM_LABEL, type CaseTeam } from "@/lib/constants/action-queue";
import {
  validateForShipping,
  VALIDATION_GROUP_LABEL,
  type ValidationFinding,
  type ValidationGroup,
  type ValidationItem,
} from "@/lib/constants/preship-validation";

/**
 * ═══════════ BẢN SOÁT ĐƠN TRƯỚC KHI GỬI ═══════════
 *
 * Đặc tả và toàn bộ luật ở `lib/constants/preship-validation.ts` — kể cả lời giải thích vì sao ERP
 * KHÔNG chặn được trạng thái đơn và chọn làm bản soát thay vì một cái cổng giả.
 *
 * Tệp này chỉ lấy dữ liệu rồi gọi `validateForShipping()`. Không điều kiện nghiệp vụ nào ở đây.
 *
 * ─── AI SỬA CÁI GÌ ───
 *
 * Mỗi lỗi mang sẵn nhóm (`CUSTOMER` · `PRODUCT` · `MONEY`), và nhóm quyết định phòng phải sửa. Một
 * bản soát trộn "thiếu SĐT" với "chưa ghép mẫu mã" thành một đống thì cả CSKH lẫn kho đều mở ra,
 * thấy phần lớn không phải việc của mình, rồi thôi không mở nữa.
 */


/** Chỉ soát đơn còn trong tầm làm được gì. Đơn 90 ngày trước chưa gửi là chuyện của dọn dữ liệu. */
const LOOKBACK_DAYS = 30;
const MAX_VALIDATION_SCAN = 3_000;

/**
 * PHÒNG SỬA THEO NHÓM LỖI. Dùng lại `CaseTeam` của `lib/constants/action-queue.ts`.
 * Tiền thuộc CSKH chứ không thuộc kế toán: người gọi được khách để đối chiếu là người trực chat,
 * còn kế toán chỉ thấy chênh lệch sau khi hàng đã đi.
 */
export const GROUP_TEAM: Record<ValidationGroup, CaseTeam> = {
  CUSTOMER: "CS",
  PRODUCT: "WAREHOUSE",
  MONEY: "CS",
};

export type PreshipValidationRow = {
  orderId: string;
  systemId: number | null;
  orderLabel: string;
  stage: OrderStage;
  customer: string;
  phone: string;
  insertedAt: Date;
  ageLabel: string;
  total: number | null;
  hasShipment: boolean;
  readyToShip: boolean;
  blockers: ValidationFinding[];
  warnings: ValidationFinding[];
  /** Nhóm của lỗi NẶNG NHẤT — dùng để lọc theo phòng. `null` khi đơn chỉ có cảnh báo. */
  primaryGroup: ValidationGroup | null;
  team: CaseTeam;
  teamLabel: string;
  /** Việc phải làm đầu tiên: câu `fix` của lỗi chặn đầu tiên, hoặc của cảnh báo nếu không có lỗi chặn. */
  nextAction: string;
  chatUrl: string | null;
};

export type PreshipValidationQueue = {
  rows: PreshipValidationRow[];
  /** Tổng đơn đã soát — mẫu số. Không có nó thì "12 đơn hỏng" không nói lên điều gì. */
  scanned: number;
  blocked: number;
  warned: number;
  /** Đếm theo từng mã lỗi, nhiều nhất trước: chỗ nào hỏng nhiều thì sửa quy trình ở đó. */
  byCode: { code: string; field: string; group: ValidationGroup; groupLabel: string; severity: string; count: number }[];
  capped: boolean;
  measuredAt: Date;
};

type OrderRaw = {
  id: string;
  system_id: number | null;
  bill_full_name: string;
  ship_full_name: string;
  bill_phone: string;
  ship_phone: string;
  ship_address: string;
  ship_province: string;
  total: string | number | null;
  prepaid: string | number | null;
  stage: OrderStage;
  inserted_at: string | Date;
  page_id: string | null;
  conversation_id: string | null;
  shipment_cod: string | number | null;
  has_shipment: boolean;
};

type ItemRaw = {
  order_id: string;
  variant_id: string | null;
  sku: string;
  product_name: string;
  variation_detail: string;
  quantity: number;
  is_bonus: boolean;
  /** Số mẫu mã của sản phẩm. `null` = chưa tra được ⇒ CHƯA BIẾT, không kết luận thiếu màu/size. */
  variant_count: number | null;
};

export async function getPreshipValidationQueue(): Promise<PreshipValidationQueue> {
  return memo("preship-validation", 90_000, async () => {
    const db = await getDb();
    const now = new Date();
    const lookback = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3_600_000);
    const preship = PRE_SHIP_STAGES.map((s) => `'${s}'`).join(",");
    const dead = DEAD_ORDER_STAGES.map((s) => `'${s}'`).join(",");

    /*
      COD lấy từ LẦN GỬI MỚI NHẤT CÒN SỐNG, không phải từ mọi vận đơn: một đơn có thể có nhiều lần
      gửi (chú thích `shipments.order_id`), và lần gửi đã huỷ không còn nói gì về số bưu tá sẽ thu.
    */
    const orders = rowsOf<OrderRaw>(
      await db.execute(sql`
        select o.id,
               o.system_id,
               o.bill_full_name,
               o.ship_full_name,
               o.bill_phone,
               o.ship_phone,
               o.ship_address,
               o.ship_province,
               o.total_price_after_discount as total,
               o.prepaid,
               o.stage::text as stage,
               o.inserted_at,
               o.page_id,
               o.conversation_id,
               s.cod_amount as shipment_cod,
               (s.id is not null) as has_shipment
          from orders o
          left join lateral (
            select s0.id, s0.cod_amount
              from shipments s0
             where s0.order_id = o.id
               and coalesce(s0.direction, 'OUTBOUND') <> 'RETURN'
               and s0.stage::text <> 'CANCELLED'
             order by s0.created_at desc
             limit 1
          ) s on true
         where o.stage::text in (${sql.raw(preship)})
           and o.stage::text not in (${sql.raw(dead)})
           and o.inserted_at >= ${lookback.toISOString()}::timestamptz
         order by o.inserted_at asc
         limit ${MAX_VALIDATION_SCAN + 1}
      `),
    );

    const capped = orders.length > MAX_VALIDATION_SCAN;
    const list = capped ? orders.slice(0, MAX_VALIDATION_SCAN) : orders;
    if (!list.length) {
      return { rows: [], scanned: 0, blocked: 0, warned: 0, byCode: [], capped, measuredAt: now };
    }

    const ids = list.map((o) => o.id);
    const items = rowsOf<ItemRaw>(
      await db.execute(sql`
        select i.order_id, i.variant_id, i.sku, i.product_name, i.variation_detail,
               i.quantity, i.is_bonus,
               pv.variant_count
          from order_items i
          left join lateral (
            /*
              Sản phẩm có bao nhiêu mẫu mã. Tra qua cột product_id của chính dòng hàng; dòng chưa
              có product_id thì trả NULL — CHƯA BIẾT, và chưa biết thì không sinh lỗi thiếu màu/size.
            */
            select count(*)::int as variant_count
              from product_variants v
             where i.product_id is not null and v.product_id = i.product_id
            having count(*) > 0
          ) pv on true
         where i.order_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      `),
    );

    const byOrder = new Map<string, ValidationItem[]>();
    for (const it of items) {
      const arr = byOrder.get(it.order_id) ?? [];
      const count = it.variant_count === null || it.variant_count === undefined ? null : Number(it.variant_count);
      arr.push({
        variantId: it.variant_id,
        sku: it.sku ?? "",
        productName: it.product_name ?? "",
        variationDetail: it.variation_detail ?? "",
        quantity: Number(it.quantity ?? 0) || 0,
        // Có từ hai mẫu mã trở lên thì màu/size là bắt buộc; đúng một mẫu mã thì không có gì để chọn.
        hasVariations: count === null ? null : count > 1,
        isBonus: Boolean(it.is_bonus),
      });
      byOrder.set(it.order_id, arr);
    }

    const rows: PreshipValidationRow[] = [];
    const tally = new Map<string, { code: string; field: string; group: ValidationGroup; groupLabel: string; severity: string; count: number }>();

    for (const o of list) {
      const insertedAt = toDate(o.inserted_at) ?? now;
      const total = o.total === null || o.total === undefined ? null : Number(o.total);
      const prepaid = o.prepaid === null || o.prepaid === undefined ? null : Number(o.prepaid);
      const report = validateForShipping({
        receiverName: (o.ship_full_name || o.bill_full_name || "").trim(),
        phone: (o.bill_phone || o.ship_phone || "").trim(),
        address: o.ship_address ?? "",
        province: o.ship_province ?? "",
        total,
        prepaid,
        shipmentCod: o.shipment_cod === null || o.shipment_cod === undefined ? null : Number(o.shipment_cod),
        items: byOrder.get(o.id) ?? [],
      });
      if (!report.findings.length) continue;

      for (const f of report.findings) {
        const cur = tally.get(f.code);
        if (cur) cur.count += 1;
        else tally.set(f.code, { code: f.code, field: f.field, group: f.group, groupLabel: VALIDATION_GROUP_LABEL[f.group], severity: f.severity, count: 1 });
      }

      const dau = report.blockers[0] ?? report.warnings[0];
      const primaryGroup = report.blockers[0]?.group ?? null;
      const team = GROUP_TEAM[dau.group];
      rows.push({
        orderId: o.id,
        systemId: o.system_id,
        orderLabel: o.system_id ? `#${o.system_id}` : o.id,
        stage: o.stage,
        customer: (o.bill_full_name || o.ship_full_name || "").trim(),
        phone: (o.bill_phone || o.ship_phone || "").trim(),
        insertedAt,
        ageLabel: ageLabel(Math.max(0, (now.getTime() - insertedAt.getTime()) / 3_600_000)),
        total,
        hasShipment: Boolean(o.has_shipment),
        readyToShip: report.readyToShip,
        blockers: report.blockers,
        warnings: report.warnings,
        primaryGroup,
        team,
        teamLabel: TEAM_LABEL[team],
        nextAction: dau.fix,
        chatUrl: o.page_id && o.conversation_id ? `https://pancake.vn/${o.page_id}?c_id=${o.conversation_id}` : null,
      });
    }

    /*
      XẾP: đơn chưa gửi được trước đơn chỉ có cảnh báo; trong cùng mức thì đơn ĐÃ CÓ VẬN ĐƠN đứng
      trên — nó sắp rời kho, nên cửa sổ sửa còn tính bằng giờ. Rồi tới đơn cũ nhất.
    */
    rows.sort((a, b) => {
      if (a.readyToShip !== b.readyToShip) return a.readyToShip ? 1 : -1;
      if (a.hasShipment !== b.hasShipment) return a.hasShipment ? -1 : 1;
      return a.insertedAt.getTime() - b.insertedAt.getTime();
    });

    return {
      rows,
      scanned: list.length,
      blocked: rows.filter((r) => !r.readyToShip).length,
      warned: rows.filter((r) => r.readyToShip).length,
      byCode: [...tally.values()].sort((a, b) => b.count - a.count),
      capped,
      measuredAt: now,
    };
  });
}

/** Bản soát của MỘT đơn — cho ngăn chi tiết đơn. Cùng một hàm luật, không có đường tính thứ hai. */
export async function getOrderValidation(orderId: string): Promise<{ report: ReturnType<typeof validateForShipping>; found: boolean }> {
  const db = await getDb();
  const rows = rowsOf<OrderRaw>(
    await db.execute(sql`
      select o.id, o.system_id, o.bill_full_name, o.ship_full_name, o.bill_phone, o.ship_phone,
             o.ship_address, o.ship_province, o.total_price_after_discount as total, o.prepaid,
             o.stage::text as stage, o.inserted_at, o.page_id, o.conversation_id,
             s.cod_amount as shipment_cod, (s.id is not null) as has_shipment
        from orders o
        left join lateral (
          select s0.id, s0.cod_amount from shipments s0
           where s0.order_id = o.id and coalesce(s0.direction, 'OUTBOUND') <> 'RETURN' and s0.stage::text <> 'CANCELLED'
           order by s0.created_at desc limit 1
        ) s on true
       where o.id = ${orderId}
       limit 1
    `),
  );
  const o = rows[0];
  if (!o) return { report: { findings: [], blockers: [], warnings: [], readyToShip: true }, found: false };

  const items = rowsOf<ItemRaw>(
    await db.execute(sql`
      select i.order_id, i.variant_id, i.sku, i.product_name, i.variation_detail, i.quantity, i.is_bonus,
             pv.variant_count
        from order_items i
        left join lateral (
          select count(*)::int as variant_count from product_variants v
           where i.product_id is not null and v.product_id = i.product_id
          having count(*) > 0
        ) pv on true
       where i.order_id = ${orderId}
    `),
  );

  const report = validateForShipping({
    receiverName: (o.ship_full_name || o.bill_full_name || "").trim(),
    phone: (o.bill_phone || o.ship_phone || "").trim(),
    address: o.ship_address ?? "",
    province: o.ship_province ?? "",
    total: o.total === null || o.total === undefined ? null : Number(o.total),
    prepaid: o.prepaid === null || o.prepaid === undefined ? null : Number(o.prepaid),
    shipmentCod: o.shipment_cod === null || o.shipment_cod === undefined ? null : Number(o.shipment_cod),
    items: items.map((it) => {
      const count = it.variant_count === null || it.variant_count === undefined ? null : Number(it.variant_count);
      return {
        variantId: it.variant_id,
        sku: it.sku ?? "",
        productName: it.product_name ?? "",
        variationDetail: it.variation_detail ?? "",
        quantity: Number(it.quantity ?? 0) || 0,
        hasVariations: count === null ? null : count > 1,
        isBonus: Boolean(it.is_bonus),
      };
    }),
  });
  return { report, found: true };
}

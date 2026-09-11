import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { RETURN_RULE } from "@/lib/constants/returns";
import {
  composeRisk,
  HIGH_RETURN_RATE,
  MIN_ADDRESS_LENGTH,
  MIN_SAMPLE_FOR_RATE,
  RISK_SIGNAL_LABEL,
  RISK_SIGNAL_MAX,
  type RiskReason,
  type RiskScore,
  type RiskSignalKey,
} from "@/lib/constants/preship-risk";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ RỦI RO TRƯỚC KHI GIAO — MỘT LƯỢT CHO CẢ DANH SÁCH ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` · trọng số: `lib/constants/preship-risk.ts`.
 *
 * ─── VÌ SAO MỘT CÂU TRUY VẤN, KHÔNG PHẢI MỘT VÒNG LẶP ───
 *
 * `riskyOrderCandidates` (`lib/alerts/risk.ts`) gọi `erpHistoryByPhone` **trong vòng lặp**: mỗi đơn
 * một truy vấn. Với 200 đơn chờ gửi là 200 lượt đi về CSDL, và mỗi lượt lại chạy `ORDER_OUTCOME_FAST`
 * trên toàn bộ đơn cùng SĐT. Ở đây mọi tín hiệu được tính SET-BASED một lượt, rồi chấm điểm bằng TS
 * thuần — nên hàm chấm kiểm thử được mà không cần CSDL.
 *
 * ─── THIẾU DỮ LIỆU KHÔNG PHẢI AN TOÀN ───
 *
 * Tín hiệu nào không tra được thì KHÔNG cộng 0 điểm mà vào `unmeasurable`. Cộng 0 sẽ làm một đơn
 * không biết gì về khách trông y hệt một đơn của khách tốt — và đó là kiểu sai làm người ta tin vào
 * điểm số. Thiếu quá nhiều chiều thì mức bị HẠ khỏi "cao" (xem `MAX_UNMEASURABLE_FOR_HIGH`).
 */

/** 9 số cuối — cách ghép SĐT duy nhất đáng tin ("+84…", "0…", có dấu cách đều về cùng một khoá). */
const PHONE_TAIL = (col: string) => sql.raw(`right(regexp_replace(${col}, '\\D', '', 'g'), 9)`);

/**
 * PHẠM VI CHẤM: đơn CHƯA rời kho.
 *
 * Chấm một đơn đã đi rồi là vô nghĩa — không còn hành động nào thay đổi được kết quả. Dùng
 * `picked_up_at`/`stage` của vận đơn chứ không dùng trạng thái Pancake: Pancake nói "đã gửi" khi
 * người bán bấm nút, hàng rời kho là một sự kiện của ĐVVC.
 */
const PRESHIP_SCOPE = sql`
  o.stage in ('NEW','WAITING','CONFIRMED','PACKING','READY_TO_SHIP')
  and not exists (
    select 1 from shipments sp
     where sp.order_id = o.id
       and (sp.picked_up_at is not null
            or sp.stage in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','DELIVERED','RETURNING','RETURNED'))
  )
`;

/** Dữ liệu thô của một đơn để chấm. Mọi trường `null` nghĩa là CHƯA TRA ĐƯỢC. */
export type RiskFacts = {
  orderId: string;
  systemId: number | null;
  customerName: string;
  phone: string;
  province: string;
  createdAt: Date | null;
  orderValue: number;
  cod: number;
  prepaid: number;
  /** Lịch sử của chính khách này, ĐÃ LOẠI đơn đang chấm. `null` = không có SĐT để tra. */
  customerDelivered: number | null;
  customerReturned: number | null;
  isBlocked: boolean | null;
  /** Số đơn khác cùng SĐT (mọi trạng thái trừ huỷ/xoá). */
  otherOrders: number | null;
  /** Số khách khác nhau cùng 9 số cuối SĐT. */
  distinctCustomers: number | null;
  addressComplete: boolean;
  addressLength: number;
  phoneShapeOk: boolean;
  /** Tỷ lệ hoàn của mẫu mã chính trên đơn; `null` khi chưa đủ mẫu. */
  variantReturnRate: number | null;
  variantSample: number;
  variantName: string;
  provinceReturnRate: number | null;
  provinceSample: number;
  sourceReturnRate: number | null;
  sourceSample: number;
  sourceKey: string;
};

export type PreshipRiskRow = RiskFacts & { risk: RiskScore };

/**
 * ───────────── CHẤM ĐIỂM: TS THUẦN, KHÔNG CHẠM CSDL ─────────────
 *
 * Tách hẳn khỏi truy vấn để kiểm thử được từng luật bằng dữ liệu dựng tay. Đây là điều kiện để câu
 * "điểm này giải thích được" có nghĩa: mỗi dòng lý do mang SỐ LIỆU THẬT của đơn đó, không phải một
 * câu mô tả chung.
 */
export function scorePreshipRisk(f: RiskFacts): RiskScore {
  const reasons: RiskReason[] = [];
  const unmeasurable: RiskSignalKey[] = [];
  const add = (key: RiskSignalKey, points: number, evidence: string) => reasons.push({ key, label: RISK_SIGNAL_LABEL[key], points, evidence });

  /* ── 1. Lịch sử hoàn của chính khách — tín hiệu mạnh nhất ── */
  if (f.customerDelivered === null || f.customerReturned === null) {
    unmeasurable.push("CUSTOMER_RETURN_HISTORY");
  } else {
    const finished = f.customerDelivered + f.customerReturned;
    if (finished === 0) {
      unmeasurable.push("CUSTOMER_RETURN_HISTORY");
    } else {
      const rate = f.customerReturned / finished;
      /*
        ĐIỂM TỶ LỆ THUẬN VỚI TỶ LỆ HOÀN, nhưng chỉ tính từ mức mặt bằng trở lên.

        Khách hoàn 1/10 đơn KHÔNG phải khách xấu — đó là chuyện bình thường của bán hàng COD. Cộng
        điểm cho mọi mức hoàn sẽ làm gần như khách nào cũng có điểm, và điểm không còn phân biệt được gì.
      */
      if (rate >= HIGH_RETURN_RATE) {
        const points = Math.round(RISK_SIGNAL_MAX.CUSTOMER_RETURN_HISTORY * Math.min(1, (rate - HIGH_RETURN_RATE) / (1 - HIGH_RETURN_RATE) * 0.5 + 0.5));
        add("CUSTOMER_RETURN_HISTORY", points, `hoàn ${f.customerReturned}/${finished} đơn (${Math.round(rate * 100)}%)`);
      } else if (f.customerReturned >= 3) {
        // Hoàn nhiều LẦN nhưng tỷ lệ chưa cao (khách mua rất nhiều): vẫn là tín hiệu, nhẹ hơn.
        add("CUSTOMER_RETURN_HISTORY", Math.round(RISK_SIGNAL_MAX.CUSTOMER_RETURN_HISTORY * 0.3), `hoàn ${f.customerReturned} đơn (tỷ lệ ${Math.round(rate * 100)}%)`);
      }
      // Khách tốt: trừ điểm. Không trừ là để khách ruột bị soát như khách lạ.
      if (f.customerDelivered >= 3 && rate < 0.3) {
        add("LOYAL_CUSTOMER", RISK_SIGNAL_MAX.LOYAL_CUSTOMER, `đã nhận thành công ${f.customerDelivered} đơn, hoàn ${Math.round(rate * 100)}%`);
      }
    }
  }

  /* ── 2. Pancake chặn khách ── */
  if (f.isBlocked === null) unmeasurable.push("CUSTOMER_BLOCKED");
  else if (f.isBlocked) add("CUSTOMER_BLOCKED", RISK_SIGNAL_MAX.CUSTOMER_BLOCKED, "Pancake đánh dấu chặn khách này");

  /* ── 3. Địa chỉ ── */
  if (!f.addressComplete) {
    add("ADDRESS_INCOMPLETE", RISK_SIGNAL_MAX.ADDRESS_INCOMPLETE, "thiếu tỉnh/thành hoặc phường/xã — POS không đẩy sang ĐVVC được");
  } else if (f.addressLength < MIN_ADDRESS_LENGTH) {
    add("ADDRESS_INCOMPLETE", Math.round(RISK_SIGNAL_MAX.ADDRESS_INCOMPLETE * 0.6), `địa chỉ chỉ ${f.addressLength} ký tự — bưu tá khó tìm được nhà`);
  }

  /* ── 4. Mẫu mã ── */
  if (f.variantReturnRate === null) unmeasurable.push("SKU_RETURN_HISTORY");
  else if (f.variantReturnRate >= HIGH_RETURN_RATE) {
    add("SKU_RETURN_HISTORY", RISK_SIGNAL_MAX.SKU_RETURN_HISTORY, `“${f.variantName}” hoàn ${Math.round(f.variantReturnRate * 100)}% trên ${f.variantSample} đơn đã kết thúc`);
  }

  /* ── 5. Hình dạng SĐT ── */
  if (!f.phone) unmeasurable.push("PHONE_MALFORMED");
  else if (!f.phoneShapeOk) add("PHONE_MALFORMED", RISK_SIGNAL_MAX.PHONE_MALFORMED, `“${f.phone}” không đúng dạng số điện thoại Việt Nam`);

  /* ── 6. Khu vực ── */
  if (f.provinceReturnRate === null) unmeasurable.push("PROVINCE_RETURN_HISTORY");
  else if (f.provinceReturnRate >= HIGH_RETURN_RATE) {
    add("PROVINCE_RETURN_HISTORY", RISK_SIGNAL_MAX.PROVINCE_RETURN_HISTORY, `${f.province} hoàn ${Math.round(f.provinceReturnRate * 100)}% trên ${f.provinceSample} đơn`);
  }

  /* ── 7. Kênh ── */
  if (f.sourceReturnRate === null) unmeasurable.push("SOURCE_RETURN_HISTORY");
  else if (f.sourceReturnRate >= HIGH_RETURN_RATE) {
    add("SOURCE_RETURN_HISTORY", RISK_SIGNAL_MAX.SOURCE_RETURN_HISTORY, `kênh ${f.sourceKey} hoàn ${Math.round(f.sourceReturnRate * 100)}% trên ${f.sourceSample} đơn`);
  }

  /* ── 8. SĐT dùng chung ── */
  if (f.distinctCustomers === null) unmeasurable.push("PHONE_SHARED");
  else if (f.distinctCustomers > 1) add("PHONE_SHARED", RISK_SIGNAL_MAX.PHONE_SHARED, `${f.distinctCustomers} khách khác nhau dùng cùng số này`);

  /* ── 9. Khách mới ── */
  if (f.otherOrders === null) unmeasurable.push("NEW_PHONE");
  else if (f.otherOrders === 0 && (f.customerDelivered ?? 0) === 0 && (f.customerReturned ?? 0) === 0) {
    add("NEW_PHONE", RISK_SIGNAL_MAX.NEW_PHONE, "SĐT chưa từng có đơn nào — chưa có gì để dựa vào (KHÔNG phải bằng chứng xấu)");
  }

  /* ── 10. Đã trả tiền trước — tín hiệu tốt mạnh nhất ── */
  if (f.prepaid > RETURN_RULE.maxCodForFakeDelivery) {
    add("PREPAID", RISK_SIGNAL_MAX.PREPAID, `khách đã chuyển trước ${f.prepaid.toLocaleString("vi-VN")}đ`);
  }

  /*
    THIỆT HẠI DỰ KIẾN — ĐỘ LỚN, KHÔNG PHẢI XÁC SUẤT.

    Cố ý KHÔNG vào điểm: trộn tiền vào xác suất sẽ đẩy đơn 2 triệu của khách ruột lên trước đơn 300K
    của khách đã hoàn bốn lần. Đây là tiền hàng không thu được + cước hai chiều nếu đơn này hoàn.
  */
  const expectedLossVnd = f.orderValue > 0 ? f.orderValue + RETURN_RULE.maxFeeForFakeDelivery * 2 : null;

  return composeRisk({ reasons, unmeasurable, expectedLossVnd });
}

/** Câu con tỷ lệ hoàn lịch sử theo một chiều, trong cửa sổ ngày. Mẫu nhỏ ⇒ `null`, không ⇒ 0. */
function rateCte(name: string, groupExpr: string, days: number) {
  return sql.raw(`
    ${name} as (
      select ${groupExpr} as k,
             count(*) filter (where co.outcome = 'DELIVERED')::int as delivered,
             count(*) filter (where co.outcome in ('RETURNED','RETURNED_BY_RULE'))::int as returned
        from canonical_order_outcome co
        join orders o2 on o2.id = co.order_id
        left join order_items oi2 on oi2.order_id = o2.id and oi2.is_bonus = false
       where o2.inserted_at >= now() - interval '${days} days'
         and co.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE')
       group by 1
    )`);
}

/**
 * Chấm rủi ro cho mọi đơn CHƯA rời kho.
 *
 * Một câu truy vấn dựng đủ mọi tín hiệu, rồi chấm bằng TS. `memo` 60 giây: đây là danh sách việc, nên
 * thà chậm 60 giây còn hơn mỗi lần mở trang lại quét toàn bộ lịch sử.
 */
export async function listPreshipRisk(options: { limit?: number } = {}): Promise<PreshipRiskRow[]> {
  const limit = options.limit ?? 300;
  return memo(`preshipRisk:${limit}`, 60_000, async () => {
    const db = await getDb();
    const rows = rowsOf<{
      id: string;
      system_id: number | null;
      customer_name: string;
      phone: string;
      province: string;
      created_at: string | null;
      order_value: string | number;
      cod: string | number;
      prepaid: string | number;
      cust_delivered: number | null;
      cust_returned: number | null;
      is_blocked: boolean | null;
      other_orders: number | null;
      distinct_customers: number | null;
      address_complete: boolean;
      address_length: number;
      phone_shape_ok: boolean;
      variant_name: string;
      variant_delivered: number | null;
      variant_returned: number | null;
      province_delivered: number | null;
      province_returned: number | null;
      source_key: string;
      source_delivered: number | null;
      source_returned: number | null;
    }>(
      await db.execute(sql`
        with ${rateCte("ty_le_mau_ma", "coalesce(nullif(oi2.product_name, ''), oi2.sku)", 180)},
        ${rateCte("ty_le_tinh", "nullif(o2.ship_province, '')", 180)},
        ${rateCte("ty_le_kenh", "coalesce(nullif(o2.source, ''), 'Khác')", 180)}
        select o.id,
               o.system_id,
               o.bill_full_name as customer_name,
               coalesce(nullif(o.bill_phone, ''), o.ship_phone, '') as phone,
               o.ship_province as province,
               o.inserted_at as created_at,
               o.total_price_after_discount as order_value,
               o.cod,
               coalesce(o.prepaid, 0) + coalesce(o.transfer_money, 0) as prepaid,
               /*
                 LỊCH SỬ CỦA CHÍNH KHÁCH — đọc kết quả ĐÃ VẬT CHẤT HOÁ, ghép theo 9 SỐ CUỐI.
                 Ghép bằng so sánh chuỗi nguyên thì "+84 912…" và "0912…" thành hai người khác nhau,
                 và lịch sử xấu của khách biến mất đúng lúc cần nó nhất.
                 LOẠI chính đơn đang chấm: không thì đơn tự dự báo bằng kết quả của chính nó.
               */
               (select count(*) filter (where co.outcome = 'DELIVERED')::int
                  from canonical_order_outcome co join orders oh on oh.id = co.order_id
                 where oh.id <> o.id and ${PHONE_TAIL("oh.bill_phone")} = ${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}
                   and length(${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}) = 9) as cust_delivered,
               (select count(*) filter (where co.outcome in ('RETURNED','RETURNED_BY_RULE'))::int
                  from canonical_order_outcome co join orders oh on oh.id = co.order_id
                 where oh.id <> o.id and ${PHONE_TAIL("oh.bill_phone")} = ${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}
                   and length(${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}) = 9) as cust_returned,
               (select c.is_block from customers c where c.id = o.customer_id) as is_blocked,
               (select count(*)::int from orders oo
                 where oo.id <> o.id and oo.stage not in ('CANCELLED','DELETED')
                   and ${PHONE_TAIL("oo.bill_phone")} = ${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}
                   and length(${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}) = 9) as other_orders,
               (select count(distinct oo.customer_id)::int from orders oo
                 where oo.customer_id is not null
                   and ${PHONE_TAIL("oo.bill_phone")} = ${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}
                   and length(${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")}) = 9) as distinct_customers,
               -- ĐỊA CHỈ ĐỦ = có tỉnh VÀ (phường/xã hoặc quận/huyện). Chuẩn hai cấp mới chỉ cần tỉnh + xã.
               (o.ship_province <> '' and (o.ship_commune <> '' or o.ship_district <> '')) as address_complete,
               length(coalesce(nullif(o.ship_full_address, ''), o.ship_address, '')) as address_length,
               -- Số VN: 10 chữ số bắt đầu bằng 0, hoặc 9 số cuối hợp lệ sau khi bỏ mã quốc gia.
               (${PHONE_TAIL("coalesce(nullif(o.bill_phone, ''), o.ship_phone, '')")} ~ '^[1-9][0-9]{8}$') as phone_shape_ok,
               coalesce(mm.ten, '') as variant_name,
               tm.delivered as variant_delivered,
               tm.returned as variant_returned,
               tt.delivered as province_delivered,
               tt.returned as province_returned,
               coalesce(nullif(o.source, ''), 'Khác') as source_key,
               tk.delivered as source_delivered,
               tk.returned as source_returned
          from orders o
          -- Mẫu mã CHÍNH của đơn: dòng hàng tiền lớn nhất, bỏ hàng tặng. Một đơn một mẫu mã để không
          -- đếm đơn nhiều lần.
          left join lateral (
            select coalesce(nullif(i.product_name, ''), i.sku) as ten
              from order_items i
             where i.order_id = o.id and i.is_bonus = false
             order by i.line_total desc nulls last, i.id
             limit 1
          ) mm on true
          left join ty_le_mau_ma tm on tm.k = mm.ten
          left join ty_le_tinh tt on tt.k = nullif(o.ship_province, '')
          left join ty_le_kenh tk on tk.k = coalesce(nullif(o.source, ''), 'Khác')
         where ${PRESHIP_SCOPE}
         order by o.inserted_at desc
         limit ${limit}
      `),
    );

    const rate = (d: number | null, r: number | null): { rate: number | null; sample: number } => {
      const delivered = Number(d ?? 0);
      const returned = Number(r ?? 0);
      const sample = delivered + returned;
      // Mẫu nhỏ ⇒ CHƯA BIẾT. Trả 0 sẽ nói "mẫu mã này không bao giờ hoàn", một câu chưa ai kiểm chứng.
      return { rate: sample >= MIN_SAMPLE_FOR_RATE ? returned / sample : null, sample };
    };

    return rows.map((r) => {
      const variant = rate(r.variant_delivered, r.variant_returned);
      const province = rate(r.province_delivered, r.province_returned);
      const source = rate(r.source_delivered, r.source_returned);
      const facts: RiskFacts = {
        orderId: r.id,
        systemId: r.system_id,
        customerName: r.customer_name ?? "",
        phone: r.phone ?? "",
        province: r.province ?? "",
        createdAt: r.created_at ? new Date(r.created_at) : null,
        orderValue: Number(r.order_value ?? 0),
        cod: Number(r.cod ?? 0),
        prepaid: Number(r.prepaid ?? 0),
        customerDelivered: r.cust_delivered === null ? null : Number(r.cust_delivered),
        customerReturned: r.cust_returned === null ? null : Number(r.cust_returned),
        isBlocked: r.is_blocked,
        otherOrders: r.other_orders === null ? null : Number(r.other_orders),
        distinctCustomers: r.distinct_customers === null ? null : Number(r.distinct_customers),
        addressComplete: Boolean(r.address_complete),
        addressLength: Number(r.address_length ?? 0),
        phoneShapeOk: Boolean(r.phone_shape_ok),
        variantReturnRate: variant.rate,
        variantSample: variant.sample,
        variantName: r.variant_name ?? "",
        provinceReturnRate: province.rate,
        provinceSample: province.sample,
        sourceReturnRate: source.rate,
        sourceSample: source.sample,
        sourceKey: r.source_key ?? "",
      };
      return { ...facts, risk: scorePreshipRisk(facts) };
    });
  });
}

export type PreshipRiskSummary = {
  total: number;
  high: number;
  medium: number;
  low: number;
  /** Số đơn bị HẠ mức vì thiếu dữ liệu — nói ra thay vì để nhãn trông như đã kiểm chứng. */
  capped: number;
  /** Tổng thiệt hại dự kiến của nhóm rủi ro cao (đồng). ĐỘ LỚN, không phải kỳ vọng thống kê. */
  highExpectedLoss: number;
};

export function summarizePreshipRisk(rows: PreshipRiskRow[]): PreshipRiskSummary {
  return {
    total: rows.length,
    high: rows.filter((r) => r.risk.band === "HIGH").length,
    medium: rows.filter((r) => r.risk.band === "MEDIUM").length,
    low: rows.filter((r) => r.risk.band === "LOW").length,
    capped: rows.filter((r) => r.risk.bandCapped).length,
    highExpectedLoss: rows.filter((r) => r.risk.band === "HIGH").reduce((t, r) => t + (r.risk.expectedLossVnd ?? 0), 0),
  };
}

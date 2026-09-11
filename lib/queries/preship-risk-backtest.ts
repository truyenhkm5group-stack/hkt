import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import {
  BACKTEST_MIN_ORDERS,
  BACKTEST_TRAIN_RATIO,
  MIN_LIFT_TO_CLAIM,
  MIN_SAMPLE_FOR_RATE,
  type BacktestBand,
  type BacktestVerdict,
  type RiskBacktest,
  type RiskBand,
} from "@/lib/constants/preship-risk";
import { scorePreshipRisk, type RiskFacts } from "@/lib/queries/preship-risk";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ KIỂM ĐỊNH ĐIỂM RỦI RO: CÓ TÁCH ĐƯỢC HOÀN KHỎI GIAO KHÔNG? ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md`.
 *
 * ─── VÌ SAO PHẢI CHIA THEO THỜI GIAN ───
 *
 * Bốn tín hiệu của điểm rủi ro (lịch sử khách, mẫu mã, khu vực, kênh) đều là TỶ LỆ HOÀN LỊCH SỬ. Nếu
 * tỷ lệ đó được tính trên toàn bộ dữ liệu, nó đã CHỨA kết quả của chính đơn đang chấm — và điểm sẽ
 * "dự báo" xuất sắc một chuyện nó đã biết trước. Đó là tự chấm bài của mình.
 *
 * Nên: tỷ lệ tham chiếu học từ nửa CŨ (trước `trainTo`), rồi chấm cho đơn của nửa MỚI. Không có tham
 * số nào được khớp — trọng số là hằng số khai trong `lib/constants/preship-risk.ts` — nên đây là kiểm
 * định "ngoài mẫu" theo đúng nghĩa: dữ liệu chấm điểm không hề biết kết quả cần dự báo.
 *
 * ─── HÀM NÀY ĐƯỢC PHÉP TRẢ VỀ "KHÔNG CÓ TÁC DỤNG" ───
 *
 * Và đó là điểm quan trọng nhất. `verdict` chỉ là `PHÂN BIỆT ĐƯỢC` khi nhóm rủi ro cao hoàn nhiều hơn
 * mặt bằng ít nhất `MIN_LIFT_TO_CLAIM` **và** biên dưới Wilson 95% của tỷ lệ đó vẫn cao hơn mặt bằng.
 * Mọi trường hợp khác trả `KHÔNG PHÂN BIỆT ĐƯỢC` hoặc `KHÔNG ĐỦ MẪU`, kèm lý do.
 *
 * `lib/queries/care-effectiveness.ts` đã từ chối công bố hiệu quả khi chưa có mẫu; đây là cùng luật.
 */

/**
 * Biên dưới khoảng tin cậy Wilson 95%.
 *
 * Dùng Wilson thay vì sai số chuẩn thường vì mẫu ở đây nhỏ (vài chục đơn mỗi nhóm) và tỷ lệ gần biên;
 * công thức thường cho khoảng tin cậy sai hẳn trong vùng đó — và một khoảng tin cậy sai sẽ làm ta
 * tuyên bố "có tác dụng" cho một dao động ngẫu nhiên.
 */
function wilsonLower(successes: number, n: number): number | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Tỷ lệ hoàn lịch sử theo một chiều, CHỈ tính đơn lên trước `cutoff`.
 *
 * `cutoff` là toàn bộ lý do hàm này tồn tại riêng: không có nó thì tỷ lệ tham chiếu chứa cả kết quả
 * của đơn đang chấm.
 */
function asOfRateCte(name: string, groupExpr: string) {
  return sql.raw(`
    ${name} as (
      select ${groupExpr} as k,
             count(*) filter (where co.outcome = 'DELIVERED')::int as delivered,
             count(*) filter (where co.outcome in ('RETURNED','RETURNED_BY_RULE'))::int as returned
        from canonical_order_outcome co
        join orders o2 on o2.id = co.order_id
        left join order_items oi2 on oi2.order_id = o2.id and oi2.is_bonus = false
       where co.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE')
         and o2.inserted_at < (select moc from moc_hoc)
       group by 1
    )`);
}

export async function getPreshipRiskBacktest(period: Period): Promise<RiskBacktest> {
  return memo(`preshipBacktest:${periodKey(period)}`, 300_000, async () => {
    const db = await getDb();

    /*
      MỐC CHIA. Lấy theo phân vị thời gian của chính tập đơn đã kết thúc trong kỳ, không lấy "hôm nay
      trừ 30 ngày": nếu shop vừa ngừng bán hai tuần thì mốc cố định sẽ để tập kiểm tra rỗng, và hàm
      trả "không đủ mẫu" vì một lý do không liên quan gì tới điểm rủi ro.
    */
    const from = period.from ? sql`and o.inserted_at >= ${period.from.toISOString()}::timestamptz` : sql``;
    const to = period.to ? sql`and o.inserted_at <= ${period.to.toISOString()}::timestamptz` : sql``;

    const rows = rowsOf<{
      id: string;
      outcome: string;
      phone: string;
      province: string;
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
      moc_hoc: string | null;
      so_don_hoc: number;
    }>(
      await db.execute(sql`
        with da_ket_thuc as (
          select o.id, o.inserted_at
            from orders o
            join canonical_order_outcome co on co.order_id = o.id
           where co.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE')
             ${from} ${to}
        ),
        moc_hoc as (
          select percentile_disc(${BACKTEST_TRAIN_RATIO}::double precision) within group (order by inserted_at) as moc,
                 count(*)::int as tong
            from da_ket_thuc
        ),
        so_don_hoc as (
          select count(*)::int as n from da_ket_thuc where inserted_at < (select moc from moc_hoc)
        ),
        ${asOfRateCte("ty_le_mau_ma", "coalesce(nullif(oi2.product_name, ''), oi2.sku)")},
        ${asOfRateCte("ty_le_tinh", "nullif(o2.ship_province, '')")},
        ${asOfRateCte("ty_le_kenh", "coalesce(nullif(o2.source, ''), 'Khác')")}
        select o.id,
               co.outcome,
               coalesce(nullif(o.bill_phone, ''), o.ship_phone, '') as phone,
               o.ship_province as province,
               o.total_price_after_discount as order_value,
               o.cod,
               coalesce(o.prepaid, 0) + coalesce(o.transfer_money, 0) as prepaid,
               /*
                 LỊCH SỬ KHÁCH TÍNH TỚI THỜI ĐIỂM CỦA CHÍNH ĐƠN NÀY.

                 "oh.inserted_at < o.inserted_at" là điều kiện chống rò rỉ quan trọng nhất của cả hàm:
                 lúc chuẩn bị gửi đơn này, ta CHƯA THỂ biết kết quả những đơn lên sau nó. Bỏ điều kiện
                 đó là cho điểm rủi ro xem trước tương lai.
               */
               (select count(*) filter (where co2.outcome = 'DELIVERED')::int
                  from canonical_order_outcome co2 join orders oh on oh.id = co2.order_id
                 where oh.id <> o.id
                   and oh.inserted_at < o.inserted_at
                   and right(regexp_replace(oh.bill_phone, '\\D', '', 'g'), 9) = right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)
                   and length(right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)) = 9) as cust_delivered,
               (select count(*) filter (where co2.outcome in ('RETURNED','RETURNED_BY_RULE'))::int
                  from canonical_order_outcome co2 join orders oh on oh.id = co2.order_id
                 where oh.id <> o.id
                   and oh.inserted_at < o.inserted_at
                   and right(regexp_replace(oh.bill_phone, '\\D', '', 'g'), 9) = right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)
                   and length(right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)) = 9) as cust_returned,
               (select c.is_block from customers c where c.id = o.customer_id) as is_blocked,
               (select count(*)::int from orders oo
                 where oo.id <> o.id and oo.stage not in ('CANCELLED','DELETED')
                   and oo.inserted_at < o.inserted_at
                   and right(regexp_replace(oo.bill_phone, '\\D', '', 'g'), 9) = right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)
                   and length(right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)) = 9) as other_orders,
               (select count(distinct oo.customer_id)::int from orders oo
                 where oo.customer_id is not null
                   and right(regexp_replace(oo.bill_phone, '\\D', '', 'g'), 9) = right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)
                   and length(right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9)) = 9) as distinct_customers,
               (o.ship_province <> '' and (o.ship_commune <> '' or o.ship_district <> '')) as address_complete,
               length(coalesce(nullif(o.ship_full_address, ''), o.ship_address, '')) as address_length,
               (right(regexp_replace(coalesce(nullif(o.bill_phone, ''), o.ship_phone, ''), '\\D', '', 'g'), 9) ~ '^[1-9][0-9]{8}$') as phone_shape_ok,
               coalesce(mm.ten, '') as variant_name,
               tm.delivered as variant_delivered,
               tm.returned as variant_returned,
               tt.delivered as province_delivered,
               tt.returned as province_returned,
               coalesce(nullif(o.source, ''), 'Khác') as source_key,
               tk.delivered as source_delivered,
               tk.returned as source_returned,
               (select moc from moc_hoc)::text as moc_hoc,
               (select n from so_don_hoc) as so_don_hoc
          from orders o
          join canonical_order_outcome co on co.order_id = o.id
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
         where co.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE')
           -- CHỈ nửa KIỂM TRA. Đơn của nửa học đã được dùng để dựng tỷ lệ tham chiếu.
           and o.inserted_at >= (select moc from moc_hoc)
           ${from} ${to}
      `),
    );

    const trainOrders = Number(rows[0]?.so_don_hoc ?? 0);
    const trainTo = rows[0]?.moc_hoc ? new Date(rows[0].moc_hoc) : null;

    const rate = (d: number | null, r: number | null) => {
      const delivered = Number(d ?? 0);
      const returned = Number(r ?? 0);
      const sample = delivered + returned;
      return { rate: sample >= MIN_SAMPLE_FOR_RATE ? returned / sample : null, sample };
    };

    // Chấm bằng ĐÚNG hàm mà giao diện dùng — kiểm định một hàm khác là kiểm định vô nghĩa.
    const scored = rows.map((r) => {
      const variant = rate(r.variant_delivered, r.variant_returned);
      const province = rate(r.province_delivered, r.province_returned);
      const source = rate(r.source_delivered, r.source_returned);
      const facts: RiskFacts = {
        orderId: r.id,
        systemId: null,
        customerName: "",
        phone: r.phone ?? "",
        province: r.province ?? "",
        createdAt: null,
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
      const risk = scorePreshipRisk(facts);
      return { band: risk.band, returned: r.outcome !== "DELIVERED" };
    });

    const total = scored.length;
    const allReturned = scored.filter((s) => s.returned).length;
    const baseline = total > 0 ? allReturned / total : null;

    const bands: BacktestBand[] = (["HIGH", "MEDIUM", "LOW"] as RiskBand[]).map((band) => {
      const rows2 = scored.filter((s) => s.band === band);
      const returned = rows2.filter((s) => s.returned).length;
      const n = rows2.length;
      // Nhóm dưới cỡ mẫu ⇒ KHÔNG có tỷ lệ. Trả một con số từ 4 đơn là mời người ta tin vào nhiễu.
      const r = n >= MIN_SAMPLE_FOR_RATE ? returned / n : null;
      return { band, orders: n, delivered: n - returned, returned, returnRate: r, lift: r !== null && baseline ? Math.round((r / baseline) * 100) / 100 : null };
    });

    const high = bands.find((b) => b.band === "HIGH")!;
    const medium = bands.find((b) => b.band === "MEDIUM")!;
    const low = bands.find((b) => b.band === "LOW")!;
    const highPrecision = high.orders >= MIN_SAMPLE_FOR_RATE ? high.returned / high.orders : null;
    const highRecall = allReturned > 0 && high.orders >= MIN_SAMPLE_FOR_RATE ? high.returned / allReturned : null;
    const uplift = high.returnRate !== null && baseline ? Math.round((high.returnRate / baseline) * 100) / 100 : null;

    /*
      ĐƠN ĐIỆU: cao ≥ trung bình ≥ thấp.

      So sánh chỉ trên các nhóm CÓ tỷ lệ (đủ mẫu). Coi nhóm thiếu mẫu là 0 sẽ làm thứ tự trông đẹp
      nhờ một con số không tồn tại.
      */
    const daDo = [high, medium, low].filter((b) => b.returnRate !== null);
    const monotone = daDo.every((b, i) => i === 0 || (daDo[i - 1].returnRate ?? 0) >= (b.returnRate ?? 0));

    let verdict: BacktestVerdict;
    let verdictReason: string;
    const wilson = high.orders >= MIN_SAMPLE_FOR_RATE ? wilsonLower(high.returned, high.orders) : null;
    if (total < BACKTEST_MIN_ORDERS || high.orders < MIN_SAMPLE_FOR_RATE || baseline === null) {
      verdict = "KHÔNG ĐỦ MẪU";
      /*
        NÊU ĐÚNG ĐIỀU KIỆN NÀO THIẾU, không đọc cả danh sách.

        Một câu liệt kê mọi điều kiện kể cả những cái đã đạt sẽ làm người đọc tưởng tất cả đều thiếu,
        rồi bỏ qua cả thông báo. Nói đúng chỗ hụt thì họ biết cần chờ thêm bao nhiêu.
      */
      const thieu: string[] = [];
      if (total < BACKTEST_MIN_ORDERS) thieu.push(`nửa kiểm tra chỉ có ${total} đơn đã kết thúc (cần ≥ ${BACKTEST_MIN_ORDERS})`);
      if (high.orders < MIN_SAMPLE_FOR_RATE) thieu.push(`nhóm rủi ro cao chỉ có ${high.orders} đơn (cần ≥ ${MIN_SAMPLE_FOR_RATE})`);
      if (baseline === null) thieu.push("không có đơn nào đã kết thúc để lấy mặt bằng");
      verdictReason =
        `Chưa đủ mẫu: ${thieu.join(" · ")}. ` +
        `CHƯA kết luận được điểm rủi ro có tác dụng hay không — và "chưa kết luận được" KHÁC "không có tác dụng". ` +
        (high.returnRate !== null && baseline !== null
          ? `Con số sơ bộ (CHƯA đủ tin): nhóm cao hoàn ${Math.round(high.returnRate * 100)}% so với mặt bằng ${Math.round(baseline * 100)}%.`
          : "");
    } else if (uplift !== null && uplift >= MIN_LIFT_TO_CLAIM && wilson !== null && wilson > baseline) {
      verdict = "PHÂN BIỆT ĐƯỢC";
      verdictReason =
        `Nhóm rủi ro cao hoàn ${Math.round((high.returnRate ?? 0) * 100)}% so với mặt bằng ${Math.round(baseline * 100)}% (gấp ${uplift}×), ` +
        `và biên dưới khoảng tin cậy 95% (${Math.round(wilson * 100)}%) vẫn cao hơn mặt bằng — không phải dao động ngẫu nhiên.`;
    } else {
      verdict = "KHÔNG PHÂN BIỆT ĐƯỢC";
      verdictReason =
        `Nhóm rủi ro cao hoàn ${high.returnRate === null ? "—" : Math.round(high.returnRate * 100) + "%"} so với mặt bằng ${Math.round((baseline ?? 0) * 100)}% ` +
        `(gấp ${uplift ?? "—"}×, cần ≥ ${MIN_LIFT_TO_CLAIM}×${wilson !== null ? `; biên dưới 95% là ${Math.round(wilson * 100)}%` : ""}). ` +
        `Điểm rủi ro hiện KHÔNG chứng minh được là dự báo được hoàn. Không được dùng nó để biện minh cho bất kỳ quyết định nào tốn tiền.`;
    }

    return {
      orders: total,
      trainOrders,
      baselineReturnRate: baseline,
      bands,
      highPrecision,
      highRecall,
      uplift,
      monotone,
      // Mọi đơn đã kết thúc đều chấm được (tín hiệu thiếu thì vào `unmeasurable`), nên độ phủ là 1.
      coverage: 1,
      verdict,
      verdictReason,
      limitations: [
        "Điểm được chấm LẠI từ dữ liệu hôm nay, không phải trạng thái đúng lúc bàn giao: địa chỉ và SĐT của đơn có thể đã được sửa sau đó.",
        "Tỉnh rỗng là CHƯA BIẾT, không phải một tỉnh — những đơn đó không có tín hiệu khu vực.",
        `Nhãn "hoàn" một phần là kết luận về TIỀN, không phải về vật lý: theo RETURN_RULE, đơn ĐVVC báo giao thành công mà thực thu dưới 100.000đ vẫn là hoàn. Nên điểm đang dự báo lẫn cả việc thu được tiền.`,
        "Trọng số là giả thiết do người đặt, không phải kết quả học máy — kiểm định này chỉ nói chúng có tách được nhóm hay không, không nói chúng là bộ trọng số tốt nhất.",
      ],
      trainTo,
      testFrom: trainTo,
    };
  });
}

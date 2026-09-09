import { sql } from "drizzle-orm";
import { operatingExpenseCond } from "@/lib/queries/cost-allocation";
import { getDb, schema } from "@/db";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";

/**
 * ───────────── DÒNG TIỀN & VỐN LƯU ĐỘNG ─────────────
 *
 * LỢI NHUẬN KHÔNG PHẢI TIỀN. Một shop bán COD có thể lãi trên giấy mà vẫn hết tiền mặt: hàng đã
 * giao nhưng Viettel Post giữ tiền cả tuần, còn tiền quảng cáo và tiền hàng thì trả ngay. Báo cáo
 * lợi nhuận không trả lời được câu "tuần sau có đủ tiền chạy quảng cáo không" — đó là việc của
 * trang này.
 *
 * GIỚI HẠN PHẢI NÓI TRƯỚC: **ERP không có nguồn số dư ngân hàng.** Không có API ngân hàng, không có
 * bảng số dư. Nên đây là DÒNG TIỀN RÒNG DỰ KIẾN (vào trừ ra), KHÔNG phải số dư tài khoản. Nó trả
 * lời "kỳ tới thu hơn chi bao nhiêu", không trả lời "còn bao nhiêu tiền trong tài khoản".
 *
 * Bịa một số dư mở đầu để có con số "đẹp" là cách nhanh nhất biến một công cụ ra quyết định thành
 * một công cụ gây thiệt hại.
 */

const o = schema.orders;
const s = schema.shipments;

export type CashBucket = {
  days: number;
  label: string;
  /** Tiền COD dự kiến về theo các đơn ĐÃ GIAO nhưng chưa thấy chứng từ. */
  codExpected: number;
  /** Chi quảng cáo dự kiến, theo nhịp chi thực tế 14 ngày gần nhất. */
  adsPlanned: number;
  /** Chi phí vận hành định kỳ, theo nhịp thực tế 60 ngày gần nhất. */
  opexPlanned: number;
  /** Tiền hàng phải trả xưởng cho các đơn sản xuất đã gửi mà chưa nhận. */
  productionDue: number;
  /** Vào trừ ra. Âm nghĩa là kỳ đó tiêu nhiều hơn thu. */
  net: number;
};

export type WorkingCapital = {
  /** Tiền COD đã giao nhưng chưa về — Viettel Post đang giữ. */
  codReceivable: number;
  codReceivableCount: number;
  /** Phần COD đã quá hạn thông thường — khả năng phải đi đòi. */
  codOverdue: number;
  /** Vốn nằm trong hàng tồn (giá nhập). */
  inventoryValue: number;
  /** Tiền hàng đã cam kết với xưởng, chưa nhận hàng. */
  productionCommitted: number;
};

export type CashflowReport = {
  buckets: CashBucket[];
  workingCapital: WorkingCapital;
  /** Nhịp chi thực tế dùng để dự phóng — hiện ra để người đọc kiểm chứng được. */
  basis: { adsPerDay: number; opexPerDay: number; codSettlementDays: number };
  /** Những gì ERP KHÔNG biết. Đọc trước khi tin con số. */
  limitations: string[];
};

/**
 * Dự phóng dòng tiền 7 / 14 / 30 ngày.
 *
 * CÁCH DỰ PHÓNG, cố ý đơn giản và nói ra được:
 *  · TIỀN VÀO  = COD của đơn đã giao chưa thấy chứng từ, rải đều tới hạn đối soát thông thường;
 *  · TIỀN RA   = nhịp chi quảng cáo 14 ngày gần nhất + nhịp chi vận hành 60 ngày gần nhất
 *                + tiền hàng phải trả cho đơn sản xuất đã gửi.
 *
 * KHÔNG dự phóng doanh thu từ đơn CHƯA giao: đơn chưa giao thì chưa chắc thành tiền, và với shop
 * bán COD tỷ lệ hoàn đủ lớn để phép ngoại suy đó thành sai lệch nghiêm trọng.
 */
export async function getCashflow(): Promise<CashflowReport> {
  const db = await getDb();

  // ── Tiền COD đang bị giữ: đơn ĐÃ GIAO THÀNH CÔNG mà chưa có đồng chứng từ nào ──
  const [cod] = await db
    .select({
      amount: sql<number>`coalesce(sum(coalesce(${s.codAmount}, 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0), 0)`,
      count: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0)`,
      overdue: sql<number>`coalesce(sum(coalesce(${s.codAmount}, 0)) filter (
        where ${ORDER_OUTCOME} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0
          and coalesce(${s.deliveredAt}, ${s.updatedAt}) < now() - (${COD_OVERDUE_DAYS} * interval '1 day')), 0)`,
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn nhiều lần gửi không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(s, sql`${s.orderId} = ${o.id} and ${PRIMARY_ATTEMPT}`);

  // ── Nhịp chi thực tế ──
  const [ads] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
    .from(schema.adSpends)
    .where(sql`${schema.adSpends.excluded} = false and ${schema.adSpends.spendDate} >= now() - interval '14 days'`);
  // MỘT KHOẢN CHI MỘT NGUỒN (AGENTS.md mục 15). Ngay trên đây đã cộng chi tiêu quảng cáo từ TÀI
  // KHOẢN QC; nếu ở đây cộng luôn khoản gõ tay nhóm "Quảng cáo" thì nhịp chi bị thổi gấp đôi và chủ
  // shop tưởng mình đang đốt tiền nhanh hơn thực tế. Giá vốn cũng vậy — nó đi theo phiếu kho.
  const [opex] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.expenses.amount}), 0)` })
    .from(schema.expenses)
    .where(sql`${schema.expenses.occurredAt} >= now() - interval '60 days' and ${operatingExpenseCond()}`);

  // ── Tiền hàng đã cam kết với xưởng: đơn sản xuất ĐÃ GỬI mà chưa nhận ──
  const [prod] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.productionOrders.totalQty} * ${schema.productionOrders.unitCost}), 0)` })
    .from(schema.productionOrders)
    .where(sql`${schema.productionOrders.status} = 'SENT'`);

  // ── Vốn nằm trong hàng tồn ──
  const [inv] = await db
    .select({
      value: sql<number>`coalesce((
        select sum(greatest(x.ton, 0) * coalesce(nullif(x.gia, 0), 0))
        from (
          select pv.id,
            coalesce((select sum(ri.quantity) from stock_receipt_items ri where ri.variant_id = pv.id), 0)
              -- ĐÃ XUẤT KHO tính bằng EXISTS chứ không bằng phép nối: một đơn nhiều lần gửi thì
              -- phép nối nhân số lượng lên theo số lần gửi và thổi phồng "đã xuất", làm tồn âm giả.
              - coalesce((select sum(oi.quantity) from order_items oi join orders oo on oo.id = oi.order_id
                          where oi.variant_id = pv.id
                            and exists (select 1 from shipments ss where ss.order_id = oo.id
                                        and (ss.picked_up_at is not null or ss.stage::text in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','DELIVERED','RETURNING','RETURNED')))), 0) as ton,
            pv.last_imported_price as gia
          from product_variants pv where pv.is_removed = false
        ) x
      ), 0)`,
    })
    .from(sql`(select 1) as t`);

  /**
   * ĐO ĐỘ ĐẦY ĐỦ CỦA DỮ LIỆU, không chỉ đo con số.
   *
   * Bốn cấu phần của dự phóng này đều có thể bằng 0 vì hai lý do hoàn toàn khác nhau: **không phát
   * sinh**, hoặc **chưa có ai nhập dữ liệu**. Trình bày hai thứ đó giống hệt nhau là cách chắc chắn
   * nhất để chủ shop tin nhầm một con số rỗng.
   *
   * Đo trên production 10/09/2026: `production_orders` 0 dòng, `bank_transactions` 0 dòng,
   * `stock_receipts` đúng 2 phiếu, và 0/37 mẫu mã có giá nhập — nghĩa là "tiền hàng đã cam kết 0đ"
   * và "vốn tồn kho 0đ" hiện tại đều là CHƯA BIẾT, không phải 0.
   */
  const [dayDu] = await db
    .select({
      lenhSanXuat: sql<number>`(select count(*) from production_orders)`,
      mauMaCoGia: sql<number>`(select count(*) from product_variants where is_removed = false and coalesce(last_imported_price, 0) > 0)`,
      mauMaTong: sql<number>`(select count(*) from product_variants where is_removed = false)`,
      phieuNhap: sql<number>`(select count(*) from stock_receipts where kind = 'RECEIPT')`,
      khoanChi60Ngay: sql<number>`(select count(*) from expenses where occurred_at >= now() - interval '60 days')`,
    })
    .from(sql`(select 1) as t`);

  const adsPerDay = Number(ads?.total ?? 0) / 14;
  const opexPerDay = Number(opex?.total ?? 0) / 60;
  const codTotal = Number(cod?.amount ?? 0);
  const productionDue = Number(prod?.total ?? 0);

  const buckets: CashBucket[] = [7, 14, 30].map((days) => {
    // COD rải đều tới hạn đối soát thông thường; quá hạn đó thì coi như đã về hết trong kỳ.
    const codExpected = Math.round(codTotal * Math.min(1, days / Math.max(1, COD_OVERDUE_DAYS)));
    const adsPlanned = Math.round(adsPerDay * days);
    const opexPlanned = Math.round(opexPerDay * days);
    // Tiền hàng rơi vào kỳ 30 ngày: đơn đã gửi xưởng thường nhận và thanh toán trong tháng.
    const prodDue = days >= 30 ? productionDue : 0;
    return {
      days,
      label: `${days} ngày tới`,
      codExpected,
      adsPlanned,
      opexPlanned,
      productionDue: prodDue,
      net: codExpected - adsPlanned - opexPlanned - prodDue,
    };
  });

  return {
    buckets,
    workingCapital: {
      codReceivable: codTotal,
      codReceivableCount: Number(cod?.count ?? 0),
      codOverdue: Number(cod?.overdue ?? 0),
      inventoryValue: Math.round(Number(inv?.value ?? 0)),
      productionCommitted: productionDue,
    },
    basis: { adsPerDay: Math.round(adsPerDay), opexPerDay: Math.round(opexPerDay), codSettlementDays: COD_OVERDUE_DAYS },
    limitations: [
      "ERP KHÔNG có số dư ngân hàng: đây là dòng tiền RÒNG dự kiến (vào trừ ra), không phải số dư tài khoản.",
      "Không dự phóng tiền từ đơn CHƯA giao — đơn chưa giao thì chưa chắc thành tiền, và tỷ lệ hoàn đủ lớn để phép ngoại suy đó sai nghiêm trọng.",
      "Chi quảng cáo và chi vận hành dự phóng theo NHỊP THỰC TẾ đã chi, không theo kế hoạch — nhịp đổi thì con số đổi theo.",
      // Những dòng dưới đây chỉ hiện KHI dữ liệu thật sự thiếu — nói đúng cái đang thiếu, không nói chung chung.
      ...(Number(dayDu?.lenhSanXuat ?? 0) === 0
        ? ['"Tiền hàng đã cam kết với xưởng" đang là 0đ vì ERP CHƯA CÓ lệnh sản xuất nào, không phải vì shop chưa đặt hàng. Nhập lệnh sản xuất thì phần này mới có số.']
        : []),
      ...(Number(dayDu?.mauMaCoGia ?? 0) === 0
        ? [`Vốn tồn kho đang là 0đ vì KHÔNG mẫu mã nào có giá nhập (0/${Number(dayDu?.mauMaTong ?? 0)}). Đây là CHƯA BIẾT, không phải "hàng không đáng tiền".`]
        : [
            `Vốn tồn kho chỉ tính ${Number(dayDu?.mauMaCoGia ?? 0)}/${Number(dayDu?.mauMaTong ?? 0)} mẫu mã CÓ giá nhập; phần còn lại không được tính vào.`,
          ]),
      ...(Number(dayDu?.phieuNhap ?? 0) < 3
        ? [`Chỉ có ${Number(dayDu?.phieuNhap ?? 0)} phiếu nhập kho trong ERP, nên mọi con số dựa trên giá vốn ở đây đều đang được suy ngược.`]
        : []),
      ...(Number(dayDu?.khoanChi60Ngay ?? 0) === 0
        ? ["Nhịp chi vận hành đang là 0đ/ngày vì 60 ngày qua KHÔNG có khoản chi nào được ghi — dự phóng tiền ra vì thế đang thấp hơn thực tế."]
        : []),
    ],
  };
}

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import {
  MIN_CONVERSATIONS_FOR_RATE,
  PRE_ORDER_MARKERS,
  type ConversationCoverage,
  type EvidenceTier,
  type PreOrderMarkerKey,
} from "@/lib/constants/conversion";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ PHỄU TRƯỚC ĐƠN — ĐỌC BẰNG CHỨNG HỘI THOẠI ĐÃ GIỮ LẠI ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` · bảng: `conversation_funnel`.
 *
 * ─── LUẬT SỐ MỘT CỦA FILE NÀY: CHƯA QUÉT THÌ KHÔNG CÓ SỐ ───
 *
 * Bảng rỗng ⇒ mọi con số trả `null`, KHÔNG phải 0, và `sourceStatus = 'DATA_UNAVAILABLE'`.
 *
 * Vì sao phải viết thành luật thay vì để mặc định: một phễu trả 0 hội thoại và 40 đơn sẽ hiện tỷ lệ
 * chuyển "không xác định" hoặc tệ hơn là 4000%. Cả hai đều là số bịa, và số bịa trông như tin tốt là
 * loại sai tệ nhất. Job quét lùi 48 giờ nên hội thoại trước lần quét đầu KHÔNG TỒN TẠI trong CSDL —
 * đó là giới hạn của dữ liệu, không phải của shop.
 *
 * ─── PHỄU NÀY KHÔNG NỐI VÀO PHỄU ĐƠN ───
 *
 * Hai phễu đứng cạnh nhau, không thành một chuỗi. Mẫu số khác nhau về bản chất: hội thoại QUÉT ĐƯỢC
 * (cửa sổ 48 giờ, page có đơn trong 90 ngày, tối đa 200 hội thoại mỗi page) ≠ toàn bộ hội thoại. Nối
 * hai mẫu số khác nhau thành một phễu là dựng ra một tỷ lệ không mô tả cái gì.
 */

export type PreOrderMarker = {
  key: PreOrderMarkerKey;
  label: string;
  /** `null` = chưa có dữ liệu hội thoại. KHÔNG phải 0. */
  count: number | null;
  /** So với mốc đầu (0–1); `null` khi chưa có dữ liệu hoặc mẫu quá nhỏ. */
  ofStart: number | null;
  /** So với mốc liền trước (0–1); `null` như trên. */
  ofPrevious: number | null;
  previousLabel: string;
  dropOff: number | null;
  tier: EvidenceTier;
  caveat: string;
};

export type PreOrderFunnel = {
  markers: PreOrderMarker[];
  coverage: ConversationCoverage;
  /** Hội thoại đã thành đơn (ghép chắc chắn). `null` khi chưa có dữ liệu. */
  converted: number | null;
  /**
   * Hội thoại có SĐT nhiều đơn — KHÔNG kết luận được. Dòng RIÊNG, không gộp vào "chưa có đơn":
   * gộp vào là biến "không biết" thành "biết là chưa", đúng kiểu sai mà đặc tả cấm.
   */
  ambiguous: number | null;
  /** Hội thoại → đơn (0–1). `null` khi mẫu dưới ngưỡng hoặc chưa có dữ liệu. */
  conversionToOrder: number | null;
  /** Trung vị PHÚT từ tin đầu của khách tới tin trả lời đầu của shop. `null` khi không đo được. */
  medianFirstReplyMinutes: number | null;
  p90FirstReplyMinutes: number | null;
  /** Hội thoại khách nhắn mà CHƯA AI trả lời (trong kỳ). `null` khi chưa có dữ liệu. */
  unanswered: number | null;
  /** Trung vị GIỜ từ lúc đủ SĐT + địa chỉ tới lúc có đơn. `null` khi không đo được. */
  medianHoursToOrder: number | null;
};

function periodWhere(period: Period) {
  const from = period.from ? sql`and c.first_customer_message_at >= ${period.from.toISOString()}::timestamptz` : sql``;
  const to = period.to ? sql`and c.first_customer_message_at <= ${period.to.toISOString()}::timestamptz` : sql``;
  return sql`c.first_customer_message_at is not null ${from} ${to}`;
}

export async function getPreOrderFunnel(period: Period): Promise<PreOrderFunnel> {
  return memo(`preOrderFunnel:${periodKey(period)}`, 120_000, async () => {
    const db = await getDb();

    /*
      MỘT CÂU, HAI VẾ.

      `phu` đo ĐỘ PHỦ trên TOÀN BẢNG (không lọc kỳ): nó trả lời "ERP biết gì về hội thoại", và câu đó
      không phụ thuộc kỳ đang xem. `ky` đo các mốc TRONG kỳ.

      Tách ra vì nếu lọc kỳ cho cả hai thì một kỳ nằm ngoài khoảng quét sẽ trả về "0 hội thoại, độ phủ
      0" — đúng nhưng vô dụng; người đọc cần biết khoảng quét THẬT SỰ bắt đầu từ đâu để hiểu vì sao kỳ
      của họ trống.
    */
    const [phu] = rowsOf<{ tong: number; som_nhat: string | null; quet_cuoi: string | null; bi_cat: number }>(
      await db.execute(sql`
        select count(*)::int as tong,
               min(coalesce(first_customer_message_at, first_seen_at)) as som_nhat,
               max(last_scan_at) as quet_cuoi,
               count(*) filter (where truncated)::int as bi_cat
          from conversation_funnel
      `),
    );

    const tongBang = Number(phu?.tong ?? 0);
    const somNhat = phu?.som_nhat ? new Date(phu.som_nhat) : null;
    const quetCuoi = phu?.quet_cuoi ? new Date(phu.quet_cuoi) : null;

    /*
      KỲ CÓ ĐƯỢC PHỦ HAY KHÔNG.

      Phủ = đầu kỳ KHÔNG sớm hơn hội thoại sớm nhất ta ghi được. Kỳ "toàn bộ" (from = null) thì gần
      như chắc chắn KHÔNG phủ, vì shop có đơn từ tháng 1 mà việc ghi hội thoại chỉ bắt đầu từ hôm nay.
      Nói thẳng điều đó thay vì hiện một tỷ lệ.
    */
    const coPhu = tongBang > 0 && Boolean(somNhat) && Boolean(period.from) && period.from!.getTime() >= somNhat!.getTime();
    const sourceStatus: ConversationCoverage["sourceStatus"] = tongBang === 0 ? "DATA_UNAVAILABLE" : coPhu ? "HEALTHY" : "DEGRADED";
    const coverage: ConversationCoverage = {
      from: somNhat,
      lastScanAt: quetCuoi,
      conversations: tongBang,
      truncated: Number(phu?.bi_cat ?? 0),
      periodCovered: coPhu,
      sourceStatus,
      note:
        tongBang === 0
          ? "Chưa ghi được hội thoại nào. Job “Case CSKH từ hội thoại Pancake” (cs-chat) phải chạy ít nhất một lượt; trước đó bốn mốc trước đơn KHÔNG có số, và đó là sự thật chứ không phải lỗi hiển thị."
          : coPhu
            ? `Hội thoại được ghi từ ${somNhat?.toLocaleDateString("vi-VN")}. Kỳ đang xem nằm trong khoảng đã quét.`
            : `Hội thoại chỉ được ghi từ ${somNhat?.toLocaleDateString("vi-VN")}, MUỘN HƠN đầu kỳ đang xem. Tỷ lệ chuyển đổi từ hội thoại KHÔNG được công bố cho kỳ này: mẫu số thiếu phần đầu kỳ, chia ra sẽ được một con số cao giả tạo.`,
    };

    const emptyMarkers = PRE_ORDER_MARKERS.map((m, i) => ({
      key: m.key,
      label: m.label,
      count: null,
      ofStart: null,
      ofPrevious: null,
      previousLabel: i === 0 ? "chính nó" : PRE_ORDER_MARKERS[i - 1].label,
      dropOff: null,
      tier: m.tier,
      caveat: m.caveat,
    }));

    if (tongBang === 0) {
      return {
        markers: emptyMarkers,
        coverage,
        converted: null,
        ambiguous: null,
        conversionToOrder: null,
        medianFirstReplyMinutes: null,
        p90FirstReplyMinutes: null,
        unanswered: null,
        medianHoursToOrder: null,
      };
    }

    const [ky] = rowsOf<{
      nhan_tin: number;
      da_tra_loi: number;
      co_sdt: number;
      co_dia_chi: number;
      da_thanh_don: number;
      nhap_nhang: number;
      chua_tra_loi: number;
      phan_hoi_p50: string | number | null;
      phan_hoi_p90: string | number | null;
      toi_don_p50: string | number | null;
    }>(
      await db.execute(sql`
        select count(*)::int as nhan_tin,
               count(*) filter (where c.first_shop_reply_at is not null)::int as da_tra_loi,
               count(*) filter (where c.phone_at is not null)::int as co_sdt,
               count(*) filter (where c.address_at is not null)::int as co_dia_chi,
               -- CHỈ ghép CHẮC CHẮN mới tính là đã thành đơn; nhập nhằng đếm riêng.
               count(*) filter (where c.matched_order_id is not null and c.match_basis in ('BY_CONVERSATION','BY_PHONE_UNIQUE'))::int as da_thanh_don,
               count(*) filter (where c.match_basis = 'AMBIGUOUS')::int as nhap_nhang,
               count(*) filter (where c.first_shop_reply_at is null)::int as chua_tra_loi,
               percentile_cont(0.5) within group (
                 order by extract(epoch from (c.first_shop_reply_at - c.first_customer_message_at)) / 60
               ) filter (where c.first_shop_reply_at is not null and c.first_shop_reply_at >= c.first_customer_message_at) as phan_hoi_p50,
               percentile_cont(0.9) within group (
                 order by extract(epoch from (c.first_shop_reply_at - c.first_customer_message_at)) / 60
               ) filter (where c.first_shop_reply_at is not null and c.first_shop_reply_at >= c.first_customer_message_at) as phan_hoi_p90,
               -- Từ ĐỦ THÔNG TIN tới CÓ ĐƠN. Chỉ đo trên ca ghép chắc chắn và đơn lên SAU mốc đủ thông tin.
               percentile_cont(0.5) within group (
                 order by extract(epoch from (c.matched_order_at - c.info_complete_at)) / 3600
               ) filter (
                 where c.info_complete_at is not null and c.matched_order_at is not null
                   and c.matched_order_at >= c.info_complete_at
                   and c.match_basis in ('BY_CONVERSATION','BY_PHONE_UNIQUE')
               ) as toi_don_p50
          from conversation_funnel c
         where ${periodWhere(period)}
      `),
    );

    const counts: Record<PreOrderMarkerKey, number> = {
      MESSAGED: Number(ky?.nhan_tin ?? 0),
      ANSWERED: Number(ky?.da_tra_loi ?? 0),
      PHONE_CAPTURED: Number(ky?.co_sdt ?? 0),
      ADDRESS_CAPTURED: Number(ky?.co_dia_chi ?? 0),
    };
    const start = counts.MESSAGED;
    /*
      MẪU QUÁ NHỎ THÌ KHÔNG CÔNG BỐ TỶ LỆ.

      Ba hội thoại, một thành đơn thì "33%" là một con số thật về ba hội thoại và một con số vô nghĩa
      về shop. Trả `null` để màn hình hiện "—" kèm lý do.
    */
    const duMau = start >= MIN_CONVERSATIONS_FOR_RATE;
    const tyLe = (part: number, whole: number) => (duMau && whole > 0 ? part / whole : null);

    const markers: PreOrderMarker[] = PRE_ORDER_MARKERS.map((m, i) => {
      const count = counts[m.key];
      const prevKey = i === 0 ? m.key : PRE_ORDER_MARKERS[i - 1].key;
      const prev = counts[prevKey];
      return {
        key: m.key,
        label: m.label,
        count,
        ofStart: i === 0 ? (duMau ? 1 : null) : tyLe(count, start),
        ofPrevious: i === 0 ? (duMau ? 1 : null) : tyLe(count, prev),
        previousLabel: i === 0 ? "chính nó" : PRE_ORDER_MARKERS[i - 1].label,
        dropOff: i === 0 ? null : Math.max(0, prev - count),
        tier: m.tier,
        caveat: m.caveat,
      };
    });

    const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
    const converted = Number(ky?.da_thanh_don ?? 0);
    return {
      markers,
      coverage,
      converted,
      ambiguous: Number(ky?.nhap_nhang ?? 0),
      // Tỷ lệ chuyển CHỈ khi kỳ được phủ VÀ mẫu đủ lớn — hai điều kiện, không phải một.
      conversionToOrder: coPhu && duMau && start > 0 ? converted / start : null,
      medianFirstReplyMinutes: num(ky?.phan_hoi_p50),
      p90FirstReplyMinutes: num(ky?.phan_hoi_p90),
      unanswered: Number(ky?.chua_tra_loi ?? 0),
      medianHoursToOrder: num(ky?.toi_don_p50),
    };
  });
}

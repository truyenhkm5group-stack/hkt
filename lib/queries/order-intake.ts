import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CASE_SLA_HOURS, TEAM_LABEL, type CaseTeam } from "@/lib/constants/action-queue";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ KHÂU CHỐT ĐƠN: TỪ "ĐỦ THÔNG TIN" TỚI "CÓ ĐƠN" ═══════════
 *
 * Đây là KPI thật của khâu chốt, và trước đây không đo được vì định nghĩa sai: luật cũ gọi "đã
 * chốt" là bất kỳ hội thoại nào có shop nói chữ "chốt đơn" — kể cả trong câu MỜI chốt. 181 case,
 * phần lớn khách còn chưa cho số điện thoại.
 *
 * Định nghĩa đúng (chủ shop chốt 10/09/2026): **khách đã cho đủ SĐT và địa chỉ**, tương đương
 * trạng thái "đơn mới" trên Pancake. Từ đó mới có một phễu đo được:
 *
 *     khách cho đủ thông tin  →  có đơn trên Pancake
 *
 * ─── TIỀN: BA LOẠI, KHÔNG GỘP ───
 *
 *   `valueAtRisk`   SỰ THẬT chỉ khi đơn đã tồn tại. Với khách CHƯA có đơn thì KHÔNG có giá trị nào
 *                   để nói — chưa biết khách lấy mẫu gì, mấy cái. Trả `null`, không trả 0.
 *   ước tính        KHÔNG làm ở đây. Nhân số khách chờ với giá trị đơn trung bình sẽ ra một con số
 *                   nghe rất cụ thể mà không có gì đứng sau: người chưa chốt mẫu mã thì chưa có
 *                   giá trị nào, và tỷ lệ chuyển thì chưa đo đủ mẫu.
 *   `converted*`    SỰ THẬT, đo sau: case nào đủ thông tin rồi ĐÃ có đơn thật.
 *
 * ─── MỐC THỜI GIAN ───
 *
 * Dùng `info_complete_at` (lúc khách đưa đủ thông tin), KHÔNG dùng `created_at` (lúc job quét thấy).
 * Lấy `created_at` là đo tốc độ của JOB, không đo tốc độ của CSKH.
 */

/** Khâu này của đội CSKH — cùng sổ đăng ký với hàng đợi việc, không khai lại. */
const DOI: CaseTeam = "CS";

/** Hạn xử lý dùng chung với hàng đợi việc: `NEW_ORDER_UNPROCESSED` = 12 giờ. */
const SLA_GIO = CASE_SLA_HOURS.NEW_ORDER_UNPROCESSED ?? 12;

export type OrderIntakeMetrics = {
  /**
   * ⚠ ĐỌC CHO ĐÚNG PHẠM VI: đây là số ca ĐÃ TỪNG BỊ ĐÁNH DẤU "chờ lên đơn", KHÔNG phải toàn bộ
   * khách đủ thông tin.
   *
   * Khách đủ thông tin mà ĐÃ CÓ đơn ngay lúc quét thì không sinh case, nên không có mặt ở đây.
   * Đo trên production 11/09/2026: một lượt quét 7 ngày thấy 157 khách đủ thông tin, trong đó 136
   * đã có đơn — chỉ 21 ca còn lại mới có khả năng thành case.
   *
   * Tỷ lệ chuyển của CẢ KHÂU nằm ở báo cáo lượt quét (`syncPancakeChatCases`), không ở đây. Bảng
   * này trả lời câu hẹp hơn nhưng quan trọng hơn với người vận hành: **những ca ta đã đánh dấu là
   * đang chờ, bao lâu thì thành đơn, và bao nhiêu ca vẫn chưa.**
   */
  infoComplete: number;
  /** Trong số đó, đã có đơn được tạo SAU thời điểm đủ thông tin. */
  orderCreatedAfterInfo: number;
  /** Còn lại: đủ thông tin mà vẫn chưa có đơn. Đây là việc phải làm. */
  orderNotCreated: number;
  /** Tỷ lệ ca ĐÃ ĐÁNH DẤU về đích (0–1). KHÔNG phải tỷ lệ chuyển của cả khâu — xem `infoComplete`. */
  conversion: number | null;
  /** Giờ từ lúc đủ thông tin tới lúc có đơn — chỉ tính ca ĐÃ có đơn. `null` khi chưa có ca nào. */
  medianHoursToOrder: number | null;
  p90HoursToOrder: number | null;
  /** Ca chưa có đơn và đã quá hạn. */
  slaBreach: number;
  slaHours: number;
  /** Ca chưa có đơn, chưa ai nhận. */
  unassigned: number;
  owner: CaseTeam;
  ownerLabel: string;
  /**
   * Giá trị đơn của những ca ĐÃ chuyển thành đơn — SỰ THẬT, đo được.
   * Đây KHÔNG phải "tiền đang treo": tiền treo của khách chưa có đơn thì chưa tồn tại.
   */
  convertedOrderValue: number;
  /**
   * Vì sao không có "tiền đang treo" cho nhóm chưa tạo đơn. Hiện thẳng lên màn hình thay vì để
   * trống hoặc bịa một con số.
   */
  atRiskNote: string;
  windowDays: number;
};

export async function getOrderIntakeMetrics(windowDays = 30): Promise<OrderIntakeMetrics> {
  return memo(`order-intake:${windowDays}`, 120_000, async () => {
    const db = await getDb();

    /*
      MỘT CÂU, HAI VẾ.

      Vế `dc` (đã có đơn) nối case với đơn qua `conversation_id` — bằng chứng trực tiếp của Pancake.
      Cố ý KHÔNG ghép bằng SĐT ở đây: một SĐT có thể có nhiều đơn, và ghép bừa sẽ thổi tỷ lệ chuyển
      lên bằng những đơn của lần mua khác.

      `o.inserted_at >= c.info_complete_at` là điều kiện then chốt: đơn tạo TRƯỚC lúc khách cho đủ
      thông tin là đơn của lần mua cũ, không phải kết quả của lần chốt này.
    */
    const [row] = rowsOf<{
      info_complete: number;
      da_co_don: number;
      chua_co_don: number;
      tre_han: number;
      chua_ai_nhan: number;
      median_h: string | number | null;
      p90_h: string | number | null;
      gia_tri_da_chuyen: string | number;
    }>(
      await db.execute(sql`
        with ca as (
          select c.id,
                 c.info_complete_at,
                 c.assignee,
                 (select min(o.inserted_at)
                    from orders o
                   where o.conversation_id = c.conversation_id
                     and o.inserted_at >= c.info_complete_at
                     and o.stage not in ('CANCELLED','DELETED')) as don_luc,
                 (select min(o.total_price_after_discount)
                    from orders o
                   where o.conversation_id = c.conversation_id
                     and o.inserted_at >= c.info_complete_at
                     and o.stage not in ('CANCELLED','DELETED')) as gia_tri
            from cs_cases c
           where c.kind = 'ORDER_NOT_CREATED'
             and c.info_complete_at is not null
             and c.info_complete_at >= now() - make_interval(days => ${windowDays})
        )
        select count(*)::int as info_complete,
               count(*) filter (where don_luc is not null)::int as da_co_don,
               count(*) filter (where don_luc is null)::int as chua_co_don,
               count(*) filter (where don_luc is null
                                 and extract(epoch from (now() - info_complete_at)) / 3600 > ${SLA_GIO})::int as tre_han,
               count(*) filter (where don_luc is null and coalesce(assignee, '') = '')::int as chua_ai_nhan,
               percentile_cont(0.5) within group (order by extract(epoch from (don_luc - info_complete_at)) / 3600)
                 filter (where don_luc is not null) as median_h,
               percentile_cont(0.9) within group (order by extract(epoch from (don_luc - info_complete_at)) / 3600)
                 filter (where don_luc is not null) as p90_h,
               coalesce(sum(gia_tri) filter (where don_luc is not null), 0) as gia_tri_da_chuyen
          from ca
      `),
    );

    const infoComplete = Number(row?.info_complete ?? 0);
    const daCoDon = Number(row?.da_co_don ?? 0);
    const chuaCoDon = Number(row?.chua_co_don ?? 0);

    return {
      infoComplete,
      orderCreatedAfterInfo: daCoDon,
      orderNotCreated: chuaCoDon,
      conversion: infoComplete > 0 ? daCoDon / infoComplete : null,
      medianHoursToOrder: row?.median_h === null || row?.median_h === undefined ? null : Number(row.median_h),
      p90HoursToOrder: row?.p90_h === null || row?.p90_h === undefined ? null : Number(row.p90_h),
      slaBreach: Number(row?.tre_han ?? 0),
      slaHours: SLA_GIO,
      unassigned: Number(row?.chua_ai_nhan ?? 0),
      owner: DOI,
      ownerLabel: TEAM_LABEL[DOI],
      convertedOrderValue: Number(row?.gia_tri_da_chuyen ?? 0),
      atRiskNote:
        chuaCoDon > 0
          ? `${chuaCoDon} khách đã cho đủ SĐT và địa chỉ mà chưa có đơn. CHƯA quy ra tiền được: chưa biết khách lấy mẫu gì, mấy cái — nhân số khách với giá trị đơn trung bình sẽ ra một con số không có gì đứng sau.`
          : "Không khách nào đủ thông tin mà chưa có đơn.",
      windowDays,
    };
  });
}

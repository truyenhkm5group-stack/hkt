import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CASE_TYPE_LABEL, teamOf, TEAM_LABEL, type CaseTeam, type CaseType } from "@/lib/constants/action-queue";
import { conversionAgeLabel } from "@/lib/constants/conversion";
import {
  CASE_TYPE_TO_BUCKET,
  CONFIDENCE_RANK,
  LEAKAGE_ACTION,
  LEAKAGE_BUCKETS,
  LEAKAGE_BUCKET_LABEL,
  LEAKAGE_MAX_AGE_HOURS,
  LEAKAGE_SLA_HOURS,
  LEAKAGE_STAGE,
  MIN_CONFIDENCE,
  MIN_ORDERS_FOR_PAGE_MEDIAN,
  SUPPRESSION_LABEL,
  type LeakageBucket,
  type LeakageConfidence,
  type SuppressionReason,
  type ValueBasis,
} from "@/lib/constants/leakage";
import { RECOMMENDATION_CONFIDENCE } from "@/lib/constants/recommendation";
import { getActionQueue } from "@/lib/queries/action-queue";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ HÀNG ĐỢI RÒ RỈ DOANH THU ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` · hằng số: `lib/constants/leakage.ts`.
 *
 * Trả lời đúng một câu: **khách nào đang có khả năng mua mà sắp bị bỏ quên, và làm gì ngay.**
 *
 * ─── KHÔNG PHẢI MỘT HÀNG ĐỢI THỨ HAI ───
 *
 * Hai nhóm cuối (`UNCONFIRMED`, `NO_SHIPMENT`) đọc lại từ `getActionQueue()` — cùng bản ghi, cùng
 * người nhận, cùng hạn, cùng trạng thái tiếp nhận. Nếu tự truy vấn lại `orders` ở đây thì ai đó tiếp
 * nhận một việc trên trang Cần xử lý sẽ thấy nó vẫn "chưa ai nhận" ở trang này, và niềm tin vào cả
 * hai màn hình mất trong một buổi.
 *
 * Ba nhóm đầu đọc `conversation_funnel` vì ERP chưa từng có loại việc nào cho chúng.
 *
 * ─── MỌI LẦN LOẠI BỎ ĐỀU PHẢI ĐẾM ĐƯỢC ───
 *
 * `suppressed` nói rõ đã bỏ bao nhiêu ca và vì sao. Một hàng đợi lặng lẽ bỏ 200 ca là một hàng đợi
 * không ai kiểm chứng được — và đúng thứ đó đã từng xảy ra ở kho mã này với 181 case sai.
 */

export type LeakageCase = {
  id: string;
  bucket: LeakageBucket;
  bucketLabel: string;
  /** Bước phễu của ca này — hàng đợi và phễu dùng cùng một hệ quy chiếu. */
  stage: string;
  /** Ai đang cầm việc. `null` = CHƯA AI NHẬN — con số quan trọng nhất của một hàng đợi. */
  owner: string | null;
  team: CaseTeam;
  teamLabel: string;
  title: string;
  /** Bằng chứng: ca này từ đâu ra. Không có bằng chứng thì không phải việc. */
  evidence: string;
  /** Giờ kể từ mốc phát sinh. */
  ageHours: number;
  ageLabel: string;
  /** Đã quá hạn xử lý chưa. */
  breached: boolean;
  slaHours: number;
  nextAction: string;
  /** `null` = CHƯA BIẾT giá trị (khách chưa chốt mẫu mã). KHÔNG phải 0đ. */
  estimatedValue: number | null;
  valueBasis: ValueBasis;
  confidence: LeakageConfidence;
  /** Vì sao mức tin cậy là như vậy — để người đọc kiểm chứng, không phải tin vào nhãn. */
  confidenceReason: string;
  href: string;
};

export type LeakageBucketSummary = {
  bucket: LeakageBucket;
  label: string;
  stage: string;
  count: number;
  unassigned: number;
  breached: number;
  /** Tổng tiền của những ca có ĐƠN THẬT. Chỉ gồm `ACTUAL_ORDER`. */
  actualValue: number;
  /** Số ca KHÔNG quy ra tiền được. Hiện ra thay vì để tổng trông đầy đủ. */
  unknownValue: number;
  oldestHours: number;
};

export type LeakageQueue = {
  cases: LeakageCase[];
  buckets: LeakageBucketSummary[];
  /** Tiền treo ở các ca có đơn thật. SỰ THẬT, cộng được. */
  actualValueAtRisk: number;
  /**
   * Ước tính RIÊNG cho các ca chưa có đơn: số ca × trung vị đơn của page. Có nhãn, KHÔNG cộng vào
   * `actualValueAtRisk`. `null` khi không page nào đủ mẫu.
   */
  estimatedValueAtRisk: number | null;
  estimateBasis: string | null;
  /** Số ca không quy ra tiền được. */
  unknownValueCases: number;
  unassigned: number;
  breached: number;
  /** Đã bỏ bao nhiêu ca, vì lý do gì. Bắt buộc có — xem docblock. */
  suppressed: { reason: SuppressionReason; label: string; count: number }[];
  /** Nguồn hội thoại đã có dữ liệu chưa. `false` ⇒ ba nhóm đầu luôn rỗng, và đó không phải lỗi. */
  conversationDataAvailable: boolean;
};

type Raw = {
  id: string;
  bucket: LeakageBucket;
  owner: string | null;
  title: string;
  evidence: string;
  ageHours: number;
  estimatedValue: number | null;
  valueBasis: ValueBasis;
  confidence: LeakageConfidence;
  confidenceReason: string;
  href: string;
  caseType?: CaseType;
};

/** Đội phụ trách của nhóm hội thoại: khách đang chờ ở đầu kia ⇒ CSKH. */
const CONVERSATION_TEAM: CaseTeam = "CS";

export async function getSalesLeakageQueue(options: { limit?: number; bucket?: LeakageBucket } = {}): Promise<LeakageQueue> {
  const limit = options.limit ?? 200;
  return memo(`salesLeakage:${limit}:${options.bucket ?? "all"}`, 60_000, async () => {
    const db = await getDb();
    const suppressed = new Map<SuppressionReason, number>();
    const bump = (r: SuppressionReason, n = 1) => suppressed.set(r, (suppressed.get(r) ?? 0) + n);
    const raw: Raw[] = [];

    /* ─────────── 1. NHÓM HỘI THOẠI (đọc conversation_funnel) ─────────── */

    const [{ tong = 0 } = { tong: 0 }] = rowsOf<{ tong: number }>(await db.execute(sql`select count(*)::int as tong from conversation_funnel`));
    const conversationDataAvailable = Number(tong) > 0;

    /**
     * TRUNG VỊ GIÁ TRỊ ĐƠN GIAO THÀNH CÔNG THEO PAGE — dùng để ƯỚC TÍNH, có nhãn.
     *
     * Chỉ page có ít nhất `MIN_ORDERS_FOR_PAGE_MEDIAN` đơn giao thành công trong 90 ngày mới có số:
     * trung vị của 3 đơn là một con số thật về 3 đơn và một con số vô nghĩa về page.
     */
    const medianRows = conversationDataAvailable
      ? rowsOf<{ page_id: string; trung_vi: string | number | null; so_don: number }>(
          await db.execute(sql`
            select o.page_id,
                   percentile_cont(0.5) within group (order by o.total_price_after_discount) as trung_vi,
                   count(*)::int as so_don
              from orders o
             where o.page_id is not null
               and o.inserted_at >= now() - interval '90 days'
               and o.stage in ('DELIVERED','PAID')
             group by o.page_id
            having count(*) >= ${MIN_ORDERS_FOR_PAGE_MEDIAN}
          `),
        )
      : [];
    const pageMedian = new Map(medianRows.map((r) => [r.page_id, { value: Math.round(Number(r.trung_vi ?? 0)), sample: Number(r.so_don ?? 0) }]));

    if (conversationDataAvailable) {
      /*
        MỘT CÂU CHO CẢ BA NHÓM HỘI THOẠI.

        `da_co_case` là cái chặn báo hai lần: job `cs-chat` đã tạo case CSKH `ORDER_NOT_CREATED` cho
        đúng những hội thoại đủ thông tin mà chưa có đơn. Không chặn thì cùng một khách hiện ở cả
        trang CSKH lẫn trang này, và hai nơi đếm ra hai con số.
      */
      const rows = rowsOf<{
        id: string;
        page_id: string;
        conversation_id: string;
        customer_name: string;
        phone: string | null;
        owner_name: string;
        first_customer_message_at: string | null;
        first_shop_reply_at: string | null;
        last_customer_message_at: string | null;
        phone_at: string | null;
        address_at: string | null;
        info_complete_at: string | null;
        address_text: string;
        match_basis: string;
        matched_order_id: string | null;
        customer_message_count: number;
        phone_from_list: boolean;
        da_co_case: boolean;
        gio_cho: string | number;
      }>(
        await db.execute(sql`
          select c.id, c.page_id, c.conversation_id, c.customer_name, c.phone, c.owner_name,
                 c.first_customer_message_at, c.first_shop_reply_at, c.last_customer_message_at,
                 c.phone_at, c.address_at, c.info_complete_at, c.address_text,
                 c.match_basis, c.matched_order_id, c.customer_message_count,
                 coalesce((c.evidence ->> 'phoneFromPancakeList')::boolean, false) as phone_from_list,
                 exists (
                   select 1 from cs_cases cc
                    where cc.conversation_id = c.conversation_id
                      and cc.status in ('OPEN','IN_PROGRESS')
                 ) as da_co_case,
                 extract(epoch from (now() - coalesce(c.info_complete_at, c.phone_at, c.last_customer_message_at, c.first_customer_message_at))) / 3600 as gio_cho
            from conversation_funnel c
           where c.customer_message_count > 0
             and c.first_customer_message_at is not null
             -- Đã có đơn rồi thì không còn là rò rỉ. Nhập nhằng xử lý riêng bên dưới.
             and (c.matched_order_id is null or c.match_basis = 'AMBIGUOUS')
           order by coalesce(c.info_complete_at, c.phone_at, c.last_customer_message_at) desc
           limit 2000
        `),
      );

      for (const r of rows) {
        const ageHours = Math.max(0, Number(r.gio_cho ?? 0));
        /*
          NHẬP NHẰNG = KHÔNG KẾT LUẬN, và đó là lý do ca bị loại chứ không phải bị hạ tin cậy.

          Một SĐT nhiều đơn là chuyện thường (khách mua nhiều lần, số người nhận hộ). Đưa ca này vào
          hàng đợi là sai theo CẢ HAI hướng: gọi lại khách đã mua, hoặc im lặng bỏ sót một đơn thật.
        */
        if (r.match_basis === "AMBIGUOUS") {
          bump("AMBIGUOUS_MATCH");
          continue;
        }

        // Nhóm theo mốc XA NHẤT khách đã đi được: đủ thông tin > có SĐT > chưa được trả lời.
        let bucket: LeakageBucket | null = null;
        let evidence = "";
        let confidence: LeakageConfidence = RECOMMENDATION_CONFIDENCE.HIGH;
        let confidenceReason = "Mốc tin nhắn là chứng từ, không phải suy đoán.";

        if (r.info_complete_at) {
          bucket = "INFO_NO_ORDER";
          evidence = `SĐT ${r.phone ?? "?"} · địa chỉ: “${(r.address_text || "").slice(0, 120)}” · đủ thông tin ${conversionAgeLabel(ageHours)} trước.`;
          // Địa chỉ nhận bằng từ khoá hành chính ⇒ là suy đoán, hạ một bậc và NÓI RA.
          confidence = RECOMMENDATION_CONFIDENCE.MEDIUM;
          confidenceReason = "Địa chỉ nhận diện bằng từ chỉ đơn vị hành chính (thôn/xã/phường…), nên đây là suy đoán chứ không phải chứng từ.";
        } else if (r.phone_at || (r.phone && r.phone_from_list)) {
          bucket = "PHONE_NO_ORDER";
          evidence = `Khách đã cho SĐT ${r.phone ?? "?"}${r.phone_from_list ? " (Pancake tách sẵn, không có mốc thời gian)" : ""} · chưa có địa chỉ · chưa có đơn.`;
          confidence = r.phone_from_list ? RECOMMENDATION_CONFIDENCE.MEDIUM : RECOMMENDATION_CONFIDENCE.HIGH;
          confidenceReason = r.phone_from_list
            ? "SĐT do Pancake tách sẵn nên không biết khách cho lúc nào; tuổi ca tính từ tin nhắn cuối."
            : "Khách tự gửi SĐT trong tin của khách — chứng từ.";
        } else if (!r.first_shop_reply_at) {
          bucket = "NO_REPLY";
          evidence = `Khách gửi ${r.customer_message_count} tin, CHƯA AI trả lời. Chờ ${conversionAgeLabel(ageHours)}.`;
          confidence = RECOMMENDATION_CONFIDENCE.HIGH;
          confidenceReason = "Không có tin nào của shop sau tin đầu của khách — sự thật, không suy đoán.";
        }
        if (!bucket) continue;

        // Case CSKH đang mở cho đúng hội thoại này ⇒ đã có người theo, không báo lần hai.
        if (r.da_co_case) {
          bump("ALREADY_A_CASE");
          continue;
        }
        if (ageHours < LEAKAGE_SLA_HOURS[bucket]) {
          bump("NOT_YET_DUE");
          continue;
        }
        if (ageHours > LEAKAGE_MAX_AGE_HOURS[bucket]) {
          bump("TOO_OLD");
          continue;
        }
        if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[MIN_CONFIDENCE]) {
          bump("LOW_CONFIDENCE");
          continue;
        }

        /*
          TIỀN CỦA KHÁCH CHƯA CÓ ĐƠN: KHÔNG CÓ SỰ THẬT NÀO ĐỂ NÓI.

          Khách chưa chốt mẫu mã thì chưa có giá trị nào. Trung vị đơn của page chỉ nói "một đơn của
          page này thường đáng bao nhiêu" — có ích để xếp thứ tự, nhưng phải mang nhãn `PAGE_MEDIAN`
          và KHÔNG bao giờ cộng vào tổng tiền thật.
        */
        const med = pageMedian.get(r.page_id);
        raw.push({
          id: `conv:${r.id}`,
          bucket,
          owner: r.owner_name || null,
          title: `${r.customer_name || "Khách"}${r.phone ? ` · ${r.phone}` : ""}`,
          evidence,
          ageHours,
          estimatedValue: med ? med.value : null,
          valueBasis: med ? "PAGE_MEDIAN" : "UNKNOWN",
          confidence,
          confidenceReason,
          href: `https://pancake.vn/${r.page_id}?c_id=${r.conversation_id}`,
        });
      }
    }

    /* ─────────── 2. NHÓM ĐƠN HÀNG (đọc lại Hàng đợi việc) ─────────── */

    const queue = await getActionQueue({ limit: 500 });
    for (const c of queue.cases) {
      const bucket = CASE_TYPE_TO_BUCKET[c.type];
      if (!bucket) continue;
      if (c.ageHours > LEAKAGE_MAX_AGE_HOURS[bucket]) {
        bump("TOO_OLD");
        continue;
      }
      raw.push({
        id: `case:${c.id}`,
        bucket,
        owner: c.owner?.name ?? null,
        title: c.title,
        // Bằng chứng do chính Hàng đợi việc dựng — không viết lại, để hai màn hình nói cùng một câu.
        evidence: `${c.evidence.detail} (${c.evidence.source})`,
        ageHours: c.ageHours,
        // Đơn CÓ THẬT ⇒ tiền là SỰ THẬT, không phải ước tính.
        estimatedValue: c.financialImpact > 0 ? c.financialImpact : null,
        valueBasis: c.financialImpact > 0 ? "ACTUAL_ORDER" : "UNKNOWN",
        confidence: RECOMMENDATION_CONFIDENCE.HIGH,
        confidenceReason: `Đơn có thật trong ERP (${CASE_TYPE_LABEL[c.type]}).`,
        href: c.href,
        caseType: c.type,
      });
    }

    /* ─────────── 3. XẾP THỨ TỰ, TỔNG HỢP ─────────── */

    const filtered = options.bucket ? raw.filter((r) => r.bucket === options.bucket) : raw;
    /*
      XẾP THEO TIỀN THẬT TRƯỚC, RỒI TỚI TUỔI.

      Cố ý KHÔNG xếp theo ước tính: nếu ước tính được xếp ngang tiền thật thì thứ tự việc của cả hàng
      đợi sẽ do một con số suy ra quyết định, và không ai phát hiện được.
    */
    const cases: LeakageCase[] = filtered
      .sort((a, b) => {
        const av = a.valueBasis === "ACTUAL_ORDER" ? (a.estimatedValue ?? 0) : 0;
        const bv = b.valueBasis === "ACTUAL_ORDER" ? (b.estimatedValue ?? 0) : 0;
        return bv - av || b.ageHours - a.ageHours;
      })
      .slice(0, limit)
      .map((r) => {
        const sla = r.caseType ? LEAKAGE_SLA_HOURS[r.bucket] : LEAKAGE_SLA_HOURS[r.bucket];
        return {
          id: r.id,
          bucket: r.bucket,
          bucketLabel: LEAKAGE_BUCKET_LABEL[r.bucket],
          stage: LEAKAGE_STAGE[r.bucket],
          owner: r.owner,
          team: r.caseType ? teamOf(r.caseType) : CONVERSATION_TEAM,
          teamLabel: TEAM_LABEL[r.caseType ? teamOf(r.caseType) : CONVERSATION_TEAM],
          title: r.title,
          evidence: r.evidence,
          ageHours: Math.round(r.ageHours * 10) / 10,
          ageLabel: conversionAgeLabel(r.ageHours),
          breached: r.ageHours > sla,
          slaHours: sla,
          nextAction: LEAKAGE_ACTION[r.bucket],
          estimatedValue: r.estimatedValue,
          valueBasis: r.valueBasis,
          confidence: r.confidence,
          confidenceReason: r.confidenceReason,
          href: r.href,
        };
      });

    const buckets: LeakageBucketSummary[] = LEAKAGE_BUCKETS.map((b) => {
      const rows = cases.filter((c) => c.bucket === b);
      return {
        bucket: b,
        label: LEAKAGE_BUCKET_LABEL[b],
        stage: LEAKAGE_STAGE[b],
        count: rows.length,
        unassigned: rows.filter((c) => !c.owner).length,
        breached: rows.filter((c) => c.breached).length,
        actualValue: rows.filter((c) => c.valueBasis === "ACTUAL_ORDER").reduce((t, c) => t + (c.estimatedValue ?? 0), 0),
        unknownValue: rows.filter((c) => c.valueBasis === "UNKNOWN").length,
        oldestHours: rows.reduce((t, c) => Math.max(t, c.ageHours), 0),
      };
    }).filter((b) => b.count > 0 || conversationDataAvailable);

    const estimatedRows = cases.filter((c) => c.valueBasis === "PAGE_MEDIAN");
    const estimated = estimatedRows.reduce((t, c) => t + (c.estimatedValue ?? 0), 0);

    return {
      cases,
      buckets,
      actualValueAtRisk: cases.filter((c) => c.valueBasis === "ACTUAL_ORDER").reduce((t, c) => t + (c.estimatedValue ?? 0), 0),
      estimatedValueAtRisk: estimatedRows.length ? estimated : null,
      estimateBasis: estimatedRows.length
        ? `${estimatedRows.length} ca chưa có đơn × trung vị đơn giao thành công của đúng page (mẫu tối thiểu ${MIN_ORDERS_FOR_PAGE_MEDIAN} đơn/90 ngày). ĐÂY LÀ ƯỚC TÍNH: khách chưa chốt mẫu mã thì chưa có giá trị thật nào.`
        : null,
      unknownValueCases: cases.filter((c) => c.valueBasis === "UNKNOWN").length,
      unassigned: cases.filter((c) => !c.owner).length,
      breached: cases.filter((c) => c.breached).length,
      suppressed: [...suppressed.entries()].map(([reason, count]) => ({ reason, label: SUPPRESSION_LABEL[reason], count })).sort((a, b) => b.count - a.count),
      conversationDataAvailable,
    };
  });
}

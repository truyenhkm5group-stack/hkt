/**
 * ═══════════ ĐƠN → MARKETER: MỘT ĐƯỜNG, DÙNG LẠI MẮT XÍCH ĐÃ CÓ ═══════════
 *
 * Hợp đồng và lý lẽ ở `lib/constants/marketer-attribution.ts`. Tệp này chỉ dựng SQL.
 *
 * ─── VÌ SAO LÀ BẢNG NỐI CHỨ KHÔNG PHẢI BIỂU THỨC VÔ HƯỚNG ───
 *
 * Viết `(select … where campaign_id = ORDER_CAMPAIGN_ID)` thì mỗi dòng đơn phải chạy lại hai truy
 * vấn con có `group by … having` trên `fb_ads`. Báo cáo hoàn quét vài nghìn đơn, nên đó là vài
 * nghìn lần gộp lại cùng một bảng nhỏ. Kho mã này đã trả giá đúng kiểu đó một lần (sổ kho 39.960ms,
 * xem `PRIMARY_ATTEMPT`).
 *
 * `orderMarketerJoin()` trả về một mảnh `left join` gồm ba phép nối băm trên ba bảng nhỏ: mỗi bảng
 * được gộp ĐÚNG MỘT LẦN cho cả truy vấn. Kết quả giống hệt biểu thức vô hướng — cùng mắt xích,
 * cùng luật nhập nhằng.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { postKeySql } from "@/lib/queries/ads-identity-sql";
import { POST_TO_CAMPAIGN } from "@/lib/queries/ads-attribution-link";
import { listEmployees } from "@/lib/queries/payroll";
import {
  MARKETER_EVIDENCE,
  MARKETER_LINK_STATES,
  MARKETER_RESOLVED_STATES,
  MARKETER_UNRESOLVED,
  MARKETER_UNRESOLVED_LABEL,
  type MarketerCoverage,
  type MarketerEvidence,
  type MarketerLinkState,
} from "@/lib/constants/marketer-attribution";

/*
 * BÀI VIẾT → CHIẾN DỊCH dùng LẠI `POST_TO_CAMPAIGN` của `ads-attribution-link.ts` — cùng mắt xích
 * mà báo cáo ROAS đang chạy: bài được nhiều chiến dịch cùng chạy thì KHÔNG nối, nhập nhằng vẫn là
 * nhập nhằng. Chép một bản thứ hai ở đây là dựng hai định nghĩa cho cùng một quan hệ.
 */

/**
 * CHIẾN DỊCH → MARKETER, chỉ khi bảng chi tiêu khai ĐÚNG MỘT người cho chiến dịch đó.
 *
 * `count(distinct …) = 1` là cả luật chống nhập nhằng: một chiến dịch được hai người khai là chưa
 * ai quyết, và chọn bừa `min()` sẽ ghi tỷ lệ hoàn của người này lên thẻ điểm người kia.
 */
const CAMPAIGN_TO_MARKETER = sql`(
  select a.campaign_id as campaign_id, min(a.marketer_id) as marketer_id
    from ad_spends a
   where a.campaign_id is not null and coalesce(a.marketer_id, '') <> ''
   group by a.campaign_id
  having count(distinct a.marketer_id) = 1
)`;

/** Chiến dịch bị khai nhiều marketer — đếm riêng để nói ra tình trạng `AMBIGUOUS`. */
const CAMPAIGN_AMBIGUOUS = sql`(
  select a.campaign_id as campaign_id
    from ad_spends a
   where a.campaign_id is not null and coalesce(a.marketer_id, '') <> ''
   group by a.campaign_id
  having count(distinct a.marketer_id) > 1
)`;

/**
 * Mảnh `left join` gắn BỐN bảng tra vào một truy vấn đã có `orders`.
 *
 * `orderId`/`adId`/`postId` truyền vào để dùng được cả khi `orders` mang bí danh khác.
 * Sau khi nối, đọc `OM_MARKETER_ID`, `OM_EVIDENCE` và `OM_STATE`.
 *
 * ─── VÌ SAO ĐỌC `order_attributions` CHỨ KHÔNG TỰ TRA SỔ PHÂN CÔNG ───
 *
 * Sổ phân công có KHOẢNG HIỆU LỰC, nên tra đúng nó cần so mốc đơn với từng khoảng — một phép nối
 * bất đẳng thức trên mỗi dòng đơn. `order_attributions` đã là ẢNH CHỤP của chính phép tra ấy, MỘT
 * dòng cho MỘT đơn (`order_attribution_order_uq`), nên phép nối này không nhân dòng và không có
 * đường nào để hai báo cáo tra ra hai người khác nhau cho cùng một đơn.
 *
 * `marketer_id` ở đó chỉ khác `NULL` khi tình trạng là `ATTRIBUTED` (ràng buộc
 * `order_attribution_marketer_check`), nên không cần lọc thêm theo `status` — đơn TRÙNG và đơn
 * chưa gán được đều mang `NULL`, và đó là câu trả lời đúng của chúng.
 */
export function orderMarketerJoin(adId: SQL, postId: SQL, orderId: SQL): SQL {
  return sql`
    left join fb_ads om_ad on om_ad.id = ${adId}
    left join ${POST_TO_CAMPAIGN} om_post on om_post.post_id = ${postKeySql(postId)}
    left join ${CAMPAIGN_TO_MARKETER} om_marketer on om_marketer.campaign_id = coalesce(om_ad.campaign_id, om_post.campaign_id)
    left join ${CAMPAIGN_AMBIGUOUS} om_amb on om_amb.campaign_id = coalesce(om_ad.campaign_id, om_post.campaign_id)
    left join order_attributions om_fp on om_fp.order_id = ${orderId}`;
}

/** Chiến dịch đã nối được của đơn (sau `orderMarketerJoin`). `NULL` = không nối được. */
export const OM_CAMPAIGN_ID = sql<string | null>`coalesce(om_ad.campaign_id, om_post.campaign_id)`;

/**
 * Marketer của đơn — `NULL` nghĩa là CHƯA XÁC ĐỊNH, không phải "không ai".
 *
 * Thứ tự của `coalesce` ở đây LÀ `MARKETER_EVIDENCE_ORDER` (quảng cáo trước, fanpage lấp chỗ).
 * Đừng đảo nó ở một chỗ riêng lẻ: thứ tự được khai ở `lib/constants/marketer-attribution.ts` và
 * bảng lương đang khai ngược lại — xem khối đầu tệp hằng số trước khi đụng vào.
 */
export const OM_MARKETER_ID = sql<string | null>`coalesce(om_marketer.marketer_id, om_fp.marketer_id)`;

/** Loại bằng chứng đã dùng — `NULL` khi không quy kết được. Hai giá trị của `MarketerEvidence`. */
export const OM_EVIDENCE = sql<MarketerEvidence | null>`case
  when om_marketer.marketer_id is not null then 'AD_CAMPAIGN'
  when om_fp.marketer_id is not null then 'FANPAGE_ASSIGNMENT'
  else null end`;

/** Đơn mà HAI đường cùng lên tiếng nhưng nói HAI tên khác nhau. Phải đếm và in ra, không được nuốt. */
export const OM_CONFLICT = sql<boolean>`(om_marketer.marketer_id is not null and om_fp.marketer_id is not null and om_marketer.marketer_id <> om_fp.marketer_id)`;

/**
 * Khoá nhóm dùng để `group by`: marketer thật, hoặc nhóm "Chưa xác định". LUÔN khác `NULL` nên
 * không đơn nào rơi khỏi phép gộp — đó là điều giữ cho tổng theo marketer bằng tổng không chia.
 */
export const OM_GROUP_KEY = sql<string>`coalesce(om_marketer.marketer_id, om_fp.marketer_id, ${MARKETER_UNRESOLVED})`;

/**
 * Tình trạng quy kết — bảy giá trị của `MarketerLinkState`.
 *
 * Thứ tự các nhánh là thứ tự THẨM QUYỀN rồi tới thứ tự VIỆC PHẢI LÀM: quy kết được thì nói ngay
 * bằng đường nào; không quy kết được thì nêu chỗ trống CỤ THỂ NHẤT mà người đọc đi lấp được.
 * Nhánh `DUPLICATE_ORDER` đứng trước `NO_CAMPAIGN` vì đơn trùng KHÔNG phải một chỗ trống cần lấp —
 * nó là một kết luận đã có, và đẩy nó vào nhóm "chưa nối được" sẽ gửi người ta đi đồng bộ Facebook
 * để chữa một thứ không hỏng.
 */
export const OM_STATE = sql<MarketerLinkState>`case
  when om_marketer.marketer_id is not null then 'RESOLVED'
  when om_fp.marketer_id is not null then 'RESOLVED_BY_PAGE'
  when om_amb.campaign_id is not null then 'AMBIGUOUS'
  when coalesce(om_ad.campaign_id, om_post.campaign_id) is not null then 'CAMPAIGN_NO_MARKETER'
  when om_fp.status = 'DUPLICATE' then 'DUPLICATE_ORDER'
  when om_fp.status = 'NO_ASSIGNMENT' then 'PAGE_NO_ASSIGNMENT'
  else 'NO_CAMPAIGN' end`;

/** Tên hiển thị của marketer. Người đã bị xoá khỏi sổ nhân sự vẫn giữ mã để không mất lịch sử. */
export async function marketerNames(): Promise<Map<string, string>> {
  const list = await listEmployees();
  const m = new Map<string, string>();
  for (const e of list) m.set(e.id, e.shortName || e.name || e.id);
  return m;
}

export function marketerLabel(id: string | null, names: Map<string, string>): string {
  if (!id || id === MARKETER_UNRESOLVED) return MARKETER_UNRESOLVED_LABEL;
  return names.get(id) ?? `Marketer ${id}`;
}

/**
 * Danh sách marketer để dựng bộ lọc — chỉ những người ĐÃ có đơn quy kết được trong toàn bộ dữ liệu.
 *
 * Phải gộp CẢ HAI đường. Bỏ đường fanpage ra thì một marketer chỉ chạy page (không đứng tên chiến
 * dịch nào) biến mất khỏi ô lọc trong khi đơn của người ấy vẫn nằm trong bảng — bộ lọc khi đó nói
 * rằng người đó không tồn tại.
 */
export async function listAttributedMarketers(): Promise<{ id: string; label: string }[]> {
  return memo("marketers-attributed", 300_000, async () => {
    const db = await getDb();
    const rows = await db.execute(sql`
      select distinct cm.marketer_id as id
        from ${CAMPAIGN_TO_MARKETER} cm
       where exists (select 1 from fb_ads fa where fa.campaign_id = cm.campaign_id)
      union
      select distinct oa.marketer_id as id
        from order_attributions oa
       where oa.marketer_id is not null`);
    const names = await marketerNames();
    const list = (rows as unknown as { rows?: { id: string }[] }).rows ?? (rows as unknown as { id: string }[]);
    return [...list]
      .map((r) => ({ id: r.id, label: marketerLabel(r.id, names) }))
      .sort((a, b) => a.label.localeCompare(b.label, "vi"));
  });
}

/**
 * ĐỘ PHỦ QUY KẾT trên một tập đơn cho trước.
 *
 * `extraWhere` để nơi gọi áp đúng bộ lọc kỳ / mã hàng của chính báo cáo đang mở — độ phủ đo trên
 * một tập đơn KHÁC với tập đang hiện thì con số đó không nói gì về bảng người đọc đang nhìn.
 */
export async function marketerCoverage(extraWhere: SQL): Promise<MarketerCoverage> {
  const db = await getDb();
  const o = schema.orders;
  const rows = await db.execute(sql`
    select ${OM_STATE} as state, ${OM_EVIDENCE} as evidence, sum(case when ${OM_CONFLICT} then 1 else 0 end)::int as conflicts, count(*)::int as n
      from ${o}
      ${orderMarketerJoin(sql`${o.adId}`, sql`coalesce(${o.postId}, '')`, sql`${o.id}`)}
     where ${extraWhere}
     group by 1, 2`);
  type Row = { state: MarketerLinkState; evidence: MarketerEvidence | null; conflicts: number; n: number };
  const list = ((rows as unknown as { rows?: Row[] }).rows ?? (rows as unknown as Row[])) as Row[];
  return summarizeMarketerCoverage(list.map((r) => ({ state: r.state, evidence: r.evidence, conflicts: Number(r.conflicts), n: Number(r.n) })));
}

/**
 * Gộp các dòng đếm thành `MarketerCoverage`. Hàm THUẦN, tách ra để cả đường SQL lẫn đường đếm
 * trong bộ nhớ (`lib/queries/return-reason-report.ts`) dùng CHUNG một phép gộp — hai phép gộp là
 * hai con số độ phủ cùng đứng trên một màn hình.
 */
export function summarizeMarketerCoverage(rows: { state: MarketerLinkState; evidence: MarketerEvidence | null; conflicts: number; n: number }[]): MarketerCoverage {
  const byState = Object.fromEntries(MARKETER_LINK_STATES.map((s) => [s, 0])) as Record<MarketerLinkState, number>;
  const byEvidence = Object.fromEntries(MARKETER_EVIDENCE.map((e) => [e, 0])) as Record<MarketerEvidence, number>;
  let total = 0;
  let conflicts = 0;
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + r.n;
    if (r.evidence) byEvidence[r.evidence] += r.n;
    conflicts += r.conflicts;
    total += r.n;
  }
  const resolved = MARKETER_RESOLVED_STATES.reduce((n, s) => n + byState[s], 0);
  return { total, resolved, pct: total ? Math.round((resolved / total) * 1000) / 10 : null, byState, byEvidence, conflicts };
}

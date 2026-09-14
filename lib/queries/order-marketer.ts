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
  MARKETER_UNRESOLVED,
  MARKETER_UNRESOLVED_LABEL,
  type MarketerCoverage,
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
 * Mảnh `left join` gắn ba bảng tra vào một truy vấn đã có `orders`.
 *
 * `orderIdSql`/`adIdSql`/`postIdSql` truyền vào để dùng được cả khi `orders` mang bí danh khác.
 * Sau khi nối, đọc `om_marketer.marketer_id` và `om_state`.
 */
export function orderMarketerJoin(adId: SQL, postId: SQL): SQL {
  return sql`
    left join fb_ads om_ad on om_ad.id = ${adId}
    left join ${POST_TO_CAMPAIGN} om_post on om_post.post_id = ${postKeySql(postId)}
    left join ${CAMPAIGN_TO_MARKETER} om_marketer on om_marketer.campaign_id = coalesce(om_ad.campaign_id, om_post.campaign_id)
    left join ${CAMPAIGN_AMBIGUOUS} om_amb on om_amb.campaign_id = coalesce(om_ad.campaign_id, om_post.campaign_id)`;
}

/** Chiến dịch đã nối được của đơn (sau `orderMarketerJoin`). `NULL` = không nối được. */
export const OM_CAMPAIGN_ID = sql<string | null>`coalesce(om_ad.campaign_id, om_post.campaign_id)`;

/** Marketer của đơn — `NULL` nghĩa là CHƯA XÁC ĐỊNH, không phải "không ai". */
export const OM_MARKETER_ID = sql<string | null>`om_marketer.marketer_id`;

/**
 * Khoá nhóm dùng để `group by`: marketer thật, hoặc nhóm "Chưa xác định". LUÔN khác `NULL` nên
 * không đơn nào rơi khỏi phép gộp — đó là điều giữ cho tổng theo marketer bằng tổng không chia.
 */
export const OM_GROUP_KEY = sql<string>`coalesce(om_marketer.marketer_id, ${MARKETER_UNRESOLVED})`;

/** Tình trạng quy kết — bốn giá trị của `MarketerLinkState`. */
export const OM_STATE = sql<MarketerLinkState>`case
  when om_marketer.marketer_id is not null then 'RESOLVED'
  when om_amb.campaign_id is not null then 'AMBIGUOUS'
  when coalesce(om_ad.campaign_id, om_post.campaign_id) is not null then 'CAMPAIGN_NO_MARKETER'
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

/** Danh sách marketer để dựng bộ lọc — chỉ những người ĐÃ có đơn quy kết được trong toàn bộ dữ liệu. */
export async function listAttributedMarketers(): Promise<{ id: string; label: string }[]> {
  return memo("marketers-attributed", 300_000, async () => {
    const db = await getDb();
    const rows = await db.execute(sql`
      select distinct cm.marketer_id as id
        from ${CAMPAIGN_TO_MARKETER} cm
       where exists (select 1 from fb_ads fa where fa.campaign_id = cm.campaign_id)`);
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
    select ${OM_STATE} as state, count(*)::int as n
      from ${o}
      ${orderMarketerJoin(sql`${o.adId}`, sql`coalesce(${o.postId}, '')`)}
     where ${extraWhere}
     group by 1`);
  const list = ((rows as unknown as { rows?: { state: MarketerLinkState; n: number }[] }).rows ?? (rows as unknown as { state: MarketerLinkState; n: number }[])) as {
    state: MarketerLinkState;
    n: number;
  }[];
  const byState: Record<MarketerLinkState, number> = { RESOLVED: 0, NO_CAMPAIGN: 0, CAMPAIGN_NO_MARKETER: 0, AMBIGUOUS: 0 };
  let total = 0;
  for (const r of list) {
    const n = Number(r.n);
    byState[r.state] = n;
    total += n;
  }
  return { total, resolved: byState.RESOLVED, pct: total ? Math.round((byState.RESOLVED / total) * 1000) / 10 : null, byState };
}

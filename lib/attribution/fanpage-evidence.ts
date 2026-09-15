/**
 * ═══════════ BẰNG CHỨNG MỘT FANPAGE LỊCH SỬ TỪNG THUỘC VỀ AI ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * 7/15 fanpage chưa gán marketer, giữ 129 đơn treo. Không thể hỏi chủ shop từng page một — và cũng
 * KHÔNG được đoán: gán nhầm là ghi doanh thu của người này lên tên người kia.
 *
 * ─── BỐN NGUỒN ĐÃ DÒ, BA NGUỒN RỖNG (đo production 15/09/2026) ───
 *
 *   `settings["payroll.config"].pageMarketers`  — 0 khoá. Bảng gán phẳng cũ CHƯA BAO GIỜ được khai.
 *   `audit_logs` cho `payroll.config`           — 0 dòng. Không ai từng sửa nó.
 *   `orders.marketer_name` (Pancake gửi)        — rỗng trên CẢ 129 đơn.
 *   `orders.ad_id` → chiến dịch → marketer      — **112/129 đơn có `ad_id`**  ← nguồn DUY NHẤT còn lại
 *
 * ─── VÌ SAO ĐƯỜNG QUẢNG CÁO LÀ BẰNG CHỨNG THẬT, KHÔNG PHẢI PHỎNG ĐOÁN ───
 *
 * Nó dùng LẠI nguyên mắt xích mà báo cáo ROAS đang chạy (`lib/queries/order-marketer.ts`):
 * `orders.ad_id` → `fb_ads.campaign_id` → `ad_spends.marketer_id`, và chỉ nhận khi chiến dịch được
 * khai ĐÚNG MỘT marketer. Đó là khai báo của chính chủ shop về việc ai chạy chiến dịch nào — không
 * phải suy từ tên, không phải dò chữ.
 *
 * ─── HAI CỔNG, VÀ CỔNG THỨ HAI MỚI LÀ CỔNG KHÓ ───
 *
 *  1. **MỘT NGƯỜI DUY NHẤT.** Cả trang chỉ được trỏ về đúng một marketer. Hai người trở lên ⇒
 *     `AMBIGUOUS` ⇒ không gán gì cả.
 *  2. **CHỈ GÁN TỪ MỐC CÓ BẰNG CHỨNG.** `effective_from` = ngày SỚM NHẤT có bằng chứng, KHÔNG phải
 *     ngày đơn đầu tiên của page. Đơn nằm trước mốc ấy Ở LẠI trạng thái chưa quy kết.
 *
 * Cổng 2 sinh ra từ một ca thật: page `757928024065008` có đơn từ **19/08/2025**, nhưng bằng chứng
 * quảng cáo sớm nhất là **08/09/2026** — cách nhau MƯỜI BA THÁNG. Suy người phụ trách hôm nay
 * ngược về một năm trước là bịa. Nên 41 đơn trong cửa sổ có bằng chứng được gán, 3 đơn ngày
 * 19/08/2025 ở lại "chưa quy kết" — và đó là câu trả lời ĐÚNG, không phải một con số còn treo.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";

export const EVIDENCE_VERDICTS = ["PROVABLE", "AMBIGUOUS", "NO_EVIDENCE"] as const;
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

export const EVIDENCE_VERDICT_LABEL: Record<EvidenceVerdict, string> = {
  PROVABLE: "Có bằng chứng — gán được",
  AMBIGUOUS: "Nhiều marketer — KHÔNG gán",
  NO_EVIDENCE: "Không có bằng chứng nào",
};

/** Một đơn của page chưa gán, kèm marketer mà đường quảng cáo nối được (nếu có). */
export type EvidenceOrder = { pageId: string; orderAt: Date; marketerId: string | null };

export type PageEvidence = {
  pageId: string;
  verdict: EvidenceVerdict;
  /** Chỉ khác `null` khi `PROVABLE`. */
  marketerId: string | null;
  /** Mốc hiệu lực đề nghị = ngày sớm nhất CÓ BẰNG CHỨNG. `null` khi không gán được. */
  effectiveFrom: Date | null;
  totalOrders: number;
  ordersWithEvidence: number;
  /** Đơn nằm TRƯỚC mốc hiệu lực — sẽ vẫn chưa quy kết, và đó là kết quả đúng. */
  ordersBeforeEvidence: number;
  distinctMarketers: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
};

/** Đầu ngày theo giờ Việt Nam — mốc hiệu lực phải trùm trọn cái ngày có bằng chứng. */
function vnStartOfDay(d: Date): Date {
  const vn = new Date(d.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000);
}

/**
 * CHẤM BẰNG CHỨNG CHO TỪNG PAGE — hàm THUẦN, không đọc CSDL, không đọc đồng hồ.
 *
 * Tất định: chỉ phụ thuộc dữ liệu vào. Chạy lại bao nhiêu lần cũng ra một kết quả.
 */
export function judgePageEvidence(orders: EvidenceOrder[]): PageEvidence[] {
  const byPage = new Map<string, EvidenceOrder[]>();
  for (const o of orders) {
    const list = byPage.get(o.pageId);
    if (list) list.push(o);
    else byPage.set(o.pageId, [o]);
  }
  const out: PageEvidence[] = [];
  for (const [pageId, list] of byPage) {
    const withEvidence = list.filter((o) => o.marketerId);
    const marketers = new Set(withEvidence.map((o) => o.marketerId as string));
    const times = list.map((o) => o.orderAt.getTime());
    const base = {
      pageId,
      totalOrders: list.length,
      ordersWithEvidence: withEvidence.length,
      distinctMarketers: marketers.size,
      firstOrderAt: times.length ? new Date(Math.min(...times)) : null,
      lastOrderAt: times.length ? new Date(Math.max(...times)) : null,
    };
    if (marketers.size === 0) {
      out.push({ ...base, verdict: "NO_EVIDENCE", marketerId: null, effectiveFrom: null, ordersBeforeEvidence: 0 });
      continue;
    }
    if (marketers.size > 1) {
      out.push({ ...base, verdict: "AMBIGUOUS", marketerId: null, effectiveFrom: null, ordersBeforeEvidence: 0 });
      continue;
    }
    const from = vnStartOfDay(new Date(Math.min(...withEvidence.map((o) => o.orderAt.getTime()))));
    out.push({
      ...base,
      verdict: "PROVABLE",
      marketerId: [...marketers][0],
      effectiveFrom: from,
      ordersBeforeEvidence: list.filter((o) => o.orderAt.getTime() < from.getTime()).length,
    });
  }
  // Tất định cả ở THỨ TỰ trả về — báo cáo chạy thử hai lần phải in ra hai bảng giống hệt nhau.
  return out.sort((a, b) => b.totalOrders - a.totalOrders || (a.pageId < b.pageId ? -1 : 1));
}

/**
 * Đọc đơn của MỌI fanpage CHƯA có phân công nào còn hiệu lực, kèm marketer nối được qua quảng cáo.
 *
 * Mắt xích chiến dịch → marketer dùng LẠI luật chống nhập nhằng của `lib/queries/order-marketer.ts`:
 * chiến dịch bị khai hai người trở lên thì KHÔNG nối — nhập nhằng vẫn là nhập nhằng.
 */
export async function readUnmappedPageEvidence(db?: Db): Promise<PageEvidence[]> {
  const d = db ?? (await getDb());
  const rows = await d.execute(sql`
    with um as (
      select f.external_page_id
        from ${schema.fanpages} f
       where not exists (
         select 1 from ${schema.fanpageMarketerAssignments} a
          where a.fanpage_id = f.id and a.active
       )
    ),
    cm as (
      select a.campaign_id, min(a.marketer_id) as marketer_id
        from ${schema.adSpends} a
       where a.campaign_id is not null and coalesce(a.marketer_id, '') <> ''
       group by a.campaign_id
      having count(distinct a.marketer_id) = 1
    )
    select o.page_id as page_id, o.inserted_at as order_at, cm.marketer_id as marketer_id
      from ${schema.orders} o
      join um on um.external_page_id = o.page_id
      left join ${schema.fbAds} fa on fa.id = o.ad_id
      left join cm on cm.campaign_id = fa.campaign_id
  `);
  const list = ((rows as unknown as { rows?: Record<string, unknown>[] }).rows ?? (rows as unknown as Record<string, unknown>[])) as {
    page_id: string;
    order_at: string | Date;
    marketer_id: string | null;
  }[];
  return judgePageEvidence(
    list.map((r) => ({ pageId: r.page_id, orderAt: new Date(r.order_at), marketerId: r.marketer_id ?? null })),
  );
}

export type EvidenceBackfillResult = {
  applied: boolean;
  pages: PageEvidence[];
  created: number;
  skipped: number;
};

/**
 * TẠO PHÂN CÔNG TỪ BẰNG CHỨNG. Mặc định CHẠY THỬ — `apply: true` mới ghi.
 *
 * Idempotent: chỉ tạo cho page CHƯA có phân công nào còn hiệu lực, nên chạy lại lần hai không tạo
 * thêm dòng nào. Mỗi dòng ghi lại CĂN CỨ vào `note` — sáu tháng sau vẫn đọc được vì sao page này
 * về tay người này.
 */
export async function backfillAssignmentsFromEvidence(options?: { apply?: boolean; actorUserId?: string | null; db?: Db }): Promise<EvidenceBackfillResult> {
  const d = options?.db ?? (await getDb());
  const pages = await readUnmappedPageEvidence(d);
  let created = 0;
  let skipped = 0;
  for (const p of pages) {
    if (p.verdict !== "PROVABLE" || !p.marketerId || !p.effectiveFrom) {
      skipped++;
      continue;
    }
    if (!options?.apply) {
      created++;
      continue;
    }
    const [page] = await d.select({ id: schema.fanpages.id }).from(schema.fanpages).where(eq(schema.fanpages.externalPageId, p.pageId)).limit(1);
    if (!page) {
      skipped++;
      continue;
    }
    // Chặn lần hai: page đã có phân công còn hiệu lực thì thôi. `readUnmappedPageEvidence` đã lọc,
    // nhưng kiểm lại ngay trước khi ghi là thứ giữ cho hai lượt chạy song song không tạo hai dòng.
    const existing = await d
      .select({ id: schema.fanpageMarketerAssignments.id })
      .from(schema.fanpageMarketerAssignments)
      .where(and(eq(schema.fanpageMarketerAssignments.fanpageId, page.id), eq(schema.fanpageMarketerAssignments.active, true)))
      .limit(1);
    if (existing.length) {
      skipped++;
      continue;
    }
    await d.insert(schema.fanpageMarketerAssignments).values({
      fanpageId: page.id,
      marketerId: p.marketerId,
      effectiveFrom: p.effectiveFrom,
      createdByUserId: options?.actorUserId ?? null,
      note: `Backfill từ bằng chứng quảng cáo: ${p.ordersWithEvidence}/${p.totalOrders} đơn nối được về đúng 1 marketer qua ad_id → chiến dịch. Hiệu lực từ ngày sớm nhất CÓ bằng chứng; ${p.ordersBeforeEvidence} đơn trước mốc đó cố ý để chưa quy kết.`,
    });
    created++;
  }
  return { applied: options?.apply === true, pages, created, skipped };
}

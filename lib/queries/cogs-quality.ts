import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { CANONICAL_OUTCOME_VERSION } from "@/lib/constants/canonical-outcome";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ CHẤT LƯỢNG GIÁ VỐN: BA HẠNG, KHÔNG PHẢI MỘT CON SỐ ═══════
 *
 * Báo cáo lợi nhuận hiện đưa ra MỘT con số giá vốn, và người đọc không có cách nào biết phần nào
 * dựa trên chứng từ, phần nào là suy ngược. Hai thứ đó có độ tin cậy khác hẳn nhau nhưng trông y hệt.
 *
 * Đo trên production 10/09/2026: 407 đơn đã giao, **368 đơn (58.049.000đ) mang căn cứ suy ngược** —
 * phiếu nhập được lập SAU ngày giao. Nghĩa là gần 90% giá vốn lịch sử là phỏng đoán, và không có
 * dấu hiệu nào trên màn hình nói ra điều đó.
 *
 * BA HẠNG, và ranh giới giữa chúng là CHỨNG TỪ, không phải cảm tính:
 *
 *  · `VERIFIED`      — có phiếu nhập kho lập TRƯỚC hoặc ĐÚNG ngày giao. Giá vốn truy nguyên được.
 *  · `RECONSTRUCTED` — chỉ có phiếu nhập lập SAU ngày giao. Con số suy ngược từ giá của tương lai.
 *  · `UNVERIFIED`    — không có phiếu nhập nào cho mẫu mã đó. Giá vốn rơi về giá Pancake / giá nhập
 *                      mẫu mã, hoặc bằng 0 — và 0 ở đây nghĩa là CHƯA BIẾT.
 *
 * KHÔNG hàm nào ở đây SỬA giá vốn. Hợp đồng ghi nhận (docs/cogs-recognition-contract.md) đã chốt:
 * không dựng lại lịch sử khi chưa có chứng từ mạnh hơn, vì dựng lại sẽ đưa 368 đơn về 0đ và thổi
 * lợi nhuận lịch sử lên 58 triệu — sai nặng hơn hiện tại, và sai theo hướng dễ chịu.
 */

export const COGS_QUALITY = ["VERIFIED", "RECONSTRUCTED", "UNVERIFIED"] as const;
export type CogsQuality = (typeof COGS_QUALITY)[number];

export const COGS_QUALITY_LABEL: Record<CogsQuality, string> = {
  VERIFIED: "Có chứng từ",
  RECONSTRUCTED: "Suy ngược",
  UNVERIFIED: "Chưa xác minh",
};

export const COGS_QUALITY_NOTE: Record<CogsQuality, string> = {
  VERIFIED: "Có phiếu nhập kho lập trước hoặc đúng ngày giao — giá vốn truy nguyên được về chứng từ.",
  RECONSTRUCTED: "Chỉ có phiếu nhập lập SAU ngày giao, nên giá vốn đang được suy ngược từ giá của tương lai.",
  UNVERIFIED: "Không có phiếu nhập nào cho mẫu mã của đơn. Giá vốn rơi về nguồn yếu hơn hoặc bằng 0 — 0 ở đây là CHƯA BIẾT.",
};

export type CogsQualityRow = { quality: CogsQuality; orders: number; amount: number; share: number };

export type CogsCoverage = {
  deliveredOrders: number;
  deliveredCogs: number;
  rows: CogsQualityRow[];
  /** Tỷ lệ GIÁ VỐN (theo tiền) có chứng từ. Đây là con số trả lời "tin được bao nhiêu phần". */
  verifiedShare: number;
  /** Đơn đã giao mà chưa chốt được giá vốn — lỗ hổng của chính lớp ghi nhận, khác với thiếu chứng từ. */
  notRecognized: number;
  /** Cách sửa thật, nói bằng lời để người đọc biết phải làm gì chứ không chỉ biết là đang sai. */
  huongSua: string;
};

/**
 * Xếp hạng giá vốn theo `cogs_basis` đã chốt lúc ghi nhận.
 *
 * Dùng cột ĐÃ CHỐT chứ không tính lại: căn cứ được xác định tại thời điểm giao và đóng băng cùng
 * `recognized_cogs`. Tính lại hôm nay sẽ cho ra câu trả lời khác khi kho vừa nhập thêm phiếu — tức
 * là chính cái bệnh mà việc đóng băng sinh ra để chữa.
 */
const HANG = sql`case
  when m.cogs_basis = 'RECEIPT_BEFORE' then 'VERIFIED'
  when m.cogs_basis = 'RECEIPT_AFTER' then 'RECONSTRUCTED'
  else 'UNVERIFIED'
end`;

export async function getCogsCoverage(period: Period | null = null): Promise<CogsCoverage> {
  return memo(`cogsCoverage:${period ? periodKey(period) : "all"}`, 120_000, () => build(period));
}

async function build(period: Period | null): Promise<CogsCoverage> {
  const db = await getDb();
  const from = period?.from ? sql`and o.inserted_at >= ${period.from}` : sql``;
  const to = period?.to ? sql`and o.inserted_at <= ${period.to}` : sql``;

  const rows = await db.execute(sql`
    select (${HANG}) as quality,
           -- GRAIN ĐƠN: một đơn gửi lại nhiều lần vẫn là MỘT đơn đã giao, không phải hai.
           count(distinct m.order_id)::int as orders,
           coalesce(sum(coalesce(m.recognized_cogs, m.cogs, 0)), 0)::bigint as amount
    from canonical_order_outcome m
    join orders o on o.id = m.order_id
    where m.outcome::text = 'DELIVERED'
      and m.logic_version = ${CANONICAL_OUTCOME_VERSION}
      ${from} ${to}
    group by 1
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as { quality: string; orders: number; amount: string | number }[];

  const [chuaChot] = await db.execute(sql`
    select count(distinct m.order_id)::int as n
    from canonical_order_outcome m
    join orders o on o.id = m.order_id
    where m.outcome::text = 'DELIVERED' and m.recognized_cogs is null ${from} ${to}
  `).then((r) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as { n: number }[]);

  const byQuality = new Map(list.map((r) => [r.quality as CogsQuality, { orders: Number(r.orders ?? 0), amount: Number(r.amount ?? 0) }]));
  const deliveredOrders = [...byQuality.values()].reduce((t, v) => t + v.orders, 0);
  const deliveredCogs = [...byQuality.values()].reduce((t, v) => t + v.amount, 0);

  const qualityRows: CogsQualityRow[] = COGS_QUALITY.map((q) => {
    const v = byQuality.get(q) ?? { orders: 0, amount: 0 };
    return { quality: q, orders: v.orders, amount: v.amount, share: deliveredCogs ? v.amount / deliveredCogs : 0 };
  });

  const verified = byQuality.get("VERIFIED")?.amount ?? 0;
  const suyNguoc = byQuality.get("RECONSTRUCTED")?.orders ?? 0;

  return {
    deliveredOrders,
    deliveredCogs,
    rows: qualityRows,
    verifiedShare: deliveredCogs ? verified / deliveredCogs : 0,
    notRecognized: Number(chuaChot?.n ?? 0),
    huongSua: suyNguoc
      ? `Nhập phiếu nhập kho cũ với NGÀY NHẬP THẬT cho ${suyNguoc} đơn đang suy ngược. Có chứng từ thì căn cứ tự chuyển sang “có chứng từ”, không cần đụng mã và không đơn nào bị sửa số.`
      : "Mọi đơn đã giao đều có phiếu nhập lập trước ngày giao — giá vốn truy nguyên được.",
  };
}

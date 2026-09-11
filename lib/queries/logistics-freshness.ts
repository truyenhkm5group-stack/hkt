import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import {
  CAPABILITY_LABEL,
  FRESHNESS_BY_STAGE,
  FRESHNESS_DEFAULT,
  FRESHNESS_LABEL,
  classifyFreshness,
  thresholdFor,
  type FreshnessClass,
  type TrackingCapability,
} from "@/lib/constants/logistics-freshness";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ ĐỘ TƯƠI CỦA TRẠNG THÁI VẬN ĐƠN ═══════════
 *
 * ─── MỘT SỬA SAI PHẢI NÓI RÕ ───
 *
 * Bản đầu của bộ đo này dùng `shipments.last_vtp_sync_at` — "lần cuối ERP tra cứu". Con số đó VÔ
 * NGHĨA ở đây: đo được nguồn `VTP_POLL` sinh ra **0 sự kiện từ trước tới nay**, nên một lần tra
 * cứu không làm dữ liệu tươi thêm một giây nào. Nó chỉ nói "ta có gọi API", không nói "ta có biết
 * kiện hàng đang ở đâu".
 *
 * Độ tươi thật đo từ **SỰ KIỆN ĐVVC gần nhất** — webhook Viettel Post hoặc sự kiện Pancake chuyển
 * tiếp. Đó là thứ duy nhất thật sự mang tin mới về kiện hàng.
 *
 * ─── ĐỘ TƯƠI KHÔNG BAO GIỜ ĐỔI KẾT LUẬN ĐƠN ───
 *
 * Đây là ranh giới không được vượt. Một vận đơn im lặng 8 giờ vẫn giữ nguyên kết quả theo chứng từ
 * cuối cùng của nó; ERP chỉ nói thêm "số liệu này cũ". Suy ra "chắc đã giao" hay "chắc đã hoàn" từ
 * sự im lặng là bịa ra một sự kiện chưa từng xảy ra — đúng thứ `ORDER_OUTCOME` cấm.
 *
 * Mô-đun này KHÔNG import `ORDER_OUTCOME` và không ghi gì. Nó chỉ đọc và xếp hạng.
 * `tests/logistics-freshness.test.ts` khoá điều đó ở mức mã nguồn.
 */

/** Sự kiện MANG TIN MỚI về kiện hàng. `VTP_POLL` không nằm ở đây vì nó chưa từng sinh ra sự kiện nào. */
const NGUON_CHUYEN_PHAT = sql`e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION')`;

export type StageFreshness = {
  stage: string;
  inFlight: number;
  /** Số giờ trung vị kể từ sự kiện ĐVVC gần nhất. `null` khi không kiện nào có sự kiện. */
  medianAgeHours: number | null;
  oldestAgeHours: number | null;
  byClass: Record<FreshnessClass, number>;
  /** Ngưỡng đang áp cho chặng này, để người đọc kiểm chứng được con số. */
  agingHours: number;
  criticalHours: number;
  why: string;
};

export type LogisticsFreshness = {
  inFlight: number;
  byClass: Record<FreshnessClass, number>;
  stages: StageFreshness[];
  byCapability: { capability: TrackingCapability; label: string; count: number }[];
  /** Webhook còn sống không: sự kiện nhận được trong 1 giờ / 24 giờ gần nhất. */
  webhookLastHour: number;
  webhookLast24h: number;
  webhookLastAt: Date | null;
  pancakeLast24h: number;
  /** Lượt tra cứu API liên tiếp không thấy vận đơn nào. */
  apiBlindStreak: number;
  measuredAt: Date;
};

const RONG: Record<FreshnessClass, number> = { FRESH: 0, AGING: 0, STALE: 0, CRITICAL_STALE: 0 };

export async function getLogisticsFreshness(): Promise<LogisticsFreshness> {
  return memo("logistics-freshness", 60_000, async () => {
    const db = await getDb();

    /*
      MỘT CÂU CHO TOÀN BỘ: tuổi của từng kiện đang chạy, kèm chặng và khả năng tra cứu.

      Tính tuổi trong SQL rồi xếp hạng trong ứng dụng — ngưỡng theo chặng nằm ở hằng số dùng chung,
      và nhúng chúng vào SQL sẽ tạo ra bản sao thứ hai của bảng ngưỡng.
    */
    const rows = rowsOf<{ stage: string; capability: TrackingCapability; tuoi_gio: string | number | null }>(
      await db.execute(sql`
        select s.stage::text as stage,
               s.tracking_capability as capability,
               extract(epoch from (now() - (
                 select max(e.occurred_at) from shipment_events e
                  where e.shipment_id = s.id and ${NGUON_CHUYEN_PHAT}
               ))) / 3600 as tuoi_gio
          from shipments s
         where s.order_id is not null and s.is_final = false
      `),
    );

    const [dem] = rowsOf<{ wh_1h: number; wh_24h: number; wh_last: string | null; pk_24h: number }>(
      await db.execute(sql`
        select count(*) filter (where source = 'VTP_WEBHOOK' and created_at > now() - interval '1 hour')::int as wh_1h,
               count(*) filter (where source = 'VTP_WEBHOOK' and created_at > now() - interval '24 hours')::int as wh_24h,
               max(created_at) filter (where source = 'VTP_WEBHOOK') as wh_last,
               count(*) filter (where source = 'PANCAKE' and created_at > now() - interval '24 hours')::int as pk_24h
          from shipment_events
      `),
    );

    const [scope] = rowsOf<{ streak: number }>(
      await db.execute(sql`select coalesce((value ->> 'missingStreak')::int, 0) as streak from sync_state where key = 'vtp:api-scope'`),
    );

    const tongTheoHang: Record<FreshnessClass, number> = { ...RONG };
    const theoChang = new Map<string, { tuoi: number[]; byClass: Record<FreshnessClass, number> }>();
    const theoKhaNang = new Map<TrackingCapability, number>();

    for (const r of rows) {
      const gio = r.tuoi_gio === null || r.tuoi_gio === undefined ? null : Number(r.tuoi_gio);
      const hang = classifyFreshness(gio, r.stage);
      tongTheoHang[hang] += 1;
      theoKhaNang.set(r.capability, (theoKhaNang.get(r.capability) ?? 0) + 1);
      const cur = theoChang.get(r.stage) ?? { tuoi: [], byClass: { ...RONG } };
      cur.byClass[hang] += 1;
      if (gio !== null) cur.tuoi.push(gio);
      theoChang.set(r.stage, cur);
    }

    const trungVi = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

    const stages: StageFreshness[] = [...theoChang.entries()]
      .map(([stage, v]) => {
        const t = thresholdFor(stage);
        return {
          stage,
          inFlight: Object.values(v.byClass).reduce((a, b) => a + b, 0),
          medianAgeHours: trungVi(v.tuoi),
          oldestAgeHours: v.tuoi.length ? Math.max(...v.tuoi) : null,
          byClass: v.byClass,
          agingHours: t.aging,
          criticalHours: t.critical,
          why: t.why,
        };
      })
      // Xếp theo mức độ nghiêm trọng, không theo bảng chữ cái: chặng nhiều kiện cũ nghiêm trọng lên đầu.
      .sort((a, b) => b.byClass.CRITICAL_STALE - a.byClass.CRITICAL_STALE || b.byClass.STALE - a.byClass.STALE || b.inFlight - a.inFlight);

    return {
      inFlight: rows.length,
      byClass: tongTheoHang,
      stages,
      byCapability: [...theoKhaNang.entries()]
        .map(([capability, count]) => ({ capability, label: CAPABILITY_LABEL[capability] ?? capability, count }))
        .sort((a, b) => b.count - a.count),
      webhookLastHour: Number(dem?.wh_1h ?? 0),
      webhookLast24h: Number(dem?.wh_24h ?? 0),
      webhookLastAt: dem?.wh_last ? new Date(dem.wh_last) : null,
      pancakeLast24h: Number(dem?.pk_24h ?? 0),
      apiBlindStreak: Number(scope?.streak ?? 0),
      measuredAt: new Date(),
    };
  });
}

/** Nhãn ngắn cho một hạng độ tươi — dùng chung giữa các màn hình. */
export function freshnessLabel(c: FreshnessClass): string {
  return FRESHNESS_LABEL[c];
}

export { FRESHNESS_BY_STAGE, FRESHNESS_DEFAULT };

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { ShipmentStage } from "@/db/schema";
import { ageLabel, TEAM_LABEL, type CaseTeam } from "@/lib/constants/action-queue";
import { memo } from "@/lib/cache";
import { toDate } from "@/lib/format";
import { rowsOf } from "@/lib/sql-rows";
import { sqlSourceList } from "@/lib/constants/truth";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { getSettingJson } from "@/lib/settings";
import {
  DWELL_EVIDENCE_SOURCES,
  DWELL_NEXT_ACTION,
  DWELL_SLA_SETTING_KEY,
  PANCAKE_RELAY_SOURCE,
  DWELL_TEAM,
  dwellLevelOf,
  thresholdOf,
  TERMINAL_STAGES,
  type DwellBasis,
  type DwellLevel,
  type DwellOverrides,
  type DwellUnrated,
} from "@/lib/constants/shipment-status-age";

/**
 * ═══════════ VẬN ĐƠN CẦN XỬ LÝ, XẾP THEO TUỔI CHẶNG ═══════════
 *
 * Đặc tả và toàn bộ lý do nằm ở `lib/constants/shipment-status-age.ts`. Tệp này CHỈ đo và xếp —
 * không luật nghiệp vụ nào được viết ở đây.
 *
 * ─── TỆP NÀY KHÔNG ĐỤNG VÀO `ORDER_OUTCOME` ───
 *
 * Tuổi chặng là một phép đo về THỜI GIAN và VỊ TRÍ của kiện hàng. Nó không kết luận đơn giao thành
 * công hay hoàn, không đọc một chứng từ tiền nào, và không được đưa vào bất kỳ báo cáo doanh thu /
 * lương / tồn kho nào. Kết quả đơn vẫn có đúng một nguồn: `ORDER_OUTCOME` (`lib/queries/return-rate.ts`).
 *
 * ─── VÌ SAO LẤY HẾT VỀ RỒI MỚI XẾP MỨC, THAY VÌ XẾP TRONG SQL ───
 *
 * Ngưỡng nằm ở hằng số + phần chủ shop ghi đè trong `settings`. Viết lại chúng thành một chuỗi
 * `case when` trong SQL là dựng ra một bản sao thứ hai của bảng ngưỡng, và bản sao đó sẽ lệch đi
 * vào ngày đầu tiên có người sửa cấu hình. Nên SQL chỉ trả về TUỔI, còn `dwellLevelOf()` — đúng
 * một hàm — quyết định mức cho cả bảng lẫn mọi con số tổng hợp.
 *
 * Tập dòng là những kiện CHƯA tới chặng kết thúc, đo được 554 kiện trên production 11/09/2026.
 * Một lượt quét, không truy vấn lồng theo dòng.
 */

/** Trần an toàn. Vượt trần thì `capped = true` và màn hình phải nói ra, không lặng lẽ cắt bớt. */
const MAX_ROWS = 5_000;

/** Cùng danh sách nguồn mà bản TypeScript dùng — một chỗ khai, hai đường đọc. */
const SOURCES = sqlSourceList(DWELL_EVIDENCE_SOURCES);

export type StatusAgeRow = {
  shipmentId: string;
  tracking: string;
  orderId: string | null;
  orderSystemId: number | null;
  customer: string;
  phone: string;
  /** COD khai trên vận đơn. ĐANG TREO — không phải tiền sẽ về. */
  codAmount: number;
  stage: ShipmentStage;
  stageLabel: string;
  /** Trạng thái THÔ của ĐVVC, để đối chiếu với trang Viettel Post mà không dịch mất chữ. */
  rawStatus: string;
  /** Mốc vào chặng hiện tại. `null` = CHƯA BIẾT (không có sự kiện nào mang chặng này). */
  stageSince: Date | null;
  /** Giờ đã đứng ở chặng hiện tại. `null` = CHƯA BIẾT — đừng in thành 0. */
  statusAgeHours: number | null;
  statusAgeLabel: string;
  /** Số sự kiện trong loạt liền kề cuối. `> 1` = ĐVVC vẫn gửi tin nhưng kiện không nhích. */
  eventsInRun: number;
  /** Nguồn đã cấp mốc vào chặng: chứng từ ĐVVC hay bản Pancake chuyển tiếp. `null` = chưa có mốc. */
  sinceBasis: DwellBasis | null;
  /** Sự kiện ĐVVC gần nhất — đồng hồ IM LẶNG, khác hẳn tuổi chặng. Hai cột đứng cạnh nhau. */
  lastCarrierUpdateAt: Date | null;
  /** Hạn của chặng (giờ). `null` = chặng cố ý không đặt hạn. */
  slaHours: number | null;
  /** Đã quá hạn xử lý chưa. `null` = chưa kết luận được (đọc `unrated`). */
  slaBreached: boolean | null;
  level: DwellLevel | null;
  unrated: DwellUnrated | null;
  team: CaseTeam;
  teamLabel: string;
  nextAction: string;
  /** Có ca care đang mở cho kiện này không — để không giục người đã đang làm. */
  careOpen: boolean;
};

export type StatusAgeSummary = {
  /** Kiện đang theo dõi (chưa tới chặng kết thúc). */
  tracked: number;
  /** Đếm theo mức. Chỉ những kiện kết luận được mức mới có mặt ở đây. */
  byLevel: Record<DwellLevel, { count: number; money: number }>;
  /**
   * Kiện KHÔNG kết luận được mức, tách theo lý do. `NO_EVIDENCE` là chỗ trống dữ liệu phải đi vá,
   * KHÔNG phải kiện đang ổn — in riêng để không ai cộng nhầm nó vào "trong hạn".
   */
  unrated: Record<DwellUnrated, { count: number; money: number }>;
  /** Kiện quá hạn (`EXCEPTION`) — con số duy nhất được gọi là "phải xử lý hôm nay". */
  breached: number;
  breachedMoney: number;
  capped: boolean;
  measuredAt: Date;
};

export type StatusAgeQueue = { rows: StatusAgeRow[]; summary: StatusAgeSummary };

type Raw = {
  id: string;
  order_id: string | null;
  system_id: number | null;
  tracking: string;
  stage: ShipmentStage;
  raw_status: string;
  cod_amount: string | number | null;
  receiver_name: string;
  receiver_phone: string;
  bill_name: string | null;
  bill_phone: string | null;
  stage_since: string | Date | null;
  since_source: string | null;
  events_in_run: number | string | null;
  last_carrier_at: string | Date | null;
  care_open: boolean;
};

export async function getDwellOverrides(): Promise<DwellOverrides> {
  return getSettingJson<DwellOverrides>(DWELL_SLA_SETTING_KEY, {});
}

/**
 * MỘT CÂU TRUY VẤN CHO CẢ HÀNG ĐỢI.
 *
 * `stage_since` và `events_in_run` dựng trong CÙNG một `lateral` chứ không phải hai truy vấn con:
 * cả hai đều cần đúng một mốc cắt (`cut`), và tính mốc đó hai lần là quét bảng sự kiện hai lần cho
 * mỗi vận đơn.
 *
 * Mốc cắt = sự kiện MỚI NHẤT mang một chặng KHÁC chặng hiện tại. Sự kiện `NULL` / `UNKNOWN` không
 * tham gia — chúng không khẳng định chặng nào (xem đặc tả, quyết định 2).
 */
export async function getShipmentStatusAgeQueue(): Promise<StatusAgeQueue> {
  return memo("shipment-status-age", 60_000, async () => {
    const overrides = await getDwellOverrides();
    const db = await getDb();
    const terminals = TERMINAL_STAGES.map((s) => `'${s}'`).join(",");

    const raw = rowsOf<Raw>(
      await db.execute(sql`
        select s.id,
               s.order_id,
               o.system_id,
               coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, ''), s.id) as tracking,
               s.stage::text as stage,
               coalesce(nullif(s.vtp_status_name, ''), '') as raw_status,
               s.cod_amount,
               s.receiver_name,
               s.receiver_phone,
               o.bill_full_name as bill_name,
               o.bill_phone,
               ev.stage_since,
               ev.since_source,
               coalesce(ev.events_in_run, 0)::int as events_in_run,
               ev.last_carrier_at,
               (care.id is not null) as care_open
          from shipments s
          left join orders o on o.id = s.order_id
          /*
            MỐC CẮT tính TRƯỚC, trong lateral riêng của nó: nó chỉ phụ thuộc s.id, nên đặt nó bên
            trong lượt tổng hợp là bắt Postgres dựng lại cùng một con số cho mỗi dòng sự kiện.
            Một lateral đọc được lateral đứng trước nó, nên tách ra không tốn thêm gì.
          */
          left join lateral (
            select max(e2.occurred_at) as moc
              from shipment_events e2
             where e2.shipment_id = s.id
               and e2.source in (${sql.raw(SOURCES)})
               and e2.normalized_stage is not null
               and e2.normalized_stage::text <> 'UNKNOWN'
               and e2.normalized_stage::text <> s.stage::text
          ) cut on true
          left join lateral (
            select min(e.occurred_at) filter (where e.trong_loat) as stage_since,
                   count(*) filter (where e.trong_loat) as events_in_run,
                   max(e.occurred_at) as last_carrier_at,
                   -- Nguồn của sự kiện MỞ ĐẦU loạt. Bằng giờ thì chứng từ gốc thắng bản chuyển
                   -- tiếp, đúng luật phá hoà của bản TypeScript.
                   (array_agg(e.source order by e.occurred_at asc, e.la_chuyen_tiep asc)
                      filter (where e.trong_loat))[1] as since_source
              from (
                select e0.occurred_at,
                       e0.source,
                       (e0.source = 'PANCAKE') as la_chuyen_tiep,
                       (e0.normalized_stage::text = s.stage::text
                        and e0.occurred_at > coalesce(cut.moc, '-infinity'::timestamptz)) as trong_loat
                  from shipment_events e0
                 where e0.shipment_id = s.id
                   and e0.source in (${sql.raw(SOURCES)})
              ) e
          ) ev on true
          left join lateral (
            select c.id from shipment_care c
             where c.shipment_id = s.id
               and c.care_status not in ('RESOLVED','CANCELLED')
             limit 1
          ) care on true
         where s.stage::text not in (${sql.raw(terminals)})
         order by s.created_at desc
         limit ${MAX_ROWS + 1}
      `),
    );

    const capped = raw.length > MAX_ROWS;
    const list = capped ? raw.slice(0, MAX_ROWS) : raw;
    const now = new Date();

    const byLevel: StatusAgeSummary["byLevel"] = {
      OK: { count: 0, money: 0 },
      WATCH: { count: 0, money: 0 },
      WARNING: { count: 0, money: 0 },
      EXCEPTION: { count: 0, money: 0 },
    };
    const unratedTally: StatusAgeSummary["unrated"] = {
      NO_EVIDENCE: { count: 0, money: 0 },
      TERMINAL_STAGE: { count: 0, money: 0 },
      NO_THRESHOLD: { count: 0, money: 0 },
    };

    const rows: StatusAgeRow[] = list.map((r) => {
      const since = toDate(r.stage_since);
      const ageHours = since ? Math.max(0, (now.getTime() - since.getTime()) / 3_600_000) : null;
      const t = thresholdOf(r.stage, overrides);
      const cod = Number(r.cod_amount ?? 0) || 0;

      let level: DwellLevel | null = null;
      let unrated: DwellUnrated | null = null;
      if (ageHours === null) unrated = "NO_EVIDENCE";
      else if (TERMINAL_STAGES.includes(r.stage)) unrated = "TERMINAL_STAGE";
      else if (!t) unrated = "NO_THRESHOLD";
      else level = dwellLevelOf(ageHours, t);

      if (level) {
        byLevel[level].count += 1;
        byLevel[level].money += cod;
      } else if (unrated) {
        unratedTally[unrated].count += 1;
        unratedTally[unrated].money += cod;
      }

      return {
        shipmentId: r.id,
        tracking: r.tracking,
        orderId: r.order_id,
        orderSystemId: r.system_id,
        customer: r.bill_name || r.receiver_name || "",
        phone: r.bill_phone || r.receiver_phone || "",
        codAmount: cod,
        stage: r.stage,
        stageLabel: SHIPMENT_STAGE_LABEL[r.stage] ?? r.stage,
        rawStatus: r.raw_status,
        stageSince: since,
        statusAgeHours: ageHours,
        // CHƯA BIẾT in ra bằng chữ, không bằng số 0 (AGENTS.md mục 42).
        statusAgeLabel: ageHours === null ? "chưa biết" : ageLabel(ageHours),
        eventsInRun: Number(r.events_in_run ?? 0) || 0,
        sinceBasis: !since ? null : r.since_source === PANCAKE_RELAY_SOURCE ? "PANCAKE_RELAY" : "CARRIER_DOCUMENT",
        lastCarrierUpdateAt: toDate(r.last_carrier_at),
        slaHours: t?.exception ?? null,
        slaBreached: level === null ? null : level === "EXCEPTION",
        level,
        unrated,
        team: DWELL_TEAM[r.stage],
        teamLabel: TEAM_LABEL[DWELL_TEAM[r.stage]],
        nextAction: DWELL_NEXT_ACTION[r.stage],
        careOpen: Boolean(r.care_open),
      };
    });

    /*
      XẾP: ngoại lệ trước, rồi tuổi chặng giảm dần. Kiện CHƯA BIẾT tuổi xếp SAU nhóm có mức nhưng
      TRƯỚC nhóm đúng hạn — chúng là việc phải làm (đi vá dữ liệu), chỉ là một loại việc khác.
    */
    const rank: Record<string, number> = { EXCEPTION: 0, WARNING: 1, WATCH: 2, NO_EVIDENCE: 3, NO_THRESHOLD: 4, OK: 5, TERMINAL_STAGE: 6 };
    rows.sort((a, b) => {
      const ra = rank[a.level ?? a.unrated ?? "OK"] ?? 9;
      const rb = rank[b.level ?? b.unrated ?? "OK"] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.statusAgeHours ?? -1) - (a.statusAgeHours ?? -1);
    });

    return {
      rows,
      summary: {
        tracked: rows.length,
        byLevel,
        unrated: unratedTally,
        breached: byLevel.EXCEPTION.count,
        breachedMoney: byLevel.EXCEPTION.money,
        capped,
        measuredAt: now,
      },
    };
  });
}

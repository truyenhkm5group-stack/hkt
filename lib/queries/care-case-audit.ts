import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
// MỘT định nghĩa duy nhất cho "phút giữa hai mốc" — hai bản sao là hai cách làm tròn khác nhau.
import { minutesBetween } from "@/lib/queries/shipment-timeline";
import {
  CASE_OUTCOMES,
  deriveCaseOutcome,
  type CaseOutcome,
  type PeriodBasis,
} from "@/lib/constants/care-effect";
import {
  classifyReopen,
  REOPEN_CLASSES,
  REOPEN_CLASS_COUNTS_AS_CASE,
  REOPEN_GUARD_LIVE_AT,
  isFalseReopenAfterFix,
  type ReopenClass,
} from "@/lib/constants/care-reopen-class";

/**
 * ═══════════ MỘT CA CHĂM SÓC, ĐỌC ĐẦY ĐỦ ═══════════
 *
 * Truy vấn này KHÔNG ghi gì và KHÔNG đoán gì. Nó gom về đúng những sự thật đã được ghi lại, rồi
 * để `deriveCaseOutcome()` — hàm thuần — kết luận. Lý lẽ đầy đủ ở `lib/constants/care-effect.ts`.
 *
 * ─── VÌ SAO "CHẠM VÀO" VÀ "CHĂM SÓC" LÀ HAI CON SỐ ───
 *
 * `care_actions` là việc chăm sóc không cần bàn cãi (gọi · nhắn · sửa địa chỉ · báo bưu cục).
 * `care_case_events` do người tạo là "có ai đó động vào ca" — rộng hơn, gồm cả đổi trạng thái và
 * ghi chú. Gộp hai thứ vào một con số thì không phân biệt được *"đội đã làm việc"* với *"đội đã
 * nhìn thấy"*, và đó đúng là khác biệt mà báo cáo này sinh ra để đo.
 *
 * `ASSIGN` bị loại khỏi CẢ HAI: giao việc là điều phối, không phải chăm sóc.
 */

export type CareCaseRow = {
  careId: string;
  shipmentId: string;
  trackingNumber: string | null;
  openedAt: Date | null;
  assignedAt: Date | null;
  /** Lần đầu có HÀNH ĐỘNG CHĂM SÓC thật (bảng `care_actions`). `null` = chưa có. */
  firstCareActionAt: Date | null;
  /** Lần đầu có NGƯỜI động vào ca (sự kiện không phải máy, không phải giao việc). */
  firstHumanTouchAt: Date | null;
  firstCustomerContactAt: Date | null;
  firstCarrierContactAt: Date | null;
  lastActionAt: Date | null;
  resolvedAt: Date | null;
  entryCarrierState: string | null;
  finalCarrierState: string | null;
  storedOutcome: string | null;
  resolution: string | null;
  /** Mọi người đã chạm vào ca, theo KHOÁ TÀI KHOẢN. Dòng không có khoá KHÔNG được đếm (mục 35). */
  contributorIds: string[];
  firstResponderId: string | null;
  lastActorId: string | null;
  resolverId: string | null;
  actionKinds: string[];
  /** Đợt này là ca thật, bản sao do lỗi cũ, hay chưa kết luận được. */
  reopenClass: ReopenClass;
  callsReached: number;
  callsNoAnswer: number;
  messages: number;
  carrierEscalations: number;
  outcome: CaseOutcome;
};

export type CareAudit = {
  basis: PeriodBasis;
  /** `null` = KHÔNG chặn đầu kỳ (chọn "toàn bộ"). Khác hẳn một mốc bịa để lấp chỗ trống. */
  from: Date | null;
  to: Date | null;
  rows: CareCaseRow[];
  counts: Record<CaseOutcome, number>;
  totals: {
    opened: number;
    assigned: number;
    /** Có ít nhất một HÀNH ĐỘNG CHĂM SÓC thật. */
    withCareAction: number;
    /** Có người động vào (rộng hơn `withCareAction`). */
    touched: number;
    untouched: number;
    resolved: number;
    /** Ca có đủ mốc để tính thời gian phản hồi — ĐỘ PHỦ, luôn đứng cạnh con số. */
    firstActionCoverage: number;
    outcomeCoverage: number;
  };
  /** Trung vị phút, `null` khi mẫu chưa đủ. CHƯA ĐỦ khác hẳn 0. */
  medians: { toAssign: number | null; toFirstAction: number | null; toResolution: number | null };
  minSample: number;
  /**
   * ═══ SỨC KHOẺ LUẬT MỞ LẠI — BA CON SỐ, KHÔNG PHẢI MỘT ═══
   *
   * `falseReopenAfterFix` là con số DUY NHẤT nói lỗi có còn đang xảy ra hay không; nó phải bằng 0.
   * Gộp nó với di sản đã vá làm chủ shop tưởng lỗi chưa hết trong khi nó đã hết.
   */
  reopen: { byClass: Record<ReopenClass, number>; falseReopenAfterFix: number; guardLiveAt: Date };
};

/** Dưới ngưỡng này thì KHÔNG phát biểu một trung vị: số nhỏ nhảy loạn theo từng ca. */
const MEDIAN_MIN_SAMPLE = 10;

/** Trần dòng trả về. Số ca vượt trần vẫn được ĐẾM đầy đủ ở `totals`, chỉ danh sách bị cắt. */
const AUDIT_MAX_ROWS = 500;

function median(xs: number[]): number | null {
  if (xs.length < MEDIAN_MIN_SAMPLE) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/** Phút giữa hai mốc, nhưng BỎ số âm: một mốc "hành động" trước mốc "mở ca" là dữ liệu hỏng, không phải một khoảng thời gian âm. */
function khoangDuong(a: Date | null, b: Date | null): number | null {
  const m = minutesBetween(a, b);
  return m !== null && m >= 0 ? m : null;
}

export async function getCareAudit(period: { from: Date | null; to: Date | null }, basis: PeriodBasis = "CASE_OPENED_AT"): Promise<CareAudit> {
  return memo(`care-audit:${basis}:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 120_000, async () => {
    const db = await getDb();
    /*
      MỐC LỌC KỲ đi theo `basis` — KHÔNG có "7 ngày gần đây" mơ hồ. Ca mở cuối kỳ chưa chốt là
      chuyện bình thường; đọc tỷ lệ kết cục theo NGÀY MỞ sẽ thấp giả tạo, nên màn hình phải in ra
      mốc đang lọc (xem `PERIOD_BASIS_HINT`).
    */
    const mocKy = basis === "CASE_RESOLVED_AT" ? sql`coalesce(c.outcome_at, c.done_at)` : sql`coalesce(c.opened_at, c.created_at)`;

    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select
          c.id as care_id,
          c.shipment_id,
          c.tracking_number,
          coalesce(c.opened_at, c.created_at) as opened_at,
          c.assigned_at,
          c.last_action_at,
          coalesce(c.outcome_at, c.done_at) as resolved_at,
          c.entry_carrier_state,
          c.final_carrier_state,
          c.care_outcome,
          c.resolution,
          c.owner_id,
          c.owner_at_resolution,
          c.episode_no,
          -- Mốc đóng của đợt LIỀN TRƯỚC trên cùng kiện — vế so của luật mở lại.
          (select coalesce(p.done_at, p.outcome_at) from shipment_care p
            where p.shipment_id = c.shipment_id and p.episode_no < c.episode_no
            order by p.episode_no desc limit 1) as truoc_dong,
          -- Có sự kiện ĐVVC nào XEN GIỮA lúc đóng đợt trước và lúc dựng đợt này không. Đây là bằng
          -- chứng phân biệt "bản sao chắc chắn" với "chưa đủ bằng chứng" — thiếu nó thì 6 cặp mơ hồ
          -- bị gộp vào nhóm lỗi và con số lỗi to lên 60%.
          exists (
            select 1 from shipment_events ev
            where ev.shipment_id = c.shipment_id
              and ev.source in ('VTP_WEBHOOK','VTP_IMPORT','PANCAKE')
              and ev.occurred_at > (select coalesce(p2.done_at, p2.outcome_at) from shipment_care p2
                                     where p2.shipment_id = c.shipment_id and p2.episode_no < c.episode_no
                                     order by p2.episode_no desc limit 1)
              and ev.occurred_at <= c.created_at
          ) as co_su_kien_xen_giua,
          -- HÀNH ĐỘNG CHĂM SÓC THẬT: bảng care_actions, mọi loại đều do NGƯỜI ghi.
          (select min(a.created_at) from care_actions a
            where a.shipment_id = c.shipment_id and a.created_at >= coalesce(c.opened_at, c.created_at)) as first_care_action_at,
          -- Lần đầu TIẾP XÚC ĐƯỢC KHÁCH (gọi được / nhắn / sửa địa chỉ / hẹn lại / khách từ chối).
          (select min(a.created_at) from care_actions a
            where a.shipment_id = c.shipment_id and a.created_at >= coalesce(c.opened_at, c.created_at)
              and a.kind in ('CALLED_REACHED','MESSAGED','ADDRESS_FIXED','RESCHEDULED','CUSTOMER_REFUSED')) as first_customer_contact_at,
          -- Lần đầu chạm tới ĐVVC: báo bưu cục, hoặc gửi lệnh sang ĐVVC từ giao diện.
          least(
            (select min(a.created_at) from care_actions a
              where a.shipment_id = c.shipment_id and a.kind = 'ESCALATED_CARRIER' and a.created_at >= coalesce(c.opened_at, c.created_at)),
            (select min(e.created_at) from care_case_events e
              where e.shipment_id = c.shipment_id and e.source <> 'SYSTEM' and e.action like 'CARRIER%'
                and e.created_at >= coalesce(c.opened_at, c.created_at))
          ) as first_carrier_contact_at,
          -- NGƯỜI ĐỘNG VÀO: rộng hơn chăm sóc. Máy và giao-việc bị loại.
          (select min(e.created_at) from care_case_events e
            where e.shipment_id = c.shipment_id and e.source <> 'SYSTEM' and e.action <> 'ASSIGN'
              and e.created_at >= coalesce(c.opened_at, c.created_at)) as first_human_touch_at,
          -- Người đã gửi lệnh PHÁT LẠI (không phải máy) — cụ thể hơn "có người chăm".
          exists (select 1 from care_case_events e
            where e.shipment_id = c.shipment_id and e.source <> 'SYSTEM' and e.action like 'CARRIER%'
              and coalesce(e.payload->>'action','') = 'REQUEST_REDELIVERY') as human_redelivery,
          -- Đóng góp theo KHOÁ TÀI KHOẢN. Dòng chỉ có chữ KHÔNG được đếm (mục 35).
          coalesce((select array_agg(distinct x.actor_id) from (
            select a.actor_id from care_actions a where a.shipment_id = c.shipment_id and a.actor_id is not null
            union
            select e.actor_id from care_case_events e where e.shipment_id = c.shipment_id and e.actor_id is not null and e.source <> 'SYSTEM' and e.action <> 'ASSIGN'
          ) x), '{}') as contributor_ids,
          (select e.actor_id from care_case_events e
            where e.shipment_id = c.shipment_id and e.actor_id is not null and e.source <> 'SYSTEM' and e.action <> 'ASSIGN'
            order by e.created_at asc limit 1) as first_responder_id,
          (select e.actor_id from care_case_events e
            where e.shipment_id = c.shipment_id and e.actor_id is not null and e.source <> 'SYSTEM' and e.action <> 'ASSIGN'
            order by e.created_at desc limit 1) as last_actor_id,
          coalesce((select array_agg(a.kind) from care_actions a
            where a.shipment_id = c.shipment_id and a.created_at >= coalesce(c.opened_at, c.created_at)), '{}') as action_kinds,
          (select count(*) from care_actions a where a.shipment_id = c.shipment_id and a.kind = 'CALLED_REACHED')::int as calls_reached,
          (select count(*) from care_actions a where a.shipment_id = c.shipment_id and a.kind = 'CALLED_NO_ANSWER')::int as calls_no_answer,
          (select count(*) from care_actions a where a.shipment_id = c.shipment_id and a.kind = 'MESSAGED')::int as messages,
          (select count(*) from care_actions a where a.shipment_id = c.shipment_id and a.kind = 'ESCALATED_CARRIER')::int as carrier_escalations
        from shipment_care c
        where ${period.from ? sql`${mocKy} >= ${period.from.toISOString()}::timestamptz` : sql`true`}
          and ${period.to ? sql`${mocKy} < ${period.to.toISOString()}::timestamptz` : sql`true`}
          -- Ca chưa có mốc của mốc-lọc-kỳ (lọc theo NGÀY CHỐT nhưng ca chưa chốt) nằm NGOÀI kỳ.
          -- Đó là câu trả lời đúng: nó chưa thuộc kỳ nào cả, không phải thuộc kỳ này với giá trị 0.
          and ${mocKy} is not null
        order by ${mocKy} desc
        limit ${AUDIT_MAX_ROWS}
      `),
    );

    const d = (v: unknown): Date | null => (v ? new Date(v as string) : null);
    const counts = Object.fromEntries(CASE_OUTCOMES.map((o) => [o, 0])) as Record<CaseOutcome, number>;
    const out: CareCaseRow[] = [];

    for (const r of rows) {
      const openedAt = d(r.opened_at);
      const resolvedAt = d(r.resolved_at);
      const firstCareActionAt = d(r.first_care_action_at);
      const kinds = ((r.action_kinds as string[] | null) ?? []).filter(Boolean);
      /*
        "TRƯỚC KHI CHỐT" tính theo mốc CHỐT KẾT QUẢ, không theo lúc đọc. Một hành động ghi SAU khi
        ĐVVC đã chốt không thể là nguyên nhân của kết quả đó — đếm nó là gán công ngược thời gian.
      */
      const humanActionBeforeOutcome = Boolean(firstCareActionAt && (!resolvedAt || firstCareActionAt <= resolvedAt));
      const outcome = deriveCaseOutcome({
        storedOutcome: (r.care_outcome as string | null) ?? null,
        resolution: (r.resolution as string | null) ?? null,
        humanActionBeforeOutcome,
        actionKinds: kinds,
        humanRequestedRedelivery: Boolean(r.human_redelivery) && humanActionBeforeOutcome,
      });
      const reopenClass = classifyReopen({
        episodeNo: Number(r.episode_no ?? 1),
        triggerAt: openedAt,
        previousClosedAt: d(r.truoc_dong),
        carrierEventBetween: Boolean(r.co_su_kien_xen_giua),
      });
      counts[outcome] += 1;
      out.push({
        careId: String(r.care_id),
        shipmentId: String(r.shipment_id),
        trackingNumber: (r.tracking_number as string | null) ?? null,
        openedAt,
        assignedAt: d(r.assigned_at),
        firstCareActionAt,
        firstHumanTouchAt: d(r.first_human_touch_at),
        firstCustomerContactAt: d(r.first_customer_contact_at),
        firstCarrierContactAt: d(r.first_carrier_contact_at),
        lastActionAt: d(r.last_action_at),
        resolvedAt,
        entryCarrierState: (r.entry_carrier_state as string | null) ?? null,
        finalCarrierState: (r.final_carrier_state as string | null) ?? null,
        storedOutcome: (r.care_outcome as string | null) ?? null,
        resolution: (r.resolution as string | null) ?? null,
        contributorIds: ((r.contributor_ids as string[] | null) ?? []).filter(Boolean),
        firstResponderId: (r.first_responder_id as string | null) ?? null,
        lastActorId: (r.last_actor_id as string | null) ?? null,
        // Người CHỊU TRÁCH NHIỆM lúc chốt — KHÔNG phải "người cuối cùng chạm vào" (mục 13).
        resolverId: (r.owner_at_resolution as string | null) ?? null,
        actionKinds: kinds,
        reopenClass,
        callsReached: Number(r.calls_reached ?? 0),
        callsNoAnswer: Number(r.calls_no_answer ?? 0),
        messages: Number(r.messages ?? 0),
        carrierEscalations: Number(r.carrier_escalations ?? 0),
        outcome,
      });
    }

    /*
      ═══ BẢN SAO DO LỖI CŨ KHÔNG ĐƯỢC ĐẾM NHƯ MỘT CA NGHIỆP VỤ ═══

      Chúng vẫn nằm nguyên trong `rows` để tra lịch sử, nhưng mọi con số tổng hợp đứng trên tập ĐÃ
      LỌC. Đếm chúng là nhân đôi một việc đã xong: số ca mở, số ca giao người, tỷ lệ cứu đơn và
      thời gian xử lý đều lệch theo.
    */
    const ca = out.filter((r) => REOPEN_CLASS_COUNTS_AS_CASE[r.reopenClass]);
    const withCareAction = ca.filter((r) => r.firstCareActionAt).length;
    const touched = ca.filter((r) => r.firstCareActionAt || r.firstHumanTouchAt).length;
    const resolved = ca.filter((r) => r.resolvedAt).length;
    const byClass = Object.fromEntries(REOPEN_CLASSES.map((k) => [k, 0])) as Record<ReopenClass, number>;
    for (const r of out) byClass[r.reopenClass] += 1;

    return {
      basis,
      from: period.from,
      to: period.to,
      rows: out,
      counts,
      totals: {
        opened: ca.length,
        assigned: ca.filter((r) => r.assignedAt).length,
        withCareAction,
        touched,
        untouched: ca.length - touched,
        resolved,
        // ĐỘ PHỦ luôn đứng cạnh con số: một trung vị trên 2/319 ca không phải một trung vị.
        firstActionCoverage: ca.length ? withCareAction / ca.length : 0,
        outcomeCoverage: ca.length ? resolved / ca.length : 0,
      },
      medians: {
        toAssign: median(ca.map((r) => khoangDuong(r.openedAt, r.assignedAt)).filter((x): x is number => x !== null)),
        toFirstAction: median(ca.map((r) => khoangDuong(r.openedAt, r.firstCareActionAt)).filter((x): x is number => x !== null)),
        toResolution: median(ca.map((r) => khoangDuong(r.openedAt, r.resolvedAt)).filter((x): x is number => x !== null)),
      },
      minSample: MEDIAN_MIN_SAMPLE,
      reopen: {
        byClass,
        // Con số DUY NHẤT nói lỗi có còn đang xảy ra hay không. Phải bằng 0.
        // Vị từ THUẦN, nhận mốc từ ngoài — bài kiểm khoá được biên mà không đọc đồng hồ hệ thống.
        falseReopenAfterFix: out.filter((r) => isFalseReopenAfterFix(r)).length,
        guardLiveAt: REOPEN_GUARD_LIVE_AT,
      },
    };
  });
}

/**
 * ═══════════ VÌ SAO MỘT CA CHƯA CÓ MỐC HÀNH ĐỘNG ═══════════
 *
 * Bốn nhóm, và **chỉ hai nhóm cuối là lỗi phải sửa** (mục 45: `TRUE_UNKNOWN` thì GIỮ NGUYÊN).
 * Không bao giờ bịa một `first_action_at` cho ca lịch sử.
 */
export const MISSING_ACTION_REASONS = ["LEGACY_BEFORE_TIMELINE", "NEVER_TOUCHED", "EVENT_NOT_MAPPED", "DATA_BUG"] as const;
export type MissingActionReason = (typeof MISSING_ACTION_REASONS)[number];

export const MISSING_ACTION_LABEL: Record<MissingActionReason, string> = {
  LEGACY_BEFORE_TIMELINE: "Ca cũ, mở trước khi ERP ghi nhật ký care",
  NEVER_TOUCHED: "Chưa ai thật sự động vào",
  EVENT_NOT_MAPPED: "Có người động vào nhưng chưa ghi thành hành động chăm sóc",
  DATA_BUG: "Có hành động nhưng mốc rơi ngoài vòng đời ca",
};

export const MISSING_ACTION_FIXABLE: Record<MissingActionReason, boolean> = {
  LEGACY_BEFORE_TIMELINE: false,
  NEVER_TOUCHED: false,
  EVENT_NOT_MAPPED: true,
  DATA_BUG: true,
};

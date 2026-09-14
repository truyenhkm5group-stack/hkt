import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CASE_TYPE_LABEL, TEAM_LABEL, type CaseTeam, type CaseType } from "@/lib/constants/action-queue";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ BẰNG CHỨNG HÀNH ĐỘNG: CÔNG CỦA ĐỘI, ĐO ĐƯỢC ═══════════
 *
 * Ba câu chưa ai trả lời được:
 *
 *   CSKH đã cứu bao nhiêu doanh thu? · Kế toán đòi về bao nhiêu COD? · Kho giải phóng bao nhiêu vốn?
 *
 * ─── VÌ SAO KHÔNG SUY NGƯỢC TỪ LỊCH SỬ ───
 *
 * Đo trên production 10/09/2026: 96 việc đã đóng có kết quả đơn, **cả 96 đều mang
 * `resolution = 'UNKNOWN'`** — đóng từ trước khi có cột ghi nguồn gốc. Không ca nào chứng minh được
 * là có người ngồi làm. Lấy chúng tính "hiệu quả hành động" là đo *"đơn từng bị cảnh báo thì kết
 * cục ra sao"* rồi dán lên đó nhãn *"xử lý thì thu về bao nhiêu"* — hai câu khác hẳn nhau.
 *
 * Nên bảng bằng chứng bắt đầu từ hôm nay và chỉ lớn lên khi người thật bấm đóng việc thật.
 *
 * ─── BA CON SỐ, BA NGHĨA ───
 *
 *   `casesClosed`    SỰ THẬT   số việc CÓ NGƯỜI đóng.
 *   `moneyHandled`   SỰ THẬT   tiền đang treo tại thời điểm đóng. Là KHỐI LƯỢNG đã đụng tới,
 *                              KHÔNG phải tiền thu về.
 *   `recoveredValue` SỰ THẬT   phần đã về đích, tính SAU khi đơn ngã ngũ. `null` = CHƯA BIẾT.
 *
 * Gọi `moneyHandled` là "đã cứu được" là cách nhanh nhất để một bảng năng suất mất hết giá trị.
 */

export type TeamEffectiveness = {
  team: CaseTeam;
  label: string;
  casesClosed: number;
  /** Tiền đang treo ở những việc đã xử lý. KHÔNG phải tiền thu về. */
  moneyHandled: number;
  /** Phần đã về đích, đo từ kết quả đơn. `null` = chưa việc nào ngã ngũ. */
  recoveredValue: number | null;
  /** Số giờ trung vị từ lúc phát hiện tới lúc đóng. */
  medianHours: number | null;
};

export type EffectivenessReport = {
  days: number;
  teams: TeamEffectiveness[];
  byType: { type: CaseType; label: string; casesClosed: number; moneyHandled: number }[];
  totalClosed: number;
  totalHandled: number;
  totalRecovered: number | null;
  /** Nói thẳng khi chưa có gì để nói, thay vì hiện một bảng toàn số 0. */
  note: string;
};

export async function getActionEffectiveness(days = 30): Promise<EffectivenessReport> {
  return memo(`action-effectiveness:${days}`, 300_000, async () => {
    const db = await getDb();
    const rows = rowsOf<{ team: CaseTeam; case_type: CaseType; n: number; tien: string | number; thu: string | number | null; co_thu: number; median_h: string | number | null }>(
      await db.execute(sql`
        select team,
               case_type,
               count(*)::int as n,
               coalesce(sum(coalesce(money_at_risk, 0)), 0) as tien,
               coalesce(sum(recovered_value), 0) as thu,
               count(*) filter (where recovered_value is not null)::int as co_thu,
               percentile_cont(0.5) within group (order by coalesce(hours_to_close, 0)) as median_h
          from action_evidence
         where completed_at >= now() - make_interval(days => ${days})
         group by team, case_type
      `),
    );

    const theoDoi = new Map<CaseTeam, TeamEffectiveness & { _coThu: number; _medianSum: number }>();
    const theoLoai = new Map<CaseType, { casesClosed: number; moneyHandled: number }>();
    for (const r of rows) {
      const n = Number(r.n ?? 0);
      const cur =
        theoDoi.get(r.team) ??
        ({ team: r.team, label: TEAM_LABEL[r.team] ?? r.team, casesClosed: 0, moneyHandled: 0, recoveredValue: null, medianHours: null, _coThu: 0, _medianSum: 0 } as TeamEffectiveness & {
          _coThu: number;
          _medianSum: number;
        });
      cur.casesClosed += n;
      cur.moneyHandled += Number(r.tien ?? 0);
      cur._coThu += Number(r.co_thu ?? 0);
      cur._medianSum += Number(r.median_h ?? 0) * n;
      if (Number(r.co_thu ?? 0) > 0) cur.recoveredValue = (cur.recoveredValue ?? 0) + Number(r.thu ?? 0);
      theoDoi.set(r.team, cur);

      const t = theoLoai.get(r.case_type) ?? { casesClosed: 0, moneyHandled: 0 };
      t.casesClosed += n;
      t.moneyHandled += Number(r.tien ?? 0);
      theoLoai.set(r.case_type, t);
    }

    const teams = [...theoDoi.values()]
      .map((t) => ({ ...t, medianHours: t.casesClosed > 0 ? t._medianSum / t.casesClosed : null }))
      .sort((a, b) => b.moneyHandled - a.moneyHandled || b.casesClosed - a.casesClosed)
      .map(({ _coThu, _medianSum, ...rest }) => {
        void _coThu;
        void _medianSum;
        return rest;
      });

    const totalClosed = teams.reduce((t, x) => t + x.casesClosed, 0);
    const coThu = teams.some((t) => t.recoveredValue !== null);
    return {
      days,
      teams,
      byType: [...theoLoai.entries()]
        .map(([type, v]) => ({ type, label: CASE_TYPE_LABEL[type] ?? type, ...v }))
        .sort((a, b) => b.moneyHandled - a.moneyHandled),
      totalClosed,
      totalHandled: teams.reduce((t, x) => t + x.moneyHandled, 0),
      totalRecovered: coThu ? teams.reduce((t, x) => t + (x.recoveredValue ?? 0), 0) : null,
      note: totalClosed
        ? `${totalClosed} việc có người đóng trong ${days} ngày.`
        : "Chưa việc nào được người bấm đóng kể từ khi bắt đầu ghi. Bảng này chỉ lớn lên bằng việc làm thật, không suy ngược từ lịch sử.",
    };
  });
}

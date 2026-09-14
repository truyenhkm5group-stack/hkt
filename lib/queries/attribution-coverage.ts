import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { CS_BOT_ASSIGNEES } from "@/lib/constants/cs";
import type { DepartmentCode } from "@/lib/constants/departments";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ QUY KẾT ĐƯỢC BAO NHIÊU PHẦN CÔNG VIỆC — ĐO, KHÔNG ĐOÁN ═══════════
 *
 * Một thẻ điểm chỉ đáng tin bằng phần dữ liệu nối được về đúng con người. Báo cáo này trả lời
 * câu đó cho từng miền, bằng cách ĐẾM trên chính dữ liệu chứ không đọc một bản khai.
 *
 * ─── BỐN CỘT, VÀ VÌ SAO PHẢI TÁCH CỘT THỨ BA ───
 *
 *   có khoá    — nối bằng `users.id`. Quy kết được.
 *   chỉ có chữ — có tên/email nhưng không nối được về tài khoản. KHÔNG quy kết được.
 *   là MÁY     — ô người phụ trách ghi tên một JOB (`Bot ERP`). Đây KHÔNG phải người, và cũng
 *                KHÔNG phải "chưa ai nhận": việc đã được chạm, chỉ là chạm bởi máy.
 *   chưa ai    — thật sự chưa ai nhận (UNASSIGNED).
 *
 * Gộp "là máy" vào "có chữ" thì báo cáo nói có 187 việc đang được người làm, trong khi con số
 * thật là 0. Gộp vào "chưa ai" thì mất thông tin rằng máy đã nhắn khách rồi.
 *
 * Đo trên production 13/09/2026 trước khi có bản này: `cs_cases` có ĐÚNG MỘT chuỗi khác rỗng
 * trong ô phụ trách, và chuỗi đó là `Bot ERP`. Tức là chưa một case nào từng được giao cho người
 * thật. Đó là lý do KHÔNG có máy ánh xạ tên → tài khoản trong bản này: không có gì để ánh xạ.
 */
export type SurfaceCoverage = {
  key: string;
  label: string;
  department: DepartmentCode;
  /** Bảng / cột được đếm — để người đọc tự kiểm chứng được con số. */
  source: string;
  total: number;
  withKey: number;
  textOnly: number;
  machine: number;
  unassigned: number;
  /** Một câu nói con số này nghĩa là gì với thẻ điểm. */
  meaning: string;
};

/** Phần quy kết được. `null` khi CHƯA CÓ DÒNG NÀO — 0/0 không phải 0%, nó là chưa biết. */
export function keyedShare(c: SurfaceCoverage): number | null {
  const nguoi = c.withKey + c.textOnly;
  return nguoi > 0 ? Math.round((c.withKey / nguoi) * 1000) / 10 : null;
}

export async function getPersonAttributionCoverage(): Promise<SurfaceCoverage[]> {
  const db = await getDb();
  const bots = CS_BOT_ASSIGNEES.map((b) => sql`${b}`);

  const [care, careEvents, cs, inspect, workEvents, alerts] = await Promise.all([
    rowsOf<{ total: number; with_key: number; text_only: number; unassigned: number }>(
      await db.execute(sql`
        select count(*)::int as total,
               count(*) filter (where owner_id is not null)::int as with_key,
               count(*) filter (where owner_id is null and owner_email <> '')::int as text_only,
               count(*) filter (where owner_id is null and owner_email = '')::int as unassigned
        from shipment_care`),
    ),
    rowsOf<{ total: number; with_key: number }>(
      await db.execute(sql`select count(*)::int as total, count(*) filter (where actor_id is not null)::int as with_key from care_case_events`),
    ),
    rowsOf<{ total: number; with_key: number; text_only: number; machine: number; unassigned: number }>(
      await db.execute(sql`
        select count(*)::int as total,
               count(*) filter (where assignee_user_id is not null)::int as with_key,
               count(*) filter (where assignee_user_id is null and assignee <> '' and assignee not in (${sql.join(bots, sql`, `)}))::int as text_only,
               count(*) filter (where assignee_user_id is null and assignee in (${sql.join(bots, sql`, `)}))::int as machine,
               count(*) filter (where assignee_user_id is null and assignee = '')::int as unassigned
        from cs_cases`),
    ),
    rowsOf<{ total: number; with_key: number; text_only: number }>(
      await db.execute(sql`
        select count(*)::int as total,
               count(*) filter (where inspected_by_user_id is not null)::int as with_key,
               count(*) filter (where inspected_by_user_id is null and coalesce(inspected_by, '') <> '')::int as text_only
        from return_inspections where status = 'INSPECTED'`),
    ),
    rowsOf<{ total: number; with_key: number }>(
      await db.execute(sql`select count(*)::int as total, count(*) filter (where actor_id is not null)::int as with_key from work_item_events`),
    ),
    rowsOf<{ total: number; assigned: number; closed_by_person: number }>(
      await db.execute(sql`
        select count(*)::int as total,
               count(*) filter (where assigned_to is not null)::int as assigned,
               count(*) filter (where resolved_by is not null)::int as closed_by_person
        from notifications`),
    ),
  ]);

  const c = care[0] ?? { total: 0, with_key: 0, text_only: 0, unassigned: 0 };
  const ce = careEvents[0] ?? { total: 0, with_key: 0 };
  const s = cs[0] ?? { total: 0, with_key: 0, text_only: 0, machine: 0, unassigned: 0 };
  const i = inspect[0] ?? { total: 0, with_key: 0, text_only: 0 };
  const w = workEvents[0] ?? { total: 0, with_key: 0 };
  const a = alerts[0] ?? { total: 0, assigned: 0, closed_by_person: 0 };

  return [
    {
      key: "CARE_CASE",
      label: "Ca chăm kiện hàng",
      department: "LOGISTICS",
      source: "shipment_care.owner_id",
      total: c.total,
      withKey: c.with_key,
      textOnly: c.text_only,
      machine: 0,
      unassigned: c.unassigned,
      meaning: "Ai đang CẦM kiện. Chưa ai nhận thì không quy về người nào được — và đó là câu trả lời đúng, không phải lỗ hổng.",
    },
    {
      key: "CARE_EVENT",
      label: "Thao tác trên ca care",
      department: "LOGISTICS",
      source: "care_case_events.actor_id",
      total: ce.total,
      withKey: ce.with_key,
      textOnly: ce.total - ce.with_key,
      machine: 0,
      unassigned: 0,
      meaning: "Ai ĐÃ LÀM gì, lúc nào. Đây là nguồn của chỉ số SLA giao vận.",
    },
    {
      key: "CS_CASE",
      label: "Case CSKH",
      department: "SALES",
      source: "cs_cases.assignee_user_id",
      total: s.total,
      withKey: s.with_key,
      textOnly: s.text_only,
      machine: s.machine,
      unassigned: s.unassigned,
      meaning: "Nguồn của MỌI chỉ số cá nhân phòng Kinh doanh. Không có case nào nối được về người thì phòng này chưa đo được ai.",
    },
    {
      key: "RETURN_INSPECTION",
      label: "Phiếu kiểm hàng hoàn",
      department: "WAREHOUSE",
      source: "return_inspections.inspected_by_user_id (chỉ phiếu ĐÃ kiểm)",
      total: i.total,
      withKey: i.with_key,
      textOnly: i.text_only,
      machine: 0,
      unassigned: 0,
      meaning: "Nguồn duy nhất của chỉ số phòng Kho. Không lập phiếu thì không có KPI — và KHÔNG được tạo phiếu giả để lấp.",
    },
    {
      key: "WORK_EVENT",
      label: "Thao tác trên việc tay",
      department: "MANAGEMENT",
      source: "work_item_events.actor_id",
      total: w.total,
      withKey: w.with_key,
      textOnly: w.total - w.with_key,
      machine: 0,
      unassigned: 0,
      meaning: "Mọi lần đổi chủ / đổi trạng thái việc tay.",
    },
    {
      key: "ALERT",
      label: "Cảnh báo đã đóng",
      department: "MANAGEMENT",
      source: "notifications.resolved_by",
      total: a.total,
      withKey: a.closed_by_person,
      textOnly: 0,
      machine: 0,
      unassigned: a.total - a.closed_by_person,
      meaning: "Cảnh báo đóng KHÔNG có người là hệ thống tự đóng vì điều kiện hết — không phải công của ai.",
    },
  ];
}

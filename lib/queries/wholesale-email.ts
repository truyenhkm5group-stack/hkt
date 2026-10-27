import { sql, type SQL } from "drizzle-orm";
import { isEmailRole } from "@/lib/constants/wholesale-email";

/**
 * ═══════════ THU THẬP EMAIL B2B — MẢNH SQL CHỈ ĐỌC ═══════════
 *
 * Trạng thái email của MỘT lead = dòng kiểm của email ĐANG Ở HỒ SƠ (`wholesale_leads.email`) trong lượt quét MỚI NHẤT có
 * email (`wholesale_lead_activities.meta.emailChecks`, ghi ở lib/wholesale/email-store.ts). Email nhân viên tự gõ chưa
 * qua lượt quét nào ⇒ không có dòng kiểm ⇒ trạng thái CHƯA BIẾT (NULL), không phải «không hợp lệ».
 *
 * Câu con tương quan viết khoá lead TƯỜNG MINH (`"wholesale_leads"."id"`): drizzle in `id` trần thành cột của bảng con.
 */

const LEAD_EMAIL_CHECK = sql`(select e.v from wholesale_lead_activities a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.meta->'emailChecks') = 'array' then a.meta->'emailChecks' else '[]'::jsonb end) as e(v) where a.lead_id = "wholesale_leads"."id" and a.kind = 'ENRICHED' and e.v->>'email' = lower(btrim("wholesale_leads"."email")) order by a.created_at desc limit 1)`;

/** `VALID_MX` · `NO_MX` · `UNKNOWN` · NULL (email chưa qua lượt quét nào / lead không có email). */
export const LEAD_EMAIL_MX = sql<string | null>`(${LEAD_EMAIL_CHECK}->>'mx')`;
/** Vai trò của email đang ở hồ sơ theo lượt quét mới nhất (NULL như trên). */
export const LEAD_EMAIL_ROLE = sql<string | null>`(${LEAD_EMAIL_CHECK}->>'role')`;
export const LEAD_HAS_EMAIL = sql<boolean>`(nullif(btrim("wholesale_leads"."email"), '') is not null)`;

/** Một giá trị của bộ lọc «Email» (khoá `email` trong URL) ⇒ điều kiện, hoặc null khi giá trị lạ. */
export function emailFilterCond(value: string): SQL | null {
  if (value === "has") return LEAD_HAS_EMAIL;
  if (value === "none") return sql`not ${LEAD_HAS_EMAIL}`;
  if (value === "valid") return sql`${LEAD_EMAIL_MX} = 'VALID_MX'`;
  if (value === "no_mx") return sql`${LEAD_EMAIL_MX} = 'NO_MX'`;
  if (value.startsWith("role_")) {
    const role = value.slice(5);
    return isEmailRole(role) ? sql`${LEAD_EMAIL_ROLE} = ${role}` : null;
  }
  return null;
}

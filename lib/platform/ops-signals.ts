/**
 * ═══════════ «SỰ CỐ 24 GIỜ / 7 NGÀY» CỦA KHÁCH — ĐỌC MỘT CÂU Ở CSDL NHÀ (sứ mệnh saas-ops-signals) — CHỈ MÁY CHỦ ═══════════
 *
 * Tám tín hiệu (lib/constants/ops-signals.ts) cho MỘT hay NHIỀU tổ chức trong ĐÚNG MỘT câu SQL — không mở CSDL tổ chức nào, không N+1:
 *  · gương `platform_org_health` (job sales-health + sự cố ghi thẳng từ đường nóng);
 *  · `platform_auth_failures` gom theo tổ chức (24 giờ / 7 ngày / lý do cuối / định danh đã che);
 *  · `platform_ai_usage` dòng ERROR và BLOCKED_QUOTA gom theo tổ chức (lớp lỗi / trần cuối, id hội thoại cuối);
 *  · lượt AI gần nhất của từng tổ chức (biết «chưa từng có lượt AI» ≠ «0 lỗi»);
 *  · mốc bắt đầu đo của hai sổ mới — dòng sớm nhất của `platform_auth_failures` / `platform_org_health` (dựng TỪ DỮ LIỆU).
 * Phép dựng tám dòng là hàm thuần `buildOpsSignalLines` — màn hình và danh sách khách (#683, dùng sau) đọc cùng một luật.
 *
 * NHÌN XUYÊN TỔ CHỨC ⇒ chỉ người vận hành nền tảng: mọi hàm xuất khẩu hỏi `platformOperatorDenial` TRƯỚC câu đọc đầu tiên.
 * Không trả email thô, tên khách, nội dung tin, khoá — chỉ số đếm, mốc, mã lý do, id tương quan, định danh ĐÃ CHE.
 */
import { sql } from "drizzle-orm";
import { getPlatformDb } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  authFailureWho,
  buildOpsSignalLines,
  OPS_LEVELS,
  ORG_HEALTH_CHECK_KEYS,
  type FailureAgg,
  type OpsLevel,
  type OpsSignalInput,
  type OpsSignalLine,
  type OrgHealthCheckKey,
  type OrgHealthRowView,
} from "@/lib/constants/ops-signals";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { rowsOf } from "@/lib/sql-rows";

export type OrgOpsSignals = { orgCode: string; checkedAt: string; lines: OpsSignalLine[] };
export type OpsSignalsDenied = { ok: false; code: "FORBIDDEN"; error: string };

/** Trần số tổ chức một lượt gom — danh sách khách lớn hơn thì người gọi chia trang. */
export const OPS_SIGNALS_MAX_ORGS = 500;

/** Một dòng của câu gom (mọi nhánh UNION cùng hình). */
export type OpsSignalSqlRow = {
  src: string;
  org_code: string | null;
  key: string | null;
  level: string | null;
  c24: number | null;
  c7: number | null;
  last_at: Date | string | null;
  last_reason: string | null;
  corr: string | null;
  detail: string | null;
  since: Date | string | null;
  measured_at: Date | string | null;
  extra: string | null;
  unclassified: number | null;
};

const iso = (v: Date | string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const int = (v: unknown): number => (Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0);
const intOrNull = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** MỘT câu cho mọi tổ chức — xem đầu tệp. Thứ tự / số cột mọi nhánh UNION giống hệt nhau (mọi NULL ép kiểu). */
async function readRows(codes: readonly string[], now: Date): Promise<OpsSignalSqlRow[]> {
  const pdb = await getPlatformDb();
  const list = sql.join(codes.map((c) => sql`${c}`), sql`, `);
  const d1 = new Date(now.getTime() - 86_400_000);
  const d7 = new Date(now.getTime() - 7 * 86_400_000);
  return rowsOf<OpsSignalSqlRow>(
    await pdb.execute(sql`
      select 'H'::text as src, h.org_code, h.check_key as key, h.level, h.count_24h as c24, h.count_7d as c7, h.last_at, h.last_reason,
             h.correlation_id as corr, h.detail, h.since, h.measured_at, null::text as extra, null::int as unclassified
      from platform_org_health h
      where h.org_code in (${list})
      union all
      select 'L'::text, f.org_code, 'LOGIN'::text, null::text, (count(*) filter (where f.at >= ${d1}))::int, count(*)::int, max(f.at),
             (array_agg(f.reason_code order by f.at desc))[1], null::text, (array_agg(f.identifier_masked order by f.at desc))[1],
             null::timestamptz, null::timestamptz, (array_agg(f.flow order by f.at desc))[1], null::int
      from platform_auth_failures f
      where f.org_code in (${list}) and f.at >= ${d7}
      group by f.org_code
      union all
      select case when u.status = 'ERROR' then 'A' else 'Q' end, u.org_code, u.status, null::text, (count(*) filter (where u.at >= ${d1}))::int,
             count(*)::int, max(u.at), (array_agg(u.error_class order by u.at desc))[1], (array_agg(coalesce(u.conversation_id, u.ref) order by u.at desc))[1],
             null::text, null::timestamptz, null::timestamptz, (array_agg(u.feature order by u.at desc))[1], (count(*) filter (where u.error_class is null))::int
      from platform_ai_usage u
      where u.org_code in (${list}) and u.at >= ${d7} and u.status in ('ERROR', 'BLOCKED_QUOTA')
      group by u.org_code, u.status
      union all
      select 'U'::text, c.code, null::text, null::text, null::int, null::int, (select max(x.at) from platform_ai_usage x where x.org_code = c.code),
             null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::int
      from (values ${sql.join(codes.map((c) => sql`(${c}::text)`), sql`, `)}) as c(code)
      union all
      select 'S'::text, null::text, 'SINCE'::text, null::text, null::int, null::int,
             least((select min(a.at) from platform_auth_failures a), (select min(g.created_at) from platform_org_health g)),
             null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::int
    `),
  );
}

const aggOf = (r: OpsSignalSqlRow, extra: string | null): FailureAgg => ({ count24h: int(r.c24), count7d: int(r.c7), lastAt: iso(r.last_at), lastReason: r.last_reason, correlationId: r.corr, extra, unclassified: int(r.unclassified) });

/** Các dòng đã đọc ⇒ đầu vào của `buildOpsSignalLines` cho từng tổ chức. HÀM THUẦN (xuất khẩu cho kiểm thử). */
export function groupOpsSignalRows(codes: readonly string[], rows: readonly OpsSignalSqlRow[]): Map<string, OpsSignalInput> {
  const sinceRow = rows.find((r) => r.src === "S");
  const signalsSince = sinceRow ? iso(sinceRow.last_at) : null;
  const out = new Map<string, OpsSignalInput>();
  for (const c of codes) out.set(c, { mirror: {}, login: null, aiErrors: null, aiBlocked: null, aiLastAnyAt: null, signalsSince });
  for (const r of rows) {
    const input = r.org_code ? out.get(r.org_code) : undefined;
    if (!input) continue;
    if (r.src === "H" && r.key && (ORG_HEALTH_CHECK_KEYS as readonly string[]).includes(r.key) && r.level && (OPS_LEVELS as readonly string[]).includes(r.level)) {
      const row: OrgHealthRowView = { key: r.key as OrgHealthCheckKey, level: r.level as OpsLevel, count24h: intOrNull(r.c24), count7d: intOrNull(r.c7), lastAt: iso(r.last_at), lastReason: r.last_reason, correlationId: r.corr, detail: r.detail, since: iso(r.since), measuredAt: iso(r.measured_at) };
      input.mirror[row.key] = row;
    } else if (r.src === "L") input.login = aggOf(r, authFailureWho(r.extra, r.detail));
    else if (r.src === "A") input.aiErrors = aggOf(r, r.extra);
    else if (r.src === "Q") input.aiBlocked = aggOf(r, r.extra);
    else if (r.src === "U") input.aiLastAnyAt = iso(r.last_at);
  }
  return out;
}

/**
 * Tám tín hiệu cho NHIỀU tổ chức — một câu. Chỉ người vận hành nền tảng (hỏi TRƯỚC mọi lượt đọc). Mã sai dạng bị bỏ; quá
 * `OPS_SIGNALS_MAX_ORGS` mã ⇒ chỉ lấy phần đầu (người gọi chia trang). `aiSalesEnabled` (tuỳ chọn, theo mã) cho dòng chỉ có gương in N/A.
 */
export async function loadOpsSignalsForOrgs(user: SessionUser, orgCodes: readonly string[], opts: { now?: Date; aiSalesEnabled?: ReadonlyMap<string, boolean | null> } = {}): Promise<{ ok: true; value: Map<string, OrgOpsSignals> } | OpsSignalsDenied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, code: "FORBIDDEN", error: denial };
  const now = opts.now ?? new Date();
  const codes = [...new Set(orgCodes.map((c) => String(c ?? "").trim().toLowerCase()).filter((c) => ORGANIZATION_CODE_PATTERN.test(c)))].slice(0, OPS_SIGNALS_MAX_ORGS);
  const value = new Map<string, OrgOpsSignals>();
  if (!codes.length) return { ok: true, value };
  const grouped = groupOpsSignalRows(codes, await readRows(codes, now));
  for (const c of codes) {
    const input = grouped.get(c)!;
    value.set(c, { orgCode: c, checkedAt: now.toISOString(), lines: buildOpsSignalLines({ ...input, aiSalesEnabled: opts.aiSalesEnabled?.get(c) ?? null }, now) });
  }
  return { ok: true, value };
}

/** Tám tín hiệu của MỘT tổ chức — khung «Sự cố 24 giờ / 7 ngày» ở `/platform/org/<mã>`. Cùng cổng, cùng câu. */
export async function loadOrgOpsSignals(user: SessionUser, orgCode: string, opts: { now?: Date; aiSalesEnabled?: boolean | null } = {}): Promise<{ ok: true; value: OrgOpsSignals } | OpsSignalsDenied | { ok: false; code: "NOT_FOUND"; error: string }> {
  const code = String(orgCode ?? "").trim().toLowerCase();
  const r = await loadOpsSignalsForOrgs(user, [code], { now: opts.now, aiSalesEnabled: new Map([[code, opts.aiSalesEnabled ?? null]]) });
  if (!r.ok) return r;
  const v = r.value.get(code);
  return v ? { ok: true, value: v } : { ok: false, code: "NOT_FOUND", error: "Mã tổ chức không hợp lệ." };
}

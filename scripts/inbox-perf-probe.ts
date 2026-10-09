/*
  ops `inbox-perf-probe` — HỘP THƯ KHÁCH MỞ MẤT BAO LÂU, CHUYỂN HỘI THOẠI MẤT BAO LÂU, ĐO TRÊN DỮ LIỆU THẬT CỦA TỪNG WORKSPACE (CHỈ ĐỌC).

  Vì sao có (09/10/2026): chủ shop cần con số production cho (1) lượt mở Hộp thư khách và (2) lượt chuyển sang một hội thoại khác,
  trên workspace khách SaaS. PGlite ở máy không thay được: dữ liệu khác, kế hoạch truy vấn khác. Script chạy TRONG container
  production và bấm giờ ĐÚNG chuỗi lời gọi máy chủ mà `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx` chạy — không viết truy vấn
  thứ hai (AGENTS §8.12):
   · TẢI (mở /ai/sales-chatbot/inbox, không ?c=): `listLabels` → `inboxPages` → Promise.all[`listInbox` (bộ lọc mặc định, 100 dòng),
     `assignableUsers`, `inboxAssignees`, `organizationLevelPack`, `listPageRoutes` (chỉ khi `ai_sales:manage`), `humanCooldownMinutes`,
     `manualOrderGate`]. Đồng hồ riêng cho `listInbox` (bộ nạp danh sách).
   · CHUYỂN (bấm một hội thoại = điều hướng tới ?c=<id>, Server Component dựng lại): `listLabels` → `inboxPages` → `loadInboxThread`
     (+ `customerInboxThread` khi workspace khách) → CÙNG Promise.all như trên. Đồng hồ riêng cho `loadInboxThread`. Hội thoại đo là N
     hội thoại ĐẦU danh sách mặc định (mới nhất — đúng thứ người dùng thấy đầu tiên).
  KHÔNG đo: tra phiên (`requirePermission`), dựng HTML / RSC, mạng tới trình duyệt, nhánh hộp thư rỗng (`loadChannelFacts`, đệm 60 giây).

  DANH TÍNH: một tài khoản ĐANG BẬT của chính tổ chức mà bộ tính quyền của phiên (`activeUserIdsWhoCan`) nói là xem được hộp thư,
  dựng như `machineOperator` của scripts/ops-signals-check.ts (vai trò + quyền đã phân giải). `loadInboxThread` GHI `staff_seen_at` khi
  người mở trả lời được (`ai_sales:reply` / `outreach:send`) — nhánh «người chỉ xem» của hàm thì không. Nên: ưu tiên tài khoản CHỈ XEM
  thật; không có thì THU HẸP tài khoản đã chọn (bỏ hai quyền gửi tin, ADMIN ⇒ VIEWER). Chỉ thu hẹp, KHÔNG cấp thêm quyền nào; cái
  giá: lượt đo thiếu đúng MỘT câu UPDATE theo khoá chính mà người trả lời được trả thêm.

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên); `main` hỏi lại CSDL nhà (`platformReadOnlyConfirmed`) và
  CSDL từng tổ chức (`show default_transaction_read_only`) rồi dừng nếu không phải. Mở CSDL tổ chức bằng đường của ứng dụng là MIGRATE
  + dọn bản sao `platform_*` (không chỉ đọc) — nên script GẮN handle chẩn đoán `getDbForInspection` (máy chủ ép chỉ đọc, không migrate,
  bể 1 kết nối) làm handle của tổ chức cho RIÊNG tiến trình này (`bindReadOnlyOrgHandle`). Hệ quả cho con số: Promise.all của trang
  xếp hàng trên MỘT kết nối thay vì hai (`PGPOOL_MAX_ORG` của app) ⇒ số đo nghiêng về phía CHẬM, không bao giờ đẹp hơn thật.

  NGUỘI / ẤM: «nguội» xoá `memo` trước mỗi lượt (điều kiện xấu nhất, như scripts/perf-probe.ts); «ấm» để nguyên. Một lượt mồi không
  tính (mở kết nối). SQL tách riêng bằng `probe()` (lib/perf/probe.ts, bật `ERP_PERF_PROBE=1`): tổng ms + số câu, cả CSDL nhà lẫn tổ chức.

  ĐẦU RA:
   · phần MÃ HOÁ (dòng không tiền tố): từng tổ chức theo MÃ — danh tính (mã tài khoản + vai trò), từng lượt đo (ms · SQL · số câu · số
     dòng), lỗi. Không tên / SĐT / chữ tin của khách nào — script không in một trường nào của hội thoại ngoài số đếm.
   · kênh công khai `[ops:tom-tat] `: tổ chức che thành «org#i» (bản đồ org#i → mã chỉ ở phần mã hoá); workspace nghiệm thu
     `cdt-nghiem-thu` (sổ khai công khai) in theo mã. p50 / p95 / max (ms) + cỡ mẫu. Dưới 3 quan sát ⇒ «mẫu nhỏ — chưa kết luận».
   · KHÔNG có ngưỡng đạt / không đạt (AGENTS 38): in số + «chưa có đích». Mã thoát: 0 đo xong mọi lượt · 1 có lượt / tổ chức đo hỏng
     hoặc không có tổ chức nào · 64 arg sai · 70 CSDL không chỉ đọc.

  arg: `[--org=<mã>] [--samples=<n>]` — mặc định mọi tổ chức ACTIVE (trừ nhà) đang bật `ai_sales`, tối đa 10 (workspace nghiệm thu
  trước, rồi theo mã); `--samples` 1–20, mặc định 5.
  ops lấy SCRIPT này từ `main` nhưng `lib/` từ IMAGE đang chạy.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("inbox-perf-probe.ts"));
if (CHAY_THANG) {
  process.env.ERP_READ_ONLY = "1";
  // Bộ đếm câu của lib/perf/probe.ts chỉ gắn vào kết nối mở SAU khi cờ này bật (db/index.ts::instrumentQueries).
  process.env.ERP_PERF_PROBE = "1";
}

import "dotenv/config";
import { inArray, sql } from "drizzle-orm";
import { getDb, getDbForInspection, schema, type Db } from "@/db";
import { activeUserIdsWhoCan, can, loadPermissionSnapshots, loadRoleTemplates, type SessionUser } from "@/lib/auth/session";
import { resolvePermissions } from "@/lib/auth/permissions";
import { clearMemo } from "@/lib/cache";
import { trungVi } from "@/lib/constants/perf-explain";
import { ACCEPTANCE_WORKSPACES } from "@/lib/constants/saas-acceptance-registry";
import { probe } from "@/lib/perf/probe";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { platformReadOnlyConfirmed } from "@/lib/pricing/migration";
import { manualOrderGate } from "@/lib/records/order-create";
import { customerFacing, customerInboxThread } from "@/lib/saas/visibility";
import { listPageRoutes } from "@/lib/sales-chatbot/channel-ownership";
import { humanCooldownMinutes } from "@/lib/sales-chatbot/conversation-control";
import { assignableUsers, inboxAssignees, inboxPages, listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { listLabels } from "@/lib/sales-chatbot/inbox-labels";
import { organizationLevelPack } from "@/lib/sales-chatbot/levels";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Trần của kênh tóm tắt (cùng số với `ma_hoa_ket_qua`: 60 dòng × 300 ký tự). */
export const SUMMARY_MAX_LINES = 60;
export const SUMMARY_MAX_CHARS = 300;
/** Mặc định / trần số lượt mỗi phép đo, và số tổ chức tối đa của lượt mặc định. */
export const DEFAULT_SAMPLES = 5;
export const MAX_SAMPLES = 20;
export const MAX_ORGS = 10;
/** Dưới chừng này quan sát thì không kết luận (AGENTS §8 — mẫu mỏng không phải bằng chứng). */
export const THIN_SAMPLE = 3;
export const THIN_LABEL = "mẫu nhỏ — chưa kết luận";
/** Không có ngưỡng nào trong mã (AGENTS 38) — câu này đứng thay chỗ PASS / FAIL. */
export const NO_TARGET_LABEL = "chưa có đích";
/** Hai quyền làm `loadInboxThread` GHI `staff_seen_at` (`canReplyTo` của lib/sales-chatbot/inbox.ts). */
export const REPLY_PERMISSIONS = ["ai_sales:reply", "outreach:send"] as const;

/** Mã tổ chức — cùng hình với khoá ổn định của `Organization.code` (lib/platform/types.ts). */
const ORG_CODE = /^[a-z][a-z0-9-]{1,30}$/;
export const ACCEPTANCE_CODES: readonly string[] = ACCEPTANCE_WORKSPACES.map((w) => w.code);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type ProbeArgs = { ok: true; org: string | null; samples: number } | { ok: false; error: string };

/** Soát arg NGHIÊM: chỉ `--org=<mã>` và `--samples=<1..20>`, mỗi cờ một lần, không tham số trần. HÀM THUẦN. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const parts = argv.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  let org: string | null = null;
  let samples: number | null = null;
  for (const p of parts) {
    const m = /^--(org|samples)=(.*)$/.exec(p);
    if (!m) return { ok: false, error: "chỉ nhận --org=<mã> và --samples=<n>" };
    if (m[1] === "org") {
      if (org !== null) return { ok: false, error: "--org chỉ một lần" };
      if (!ORG_CODE.test(m[2])) return { ok: false, error: "--org phải là mã tổ chức dạng chữ thường / số / gạch ngang (2–31 ký tự)" };
      org = m[2];
    } else {
      if (samples !== null) return { ok: false, error: "--samples chỉ một lần" };
      if (!/^[0-9]{1,2}$/.test(m[2]) || Number(m[2]) < 1 || Number(m[2]) > MAX_SAMPLES) return { ok: false, error: `--samples phải là số nguyên 1–${MAX_SAMPLES}` };
      samples = Number(m[2]);
    }
  }
  return { ok: true, org, samples: samples ?? DEFAULT_SAMPLES };
}

export type SeriesStats = { n: number; p50: number | null; p95: number | null; max: number | null };

/**
 * p50 = trung vị (`trungVi` — số phần tử chẵn lấy trung bình hai phần tử giữa); p95 = HẠNG GẦN NHẤT (phần tử thứ ⌈0,95·n⌉ sau khi
 * sắp — với n ≤ 19 nó chính là max, nói thật rằng mẫu nhỏ không có đuôi riêng); bỏ giá trị không hữu hạn. Rỗng ⇒ `null` (CHƯA BIẾT,
 * không phải 0 — luật 42). HÀM THUẦN.
 */
export function seriesStats(xs: readonly (number | null | undefined)[]): SeriesStats {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, p50: null, p95: null, max: null };
  return { n: v.length, p50: trungVi(v), p95: v[Math.max(0, Math.ceil(0.95 * v.length) - 1)], max: v[v.length - 1] };
}

const ms = (x: number | null): string => (x === null ? "—" : String(Math.round(x)));
const triple = (s: SeriesStats): string => `p50 ${ms(s.p50)} · p95 ${ms(s.p95)} · max ${ms(s.max)}`;
const cap = (l: string): string => (l.length > SUMMARY_MAX_CHARS ? `${l.slice(0, SUMMARY_MAX_CHARS - 1)}…` : l);

/** Một lượt dựng đường máy chủ của trang. `error` khác `null` ⇒ lượt hỏng, không vào thống kê. */
export type RenderSample = {
  ms: number;
  /** Đồng hồ riêng của `listInbox` (chạy song song với phần còn lại của Promise.all). */
  listMs: number | null;
  /** Đồng hồ riêng của `loadInboxThread` — `null` ở lượt TẢI. */
  threadMs: number | null;
  /** Tổng ms các câu SQL + số câu (lib/perf/probe.ts) — `null` khi bộ đếm không gắn được (CHƯA ĐO, không phải 0). */
  sqlMs: number | null;
  queries: number | null;
  rows: number | null;
  total: number | null;
  /** Số mục trên dòng thời gian của hội thoại (lượt CHUYỂN). */
  items: number | null;
  error: string | null;
};

export type IdentityKind = "VIEW_ONLY_ACCOUNT" | "NARROWED";
export type OrgPerf = {
  code: string;
  identity: { kind: IdentityKind; userId: string; role: string; fromRole: string } | null;
  result:
    | { ok: true; load: { cold: RenderSample[]; warm: RenderSample[] }; switchTo: { cold: RenderSample[]; warm: RenderSample[] }; conversations: number }
    | { ok: false; error: string };
};

export type InboxPerfReport = { verdict: "MEASURED" | "INCOMPLETE"; publicLines: string[]; labels: Map<string, string>; failedSamples: number };

const good = (xs: readonly RenderSample[]) => xs.filter((x) => x.error === null);
const thin = (...ss: SeriesStats[]) => (ss.some((s) => s.n < THIN_SAMPLE) ? ` · ${THIN_LABEL}` : "");

/**
 * Nhãn công khai của từng tổ chức: workspace nghiệm thu giữ mã (sổ khai công khai), còn lại «org#i» theo thứ tự đo. HÀM THUẦN.
 */
export function publicLabels(codes: readonly string[], acceptance: readonly string[] = ACCEPTANCE_CODES): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const c of codes) out.set(c, acceptance.includes(c) ? c : `org#${++i}`);
  return out;
}

/**
 * Gom mọi tổ chức ⇒ dòng công khai + phán quyết LƯỢT ĐO (không phải phán quyết hiệu năng — không có đích). HÀM THUẦN.
 *  · Dòng công khai chỉ mang nhãn che / mã nghiệm thu, số ms, cỡ mẫu, số dòng — không tên, SĐT, chữ tin, mã tài khoản, câu lỗi.
 *  · Dưới `THIN_SAMPLE` quan sát ở một chuỗi ⇒ «mẫu nhỏ — chưa kết luận».
 *  · `INCOMPLETE` khi không có tổ chức nào, có tổ chức đo hỏng, hoặc có lượt hỏng.
 */
export function summarizeInboxPerf(orgs: readonly OrgPerf[], opts: { samples: number; acceptanceCodes?: readonly string[]; cappedFrom?: number | null } = { samples: DEFAULT_SAMPLES }): InboxPerfReport {
  const labels = publicLabels(
    orgs.map((o) => o.code),
    opts.acceptanceCodes ?? ACCEPTANCE_CODES,
  );
  const lines: string[] = [];
  let failedSamples = 0;
  let failedOrgs = 0;
  const body: string[] = [];
  for (const o of orgs) {
    const label = labels.get(o.code)!;
    if (!o.result.ok) {
      failedOrgs += 1;
      body.push(`${label}: ĐO HỎNG cả tổ chức (câu lỗi trong phần mã hoá)`);
      continue;
    }
    const r = o.result;
    const all = [...r.load.cold, ...r.load.warm, ...r.switchTo.cold, ...r.switchTo.warm];
    const bad = all.filter((x) => x.error !== null).length;
    failedSamples += bad;
    const lc = good(r.load.cold);
    const lw = good(r.load.warm);
    const sc = good(r.switchTo.cold);
    const sw = good(r.switchTo.warm);
    const loadCold = seriesStats(lc.map((x) => x.ms));
    const loadWarm = seriesStats(lw.map((x) => x.ms));
    const listCold = seriesStats(lc.map((x) => x.listMs));
    const sqlCold = seriesStats(lc.map((x) => x.sqlMs));
    const qCold = seriesStats(lc.map((x) => x.queries));
    const rows = lc.find((x) => x.rows !== null);
    const id = o.identity ? (o.identity.kind === "VIEW_ONLY_ACCOUNT" ? "tài khoản CHỈ XEM thật" : `thu hẹp từ ${o.identity.fromRole} (bỏ ${REPLY_PERMISSIONS.join(" · ")})`) : "—";
    body.push(`${label} danh tính: ${id}${bad ? ` · ${bad}/${all.length} lượt HỎNG (câu lỗi trong phần mã hoá)` : ""}`);
    body.push(
      `${label} tải hộp thư (ms): nguội ${triple(loadCold)} · ấm ${triple(loadWarm)} (n=${loadCold.n}/${loadWarm.n}) · listInbox nguội p50 ${ms(listCold.p50)} · SQL nguội p50 ${ms(sqlCold.p50)} ms / ${ms(qCold.p50)} câu · hàng ${rows ? `${rows.rows}/${rows.total ?? "—"}` : "—"}${thin(loadCold, loadWarm)}`,
    );
    if (r.conversations === 0) {
      body.push(`${label} chuyển hội thoại: 0 hội thoại — không đo được (${THIN_LABEL})`);
      continue;
    }
    const swCold = seriesStats(sc.map((x) => x.ms));
    const swWarm = seriesStats(sw.map((x) => x.ms));
    const thCold = seriesStats(sc.map((x) => x.threadMs));
    const thWarm = seriesStats(sw.map((x) => x.threadMs));
    const sqlSw = seriesStats(sc.map((x) => x.sqlMs));
    const qSw = seriesStats(sc.map((x) => x.queries));
    body.push(
      `${label} chuyển hội thoại (ms): nguội ${triple(swCold)} · ấm ${triple(swWarm)} (n=${swCold.n}/${swWarm.n} trên ${r.conversations} hội thoại) · loadInboxThread nguội ${triple(thCold)} · ấm p50 ${ms(thWarm.p50)} · SQL nguội p50 ${ms(sqlSw.p50)} ms / ${ms(qSw.p50)} câu${r.conversations < THIN_SAMPLE ? ` · ${THIN_LABEL}` : thin(swCold, swWarm)}`,
    );
  }
  const verdict: InboxPerfReport["verdict"] = orgs.length > 0 && failedOrgs === 0 && failedSamples === 0 ? "MEASURED" : "INCOMPLETE";
  lines.push(
    `inbox-perf-probe: ${verdict === "MEASURED" ? "ĐO XONG" : "ĐO CHƯA TRỌN"} · ${orgs.length} tổ chức${opts.cappedFrom ? ` (cắt từ ${opts.cappedFrom}, trần ${MAX_ORGS})` : ""} · ${opts.samples} lượt mỗi phép đo · ${failedOrgs} tổ chức hỏng · ${failedSamples} lượt hỏng · đích: ${NO_TARGET_LABEL} (không PASS/FAIL — AGENTS 38)` +
      (orgs.length === 0 ? " · KHÔNG có tổ chức nào để đo" : ""),
  );
  lines.push("cách đọc: ms đo TRONG container, chỉ phần máy chủ của trang (không tra phiên, không dựng HTML, không mạng) · nguội = xoá memo trước mỗi lượt (xấu nhất) · ấm = memo còn · p95 hạng gần nhất (n<20 ⇒ = max)");
  lines.push("bể CSDL tổ chức = 1 kết nối chỉ đọc (app: 2) ⇒ Promise.all của trang xếp hàng, số nghiêng về CHẬM · danh tính chỉ xem ⇒ thiếu 1 UPDATE staff_seen_at theo khoá chính");
  lines.push(...body);
  const publicLines = lines.slice(0, SUMMARY_MAX_LINES).map(cap);
  return { verdict, publicLines, labels, failedSamples };
}

/** Phần MÃ HOÁ của một tổ chức — mã thật, mã tài khoản, từng lượt; KHÔNG một trường nội dung nào của hội thoại. HÀM THUẦN. */
export function privateLinesOf(o: OrgPerf, label: string): string[] {
  if (!o.result.ok) return [`${label} = ${o.code}: ĐO HỎNG — ${o.result.error.slice(0, 300)}`];
  const one = (tag: string, s: RenderSample, i: number) =>
    `  ${tag} #${i + 1}: ${s.error ? `HỎNG — ${s.error.slice(0, 200)}` : `${ms(s.ms)} ms · listInbox ${ms(s.listMs)} · thread ${ms(s.threadMs)} · SQL ${ms(s.sqlMs)} ms / ${s.queries ?? "—"} câu · hàng ${s.rows ?? "—"}/${s.total ?? "—"} · mục ${s.items ?? "—"}`}`;
  const r = o.result;
  return [
    `${label} = ${o.code}: danh tính ${o.identity ? `${o.identity.kind} · tài khoản ${o.identity.userId} · vai trò đo ${o.identity.role} (gốc ${o.identity.fromRole})` : "—"} · ${r.conversations} hội thoại đem đo`,
    ...r.load.cold.map((s, i) => one("tải nguội", s, i)),
    ...r.load.warm.map((s, i) => one("tải ấm", s, i)),
    ...r.switchTo.cold.map((s, i) => one("chuyển nguội", s, i)),
    ...r.switchTo.warm.map((s, i) => one("chuyển ấm", s, i)),
  ];
}

// ─────────────────────────── ĐO (chỉ đọc, qua ĐÚNG hàm của trang) ───────────────────────────

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/** Bộ lọc MẶC ĐỊNH của page.tsx (không tham số URL nào) — đúng đối tượng `listInbox` nhận khi mở hộp thư. */
const DEFAULT_LIST_QUERY = { filter: "ALL", channel: null, q: "", label: null, page: null, phone: null, level: null, assignee: null, period: null, from: null, to: null, limit: 100, handler: null } as const;

/**
 * ĐÚNG chuỗi lời gọi máy chủ của `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx`, cùng thứ tự tuần tự / song song. `selected` =
 * tham số `?c=` (lượt CHUYỂN); `null` = mở hộp thư (lượt TẢI). Trả số đếm + mã các hội thoại ĐẦU danh sách (chỉ trong bộ nhớ).
 */
export async function renderInboxServerPath(user: SessionUser, selected: string | null): Promise<{ sample: RenderSample; ids: string[] }> {
  const t0 = performance.now();
  let listMs: number | null = null;
  let threadMs: number | null = null;
  let items: number | null = null;
  let error: string | null = null;
  let rows: number | null = null;
  let total: number | null = null;
  let ids: string[] = [];
  const { stats } = await probe(
    "inbox-perf-probe",
    async () => {
      try {
        await listLabels();
        await inboxPages();
        if (selected) {
          const ts = performance.now();
          const loaded = await loadInboxThread(user, selected);
          threadMs = performance.now() - ts;
          if (loaded.ok) items = (customerFacing(user.organization) ? customerInboxThread(loaded.thread) : loaded.thread).items.length;
          else error = `loadInboxThread: ${loaded.error}`;
        }
        const canManage = can(user, "ai_sales:manage");
        const timedList = (async () => {
          const tl = performance.now();
          try {
            return await listInbox(user, DEFAULT_LIST_QUERY);
          } finally {
            listMs = performance.now() - tl;
          }
        })();
        const [list] = await Promise.all([timedList, assignableUsers(user), inboxAssignees(user), organizationLevelPack(), canManage ? listPageRoutes().catch(() => []) : Promise.resolve([]), humanCooldownMinutes(), manualOrderGate(user)]);
        if (list.ok) {
          rows = list.rows.length;
          total = list.total;
          ids = list.rows.map((r) => r.id);
        } else error = error ?? `listInbox: ${list.error}`;
      } catch (e) {
        error = errText(e);
      }
    },
    { top: 0 },
  );
  const sample: RenderSample = { ms: performance.now() - t0, listMs, threadMs, sqlMs: stats.queries > 0 ? stats.dbMs : null, queries: stats.queries > 0 ? stats.queries : null, rows, total, items, error };
  return { sample, ids };
}

/** Lượt đo của MỘT tổ chức — chạy BÊN TRONG `withOrganization(code)`. Không ném: lỗi của từng lượt nằm trong `error` của lượt đó. */
export async function measureInbox(user: SessionUser, samples: number): Promise<{ load: { cold: RenderSample[]; warm: RenderSample[] }; switchTo: { cold: RenderSample[]; warm: RenderSample[] }; conversations: number }> {
  // Lượt mồi (không tính): mở kết nối, nạp mô-đun lười — chi phí một lần của tiến trình, không phải của người dùng.
  const warmup = await renderInboxServerPath(user, null);
  const load = { cold: [] as RenderSample[], warm: [] as RenderSample[] };
  let ids = warmup.ids;
  for (let i = 0; i < samples; i++) {
    clearMemo();
    const r = await renderInboxServerPath(user, null);
    load.cold.push(r.sample);
    if (r.ids.length) ids = r.ids;
  }
  for (let i = 0; i < samples; i++) load.warm.push((await renderInboxServerPath(user, null)).sample);
  const pick = ids.slice(0, samples);
  const switchTo = { cold: [] as RenderSample[], warm: [] as RenderSample[] };
  for (const id of pick) {
    clearMemo();
    switchTo.cold.push((await renderInboxServerPath(user, id)).sample);
    switchTo.warm.push((await renderInboxServerPath(user, id)).sample);
  }
  return { load, switchTo, conversations: pick.length };
}

/**
 * Người ĐỌC hộp thư của tổ chức hiện hành (gọi BÊN TRONG `withOrganization`). Tài khoản lấy từ bộ tính quyền của phiên
 * (`activeUserIdsWhoCan`) — không bịa ai. Ưu tiên tài khoản CHỈ XEM thật; không có ⇒ THU HẸP tài khoản đầu (ADMIN trước, id cố định):
 * bỏ `REPLY_PERMISSIONS`, ADMIN ⇒ VIEWER (ADMIN qua mọi `can()`). Hỏi lại `can()` sau khi dựng: xem được VÀ không gửi được, nếu không ⇒ lỗi.
 */
export async function inboxReader(org: { code: string; name: string; isHome: boolean; brand?: "vnx" | "chotdon" | null }): Promise<{ ok: true; user: SessionUser; identity: NonNullable<OrgPerf["identity"]> } | { ok: false; error: string }> {
  const view = await activeUserIdsWhoCan("ai_sales:view");
  if (!view.length) return { ok: false, error: "Tổ chức không có tài khoản đang bật nào xem được hộp thư (ai_sales:view) — hoặc module ai_sales đang tắt." };
  const reply = new Set([...(await activeUserIdsWhoCan("ai_sales:reply")), ...(await activeUserIdsWhoCan("outreach:send"))]);
  const db = await getDb();
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, permissions: schema.users.permissions })
    .from(schema.users)
    .where(inArray(schema.users.id, view));
  rows.sort((a, b) => Number(reply.has(a.id)) - Number(reply.has(b.id)) || Number(b.role === "ADMIN") - Number(a.role === "ADMIN") || a.id.localeCompare(b.id));
  const row = rows[0];
  if (!row) return { ok: false, error: "Không đọc lại được tài khoản xem hộp thư." };
  const [templates, snapshots, modules] = await Promise.all([loadRoleTemplates(), loadPermissionSnapshots(), getEnabledModules(org.code)]);
  const base: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: resolvePermissions(row.role, row.permissions, templates, snapshots[row.id] ?? null),
    scope: "ALL",
    departmentCodes: [],
    positionId: null,
    organization: { code: org.code, name: org.name, isHome: org.isHome, brand: org.brand ?? null },
    modules: [...modules],
  };
  const sends = (u: SessionUser) => REPLY_PERMISSIONS.some((p) => can(u, p));
  const viewOnly = !reply.has(row.id) && !sends(base);
  const user: SessionUser = viewOnly ? base : { ...base, role: base.role === "ADMIN" ? "VIEWER" : base.role, permissions: base.permissions.filter((p) => !(REPLY_PERMISSIONS as readonly string[]).includes(p)) };
  if (!can(user, "ai_sales:view")) return { ok: false, error: "Danh tính dựng ra không xem được hộp thư (ai_sales:view)." };
  if (sends(user)) return { ok: false, error: "Danh tính dựng ra vẫn gửi tin được — loadInboxThread sẽ GHI staff_seen_at; dừng." };
  return { ok: true, user, identity: { kind: viewOnly ? "VIEW_ONLY_ACCOUNT" : "NARROWED", userId: row.id, role: user.role, fromRole: row.role } };
}

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };

/**
 * Handle CSDL tổ chức cho RIÊNG tiến trình đo: đã có handle sống (ứng dụng / kiểm thử) ⇒ dùng nguyên (`LIVE`); chưa có ⇒ gắn handle
 * CHẨN ĐOÁN (`getDbForInspection`: máy chủ ép chỉ đọc, không migrate, không dọn) vào chỗ `getDb()` tìm handle của tổ chức (`BOUND`).
 * Không gắn thì `getDb()` trong `withOrganization` sẽ MIGRATE + dọn bản sao `platform_*` — không phải một lượt chỉ đọc, và dưới
 * `ERP_READ_ONLY=1` thì nó hỏng ngay ở câu DDL đầu. Cấu trúc sổ handle của db/index.ts đổi ⇒ ném (không lặng lẽ đi đường migrate).
 */
export async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }): Promise<"HOME" | "LIVE" | "BOUND"> {
  if (org.isHome) return "HOME";
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — không gắn được handle chỉ đọc; dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — không gắn được handle chỉ đọc; dừng.");
  if (orgs.get(org.code)?.db) return "LIVE";
  const db = await getDbForInspection(org);
  orgs.set(org.code, { db });
  return "BOUND";
}

export type CollectDeps = {
  /** Mở ngữ cảnh tổ chức cho lượt đo (mặc định: gắn handle chỉ đọc rồi `withOrganization`). */
  enter: <T>(org: { code: string; isHome: boolean }, fn: () => Promise<T>) => Promise<T>;
  /** CSDL của tổ chức (trong ngữ cảnh) có đang bị máy chủ ép chỉ đọc không. */
  orgReadOnly: () => Promise<boolean>;
};

const defaultDeps: CollectDeps = {
  enter: async (org, fn) => {
    await bindReadOnlyOrgHandle(org);
    return withOrganization(org.code, fn);
  },
  orgReadOnly: async () => {
    const [ro] = rowsOf<Record<string, unknown>>(await (await getDb()).execute(sql`show default_transaction_read_only`));
    return String(ro?.default_transaction_read_only ?? "") === "on";
  },
};

/** Đo từng tổ chức. Không ném: tổ chức hỏng ⇒ `result.ok = false` kèm câu lỗi (chỉ phần mã hoá). */
export async function collectInboxPerf(codes: readonly string[], samples: number, deps: Partial<CollectDeps> = {}): Promise<OrgPerf[]> {
  const d = { ...defaultDeps, ...deps };
  const out: OrgPerf[] = [];
  for (const code of codes) {
    try {
      const org = await findOrganization(code);
      if (!org) {
        out.push({ code, identity: null, result: { ok: false, error: "Không có tổ chức này trong sổ." } });
        continue;
      }
      if (org.status !== "ACTIVE") {
        out.push({ code, identity: null, result: { ok: false, error: `Tổ chức đang ${org.status}.` } });
        continue;
      }
      out.push(
        await d.enter(org, async (): Promise<OrgPerf> => {
          if (!(await d.orgReadOnly())) return { code, identity: null, result: { ok: false, error: "DỪNG: CSDL tổ chức KHÔNG ở chế độ chỉ đọc — không đo." } };
          const reader = await inboxReader(org);
          if (!reader.ok) return { code, identity: null, result: { ok: false, error: reader.error } };
          return { code, identity: reader.identity, result: { ok: true, ...(await measureInbox(reader.user, samples)) } };
        }),
      );
    } catch (e) {
      out.push({ code, identity: null, result: { ok: false, error: errText(e) } });
    }
  }
  return out;
}

/** Tổ chức đem đo: `--org` ⇒ đúng mã đó; mặc định ⇒ ACTIVE · không phải nhà · bật `ai_sales`, nghiệm thu trước rồi theo mã, tối đa 10. */
export async function pickOrganizations(org: string | null, acceptance: readonly string[] = ACCEPTANCE_CODES): Promise<{ codes: string[]; cappedFrom: number | null }> {
  if (org) return { codes: [org], cappedFrom: null };
  const all = (await listOrganizations()).filter((o) => o.status === "ACTIVE" && !o.isHome);
  const withAi: string[] = [];
  for (const o of all) {
    try {
      if ((await getEnabledModules(o.code)).has("ai_sales")) withAi.push(o.code);
    } catch {
      // Không đọc được sổ module ⇒ không đoán là có bật; tổ chức không vào lượt mặc định (gõ --org để đo riêng).
    }
  }
  withAi.sort((a, b) => Number(acceptance.includes(b)) - Number(acceptance.includes(a)) || a.localeCompare(b));
  return { codes: withAi.slice(0, MAX_ORGS), cappedFrom: withAi.length > MAX_ORGS ? withAi.length : null };
}

async function main() {
  const args = parseProbeArgs(ARGS);
  if (!args.ok) {
    tomTat(`inbox-perf-probe: DỪNG · cách dùng sai — ${args.error} (arg: [--org=<mã>] [--samples=1..${MAX_SAMPLES}])`);
    process.exit(64);
  }
  if (!(await platformReadOnlyConfirmed())) {
    tomTat("inbox-perf-probe: DỪNG · kết nối CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(70);
  }
  if (process.env.ERP_PERF_PROBE !== "1") console.log("Bộ đếm câu SQL chưa bật (ERP_PERF_PROBE) — cột SQL in «—».");
  const { codes, cappedFrom } = await pickOrganizations(args.org);
  const orgs = await collectInboxPerf(codes, args.samples);
  const report = summarizeInboxPerf(orgs, { samples: args.samples, cappedFrom });
  for (const o of orgs) for (const l of privateLinesOf(o, report.labels.get(o.code) ?? o.code)) console.log(l);
  for (const l of report.publicLines) tomTat(l);
  process.exit(report.verdict === "MEASURED" ? 0 : 1);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.log(`LỖI: ${errText(e)}`);
    tomTat("inbox-perf-probe: ĐO CHƯA TRỌN · LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

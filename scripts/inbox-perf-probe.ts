/*
  ops `inbox-perf-probe` — HỘP THƯ KHÁCH MỞ MẤT BAO LÂU, CHUYỂN HỘI THOẠI MẤT BAO LÂU, ĐO TRÊN DỮ LIỆU THẬT CỦA TỪNG WORKSPACE (CHỈ ĐỌC).

  Vì sao có (09/10/2026): chủ shop cần con số production cho (1) lượt mở Hộp thư khách và (2) lượt chuyển sang một hội thoại khác,
  trên workspace khách SaaS. PGlite ở máy không thay được: dữ liệu khác, kế hoạch truy vấn khác. Script chạy TRONG container
  production và bấm giờ ĐÚNG chuỗi lời gọi máy chủ mà `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx` chạy — không viết truy vấn
  thứ hai (AGENTS §8.12):
   · TẢI (mở /ai/sales-chatbot/inbox, không ?c=): `listLabels` → `inboxPages` → Promise.all[`listInbox` (bộ lọc mặc định, 100 dòng),
     `assignableUsers`, `inboxAssignees`, `organizationLevelPack`, `listPageRoutes` (chỉ khi `ai_sales:manage`), `humanCooldownMinutes`,
     `manualOrderGate`]. Đồng hồ riêng cho `listInbox` (bộ nạp danh sách).
   · CHUYỂN (bấm một hội thoại — từ 10/10/2026 KHÔNG dựng lại trang: đổi `?c=` tại chỗ + `GET /api/ai-sales/inbox-thread`):
     CHỈ `inboxThreadPayload` (đọc hội thoại + lọc chữ nội bộ của workspace khách). Trước đó mỗi cú bấm chạy lại cả lượt TẢI
     (đo HSLC 10/10: listInbox 350–800 ms / cú bấm). Mở bằng đường dẫn có `?c=` vẫn là lượt TẢI + `inboxThreadPayload`. Hội thoại
     đo là N hội thoại ĐẦU danh sách mặc định (mới nhất — đúng thứ người dùng thấy đầu tiên).
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

  CÂU CHẬM NHẤT (13/10/2026 — HSLC listInbox nguội p50 13.364 ms / SQL 18.190 ms trên 31 câu, fixture #792 3.000 hội thoại ~117 ms):
  tổng ms không chỉ ra CÂU nào. Script bọc `query` của CHÍNH handle tổ chức (không đổi lib/ — ops lấy script từ main nhưng lib/ từ
  image) và ghi từng câu của lượt TẢI nguội: chữ câu + tham số (CHỈ trong bộ nhớ), ms, số dòng. Gộp theo HÌNH DẠNG (bỏ tham số), đặt
  tên KHỐI (`queryBlockOf` — listInbox.đếm-thẻ · listInbox.hàng · xem trước …) và in top-N theo trung vị ms qua các lượt. Kèm
  CHẨN ĐOÁN «chưa đọc» 0245 (cột có chưa · công tắc nhà · đường đọc lưu sẵn hay tính trực tiếp · số dòng `turn_unhandled` NULL ·
  số migration đã áp so với sổ của kho) và — khi đo MỘT tổ chức (`--org`) — `EXPLAIN (FORMAT JSON)` KHÔNG ANALYZE (chỉ lập kế hoạch,
  không chạy câu) cho `EXPLAIN_SHAPES` hình dạng chậm nhất. Công khai chỉ mang tên khối, mã băm hình dạng, ms, số câu, số dòng, và
  CẤU TRÚC kế hoạch (loại nút · bảng · chỉ mục · số dòng ước tính · cost) — không điều kiện lọc, không hằng số; chữ câu + kế hoạch đủ
  điều kiện nằm ở phần MÃ HOÁ.

  CỠ `state` + `--analyze` (13/10/2026 tối — probe sau #826: HSLC đọc LƯU SẴN, NULL 0/3.742, mà câu lấy hàng vẫn 7.294 ms, câu đếm thẻ
  5.856 ms; EXPLAIN không ANALYZE chỉ in cost ƯỚC TÍNH — gồm cả nhánh `coalesce` không bao giờ chạy — nên không chỉ ra câu con nào thật
  sự tốn): in cỡ cột `state` JSONB của hội thoại (TB · p95 · max sau nén — `pg_column_size`, không giải nén) và các NHÁNH lớn nhất (tên khoá
  do mã đặt, trên 200 hội thoại mới nhất) — mỗi `state->'…'` trong một điều kiện quét cả hộp thư giải nén TOÀN BỘ giá trị TOAST. Cờ
  `--analyze` (chỉ khi `--org`): `EXPLAIN (ANALYZE, BUFFERS)` hai câu chậm nhất — CHẠY câu SELECT thêm một lần (chỉ đọc, CSDL ép chỉ
  đọc), in thời gian THẬT · số vòng · số dòng từng nút (vẫn chỉ cấu trúc ở kênh công khai).

  arg: `[--org=<mã>] [--samples=<n>] [--analyze]` — mặc định mọi tổ chức ACTIVE (trừ nhà) đang bật `ai_sales`, tối đa 10 (workspace nghiệm thu
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
import { readFileSync } from "node:fs";
import { inArray, sql, type SQL } from "drizzle-orm";
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
import { listPageRoutes } from "@/lib/sales-chatbot/channel-ownership";
import { humanCooldownMinutes } from "@/lib/sales-chatbot/conversation-control";
import { assignableUsers, inboxAssignees, inboxPages, listInbox } from "@/lib/sales-chatbot/inbox";
import { inboxThreadPayload } from "@/lib/sales-chatbot/inbox-thread-payload";
import { listLabels } from "@/lib/sales-chatbot/inbox-labels";
import { organizationLevelPack } from "@/lib/sales-chatbot/levels";
import { inboxUnreadMaterialized } from "@/lib/sales-chatbot/inbox-unread";
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

export type ProbeArgs = { ok: true; org: string | null; samples: number; analyze: boolean } | { ok: false; error: string };

/** Soát arg NGHIÊM: chỉ `--org=<mã>`, `--samples=<1..20>` và cờ `--analyze` (cần `--org`), mỗi cờ một lần, không tham số trần. HÀM THUẦN. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const parts = argv.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  let org: string | null = null;
  let samples: number | null = null;
  let analyze = false;
  for (const p of parts) {
    if (p === "--analyze") {
      if (analyze) return { ok: false, error: "--analyze chỉ một lần" };
      analyze = true;
      continue;
    }
    const m = /^--(org|samples)=(.*)$/.exec(p);
    if (!m) return { ok: false, error: "chỉ nhận --org=<mã>, --samples=<n> và --analyze" };
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
  if (analyze && !org) return { ok: false, error: "--analyze cần --org (chạy lại câu chậm của MỘT tổ chức)" };
  return { ok: true, org, samples: samples ?? DEFAULT_SAMPLES, analyze };
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

// ─────────────────────────── CÂU CHẬM NHẤT · KẾ HOẠCH (PHẦN THUẦN) ───────────────────────────

/** Một câu đã chạy trong lượt đo. `values` chỉ sống trong bộ nhớ (để EXPLAIN đúng câu) — KHÔNG BAO GIỜ in. */
export type CapturedQuery = { text: string; values: readonly unknown[]; ms: number; rows: number };
/** Số hình dạng in ra: đo MỘT tổ chức ⇒ 8; nhiều tổ chức ⇒ 3 (kênh tóm tắt có trần 60 dòng). */
export const TOP_SINGLE_ORG = 8;
export const TOP_MANY_ORGS = 3;
/** Số hình dạng chậm nhất đem EXPLAIN, và trần số dòng CẤU TRÚC kế hoạch mỗi hình dạng trên kênh công khai. */
export const EXPLAIN_SHAPES = 2;
export const PLAN_PUBLIC_LINES = 16;
export const PLAN_PRIVATE_LINES = 60;

/**
 * Tên KHỐI của một câu — chỉ đọc cấu trúc câu (bảng · từ khoá), không đọc tham số. Thứ tự quan trọng: mẫu hẹp trước. HÀM THUẦN.
 * Khối không nhận ra ⇒ «khác:<bảng đầu tiên sau from>» để vẫn lần ra được.
 */
const BLOCKS: readonly [RegExp, string][] = [
  [/count\(\*\) filter \(where/i, "listInbox.đếm-thẻ"],
  [/group by "sales_chat_conversations"\."customer_level"/i, "listInbox.đếm-level"],
  [/"unread_flag"/i, "listInbox.hàng"],
  [/from \(values[\s\S]*left join lateral[\s\S]*"sales_chat_inbound"/i, "listInbox.xem-trước-fanpage"],
  [/from \(values[\s\S]*left join lateral[\s\S]*"sales_chat_messages"/i, "listInbox.xem-trước-web"],
  [/"sales_chat_conversation_labels"|"sales_chat_labels"/i, "nhãn"],
  [/information_schema\.columns/i, "công-tắc-0245.cột"],
  [/from "settings"|"settings"\."key"/i, "settings"],
  [/"channel_page_routes"|page_routes/i, "định-tuyến-page"],
  [/"sales_chat_reads"/i, "con-trỏ-đọc"],
  [/"connector|"connections"|channel_pages/i, "kênh/page"],
  [/from "users"/i, "users"],
];
export function queryBlockOf(text: string): string {
  for (const [re, name] of BLOCKS) if (re.test(text)) return name;
  const m = /\bfrom\s+"?([a-z_][a-z0-9_]*)"?/i.exec(text);
  return `khác:${m ? m[1] : "?"}`;
}

/** Hình dạng ĐỦ của câu (không cắt 240 ký tự như `shapeOf`): gộp khoảng trắng, tham số ⇒ ?, chuỗi hằng ⇒ '?'. HÀM THUẦN. */
export function fullShape(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\$\d+/g, "?")
    .replace(/'[^']*'/g, "'?'")
    .trim();
}
/** Mã băm 8 ký tự (FNV-1a 32 bit) của hình dạng — khoá nối dòng công khai với chữ câu ở phần mã hoá. HÀM THUẦN. */
export function shapeHash(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of fullShape(text)) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type TopQuery = {
  block: string;
  hash: string;
  /** Trung vị qua các lượt có hình dạng này: tổng ms của hình dạng trong lượt · số lần chạy trong lượt · tổng dòng trả về. */
  ms: number;
  calls: number;
  rows: number;
  /** Lượt chậm nhất của MỘT lần chạy (ms) — phân biệt «một câu chậm» với «nhiều câu nhanh» (N+1). */
  maxOne: number;
  /** Lần chạy chậm nhất (để EXPLAIN đúng câu, đúng tham số) — chỉ trong bộ nhớ. */
  slowest: CapturedQuery;
};

/** Gộp các lượt đo theo hình dạng ⇒ top-N theo trung vị ms. Rỗng ⇒ []. HÀM THUẦN. */
export function topQueries(samples: readonly (readonly CapturedQuery[])[], n: number): TopQuery[] {
  const per = new Map<string, { block: string; ms: number[]; calls: number[]; rows: number[]; maxOne: number; slowest: CapturedQuery }>();
  for (const sample of samples) {
    const inSample = new Map<string, { ms: number; calls: number; rows: number }>();
    for (const q of sample) {
      const h = shapeHash(q.text);
      const cur = inSample.get(h) ?? { ms: 0, calls: 0, rows: 0 };
      cur.ms += q.ms;
      cur.calls += 1;
      cur.rows += Math.max(0, q.rows);
      inSample.set(h, cur);
      const agg = per.get(h) ?? { block: queryBlockOf(q.text), ms: [], calls: [], rows: [], maxOne: 0, slowest: q };
      if (q.ms >= agg.maxOne) {
        agg.maxOne = q.ms;
        agg.slowest = q;
      }
      per.set(h, agg);
    }
    for (const [h, v] of inSample) {
      const agg = per.get(h)!;
      agg.ms.push(v.ms);
      agg.calls.push(v.calls);
      agg.rows.push(v.rows);
    }
  }
  return [...per.entries()]
    .map(([hash, a]) => ({ block: a.block, hash, ms: trungVi(a.ms) ?? 0, calls: trungVi(a.calls) ?? 0, rows: trungVi(a.rows) ?? 0, maxOne: a.maxOne, slowest: a.slowest }))
    .sort((x, y) => y.ms - x.ms || x.hash.localeCompare(y.hash))
    .slice(0, Math.max(0, n));
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/** Gốc kế hoạch từ kết quả `EXPLAIN (FORMAT JSON)` (pg trả đối tượng, PGlite có thể trả chuỗi). Không đọc được ⇒ null. HÀM THUẦN. */
export function planRootOf(cell: unknown): PlanNode | null {
  let v: unknown = cell;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const first = Array.isArray(v) ? v[0] : v;
  const plan = first && typeof first === "object" ? (first as { Plan?: unknown }).Plan : null;
  return plan && typeof plan === "object" ? (plan as PlanNode) : null;
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);
const word = (x: unknown) => (typeof x === "string" && /^[A-Za-z0-9_ .$()-]{1,80}$/.test(x) ? x : null);

/**
 * CẤU TRÚC kế hoạch cho kênh CÔNG KHAI: loại nút · bảng · chỉ mục · quan hệ cha (SubPlan / InitPlan) · số dòng ước tính · cost. KHÔNG
 * điều kiện lọc / Index Cond / Output (chúng mang hằng số). Tên bảng / chỉ mục chỉ in khi là định danh trơn. Dòng đầu là tóm tắt
 * (số nút · số SubPlan · bảng bị Seq Scan). HÀM THUẦN.
 */
export function planStructure(root: PlanNode | null, maxLines: number = PLAN_PUBLIC_LINES): string[] {
  if (!root) return ["kế hoạch: không đọc được"];
  const lines: string[] = [];
  let nodes = 0;
  let subplans = 0;
  let neverRun = 0;
  const seq = new Set<string>();
  const walk = (n: PlanNode, depth: number) => {
    nodes += 1;
    const type = word(n["Node Type"]) ?? "?";
    const rel = word(n["Relation Name"]);
    const idx = word(n["Index Name"]);
    const parent = word(n["Parent Relationship"]);
    const sub = word(n["Subplan Name"]);
    if (parent === "SubPlan" || parent === "InitPlan") subplans += 1;
    if (type === "Seq Scan" && rel) seq.add(rel);
    const loops = num(n["Actual Loops"]);
    const actual = typeof n["Actual Total Time"] === "number" && loops !== null ? ` · THẬT ${Math.round((n["Actual Total Time"] as number) * loops)} ms (${loops} vòng × ${num(n["Actual Rows"]) ?? "?"} dòng)` : "";
    if (loops === 0) neverRun += 1;
    lines.push(
      `${"  ".repeat(Math.min(depth, 8))}${sub ? `[${sub}] ` : parent && parent !== "Outer" && parent !== "Inner" && parent !== "Member" ? `[${parent}] ` : ""}${type}${rel ? ` on ${rel}` : ""}${idx ? ` using ${idx}` : ""} · ~${num(n["Plan Rows"]) ?? "?"} dòng · cost ${num(n["Total Cost"]) ?? "?"}${actual}`,
    );
    for (const c of n.Plans ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  const ran = typeof root["Actual Total Time"] === "number" ? ` · THẬT ${Math.round(root["Actual Total Time"] as number)} ms · ${neverRun} nút KHÔNG chạy lần nào` : "";
  const head = `${nodes} nút · ${subplans} SubPlan/InitPlan · Seq Scan: ${seq.size ? [...seq].sort().join(", ") : "không"} · cost gốc ${num(root["Total Cost"]) ?? "?"}${ran}`;
  const body = lines.slice(0, Math.max(0, maxLines - 1));
  return [head, ...body, ...(lines.length > body.length ? [`… (+${lines.length - body.length} nút)`] : [])];
}

/**
 * DẤU HIỆU biểu thức của một nút (13/10/2026 — probe --analyze HSLC: «Seq Scan on sales_chat_conversations · 3772 dòng · THẬT 4.555 ms»
 * và «Limit · THẬT 8.821 ms» trên con 326 ms — biểu thức đắt nằm TRONG nút, phải biết nó là gì mà không lộ dữ liệu): bỏ mọi chuỗi hằng
 * `'…'` rồi chỉ giữ TÊN hàm, TÊN cột (dạng bảng.cột), số lần dùng regex `~`, số lần `->`/`->>`, số SubPlan. Không giá trị nào. HÀM THUẦN.
 */
const NOT_FUNCTIONS = new Set(["and", "or", "not", "case", "when", "then", "else", "end", "in", "any", "all", "exists", "array", "row", "subplan", "initplan", "hashed", "filter", "values"]);
export function exprSignature(node: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["Filter", "Output", "Index Cond", "Recheck Cond", "Join Filter", "Hash Cond", "Merge Cond", "Sort Key", "Group Key"]) {
    const v = node[k];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") parts.push(x);
  }
  const text = parts.join(" , ").replace(/'(?:[^']|'')*'/g, "''");
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const fns = new Map<string, number>();
  // Postgres in tên hàm DÍNH dấu «(» — «c.id (SubPlan 3)» không phải lời gọi hàm.
  for (const m of text.matchAll(/\b([a-z_][a-z0-9_]*)\(/gi)) {
    const f = m[1].toLowerCase();
    if (!NOT_FUNCTIONS.has(f)) fns.set(f, (fns.get(f) ?? 0) + 1);
  }
  const cols = new Map<string, number>();
  for (const m of text.matchAll(/\b[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)\b/gi)) cols.set(m[1], (cols.get(m[1]) ?? 0) + 1);
  const top = (mp: Map<string, number>, n: number) => [...mp.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k, c]) => `${k}×${c}`).join(",");
  const out = [
    fns.size ? `hàm ${top(fns, 8)}` : "",
    cols.size ? `cột ${top(cols, 6)}` : "",
    count(/~\*?/g) ? `regex×${count(/~\*?/g)}` : "",
    count(/->>?/g) ? `json->×${count(/->>?/g)}` : "",
    count(/SubPlan \d+/g) ? `SubPlan×${count(/SubPlan \d+/g)}` : "",
  ].filter(Boolean);
  return out.length ? out.join(" · ") : "—";
}

/**
 * TOP nút theo thời gian THẬT TỰ THÂN (exclusive = tổng của nút − tổng các nút con, kể cả SubPlan/InitPlan — câu con chạy trong biểu
 * thức của nút cha được tính vào cha) trên TOÀN cây, kèm loại · bảng · chỉ mục · vòng · dòng · dòng bị lọc bỏ · dấu hiệu biểu thức.
 * Chỉ có nghĩa với kế hoạch ANALYZE; không có số thật ⇒ []. HÀM THUẦN.
 */
export function planHotNodes(root: PlanNode | null, n = 12): string[] {
  if (!root || typeof root["Actual Total Time"] !== "number") return [];
  const total = (x: PlanNode) => (typeof x["Actual Total Time"] === "number" ? (x["Actual Total Time"] as number) * Number(x["Actual Loops"] ?? 1) : 0);
  const all: { ms: number; line: string }[] = [];
  const walk = (x: PlanNode) => {
    const kids = x.Plans ?? [];
    const self = Math.max(0, total(x) - kids.reduce((t, k) => t + total(k), 0));
    const type = word(x["Node Type"]) ?? "?";
    const rel = word(x["Relation Name"]);
    const idx = word(x["Index Name"]);
    const sub = word(x["Subplan Name"]) ?? (word(x["Parent Relationship"]) === "SubPlan" || word(x["Parent Relationship"]) === "InitPlan" ? word(x["Parent Relationship"]) : null);
    const removed = num(x["Rows Removed by Filter"]);
    all.push({
      ms: self,
      line: `${Math.round(self)} ms tự thân · ${sub ? `[${sub}] ` : ""}${type}${rel ? ` on ${rel}` : ""}${idx ? ` using ${idx}` : ""} · ${num(x["Actual Loops"]) ?? "?"} vòng × ${num(x["Actual Rows"]) ?? "?"} dòng${removed ? ` · lọc bỏ ${removed}` : ""} · ${exprSignature(x)}`,
    });
    for (const k of kids) walk(k);
  };
  walk(root);
  return all
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n)
    .map((x) => x.line);
}

/** Kế hoạch ĐỦ ĐIỀU KIỆN cho phần MÃ HOÁ (có Filter / Index Cond — mang hằng số của câu). Mỗi dòng ≤ 300 ký tự. HÀM THUẦN. */
export function planDetail(root: PlanNode | null, maxLines: number = PLAN_PRIVATE_LINES): string[] {
  if (!root) return ["kế hoạch: không đọc được"];
  const out: string[] = [];
  const keys = ["Filter", "Index Cond", "Recheck Cond", "Join Filter", "Hash Cond", "Merge Cond", "Sort Key", "Group Key"];
  const walk = (n: PlanNode, depth: number) => {
    const pad = "  ".repeat(Math.min(depth, 8));
    out.push(`${pad}${String(n["Subplan Name"] ?? n["Parent Relationship"] ?? "")} ${String(n["Node Type"] ?? "?")} ${String(n["Relation Name"] ?? "")} ${String(n["Index Name"] ?? "")} rows=${String(n["Plan Rows"] ?? "?")} cost=${String(n["Total Cost"] ?? "?")}`.slice(0, 300));
    for (const k of keys) if (n[k] !== undefined) out.push(`${pad}  ${k}: ${typeof n[k] === "string" ? n[k] : JSON.stringify(n[k])}`.slice(0, 300));
    for (const c of n.Plans ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return out.slice(0, maxLines);
}

/** Chẩn đoán «chưa đọc» 0245 của MỘT tổ chức. `null` ở từng trường = CHƯA ĐỌC ĐƯỢC (không phải 0 / không). */
export type InboxDiag = {
  /** Số cột 0245 có trên CSDL tổ chức (2 = đủ). */
  columns: number | null;
  /** Đường đọc hộp thư đang dùng: `true` = lưu sẵn 0245; `false` = tính trực tiếp bằng hàm #803 (đắt cho từng hội thoại). */
  materialized: boolean | null;
  conversations: number | null;
  /** Hội thoại có `turn_unhandled` NULL — mỗi dòng như vậy rơi về phép tính trực tiếp trong bộ đếm + khoá xếp. */
  nullTurns: number | null;
  migrationsApplied: number | null;
  migrationsInRepo: number | null;
  pgVersion: string | null;
  /** Cỡ cột `state` (byte, SAU NÉN — `pg_column_size`, không giải nén). */
  stateBytes?: { avg: number | null; p95: number | null; max: number | null };
  /** Nhánh cấp một lớn nhất của `state` trên 200 hội thoại mới nhất (tên khoá do mã đặt) — byte trung bình. */
  stateKeys?: { key: string; avg: number }[];
};

const yn = (x: boolean | null, yes: string, no: string) => (x === null ? "—" : x ? yes : no);
/** Một dòng công khai của chẩn đoán (số đếm, không dữ liệu khách). HÀM THUẦN. */
const kb = (b: number | null) => (b === null ? "—" : `${(b / 1024).toFixed(1).replace(".", ",")} KB`);
/** Dòng công khai cỡ `state` (byte + tên khoá do mã đặt). `null` nếu chưa đọc được. HÀM THUẦN. */
export function stateLine(label: string, d: InboxDiag): string | null {
  if (!d.stateBytes) return null;
  const keys = (d.stateKeys ?? []).filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k.key)).slice(0, 6);
  return `${label} cột state hội thoại (sau nén): TB ${kb(d.stateBytes.avg)} · p95 ${kb(d.stateBytes.p95)} · max ${kb(d.stateBytes.max)} · nhánh lớn nhất (200 hội thoại mới nhất): ${keys.length ? keys.map((k) => `${k.key} ~${kb(k.avg)}`).join(" · ") : "—"}`;
}

export function diagLine(label: string, d: InboxDiag): string {
  const cols = d.columns === null ? "—" : d.columns === 2 ? "đủ 2/2" : `THIẾU (${d.columns}/2)`;
  const nulls = d.nullTurns === null ? "—" : `${d.nullTurns}/${d.conversations ?? "—"}`;
  return `${label} chẩn đoán «chưa đọc» 0245: cột ${cols} · đường đọc ${yn(d.materialized, "LƯU SẴN", "TÍNH TRỰC TIẾP (hàm #803 cho từng hội thoại)")} · turn_unhandled NULL ${nulls} · migration đã áp ${d.migrationsApplied ?? "—"} (sổ kho ${d.migrationsInRepo ?? "—"}) · PG ${d.pgVersion ?? "—"}`;
}

/** Dòng công khai của một hình dạng chậm. HÀM THUẦN. */
export function topLine(label: string, i: number, t: TopQuery): string {
  return `${label} câu chậm #${i + 1} ${t.block} [${t.hash}]: ${Math.round(t.ms)} ms/lượt · ${t.calls} lần/lượt · lần chậm nhất ${Math.round(t.maxOne)} ms · ${t.rows} dòng`;
}

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
  /** Từng câu của lượt (chữ + tham số CHỈ trong bộ nhớ — không in) — chỉ có ở lượt TẢI. */
  captured?: CapturedQuery[];
};

export type IdentityKind = "VIEW_ONLY_ACCOUNT" | "NARROWED";
export type OrgPerf = {
  code: string;
  identity: { kind: IdentityKind; userId: string; role: string; fromRole: string } | null;
  result:
    | { ok: true; load: { cold: RenderSample[]; warm: RenderSample[] }; switchTo: { cold: RenderSample[]; warm: RenderSample[] }; conversations: number; diag?: InboxDiag | null; slow?: SlowReport }
    | { ok: false; error: string };
};

/** Câu chậm nhất của lượt TẢI nguội + kế hoạch (EXPLAIN không ANALYZE) của vài hình dạng đầu. */
export type SlowReport = { top: TopQuery[]; plans: { hash: string; block: string; structure: string[]; detail: string[]; hot?: string[] }[] };

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
export function summarizeInboxPerf(orgs: readonly OrgPerf[], opts: { samples: number; acceptanceCodes?: readonly string[]; cappedFrom?: number | null; top?: number } = { samples: DEFAULT_SAMPLES }): InboxPerfReport {
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
    if (r.diag) body.push(diagLine(label, r.diag));
    const sl = r.diag ? stateLine(label, r.diag) : null;
    if (sl) body.push(sl);
    if (r.slow) {
      const n = opts.top ?? (orgs.length === 1 ? TOP_SINGLE_ORG : TOP_MANY_ORGS);
      r.slow.top.slice(0, n).forEach((t, i) => body.push(topLine(label, i, t)));
      for (const p of r.slow.plans) {
        // Có số THẬT ⇒ dòng tóm tắt + TOP nút tự thân (cây đầy đủ bị cắt ở 16 dòng không chỉ ra nút tốn); không ⇒ cấu trúc như cũ.
        const lines = p.hot && p.hot.length ? [p.structure[0], ...p.hot.map((h, i) => `nút nóng #${i + 1}: ${h}`)] : p.structure;
        body.push(...lines.map((l, i) => `${label} kế hoạch [${p.hash}] ${p.block}${i === 0 ? ": " : " │ "}${l}`));
      }
    }
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
    ...(r.slow?.top ?? []).flatMap((t) => {
      const shape = fullShape(t.slowest.text);
      return [`  hình dạng [${t.hash}] ${t.block}: ${shape.slice(0, 280)}`, ...(shape.length > 280 ? [`    … ${shape.slice(280, 560)}${shape.length > 560 ? ` … (+${shape.length - 560} ký tự)` : ""}`] : [])];
    }),
    ...(r.slow?.plans ?? []).flatMap((p) => [`  kế hoạch đủ [${p.hash}] ${p.block}:`, ...p.detail.map((l) => `    ${l}`)]),
  ];
}

// ─────────────────────────── ĐO (chỉ đọc, qua ĐÚNG hàm của trang) ───────────────────────────

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/*
  BẮT TỪNG CÂU: bọc `query` của client CSDL tổ chức (`db.$client` — bể pg hoặc PGlite; cả hai đều là `query(text|config, values)`).
  Lớp bọc của db/index.ts (`instrumentQueries`) chỉ ghi chữ câu; cần cả tham số để EXPLAIN đúng câu. Bọc MỘT lần mỗi client (WeakMap
  giữ hàm gốc), chỉ ghi khi `sink` đang mở — ngoài lượt đo không tốn gì. Không đổi câu nào, không chạy thêm câu nào.
*/
type QueryFn = (...args: unknown[]) => Promise<unknown>;
export const EXPLAIN_PLAN_ONLY = "EXPLAIN (FORMAT JSON)";
export const EXPLAIN_RUN = "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)";
const originals = new WeakMap<object, QueryFn>();
let sink: CapturedQuery[] | null = null;

function argText(args: readonly unknown[]): string {
  const a = args[0];
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && "text" in a) return String((a as { text: unknown }).text);
  return "(không rõ)";
}
function argValues(args: readonly unknown[]): unknown[] {
  if (Array.isArray(args[1])) return args[1] as unknown[];
  const a = args[0];
  if (a && typeof a === "object" && Array.isArray((a as { values?: unknown }).values)) return (a as { values: unknown[] }).values;
  return [];
}

/** Bọc client của handle `db` (một lần). Trả hàm `query` GỐC — EXPLAIN gọi thẳng nó để không tự ghi vào lượt đo. */
export function installCapture(db: unknown): QueryFn | null {
  const client = (db as { $client?: unknown } | null)?.$client;
  if (!client || typeof client !== "object" || typeof (client as { query?: unknown }).query !== "function") return null;
  const known = originals.get(client);
  if (known) return known;
  const c = client as { query: QueryFn };
  const original = c.query.bind(c) as QueryFn;
  originals.set(client, original);
  c.query = async (...args: unknown[]) => {
    const target = sink;
    if (!target) return original(...args);
    const t = performance.now();
    let rows = -1;
    try {
      const r = (await original(...args)) as { rows?: unknown[] } | undefined;
      rows = r?.rows?.length ?? 0;
      return r;
    } finally {
      target.push({ text: argText(args), values: argValues(args), ms: performance.now() - t, rows });
    }
  };
  return original;
}

/**
 * `EXPLAIN (FORMAT JSON)` — mặc định KHÔNG ANALYZE: chỉ lập kế hoạch, câu không chạy. `analyze` (cờ `--analyze`, chỉ khi `--org`) ⇒ chạy
 * câu SELECT thêm MỘT lần (CSDL ép chỉ đọc) để có thời gian thật từng nút. Hỏng ⇒ null (kế hoạch «không đọc được»).
 */
export async function explainPlan(original: QueryFn, q: CapturedQuery, analyze = false): Promise<ReturnType<typeof planRootOf>> {
  try {
    const r = (await original(`${analyze ? EXPLAIN_RUN : EXPLAIN_PLAN_ONLY} ${q.text}`, [...q.values])) as { rows?: Record<string, unknown>[] } | undefined;
    const row = r?.rows?.[0];
    return planRootOf(row ? (row["QUERY PLAN"] ?? Object.values(row)[0]) : null);
  } catch {
    return null;
  }
}

/** Số migration trong sổ của kho (script chạy từ main ⇒ sổ của main; image có thể cũ hơn). Không đọc được ⇒ null. */
function migrationsInRepo(): number | null {
  try {
    const j = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries?: unknown[] };
    return Array.isArray(j.entries) ? j.entries.length : null;
  } catch {
    return null;
  }
}

async function scalar(db: Db, q: SQL, key: string): Promise<unknown> {
  try {
    const [r] = rowsOf<Record<string, unknown>>(await db.execute(q));
    return r?.[key] ?? null;
  } catch {
    return null;
  }
}
const asNum = (x: unknown) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));

/** Chẩn đoán 0245 của tổ chức hiện hành (trong `withOrganization`) — mỗi phép đọc độc lập, hỏng ⇒ trường đó `null`. */
export async function inboxDiagnostics(): Promise<InboxDiag> {
  const db = await getDb();
  const columns = asNum(await scalar(db, sql`select count(*)::int as n from information_schema.columns where table_schema = current_schema() and table_name = 'sales_chat_conversations' and column_name in ('turn_unhandled', 'last_read_at')`, "n"));
  clearMemo();
  const materialized = await inboxUnreadMaterialized().catch(() => null);
  const conversations = asNum(await scalar(db, sql`select count(*)::int as n from "sales_chat_conversations" where "channel" <> 'TEST'`, "n"));
  const nullTurns = columns === 2 ? asNum(await scalar(db, sql`select count(*)::int as n from "sales_chat_conversations" where "channel" <> 'TEST' and "turn_unhandled" is null`, "n")) : null;
  const migrationsApplied = asNum(await scalar(db, sql`select count(*)::int as n from "drizzle"."__drizzle_migrations"`, "n"));
  const version = await scalar(db, sql`show server_version`, "server_version");
  let stateBytes: InboxDiag["stateBytes"];
  let stateKeys: InboxDiag["stateKeys"];
  try {
    const [r] = rowsOf<Record<string, unknown>>(
      await db.execute(sql`select avg(pg_column_size("state"))::int as a, (percentile_cont(0.95) within group (order by pg_column_size("state")))::int as p, max(pg_column_size("state"))::int as m from "sales_chat_conversations" where "channel" <> 'TEST'`),
    );
    stateBytes = { avg: asNum(r?.a), p95: asNum(r?.p), max: asNum(r?.m) };
    stateKeys = rowsOf<{ k: string; b: number }>(
      await db.execute(sql`select e.key as k, avg(pg_column_size(e.value))::int as b from (select "state" as s from "sales_chat_conversations" where "channel" <> 'TEST' and jsonb_typeof("state") = 'object' order by "updated_at" desc limit 200) x, jsonb_each(x.s) e group by e.key order by b desc limit 8`),
    ).map((x) => ({ key: String(x.k), avg: Number(x.b) }));
  } catch {
    stateBytes = undefined;
  }
  return { columns, materialized, conversations, nullTurns, migrationsApplied, migrationsInRepo: migrationsInRepo(), pgVersion: version === null ? null : String(version).slice(0, 40), stateBytes, stateKeys };
}

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
  const captured: CapturedQuery[] = [];
  sink = selected ? null : captured;
  const { stats } = await probe(
    "inbox-perf-probe",
    async () => {
      try {
        await listLabels();
        await inboxPages();
        if (selected) {
          const ts = performance.now();
          const loaded = await inboxThreadPayload(user, selected);
          threadMs = performance.now() - ts;
          if (loaded.ok) items = loaded.thread.items.length;
          else error = `inboxThreadPayload: ${loaded.error}`;
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
  ).finally(() => {
    sink = null;
  });
  const sample: RenderSample = { ms: performance.now() - t0, listMs, threadMs, sqlMs: stats.queries > 0 ? stats.dbMs : null, queries: stats.queries > 0 ? stats.queries : null, rows, total, items, error, ...(selected ? {} : { captured }) };
  return { sample, ids };
}

/** ĐÚNG lời gọi máy chủ của route `/api/ai-sales/inbox-thread` khi người bấm sang hội thoại `id` (không dựng lại danh sách). */
export async function switchConversationPath(user: SessionUser, id: string): Promise<RenderSample> {
  const t0 = performance.now();
  let items: number | null = null;
  let error: string | null = null;
  const { stats } = await probe(
    "inbox-perf-probe",
    async () => {
      try {
        const loaded = await inboxThreadPayload(user, id);
        if (loaded.ok) items = loaded.thread.items.length;
        else error = `inboxThreadPayload: ${loaded.error}`;
      } catch (e) {
        error = errText(e);
      }
    },
    { top: 0 },
  );
  const ms = performance.now() - t0;
  return { ms, listMs: null, threadMs: ms, sqlMs: stats.queries > 0 ? stats.dbMs : null, queries: stats.queries > 0 ? stats.queries : null, rows: null, total: null, items, error };
}

/** Lượt đo của MỘT tổ chức — chạy BÊN TRONG `withOrganization(code)`. Không ném: lỗi của từng lượt nằm trong `error` của lượt đó. */
export async function measureInbox(
  user: SessionUser,
  samples: number,
  opts: { explain?: boolean; analyze?: boolean; top?: number } = {},
): Promise<{ load: { cold: RenderSample[]; warm: RenderSample[] }; switchTo: { cold: RenderSample[]; warm: RenderSample[] }; conversations: number; diag: InboxDiag | null; slow: SlowReport }> {
  const original = installCapture(await getDb());
  const diag = await inboxDiagnostics().catch(() => null);
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
    switchTo.cold.push(await switchConversationPath(user, id));
    switchTo.warm.push(await switchConversationPath(user, id));
  }
  // Câu chậm nhất: CHỈ lượt TẢI nguội (điều kiện xấu nhất, như số công khai); chữ + tham số rời khỏi mẫu ngay sau khi gộp.
  const top = topQueries(
    load.cold.filter((x) => x.error === null).map((x) => x.captured ?? []),
    Math.max(opts.top ?? TOP_SINGLE_ORG, EXPLAIN_SHAPES),
  );
  for (const s of [...load.cold, ...load.warm]) delete s.captured;
  const plans: SlowReport["plans"] = [];
  if (opts.explain && original) {
    for (const t of top.slice(0, EXPLAIN_SHAPES)) {
      const root = await explainPlan(original, t.slowest, Boolean(opts.analyze));
      plans.push({ hash: t.hash, block: t.block, structure: planStructure(root), detail: planDetail(root), hot: planHotNodes(root) });
    }
  }
  return { load, switchTo, conversations: pick.length, diag, slow: { top, plans } };
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
export async function collectInboxPerf(codes: readonly string[], samples: number, deps: Partial<CollectDeps> = {}, opts: { explain?: boolean; analyze?: boolean; top?: number } = {}): Promise<OrgPerf[]> {
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
          return { code, identity: reader.identity, result: { ok: true, ...(await measureInbox(reader.user, samples, opts)) } };
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
  // EXPLAIN chỉ khi đo MỘT tổ chức (`--org`): kênh tóm tắt có trần 60 dòng, và đó là lượt đi tìm câu chậm.
  const top = codes.length === 1 ? TOP_SINGLE_ORG : TOP_MANY_ORGS;
  const orgs = await collectInboxPerf(codes, args.samples, {}, { explain: Boolean(args.org), analyze: args.analyze, top });
  const report = summarizeInboxPerf(orgs, { samples: args.samples, cappedFrom, top });
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

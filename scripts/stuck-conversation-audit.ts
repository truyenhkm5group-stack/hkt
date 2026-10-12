/*
  ops `stuck-conversation-audit` — HỘI THOẠI AI BÁN HÀNG ĐANG KẸT Ở ĐÂU, ĐO TRÊN DỮ LIỆU THẬT TRƯỚC KHI SỬA (CHỈ ĐỌC).

  Vì sao có (HOTFIX P0 12/10/2026, chủ shop HSLC — ca «Khanh Nhung», đơn #6495CA72): hộp thư in «AI đã dừng · Chờ 1.500+ phút ·
  Phụ trách: KHÔNG CHỦ — Phòng phụ trách chưa có ai xem được hộp thư», đơn hiện «Chưa gửi» trong khi khách nhắn «Tôi nhận hàng rồi
  nhưng chưa thử chất lượng». Trước khi sửa phải biết PHẠM VI trên toàn hệ thống, chia theo đúng câu hỏi chủ shop hỏi:

   A  AI dừng > 60 / 240 / 1.440 phút, chia theo NHÓM LÝ DO (bốn trạng thái chủ shop muốn tách: AI đang xử lý · CHỜ NGƯỜI · LỖI KỸ
      THUẬT · TẠM DỪNG CÓ CHỦ ĐÍCH) và theo LÝ DO cụ thể (chuyển người sau chốt đơn · khách báo chuyển khoản · hàng rào khẳng định ·
      công cụ xin người · AI hỏng · nhân viên tiếp quản …). Riêng «AI hỏng»: đồng hồ thử lại của hộp thư đọc `updated_at + 30 phút`
      — mọi lượt ghi vào hội thoại (đóng dấu hàng đợi, mở hội thoại, nhật ký ghi đơn…) đẩy `updated_at` về «bây giờ» ⇒ đếm riêng số
      hội thoại AI HỎNG ĐÃ QUÁ 30 PHÚT tính từ mốc hỏng thật mà vẫn bị coi là đang trong khoảng chờ (`AI_DOWN_CLOCK_PUSHED`).
   B  CẦN NGƯỜI MÀ KHÔNG CHỦ — câu đếm `countUnownedHandoffs` của #800 (chưa vào hàng đợi · phòng không ai xem được hộp thư) + số
      người xem được hộp thư của CẢ tổ chức (≥ 1 ⇒ hội thoại «không chủ» vẫn có người nhận được nếu có hàng đợi chung).
   C  SLA QUÁ HẠN — hạn theo `work.sla` (`handoffDueAt` của #800) tính từ mốc vào hàng đợi; quá hạn · quá hạn > 24 giờ mà chưa ai
      cầm (ngưỡng STALE của luật 26).
   D  NHẮN LẠI SAI NGỮ CẢNH — `followup.sent` trong kỳ mà lúc gửi hội thoại ĐÃ có đơn sống không còn là nháp (đơn ≠ Mới / Huỷ / Xoá).
   E  ĐƠN KHÔNG ĐỒNG BỘ — đơn nối với hội thoại, tạo trong kỳ, còn sống: theo `ORDER_OUTCOME` (nguồn duy nhất); đơn đã chốt > 3 ngày
      mà ERP KHÔNG có vận đơn nào (hộp thư in «Chưa gửi» cho đúng nhóm này); đơn ERP + đơn Pancake cùng một hội thoại trong ± 3 ngày;
      đơn ERP còn sống thiếu xã / phường; khách NÓI đã nhận hàng mà ERP chưa có chứng từ giao (lời khách KHÔNG đổi trạng thái đơn —
      chỉ đếm để biết bao nhiêu khách đang ở giai đoạn sau bán mà ERP không thấy).

  arg: `<mã tổ chức> | --all [--days=1..30] [--conv=<uuid>] [--order=<mã ngắn 8 ký tự>]`. `--all` = nhà + mọi tổ chức ACTIVE.
  `--conv` / `--order` in dòng thời gian trạng thái của MỘT hội thoại (chỉ phần MÃ HOÁ, không tên / SĐT / chữ tin).

  RÀNG BUỘC: ops lấy script từ `main` nhưng `lib/` từ IMAGE đang chạy ⇒ phần đếm chính là SQL THÔ trên cột đã có từ 0242 (#800) —
  không nhập hàm mới nào của bản vá. Hai phép dùng lib (B, C) đọc qua `withOrganization` sau khi GẮN handle chỉ đọc
  (`bindReadOnlyOrgHandle`, như scripts/inbox-perf-probe.ts); lib cũ / thiếu ⇒ in «CHƯA ĐO ĐƯỢC», không phải 0. CHỈ ĐỌC do Postgres
  ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên). Kênh `[ops:tom-tat] ` chỉ số đếm; mã hội thoại / lý do nguyên
  văn chỉ ở phần MÃ HOÁ (ops-vps `OPS_THAO_TAC_MA_HOA`). Mã thoát: 0 đo xong · 1 có CSDL hỏng / arg sai.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("stuck-conversation-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export const STUCK_DEFAULT_DAYS = 7;
export const STUCK_MAX_DAYS = 30;
/** Ngưỡng phút «AI dừng lâu» in ra — chỉ là MỐC ĐẾM, không phải đích đạt / không đạt (AGENTS 38). */
export const STUCK_MINUTE_BUCKETS = [60, 240, 1440] as const;
/** Đơn đã chốt quá chừng này mà ERP chưa có vận đơn ⇒ «chưa đồng bộ vận chuyển» (mốc đếm). */
export const NO_SHIPMENT_AFTER_DAYS = 3;
/** Khoảng nhường của AI hỏng — bản sao số của `HUMAN_COOLDOWN_MINUTES` (ai-hold-shared.ts); bài kiểm so hai giá trị. */
export const AI_DOWN_RETRY_MINUTES = 30;
/** Bản sao chữ (script tự chứa — ops lấy lib từ image): bài kiểm so bằng nhau với hằng gốc. */
export const REASON_TEXT = {
  AI_DOWN: "AI tạm không trả lời được — nhân viên liên hệ lại khách",
  FANPAGE_STAFF: "Nhân viên đang trả lời trên fanpage",
  ZALO_STAFF: "Nhân viên đang trả lời trên Zalo OA",
  WEB_STAFF: "Nhân viên đang trả lời trên chat web",
  POST_ORDER_PREFIX: "Khách nhắn sau khi đã chốt đơn",
  LONG: "Hội thoại quá dài",
  TOOL_LOOP: "Quá số vòng công cụ",
  TOOL_REQUIRE_PREFIX: "Cần người xử lý — ",
  TAKEOVER: "Nhân viên tiếp quản hội thoại",
  ORDER_WRITE_PREFIX: "Ghi đơn hỏng",
  PRICE_PREFIX: "Giá / tồn bất thường",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = `<mã tổ chức> | --all [--days=1..${STUCK_MAX_DAYS}] [--conv=<uuid>] [--order=<mã ngắn>]`;

export type StuckArgs = { all: boolean; code: string | null; days: number; conv: string | null; order: string | null };

/** Soát đối số. HÀM THUẦN. */
export function parseStuckArgs(argv: readonly string[]): StuckArgs | { error: string } {
  const args = argv.map((a) => a.trim()).filter(Boolean);
  const free = args.filter((a) => !a.startsWith("--"));
  const all = args.includes("--all");
  const val = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--all" && !/^--(days|conv|order)=/.test(a));
  if (unknown.length) return { error: `cờ lạ: ${unknown.join(" ")}` };
  if (all && free.length) return { error: "--all không đi kèm mã tổ chức" };
  if (!all && free.length !== 1) return { error: "cần đúng MỘT mã tổ chức hoặc --all" };
  const code = all ? null : free[0];
  if (code !== null && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "sai mã tổ chức" };
  const rawDays = val("days");
  const days = rawDays === undefined ? STUCK_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > STUCK_MAX_DAYS) return { error: `--days phải là số nguyên 1..${STUCK_MAX_DAYS}` };
  const conv = val("conv") ?? null;
  if (conv !== null && !UUID_RE.test(conv)) return { error: "--conv phải là mã hội thoại dạng uuid" };
  const rawOrder = val("order") ?? null;
  const order = rawOrder === null ? null : rawOrder.replace(/^#/, "").toLowerCase();
  if (order !== null && !/^[0-9a-f]{8}$/.test(order)) return { error: "--order phải là mã ngắn 8 ký tự hex (vd 6495CA72)" };
  if (all && (conv || order)) return { error: "--conv / --order chỉ dùng với MỘT mã tổ chức" };
  return { all, code, days, conv, order };
}

/** Bốn trạng thái chủ shop muốn tách khi AI không trả lời. */
export const STUCK_GROUPS = ["WAITING_HUMAN", "TECH_ERROR", "INTENTIONAL_PAUSE"] as const;
export type StuckGroup = (typeof STUCK_GROUPS)[number];
export const STUCK_GROUP_LABEL: Record<StuckGroup, string> = { WAITING_HUMAN: "chờ người", TECH_ERROR: "lỗi kỹ thuật", INTENTIONAL_PAUSE: "tạm dừng có chủ đích" };

export const STUCK_CLASSES = [
  "TAKEOVER",
  "STAFF_PAUSE_ACTIVE",
  "STAFF_PAUSE_EXPIRED",
  "WEB_STAFF",
  "AI_DOWN_ACTIVE",
  "AI_DOWN_CLOCK_PUSHED",
  "AI_DOWN_EXPIRED",
  "POST_ORDER",
  "PAYMENT_CLAIM",
  "CLAIM_GUARD",
  "PRICE",
  "TOOL_REQUIRE",
  "CANCEL",
  "ORDER_WRITE",
  "LONG",
  "TOOL_LOOP",
  "MODEL_HANDOFF",
  "NO_REASON",
] as const;
export type StuckClass = (typeof STUCK_CLASSES)[number];

export const STUCK_CLASS_GROUP: Record<StuckClass, StuckGroup> = {
  TAKEOVER: "INTENTIONAL_PAUSE",
  STAFF_PAUSE_ACTIVE: "INTENTIONAL_PAUSE",
  STAFF_PAUSE_EXPIRED: "INTENTIONAL_PAUSE",
  WEB_STAFF: "INTENTIONAL_PAUSE",
  AI_DOWN_ACTIVE: "TECH_ERROR",
  AI_DOWN_CLOCK_PUSHED: "TECH_ERROR",
  AI_DOWN_EXPIRED: "TECH_ERROR",
  POST_ORDER: "WAITING_HUMAN",
  PAYMENT_CLAIM: "WAITING_HUMAN",
  CLAIM_GUARD: "WAITING_HUMAN",
  PRICE: "WAITING_HUMAN",
  TOOL_REQUIRE: "WAITING_HUMAN",
  CANCEL: "WAITING_HUMAN",
  ORDER_WRITE: "WAITING_HUMAN",
  LONG: "WAITING_HUMAN",
  TOOL_LOOP: "WAITING_HUMAN",
  MODEL_HANDOFF: "WAITING_HUMAN",
  NO_REASON: "WAITING_HUMAN",
};

/** Một hội thoại AI đang không trả lời (`status = 'HANDOFF'` hoặc chế độ HUMAN). Mốc là Date hoặc null. */
export type SilentRow = {
  status: string;
  reason: string | null;
  mode: string | null;
  handoffAt: Date | null;
  handoffReason: string | null;
  updatedAt: Date;
  cooldownUntil: Date | null;
  queuedAt: Date | null;
};

const valid = (d: Date | null): Date | null => (d && Number.isFinite(d.getTime()) ? d : null);

/** Nhóm lý do của MỘT hội thoại AI im tại `now`. HÀM THUẦN. */
export function classifyStuck(r: SilentRow, now: Date): StuckClass {
  const reason = r.reason ?? "";
  const t = now.getTime();
  if (r.mode === "HUMAN" || reason === REASON_TEXT.TAKEOVER) return "TAKEOVER";
  if (reason === REASON_TEXT.WEB_STAFF) return "WEB_STAFF";
  if (reason === REASON_TEXT.FANPAGE_STAFF || reason === REASON_TEXT.ZALO_STAFF) {
    const until = valid(r.cooldownUntil) ?? new Date(r.updatedAt.getTime() + AI_DOWN_RETRY_MINUTES * 60_000);
    return until.getTime() > t ? "STAFF_PAUSE_ACTIVE" : "STAFF_PAUSE_EXPIRED";
  }
  if (reason === REASON_TEXT.AI_DOWN) {
    const shown = r.updatedAt.getTime() + AI_DOWN_RETRY_MINUTES * 60_000;
    const start = (r.handoffReason === REASON_TEXT.AI_DOWN ? valid(r.handoffAt) : null) ?? valid(r.queuedAt);
    if (shown <= t) return "AI_DOWN_EXPIRED";
    if (start && start.getTime() + AI_DOWN_RETRY_MINUTES * 60_000 <= t) return "AI_DOWN_CLOCK_PUSHED";
    return "AI_DOWN_ACTIVE";
  }
  if (!reason) return "NO_REASON";
  if (reason.startsWith(REASON_TEXT.POST_ORDER_PREFIX)) return "POST_ORDER";
  if (reason.startsWith("Khách báo đã chuyển khoản")) return "PAYMENT_CLAIM";
  if (reason.startsWith("AI định khẳng định")) return "CLAIM_GUARD";
  if (reason.startsWith(REASON_TEXT.ORDER_WRITE_PREFIX)) return "ORDER_WRITE";
  if (reason.startsWith(REASON_TEXT.PRICE_PREFIX) || reason.startsWith("Cần người xử lý — Giá bất thường")) return "PRICE";
  if (reason.startsWith("Khách huỷ đơn")) return "CANCEL";
  if (reason === REASON_TEXT.LONG) return "LONG";
  if (reason === REASON_TEXT.TOOL_LOOP) return "TOOL_LOOP";
  if (reason.startsWith(REASON_TEXT.TOOL_REQUIRE_PREFIX)) return "TOOL_REQUIRE";
  return "MODEL_HANDOFF";
}

/**
 * Mốc AI bắt đầu im: dấu vào hàng đợi (#800) → `state.handoff.at` → `updated_at` (ƯỚC TÍNH — cột này bị mọi lượt ghi đẩy tới nên chỉ
 * làm số im lặng NHỎ HƠN thật, không bao giờ lớn hơn). HÀM THUẦN.
 */
export function silentSince(r: SilentRow): { at: Date; estimated: boolean } {
  const q = valid(r.queuedAt) ?? valid(r.handoffAt);
  return q ? { at: q, estimated: false } : { at: r.updatedAt, estimated: true };
}

/** Khách tự nói ĐÃ NHẬN HÀNG — chỉ để ĐẾM (lời khai của khách, không đổi trạng thái đơn). Bản SQL ở `RECEIPT_CLAIM_SQL_RE`. HÀM THUẦN. */
export const RECEIPT_CLAIM_RE = /(?:đã|da|mới|moi|vừa|vua)\s+nh[aậ]n\s+(?:được\s+|duoc\s+)?(?:h[aà]ng|đơn|don)|nh[aậ]n\s+(?:được\s+|duoc\s+)?(?:h[aà]ng|đơn|don)\s+r[oồ]i|h[aà]ng\s+(?:v[eề]|t[oớ]i|đến|den)\s+r[oồ]i/i;
export const RECEIPT_CLAIM_SQL_RE = "((đã|da|mới|moi|vừa|vua)[[:space:]]+nh[aậ]n[[:space:]]+((được|duoc)[[:space:]]+)?(h[aà]ng|đơn|don)|nh[aậ]n[[:space:]]+((được|duoc)[[:space:]]+)?(h[aà]ng|đơn|don)[[:space:]]+r[oồ]i|h[aà]ng[[:space:]]+(v[eề]|t[oớ]i|đến|den)[[:space:]]+r[oồ]i)";

export type StuckCounts = {
  silent: number;
  /** Số hội thoại theo nhóm lý do × ngưỡng phút (`> 60` · `> 240` · `> 1440`). */
  byClass: Record<StuckClass, { total: number; over: number[] }>;
  /** Số im lặng có mốc ƯỚC TÍNH (thiếu dấu hàng đợi lẫn `state.handoff.at`). */
  estimated: number;
  /** Khách đang chờ trả lời (tin cuối là của khách) trong nhóm AI im. */
  customerWaiting: number;
  longest: { minutes: number; cls: StuckClass } | null;
};

export function emptyCounts(): StuckCounts {
  return { silent: 0, byClass: Object.fromEntries(STUCK_CLASSES.map((c) => [c, { total: 0, over: STUCK_MINUTE_BUCKETS.map(() => 0) }])) as StuckCounts["byClass"], estimated: 0, customerWaiting: 0, longest: null };
}

/** Gom một hội thoại vào bộ đếm. HÀM THUẦN (đổi `c`). */
export function addSilent(c: StuckCounts, r: SilentRow, waiting: boolean, now: Date): StuckClass {
  const cls = classifyStuck(r, now);
  const since = silentSince(r);
  const minutes = Math.max(0, Math.floor((now.getTime() - since.at.getTime()) / 60_000));
  c.silent += 1;
  c.byClass[cls].total += 1;
  STUCK_MINUTE_BUCKETS.forEach((b, i) => {
    if (minutes > b) c.byClass[cls].over[i] += 1;
  });
  if (since.estimated) c.estimated += 1;
  if (waiting) c.customerWaiting += 1;
  if (!c.longest || minutes > c.longest.minutes) c.longest = { minutes, cls };
  return cls;
}

/** Dòng tóm tắt A (chỉ số đếm). HÀM THUẦN. */
export function silentSummary(org: string, c: StuckCounts): string[] {
  const lines: string[] = [];
  const group = (g: StuckGroup) => STUCK_CLASSES.filter((k) => STUCK_CLASS_GROUP[k] === g).reduce((s, k) => s + c.byClass[k].total, 0);
  lines.push(`${org} A · AI im ${c.silent} hội thoại: ${STUCK_GROUPS.map((g) => `${STUCK_GROUP_LABEL[g]} ${group(g)}`).join(" · ")} · khách đang chờ trả lời ${c.customerWaiting} · mốc ước tính ${c.estimated}${c.longest ? ` · lâu nhất ${c.longest.minutes} phút (${c.longest.cls})` : ""}`);
  const rows = STUCK_CLASSES.filter((k) => c.byClass[k].total > 0).map((k) => `${k} ${c.byClass[k].total} (${STUCK_MINUTE_BUCKETS.map((b, i) => `>${b}p ${c.byClass[k].over[i]}`).join(" ")})`);
  for (let i = 0; i < rows.length; i += 3) lines.push(`${org} A · ${rows.slice(i, i + 3).join(" · ")}`);
  return lines;
}

// ─────────────────────────── PHẦN CSDL ───────────────────────────

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };

/** Gắn handle CHẨN ĐOÁN (chỉ đọc, không migrate) vào chỗ `getDb()` tìm handle tổ chức — bản sao của scripts/inbox-perf-probe.ts. */
async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }): Promise<void> {
  if (org.isHome) return;
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — không gắn được handle chỉ đọc; dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — không gắn được handle chỉ đọc; dừng.");
  if (orgs.get(org.code)?.db) return;
  orgs.set(org.code, { db: await getDbForInspection(org) });
}

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
};

/** A — hội thoại AI im ngay lúc đo. Trả cả mã hội thoại theo nhóm (phần MÃ HOÁ). */
export async function collectSilent(db: Db, now: Date): Promise<{ counts: StuckCounts; samples: Partial<Record<StuckClass, string[]>>; reasons: Map<string, number> }> {
  const res = await db.execute(sql`select c.id, c.status, c.handoff_reason, c.state->'control'->>'mode' as mode,
      c.state->'handoff'->>'at' as handoff_at, c.state->'handoff'->>'reason' as handoff_state_reason, c.updated_at, c.human_cooldown_until, c.handoff_queued_at,
      (c.last_customer_at is not null and c.last_customer_at > coalesce(c.last_bot_at, 'epoch'::timestamptz) and c.last_customer_at > coalesce(c.last_staff_at, 'epoch'::timestamptz)) as waiting
    from "sales_chat_conversations" c
    where c.channel <> 'TEST' and (c.status = 'HANDOFF' or coalesce(c.state->'control'->>'mode', '') = 'HUMAN')
    limit 20000`);
  const counts = emptyCounts();
  const samples: Partial<Record<StuckClass, string[]>> = {};
  const reasons = new Map<string, number>();
  for (const r of rowsOf<Record<string, unknown>>(res)) {
    const row: SilentRow = {
      status: String(r.status ?? ""),
      reason: r.handoff_reason == null ? null : String(r.handoff_reason),
      mode: r.mode == null ? null : String(r.mode),
      handoffAt: toDate(r.handoff_at),
      handoffReason: r.handoff_state_reason == null ? null : String(r.handoff_state_reason),
      updatedAt: toDate(r.updated_at) ?? now,
      cooldownUntil: toDate(r.human_cooldown_until),
      queuedAt: toDate(r.handoff_queued_at),
    };
    const cls = addSilent(counts, row, r.waiting === true || r.waiting === "t", now);
    const list = (samples[cls] ??= []);
    if (list.length < 30) list.push(String(r.id));
    const key = (row.reason ?? "(trống)").replace(/#[0-9A-F]{8}\b/g, "#…").slice(0, 90);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  return { counts, samples, reasons };
}

export type OwnershipMeasure = { ok: true; silent: number; person: number; department: number; unowned: number; byReason: Record<string, number>; responders: number; viewers: number; departmentCode: string; overdue: number; stale: number; queued: number; unqueued: number } | { ok: false; why: string };

/** B + C — đọc bằng lib #800 trong ngữ cảnh tổ chức (handle chỉ đọc). Thiếu hàm trên image ⇒ CHƯA ĐO ĐƯỢC. */
export async function collectOwnership(org: { code: string; isHome: boolean }, now: Date): Promise<OwnershipMeasure> {
  try {
    await bindReadOnlyOrgHandle(org);
    return await withOrganization(org.code, async () => {
      const routing = (await import("@/lib/sales-chatbot/handoff-routing")) as Record<string, unknown>;
      const count = routing.countUnownedHandoffs as ((now: Date) => Promise<{ silent: number; person: number; department: number; unowned: number; byReason: Record<string, number>; responders: number; departmentCode: string }>) | undefined;
      const items = routing.handoffWorkItems as ((now: Date) => Promise<{ createdAt: Date; assignee: unknown; tags: string[] }[]>) | undefined;
      const ctxOf = routing.handoffViewContext as (() => Promise<{ cfg: unknown }>) | undefined;
      const dueOf = routing.handoffDueAt as ((queuedAt: Date, cfg: unknown) => Date | null) | undefined;
      if (!count || !items || !ctxOf || !dueOf) return { ok: false as const, why: "image chưa có hàm hàng đợi người của #800" };
      const { activeUserIdsWhoCan } = await import("@/lib/auth/session");
      const [u, list, ctx, viewers] = await Promise.all([count(now), items(now), ctxOf(), activeUserIdsWhoCan("ai_sales:view")]);
      let overdue = 0;
      let stale = 0;
      let queued = 0;
      for (const it of list) {
        if (it.tags.includes("NOT_QUEUED")) continue;
        queued += 1;
        const due = dueOf(it.createdAt, ctx.cfg);
        if (!due || due.getTime() > now.getTime()) continue;
        overdue += 1;
        if (!it.assignee && now.getTime() - due.getTime() > 24 * 3_600_000) stale += 1;
      }
      return { ok: true as const, silent: u.silent, person: u.person, department: u.department, unowned: u.unowned, byReason: u.byReason, responders: u.responders, viewers: viewers.length, departmentCode: u.departmentCode, overdue, stale, queued, unqueued: list.length - queued };
    });
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}

/** Đơn nối với hội thoại (cùng phép nối của hộp thư / claim-guard): `sales_conversation_id` · ô đơn / nháp của hội thoại. */
const LINKED_ORDER = sql.raw(`("orders"."sales_conversation_id" = c.id or "orders"."id" = c.order_id or "orders"."id" = c.draft_order_id)`);

export type OrderMeasure = {
  followupsSent: number;
  followupsAfterOrder: number;
  orders: number;
  byOutcome: Record<string, number>;
  confirmedNoShipmentAged: number;
  erpAndPancakeSameThread: number;
  missingWard: number;
  receiptClaims: number;
  receiptClaimsNotDelivered: number;
};

/** D + E — SQL thô, CHỈ ĐỌC. `ORDER_OUTCOME` là nguồn duy nhất của kết quả đơn (AGENTS 0.2). */
export async function collectOrders(db: Db, days: number, now: Date): Promise<{ m: OrderMeasure; samples: Record<string, string[]> }> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const aged = new Date(now.getTime() - NO_SHIPMENT_AFTER_DAYS * 86_400_000);
  const [f] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select count(*)::int as sent,
        count(*) filter (where exists (select 1 from "sales_chat_conversations" c join "orders" on ${LINKED_ORDER}
          where c.id = e.conversation_id and "orders"."stage" not in ('NEW', 'CANCELLED', 'DELETED') and "orders"."inserted_at" < e.occurred_at))::int as after_order
      from "sales_conversation_events" e where e.type = 'followup.sent' and e.occurred_at >= ${since}`),
  );
  const outcomeRows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${ORDER_OUTCOME}::text as outcome, count(distinct "orders"."id")::int as n,
        count(distinct "orders"."id") filter (where ${ORDER_OUTCOME}::text = 'NOT_SHIPPED' and "orders"."stage" not in ('NEW', 'WAITING') and "orders"."inserted_at" < ${aged})::int as aged
      from "orders" left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
      where "orders"."sales_conversation_id" is not null and "orders"."inserted_at" >= ${since} and "orders"."stage" not in ('CANCELLED', 'DELETED')
      group by 1`),
  );
  const byOutcome: Record<string, number> = {};
  let orders = 0;
  let confirmedNoShipmentAged = 0;
  for (const r of outcomeRows) {
    byOutcome[String(r.outcome ?? "NULL")] = Number(r.n ?? 0);
    orders += Number(r.n ?? 0);
    confirmedNoShipmentAged += Number(r.aged ?? 0);
  }
  const agedSample = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select "orders"."id" from "orders" left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
      where "orders"."sales_conversation_id" is not null and "orders"."inserted_at" >= ${since} and "orders"."inserted_at" < ${aged}
        and "orders"."stage" not in ('NEW', 'WAITING', 'CANCELLED', 'DELETED') and ${ORDER_OUTCOME}::text = 'NOT_SHIPPED' order by "orders"."inserted_at" desc limit 30`),
  ).map((r) => String(r.id));
  const [x] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select
        (select count(distinct a.id)::int from "orders" a join "orders" b on b.sales_conversation_id = a.sales_conversation_id and b.id not like 'erp-%'
          and b.stage not in ('CANCELLED', 'DELETED') and abs(extract(epoch from (b.inserted_at - a.inserted_at))) <= ${NO_SHIPMENT_AFTER_DAYS * 86_400}
          where a.id like 'erp-%' and a.sales_conversation_id is not null and a.inserted_at >= ${since} and a.stage not in ('CANCELLED', 'DELETED')) as both,
        (select count(*)::int from "orders" where id like 'erp-%' and sales_conversation_id is not null and inserted_at >= ${since}
          and stage in ('NEW', 'CONFIRMED', 'WAITING') and coalesce(ship_commune, '') = '') as no_ward`),
  );
  // Lời khách «đã nhận hàng» trong kỳ (sổ tin thô kênh nhắn tin + lịch sử chat web) và hội thoại đó có đơn sống chưa có chứng từ giao.
  const [k] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`with claims as (
        select distinct c.id from "sales_chat_conversations" c join "sales_chat_inbound" i on i.page_id = c.page_id and i.thread_id = c.thread_id
          where c.channel <> 'TEST' and i.created_at >= ${since} and i.imported_at is null and coalesce(i.note, '') not in ('BOT_SENT', 'PAGE_REPLY') and i.text ~* ${RECEIPT_CLAIM_SQL_RE}
      )
      select (select count(*)::int from claims) as claims,
        (select count(*)::int from claims cl where exists (select 1 from "sales_chat_conversations" c join "orders" on ${LINKED_ORDER}
          left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
          where c.id = cl.id and "orders"."stage" not in ('CANCELLED', 'DELETED') and ${ORDER_OUTCOME}::text <> 'DELIVERED')) as not_delivered`),
  );
  return {
    m: {
      followupsSent: Number(f?.sent ?? 0),
      followupsAfterOrder: Number(f?.after_order ?? 0),
      orders,
      byOutcome,
      confirmedNoShipmentAged,
      erpAndPancakeSameThread: Number(x?.both ?? 0),
      missingWard: Number(x?.no_ward ?? 0),
      receiptClaims: Number(k?.claims ?? 0),
      receiptClaimsNotDelivered: Number(k?.not_delivered ?? 0),
    },
    samples: { confirmedNoShipmentAged: agedSample },
  };
}

/** Dòng thời gian trạng thái của MỘT hội thoại (chỉ phần MÃ HOÁ): không tên, SĐT, chữ tin. */
async function conversationTimeline(db: Db, where: { conv: string | null; order: string | null }, now: Date): Promise<boolean> {
  const id = where.conv
    ? where.conv
    : String(
        rowsOf<Record<string, unknown>>(
          await db.execute(sql`select coalesce(o.sales_conversation_id, (select c.id from "sales_chat_conversations" c where c.order_id = o.id or c.draft_order_id = o.id limit 1)) as id
            from "orders" o where o.id like ${`erp-${where.order}%`} limit 1`),
        )[0]?.id ?? "",
      );
  if (!id) {
    tomTat("stuck-conversation-audit: không thấy hội thoại của mã đã cho");
    return false;
  }
  const [c] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select id, channel, status, handoff_reason, state->'control' as control, state->'handoff' as handoff, (state->'confirmed') is not null as confirmed,
        state->'confirmed'->>'at' as confirmed_at, (state->'confirmed'->>'auto') as confirmed_auto, jsonb_array_length(coalesce(state->'pastOrders', '[]'::jsonb)) as past_orders,
        updated_at, human_cooldown_until, handoff_queued_at, handoff_alerted_at, assignee_user_id, last_customer_at, last_bot_at, last_staff_at, staff_seen_at, turns
      from "sales_chat_conversations" where id = ${id}`),
  );
  if (!c) {
    tomTat("stuck-conversation-audit: không có hội thoại này trong tổ chức đã chọn");
    return false;
  }
  console.log(`— hội thoại ${id}`);
  console.log(JSON.stringify(c));
  const row: SilentRow = { status: String(c.status), reason: c.handoff_reason == null ? null : String(c.handoff_reason), mode: (c.control as { mode?: string } | null)?.mode ?? null, handoffAt: toDate((c.handoff as { at?: string } | null)?.at), handoffReason: (c.handoff as { reason?: string } | null)?.reason ?? null, updatedAt: toDate(c.updated_at) ?? now, cooldownUntil: toDate(c.human_cooldown_until), queuedAt: toDate(c.handoff_queued_at) };
  if (row.status === "HANDOFF" || row.mode === "HUMAN") {
    const s = silentSince(row);
    console.log(`  nhóm: ${classifyStuck(row, now)} · im từ ${s.at.toISOString()}${s.estimated ? " (ước tính theo updated_at)" : ""} · ${Math.floor((now.getTime() - s.at.getTime()) / 60_000)} phút`);
  } else console.log("  AI không im (status ≠ HANDOFF, chế độ ≠ HUMAN)");
  const orders = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select "orders"."id", "orders"."stage"::text as stage, "orders"."inserted_at", ${ORDER_OUTCOME}::text as outcome, "shipments"."id" is not null as has_shipment,
        "shipments"."stage"::text as ship_stage, coalesce("orders"."ship_commune", '') <> '' as has_ward, coalesce("orders"."ship_province", '') <> '' as has_province,
        ("orders"."raw"->'review') is not null as has_review, "orders"."origin"
      from "orders" left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
      where "orders"."sales_conversation_id" = ${id} or "orders"."id" in (select order_id from "sales_chat_conversations" where id = ${id} union select draft_order_id from "sales_chat_conversations" where id = ${id})
      order by "orders"."inserted_at" desc limit 10`),
  );
  for (const o of orders) console.log(`  đơn ${String(o.id).slice(0, 12)}… ${JSON.stringify({ ...o, id: undefined })}`);
  const events = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select occurred_at, type, actor_kind, reason_code, order_id from "sales_conversation_events" where conversation_id = ${id} order by occurred_at desc limit 40`),
  );
  for (const e of events.reverse()) console.log(`  ${toDate(e.occurred_at)?.toISOString() ?? "?"} ${e.type} ${e.actor_kind}${e.reason_code ? ` ${e.reason_code}` : ""}${e.order_id ? ` đơn ${String(e.order_id).slice(0, 12)}…` : ""}`);
  const inbound = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select i.created_at, i.status, left(coalesce(i.note, ''), 120) as note, i.sender_kind from "sales_chat_inbound" i join "sales_chat_conversations" c on c.page_id = i.page_id and c.thread_id = i.thread_id
      where c.id = ${id} and i.imported_at is null order by i.created_at desc limit 30`),
  );
  for (const m of inbound.reverse()) console.log(`  tin ${toDate(m.created_at)?.toISOString() ?? "?"} ${m.status} ${m.sender_kind ?? ""} ${m.note}`);
  return true;
}

async function oneOrg(org: { code: string; isHome: boolean }, args: StuckArgs, now: Date): Promise<boolean> {
  try {
    const db: Db = await getDbForInspection(org);
    const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
    if (String(ro?.default_transaction_read_only ?? "") !== "on") {
      tomTat(`stuck-conversation-audit ${org.code}: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì`);
      return false;
    }
    if (args.conv || args.order) return await conversationTimeline(db, { conv: args.conv, order: args.order }, now);
    const a = await collectSilent(db, now);
    for (const line of silentSummary(org.code, a.counts)) tomTat(line);
    console.log(`${org.code} A · mã hội thoại theo nhóm: ${JSON.stringify(a.samples)}`);
    console.log(`${org.code} A · lý do nguyên văn: ${JSON.stringify([...a.reasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40))}`);

    const b = await collectOwnership(org, now);
    if (b.ok) {
      tomTat(`${org.code} B · cần người ${b.silent}: người cầm ${b.person} · hàng đợi phòng ${b.department} · KHÔNG CHỦ ${b.unowned} (${Object.entries(b.byReason).map(([k, v]) => `${k} ${v}`).join(" · ")}) · phòng ${b.departmentCode} có ${b.responders} người xem được hộp thư · cả tổ chức ${b.viewers}`);
      tomTat(`${org.code} C · SLA (work.sla): đã vào hàng đợi ${b.queued} · quá hạn ${b.overdue} · quá hạn > 24 giờ chưa ai cầm ${b.stale} · chưa vào hàng đợi ${b.unqueued}`);
    } else {
      tomTat(`${org.code} B/C · CHƯA ĐO ĐƯỢC — ${b.why}`);
    }

    const d = await collectOrders(db, args.days, now);
    tomTat(`${org.code} D · nhắn lại ${args.days} ngày: ${d.m.followupsSent} tin · sau khi đã có đơn sống (không phải nháp) ${d.m.followupsAfterOrder}`);
    tomTat(`${org.code} E · đơn nối hội thoại ${args.days} ngày còn sống ${d.m.orders}: ${Object.entries(d.m.byOutcome).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
    tomTat(`${org.code} E · đã chốt > ${NO_SHIPMENT_AFTER_DAYS} ngày mà ERP KHÔNG có vận đơn ${d.m.confirmedNoShipmentAged} · đơn ERP + đơn Pancake cùng hội thoại ±${NO_SHIPMENT_AFTER_DAYS} ngày ${d.m.erpAndPancakeSameThread} · đơn ERP thiếu xã/phường ${d.m.missingWard}`);
    tomTat(`${org.code} E · khách NÓI đã nhận hàng ${d.m.receiptClaims} hội thoại · trong đó đơn chưa có chứng từ giao (ORDER_OUTCOME ≠ DELIVERED) ${d.m.receiptClaimsNotDelivered} — lời khách không đổi trạng thái đơn`);
    console.log(`${org.code} E · mã đơn chốt quá hạn chưa vận đơn: ${JSON.stringify(d.samples.confirmedNoShipmentAged)}`);
    return true;
  } catch (e) {
    console.error(`stuck-conversation-audit ${org.code} lỗi:`, e instanceof Error ? e.message : e);
    tomTat(`stuck-conversation-audit ${org.code}: LỖI ngoài phép đo — chi tiết trong phần mã hoá`);
    return false;
  }
}

/** Xả stdout trước khi thoát — `process.exit` ngay sau `console.log` có thể cắt mất phần cuối khi stdout là ống (docker exec). */
function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

async function main() {
  const args = parseStuckArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`stuck-conversation-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return exitAfterFlush(1);
  }
  let orgs: { code: string; isHome: boolean }[];
  if (args.all) {
    orgs = (await listOrganizations()).filter((o) => o.isHome || o.status === "ACTIVE").sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.code.localeCompare(b.code));
  } else {
    const org = await findOrganization(args.code!);
    if (!org) {
      tomTat(`stuck-conversation-audit: DỪNG · không có tổ chức «${args.code}»`);
      return exitAfterFlush(1);
    }
    orgs = [org];
  }
  const now = new Date();
  console.log(`stuck-conversation-audit · ${orgs.length} CSDL · ${args.days} ngày · lúc ${now.toISOString()}`);
  let ok = true;
  for (const org of orgs) ok = (await oneOrg(org, args, now)) && ok;
  exitAfterFlush(ok ? 0 : 1);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("stuck-conversation-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("stuck-conversation-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    exitAfterFlush(1);
  });
}

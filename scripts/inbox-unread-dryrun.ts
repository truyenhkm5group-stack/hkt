/*
  ops `inbox-unread-dryrun` — CHẠY THỬ (CHỈ ĐỌC) «tin khách chưa đọc» lưu sẵn của PR #792 TRÊN DỮ LIỆU THẬT, TRƯỚC KHI GỘP.

  Vì sao có (chủ shop 11/10/2026 — duyệt #792 có điều kiện): #792 thêm cột `sales_chat_conversations.turn_unhandled` = kết quả định nghĩa
  «lượt khách mới nhất chưa xử lý» của response-ownership (#803, `latestCustomerTurnUnhandledSql()`), migration 0245 dẫn xuất cột cho MỌI
  hội thoại bằng MỘT câu UPDATE trong giao dịch khởi động. Trước khi để câu ấy chạy trên production phải biết: (1) nó đổi «Chưa đọc» của
  hộp thư bao nhiêu so với luật đang chạy, theo hướng nào, vì lý do gì; (2) câu tính hàm #803 trên toàn bảng mất bao lâu — ước lượng thời
  gian dẫn xuất so với trần `statement_timeout` của 0245.

  In cho MỖI CSDL (tổ chức chỉ định, hoặc `--all` = nhà + mọi tổ chức ACTIVE):
   · tổng hội thoại (không TEST) · số sẽ có `turn_unhandled = true` theo hàm #803 · số UNREAD theo luật đang chạy (V3: tin khách thật sau
     con trỏ chung `greatest(staff_seen_at, last_staff_at)` — đúng biểu thức hộp thư main dùng cho người xem chưa có con trỏ riêng);
   · số đổi true→false (V3 báo chưa đọc, #803 nói đã xử lý) chia theo lý do: AI trả lời · nhân viên / page trả lời · người mở (con trỏ
     đọc / mốc mở cũ) — lý do «người mở» ĐO ĐÚNG bằng chính hàm #803 bỏ vế người mở; tách AI ⇄ NV/page là ƯỚC TÍNH (có câu bot / AI sau
     tin khách cuối) và in nhãn như vậy; số đổi false→true;
   · THỜI GIAN câu tính hàm #803 trên toàn bảng (đồng hồ của script, `statement_timeout` riêng 600 giây) + số dòng ⇒ ước lượng dẫn xuất;
   · kích thước bảng sales_chat_conversations / sales_chat_inbound (gồm chỉ mục).

  RÀNG BUỘC: ops lấy script từ main nhưng lib/ từ image đang chạy ⇒ script CHỈ nhập thứ đã có trên main sau #803 (response-ownership-ledger,
  inbox-states) và vẫn còn sau #792 — không nhập `inbox-unread*` của #792. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối
  đầu tiên + hỏi lại phiên); CSDL tổ chức mở bằng `getDbForInspection` (không migrate). Chỉ in số đếm, thời gian, kích thước — không tên,
  SĐT, chữ tin, mã hội thoại. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`).

  arg: `<mã tổ chức> | --all`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("inbox-unread-dryrun.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql, type SQL } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { customerCountAfterSql, SHARED_SEEN_SQL } from "@/lib/sales-chatbot/inbox-states";
import { latestCustomerTurnUnhandledFor, latestCustomerTurnUnhandledSql, latestWebTurnUnhandledFor, WEB_STAFF_PREFIX } from "@/lib/sales-chatbot/response-ownership-ledger";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Trần `statement_timeout` mà 0245 (#792) đặt cho giao dịch migration — số so để kết luận. */
export const DRYRUN_MIGRATION_TIMEOUT_S = 600;
/** Hệ số ước lượng dẫn xuất từ thời gian câu ĐỌC: UPDATE = cùng phép tính + ghi lại từng dòng hội thoại (heap + chỉ mục). */
export const DRYRUN_WRITE_FACTOR = { low: 1.2, high: 2.5 } as const;

export function parseDryrunArgs(argv: readonly string[]): { all: true } | { all: false; code: string } | { error: string } {
  if (argv.length === 1 && argv[0] === "--all") return { all: true };
  const rest = argv.filter((a) => a.trim() !== "");
  if (rest.length !== 1 || rest[0].startsWith("--")) return { error: "cần đúng MỘT đối số: <mã tổ chức> hoặc --all" };
  const code = rest[0].trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "sai mã tổ chức" };
  return { all: false, code };
}

/** Số đếm của MỘT CSDL. */
export type DryrunCounts = {
  conversations: number;
  /** Theo hàm #803 — sẽ là `turn_unhandled = true` sau dẫn xuất. */
  turnUnread: number;
  /** Luật đang chạy (V3, con trỏ chung). */
  v3Unread: number;
  trueToFalse: number;
  /** Trong true→false: chỉ vế «người mở» làm nó thành đã xử lý (ĐO bằng hàm #803 bỏ vế người mở). */
  byRead: number;
  /** Trong true→false do câu trả lời: có câu bot / AI sau tin khách cuối (ƯỚC TÍNH) · còn lại = nhân viên / page. */
  byReplyAi: number;
  byReplyHumanPage: number;
  falseToTrue: number;
};

/** Ước lượng thời gian dẫn xuất từ thời gian câu đọc. HÀM THUẦN. */
export function estimateBackfill(readMs: number): { lowS: number; highS: number; verdict: "AN_TOAN" | "SAT_TRAN" | "VUOT_TRAN" } {
  const lowS = (readMs * DRYRUN_WRITE_FACTOR.low) / 1000;
  const highS = (readMs * DRYRUN_WRITE_FACTOR.high) / 1000;
  const verdict = highS <= DRYRUN_MIGRATION_TIMEOUT_S / 2 ? "AN_TOAN" : highS <= DRYRUN_MIGRATION_TIMEOUT_S ? "SAT_TRAN" : "VUOT_TRAN";
  return { lowS, highS, verdict };
}

const fmtS = (s: number) => (s < 10 ? s.toFixed(2) : s.toFixed(1));

/** Các dòng tóm tắt của MỘT CSDL — chỉ số đếm / thời gian / kích thước. HÀM THUẦN. */
export function dryrunSummary(org: string, c: DryrunCounts, timing: { readMs: number; compareMs: number }, size: { conversations: string; inbound: string }): string[] {
  const est = estimateBackfill(timing.readMs);
  const reply = c.trueToFalse - c.byRead;
  return [
    `inbox-unread-dryrun ${org}: ${c.conversations} hội thoại (không TEST) · bảng hội thoại ${size.conversations} · bảng tin ${size.inbound}`,
    `${org} UNREAD: luật đang chạy (V3, con trỏ chung) ${c.v3Unread} → sau 0245 (turn_unhandled = hàm #803) ${c.turnUnread} · true→false ${c.trueToFalse} · false→true ${c.falseToTrue}`,
    `${org} true→false theo lý do: người mở ${c.byRead} (đo) · trả lời ${reply} = AI ${c.byReplyAi} + NV/page ${c.byReplyHumanPage} (ước tính: có câu bot / AI sau tin khách cuối)`,
    `${org} THỜI GIAN hàm #803 trên toàn bảng ${(timing.readMs / 1000).toFixed(2)} s / ${c.conversations} dòng · câu so sánh ${(timing.compareMs / 1000).toFixed(2)} s ⇒ dẫn xuất 0245 ước ${fmtS(est.lowS)}–${fmtS(est.highS)} s (trần ${DRYRUN_MIGRATION_TIMEOUT_S} s: ${est.verdict})`,
  ];
}

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

const C = (n: string) => sql.raw(`"sales_chat_conversations"."${n}"`);
const NO_SEEN = sql`null::timestamptz`;

/** Hàm #803 BỎ vế «người mở» (mốc đọc NULL) — còn chưa xử lý ⇒ chỉ lượt đọc làm nó thành đã xử lý. */
function unhandledIgnoringReadSql(): SQL<boolean> {
  return sql<boolean>`(case when ${C("page_id")} is not null and ${C("thread_id")} is not null
    then ${latestCustomerTurnUnhandledFor(C("page_id"), C("thread_id"), NO_SEEN)}
    else ${latestWebTurnUnhandledFor(C("id"), NO_SEEN)} end)`;
}

/** ƯỚC TÍNH: có câu bot / AI sau tin khách cuối (kênh nhắn tin: BOT_SENT hoặc PAGE_REPLY sender_kind AI_AGENT; chat web: assistant không phải câu nhân viên). */
function aiAfterLastCustomerSql(): SQL<boolean> {
  const lastCust = sql`(select max(i.created_at) from "sales_chat_inbound" i where i.page_id = ${C("page_id")} and i.thread_id = ${C("thread_id")}
    and i.imported_at is null and coalesce(i.note, '') not in ('BOT_SENT', 'PAGE_REPLY'))`;
  const lastWeb = sql`(select max(m.seq) from "sales_chat_messages" m where m.conversation_id = ${C("id")} and m.role = 'user')`;
  return sql<boolean>`(case when ${C("page_id")} is not null and ${C("thread_id")} is not null
    then exists (select 1 from "sales_chat_inbound" o where o.page_id = ${C("page_id")} and o.thread_id = ${C("thread_id")} and o.imported_at is null
      and (o.note = 'BOT_SENT' or (o.note = 'PAGE_REPLY' and o.sender_kind = 'AI_AGENT')) and o.created_at > ${lastCust})
    else exists (select 1 from "sales_chat_messages" a where a.conversation_id = ${C("id")} and a.role = 'assistant' and a.seq > coalesce(${lastWeb}, -1)
      and not (a.content::text like ${`%${WEB_STAFF_PREFIX}%`})) end)`;
}

/** Cột / bảng mà hàm #803 đọc tới — thiếu (chưa áp 0239 / 0244) ⇒ không đo được, nói rõ. */
export async function missingPrereqs(db: Db): Promise<string[]> {
  const [r] = rowsOf<{ reads: boolean; cols: number }>(
    await db.execute(sql`select to_regclass('public.sales_chat_reads') is not null as reads,
      (select count(*)::int from information_schema.columns where table_schema = current_schema() and table_name = 'sales_chat_inbound' and column_name in ('sender_kind', 'source_at')) as cols`),
  );
  const out: string[] = [];
  if (!r?.reads) out.push("bảng sales_chat_reads (0239)");
  if (Number(r?.cols) !== 2) out.push("cột sender_kind / source_at (0244)");
  return out;
}

/** Chạy một câu trong giao dịch có trần thời gian riêng (đọc nặng trên production không được treo vô hạn). */
async function timed<T>(db: Db, q: SQL): Promise<{ rows: T[]; ms: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local statement_timeout = '${DRYRUN_MIGRATION_TIMEOUT_S}s'`));
    const t = performance.now();
    const rows = rowsOf<T>(await tx.execute(q));
    return { rows, ms: performance.now() - t };
  });
}

export async function collectDryrun(db: Db): Promise<{ counts: DryrunCounts; timing: { readMs: number; compareMs: number }; size: { conversations: string; inbound: string } }> {
  const turn = sql`coalesce(${latestCustomerTurnUnhandledSql()}, false)`;
  const v3 = sql`(coalesce(${customerCountAfterSql(SHARED_SEEN_SQL)}, 0) > 0)`;
  const notTest = sql`"sales_chat_conversations"."channel" <> 'TEST'`;

  // 1. Đúng phép tính của câu dẫn xuất 0245 trên toàn bảng — đo thời gian.
  const read = await timed<{ total: number; turn: number }>(db, sql`select count(*)::int as total, count(*) filter (where ${turn})::int as turn from "sales_chat_conversations" where ${notTest}`);

  // 2. So với luật đang chạy + lý do. Vế đắt (lý do) chỉ tính cho dòng đổi true→false (CASE lười).
  const cmp = await timed<{ v3: number; t2f: number; f2t: number; by_read: number; by_ai: number; by_hp: number }>(
    db,
    sql`select count(*) filter (where x.v3)::int as v3,
        count(*) filter (where x.v3 and not x.turn)::int as t2f,
        count(*) filter (where not x.v3 and x.turn)::int as f2t,
        count(*) filter (where x.why = 'READ')::int as by_read,
        count(*) filter (where x.why = 'AI')::int as by_ai,
        count(*) filter (where x.why = 'HP')::int as by_hp
      from (select y.v3, y.turn,
          case when y.v3 and not y.turn then (case when y.ign then 'READ' when y.ai then 'AI' else 'HP' end) end as why
        from (select ${v3} as v3, ${turn} as turn,
            (case when ${v3} and not ${turn} then coalesce(${unhandledIgnoringReadSql()}, false) end) as ign,
            (case when ${v3} and not ${turn} then ${aiAfterLastCustomerSql()} end) as ai
          from "sales_chat_conversations" where ${notTest}) y) x`,
  );
  const [s] = rowsOf<{ conv: string; inbound: string }>(
    await db.execute(sql`select pg_size_pretty(pg_total_relation_size('sales_chat_conversations')) as conv, pg_size_pretty(pg_total_relation_size('sales_chat_inbound')) as inbound`),
  );
  const r = read.rows[0];
  const k = cmp.rows[0];
  return {
    counts: {
      conversations: Number(r?.total ?? 0),
      turnUnread: Number(r?.turn ?? 0),
      v3Unread: Number(k?.v3 ?? 0),
      trueToFalse: Number(k?.t2f ?? 0),
      byRead: Number(k?.by_read ?? 0),
      byReplyAi: Number(k?.by_ai ?? 0),
      byReplyHumanPage: Number(k?.by_hp ?? 0),
      falseToTrue: Number(k?.f2t ?? 0),
    },
    timing: { readMs: read.ms, compareMs: cmp.ms },
    size: { conversations: String(s?.conv ?? "—"), inbound: String(s?.inbound ?? "—") },
  };
}

async function oneOrg(org: { code: string; isHome: boolean }): Promise<boolean> {
  try {
    const db: Db = await getDbForInspection(org);
    const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
    if (String(ro?.default_transaction_read_only ?? "") !== "on") {
      tomTat(`inbox-unread-dryrun ${org.code}: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì`);
      return false;
    }
    const missing = await missingPrereqs(db);
    if (missing.length) {
      tomTat(`inbox-unread-dryrun ${org.code}: CHƯA ĐO ĐƯỢC · thiếu ${missing.join(" · ")} — cần bản triển khai có #803`);
      return true;
    }
    const r = await collectDryrun(db);
    for (const line of dryrunSummary(org.code, r.counts, r.timing, r.size)) tomTat(line);
    return true;
  } catch (e) {
    console.error(`inbox-unread-dryrun ${org.code} lỗi:`, e instanceof Error ? e.message : e);
    tomTat(`inbox-unread-dryrun ${org.code}: LỖI ngoài phép đo — chi tiết trong phần mã hoá`);
    return false;
  }
}

async function main() {
  const args = parseDryrunArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`inbox-unread-dryrun: DỪNG · cách dùng sai — ${args.error}`);
    process.exit(1);
  }
  let orgs: { code: string; isHome: boolean }[];
  if (args.all) {
    orgs = (await listOrganizations()).filter((o) => o.isHome || o.status === "ACTIVE").sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.code.localeCompare(b.code));
  } else {
    const org = await findOrganization(args.code);
    if (!org) {
      tomTat(`inbox-unread-dryrun: DỪNG · không có tổ chức «${args.code}»`);
      process.exit(1);
    }
    orgs = [org];
  }
  console.log(`inbox-unread-dryrun · ${orgs.length} CSDL · lúc ${new Date().toISOString()} · trần đọc ${DRYRUN_MIGRATION_TIMEOUT_S} s mỗi câu`);
  let ok = true;
  for (const org of orgs) ok = (await oneOrg(org)) && ok;
  process.exit(ok ? 0 : 1);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("inbox-unread-dryrun lỗi:", e instanceof Error ? e.message : e);
    tomTat("inbox-unread-dryrun: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

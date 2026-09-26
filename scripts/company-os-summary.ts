/*
  ops `company-os-summary` — COMPANY OS ĐÃ ĐƯỢC DÙNG TỚI ĐÂU, BẰNG SỐ ĐẾM.

  Câu hỏi của Tech Lead sau khi gộp và deploy trọn Company OS (26/09/2026): sổ mẫu đã có bao nhiêu mẫu,
  bao nhiêu mẫu đã khai vòng đời, topic / giá thành / mẫu xưởng / bản thiết kế có ai dùng chưa, lệnh sản
  xuất mới có trỏ vào bản thiết kế đã duyệt không, chủ shop có phản ứng với "Cần anh quyết" không, tin Lark
  có bật không, hàng hoàn không tái nhập đi về đâu, yêu cầu duyệt có chạy xong không, phiếu nhập có gắn
  lệnh / lô không. Mỗi câu một con số — đo trên dữ liệu thật mà KHÔNG cần mở màn hình nào.

  CHỈ ĐẾM. Không in tên, SĐT, email, địa chỉ, tiêu đề, ghi chú, mã mẫu, mã đơn, mã vận đơn — kể cả mã
  mẫu mơ hồ của sổ mẫu chỉ được ĐẾM (`previewModelRegistry().ambiguous.length`). Dòng ra log công khai
  qua kênh `[ops:tom-tat] `; nhánh ops vẫn bọc `ma_hoa_ket_qua` (cùng khuôn `stock-wait-summary`).

  Mỗi con số là MỘT câu đọc. Câu nào không chạy được (bảng chưa có trên ảnh đang chạy, lỗi quyền…) thì
  mục đó in `—` KÈM LÝ DO — không bao giờ in 0 (AGENTS.md mục 42): 0 là "đã đếm và không có", `—` là
  "không đếm được".

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` đặt trước lần mở kết nối đầu tiên, `main` hỏi lại rồi dừng
  nếu không phải) — cùng khuôn với `cod-statement-audit`.

  CHỈ import tệp `lib/` ĐÃ CÓ trên ảnh đang chạy: ops lấy script từ `main` nhưng `lib/` từ container, nên
  một tệp `lib/` mới làm script chết `MODULE_NOT_FOUND` tới lần deploy sau.

  arg: không có.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("company-os-summary.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { DOMAIN_EVENTS } from "@/lib/constants/domain-events";
import { describeTopicOpenContext } from "@/lib/constants/early-topic";
import { MODEL_STATES } from "@/lib/constants/model-lifecycle";
import { RECOMMENDATION_DECISIONS } from "@/lib/constants/owner-decisions";
import { OWNER_DIGEST_CONFIG_KEY, OWNER_DIGEST_LEDGER_KEY, parseOwnerDigestLedger } from "@/lib/constants/owner-digest";
import { COST_SHEET_STATUSES, SAMPLE_STATUSES, TOPIC_STATUSES } from "@/lib/constants/production-os";
import { RETURN_DISPOSITIONS } from "@/lib/constants/return-disposition";
import { UNIDENTIFIED_STATUSES } from "@/lib/constants/return-unidentified";
import { formatNumber } from "@/lib/format";
import { previewModelRegistry } from "@/lib/queries/models";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Kênh tóm tắt cho ra log tối đa 60 dòng, 300 ký tự mỗi dòng — cả lượt phải lọt trong đó. */
export const SUMMARY_MAX_LINES = 60;
export const SUMMARY_MAX_CHARS = 300;
const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "EXECUTED"] as const;
const CHUA_KHAI = "chưa khai";

// ═══════════════════════════ KIỂU ═══════════════════════════

/** Một mục đọc được, hoặc KHÔNG đọc được kèm lý do — không có trạng thái thứ ba "0 cho yên chuyện". */
export type Doc<T> = { ok: true; data: T } | { ok: false; reason: string };
export type CountRow = { key: string | null; n: number };

export type CompanyOsSummary = {
  at: Date;
  models: Doc<{ byState: CountRow[]; withProduct: number; designOnly: number; bare: number; byUser: number }>;
  registry: Doc<{ pendingInsert: number; pendingLink: number; ambiguous: number }>;
  runs: Doc<{ registryLastAt: Date | null; registryLastStatus: string | null; registryRuns7: number; warmLastAt: Date | null; warmLastStatus: string | null; warmFailed: number | null; warmModelSignalsMs: number | null }>;
  events: Doc<{ name: string; n7: number; n: number }[]>;
  topics: Doc<{ byStatus: CountRow[]; early: number; promisingAtOpen: number; noContext: number }>;
  costSheets: Doc<CountRow[]>;
  samples: Doc<CountRow[]>;
  design: Doc<{ versions: number; firstApprovedAt: Date | null; orders: number; ordersLinked: number; ordersSince: number | null; ordersSinceLinked: number | null }>;
  recommendations: Doc<{ kind: string; decision: string; n7: number; n: number }[]>;
  ownerDigest: Doc<{ configured: boolean; enabled: boolean | null; ledgerDay: string | null; lastSentAt: string | null; seenToday: number }>;
  dispositions: Doc<{ key: string; n: number; qty: number; unidentified: number }[]>;
  unidentified: Doc<{ status: string; withVariant: number; withoutVariant: number }[]>;
  approvals: Doc<{ status: string; n7: number; n: number; err7: number; err: number }[]>;
  receipts: Doc<{ receipts: number; withOrder: number; withBatch: number; linked: number; receipts30: number; linked30: number }>;
};

// ═══════════════════════════ IN (thuần) ═══════════════════════════

/** Số đếm: `null` / không hữu hạn ⇒ `—` (chưa biết), 0 thật ⇒ `0`. */
export const dem = (n: number | null | undefined) => formatNumber(n);

const moc = (d: Date | null | undefined) => (d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");

/** Gói các mẩu vào dòng ≤ `SUMMARY_MAX_CHARS` ký tự; dòng tiếp theo thụt lề để đọc liền. */
export function packParts(prefix: string, parts: readonly string[], max = SUMMARY_MAX_CHARS): string[] {
  if (!parts.length) return [`${prefix}(không có dòng nào)`];
  const out: string[] = [];
  let cur = prefix;
  for (const p of parts) {
    const sep = cur === prefix || cur === "  " ? "" : " · ";
    if (cur.length + sep.length + p.length > max && cur !== prefix && cur !== "  ") {
      out.push(cur);
      cur = `  ${p}`;
    } else cur += sep + p;
  }
  out.push(cur);
  return out.map((l) => l.slice(0, max));
}

/** Đếm theo một bộ từ vựng ĐÃ BIẾT (khoá không có dòng = 0 thật, vì câu đọc đã chạy) + khoá lạ nếu có. */
export function vocabParts(rows: readonly CountRow[], vocab: readonly string[], nullLabel?: string): string[] {
  const m = new Map<string | null, number>();
  for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + r.n);
  const parts: string[] = [];
  if (nullLabel !== undefined) parts.push(`${nullLabel} ${dem(m.get(null) ?? 0)}`);
  for (const k of vocab) parts.push(`${k} ${dem(m.get(k) ?? 0)}`);
  for (const [k, n] of m) if (k !== null && !vocab.includes(k)) parts.push(`${k} (lạ) ${dem(n)}`);
  if (nullLabel === undefined && m.has(null)) parts.push(`(rỗng) ${dem(m.get(null))}`);
  return parts;
}

const tong = (rows: readonly { n: number }[]) => rows.reduce((t, r) => t + r.n, 0);

function khongDoc(title: string, reason: string): string {
  return `${title}: — (không đọc được: ${reason.replace(/\s+/g, " ").slice(0, 160)})`;
}

/** Mọi dòng tóm tắt. Hàm THUẦN trên kết quả đã đọc — bài kiểm gọi thẳng. */
export function companyOsSummaryLines(s: CompanyOsSummary): string[] {
  const out: string[] = [];
  const muc = <T>(title: string, d: Doc<T>, f: (x: T) => string[]) => {
    if (!d.ok) out.push(khongDoc(title, d.reason));
    else out.push(...f(d.data));
  };
  out.push(`COMPANY OS · đo lúc ${moc(s.at)} · mọi con số là SỐ ĐẾM (không tên, không mã) · "—" = không đọc được, 0 = đã đếm và không có`);

  muc("MẪU", s.models, (x) => [
    `MẪU: tổng ${dem(tong(x.byState))} · có sản phẩm Pancake ${dem(x.withProduct)} · chỉ có thiết kế ${dem(x.designOnly)} · chưa có cả hai (ý tưởng) ${dem(x.bare)} · người gõ mã ${dem(x.byUser)}`,
    ...packParts("  vòng đời — ", vocabParts(x.byState, MODEL_STATES, CHUA_KHAI)),
  ]);
  muc("SỔ MẪU (xem trước đồng bộ)", s.registry, (x) => [
    `SỔ MẪU (xem trước đồng bộ, cùng planModelRegistry của đường ghi): chờ đăng ký ${dem(x.pendingInsert)} · chờ nối sản phẩm ${dem(x.pendingLink)} · mã mơ hồ ${dem(x.ambiguous)}`,
  ]);
  muc("JOB", s.runs, (x) => [
    `JOB model-registry: lượt cuối ${moc(x.registryLastAt)} · ${x.registryLastStatus ?? "chưa chạy lần nào"} · ${dem(x.registryRuns7)} lượt/7 ngày`,
    `JOB dashboard-warm: lượt cuối ${moc(x.warmLastAt)} · ${x.warmLastStatus ?? "chưa chạy lần nào"} · mục lỗi ${dem(x.warmFailed)} · tín hiệu mẫu ${x.warmModelSignalsMs === null ? "— (lượt cuối chưa làm ấm buồng lái)" : `${dem(x.warmModelSignalsMs)} ms`}`,
  ]);
  muc("SỰ KIỆN", s.events, (x) => {
    const co = new Set(x.map((e) => e.name));
    const live = DOMAIN_EVENTS.filter((e) => e.status === "LIVE" && !co.has(e.name)).map((e) => e.name);
    return [
      `SỰ KIỆN domain_events: tổng ${dem(tong(x))} · 7 ngày ${dem(x.reduce((t, e) => t + e.n7, 0))} — theo tên (7 ngày/tổng):`,
      ...packParts("  ", x.map((e) => `${e.name} ${dem(e.n7)}/${dem(e.n)}`)),
      ...packParts("  LIVE mà CHƯA phát lần nào — ", live),
    ];
  });
  muc("TOPIC SẢN XUẤT", s.topics, (x) => [
    ...packParts(`TOPIC SẢN XUẤT: tổng ${dem(tong(x.byStatus))} — `, vocabParts(x.byStatus, TOPIC_STATUSES)),
    `  mở SỚM (luật chủ shop 25/09) ${dem(x.early)} · tín hiệu lúc mở TRIỂN VỌNG ${dem(x.promisingAtOpen)} · ảnh chụp cũ không có bối cảnh ${dem(x.noContext)}`,
  ]);
  muc("GIÁ THÀNH", s.costSheets, (x) => packParts(`GIÁ THÀNH (phiên bản): tổng ${dem(tong(x))} — `, vocabParts(x, COST_SHEET_STATUSES)));
  muc("MẪU XƯỞNG", s.samples, (x) => packParts(`MẪU XƯỞNG (phiên bản): tổng ${dem(tong(x))} — `, vocabParts(x, SAMPLE_STATUSES)));
  muc("BẢN THIẾT KẾ / LỆNH SX", s.design, (x) => [
    `BẢN THIẾT KẾ đã duyệt ${dem(x.versions)} (đầu tiên ${moc(x.firstApprovedAt)}) · LỆNH SX tổng ${dem(x.orders)}: trỏ bản thiết kế ${dem(x.ordersLinked)} · không trỏ ${dem(x.orders - x.ordersLinked)}`,
    x.ordersSince === null
      ? "  lệnh SX lập SAU bản thiết kế đầu tiên: — (chưa có bản thiết kế nào — chưa lệnh nào trỏ được)"
      : `  lệnh SX lập SAU bản thiết kế đầu tiên ${dem(x.ordersSince)}: trỏ ${dem(x.ordersSinceLinked)} · không trỏ ${dem(x.ordersSinceLinked === null ? null : x.ordersSince - x.ordersSinceLinked)}`,
  ]);
  muc("CẦN ANH QUYẾT", s.recommendations, (x) => {
    const theo = RECOMMENDATION_DECISIONS.map((d) => {
      const r = x.filter((y) => y.decision === d);
      return `${d} ${dem(r.reduce((t, y) => t + y.n7, 0))}/${dem(tong(r))}`;
    });
    return [
      `CẦN ANH QUYẾT (recommendation_decisions, 7 ngày/tổng): ${dem(x.reduce((t, y) => t + y.n7, 0))}/${dem(tong(x))} — ${theo.join(" · ")}`,
      ...(x.length ? packParts("  loại × phản ứng — ", x.map((y) => `${y.kind}×${y.decision} ${dem(y.n7)}/${dem(y.n)}`)) : []),
    ];
  });
  muc("TIN LARK CẦN ANH QUYẾT", s.ownerDigest, (x) => [
    `TIN LARK "Cần anh quyết" (${OWNER_DIGEST_CONFIG_KEY}): ${!x.configured ? "chưa khai (mặc định TẮT)" : x.enabled === null ? "— (giá trị lưu không đọc được)" : x.enabled ? "BẬT" : "TẮT"} · sổ gửi: ngày xét cuối ${x.ledgerDay ?? "—"} · gửi cuối ${x.lastSentAt ?? "—"} · khoá gấp đã báo trong ngày ${dem(x.seenToday)}`,
  ]);
  muc("HÀNG HOÀN KHÔNG TÁI NHẬP", s.dispositions, (x) =>
    packParts(
      `HÀNG HOÀN — sổ kết cục return_dispositions (DÒNG SỔ, không phải tình trạng hiện tại; dòng/món, trong đó món không nhãn): tổng ${dem(tong(x))} — `,
      [
        ...RETURN_DISPOSITIONS.map((k) => {
          const r = x.find((y) => y.key === k);
          return `${k} ${dem(r?.n ?? 0)}/${dem(r?.qty ?? 0)} (${dem(r?.unidentified ?? 0)})`;
        }),
        ...x.filter((y) => !(RETURN_DISPOSITIONS as readonly string[]).includes(y.key)).map((y) => `${y.key} (lạ) ${dem(y.n)}`),
      ],
    ),
  );
  muc("MÓN HOÀN KHÔNG NHÃN", s.unidentified, (x) =>
    packParts(`MÓN HOÀN KHÔNG NHÃN (có/chưa có mẫu mã): tổng ${dem(x.reduce((t, y) => t + y.withVariant + y.withoutVariant, 0))} — `, [
      ...UNIDENTIFIED_STATUSES.map((k) => {
        const r = x.find((y) => y.status === k);
        return `${k} ${dem(r?.withVariant ?? 0)}/${dem(r?.withoutVariant ?? 0)}`;
      }),
      ...x.filter((y) => !(UNIDENTIFIED_STATUSES as readonly string[]).includes(y.status)).map((y) => `${y.status} (lạ) ${dem(y.withVariant)}/${dem(y.withoutVariant)}`),
    ]),
  );
  muc("YÊU CẦU DUYỆT", s.approvals, (x) => {
    const ev = s.events.ok ? (s.events.data.find((e) => e.name === "approval.executed") ?? { n7: 0, n: 0 }) : null;
    return [
      ...packParts(
        "YÊU CẦU DUYỆT (7 ngày/tổng) — ",
        APPROVAL_STATUSES.map((k) => {
          const r = x.find((y) => y.status === k);
          return `${k} ${dem(r?.n7 ?? 0)}/${dem(r?.n ?? 0)}`;
        }),
      ),
      `  lỗi khi chạy (execution_error) ${dem(x.reduce((t, y) => t + y.err7, 0))}/${dem(x.reduce((t, y) => t + y.err, 0))} · sự kiện approval.executed ${ev ? `${dem(ev.n7)}/${dem(ev.n)}` : "— (không đọc được sổ sự kiện)"}`,
    ];
  });
  muc("PHIẾU NHẬP", s.receipts, (x) => [
    `PHIẾU NHẬP (RECEIPT): tổng ${dem(x.receipts)} · gắn lệnh SX ${dem(x.withOrder)} · gắn lô xưởng ${dem(x.withBatch)} · gắn ít nhất một ${dem(x.linked)} · 30 ngày: ${dem(x.linked30)}/${dem(x.receipts30)} có gắn`,
  ]);
  return out.slice(0, SUMMARY_MAX_LINES).map((l) => l.slice(0, SUMMARY_MAX_CHARS));
}

// ═══════════════════════════ ĐỌC (mỗi mục MỘT câu) ═══════════════════════════

async function docMuc<T>(fn: () => Promise<T>): Promise<Doc<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const so = (v: unknown) => Number(v ?? 0);
const soHoacNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const ngay = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
type R = Record<string, unknown>;

/** Tuần tự (máy 2 nhân đang phục vụ người dùng thật); mục hỏng không kéo mục khác. */
export async function collectCompanyOsSummary(db: Db): Promise<CompanyOsSummary> {
  const at = new Date();
  const q = async (s: ReturnType<typeof sql>) => rowsOf<R>(await db.execute(s));

  const models = await docMuc(async () => {
    const rows = await q(sql`
      select lifecycle_state as k, count(*)::int as n,
        count(*) filter (where product_id is not null)::int as with_product,
        count(*) filter (where product_id is null and design_concept_id is not null)::int as design_only,
        count(*) filter (where product_id is null and design_concept_id is null)::int as bare,
        count(*) filter (where registered_by = 'USER')::int as by_user
      from product_models group by lifecycle_state`);
    return {
      byState: rows.map((r) => ({ key: r.k === null || r.k === undefined ? null : String(r.k), n: so(r.n) })),
      withProduct: rows.reduce((t, r) => t + so(r.with_product), 0),
      designOnly: rows.reduce((t, r) => t + so(r.design_only), 0),
      bare: rows.reduce((t, r) => t + so(r.bare), 0),
      byUser: rows.reduce((t, r) => t + so(r.by_user), 0),
    };
  });

  const registry = await docMuc(async () => {
    const p = await previewModelRegistry();
    return { pendingInsert: p.pendingInsert, pendingLink: p.pendingLink, ambiguous: p.ambiguous.length };
  });

  const runs = await docMuc(async () => {
    const [r] = await q(sql`
      select
        (select max(started_at) from sync_runs where job = 'model-registry') as reg_at,
        (select status from sync_runs where job = 'model-registry' order by started_at desc limit 1) as reg_status,
        (select count(*)::int from sync_runs where job = 'model-registry' and started_at >= now() - interval '7 days') as reg_7,
        (select max(started_at) from sync_runs where job = 'dashboard-warm') as warm_at,
        (select status from sync_runs where job = 'dashboard-warm' order by started_at desc limit 1) as warm_status,
        (select skipped from sync_runs where job = 'dashboard-warm' order by started_at desc limit 1) as warm_skipped,
        (select substring(detail from 'cockpit:model-signals ([0-9]+) ms') from sync_runs where job = 'dashboard-warm' order by started_at desc limit 1) as warm_signal_ms`);
    return {
      registryLastAt: ngay(r?.reg_at),
      registryLastStatus: r?.reg_status === null || r?.reg_status === undefined ? null : String(r.reg_status),
      registryRuns7: so(r?.reg_7),
      warmLastAt: ngay(r?.warm_at),
      warmLastStatus: r?.warm_status === null || r?.warm_status === undefined ? null : String(r.warm_status),
      warmFailed: soHoacNull(r?.warm_skipped),
      warmModelSignalsMs: soHoacNull(r?.warm_signal_ms),
    };
  });

  const events = await docMuc(async () =>
    (
      await q(sql`
        select name as ev, count(*) filter (where occurred_at >= now() - interval '7 days')::int as n7, count(*)::int as n
        from domain_events group by 1 order by 1`)
    ).map((r) => ({ name: String(r.ev), n7: so(r.n7), n: so(r.n) })),
  );

  const topics = await docMuc(async () => {
    const rows = await q(sql`select status, evidence_snapshot as ev_snap from production_topics`);
    const by = new Map<string, number>();
    let early = 0;
    let promisingAtOpen = 0;
    let noContext = 0;
    for (const r of rows) {
      by.set(String(r.status), (by.get(String(r.status)) ?? 0) + 1);
      const ctx = describeTopicOpenContext(r.ev_snap);
      if (!ctx) noContext += 1;
      else if (ctx.early) early += 1;
      const snap = r.ev_snap as { signalAtOpen?: { signal?: unknown } | null } | null;
      if (snap?.signalAtOpen?.signal === "PROMISING") promisingAtOpen += 1;
    }
    return { byStatus: [...by].map(([key, n]) => ({ key, n })), early, promisingAtOpen, noContext };
  });

  const countBy = (table: "cost_sheets" | "samples") =>
    docMuc(async () => (await q(sql`select status as k, count(*)::int as n from ${sql.raw(table)} group by status`)).map((r) => ({ key: String(r.k), n: so(r.n) })));
  const costSheets = await countBy("cost_sheets");
  const samples = await countBy("samples");

  const design = await docMuc(async () => {
    const [r] = await q(sql`
      with dv as (select count(*)::int as n, min(approved_at) as first_at from design_versions)
      select dv.n as versions, dv.first_at,
        count(po.id)::int as orders,
        count(po.id) filter (where po.design_version_id is not null)::int as linked,
        count(po.id) filter (where dv.first_at is not null and po.created_at >= dv.first_at)::int as since,
        count(po.id) filter (where dv.first_at is not null and po.created_at >= dv.first_at and po.design_version_id is not null)::int as since_linked
      from dv left join production_orders po on true
      group by dv.n, dv.first_at`);
    const first = ngay(r?.first_at);
    return {
      versions: so(r?.versions),
      firstApprovedAt: first,
      orders: so(r?.orders),
      ordersLinked: so(r?.linked),
      ordersSince: first ? so(r?.since) : null,
      ordersSinceLinked: first ? so(r?.since_linked) : null,
    };
  });

  const recommendations = await docMuc(async () =>
    (
      await q(sql`
        select kind, decision, count(*) filter (where decided_at >= now() - interval '7 days')::int as n7, count(*)::int as n
        from recommendation_decisions group by kind, decision order by kind, decision`)
    ).map((r) => ({ kind: String(r.kind), decision: String(r.decision), n7: so(r.n7), n: so(r.n) })),
  );

  const ownerDigest = await docMuc(async () => {
    const rows = await q(sql`select key, value from settings where key in (${OWNER_DIGEST_CONFIG_KEY}, ${OWNER_DIGEST_LEDGER_KEY})`);
    const cfg = rows.find((r) => r.key === OWNER_DIGEST_CONFIG_KEY);
    const led = rows.find((r) => r.key === OWNER_DIGEST_LEDGER_KEY);
    let enabled: boolean | null = null;
    if (cfg) {
      try {
        const v = JSON.parse(String(cfg.value)) as { enabled?: unknown } | null;
        enabled = v && typeof v.enabled === "boolean" ? v.enabled : null;
      } catch {
        enabled = null;
      }
    }
    const ledger = parseOwnerDigestLedger(led ? String(led.value) : null);
    return { configured: Boolean(cfg), enabled, ledgerDay: ledger.day, lastSentAt: ledger.lastSentAt, seenToday: ledger.seen.length };
  });

  const dispositions = await docMuc(async () =>
    (
      await q(sql`
        select disposition as k, count(*)::int as n, coalesce(sum(qty), 0)::int as qty, count(*) filter (where unidentified_id is not null)::int as unid
        from return_dispositions group by disposition`)
    ).map((r) => ({ key: String(r.k), n: so(r.n), qty: so(r.qty), unidentified: so(r.unid) })),
  );

  const unidentified = await docMuc(async () =>
    (
      await q(sql`
        select status as k, count(*) filter (where variant_id is not null)::int as with_v, count(*) filter (where variant_id is null)::int as without_v
        from return_unidentified group by status`)
    ).map((r) => ({ status: String(r.k), withVariant: so(r.with_v), withoutVariant: so(r.without_v) })),
  );

  const approvals = await docMuc(async () =>
    (
      await q(sql`
        select status::text as k,
          count(*) filter (where requested_at >= now() - interval '7 days')::int as n7, count(*)::int as n,
          count(*) filter (where execution_error is not null and requested_at >= now() - interval '7 days')::int as err7,
          count(*) filter (where execution_error is not null)::int as err
        from approval_requests group by status`)
    ).map((r) => ({ status: String(r.k), n7: so(r.n7), n: so(r.n), err7: so(r.err7), err: so(r.err) })),
  );

  const receipts = await docMuc(async () => {
    const [r] = await q(sql`
      select count(*)::int as n,
        count(*) filter (where production_order_id is not null)::int as po,
        count(*) filter (where production_batch_id is not null)::int as batch,
        count(*) filter (where production_order_id is not null or production_batch_id is not null)::int as linked,
        count(*) filter (where received_at >= now() - interval '30 days')::int as n30,
        count(*) filter (where received_at >= now() - interval '30 days' and (production_order_id is not null or production_batch_id is not null))::int as linked30
      from stock_receipts where kind = 'RECEIPT'`);
    return { receipts: so(r?.n), withOrder: so(r?.po), withBatch: so(r?.batch), linked: so(r?.linked), receipts30: so(r?.n30), linked30: so(r?.linked30) };
  });

  return { at, models, registry, runs, events, topics, costSheets, samples, design, recommendations, ownerDigest, dispositions, unidentified, approvals, receipts };
}

async function main() {
  const db = await getDb();
  const [ro] = rowsOf<R>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("company-os-summary: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  for (const line of companyOsSummaryLines(await collectCompanyOsSummary(db))) tomTat(line);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("company-os-summary lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

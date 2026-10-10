/*
  ops `saas-value-snapshot-check` — ẢNH GIÁ TRỊ THEO TỔ CHỨC + SỨC KHOẺ THEO NGÀY ĐÃ CHỤP TỚI ĐÂU (0240 · CHỈ ĐỌC).

  Vì sao có (11/10/2026, sứ mệnh saas-value-snapshots): lượt chụp chạy NGẦM, ké job `alerts` của nhà (captureSaasSnapshot · nhánh JOB),
  một lần mỗi ngày VN. Sau deploy cần trả lời ba câu mà không mở CSDL bằng tay: (1) hôm nay đã có ảnh chưa, mấy tổ chức × mấy cửa sổ;
  (2) bao nhiêu ô phẳng CHƯA BIẾT và nguồn nào hay hỏng (`source_errors`); (3) lượt chụp mất bao lâu — đọc từ chi tiết lượt chạy job
  `alerts` (đoạn «ảnh giá trị …: n/m tổ chức, X ms (sổ nhà Y ms, chậm nhất Z ms)» do saasSnapshotForJob ghi).

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên); `main` hỏi lại rồi dừng nếu không phải. Không INSERT /
  UPDATE / DELETE, không chạy job (tests/saas-value-snapshots.test.ts quét mã nguồn).

  ĐẦU RA:
   · phần MÃ HOÁ (dòng không tiền tố): từng tổ chức của ngày mới nhất — mã · cửa sổ · cột phẳng · mã nguồn hỏng · mức sức khoẻ / rủi ro.
   · kênh công khai `[ops:tom-tat] `: CHỈ số đếm theo ngày × cửa sổ, số ô NULL từng cột, số dòng có nguồn hỏng theo MÃ nguồn, phân bố mức
     sức khoẻ / rủi ro, và đoạn thời gian chụp của job. Không mã tổ chức, không tiền.
   · Mã thoát: 0 đọc xong (kể cả CHƯA CÓ ẢNH — chưa chụp không phải lỗi của phép đọc) · 64 arg sai · 70 CSDL không chỉ đọc · 1 lỗi đọc.

  arg: "[--days=1..30]" (mặc định 3 ngày gần nhất).
  ops lấy SCRIPT này từ `main` nhưng `lib/` từ IMAGE đang chạy — cần image mang 0240.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("saas-value-snapshot-check.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addDays, vnDate } from "@/lib/billing/rules";
import { platformReadOnlyConfirmed } from "@/lib/pricing/migration";
import { TENANT_VALUE_SOURCES } from "@/lib/saas/tenant-value-capture";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

export function parseSnapshotCheckArgs(args: readonly string[]): { ok: true; days: number } | { ok: false; error: string } {
  let days = 3;
  for (const a of args.map((x) => x.trim()).filter(Boolean)) {
    const m = /^--days=(\d{1,2})$/.exec(a);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 30) return { ok: false, error: `arg không hiểu: «${a.slice(0, 40)}» — chỉ nhận --days=1..30` };
    days = Number(m[1]);
  }
  return { ok: true, days };
}

export type SnapshotRowLite = {
  capturedDay: string;
  orgCode: string;
  windowDays: number;
  customerSpendVnd: number | null;
  variableCogsVnd: number | null;
  platformGrossProfitVnd: number | null;
  aiCreditedGrossProfitVnd: number | null;
  valueMultipleMilli: number | null;
  ordersPending: number | null;
  formulaVersion: string;
  sourceErrors: string[];
};
export type HealthRowLite = { day: string; orgCode: string; level: string; churnRisk: string };

const FLATS = ["customerSpendVnd", "variableCogsVnd", "platformGrossProfitVnd", "aiCreditedGrossProfitVnd", "valueMultipleMilli", "ordersPending"] as const;

/** Mã nguồn của một dòng `source_errors` («AI_USAGE (30 ngày): …» → AI_USAGE). Chuỗi lạ ⇒ «(khác)», không in nguyên văn. HÀM THUẦN. */
export function sourceCodeOf(line: string): string {
  const m = /^(?:\d+d\s+)?([A-Z_]+)\b/.exec(line);
  return m && (TENANT_VALUE_SOURCES as readonly string[]).includes(m[1]) ? m[1] : "(khác)";
}

/** Đoạn thời gian chụp trong chi tiết lượt chạy `alerts` — CHỈ phần «ảnh giá trị …)» (không kèm câu lỗi có thể mang mã tổ chức). */
export function captureTimingOf(detail: string): string | null {
  const m = /ảnh giá trị (?:CAPTURED|SKIPPED|REFUSED): \d+\/\d+ tổ chức, \d+ ms \(sổ nhà \d+ ms(?:, chậm nhất \d+ ms)?\)(?:, lỗi nguồn \d+)?/.exec(detail);
  return m ? m[0] : null;
}

/** Dòng công khai — chỉ số đếm. HÀM THUẦN. */
export function summarizeSnapshots(input: { today: string; rows: readonly SnapshotRowLite[]; health: readonly HealthRowLite[]; timings: readonly { at: string; text: string }[] }): string[] {
  const out: string[] = [];
  const days = [...new Set(input.rows.map((r) => r.capturedDay))].sort().reverse();
  const hasToday = days.includes(input.today);
  out.push(`saas-value-snapshot-check: ${hasToday ? "CÓ ẢNH HÔM NAY" : "CHƯA CÓ ẢNH HÔM NAY"} · ${input.today} · ${days.length} ngày có ảnh trong kỳ đọc`);
  for (const d of days) {
    const dayRows = input.rows.filter((r) => r.capturedDay === d);
    const versions = [...new Set(dayRows.map((r) => r.formulaVersion))].join(",");
    for (const w of [...new Set(dayRows.map((r) => r.windowDays))].sort((a, b) => a - b)) {
      const rs = dayRows.filter((r) => r.windowDays === w);
      const nulls = FLATS.map((k) => `${k}=${rs.filter((r) => r[k] === null).length}`).join(" ");
      out.push(`${d} · ${w} ngày · ${new Set(rs.map((r) => r.orgCode)).size} tổ chức · ${versions} · NULL: ${nulls} · dòng có nguồn hỏng ${rs.filter((r) => r.sourceErrors.length > 0).length}`);
    }
    const bySource = new Map<string, number>();
    for (const r of dayRows) for (const c of new Set(r.sourceErrors.map(sourceCodeOf))) bySource.set(c, (bySource.get(c) ?? 0) + 1);
    if (bySource.size) out.push(`${d} · nguồn hỏng (số dòng): ${[...bySource].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(" · ")}`);
    const h = input.health.filter((x) => x.day === d);
    const tally = (k: "level" | "churnRisk") => [...h.reduce((m, x) => m.set(x[k], (m.get(x[k]) ?? 0) + 1), new Map<string, number>())].sort().map(([v, n]) => `${v} ${n}`).join(" · ");
    out.push(`${d} · sức khoẻ ${h.length} tổ chức: ${tally("level") || "—"} · rủi ro rời bỏ: ${tally("churnRisk") || "—"}`);
  }
  for (const t of input.timings) out.push(`lượt chụp ${t.at}: ${t.text}`);
  if (!input.timings.length) out.push("lượt chụp: chưa thấy đoạn «ảnh giá trị» trong chi tiết job alerts của kỳ đọc");
  return out.slice(0, 60).map((l) => l.slice(0, 300));
}

async function main() {
  const parsed = parseSnapshotCheckArgs(ARGS);
  if (!parsed.ok) {
    tomTat(`saas-value-snapshot-check: FAIL · ${parsed.error}`);
    process.exit(64);
  }
  if (!(await platformReadOnlyConfirmed())) {
    tomTat("saas-value-snapshot-check: FAIL · DỪNG: kết nối CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(70);
  }
  const now = new Date();
  const today = vnDate(now);
  const fromDay = addDays(today, -(parsed.days - 1));
  // Không có ngữ cảnh tổ chức ⇒ getDb() là CSDL NHÀ — nơi hai bảng ảnh chụp và sổ lượt chạy của job nhà nằm.
  const db = await getDb();
  const v = schema.platformTenantValueSnapshots;
  const h = schema.platformTenantHealthDaily;
  const r = schema.syncRuns;
  const rows = await db.select().from(v).where(gte(v.capturedDay, fromDay));
  const health = await db.select({ day: h.day, orgCode: h.orgCode, level: h.level, churnRisk: h.churnRisk }).from(h).where(gte(h.day, fromDay));
  const runs = await db
    .select({ at: r.startedAt, detail: r.detail })
    .from(r)
    .where(and(eq(r.job, "alerts"), gte(r.startedAt, new Date(`${fromDay}T00:00:00+07:00`))))
    .orderBy(desc(r.startedAt))
    .limit(2000);
  const timings = runs.map((x) => ({ at: x.at.toISOString(), text: captureTimingOf(x.detail) })).filter((x): x is { at: string; text: string } => x.text !== null).slice(0, 10);
  const latest = [...new Set(rows.map((x) => x.capturedDay))].sort().pop() ?? null;
  for (const x of rows.filter((y) => y.capturedDay === latest).sort((a, b) => a.orgCode.localeCompare(b.orgCode) || a.windowDays - b.windowDays)) {
    console.log(`${x.capturedDay} ${x.orgCode} ${x.windowDays}d · spend=${x.customerSpendVnd ?? "—"} cogs=${x.variableCogsVnd ?? "—"} gp=${x.platformGrossProfitVnd ?? "—"} aiGp=${x.aiCreditedGrossProfitVnd ?? "—"} multiple‰=${x.valueMultipleMilli ?? "—"} pending=${x.ordersPending ?? "—"} · ${x.formulaVersion} · nguồn hỏng: ${[...new Set(x.sourceErrors.map(sourceCodeOf))].join(",") || "—"} · chụp ${x.capturedAt.toISOString()}`);
  }
  for (const x of health.filter((y) => y.day === latest)) console.log(`${x.day} ${x.orgCode} · sức khoẻ ${x.level} · rủi ro ${x.churnRisk}`);
  for (const l of summarizeSnapshots({ today, rows, health, timings })) tomTat(l);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.log(`LỖI: ${errText(e)}`);
    tomTat("saas-value-snapshot-check: FAIL · LỖI đọc — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

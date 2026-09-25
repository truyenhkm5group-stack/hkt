/*
  ops `confirm-funnel-audit` — "ĐÃ XÁC NHẬN" CŨ vs MỚI, VÀ ĐƠN HUỶ KHI CHƯA TỪNG XÁC NHẬN.

  Chủ shop chốt 25/09/2026: bước "đã xác nhận" của phễu / thẻ nhân viên đổi từ `stage not in
  ('NEW','WAITING')` (đọc trạng thái HIỆN TẠI — tính cả đơn huỷ khi chưa ai xác nhận) sang
  `ORDER_EVER_CONFIRMED` (đơn TỪNG được xác nhận). AGENTS.md mục 6.5: sửa số liệu báo cáo phải đối
  chiếu trước / sau trên production — script này in CẢ HAI cạnh nhau trên cùng một lượt đọc.

  Định nghĩa CŨ chỉ còn ở đây, viết thẳng bằng SQL, và CHỈ để đối chiếu — không màn hình nào đọc nó.
  Định nghĩa MỚI đọc qua ĐÚNG hàm của trang (`getConversionFunnel`, `getConversionByDimension`).

  KHÔNG IN tên nhân viên, tên khách, SĐT, mã đơn: chỉ số đếm theo kỳ, theo NGUỒN đơn và theo GIỜ.
  Nhánh ops vẫn bọc `ma_hoa_ket_qua`. CHỈ ĐỌC do Postgres ép (ERP_READ_ONLY), cùng khuôn với
  `cod-statement-audit` / `stock-wait-summary`.

  arg: `--days=N` (mặc định 90, trần 365) — kỳ lọc theo ngày lên đơn.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("confirm-funnel-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { PANCAKE_ORDER_STATUS } from "@/lib/constants/pancake";
import { addDays, todayVN } from "@/lib/format";
import { getConversionByDimension, getConversionFunnel, type ConversionFunnel } from "@/lib/queries/conversion-funnel";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

export const AUDIT_MAX_LINES = 60;

export function soNgay(argv: string[]): number {
  const m = argv.join(" ").match(/--days=(\d+)/);
  const n = m ? Number(m[1]) : 90;
  return Math.min(365, Math.max(7, Number.isFinite(n) ? n : 90));
}

export type OldDefinition = { created: number; confirmed: number; cancelled: number; confirmMedianHours: number | null };
export type DimLine = { label: string; created: number; confirmed: number; preCancel: number; postCancel: number; medianHoursToPreCancel: number | null };

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");
const gio = (h: number | null) => (h === null ? "—" : h < 1 ? `${Math.round(h * 60)} phút` : h < 48 ? `${h.toFixed(1)} giờ` : `${(h / 24).toFixed(1)} ngày`);

/** Mọi dòng tóm tắt. Hàm THUẦN — bài kiểm gọi thẳng. */
export function confirmAuditLines(days: number, oldDef: OldDefinition, f: ConversionFunnel, bySource: DimLine[], byHour: DimLine[]): string[] {
  const created = f.steps.find((s) => s.key === "CREATED")?.count ?? 0;
  const confirmed = f.steps.find((s) => s.key === "CONFIRMED")?.count ?? 0;
  const timing = f.steps.find((s) => s.key === "CONFIRMED")?.timing;
  const p = f.preConfirmCancel;
  const out: string[] = [];
  out.push(`KỲ ${days} ngày theo ngày lên đơn · ${created} đơn tạo (định nghĩa cũ đếm ${oldDef.created})`);
  out.push(
    `ĐÃ XÁC NHẬN · CŨ (stage ∉ NEW/WAITING): ${oldDef.confirmed} (${pct(oldDef.confirmed, oldDef.created)}) · MỚI (từng xác nhận): ${confirmed} (${pct(confirmed, created)}) · chênh ${oldDef.confirmed - confirmed} đơn`,
  );
  out.push(`TRUNG VỊ LÊN ĐƠN → XÁC NHẬN · CŨ (tính cả mốc huỷ): ${gio(oldDef.confirmMedianHours)} · MỚI: ${gio(timing?.medianHours ?? null)} (p90 ${gio(timing?.p90Hours ?? null)}, đo được ${timing?.coverage === null || timing?.coverage === undefined ? "—" : `${(timing.coverage * 100).toFixed(0)}%`})`);
  out.push(`ĐƠN HUỶ: ${f.cancelled} · huỷ KHI CHƯA TỪNG xác nhận ${p.count} (${pct(p.count, created)} số đơn tạo) · huỷ SAU xác nhận ${f.cancelledAfterConfirm}`);
  out.push(`HUỶ TRƯỚC XÁC NHẬN — sau bao lâu (đo được ${p.measured}/${p.count}): trung vị ${gio(p.medianHours)} · p90 ${gio(p.p90Hours)}`);
  out.push(`  ${p.buckets.map((b) => `${b.label}: ${b.count}`).join(" · ")}${p.count - p.buckets.reduce((t, b) => t + b.count, 0) > 0 ? ` · chưa có mốc huỷ: ${p.count - p.buckets.reduce((t, b) => t + b.count, 0)}` : ""}`);
  out.push("THEO NGUỒN: nguồn · tạo · xác nhận (mới) · huỷ trước XN · tỷ lệ · trung vị giờ huỷ · huỷ sau XN");
  for (const r of bySource) out.push(`  ${r.label} · ${r.created} · ${r.confirmed} · ${r.preCancel} · ${pct(r.preCancel, r.created)} · ${gio(r.medianHoursToPreCancel)} · ${r.postCancel}`);
  out.push("THEO GIỜ LÊN ĐƠN (giờ VN): giờ · tạo · huỷ trước XN · tỷ lệ");
  const hourLines = [...byHour].sort((a, b) => a.label.localeCompare(b.label));
  for (let i = 0; i < hourLines.length; i += 6) {
    out.push(`  ${hourLines.slice(i, i + 6).map((r) => `${r.label}h ${r.created}/${r.preCancel} (${pct(r.preCancel, r.created)})`).join(" · ")}`);
  }
  return out.slice(0, AUDIT_MAX_LINES).map((l) => l.slice(0, 300));
}

/** Mã nhóm Mới / Chờ — suy từ bảng trạng thái, không gõ tay. Mốc "xác nhận" CŨ = lần đầu rời nhóm này (kể cả huỷ). */
const NHOM_CHO = Object.entries(PANCAKE_ORDER_STATUS)
  .filter(([, v]) => v.stage === "NEW" || v.stage === "WAITING")
  .map(([k]) => Number(k));

async function oldDefinition(from: Date, to: Date): Promise<OldDefinition> {
  const db = await getDb();
  const [r] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with don as (
        select o.id, o.stage::text as stage, o.inserted_at,
               (select min(h.updated_at) from order_status_history h
                 where h.order_id = o.id and h.status not in ${sql.raw(`(${NHOM_CHO.join(",")})`)}) as xn_cu
          from orders o
         where o.inserted_at >= ${from} and o.inserted_at <= ${to})
      select count(*) as created,
             count(*) filter (where stage not in ('NEW','WAITING')) as confirmed,
             count(*) filter (where stage in ('CANCELLED','DELETED')) as cancelled,
             percentile_cont(0.5) within group (order by extract(epoch from (xn_cu - inserted_at)) / 3600)
               filter (where xn_cu is not null and xn_cu >= inserted_at) as med
        from don`),
  );
  return {
    created: Number(r?.created ?? 0),
    confirmed: Number(r?.confirmed ?? 0),
    cancelled: Number(r?.cancelled ?? 0),
    confirmMedianHours: r?.med === null || r?.med === undefined ? null : Number(r.med),
  };
}

async function main() {
  const db = await getDb();
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("confirm-funnel-audit: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  const days = soNgay(process.argv.slice(2));
  const toKey = todayVN();
  const fromKey = addDays(toKey, -(days - 1));
  const period: Period = { key: "custom", from: new Date(`${fromKey}T00:00:00+07:00`), to: new Date(`${toKey}T23:59:59.999+07:00`), label: `${days} ngày`, fromKey, toKey };
  const [oldDef, f, src, hour] = await Promise.all([
    oldDefinition(period.from as Date, period.to as Date),
    getConversionFunnel(period),
    getConversionByDimension(period, "source"),
    getConversionByDimension(period, "hour"),
  ]);
  const dim = (rows: typeof src.rows): DimLine[] =>
    rows.map((r) => ({ label: r.label, created: r.created, confirmed: r.confirmed, preCancel: r.cancelledBeforeConfirm, postCancel: r.cancelledAfterConfirm, medianHoursToPreCancel: r.medianHoursToPreConfirmCancel }));
  for (const line of confirmAuditLines(days, oldDef, f, dim(src.rows), dim(hour.rows))) tomTat(line);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("confirm-funnel-audit lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

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

  Bổ sung 25/09/2026 (chủ shop hỏi "đã lọc trùng chưa" và "báo cáo đơn huỷ sau xác nhận"): in thêm
  phân tích đơn huỷ của `getCancelAnalysis` — mất thật hay đã có đơn thay (luật đơn trùng), huỷ sau
  bao lâu, huỷ sau xác nhận ở khâu nào. Vẫn chỉ số đếm, không một dòng đơn nào.

  arg: `--days=N` (mặc định 90, trần 365) — kỳ lọc theo ngày lên đơn.

  Bổ sung 25/09/2026 (chủ shop: "làm tất cả các việc bạn thấy là tốt nhất"), hai chế độ đo riêng:
   · `--gio` — giờ lên đơn bất thường (1.006 đơn "lên lúc 15h", 126 đơn lúc 3h sáng với 78% huỷ).
     Hỏi: đó là giờ khách đặt thật, hay giờ của một lượt nhập / đồng bộ hàng loạt? Đếm đơn Pancake
     không gửi `inserted_at` (ERP lùi về giờ đồng bộ), đơn có mốc lên đơn MUỘN hơn trạng thái đầu
     tiên, và các PHÚT dồn nhiều đơn — một lượt nhập hàng loạt để lại dấu vân tay "hàng trăm đơn
     cùng một phút".
   · `--xoa` — đơn "Đã xoá" khác đơn "Đã huỷ" ở đâu: có hàng không, có tiền không, từng xác nhận
     chưa, có vận đơn không, cùng SĐT có đơn khác quanh đó không. Để quyết định có tách "Đã xoá"
     khỏi số huỷ bằng dữ kiện, không bằng đoán.
  Cả hai vẫn CHỈ in số đếm và mốc thời gian gộp theo phút / ngày — không mã đơn, không SĐT, không tên.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("confirm-funnel-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { PANCAKE_ORDER_STATUS } from "@/lib/constants/pancake";
import { addDays, todayVN } from "@/lib/format";
import { CANCEL_MATCHES, CANCEL_MATCH_LABEL, POST_CONFIRM_STAGES, POST_CONFIRM_STAGE_LABEL } from "@/lib/constants/cancel-analysis";
import { getCancelAnalysis, type CancelAnalysis, type CancelSide } from "@/lib/queries/cancel-analysis";
import { CANCELLED_AT, ORDER_EVER_CONFIRMED, getConversionByDimension, getConversionFunnel, type ConversionFunnel } from "@/lib/queries/conversion-funnel";
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

function sideLines(title: string, x: CancelSide, windowHours: number): string[] {
  return [
    `${title}: ${x.total} đơn (xoá ${x.deleted}) · MẤT THẬT ${x.lost} · đã có đơn thay ${x.replaced} · trung vị tuổi lúc huỷ ${gio(x.medianAgeHours)} (đo được ${x.ageMeasured})`,
    `  ${CANCEL_MATCHES.map((k) => `${CANCEL_MATCH_LABEL[k]}: ${x.byMatch[k]} (7 ngày: ${x.byMatchWide[k]})`).join(" · ")} — cửa sổ ${windowHours} giờ`,
    `  tuổi lúc huỷ: ${x.ageBuckets.map((b) => `${b.label}: ${b.count}`).join(" · ")}`,
  ];
}

/** Phân tích đơn huỷ — số tổng hợp. Hàm THUẦN. */
export function cancelAnalysisLines(a: CancelAnalysis): string[] {
  return [
    ...sideLines("HUỶ TRƯỚC XÁC NHẬN", a.pre, a.windowHours),
    ...sideLines("HUỶ SAU XÁC NHẬN (tuổi tính từ lúc xác nhận)", a.post, a.windowHours),
    `  huỷ ở khâu: ${POST_CONFIRM_STAGES.map((k) => `${POST_CONFIRM_STAGE_LABEL[k]}: ${a.post.byStage[k]}`).join(" · ")} · từng chờ hàng: ${a.post.waitedStock}`,
    "THEO NGUỒN: nguồn · huỷ trước XN (mất thật) · huỷ sau XN (mất thật)",
    ...a.bySource.map((r) => `  ${r.label} · ${r.pre} (${r.preLost}) · ${r.post} (${r.postLost})`),
  ];
}

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

// ─────────────────────────── --gio: giờ lên đơn bất thường ───────────────────────────

export type HourRow = { hour: number; created: number; missingStamp: number; laterThanHistory: number; preCancel: number };
export type MinuteRow = { minute: string; created: number; cancelled: number; missingStamp: number; source: string; medHistoryGapMin: number | null; medErpGapMin: number | null };
export type DayRow = { hour: number; day: string; created: number };

/** Giờ nào dồn bất thường: nhiều hơn 3 lần trung vị của 24 giờ. Hàm THUẦN. */
export function spikeHours(rows: readonly HourRow[]): number[] {
  const counts = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.hour === h)?.created ?? 0).sort((a, b) => a - b);
  const med = (counts[11] + counts[12]) / 2;
  return rows.filter((r) => med > 0 && r.created > 3 * med).map((r) => r.hour).sort((a, b) => a - b);
}

/** Dòng tóm tắt cho `--gio`. Hàm THUẦN — bài kiểm gọi thẳng. */
export function hourAuditLines(days: number, hours: readonly HourRow[], minutes: readonly MinuteRow[], spikeDays: readonly DayRow[]): string[] {
  const tong = hours.reduce((t, r) => t + r.created, 0);
  const thieu = hours.reduce((t, r) => t + r.missingStamp, 0);
  const muon = hours.reduce((t, r) => t + r.laterThanHistory, 0);
  const out: string[] = [];
  out.push(`GIỜ LÊN ĐƠN — ${days} ngày · ${tong} đơn · Pancake KHÔNG gửi inserted_at (ERP lùi về giờ đồng bộ): ${thieu} · mốc lên đơn MUỘN hơn trạng thái đầu > 1 giờ: ${muon}`);
  out.push("THEO GIỜ (VN): giờ tạo/thiếu mốc/muộn hơn lịch sử/huỷ trước XN");
  const sorted = [...hours].sort((a, b) => a.hour - b.hour);
  for (let i = 0; i < sorted.length; i += 6) {
    out.push(`  ${sorted.slice(i, i + 6).map((r) => `${String(r.hour).padStart(2, "0")}h ${r.created}/${r.missingStamp}/${r.laterThanHistory}/${r.preCancel}`).join(" · ")}`);
  }
  const dinh = spikeHours(hours);
  out.push(`GIỜ DỒN (> 3 × trung vị 24 giờ): ${dinh.length ? dinh.map((h) => `${String(h).padStart(2, "0")}h`).join(", ") : "không có"}`);
  for (const h of dinh) {
    const ds = spikeDays.filter((d) => d.hour === h).sort((a, b) => b.created - a.created).slice(0, 8);
    const trongGio = hours.find((r) => r.hour === h)?.created ?? 0;
    const top = ds.reduce((t, d) => t + d.created, 0);
    out.push(`  ${String(h).padStart(2, "0")}h theo NGÀY (8 ngày nhiều nhất = ${top}/${trongGio}): ${ds.map((d) => `${d.day} ${d.created}`).join(" · ")}`);
  }
  out.push("PHÚT DỒN (≥ 5 đơn cùng một phút, giờ VN): phút · đơn · huỷ/xoá · thiếu mốc · nguồn nhiều nhất · trung vị (trạng thái đầu − lên đơn) · trung vị (ERP ghi dòng − lên đơn)");
  const phut = (m: number | null) => (m === null ? "—" : Math.abs(m) < 120 ? `${Math.round(m)} phút` : Math.abs(m) < 2880 ? `${(m / 60).toFixed(1)} giờ` : `${(m / 1440).toFixed(1)} ngày`);
  for (const m of minutes.slice(0, 15)) {
    out.push(`  ${m.minute} · ${m.created} · ${m.cancelled} · ${m.missingStamp} · ${m.source || "—"} · ${phut(m.medHistoryGapMin)} · ${phut(m.medErpGapMin)}`);
  }
  if (!minutes.length) out.push("  không có phút nào dồn ≥ 5 đơn");
  return out.slice(0, AUDIT_MAX_LINES).map((l) => l.slice(0, 300));
}

export async function hourAudit(from: Date, to: Date): Promise<{ hours: HourRow[]; minutes: MinuteRow[]; spikeDays: DayRow[] }> {
  const db = await getDb();
  const o = schema.orders;
  const base = sql`
    select ${o.id} as id, ${o.stage}::text as stage, ${o.source} as source, ${o.insertedAt} as ins, ${o.createdAt} as erp_at,
           extract(hour from ${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::int as gio,
           to_char(${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') as phut,
           to_char(${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as ngay,
           coalesce(${o.raw}->>'inserted_at', '') = '' as thieu_moc,
           (select min(h.updated_at) from order_status_history h where h.order_id = ${o.id}) as ls_dau,
           (${ORDER_EVER_CONFIRMED}) as da_xn
      from ${o}
     where ${o.insertedAt} >= ${from} and ${o.insertedAt} <= ${to}`;
  const hours = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with don as (${base})
      select gio, count(*) as n,
             count(*) filter (where thieu_moc) as thieu,
             count(*) filter (where ls_dau is not null and ins > ls_dau + interval '1 hour') as muon,
             count(*) filter (where stage in ('CANCELLED','DELETED') and not da_xn) as huy
        from don group by gio`),
  ).map((r) => ({ hour: Number(r.gio), created: Number(r.n), missingStamp: Number(r.thieu), laterThanHistory: Number(r.muon), preCancel: Number(r.huy) }));
  const minutes = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with don as (${base})
      select phut, count(*) as n,
             count(*) filter (where stage in ('CANCELLED','DELETED')) as huy,
             count(*) filter (where thieu_moc) as thieu,
             mode() within group (order by source) as nguon,
             percentile_cont(0.5) within group (order by extract(epoch from (ls_dau - ins)) / 60) filter (where ls_dau is not null) as ls_gap,
             percentile_cont(0.5) within group (order by extract(epoch from (erp_at - ins)) / 60) as erp_gap
        from don group by phut having count(*) >= 5
       order by count(*) desc, phut
       limit 15`),
  ).map((r) => ({
    minute: String(r.phut),
    created: Number(r.n),
    cancelled: Number(r.huy),
    missingStamp: Number(r.thieu),
    source: String(r.nguon ?? ""),
    medHistoryGapMin: r.ls_gap === null || r.ls_gap === undefined ? null : Number(r.ls_gap),
    medErpGapMin: r.erp_gap === null || r.erp_gap === undefined ? null : Number(r.erp_gap),
  }));
  const dinh = spikeHours(hours);
  const spikeDays = dinh.length
    ? rowsOf<Record<string, unknown>>(
        await db.execute(sql`
          with don as (${base})
          select gio, ngay, count(*) as n from don
           where gio in ${sql.raw(`(${dinh.join(",")})`)}
           group by gio, ngay`),
      ).map((r) => ({ hour: Number(r.gio), day: String(r.ngay), created: Number(r.n) }))
    : [];
  return { hours, minutes, spikeDays };
}

// ─────────────────────────── --xoa: "Đã xoá" khác "Đã huỷ" ở đâu ───────────────────────────

export type DeadProfile = {
  stage: "CANCELLED" | "DELETED";
  total: number;
  everConfirmed: number;
  withShipment: number;
  noItems: number;
  zeroValue: number;
  noPhone: number;
  /** Cùng SĐT (9 số cuối) có một đơn KHÁC còn sống, lên trong ±48 giờ. */
  samePhoneAlive: number;
  /** Trung vị giờ từ lúc lên đơn tới lúc chuyển sang trạng thái chết (lịch sử Pancake). */
  medHoursToDead: number | null;
  deadMeasured: number;
  bySource: { source: string; n: number }[];
};

/** Dòng tóm tắt cho `--xoa`. Hàm THUẦN. */
export function deletedAuditLines(days: number, rows: readonly DeadProfile[]): string[] {
  const out: string[] = [`ĐÃ XOÁ vs ĐÃ HUỶ — ${days} ngày theo ngày lên đơn · cột: tổng · từng xác nhận · có vận đơn · không dòng hàng · giá trị 0đ · không SĐT · cùng SĐT có đơn sống ±48h · trung vị lên đơn → chết`];
  for (const r of rows) {
    out.push(
      `  ${r.stage === "DELETED" ? "ĐÃ XOÁ" : "ĐÃ HUỶ"} · ${r.total} · ${r.everConfirmed} (${pct(r.everConfirmed, r.total)}) · ${r.withShipment} · ${r.noItems} (${pct(r.noItems, r.total)}) · ${r.zeroValue} (${pct(r.zeroValue, r.total)}) · ${r.noPhone} · ${r.samePhoneAlive} (${pct(r.samePhoneAlive, r.total)}) · ${gio(r.medHoursToDead)} (đo ${r.deadMeasured})`,
    );
    out.push(`    theo nguồn: ${r.bySource.map((x) => `${x.source || "—"} ${x.n}`).join(" · ") || "—"}`);
  }
  return out.slice(0, AUDIT_MAX_LINES).map((l) => l.slice(0, 300));
}

export async function deletedAudit(from: Date, to: Date): Promise<DeadProfile[]> {
  const db = await getDb();
  const o = schema.orders;
  const sdt = sql`right(regexp_replace(coalesce(nullif(${o.billPhone}, ''), ${o.shipPhone}), '[^0-9]', '', 'g'), 9)`;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with don as (
        select ${o.id} as id, ${o.stage}::text as stage, ${o.source} as source, ${o.insertedAt} as ins,
               coalesce(${o.totalPriceAfterDiscount}, ${o.totalPrice}, 0) as gia,
               ${sdt} as sdt,
               (${ORDER_EVER_CONFIRMED}) as da_xn,
               exists (select 1 from shipments s where s.order_id = ${o.id}) as co_vd,
               not exists (select 1 from order_items i where i.order_id = ${o.id}) as khong_hang,
               (${CANCELLED_AT}) as chet_at
          from ${o}
         where ${o.insertedAt} >= ${from} and ${o.insertedAt} <= ${to} and ${o.stage} in ('CANCELLED','DELETED'))
      select d.stage, count(*) as n,
             count(*) filter (where d.da_xn) as xn,
             count(*) filter (where d.co_vd) as vd,
             count(*) filter (where d.khong_hang) as kh,
             count(*) filter (where d.gia = 0) as g0,
             count(*) filter (where length(d.sdt) < 9) as ksdt,
             count(*) filter (where length(d.sdt) = 9 and exists (
               select 1 from orders x
                where x.id <> d.id and x.stage::text not in ('CANCELLED','DELETED')
                  and right(regexp_replace(coalesce(nullif(x.bill_phone, ''), x.ship_phone), '[^0-9]', '', 'g'), 9) = d.sdt
                  and x.inserted_at between d.ins - interval '48 hours' and d.ins + interval '48 hours')) as song,
             percentile_cont(0.5) within group (order by extract(epoch from (d.chet_at - d.ins)) / 3600) filter (where d.chet_at is not null and d.chet_at >= d.ins) as med,
             count(*) filter (where d.chet_at is not null and d.chet_at >= d.ins) as do_duoc
        from don d group by d.stage`),
  );
  const nguon = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select ${o.stage}::text as stage, ${o.source} as source, count(*) as n
        from ${o}
       where ${o.insertedAt} >= ${from} and ${o.insertedAt} <= ${to} and ${o.stage} in ('CANCELLED','DELETED')
       group by 1, 2 order by 3 desc`),
  );
  return (["DELETED", "CANCELLED"] as const).map((st) => {
    const r = rows.find((x) => x.stage === st) ?? {};
    return {
      stage: st,
      total: Number(r.n ?? 0),
      everConfirmed: Number(r.xn ?? 0),
      withShipment: Number(r.vd ?? 0),
      noItems: Number(r.kh ?? 0),
      zeroValue: Number(r.g0 ?? 0),
      noPhone: Number(r.ksdt ?? 0),
      samePhoneAlive: Number(r.song ?? 0),
      medHoursToDead: r.med === null || r.med === undefined ? null : Number(r.med),
      deadMeasured: Number(r.do_duoc ?? 0),
      bySource: nguon.filter((x) => x.stage === st).slice(0, 5).map((x) => ({ source: String(x.source ?? ""), n: Number(x.n) })),
    };
  });
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
  const mode = process.argv.slice(2).join(" ");
  if (/--gio\b/.test(mode)) {
    const h = await hourAudit(period.from as Date, period.to as Date);
    for (const line of hourAuditLines(days, h.hours, h.minutes, h.spikeDays)) tomTat(line);
    process.exit(0);
  }
  if (/--xoa\b/.test(mode)) {
    for (const line of deletedAuditLines(days, await deletedAudit(period.from as Date, period.to as Date))) tomTat(line);
    process.exit(0);
  }
  const [oldDef, f, src, hour, huy] = await Promise.all([
    oldDefinition(period.from as Date, period.to as Date),
    getConversionFunnel(period),
    getConversionByDimension(period, "source"),
    getConversionByDimension(period, "hour"),
    getCancelAnalysis(period, { fresh: true }),
  ]);
  const dim = (rows: typeof src.rows): DimLine[] =>
    rows.map((r) => ({ label: r.label, created: r.created, confirmed: r.confirmed, preCancel: r.cancelledBeforeConfirm, postCancel: r.cancelledAfterConfirm, medianHoursToPreCancel: r.medianHoursToPreConfirmCancel }));
  // Phân tích đơn huỷ chèn TRƯỚC phần theo giờ: phần theo giờ đứng cuối để nếu chạm trần 60 dòng
  // thì mất phần ít quan trọng nhất.
  const head = confirmAuditLines(days, oldDef, f, dim(src.rows), dim(hour.rows));
  const hourAt = head.findIndex((l) => l.startsWith("THEO GIỜ"));
  const lines = hourAt < 0 ? [...head, ...cancelAnalysisLines(huy)] : [...head.slice(0, hourAt), ...cancelAnalysisLines(huy), ...head.slice(hourAt)];
  for (const line of lines.slice(0, AUDIT_MAX_LINES)) tomTat(line.slice(0, 300));
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("confirm-funnel-audit lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

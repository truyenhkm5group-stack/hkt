import Link from "next/link";
import { CheckCircle2, CircleDot, MinusCircle, XCircle } from "lucide-react";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { formatDuration, pctOf, type RunProgress } from "@/lib/wholesale/run-progress";
import type { ActivityLogRow } from "@/lib/queries/wholesale-activity";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KHỐI «VIỆC ĐANG CHẠY» DÙNG CHUNG — Săn khách + Liên hệ ═══════════
 *
 * Ba mảnh, không có trạng thái (dựng được ở máy chủ): thẻ TIẾN ĐỘ (vòng % · đã xử lý / tổng · thanh · đã chạy · dự kiến xong),
 * ba ô KẾT QUẢ (thành công · thất bại · bỏ qua, kèm %), NHẬT KÝ gọn mới nhất trên cùng (liên hệ đã che ở máy chủ).
 */

function Ring({ pct }: { pct: number | null }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const v = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0" role="img" aria-label={pct == null ? "chưa có việc" : `${v}%`}>
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="7" className="stroke-muted" />
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="7" strokeLinecap="round" className="stroke-primary" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle" className="fill-foreground text-[13px] font-semibold">
        {pct == null ? "—" : `${Math.round(v)}%`}
      </text>
    </svg>
  );
}

/** Thẻ tiến độ lớn. `unit` = đơn vị đếm («ô», «tin», «thư»). */
export function ProgressCard({ title, p, unit, note, actions }: { title: React.ReactNode; p: RunProgress; unit: string; note?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
      <Ring pct={p.pct} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0 truncate font-semibold">{title}</div>
          <div className="text-sm tabular-nums">
            <b>{formatNumber(p.processed)}</b> / {formatNumber(p.total)} {unit}
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${p.pct ?? 0}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>Đã chạy: {formatDuration(p.elapsedMs)}</span>
          <span>Dự kiến xong: {p.etaMs == null ? "—" : p.etaMs === 0 ? "đã xong" : `còn ~${formatDuration(p.etaMs)}`}</span>
          {note ? <span>{note}</span> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-1.5">{actions}</div> : null}
    </div>
  );
}

const TILE = {
  OK: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  FAIL: "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
  SKIP: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
} as const;

export type ResultTile = { label: string; value: number; of: number; hint?: string };

/** Ba ô kết quả màu: Thành công · Thất bại · Bỏ qua. Phần trăm tính trên `of` của TỪNG ô (mẫu số 0 ⇒ «—»). */
export function ResultTiles({ ok, fail, skip }: { ok: ResultTile; fail: ResultTile; skip: ResultTile }) {
  const tiles: [keyof typeof TILE, ResultTile, typeof CheckCircle2][] = [
    ["OK", ok, CheckCircle2],
    ["FAIL", fail, XCircle],
    ["SKIP", skip, MinusCircle],
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {tiles.map(([tone, t, Icon]) => (
        <div key={tone} className={cn("rounded-lg border px-3 py-2", TILE[tone])}>
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {t.label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-xl font-bold tabular-nums">{formatNumber(t.value)}</span>
            <span className="text-xs tabular-nums opacity-80">{formatPercent(pctOf(t.value, t.of))}</span>
          </div>
          {t.hint ? <div className="truncate text-[11px] opacity-80" title={t.hint}>{t.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

const STATUS_ICON: Record<ActivityLogRow["status"], { Icon: typeof CheckCircle2; cls: string; label: string }> = {
  OK: { Icon: CheckCircle2, cls: "text-emerald-600", label: "Thành công" },
  FAIL: { Icon: XCircle, cls: "text-rose-600", label: "Thất bại" },
  SKIP: { Icon: MinusCircle, cls: "text-amber-600", label: "Bỏ qua" },
  INFO: { Icon: CircleDot, cls: "text-muted-foreground", label: "Ghi nhận" },
};

/** Nhật ký hoạt động gọn — mới nhất trên cùng. Liên hệ ĐÃ CHE ở máy chủ (`maskContact`). */
export function ActivityLog({ rows, empty }: { rows: ActivityLogRow[]; empty: string }) {
  if (!rows.length) return <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 pr-2 font-medium">Giờ</th>
            <th className="py-1.5 pr-2 font-medium">Kênh / việc</th>
            <th className="py-1.5 pr-2 font-medium">Đối tượng</th>
            <th className="py-1.5 pr-2 font-medium">Nội dung</th>
            <th className="py-1.5 font-medium">Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = STATUS_ICON[r.status];
            return (
              <tr key={r.id} className="border-b align-top last:border-0">
                <td className="whitespace-nowrap py-1.5 pr-2 text-xs tabular-nums text-muted-foreground">{formatDateTime(r.at)}</td>
                <td className="py-1.5 pr-2 text-xs">
                  <div>{r.kind}</div>
                  <div className="text-[11px] text-muted-foreground">{r.actor}</div>
                </td>
                <td className="py-1.5 pr-2 text-xs">
                  <Link href={`/wholesale/leads/${r.leadId}`} className="block max-w-[180px] truncate font-medium hover:underline">
                    {r.lead}
                  </Link>
                  <div className="font-mono text-[11px] text-muted-foreground" translate="no">
                    {r.contact}
                  </div>
                </td>
                <td className="max-w-[320px] py-1.5 pr-2 text-xs text-muted-foreground">{r.text || "—"}</td>
                <td className="py-1.5 text-xs">
                  <span className={cn("inline-flex items-center gap-1", s.cls)}>
                    <s.Icon className="h-3.5 w-3.5" aria-hidden />
                    {s.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

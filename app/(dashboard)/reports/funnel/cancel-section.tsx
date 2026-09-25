import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CANCEL_MATCHES, CANCEL_MATCH_LABEL, POST_CONFIRM_STAGES, POST_CONFIRM_STAGE_LABEL, type CancelMatch } from "@/lib/constants/cancel-analysis";
import { formatNumber } from "@/lib/format";
import { getCancelAnalysis, type CancelSide } from "@/lib/queries/cancel-analysis";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

function hoursText(h: number | null) {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} phút`;
  if (h < 48) return `${h.toFixed(1)} giờ`;
  return `${(h / 24).toFixed(1)} ngày`;
}

const LOST: readonly CancelMatch[] = ["SAME_CUSTOMER_OTHER", "LOST"];

function SideTable({ title, side, windowHours, ageFrom }: { title: string; side: CancelSide; windowHours: number; ageFrom: string }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 px-5 pt-3 text-sm">
        <span className="font-semibold">{title}:</span>
        <span className="font-bold tabular-nums">{formatNumber(side.total)} đơn</span>
        {side.deleted ? <span className="text-xs text-muted-foreground">(trong đó {formatNumber(side.deleted)} đơn bị xoá)</span> : null}
        <span className="text-xs">
          · mất thật <b className="tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(side.lost)}</b> · đã có đơn thay <b className="tabular-nums">{formatNumber(side.replaced)}</b>
        </span>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[420px]">
          <TableHeader>
            <TableRow>
              <TableHead>Đơn huỷ này là</TableHead>
              <TableHead className="text-right">Cửa sổ {windowHours} giờ</TableHead>
              <TableHead className="text-right">Nới 7 ngày</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CANCEL_MATCHES.map((k) => (
              <TableRow key={k} className={cn(LOST.includes(k) && "bg-rose-50/40 dark:bg-rose-950/10")}>
                <TableCell className="text-xs">{CANCEL_MATCH_LABEL[k]}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(side.byMatch[k])}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(side.byMatchWide[k])}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3 pt-2 text-xs">
        <span className="text-muted-foreground">
          Huỷ sau bao lâu {ageFrom} — trung vị {hoursText(side.medianAgeHours)} ({formatNumber(side.ageMeasured)}/{formatNumber(side.total)} đo được):
        </span>
        {side.ageBuckets.map((b) => (
          <span key={b.key} className="rounded-md border px-2 py-0.5">
            {b.label}: <b className="tabular-nums">{formatNumber(b.count)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * ═══════════ ĐƠN HUỶ: MẤT THẬT HAY CHỈ LÀ ĐƠN ĐƯỢC LÊN LẠI ═══════════
 *
 * Chủ shop hỏi 25/09/2026: số đơn huỷ đã lọc trùng với đơn đã xác nhận gần đó chưa, và đơn huỷ SAU xác
 * nhận ra sao. Luật trùng dùng lại đúng hàng đợi đơn trùng (cùng SĐT, cửa sổ trong `settings`, so tập
 * mặt hàng) — xem `lib/constants/cancel-analysis.ts`. Chỉ đọc.
 */
export async function CancelAnalysisSection({ period }: { period: Period }) {
  const a = await getCancelAnalysis(period);
  const p = a.post;
  return (
    <SectionCard
      title="Đơn huỷ: mất thật hay đã có đơn thay"
      description={`Trước xác nhận ${formatNumber(a.pre.total)} · sau xác nhận ${formatNumber(p.total)} — mất thật ${formatNumber(a.pre.lost + p.lost)} đơn`}
      hint={`Mỗi đơn huỷ được so với các đơn KHÁC cùng SĐT (9 số cuối) đã từng được xác nhận, lên đơn cách nhau không quá ${a.windowHours} giờ — cùng luật với hàng đợi đơn trùng. Cùng mẫu mã ⇒ đơn được lên lại; mẫu mã chồng lấn ⇒ có thể lên lại; khác mẫu mã ⇒ theo luật của shop là hai đơn hợp lệ nên món trong đơn huỷ vẫn là bị mất. Cột "nới 7 ngày" chỉ để xem độ nhạy, không phải định nghĩa. Không đủ SĐT thì CHƯA BIẾT, không tính là mất.`}
      padded={false}
    >
      <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <SideTable title="Huỷ khi chưa từng xác nhận" side={a.pre} windowHours={a.windowHours} ageFrom="kể từ lúc lên đơn" />
        <div className="min-w-0">
          <SideTable title="Huỷ sau khi đã xác nhận" side={p} windowHours={a.windowHours} ageFrom="kể từ lúc xác nhận" />
          <div className="flex flex-wrap items-center gap-1.5 border-t px-5 py-2.5 text-xs">
            <span className="text-muted-foreground">Huỷ ở khâu:</span>
            {POST_CONFIRM_STAGES.map((k) => (
              <span key={k} className={cn("rounded-md border px-2 py-0.5", k === "AFTER_HANDOFF" && p.byStage[k] > 0 && "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300")}>
                {POST_CONFIRM_STAGE_LABEL[k]}: <b className="tabular-nums">{formatNumber(p.byStage[k])}</b>
              </span>
            ))}
            <span className="rounded-md border px-2 py-0.5">
              Từng chờ hàng: <b className="tabular-nums">{formatNumber(p.waitedStock)}</b>
              <InfoHint className="ml-1 align-middle">Đơn có trong sổ đơn chờ hàng của ERP hoặc từng ở trạng thái Pancake &ldquo;Chờ hàng&rdquo;. Sổ ERP chỉ có từ 25/09/2026.</InfoHint>
            </span>
          </div>
        </div>
      </div>
      {a.bySource.length ? (
        <div className="overflow-x-auto border-t">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>Nguồn đơn</TableHead>
                <TableHead className="text-right">Huỷ trước XN</TableHead>
                <TableHead className="text-right">· mất thật</TableHead>
                <TableHead className="text-right">Huỷ sau XN</TableHead>
                <TableHead className="text-right">· mất thật</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.bySource.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.pre)}</TableCell>
                  <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.preLost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.post)}</TableCell>
                  <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.postLost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="border-t px-5 py-3 text-sm text-muted-foreground">Không có đơn huỷ nào trong kỳ.</p>
      )}
    </SectionCard>
  );
}

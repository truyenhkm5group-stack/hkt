import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { COGS_QUALITY_LABEL, COGS_QUALITY_NOTE, getCogsCoverage } from "@/lib/queries/cogs-quality";
import { COVERAGE_ACTION_LABEL, getProfitCoverage } from "@/lib/queries/profit-coverage";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ───────────── ĐỘ TIN CẬY CỦA LỢI NHUẬN, NÓI RA TỪNG PHẦN ─────────────
 *
 * Chủ shop chốt: KHÔNG tạo một "điểm tin cậy" bí ẩn. Gộp năm thứ khác nhau thành 78% thì không ai
 * biết thiếu ở đâu và phải làm gì để nó lên.
 *
 * Nên mỗi thành phần đứng riêng, và mỗi thiếu sót dẫn tới ĐÚNG MỘT chỗ làm việc — trừ quy kết quảng
 * cáo, nơi ERP phải nói thẳng là **không sửa được bằng thao tác**. Bắt nhân viên đi sửa thứ nguồn
 * không cung cấp là cách nhanh nhất để họ bỏ qua toàn bộ bảng này.
 */
export async function ProfitCoverageSection({ period }: { period: Period }) {
  const [cov, cogs] = await Promise.all([getProfitCoverage(period), getCogsCoverage(period)]);

  return (
    <SectionCard
      title="Lợi nhuận này dựa trên dữ liệu đầy đủ tới đâu"
      description="Năm thành phần đo riêng, không gộp thành một điểm."
      hint="Phần trăm thấp KHÔNG có nghĩa là số sai — nó có nghĩa là phần đó chưa kiểm chứng được. Chưa biết khác không, và không bao giờ được làm tròn thành 0."
      padded={false}
    >
      <div className="divide-y">
        {cov.components.map((c) => (
          <div key={c.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-[190px] flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className={cn("size-4 shrink-0", c.pct === null ? "text-muted-foreground" : c.pct >= 0.8 ? "text-emerald-600" : c.pct >= 0.5 ? "text-amber-600" : "text-rose-600")} />
                {c.label}
              </div>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{c.hauQua}</p>
            </div>

            <div className="w-[150px] shrink-0">
              {/* CHƯA ĐO ĐƯỢC khác hẳn 0%. Sổ ngân hàng trống thì độ phủ là chưa biết. */}
              {c.pct === null ? (
                <span className="text-sm text-muted-foreground">chưa đo được</span>
              ) : (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className="numeric text-lg font-semibold">{formatPercent(c.pct * 100)}</span>
                    <span className="text-[11.5px] text-muted-foreground">
                      {c.unit === "đồng giá vốn" ? formatVND(c.covered) : formatNumber(c.covered)} / {c.unit === "đồng giá vốn" ? formatVND(c.total) : formatNumber(c.total)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className={cn("h-full rounded-full", c.pct >= 0.8 ? "bg-emerald-500" : c.pct >= 0.5 ? "bg-amber-500" : "bg-rose-500")} style={{ width: `${Math.round(c.pct * 100)}%` }} />
                  </div>
                </>
              )}
            </div>

            <div className="w-[210px] shrink-0 text-[12px]">
              {c.href ? (
                <Link href={c.href} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                  {COVERAGE_ACTION_LABEL[c.action]} <ArrowRight className="size-3.5" />
                </Link>
              ) : (
                <span className="text-muted-foreground">{COVERAGE_ACTION_LABEL[c.action]}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── BA HẠNG GIÁ VỐN: phần nào của lợi nhuận dựa trên chứng từ, phần nào là suy ngược ── */}
      <div className="border-t bg-muted/30 px-4 py-3">
        <div className="text-sm font-medium">Giá vốn của {formatNumber(cogs.deliveredOrders)} đơn đã giao đến từ đâu</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {cogs.rows.map((r) => (
            <div key={r.quality} className="rounded-lg border bg-card p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-medium">{COGS_QUALITY_LABEL[r.quality]}</span>
                <span className="numeric text-sm font-semibold">{formatPercent(r.share * 100)}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                {formatNumber(r.orders)} đơn · {formatVND(r.amount)}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{COGS_QUALITY_NOTE[r.quality]}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-muted-foreground">
          <b className="text-foreground">Cách sửa:</b> {cogs.huongSua}
          {cogs.notRecognized ? ` · ${formatNumber(cogs.notRecognized)} đơn đã giao chưa chốt được giá vốn — chạy lại job “Dựng lại kết quả đơn đã tính sẵn”.` : ""}
        </p>
      </div>
    </SectionCard>
  );
}

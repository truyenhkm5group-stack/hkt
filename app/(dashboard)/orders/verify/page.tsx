import Link from "next/link";
import { AlertTriangle, CheckCircle2, HelpCircle, ShieldAlert } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { CONFIDENCE_LABEL } from "@/lib/constants/recommendation";
import { MAX_UNMEASURABLE_FOR_HIGH, RISK_BAND_LABEL, RISK_BAND_TONE, RISK_SIGNAL_LABEL, RISK_SIGNALS, RISK_THRESHOLDS } from "@/lib/constants/preship-risk";
import { formatNumber } from "@/lib/format";
import { listPreshipRisk, summarizePreshipRisk } from "@/lib/queries/preship-risk";
import { cn } from "@/lib/utils";

export const metadata = { title: "Đơn cần xác minh trước khi giao" };

/**
 * ═══════════ ĐƠN CẦN XÁC MINH TRƯỚC KHI GIAO ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` §5.
 *
 * Danh sách đơn CHƯA rời kho, xếp theo điểm rủi ro hoàn — kèm LÝ DO của từng điểm và việc cần làm.
 *
 * Ba điều trang này cố ý KHÔNG làm:
 *  · không có nút huỷ đơn — điểm cao chỉ là lý do gọi xác nhận, không phải phán quyết;
 *  · không hiện điểm như một xác suất;
 *  · không im lặng khi thiếu dữ liệu — số tín hiệu chưa tra được hiện thành một cột riêng.
 */
export default async function VerifyOrdersPage() {
  await requirePermission("orders:read");
  const rows = await listPreshipRisk({ limit: 300 });
  const tk = summarizePreshipRisk(rows);
  const canSoat = rows.filter((r) => r.risk.band !== "LOW");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng"
        title="Đơn cần xác minh trước khi giao"
        description="Đơn còn trong kho, xếp theo khả năng bị hoàn. Mỗi dòng nói rõ vì sao."
        hint={
          `Điểm 0–100 là MỨC RỦI RO TƯƠNG ĐỐI để xếp thứ tự việc, KHÔNG phải xác suất hoàn. ` +
          `Chỉ đơn CHƯA rời kho được chấm — chấm một đơn đã đi rồi thì không còn hành động nào thay đổi được kết quả. ` +
          `Giá trị đơn và COD CỐ Ý không vào điểm: tiền là độ lớn thiệt hại, không phải xác suất xảy ra, nên nó hiện ở cột riêng. ` +
          `Đơn thiếu quá ${MAX_UNMEASURABLE_FOR_HIGH} tín hiệu bị HẠ mức khỏi "cao" — thiếu dữ liệu không phải bằng chứng xấu. ` +
          `Trang này KHÔNG bao giờ tự huỷ đơn.`
        }
        actions={
          <Link href="/orders" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            ← Về danh sách đơn
          </Link>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Đơn còn trong kho" value={formatNumber(tk.total)} note="Chưa bàn giao ĐVVC — còn xác minh được" icon={CheckCircle2} tone="slate" />
        <MetricCard
          label="Rủi ro cao"
          value={formatNumber(tk.high)}
          note={`Từ ${RISK_THRESHOLDS.high} điểm — nên xin cọc hoặc gọi xác nhận`}
          icon={ShieldAlert}
          tone={tk.high ? "rose" : "slate"}
        />
        <MetricCard
          label="Rủi ro trung bình"
          value={formatNumber(tk.medium)}
          note={`Từ ${RISK_THRESHOLDS.medium} điểm — nhắn xác nhận địa chỉ`}
          icon={AlertTriangle}
          tone={tk.medium ? "amber" : "slate"}
        />
        <MetricCard
          label="Bị hạ mức vì thiếu dữ liệu"
          value={formatNumber(tk.capped)}
          note="Điểm đủ cao nhưng thiếu quá nhiều tín hiệu — KHÔNG kết luận 'cao'"
          icon={HelpCircle}
          tone={tk.capped ? "amber" : "slate"}
        />
      </section>

      <SectionCard
        title={`${formatNumber(canSoat.length)} đơn nên soát trước khi gửi`}
        description="Xếp theo điểm giảm dần. Bấm mã đơn để mở chi tiết."
        hint="Cột 'Vì sao' là ba lý do nặng nhất, kèm số liệu thật của chính đơn đó — không phải mô tả chung. Cột 'Chưa tra được' cho biết điểm này dựng trên bao nhiêu phần dữ liệu: thiếu nhiều thì đọc điểm nhẹ tay hơn."
        padded={false}
      >
        {canSoat.length === 0 ? (
          <EmptyState
            title="Không đơn nào cần soát"
            description={
              tk.total === 0
                ? "Hiện không có đơn nào đang chờ bàn giao ĐVVC."
                : `Cả ${formatNumber(tk.total)} đơn đang chờ gửi đều ở mức rủi ro thấp. Gửi bình thường.`
            }
            icon={CheckCircle2}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Đơn</TableHead>
                  <TableHead>Khách</TableHead>
                  <TableHead className="text-right">Điểm</TableHead>
                  <TableHead>Mức</TableHead>
                  <TableHead>Vì sao</TableHead>
                  <TableHead className="text-right">Thiệt hại nếu hoàn</TableHead>
                  <TableHead className="text-right">Chưa tra được</TableHead>
                  <TableHead>Việc cần làm</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {canSoat.map((r) => (
                  <TableRow key={r.orderId}>
                    <TableCell className="font-medium">
                      <Link href={`/orders/${r.orderId}`} className="underline-offset-4 hover:underline">
                        #{r.systemId ?? r.orderId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{r.customerName || "—"}</div>
                      <div className="text-xs text-muted-foreground">{r.phone || "chưa có SĐT"}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{r.risk.score}</TableCell>
                    <TableCell>
                      <Badge className={cn("font-normal", RISK_BAND_TONE[r.risk.band])}>{RISK_BAND_LABEL[r.risk.band]}</Badge>
                      {r.risk.bandCapped ? <div className="mt-1 text-xs text-muted-foreground">đã hạ mức vì thiếu dữ liệu</div> : null}
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <ul className="space-y-0.5 text-xs">
                        {r.risk.topReasons.map((x) => (
                          <li key={x.key}>
                            <span className="font-medium">{x.label}</span> <span className="text-muted-foreground">· {x.evidence}</span>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    {/* Tiền hiện ở cột RIÊNG, không vào điểm — xem hợp đồng §5.1. */}
                    <TableCell className="text-right">{r.risk.expectedLossVnd === null ? <span title="Chưa biết giá trị đơn">—</span> : <Money value={r.risk.expectedLossVnd} />}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground" title={r.risk.unmeasurable.map((k) => RISK_SIGNAL_LABEL[k]).join(", ")}>
                      {r.risk.unmeasurable.length}/{RISK_SIGNALS.length} · {CONFIDENCE_LABEL[r.risk.confidence]}
                    </TableCell>
                    <TableCell className="max-w-[260px] text-xs text-muted-foreground">{r.risk.recommendedAction}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="border-t px-5 py-2 text-xs text-muted-foreground">
          Trọng số của từng tín hiệu là <strong>giả thiết do người đặt ra</strong>, chưa phải kết quả học máy. Xem mục
          &ldquo;Kiểm định điểm rủi ro&rdquo; ở trang Phễu bán hàng để biết điểm này có thật sự tách được nhóm hoàn khỏi nhóm giao thành công trên dữ
          liệu của shop hay chưa — nếu chưa, đừng dùng nó để biện minh cho quyết định nào tốn tiền.
        </p>
      </SectionCard>
    </div>
  );
}

import { AlertTriangle, ArrowRight, Banknote, FileWarning, Landmark, ReceiptText } from "lucide-react";
import Link from "next/link";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import {
  codBatchGaps,
  codReconciliation,
  staleCodOnReturned,
  unprovenCollectedShipments,
} from "@/lib/queries/cod-reconciliation";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

/** Một bậc trong dòng tiền, kèm mức độ bằng chứng để không đọc nhầm khai báo thành tiền thật. */
function Step({
  label,
  amount,
  count,
  evidence,
  tone,
  icon: Icon,
  href,
}: {
  label: string;
  amount: number;
  count?: string;
  evidence: string;
  tone: "muted" | "info" | "good" | "warn";
  icon: typeof Banknote;
  href?: string;
}) {
  const tones = {
    muted: "border-border",
    info: "border-sky-300 dark:border-sky-800",
    good: "border-emerald-400 dark:border-emerald-800",
    warn: "border-amber-400 dark:border-amber-800",
  };
  const body = (
    <div className={cn("h-full rounded-xl border-2 p-4 transition", tones[tone], href && "hover:bg-accent/40")}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <Icon className="size-[18px] shrink-0 text-muted-foreground" />
      </div>
      <p className="numeric mt-2 text-xl font-bold tracking-tight">{formatVND(amount)}</p>
      {count ? <p className="mt-0.5 text-xs text-muted-foreground">{count}</p> : null}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{evidence}</p>
      {href ? <p className="mt-1 text-[11px] font-medium text-primary">Xem chi tiết →</p> : null}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export async function CodReconciliation({ period, drill, page }: { period: Period; drill: string | null; page: number }) {
  const [recon, gaps] = await Promise.all([codReconciliation(period), codBatchGaps(period)]);
  const href = (key: string) => `/cod?recon=${key}&period=${period.key}`;
  const close = `/cod?period=${period.key}`;

  const [unproven, stale] = await Promise.all([
    drill === "unproven" ? unprovenCollectedShipments(page, PAGE_SIZE, "") : Promise.resolve(null),
    drill === "stale" ? staleCodOnReturned(page, PAGE_SIZE) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Đối soát tiền COD: từ khai báo đến tài khoản"
        description="Mỗi bậc là một mức độ bằng chứng khác nhau. Khoảng cách giữa các bậc chính là chỗ tiền đang treo."
      >
        <div className="grid gap-3 lg:grid-cols-4">
          <Step
            label="1 · Phải thu"
            amount={recon.receivable.amount}
            count={`${formatNumber(recon.receivable.count)} vận đơn còn thu được`}
            evidence="COD ghi trên vận đơn. Đây là con số KHAI BÁO, chưa phải tiền."
            tone="muted"
            icon={ReceiptText}
          />
          <Step
            label="2 · Viettel Post báo đã thu"
            amount={recon.collected.amount}
            count={`${formatNumber(recon.collected.count)} vận đơn`}
            evidence="ĐVVC nói đã thu của khách. Shop CHƯA có chứng từ tiền cho phần này."
            tone="info"
            icon={Banknote}
          />
          <Step
            label="3 · Có trên bảng kê"
            amount={recon.onStatement.amount}
            count={`${formatNumber(recon.onStatement.count)} vận đơn ghép được`}
            evidence="Đã ghép vào một đợt tiền về — truy ngược được tới chứng từ."
            tone={recon.onStatement.amount > 0 ? "good" : "warn"}
            icon={FileWarning}
          />
          <Step
            label="4 · Tiền về tài khoản"
            amount={recon.bank.net}
            count={`${formatNumber(recon.bank.batches)} đợt · phí ${formatVND(recon.bank.fee)}`}
            evidence="Tiền thực nhận theo bảng kê, sau khi Viettel Post trừ cước."
            tone="good"
            icon={Landmark}
          />
        </div>

        {/* ── Các khoảng trống ── */}
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <Link href={href("unproven")} className={cn("rounded-xl border p-4 transition hover:border-primary hover:bg-accent/40", drill === "unproven" && "border-primary bg-accent/40")}>
            <p className="text-[13px] font-medium text-muted-foreground">Đã thu nhưng CHƯA có chứng từ</p>
            <p className="numeric mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400">{formatVND(recon.unproven.amount)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatNumber(recon.unproven.count)} vận đơn · bậc 2 trừ bậc 3. Cần nhập bảng kê chi tiết để đối soát.
            </p>
          </Link>
          <Link href={href("pending")} className={cn("rounded-xl border p-4 transition hover:border-primary hover:bg-accent/40", drill === "pending" && "border-primary bg-accent/40")}>
            <p className="text-[13px] font-medium text-muted-foreground">Chưa thu được</p>
            <p className="numeric mt-1 text-2xl font-bold">{formatVND(recon.pending.amount)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{formatNumber(recon.pending.count)} vận đơn còn thu được nhưng ĐVVC chưa xác nhận thu.</p>
          </Link>
          <Link href={href("stale")} className={cn("rounded-xl border p-4 transition hover:border-primary hover:bg-accent/40", drill === "stale" && "border-primary bg-accent/40")}>
            <p className="text-[13px] font-medium text-muted-foreground">Trạng thái COD mâu thuẫn</p>
            <p className="numeric mt-1 text-2xl font-bold text-destructive">{formatNumber(recon.stale.count)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Vận đơn đã hoàn/huỷ nhưng COD vẫn treo như còn thu được ({formatVND(recon.stale.amount)}).
            </p>
          </Link>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {recon.provenRate === null ? (
            <span>Chưa thu được đồng nào trong kỳ — chưa tính được tỷ lệ có chứng từ.</span>
          ) : (
            <>
              Mới <span className={cn("font-semibold", recon.provenRate >= 80 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>{recon.provenRate}%</span> số tiền
              ĐVVC báo đã thu là truy ngược được tới bảng kê. Phần còn lại chỉ có lời của ĐVVC.
            </>
          )}
          {recon.bank.unlinkedAmount > 0 ? (
            <>
              {" "}Ngược lại, <span className="font-semibold text-amber-600 dark:text-amber-400">{formatVND(recon.bank.unlinkedAmount)}</span> trên bảng kê chưa ghép được về vận đơn nào.
            </>
          ) : null}
        </p>
      </SectionCard>

      {/* ── Chênh lệch theo từng đợt tiền về ── */}
      {gaps.length ? (
        <SectionCard title="Chênh lệch theo từng đợt tiền về" description="So COD trên bảng kê với tổng COD của các vận đơn đã ghép vào đợt đó.">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Đợt</TableHead>
                  <TableHead>Ngày về</TableHead>
                  <TableHead className="text-right">COD bảng kê</TableHead>
                  <TableHead className="text-right">Phí ĐVVC</TableHead>
                  <TableHead className="text-right">Thực nhận</TableHead>
                  <TableHead className="text-right">Vận đơn ghép</TableHead>
                  <TableHead className="text-right">Chênh lệch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gaps.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="numeric font-medium">
                      <Link className="text-primary underline underline-offset-2" href={`/cod?batch=${g.id}`}>{g.reference}</Link>
                      <Badge variant="secondary" className="ml-2">{g.source === "VTP_STATEMENT" ? "Bảng kê" : "Thủ công"}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(g.receivedAt)}</TableCell>
                    <TableCell className="numeric text-right">{formatVND(g.gross)}</TableCell>
                    <TableCell className="numeric text-right text-muted-foreground">{formatVND(g.fee)}</TableCell>
                    <TableCell className="numeric text-right font-medium">{formatVND(g.net)}</TableCell>
                    <TableCell className="numeric text-right">
                      {g.linkedShipments ? (
                        <>
                          {formatNumber(g.linkedShipments)}
                          <span className="block text-[10.5px] text-muted-foreground">{formatVND(g.linkedAmount)}</span>
                        </>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400">chưa ghép</span>
                      )}
                    </TableCell>
                    <TableCell className={cn("numeric text-right font-semibold", g.gap !== 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
                      {g.linkedShipments ? formatVND(g.gap, { sign: true }) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Đợt &quot;chưa ghép&quot; nghĩa là tiền đã về tài khoản nhưng ERP không biết tiền đó thuộc vận đơn nào. Nhập bảng kê
            kèm <strong>chi tiết vận đơn</strong> (không chỉ dòng tổng) ở nút &quot;Nhập bảng kê&quot; phía trên để ghép tự động theo mã vận đơn.
          </p>
        </SectionCard>
      ) : null}

      {/* ── Drill-down ── */}
      {drill && (unproven || stale) ? (
        <SectionCard
          title={drill === "unproven" ? "Vận đơn đã thu nhưng chưa có chứng từ" : "Vận đơn đã hoàn/huỷ nhưng COD còn treo"}
          description={
            drill === "unproven"
              ? "Viettel Post báo đã thu tiền của khách, nhưng chưa ghép được vào bảng kê nào. Đây là phần cần đối soát trước khi coi là tiền thật."
              : "Vận đơn đã hoàn hoặc huỷ thì không còn tiền để thu. Trạng thái COD còn treo làm sai số 'phải thu'."
          }
          actions={<Button asChild variant="outline" size="sm"><Link href={close}>Đóng danh sách</Link></Button>}
        >
          {(() => {
            const data = unproven ?? stale!;
            if (!data.total) return <EmptyState title="Không có vận đơn nào" description="Nhóm này hiện đang sạch." />;
            return (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {formatNumber(data.total)} vận đơn · đang xem {formatNumber(data.rows.length)} dòng (trang {page})
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Mã vận đơn</TableHead>
                        <TableHead>Đơn</TableHead>
                        <TableHead>Trạng thái</TableHead>
                        <TableHead>Người nhận</TableHead>
                        <TableHead className="text-right">COD khai báo</TableHead>
                        <TableHead className="text-right">Đã thu</TableHead>
                        <TableHead>Ngày giao</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.rows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="numeric font-medium">
                            <Link className="text-primary underline underline-offset-2" href={`/shipments/${r.id}`}>{r.vtpOrderNumber ?? r.id}</Link>
                          </TableCell>
                          <TableCell className="numeric">
                            {r.orderId ? <Link className="text-primary underline underline-offset-2" href={`/orders/${r.orderId}`}>#{r.orderId}</Link> : <span className="text-muted-foreground">chưa ghép đơn</span>}
                          </TableCell>
                          <TableCell><Badge variant="secondary">{r.stage} · {r.codStatus}</Badge></TableCell>
                          <TableCell className="max-w-[180px] truncate">{r.receiverName || <span className="text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="numeric text-right">{formatVND(r.codAmount ?? 0)}</TableCell>
                          <TableCell className="numeric text-right">{r.codCollected ? formatVND(r.codCollected) : <span className="text-muted-foreground">Chưa có số</span>}</TableCell>
                          <TableCell className="text-muted-foreground">{r.deliveredAt ? formatDate(r.deliveredAt) : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {data.total > PAGE_SIZE ? (
                  <div className="flex items-center justify-between gap-2">
                    <Button asChild variant="outline" size="sm" disabled={page <= 1}>
                      <Link href={`/cod?recon=${drill}&period=${period.key}&rpage=${Math.max(1, page - 1)}`}>Trang trước</Link>
                    </Button>
                    <span className="text-xs text-muted-foreground">Trang {page} / {Math.ceil(data.total / PAGE_SIZE)}</span>
                    <Button asChild variant="outline" size="sm" disabled={page >= Math.ceil(data.total / PAGE_SIZE)}>
                      <Link href={`/cod?recon=${drill}&period=${period.key}&rpage=${page + 1}`}>Trang sau</Link>
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })()}
        </SectionCard>
      ) : null}

      {drill === "pending" ? (
        <SectionCard
          title="Vận đơn chưa thu được tiền"
          description="Còn khả năng thu nhưng Viettel Post chưa xác nhận đã thu."
          actions={<Button asChild variant="outline" size="sm"><Link href={close}>Đóng</Link></Button>}
        >
          <p className="text-sm text-muted-foreground">
            Dùng tab <Link className="text-primary underline underline-offset-2" href="/cod?cod=pending">Chưa thu</Link> ở bảng bên dưới để xem và lọc đầy đủ danh sách này.
          </p>
        </SectionCard>
      ) : null}
    </div>
  );
}

export { ArrowRight, AlertTriangle };

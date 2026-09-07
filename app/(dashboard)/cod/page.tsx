import Link from "next/link";
import { AlertTriangle, Banknote, CircleDollarSign, Clock, Download, Landmark, Receipt, Undo2 } from "lucide-react";
import { SettlementTabs } from "@/app/(dashboard)/cod/settlement-tabs";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { SETTLEMENT_HINT, SETTLEMENT_LABEL, SETTLEMENT_TONE, type SettlementStatus } from "@/lib/constants/cod";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import {
  codSettlementCounts,
  codSettlementSummary,
  listCodSettlement,
  listStatementPayments,
  statementGapDays,
} from "@/lib/queries/cod-settlement";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Đối soát COD" };

const TINH_TRANG_HOP_LE = new Set<string>(["QUA_HAN", "CHUA_TRA", "TRA_THIEU", "DA_TRA_DU", "CHUA_GIAO", "GIAO_NHUNG_HOAN", "KHONG_PHAI_TRA", "ALL"]);

export default async function CodPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("cod:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "deliveredAt", sortable: [], defaultPeriod: "all" });
  const tt = param(raw, "tt");
  const tinhTrang = TINH_TRANG_HOP_LE.has(tt) ? tt : "QUA_HAN";

  const [tong, dem, danhSach, bangKe, thieu] = await Promise.all([
    codSettlementSummary(params.period),
    codSettlementCounts(params.period),
    listCodSettlement({ period: params.period, status: tinhTrang as SettlementStatus | "ALL", q: params.q, page: params.page, pageSize: params.pageSize }),
    listStatementPayments(40),
    statementGapDays(),
  ]);

  const exportQuery = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])),
  ).toString();
  const tyLeTra = tong.phaiThu.amount > 0 ? Math.round((tong.daTra.amount / tong.phaiThu.amount) * 1000) / 10 : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Đối soát COD"
        description={`${formatVND(tong.conThieu, { compact: true })} Viettel Post chưa trả · ${formatNumber(tong.quaHan.count)} đơn quá hạn`}
        hint={
          <>
            So từng <b>đơn đã phát thành công</b> với các dòng bảng kê Viettel Post gửi qua email:
            đơn nào đã được trả tiền, trả ngày nào, trả đủ hay thiếu, cước bị trừ bao nhiêu, đơn nào
            quá {tong.overdueDays} ngày vẫn chưa thấy đồng nào. Tiền chỉ tính theo dòng bảng kê thật;
            không suy từ trạng thái giao hàng hay từ tiền thu hộ khai báo.
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/cod?${exportQuery}`}>
                <Download className="size-4" /> Xuất CSV
              </a>
            </Button>
            <SyncButton job="vtp-tracking" label="Cập nhật từ Viettel Post" />
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Viettel Post phải trả"
          value={formatVND(tong.phaiThu.amount, { compact: true })}
          note={`${formatNumber(tong.phaiThu.count)} đơn giao thành công${tong.uocTinh.count ? ` · ${formatVND(tong.uocTinh.amount, { compact: true })} còn tạm tính` : ""}`}
          hint={
            <>
              Chỉ gồm đơn <b>giao thành công theo kết quả đơn</b> — đã trừ đơn hoàn, đơn huỷ và cả
              đơn Viettel Post báo &ldquo;giao thành công&rdquo; nhưng khách chỉ trả tiền ship.
              Đơn đã có bảng kê thì lấy đúng số trên bảng kê (Viettel Post chỉ nợ phần thực thu của
              khách); đơn chưa có bảng kê thì <b>tạm tính</b> theo tiền thu hộ khai báo
              {tong.uocTinh.count ? ` — hiện ${formatNumber(tong.uocTinh.count)} đơn, ${formatVND(tong.uocTinh.amount)}` : ""}.
            </>
          }
          icon={CircleDollarSign}
          tone="slate"
        />
        <MetricCard
          label="Đã trả theo bảng kê"
          value={formatVND(tong.daTra.amount, { compact: true })}
          note={`${formatNumber(tong.daTra.count)} đơn · ${tyLeTra === null ? "—" : `${tyLeTra}%`} số phải trả${tong.soNgayTraTB === null ? "" : ` · thường trả sau ${tong.soNgayTraTB} ngày`}`}
          hint="Cộng số tiền COD ghi cho từng vận đơn trên các bảng kê đã nhận. Đây là tiền có chứng từ, không phải suy đoán."
          icon={Banknote}
          tone="green"
        />
        <MetricCard
          label="Chưa trả"
          value={formatVND(tong.conThieu, { compact: true })}
          note={`${formatNumber((dem.CHUA_TRA ?? 0) + (dem.QUA_HAN ?? 0))} đơn chưa thấy trên bảng kê nào`}
          hint="Phải trả trừ đi đã trả. Gồm cả đơn còn trong hạn lẫn đơn đã quá hạn."
          icon={Clock}
          tone={tong.conThieu ? "amber" : "slate"}
        />
        <MetricCard
          label={`Quá hạn > ${tong.overdueDays} ngày`}
          value={formatVND(tong.quaHan.amount, { compact: true })}
          note={`${formatNumber(tong.quaHan.count)} đơn đã phát thành công mà chưa có đồng nào`}
          hint={`Đơn phát thành công quá ${tong.overdueDays} ngày mà không dòng bảng kê nào nhắc tới. Đây là tiền cần đòi Viettel Post. Ngưỡng đo trên dữ liệu thật: bảng kê thường chốt trả trong vài ngày sau khi phát.`}
          icon={AlertTriangle}
          tone={tong.quaHan.count ? "rose" : "slate"}
        />
        <MetricCard
          label="Trả thiếu so với khai báo"
          value={formatVND(tong.traThieu.gap, { compact: true })}
          note={`${formatNumber(tong.traThieu.count)} đơn bảng kê trả ít hơn tiền thu hộ`}
          hint="Đơn VẪN là giao thành công mà bảng kê trả ít hơn tiền thu hộ khai báo — phần chênh này Viettel Post còn nợ. Đơn khách chỉ trả tiền ship không nằm ở đây: chúng là đơn hoàn, xem ở thẻ bên cạnh."
          icon={Receipt}
          tone={tong.traThieu.count ? "amber" : "slate"}
        />
        <MetricCard
          label="Giao nhưng thu không đủ"
          value={formatNumber(tong.giaoNhungHoan.count)}
          note={`khai báo ${formatVND(tong.giaoNhungHoan.khaiBao, { compact: true })} · bảng kê chỉ trả ${formatVND(tong.giaoNhungHoan.thucThu, { compact: true })}`}
          hint="Viettel Post báo phát thành công nhưng bảng kê chỉ trả một phần nhỏ — khách không nhận hàng, chỉ trả tiền ship để xem. Theo quy tắc của shop đây là ĐƠN HOÀN nên KHÔNG tính vào tiền Viettel Post phải trả; tách riêng ra đây để thấy hàng đã đi rồi quay về."
          icon={Undo2}
          tone={tong.giaoNhungHoan.count ? "amber" : "slate"}
        />
        <MetricCard
          label="Thực nhận về tài khoản"
          value={formatVND(tong.thucNhan, { compact: true })}
          note={`đã trừ cước ${formatVND(tong.cuoc, { compact: true })}${tong.chuaGhep.count ? ` · ${formatVND(tong.chuaGhep.amount, { compact: true })} chưa truy nguyên` : ""}`}
          hint="Số tiền còn lại phải thanh toán ghi ở phần KẾT LUẬN ĐỐI SOÁT của các bảng kê: tiền COD trừ cước. Đây là số khớp với tiền về tài khoản ngân hàng."
          icon={Landmark}
          tone="primary"
        />
      </section>

      <SettlementTabs counts={dem} active={tinhTrang} />

      <DataTableToolbar
        searchPlaceholder="Mã vận đơn, SĐT, tên khách…"
        period={{ defaultKey: "all" }}
        resultLabel={
          <>
            {formatNumber(danhSach.total)} vận đơn · {SETTLEMENT_HINT[tinhTrang as SettlementStatus] ?? "toàn bộ vận đơn có thu hộ"}
          </>
        }
      />

      <SectionCard padded={false}>
        <div className="overflow-x-auto">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead>Vận đơn</TableHead>
                <TableHead>Khách</TableHead>
                <TableHead>Ngày phát</TableHead>
                <TableHead className="text-right">Thu hộ khai báo</TableHead>
                <TableHead className="text-right">Bảng kê trả</TableHead>
                <TableHead className="text-right">Chênh lệch</TableHead>
                <TableHead className="text-right">Cước ĐVVC</TableHead>
                <TableHead>Ngày trả</TableHead>
                <TableHead className="text-right">Chờ</TableHead>
                <TableHead>Tình trạng</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {danhSach.rows.map((r) => (
                <TableRow key={r.id} className={cn(r.status === "QUA_HAN" && "bg-rose-50/40 dark:bg-rose-950/10")}>
                  <TableCell>
                    <Link href={`/shipments/${r.id}`} className="font-mono text-[12px] font-semibold hover:text-primary hover:underline">
                      {r.vtpOrderNumber ?? "—"}
                    </Link>
                    {r.systemId ? <div className="text-[11px] text-muted-foreground">#{r.systemId}</div> : null}
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate text-sm">{r.customer || "—"}</TableCell>
                  <TableCell className="text-xs">{r.deliveredAt ? formatDate(r.deliveredAt) : "—"}</TableCell>
                  <TableCell className="text-right"><Money value={r.codDeclared} /></TableCell>
                  <TableCell className="text-right">
                    {r.codPaid > 0 ? <Money value={r.codPaid} className="font-semibold text-emerald-700 dark:text-emerald-400" /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "TRA_THIEU" ? <Money value={r.gap} className="font-semibold text-amber-700 dark:text-amber-400" /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right">{r.fee > 0 ? <Money value={r.fee} className="text-muted-foreground" /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-xs" title={r.statementFile ?? ""}>{r.paidAt ? formatDate(r.paidAt) : "—"}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {r.waitingDays === null ? "—" : <span className={cn(r.status === "QUA_HAN" && "font-semibold text-rose-600")}>{formatNumber(r.waitingDays)} ngày</span>}
                  </TableCell>
                  <TableCell>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", SETTLEMENT_TONE[r.status])}>{SETTLEMENT_LABEL[r.status]}</span>
                  </TableCell>
                </TableRow>
              ))}
              {danhSach.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">Không có vận đơn nào trong nhóm này.</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <div className="border-t px-4 py-3">
          <UrlPagination pageCount={danhSach.pageCount} total={danhSach.total} />
        </div>
      </SectionCard>

      {thieu.length ? (
        <SectionCard
          title="Ngày phát chưa được bảng kê nào chi trả"
          description="Đơn giao thành công trong khoảng ngày này mà không dòng bảng kê nào nhắc tới."
          hint="Suy từ dữ liệu thật chứ không từ lịch trả tiền của Viettel Post. Hoặc Viettel Post chưa trả kỳ đó, hoặc thư bảng kê của kỳ đó chưa về ERP — đối chiếu với bảng bên dưới để biết kỳ nào còn thiếu."
          padded={false}
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[520px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Từ ngày</TableHead>
                  <TableHead>Đến ngày</TableHead>
                  <TableHead className="text-right">Đơn</TableHead>
                  <TableHead className="text-right">Tiền đang treo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {thieu.map((g) => (
                  <TableRow key={`${g.from}-${g.to}`}>
                    <TableCell className="text-sm font-medium">{formatDate(g.from)}</TableCell>
                    <TableCell className="text-sm font-medium">{formatDate(g.to)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(g.shipments)}</TableCell>
                    <TableCell className="text-right"><Money value={g.amount} className="font-semibold text-amber-700 dark:text-amber-400" /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Bảng kê Viettel Post nhận qua email"
        description={`${formatNumber(bangKe.length)} bảng kê · mỗi bảng kê là một lần Viettel Post chuyển tiền`}
        hint={
          <>
            Thư “BẢNG KÊ ĐỐI SOÁT THANH TOÁN” về hòm thư shop được đẩy thẳng vào ERP. Ba số tổng lấy
            từ phần <b>KẾT LUẬN ĐỐI SOÁT</b> in trong chính tệp: tiền COD phải trả − cước phải thu =
            còn lại phải thanh toán. <b>Chưa ghép</b> là dòng bảng kê có mã vận đơn mà ERP chưa có
            vận đơn đó — tiền có thật nhưng chưa truy nguyên được về đơn nào.
          </>
        }
        padded={false}
      >
        {bangKe.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày chốt trả</TableHead>
                  <TableHead>Chi trả cho ngày phát</TableHead>
                  <TableHead className="text-right">Tiền COD</TableHead>
                  <TableHead className="text-right">Cước</TableHead>
                  <TableHead className="text-right">Thực nhận</TableHead>
                  <TableHead className="text-right">Dòng</TableHead>
                  <TableHead className="text-right">Chưa ghép</TableHead>
                  <TableHead>Tệp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bangKe.map((f) => (
                  <TableRow key={f.filename}>
                    <TableCell className="text-sm font-semibold">{f.paidOn ? formatDate(f.paidOn) : <span className="text-amber-600">chưa rõ</span>}</TableCell>
                    <TableCell className="text-xs">{f.periodFrom ? `${formatDate(f.periodFrom)} → ${formatDate(f.periodTo ?? f.periodFrom)}` : "—"}</TableCell>
                    <TableCell className="text-right"><Money value={f.codTotal || f.codMatched} /></TableCell>
                    <TableCell className="text-right"><Money value={f.feeTotal} className="text-muted-foreground" /></TableCell>
                    <TableCell className="text-right"><Money value={f.netTotal} className="font-semibold" /></TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(f.matched)}/{formatNumber(f.lines)}</TableCell>
                    <TableCell className="text-right">
                      {f.codUnmatched ? <Money value={f.codUnmatched} className="text-amber-700 dark:text-amber-400" /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground" title={f.filename}>{f.filename}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            Chưa có bảng kê nào trong sổ chứng từ. Bảng kê Viettel Post gửi qua email sẽ tự chảy vào đây.
          </p>
        )}
      </SectionCard>
    </div>
  );
}

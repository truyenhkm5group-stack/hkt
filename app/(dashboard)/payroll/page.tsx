import {
  AlertTriangle,
  Banknote,
  HandCoins,
  Megaphone,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DeleteEmployeeButton,
  EmployeeDialog,
} from "@/app/(dashboard)/payroll/employee-dialog";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Money, SectionCard } from "@/components/ui-bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, requireUser } from "@/lib/auth/session";
import {
  PAYROLL_BASIS_LABEL,
  type PayrollBasis,
} from "@/lib/constants/payroll";
import { formatNumber, formatVND } from "@/lib/format";
import {
  getPayrollReport,
  listAdAccounts,
  unassignedMarketerSpend,
} from "@/lib/queries/payroll";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Lương & hoa hồng" };

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const user = await requireUser();
  if (!can(user, "payroll:view")) redirect("/?forbidden=1");
  const canManage = can(user, "payroll:manage");
  const period = resolvePeriod(raw, "month");
  const basis: PayrollBasis =
    param(raw, "basis") === "cash" ? "cash" : "nominal";
  const selected = param(raw, "marketer");
  const [report, unassigned, accounts] = await Promise.all([
    getPayrollReport(period, basis),
    unassignedMarketerSpend(period),
    listAdAccounts(),
  ]);
  const qs = new URLSearchParams({
    period: period.key,
    basis,
    ...(period.key === "custom"
      ? { from: period.fromKey ?? "", to: period.toKey ?? "" }
      : {}),
  }).toString();
  const m = report.marketers;
  const selectedMarketer = selected
    ? m.marketers.find((x) => (x.marketerId ?? "none") === selected)
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title="Lương & hoa hồng"
        description={`${period.label} · ${PAYROLL_BASIS_LABEL[basis].toLowerCase()} · ${formatNumber(report.lines.length)} nhân sự đang làm việc`}
        actions={canManage ? <EmployeeDialog accounts={accounts} /> : null}
      />

      <DataTableToolbar
        period={{ defaultKey: "month" }}
        facets={[
          {
            key: "basis",
            label: "Cơ sở lợi nhuận",
            options: [
              { value: "nominal", label: PAYROLL_BASIS_LABEL.nominal },
              { value: "cash", label: PAYROLL_BASIS_LABEL.cash },
            ],
            single: true,
          },
        ]}
        resultLabel="Lợi nhuận cá nhân của marketer luôn tính theo danh nghĩa (đơn lên trong kỳ × tỷ lệ hoàn ước tính); cơ sở chỉ đổi cách tính lợi nhuận tổng."
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Lợi nhuận tổng kỳ"
          value={
            <span
              className={
                report.totalProfit >= 0 ? "text-success" : "text-destructive"
              }
            >
              {formatVND(report.totalProfit, { compact: true })}
            </span>
          }
          note={PAYROLL_BASIS_LABEL[basis]}
          icon={TrendingUp}
          tone={report.totalProfit >= 0 ? "green" : "rose"}
        />
        <MetricCard
          label="Tổng lương kỳ"
          value={formatVND(report.totalSalary, { compact: true })}
          note={`${formatNumber(report.lines.length)} người · lương cứng ${formatVND(
            report.lines.reduce((s, l) => s + l.fixed, 0),
            { compact: true },
          )}`}
          icon={HandCoins}
          tone="primary"
        />
        <MetricCard
          label="Chi phí QC test"
          value={formatVND(m.nominal.unmatchedAdSpend, { compact: true })}
          note="Quảng cáo không thuộc mã nào, trừ vào lợi nhuận tổng và cá nhân"
          icon={Megaphone}
          tone="amber"
        />
        <MetricCard
          label="QC chưa gán marketer"
          value={formatVND(unassigned.spend, { compact: true })}
          note={
            unassigned.spend
              ? `${formatNumber(unassigned.campaigns)} chiến dịch — gán ở Chi phí & quảng cáo → tab Quảng cáo`
              : "Tất cả chiến dịch đã có marketer"
          }
          icon={AlertTriangle}
          tone={unassigned.spend ? "rose" : "slate"}
        />
      </section>

      <SectionCard
        title="Bảng lương"
        description="Lương = lương cứng + % lợi nhuận tổng + % lợi nhuận cá nhân + % doanh thu cá nhân · thưởng chỉ tính khi lợi nhuận dương"
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1100px]">
            <TableHeader>
              <TableRow>
                <TableHead>Nhân sự</TableHead>
                <TableHead>Cơ chế</TableHead>
                <TableHead className="text-right">LN tổng</TableHead>
                <TableHead className="text-right">LN cá nhân</TableHead>
                <TableHead className="text-right">Lương cứng</TableHead>
                <TableHead className="text-right">Thưởng % tổng</TableHead>
                <TableHead className="text-right">Thưởng % cá nhân</TableHead>
                <TableHead className="text-right">Thưởng % DT</TableHead>
                <TableHead className="text-right">Tổng lương</TableHead>
                {canManage ? <TableHead className="w-20" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.lines.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    Chưa có nhân sự. Bấm “Thêm nhân sự”, nhập cơ chế lương và bí
                    danh chiến dịch (VD Quân TA: 35% lợi nhuận tổng, bí danh
                    QA4).
                  </TableCell>
                </TableRow>
              ) : (
                report.lines.map((l) => (
                  <TableRow key={l.employee.id}>
                    <TableCell>
                      <div className="font-semibold">{l.employee.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {l.employee.shortName} · {l.employee.department}
                        {l.employee.aliases.length
                          ? ` · bí danh ${l.employee.aliases.join(", ")}`
                          : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {[
                        l.employee.fixed
                          ? `cứng ${formatVND(l.employee.fixed, { compact: true })}`
                          : null,
                        l.employee.percentTotal
                          ? `${l.employee.percentTotal}% LN tổng`
                          : null,
                        l.employee.percentPersonal
                          ? `${l.employee.percentPersonal}% LN cá nhân`
                          : null,
                        l.employee.percentRevenue
                          ? `${l.employee.percentRevenue}% DT cá nhân`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" + ") || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={l.totalProfit}
                        className={cn(
                          l.employee.percentTotal
                            ? ""
                            : "text-muted-foreground",
                        )}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {l.personalProfit === null ? (
                        <span className="text-xs text-muted-foreground">
                          không có QC
                        </span>
                      ) : (
                        <Link
                          href={`/payroll?${qs}&marketer=${l.employee.id}#marketer`}
                          className="hover:underline"
                        >
                          <Money
                            value={l.personalProfit}
                            className={cn(
                              "font-semibold",
                              l.personalProfit >= 0
                                ? "text-success"
                                : "text-destructive",
                            )}
                          />
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={l.fixed}
                        className={l.fixed ? "" : "text-muted-foreground"}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={l.bonusTotal}
                        className={l.bonusTotal ? "" : "text-muted-foreground"}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={l.bonusPersonal}
                        className={
                          l.bonusPersonal ? "" : "text-muted-foreground"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={l.bonusRevenue}
                        className={
                          l.bonusRevenue ? "" : "text-muted-foreground"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={l.salary} className="text-base font-bold" />
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        <div className="flex items-center">
                          <EmployeeDialog
                            employee={l.employee}
                            accounts={accounts}
                          />
                          <DeleteEmployeeButton employee={l.employee} />
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
              {report.lines.length ? (
                <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                  <TableCell colSpan={4}>Tổng</TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={report.lines.reduce((s, l) => s + l.fixed, 0)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={report.lines.reduce((s, l) => s + l.bonusTotal, 0)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={report.lines.reduce(
                        (s, l) => s + l.bonusPersonal,
                        0,
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={report.lines.reduce(
                        (s, l) => s + l.bonusRevenue,
                        0,
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={report.totalSalary} className="text-base" />
                  </TableCell>
                  {canManage ? <TableCell /> : null}
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Lợi nhuận cá nhân theo marketer"
        description="Lợi nhuận danh nghĩa mỗi mã (trước QC) chia cho các marketer theo tỷ trọng tiền QC họ chạy cho mã đó, trừ QC mã hàng và QC test của chính họ. Bấm tên để xem theo mã."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">QC mã hàng</TableHead>
                <TableHead className="text-right">QC test</TableHead>
                <TableHead className="text-right">Đơn phân bổ</TableHead>
                <TableHead className="text-right">DT GTC phân bổ</TableHead>
                <TableHead className="text-right">LN trước QC</TableHead>
                <TableHead className="text-right">LN cá nhân</TableHead>
                <TableHead className="text-right">CPQC/đơn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.marketers.map((x) => (
                <TableRow
                  key={x.marketerId ?? "none"}
                  className={cn(
                    selectedMarketer &&
                      (selectedMarketer.marketerId ?? "none") ===
                        (x.marketerId ?? "none") &&
                      "bg-primary/5",
                  )}
                >
                  <TableCell>
                    <Link
                      href={`/payroll?${qs}&marketer=${x.marketerId ?? "none"}#marketer`}
                      className={cn(
                        "font-semibold hover:text-primary hover:underline",
                        !x.marketerId && "text-amber-700",
                      )}
                    >
                      {x.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={x.adSpend} className="text-rose-600" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={x.testSpend}
                      className={
                        x.testSpend ? "text-amber-600" : "text-muted-foreground"
                      }
                    />
                  </TableCell>
                  <TableCell className="numeric text-right">
                    {formatNumber(x.attributedOrders)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={x.attributedRevenue} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={x.attributedProfitBeforeAds}
                      className="text-muted-foreground"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={x.personalProfit}
                      className={cn(
                        "font-bold",
                        x.personalProfit >= 0
                          ? "text-success"
                          : "text-destructive",
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={
                        x.attributedOrders
                          ? Math.round(x.totalSpend / x.attributedOrders)
                          : 0
                      }
                      className="text-muted-foreground"
                    />
                  </TableCell>
                </TableRow>
              ))}
              {m.unattributedProfit ? (
                <TableRow className="text-muted-foreground">
                  <TableCell>
                    Mã không có quảng cáo (không phân bổ cho ai)
                  </TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right">
                    <Money value={m.unattributedRevenue} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={m.unattributedProfit} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={m.unattributedProfit} />
                  </TableCell>
                  <TableCell className="text-right">—</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {selectedMarketer ? (
        <div id="marketer">
          <SectionCard
            title={`${selectedMarketer.name} · theo mã hàng`}
            description={`Lợi nhuận cá nhân ${formatVND(selectedMarketer.personalProfit)} = LN trước QC phân bổ ${formatVND(selectedMarketer.attributedProfitBeforeAds)} − QC mã hàng ${formatVND(selectedMarketer.adSpend)} − QC test ${formatVND(selectedMarketer.testSpend)}`}
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href={`/payroll?${qs}`}>Đóng</Link>
              </Button>
            }
            padded={false}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã hàng</TableHead>
                  <TableHead className="text-right">QC của marketer</TableHead>
                  <TableHead className="text-right">Tỷ trọng QC mã</TableHead>
                  <TableHead className="text-right">Đơn phân bổ</TableHead>
                  <TableHead className="text-right">DT GTC phân bổ</TableHead>
                  <TableHead className="text-right">LN trước QC</TableHead>
                  <TableHead className="text-right">LN cá nhân</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedMarketer.products.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell className="font-medium">
                      {p.code ? `${p.code} · ` : ""}
                      {p.productName}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={p.adSpend} className="text-rose-600" />
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {(p.share * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {formatNumber(p.orders)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={p.attributedRevenue} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={p.attributedProfitBeforeAds}
                        className="text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={p.personalProfit}
                        className={cn(
                          "font-semibold",
                          p.personalProfit >= 0
                            ? "text-success"
                            : "text-destructive",
                        )}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {selectedMarketer.testSpend ? (
                  <TableRow className="text-amber-700">
                    <TableCell>
                      Chi phí test (chiến dịch không thuộc mã)
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={selectedMarketer.testSpend} />
                    </TableCell>
                    <TableCell colSpan={4} />
                    <TableCell className="text-right">
                      <Money value={-selectedMarketer.testSpend} />
                    </TableCell>
                  </TableRow>
                ) : null}
                {selectedMarketer.products.length === 0 &&
                !selectedMarketer.testSpend ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Không có chi tiêu trong kỳ.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </SectionCard>
        </div>
      ) : null}
      <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-3.5 text-[13px] text-muted-foreground">
        <Banknote className="mt-0.5 size-4 shrink-0" />
        <div>
          Ví dụ cơ chế: Trần Anh Quân 35% lợi nhuận tổng → nhập{" "}
          <b className="text-foreground">% lợi nhuận tổng = 35</b>. Hồ Minh Hiếu
          30% lợi nhuận cá nhân →{" "}
          <b className="text-foreground">% lợi nhuận cá nhân = 30</b>, bí danh{" "}
          <span className="font-mono">HIEU, HIEU_HM</span>, tài khoản QC mặc
          định <span className="font-mono">HIEU.HM 01</span>. Lê Việt Nhật 25% →{" "}
          <span className="font-mono">NHAT_LV, NHAT</span>, tài khoản{" "}
          <span className="font-mono">Nhật LV</span>.
        </div>
      </div>
    </div>
  );
}

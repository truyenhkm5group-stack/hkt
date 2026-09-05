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
import { employeeMatchesUser } from "@/lib/queries/payroll";
import {
  PAYROLL_BASIS_LABEL,
  type PayrollBasis,
  PAYROLL_BASES,
  PAYROLL_BASIS_SHORT,
  parsePayrollBasis,
} from "@/lib/constants/payroll";
import { formatNumber, formatVND } from "@/lib/format";
import {
  getPayrollReport,
  listAdAccounts,
  listPagesForConfig,
  unassignedMarketerSpend,
} from "@/lib/queries/payroll";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { ProductOwnersForm } from "@/app/(dashboard)/payroll/product-owners-form";
import { listProductsForMapping } from "@/lib/queries/ads-mapping";
import { cn } from "@/lib/utils";

export const metadata = { title: "Lương & hoa hồng" };

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const user = await requireUser();
  const viewAll = can(user, "payroll:view");
  if (!viewAll && !can(user, "payroll:view-own")) redirect("/?forbidden=1");
  const canManage = viewAll && can(user, "payroll:manage");
  const period = resolvePeriod(raw, "month");
  const basis: PayrollBasis = parsePayrollBasis(param(raw, "basis"));
  const selected = param(raw, "marketer");
  const pagesForConfig = listPagesForConfig().catch(() => []);
  const [report, unassigned, accounts, products] = await Promise.all([
    getPayrollReport(period, basis),
    unassignedMarketerSpend(period),
    listAdAccounts(),
    listProductsForMapping(),
  ]);
  const qs = new URLSearchParams({
    period: period.key,
    basis,
    ...(period.key === "custom"
      ? { from: period.fromKey ?? "", to: period.toKey ?? "" }
      : {}),
  }).toString();
  const m = report.marketers;
  // Quyền "xem của mình": chỉ dòng lương / marketer khớp email hoặc tên người đăng nhập
  const ownIds = new Set(report.lines.filter((l) => employeeMatchesUser(l.employee, user)).map((l) => l.employee.id));
  const lines = viewAll ? report.lines : report.lines.filter((l) => ownIds.has(l.employee.id));
  const marketersVisible = viewAll ? m.marketers : m.marketers.filter((x) => x.marketerId && ownIds.has(x.marketerId));
  const selectedMarketer = selected
    ? marketersVisible.find((x) => (x.marketerId ?? "none") === selected)
    : null;
  const totalSalary = viewAll ? report.totalSalary : lines.reduce((t, l) => t + l.salary, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Lương & hoa hồng"
        description={`${period.label} · ${PAYROLL_BASIS_LABEL[basis].toLowerCase()} · ${formatNumber(lines.length)} nhân sự đang làm việc`}
        actions={canManage ? <EmployeeDialog accounts={accounts} /> : null}
      />

      <DataTableToolbar
        period={{ defaultKey: "month" }}
        facets={[
          {
            key: "basis",
            label: "Cơ sở lợi nhuận",
            options: PAYROLL_BASES.map((b) => ({ value: b, label: PAYROLL_BASIS_SHORT[b] })),
            single: true,
          },
        ]}
        resultLabel={
          basis === "cash"
            ? `Dòng tiền thực: LN tổng = tiền vào (COD về theo bảng kê + trả trước) − tiền ra trong kỳ; LN cá nhân = LN1 cá nhân × ${report.cashRatio.toFixed(2)} (LN dòng tiền ${formatVND(report.totalProfit, { compact: true })} ÷ LN1 ${formatVND(report.marketers.totals.profit, { compact: true })}).`
            : basis === "nominal"
              ? "Danh nghĩa: đơn lên trong kỳ × tỷ lệ giao thành công ước tính (GTC = COD thực > 100K) − giá vốn − vận chuyển − QC; chưa phải tiền thật về."
              : `${PAYROLL_BASIS_LABEL[basis]}. Đơn & doanh thu của mã ghi nhận cho marketer theo FANPAGE phát sinh đơn (page chưa gán → theo tỷ trọng QC). Chủ mã chịu tồn kho & giá vốn, hưởng X% LN đơn của mình; người chạy cùng hưởng Y% LN đơn mình tạo, phần còn lại về chủ mã (khai báo ở trên). Chi phí vận hành đã nhập và chi phí cố định (giả định ở Báo cáo lợi nhuận) phân bổ theo tỷ trọng doanh thu GTC; đóng hàng và nhân viên vận đơn tính theo số đơn gửi của từng mã.`
        }
      />

      {!viewAll ? (
        <div className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
          Bạn đang xem <b>lương & lợi nhuận của riêng mình</b>{lines.length ? ` (${lines.map((l) => l.employee.shortName || l.employee.name).join(", ")})` : ""}. {lines.length ? "" : "Chưa khớp được nhân sự nào với tài khoản của bạn — nhờ quản trị khai báo email đăng nhập trong hồ sơ nhân sự."}
        </div>
      ) : null}
      {viewAll ? <ProductOwnersForm config={report.marketers.config} products={products} pages={(await pagesForConfig).map((p) => ({ pageId: p.pageId, name: p.name, orders: p.orders, sales: p.sales }))} marketers={lines.filter((l) => l.employee.department === "Marketing").map((l) => ({ id: l.employee.id, name: l.employee.shortName || l.employee.name }))} canWrite={canManage} /> : null}

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
          note={`${PAYROLL_BASIS_SHORT[basis]} · DT GTC ${formatVND(m.totals.revenue, { compact: true })} − QC ${formatVND(m.totals.adSpend + m.totals.testSpend, { compact: true })} − giá vốn ${formatVND(m.totals.cogs, { compact: true })} − VC ${formatVND(m.totals.shipping, { compact: true })} − vận hành ${formatVND(m.totals.operating, { compact: true })} (đã nhập ${formatVND(m.totals.operatingEntered, { compact: true })} + cố định ${formatVND(m.totals.fixedCost, { compact: true })} · ${m.totals.months} tháng + đóng hàng & NV vận đơn ${formatVND(m.totals.perOrderOps, { compact: true })})`}
          icon={TrendingUp}
          tone={report.totalProfit >= 0 ? "green" : "rose"}
        />
        <MetricCard
          label="Tổng lương kỳ"
          value={formatVND(totalSalary, { compact: true })}
          note={`${formatNumber(lines.length)} người · lương cứng ${formatVND(
            lines.reduce((s, l) => s + l.fixed, 0),
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
              ? `${formatNumber(unassigned.campaigns)} chiến dịch — gán ở module Quảng cáo (cuối trang)`
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
              {lines.length === 0 ? (
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
                lines.map((l) => (
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
              {lines.length ? (
                <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                  <TableCell colSpan={4}>Tổng</TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={lines.reduce((s, l) => s + l.fixed, 0)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={lines.reduce((s, l) => s + l.bonusTotal, 0)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={lines.reduce(
                        (s, l) => s + l.bonusPersonal,
                        0,
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={lines.reduce(
                        (s, l) => s + l.bonusRevenue,
                        0,
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={totalSalary} className="text-base" />
                  </TableCell>
                  {canManage ? <TableCell /> : null}
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title={`Lợi nhuận theo mã hàng · ${PAYROLL_BASIS_SHORT[basis]}`}
        description={basis === "profit2" ? "Doanh thu GTC − QC − giá vốn TỔNG hàng nhập trong kỳ (phiếu nhập) − vận chuyển − vận hành (đã nhập + cố định phân bổ theo doanh thu, đóng hàng + NV vận đơn theo đơn gửi). Chủ mã chịu toàn bộ giá vốn hàng nhập." : "Doanh thu GTC − QC − giá vốn hàng giao thành công − vận chuyển (kể cả đơn hoàn) − vận hành (đã nhập + cố định phân bổ theo doanh thu, đóng hàng + NV vận đơn theo đơn gửi)."}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead>Phụ trách</TableHead>
                <TableHead className="text-right">Đơn GTC</TableHead>
                <TableHead className="text-right">Doanh thu GTC</TableHead>
                <TableHead className="text-right">QC</TableHead>
                <TableHead className="text-right">{basis === "profit2" ? "Giá vốn hàng nhập" : "Giá vốn hàng giao"}</TableHead>
                <TableHead className="text-right">Vận chuyển</TableHead>
                <TableHead className="text-right">CP phân bổ</TableHead>
                <TableHead className="text-right">Lợi nhuận</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.products.map((p) => (
                <TableRow key={p.productId}>
                  <TableCell className="font-medium">{p.code ? `${p.code} · ` : ""}{p.productName}</TableCell>
                  <TableCell className={cn("text-sm", !p.ownerName && "text-amber-700")}>{p.ownerName || "Chưa gán"}</TableCell>
                  <TableCell className="numeric text-right">{formatNumber(p.deliveredOrders)}</TableCell>
                  <TableCell className="text-right"><Money value={p.revenue} /></TableCell>
                  <TableCell className="text-right"><Money value={p.adSpend} className="text-rose-600" /></TableCell>
                  <TableCell className="text-right"><Money value={p.cogs} className="text-rose-600" />{basis === "profit2" && p.cogsDelivered ? <div className="text-[11px] text-muted-foreground">hàng giao {formatVND(p.cogsDelivered, { compact: true })}</div> : null}</TableCell>
                  <TableCell className="text-right"><Money value={p.shipping} className="text-rose-600" /></TableCell>
                  <TableCell className="text-right"><Money value={p.operatingAlloc} className="text-rose-600" /></TableCell>
                  <TableCell className="text-right"><Money value={p.profit} className={cn("font-bold", p.profit >= 0 ? "text-success" : "text-destructive")} /></TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell colSpan={3}>Tổng{m.totals.testSpend ? ` · QC test ${formatVND(m.totals.testSpend, { compact: true })} trừ riêng` : ""}</TableCell>
                <TableCell className="text-right"><Money value={m.totals.revenue} /></TableCell>
                <TableCell className="text-right"><Money value={m.totals.adSpend} className="text-rose-600" /></TableCell>
                <TableCell className="text-right"><Money value={m.totals.cogs} className="text-rose-600" /></TableCell>
                <TableCell className="text-right"><Money value={m.totals.shipping} className="text-rose-600" /></TableCell>
                <TableCell className="text-right"><Money value={m.totals.operating} className="text-rose-600" /></TableCell>
                <TableCell className="text-right"><Money value={m.totals.profit} className={cn("font-bold", m.totals.profit >= 0 ? "text-success" : "text-destructive")} /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Lợi nhuận cá nhân theo marketer"
        description={`Doanh thu GTC − vận chuyển − chi phí phân bổ${basis === "profit2" ? "" : " − giá vốn hàng giao TC"} của mỗi mã chia theo tỷ trọng tiền QC; trừ QC của chính mình${basis === "profit2" ? " và toàn bộ giá vốn hàng nhập của mã mình phụ trách" : ""}; người đẩy chéo trích ${m.config.ownerSharePct}% lợi nhuận cho chủ mã; QC test trừ vào người chạy. Bấm tên để xem theo mã.`}
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
                <TableHead className="text-right">Giá vốn chịu</TableHead>
                <TableHead className="text-right">% chủ mã</TableHead>
                <TableHead className="text-right">LN cá nhân</TableHead>
                <TableHead className="text-right">CPQC/đơn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {marketersVisible.map((x) => (
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
                    {x.ownedProducts.length ? <div className="text-[11px] text-muted-foreground">Phụ trách: {x.ownedProducts.join(", ")}</div> : null}
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
                    <Money value={x.cogsCharged} className={x.cogsCharged ? "text-rose-600" : "text-muted-foreground"} />
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {x.ownerBonusReceived ? <div className="text-emerald-700">+{formatVND(x.ownerBonusReceived)}</div> : null}
                    {x.ownerBonusPaid ? <div className="text-rose-600">−{formatVND(x.ownerBonusPaid)}</div> : null}
                    {!x.ownerBonusReceived && !x.ownerBonusPaid ? <span className="text-muted-foreground">—</span> : null}
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
            description={`Lợi nhuận cá nhân ${formatVND(selectedMarketer.personalProfit)} = LN trước QC phân bổ ${formatVND(selectedMarketer.attributedProfitBeforeAds)} − QC mã hàng ${formatVND(selectedMarketer.adSpend)} − giá vốn chịu ${formatVND(selectedMarketer.cogsCharged)} + % chủ mã nhận ${formatVND(selectedMarketer.ownerBonusReceived)} − % chia cho chủ mã ${formatVND(selectedMarketer.ownerBonusPaid)} − QC test ${formatVND(selectedMarketer.testSpend)}`}
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
                  <TableHead className="text-right">Giá vốn chịu</TableHead>
                  <TableHead className="text-right">% chủ mã</TableHead>
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
                    <TableCell className="text-right"><Money value={p.cogsCharged} className={p.cogsCharged ? "text-rose-600" : "text-muted-foreground"} /></TableCell>
                    <TableCell className="text-right text-xs">{p.ownerBonus ? <span className={p.ownerBonus > 0 ? "text-emerald-700" : "text-rose-600"}>{p.ownerBonus > 0 ? "+" : "−"}{formatVND(Math.abs(p.ownerBonus))}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
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

import {
  AlertTriangle,
  Banknote,
  Download,
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
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { MetricCard } from "@/components/metric-card";
import { FinanceNav } from "@/components/finance-nav";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { RunWorkflow } from "@/app/(dashboard)/payroll/run-workflow";
import { CalculationDetail } from "@/app/(dashboard)/payroll/calculation-detail";
import { ProfitBreakdown } from "@/app/(dashboard)/payroll/profit-breakdown";
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
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import { can, requireUser } from "@/lib/auth/session";
import { employeeMatchesUser, listEmployees } from "@/lib/queries/payroll";
import {
  PAYROLL_BASIS_ELIGIBILITY,
  PAYROLL_BASIS_LABEL,
  PAYROLL_BASIS_NAME,
  type PayrollBasis,
  PAYROLL_BASES,
  PAYROLL_BASIS_SHORT,
  parsePayrollBasis,
} from "@/lib/constants/payroll";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import {
  getPayrollReport,
  listAdAccounts,
  listPagesForConfig,
  unassignedMarketerSpend,
} from "@/lib/queries/payroll";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { ProductOwnersForm } from "@/app/(dashboard)/payroll/product-owners-form";
import { FinalizePeriodButton } from "@/app/(dashboard)/payroll/finalize-button";
import { FinalizedPeriodTable } from "@/app/(dashboard)/payroll/finalized-period";
import { getPayrollPeriodState, payrollDrift } from "@/lib/queries/payroll-period";
import { validatePolicyBookForPeriod } from "@/lib/queries/payroll-policies";
import { listProductsForMapping } from "@/lib/queries/ads-mapping";
import { cn } from "@/lib/utils";
import { canOpenPayroll, canSeeAllPayroll, resolvePayrollScope } from "@/lib/auth/payroll-scope";

export const metadata = { title: "Lương & hoa hồng" };

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const user = await requireUser();
  /*
    PHẠM VI TÍNH MỘT LẦN, Ở MÁY CHỦ, TRƯỚC KHI ĐỌC DÒNG NÀO (`lib/auth/payroll-scope.ts`).
    `payroll:view` cũ KHÔNG còn là "xem tất cả" — xem mục đầu tệp ấy để biết vì sao.
  */
  const scope = resolvePayrollScope(user);
  if (!canOpenPayroll(scope)) redirect("/?forbidden=1");
  const viewAll = canSeeAllPayroll(scope);
  const canManage = viewAll && can(user, "payroll:manage");
  const period = resolvePeriod(raw, "month");
  const basis: PayrollBasis = parsePayrollBasis(param(raw, "basis"));
  const selected = param(raw, "marketer");
  const pagesForConfig = listPagesForConfig().catch(() => []);
  const [report, unassigned, accounts, products, periodState, employeesForCheck] = await Promise.all([
    getPayrollReport(period, basis),
    unassignedMarketerSpend(period),
    listAdAccounts(),
    listProductsForMapping(),
    getPayrollPeriodState(period, basis),
    listEmployees(),
  ]);
  /*
    LỖI Ở SỔ KHAI, KHÁC HẲN THIẾU SỐ LIỆU.

    Chồng lấn mốc gán, khoảng trống không chính sách nào phủ, thành phần khai tỷ lệ 0 — cả ba đều
    KHÔNG lộ ra ở con số cuối cùng: bảng vẫn ra một số, và số ấy sai. Nên chúng được kiểm riêng,
    và câu chặn nói ĐÚNG chỗ phải sửa.
  */
  const policyIssues =
    period.from && period.to
      ? await validatePolicyBookForPeriod(period.from, period.to, employeesForCheck.filter((e) => e.active).map((e) => ({ id: e.id, name: e.shortName || e.name })))
      : [];
  /*
    KỲ ĐÃ KHOÁ ĐỌC ẢNH CHỤP, KHÔNG ĐỌC BẢN TÍNH SỐNG.

    Bản tính sống vẫn được dựng (một lần, ở trên) nhưng chỉ để so ra phần CHÊNH phát sinh sau ngày
    khoá — nó KHÔNG được hiện thay cho con số của kỳ. Đổi tỷ lệ hay nhập thêm phiếu kho về sau mà
    bảng lương tháng trước đổi theo là viết lại một kỳ đã trả tiền.

    `frozen` = `LOCKED` hoặc `PAID` (và `FINAL` cũ đọc như `LOCKED`). Bốn trạng thái trước đó —
    kể cả `APPROVED` — vẫn hiện bản tính sống: chúng tồn tại chính là để còn phát hiện được sai.
  */
  const daChot = periodState.frozen && periodState.snapshot !== null;
  const drift = daChot && periodState.snapshot ? payrollDrift(periodState.snapshot, report) : [];
  /*
    VIỆC CÒN THIẾU TRƯỚC KHI CHỐT — cùng một hàm thuần với `lib/actions/payroll-period.ts`.
    Dùng `report.lines` (chưa lọc theo quyền) chứ không phải `lines`: điều kiện chốt là điều kiện
    của CẢ KỲ, không phải của riêng người đang xem.
  */
  const blockers = payrollFinalizeBlockers({
    bounded: report.fixedBasis.bounded,
    basisEligible: PAYROLL_BASIS_ELIGIBILITY[basis].eligible,
    basisWhy: PAYROLL_BASIS_ELIGIBILITY[basis].why,
    basisLabel: PAYROLL_BASIS_SHORT[basis],
    totalSalary: report.totalSalary,
    costWarnings: report.marketers.costWarnings,
    lines: report.lines.map((l) => ({
      name: l.employee.shortName || l.employee.name,
      carryEstablished: l.carry ? l.carry.openingEstablished : null,
      carryReason: l.carry?.openingReason ?? null,
      engineMissing: l.engine?.result.missing.map((m) => ({ label: m.label, message: m.message })) ?? [],
      engineProblems: l.engine?.result.problems ?? [],
    })),
    policyIssues,
  });
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
  // `null` = lương cứng của kỳ CHƯA BIẾT (kỳ không có mốc đầu/cuối) ⇒ tổng lương cũng chưa biết.
  const totalSalary = !report.fixedBasis.bounded ? null : viewAll ? report.totalSalary : lines.reduce((t, l) => t + (l.salary ?? 0), 0);
  const fixedTotal = report.fixedBasis.bounded ? lines.reduce((t, l) => t + (l.fixed ?? 0), 0) : null;
  const fixedMonthlyTotal = lines.reduce((t, l) => t + l.fixedMonthly, 0);
  /** Nhân sự chưa có liên kết tài khoản ⇒ chính họ không xem được dòng lương của mình. */
  const chuaNoiTaiKhoan = viewAll ? report.lines.filter((l) => !(l.employee.userEmail ?? "").trim()) : [];
  /** Lương cứng khai theo THÁNG nhưng bảng hiện phần THUỘC KỲ — nói thẳng căn cứ, đừng để người đọc tự đoán. */
  const fixedNote = report.fixedBasis.bounded
    ? `khai ${formatVND(fixedMonthlyTotal, { compact: true })}/tháng, chia theo ${formatNumber(report.fixedBasis.days)} ngày của kỳ`
    : `khai ${formatVND(fixedMonthlyTotal, { compact: true })}/tháng — kỳ “Toàn bộ” không có mốc đầu/cuối nên chưa chia theo ngày được`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Lương & hoa hồng"
        description={`${period.label} · ${PAYROLL_BASIS_NAME[basis]} (${PAYROLL_BASIS_LABEL[basis].toLowerCase()}) · ${formatNumber(lines.length)} nhân sự đang làm việc`}
        hint={
          <p>
            Ví dụ cơ chế: Trần Anh Quân 35% lợi nhuận tổng → nhập <b>% lợi nhuận tổng = 35</b>. Hồ Minh Hiếu 30% lợi nhuận cá nhân →{" "}
            <b>% lợi nhuận cá nhân = 30</b>, bí danh <span className="font-mono">HIEU, HIEU_HM</span>, tài khoản QC mặc định{" "}
            <span className="font-mono">HIEU.HM 01</span>. Lê Việt Nhật 25% → <span className="font-mono">NHAT_LV, NHAT</span>, tài khoản{" "}
            <span className="font-mono">Nhật LV</span>.
          </p>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* Xuất ĐÚNG bảng đang xem: `qs` mang y nguyên kỳ và cơ sở lợi nhuận của màn hình. */}
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/payroll?${qs}`}>
                <Download className="size-4" aria-hidden /> Xuất CSV
              </a>
            </Button>
            {/*
              CHỈ hiện khi kỳ CHỐT ĐƯỢC, và điều kiện ấy đọc từ CÙNG hàm mà server action dùng
              (`payrollFinalizeBlockers`). Hai nơi tự viết hai mệnh đề là cách nút hiện rồi server
              từ chối — bắt người dùng phát hiện luật bằng cách bấm nhầm — hoặc tệ hơn: nút ẩn vì
              một lý do còn server cho qua vì lý do khác.
            */}
            {canManage && !daChot && periodState.key && !blockers.length && period.fromKey && period.toKey && totalSalary !== null ? (
              <FinalizePeriodButton from={period.fromKey} to={period.toKey} basis={basis} label={period.label} totalSalary={formatVND(totalSalary)} />
            ) : null}
            {canManage ? <EmployeeDialog accounts={accounts} /> : null}
          </div>
        }
      />
      <FinanceNav />
      <PayrollTabs canManage={canManage} />

      {/*
        THANH VÒNG ĐỜI ĐẶT TRƯỚC MỌI BẢNG SỐ.

        Câu hỏi đầu tiên của người mở bảng lương không phải "bao nhiêu tiền" mà là "con số này đã
        được ai duyệt chưa". Để nó ở cuối trang là để người ta đọc số trước rồi mới biết số ấy còn
        là bản nháp.
      */}
      {periodState.key && viewAll ? (
        <RunWorkflow
          periodKey={periodState.key}
          basis={basis}
          status={periodState.status === "NONE" ? "DRAFT" : periodState.status}
          canManage={canManage}
          canApprove={can(user, "payroll:approve")}
          calcRuns={periodState.calcRuns}
          statusReason={periodState.statusReason}
          approvedByEmail={periodState.approvedByEmail}
          approvedAt={periodState.approvedAt ? formatDateTime(periodState.approvedAt) : null}
          lockedAt={periodState.lockedAt ? formatDateTime(periodState.lockedAt) : null}
          paidAt={periodState.paidAt ? formatDateTime(periodState.paidAt) : null}
        />
      ) : null}

      <DataTableToolbar
        period={{ defaultKey: "month" }}
        facets={[
          {
            key: "basis",
            label: "Cơ sở lợi nhuận",
            options: PAYROLL_BASES.map((b) => ({ value: b, label: PAYROLL_BASIS_NAME[b] })),
            single: true,
          },
        ]}
        resultLabel={
          <span className="inline-flex items-center gap-1">
            Cách tính cơ sở lợi nhuận
            <InfoHint label="Cách tính cơ sở lợi nhuận">
          {basis === "cash"
            ? report.cashRatio === null
              ? `Dòng tiền thực: lợi nhuận tổng = tiền vào (COD về theo bảng kê + trả trước) − tiền ra trong kỳ. ${report.cashRatioReason ?? ""}`
              : `Dòng tiền thực: lợi nhuận tổng = tiền vào (COD về theo bảng kê + trả trước) − tiền ra trong kỳ; lợi nhuận cá nhân = phần cá nhân ở cơ sở “${PAYROLL_BASIS_NAME.profit1}” × ${report.cashRatio.toFixed(2)} (dòng tiền ${formatVND(report.totalProfit, { compact: true })} ÷ ${formatVND(report.marketers.totals.profit, { compact: true })}) — đây là phép QUY ĐỔI THEO TỶ TRỌNG, không phải lợi nhuận đo được của từng người.`
            : basis === "nominal"
              ? "Danh nghĩa: đơn lên trong kỳ × tỷ lệ giao thành công ước tính (GTC = COD thực > 100K) − giá vốn − vận chuyển − QC; chưa phải tiền thật về."
              : `${PAYROLL_BASIS_LABEL[basis]}. Đơn & doanh thu của mã ghi nhận cho marketer theo FANPAGE phát sinh đơn (page chưa gán → theo tỷ trọng QC). Chủ mã chịu tồn kho & giá vốn, hưởng X% LN đơn của mình; người chạy cùng hưởng Y% LN đơn mình tạo, phần còn lại về chủ mã (khai báo ở trên). Chi phí vận hành đã nhập và chi phí cố định (giả định ở Báo cáo lợi nhuận) phân bổ theo tỷ trọng doanh thu GTC; đóng hàng và nhân viên vận đơn tính theo số đơn gửi của từng mã.`}
            </InfoHint>
          </span>
        }
      />

      {/*
        CƠ SỞ ĐANG CHỌN CÓ ĐƯỢC PHÉP CHỐT LƯƠNG KHÔNG.

        Ô chọn cơ sở cho bốn lựa chọn trông giống hệt nhau, nhưng trước luật "lợi nhuận tính lương =
        doanh thu thực − TOÀN BỘ chi phí thuộc phạm vi ghi nhận" thì chỉ MỘT cái đủ điều kiện. Một
        lần bấm nhầm là cả kỳ lương tính trên cơ sở sai mà không có gì báo — nên nó phải báo.
        Không cơ sở nào bị gỡ: chúng vẫn là số liệu quản trị hữu ích, chỉ không được ÂM THẦM thành
        căn cứ trả tiền cho người.
      */}
      {!PAYROLL_BASIS_ELIGIBILITY[basis].eligible ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground dark:text-destructive">
          <b>Cơ sở “{PAYROLL_BASIS_SHORT[basis]}” KHÔNG dùng để chốt lương được.</b>
          <DataWarnings
            tone="danger"
            items={[
              PAYROLL_BASIS_ELIGIBILITY[basis].why,
              <>
                Cơ sở “{PAYROLL_BASIS_NAME.profit1}” — {PAYROLL_BASIS_ELIGIBILITY.profit1.why}
              </>,
            ]}
          />
          <Link href={`/payroll?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qs)), basis: "profit1" }).toString()}`} className="font-medium underline">
            Xem ở cơ sở “{PAYROLL_BASIS_NAME.profit1}”
          </Link>
        </div>
      ) : null}

      {/*
        ĐỦ CĂN CỨ ĐỂ CHỐT HAY CHƯA — VÀ VÌ SAO, NGAY CẠNH NÚT.

        Một nút bị ẩn mà không nói vì sao là một bức tường: chủ shop không biết phải làm gì để chốt
        được. Nên danh sách việc còn thiếu hiện ra nguyên văn, cùng đúng những dòng mà server action
        sẽ trả về nếu ai đó gọi thẳng vào nó.

        Chỉ hiện cho người có quyền khai báo lương: người chỉ xem không chốt được nên danh sách này
        với họ là nhiễu.
      */}
      {canManage && !daChot ? (
        blockers.length ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground dark:text-destructive">
            <b>Chưa đủ căn cứ để chốt kỳ này.</b>
            <DataWarnings
              tone="danger"
              label={`${formatNumber(blockers.length)} việc còn thiếu`}
              items={blockers.map((b) => (
                <span key={`${b.code}-${b.message.slice(0, 40)}`}>{b.message}</span>
              ))}
            />
          </div>
        ) : periodState.key ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <b>Đủ căn cứ để chốt kỳ này.</b>
            <InfoHint label="Vì sao đủ căn cứ">
              Mọi con số dùng để trả tiền đều đã tính được, không khoản chi nào đang nằm ngoài phép tính
              {report.lines.some((l) => l.carry) ? ", và số dư lỗ đầu kỳ của từng người đã xác lập" : ""}.
            </InfoHint>
          </div>
        ) : null
      ) : null}

      {/*
        AI CHƯA NỐI ĐƯỢC VỚI TÀI KHOẢN NÀO.

        Quyền "Lương: xem của mình" khớp bằng KHOÁ TÀI KHOẢN (ô "Email đăng nhập ERP"), không so
        tên — hai người trùng tên mà so tên là đọc được lương của nhau. Hệ quả cần nói ra: nhân sự
        chưa khai email thì chính họ KHÔNG xem được dòng của mình. Người quản trị là người sửa được
        việc đó, nên nhắc ở đây, cạnh chỗ sửa, chứ không để họ tự phát hiện qua một lời phàn nàn.
      */}
      <DataWarnings
        items={[
          canManage && chuaNoiTaiKhoan.length ? (
            <>
              <b>{formatNumber(chuaNoiTaiKhoan.length)}/{formatNumber(report.lines.length)} nhân sự chưa khai “Email đăng nhập ERP”</b> —{" "}
              {chuaNoiTaiKhoan.map((l) => l.employee.shortName || l.employee.name).join(", ")}. Người chỉ có quyền “Lương: xem của mình” sẽ thấy bảng rỗng cho
              tới khi có email, vì ERP khớp bằng KHOÁ TÀI KHOẢN chứ không so tên (hai người trùng tên mà so tên là đọc được lương của nhau). Bấm sửa từng
              người ở cột cuối bảng để khai.
            </>
          ) : null,
          report.cashRatioReason ? (
            <>
              <b>Lợi nhuận cá nhân của kỳ này chưa tính được ở cơ sở dòng tiền.</b> {report.cashRatioReason}
            </>
          ) : null,
          !viewAll && !lines.length ? "Chưa khớp được nhân sự nào với tài khoản của bạn — nhờ quản trị khai báo email đăng nhập trong hồ sơ nhân sự." : null,
        ]}
      />
      {!viewAll ? (
        <div className="rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
          Bạn đang xem <b>lương & lợi nhuận của riêng mình</b>{lines.length ? ` (${lines.map((l) => l.employee.shortName || l.employee.name).join(", ")})` : ""}.
        </div>
      ) : null}
      {viewAll ? <ProductOwnersForm config={report.marketers.config} products={products} pages={(await pagesForConfig).map((p) => ({ pageId: p.pageId, name: p.name, orders: p.orders, sales: p.sales }))} marketers={lines.filter((l) => l.employee.department === "Marketing").map((l) => ({ id: l.employee.id, name: l.employee.shortName || l.employee.name }))} canWrite={canManage} /> : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
          note={PAYROLL_BASIS_SHORT[basis]}
          hint={`${PAYROLL_BASIS_SHORT[basis]} · DT GTC ${formatVND(m.totals.revenue, { compact: true })} − QC ${formatVND(m.totals.adSpend + m.totals.testSpend, { compact: true })} − giá vốn ${formatVND(m.totals.cogs, { compact: true })} − VC ${formatVND(m.totals.shipping, { compact: true })} − vận hành ${formatVND(m.totals.operating, { compact: true })} (đã nhập ${formatVND(m.totals.operatingEntered, { compact: true })} + cố định ${formatVND(m.totals.fixedCost, { compact: true })} · ${m.totals.months} tháng + đóng hàng & NV vận đơn ${formatVND(m.totals.perOrderOps, { compact: true })})`}
          icon={TrendingUp}
          tone={report.totalProfit >= 0 ? "green" : "rose"}
        />
        <MetricCard
          label="Tổng lương kỳ"
          value={totalSalary === null ? "—" : formatVND(totalSalary, { compact: true })}
          note={`${formatNumber(lines.length)} người · lương cứng ${fixedTotal === null ? "—" : formatVND(fixedTotal, { compact: true })}`}
          hint={`Lương cứng ${fixedNote}.`}
          icon={HandCoins}
          tone="primary"
        />
        {/*
          BA CON SỐ RIÊNG, KHÔNG GỘP: phải trả (phép tính trên kỳ làm việc) · đã trả (sự kiện tiền,
          có ngày của riêng nó) · chênh lệch. Lương tháng 8 trả ngày 05/09 là tiền ra của tháng 9
          nhưng là chi phí của tháng 8 — gộp lại là mất dấu một tháng lương.
        */}
        <MetricCard
          label="Đã trả trong kỳ"
          value={formatVND(report.paid.amount, { compact: true })}
          note={
            viewAll
              ? `${formatNumber(report.paid.count)} khoản chi nhóm “Lương” · ${
                  totalSalary === null ? "chưa so được với phải trả" : `phải trả ${formatVND(totalSalary, { compact: true })} · chênh ${formatVND(report.paid.amount - totalSalary, { compact: true })}`
                } · toàn shop`
              : "Con số toàn shop"
          }
          hint={`${
            viewAll
              ? `Theo NGÀY PHÁT SINH · toàn shop, KHÔNG tách được theo người${totalSalary === null ? " · chưa so được với phải trả (một phần chưa biết)" : ""}.`
              : "Con số toàn shop — ERP chưa tách được tiền đã trả theo từng người."
          } Tiền lương THẬT SỰ ra khỏi túi trong kỳ: tổng khoản chi nhóm “Lương” ở bảng Chi phí, đọc theo NGÀY PHÁT SINH thô (không qua phép phân bổ theo kỳ). Đây là chiều khác hẳn “phải trả” — lương tháng 8 trả ngày 05/09 là tiền ra của tháng 9 nhưng là chi phí của tháng 8. ${report.paid.missingWhat}`}
          icon={Banknote}
          tone="slate"
        />
        <MetricCard
          label="Chi phí QC test"
          value={formatVND(m.nominal.unmatchedAdSpend, { compact: true })}
          hint="Quảng cáo không thuộc mã nào, trừ vào lợi nhuận tổng và cá nhân"
          icon={Megaphone}
          tone="amber"
        />
        <MetricCard
          label="QC chưa gán marketer"
          value={formatVND(unassigned.spend, { compact: true })}
          note={
            unassigned.spend
              ? `${formatNumber(unassigned.campaigns)} chiến dịch`
              : "Tất cả chiến dịch đã có marketer"
          }
          hint={unassigned.spend ? "Gán ở module Quảng cáo (cuối trang)." : undefined}
          icon={AlertTriangle}
          tone={unassigned.spend ? "rose" : "slate"}
        />
      </section>

      {/*
        LỢI NHUẬN NÀY ĐÃ TRỪ ĐỦ CHI PHÍ CHƯA — hỏi thẳng máy chi phí, in nguyên văn lời khai của nó.

        Cùng bộ cảnh báo mà trang Chi phí đang hiện. Nó phải có mặt ở ĐÂY nữa, vì đây là nơi con số
        lợi nhuận biến thành tiền trả cho người thật: một khoản lương hay hoa hồng bị loại vì trùng
        nguồn, hay một nguồn chi phí chưa phủ đủ, làm lợi nhuận CAO HƠN thực tế — và thưởng theo %
        lợi nhuận cao theo.
      */}
      {/*
        DOANH THU CHIA CHO MARKETER BẰNG CĂN CỨ NÀO — bốn nhóm, cộng lại đúng tổng đem chia.

        "Bảng gán phẳng" là ánh xạ page → người KHÔNG có mốc hiệu lực: đổi người phụ trách hôm nay
        thì phần doanh thu ấy của kỳ TRƯỚC cũng đổi chủ. Nên phần đi bằng nó phải hiện ra, và việc
        cần làm là khai mốc hiệu lực ở Marketing → Fanpage & quy kết rồi chạy lại đối soát.
      */}
      {viewAll && report.marketers.attributionCoverage.total > 0 ? (
        <SectionCard
          title="Doanh thu chia cho marketer bằng căn cứ nào"
          hint="Doanh thu GIAO THÀNH CÔNG của kỳ, tách theo nguồn đã dùng để quyết định ai được tính. Bốn nhóm cộng lại bằng tổng đem chia."
          actions={
            report.marketers.attributionCoverage.legacyPage > 0 ? (
              <DataWarnings
                align="end"
                items={[
                  <>
                    Còn {formatVND(report.marketers.attributionCoverage.legacyPage)} đi bằng bảng gán phẳng.{" "}
                    <Link href="/marketing/fanpages?tab=assign" className="underline">
                      Khai mốc hiệu lực cho các fanpage ấy
                    </Link>{" "}
                    rồi chạy “Đối soát lại” để phần này chuyển sang ảnh chụp.
                  </>,
                ]}
              />
            ) : null
          }
        >
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ["Ảnh chụp theo mốc đơn lên", report.marketers.attributionCoverage.snapshot, "Người phụ trách fanpage TẠI LÚC ĐƠN PHÁT SINH. Nguồn có thẩm quyền — đổi người hôm nay không làm đổi số của kỳ đã qua.", "emerald"],
                ["Bảng gán phẳng (cũ)", report.marketers.attributionCoverage.legacyPage, "Ánh xạ fanpage → người KHÔNG có mốc hiệu lực. Đổi người phụ trách hôm nay sẽ làm đổi cả số của kỳ trước. Khai mốc hiệu lực ở Marketing → Fanpage & quy kết rồi chạy “Đối soát lại”.", "amber"],
                ["Theo quảng cáo (lấp chỗ)", report.marketers.attributionCoverage.ads, "Fanpage không nói được gì nên lấy `ad_id` → chiến dịch → marketer. Quảng cáo KHÔNG ghi đè người được tính theo fanpage.", "slate"],
                ["Chưa có căn cứ", report.marketers.attributionCoverage.unmapped, "Không nguồn nào nói được ai: chia theo tỷ trọng tiền quảng cáo trên mã, về chủ mã, hoặc không thuộc về ai.", "slate"],
              ] as const
            ).map(([label, value, hint, tone]) => (
              <div key={label} className="rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-[11.5px] font-medium">
                    {label}
                    <InfoHint>{hint}</InfoHint>
                  </span>
                  <span className={cn("numeric text-sm font-semibold", tone === "emerald" && "text-success", tone === "amber" && "text-amber-600 dark:text-amber-400")}>
                    {formatVND(value, { compact: true })}
                  </span>
                </div>
                {report.marketers.attributionCoverage.total > 0 ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{`${Math.round((value / report.marketers.attributionCoverage.total) * 100)}%`}</p>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {viewAll && report.marketers.costWarnings.length ? (
        <SectionCard
          title="Lợi nhuận này đã trừ đủ chi phí chưa?"
          hint={
            <>
              <p>Lời khai của máy chi phí (lib/queries/cost-engine.ts) về nguồn từng khoản — lấy nguyên văn, bảng lương không tự đánh giá lại.</p>
              <p className="mt-1">
                Chi phí nhân sự trong lợi nhuận đang lấy từ{" "}
                <b>{report.marketers.payrollCovered ? "bảng Lương (lương cứng, chia theo số ngày của kỳ)" : "khoản chi nhóm “Lương” ở bảng Chi phí"}</b>. Hai nguồn
                không bao giờ được cộng cả hai — xem chi tiết ở{" "}
                <Link href="/expenses?tab=bao-cao" className="underline">
                  Chi phí → Báo cáo
                </Link>
                .
              </p>
            </>
          }
        >
          <DataWarnings
            tone={report.marketers.costWarnings.some((w) => w.severity === "high") ? "danger" : "warn"}
            items={report.marketers.costWarnings.map((w) => (
              <div key={w.rule}>
                <p className="font-semibold">{w.title}</p>
                <p className="text-muted-foreground">{w.detail}</p>
                <p>
                  <span className="font-medium">Nên làm gì: </span>
                  {w.action}
                </p>
              </div>
            ))}
          />
        </SectionCard>
      ) : null}

      {daChot ? <FinalizedPeriodTable state={periodState} basis={basis} drift={drift} /> : null}

      {daChot ? null : (
      <SectionCard
        title="Bảng lương"
        hint={
          <>
            <p>Lương cứng cộng thưởng theo lợi nhuận và doanh thu.</p>
            <p className="mt-1">Lương = lương cứng + % lợi nhuận tổng + % lợi nhuận cá nhân + % doanh thu cá nhân · thưởng chỉ tính khi lợi nhuận dương</p>
          </>
        }
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
                <TableHead className="text-right" title="Lương cứng khai theo THÁNG, chia theo số ngày chồng lấn của kỳ đang xem">
                  Lương cứng <span className="font-normal text-muted-foreground">(thuộc kỳ)</span>
                </TableHead>
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
                    {/*
                      MÀN HÌNH PHẢI NÓI RÕ NGƯỜI NÀY TÍNH BẰNG ĐƯỜNG NÀO.

                      Hai đường tồn tại song song trong giai đoạn chuyển, và một bảng không phân
                      biệt được chúng là một bảng mà người đọc không biết con số đến từ đâu. Đã gán
                      chính sách ⇒ hiện tên chính sách và các thành phần của nó; chưa gán ⇒ hiện
                      bốn ô cũ như trước.
                    */}
                    <TableCell className="text-xs">
                      {l.engine ? (
                        <>
                          <div className="font-medium">
                            {[...new Map(l.engine.segments.filter((sg) => sg.policyId).map((sg) => [sg.policyCode, sg])).values()]
                              .map((sg) => `${sg.policyName || sg.policyCode} #${sg.policyVersion ?? "?"}`)
                              .join(" → ") || "chưa có phiên bản hiệu lực"}
                          </div>
                          <div className="text-muted-foreground">
                            {l.engine.result.components.map((c) => c.label).join(" + ") || "chưa có thành phần nào tính được"}
                          </div>
                        </>
                      ) : (
                        [
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
                          .join(" + ") || "—"
                      )}
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
                      {l.fixed === null ? (
                        <span className="text-xs text-muted-foreground" title="Kỳ “Toàn bộ” không có mốc đầu/cuối nên không chia lương tháng theo ngày được">
                          —
                        </span>
                      ) : (
                        <>
                          <Money value={l.fixed} className={l.fixed ? "" : "text-muted-foreground"} />
                          {l.fixedMonthly && l.fixed !== l.fixedMonthly ? (
                            <div className="text-[11px] text-muted-foreground">
                              {formatVND(l.fixedMonthly, { compact: true })}/tháng × {formatNumber(l.employmentClip ? l.employmentClip.days : report.fixedBasis.days)} ngày
                              {l.employmentClip ? ` (làm ${l.employmentClip.from} → ${l.employmentClip.to})` : ""}
                            </div>
                          ) : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        value={l.bonusTotal}
                        className={l.bonusTotal ? "" : "text-muted-foreground"}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {l.bonusPersonal === null ? (
                        <span className="text-xs text-muted-foreground" title={report.cashRatioReason ?? undefined}>
                          —
                        </span>
                      ) : (
                        <Money value={l.bonusPersonal} className={l.bonusPersonal ? "" : "text-muted-foreground"} />
                      )}
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
                      {l.salary === null ? <span className="text-xs text-muted-foreground">—</span> : <Money value={l.salary} className="text-base font-bold" />}
                      {l.legacyAdjustments && l.legacyAdjustments.total !== 0 ? (
                        <div className="text-[11px] text-muted-foreground" title={l.legacyAdjustments.items.map((a) => `${a.label}: ${formatVND(a.amount)}`).join(" · ")}>
                          gồm điều chỉnh {formatVND(l.legacyAdjustments.total, { compact: true })}
                        </div>
                      ) : null}
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
                    {fixedTotal === null ? <span className="text-xs font-normal text-muted-foreground">—</span> : <Money value={fixedTotal} />}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      value={lines.reduce((s, l) => s + l.bonusTotal, 0)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {lines.some((l) => l.bonusPersonal === null) ? (
                      <span className="text-xs font-normal text-muted-foreground">—</span>
                    ) : (
                      <Money value={lines.reduce((s, l) => s + (l.bonusPersonal ?? 0), 0)} />
                    )}
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
                    {totalSalary === null ? <span className="text-xs font-normal text-muted-foreground">—</span> : <Money value={totalSalary} className="text-base" />}
                  </TableCell>
                  {canManage ? <TableCell /> : null}
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      )}

      {/*
        ═══ CHI TIẾT CÁCH TÍNH CHO TỪNG NGƯỜI ĐANG ĐI QUA MÁY CHUNG ═══

        Yêu cầu: *"không chỉ hiện con số cuối cùng."* Khối này in đúng các bước máy tính đã làm,
        theo đúng thứ tự nó đã làm, lấy thẳng từ vết giải thích mà chính phép tính sinh ra — không
        dựng lại ở tầng màn hình.

        Chỉ hiện cho kỳ CHƯA CHỐT: kỳ đã chốt đọc ảnh chụp ở khối riêng bên dưới, và ảnh chụp mang
        theo vết giải thích của LÚC ẤY chứ không phải của chính sách hôm nay.
      */}
      {!daChot
        ? lines
            .filter((l) => l.engine)
            .map((l) => <CalculationDetail key={l.employee.id} engine={l.engine!} employeeName={l.employee.shortName || l.employee.name} />)
        : null}

      {/*
        ═══ BẢNG BÙ TRỪ LỖ LŨY KẾ ═══

        Đặt riêng chứ không nhồi bảy cột vào bảng lương phía trên: bảng ấy đã rộng, và bảy con số
        này chỉ đọc được khi đứng CẠNH NHAU theo đúng thứ tự của phép tính — lỗ đầu kỳ, lãi/lỗ
        tháng, phần bù, cơ sở còn lại, rồi mới tới tiền.

        Cột "HH có dấu" cố ý vẫn hiện SỐ ÂM dù tiền phải trả bằng 0. Đó là thứ chủ shop cần thấy để
        biết một người đang âm bao nhiêu — giấu nó đi thì tháng lỗ và tháng hoà vốn trông giống hệt
        nhau, và đó chính là lỗi mà cơ chế này sinh ra để sửa.

        Bảng dựng từ `lines` — tập ĐÃ LỌC theo quyền — nên tài khoản "xem của mình" chỉ thấy sổ của
        chính mình, không cần thêm một lượt lọc thứ hai (thêm lượt lọc thứ hai là thêm một chỗ để
        quên).
      */}
      {lines.some((l) => l.carry) ? (
        <SectionCard
          title="Bù trừ lỗ lũy kế theo tháng"
          description={`Tháng ${lines.find((l) => l.carry)?.carry?.monthKey ?? ""}`}
          hint="Lợi nhuận âm của tháng trước được bù hết trước khi tính hoa hồng. Tiền phải trả không bao giờ âm; cột “HH có dấu” vẫn hiện số âm để theo dõi."
          padded={false}
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Nhân sự</TableHead>
                  <TableHead className="text-right">Lỗ đầu tháng</TableHead>
                  <TableHead className="text-right">LN thực tháng</TableHead>
                  <TableHead className="text-right">Lỗ được bù</TableHead>
                  <TableHead className="text-right">LN tính HH sau bù</TableHead>
                  <TableHead className="text-right">HH có dấu</TableHead>
                  <TableHead className="text-right">HH phải trả</TableHead>
                  <TableHead className="text-right">Lỗ chuyển tiếp</TableHead>
                  <TableHead>Căn cứ số dư</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines
                  .filter((l) => l.carry)
                  .map((l) => {
                    const c = l.carry!;
                    const chuaBiet = (
                      <span className="text-xs text-muted-foreground">—</span>
                    );
                    return (
                      <TableRow key={l.employee.id}>
                        <TableCell className="font-medium">{l.employee.shortName || l.employee.name}</TableCell>
                        <TableCell className="text-right">
                          {c.openingBalance === null ? chuaBiet : <Money value={c.openingBalance} className={c.openingBalance ? "text-destructive" : "text-muted-foreground"} />}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.realProfit === null ? chuaBiet : <Money value={c.realProfit} className={cn("font-semibold", c.realProfit >= 0 ? "text-success" : "text-destructive")} />}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.lossApplied === null ? chuaBiet : <Money value={c.lossApplied} className={c.lossApplied ? "" : "text-muted-foreground"} />}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.commissionBase === null ? chuaBiet : <Money value={c.commissionBase} className={c.commissionBase ? "font-semibold" : "text-muted-foreground"} />}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.signedCommission === null ? chuaBiet : <Money value={c.signedCommission} className={c.signedCommission < 0 ? "text-destructive" : c.signedCommission ? "" : "text-muted-foreground"} />}
                        </TableCell>
                        <TableCell className="text-right">
                          {l.bonusPersonal === null ? chuaBiet : <Money value={l.bonusPersonal} className={cn("font-bold", l.bonusPersonal ? "" : "text-muted-foreground")} />}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.closingBalance === null ? chuaBiet : <Money value={c.closingBalance} className={c.closingBalance ? "text-destructive" : "text-muted-foreground"} />}
                        </TableCell>
                        <TableCell className="max-w-[320px] text-xs text-muted-foreground">
                          {c.openingEstablished ? null : <span className="mr-1 rounded bg-amber-100 px-1 py-0.5 font-medium text-amber-800">chưa đủ để chốt</span>}
                          {c.openingReason}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title={`Lợi nhuận theo mã hàng · ${PAYROLL_BASIS_SHORT[basis]}`}
        hint={basis === "profit2" ? "Doanh thu GTC − QC − giá vốn TỔNG hàng nhập trong kỳ (phiếu nhập) − vận chuyển − vận hành (đã nhập + cố định phân bổ theo doanh thu, đóng hàng + NV vận đơn theo đơn gửi). Chủ mã chịu toàn bộ giá vốn hàng nhập." : "Doanh thu GTC − QC − giá vốn hàng giao thành công − vận chuyển (kể cả đơn hoàn) − vận hành (đã nhập + cố định phân bổ theo doanh thu, đóng hàng + NV vận đơn theo đơn gửi)."}
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
        hint={`Doanh thu GTC − vận chuyển − chi phí phân bổ${basis === "profit2" ? "" : " − giá vốn hàng giao TC"} của mỗi mã chia theo tỷ trọng tiền QC; trừ QC của chính mình${basis === "profit2" ? " và toàn bộ giá vốn hàng nhập của mã mình phụ trách" : ""}; người đẩy chéo trích ${m.config.ownerSharePct}% lợi nhuận cho chủ mã; QC test trừ vào người chạy. Bấm tên để xem theo mã.`}
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

      {/*
        ═══ BÓC TÁCH LỢI NHUẬN TÍNH LƯƠNG, TỪNG DÒNG MỘT ═══

        Đặt TRƯỚC bảng theo mã hàng: người đọc cần thấy "con số này từ đâu ra" trước khi cần thấy
        "chia theo mã thế nào". Bảng theo mã trả lời câu hỏi thứ hai, không thay được câu thứ nhất.
      */}
      {selectedMarketer ? (
        <div id="marketer" className="space-y-4">
          <ProfitBreakdown
            marketer={selectedMarketer}
            carry={lines.find((l) => l.employee.id === selectedMarketer.marketerId)?.carry ?? null}
            commissionPercent={lines.find((l) => l.employee.id === selectedMarketer.marketerId)?.employee.percentPersonal ?? 0}
            commission={lines.find((l) => l.employee.id === selectedMarketer.marketerId)?.bonusPersonal ?? null}
            periodQs={qs}
          />
          <SectionCard
            title={`${selectedMarketer.name} · theo mã hàng`}
            description={`Lợi nhuận cá nhân ${formatVND(selectedMarketer.personalProfit)}`}
            hint={`Lợi nhuận cá nhân ${formatVND(selectedMarketer.personalProfit)} = LN trước QC phân bổ ${formatVND(selectedMarketer.attributedProfitBeforeAds)} − QC mã hàng ${formatVND(selectedMarketer.adSpend)} − giá vốn chịu ${formatVND(selectedMarketer.cogsCharged)} + % chủ mã nhận ${formatVND(selectedMarketer.ownerBonusReceived)} − % chia cho chủ mã ${formatVND(selectedMarketer.ownerBonusPaid)} − QC test ${formatVND(selectedMarketer.testSpend)}`}
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
    </div>
  );
}

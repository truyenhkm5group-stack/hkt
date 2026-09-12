import Link from "next/link";
import { ArrowRight, Banknote, Coins, HandCoins, Landmark, PackageCheck, ReceiptText, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { AccountsPanel } from "@/app/(dashboard)/finance/accounts-panel";
import { ExceptionsPanel } from "@/app/(dashboard)/finance/exceptions-panel";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { FinanceNav } from "@/components/finance-nav";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import { BALANCE_CONFIDENCE_LABEL } from "@/lib/queries/cash-position";
import { getFinanceOverview } from "@/lib/queries/finance-overview";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Tổng quan tài chính" };

/**
 * ═══════════ BUỒNG LÁI TÀI CHÍNH ═══════════
 *
 * Nhóm Tiền có sáu trang và không trang nào trả lời được câu hỏi đầu tiên của chủ shop mỗi sáng:
 * "còn bao nhiêu tiền, và đang nằm ở đâu". Sổ ngân hàng là danh sách giao dịch, Chi phí là biểu
 * mẫu nhập, Đối soát COD là bảng đối chiếu — mỗi trang đúng việc của nó, cộng lại vẫn không thành
 * một câu trả lời.
 *
 * ─── THỨ TỰ ĐỌC LÀ THIẾT KẾ, KHÔNG PHẢI SẮP XẾP ───
 *
 *  0. VIỆC CẦN LÀM   — đặt TRƯỚC mọi con số, vì mỗi mục trong đó đang làm sai lệch số bên dưới.
 *  1. TIỀN HIỆN CÓ   — trạng thái, không phụ thuộc kỳ báo cáo. Số duy nhất trả lời "mua được không".
 *  2. KỲ NÀY         — tiền vào / ra / ròng, có so kỳ trước.
 *  3. KINH DOANH     — doanh thu giao thành công, lợi nhuận góp, chi phí vận hành.
 *  4. TIỀN CHƯA VỀ   — COD Viettel Post còn giữ.
 *  5. LỢI NHUẬN ≠ TIỀN — vì sao hai con số trên không bằng nhau.
 *
 * KHỐI 1 CỐ Ý KHÔNG THEO KỲ. "Tiền hiện có" là số dư HÔM NAY; lọc nó theo "tháng trước" là vô
 * nghĩa. Nhãn trên thẻ nói rõ điều đó để không ai đọc nó như một con số của kỳ đang chọn.
 *
 * Mọi con số đều bấm được và mang theo kỳ đang xem — cùng hợp đồng mà
 * `tests/drilldown-contract.test.ts` áp cho bảng điều khiển: một chỉ số không kiểm chứng được thì
 * mất giá trị ra quyết định.
 */
export default async function FinancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  await requirePermission("bank:view");
  const period = resolvePeriod(raw, "month");
  const r = await getFinanceOverview(period);

  // Mang kỳ đang xem theo mọi liên kết drill-down. Thiếu bước này là lỗi "trông vẫn hợp lý" tệ nhất:
  // thẻ nói về tháng 9, trang mở ra nói về 30 ngày gần nhất, và hai tập đơn khác nhau.
  const ky = new URLSearchParams();
  if (period.key !== "all") ky.set("period", period.key);
  if (period.key === "custom") {
    if (period.fromKey) ky.set("from", period.fromKey);
    if (period.toKey) ky.set("to", period.toKey);
  }
  const qs = ky.toString();
  const withPeriod = (href: string) => (qs ? `${href}${href.includes("?") ? "&" : "?"}${qs}` : href);

  const pct = (now: number, before: number | null) => (before === null || before === 0 ? null : ((now - before) / before) * 100);

  const { cash, statement, truth, cod, costs } = r;
  const operating = costs.operatingTotal;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Tổng quan tài chính"
        description="Còn bao nhiêu tiền, tiền đang nằm ở đâu, và việc gì cần xử lý ngay"
        hint="Trang này KHÔNG tự tính con số nào: nó đọc lại đúng các engine đã có thẩm quyền (ORDER_OUTCOME cho kết quả đơn, cost-engine cho chi phí, bảng kê ĐVVC cho COD, số dư ngân hàng cho tiền) rồi xếp theo thứ tự mà một người đang ra quyết định cần đọc. Vì thế mọi số ở đây luôn khớp với trang gốc của nó."
        actions={<PeriodFilter defaultKey="month" />}
      />
      <FinanceNav badges={{ overview: r.exceptions.filter((e) => e.severity === "high").length, bank: statement.unclassified.count, cod: cod.quaHan.count }} />

      {/* ───────── 0. VIỆC CẦN LÀM — trước mọi con số ───────── */}
      <ExceptionsPanel exceptions={r.exceptions} />

      {/* ───────── 1. TIỀN HIỆN CÓ — trạng thái hôm nay, KHÔNG theo kỳ ───────── */}
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <MetricCard
          size="lg"
          label="Tiền hiện có"
          value={cash.total === null ? <span className="text-muted-foreground">Chưa biết</span> : <Money value={cash.total} />}
          note={
            cash.total === null
              ? "Chưa tài khoản nào có số dư từ ngân hàng"
              : `${formatNumber(cash.knownAccounts)} tài khoản${cash.complete ? "" : ` · ${formatNumber(cash.unknownAccounts)} chưa biết số dư`}${cash.freshestAt ? ` · ${formatTimeAgo(cash.freshestAt)}` : ""}`
          }
          hint="Số dư HÔM NAY, không theo kỳ báo cáo — lọc số dư theo 'tháng trước' là vô nghĩa. Đọc từ chính con số ngân hàng ghi trên giao dịch gần nhất của mỗi tài khoản, cộng các giao dịch phát sinh sau đó. Tài khoản chưa bao giờ có số dư từ ngân hàng KHÔNG được cộng dồn từ 0: con số đó sẽ trông thuyết phục mà hoàn toàn bịa."
          icon={Wallet}
          tone={cash.total === null ? "slate" : cash.complete ? "primary" : "amber"}
          href="/bank?tab=tai-khoan"
        />
        <SectionCard
          title="Tiền đang nằm ở tài khoản nào"
          description={cash.stalestAt ? `Số dư cũ nhất trong tổng: ${formatTimeAgo(cash.stalestAt)}` : undefined}
          hint="Cột 'Nguồn số dư' phân biệt ba thứ hoàn toàn khác nhau mà không có nó thì trông y hệt: số NGÂN HÀNG GHI, số ERP CỘNG THÊM từ mốc gần nhất, và số KHÔNG TỒN TẠI. Tài khoản ngừng dùng vẫn hiện trong bảng nhưng không vào tổng — tiền ở đó là thật, chỉ là đã thôi dùng để nhận tiền."
          padded={false}
        >
          <AccountsPanel cash={cash} />
        </SectionCard>
      </section>

      {/* ───────── 2. KỲ NÀY: tiền thật vào ra ───────── */}
      <SectionCard
        title={`Tiền thật vào ra · ${period.label}`}
        description="Theo ngày ngân hàng ghi, đã loại chuyển nội bộ"
        hint="Chuyển giữa hai tài khoản của mình bị LOẠI khỏi cả tiền vào và tiền ra: tính vào thì cùng một đồng vừa là tiền ra vừa là tiền vào, chênh lệch vẫn đúng nhưng hai con số tổng đều bị thổi phồng và người đọc tưởng shop quay vòng gấp đôi thực tế."
        actions={
          <Link href={withPeriod("/reports/cashflow")} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Báo cáo dòng tiền đầy đủ <ArrowRight className="size-3" />
          </Link>
        }
      >
        {!statement.hasData ? (
          <p className="text-sm text-muted-foreground">
            Kỳ này <span className="font-medium text-foreground">chưa có giao dịch ngân hàng nào</span> — các số dưới đây là CHƯA NHẬP, không phải 0đ. Nhập sao kê hoặc nối SePay ở{" "}
            <Link href="/bank?tab=nhap-sao-ke" className="font-medium text-primary hover:underline">
              Sổ ngân hàng
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Tiền vào"
              value={<Money value={statement.moneyIn} />}
              change={pct(statement.moneyIn, statement.previous?.moneyIn ?? null)}
              note={`${formatNumber(statement.txnCount)} giao dịch trong kỳ`}
              icon={TrendingUp}
              tone="green"
              href={withPeriod("/bank?tab=giao-dich&direction=IN")}
            />
            <MetricCard
              label="Tiền ra"
              value={<Money value={statement.moneyOut} />}
              change={pct(statement.moneyOut, statement.previous?.moneyOut ?? null)}
              changeLabel="so với kỳ trước — tăng là xấu"
              icon={TrendingDown}
              tone="rose"
              href={withPeriod("/bank?tab=giao-dich&direction=OUT")}
            />
            <MetricCard
              label="Dòng tiền ròng"
              value={<Money value={statement.net} sign />}
              note={statement.net < 0 ? "Kỳ này tiêu nhiều hơn thu" : "Kỳ này thu nhiều hơn tiêu"}
              icon={Banknote}
              tone={statement.net < 0 ? "rose" : "green"}
              href={withPeriod("/reports/cashflow")}
            />
            <MetricCard
              label="Số dư cuối kỳ"
              value={statement.closing === null ? <span className="text-muted-foreground">Chưa biết</span> : <Money value={statement.closing} />}
              note={
                statement.opening === null
                  ? "Chưa có mốc số dư đầu kỳ để đối chiếu"
                  : `Đầu kỳ ${formatVND(statement.opening)} · ${BALANCE_CONFIDENCE_LABEL[statement.closingConfidence]}`
              }
              hint="Đầu kỳ + tổng phát sinh phải BẰNG cuối kỳ. Đây là một phép KIỂM, không phải cách trình bày: lệch nghĩa là sổ thiếu hoặc trùng giao dịch, và mọi con số tiền của kỳ đều sai theo đúng chừng đó."
              icon={Landmark}
              tone={statement.integrityGap ? "amber" : "slate"}
              href={withPeriod("/reports/cashflow")}
            />
          </div>
        )}
        {statement.integrityGap !== null && statement.integrityGap !== 0 ? (
          <p className="mt-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-5">
            <span className="font-semibold">Sổ ngân hàng lệch {formatVND(Math.abs(statement.integrityGap))} trong kỳ.</span>{" "}
            {statement.integrityGap > 0
              ? "ERP cộng được NHIỀU hơn mức ngân hàng thật sự đổi — sổ đang thiếu một khoản tiền ra, hoặc thừa một dòng tiền vào (nhập sao kê hai lần)."
              : "ERP cộng được ÍT hơn mức ngân hàng thật sự đổi — sổ đang thiếu một khoản tiền vào, hoặc thừa một dòng tiền ra."}{" "}
            <Link href="/bank?tab=doi-chieu" className="font-medium text-primary hover:underline">
              Mở trang đối chiếu
            </Link>
          </p>
        ) : null}
      </SectionCard>

      {/* ───────── 3. KINH DOANH ───────── */}
      <SectionCard
        title={`Kinh doanh · ${period.label}`}
        description="Đo theo kỳ hưởng lợi ích — đơn giao trong kỳ, dù tiền về kỳ sau"
        hint="KHÁC CƠ SỞ với khối tiền ở trên, và đó là chủ đích. Doanh thu ở đây là của đơn ĐÃ GIAO THÀNH CÔNG theo ORDER_OUTCOME (chứng từ ĐVVC trước, tiền thực thu sau) — không phải tiền đã về tài khoản. Hai khối không bao giờ bằng nhau; khối 'Lợi nhuận ≠ tiền' bên dưới giải thích vì sao."
        actions={
          <Link href={withPeriod("/reports")} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Báo cáo lợi nhuận <ArrowRight className="size-3" />
          </Link>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Doanh thu giao thành công"
            value={<Money value={truth.revenue.delivered} />}
            note={`${formatNumber(truth.revenue.deliveredOrders)} đơn · hoàn ${formatVND(truth.revenue.returned)}`}
            icon={Coins}
            tone="primary"
            href={withPeriod("/reports")}
          />
          <MetricCard
            label="Lợi nhuận góp"
            value={<Money value={truth.contribution} sign />}
            note="Sau giá vốn, cước, phí hoàn, quảng cáo — chưa trừ vận hành"
            icon={TrendingUp}
            tone={truth.contribution < 0 ? "rose" : "green"}
            href={withPeriod("/reports")}
          />
          <MetricCard
            label="Chi phí vận hành"
            value={<Money value={operating} />}
            change={pct(operating, r.previousOperating)}
            changeLabel="so với kỳ trước — tăng là xấu"
            note={`${formatNumber(costs.operatingCount)} khoản có chứng từ`}
            hint="Lấy qua cost-engine — MỘT đường duy nhất cho mọi báo cáo. Khoản nào có nguồn chuyên biệt (quảng cáo ở tài khoản QC, tiền hàng ở phiếu kho, cước ở vận đơn) KHÔNG được cộng lại ở đây, nếu không cùng một đồng bị trừ hai lần."
            icon={ReceiptText}
            tone="amber"
            href={withPeriod("/expenses?tab=bao-cao")}
          />
          <MetricCard
            label="Lợi nhuận ước tính"
            value={<Money value={truth.estimatedProfit} sign />}
            note={truth.realizedProfit === null ? "Lợi nhuận thực nhận: chưa đủ chứng từ" : `Thực nhận theo tiền: ${formatVND(truth.realizedProfit)}`}
            hint="ƯỚC TÍNH theo đơn trong kỳ. Có dòng chỉ đo được ở mức KỲ (quảng cáo, vận hành) nên không chia về từng đơn được. Lợi nhuận THỰC NHẬN chỉ tính khi kỳ đã có bảng kê ĐVVC — chưa có thì là CHƯA BIẾT, không phải 0."
            icon={HandCoins}
            tone={truth.estimatedProfit < 0 ? "rose" : "green"}
            href={withPeriod("/reports?tab=chan-ly")}
          />
        </div>
      </SectionCard>

      {/* ───────── 4. TIỀN CHƯA VỀ ───────── */}
      <SectionCard
        title="Tiền Viettel Post còn giữ"
        description={`Kỳ đối soát thông thường ${cod.overdueDays} ngày · trung vị thực tế ${cod.soNgayTraTB === null ? "chưa đo được" : `${cod.soNgayTraTB} ngày`}`}
        hint="Đây là khoản làm một shop bán COD 'lãi trên giấy mà hết tiền mặt': hàng đã tới tay khách nên doanh thu được ghi, còn tiền thì Viettel Post giữ cả tuần, trong khi tiền quảng cáo và tiền hàng phải trả ngay."
        actions={
          <Link href={withPeriod("/cod")} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Đối soát COD <ArrowRight className="size-3" />
          </Link>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Phải thu"
            value={<Money value={cod.phaiThu.amount} />}
            note={`${formatNumber(cod.phaiThu.count)} đơn giao thành công có thu hộ`}
            icon={PackageCheck}
            tone="slate"
            href={withPeriod("/cod")}
          />
          <MetricCard
            label="Bảng kê đã trả"
            value={<Money value={cod.daTra.amount} />}
            note={`${formatNumber(cod.daTra.count)} đơn có chứng từ tiền`}
            icon={Banknote}
            tone="green"
            href={withPeriod("/cod")}
          />
          <MetricCard
            label="Còn chưa về"
            value={<Money value={cod.conThieu} />}
            note={cod.uocTinh.count > 0 ? `${formatNumber(cod.uocTinh.count)} đơn còn tạm tính theo tiền khai báo` : "Đã có chứng từ cho toàn bộ"}
            icon={Wallet}
            tone={cod.conThieu > 0 ? "amber" : "slate"}
            href={withPeriod("/cod")}
          />
          <MetricCard
            label="Quá hạn — phải đi đòi"
            value={<Money value={cod.quaHan.amount} />}
            note={`${formatNumber(cod.quaHan.count)} đơn đã quá ${cod.overdueDays} ngày`}
            icon={TrendingDown}
            tone={cod.quaHan.amount > 0 ? "rose" : "slate"}
            href={withPeriod("/cod")}
          />
        </div>
        {cod.giaoNhungHoan.count > 0 ? (
          <p className="mt-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-5">
            <span className="font-semibold">
              {formatNumber(cod.giaoNhungHoan.count)} đơn Viettel Post báo &ldquo;giao thành công&rdquo; nhưng tiền thực thu dưới ngưỡng
            </span>{" "}
            — khai {formatVND(cod.giaoNhungHoan.khaiBao)}, thực thu {formatVND(cod.giaoNhungHoan.thucThu)}. Theo luật kết quả đơn, những đơn này là ĐƠN HOÀN.{" "}
            <Link href={withPeriod("/reports/returns")} className="font-medium text-primary hover:underline">
              Xem tỷ lệ giao thành công
            </Link>
          </p>
        ) : null}
      </SectionCard>

      {/* ───────── 5. LỢI NHUẬN ≠ TIỀN ───────── */}
      <SectionCard
        title="Vì sao lợi nhuận khác tiền"
        description="Hai con số đo hai thứ khác nhau — cả hai đều đúng"
        actions={
          <Link href={withPeriod("/reports/cashflow?tab=doi-chieu")} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Bảng đối chiếu đầy đủ <ArrowRight className="size-3" />
          </Link>
        }
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
          <div className="rounded-xl border bg-surface-sunken/40 p-4">
            <p className="text-[12.5px] font-medium text-muted-foreground">Lợi nhuận ước tính</p>
            <p className={cn("numeric mt-1 text-2xl font-bold", truth.estimatedProfit < 0 && "text-destructive")}>{formatVND(truth.estimatedProfit)}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Theo KỲ HƯỞNG LỢI ÍCH: đơn giao trong kỳ là doanh thu của kỳ, dù tiền về kỳ sau.</p>
          </div>
          <div className="flex items-center justify-center text-muted-foreground">
            <span className="rounded-full border bg-card px-2 py-1 text-[11px] font-semibold">≠</span>
          </div>
          <div className="rounded-xl border bg-surface-sunken/40 p-4">
            <p className="text-[12.5px] font-medium text-muted-foreground">Dòng tiền ròng thật</p>
            <p className={cn("numeric mt-1 text-2xl font-bold", statement.hasData && statement.net < 0 && "text-destructive")}>
              {statement.hasData ? formatVND(statement.net) : "Chưa biết"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Theo NGÀY TIỀN ĐỘNG: tiền COD tháng này có thể là của đơn giao tháng trước.</p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

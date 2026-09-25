import { Flag, Scale, Target, Wallet } from "lucide-react";
import Link from "next/link";
import { MetricCard } from "@/components/metric-card";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { PageHeader } from "@/components/page-header";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";
import {
  baseline,
  buildScenarios,
  clampTargetLevers,
  DEFAULT_TARGET_STEPS,
  NO_LEVERS,
  skuUnit,
  soloOrdersPerDay,
  solveScenario,
  type SkuUnit,
  type TargetLevers,
} from "@/lib/constants/profit-target";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { getProfitTargetData } from "@/lib/queries/profit-target";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Kế hoạch mục tiêu lợi nhuận" };
export const dynamic = "force-dynamic";

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}
function many(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.split(",")).filter(Boolean);
}
/** Ô trống = chưa nhập (`null`), KHÔNG phải 0 — mục tiêu 0 ₫ là một đích có thật. */
function soHoacNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
/** Đơn/ngày giữ một chữ số lẻ: 2,4 đơn/ngày khác 2 đơn/ngày khi nhân lên cả tháng. */
const don = (x: number | null) => (x === null ? "—" : x.toLocaleString("vi-VN", { maximumFractionDigits: 1 }));
const lan = (x: number | null) => (x === null ? "—" : `×${x.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}`);

export default async function ProfitTargetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { decision } = await requireResource("REPORTS", "reports:nominal");
  if (decision.allow === "NONE") return <ScopeDenied title="Kế hoạch mục tiêu lợi nhuận" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const period = resolvePeriod(raw, "30d");
  const data = await getProfitTargetData(period);

  const trieu = soHoacNull(one(raw.muctieu));
  // Đích là QUYẾT ĐỊNH của chủ shop (AGENTS.md mục 38): không có số mặc định, ô trống thì chưa giải.
  const target = trieu === null ? null : Math.round(trieu * 1_000_000);
  const steps = clampTargetLevers({
    gtcPoints: soHoacNull(one(raw.buoc_gtc)) ?? DEFAULT_TARGET_STEPS.gtcPoints,
    cpoPercent: soHoacNull(one(raw.buoc_cpo)) ?? DEFAULT_TARGET_STEPS.cpoPercent,
    pricePercent: soHoacNull(one(raw.buoc_gia)) ?? DEFAULT_TARGET_STEPS.pricePercent,
  });
  const custom = clampTargetLevers({ gtcPoints: soHoacNull(one(raw.gtc)) ?? 0, cpoPercent: soHoacNull(one(raw.cpo)) ?? 0, pricePercent: soHoacNull(one(raw.gia)) ?? 0 });
  // Đã bấm "Tính" (`chon=1`) thì lấy ĐÚNG các ô đã tick, kể cả khi bỏ hết; chưa bấm thì gợi ý mã đang lãi.
  const selected = new Set(one(raw.chon) === "1" ? many(raw.ma) : data.defaultSelected);
  const days = data.periodDays;

  const periodHidden = (
    <>
      <input type="hidden" name="period" value={period.key} />
      {period.key === "custom" && period.fromKey ? <input type="hidden" name="from" value={period.fromKey} /> : null}
      {period.key === "custom" && period.toKey ? <input type="hidden" name="to" value={period.toKey} /> : null}
    </>
  );

  if (!days) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Tài chính" title="Kế hoạch mục tiêu lợi nhuận" />
        <DataTableToolbar period={{ defaultKey: "30d" }} />
        <EmptyState icon={Target} title="Chưa có kỳ gốc để quy về một tháng" description="Kỳ “Toàn bộ” không có ngày bắt đầu nên không tính được mỗi ngày bán bao nhiêu. Chọn “30 ngày qua” hoặc một khoảng ngày cụ thể." />
      </div>
    );
  }

  const chosen = data.skus.filter((s) => selected.has(s.productId));
  const base = baseline(chosen, data.shopNetProfit, data.fixedInPeriod, days);
  const unitsOf = (lv: TargetLevers) => chosen.map((s) => skuUnit(s, data.assumptions, lv, days)).filter((u): u is SkuUnit => u !== null);
  const scenarios = buildScenarios(steps, custom).map((sc) => ({ ...sc, units: unitsOf(sc.levers) }));
  const solved = target === null ? [] : scenarios.map((sc) => ({ ...sc, r: solveScenario(sc.units, base, target, sc.levers) }));
  const ksKey = one(raw.ks) || "giu";
  const focus = solved.find((s) => s.key === ksKey) ?? solved[0];
  const baseUnits = unitsOf(NO_LEVERS);
  const monthNow = baseUnits.reduce((t, u) => t + u.ordersPerDay, 0);
  const gridG = [-steps.gtcPoints, 0, steps.gtcPoints, 2 * steps.gtcPoints];
  const gridC = [2 * steps.cpoPercent, steps.cpoPercent, 0, -steps.cpoPercent, -2 * steps.cpoPercent];
  const keepQuery = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(raw)) for (const x of Array.isArray(v) ? v : v ? [v] : []) q.append(k, x);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `/reports/target?${q.toString()}`;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Kế hoạch mục tiêu lợi nhuận"
        hint="Đặt mục tiêu LN ròng mỗi tháng, bảng giải ngược ra số đơn và ngân sách quảng cáo mỗi ngày cần có, theo từng kịch bản. Điểm xuất phát lấy nguyên dòng mã của Báo cáo lợi nhuận danh nghĩa trong kỳ gốc — kịch bản “giữ nguyên” ra đúng lợi nhuận báo cáo tính theo giá vốn THẬT (không dùng giá vốn dự tính đặt tay, nên mã chưa có giá vốn mang ⚠). Đây là phép tính KẾ HOẠCH (để đạt đích thì cần), không phải dự báo."
      />
      <DataTableToolbar period={{ defaultKey: "30d" }} resultLabel={<span className="text-xs text-muted-foreground">Kỳ gốc: {period.label} · {formatNumber(days)} ngày</span>} />

      <SectionCard title="Đặt mục tiêu" hint="Mục tiêu là LN ròng danh nghĩa ước tính của CẢ SHOP mỗi tháng (30 ngày), sau mọi chi phí — cùng dòng “Lợi nhuận danh nghĩa” của báo cáo. Bước kịch bản là cỡ bước để so sánh, sửa tuỳ ý.">
        <form method="get" className="space-y-4">
          {periodHidden}
          <input type="hidden" name="chon" value="1" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <O label="Mục tiêu LN ròng / tháng (triệu ₫)" name="muctieu" value={trieu === null ? "" : String(trieu)} placeholder="vd 100" strong />
            <O label="Bước TL GTC (điểm %)" name="buoc_gtc" value={String(steps.gtcPoints)} />
            <O label="Bước CPO (%)" name="buoc_cpo" value={String(steps.cpoPercent)} />
            <O label="Bước giá bán (%)" name="buoc_gia" value={String(steps.pricePercent)} />
          </div>
          <details className="rounded-lg border px-3 py-2 text-sm" open={Boolean(custom.gtcPoints || custom.cpoPercent || custom.pricePercent)}>
            <summary className="cursor-pointer font-medium">Kịch bản của bạn (tuỳ chọn)</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <O label="TL GTC đổi (điểm %)" name="gtc" value={custom.gtcPoints ? String(custom.gtcPoints) : ""} placeholder="vd 8" />
              <O label="CPO đổi (%)" name="cpo" value={custom.cpoPercent ? String(custom.cpoPercent) : ""} placeholder="vd -15" />
              <O label="Giá bán đổi (%)" name="gia" value={custom.pricePercent ? String(custom.pricePercent) : ""} placeholder="vd 5" />
            </div>
          </details>
          <div>
            <div className="mb-1.5 flex items-center gap-1 text-[13px] font-medium">
              Mã đưa vào kế hoạch
              <InfoHint>Chọn sẵn: mã đang LÃI (LN ròng &gt; 0) và đã đo được TL GTC trong kỳ gốc. Bỏ tick mã không muốn đẩy; mã không chọn giữ nguyên lãi/lỗ như hiện tại.</InfoHint>
            </div>
            <div className="grid max-h-56 gap-1 overflow-auto rounded-lg border p-2 text-[12.5px] sm:grid-cols-2 xl:grid-cols-3">
              {data.skus.map((s) => (
                <label key={s.productId} className={cn("flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted", s.deliveryRate === null && "opacity-60")}>
                  <input type="checkbox" name="ma" value={s.productId} defaultChecked={selected.has(s.productId)} disabled={s.deliveryRate === null} />
                  <span className="min-w-0 flex-1 truncate">{s.code || s.name}</span>
                  <span className="numeric text-muted-foreground">{formatVND((s.netProfit * 30) / days, { compact: true })}/th</span>
                </label>
              ))}
              {data.skus.length === 0 ? <span className="text-muted-foreground">Không có mã nào có đơn trong kỳ gốc.</span> : null}
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit">Tính kịch bản</Button>
            <Button asChild variant="ghost">
              <a href="/reports/target">Đặt lại</a>
            </Button>
          </div>
        </form>
      </SectionCard>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="LN ròng / tháng hiện tại" value={formatVND(base.shopMonthly, { compact: true })} note={`cả shop · theo nhịp ${period.label.toLowerCase()}`} icon={Wallet} tone="blue" />
        <MetricCard label="Mục tiêu / tháng" value={target === null ? "—" : formatVND(target, { compact: true })} note={target === null ? "Nhập mục tiêu ở trên" : `còn thiếu ${formatVND(target - base.shopMonthly, { compact: true })}`} icon={Flag} tone="primary" />
        <MetricCard
          label="Lãi góp các mã chọn / tháng"
          value={formatVND(base.selectedContributionMonthly, { compact: true })}
          hint="Trước chi phí cố định. Phần còn lại (mã không chọn, QC chưa ghép mã…) giữ nguyên."
          note={`${chosen.length} mã · ${don(monthNow)} đơn/ngày · còn lại ${formatVND(base.restMonthly, { compact: true })}`}
          icon={Target}
          tone="amber"
        />
        <MetricCard label="Chi phí cố định / tháng" value={formatVND(base.fixedMonthly, { compact: true })} hint="Vận hành đã nhập (lương, mặt bằng, phần mềm…) + chi phí cố định ở Giả định. Giả định không tăng theo số đơn." note="không tăng khi tăng đơn" icon={Scale} tone="rose" />
      </section>

      {target === null ? (
        <EmptyState icon={Target} title="Chưa có mục tiêu" description="Nhập mục tiêu LN ròng mỗi tháng (triệu đồng) rồi bấm “Tính kịch bản”." />
      ) : chosen.length === 0 ? (
        <EmptyState icon={Target} title="Chưa chọn mã nào" description="Tick ít nhất một mã ở ô “Mã đưa vào kế hoạch”." />
      ) : (
        <>
          <SectionCard
            title="Các kịch bản để đạt mục tiêu"
            description={`Mục tiêu ${formatVND(target, { compact: true })}/tháng · hiện ${don(monthNow)} đơn/ngày trên ${chosen.length} mã chọn`}
            hint="Mỗi dòng: giữ tỷ trọng giữa các mã như hiện tại, nhân số đơn lên bao nhiêu lần thì LN ròng tháng chạm đích. “LN tháng nếu giữ số đơn” = chỉ đổi đòn bẩy mà không bán thêm. CPO giữ như kịch bản ghi — thực tế đẩy ngân sách thường làm CPO tăng, xem dòng “Rủi ro”. Bấm tên kịch bản để xem kế hoạch từng mã."
            padded={false}
          >
            <div className="flex px-5 pt-3">
              <DataWarnings items={data.warnings} />
            </div>
            <div className="overflow-x-auto">
              <Table className="min-w-[980px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Kịch bản</TableHead>
                    <TableHead className="text-right" title="Lãi góp bình quân mỗi đơn lên của các mã chọn, trước chi phí cố định">Lãi góp/đơn</TableHead>
                    <TableHead className="text-right" title="LN ròng cả shop mỗi tháng nếu GIỮ số đơn như hiện tại, chỉ đổi đòn bẩy">LN tháng nếu giữ số đơn</TableHead>
                    <TableHead className="text-right" title="Số đơn cần có so với hiện tại">Cần gấp</TableHead>
                    <TableHead className="text-right">Đơn/ngày cần</TableHead>
                    <TableHead className="text-right" title="Đơn/ngày cần × CPO của kịch bản">QC/ngày cần</TableHead>
                    <TableHead className="text-right" title="Doanh thu giao thành công ước tính mỗi tháng khi đạt số đơn cần">DT GTC ƯT/tháng</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {solved.map((s) => (
                    <TableRow key={s.key} className={cn(focus?.key === s.key && "bg-primary/5")}>
                      <TableCell className="font-medium">
                        <Link href={keepQuery({ ks: s.key })} scroll={false} className="hover:underline">
                          {s.label}
                        </Link>
                      </TableCell>
                      <TableCell className="numeric text-right">{formatVND(s.r.contributionPerOrder)}</TableCell>
                      <TableCell className="numeric text-right">{formatVND(s.r.profitAtCurrentVolume)}</TableCell>
                      <TableCell className="numeric text-right font-semibold">{s.r.multiplier === null ? <KhongDat /> : lan(s.r.multiplier)}</TableCell>
                      <TableCell className="numeric text-right font-semibold">{don(s.r.ordersPerDay)}</TableCell>
                      <TableCell className="numeric text-right">{formatVND(s.r.adPerDay)}</TableCell>
                      <TableCell className="numeric text-right">{formatVND(s.r.revenueMonthly, { compact: true })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>

          <SectionCard
            title="Bảng độ nhạy: đơn/ngày cần theo TL GTC × CPO"
            description="Giá bán giữ nguyên · giữ tỷ trọng giữa các mã"
            hint="Mỗi ô: tổng số đơn/ngày của các mã chọn cần có để chạm đích, khi TL GTC đổi theo hàng và CPO đổi theo cột. “Không đạt” = ở mức ấy mỗi đơn đang lỗ, bán thêm chỉ làm xa đích hơn."
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>TL GTC \ CPO</TableHead>
                    {gridC.map((c) => (
                      <TableHead key={c} className="text-right">
                        {c === 0 ? "CPO như nay" : `CPO ${c > 0 ? "+" : "−"}${Math.abs(c)}%`}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gridG.map((g) => (
                    <TableRow key={g}>
                      <TableCell className="font-medium">{g === 0 ? "GTC như nay" : `GTC ${g > 0 ? "+" : "−"}${Math.abs(g)} điểm`}</TableCell>
                      {gridC.map((c) => {
                        const lv = { gtcPoints: g, cpoPercent: c, pricePercent: 0 };
                        const r = solveScenario(unitsOf(lv), base, target, lv);
                        return (
                          <TableCell key={c} className={cn("numeric text-right", g === 0 && c === 0 && "font-bold")}>
                            {r.ordersPerDay === null ? <KhongDat /> : don(r.ordersPerDay)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>

          {focus ? (
            <SectionCard
              title={`Kế hoạch từng mã · ${focus.label}`}
              description="Bấm tên một kịch bản ở bảng trên để đổi"
              hint="“Cần/ngày” giữ tỷ trọng giữa các mã như hiện tại. “Một mình gánh” = nếu chỉ đẩy riêng mã này (các mã khác giữ nguyên) thì mã này cần bao nhiêu đơn/ngày. “SP cần/tháng” = số sản phẩm gửi đi mỗi tháng ở mức cần, so với tồn thực tế theo Sổ kho."
              padded={false}
            >
              <div className="overflow-x-auto">
                <Table className="min-w-[980px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã</TableHead>
                      <TableHead className="text-right">TL GTC</TableHead>
                      <TableHead className="text-right">CPO</TableHead>
                      <TableHead className="text-right">Lãi góp/đơn</TableHead>
                      <TableHead className="text-right">Đơn/ngày nay</TableHead>
                      <TableHead className="text-right">Cần/ngày</TableHead>
                      <TableHead className="text-right">QC/ngày cần</TableHead>
                      <TableHead className="text-right">Một mình gánh</TableHead>
                      <TableHead className="text-right">SP cần/tháng · tồn</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {focus.units.map((u) => {
                      const ps = focus.r.perSku.find((x) => x.productId === u.sku.productId);
                      const solo = soloOrdersPerDay(u, focus.units, base, target);
                      const thieuTon = ps?.itemsMonthlyNeeded != null && ps.stockQty !== null && ps.itemsMonthlyNeeded > ps.stockQty;
                      return (
                        <TableRow key={u.sku.productId}>
                          <TableCell className="font-medium">
                            {u.sku.code || u.sku.name}
                            {u.sku.cogsIncomplete ? <span title="Còn sản phẩm chưa có giá vốn — lãi góp đang cao hơn thật"> ⚠</span> : null}
                          </TableCell>
                          <TableCell className="numeric text-right">{formatPercent(u.gtc * 100)}</TableCell>
                          <TableCell className="numeric text-right">{formatVND(u.cpo)}</TableCell>
                          <TableCell className="numeric text-right">{formatVND(u.contributionPerOrder)}</TableCell>
                          <TableCell className="numeric text-right">{don(u.ordersPerDay)}</TableCell>
                          <TableCell className="numeric text-right font-semibold">{ps?.ordersPerDayNeeded == null ? <KhongDat /> : don(ps.ordersPerDayNeeded)}</TableCell>
                          <TableCell className="numeric text-right">{formatVND(ps?.adPerDayNeeded ?? null)}</TableCell>
                          <TableCell className="numeric text-right">{solo === null ? <span className="text-muted-foreground" title="Mã đang lỗ mỗi đơn — bán thêm không giúp">lỗ/đơn</span> : don(solo)}</TableCell>
                          <TableCell className="numeric text-right">
                            {ps?.itemsMonthlyNeeded == null ? "—" : formatNumber(Math.round(ps.itemsMonthlyNeeded))} ·{" "}
                            <span className={cn(thieuTon && "font-semibold text-amber-600 dark:text-amber-400")} title={ps?.stockQty === null ? "Chưa có phiếu nhập — tồn chưa biết" : thieuTon ? "Tồn hiện tại không đủ cho một tháng ở mức cần" : undefined}>
                              {ps?.stockQty == null ? "tồn —" : `tồn ${formatNumber(ps.stockQty)}`}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {focus.units.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                          Không có mã nào tính được (chưa đo được TL GTC).
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}

function KhongDat() {
  return (
    <span className="text-muted-foreground" title="Mỗi đơn đang lỗ ở mức này — tăng đơn chỉ làm xa đích hơn">
      không đạt
    </span>
  );
}

function O({ label, name, value, placeholder = "", strong }: { label: string; name: string; value: string; placeholder?: string; strong?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className={cn("text-[13px]", strong ? "font-semibold" : "font-medium")}>{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={value}
        step="any"
        placeholder={placeholder}
        className="numeric h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
    </label>
  );
}

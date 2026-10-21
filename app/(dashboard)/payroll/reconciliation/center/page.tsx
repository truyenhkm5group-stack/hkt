import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { DEPARTMENT_LABEL } from "@/lib/constants/departments";
import { monthKeyOf } from "@/lib/constants/payroll-carryover";
import { formatVND } from "@/lib/format";
import { COD_GAP_CAUSE_LABEL, issueOwner, reconCenterDefaultRange, type CodGapCause } from "@/lib/payroll/recon-center";
import { COGS_GAP_CAUSE_LABEL, getReconCenter } from "@/lib/queries/payroll-recon-center";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";
import type { SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Trung tâm đối soát lương" };

const v = (n: number | null | undefined) => formatVND(n ?? null);
const phanTram = (x: number | null) => (x === null ? "—" : `${(x * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`);
const THANG = /^\d{4}-(0[1-9]|1[0-2])$/;
const lui = (monthKey: string, n: number) => {
  const [y, m] = monthKey.split("-").map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const linkThang = (m: string) => {
  const p = monthPeriod(m);
  return `/payroll/reconciliation?period=custom&from=${p.fromKey}&to=${p.toKey}`;
};

/**
 * ═══ TRUNG TÂM ĐỐI SOÁT LƯƠNG (Payroll V2, chủ shop 20/10/2026) ═══
 *
 * Đặc tả `docs/payroll-code-ledger.md` §10. Mọi số lấy từ `getReconCenter` — trang không cộng trừ thêm.
 * Ba khối: khoản ĐÃ tự đối soát (dữ liệu nguồn đủ, máy kết luận) · khoản CHƯA đối soát kèm phòng chịu
 * trách nhiệm, nguyên nhân, hành động · MỘT danh sách phê duyệt cho mọi quyết định chỉ người làm được.
 * Không có nút nào ghi số: số dư mở sổ, giá vốn, phân công đều khai ở đúng màn hình sở hữu chúng.
 */
export default async function PayrollReconCenterPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  const nay = monthKeyOf(new Date());
  const toMonth = typeof raw.to === "string" && THANG.test(raw.to) && raw.to <= nay ? raw.to : nay;
  const fromRaw = typeof raw.from === "string" && THANG.test(raw.from) ? raw.from : reconCenterDefaultRange(toMonth).fromMonth;
  const fromMonth = fromRaw > toMonth ? toMonth : fromRaw < lui(toMonth, 11) ? lui(toMonth, 11) : fromRaw;
  const c = await getReconCenter(fromMonth, toMonth);

  const tuDoiSoat = c.months.flatMap((m) => m.recon.lines.filter((l) => (l.status === "MATCHED" || l.status === "EXPLAINED") && (l.basis ?? l.source ?? 0) !== 0).map((l) => ({ month: m.monthKey, l })));
  const chuaDoiSoat = c.months.flatMap((m) => m.recon.issues.map((i) => ({ month: m.monthKey, i })));
  const dat = c.months.filter((m) => m.recon.status === "RECONCILED").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Trung tâm đối soát lương"
        description={`Tháng ${fromMonth} → ${toMonth}: ${dat}/${c.months.length} tháng đối soát đủ. Khoản có dữ liệu nguồn được tự đối soát; khoản còn lại có phòng chịu trách nhiệm và việc cần làm; mọi quyết định gom vào một danh sách phê duyệt. Trang này không ghi số nào.`}
      />
      <PayrollTabs canManage />
      <form className="flex flex-wrap items-end gap-2 text-sm" method="get">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Từ tháng</span>
          <input name="from" defaultValue={fromMonth} className="h-8 w-[110px] rounded border px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Tới tháng</span>
          <input name="to" defaultValue={toMonth} className="h-8 w-[110px] rounded border px-2" />
        </label>
        <button className="h-8 rounded border px-3">Xem</button>
        <span className="text-xs text-muted-foreground">Tối đa 12 tháng · đầu kỳ dữ liệu: đơn {c.dataStart.orders ?? "—"} · quảng cáo {c.dataStart.ads ?? "—"} · chi phí {c.dataStart.expenses ?? "—"}</span>
      </form>

      <SectionCard title={`Danh sách phê duyệt — ${c.approvals.length} mục`} description="MỘT danh sách cho mọi quyết định nghiệp vụ còn lại. «Quyết» = người có quyền phải chọn; «Bổ sung» = phòng phải đưa chứng từ / dữ liệu ERP chưa có. ERP không tự chốt mục nào.">
        {c.approvals.length === 0 ? (
          <EmptyState title="Không còn quyết định nào chờ" description="Mọi khoản của khoảng tháng này đã có căn cứ." />
        ) : (
          <ol className="space-y-2 text-sm">
            {c.approvals.map((a, idx) => (
              <li key={a.key} className={cn("rounded border px-3 py-2", a.kind === "DECIDE" ? "border-amber-300" : "border-sky-300")}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs text-muted-foreground">{idx + 1}.</span>
                  <b>{a.title}</b>
                  <span className="text-xs">{a.kind === "DECIDE" ? "Quyết" : "Bổ sung"} · {DEPARTMENT_LABEL[a.owner]}</span>
                  {a.amount !== null ? <span className="tabular-nums text-xs">{v(a.amount)}</span> : null}
                  <Link href={a.href} className="ml-auto text-primary hover:underline">
                    mở →
                  </Link>
                </div>
                <div className="text-xs text-muted-foreground">Nguyên nhân: {a.cause}</div>
                <div className="text-xs">Việc cần làm: {a.action}</div>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      <SectionCard title="Theo tháng" description="Doanh thu KẾ TOÁN (đã giao) ≠ tiền thực nhận. Phải thu = đã giao mà chưa có chứng từ tiền — CHƯA XÁC MINH, không phải mất.">
        <TableToolsFor tableId="payroll-recon-center-months" />
        <div className="overflow-x-auto">
          <table id="payroll-recon-center-months" className="w-full min-w-[1080px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Tháng · trạng thái</th>
                <th className="py-1 pr-3 text-right font-medium">DT có chứng từ · đơn có KQ · chi phí khớp</th>
                <th className="py-1 pr-3 text-right font-medium">Doanh thu kế toán</th>
                <th className="py-1 pr-3 text-right font-medium">Phải thu chưa xác minh</th>
                <th className="py-1 pr-3 text-right font-medium">Tiền thực nhận · COD ĐVVC đang giữ</th>
                <th className="py-1 font-medium">Thưởng LN đủ ĐK · ký cấp 1</th>
              </tr>
            </thead>
            <tbody>
              {c.months.map((m) => (
                <tr key={m.monthKey} className="border-t align-top">
                  <td className="py-1.5 pr-3">
                    <Link href={linkThang(m.monthKey)} className="font-medium hover:text-primary hover:underline">
                      {m.monthKey}
                    </Link>
                    <div className={cn("text-xs", m.recon.status === "RECONCILED" ? "text-emerald-700" : "text-rose-700")}>{m.recon.status === "RECONCILED" ? "Đã đối soát đủ" : `Chưa — ${m.recon.issues.length} khoản`}</div>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {phanTram(m.recon.coverage.revenueWithMoneyPct)} · {phanTram(m.recon.coverage.revenueSettledPct)} · {phanTram(m.recon.coverage.costReconciledPct)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {v(m.cod.accounting.revenue)}
                    <div className="text-xs text-muted-foreground">{m.cod.accounting.orders.toLocaleString("vi-VN")} đơn</div>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {v(m.cod.receivable.revenue)}
                    <div className="text-xs text-muted-foreground">
                      {m.cod.receivable.orders.toLocaleString("vi-VN")} đơn · quá 30 ngày {m.cod.receivable.age.over30.orders.toLocaleString("vi-VN")}
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {v(m.cod.cashReceived)}
                    <div className="text-xs text-muted-foreground">{v(m.cod.codHeldByCarrier)}</div>
                  </td>
                  <td className="py-1.5">
                    {v(m.eligibleBonus)} · {m.signed ? "đã ký" : m.eligibleBonus > 0 ? "CHƯA ký" : "không cần"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
          {c.months
            .filter((m) => m.cod.receivable.orders > 0)
            .map((m) => (
              <div key={m.monthKey} className="rounded border px-2 py-1.5">
                <b>{m.monthKey} · phải thu theo nguyên nhân:</b>{" "}
                {(Object.keys(COD_GAP_CAUSE_LABEL) as CodGapCause[])
                  .filter((k) => m.cod.receivable.byCause[k].orders > 0)
                  .map((k) => `${COD_GAP_CAUSE_LABEL[k]} ${m.cod.receivable.byCause[k].orders} đơn (${v(m.cod.receivable.byCause[k].revenue)})`)
                  .join(" · ")}
              </div>
            ))}
        </div>
      </SectionCard>

      <SectionCard title={`Khoản chưa đối soát — ${chuaDoiSoat.length}`} description="Mỗi khoản có phòng chịu trách nhiệm (phòng ban, không phải một người), nguyên nhân và chỗ sửa.">
        {chuaDoiSoat.length === 0 ? (
          <EmptyState title="Không còn khoản nào chưa đối soát" description="Mọi dòng của các tháng đã khớp nguồn hoặc có giải thích đo được." />
        ) : (
          <div className="overflow-x-auto">
            <table id="payroll-recon-center-issues" className="w-full min-w-[860px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Tháng</th>
                  <th className="py-1 pr-3 font-medium">Khoản · nguyên nhân</th>
                  <th className="py-1 pr-3 text-right font-medium">Số tiền · số mục</th>
                  <th className="py-1 pr-3 font-medium">Phòng</th>
                  <th className="py-1 font-medium">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {chuaDoiSoat.map(({ month, i }) => (
                  <tr key={`${month}:${i.code}`} className="border-t align-top">
                    <td className="py-1.5 pr-3">{month}</td>
                    <td className="py-1.5 pr-3">
                      {i.label}
                      <div className="max-w-[460px] text-xs text-muted-foreground">{c.months.find((m) => m.monthKey === month)?.recon.lines.find((l) => l.key === i.code)?.note ?? ""}</div>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {v(i.amount)}
                      {i.count !== null ? <div className="text-xs text-muted-foreground">{i.count.toLocaleString("vi-VN")} mục</div> : null}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{DEPARTMENT_LABEL[issueOwner(i.code)]}</td>
                    <td className="py-1.5">
                      {i.href ? (
                        <Link href={i.href} className="text-primary hover:underline">
                          mở chỗ sửa →
                        </Link>
                      ) : (
                        <Link href={linkThang(month)} className="text-primary hover:underline">
                          xem bảng tháng →
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={`Đề xuất số dư mở sổ tại ${c.opening.openingMonth} — ${c.opening.complete ? "đủ căn cứ" : "CHƯA ĐỦ CĂN CỨ"}`}
        description={`Lũy kế ĐO ĐƯỢC từ ${c.opening.dataStart ?? "—"}: doanh thu đã ghi nhận − chi phí đã ghi nhận − lương cứng có căn cứ chưa ghi nhận. KHÔNG cộng chi phí cố định giả định, định mức theo đơn hay lương của người chưa khai ngày vào làm. Đây là ĐỀ XUẤT — người có quyền khai quy chế cổng ở Lương → Cấu hình.`}
      >
        {c.opening.months.length === 0 ? (
          <EmptyState title="Không có tháng nào trước mốc mở sổ" description="Đầu kỳ dữ liệu trùng hoặc sau mốc mở sổ — số dư có căn cứ là 0 vì chưa có hoạt động nào được ghi." />
        ) : (
          <>
            <p className="mb-2 text-sm">
              Lũy kế đo được <b className="tabular-nums">{v(c.opening.measuredCumulative)}</b> · đỉnh <span className="tabular-nums">{v(c.opening.measuredHighWater)}</span>
              {c.opening.complete ? "" : ` · ${c.opening.incompleteMonths.length}/${c.opening.months.length} tháng còn thiếu căn cứ`}
            </p>
            <div className="overflow-x-auto">
              <table id="payroll-recon-center-opening" className="w-full min-w-[860px] text-[13px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Tháng</th>
                    <th className="py-1 pr-3 text-right font-medium">Doanh thu</th>
                    <th className="py-1 pr-3 text-right font-medium">Chi phí ghi nhận (trừ lương chưa có căn cứ)</th>
                    <th className="py-1 pr-3 text-right font-medium">Lương có căn cứ chưa ghi</th>
                    <th className="py-1 pr-3 text-right font-medium">LN đo được</th>
                    <th className="py-1 font-medium">Còn thiếu</th>
                  </tr>
                </thead>
                <tbody>
                  {c.opening.months.map((m) => (
                    <tr key={m.monthKey} className="border-t align-top">
                      <td className="py-1.5 pr-3">{m.monthKey}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(m.revenue)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(m.recognizedCost)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(m.salaryGapEvidenced)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(m.measuredProfit)}</td>
                      <td className="max-w-[420px] py-1.5 text-xs text-muted-foreground">{m.gaps.length ? m.gaps.join(" · ") : "đủ căn cứ"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard title={`Truy giá vốn — ${c.cogsGaps.length} mẫu mã`} description="Dòng đã giao đang tính giá vốn 0 (lợi nhuận ảo). Nguyên nhân đo được từ dữ liệu ERP; ERP KHÔNG tự đặt giá vốn — nhập giá ở phiếu nhập / Trung tâm giá vốn.">
        {c.cogsGaps.length === 0 ? (
          <EmptyState title="Không có dòng nào thiếu giá vốn" description="Mọi dòng đã giao của khoảng tháng này đều có giá vốn." />
        ) : (
          <div className="overflow-x-auto">
            <table id="payroll-recon-center-cogs" className="w-full min-w-[900px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Mã · mẫu mã</th>
                  <th className="py-1 pr-3 text-right font-medium">Dòng · SL</th>
                  <th className="py-1 pr-3 text-right font-medium">Doanh thu</th>
                  <th className="py-1 pr-3 font-medium">Nguyên nhân</th>
                  <th className="py-1 font-medium">Đơn để tra</th>
                </tr>
              </thead>
              <tbody>
                {c.cogsGaps.map((g) => (
                  <tr key={`${g.productId}:${g.variantId ?? "-"}`} className="border-t align-top">
                    <td className="py-1.5 pr-3">
                      <b>{g.code || g.productName}</b>
                      <div className="text-xs text-muted-foreground">{g.sku || g.variantId || "không có mẫu mã"}</div>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {g.lines} · {g.quantity}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v(g.revenue)}</td>
                    <td className="py-1.5 pr-3 text-xs">{COGS_GAP_CAUSE_LABEL[g.cause]}</td>
                    <td className="py-1.5 text-xs">
                      {g.sampleOrderIds.map((id) => (
                        <Link key={id} href={`/orders/${id}`} className="mr-2 text-primary hover:underline">
                          {id}
                        </Link>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title={`Đã tự đối soát — ${tuDoiSoat.length} dòng`} description="Dữ liệu nguồn đã có nên máy tự kết luận — không ai phải nhập lại. Vd phí chiều hoàn nối được về đơn gốc đã tự gắn vào mã.">
        <ul className="grid gap-1 text-xs md:grid-cols-2">
          {tuDoiSoat.map(({ month, l }) => (
            <li key={`${month}:${l.key}`} className="rounded border border-emerald-200 px-2 py-1">
              <b>{month}</b> · {l.label} · <span className="tabular-nums">{v(l.basis ?? l.source)}</span>
              <div className="text-muted-foreground">{l.note}</div>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

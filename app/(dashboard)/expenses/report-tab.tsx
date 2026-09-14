import Link from "next/link";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Landmark, Minus, ReceiptText, Users } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatVND } from "@/lib/format";
import { getExpenseReport } from "@/lib/queries/expense-report";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÁO CÁO CHI PHÍ ═══════════
 *
 * Tab "Danh sách" là SỔ GHI: nó phải hiện đủ mọi khoản đã gõ vào, kể cả khoản bị loại khỏi lợi
 * nhuận vì nguồn khác có thẩm quyền — lọc bớt ở đó thì người vừa nhập xong thấy khoản của mình
 * biến mất. Tab này là BÁO CÁO: nó chỉ hiện con số thật sự vào lợi nhuận, đã phân bổ theo kỳ và đã
 * áp luật thẩm quyền nguồn.
 *
 * Hai tab cùng một bảng dữ liệu và CỐ Ý ra hai con số khác nhau. Nhãn trên từng khối nói rõ cơ sở
 * đo, vì đây đúng là chỗ hai con số hợp lý bị đọc như một con số bị sai.
 */
export async function ExpenseReportTab({ period }: { period: Period }) {
  const r = await getExpenseReport(period);
  const deltaTong = r.recognizedPrevious === null ? null : r.recognized - r.recognizedPrevious;
  const pctTong = r.recognizedPrevious === null || r.recognizedPrevious === 0 ? null : ((r.recognized - r.recognizedPrevious) / r.recognizedPrevious) * 100;
  const dinhCaoNhat = r.trend.reduce<{ day: string; cashOut: number } | null>((max, p) => (!max || p.cashOut > max.cashOut ? p : max), null);

  return (
    <div className="space-y-5">
      {/* ───── Bốn con số dẫn dắt ───── */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Chi phí vận hành ghi nhận"
          value={<Money value={r.recognized} />}
          change={pctTong}
          changeLabel="so với kỳ trước — tăng là xấu"
          note={deltaTong === null ? "Kỳ không có biên để so" : `${deltaTong >= 0 ? "Tăng" : "Giảm"} ${formatVND(Math.abs(deltaTong))}`}
          hint="Lấy qua cost-engine — MỘT đường duy nhất cho mọi báo cáo. Đã phân bổ theo số ngày chồng lấn (tiền thuê cả tháng không dồn vào ngày ghi sổ) và đã loại khoản có nguồn chuyên biệt: quảng cáo ở tài khoản QC, tiền hàng ở phiếu kho, cước ở vận đơn. Cộng lại ở đây là trừ hai lần."
          icon={ReceiptText}
          tone="amber"
        />
        <MetricCard
          label="Nhóm tăng mạnh nhất"
          value={r.largestChanges[0] ? <Money value={Math.abs(r.largestChanges[0].delta ?? 0)} sign={false} /> : <span className="text-muted-foreground">—</span>}
          note={r.largestChanges[0] ? `${r.largestChanges[0].label} · ${(r.largestChanges[0].delta ?? 0) >= 0 ? "tăng" : "giảm"} so với kỳ trước` : "Chưa có biến động nào"}
          hint="Xếp theo SỐ TIỀN, không theo phần trăm. Một khoản 50.000đ thành 150.000đ là +200% và đứng đầu mọi bảng xếp theo phần trăm, còn khoản 40 triệu thành 52 triệu chỉ +30% — nhưng khoản thứ hai mới là khoản làm mất tiền."
          icon={r.largestChanges[0] && (r.largestChanges[0].delta ?? 0) >= 0 ? ArrowUpRight : ArrowDownRight}
          tone={r.largestChanges[0] && (r.largestChanges[0].delta ?? 0) > 0 ? "rose" : "slate"}
        />
        <MetricCard
          label="Ngày chi nhiều nhất"
          value={dinhCaoNhat && dinhCaoNhat.cashOut > 0 ? <Money value={dinhCaoNhat.cashOut} /> : <span className="text-muted-foreground">—</span>}
          note={dinhCaoNhat && dinhCaoNhat.cashOut > 0 ? dinhCaoNhat.day.split("-").reverse().join("/") : "Chưa có sao kê trong kỳ"}
          hint="TIỀN THẬT đã ra theo ngày ngân hàng ghi — khác cơ sở với con số ghi nhận bên trái. Một khoản thuê năm trả một lần nằm gọn trong một ngày ở đây và rải đều 365 ngày ở kia; cả hai đều đúng."
          icon={Landmark}
          tone="slate"
        />
        <MetricCard
          label="Tiền ra chưa phân loại"
          value={<Money value={r.unclassifiedOutflow.amount} />}
          note={`${formatNumber(r.unclassifiedOutflow.count)} giao dịch chưa biết thuộc chi phí nào`}
          hint="Tiền đã thật sự ra khỏi tài khoản nhưng chưa ai gán nhóm, nên CHƯA khoản chi nào trong báo cáo này có nó. Con số chi phí ở trên đang thiếu đúng chừng đó."
          icon={AlertTriangle}
          tone={r.unclassifiedOutflow.count > 0 ? "rose" : "slate"}
          href="/bank?tab=giao-dich&direction=OUT&unclassified=1"
        />
      </section>

      {/* ───── Biến động theo nhóm ───── */}
      <SectionCard
        title="Chi phí theo nhóm"
        description={`${period.label} · so với kỳ trước cùng độ dài`}
        hint="Cột 'Biến động' là lý do bảng này tồn tại: mức chi thì trang Danh sách đã nói, còn thứ đáng quyết định là khoản nào đang TĂNG. Ô '—' ở cột phần trăm nghĩa là kỳ trước bằng 0 nên KHÔNG so được — 'tăng 100%' hay 'tăng ∞%' đều là bịa."
        padded={false}
      >
        {!r.byCategory.length ? (
          <div className="p-5">
            <EmptyState
              icon={ReceiptText}
              title="Kỳ này chưa có khoản chi vận hành nào"
              description="Đây là CHƯA GHI, không phải 'kỳ này không tốn gì'. Quảng cáo và tiền hàng cố ý không xuất hiện ở đây vì chúng có nguồn chuyên biệt riêng."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Nhóm</TableHead>
                  <TableHead className="text-right">Kỳ này</TableHead>
                  <TableHead className="text-right">Kỳ trước</TableHead>
                  <TableHead className="text-right">Biến động</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Tỷ trọng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.byCategory.map((c) => (
                  <TableRow key={c.category}>
                    <TableCell>
                      <Link
                        href={`/expenses?category=${c.category}${period.key !== "all" ? `&period=${period.key}` : ""}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {c.label}
                      </Link>
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{formatNumber(c.count)} khoản</span>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      <Money value={c.amount} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{c.previous === null ? "—" : <Money value={c.previous} />}</TableCell>
                    <TableCell className={cn("text-right font-medium", c.delta !== null && c.delta > 0 && "text-rose-600 dark:text-rose-400", c.delta !== null && c.delta < 0 && "text-success")}>
                      {c.delta === null ? "—" : <Money value={c.delta} sign />}
                    </TableCell>
                    <TableCell className="numeric text-right text-xs text-muted-foreground">
                      {c.deltaPct === null ? (
                        <span title="Kỳ trước bằng 0 nên không so được bằng phần trăm">—</span>
                      ) : (
                        `${c.deltaPct >= 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%`
                      )}
                    </TableCell>
                    <TableCell className="numeric text-right text-xs text-muted-foreground">{c.share.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* ───── Tiền thật ra theo ngày ───── */}
      <SectionCard
        title="Tiền thật đã ra theo ngày"
        description="Theo ngày ngân hàng ghi — KHÁC cơ sở với bảng theo nhóm ở trên"
        hint="Cố ý dùng tiền thật thay vì chi phí đã phân bổ: một đường 'chi phí phân bổ theo ngày' thì PHẲNG theo thiết kế (tiền thuê chia đều mỗi ngày) nên không phát hiện được gì. Đường tiền thật có đỉnh, và đỉnh là thứ cần nhìn. Chuyển nội bộ, trả nợ gốc, rút vốn bị loại — chúng làm tài khoản vơi đi nhưng không phải chi phí."
        padded={false}
      >
        {!r.hasBankData ? (
          <div className="p-5">
            <EmptyState
              icon={Landmark}
              title="Kỳ này chưa có giao dịch ngân hàng nào"
              description={
                <>
                  Biểu đồ tiền thật cần sao kê. Nối SePay hoặc nhập sao kê ở{" "}
                  <Link href="/bank?tab=nhap-sao-ke" className="font-medium text-primary hover:underline">
                    Sổ ngân hàng
                  </Link>{" "}
                  thì phần này mới có số. Bảng theo nhóm ở trên vẫn đúng vì nó đọc từ bảng Chi phí.
                </>
              }
            />
          </div>
        ) : (
          <ExpenseTrendBars trend={r.trend} />
        )}
      </SectionCard>

      {/* ───── Trả cho ai ───── */}
      {r.topVendors.length ? (
        <SectionCard
          title="Trả cho ai nhiều nhất"
          description={`${period.label} · theo tên đối tác trên sao kê`}
          hint="Đọc từ ô tên đối tác của sao kê, nên chất lượng phụ thuộc cách ngân hàng ghi — cùng một nhà cung cấp có thể hiện thành hai dòng nếu chuyển khoản từ hai nơi khác nhau. Dùng để thấy tiền đi đâu, không dùng làm sổ công nợ."
          padded={false}
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[520px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Đối tác</TableHead>
                  <TableHead className="text-right">Đã trả</TableHead>
                  <TableHead className="text-right">Số lần</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.topVendors.map((v) => (
                  <TableRow key={v.counterparty}>
                    <TableCell className="font-medium">
                      <Users className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden />
                      {v.counterparty}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      <Money value={v.amount} />
                    </TableCell>
                    <TableCell className="numeric text-right text-xs text-muted-foreground">{formatNumber(v.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      {/* ───── Cảnh báo của cost-engine ───── */}
      {r.warnings.length ? (
        <SectionCard title="Cảnh báo về nguồn chi phí" description="Của cost-engine — lấy lại nguyên văn, không tự đánh giá lại">
          <ul className="space-y-3">
            {r.warnings.map((w) => (
              <li key={w.rule} className={cn("rounded-lg border px-3 py-2.5", w.severity === "high" ? "border-destructive/30 bg-destructive/5" : "border-warning/40 bg-warning/5")}>
                <p className="text-[13px] font-semibold">{w.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{w.detail}</p>
                <p className="mt-1 text-xs leading-5">
                  <span className="font-medium">Nên làm gì: </span>
                  {w.action}
                </p>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

/**
 * BIỂU ĐỒ CỘT DỰNG BẰNG CSS, không nạp thư viện vẽ.
 *
 * Đây là một chuỗi theo ngày, mỗi cột hai giá trị (tổng tiền ra và phần quảng cáo) — không cần
 * trục, không cần tương tác, không cần tooltip. Nạp cả một thư viện đồ thị cho việc này là thêm
 * JavaScript về máy người dùng để vẽ ra đúng thứ mà `div` có chiều cao tính theo phần trăm đã vẽ
 * được. Giá trị đọc được bằng `title` khi rê chuột, và mỗi cột có nhãn cho trình đọc màn hình.
 */
function ExpenseTrendBars({ trend }: { trend: { day: string; cashOut: number; ads: number }[] }) {
  const max = Math.max(...trend.map((p) => p.cashOut), 1);
  const tongRa = trend.reduce((t, p) => t + p.cashOut, 0);
  const tongQc = trend.reduce((t, p) => t + p.ads, 0);

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary/70" /> Tiền ra theo sao kê · {formatVND(tongRa)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-info/70" /> Trong đó quảng cáo (tài khoản QC) · {formatVND(tongQc)}
        </span>
      </div>
      <div className="flex h-36 items-end gap-[3px] overflow-x-auto pb-1">
        {trend.map((p) => {
          const h = Math.max(2, Math.round((p.cashOut / max) * 100));
          const hQc = p.cashOut > 0 ? Math.min(100, Math.round((p.ads / max) * 100)) : 0;
          return (
            <div
              key={p.day}
              className="group/bar relative flex min-w-[8px] flex-1 flex-col justify-end"
              title={`${p.day.split("-").reverse().join("/")}: tiền ra ${formatVND(p.cashOut)}${p.ads ? ` · quảng cáo ${formatVND(p.ads)}` : ""}`}
            >
              <span className="sr-only">
                {p.day}: {formatVND(p.cashOut)}
              </span>
              {/* Cột quảng cáo vẽ CHỒNG phía dưới cột tổng, không cộng thêm chiều cao. */}
              <div className="relative w-full rounded-t-sm bg-primary/70 transition-colors group-hover/bar:bg-primary" style={{ height: `${h}%` }}>
                {hQc > 0 ? <div className="absolute inset-x-0 bottom-0 rounded-t-sm bg-info/70" style={{ height: `${Math.min(100, Math.round((p.ads / Math.max(p.cashOut, 1)) * 100))}%` }} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      {trend.length ? (
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{trend[0].day.split("-").reverse().join("/")}</span>
          {trend.length > 1 ? <span>{trend[trend.length - 1].day.split("-").reverse().join("/")}</span> : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Minus className="size-3.5" /> Không có ngày nào phát sinh tiền ra trong kỳ.
        </p>
      )}
    </div>
  );
}

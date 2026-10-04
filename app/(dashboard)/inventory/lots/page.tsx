import Link from "next/link";
import { DeleteStockLotButton, StockLotForm } from "@/components/inventory/stock-lot-forms";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { LOT_EXPIRY_LABEL, LOT_WINDOW_OPTIONS, parseLotWindow } from "@/lib/constants/lots";
import { formatNumber, todayVN } from "@/lib/format";
import { lotBoard, lotItemOptions } from "@/lib/queries/stock-lots";

export const metadata = { title: "Lô & hạn dùng" };

/**
 * LÔ & HẠN DÙNG (module `lots`, 0199 · docs/verticals/food-lots.md) — lô đã hết hạn còn hàng (đỏ), lô cận hạn trong cửa sổ
 * người xem chọn, từng mẫu mã với thứ tự lấy hàng hạn gần trước, form gắn lô lên dòng phiếu nhập. Số «còn» là ƯỚC TÍNH: tồn
 * thực tế của sổ kho rải vào lô theo nhập trước xuất trước — lô không đổi một cái tồn nào.
 */

const showDay = (d: string) => d.split("-").reverse().join("/");
const left = (days: number) => (days < 0 ? `quá ${-days} ngày` : days === 0 ? "hết hạn hôm nay" : `còn ${days} ngày`);
const remainText = (n: number | null) => (n === null ? "—" : formatNumber(n));

export default async function StockLotsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("lots:view");
  const sp = await searchParams;
  const windowDays = parseLotWindow(sp.trong);
  const today = todayVN();
  const canWrite = can(user, "lots:write");
  const [board, options] = await Promise.all([lotBoard(today, windowDays), canWrite ? lotItemOptions(today) : Promise.resolve([])]);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Lô & hạn dùng"
        description={`${board.variants.length} mẫu mã có lô · ${board.expired.length} lô hết hạn còn hàng · ${board.near.length} lô cận hạn`}
        hint="Gắn mã lô và hạn dùng lên dòng phiếu nhập. Số «còn» của từng lô là ƯỚC TÍNH: tồn thực tế của sổ kho chia vào lô theo nhập trước xuất trước — lô không cộng, không trừ tồn. Hàng hết hạn phải huỷ thì lập phiếu xuất kho ở Nhập hàng & kiểm kê."
      />

      <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Cửa sổ cận hạn">
        <span className="text-muted-foreground">Cận hạn trong:</span>
        {LOT_WINDOW_OPTIONS.map((w) => (
          <Link key={w} href={`/inventory/lots?trong=${w}`} className={`rounded-md border px-2 py-0.5 ${w === windowDays ? "border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}>
            {w} ngày
          </Link>
        ))}
      </nav>

      {board.expired.length ? (
        <SectionCard title={`Đã hết hạn còn hàng · ${board.expired.length}`} description="Không bán. Huỷ hàng bằng phiếu xuất kho để tồn đúng." className="border-red-300 dark:border-red-800">
          <ul className="divide-y text-sm text-red-700 dark:text-red-300" data-lots-expired={board.expired.length}>
            {board.expired.map((x) => (
              <li key={x.id} className="py-1.5">
                <b>{x.variantLabel}</b> · lô {x.lotCode} · hạn {showDay(x.expiresOn)} ({left(x.daysLeft)}) · còn ước tính {remainText(x.remaining)}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title={`Cận hạn trong ${windowDays} ngày · ${board.near.length}`} description="Lấy trước, đẩy bán trước. Số còn là ước tính.">
        {board.near.length ? (
          <ul className="divide-y text-sm" data-lots-near={board.near.length}>
            {board.near.map((x) => (
              <li key={x.id} className="py-1.5">
                <b>{x.variantLabel}</b> · lô {x.lotCode} · hạn {showDay(x.expiresOn)} <span className="text-amber-700 dark:text-amber-300">({left(x.daysLeft)})</span> · còn ước tính {remainText(x.remaining)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Không có lô nào còn hàng sắp hết hạn trong {windowDays} ngày.</p>
        )}
      </SectionCard>

      {canWrite ? (
        <SectionCard title="Gắn lô cho phiếu nhập" description="Dòng phiếu đưa hàng vào kho trong 120 ngày gần nhất còn phần chưa gắn lô. Một dòng chia được nhiều lô.">
          {options.length ? (
            <StockLotForm options={options} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Không còn dòng phiếu nào chưa gắn lô.{" "}
              <Link href="/inventory/receipts" className="underline">
                Nhập hàng & kiểm kê
              </Link>
            </p>
          )}
        </SectionCard>
      ) : null}

      <SectionCard title="Theo mẫu mã" description="Lô xếp theo hạn gần nhất trước; số thứ tự là thứ tự lấy hàng. «Chưa gắn lô» là phần tồn nằm ở dòng nhập chưa khai lô.">
        {board.variants.length ? (
          <div className="space-y-4" data-lot-variants={board.variants.length}>
            {board.variants.map((v) => (
              <div key={v.variantId} className="space-y-1">
                <div className="text-sm">
                  <b>{v.label}</b>
                  <span className="text-muted-foreground"> · tồn thực tế {v.stockKnown ? formatNumber(v.onHand) : "chưa có phiếu nhập"}</span>
                  {v.untracked ? <span className="text-muted-foreground"> · chưa gắn lô {formatNumber(v.untracked)}</span> : null}
                  {v.unexplained ? <span className="text-muted-foreground"> · ngoài mọi dòng nhập {formatNumber(v.unexplained)}</span> : null}
                </div>
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-2">Lấy</th>
                      <th className="py-1 pr-2">Lô</th>
                      <th className="py-1 pr-2">Hạn dùng</th>
                      <th className="py-1 pr-2">Phiếu</th>
                      <th className="py-1 pr-2 text-right">Nhập</th>
                      <th className="py-1 pr-2 text-right">Còn (ước tính)</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {v.lots.map((x) => {
                      const order = v.pickOrder.indexOf(x.id);
                      const tone = x.state === "EXPIRED" ? "text-red-700 dark:text-red-300" : x.state === "NEAR" ? "text-amber-700 dark:text-amber-300" : "";
                      return (
                        <tr key={x.id} className="border-t">
                          <td className="py-1 pr-2">{order >= 0 ? order + 1 : "—"}</td>
                          <td className="py-1 pr-2 font-mono">{x.lotCode}</td>
                          <td className={`py-1 pr-2 ${tone}`}>
                            {showDay(x.expiresOn)} · {LOT_EXPIRY_LABEL[x.state]} ({left(x.daysLeft)})
                          </td>
                          <td className="py-1 pr-2">
                            {showDay(x.receivedOn)}
                            {x.receiptReference ? ` · ${x.receiptReference}` : ""}
                          </td>
                          <td className="py-1 pr-2 text-right">{formatNumber(x.quantity)}</td>
                          <td className="py-1 pr-2 text-right">{remainText(x.remaining)}</td>
                          <td className="py-1 text-right">{canWrite ? <DeleteStockLotButton id={x.id} /> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="Chưa có lô nào" description={canWrite ? "Gắn lô ở khung phía trên sau khi lập phiếu nhập hàng." : undefined} />
        )}
      </SectionCard>
    </div>
  );
}

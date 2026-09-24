import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { PACK_BATCH_MIN, type PackLine } from "@/lib/constants/packing-waves";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getPackingWaves } from "@/lib/queries/packing-waves";

export const metadata = { title: "Đóng gói theo lượt" };

/** Số đơn lẻ in ra — đơn chờ lâu nhất trước. Trang phải mở nhanh đúng lúc kho đông đơn nhất. */
const SINGLES_LIMIT = 150;

const hang = (lines: PackLine[]) => lines.map((l) => `${l.qty}× ${l.label}`).join(" · ");

/**
 * ═══════════ ĐÓNG GÓI THEO LƯỢT ═══════════
 *
 * Màn hình của Kho: đơn ĐỦ HÀNG còn phải đóng, bày theo cách đi kho ít vòng nhất. Luật gom ở
 * `lib/constants/packing-waves.ts`, chọn đơn ở `lib/queries/packing-waves.ts`. Chỉ đọc — không nút
 * nào đổi trạng thái đơn hay tạo vận đơn; việc đó vẫn làm trên Pancake như cũ.
 */
export default async function PackingWavesPage() {
  const { decision } = await requireResource("INVENTORY", "products:view");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết (cùng khuôn các trang Kho).
  if (decision.allow === "NONE") return <ScopeDenied title="Đóng gói theo lượt" reason={decision.reason} fix={decision.fix} />;
  const w = await getPackingWaves();
  const x = w.excluded;
  const conLai = w.singles.length - Math.min(w.singles.length, SINGLES_LIMIT);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Đóng gói theo lượt"
        description={`${formatNumber(w.totals.orders)} đơn đủ hàng · ${formatNumber(w.totals.units)} cái · ${formatNumber(w.totals.variants)} mẫu · cập nhật ${formatDateTime(w.measuredAt)}`}
        hint={
          <>
            <p>
              Đơn ở đây là đơn <b>đã chốt</b>, đang ở giai đoạn <b>Đã xác nhận</b> hoặc <b>Đang đóng hàng</b>, hàng <b>chưa rời kho</b>, và sổ kho đã phân <b>đủ hàng</b> cho
              nó theo thứ tự ai lên đơn trước được hàng trước — cùng phép phân bổ với trang Thiếu hàng giao đơn.
            </p>
            <p className="mt-1.5">
              Không dựa vào &quot;đã có vận đơn hay chưa&quot;: Pancake tạo vận đơn trước khi đóng gói. Đơn &quot;Chờ lấy hàng&quot; là đã đóng xong nên không có ở đây.
            </p>
            <p className="mt-1.5">Trang chỉ bày thứ tự — không đổi trạng thái đơn, không tạo vận đơn, không in nhãn.</p>
          </>
        }
      />

      <StatStrip
        columns={5}
        items={[
          { label: "Đủ hàng · cần đóng", value: formatNumber(w.totals.orders), note: `${formatNumber(w.totals.units)} cái` },
          {
            label: "Gom được vào lượt",
            value: formatNumber(w.totals.ordersInBatches),
            note: `${formatNumber(w.batches.length)} lượt giống hệt nhau`,
            hint: `Nhóm từ ${PACK_BATCH_MIN} đơn có ĐÚNG cùng danh sách hàng trở lên — đóng liền tay như một dây chuyền.`,
          },
          { label: "Chờ hàng", value: formatNumber(x.waitingStock), tone: x.waitingStock ? "amber" : "muted", note: "kho không đủ — không đóng", hint: "Xem ở trang Thiếu hàng giao đơn." },
          { label: "Thiếu dữ liệu", value: formatNumber(x.dataBlocked), tone: x.dataBlocked ? "amber" : "muted", note: "chưa tạo được vận đơn", hint: "Thiếu SĐT / địa chỉ / chưa chuẩn hoá tỉnh-xã — CSKH gọi khách trước, kho đóng sau." },
          {
            label: "Chưa xét",
            value: formatNumber(x.stockUnknown + x.promisedLater + x.notYetAllocated),
            tone: "muted",
            note: `${formatNumber(x.stockUnknown)} chưa biết tồn · ${formatNumber(x.promisedLater)} hẹn giao xa`,
            hint: "Mẫu chưa có phiếu nhập thì không biết đủ hay thiếu — không gom. Khách hẹn ngày giao còn xa thì chưa cần đóng hôm nay. Đơn vừa lên trong một phút gần nhất chờ lượt phân bổ kế tiếp.",
          },
        ]}
      />
      {x.waitingStock || x.dataBlocked ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          {x.waitingStock ? (
            <Link href="/inventory/shortage" className="underline underline-offset-2">
              Đơn chờ hàng →
            </Link>
          ) : null}
          {x.waitingStock && x.dataBlocked ? " · " : null}
          {x.dataBlocked ? (
            <Link href="/operations/fulfillment" className="underline underline-offset-2">
              Đơn thiếu dữ liệu →
            </Link>
          ) : null}
        </p>
      ) : null}

      {w.totals.orders === 0 ? (
        <EmptyState title="Không còn đơn nào đủ hàng đang chờ đóng" description="Mọi đơn đã chốt đủ hàng đều đã đóng xong, hoặc đang chờ hàng / chờ dữ liệu." />
      ) : (
        <>
          <SectionCard
            title="Phiếu lấy hàng"
            description="Đi kho MỘT vòng: mỗi mẫu lấy đủ số cái cho mọi đơn đủ hàng."
            hint="Mẫu nhiều cái nhất đứng trước. Số đơn là số đơn có ít nhất một cái của mẫu đó."
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[480px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Mẫu</TableHead>
                    <TableHead className="w-[100px] text-right">Số cái</TableHead>
                    <TableHead className="w-[100px] text-right">Số đơn</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {w.pickList.map((r) => (
                    <TableRow key={r.variantId}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatNumber(r.qty)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(r.orders)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>

          <SectionCard
            title={`Lượt giống hệt nhau · ${formatNumber(w.batches.length)} lượt · ${formatNumber(w.totals.ordersInBatches)} đơn`}
            description="Đơn có đúng cùng danh sách hàng — đóng liền tay, dán nhãn theo lô."
            hint="Lượt đông đơn nhất đứng trước. Trong một lượt, đơn lên trước đứng trước."
            padded={false}
          >
            {w.batches.length ? (
              <ul className="divide-y">
                {w.batches.map((b) => (
                  <li key={b.key} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="text-[11px] tabular-nums">
                        {formatNumber(b.orders.length)} đơn
                      </Badge>
                      <span className="text-sm font-medium">{hang(b.lines)}</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {b.orders.map((o, i) => (
                        <span key={o.orderId}>
                          {i ? " · " : ""}
                          <Link href={`/orders/${o.orderId}`} className="underline-offset-2 hover:underline">
                            #{o.systemId ?? "?"}
                          </Link>
                        </span>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Chưa có hai đơn nào giống hệt nhau" description="Mọi đơn đủ hàng đều có danh sách hàng khác nhau — đóng theo danh sách đơn lẻ bên dưới." className="border-0" />
            )}
          </SectionCard>

          <SectionCard
            title={`Đơn lẻ · ${formatNumber(w.singles.length)} đơn`}
            description="Không trùng danh sách hàng với đơn nào khác — đơn lên trước đứng trước."
            padded={false}
          >
            {w.singles.length ? (
              <div className="overflow-x-auto">
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[90px]">Đơn</TableHead>
                      <TableHead className="w-[160px]">Khách</TableHead>
                      <TableHead>Hàng</TableHead>
                      <TableHead className="w-[130px]">Lên đơn</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {w.singles.slice(0, SINGLES_LIMIT).map((o) => (
                      <TableRow key={o.orderId}>
                        <TableCell>
                          <Link href={`/orders/${o.orderId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                            #{o.systemId ?? "?"}
                          </Link>
                        </TableCell>
                        <TableCell className="truncate">{o.customer}</TableCell>
                        <TableCell className="whitespace-normal text-xs">{hang(o.lines)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDateTime(o.insertedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {conLai > 0 ? <p className="border-t px-3 py-2 text-xs text-muted-foreground">Còn {formatNumber(conLai)} đơn lẻ nữa — đóng xong nhóm trên rồi tải lại trang.</p> : null}
              </div>
            ) : (
              <EmptyState title="Không còn đơn lẻ" description="Mọi đơn đủ hàng đều nằm trong một lượt giống hệt nhau." className="border-0" />
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { QueueViewTabs } from "@/components/queue-view-tabs";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND, formatTimeAgo, MISSING_TEXT } from "@/lib/format";
import {
  DWELL_BASIS_LABEL,
  DWELL_LEVEL_LABEL,
  DWELL_LEVEL_TONE,
  DWELL_LEVELS,
  DWELL_UNRATED,
  DWELL_UNRATED_HINT,
  DWELL_UNRATED_LABEL,
} from "@/lib/constants/shipment-status-age";
import { getShipmentStatusAgeQueue } from "@/lib/queries/shipment-status-age";
import { cn } from "@/lib/utils";

export const metadata = { title: "Vận đơn đứng yên quá lâu" };

/**
 * ═══════════ VẬN ĐƠN ĐỨNG YÊN QUÁ LÂU ═══════════
 *
 * Trang này đo MỘT thứ mà không màn hình nào khác đo: **kiện đã đứng ở chặng hiện tại bao lâu rồi.**
 *
 * Nó KHÁC đồng hồ "quá lâu không cập nhật" của tháp giao vận, và sự khác nhau đó là lý do trang này
 * tồn tại. Đồng hồ kia đo IM LẶNG, nên nó bị đặt lại mỗi lần ĐVVC gửi một tin — kể cả tin nói rằng
 * kiện vẫn nằm im. Đo trên production 13/09/2026: 106 kiện chưa bao giờ rời kho, 61 triệu COD, và
 * KHÔNG kiện nào trong số đó im lặng quá 96 giờ.
 *
 * Hai đồng hồ đứng cạnh nhau ở mỗi dòng, cố ý: lệch nhau nhiều là một tín hiệu đọc được — ĐVVC vẫn
 * nói chuyện đều đặn nhưng gói hàng không đi tới đâu.
 */
export default async function DwellPage() {
  await requirePermission("shipments:view");
  const { rows, summary } = await getShipmentStatusAgeQueue();
  const rot = rows.filter((r) => r.unrated === "NO_EVIDENCE").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Giao vận"
        title="Vận đơn đứng yên quá lâu"
        description="Đo từ lúc kiện VÀO chặng hiện tại — đồng hồ này không bị đặt lại bởi một sự kiện cùng chặng."
        hint={
          <>
            <p>
              <b>Tuổi chặng</b> = bây giờ − lúc kiện vào chặng hiện tại, lấy từ sự kiện sớm nhất của loạt liền kề cuối mang đúng chặng
              đó. Mười lần &quot;phân công bưu tá&quot; vẫn là mười lần đứng yên, và cột này nói đúng như vậy.
            </p>
            <p className="mt-1.5">
              <b>Khác với &quot;ĐVVC im lặng&quot;</b> (cột bên cạnh): im lặng trả lời &quot;ERP có biết kiện ở đâu không&quot;, tuổi chặng trả lời
              &quot;kiện có đi tới đâu không&quot;. Một kiện có thể nhận tin mỗi giờ mà vẫn không nhích.
            </p>
            <p className="mt-1.5">
              <b>Chưa biết mốc</b> là CHỖ TRỐNG DỮ LIỆU, không phải kiện đang ổn: không có sự kiện nào mang chặng hiện tại của vận đơn.
              ERP cố ý KHÔNG lùi về ngày tạo vận đơn hay ngày lên đơn — đó là mốc của ERP, không phải mốc kiện hàng vào chặng.
            </p>
            <p className="mt-1.5">
              Ba trạng thái care nội bộ (chờ phát lại · chờ xử lý · chờ duyệt hoàn) KHÔNG đo ở đây — chúng đã có hạn riêng ở trang Vận
              đơn &amp; care. Đặt thêm một hạn thứ hai là đếm cùng một việc hai lần.
            </p>
          </>
        }
        actions={<QueueViewTabs active="dwell" />}
      />

      <SectionCard
        title={`${formatNumber(summary.breached)} kiện quá hạn ở chặng hiện tại`}
        description={`${formatVND(summary.breachedMoney)} COD đang treo trên nhóm đó · ${formatNumber(summary.tracked)} kiện đang theo dõi · đo lúc ${formatDateTime(summary.measuredAt)}`}
        hint="Xếp: ngoại lệ trước, rồi bất thường, rồi để mắt, rồi nhóm CHƯA BIẾT MỐC (việc đi vá dữ liệu), cuối cùng là nhóm trong hạn."
        padded={false}
      >
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          {DWELL_LEVELS.map((lv) => (
            <span key={lv} className={cn("rounded-lg px-2.5 py-1 text-[11.5px]", DWELL_LEVEL_TONE[lv])}>
              {DWELL_LEVEL_LABEL[lv]} <b className="numeric">{formatNumber(summary.byLevel[lv].count)}</b>
              {summary.byLevel[lv].money > 0 ? <span className="ml-1 opacity-80">{formatVND(summary.byLevel[lv].money, { compact: true })}</span> : null}
            </span>
          ))}
          {DWELL_UNRATED.map((u) =>
            summary.unrated[u].count ? (
              <span key={u} className="rounded-lg border border-dashed bg-muted/30 px-2.5 py-1 text-[11.5px]" title={DWELL_UNRATED_HINT[u]}>
                {DWELL_UNRATED_LABEL[u]} <b className="numeric">{formatNumber(summary.unrated[u].count)}</b>
                {summary.unrated[u].money > 0 ? <span className="ml-1 opacity-80">{formatVND(summary.unrated[u].money, { compact: true })}</span> : null}
              </span>
            ) : null,
          )}
        </div>

        {rot > 0 ? (
          <p className="border-b bg-muted/20 px-5 py-2 text-[12px] text-muted-foreground">
            <b>{formatNumber(rot)} kiện nằm NGOÀI phép đo</b> vì chưa có sự kiện nào mang chặng hiện tại của chúng. Con số ở trên là của{" "}
            {formatNumber(summary.tracked - rot)} kiện còn lại — nói ra để không ai đọc nhầm nó thành &quot;cả kho đều ổn&quot;.
          </p>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState title="Không kiện nào đang theo dõi" description="Mọi vận đơn đều đã tới chặng kết thúc." className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-[12.5px]">
              <thead className="border-b bg-muted/30 text-left text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Mức</th>
                  <th className="px-4 py-2 font-medium">Vận đơn</th>
                  <th className="px-4 py-2 font-medium">Chặng hiện tại</th>
                  <th className="px-4 py-2 font-medium">Vào chặng lúc</th>
                  <th className="px-4 py-2 font-medium">Tuổi chặng</th>
                  <th className="px-4 py-2 font-medium">ĐVVC im lặng</th>
                  <th className="px-4 py-2 font-medium">Hạn</th>
                  <th className="px-4 py-2 font-medium">Phòng</th>
                  <th className="px-4 py-2 font-medium">COD treo</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.slice(0, 300).map((r) => (
                  <tr key={r.shipmentId} className="align-top">
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          "inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold",
                          r.level ? DWELL_LEVEL_TONE[r.level] : "border border-dashed bg-muted/40 text-muted-foreground",
                        )}
                        title={r.unrated ? DWELL_UNRATED_HINT[r.unrated] : undefined}
                      >
                        {r.level ? DWELL_LEVEL_LABEL[r.level] : r.unrated ? DWELL_UNRATED_LABEL[r.unrated] : MISSING_TEXT}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {r.orderId ? (
                        <Link href={`/orders/${r.orderId}`} className="font-medium hover:underline">
                          {r.tracking}
                        </Link>
                      ) : (
                        <span className="font-medium">{r.tracking}</span>
                      )}
                      <span className="block text-[11.5px] text-muted-foreground">
                        {r.orderSystemId ? `#${r.orderSystemId} · ` : ""}
                        {r.customer || MISSING_TEXT} · {r.phone || MISSING_TEXT}
                        {r.careOpen ? <span className="ml-1 text-emerald-700 dark:text-emerald-400">· đang có người care</span> : null}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {r.stageLabel}
                      {r.rawStatus ? <span className="block text-[11.5px] text-muted-foreground">ĐVVC: {r.rawStatus}</span> : null}
                    </td>
                    <td className="px-4 py-2">
                      {/* CHƯA BIẾT in ra dấu gạch, KHÔNG in thành một mốc giả. */}
                      {r.stageSince ? formatDateTime(r.stageSince) : MISSING_TEXT}
                      {r.sinceBasis ? <span className="block text-[11.5px] text-muted-foreground">{DWELL_BASIS_LABEL[r.sinceBasis]}</span> : null}
                    </td>
                    <td className="px-4 py-2 numeric">
                      {r.statusAgeHours === null ? MISSING_TEXT : r.statusAgeLabel}
                      {r.eventsInRun > 1 ? (
                        <span className="block text-[11.5px] text-muted-foreground">{formatNumber(r.eventsInRun)} tin cùng chặng</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 numeric text-muted-foreground">{r.lastCarrierUpdateAt ? formatTimeAgo(r.lastCarrierUpdateAt) : MISSING_TEXT}</td>
                    <td className="px-4 py-2 numeric">
                      {r.slaHours === null ? <span className="text-muted-foreground">không đặt hạn</span> : `${r.slaHours} giờ`}
                      {r.slaBreached === true ? <span className="block text-[11.5px] font-semibold text-rose-600 dark:text-rose-400">quá hạn</span> : null}
                    </td>
                    <td className="px-4 py-2">{r.teamLabel}</td>
                    <td className="px-4 py-2 numeric">{formatVND(r.codAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 300 ? (
          <p className="border-t px-5 py-2 text-[12px] text-muted-foreground">Đang hiện 300 kiện đầu trong tổng {formatNumber(rows.length)}.</p>
        ) : null}
      </SectionCard>

      {/* Việc phải làm theo chặng — nêu một lần ở cuối thay vì lặp trên từng dòng. */}
      {summary.breached > 0 ? (
        <SectionCard title="Việc phải làm" description="Theo chặng kiện đang đứng. Việc của từng kiện cụ thể thì ghi thêm ở trang Vận đơn & care.">
          <ul className="space-y-2 text-[12.5px]">
            {[...new Map(rows.filter((r) => r.level === "EXCEPTION").map((r) => [r.stage, r])).values()].map((r) => (
              <li key={r.stage}>
                <b>{r.stageLabel}</b> <span className="text-muted-foreground">· {r.teamLabel}</span>
                <span className="block text-muted-foreground">{r.nextAction}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

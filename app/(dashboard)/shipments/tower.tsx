import Link from "next/link";
import { AlertTriangle, ArrowRight, PhoneOff } from "lucide-react";
import { CareDrawer } from "@/app/(dashboard)/shipments/care-drawer";
import { SectionCard } from "@/components/ui-bits";
import { BUCKET_TONE, EXCLUSIVE_BUCKETS, type BucketKey } from "@/lib/constants/delivery-tower";
import { formatNumber, formatVND } from "@/lib/format";
import { getDeliveryTower, tongRoThat } from "@/lib/queries/delivery-tower";
import { cn } from "@/lib/utils";

/**
 * ───────────── THÁP ĐIỀU KHIỂN GIAO VẬN ─────────────
 *
 * Trang Vận đơn trước đây mở ra bằng bảng 554 dòng xếp theo ngày tạo — tra cứu được, vận hành thì
 * không. Câu hỏi buổi sáng là "hôm nay phải gọi ai", và bảng đó không trả lời.
 *
 * Rổ nào cũng nói rõ TIỀN TRONG RỔ CÓ NGHĨA GÌ. Rổ "đang chuyển hoàn" cũng có COD, nhưng COD đó đã
 * mất — gộp nó vào một con số "tiền cứu được" chung là bịa.
 *
 * Chọn rổ bằng `?bucket=` để danh sách render ở máy chủ: mở trang không phải tải 554 dòng về máy.
 */
export async function DeliveryTower({ bucket }: { bucket?: string }) {
  const tower = await getDeliveryTower();
  const chon = (EXCLUSIVE_BUCKETS.some((b) => b.key === bucket) || bucket === "CARE_TODAY" ? bucket : null) as BucketKey | null;
  const dangMo = chon ? tower.buckets.find((b) => b.key === chon) : null;
  const kiemTra = tongRoThat(tower);

  const gio = (h: number | null) => (h === null ? "chưa có tin" : h < 1 ? "<1 giờ" : h < 48 ? `${Math.round(h)} giờ` : `${Math.round(h / 24)} ngày`);
  // Danh sách để ngăn kéo đi LẦN LƯỢT: đúng 60 kiện đang hiện, đúng thứ tự đang hiện.
  const hangDoiCare = dangMo ? dangMo.rows.slice(0, 60).map((r) => ({ shipmentId: r.shipmentId })) : undefined;

  return (
    <SectionCard
      title="Cần can thiệp hôm nay"
      description={`${formatNumber(tower.exceptions)}/${formatNumber(tower.tracked)} kiện đang theo dõi cần người động vào · ${formatNumber(tower.onTrack)} kiện đang chạy đúng lịch`}
      hint={`Mỗi kiện nằm ĐÚNG MỘT rổ, xét theo thứ tự — tổng các rổ (${formatNumber(kiemTra)}) bằng đúng số kiện ngoại lệ (${formatNumber(tower.exceptions)}). Riêng "Cần care hôm nay" là RỔ TỔNG HỢP của ba rổ đầu, cố ý chồng lên chúng, nên KHÔNG cộng nó vào tổng. Rổ "quá lâu không cập nhật" nói DỮ LIỆU cũ, không nói đơn hỏng: kết quả đơn vẫn theo chứng từ cuối cùng.`}
      padded={false}
    >
      <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {tower.buckets.map((b) => {
          const active = chon === b.key;
          return (
            <Link
              key={b.key}
              href={active ? "/shipments" : `/shipments?bucket=${b.key}`}
              scroll={false}
              className={cn(
                "rounded-xl border px-3 py-2.5 transition-colors",
                BUCKET_TONE[b.tone],
                active ? "ring-2 ring-primary/60" : b.count > 0 ? "hover:brightness-[0.98]" : "opacity-60",
              )}
            >
              <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                {b.key === "NO_CONTACT" ? <PhoneOff className="size-3.5" /> : b.key === "STALE_NO_UPDATE" ? <AlertTriangle className="size-3.5" /> : null}
                {b.label}
                {b.rollupOf ? <span className="rounded bg-background/70 px-1 text-[9.5px] font-medium uppercase tracking-wide">gộp</span> : null}
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="numeric text-xl font-bold">{formatNumber(b.count)}</span>
                <span className="numeric text-[12px] text-muted-foreground">{formatVND(b.money, { compact: true })}</span>
              </div>
              <div className="text-[11px] leading-snug text-muted-foreground">
                {b.count > 0 ? (
                  <>
                    {formatNumber(b.untouched)} chưa ai chạm · cũ nhất {gio(b.oldestHours)} · {b.teamLabel}
                  </>
                ) : (
                  "Không có kiện nào"
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {dangMo ? (
        <div className="border-t">
          <div className="flex flex-wrap items-start justify-between gap-3 bg-muted/40 px-4 py-3">
            <div className="min-w-[280px] flex-1">
              <div className="text-[13px] font-bold">{dangMo.label}</div>
              <p className="text-[12px] text-muted-foreground" title={`${dangMo.question} · Tiền trong rổ: ${dangMo.moneyMeaning}`}>
                <b className="font-semibold text-foreground">Nên làm:</b> {dangMo.nextAction}
              </p>
            </div>
            <Link href="/shipments" className="shrink-0 rounded-lg border bg-card px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent">
              Đóng danh sách
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-[12px]">
              <thead className="border-b bg-card text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Vận đơn</th>
                  <th className="px-3 py-2 font-semibold">Khách · SĐT</th>
                  <th className="px-3 py-2 text-right font-semibold">COD</th>
                  <th className="px-3 py-2 font-semibold">VTP báo (thô)</th>
                  <th className="px-3 py-2 font-semibold">ERP hiểu</th>
                  <th className="px-3 py-2 font-semibold">Tin cuối</th>
                  <th className="px-3 py-2 font-semibold">CSKH đã làm</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {dangMo.rows.slice(0, 60).map((r) => (
                  <tr key={r.shipmentId} className="align-top hover:bg-accent/40">
                    <td className="px-3 py-2">
                      {/*
                        Bấm mã vận đơn MỞ NGĂN KÉO, không rời trang. Trước đây một cuộc gọi cho khách
                        giao hụt cần sáu lần chuyển màn hình; giờ còn một lần mở và một lần đóng.
                      */}
                      <CareDrawer shipmentId={r.shipmentId} queue={hangDoiCare} className="font-medium">
                        {r.tracking}
                      </CareDrawer>
                      <div className="text-[11px] text-muted-foreground">
                        {r.orderSystemId ? `#${r.orderSystemId}` : "ngoài Pancake"}
                        {r.failedAttempts > 0 ? ` · giao hụt ${r.failedAttempts} lần` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.customer}</div>
                      <div className="numeric text-[11px] text-muted-foreground">{r.phone || "chưa có SĐT"}</div>
                    </td>
                    <td className="numeric px-3 py-2 text-right font-semibold">{formatVND(r.codAmount)}</td>
                    {/* Hai cột cạnh nhau có chủ ý: VTP nói gì, ERP hiểu thành gì. Lệch là thấy ngay. */}
                    <td className="px-3 py-2">
                      <div>{r.rawStatus}</div>
                      <div className="text-[11px] text-muted-foreground">{r.reasonLabel}</div>
                    </td>
                    <td className="px-3 py-2">{r.stageLabel}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{gio(r.lastEventAgeHours)}</td>
                    <td className="px-3 py-2">
                      {r.lastCsAction ? (
                        <span className={r.lastCsActionByHuman ? "" : "text-muted-foreground"}>
                          {r.lastCsAction.slice(0, 90)}
                          {/* Bot nhắn một tin KHÔNG thay được một cuộc gọi — nói rõ ai làm, đừng để hai việc trông như một. */}
                          {r.lastCsActionByHuman ? null : <span className="ml-1 rounded bg-muted px-1 text-[10px]">bot</span>}
                        </span>
                      ) : (
                        <span className="font-medium text-rose-600 dark:text-rose-400">Chưa ai chạm</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dangMo.rows.length > 60 ? (
            <p className="border-t px-4 py-2 text-[11.5px] text-muted-foreground">
              Hiện 60/{formatNumber(dangMo.rows.length)} kiện đầu, xếp theo COD giảm dần. Dùng bộ lọc bên dưới để xem hết.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t px-4 py-2.5 text-[12px] text-muted-foreground">
          Bấm vào một rổ để xem danh sách kiện <ArrowRight className="size-3.5" />
        </div>
      )}
    </SectionCard>
  );
}

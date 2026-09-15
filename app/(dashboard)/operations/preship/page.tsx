import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { QueueViewTabs } from "@/components/queue-view-tabs";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND, MISSING_TEXT } from "@/lib/format";
import { SEVERITY_LABEL, SEVERITY_TONE, VALIDATION_GROUP_LABEL } from "@/lib/constants/preship-validation";
import { DUPLICATE_VERDICT_LABEL, DUPLICATE_VERDICT_TONE } from "@/lib/constants/order-duplicate";
import { getPreshipValidationQueue } from "@/lib/queries/preship-validation";
import { getDuplicateOrderQueue } from "@/lib/queries/order-duplicate";
import { cn } from "@/lib/utils";

export const metadata = { title: "Soát đơn trước khi gửi" };

/**
 * ═══════════ SOÁT ĐƠN TRƯỚC KHI GỬI ═══════════
 *
 * Hai câu hỏi phải trả lời TRƯỚC khi kho dán mã vận đơn, và đây là chỗ duy nhất hỏi cả hai:
 *
 *   1. Chứng từ của đơn này đã đủ để gửi chưa?   (lib/constants/preship-validation.ts)
 *   2. Đơn này có phải bản thứ hai của một đơn đã có không?  (lib/constants/order-duplicate.ts)
 *
 * Cả hai đều nói về cùng một khoảnh khắc — lúc hàng còn trong tay shop và mọi lỗi còn sửa được
 * MIỄN PHÍ. Sau khi bưu tá cầm hàng đi thì cùng những lỗi đó tốn hai chiều cước.
 *
 * ERP KHÔNG chặn và KHÔNG tự huỷ: trạng thái đơn do Pancake giữ, và API Pancake không có đường
 * ghi ngược. Trang này nêu việc phải làm cho người, không thay người quyết.
 */
export default async function PreshipPage() {
  await requirePermission("orders:read");
  const [validation, duplicates] = await Promise.all([getPreshipValidationQueue(), getDuplicateOrderQueue()]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Soát đơn trước khi gửi"
        description="Đơn chưa rời kho: trường nào chưa đạt, và đơn nào có thể là bản thứ hai của một đơn đã có."
        hint={
          <>
            <p>
              <b>ERP không chặn được trạng thái đơn.</b> Trạng thái nằm ở Pancake và API Pancake không có đường ghi ngược, nên đây là
              một bản SOÁT để người sửa trước khi dán mã vận đơn — không phải một cái cổng.
            </p>
            <p className="mt-1.5">
              <b>Chưa gửi được</b> = gửi đi thì gần như chắc chắn hỏng (bưu tá không tìm được nhà, không gọi được khách, kho không biết
              lấy hàng gì). <b>Gửi được · số sẽ sai</b> = kiện vẫn tới nơi nhưng một con số sẽ lệch về sau.
            </p>
            <p className="mt-1.5">
              Trường <b>chưa tra được</b> thì im lặng: chưa biết mẫu hàng có phân loại hay không, chưa có vận đơn để so số thu hộ — cả
              hai đều không sinh lỗi, và cũng không được đọc là đã đạt.
            </p>
          </>
        }
        actions={<QueueViewTabs active="preship" />}
      />

      {/* ─────────── Bảng đếm theo mã lỗi: chỗ nào hỏng nhiều thì sửa QUY TRÌNH ở đó ─────────── */}
      <SectionCard
        title={`${formatNumber(validation.blocked)} đơn chưa gửi được`}
        description={`${formatNumber(validation.scanned)} đơn đã soát · ${formatNumber(validation.warned)} đơn gửi được nhưng số sẽ sai · đo lúc ${formatDateTime(validation.measuredAt)}`}
        hint="Xếp theo: chưa gửi được trước, rồi đơn ĐÃ CÓ VẬN ĐƠN (sắp rời kho, cửa sổ sửa tính bằng giờ), rồi đơn cũ nhất."
        padded={false}
      >
        {validation.byCode.length ? (
          <div className="flex flex-wrap gap-2 border-b px-5 py-3">
            {validation.byCode.map((c) => (
              <span key={c.code} className="rounded-lg border bg-muted/30 px-2.5 py-1 text-[11.5px]">
                {c.field} <span className="text-muted-foreground">· {VALIDATION_GROUP_LABEL[c.group]}</span> <b className="numeric">{formatNumber(c.count)}</b>
              </span>
            ))}
          </div>
        ) : null}

        {validation.rows.length === 0 ? (
          <EmptyState title="Mọi đơn chưa gửi đều đủ chứng từ" description="Không đơn nào thiếu thông tin khách, mẫu mã hay số tiền." className="m-4" />
        ) : (
          <ul className="divide-y">
            {validation.rows.slice(0, 200).map((r) => (
              <li key={r.orderId} className="space-y-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold",
                      r.readyToShip ? SEVERITY_TONE.WARNING : SEVERITY_TONE.BLOCKER,
                    )}
                  >
                    {r.readyToShip ? SEVERITY_LABEL.WARNING : SEVERITY_LABEL.BLOCKER}
                  </span>
                  <Link href={`/orders/${r.orderId}`} className="font-semibold hover:underline">
                    {r.orderLabel}
                  </Link>
                  <span className="text-[12.5px] text-muted-foreground">
                    {r.customer || MISSING_TEXT} · {r.phone || MISSING_TEXT} · {formatVND(r.total)} · lên đơn {r.ageLabel} trước
                  </span>
                  <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">{r.teamLabel}</span>
                  {r.hasShipment ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">đã có vận đơn</span>
                  ) : null}
                  {r.chatUrl ? (
                    <a href={r.chatUrl} target="_blank" rel="noreferrer" className="text-[11.5px] text-primary hover:underline">
                      Mở chat
                    </a>
                  ) : null}
                </div>

                <ul className="space-y-1">
                  {[...r.blockers, ...r.warnings].map((f) => (
                    <li key={f.code} className="text-[12.5px]">
                      <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold", SEVERITY_TONE[f.severity])}>{f.field}</span>
                      <span>{f.detail}</span>
                      <span className="block pl-1 text-muted-foreground">
                        <b>Vì sao:</b> {f.why}
                      </span>
                      <span className="block pl-1 text-muted-foreground">
                        <b>Sửa:</b> {f.fix}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {validation.rows.length > 200 ? (
          <p className="border-t px-5 py-2 text-[12px] text-muted-foreground">
            Đang hiện 200 đơn đầu trong tổng {formatNumber(validation.rows.length)} — làm hết nhóm này rồi tải lại.
          </p>
        ) : null}
      </SectionCard>

      {/* ─────────── Đơn nghi trùng ─────────── */}
      <SectionCard
        title={`${formatNumber(duplicates.suspected)} đơn nghi trùng`}
        description={
          duplicates.rule.enabled
            ? `${formatNumber(duplicates.possible)} đơn cần người xem · ${formatVND(duplicates.atRisk)} đang treo · cửa sổ ${duplicates.rule.windowHours} giờ · ${formatNumber(duplicates.scanned)} đơn đã xét`
            : "Luật dò đơn trùng đang TẮT — danh sách rỗng vì không ai đang dò, không phải vì không có đơn trùng."
        }
        hint="Cùng SĐT + cùng mẫu mã + cùng số lượng ⇒ nghi trùng. Cùng khách nhưng KHÁC mẫu mã ⇒ hai đơn hợp lệ, không báo. Đơn đặt TRƯỚC là bản được giữ."
        padded={false}
      >
        {!duplicates.rule.enabled ? (
          <EmptyState title="Luật dò đơn trùng đang tắt" description="Bật lại ở cấu hình khoá orders.duplicate-rule." className="m-4" />
        ) : duplicates.rows.length === 0 ? (
          <EmptyState title="Không có đơn nào nghi trùng" description={`Đã xét ${formatNumber(duplicates.scanned)} đơn trong ${duplicates.rule.windowHours} giờ qua.`} className="m-4" />
        ) : (
          <ul className="divide-y">
            {duplicates.rows.slice(0, 100).map((r) => (
              <li key={r.suspectOrderId} className="space-y-1.5 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold", DUPLICATE_VERDICT_TONE[r.verdict])}>
                    {DUPLICATE_VERDICT_LABEL[r.verdict]}
                  </span>
                  <Link href={`/orders/${r.suspectOrderId}`} className="font-semibold hover:underline">
                    {r.suspectSystemId ? `#${r.suspectSystemId}` : r.suspectOrderId}
                  </Link>
                  <span className="text-[12.5px] text-muted-foreground">nghi là bản thứ hai của</span>
                  <Link href={`/orders/${r.keeperOrderId}`} className="font-semibold hover:underline">
                    {r.keeperSystemId ? `#${r.keeperSystemId}` : r.keeperOrderId}
                  </Link>
                  {r.keeperShipped ? (
                    <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                      đơn trước ĐÃ RỜI KHO
                    </span>
                  ) : null}
                  {r.chatUrl ? (
                    <a href={r.chatUrl} target="_blank" rel="noreferrer" className="text-[11.5px] text-primary hover:underline">
                      Mở chat
                    </a>
                  ) : null}
                </div>
                <p className="text-[12.5px] text-muted-foreground">
                  {r.customer || MISSING_TEXT} · {r.phone} · {formatVND(r.atRisk)} · hai đơn cách nhau {r.gapHours < 1 ? "dưới 1 giờ" : `${Math.round(r.gapHours)} giờ`} ·{" "}
                  {r.signalLabels.join(" · ")}
                </p>
                <p className="text-[12.5px]">{r.why}</p>
                <p className="text-[12.5px] text-muted-foreground">
                  <b>Việc phải làm:</b> {r.nextAction}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

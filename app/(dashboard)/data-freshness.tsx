import Link from "next/link";
import { formatTimeAgo } from "@/lib/format";
import { getLogisticsFreshness } from "@/lib/queries/logistics-freshness";
import { getWebhookHealth } from "@/lib/queries/webhook-health";
import { cn } from "@/lib/utils";

/**
 * ───────────── DẢI ĐỘ TƯƠI TRÊN TRANG CHỦ ─────────────
 *
 * Một bảng điều hành toàn màu xanh dựng trên số liệu cũ ba tiếng thì TỆ HƠN không có bảng: nó tạo
 * ra sự yên tâm không có căn cứ, và người đọc không có cách nào biết.
 *
 * Dải này cố ý MỎNG và luôn hiện — kể cả khi mọi thứ đang tươi. Chỉ hiện khi có vấn đề thì ngày
 * bình thường người dùng quen với việc không thấy gì, và hôm nó xuất hiện sẽ bị lướt qua.
 *
 * KHÔNG kết luận gì về đơn hàng. "Số liệu cũ" là chuyện của DỮ LIỆU.
 */
export async function DataFreshnessStrip() {
  const [tuoi, wh] = await Promise.all([getLogisticsFreshness(), getWebhookHealth()]);
  const cu = tuoi.byClass.STALE + tuoi.byClass.CRITICAL_STALE;
  const dut = wh.lanes.filter((l) => l.status === "SILENT");
  const yeu = wh.lanes.filter((l) => l.status === "QUIET");
  const nang = dut.length > 0 || tuoi.byClass.CRITICAL_STALE > 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-3.5 py-2 text-[12px]",
        nang ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20" : "bg-muted/30",
      )}
    >
      <span className="font-semibold">Độ tươi số liệu</span>
      <span className="text-muted-foreground">
        Vận đơn: <b className="numeric text-foreground">{tuoi.inFlight - cu}</b>/{tuoi.inFlight} kiện có tin mới trong ngưỡng
        {tuoi.byClass.CRITICAL_STALE > 0 ? (
          <>
            {" · "}
            <b className="numeric text-amber-700 dark:text-amber-300">{tuoi.byClass.CRITICAL_STALE}</b> im lặng nghiêm trọng
          </>
        ) : null}
      </span>
      <span className="text-muted-foreground">
        Webhook: {dut.length === 0 && yeu.length === 0 ? "cả 3 đường đang chạy" : [...dut.map((l) => `${l.label} ĐỨT`), ...yeu.map((l) => `${l.label} thấp`)].join(" · ")}
      </span>
      {tuoi.webhookLastAt ? <span className="text-muted-foreground">Tin ĐVVC gần nhất {formatTimeAgo(tuoi.webhookLastAt)}</span> : null}
      <Link href="/shipments" className="ml-auto font-medium hover:underline">
        Xem tháp điều khiển giao vận
      </Link>
    </div>
  );
}

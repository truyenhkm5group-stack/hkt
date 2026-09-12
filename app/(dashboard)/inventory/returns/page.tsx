import { Boxes, ClipboardCheck, PackageX, ScanLine, Timer, TriangleAlert } from "lucide-react";
import { Suspense } from "react";
import { InspectionStation } from "@/app/(dashboard)/inventory/returns/inspection-station";
import { ReturnPipelineSection } from "@/app/(dashboard)/inventory/returns/pipeline-section";
import { ReceiveQueue } from "@/app/(dashboard)/inventory/returns/receive-queue";
import { receiveQueue, RECEIVE_SLA_DAYS } from "@/lib/returns/receive-queue";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { inspectionDashboard, listPendingInspections } from "@/lib/returns/inspection";

export const metadata = { title: "Kiểm đếm hàng hoàn" };

/**
 * TRẠM ĐẾM HÀNG HOÀN.
 *
 * Vì sao tách khỏi màn "xác nhận về kho": nhận hàng và đếm hàng là hai việc của hai lúc khác nhau.
 * Gộp lại thì người nhận hàng vô tình quyết định luôn số tồn — và ERP tin một con số chưa ai đếm.
 *
 * Bảng điều khiển ở đầu trang tách "chờ nhận" khỏi "chờ đếm" cũng vì lý do đó: hai việc tắc ở hai
 * chỗ khác nhau và thuộc hai người khác nhau. Gộp một con số thì không biết phải đi giục ai.
 */
export default async function ReturnInspectionPage() {
  const user = await requirePermission("products:view");
  const canWrite = can(user, "inventory:write");
  const [bang, pending, choNhan] = await Promise.all([inspectionDashboard(), listPendingInspections(300), receiveQueue({ limit: 400 })]);
  const hao = bang.damaged + bang.missing + bang.wrongItem + bang.unsellable;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Kiểm đếm hàng hoàn"
        description="Bắn mã → kiện nhảy lên đầu → một chạm ra kết luận. Hàng hoàn CHỈ vào lại tồn khi có người đếm thực tế."
        hint="Ghi nhận kiện đã về là một việc; đếm được bao nhiêu món còn bán được là việc khác. ERP không bao giờ tự cộng hàng hoàn vào tồn."
      />

      {/*
        ĐƯỜNG ỐNG ĐẶT TRƯỚC TRẠM ĐẾM, CỐ Ý.

        Trạm đếm chỉ hiện kiện sẵn sàng đếm hôm nay. Câu hỏi lớn hơn — bao nhiêu vốn đang nằm ngoài
        sổ và nằm bao lâu — phải nhìn thấy trước khi cúi xuống đếm từng kiện.

        Trong Suspense riêng: nó đọc thêm bảng kết quả đơn, không được giữ trạm đếm chờ theo.
      */}
      <Suspense fallback={null}>
        <ReturnPipelineSection />
      </Suspense>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          label="Chờ kho nhận"
          value={formatNumber(bang.awaitingArrival)}
          note="ĐVVC đã trả về shop, chưa ai bấm “đã nhận”"
          icon={Timer}
          tone={bang.awaitingArrival ? "amber" : "green"}
        />
        <MetricCard
          label="Chờ đếm"
          value={formatNumber(bang.pendingInspection)}
          note={`${formatNumber(bang.pendingItems)} món đang KHÔNG được tính vào tồn`}
          icon={ClipboardCheck}
          tone={bang.pendingInspection ? "amber" : "green"}
        />
        <MetricCard label="Đã vào lại tồn" value={formatNumber(bang.restocked)} note={`${formatNumber(bang.restockedQty)} món`} icon={Boxes} tone="green" />
        <MetricCard label="Hỏng" value={formatNumber(bang.damaged)} note="Về tới nơi nhưng không bán lại được" icon={PackageX} tone={bang.damaged ? "rose" : "slate"} />
        <MetricCard label="Thiếu / mất" value={formatNumber(bang.missing)} note="Đếm hụt so với số ERP đã xuất" icon={TriangleAlert} tone={bang.missing ? "rose" : "slate"} />
        <MetricCard
          label="Không đúng hàng"
          value={formatNumber(bang.wrongItem)}
          note={hao ? `Tổng ${formatNumber(hao)} kiện không vào lại tồn` : "Khách trả về món khác"}
          icon={ScanLine}
          tone={bang.wrongItem ? "amber" : "slate"}
        />
      </div>

      {/* TUỔI TỒN ĐỌNG: hàng nằm càng lâu thì sổ càng sai lâu, nên nó phải nhìn thấy được. */}
      {bang.pendingInspection > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 text-[12.5px]">
          <span className="font-medium">Tuổi kiện chờ đếm:</span>
          <span className="rounded-md bg-muted px-2 py-0.5">dưới 1 ngày · {formatNumber(bang.aging.duoi1Ngay)}</span>
          <span className="rounded-md bg-muted px-2 py-0.5">1–3 ngày · {formatNumber(bang.aging.tu1Den3Ngay)}</span>
          <span className={bang.aging.tu3Den7Ngay ? "rounded-md bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "rounded-md bg-muted px-2 py-0.5"}>
            3–7 ngày · {formatNumber(bang.aging.tu3Den7Ngay)}
          </span>
          <span className={bang.aging.tren7Ngay ? "rounded-md bg-rose-100 px-2 py-0.5 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200" : "rounded-md bg-muted px-2 py-0.5"}>
            trên 7 ngày · {formatNumber(bang.aging.tren7Ngay)}
          </span>
          <span className="text-muted-foreground">kiện cũ nhất đã chờ {formatNumber(bang.aging.cuNhatNgay)} ngày</span>
        </div>
      ) : null}

      {/*
        BƯỚC 1 NẰM NGAY TRÊN BƯỚC 2. Trước đây "kho đã nhận" ở trang Chất lượng dữ liệu, "đếm" ở đây:
        một việc của kho phải qua hai trang và hai giao diện khác nhau. Nay cả hai bước ở một chỗ —
        tick đã nhận rồi cuộn xuống đếm. Vẫn là hai thao tác tách bạch: nhận hàng không cộng tồn.
      */}
      {choNhan.rows.length ? (
        <SectionCard
          title={`Chờ kho nhận · ${formatNumber(choNhan.total)} kiện`}
          description={
            /*
              TÓM TẮT CHO NGƯỜI ĐỨNG Ở KHO, KHÔNG PHẢI CHO BÁO CÁO.
              "Bao nhiêu món phải dọn chỗ" và "bao nhiêu kiện nằm quá lâu" là hai câu họ hỏi trước
              khi mở kiện đầu tiên. Số món CHỈ cộng phần đã ghép được đơn; phần chưa ghép nêu riêng
              chứ không ước lượng — một con số trộn cả phần đoán sẽ bị đọc thành tồn kho.
            */
            [
              `${formatNumber(choNhan.summary.expectedUnits)} sản phẩm dự kiến từ ${formatNumber(choNhan.summary.mapped)} kiện đã ghép được đơn`,
              choNhan.summary.unmapped ? `${formatNumber(choNhan.summary.unmapped)} kiện chưa xác định đơn` : "",
              choNhan.summary.overdue ? `${formatNumber(choNhan.summary.overdue)} kiện quá ${RECEIVE_SLA_DAYS} ngày` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          }
          hint="Xác nhận ở đây rồi kiện mới xuống hàng đợi đếm bên dưới. Bấm “đã nhận” KHÔNG cộng tồn: tồn chỉ tăng khi có người đếm thực tế. “Sản phẩm dự kiến” là hàng LẼ RA quay về theo đơn gốc — chưa ai đếm, và không phải số tồn."
          padded={false}
        >
          <div className="space-y-3 p-3">
            {choNhan.summary.topSkus.length ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <span className="text-muted-foreground">Dự kiến theo mã hàng:</span>
                {choNhan.summary.topSkus.slice(0, 8).map((x) => (
                  <span key={x.sku || x.name} className="rounded-md bg-muted px-1.5 py-0.5">
                    <span className="font-medium">{x.sku || x.name}</span>
                    <span className="numeric"> · {formatNumber(x.qty)}</span>
                  </span>
                ))}
                {choNhan.summary.topSkus.length > 8 ? <span className="text-muted-foreground">+{choNhan.summary.topSkus.length - 8} mã nữa</span> : null}
              </div>
            ) : null}
            <ReceiveQueue
              total={choNhan.total}
              canWrite={canWrite}
              rows={choNhan.rows.map((r) => ({
                shipmentId: r.shipmentId,
                code: r.code,
                receiverName: r.receiverName,
                receiverPhone: r.receiverPhone,
                codAmount: r.codAmount,
                returnedAt: r.returnedAt ? r.returnedAt.toISOString() : null,
                ageDays: r.ageDays,
                ctx: r.ctx,
              }))}
            />
            {choNhan.total > choNhan.loaded ? (
              <p className="text-[11.5px] text-muted-foreground">
                Đang hiện {formatNumber(choNhan.loaded)} kiện cũ nhất trong tổng {formatNumber(choNhan.total)}. Xử lý bớt thì phần còn lại tự lên.
              </p>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title={`Kiện đã về, chờ đếm${pending.length ? ` · ${formatNumber(pending.length)}` : ""}`}
        description={
          canWrite
            ? "Cũ nhất trước. Bắn mã để nhảy thẳng tới kiện đang cầm trên tay; chọn nhiều kiện cùng kết luận để xử lý một lượt."
            : "Bạn không có quyền cập nhật kho nên chỉ xem được danh sách."
        }
        padded={false}
      >
        <div className="p-3">
          <InspectionStation rows={pending} canWrite={canWrite} />
        </div>
      </SectionCard>
    </div>
  );
}

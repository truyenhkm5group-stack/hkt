import {
  Boxes,
  ClipboardCheck,
  PackageX,
  ScanLine,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Suspense } from "react";
import { InspectionStation } from "@/app/(dashboard)/inventory/returns/inspection-station";
import { ReturnPipelineSection } from "@/app/(dashboard)/inventory/returns/pipeline-section";
import { ReceiveQueue } from "@/app/(dashboard)/inventory/returns/receive-queue";
import { receiveQueue, RECEIVE_SLA_DAYS } from "@/lib/returns/receive-queue";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";
import { formatNumber } from "@/lib/format";
import {
  inspectionDashboard,
  listPendingInspections,
  toStationRow,
} from "@/lib/returns/inspection";
import { PENDING_STATION_CAP } from "@/lib/returns/inspection-filter";
import { inspectionTruth } from "@/lib/queries/inspection-truth";
import {
  InspectionTruthSection,
  RecoveredValueSection,
} from "@/app/(dashboard)/inventory/returns/inspection-truth-section";
import { hmtRunSummary } from "@/lib/returns/hmt-provenance";
import { latestHmtWorkbookMeta } from "@/lib/returns/hmt-source";
import { HmtSourceSection } from "@/app/(dashboard)/inventory/returns/hmt-source-section";
import { ExceptionQueues } from "@/app/(dashboard)/inventory/returns/exception-queues";
import { ReceiveScanDesk } from "@/app/(dashboard)/inventory/returns/receive-scan-desk";
import { UnidentifiedSection } from "@/app/(dashboard)/inventory/returns/unidentified-section";
import { listUnidentifiedReturns, unidentifiedSummary } from "@/lib/returns/unidentified";
import { RESTOCK_UNIDENTIFIED_PERMISSION } from "@/lib/constants/return-unidentified";
import { ReturnQualityCounters } from "@/app/(dashboard)/inventory/returns/quality-counters";
import {
  returnDataQuality,
  returnExceptionQueues,
} from "@/lib/queries/return-exceptions";
import {
  returnByInspector,
  returnBySku,
  returnThroughput,
  returnWarehouseKpi,
} from "@/lib/queries/return-warehouse-kpi";
import {
  WarehouseKpiBlock,
  WarehouseKpiGaps,
  WarehouseToday,
} from "@/app/(dashboard)/inventory/returns/warehouse-kpi";
import {
  WarehouseBySku,
  WarehousePeople,
  WarehouseThroughput,
} from "@/app/(dashboard)/inventory/returns/warehouse-people";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Kiểm đếm hàng hoàn" };

/*
  KỲ ĐO KHAI MỘT CHỖ. Ba khối dưới trang nhìn ba kỳ khác nhau, cố ý: năng suất đọc theo tháng để
  thấy xu hướng, người đếm theo tháng để đủ mẫu, mẫu mã theo quý vì hàng hoàn của một mẫu mã thưa
  hơn nhiều. Con số nào lên màn hình thì cũng lấy từ đây, nên nhãn không bao giờ nói khác truy vấn.
*/
const TREND_DAYS = 30;
const PEOPLE_DAYS = 30;
const SKU_DAYS = 90;

/**
 * TRẦN DANH SÁCH KIỆN MẤT NHÃN.
 *
 * Danh sách này gần như luôn ngắn (kiện mất nhãn là ngoại lệ, không phải dòng chảy chính) — nhưng
 * trần vẫn phải có: một ngày dỡ hàng hỏng có thể sinh ra hàng trăm dòng, và vẽ hết chúng vào trang
 * đã nặng sẵn này là làm đứng hình đúng lúc kho cần nó nhất. Bộ đếm phía trên vẫn đếm TOÀN BỘ.
 */
const UNIDENTIFIED_CAP = 60;

/**
 * TRẠM ĐẾM HÀNG HOÀN.
 *
 * Vì sao tách khỏi màn "xác nhận về kho": nhận hàng và đếm hàng là hai việc của hai lúc khác nhau.
 * Gộp lại thì người nhận hàng vô tình quyết định luôn số tồn — và ERP tin một con số chưa ai đếm.
 *
 * Bảng điều khiển ở đầu trang tách "chờ nhận" khỏi "chờ đếm" cũng vì lý do đó: hai việc tắc ở hai
 * chỗ khác nhau và thuộc hai người khác nhau. Gộp một con số thì không biết phải đi giục ai.
 */
export default async function ReturnInspectionPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  /*
    Ô TÌM KIỆN ĐI LÊN MÁY CHỦ, KHÔNG LỌC TẠI CHỖ.

    Trước bản này trang gọi hàng đợi mà KHÔNG truyền ô tìm, rồi trình duyệt
    lọc trên đúng 400 dòng đã tải. Phần lọc phía máy chủ có sẵn trong truy vấn nhưng chưa ai gọi.

    Hậu quả ở đúng lúc tệ nhất: người kho cầm một kiện, gõ mã vận đơn, và nếu kiện đó nằm ngoài 400
    dòng cũ nhất thì màn hình nói "0 kiện". Người đứng ở kho đọc câu đó là "kiện này không có trong
    hệ thống" — rồi chọn đại một dòng gần giống hoặc lập phiếu mới. Đây là kiểu hỏng mà màn hình
    trông hoàn toàn bình thường: không lỗi, không cảnh báo, chỉ là một danh sách rỗng.
  */
  const sp = await searchParams;
  const timKien = param(sp, "kien") ?? "";
  const { user, decision } = await requireResource("RETURNS", "products:view");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE")
    return (
      <ScopeDenied
        title="Hàng hoàn về kho"
        reason={decision.reason}
        fix={decision.fix}
      />
    );
  const canWrite = can(user, "inventory:write");
  /*
    TẢI TRỌN HÀNG ĐỢI ĐẾM (tới trần), KHÔNG PHẢI MỘT TRANG.

    Bộ lọc mã hàng / màu / size của trạm đếm chạy ở trình duyệt — buộc phải vậy, vì danh sách món
    trong kiện do `returnProductContext` dựng sau truy vấn chứ không nằm ở một cột nào. Lọc trong
    trình duyệt trên một danh sách bị cắt là đúng cái bẫy mô tả ngay trên kia: màn hình nói "0 kiện"
    và người đứng ở kho đọc câu đó thành "kiện này không có trong hệ thống".

    Nên: tải tới `PENDING_STATION_CAP`, và truyền xuống cả TỔNG THẬT để trạm đếm tự nói ra khi phần
    đang lọc không phải toàn bộ. Trần vẫn phải có — vẽ vài nghìn thẻ thì trình duyệt đứng hình.
  */
  const [
    bang,
    pending,
    choNhan,
    hmt,
    soGiay,
    ngoaiLe,
    chatLuong,
    kpi,
    nangSuat,
    nguoiDem,
    theoMauMa,
    suThat,
    khongMa,
    khongMaTong,
  ] = await Promise.all([
    inspectionDashboard(),
    listPendingInspections(PENDING_STATION_CAP),
    receiveQueue({ limit: 400, q: timKien }),
    hmtRunSummary(),
    latestHmtWorkbookMeta(),
    returnExceptionQueues(),
    returnDataQuality(),
    returnWarehouseKpi(),
    returnThroughput(TREND_DAYS),
    returnByInspector(PEOPLE_DAYS),
    returnBySku(SKU_DAYS),
    inspectionTruth(),
    listUnidentifiedReturns({ limit: UNIDENTIFIED_CAP }),
    unidentifiedSummary(),
  ]);
  /*
    CHỈ ĐƯA **META** XUỐNG TRÌNH DUYỆT.

    Trang này KHÔNG đọc nội dung sổ: `latestHmtWorkbookMeta()` cố ý không kéo cột `content`
    (base64 ~80 KB). Kéo về rồi giải mã chỉ để hiện tên tệp là bắt MỌI lượt mở trang trả tiền cho
    một khối byte không ai đọc — và vì Node chạy một luồng, phép giải mã đồng bộ ấy chặn luôn các
    yêu cầu khác đang chờ.

    Và dù có kéo về cũng KHÔNG được truyền xuống client: đó là nhét tên, số điện thoại, địa chỉ
    khách vào HTML của mỗi lượt tải trang, đọc được toàn bộ sổ hàng hoàn bằng "xem nguồn". Tên ·
    băm · dung lượng · ai tải · lúc nào là đủ cho màn hình.
  */
  const hmtUpload = soGiay
    ? {
        filename: soGiay.filename,
        sha256: soGiay.sha256,
        bytes: soGiay.bytes,
        uploadedBy: soGiay.uploadedBy,
        uploadedAt: soGiay.uploadedAt ?? new Date(),
        lastUsedAt: soGiay.lastUsedAt,
      }
    : null;
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
        BÀN BẮN MÃ ĐỨNG ĐẦU TIÊN, TRÊN MỌI CON SỐ.

        Người kho mở trang này với một kiện hàng trên tay, không phải để đọc báo cáo. Đẩy ô bắn mã
        xuống dưới bốn khối số liệu là bắt họ cuộn mỗi lần nhận một kiện — và việc bị bỏ qua đúng
        theo cách đó là lý do production từng có hàng trăm kiện chưa ai bấm nhận.

        Ô này CHỈ ghi nhận kiện đã về. Tồn kho không đổi một món nào ở đây.
      */}
      <ReceiveScanDesk canWrite={canWrite} awaiting={bang.awaitingArrival} />

      {/* Nguồn thứ ba của bàn này: sổ hàng hoàn viết tay. Chưa đối soát lần nào thì khối không hiện. */}
      <HmtSourceSection run={hmt} upload={hmtUpload} canWrite={canWrite} />

      {/*
        NGOẠI LỆ ĐỨNG NGAY SAU NGUỒN, TRƯỚC MỌI SỐ TỔNG HỢP.

        26 dòng không khớp và 144 mã chỉ có mã là phần sổ giấy và ERP nói khác nhau — đó là chỗ
        DUY NHẤT trên trang này cần một quyết định của người. Đẩy nó xuống dưới bảng số liệu là
        cách chắc chắn nhất để không ai cuộn tới.
      */}
      <WarehouseToday kpi={kpi} />

      <ExceptionQueues data={ngoaiLe} canWrite={canWrite} />

      {/*
        KIỆN MẤT NHÃN ĐỨNG CẠNH CÁC HÀNG ĐỢI NGOẠI LỆ, KHÔNG PHẢI CUỐI TRANG.

        Nó là ngoại lệ cần một QUYẾT ĐỊNH CỦA NGƯỜI, cùng loại với bốn hàng đợi ngay trên. Đẩy nó
        xuống dưới các bảng số liệu là cách chắc chắn nhất để hàng nằm mãi ngoài sổ — và mỗi ngày
        nằm ngoài sổ là một ngày kế hoạch đặt hàng đặt thừa đúng bằng phần ấy.
      */}
      <UnidentifiedSection
        rows={khongMa}
        summary={khongMaTong}
        canWrite={canWrite}
        canOverride={can(user, RESTOCK_UNIDENTIFIED_PERMISSION)}
      />

      <ReturnQualityCounters rows={chatLuong} />

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
          hint="Cùng một điều kiện với bảng “Chờ kho nhận” bên dưới và nút xác nhận hàng loạt: vận đơn Viettel Post đã trả xong (504, hoặc phát thành công chiều hoàn), kho chưa bấm nhận. Vận đơn chiều về (mã gốc + 1P1) cũng được tính khi vận đơn chiều đi chưa tự nằm trong danh sách."
          icon={Timer}
          tone={bang.awaitingArrival ? "amber" : "green"}
        />
        <MetricCard
          label="Chờ đếm"
          value={formatNumber(bang.pendingInspection)}
          /* CHƯA BIẾT hiện là "—", không phải 0: kiện chưa ghép được đơn thì không ai biết trong đó có mấy món. */
          note={[
            `${bang.pendingItems === null ? "—" : formatNumber(bang.pendingItems)} món đang KHÔNG được tính vào tồn`,
            bang.unknownParcels
              ? `${formatNumber(bang.unknownParcels)} kiện chưa rõ hàng`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          hint="Số món KỲ VỌNG theo đơn gốc của các kiện đã về mà chưa đếm. Kiện chưa ghép được đơn không có số kỳ vọng — chúng được đếm riêng là “chưa rõ hàng”, không được ước lượng thành 0."
          icon={ClipboardCheck}
          tone={bang.pendingInspection ? "amber" : "green"}
        />
        <MetricCard
          label="Đã vào lại tồn"
          value={formatNumber(bang.restocked)}
          note={`${formatNumber(bang.restockedQty)} món`}
          icon={Boxes}
          tone="green"
        />
        <MetricCard
          label="Hỏng"
          value={formatNumber(bang.damaged)}
          note="Về tới nơi nhưng không bán lại được"
          icon={PackageX}
          tone={bang.damaged ? "rose" : "slate"}
        />
        <MetricCard
          label="Thiếu / mất"
          value={formatNumber(bang.missing)}
          note="Đếm hụt so với số ERP đã xuất"
          icon={TriangleAlert}
          tone={bang.missing ? "rose" : "slate"}
        />
        <MetricCard
          label="Không đúng hàng"
          value={formatNumber(bang.wrongItem)}
          note={
            hao
              ? `Tổng ${formatNumber(hao)} kiện không vào lại tồn`
              : "Khách trả về món khác"
          }
          icon={ScanLine}
          tone={bang.wrongItem ? "amber" : "slate"}
        />
      </div>

      <InspectionTruthSection truth={suThat} />

      <WarehouseKpiBlock kpi={kpi} />

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
              choNhan.summary.unmapped
                ? `${formatNumber(choNhan.summary.unmapped)} kiện chưa xác định đơn`
                : "",
              choNhan.summary.overdue
                ? `${formatNumber(choNhan.summary.overdue)} kiện quá ${RECEIVE_SLA_DAYS} ngày`
                : "",
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
                <span className="text-muted-foreground">
                  Dự kiến theo mã hàng:
                </span>
                {choNhan.summary.topSkus.slice(0, 8).map((x) => (
                  <span
                    key={x.sku || x.name}
                    className="rounded-md bg-muted px-1.5 py-0.5"
                  >
                    <span className="font-medium">{x.sku || x.name}</span>
                    <span className="numeric"> · {formatNumber(x.qty)}</span>
                  </span>
                ))}
                {choNhan.summary.topSkus.length > 8 ? (
                  <span className="text-muted-foreground">
                    +{choNhan.summary.topSkus.length - 8} mã nữa
                  </span>
                ) : null}
              </div>
            ) : null}
            <ReceiveQueue
              searching={Boolean(timKien.trim())}
              loaded={choNhan.loaded}
              total={choNhan.total}
              canWrite={canWrite}
              rows={choNhan.rows.map((r) => ({
                shipmentId: r.shipmentId,
                code: r.code,
                receiverName: r.receiverName,
                receiverPhone: r.receiverPhone,
                codAmount: r.codAmount,
                stage: r.stage,
                returnedAt: r.returnedAt ? r.returnedAt.toISOString() : null,
                ageDays: r.ageDays,
                ctx: r.ctx,
              }))}
            />
            {choNhan.total > choNhan.loaded ? (
              <p className="text-[11.5px] text-muted-foreground">
                Đang hiện {formatNumber(choNhan.loaded)} kiện cũ nhất trong tổng{" "}
                {formatNumber(choNhan.total)}. Xử lý bớt thì phần còn lại tự
                lên.
              </p>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {/* `scroll-mt` chừa chỗ cho thanh tiêu đề dính trên: không có nó thì nhảy neo xong tiêu đề bảng bị che. */}
      <div id="tram-dem" className="scroll-mt-20">
        <SectionCard
          title={`Kiện đã về, chờ đếm${bang.pendingInspection ? ` · ${formatNumber(bang.pendingInspection)}` : ""}`}
          description={
            canWrite
              ? "Lọc theo mã hàng / màu / size để gom cả sọt rồi đếm một lượt. Bắn mã để nhảy thẳng tới kiện đang cầm trên tay; chọn nhiều kiện cùng kết luận để xử lý hàng loạt."
              : "Bạn không có quyền cập nhật kho nên chỉ xem được danh sách."
          }
          hint="“Nhận đủ” = mỗi dòng hàng của kiện về đúng số kỳ vọng của nó, kể cả kiện nhiều mẫu mã. Đếm THIẾU trên kiện nhiều mẫu mã thì phải mở “Kiểm từng món”: một con số tổng không nói được mẫu nào hụt, và ghi bừa làm sai tồn của nhiều mẫu mã cùng lúc."
          padded={false}
        >
          <div className="p-3">
            {/* Tiêu đề đếm TỔNG THẬT; danh sách chỉ tải tới trần — trạm đếm nói ra chênh lệch đó. */}
            <InspectionStation
              rows={pending.map(toStationRow)}
              canWrite={canWrite}
              total={bang.pendingInspection}
            />
          </div>
        </SectionCard>
      </div>

      {/*
        ĐO HIỆU SUẤT NẰM SAU CHỖ LÀM VIỆC, CỐ Ý.

        Người kho mở trang này để ĐẾM HÀNG; đẩy bốn khối số liệu lên trên trạm đếm là bắt họ cuộn
        qua báo cáo mỗi lần bắn một mã. Người quản lý thì đọc từ trên xuống và dừng ở đâu cũng được —
        "hôm nay" đã nằm ngay đầu trang cho họ.
      */}
      <WarehouseThroughput data={nangSuat} days={TREND_DAYS} />
      <WarehousePeople
        rows={nguoiDem.rows}
        unattributed={nguoiDem.unattributed}
        days={PEOPLE_DAYS}
        slaHours={kpi.slaHours.receiveToInspect}
      />
      <WarehouseBySku rows={theoMauMa} days={SKU_DAYS} />
      <RecoveredValueSection truth={suThat} />
      <WarehouseKpiGaps />
    </div>
  );
}

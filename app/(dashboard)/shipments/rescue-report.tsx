import { InfoHint } from "@/components/info-hint";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { BUSINESS_ACTIONS, BUSINESS_ACTION_LABEL, CARE_OUTCOME_HINT, CARE_OUTCOME_LABEL } from "@/lib/constants/care-outcome";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { formatNumber } from "@/lib/format";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { RescueCaseList } from "@/app/(dashboard)/shipments/rescue-case-list";
import { CARE_CASE_BUCKETS, getCarePerformanceByPic, getCarePerformanceByProduct, getRescueSummary, type CareCaseBucket } from "@/lib/queries/care-performance";
import type { Period, SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TỶ LỆ CỨU ĐƠN — CÓ SỐ, VÀ CÓ CẢ PHẦN CHƯA BIẾT ═══════════
 *
 * Ba quy tắc trình bày, cả ba đều để tránh một con số trông chắc chắn hơn nó thật sự:
 *
 *  1. Ca CHƯA có kết cục luôn hiện cạnh tỷ lệ, không giấu xuống chân trang. Tỷ lệ 100% trên 2 ca
 *     đã chốt trong khi còn 40 ca treo là một câu nói khác hẳn "100%".
 *  2. Chưa ca nào chốt ⇒ in "—", KHÔNG in 0%. Hai cái dẫn tới hai kết luận trái ngược: một cái nói
 *     chưa đo được, cái kia nói đội đã làm mà không cứu được ca nào.
 *  3. Cứu TRỰC TIẾP và cứu BẰNG ĐƠN ĐỔI là hai cột riêng. Đơn đổi tốn thêm một lượt cước và một
 *     lần đóng gói; gộp im lặng là giấu mất chênh lệch đó.
 */

/** In tỷ lệ, hoặc "—" khi chưa đo được. `0` là một con số thật và vẫn được in. */
function Ty({ value, mau }: { value: number | null; mau: number }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="numeric font-semibold">
      {value.toFixed(1)}%{mau < 20 ? <span className="ml-0.5 text-[10px] font-normal text-amber-600 dark:text-amber-400" title={`Chỉ ${mau} ca đã chốt — mẫu nhỏ, đừng kết luận về con người từ con số này`}>/{mau}</span> : null}
    </span>
  );
}

/**
 * In một trung vị thời gian kèm ĐỘ PHỦ. Mẫu dưới ngưỡng ⇒ truy vấn đã trả `null`, và ô này in "—"
 * kèm số ca có mốc ấy: người quản lý phải phân biệt được CHƯA ĐỦ DỮ LIỆU với LÀM NHANH (mục 39).
 */
function Gio({ phut, mau, nguong, xungDot = 0 }: { phut: number | null; mau: number; nguong: number; xungDot?: number }) {
  // Ca ghi mốc phản hồi sớm hơn mốc mở ca QUÁ dung sai ghi là mâu thuẫn thật, không phải phản hồi
  // nhanh. Nó nằm ngoài phép tính, nhưng hiện ra ở đây để không ai phải đi tìm mới biết.
  // (Sớm dưới dung sai là hai mốc ghi cùng một thao tác — những ca ấy được kẹp về 0 và VẪN tính.)
  const canhBao = xungDot ? ` · ${xungDot} ca ghi mốc phản hồi sớm hơn hẳn mốc mở ca — mâu thuẫn dữ liệu, nằm ngoài phép tính` : "";
  if (phut === null) {
    return (
      <span className="text-muted-foreground" title={(mau === 0 ? "Chưa ca nào của người này có mốc dùng được" : `Chỉ ${mau} ca có mốc dùng được — dưới ngưỡng ${nguong} ca nên không phát biểu một trung vị`) + canhBao}>
        —<span className="ml-0.5 text-[10px]">/{mau}</span>
        {xungDot ? <span className="ml-0.5 text-[10px] text-amber-600 dark:text-amber-400">!</span> : null}
      </span>
    );
  }
  return (
    <span className="numeric font-medium" title={`Trung vị trên ${mau} ca có mốc dùng được${canhBao}`}>
      {phut < 60 ? `${phut}p` : `${Math.round(phut / 60)}h`}
      {mau < nguong * 2 ? <span className="ml-0.5 text-[10px] font-normal text-amber-600 dark:text-amber-400">/{mau}</span> : null}
      {xungDot ? <span className="ml-0.5 text-[10px] text-amber-600 dark:text-amber-400">!</span> : null}
    </span>
  );
}

/** Tham số URL của ô đang mở: `caNguoi` = id tài khoản hoặc `none` (Chưa nối được người), `caO` = ô. */
const KHONG_NGUOI = "none";

/**
 * Đường dẫn giữ NGUYÊN kỳ lọc đang xem (period / from / to / basis) và chỉ đổi ô đang mở. Mất kỳ
 * lọc khi bấm là danh sách ra theo kỳ mặc định — số dòng không còn bằng con số vừa bấm.
 */
function hrefO(raw: SearchParams, o: { owner: string | null; bucket: CareCaseBucket } | null): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (k === "caNguoi" || k === "caO" || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
  }
  if (o) {
    q.set("caNguoi", o.owner ?? KHONG_NGUOI);
    q.set("caO", o.bucket);
  }
  return `/shipments?${q.toString()}${o ? "#ds-ca" : ""}`;
}

/** Một con số bấm được. 0 thì không có gì để mở — in số, không in liên kết. */
function So({ n, href, className, dangMo }: { n: number; href: string; className?: string; dangMo: boolean }) {
  if (!n) return <span className={className}>{formatNumber(n)}</span>;
  return (
    <Link href={href} className={cn("numeric underline decoration-dotted underline-offset-2 hover:decoration-solid", dangMo && "rounded bg-accent px-1 decoration-solid", className)}>
      {formatNumber(n)}
    </Link>
  );
}

export async function RescueReportSection({ period, raw = {} }: { period: Period; raw?: SearchParams }) {
  const [tong, theoNguoi, theoMa] = await Promise.all([getRescueSummary(period), getCarePerformanceByPic(period), getCarePerformanceByProduct(period)]);

  const caNguoi = typeof raw.caNguoi === "string" ? raw.caNguoi : null;
  const caO = typeof raw.caO === "string" && (CARE_CASE_BUCKETS as readonly string[]).includes(raw.caO) ? (raw.caO as CareCaseBucket) : null;
  const dong = caNguoi && caO ? theoNguoi.find((r) => (r.userId ?? KHONG_NGUOI) === caNguoi) : undefined;
  const o = (r: (typeof theoNguoi)[number], bucket: CareCaseBucket) => ({
    href: hrefO(raw, { owner: r.userId, bucket }),
    dangMo: dong === r && caO === bucket,
  });

  return (
    <div className="space-y-4">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Tỷ lệ cứu đơn (trực tiếp)"
          value={tong.directRate === null ? "—" : `${tong.directRate.toFixed(1)}%`}
          note={`${formatNumber(tong.direct)} cứu được / ${formatNumber(tong.direct + tong.failed)} ca đã chốt`}
          hint={`Chính vận đơn đang gặp sự cố cuối cùng ĐÃ GIAO theo chứng từ ĐVVC. Mẫu số chỉ gồm ca đã có kết cục cuối — ${formatNumber(tong.pending)} ca chưa có kết quả nằm NGOÀI cả tử số lẫn mẫu số. Bấm "Phát tiếp" không làm một ca thành cứu được; chỉ hành trình ĐVVC làm được điều đó.`}
          tone="green"
        />
        <MetricCard
          label="Tính cả đơn đổi"
          value={tong.rateWithExchange === null ? "—" : `${tong.rateWithExchange.toFixed(1)}%`}
          note={`thêm ${formatNumber(tong.exchange)} ca cứu bằng đơn đổi`}
          hint="Vận đơn gốc không tới tay khách nhưng đơn ĐỔI nối với ca cuối cùng đã giao. Tách riêng vì đơn đổi tốn thêm một lượt cước và một lần đóng gói — gộp im lặng là giấu mất chênh lệch đó."
          tone="blue"
        />
        <MetricCard
          label="Chưa có kết quả"
          value={formatNumber(tong.pending)}
          note="kiện chưa tới đích và cũng chưa quay đầu"
          hint="CHƯA BIẾT. Cố ý nằm ngoài cả tử số lẫn mẫu số: đẩy vào mẫu số là ép một câu trả lời chưa tồn tại thành “chưa cứu được”, và tỷ lệ tụt xuống chỉ vì hôm nay có nhiều ca mới."
          tone="amber"
        />
        <MetricCard
          label="Ca mở trong kỳ"
          value={formatNumber(tong.openedInPeriod)}
          note={`${formatNumber(tong.total)} ca CHỐT trong kỳ`}
          hint="Hai con số trả lời hai câu khác nhau nên đi theo hai mốc khác nhau: khối lượng việc theo NGÀY MỞ ca, hiệu suất theo NGÀY CHỐT kết quả. Ca mở tháng trước và chốt tháng này thuộc khối lượng tháng trước nhưng thuộc hiệu suất tháng này."
        />
      </section>

      {tong.unattributed ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
          {formatNumber(tong.unattributed)} ca <b>không đủ chứng cứ để kết luận</b> — ca lịch sử chưa nối được về người hoặc về chứng từ. Chúng nằm ngoài mọi tỷ lệ và không tính vào hiệu suất của ai.
        </p>
      ) : null}

      <SectionCard
        title="Hiệu suất theo người xử lý"
        description="Quy kết theo người ĐANG CẦM CA LÚC CHỐT KẾT QUẢ — không phải người mở ca, không phải người bấm nhiều nhất"
        actions={<InfoHint>Một ca qua tay nhiều người thì cộng kết quả cho tất cả sẽ đếm một ca thành nhiều lần trong tỷ lệ tổng. Số THAO TÁC của từng người đếm riêng ở các cột bên phải để thấy ai đã đóng góp — nhưng nó KHÔNG tham gia tỷ lệ cứu đơn.</InfoHint>}
        padded={false}
      >
        <TableToolsFor tableId="shipments-rescue-report-1" />
        <div className={TABLE_SCROLL}>
          <table id="shipments-rescue-report-1" className="w-full min-w-[1060px] text-[12px]">
            <thead className={cn(STICKY_HEAD, "border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground")}>
              <tr>
                <th className="px-2.5 py-2 font-semibold">Người xử lý</th>
                <th className="px-2.5 py-2 text-right font-semibold" title="Ca được giao cho người này trong kỳ (theo ngày MỞ ca)">Được giao</th>
                <th className="px-2.5 py-2 text-right font-semibold" title="Ca đã có kết cục cuối và người này đang cầm lúc chốt">Đã chốt</th>
                <th className="px-2.5 py-2 text-right font-semibold">Cứu trực tiếp</th>
                <th className="px-2.5 py-2 text-right font-semibold">Cứu bằng đổi</th>
                <th className="px-2.5 py-2 text-right font-semibold">Không cứu được</th>
                <th
                  className="px-2.5 py-2 text-right font-semibold"
                  title="Đợt chăm sóc mà Viettel Post CHƯA báo kết cục cuối, tính tới cuối kỳ — gồm cả ca mở từ các kỳ trước và ca nhân viên đã đóng. KHÁC “Cần care”: Cần care đếm KIỆN đang cần người làm ngay; đây đếm ĐỢT chưa có câu trả lời cứu được hay không. Bấm vào số để xem từng ca và lý do. KHÔNG thưởng phạt trên nhóm này."
                >
                  Đang treo
                </th>
                <th className="px-2.5 py-2 text-right font-semibold">Tỷ lệ cứu</th>
                <th className="px-2.5 py-2 text-right font-semibold" title="Trung vị từ lúc MỞ ca tới lần đầu có NGƯỜI CHẠM VÀO: nhận ca, đổi trạng thái, ghi note. Trung vị chứ không phải trung bình — một ca treo ba tuần kéo trung bình đi mà không nói gì về ngày làm việc bình thường.">Chạm đầu</th>
                <th className="px-2.5 py-2 text-right font-semibold" title="Trung vị tới lần đầu có HÀNH ĐỘNG NGHIỆP VỤ gửi sang ĐVVC (phát tiếp · đổi địa chỉ · thu hồi). Hai cột cố ý tách nhau: chạm vào một ca không có nghĩa là đã làm gì với kiện hàng.">Hành động đầu</th>
                {BUSINESS_ACTIONS.map((a) => (
                  <th key={a} className="px-2.5 py-2 text-right font-semibold">{BUSINESS_ACTION_LABEL[a]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {theoNguoi.length ? (
                theoNguoi.map((r) => (
                  <tr key={r.userId ?? "none"} className="border-b last:border-0 hover:bg-accent/30">
                    <td className={cn("px-2.5 py-2 font-medium", !r.userId && "text-muted-foreground italic")}>{r.name}</td>
                    <td className="numeric px-2.5 py-2 text-right">{formatNumber(r.assigned)}</td>
                    <td className="numeric px-2.5 py-2 text-right font-semibold"><So n={r.finished} {...o(r, "FINISHED")} /></td>
                    <td className="numeric px-2.5 py-2 text-right text-emerald-700 dark:text-emerald-400"><So n={r.direct} {...o(r, "RESCUED_DIRECT")} /></td>
                    <td className="numeric px-2.5 py-2 text-right text-sky-700 dark:text-sky-400"><So n={r.exchange} {...o(r, "RESCUED_EXCHANGE")} /></td>
                    <td className="numeric px-2.5 py-2 text-right text-rose-700 dark:text-rose-400"><So n={r.failed} {...o(r, "RESCUE_FAILED")} /></td>
                    <td className="numeric px-2.5 py-2 text-right text-muted-foreground">
                      <So n={r.pending} {...o(r, "PENDING")} />
                      {/*
                        Ca lịch sử chưa có kết luận không có cột riêng, và trước đây biến mất hẳn: một
                        người cầm 4 ca như vậy hiện ra với toàn số 0. Tầng hai của ô, bấm được.
                      */}
                      {r.unattributed ? (
                        <div className="whitespace-nowrap text-[10.5px]" title="Ca lịch sử chưa có kết luận (không đủ chứng cứ) — nằm ngoài mọi tỷ lệ. Bấm để xem.">
                          +<So n={r.unattributed} {...o(r, "UNATTRIBUTED")} /> lịch sử
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-2 text-right"><Ty value={r.directRate} mau={r.direct + r.failed} /></td>
                    <td className="px-2.5 py-2 text-right"><Gio phut={r.medianFirstTouchMin} mau={r.touchSample} nguong={r.timingMinSample} xungDot={r.touchInconsistent} /></td>
                    <td className="px-2.5 py-2 text-right"><Gio phut={r.medianFirstActionMin} mau={r.actionSample} nguong={r.timingMinSample} xungDot={r.actionInconsistent} /></td>
                    {BUSINESS_ACTIONS.map((a) => (
                      <td key={a} className="numeric px-2.5 py-2 text-right text-muted-foreground">{formatNumber(r.actions[a] ?? 0)}</td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={14} className="px-3 py-8 text-center text-muted-foreground">Chưa ca nào chốt kết quả trong kỳ này.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {dong && caO ? (
        <Suspense key={`${caNguoi}:${caO}`} fallback={<Skeleton className="h-48 rounded-xl" />}>
          <RescueCaseList period={period} ownerId={dong.userId} ownerName={dong.name} bucket={caO} closeHref={hrefO(raw, null)} />
        </Suspense>
      ) : null}

      <SectionCard
        title="Hiệu suất chăm sóc theo mã hàng"
        description="Ca chăm sóc gắn với VẬN ĐƠN; mã hàng gắn với DÒNG HÀNG — nên tổng theo mã lớn hơn tổng ca thật"
        actions={
          <InfoHint>
            Đơn nhiều mã thì ca đó được cộng cho MỌI mã của đơn. Không chia ca theo tỷ lệ và không gán nguyên nhân cho một mã: không có gì trong dữ liệu nói mã nào gây ra sự cố giao hàng. Mã hàng lần qua quan hệ thật (dòng hàng → mẫu mã → sản phẩm), không qua chuỗi SKU.
          </InfoHint>
        }
        padded={false}
      >
        <p className="border-b px-3 py-2 text-[11.5px] text-muted-foreground">
          {formatNumber(theoMa.totalCases)} ca trong kỳ · <b>{formatNumber(theoMa.multiCodeCases)}</b> ca thuộc đơn nhiều mã (được cộng cho từng mã) ·{" "}
          <b>{formatNumber(theoMa.unmappedCases)}</b> ca chưa lần được về mã nào
        </p>
        <TableToolsFor tableId="shipments-rescue-report-2" />
        <div className={TABLE_SCROLL}>
          <table id="shipments-rescue-report-2" className="w-full min-w-[720px] text-[12px]">
            <thead className={cn(STICKY_HEAD, "border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground")}>
              <tr>
                <th className="px-2.5 py-2 font-semibold">Mã hàng</th>
                <th className="px-2.5 py-2 text-right font-semibold">Số ca</th>
                <th className="px-2.5 py-2 text-right font-semibold">Cứu trực tiếp</th>
                <th className="px-2.5 py-2 text-right font-semibold">Cứu bằng đổi</th>
                <th className="px-2.5 py-2 text-right font-semibold">Không cứu được</th>
                <th className="px-2.5 py-2 text-right font-semibold">Đang treo</th>
                <th className="px-2.5 py-2 text-right font-semibold">Tỷ lệ cứu</th>
              </tr>
            </thead>
            <tbody>
              {theoMa.rows.length ? (
                theoMa.rows.map((r) => (
                  <tr key={r.code} className="border-b last:border-0 hover:bg-accent/30">
                    <td className="px-2.5 py-2 font-semibold">{r.code} <span className="font-normal text-muted-foreground">{r.name}</span></td>
                    <td className="numeric px-2.5 py-2 text-right">{formatNumber(r.total)}</td>
                    <td className="numeric px-2.5 py-2 text-right text-emerald-700 dark:text-emerald-400">{formatNumber(r.direct)}</td>
                    <td className="numeric px-2.5 py-2 text-right text-sky-700 dark:text-sky-400">{formatNumber(r.exchange)}</td>
                    <td className="numeric px-2.5 py-2 text-right text-rose-700 dark:text-rose-400">{formatNumber(r.failed)}</td>
                    <td className="numeric px-2.5 py-2 text-right text-muted-foreground">{formatNumber(r.pending)}</td>
                    <td className="px-2.5 py-2 text-right"><Ty value={r.directRate} mau={r.direct + r.failed} /></td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">Chưa ca nào chốt kết quả trong kỳ này.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <b>Kết quả lấy từ đâu.</b> Ca mở khi ĐVVC báo <b>{CARRIER_SUBSTATE_LABEL["WAITING_PROCESSING" as CarrierSubstate]}</b> (chỉ khi có chứng từ rời kho — mã 102 trước lúc lấy hàng
        không phải việc của đội), <b>{CARRIER_SUBSTATE_LABEL["WAITING_REDELIVERY" as CarrierSubstate]}</b> hoặc <b>{CARRIER_SUBSTATE_LABEL["DELIVERY_EXCEPTION" as CarrierSubstate]}</b>, và chốt khi ĐVVC báo kết cục cuối theo
        CHIỀU ĐI / CHIỀU HOÀN (501 chiều hoàn là hàng về shop, không phải giao thành công). Không thao tác nào của nhân viên mở hay chốt được kết quả một ca — bấm nút không làm gói hàng di chuyển.
        Ca máy đóng vì kiện không phải điều kiện care nằm ngoài mọi con số ở đây. {CARE_OUTCOME_LABEL.RESCUED_DIRECT}: {CARE_OUTCOME_HINT.RESCUED_DIRECT}
      </p>
    </div>
  );
}

"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight, List } from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/format";
import { RETURN_REASON_GROUP_ACTION, RETURN_REASON_OWNER } from "@/lib/constants/return-reason";
import { RESCUE_STATE_LABEL } from "@/lib/constants/return-rescue";
import type { ReasonGroupRow, ReasonDetailRow } from "@/lib/queries/return-reason-report";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BẢNG LÝ DO HOÀN HAI TẦNG ═══════════
 *
 * Nhóm mở sẵn, chi tiết gấp lại. Lý do: chủ shop mở báo cáo để quyết một việc — sửa xưởng, sửa
 * bảng size, hay đổi ĐVVC — và quyết định đó nằm ở tầng nhóm. Ba mươi dòng chi tiết đổ ra ngay
 * lập tức chỉ làm người đọc phải tự cộng nhẩm.
 *
 * Mỗi ô số mang tooltip có TỬ SỐ, MẪU SỐ và CÔNG THỨC — không phải chỉ một con số trần.
 */
function RescueCell({ r, count, rescued }: { r: ReasonDetailRow["rescue"]; count: number; rescued: number }) {
  /*
    "CHƯA THEO DÕI ĐƯỢC" KHÔNG ĐƯỢC IN THÀNH 0%.

    Hai con số đó dẫn tới hai kết luận trái ngược: 0% nói đội chăm sóc không cứu được ca nào;
    "chưa theo dõi được" nói ERP chưa ghi lại việc họ làm. In nhầm cái đầu là vu oan cho một đội
    ngũ bằng một lỗ hổng dữ liệu.
  */
  if (r.state !== "MEASURED") {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title={
          r.state === "NO_CASES"
            ? "Không có ca nào mang lý do này trong kỳ — không có gì để cứu, khác hẳn cứu không được."
            : `${RESCUE_STATE_LABEL.NOT_TRACKED}: có ${count} ca mang lý do này nhưng chưa ca nào được ghi thao tác xử lý của người. Chưa có bằng chứng ai đã làm gì thì không tính được tỷ lệ cứu — và KHÔNG in 0%, vì 0% nghĩa là đã làm mà không cứu được.`
        }
      >
        {r.state === "NO_CASES" ? "—" : "chưa theo dõi"}
      </span>
    );
  }
  return (
    <span className="tabular-nums" title={`${rescued} ca cứu được ÷ ${count + rescued} ca từng mang lý do này = ${formatPercent(r.value)}. Mẫu số gồm CẢ ca đã cứu lẫn ca vẫn hoàn.`}>
      {formatPercent(r.value)}
    </span>
  );
}

/**
 * ═══ BỐN CHỈ SỐ KHÁC NHAU, BỐN CÁI TÊN KHÁC NHAU ═══
 *
 * Chủ shop chốt 14/09/2026 — và đây là chỗ dễ trộn nhất trong cả báo cáo:
 *
 *   SỐ ĐƠN        — tần suất thô của lý do.
 *   TỶ TRỌNG      — ca của lý do ÷ ca hoàn ĐÃ BIẾT lý do. Cộng lại đúng 100%.
 *   TRÊN ĐÃ GỬI   — ca của lý do ÷ TOÀN BỘ lô hàng đã bàn giao ĐVVC. Đây mới là con số trả lời
 *                   "cứ 100 kiện gửi đi thì bao nhiêu hỏng vì lý do này".
 *   TỶ LỆ CỨU     — chỉ áp cho ca ĐÃ ĐƯỢC CHĂM SÓC trước khi ngã ngũ. KHÔNG phải một chỉ số về lý do.
 *
 * Hai cột giữa hay bị gọi lẫn: "vải xấu 40%" (tỷ trọng) và "vải xấu 9%" (trên đã gửi) là cùng một
 * hiện tượng. Dùng nhầm cột đầu để nói về quy mô là phóng đại hơn bốn lần.
 */
export function ReasonGroupTable({
  groups,
  known,
  eligibleSent,
  drilldownHref,
  groupHref,
}: {
  groups: ReasonGroupRow[];
  known: number;
  /** Mẫu số của cột "trên đã gửi". 0 ⇒ cột đó in "—", không in 0%. */
  eligibleSent: number;
  /**
   * Đường mở danh sách vận đơn của từng lý do, GIỮ NGUYÊN mọi bộ lọc đang bật.
   *
   * MỘT BẢNG TRA, KHÔNG PHẢI MỘT HÀM: `components/*` ở đây là Client Component, và Server Component
   * không truyền hàm qua ranh giới ấy được ("Functions cannot be passed directly to Client
   * Components"). Quy ước này đã nằm ở `docs/CONVENTIONS.md`; bản nháp đầu tiên vi phạm nó và cả
   * khối lý do hoàn biến mất sau một lớp bắt lỗi — trang vẫn 200, chỉ thiếu mất một mục.
   */
  drilldownHref: Record<string, string>;
  /**
   * Đường mở drilldown cho CẢ NHÓM — tầng đầu tiên của ba tầng (nhóm → mã hàng → vận đơn).
   *
   * Bản trước chỉ mở được ở tầng lý do CHI TIẾT, nên câu hỏi thật của chủ shop ("hoàn vì sai size
   * là vấn đề của cả shop hay của đúng một mã?") phải trả lời bằng cách bấm lần lượt tám lý do
   * con rồi tự cộng.
   */
  groupHref: Record<string, string>;
}) {
  const [mo, setMo] = useState<Record<string, boolean>>({});
  /*
    DÒNG 0 ĐƠN BỊ GẤP MẶC ĐỊNH, KHÔNG BỊ XOÁ.

    Bảng 40 dòng mà 30 dòng bằng 0 là bảng không ai đọc hết. Nhưng xoá hẳn chúng thì mất đúng cái
    thông tin quý nhất: lý do `needsHuman` bằng 0 nghĩa là CHƯA AI GHI, không phải không có ca nào.
    Nên: gấp lại, và có nút mở ra để rà soát sổ phân loại.
  */
  const [hienSoKhong, setHienSoKhong] = useState(false);
  const tong = groups.reduce((n, g) => n + g.count, 0);
  const tongCuu = groups.reduce((n, g) => n + g.rescued, 0);
  const tongMat = groups.reduce((n, g) => n + g.lostRevenue, 0);
  const soDongKhong = groups.reduce((n, g) => n + g.details.filter((d) => d.count === 0).length, 0);

  return (
    <>
      {soDongKhong ? (
        <div className="mb-2 flex items-center justify-end">
          <button
            type="button"
            onClick={() => setHienSoKhong((v) => !v)}
            className="rounded-md border border-hairline px-2 py-1 text-[11.5px] text-muted-foreground hover:bg-muted"
            title="Lý do 0 đơn được gấp lại cho bảng đọc được. Mở ra khi cần rà soát SỔ PHÂN LOẠI: lý do máy không đọc được mà bằng 0 nghĩa là chưa ai ghi, không phải không có ca nào."
          >
            {hienSoKhong ? "Ẩn" : "Hiện"} {soDongKhong} lý do 0 đơn
          </button>
        </div>
      ) : null}
    <div className={TABLE_SCROLL}>
      <table className="w-full min-w-[760px] text-sm">
        <thead className={cn(STICKY_HEAD, "border-b text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Nhóm lý do</th>
            <th className="px-3 py-2 text-left font-semibold">Lý do hoàn</th>
            <th className="px-3 py-2 text-right font-semibold" title="Số ĐƠN HOÀN mang lý do này trong kỳ lọc. Mỗi đơn đếm đúng một lần; đơn gửi lại không đếm hai lần (PRIMARY_ATTEMPT).">
              Số đơn
            </th>
            <th
              className="px-3 py-2 text-right font-semibold"
              title="Số đơn TỪNG mang lý do hoàn này nhưng kết quả cuối là GIAO THÀNH CÔNG — tức đã được cứu. Chỉ đếm ca có lý do đến từ chứng từ; đơn giao thành công bình thường chưa bao giờ gặp nguy cơ hoàn nên không vào đây."
            >
              Số đơn cứu được
            </th>
            <th
              className="px-3 py-2 text-right font-semibold"
              title="Cứu được ÷ (cứu được + còn hoàn). Chưa ca nào được ghi thao tác xử lý thì hiện 'chưa theo dõi', KHÔNG hiện 0% — 0% nghĩa là đã làm mà không cứu được, hai chuyện khác nhau."
            >
              Tỷ lệ cứu đơn
            </th>
            <th className="px-3 py-2 text-right font-semibold" title="Số đơn của lý do ÷ tổng đơn hoàn ĐÃ XÁC ĐỊNH ĐƯỢC LÝ DO. Cộng lại đúng 100%. Phần chưa ai hỏi được báo riêng ở khối độ phủ phía trên.">
              Tỷ trọng trên hoàn
            </th>
            <th className="px-3 py-2 text-right font-semibold" title="Số đơn của lý do ÷ TOÀN BỘ lô hàng đã bàn giao ĐVVC trong kỳ. Khác hẳn cột bên trái: đây là quy mô thật của lý do trên cả lô hàng, không phải tỷ trọng trong nhóm đã biết.">
              Tỷ lệ trên đã gửi
            </th>
            <th className="px-3 py-2 text-right font-semibold" title="Tổng giá trị đơn của các ca mang lý do này. Doanh thu ĐÃ MẤT, không phải doanh thu treo.">
              Doanh thu mất
            </th>
            <th className="px-3 py-2 text-right font-semibold" />
          </tr>
        </thead>
        <tbody className="divide-y">
          <tr className="bg-muted/30 font-semibold">
            <td className="px-3 py-2" colSpan={2}>
              Tổng
            </td>
            <td className="px-3 py-2 text-right tabular-nums" title={`${tong} đơn hoàn đã xác định được lý do trong kỳ lọc.`}>
              {formatNumber(tong)}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{formatNumber(tongCuu)}</td>
            <td className="px-3 py-2 text-right tabular-nums">
              <RescueCell r={{ value: tong + tongCuu ? (tongCuu / (tong + tongCuu)) * 100 : null, state: tongCuu > 0 ? "MEASURED" : tong > 0 ? "NOT_TRACKED" : "NO_CASES" }} count={tong} rescued={tongCuu} />
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{known ? "100%" : "—"}</td>
            <td className="px-3 py-2 text-right tabular-nums">{eligibleSent ? formatPercent((tong / eligibleSent) * 100) : "—"}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatVND(tongMat, { compact: true })}</td>
            <td className="px-3 py-2" />
          </tr>

          {groups.map((g) => {
            const xo = mo[g.group] ?? true;
            return (
              <Fragment key={g.group}>
                <tr className="cursor-pointer bg-muted/10 font-medium hover:bg-muted/30" onClick={() => setMo({ ...mo, [g.group]: !xo })}>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1" title={RETURN_REASON_GROUP_ACTION[g.group]}>
                      <ChevronRight className={cn("size-3.5 transition-transform", xo && "rotate-90")} />
                      {g.label}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{g.details.length} lý do</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(g.count)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(g.rescued)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <RescueCell r={g.rescue} count={g.count} rescued={g.rescued} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatPercent(g.share)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums" title={eligibleSent ? `${g.count} ÷ ${eligibleSent} kiện đã gửi` : undefined}>
                    {g.incidence === null ? "—" : formatPercent(g.incidence)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatVND(g.lostRevenue, { compact: true })}</td>
                  <td className="px-3 py-1.5 text-right">
                    {g.count ? (
                      <Link
                        href={groupHref[g.group] ?? "#"}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                        title="Mở cả nhóm: xem mã hàng nào dính nhóm lý do này, rồi xuống tới từng vận đơn."
                      >
                        <List className="size-3" /> {formatNumber(g.count)} vận đơn
                      </Link>
                    ) : null}
                  </td>
                </tr>

                {xo
                  ? g.details.filter((d) => hienSoKhong || d.count > 0).map((d) => (
                      <tr key={`${g.group}-${d.reason}`} className={cn("text-[13px]", d.count === 0 && "text-muted-foreground")}>
                        <td className="px-3 py-1" />
                        <td className="px-3 py-1 pl-8">
                          {d.label}
                          {/*
                            0 Ở MỘT LÝ DO MÁY KHÔNG ĐỌC ĐƯỢC NGHĨA LÀ CHƯA AI GHI.
                            Không nói ra thì chủ shop đọc bảng và kết luận shop không có vấn đề về
                            size, trong khi sự thật là chưa ai từng ghi lý do size lần nào.
                          */}
                          {d.count === 0 && d.needsHuman ? (
                            <span className="ml-1.5 text-[10.5px] text-amber-600 dark:text-amber-400" title="Lý do này chỉ có khi NGƯỜI của shop hỏi khách rồi ghi lại — Viettel Post không bao giờ nói vải xấu hay mặc không vừa. Số 0 ở đây nghĩa là chưa ai ghi, KHÔNG phải không có ca nào.">
                              chưa ai ghi
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums" title={d.count ? `${d.count} đơn hoàn mang lý do "${d.label}". Sửa ở: ${RETURN_REASON_OWNER[d.reason]}.` : undefined}>
                          {formatNumber(d.count)}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums">{formatNumber(d.rescued)}</td>
                        <td className="px-3 py-1 text-right">
                          <RescueCell r={d.rescue} count={d.count} rescued={d.rescued} />
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums" title={d.count ? `${d.count} ÷ ${known} đơn đã biết lý do = ${formatPercent(d.share)}` : undefined}>
                          {formatPercent(d.share)}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums" title={d.count && eligibleSent ? `${d.count} ÷ ${eligibleSent} kiện đã gửi = ${formatPercent(d.incidence)}` : undefined}>
                          {d.incidence === null ? "—" : formatPercent(d.incidence)}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums">{d.lostRevenue ? formatVND(d.lostRevenue, { compact: true }) : "—"}</td>
                        <td className="px-3 py-1 text-right">
                          {d.count ? (
                            <Link href={drilldownHref[d.reason] ?? "#"} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline" title="Mở danh sách vận đơn của đúng lý do này, giữ nguyên mọi bộ lọc đang bật.">
                              <List className="size-3" /> {formatNumber(d.count)} vận đơn
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    ))
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

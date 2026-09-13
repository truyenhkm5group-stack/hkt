"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/format";
import { RETURN_REASON_GROUP_ACTION, RETURN_REASON_OWNER } from "@/lib/constants/return-reason";
import { RESCUE_STATE_LABEL } from "@/lib/constants/return-rescue";
import type { ReasonGroupRow, ReasonDetailRow } from "@/lib/queries/return-reason-report";
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

export function ReasonGroupTable({ groups, known }: { groups: ReasonGroupRow[]; known: number }) {
  const [mo, setMo] = useState<Record<string, boolean>>({});
  const tong = groups.reduce((n, g) => n + g.count, 0);
  const tongCuu = groups.reduce((n, g) => n + g.rescued, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="border-b bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
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
              Tỷ trọng
            </th>
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
          </tr>

          {groups.map((g) => {
            const xo = mo[g.group] ?? true;
            return (
              <>
                <tr key={g.group} className="cursor-pointer bg-muted/10 font-medium hover:bg-muted/30" onClick={() => setMo({ ...mo, [g.group]: !xo })}>
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
                </tr>

                {xo
                  ? g.details.map((d) => (
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
                      </tr>
                    ))
                  : null}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

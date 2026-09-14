import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CS_ASSIGNEE_FACET_BOT, CS_ASSIGNEE_FACET_UNLINKED } from "@/lib/constants/cs-domain";
import { TABLE_FLOW } from "@/lib/constants/table-ux";
import { formatNumber } from "@/lib/format";
import type { CsOwnerLoad } from "@/lib/queries/cs";
import { cn } from "@/lib/utils";

/**
 * ═══════════ AI ĐANG GÁNH BAO NHIÊU — ĐỂ CHIA LẠI VIỆC, KHÔNG ĐỂ CHẤM ĐIỂM ═══════════
 *
 * Trưởng ca cần đúng một câu trả lời trước khi giao việc tiếp: *ai đang quá tải, ai còn chỗ, việc
 * nào chưa ai nhận*. Bảng này trả lời câu đó và dừng ở đó.
 *
 * ─── VÌ SAO KHÔNG CÓ CỘT XẾP HẠNG VÀ KHÔNG CÓ ĐIỂM TỔNG ───
 *
 * "Đã đóng hôm nay" phụ thuộc loại case rơi vào tay ai; "thời gian xử lý" phụ thuộc khách có bắt
 * máy hay không. Hai thứ người trực KHÔNG quyết được (AGENTS.md mục 24: nguồn nào có kết quả do
 * bên ngoài quyết thì không được dùng để chấm người; mục 27: điểm tổng chỉ tồn tại khi chủ shop
 * khai trọng số, và không có bộ mặc định).
 *
 * Nên đây là bảng ĐIỀU PHỐI. Nó xếp theo SỐ VIỆC QUÁ HẠN — thứ cần can thiệp ngay — chứ không theo
 * một thang điểm nào.
 *
 * ─── BA RỔ KHÔNG PHẢI NGƯỜI, VÀ CHÚNG PHẢI ĐỨNG RIÊNG ───
 *
 * `Bot ERP` là MÁY (AGENTS.md mục 36 — đo production 13/09: gộp nó vào người thì báo cáo nói có
 * 187 việc đang được người làm trong khi con số thật là 0). "Tên gõ tay chưa nối tài khoản" là
 * DÒNG LỊCH SỬ chưa quy kết được. "Chưa ai nhận" là hàng đợi chung. Gộp bất kỳ rổ nào vào người là
 * dựng ra một nhân viên không tồn tại.
 */
const RO_KHONG_PHAI_NGUOI: Record<string, string> = {
  [CS_ASSIGNEE_FACET_BOT]: "MÁY làm — không phải một người, và không phải 'đã có người nhận'.",
  [CS_ASSIGNEE_FACET_UNLINKED]: "Dòng cũ chỉ có TÊN GÕ TAY, chưa nối về tài khoản nào nên không quy kết được.",
  __NONE__: "Chưa ai nhận — đây là hàng đợi chung, không phải khối lượng việc của một người.",
};

export function OwnerLoadSection({ rows }: { rows: CsOwnerLoad[] }) {
  if (!rows.length) return null;
  const tong = rows.reduce((t, r) => t + r.open, 0);
  return (
    <SectionCard
      title="Khối lượng việc CSKH theo người"
      description={`${formatNumber(tong)} việc đang mở. Bảng này để CHIA LẠI VIỆC trong ca — không phải để thưởng/phạt: kết quả một case phụ thuộc khách có bắt máy hay không, thứ người trực không quyết được.`}
      padded={false}
    >
      <div className={cn(TABLE_FLOW)}>
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Người phụ trách</TableHead>
              <TableHead className="w-24 text-right">Đang mở</TableHead>
              <TableHead className="w-24 text-right">Quá hạn</TableHead>
              <TableHead className="w-32 text-right">Khách đang chờ</TableHead>
              <TableHead className="w-32 text-right">Đóng hôm nay</TableHead>
              <TableHead className="w-40 text-right">Trung vị xử lý (30 ngày)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const ghiChu = RO_KHONG_PHAI_NGUOI[r.key];
              return (
                <TableRow key={r.key} className={cn(ghiChu && "text-muted-foreground")}>
                  <TableCell>
                    <div className="font-medium">{r.label}</div>
                    {ghiChu ? <div className="text-[11px]">{ghiChu}</div> : null}
                  </TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.open)}</TableCell>
                  <TableCell className={cn("numeric text-right", r.overdue > 0 && "font-semibold text-rose-700 dark:text-rose-300")}>
                    {r.overdue > 0 ? (
                      <Link href="/cs?view=theo-khach&sla=OVERDUE" className="hover:underline">
                        {formatNumber(r.overdue)}
                      </Link>
                    ) : (
                      formatNumber(r.overdue)
                    )}
                  </TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.waitingCustomer)}</TableCell>
                  <TableCell className="numeric text-right">{formatNumber(r.completedToday)}</TableCell>
                  <TableCell className="numeric text-right">
                    {/*
                      CHƯA ĐỦ MẪU IN "—", KHÔNG IN 0 (AGENTS.md mục 42). Một người đóng đúng hai case
                      trong 30 ngày thì trung vị của họ không nói lên điều gì; in ra một con số cạnh
                      người có 40 case là mời người đọc so hai thứ không so được.
                    */}
                    {r.medianResolutionHours === null ? <span title="Chưa đủ case đã đóng để tính trung vị">—</span> : `${r.medianResolutionHours.toFixed(1)} giờ`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="border-t px-4 py-2 text-[11.5px] text-muted-foreground">
        Việc theo PHÒNG BAN, hạn xử lý và máy phân việc nằm ở{" "}
        <Link href="/work" className="text-primary hover:underline">
          Hệ điều hành công việc
        </Link>{" "}
        — bảng này chỉ là lát cắt CSKH của nó, không phải một sổ thứ hai.
      </p>
    </SectionCard>
  );
}

import { HelpCircle } from "lucide-react";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getProfitCashBridge } from "@/lib/queries/profit-cash-bridge";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * BẢNG ĐỐI CHIẾU LỢI NHUẬN → TIỀN.
 *
 * Đi từ "lãi bao nhiêu" sang "tài khoản dày lên bao nhiêu" và gọi tên từng khoản làm nên khoảng
 * lệch. Đây là câu hỏi mà chủ shop hỏi nhiều nhất và ERP chưa từng trả lời: "báo cáo nói lãi 80
 * triệu, sao tài khoản chỉ thêm 12 triệu".
 *
 * ─── DÒNG "CHƯA GIẢI THÍCH ĐƯỢC" LÀ TÍNH NĂNG, KHÔNG PHẢI THIẾU SÓT ───
 *
 * Bảng này cố ý KHÔNG ép cho khớp. ERP không có sổ công nợ phải trả nhà cung cấp và không có khấu
 * hao, nên phần dư là thật. Nhồi nó vào một khoản "điều chỉnh khác" để bảng khớp 0đ là cách hợp
 * pháp hoá mọi sai sót về sau: từ đó trở đi, mọi lỗi mới cũng lặng lẽ chảy vào đúng cái khoản đó.
 */
export async function BridgeTab({ period }: { period: Period }) {
  const r = await getProfitCashBridge(period);
  const dieuChinh = r.lines.filter((l) => !l.anchor);

  return (
    <div className="space-y-5">
      <SectionCard
        title="Từ lợi nhuận sang tiền thật"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {period.label}
            <DataWarnings items={r.reasons} />
          </span>
        }
        hint={
          <>
            <p className="mb-2">Mỗi dòng là một khoản làm tiền khác lợi nhuận.</p>
            <p className="mb-2">
              LỢI NHUẬN đo theo kỳ hưởng lợi ích (đơn giao trong kỳ là doanh thu của kỳ, dù tiền về kỳ sau). TIỀN đo theo ngày tiền động (tiền COD kỳ này có thể là của đơn giao kỳ trước). Hai cơ sở khác nhau, nên lệch nhau là chuyện BÌNH THƯỜNG — bảng này chỉ ra lệch ở đâu.
            </p>
            <p className="mb-1 font-medium">Đọc bảng này thế nào:</p>
            <ul className="mb-2 space-y-1">
              <li>
                <span className="font-semibold">Dấu ÂM</span> nghĩa là tiền THẤP hơn lợi nhuận: lãi đã ghi mà tiền chưa về, hoặc tiền đã đi mà chưa thành chi phí của kỳ.
                Khoản COD chờ về và khoản nhập hàng là hai nguồn lớn nhất.
              </li>
              <li>
                <span className="font-semibold">Dấu DƯƠNG</span> nghĩa là tiền CAO hơn lợi nhuận: khách trả trước cho đơn chưa giao, hoặc tiền vay về. Cả hai đều KHÔNG phải
                lãi — tiền vay phải trả lại, tiền trả trước còn nợ khách một lần giao hàng.
              </li>
              <li>
                <span className="font-semibold">Phần dư lớn</span> thường có đúng một nguyên nhân: sổ ngân hàng chưa đủ. Nối SePay để mọi giao dịch tự vào sổ thì phần dư co
                lại và bảng này mới dùng để ra quyết định được.
              </li>
            </ul>
            <p>Vì sao bảng này KHÔNG khớp về 0: xem nhãn lưu ý dữ liệu cạnh kỳ — đọc trước khi tin phần dư.</p>
          </>
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[480px]">
            <TableHeader>
              <TableRow>
                <TableHead>Khoản</TableHead>
                <TableHead className="text-right">Số tiền</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Mốc khởi đầu */}
              <TableRow className="bg-surface-sunken/50">
                <TableCell className="font-bold">
                  <span className="inline-flex items-center gap-1">
                    {r.lines[0].label}
                    <InfoHint>{r.lines[0].why}</InfoHint>
                  </span>
                </TableCell>
                <TableCell className="text-right font-bold">
                  <Money value={r.profit} sign />
                </TableCell>
              </TableRow>

              {dieuChinh.map((l) => (
                <TableRow key={l.key}>
                  <TableCell className={cn("font-medium", !l.known && "text-muted-foreground")}>
                    {l.label}
                    <InfoHint className="ml-1 align-middle">{l.why}</InfoHint>
                    {!l.known ? (
                      <span
                        className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
                        title="Không đo được với kỳ đang chọn, nên KHÔNG được cộng vào tổng. Chưa biết không phải 0."
                      >
                        chưa biết
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className={cn("text-right", !l.known ? "text-muted-foreground" : l.amount < 0 && "text-rose-600 dark:text-rose-400")}>
                    {/* CHƯA BIẾT hiện dấu gạch chứ không hiện 0đ — hai thứ đó khác nhau về nghiệp vụ. */}
                    {l.known ? <Money value={l.amount} sign /> : "—"}
                  </TableCell>
                </TableRow>
              ))}

              {/* Phần dư — đứng riêng, có nhãn trung thực */}
              <TableRow>
                <TableCell className="font-medium">
                  Chưa giải thích được
                  <InfoHint className="ml-1 align-middle">
                    Phần còn lại không khoản nào ở trên giải thích. CỐ Ý để đứng riêng thay vì nhồi vào một dòng &ldquo;điều chỉnh khác&rdquo; cho bảng khớp 0đ — bảng khớp
                    kiểu đó sẽ âm thầm hấp thụ mọi sai sót về sau.
                  </InfoHint>
                  <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                    <HelpCircle className="size-3" /> phần dư
                  </span>
                </TableCell>
                <TableCell className="text-right">{r.unexplained === null ? <span className="text-muted-foreground">—</span> : <Money value={r.unexplained} sign />}</TableCell>
              </TableRow>

              {/* Mốc đích */}
              <TableRow className="bg-surface-sunken/50">
                <TableCell className="font-bold">
                  <span className="inline-flex items-center gap-1">
                    Dòng tiền ròng thật trên sao kê
                    <InfoHint>Theo NGÀY TIỀN ĐỘNG, đã loại chuyển giữa tài khoản của mình.</InfoHint>
                  </span>
                </TableCell>
                <TableCell className="text-right font-bold">
                  {r.cashMovement === null ? <span className="text-muted-foreground">Chưa biết</span> : <Money value={r.cashMovement} sign />}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

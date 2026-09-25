import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { requireUser } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { getOwnerDecisionQueue } from "@/lib/queries/owner-decisions";
import { KindGroupBlock, SourceWarnings } from "@/app/(dashboard)/cockpit/decision-list";

/**
 * ═══════════ KHỐI "CẦN ANH QUYẾT" TRÊN TRANG CHỦ (Company OS · Agent H) ═══════════
 *
 * Đứng TRÊN "Việc cần làm hôm nay": khối kia là hàng đợi VIỆC của cả shop (ai cũng làm được), khối này
 * chỉ gồm QUYẾT ĐỊNH của người điều hành — duyệt, chốt, cắt, đặt, xả. Mỗi loại một hàng: số đếm + 3 dòng
 * đầu, đủ danh sách ở `/cockpit`.
 *
 * Người xem chỉ thấy loại mà họ mở được màn hình chủ (quyền + phạm vi). Nguồn hỏng / chậm được nêu tên,
 * không biến khối thành "không có gì" giả.
 */
export async function OwnerDecisionsSection() {
  const user = await requireUser();
  const q = await getOwnerDecisionQueue({ viewer: user });
  if (!q.kinds.length) return null;

  const snoozed = q.hidden.filter((h) => h.latest?.decision === "SNOOZED").length;
  const dismissed = q.hidden.length - snoozed;

  return (
    <SectionCard
      id="can-anh-quyet"
      title={
        <>
          Cần anh quyết
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary tabular-nums">{formatNumber(q.total)}</span>
        </>
      }
      hint={
        <>
          <p>Quyết định thuộc về người điều hành, gom từ các màn hình đang chạy: yêu cầu duyệt, mẫu chờ duyệt, topic chờ chốt, chiến dịch nên cắt, lệnh sản xuất quá hẹn, mẫu quảng cáo đề nghị tăng, và ba kết luận tồn kho. Không có công thức hay ngưỡng mới nào ở đây.</p>
          <p className="mt-1.5">Nút hành động mở màn hình chủ — việc thật làm và đóng ở đó. Ba nút nhỏ chỉ ghi lại anh nghĩ gì về đề xuất: Chấp nhận (vẫn hiện tới khi làm xong), Bỏ qua (bắt buộc lý do, ẩn tới khi nguồn đổi kết luận), Nhắc lại sau (ẩn tới ngày chọn).</p>
        </>
      }
      actions={
        <Link href="/cockpit" className="text-xs font-semibold text-primary hover:underline">
          Mở buồng lái
        </Link>
      }
      padded={false}
    >
      {q.groups.length ? (
        q.groups.map((g) => <KindGroupBlock key={g.kind} group={g} limit={3} from="home" />)
      ) : (
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">
          {q.failed.length ? "Các nguồn đọc được không có quyết định nào đang chờ — xem dòng cảnh báo bên dưới." : "Không có quyết định nào đang chờ anh."}
        </p>
      )}
      {q.hidden.length ? (
        <div className="border-t px-5 py-2 text-[11px] text-muted-foreground">
          <Link href="/cockpit?an=1" className="hover:underline">
            {dismissed ? `${formatNumber(dismissed)} đề xuất đã bỏ qua` : ""}
            {dismissed && snoozed ? " · " : ""}
            {snoozed ? `${formatNumber(snoozed)} đang hẹn nhắc lại` : ""}
          </Link>
        </div>
      ) : null}
      <SourceWarnings failed={q.failed} notes={q.notes} />
    </SectionCard>
  );
}

import { SectionCard } from "@/components/ui-bits";
import { getApprovalEnforceState } from "@/lib/actions/approvals";
import { APPROVAL_THRESHOLD, APPROVAL_VALID_HOURS, type ApprovalGroup } from "@/lib/constants/approval";
import { formatVND } from "@/lib/format";
import { ApprovalEnforceToggle } from "@/app/(dashboard)/alerts/approval-enforce-toggle";

/**
 * ───────────── CÔNG TẮC CƯỠNG CHẾ DUYỆT HAI BƯỚC — CHỈ QUẢN TRỊ VIÊN ─────────────
 *
 * Company OS · Agent G. Trước bản này khoá `approval.enforce` không có màn hình nào ghi được. Công
 * tắc đặt NGAY DƯỚI hàng chờ duyệt vì đó là nơi hậu quả của nó hiện ra: bật một nhóm là từ lượt sau,
 * mọi việc trong nhóm ấy (vượt ngưỡng) phải có người thứ hai gật mới chạy.
 *
 * Mặc định TẮT hết, và bản phát hành này KHÔNG bật nhóm nào — bật là quyết định của chủ shop.
 * `getApprovalEnforceState()` trả rỗng cho người không phải ADMIN, nên mục này tự biến mất với họ.
 */
export async function ApprovalEnforcePanel() {
  const state = await getApprovalEnforceState();
  if (!state.length) return null;
  const dangBat = state.filter((s) => s.enforced).length;
  return (
    <SectionCard
      title="Cưỡng chế duyệt hai bước"
      description={`${dangBat ? `${dangBat} nhóm đang BẬT` : "Tất cả đang TẮT"} · bật là quyết định của chủ shop, không phải cấu hình kỹ thuật.`}
      hint={`TẮT: việc vẫn chạy ngay, chỉ để lại dòng nhật ký "chưa cần duyệt". BẬT: việc vượt ngưỡng dừng lại thành một yêu cầu chờ người KHÁC duyệt; người xin bấm lại đúng việc đó sau khi được duyệt thì việc chạy, và lời duyệt chỉ dùng được MỘT lần trong ${APPROVAL_VALID_HOURS} giờ. Chưa có người duyệt thứ hai (ADMIN / MANAGER khác người xin) thì việc bị CHẶN hẳn — không tự cho qua. Mỗi lần bật / tắt được ghi nhật ký trước/sau.`}
      padded={false}
    >
      <ul className="divide-y">
        {state.map((s) => (
          <li key={s.group} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {s.label}
                <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">{nguongChu(s.group)}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">{s.reason}</div>
              {!s.wired ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">Chưa nối vào thao tác nào — bật lên cũng không chặn được gì, nên không bật được.</div> : null}
            </div>
            <ApprovalEnforceToggle group={s.group} label={s.label} enforced={s.enforced} disabled={!s.wired} />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function nguongChu(group: ApprovalGroup): string {
  const n = APPROVAL_THRESHOLD[group];
  return n === undefined ? "mọi mức tiền" : `từ ${formatVND(n)}`;
}

import { PageHeader } from "@/components/page-header";
import { ApprovalSection } from "@/app/(dashboard)/alerts/approval-section";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Duyệt" };

/**
 * ═══════════ TRANG DUYỆT — HÀNG ĐỢI DUYỆT HAI BƯỚC CỦA LÕI ═══════════
 *
 * Trước trang này, lối vào DUY NHẤT để duyệt là mục đầu trang Cần xử lý (`/alerts`) — thuộc module «Cần xử lý», mà
 * module ấy phụ thuộc «Đơn hàng». Tổ chức dịch vụ (mẫu service-business: không Sản phẩm, không Đơn hàng) cài luật
 * «Hợp đồng lớn ⇒ trưởng phòng duyệt ⇒ việc»: lượt chạy xin duyệt, link «Mở hàng đợi duyệt» dẫn tới `/module-disabled`,
 * và lượt chạy treo «chờ duyệt» mãi (bài chấp nhận Phase 12, E2E #3).
 *
 * Trang thuộc module LÕI (`core`), cổng là khoá `approvals:decide` của lõi. KHÔNG có đường duyệt thứ hai: cùng
 * component (`ApprovalSection`), cùng server action (`decideApproval` — kiểm lại `approvals:decide`, người xin không
 * tự duyệt, ghi nhật ký), cùng truy vấn với trang Cần xử lý. Trang Cần xử lý của tổ chức nhà giữ nguyên mục duyệt.
 */
export default async function ApprovalsPage() {
  await requirePermission("approvals:decide");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Nền tảng"
        title="Duyệt"
        description="Việc đang chờ người thứ hai quyết — của người trong tổ chức và của luật tự động có cửa duyệt."
        hint="Duyệt: việc được làm đúng một lần (luật tự động chạy tiếp ở lượt kế tiếp). Từ chối: bắt buộc nêu lý do. Người xin không duyệt được việc của chính mình."
      />
      <ApprovalSection standalone />
    </div>
  );
}

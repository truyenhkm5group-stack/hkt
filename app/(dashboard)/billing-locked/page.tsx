import Link from "next/link";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { can, requireUser } from "@/lib/auth/session";
import { BILLING_STANDING_LABEL } from "@/lib/billing/rules";
import { orgBillingStanding } from "@/lib/billing/standing";
import { formatDate } from "@/lib/format";
import { listActiveAdmins } from "@/lib/queries/platform-modules";

export const metadata = { title: "Chỉ xem — quá hạn thanh toán" };

/**
 * ĐÍCH ĐẾN KHI MỘT LƯỢT GHI BỊ CHẶN VÌ QUÁ HẠN THANH TOÁN (0187 — `requireUser` chuyển tới đây). Nói ba điều: tổ chức đang
 * chỉ xem từ bao giờ, cái gì vẫn dùng được, AI gia hạn được và gia hạn ở đâu. Mở trực tiếp khi tổ chức KHÔNG bị khoá thì
 * nói đúng điều đó — trang này không bao giờ là trang lỗi.
 */
export default async function BillingLockedPage() {
  const user = await requireUser();
  const org = user.organization;
  const standing = org ? await orgBillingStanding(org, new Date(), { fresh: true }) : null;
  const locked = standing?.kind === "LOCKED";
  const canPay = can(user, "settings:manage");
  const admins = locked && !canPay ? await listActiveAdmins() : [];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader eyebrow="Thanh toán" title={locked ? "Tổ chức đang ở chế độ chỉ xem" : "Tổ chức không bị khoá"} description={standing ? BILLING_STANDING_LABEL[standing.kind] : undefined} refresh={false} />
      <SectionCard>
        <div className="flex gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <div className="min-w-0 space-y-3 text-sm" data-billing-locked={locked ? "1" : "0"}>
            {locked ? (
              <>
                <p>
                  Gói của {org?.name ?? "tổ chức"} hết hạn ngày <span className="font-semibold">{formatDate(standing?.paidThrough)}</span> và đã qua thời gian ân hạn. Thao tác vừa rồi chưa được lưu.
                </p>
                <p>
                  <span className="font-medium">Vẫn dùng được:</span> xem mọi màn hình, tìm kiếm, xuất tệp, đăng xuất. <span className="font-medium">Tạm dừng:</span> tạo / sửa / xoá, luật tự động, đồng bộ nền.
                  Không dữ liệu nào bị xoá — gia hạn xong là dùng lại ngay, đúng như trước.
                </p>
                {canPay ? null : <p>Người gia hạn được: quản trị của tổ chức{admins.length ? ` — ${admins.map((a) => a.name || a.email).join(", ")}` : ""}.</p>}
              </>
            ) : (
              <p>Tổ chức của bạn đang dùng bình thường. Nếu vừa thấy thông báo chỉ xem, có thể tiền vừa về — thử lại thao tác.</p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {canPay ? (
                <Button asChild size="sm">
                  <Link href="/settings/plan">Gia hạn ngay</Link>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="outline">
                <Link href="/">Về Tổng quan</Link>
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

import { CopyButton } from "@/components/misc";
import { SyncButton } from "@/components/sync-button";
import { SectionCard } from "@/components/ui-bits";
import { pancakeOrgWebhookPath } from "@/lib/constants/pancake-pos-org";
import { env } from "@/lib/env";
import { orgPancakePosActive } from "@/lib/platform/capabilities";
import { webhookUrlToken } from "@/lib/platform/webhooks";

/**
 * Khung «Pancake POS của tổ chức» trên /settings/connections (F1 · docs/verticals/fashion-cod.md) — chỉ tổ chức khách. Ba
 * việc sau khi kết nối đã Kiểm tra đạt + Bật: chép URL webhook vào Pancake (đơn về tức thời), bấm «Đồng bộ ngay» (kéo đủ lần
 * đầu), và biết trước hệ quả: Pancake là NGUỒN đơn / khách / sản phẩm. URL mang token của tổ chức — trang này đã đòi quyền
 * quản lý kết nối.
 */
export async function OrgPosPanel({ orgCode }: { orgCode: string }) {
  const active = await orgPancakePosActive();
  const token = webhookUrlToken("PANCAKE_POS_ORG", orgCode);
  const url = token ? `${env.appUrl.replace(/\/+$/, "")}${pancakeOrgWebhookPath(token)}` : null;
  return (
    <SectionCard
      title="Pancake POS của tổ chức — đồng bộ"
      description="Đơn, khách, sản phẩm và tồn kho từ Pancake POS của chính shop. Bật kết nối ⇒ Pancake là NGUỒN đơn / khách / sản phẩm: ERP thôi tạo tay và chatbot ERP thôi lên đơn (một lần mua không hai bản)."
    >
      {!active ? (
        <p className="text-sm text-muted-foreground" data-pancake-org="inactive">
          Chưa bật. Khai API key + mã shop ở dòng «Pancake POS của tổ chức» trong bảng Nguồn đơn bên dưới, bấm Kiểm tra, rồi Bật — khung này hiện URL webhook và nút đồng bộ.
        </p>
      ) : (
        <div className="space-y-3 text-sm" data-pancake-org="active">
          <div className="space-y-1">
            <p className="font-medium">1. Dán URL webhook vào Pancake POS</p>
            <p className="text-xs text-muted-foreground">Pancake POS → Cấu hình → Webhook: dán URL dưới đây, chọn Đơn hàng, Khách hàng, Sản phẩm, Tồn kho. Đơn mới / đơn đổi trạng thái về ERP trong vài giây.</p>
            {url ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">{url}</code>
                <CopyButton value={url} what="URL webhook" label="Sao chép" />
              </div>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300">Máy chủ chưa có khoá bí mật nền tảng — chưa cấp được URL webhook. Báo bên cung cấp phần mềm.</p>
            )}
          </div>
          <div className="space-y-1">
            <p className="font-medium">2. Kéo dữ liệu lần đầu</p>
            <p className="text-xs text-muted-foreground">Lần đầu kéo 30 ngày đơn gần nhất cùng toàn bộ sản phẩm, khách, tồn kho. Bấm lại bất cứ lúc nào để bù phần webhook có thể đã lỡ.</p>
            <SyncButton job="pancake-org" label="Đồng bộ ngay" />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

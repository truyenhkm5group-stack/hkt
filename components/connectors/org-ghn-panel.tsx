import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CopyButton } from "@/components/misc";
import { SectionCard } from "@/components/ui-bits";
import { ghnOrgWebhookPath } from "@/lib/constants/carrier-ghn";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { webhookUrlToken } from "@/lib/platform/webhooks";

/**
 * Khung «GHN của tổ chức — webhook» trên /settings/connections (POS tự chủ) — chỉ tổ chức khách. Token + ShopId khai ở dòng
 * «GHN của tổ chức (tạo vận đơn)» bên dưới; khung này cấp URL webhook mang token riêng của tổ chức để shop tự dán vào
 * developer.ghn.vn → Cấu hình webhook (tài liệu GHN: shop tự đăng ký, ~15 phút có hiệu lực). Gói tin gần nhất là bằng chứng.
 */
export async function OrgGhnPanel({ orgCode }: { orgCode: string }) {
  if (!(await canUseModule("logistics"))) return null;
  const token = webhookUrlToken("GHN_ORG", orgCode);
  const url = token ? `${env.appUrl.replace(/\/+$/, "")}${ghnOrgWebhookPath(token)}` : null;
  const db = await getDb();
  const [stat] = await db
    .select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${schema.webhookEvents.receivedAt})` })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.source, "GHN"));
  const count = Number(stat?.n ?? 0);
  return (
    <SectionCard title="GHN của tổ chức — webhook trạng thái" description="Hành trình vận đơn GHN do ERP tạo: chờ lấy · đã lấy · đang giao · giao thành công / hoàn / huỷ. Mã cuối của GHN là chứng từ kết quả đơn.">
      <div className="space-y-1 text-sm" data-ghn-org={count > 0 ? "receiving" : "waiting"}>
        <p className="text-xs text-muted-foreground">developer.ghn.vn → đăng nhập → menu tài khoản → «Cấu hình webhook» → tab Đơn hàng → dán URL này → «Tạo webhook». Thay đổi có hiệu lực sau khoảng 15 phút.</p>
        {url ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">{url}</code>
            <CopyButton value={url} what="URL webhook GHN" label="Sao chép" />
          </div>
        ) : (
          <p className="text-xs text-amber-700 dark:text-amber-300">Máy chủ chưa có khoá bí mật nền tảng — chưa cấp được URL webhook. Báo bên cung cấp phần mềm.</p>
        )}
        <p className="text-xs">
          {count > 0 ? (
            <>
              Đã nhận <b>{formatNumber(count)}</b> gói tin · gần nhất {formatDateTime(stat?.last ?? null)}.
            </>
          ) : (
            <span className="text-muted-foreground">Chưa nhận gói tin nào — gói đầu tiên về là bằng chứng đã nối được.</span>
          )}
        </p>
      </div>
    </SectionCard>
  );
}

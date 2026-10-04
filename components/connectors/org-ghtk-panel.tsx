import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CopyButton } from "@/components/misc";
import { SectionCard } from "@/components/ui-bits";
import { ghtkOrgWebhookPath } from "@/lib/constants/carrier-ghtk";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { webhookUrlToken } from "@/lib/platform/webhooks";

/**
 * Khung «GHTK của tổ chức — webhook» trên /settings/connections (POS tự chủ) — chỉ tổ chức khách. Token + mã shop + nơi lấy
 * hàng khai ở dòng «GHTK của tổ chức (tạo vận đơn)» bên dưới; khung này cấp URL webhook mang token riêng của tổ chức để shop
 * dán vào web khách hàng GHTK (Cấu hình API → Webhook). Gói tin gần nhất là bằng chứng đã nối được.
 */
export async function OrgGhtkPanel({ orgCode }: { orgCode: string }) {
  if (!(await canUseModule("logistics"))) return null;
  const token = webhookUrlToken("GHTK_ORG", orgCode);
  const url = token ? `${env.appUrl.replace(/\/+$/, "")}${ghtkOrgWebhookPath(token)}` : null;
  const db = await getDb();
  const [stat] = await db
    .select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${schema.webhookEvents.receivedAt})` })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.source, "GHTK"));
  const count = Number(stat?.n ?? 0);
  return (
    <SectionCard title="GHTK của tổ chức — webhook trạng thái" description="Hành trình vận đơn GHTK do ERP tạo: chờ lấy · đã lấy · đang giao · đã giao / đã trả hàng / huỷ. Mã cuối của GHTK là chứng từ kết quả đơn.">
      <div className="space-y-1 text-sm" data-ghtk-org={count > 0 ? "receiving" : "waiting"}>
        <p className="text-xs text-muted-foreground">khachhang.giaohangtietkiem.vn → Thông tin shop → Cấu hình API → ô URL webhook → dán URL này → lưu. Nếu không thấy ô webhook, gửi URL này cho GHTK (hotline / chat hỗ trợ) để họ khai giúp.</p>
        {url ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">{url}</code>
            <CopyButton value={url} what="URL webhook GHTK" label="Sao chép" />
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

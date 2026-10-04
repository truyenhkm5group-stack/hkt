import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CopyButton } from "@/components/misc";
import { SectionCard } from "@/components/ui-bits";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { webhookUrlToken } from "@/lib/platform/webhooks";

/**
 * Khung «Viettel Post của tổ chức» trên /settings/connections (F2 · docs/verticals/fashion-cod.md) — chỉ tổ chức khách. Viettel
 * Post không cấp API tra cứu cho shop, nên nguồn tin là webhook (URL mang token riêng của tổ chức) + tệp nhập tay. Gói tin gần
 * nhất là bằng chứng đã nối được — không có nút «Kiểm tra» vì không có API nào để hỏi.
 */
export async function OrgCarrierPanel({ orgCode }: { orgCode: string }) {
  if (!(await canUseModule("logistics"))) {
    return (
      <SectionCard title="Viettel Post của tổ chức">
        <p className="text-sm text-muted-foreground">Bật module Giao vận (Hệ thống → Module của tổ chức) để nhận hành trình vận đơn Viettel Post.</p>
      </SectionCard>
    );
  }
  const token = webhookUrlToken("VIETTELPOST_ORG", orgCode);
  const url = token ? `${env.appUrl.replace(/\/+$/, "")}/api/webhooks/viettelpost-org/${token}` : null;
  const db = await getDb();
  const [stat] = await db
    .select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${schema.webhookEvents.receivedAt})` })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.source, "VIETTELPOST"));
  const count = Number(stat?.n ?? 0);
  return (
    <SectionCard
      title="Viettel Post của tổ chức"
      description="Hành trình vận đơn, giao thành công / hoàn, COD — nguồn cho trang Vận đơn, Hoàn hàng, Đối soát COD và kết quả đơn. Viettel Post không cấp API tra cứu cho shop: tin về qua webhook và tệp."
    >
      <div className="space-y-3 text-sm" data-vtp-org={count > 0 ? "receiving" : "waiting"}>
        <div className="space-y-1">
          <p className="font-medium">1. URL webhook của shop</p>
          <p className="text-xs text-muted-foreground">Đưa URL này vào cấu hình webhook trạng thái đơn trong tài khoản Viettel Post của shop. Chưa thấy mục cấu hình ⇒ gọi CSKH Viettel Post xin bật webhook trạng thái đơn và gửi họ URL này.</p>
          {url ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">{url}</code>
              <CopyButton value={url} what="URL webhook Viettel Post" label="Sao chép" />
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
        <div className="space-y-1">
          <p className="font-medium">2. Tệp từ Viettel Post</p>
          <p className="text-xs text-muted-foreground">
            Tệp «Danh sách vận đơn» (bù trạng thái webhook không đẩy, vd lấy hàng thất bại) và bảng kê COD (tiền thực thu) nhập ở{" "}
            <Link href="/import-vtp" className="text-primary hover:underline">
              Bổ sung danh sách vận đơn
            </Link>
            .
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

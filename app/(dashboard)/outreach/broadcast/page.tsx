import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BroadcastComposer } from "@/app/(dashboard)/outreach/broadcast/broadcast-composer";
import { BroadcastHistory, type BroadcastHistoryRow } from "@/app/(dashboard)/outreach/broadcast/broadcast-history";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { can, requirePermission } from "@/lib/auth/session";
import { isBroadcastStale } from "@/lib/constants/outreach-broadcast";
import { loadOutreachConfig } from "@/lib/outreach/build";
import { broadcastFilterOptions, listBroadcasts } from "@/lib/queries/outreach-broadcast";

export const metadata = { title: "Gửi tin hàng loạt" };

export default async function OutreachBroadcastPage() {
  const user = await requirePermission("outreach:view");
  const canSend = can(user, "outreach:send");
  const [options, broadcasts, config] = await Promise.all([broadcastFilterOptions(), listBroadcasts(), loadOutreachConfig()]);
  const now = new Date();
  const history: BroadcastHistoryRow[] = broadcasts.map((b) => ({
    ...b,
    createdAt: b.createdAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
    stale: b.status === "RUNNING" && isBroadcastStale(b.heartbeatAt, now),
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Gửi tin hàng loạt"
        description="Lọc khách theo fanpage, ngày, thẻ Pancake, trạng thái — xem trước — rồi bấm gửi."
        hint="Meta chỉ cho trang nhắn trong 24 giờ kể từ tin cuối KHÁCH gửi, nên khách quá 24 giờ được đếm riêng và không vào lượt gửi (gửi cũng bị Meta từ chối, mã #10). Ngay trước khi gửi từng khách, ERP đọc lại hội thoại: khách vừa nhắn lại thì để nhân viên trả lời, khách vừa lên đơn thì bỏ qua. Mỗi khách nhận đúng một lần mỗi lượt. Dữ liệu lọc lấy từ lượt quét hội thoại Pancake mỗi 15 phút."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/outreach">
              <ArrowLeft className="size-4" /> Chăm sóc & bán chéo
            </Link>
          </Button>
        }
      />
      <BroadcastComposer pages={options.pages} tags={options.tags} canSend={canSend} defaultMessage={config.nurtureSteps[0] ?? ""} />
      <BroadcastHistory rows={history} canSend={canSend} />
    </div>
  );
}

import Link from "next/link";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechPriorityBadge, TechRiskBadge } from "@/app/(dashboard)/tech/badges";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { TECH_OWNER_ESCALATION_LABEL, type TechOwnerEscalation, type TechPriority, type TechRisk } from "@/lib/constants/tech";
import { formatTimeAgo } from "@/lib/format";
import { techNeedsOwnerQueue } from "@/lib/queries/tech-control-plane";

export const metadata = { title: "Cần chủ shop · Phòng Tech AI" };

/**
 * MỘT câu hỏi: "cái gì đang đứng im vì tôi?". Thiết kế cho điện thoại: mỗi dòng là một thẻ to, câu việc
 * phải làm đứng đầu, bấm vào là mở đúng việc để duyệt / gỡ.
 */
export default async function TechNeedsOwnerPage() {
  await requirePermission("tech:view");
  const items = await techNeedsOwnerQueue();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Cần chủ shop"
        description={items.length ? `${items.length} việc đang chờ đúng một việc của bạn` : "Không có gì đang chờ bạn"}
        hint={
          <>
            Hai loại: việc máy / agent đã dừng lại vì cần bạn (duyệt, cấp khoá, đăng nhập dịch vụ ngoài, quyết định
            không hoàn tác…) và việc mức R2 đang chờ bạn duyệt trước khi deploy. Mọi thứ khác hệ thống tự đi tiếp.
          </>
        }
      />
      <TechNav />

      {items.length === 0 ? (
        <EmptyState title="Không có gì đang chờ bạn" description="Khi một việc cần bạn, nó hiện ở đây kèm đúng việc phải làm." />
      ) : (
        <div className="space-y-3">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/tech/tasks/${t.id}`}
              className="block rounded-xl border-2 border-fuchsia-200 bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-muted/40 dark:border-fuchsia-900"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-fuchsia-700 dark:text-fuchsia-300">
                {t.status === "NEEDS_OWNER" ? (TECH_OWNER_ESCALATION_LABEL[t.ownerEscalation as TechOwnerEscalation] ?? t.ownerEscalation) : "Chờ bạn duyệt trước khi deploy"}
              </p>
              <p className="mt-1 text-base font-semibold leading-snug">{t.status === "NEEDS_OWNER" ? t.ownerAction : t.title}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-semibold">{t.code}</span>
                {t.status === "NEEDS_OWNER" ? <span className="truncate">· {t.title}</span> : null}
                <TechPriorityBadge priority={t.priority as TechPriority} />
                <TechRiskBadge risk={t.risk as TechRisk} />
                {t.mission ? <span>· {t.mission.code}</span> : null}
                <span>· chờ {formatTimeAgo(t.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

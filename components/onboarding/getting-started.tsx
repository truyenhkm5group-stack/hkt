import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, CircleDashed } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Progress } from "@/components/ui/progress";
import type { SessionUser } from "@/lib/auth/session";
import { getGettingStarted } from "@/lib/onboarding/progress";
import { cn } from "@/lib/utils";

/**
 * TRANG CHỦ CỦA TỔ CHỨC KHÔNG PHẢI NHÀ (Phase 10 · §3): thẻ "Bắt đầu" thay cho các thẻ KPI của tổ chức nhà — những thẻ
 * ấy đọc luật COD / Pancake / Viettel Post của VNX và với một tổ chức mới chỉ là một bảng số 0 giả. Tiến độ đo từ dữ
 * liệu thật (`lib/onboarding/progress.ts`); bước không đo được hiện vòng nét đứt và không tính vào tiến độ.
 */
export async function GettingStartedHome({ user }: { user: SessionUser }) {
  const gs = await getGettingStarted(user);
  const pct = gs.measurable ? Math.round((gs.done / gs.measurable) * 100) : 0;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={user.organization?.name ?? "Tổ chức"}
        title="Bắt đầu"
        description={`${gs.done}/${gs.measurable} bước đã xong${gs.planName ? ` · gói ${gs.planName}` : ""}`}
        actions={
          <Link href="/settings/plan" className="text-xs font-medium text-primary hover:underline">
            Gói & hạn mức
          </Link>
        }
      />
      <SectionCard title="Dựng ERP của bạn" description="Mỗi bước tự đánh dấu xong khi dữ liệu thật xuất hiện — không có ô nào để bấm cho xong." padded={false} contentClassName="p-0">
        <div className="px-4 pb-2 pt-3">
          <Progress value={pct} aria-label={`Tiến độ ${pct}%`} />
        </div>
        <ul className="divide-y divide-hairline" data-getting-started>
          {gs.steps.map((s) => {
            const Icon = s.done === null ? CircleDashed : s.done ? CheckCircle2 : Circle;
            return (
              <li key={s.key} className="flex items-center gap-3 px-4 py-3" data-step={s.key} data-done={s.done === null ? "unknown" : s.done ? "1" : "0"}>
                <Icon className={cn("size-5 shrink-0", s.done ? "text-emerald-600" : "text-muted-foreground")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-semibold", s.done && "text-muted-foreground line-through decoration-1")}>{s.label}</p>
                  <p className="text-xs text-muted-foreground">{s.detail}</p>
                </div>
                <Link href={s.href} className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">
                  {s.cta} <ArrowRight className="size-3.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      </SectionCard>
      {gs.pages.length > 1 ? (
        <SectionCard title="Trang của tổ chức" description="Trang tuỳ biến đã xuất bản (từ mẫu hoặc tự soạn)">
          <div className="flex flex-wrap gap-2">
            {gs.pages.map((p) => (
              <Link key={p.slug} href={`/p/${p.slug}`} className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                {p.name}
              </Link>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

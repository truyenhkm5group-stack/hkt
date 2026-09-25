import Link from "next/link";
import { notFound } from "next/navigation";
import { TopicForm } from "@/app/(dashboard)/production/topics/new/topic-form";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { getModelBrief, listModelOptions, listSupplierOptions } from "@/lib/queries/production-os";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Mở topic sản xuất" };

/**
 * `/production/topics/new?model=<id>` — lối vào từ trang 360 (`/models/[id]`, Agent A2 đặt nút). Không có
 * `?model=` thì chọn mẫu trong sổ. Máy KHÔNG tự mở topic khi mẫu thắng test (luật 23): người bấm.
 */
export default async function NewTopicPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("production:write");
  const raw = await searchParams;
  const modelParam = typeof raw.model === "string" ? raw.model : "";
  const [model, models, suppliers] = await Promise.all([modelParam ? getModelBrief(modelParam) : null, modelParam ? [] : listModelOptions(), listSupplierOptions()]);
  if (modelParam && !model) notFound();
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title={model ? `Mở topic · ${model.code}${model.name ? ` · ${model.name}` : ""}` : "Mở topic sản xuất"}
        description="Hỏi giá xưởng và bàn phương án cho một mẫu"
        actions={
          <Link href="/production" className="text-sm text-primary hover:underline">
            Danh sách topic
          </Link>
        }
      />
      {!model && !models.length ? (
        <p className="text-sm text-muted-foreground">
          Sổ mẫu đang trống — đồng bộ sổ ở <Link href="/models" className="underline">Vòng đời mẫu</Link> trước khi mở topic.
        </p>
      ) : (
        <TopicForm models={models} fixedModelId={model?.id ?? null} suppliers={suppliers} />
      )}
    </div>
  );
}

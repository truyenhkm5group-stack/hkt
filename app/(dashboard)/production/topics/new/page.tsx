import Link from "next/link";
import { notFound } from "next/navigation";
import { TopicForm } from "@/app/(dashboard)/production/topics/new/topic-form";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { topicOpenNotice } from "@/lib/constants/early-topic";
import { isModelState, MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL, type ModelState } from "@/lib/constants/model-lifecycle";
import { MODEL_SIGNAL_LABEL } from "@/lib/constants/model-signal";
import { modelSignalsForPicker } from "@/lib/queries/early-topic";
import { getModelBrief, listModelOptions, listSupplierOptions } from "@/lib/queries/production-os";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Mở topic sản xuất" };

/**
 * `/production/topics/new?model=<id>` — lối vào từ trang 360 (`/models/[id]`, Agent A2 đặt nút). Không có
 * `?model=` thì chọn mẫu trong sổ. Máy KHÔNG tự mở topic khi mẫu thắng test (luật 23): người bấm.
 *
 * Quy tắc chủ shop 25/09/2026 (Agent T): topic mở được cho MỌI mẫu trong sổ — kể cả mẫu TRIỂN VỌNG chưa
 * thắng và thiết kế TK chưa có mã Pancake. Ô chọn mẫu KHÔNG lọc theo trạng thái (C không lọc; giữ nguyên),
 * chỉ gắn thêm nhãn trạng thái khai + tín hiệu mẫu (lô của Agent S, có hạn giờ — thiếu thì bỏ nhãn tín
 * hiệu). Mẫu còn trước THẮNG thì biểu mẫu nói rõ đây là topic mở SỚM: vòng đời không đổi.
 */
export default async function NewTopicPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("production:write");
  const raw = await searchParams;
  const modelParam = typeof raw.model === "string" ? raw.model : "";
  // Nhãn tín hiệu chỉ là NHÃN (không số) — cùng mức trang 360 cho người có "Vòng đời mẫu: xem".
  const [model, models, suppliers, signals] = await Promise.all([
    modelParam ? getModelBrief(modelParam) : null,
    modelParam ? [] : listModelOptions(),
    listSupplierOptions(),
    can(user, "models:view") ? modelSignalsForPicker() : Promise.resolve(null),
  ]);
  if (modelParam && !model) notFound();
  const stateOf = (s: string | null): ModelState | null => (isModelState(s) ? s : null);
  const options = models.map((m) => {
    const st = stateOf(m.state);
    const sig = signals?.get(m.id) ?? null;
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      hint: [st ? MODEL_STATE_LABELS[st] : MODEL_STATE_UNDECLARED_LABEL, sig ? `tín hiệu ${MODEL_SIGNAL_LABEL[sig]}` : null].filter(Boolean).join(" · "),
      notice: topicOpenNotice(st, sig)?.text ?? null,
    };
  });
  const fixedNotice = model ? (topicOpenNotice(stateOf(model.state), signals?.get(model.id) ?? null)?.text ?? null) : null;
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
        <TopicForm models={options} fixedModelId={model?.id ?? null} fixedNotice={fixedNotice} suppliers={suppliers} />
      )}
    </div>
  );
}

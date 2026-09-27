import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { TopicForm } from "@/app/(dashboard)/marketing/topics/new/topic-form";
import { PageHeader } from "@/components/page-header";
import { can, requireUser } from "@/lib/auth/session";
import { topicOpenNotice } from "@/lib/constants/early-topic";
import { isModelState, MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL, type ModelState } from "@/lib/constants/model-lifecycle";
import { MODEL_SIGNAL_LABEL } from "@/lib/constants/model-signal";
import { modelSignalsForPicker } from "@/lib/queries/early-topic";
import { canOpenTopic } from "@/lib/production/topic-access";
import { getModelBrief, listModelOptions, listTaggableUsers } from "@/lib/queries/production-os";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Mở topic sản xuất" };

/**
 * `/marketing/topics/new?model=<id>` (đường cũ `/production/topics/new` chuyển về đây) — lối vào từ trang 360 (`/models/[id]`, Agent A2 đặt nút). Không có
 * `?model=` thì chọn mẫu trong sổ. Máy KHÔNG tự mở topic khi mẫu thắng test (luật 23): người bấm.
 *
 * Quy tắc chủ shop 25/09/2026 (Agent T): topic mở được cho MỌI mẫu trong sổ — kể cả mẫu TRIỂN VỌNG chưa
 * thắng và thiết kế TK chưa có mã Pancake. Ô chọn mẫu KHÔNG lọc theo trạng thái (C không lọc; giữ nguyên),
 * chỉ gắn thêm nhãn trạng thái khai + tín hiệu mẫu (lô của Agent S, có hạn giờ — thiếu thì bỏ nhãn tín
 * hiệu). Mẫu còn trước THẮNG thì biểu mẫu nói rõ đây là topic mở SỚM: vòng đời không đổi.
 *
 * Chủ shop 26/09/2026: mẫu MỚI TEST chưa có mã cũng mở được topic — lựa chọn "Mẫu mới chưa có mã" đăng ký
 * mẫu với mã tạm (lib/constants/provisional-model.ts), cần thêm `models:write` như mọi lượt đăng ký mẫu.
 * Có quyền ấy thì sổ trống cũng không chặn biểu mẫu nữa.
 *
 * Chủ shop 27/09/2026: biểu mẫu thuộc MARKETING (marketer mở topic để trao đổi với sản xuất), quyền là
 * `canOpenTopic` (khoá hẹp `production:topic-open` hoặc `production:write`) — khoá hẹp đủ để cấp MÃ TẠM cho
 * mẫu mới. Người mở TAG người cần trao đổi; topic mở ra là topic RIÊNG (chỉ người mở + người được tag + ADMIN).
 */
export default async function NewTopicPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  if (!canOpenTopic(user)) redirect("/?forbidden=1");
  const raw = await searchParams;
  const modelParam = typeof raw.model === "string" ? raw.model : "";
  // Nhãn tín hiệu chỉ là NHÃN (không số) — cùng mức trang 360 cho người có "Vòng đời mẫu: xem".
  const [model, models, signals, people] = await Promise.all([
    modelParam ? getModelBrief(modelParam) : null,
    modelParam ? [] : listModelOptions(),
    can(user, "models:view") ? modelSignalsForPicker() : Promise.resolve(null),
    listTaggableUsers(),
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
      hint: [m.provisional ? "mã tạm" : null, st ? MODEL_STATE_LABELS[st] : MODEL_STATE_UNDECLARED_LABEL, sig ? `tín hiệu ${MODEL_SIGNAL_LABEL[sig]}` : null].filter(Boolean).join(" · "),
      notice: topicOpenNotice(st, sig)?.text ?? null,
    };
  });
  const fixedNotice = model ? (topicOpenNotice(stateOf(model.state), signals?.get(model.id) ?? null)?.text ?? null) : null;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title={model ? `Mở topic · ${model.code}${model.name ? ` · ${model.name}` : ""}` : "Mở topic sản xuất"}
        description="Gửi yêu cầu sang sản xuất và tag người cùng trao đổi"
        actions={
          <Link href="/marketing/topics" className="text-sm text-primary hover:underline">
            Danh sách topic
          </Link>
        }
      />
      <TopicForm
        models={options}
        fixedModelId={model?.id ?? null}
        fixedModelLabel={model ? `${model.code}${model.name ? ` · ${model.name}` : ""}` : null}
        fixedNotice={fixedNotice}
        people={people.filter((p) => p.id !== user.id)}
      />
    </div>
  );
}

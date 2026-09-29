import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { RuleControls } from "@/components/platform/workflow/rule-controls";
import { RuleEditor } from "@/components/platform/workflow/rule-editor";
import { WorkflowRunsTable } from "@/components/platform/workflow/runs-table";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import type { SessionUser } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import { RECENT_RUNS_LIMIT, type loadWorkflowEditor } from "@/lib/platform-ui/workflow-admin";
import { blankRuleDraft, liveConsequences, ruleToDraft, subjectObjectKey } from "@/lib/platform-ui/workflow-admin-shared";

/**
 * Trang của MỘT luật (hoặc luật mới): điều khiển bản đã lưu (bật / tạm dừng / lưu trữ / chạy thật / chạy thử) ·
 * form luật · lượt chạy gần đây. Dùng chung cho `/settings/workflows/[id]` và `/new`; mỗi trang tự vẽ
 * `<PageHeader>` (nút làm mới đi theo tiêu đề trang — tests/refresh-button.test.ts) từ `ruleHeader()`.
 */

type LoadedEditor = Awaited<ReturnType<typeof loadWorkflowEditor>>;

export const RULE_EYEBROW = "Hệ thống · Luật tự động";

export const BACK_TO_LIST = (
  <Button asChild variant="ghost" size="sm">
    <Link href="/settings/workflows">
      <ArrowLeft /> Danh sách luật
    </Link>
  </Button>
);

const RULE_HINT = (
  <div className="space-y-1.5 text-xs leading-5">
    <p>Luật mới sinh ra ở NHÁP + CHẠY THỬ. Lưu bất kỳ thay đổi nào cũng đưa luật về NHÁP + CHẠY THỬ và tăng phiên bản — lượt chạy ghi theo phiên bản đã chạy.</p>
    <p>Thứ tự an toàn: lưu → chạy thử trên một bản ghi → Bật (máy ghi lượt «chạy thử» mà không làm gì) → đọc lượt chạy → mới chuyển CHẠY THẬT.</p>
    <p>Luật không bao giờ đổi đơn, vận đơn, COD hay tồn kho; ghi giá trị chỉ vào field tuỳ biến, qua cùng kiểm hợp lệ như khi người ghi tay.</p>
  </div>
);

/** Tiêu đề / mô tả / ⓘ của trang luật. */
export function ruleHeader(loaded: LoadedEditor, user: SessionUser): { title: string; description?: string; hint?: React.ReactNode } {
  if (!loaded.ok) return { title: "Không mở được luật" };
  const rule = loaded.value.rule;
  return { title: rule ? rule.name : "Luật mới", description: rule ? `${rule.key} · phiên bản ${rule.version}` : user.organization?.name, hint: RULE_HINT };
}

export function WorkflowRuleBody({ loaded }: { loaded: LoadedEditor }) {
  if (!loaded.ok) return <EmptyState title="Không mở được luật này" description={loaded.errors.map((e) => e.message).join(" · ")} />;
  const { rule, takenKeys, events, objects, runs, schedule } = loaded.value;
  const initial = rule ? ruleToDraft(rule) : blankRuleDraft();
  const previewKey = rule ? subjectObjectKey(initial, events) : null;
  const previewDef = previewKey ? objectDef(previewKey) : null;

  return (
    <>
      {rule ? (
        <SectionCard title="Trạng thái & chạy thử" hint="Các nút ở đây tác động lên bản ĐÃ LƯU của luật, không lên thứ đang sửa dở trong form bên dưới.">
          <RuleControls
            ruleId={rule.id}
            status={rule.status}
            mode={rule.mode}
            consequences={liveConsequences(rule.actions, rule.gate)}
            previewObject={previewDef ? { key: previewDef.key, label: previewDef.label } : null}
          />
        </SectionCard>
      ) : null}
      <RuleEditor key={rule ? `${rule.id}:${rule.version}:${rule.status}` : "new"} ruleId={rule?.id ?? null} status={rule?.status ?? null} initial={initial} takenKeys={takenKeys} events={events} objects={objects} />
      {rule ? (
        <SectionCard title="Lượt chạy gần đây" description={`${runs.length} lượt mới nhất (tối đa ${RECENT_RUNS_LIMIT})`} padded={false} contentClassName="p-3">
          <WorkflowRunsTable runs={runs} schedule={schedule} />
        </SectionCard>
      ) : null}
    </>
  );
}

import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { loadWorkflowEditor } from "@/lib/platform-ui/workflow-admin";
import { BACK_TO_LIST, RULE_EYEBROW, ruleHeader, WorkflowRuleBody } from "../rule-view";

export const metadata = { title: "Luật tự động" };

/** Một luật tự động — vào từ bảng /settings/workflows (không có mục menu riêng). */
export default async function WorkflowRulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("workflow:manage");
  const { id } = await params;
  const loaded = await loadWorkflowEditor(user, decodeURIComponent(id));
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={RULE_EYEBROW} actions={BACK_TO_LIST} {...ruleHeader(loaded, user)} />
      <WorkflowRuleBody loaded={loaded} />
    </div>
  );
}

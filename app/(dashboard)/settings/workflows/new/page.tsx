import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { loadWorkflowEditor } from "@/lib/platform-ui/workflow-admin";
import { BACK_TO_LIST, RULE_EYEBROW, ruleHeader, WorkflowRuleBody } from "../rule-view";

export const metadata = { title: "Luật tự động mới" };

/** Tạo luật tự động — vào từ nút «Luật mới» ở đầu /settings/workflows. Luật sinh ra ở NHÁP + CHẠY THỬ. */
export default async function NewWorkflowRulePage() {
  const user = await requirePermission("workflow:manage");
  const loaded = await loadWorkflowEditor(user, null);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={RULE_EYEBROW} actions={BACK_TO_LIST} {...ruleHeader(loaded, user)} />
      <WorkflowRuleBody loaded={loaded} />
    </div>
  );
}

import { AlertTriangle, Bot, CircleHelp, GitBranch } from "lucide-react";
import { ApproveButton, PlanButton, RejectButton } from "@/app/(dashboard)/tech/cto/cto-controls";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_AGENT_TEMPLATES } from "@/lib/constants/tech";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { listTechAgents } from "@/lib/queries/tech-agents";
import { ctoPlannableTasks, listTechProposals, type ProposalRow } from "@/lib/queries/tech-proposal";
import { cn } from "@/lib/utils";

export const metadata = { title: "AI CTO" };

const NHAN_TRANG_THAI: Record<string, string> = {
  DRAFT: "Nháp / lập kế hoạch hỏng",
  READY_FOR_REVIEW: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Đã từ chối",
  SUPERSEDED: "Đã bị thay thế",
};

const MAU_RUI_RO: Record<string, string> = {
  R0: "bg-success/15 text-success",
  R1: "bg-warning/15 text-warning",
  R2: "bg-destructive/15 text-destructive",
};

function ThePhieu({ p, canManage }: { p: ProposalRow; canManage: boolean }) {
  const choDuyet = p.status === "READY_FOR_REVIEW";
  const doiRuiRo = p.tasks.filter((t) => t.suggestedRisk !== t.willBeRisk);
  const canNguoiQuyet = p.tasks.filter((t) => t.needsHumanDecision);

  return (
    <SectionCard
      title={`${p.sourceCode || "—"} · ${p.sourceTitle || "(không rõ mục tiêu)"}`}
      description={`${NHAN_TRANG_THAI[p.status] ?? p.status} · ${p.provider || "—"}/${p.model || "—"} · ${formatTimeAgo(p.createdAt)}`}
    >
      <div className="space-y-4">
        {p.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-semibold">Lượt lập kế hoạch KHÔNG đạt</p>
            <p className="mt-1 break-words text-muted-foreground">{p.error}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Bản hỏng vẫn được giữ: lần sau còn đọc được nó đã hỏng vì lý do gì.
            </p>
          </div>
        ) : null}

        {/*
          MỘT LƯỢT SỬA LÀ THÔNG TIN, KHÔNG PHẢI THỨ ĐỂ GIẤU.

          Bản kế hoạch phải sửa mới đạt vẫn là bản đạt — nhưng người đọc có quyền biết nó đã
          không đạt ở lượt đầu vì cái gì. Giấu đi thì "AI CTO luôn trả đúng" trở thành một niềm
          tin không ai kiểm được, và lần hợp đồng đổi thì không ai biết tỷ lệ sửa đang tăng.
        */}
        {p.repairOutcome !== "NONE" ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-semibold">
              {p.repairOutcome === "PASS" ? "Đạt sau MỘT lượt sửa" : "Sửa một lượt vẫn không đạt"}
            </p>
            <p className="mt-1 break-words text-muted-foreground">Lượt đầu sai: {p.initialError || "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {p.modelCalls} lượt gọi model. Trần là hai — không có lượt sửa thứ hai.
            </p>
          </div>
        ) : null}

        {p.summary ? <p className="text-sm">{p.summary}</p> : null}

        {p.assumptions.length ? (
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">AI đã giả định</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
              {p.assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </div>
        ) : null}

        {p.questions.length ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <CircleHelp className="size-4" /> AI thiếu dữ liệu, cần người trả lời
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
              {p.questions.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        ) : null}

        {p.tasks.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Việc đề nghị</TableHead>
                  <TableHead>Vai đề nghị</TableHead>
                  <TableHead>Phụ thuộc</TableHead>
                  <TableHead>AI nghĩ</TableHead>
                  <TableHead>MÁY xếp</TableHead>
                  <TableHead>Việc thật</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.key}</TableCell>
                    <TableCell className="max-w-[420px]">
                      <p className="font-semibold">{t.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t.taskType} · {t.module} · {t.suggestedPriority}
                      </p>
                      {t.acceptanceCriteria.length ? (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                          {t.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}
                        </ul>
                      ) : null}
                      {t.expectedScope.length ? (
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground">{t.expectedScope.join(" · ")}</p>
                      ) : null}
                      {t.needsHumanDecision ? (
                        <p className="mt-1 text-xs font-semibold text-warning">
                          Cần người quyết{t.humanDecisionNote ? `: ${t.humanDecisionNote}` : ""}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.suggestedAgentKey}</TableCell>
                    <TableCell className="font-mono text-xs">{t.dependsOnKeys.join(", ") || "—"}</TableCell>
                    <TableCell>
                      <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", MAU_RUI_RO[t.suggestedRisk])}>{t.suggestedRisk}</span>
                      {t.riskExplanation ? <p className="mt-1 max-w-[220px] text-[11px] text-muted-foreground">{t.riskExplanation}</p> : null}
                    </TableCell>
                    <TableCell>
                      <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", MAU_RUI_RO[t.appliedRisk || t.willBeRisk])}>
                        {t.appliedRisk || t.willBeRisk}
                      </span>
                      {t.suggestedRisk !== (t.appliedRisk || t.willBeRisk) ? (
                        <p className="mt-1 text-[11px] font-semibold text-warning">khác ý AI</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.appliedCode ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {doiRuiRo.length ? (
          <p className="text-xs text-muted-foreground">
            <b>{doiRuiRo.length}</b> việc có mức rủi ro MÁY xếp khác ý AI. Cột “MÁY xếp” là mức sẽ
            áp khi duyệt — AI không quyết được mức này, kể cả khi nó nghĩ khác.
          </p>
        ) : null}
        {canNguoiQuyet.length ? (
          <p className="text-xs font-semibold text-warning">
            {canNguoiQuyet.length} việc AI tự nhận là cần người quyết trước khi làm.
          </p>
        ) : null}

        {p.decidedAt ? (
          <p className="text-xs text-muted-foreground">
            {p.status === "APPROVED" ? "Đã duyệt" : "Đã từ chối"} bởi <b>{p.decidedByName || "—"}</b> lúc {formatDateTime(p.decidedAt)}
            {p.decisionNote ? ` · ${p.decisionNote}` : ""}
          </p>
        ) : null}

        {canManage && choDuyet ? (
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <ApproveButton proposalId={p.id} count={p.tasks.length} />
            <RejectButton proposalId={p.id} />
          </div>
        ) : null}
        {canManage && (p.status === "REJECTED" || p.status === "SUPERSEDED" || p.status === "DRAFT") ? (
          <div className="border-t pt-3">
            <PlanButton taskId={p.sourceTaskId} label="Yêu cầu AI lập lại kế hoạch" />
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

export default async function TechCtoPage() {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const [proposals, muctieu, agents] = await Promise.all([listTechProposals(), ctoPlannableTasks(), listTechAgents()]);

  const cto = agents.find((a) => a.key === "ai-cto");
  const mau = TECH_AGENT_TEMPLATES.find((t) => t.key === "ai-cto");
  const choDuyet = proposals.filter((p) => p.status === "READY_FOR_REVIEW");
  const daQuyet = proposals.filter((p) => p.status === "APPROVED" || p.status === "REJECTED");
  const khac = proposals.filter((p) => p.status === "DRAFT" || p.status === "SUPERSEDED");

  return (
    <div className="space-y-4">
      <PageHeader title="AI CTO" description="Đọc hàng đợi Tech và ĐỀ XUẤT cách chia việc. Không tạo việc, không giao ai, không deploy." />
      <TechNav />

      <SectionCard
        title="Chế độ hoạt động"
        description="AI CTO ở CHẾ ĐỘ ĐỀ XUẤT. Mọi bản kế hoạch phải có người bấm duyệt mới thành việc thật."
        hint="Mức rủi ro trong bản đề xuất chỉ là Ý KIẾN của AI. Lúc duyệt, từng việc chạy lại classifyTechRisk() và lấy kết quả của MÁY — nên một bản đề xuất nói R0 cho việc chạm lương vẫn ra R2 và vẫn chờ chủ shop ký."
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Vai AI CTO</p>
            <p className="font-semibold">{cto ? (cto.enabled ? "Đang bật" : "Đang TẮT") : "Chưa khởi tạo sổ agent"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Quyền của vai</p>
            <p className="font-mono text-xs">
              rủi ro {mau?.allowedRisks.join("/") ?? "—"} · viết mã {mau?.canCode ? "có" : "KHÔNG"} · merge {mau?.canMerge ? "có" : "KHÔNG"} · deploy {mau?.canDeploy ? "có" : "KHÔNG"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Đang chờ duyệt</p>
            <p className="text-2xl font-semibold">{choDuyet.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Việc thật AI tự tạo</p>
            <p className="text-2xl font-semibold text-success">0</p>
          </div>
        </div>
      </SectionCard>

      {canManage ? (
        <SectionCard title="Nhờ AI CTO lập kế hoạch" description="Chọn một mục tiêu đang mở. AI đọc ngữ cảnh đã chọn rồi trả về bản kế hoạch — không chạm việc nào.">
          {muctieu.length ? (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã</TableHead>
                    <TableHead>Mục tiêu</TableHead>
                    <TableHead>Module</TableHead>
                    <TableHead>Rủi ro</TableHead>
                    <TableHead className="text-right">Lập kế hoạch</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {muctieu.slice(0, 10).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs">{t.code}</TableCell>
                      <TableCell>{t.title}</TableCell>
                      <TableCell className="text-xs">{t.module}</TableCell>
                      <TableCell><span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", MAU_RUI_RO[t.risk])}>{t.risk}</span></TableCell>
                      <TableCell className="text-right"><PlanButton taskId={t.id} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState icon={GitBranch} title="Chưa có mục tiêu nào đang mở" description="Tạo một việc ở Hàng đợi việc trước." />
          )}
        </SectionCard>
      ) : null}

      {choDuyet.length ? (
        <div className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle className="size-5 text-warning" /> Chờ duyệt ({choDuyet.length})
          </h2>
          {choDuyet.map((p) => <ThePhieu key={p.id} p={p} canManage={canManage} />)}
        </div>
      ) : null}

      {daQuyet.length ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Đã quyết ({daQuyet.length})</h2>
          {daQuyet.map((p) => <ThePhieu key={p.id} p={p} canManage={canManage} />)}
        </div>
      ) : null}

      {khac.length ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Nháp / đã bị thay thế ({khac.length})</h2>
          {khac.map((p) => <ThePhieu key={p.id} p={p} canManage={canManage} />)}
        </div>
      ) : null}

      {proposals.length === 0 ? (
        <EmptyState icon={Bot} title="Chưa có bản đề xuất nào" description="Chọn một mục tiêu ở trên và bấm “Tạo đề xuất”. AI CTO sẽ đọc ngữ cảnh rồi đề nghị cách chia việc — chưa tạo việc nào." />
      ) : null}
    </div>
  );
}

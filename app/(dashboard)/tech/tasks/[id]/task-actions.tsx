"use client";

import { CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  addTechTaskNoteAction,
  assignTechTaskAgentAction,
  dispatchTaskToAgentAction,
  decideTechApprovalAction,
  overrideTechTaskRiskAction,
  setTechTaskBranchAction,
  setTechTaskPriorityAction,
  setTechTaskStatusAction,
  verifyTechTaskAction,
} from "@/lib/actions/tech";
import {
  TECH_PRIORITIES,
  TECH_PRIORITY_LABEL,
  TECH_RISKS,
  TECH_RISK_LABEL,
  TECH_TASK_STATUS_HINT,
  TECH_TASK_STATUS_LABEL,
  TECH_TASK_TRANSITIONS,
  type TechPriority,
  type TechRisk,
  type TechTaskStatus,
} from "@/lib/constants/tech";

type Props = {
  taskId: string;
  taskCode: string;
  /** Cửa giao việc đã bật chưa — tính ở MÁY CHỦ, vì nó phụ thuộc một khoá chỉ máy chủ thấy. */
  dispatchReason: string | null;
  status: TechTaskStatus;
  priority: TechPriority;
  risk: TechRisk;
  approvalRequired: boolean;
  approvalStatus: string;
  agentId: string | null;
  branch: string;
  worktree: string;
  verified: boolean;
  agents: { id: string; key: string; name: string; allowedRisks: string[] }[];
};

/**
 * Bảng thao tác của một việc Tech.
 *
 * Nút trạng thái CHỈ hiện những nước đi hợp lệ (`TECH_TASK_TRANSITIONS`). Ẩn nước đi không hợp lệ
 * thay vì hiện rồi báo lỗi: hiện một nút không bấm được là dạy người dùng rằng hệ thống hay từ chối
 * vô cớ, và họ sẽ thôi đọc thông báo lỗi.
 *
 * Hai nước đi cần giải thích thì mở hộp thoại hỏi lý do thay vì bấm phát ăn ngay:
 *   · `BLOCKED` — chặn mà không nói vì sao thì không ai gỡ được;
 *   · `DONE` khi chưa xác minh production — đóng im lặng là cách một việc hỏng biến mất.
 */
export function TechTaskActions({ taskId, taskCode, dispatchReason, status, priority, risk, approvalRequired, approvalStatus, agentId, branch, worktree, verified, agents }: Props) {
  const [pending, start] = useTransition();
  const [hoiLyDo, setHoiLyDo] = useState<TechTaskStatus | null>(null);
  const [lyDo, setLyDo] = useState("");
  const [moRuiRo, setMoRuiRo] = useState(false);
  const [ruiRoMoi, setRuiRoMoi] = useState<TechRisk>(risk);
  const [lyDoRuiRo, setLyDoRuiRo] = useState("");
  const [moXacMinh, setMoXacMinh] = useState(false);
  const [bangChung, setBangChung] = useState("");
  const [ghiChu, setGhiChu] = useState("");
  const [lyDoKy, setLyDoKy] = useState("");
  const [nhanh, setNhanh] = useState(branch);
  const [cay, setCay] = useState(worktree);

  const chay = (fn: () => Promise<{ ok: true } | { error: string }>, thanhCong: string) =>
    start(async () => {
      const res = await fn();
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(thanhCong);
    });

  const doiTrangThai = (to: TechTaskStatus, note?: string) => chay(() => setTechTaskStatusAction({ taskId, to, note }), `Đã chuyển sang “${TECH_TASK_STATUS_LABEL[to]}”`);

  const bamTrangThai = (to: TechTaskStatus) => {
    const canLyDo = to === "BLOCKED" || (to === "DONE" && !verified);
    if (canLyDo) {
      setLyDo("");
      setHoiLyDo(to);
      return;
    }
    doiTrangThai(to);
  };

  const nuocDi = TECH_TASK_TRANSITIONS[status];

  return (
    <div className="space-y-4">
      {/*
        ───────── Cổng phê duyệt: đứng trên cùng vì nó chặn mọi thứ khác ─────────

        HIỆN CẢ KHI ĐÃ TỪ CHỐI, không chỉ khi đang chờ. `decideTechApproval()` vốn cho đổi ý (một
        việc `REJECTED` vẫn ký `APPROVED` được, và đó đúng là quyền của người ký), nhưng màn hình
        cũ chỉ mời khi `PENDING` — nên một việc bị từ chối là kẹt vĩnh viễn ở đây, dù dịch vụ không
        hề cấm. Cùng lớp lỗi với nút "Áp lại" ở /tech/cto và ô cấp mức ở /tech/agents: logic mở,
        màn hình đóng.
      */}
      {approvalRequired && approvalStatus !== "APPROVED" ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldAlert className="size-4 text-amber-600" />
            {approvalStatus === "REJECTED" ? `Việc mức ${risk} — đã bị từ chối` : `Việc mức ${risk} — cần chủ shop phê duyệt`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {approvalStatus === "REJECTED"
              ? "Đổi ý được: duyệt lại thì việc đi tiếp. Lượt đổi ý cũng vào nhật ký như mọi chữ ký khác."
              : "Chưa duyệt thì không vào được bước deploy. Từ chối cũng là một câu trả lời hợp lệ và được ghi lại."}
          </p>
          {/*
            TỪ CHỐI BẮT BUỘC NÊU LÝ DO — Y HỆT ĐƯỜNG KÝ HÀNG LOẠT.

            Đường ký loạt buộc nêu lý do; nếu chỗ này không buộc thì hàng rào ấy có cửa sau, và
            "một luật có hai bản thì bản LỎNG HƠN là bản thật".
          */}
          <input
            value={lyDoKy}
            onChange={(e) => setLyDoKy(e.target.value)}
            placeholder="Lý do (bắt buộc khi từ chối)"
            className="mt-2 w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => chay(() => decideTechApprovalAction({ taskId, decision: "APPROVED", note: lyDoKy || undefined }), "Đã duyệt")}>
              <CheckCircle2 className="size-4" /> Duyệt
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || lyDoKy.trim().length < 5}
              title={lyDoKy.trim().length < 5 ? "Chặn một việc mà không nói vì sao thì không ai gỡ được" : undefined}
              onClick={() => chay(() => decideTechApprovalAction({ taskId, decision: "REJECTED", note: lyDoKy }), "Đã từ chối")}
            >
              <XCircle className="size-4" /> Từ chối
            </Button>
          </div>
        </div>
      ) : null}

      {/* ───────── Nước đi hợp lệ ───────── */}
      <div>
        <Label className="text-xs">Chuyển trạng thái</Label>
        {nuocDi.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Việc đã đóng. Hỏng lại thì mở việc MỚI có liên kết tới việc này — mở lại một việc đã đóng làm mất dòng thời gian của lần đầu.</p>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {nuocDi.map((to) => (
              <Button key={to} size="sm" variant="outline" disabled={pending} title={TECH_TASK_STATUS_HINT[to]} onClick={() => bamTrangThai(to)}>
                {TECH_TASK_STATUS_LABEL[to]}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Mức ưu tiên</Label>
          <Select value={priority} disabled={pending} onValueChange={(v) => chay(() => setTechTaskPriorityAction({ taskId, priority: v as TechPriority }), "Đã đổi mức ưu tiên")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TECH_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {TECH_PRIORITY_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/*
          ═══ GIAO VIỆC CHO AGENT ═══

          Nút này khởi động một lượt chạy THẬT trên GitHub Actions — nó tốn khoá AI và phút Actions
          thật. Nên nó nói trước điều đó, và nói trước cả lý do KHÔNG bấm được (chưa khai khoá ghi
          trên máy chủ) thay vì để người dùng bấm rồi mới biết.

          Ba cổng thật nằm ở máy chủ (`lib/tech/dispatch-service.ts`); phần ẩn/hiện ở đây chỉ là
          phép lịch sự với người dùng, KHÔNG phải hàng rào — ẩn một nút không khoá được một action.
        */}
        <div className="space-y-1.5">
          <Label className="text-xs">Khởi động lượt chạy agent</Label>
          {dispatchReason ? (
            <p className="text-xs text-muted-foreground">{dispatchReason}</p>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => chay(() => dispatchTaskToAgentAction({ taskCode, gates: "typecheck,lint,test,build" }), `Đã khởi động lượt chạy agent — theo dõi ở GitHub Actions`)}
              >
                {pending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Khởi động lượt chạy agent
              </Button>
              <p className="text-xs text-muted-foreground">
                Khởi động một lượt chạy thật trên GitHub Actions (tốn khoá AI và phút Actions). Agent KHÔNG merge, KHÔNG deploy — nó mở một PR để người xem.
                {" "}
                <strong>Lượt chạy nhận ĐÚNG việc này</strong>: chỉ MÃ việc đi kèm lệnh khởi động (ô ấy công khai), còn tiêu đề và mô tả đi qua cửa đọc có khoá.
              </p>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Agent phụ trách</Label>
          <Select
            value={agentId ?? "NONE"}
            disabled={pending}
            onValueChange={(v) => chay(() => assignTechTaskAgentAction({ taskId, agentId: v === "NONE" ? null : v }), "Đã đổi agent phụ trách")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* "Chưa giao" là một lựa chọn THẬT, không phải ô trống: bỏ nó đi thì không gỡ việc
                  khỏi một agent được nữa. */}
              <SelectItem value="NONE">— chưa giao</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id} disabled={!a.allowedRisks.includes(risk)}>
                  {a.name}
                  {a.allowedRisks.includes(risk) ? "" : ` (không được phép làm việc mức ${risk})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { setRuiRoMoi(risk); setLyDoRuiRo(""); setMoRuiRo(true); }}>
          Đổi mức rủi ro
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { setBangChung(""); setMoXacMinh(true); }}>
          {verified ? "Ghi lại xác minh production" : "Xác minh trên production"}
        </Button>
      </div>

      {/*
        NHÁNH VÀ CÂY LÀM VIỆC. AGENTS.md mục 9: mỗi phiên làm việc một cây riêng, một nhánh riêng —
        hai phiên ghi vào cùng một thư mục đã làm `main` đỏ bốn lần trong một buổi chiều. Ghi chúng
        ngay trên việc để người (và Phase 2 là agent) biết việc này đang sống ở đâu.
      */}
      <div className="space-y-1.5">
        <Label htmlFor="tech-branch-field" className="text-xs">
          Nhánh git / cây làm việc
        </Label>
        <Input id="tech-branch-field" value={nhanh} onChange={(e) => setNhanh(e.target.value)} placeholder="claude/ten-viec" />
        <Input value={cay} onChange={(e) => setCay(e.target.value)} placeholder="../wt-ten-viec" aria-label="Đường dẫn cây làm việc" />
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || (nhanh.trim() === branch && cay.trim() === worktree)}
          onClick={() => chay(() => setTechTaskBranchAction({ taskId, branch: nhanh, worktree: cay }), "Đã lưu nhánh làm việc")}
        >
          Lưu nhánh
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tech-note" className="text-xs">
          Ghi chú
        </Label>
        <Textarea id="tech-note" rows={2} value={ghiChu} onChange={(e) => setGhiChu(e.target.value)} placeholder="Ghi lại điều người sau cần biết — không ghi đè gì, chỉ thêm vào nhật ký" />
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !ghiChu.trim()}
          onClick={() =>
            chay(async () => {
              const res = await addTechTaskNoteAction({ taskId, note: ghiChu });
              if ("ok" in res) setGhiChu("");
              return res;
            }, "Đã ghi chú")
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Thêm ghi chú
        </Button>
      </div>

      {/* ───────── Hộp thoại hỏi lý do ───────── */}
      <Dialog open={hoiLyDo !== null} onOpenChange={(v) => (v ? null : setHoiLyDo(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hoiLyDo === "BLOCKED" ? "Việc này bị chặn bởi cái gì?" : "Đóng việc mà chưa xác minh production"}</DialogTitle>
            <DialogDescription>
              {hoiLyDo === "BLOCKED"
                ? "Chặn mà không nói vì sao thì không ai gỡ được — và việc sẽ nằm mãi trong hàng đợi."
                : "Nói rõ vì sao việc này không có gì để xác minh trên production (tài liệu, dọn mã, kiểm thử). Nếu có thứ để xác minh thì bấm “Xác minh trên production” trước."}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={4} value={lyDo} onChange={(e) => setLyDo(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHoiLyDo(null)} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || lyDo.trim().length < (hoiLyDo === "BLOCKED" ? 5 : 10)}
              onClick={() => {
                const to = hoiLyDo;
                if (!to) return;
                setHoiLyDo(null);
                doiTrangThai(to, lyDo);
              }}
            >
              Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───────── Đổi mức rủi ro ───────── */}
      <Dialog open={moRuiRo} onOpenChange={setMoRuiRo}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Đổi mức rủi ro</DialogTitle>
            <DialogDescription>
              Máy xếp theo luật; người đè được, nhưng lượt đè phải có lý do và được ghi vào nhật ký. Nâng lên R2 thì việc quay về “chờ duyệt”, kể cả khi trước đó đã được duyệt — cái đã duyệt là một việc khác.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={ruiRoMoi} onValueChange={(v) => setRuiRoMoi(v as TechRisk)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TECH_RISKS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {TECH_RISK_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea rows={3} value={lyDoRuiRo} onChange={(e) => setLyDoRuiRo(e.target.value)} placeholder="Vì sao mức máy xếp không đúng với việc này?" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoRuiRo(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || lyDoRuiRo.trim().length < 10 || ruiRoMoi === risk}
              onClick={() => {
                setMoRuiRo(false);
                chay(() => overrideTechTaskRiskAction({ taskId, risk: ruiRoMoi, reason: lyDoRuiRo }), "Đã đổi mức rủi ro");
              }}
            >
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───────── Xác minh production ───────── */}
      <Dialog open={moXacMinh} onOpenChange={setMoXacMinh}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xác minh trên production</DialogTitle>
            <DialogDescription>Ghi lại BẰNG CHỨNG: câu truy vấn đã chạy, số trước/sau, hoặc màn hình đã mở. Không có bằng chứng thì đây chỉ là một lời khẳng định.</DialogDescription>
          </DialogHeader>
          <Textarea rows={4} value={bangChung} onChange={(e) => setBangChung(e.target.value)} placeholder="Ví dụ: mở /payroll kỳ 09/2026, lương cứng 12.400.000đ khớp sổ ngân hàng (trước bản sửa: 12.640.000đ)" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoXacMinh(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || bangChung.trim().length < 10}
              onClick={() => {
                setMoXacMinh(false);
                chay(() => verifyTechTaskAction({ taskId, evidence: bangChung }), "Đã ghi xác minh");
              }}
            >
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

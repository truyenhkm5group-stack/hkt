"use client";

import { Loader2, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { recordTechDeploymentAction, updateTechDeploymentAction } from "@/lib/actions/tech";
import { TECH_GATE_RESULTS, TECH_GATE_RESULT_LABEL, type TechGateResult } from "@/lib/constants/tech";

/**
 * GHI MỘT LƯỢT DEPLOY ĐÃ XẢY RA.
 *
 * Nút này KHÔNG deploy. ERP không có đường nào chạm tới máy chủ — workflow trên GitHub Actions là
 * bên có thẩm quyền. Đây là ô ghi QUAN SÁT: "lượt vừa rồi là commit nào, kết quả ra sao", để trang
 * này trả lời được câu hỏi đó mà không phải mở GitHub.
 *
 * Mặc định trạng thái là "Đang chạy" chứ không phải "Thành công": người ta thường bấm ghi NGAY KHI
 * mở workflow, và một mặc định "thành công" sẽ biến mọi lượt bỏ dở thành một lượt xanh.
 */
export function TechDeploymentRecordForm() {
  const [open, setOpen] = useState(false);
  const [commit, setCommit] = useState("");
  const [branch, setBranch] = useState("main");
  const [status, setStatus] = useState<"PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED">("RUNNING");
  const [externalRef, setExternalRef] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const dong = () => {
    setOpen(false);
    setCommit("");
    setBranch("main");
    setStatus("RUNNING");
    setExternalRef("");
    setNotes("");
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Ghi lượt deploy
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Ghi một lượt deploy</DialogTitle>
            <DialogDescription>Đây là ô ghi QUAN SÁT — nó không chạy deploy và không dừng được một lượt đang chạy.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dep-commit">Commit</Label>
              <Input id="dep-commit" value={commit} onChange={(e) => setCommit(e.target.value)} placeholder="7–40 ký tự hex" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="dep-branch">Nhánh</Label>
                <Input id="dep-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Trạng thái lúc ghi</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PENDING">Chờ chạy</SelectItem>
                    <SelectItem value="RUNNING">Đang chạy</SelectItem>
                    <SelectItem value="SUCCEEDED">Thành công</SelectItem>
                    <SelectItem value="FAILED">Thất bại</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dep-ref">Đường dẫn lượt chạy GitHub Actions</Label>
              <Input id="dep-ref" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="Để đối chiếu với bên có thẩm quyền" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dep-notes">Ghi chú</Label>
              <Textarea id="dep-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={dong} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || !/^[0-9a-f]{7,40}$/i.test(commit.trim())}
              onClick={() =>
                start(async () => {
                  const res = await recordTechDeploymentAction({ commitSha: commit.trim(), branch, status, externalRef, notes });
                  if ("error" in res) {
                    toast.error(res.error);
                    return;
                  }
                  toast.success("Đã ghi lượt deploy");
                  dong();
                  router.refresh();
                })
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Ghi lại
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * CẬP NHẬT KẾT QUẢ SAU KHI LÊN.
 *
 * Ba cổng (health · smoke · quan sát) mặc định "Chưa xác minh" và ở lại đó cho tới khi có người
 * khai. Đó là điểm của chúng: một lượt deploy chưa ai kiểm KHÔNG được trông giống một lượt đã kiểm
 * và thấy ổn (AGENTS.md mục 42).
 */
export function TechDeploymentUpdateForm({ deployments }: { deployments: { id: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(deployments[0]?.id ?? "");
  const [status, setStatus] = useState<"RUNNING" | "SUCCEEDED" | "FAILED" | "">("");
  const [health, setHealth] = useState<TechGateResult | "">("");
  const [smoke, setSmoke] = useState<TechGateResult | "">("");
  const [observation, setObservation] = useState<TechGateResult | "">("");
  const [pending, start] = useTransition();
  const router = useRouter();

  if (!deployments.length) return null;

  const oCong = (nhan: string, giaTri: TechGateResult | "", dat: (v: TechGateResult | "") => void) => (
    <div className="space-y-1.5">
      <Label>{nhan}</Label>
      <Select value={giaTri || "KHONG_DOI"} onValueChange={(v) => dat(v === "KHONG_DOI" ? "" : (v as TechGateResult))}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="KHONG_DOI">Giữ nguyên</SelectItem>
          {TECH_GATE_RESULTS.map((r) => (
            <SelectItem key={r} value={r}>
              {TECH_GATE_RESULT_LABEL[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Cập nhật kết quả
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Cập nhật một lượt deploy</DialogTitle>
            <DialogDescription>Ba cổng sau khi lên đứng RIÊNG: gộp thành một ô “ổn” là làm mất khả năng biết cái nào chưa ai kiểm.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Lượt deploy</Label>
              <Select value={id} onValueChange={setId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {deployments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Kết quả lượt chạy</Label>
              <Select value={status || "KHONG_DOI"} onValueChange={(v) => setStatus(v === "KHONG_DOI" ? "" : (v as typeof status))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="KHONG_DOI">Giữ nguyên</SelectItem>
                  <SelectItem value="RUNNING">Đang chạy</SelectItem>
                  <SelectItem value="SUCCEEDED">Thành công</SelectItem>
                  <SelectItem value="FAILED">Thất bại</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {oCong("Health", health, setHealth)}
              {oCong("Smoke", smoke, setSmoke)}
              {oCong("Quan sát", observation, setObservation)}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button
              disabled={pending || !id}
              onClick={() =>
                start(async () => {
                  const res = await updateTechDeploymentAction({
                    deploymentId: id,
                    ...(status ? { status } : {}),
                    ...(health ? { healthResult: health } : {}),
                    ...(smoke ? { smokeResult: smoke } : {}),
                    ...(observation ? { observationResult: observation } : {}),
                  });
                  if ("error" in res) {
                    toast.error(res.error);
                    return;
                  }
                  toast.success("Đã cập nhật lượt deploy");
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

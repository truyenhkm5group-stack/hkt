"use client";

import { Copy, Loader2, Plus, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { reapTechLeasesAction, registerTechWorkerAction, setTechWorkerEnabledAction } from "@/lib/actions/tech-control-plane";
import { TECH_CAPABILITIES } from "@/lib/constants/tech-capabilities";
import { TECH_EXECUTION_PROVIDER_LABEL, TECH_QUEUE_PROVIDERS, type TechExecutionProvider } from "@/lib/constants/tech-worker";

const TU_DONG = TECH_CAPABILITIES.filter((c) => c.autonomous);

/**
 * Đăng ký worker. Khoá hiện ĐÚNG MỘT LẦN trong hộp thoại này (CSDL chỉ giữ băm) kèm lệnh chạy nguyên văn —
 * đóng hộp thoại là mất, cần thì tạo worker mới và tắt worker cũ.
 */
export function RegisterWorker({ origin }: { origin: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<TechExecutionProvider>("SUBSCRIPTION_CLAUDE_CODE");
  const [caps, setCaps] = useState<string[]>(["write-docs", "fix-bug", "implement-feature", "unit-test"]);
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dong = () => {
    setOpen(false);
    setToken(null);
    setKey("");
    setName("");
  };

  const lenh = token
    ? [`$env:TECH_WORKER_URL="${origin}"`, `$env:TECH_WORKER_TOKEN="${token}"`, `$env:TECH_WORKER_REPO="C:\\duong\\toi\\ban-clone-rieng"`, `npm run tech:worker -- --check`, `npm run tech:worker`].join("\n")
    : "";

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Đăng ký worker
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{token ? "Khoá của worker — chỉ hiện lần này" : "Đăng ký một worker"}</DialogTitle>
            <DialogDescription>
              {token
                ? "Chép khoá vào máy chạy worker ngay. Đóng hộp thoại là không xem lại được — CSDL chỉ giữ bản băm."
                : "Worker là một tiến trình trên máy có Claude Code. Nó nhận việc R0/R1 của sứ mệnh đang chạy, làm trong cây git riêng, chạy cổng, đẩy nhánh. Không gộp, không deploy."}
            </DialogDescription>
          </DialogHeader>
          {token ? (
            <div className="space-y-2">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{lenh}</pre>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(lenh);
                  toast.success("Đã chép");
                }}
              >
                <Copy className="size-4" /> Chép lệnh
              </Button>
              <p className="text-xs text-muted-foreground">
                TECH_WORKER_REPO nên là một bản clone RIÊNG cho worker — worker dựng cây làm việc từ đó, không bao giờ sửa trong nó.
                Worker gói thuê bao chạy bằng đăng nhập Claude Code của máy và KHÔNG BAO GIỜ nhận khoá API.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="w-key">Mã (chữ thường, số, gạch nối)</Label>
                  <Input id="w-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="may-dev-1" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="w-name">Tên</Label>
                  <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Máy dev văn phòng" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Đường thi hành</Label>
                <Select value={provider} onValueChange={(v) => setProvider(v as TechExecutionProvider)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_QUEUE_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {TECH_EXECUTION_PROVIDER_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Năng lực (chỉ năng lực worker được tự làm)</Label>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {TU_DONG.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={caps.includes(c.key)} onChange={(e) => setCaps((x) => (e.target.checked ? [...x, c.key] : x.filter((k) => k !== c.key)))} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            {token ? (
              <Button onClick={dong}>Đã chép, đóng</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={dong} disabled={pending}>
                  Huỷ
                </Button>
                <Button
                  disabled={pending || key.trim().length < 3 || caps.length === 0}
                  onClick={() =>
                    start(async () => {
                      const res = await registerTechWorkerAction({ key, name: name || key, provider, capabilities: caps });
                      if ("error" in res) {
                        toast.error(res.error);
                        return;
                      }
                      setToken(res.token);
                    })
                  }
                >
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null} Tạo worker
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function WorkerToggle({ workerId, enabled }: { workerId: string; enabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setTechWorkerEnabledAction({ workerId, enabled: !enabled, reason: enabled ? "Tắt từ /tech/workers" : undefined });
          if ("error" in res) toast.error(res.error);
          else toast.success(enabled ? "Đã tắt — lượt đang chạy nhận lệnh DỪNG ở nhịp tim kế" : "Đã bật");
        })
      }
    >
      {enabled ? "Tắt" : "Bật"}
    </Button>
  );
}

export function ReapLeases() {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await reapTechLeasesAction();
          if ("error" in res) toast.error(res.error);
          else toast.success(res.reaped ? `Đã thả ${res.reaped} việc về hàng đợi` : "Không có lease nào hết hạn");
        })
      }
    >
      <RotateCcw className="size-4" /> Thu hồi lease hết hạn
    </Button>
  );
}

"use client";

import { Download, KeyRound, Loader2, Plus, RotateCcw, Trash2, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { reapTechLeasesAction, setTechWorkerEnabledAction } from "@/lib/actions/tech-control-plane";
import { createTechWorkerAction, downloadWorkerInstallerAction, removeTechWorkerAction, requestWorkerRepairAction, rotateWorkerTokenAction } from "@/lib/actions/tech-worker-onboarding";
import { TECH_CAPABILITIES } from "@/lib/constants/tech-capabilities";
import { DOGFOOD_WORKER_DEFAULTS, ENROLLMENT_TTL_MINUTES, TECH_REPAIR_COMMANDS, TECH_REPAIR_LABEL, WORKER_POLICY_FACTS, type TechRepairCommand } from "@/lib/constants/tech-worker-onboarding";
import { TECH_EXECUTION_PROVIDER_LABEL, TECH_QUEUE_PROVIDERS, type TechExecutionProvider } from "@/lib/constants/tech-worker";

const TU_DONG = TECH_CAPABILITIES.filter((c) => c.autonomous);

/**
 * Lưu tệp bộ cài mà Server Action trả về trong THÂN phản hồi. Đường dẫn `blob:` là đối tượng cục bộ của trình duyệt —
 * không mang mã, không đi qua mạng; mã ghi danh chỉ nằm TRONG tệp.
 */
function luuTep(fileName: string, content: string) {
  const blob = new Blob([content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Bước 1 — Tạo worker. Chưa có worker nào ⇒ điền sẵn mặc định dogfood an toàn (dogfood-1, gói thuê bao, chỉ «Viết tài
 * liệu», 1 việc một lúc). Không có ô mở trần R1 ở đây — trần chính sách là quyết định riêng. Tạo xong KHÔNG hiện khoá:
 * hộp thoại chuyển ngay sang bước 2 «Cài worker trên máy Windows này».
 */
export function CreateWorker({ isFirst, apiBudgetDeclared, policyCeiling }: { isFirst: boolean; apiBudgetDeclared: boolean; policyCeiling: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(isFirst ? DOGFOOD_WORKER_DEFAULTS.key : "");
  const [name, setName] = useState(isFirst ? DOGFOOD_WORKER_DEFAULTS.name : "");
  const [provider, setProvider] = useState<TechExecutionProvider>(DOGFOOD_WORKER_DEFAULTS.provider);
  const [caps, setCaps] = useState<string[]>(DOGFOOD_WORKER_DEFAULTS.capabilities);
  const [maxConcurrency, setMaxConcurrency] = useState(DOGFOOD_WORKER_DEFAULTS.maxConcurrency);
  const [ackApi, setAckApi] = useState(false);
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const dong = () => {
    setOpen(false);
    setCreated(null);
    setDownloaded(false);
    setAckApi(false);
  };
  const api = provider === "ANTHROPIC_API";

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Tạo worker
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{created ? `Bước 2 — Cài ${created.key} trên máy này` : "Bước 1 — Tạo worker"}</DialogTitle>
            <DialogDescription>
              {created
                ? "Bấm nút dưới để tải bộ cài. Mở tệp vừa tải (bấm đúp) trên chính máy Windows sẽ chạy worker — bộ cài tự lo mọi thứ còn lại."
                : "Worker là máy làm việc tài liệu / mã cho Phòng Tech AI. Nó chỉ nhận việc tới trần chính sách, làm trong thư mục riêng, không gộp, không deploy."}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3 text-sm">
              <InstallerButton workerId={created.id} label="Cài worker trên máy Windows này" onDone={() => setDownloaded(true)} />
              {downloaded ? (
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>Mở thư mục Tải xuống, bấm đúp tệp <b>cai-worker-{created.key}.cmd</b>. Windows hỏi «có chạy không» thì chọn chạy.</li>
                  <li>Nếu được hỏi, đăng nhập Claude một lần trong cửa sổ hiện ra.</li>
                  <li>Quay lại trang này — worker tự chuyển «Đang sống».</li>
                </ol>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Tệp chỉ mang một mã dùng MỘT lần, hết hạn sau {ENROLLMENT_TTL_MINUTES} phút — không mang khoá worker. Không cần dán gì vào PowerShell, không cần cài gì tay.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="w-key">Mã (chữ thường, số, gạch nối)</Label>
                  <Input id="w-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="may-van-phong-1" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="w-name">Tên</Label>
                  <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Máy văn phòng" />
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
                {api ? (
                  <div className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                    <p>
                      <b>Tốn tiền thật:</b> đường này trả Anthropic theo token. Bộ cài sẽ hỏi một khoá API RIÊNG cho worker. Worker API chỉ nhận việc khi đã khai trần chi API / ngày ở «Ngân sách» bên dưới.
                    </p>
                    {!apiBudgetDeclared ? <p>Hiện CHƯA khai trần chi API / ngày ⇒ worker này sẽ không nhận việc nào cho tới khi khai.</p> : null}
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={ackApi} onChange={(e) => setAckApi(e.target.checked)} /> Tôi hiểu đường này tốn tiền theo token
                    </label>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Dùng gói thuê bao Claude (Pro / Max) của máy — không tốn tiền API, không bao giờ tự rơi sang tiền API.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Năng lực (chỉ những việc worker được tự làm)</Label>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {TU_DONG.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={caps.includes(c.key)} onChange={(e) => setCaps((x) => (e.target.checked ? [...x, c.key] : x.filter((k) => k !== c.key)))} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-conc">Số việc cùng lúc</Label>
                <Input id="w-conc" type="number" min={1} max={4} value={maxConcurrency} onChange={(e) => setMaxConcurrency(Math.min(4, Math.max(1, Number(e.target.value) || 1)))} className="w-24" />
              </div>
              <div className="rounded-lg bg-muted p-2.5 text-xs">
                <p className="font-semibold">Trần chính sách</p>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  <li>Trần rủi ro worker được nhận: {policyCeiling} (đổi ở cấu hình chính sách, không ở đây)</li>
                  {WORKER_POLICY_FACTS.map((f) => (
                    <li key={f.key}>
                      {f.label}: <b>{f.value}</b>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <DialogFooter>
            {created ? (
              <Button
                onClick={() => {
                  dong();
                  router.refresh();
                }}
              >
                Xong
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={dong} disabled={pending}>
                  Huỷ
                </Button>
                <Button
                  disabled={pending || key.trim().length < 3 || caps.length === 0 || (api && !ackApi)}
                  onClick={() =>
                    start(async () => {
                      const res = await createTechWorkerAction({ key, name: name || key, provider, capabilities: caps, maxConcurrency, acknowledgeApiCost: api ? ackApi : undefined });
                      if ("error" in res) {
                        toast.error(res.error);
                        return;
                      }
                      setCreated({ id: res.id, key: key.trim().toLowerCase() });
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

/** Bước 2 — tải bộ cài (mã ghi danh mới; mã cũ chưa dùng chết). */
export function InstallerButton({ workerId, label = "Tải bộ cài", onDone, variant = "default" }: { workerId: string; label?: string; onDone?: () => void; variant?: "default" | "outline" }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await downloadWorkerInstallerAction({ workerId });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          luuTep(res.fileName, res.content);
          toast.success(`Đã tải ${res.fileName} — bấm đúp để cài (hết hạn sau ${ENROLLMENT_TTL_MINUTES} phút)`);
          onDone?.();
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} {label}
    </Button>
  );
}

/** «Tạo lại token»: khoá hiện tại chết NGAY, tải bộ cài mới để cài lại. */
export function RotateTokenButton({ workerId, workerKey }: { workerId: string; workerKey: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Tạo lại token cho ${workerKey}? Worker đang chạy sẽ dừng ngay ở nhịp tim kế; chạy bộ cài mới để cài lại.`)) return;
        start(async () => {
          const res = await rotateWorkerTokenAction({ workerId });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          luuTep(res.fileName, res.content);
          toast.success("Khoá cũ đã chết. Đã tải bộ cài mới — bấm đúp để cài lại.");
        });
      }}
    >
      <KeyRound className="size-4" /> Tạo lại token
    </Button>
  );
}

/** «Gỡ worker»: vô hiệu + thu hồi lease + tải tệp gỡ khỏi máy (xoá tác vụ tự chạy, khoá đã cất, thư mục). */
export function RemoveWorkerButton({ workerId, workerKey }: { workerId: string; workerKey: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      className="text-rose-700 dark:text-rose-300"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Gỡ worker ${workerKey}? Khoá bị thu hồi, việc đang giữ về hàng đợi. Trang sẽ tải tệp gỡ để chạy trên máy đó.`)) return;
        start(async () => {
          const res = await removeTechWorkerAction({ workerId });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          luuTep(res.fileName, res.content);
          toast.success(`Đã gỡ trên máy chủ${res.released ? ` (thả ${res.released} việc về hàng đợi)` : ""}. Bấm đúp ${res.fileName} trên máy worker để dọn máy.`);
        });
      }}
    >
      <Trash2 className="size-4" /> Gỡ worker
    </Button>
  );
}

/** «Sửa lỗi tự động» — chỉ các lệnh trong danh sách đóng; worker nhận ở nhịp tim kế (≤ 30 giây). */
export function RepairMenu({ workerId }: { workerId: string }) {
  const [cmd, setCmd] = useState<TechRepairCommand>("RERUN_SELF_CHECK");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={cmd} onValueChange={(v) => setCmd(v as TechRepairCommand)}>
        <SelectTrigger className="h-8 w-56 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TECH_REPAIR_COMMANDS.map((c) => (
            <SelectItem key={c} value={c}>
              {TECH_REPAIR_LABEL[c].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        title={TECH_REPAIR_LABEL[cmd].does}
        onClick={() =>
          start(async () => {
            const res = await requestWorkerRepairAction({ workerId, command: cmd });
            if ("error" in res) toast.error(res.error);
            else toast.success(`Đã gửi «${TECH_REPAIR_LABEL[cmd].label}» — worker làm ở nhịp tim kế`);
          })
        }
      >
        <Wrench className="size-4" /> Sửa lỗi tự động
      </Button>
    </div>
  );
}

/** Trang tự làm mới khi còn worker đang chờ lên «Đang sống» — chủ shop không phải bấm F5 (bước 4). */
export function AutoRefresh({ active, seconds = 15 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
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

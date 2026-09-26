"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { registerModel, runModelRegistrySync } from "@/lib/actions/models";

/*
  `useNavTransition` chứ không phải `useTransition` trần: cả hai nút kết thúc bằng một lượt đi lên máy
  chủ (trang dựng lại nhờ `revalidatePath` của action / `router.push` sang trang mẫu vừa tạo), nên thanh tiến trình phải biết
  (tests/loading-ux-contract.test.ts mục 5).
*/

/**
 * Nút "Đồng bộ sổ mẫu" — chạy job `model-registry` (có bản ghi `sync_runs`). Job này không có lịch RIÊNG,
 * nhưng tự chạy lồng sau mỗi lượt `pancake-products`; nút là để không phải đợi lượt kế tiếp.
 */
export function RegistrySyncButton({ label = "Đồng bộ sổ mẫu", variant = "outline" }: { label?: string; variant?: "outline" | "default" }) {
  const [pending, start] = useNavTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runModelRegistrySync();
          if ("error" in r) {
            toast.error(r.error);
            return;
          }
          toast.success(`Đăng ký ${r.inserted} mẫu · nối ${r.linked} liên kết${r.ambiguous ? ` · ${r.ambiguous} mã mơ hồ chờ người quyết` : ""}${r.failed ? ` · ${r.failed} lỗi` : ""}`);
        })
      }
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} /> {pending ? "Đang đồng bộ…" : label}
    </Button>
  );
}

/**
 * Đăng ký một mẫu MỚI (chưa có trên Pancake, chưa có thiết kế TK) ở giai đoạn Ý tưởng. Mã đã có ở đâu đó
 * thì máy chủ từ chối và chỉ sang nút đồng bộ.
 */
export function RegisterModelDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pending, start] = useNavTransition();
  const router = useRouter();

  const luu = () =>
    start(async () => {
      const r = await registerModel({ code, name });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã đăng ký mẫu ở giai đoạn Ý tưởng");
      setOpen(false);
      setCode("");
      setName("");
      router.push(`/models/${r.modelId}`);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Mẫu mới
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đăng ký mẫu mới</DialogTitle>
          <DialogDescription>Cho mẫu CHƯA có trên Pancake và chưa có thiết kế TK — ví dụ một ý tưởng, một mockup. Mẫu vào sổ ở giai đoạn Ý tưởng.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="model-code">Mã mẫu</Label>
            <Input id="model-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Q012" maxLength={40} className="font-mono" />
            <p className="text-[11px] text-muted-foreground">Máy in hoa và bỏ khoảng trắng: “q 012” và “Q012” là một mã.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="model-name">Tên (tuỳ chọn)</Label>
            <Input id="model-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Đầm cổ vuông tay phồng" maxLength={200} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={pending || !code.trim()} onClick={luu}>
            {pending ? "Đang lưu…" : "Đăng ký"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

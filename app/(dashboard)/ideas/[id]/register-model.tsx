"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { registerModelFromIdea } from "@/lib/actions/model-ideas";

/**
 * "Đăng ký thành mẫu" (Company OS · A2): đưa ý tưởng vào SỔ MẪU ở giai đoạn Ý tưởng và nối ý tưởng với
 * mẫu vừa tạo. Không đổi trạng thái của ý tưởng. `useNavTransition` vì nút kết thúc bằng `router.push`
 * sang trang mẫu (tests/loading-ux-contract.test.ts mục 5).
 */
export function RegisterModelFromIdea({ ideaId, defaultName }: { ideaId: string; defaultName: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultName.slice(0, 200));
  const [pending, start] = useNavTransition();
  const router = useRouter();

  const luu = () =>
    start(async () => {
      const r = await registerModelFromIdea({ ideaId, code, name });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã đăng ký mẫu ở giai đoạn Ý tưởng và nối với ý tưởng này");
      setOpen(false);
      router.push(`/models/${r.modelId}`);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <GitBranch className="size-4" /> Đăng ký thành mẫu
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đăng ký ý tưởng thành mẫu</DialogTitle>
          <DialogDescription>Mẫu vào sổ ở giai đoạn Ý tưởng và nối với ý tưởng này. Trạng thái duyệt của ý tưởng giữ nguyên.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="idea-model-code">Mã mẫu</Label>
            <Input id="idea-model-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Q012" maxLength={40} className="font-mono" />
            <p className="text-[11px] text-muted-foreground">Máy in hoa và bỏ khoảng trắng. Mã đã là sản phẩm Pancake / thiết kế TK thì dùng nút đồng bộ ở trang Vòng đời mẫu.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="idea-model-name">Tên (tuỳ chọn)</Label>
            <Input id="idea-model-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
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

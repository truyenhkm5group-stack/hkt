"use client";

/**
 * CHỨC DANH — nhãn tổ chức, KHÔNG SINH QUYỀN.
 *
 * Màn hình này cố ý không có một ô tích quyền nào. Cái bẫy cổ điển là đặt chức danh "Kế toán
 * trưởng" rồi ở đâu đó code đọc chuỗi ấy và mở quyền tài chính — từ lúc đó, ĐỔI TÊN CHỨC DANH LÀ
 * LEO THANG QUYỀN, mà người đổi tên tưởng mình chỉ đang sửa một cái nhãn.
 * `tests/access-model.test.ts` quét mã nguồn để giữ đúng tính chất đó.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Loader2, Plus, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PickerMenu } from "@/components/picker-menu";
import { savePosition, setPositionActive } from "@/lib/actions/access";
import { cn } from "@/lib/utils";

export type PositionPanelRow = { id: string; code: string; name: string; description: string; departmentId: string | null; departmentName: string; active: boolean; usedBy: number };

export function PositionsPanel({ positions, departments }: { positions: PositionPanelRow[]; departments: { id: string; name: string }[] }) {
  const [editing, setEditing] = useState<PositionPanelRow | "new" | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = (row: PositionPanelRow) =>
    startTransition(async () => {
      const result = await setPositionActive({ id: row.id, active: !row.active });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(row.active ? `Đã tắt chức danh ${row.name}` : `Đã bật lại chức danh ${row.name}`);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Chức danh chỉ trả lời câu hỏi &ldquo;người này làm chức gì&rdquo;. Nó <strong>không</strong> mở thêm một quyền nào — quyền đặt ở cột &ldquo;Quyền &amp; phạm vi&rdquo; của từng người.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="size-4" /> Chức danh mới
        </Button>
      </div>

      <ul className="divide-y rounded-lg border">
        {positions.map((p) => (
          <li key={p.id} className={cn("flex flex-wrap items-center gap-3 p-3", !p.active && "opacity-60")}>
            <BadgeCheck className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{p.name}</span>
                <span className="rounded bg-muted px-1.5 text-[10.5px] font-mono text-muted-foreground">{p.code}</span>
                {!p.active ? <span className="rounded bg-zinc-100 px-1.5 text-[10.5px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Đang tắt</span> : null}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {p.departmentName || "không gắn phòng ban"} · {p.usedBy ? `${p.usedBy} người đang mang` : "chưa ai mang"}
                {p.description ? ` · ${p.description}` : ""}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
              Sửa
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggle(p)}>
              {p.active ? <PowerOff className="size-4" /> : <Power className="size-4" />}
              {p.active ? "Tắt" : "Bật"}
            </Button>
          </li>
        ))}
      </ul>

      {editing ? <PositionDialog row={editing === "new" ? null : editing} departments={departments} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function PositionDialog({ row, departments, onClose }: { row: PositionPanelRow | null; departments: { id: string; name: string }[]; onClose: () => void }) {
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [departmentId, setDepartmentId] = useState(row?.departmentId ?? "");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () =>
    startTransition(async () => {
      const result = await savePosition({ id: row?.id ?? "", code, name, description, departmentId, active: row?.active ?? true });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(row ? `Đã lưu chức danh ${name}` : `Đã tạo chức danh ${name}`);
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? `Sửa chức danh ${row.name}` : "Chức danh mới"}</DialogTitle>
          <DialogDescription>Nhãn tổ chức. Gắn phòng ban chỉ để hiển thị và gợi ý khi xếp người — không mở thêm quyền nào.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mã</span>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="TRUONG_CA" className="font-mono" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tên hiển thị</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trưởng ca" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mô tả</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Điều phối ca làm việc trong kho" />
          </label>
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Phòng ban gắn kèm</span>
            <PickerMenu
              label={departments.find((d) => d.id === departmentId)?.name ?? "Không gắn phòng nào"}
              options={[{ value: "", label: "Không gắn phòng nào", checked: !departmentId }, ...departments.map((d) => ({ value: d.id, label: d.name, checked: d.id === departmentId }))]}
              onPick={setDepartmentId}
              align="start"
              className="w-full"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

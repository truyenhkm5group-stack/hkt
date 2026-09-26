"use client";

/**
 * VAI TRÒ TUỲ CHỈNH — bó quyền do chủ shop tự đặt tên.
 *
 * Tám vai trò hệ thống KHÔNG hiện ở đây để sửa/xoá: chúng là hằng số trong mã nguồn, và mẫu quyền
 * của chúng chỉnh ở bảng "Vai trò & quyền" bên dưới. Tách như vậy thì "vai trò hệ thống được bảo
 * vệ" là một tính chất của cấu trúc chứ không phải một cái nút bị vô hiệu hoá — nút bị vô hiệu hoá
 * chỉ chặn được người dùng đi qua giao diện.
 */
import { useState, useTransition } from "react";
import { Loader2, Plus, Power, PowerOff, ShieldPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PickerMenu } from "@/components/picker-menu";
import { saveAccessRole, setAccessRoleActive } from "@/lib/actions/access";
import { PERMISSION_GROUPS } from "@/lib/auth/permissions";
import { ACCESS_SCOPE_HINT, ACCESS_SCOPE_LABEL, ACCESS_SCOPES, ROLE_BUILDER_FORBIDDEN, ROLE_BUILDER_FORBIDDEN_REASON, type AccessScope } from "@/lib/constants/access-scope";
import { ROLE_HINT, ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
import { cn } from "@/lib/utils";

export type RolePanelRow = { id: string; code: string; name: string; description: string; baseRole: string; permissions: string[]; defaultScope: AccessScope; active: boolean; usedBy: number };

const BASE_ROLES = ROLE_ORDER.filter((r) => r !== "ADMIN");

export function RolesPanel({ roles }: { roles: RolePanelRow[] }) {
  const [editing, setEditing] = useState<RolePanelRow | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (row: RolePanelRow) =>
    startTransition(async () => {
      const result = await setAccessRoleActive({ id: row.id, active: !row.active });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(row.active ? `Đã tắt vai trò ${row.name}` : `Đã bật lại vai trò ${row.name}`);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Tắt một vai trò không xoá nó: người đang mang vai trò ấy rơi về mẫu quyền của vai trò nền, bật lại là khôi phục nguyên trạng.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="size-4" /> Vai trò mới
        </Button>
      </div>

      {roles.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          Chưa có vai trò tuỳ chỉnh nào. Tám vai trò hệ thống vẫn đang chạy bình thường — chỉ tạo thêm khi cần một bó quyền mà không vai trò nào tả đúng.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {roles.map((r) => (
            <li key={r.id} className={cn("flex flex-wrap items-center gap-3 p-3", !r.active && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <span className="rounded bg-muted px-1.5 text-[10.5px] font-mono text-muted-foreground">{r.code}</span>
                  {!r.active ? <span className="rounded bg-zinc-100 px-1.5 text-[10.5px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Đang tắt</span> : null}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {r.permissions.length} quyền · nền {ROLE_LABEL[r.baseRole as keyof typeof ROLE_LABEL] ?? r.baseRole} · phạm vi gợi ý {ACCESS_SCOPE_LABEL[r.defaultScope]} ·{" "}
                  {r.usedBy ? `${r.usedBy} người đang dùng` : "chưa ai dùng"}
                  {r.description ? ` · ${r.description}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                Sửa
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggle(r)}>
                {r.active ? <PowerOff className="size-4" /> : <Power className="size-4" />}
                {r.active ? "Tắt" : "Bật"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing ? <RoleDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function RoleDialog({ row, onClose }: { row: RolePanelRow | null; onClose: () => void }) {
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [baseRole, setBaseRole] = useState(row?.baseRole ?? "VIEWER");
  const [scope, setScope] = useState<AccessScope>(row?.defaultScope ?? "DEPARTMENT");
  const [perms, setPerms] = useState<Set<string>>(new Set(row?.permissions ?? []));
  const [pending, startTransition] = useTransition();

  const toggle = (key: string, on: boolean) =>
    setPerms((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const save = () =>
    startTransition(async () => {
      const result = await saveAccessRole({ id: row?.id ?? "", code, name, description, baseRole, permissions: [...perms], defaultScope: scope, active: row?.active ?? true });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(row ? `Đã lưu vai trò ${name}` : `Đã tạo vai trò ${name}`);
      onClose();
    });

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldPlus className="size-4" /> {row ? `Sửa vai trò ${row.name}` : "Vai trò tuỳ chỉnh mới"}
          </DialogTitle>
          <DialogDescription>
            Bó quyền này thay cho mẫu quyền của vai trò hệ thống. Vai trò nền là nơi rơi về khi vai trò này bị tắt — nên chọn vai trò hẹp nhất vẫn dùng được, không phải vai trò rộng nhất.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mã</span>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="THU_QUY" className="font-mono" />
          </label>
          <label className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tên hiển thị</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Thủ quỹ" />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mô tả</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Giữ tiền mặt, đối chiếu quỹ cuối ngày" />
          </label>
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Vai trò nền</span>
            <PickerMenu
              label={ROLE_LABEL[baseRole as keyof typeof ROLE_LABEL] ?? baseRole}
              options={BASE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r], checked: r === baseRole }))}
              onPick={setBaseRole}
              align="start"
              className="w-full"
            />
            <p className="text-[10.5px] text-muted-foreground">Quản trị không được làm nền: nền toàn quyền biến mọi giới hạn phía trên thành trang trí.</p>
          </div>
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Phạm vi gợi ý</span>
            <PickerMenu
              label={ACCESS_SCOPE_LABEL[scope]}
              options={ACCESS_SCOPES.map((s) => ({ value: s, label: ACCESS_SCOPE_LABEL[s], hint: ACCESS_SCOPE_HINT[s], checked: s === scope }))}
              onPick={(v) => setScope(v as AccessScope)}
              align="start"
              className="w-full"
            />
            <p className="text-[10.5px] text-muted-foreground">Chỉ là gợi ý khi gán cho một người; phạm vi thật vẫn đặt riêng cho từng người.</p>
          </div>
        </div>

        <div className="space-y-3">
          {PERMISSION_GROUPS.map((g) => (
            <div key={g.module}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.module}</div>
              <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                {g.items.map((item) => {
                  const cam = ROLE_BUILDER_FORBIDDEN.includes(item.key);
                  return (
                    <label key={item.key} className={cn("flex items-start gap-2 rounded-md p-1.5 text-xs", cam ? "opacity-50" : "hover:bg-muted/50")}>
                      <Checkbox checked={perms.has(item.key)} disabled={cam} onCheckedChange={(v) => toggle(item.key, v === true)} className="mt-0.5" />
                      <span>
                        <span className="font-medium">{item.label}</span>
                        {cam ? <span className="block text-[10.5px] text-muted-foreground">{ROLE_BUILDER_FORBIDDEN_REASON[item.key] ?? "Vai trò tuỳ chỉnh không được cấp quyền này"}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
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

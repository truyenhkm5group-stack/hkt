"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { saveRolePermissions } from "@/lib/actions/users";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_GROUPS, rolePermissions, type RolePermissionMap } from "@/lib/auth/permissions";
import { ROLE_LABEL, ROLE_ORDER, ROLE_TONE } from "@/lib/constants/roles";
import { cn } from "@/lib/utils";

const EDITABLE = ROLE_ORDER.filter((r) => r !== "ADMIN");

/** Ma trận quyền × vai trò: chỉnh mẫu quyền mặc định của từng vai trò */
export function RoleMatrix({ templates, canEdit }: { templates: RolePermissionMap; canEdit: boolean }) {
  const initial = useMemo(() => Object.fromEntries(EDITABLE.map((r) => [r, new Set(rolePermissions(r, templates))])) as Record<string, Set<string>>, [templates]);
  const [state, setState] = useState<Record<string, Set<string>>>(initial);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const dirty = EDITABLE.some((r) => {
    const a = state[r];
    const b = initial[r];
    return a.size !== b.size || [...a].some((k) => !b.has(k));
  });

  const toggle = (role: string, key: string, on: boolean) =>
    setState((prev) => {
      const next = new Set(prev[role]);
      if (on) next.add(key);
      else next.delete(key);
      return { ...prev, [role]: next };
    });

  const save = () =>
    startTransition(async () => {
      const result = await saveRolePermissions(Object.fromEntries(EDITABLE.map((r) => [r, [...state[r]]])));
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Đã lưu mẫu quyền của các vai trò");
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Quyền</th>
              <th className="px-2 py-2 text-center">
                <span className={cn("rounded-md px-2 py-0.5", ROLE_TONE.ADMIN)}>{ROLE_LABEL.ADMIN}</span>
              </th>
              {EDITABLE.map((r) => (
                <th key={r} className="px-2 py-2 text-center">
                  <span className={cn("rounded-md px-2 py-0.5", ROLE_TONE[r])}>{ROLE_LABEL[r]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.map((group) => (
              <GroupRows key={group.module} group={group} state={state} canEdit={canEdit} toggle={toggle} />
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={save} disabled={pending || !dirty}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu mẫu quyền
          </Button>
          <Button type="button" variant="ghost" onClick={() => setState(Object.fromEntries(EDITABLE.map((r) => [r, new Set(DEFAULT_ROLE_PERMISSIONS[r])])))} disabled={pending}>
            <RotateCcw className="size-4" /> Về mặc định hệ thống
          </Button>
          <span className="text-xs text-muted-foreground">Mẫu quyền áp dụng cho mọi người dùng chưa được tuỳ chỉnh riêng. Quản trị luôn toàn quyền.</span>
        </div>
      ) : null}
    </div>
  );
}

function GroupRows({ group, state, canEdit, toggle }: { group: (typeof PERMISSION_GROUPS)[number]; state: Record<string, Set<string>>; canEdit: boolean; toggle: (role: string, key: string, on: boolean) => void }) {
  return (
    <>
      <tr className="border-t bg-muted/30">
        <td colSpan={2 + EDITABLE.length} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
          {group.module}
        </td>
      </tr>
      {group.items.map((item) => (
        <tr key={item.key} className="border-t">
          <td className="px-3 py-1.5">
            <div className="font-medium">{item.label}</div>
            {"hint" in item && item.hint ? <div className="text-[11px] text-muted-foreground">{item.hint}</div> : null}
          </td>
          <td className="px-2 py-1.5 text-center">
            <Checkbox checked disabled aria-label="Quản trị luôn có" />
          </td>
          {EDITABLE.map((r) => (
            <td key={r} className="px-2 py-1.5 text-center">
              <Checkbox checked={state[r].has(item.key)} disabled={!canEdit} onCheckedChange={(v) => toggle(r, item.key, v === true)} aria-label={`${ROLE_LABEL[r]} · ${item.label}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

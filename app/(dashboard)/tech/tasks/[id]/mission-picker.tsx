"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { attachTechTaskToMissionAction } from "@/lib/actions/tech-control-plane";

const KHONG = "__none__";

/** Gắn / gỡ việc khỏi sứ mệnh. Chỉ liệt kê sứ mệnh còn mở — máy chủ kiểm lại (việc / sứ mệnh đã kết thúc ⇒ từ chối). */
export function TaskMissionPicker({ taskId, missionId, missions, disabled }: { taskId: string; missionId: string | null; missions: { id: string; code: string; title: string }[]; disabled?: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Select
      value={missionId ?? KHONG}
      disabled={pending || disabled}
      onValueChange={(v) =>
        start(async () => {
          const res = await attachTechTaskToMissionAction({ taskId, missionId: v === KHONG ? null : v });
          if ("error" in res) toast.error(res.error);
          else toast.success(v === KHONG ? "Đã gỡ khỏi sứ mệnh" : "Đã gắn vào sứ mệnh");
        })
      }
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={KHONG}>— Không thuộc sứ mệnh nào</SelectItem>
        {missions.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.code} · {m.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

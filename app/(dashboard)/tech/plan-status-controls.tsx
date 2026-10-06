"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { setTechGoalStatusAction, setTechMissionStatusAction } from "@/lib/actions/tech-control-plane";
import {
  TECH_GOAL_STATUS_LABEL,
  TECH_GOAL_TRANSITIONS,
  TECH_MISSION_STATUS_LABEL,
  TECH_MISSION_TRANSITIONS,
  type TechGoalStatus,
  type TechMissionStatus,
} from "@/lib/constants/tech-control-plane";

type Props = { kind: "goal"; id: string; status: TechGoalStatus } | { kind: "mission"; id: string; status: TechMissionStatus };

/** Trạng thái cuối cần một câu kết quả (CHECK ở CSDL đòi ≥ 10 ký tự) — hỏi trước để không bị từ chối sau. */
const CAN_CAU: string[] = ["ACHIEVED", "ABANDONED", "DONE", "CANCELLED"];

const DONG_TAC: Record<string, string> = {
  ACTIVE: "Bắt đầu / tiếp tục",
  PAUSED: "Tạm dừng",
  ACHIEVED: "Chốt: đã đạt",
  ABANDONED: "Bỏ mục tiêu",
  DONE: "Chốt xong",
  CANCELLED: "Huỷ",
};

/**
 * Nút đổi trạng thái của Goal / Mission. Chỉ hiện nước đi hợp lệ (bảng phép chuyển ở hằng số); máy chủ
 * kiểm lại mọi luật (mục tiêu chưa bật thì sứ mệnh không chạy, còn việc mở thì không chốt…).
 */
export function PlanStatusControls(props: Props) {
  const [pending, start] = useTransition();
  const [hoi, setHoi] = useState<string | null>(null);
  const [cau, setCau] = useState("");
  const nuocDi: string[] = props.kind === "goal" ? TECH_GOAL_TRANSITIONS[props.status] : TECH_MISSION_TRANSITIONS[props.status];
  const nhan = (s: string) => (props.kind === "goal" ? TECH_GOAL_STATUS_LABEL[s as TechGoalStatus] : TECH_MISSION_STATUS_LABEL[s as TechMissionStatus]);

  const doi = (to: string, note?: string) =>
    start(async () => {
      const res =
        props.kind === "goal"
          ? await setTechGoalStatusAction({ goalId: props.id, to, note })
          : await setTechMissionStatusAction({ missionId: props.id, to, note });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã chuyển sang “${nhan(to)}”`);
    });

  if (!nuocDi.length) return <p className="text-xs text-muted-foreground">Đã kết thúc — mục tiêu / sứ mệnh mới thì tạo mới, để kết quả lần này còn đọc được.</p>;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {nuocDi.map((to) => (
          <Button
            key={to}
            size="sm"
            variant={to === "ACTIVE" ? "default" : "outline"}
            disabled={pending}
            onClick={() => {
              if (CAN_CAU.includes(to)) {
                setCau("");
                setHoi(to);
              } else doi(to);
            }}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {DONG_TAC[to] ?? nhan(to)}
          </Button>
        ))}
      </div>
      <Dialog open={hoi !== null} onOpenChange={(v) => (v ? null : setHoi(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hoi ? `${DONG_TAC[hoi] ?? nhan(hoi)} — kết quả / lý do` : ""}</DialogTitle>
            <DialogDescription>
              {hoi === "ABANDONED"
                ? "Bỏ mục tiêu sẽ HUỶ luôn các sứ mệnh chưa kết thúc của nó — worker thôi nhận việc cho thứ đã bỏ."
                : "Ghi lại đã đạt được gì / vì sao dừng. Lần sau đọc lại còn biết lần này đã học được gì."}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={4} value={cau} onChange={(e) => setCau(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHoi(null)} disabled={pending}>
              Thôi
            </Button>
            <Button
              disabled={pending || cau.trim().length < 10}
              onClick={() => {
                const to = hoi;
                if (!to) return;
                setHoi(null);
                doi(to, cau);
              }}
            >
              Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

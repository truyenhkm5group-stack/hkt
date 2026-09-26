"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { linkTechIncidentAction, setTechIncidentStatusAction } from "@/lib/actions/tech";
import { TECH_INCIDENT_STATUS_LABEL, TECH_INCIDENT_TRANSITIONS, type TechIncidentStatus } from "@/lib/constants/tech";

/**
 * Thao tác trên một sự cố.
 *
 * Ba ô chữ luôn hiện cùng lúc, không giấu sau từng bước: người trực thường viết "đã làm gì" trước,
 * còn "vì sao nó xảy ra" thì vài ngày sau mới biết. Bắt điền theo thứ tự là bắt họ bịa.
 *
 * Nút "Đã đóng" chỉ bấm được khi ô KẾT QUẢ đã có chữ — đó là ràng buộc thật ở CSDL, hiện ra ở đây
 * để người dùng thấy trước khi bấm chứ không phải sau khi bị từ chối.
 */
export function TechIncidentActions({
  incidentId,
  status,
  rootCause,
  mitigation,
  resolution,
  taskId,
  tasks,
}: {
  incidentId: string;
  status: TechIncidentStatus;
  rootCause: string;
  mitigation: string;
  resolution: string;
  taskId: string | null;
  tasks: { id: string; code: string; title: string }[];
}) {
  const [nguyenNhan, setNguyenNhan] = useState(rootCause);
  const [giamThieu, setGiamThieu] = useState(mitigation);
  const [ketQua, setKetQua] = useState(resolution);
  const [pending, start] = useTransition();

  const chuyen = (to: TechIncidentStatus) =>
    start(async () => {
      const res = await setTechIncidentStatusAction({ incidentId, to, rootCause: nguyenNhan, mitigation: giamThieu, resolution: ketQua });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã chuyển sang “${TECH_INCIDENT_STATUS_LABEL[to]}”`);
    });

  const nuocDi = TECH_INCIDENT_TRANSITIONS[status];

  return (
    <div className="space-y-3">
      {/*
        NỐI sự cố với việc Tech đang xử lý nó — nối chứ KHÔNG chép: việc vẫn giữ trạng thái của
        việc, sự cố vẫn giữ trạng thái của sự cố. Hai vòng đời khác nhau trả lời hai câu hỏi khác
        nhau ("khách còn chịu ảnh hưởng không" và "bản sửa đã tới production chưa").
      */}
      <div className="space-y-1.5">
        <Label className="text-xs">Việc Tech đang xử lý sự cố này</Label>
        <Select
          value={taskId ?? "NONE"}
          disabled={pending}
          onValueChange={(v) =>
            start(async () => {
              const res = await linkTechIncidentAction({ incidentId, taskId: v === "NONE" ? null : v });
              if ("error" in res) {
                toast.error(res.error);
                return;
              }
              toast.success(v === "NONE" ? "Đã bỏ liên kết" : "Đã nối sự cố với việc Tech");
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NONE">— chưa nối việc nào</SelectItem>
            {tasks.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.code} · {t.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="inc-root" className="text-xs">
          Nguyên nhân gốc (để trống nếu chưa chứng minh được)
        </Label>
        <Textarea id="inc-root" rows={2} value={nguyenNhan} onChange={(e) => setNguyenNhan(e.target.value)} placeholder="Chỉ ghi khi có bằng chứng — một câu nghe hợp lý không phải một nguyên nhân" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="inc-mit" className="text-xs">
          Đã giảm thiểu bằng cách nào
        </Label>
        <Textarea id="inc-mit" rows={2} value={giamThieu} onChange={(e) => setGiamThieu(e.target.value)} placeholder="Việc tạm để khách và nhân viên dùng được trong lúc chờ sửa gốc" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="inc-res" className="text-xs">
          Đã làm gì để sự cố hết (bắt buộc khi đóng)
        </Label>
        <Textarea id="inc-res" rows={2} value={ketQua} onChange={(e) => setKetQua(e.target.value)} placeholder="Bản sửa nào, deploy lúc nào, đã kiểm lại bằng cách nào" />
      </div>

      {nuocDi.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sự cố đã đóng. Tái phát thì chuyển lại về “đang điều tra” từ một sự cố mới có liên kết — dòng thời gian của lần này giữ nguyên.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {nuocDi.map((to) => (
            <Button key={to} size="sm" variant="outline" disabled={pending || (to === "RESOLVED" && ketQua.trim().length < 10)} onClick={() => chuyen(to)}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} {TECH_INCIDENT_STATUS_LABEL[to]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

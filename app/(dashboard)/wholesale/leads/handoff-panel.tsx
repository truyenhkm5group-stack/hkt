"use client";

import { Send } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { sendLeadsToFieldAction } from "@/lib/actions/wholesale";
import type { FieldHandoffOptions } from "@/lib/wholesale/field-handoff";

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

/** Gửi một hoặc nhiều lead cho nhân viên thị trường — dùng chung cho trang lead và thanh thao tác hàng loạt. */
export function HandoffPanel({ leadIds, options, onDone }: { leadIds: string[]; options: FieldHandoffOptions; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dest, setDest] = useState<string>(options.destinations.length ? "0" : "");
  const [note, setNote] = useState("");

  if (!options.ready) {
    return (
      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Chưa gửi được: {options.reason} Vào <Link className="underline" href="/settings/connections">Cài đặt → Kết nối</Link>, mục «{options.connectorLabel}», dán token bot, bấm «Tìm chat» để lấy nhóm của nhân viên thị trường, Kiểm tra rồi Bật.
      </p>
    );
  }
  const send = () =>
    start(async () => {
      const r = await sendLeadsToFieldAction({ leadIds, destination: dest === "" ? null : Number(dest), note });
      if ("error" in r) return void toast.error(r.error);
      const { sent, duplicate, skipped, failed, destinationLabel } = r.report;
      const parts = [`Đã gửi ${sent} khách tới ${destinationLabel}`];
      if (duplicate) parts.push(`${duplicate} vừa gửi trong phút này (không gửi lại)`);
      if (skipped.length) parts.push(`bỏ qua ${skipped.length}: ${[...new Set(skipped.map((s) => s.reason))].join("; ")}`);
      if (failed.length) toast.error(`${parts.join(" · ")} · lỗi ${failed.length}: ${failed[0]!.error}`);
      else toast.success(parts.join(" · "));
      setNote("");
      onDone?.();
      router.refresh();
    });
  return (
    <div className="space-y-2">
      <select className={sel} value={dest} onChange={(e) => setDest(e.target.value)} aria-label="Gửi tới">
        {options.destinations.map((label, i) => (
          <option key={`${i}-${label}`} value={String(i)}>
            {label}
          </option>
        ))}
        <option value="">Chat mặc định của kết nối</option>
      </select>
      <Textarea rows={2} placeholder="Lời dặn nhân viên thị trường (vd ghé trước 10h, mang mẫu tôm)" value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="text-[11px] text-muted-foreground">Tin chỉ mang tên / SĐT / địa chỉ ĐÃ GỌI XÁC NHẬN (hoặc nhân viên nhập) cùng link Google Maps — chưa gọi thì nhân viên mở bản đồ để xem. Lead «Không liên hệ» bị bỏ qua.</p>
      <Button size="sm" disabled={pending || !leadIds.length} onClick={send}>
        <Send className="size-4" /> Gửi {leadIds.length > 1 ? `${leadIds.length} khách` : ""} qua {options.connectorLabel.split(" — ")[0]}
      </Button>
    </div>
  );
}

"use client";

import { CheckCircle2, Loader2, MessageSquare, PenLine, XCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { commentOnIdea } from "@/lib/actions/ideas";
import type { IdeaStatus } from "@/db/schema";

const QUYET_DINH: { value: Exclude<IdeaStatus, "NEW" | "REVIEWING">; label: string; icon: typeof CheckCircle2; variant: "default" | "outline" | "destructive" }[] = [
  { value: "APPROVED", label: "Duyệt", icon: CheckCircle2, variant: "default" },
  { value: "CHANGES", label: "Cần sửa", icon: PenLine, variant: "outline" },
  { value: "REJECTED", label: "Không duyệt", icon: XCircle, variant: "destructive" },
];

/**
 * Khung trao đổi. Quản lý vừa viết nhận xét vừa chốt trạng thái trong MỘT lần bấm — tách làm hai
 * thao tác thì hay có trạng thái đổi mà không ai biết vì sao.
 */
export function FeedbackForm({ ideaId, canReview }: { ideaId: string; canReview: boolean }) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const gui = (decision?: Exclude<IdeaStatus, "NEW" | "REVIEWING">) => {
    if (!body.trim()) {
      toast.error(decision ? "Viết lý do trước khi chốt" : "Nhập nhận xét");
      return;
    }
    start(async () => {
      const r = await commentOnIdea({ ideaId, body, decision });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(decision ? "Đã chốt và ghi nhận xét" : "Đã gửi nhận xét");
      setBody("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder={canReview ? "Nhận xét cho marketer — nói rõ cần sửa gì thì sửa mới trúng…" : "Trả lời quản lý…"}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending || !body.trim()} onClick={() => gui()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} Gửi nhận xét
        </Button>
        {canReview ? (
          <>
            <span className="mx-1 text-xs text-muted-foreground">hoặc chốt:</span>
            {QUYET_DINH.map((q) => (
              <Button key={q.value} type="button" variant={q.variant} size="sm" disabled={pending || !body.trim()} onClick={() => gui(q.value)}>
                <q.icon className="size-4" /> {q.label}
              </Button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

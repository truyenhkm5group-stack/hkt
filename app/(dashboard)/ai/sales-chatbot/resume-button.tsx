"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resumeConversationAction } from "@/lib/actions/sales-chatbot";

/** «Trả lại cho AI» — hội thoại CẦN NGƯỜI XỬ LÝ đã được người xử lý xong; tin khách kế tiếp bot trả lời lại. */
export function ResumeToAiButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await resumeConversationAction(id);
          if ("error" in r) toast.error(r.error);
          else toast.success(r.message);
        })
      }
    >
      Trả lại cho AI
    </Button>
  );
}

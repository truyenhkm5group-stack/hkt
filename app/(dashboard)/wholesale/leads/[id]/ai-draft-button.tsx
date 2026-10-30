"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { aiDraftEmailAction } from "@/lib/actions/wholesale-email-ai";

/** «AI soạn nháp» (luồng email) — MỘT lead, MỘT lượt. Nháp vào khối «Nháp AI» của Hộp thư đi, không vào hộp thư đi. */
export function AiDraftButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await aiDraftEmailAction(leadId);
      if ("error" in r) toast.error(r.error);
      else {
        if (r.status === "BLOCKED") toast.error(`Máy chặn nháp AI: ${r.violations.map((v) => v.detail).join(" ")}`);
        else toast.success("Đã có nháp AI — sửa và duyệt ở Hộp thư đi, mục «Nháp AI».");
        router.refresh();
      }
    });
  return (
    <button type="button" onClick={run} disabled={pending} className="rounded-md border px-2.5 py-1 text-sm font-medium hover:bg-muted disabled:opacity-50">
      {pending ? "AI đang soạn…" : "AI soạn nháp email"}
    </button>
  );
}

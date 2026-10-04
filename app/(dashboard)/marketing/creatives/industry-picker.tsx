"use client";

import { Loader2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { setCreativeIndustryAction } from "@/lib/actions/creative-manual-gen";
import { CREATIVE_INDUSTRIES, CREATIVE_INDUSTRY_LABEL, type CreativeIndustry } from "@/lib/constants/creative-industry";

/**
 * Chọn NGÀNH cho Thư viện Media (chỉ tổ chức khách, chỉ người có `settings:manage`). Đổi ngành đổi câu lệnh vẽ ảnh, kiểu ảnh,
 * công thức câu chữ và luật khẳng định cho MỌI lượt gen tay sau đó — lượt đã vẽ giữ nguyên câu lệnh đã gửi.
 */
export function IndustryPicker({ value, basis }: { value: CreativeIndustry; basis: string }) {
  const [pending, start] = useTransition();
  const change = (next: string) =>
    start(async () => {
      const r = await setCreativeIndustryAction({ industry: next === "" ? null : next });
      if ("error" in r) return void toast.error(r.error);
      toast.success("Đã đổi ngành của Thư viện Media.");
    });
  return (
    <label className="inline-flex items-center gap-1.5 text-[12px]" title={basis}>
      <span className="text-muted-foreground">Ngành:</span>
      <select className="h-7 rounded-md border border-input bg-background px-1.5 text-[12px]" value={value} disabled={pending} onChange={(e) => change(e.target.value)} aria-label="Ngành của Thư viện Media">
        {CREATIVE_INDUSTRIES.map((k) => (
          <option key={k} value={k}>
            {CREATIVE_INDUSTRY_LABEL[k]}
          </option>
        ))}
      </select>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
    </label>
  );
}

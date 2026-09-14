"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { ADS_DIMENSION_LABEL, ADS_DIMENSION_HAS_SPEND, type AdsDimension } from "@/lib/constants/ads-decision";
import { cn } from "@/lib/utils";

const DIMENSIONS: AdsDimension[] = ["campaign", "product", "adset", "ad"];

const HINT: Record<AdsDimension, string> = {
  campaign: "Cấp duy nhất có CẢ tiền chi lẫn đơn hàng từ Facebook — mọi khuyến nghị về tiền đều bắt nguồn ở đây.",
  product: "Tiền quảng cáo ghép được về mã hàng qua tên chiến dịch, nên cấp này cũng kết luận được về tiền. Dùng để biết mã nào chịu được scale.",
  adset: "Chỉ có ĐƠN, không có tiền chi: Facebook Insights đồng bộ ở cấp chiến dịch/ngày. Dùng để xem nhóm nào đưa được hàng tới tay khách.",
  ad: "Chỉ có ĐƠN, không có tiền chi. Dùng để xem mẩu nào đưa được hàng tới tay khách, không dùng để tính ROAS.",
};

/**
 * Chọn cấp phân tích. Bốn cấp này KHÔNG cùng loại số liệu: hai cấp đầu có tiền, hai cấp sau không.
 * Nhãn phải nói rõ điều đó ngay trên nút, trước khi người dùng bấm vào rồi tự hỏi sao cột tiền trống.
 */
export function AdsDimensionTabs({ current }: { current: AdsDimension }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useNavTransition();

  return (
    <div className="flex flex-wrap items-center gap-1">
      {DIMENSIONS.map((d) => (
        <Button
          key={d}
          variant={d === current ? "default" : "ghost"}
          size="sm"
          className={cn("h-7 px-2 text-xs", d === current && "pointer-events-none")}
          disabled={pending}
          title={HINT[d]}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.set("dim", d);
            start(() => router.push(`/ads?${next.toString()}`));
          }}
        >
          {ADS_DIMENSION_LABEL[d]}
          {ADS_DIMENSION_HAS_SPEND[d] ? null : <span className="ml-1 opacity-60">(không có chi)</span>}
        </Button>
      ))}
      {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}

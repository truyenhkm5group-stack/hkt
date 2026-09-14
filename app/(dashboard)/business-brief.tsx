import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { AREA_LABEL, AREA_TONE, CONFIDENCE_LABEL } from "@/lib/constants/recommendation";
import { formatVND } from "@/lib/format";
import { getBusinessBrief } from "@/lib/queries/business-brief";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ───────────── TÓM TẮT & RỦI RO ─────────────
 *
 * Mọi câu ở đây sinh theo QUY TẮC từ số liệu đã tính bằng SQL, không phải văn của mô hình ngôn ngữ.
 * Dự án chưa nối nhà cung cấp AI nào, và ngay cả khi nối thì mô hình cũng chỉ được diễn đạt lại
 * chính những câu này — không được tự tính lại con số nào.
 *
 * Mỗi rủi ro bắt buộc mang theo: chỉ số nào · bằng chứng nào · khoảng thời gian nào · mức tin cậy.
 * Thiếu một trong bốn thì đó là câu bói, không phải khuyến nghị.
 */
export async function BusinessBriefSection({ period }: { period: Period }) {
  const brief = await getBusinessBrief(period);
  if (!brief.summary.length && !brief.risks.length) return null;

  return (
    <SectionCard
      title="Tóm tắt & rủi ro"
      description={`${period.label} · ${brief.risks.length} rủi ro đang theo dõi`}
      hint="Mọi con số ở đây được tính bằng truy vấn dữ liệu, KHÔNG bằng mô hình ngôn ngữ — cùng đầu vào luôn cho cùng đầu ra, và truy được về tận chứng từ. ERP chỉ đề xuất: không tự đổi ngân sách quảng cáo, không tự đặt sản xuất, không tự sửa tồn kho, không tự đổi trạng thái đơn."
      padded={false}
    >
      <ul className="space-y-1.5 px-5 py-4 text-sm">
        {brief.summary.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-muted-foreground">•</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {brief.risks.length ? (
        <div className="divide-y border-t">
          {brief.risks.slice(0, 6).map((r, i) => (
            <Link key={`${r.area}-${i}`} href={r.href} className="flex items-start gap-3 px-5 py-3 hover:bg-muted/50">
              <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap", AREA_TONE[r.area])}>{AREA_LABEL[r.area]}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{r.title}</p>
                <p className="text-xs text-muted-foreground">{r.reason}</p>
                {/* Bốn thứ bắt buộc — thiếu một là câu bói, không phải khuyến nghị. */}
                <p className="truncate text-[10.5px] text-muted-foreground/80" title={r.evidence}>
                  {r.metric} · {r.timeRange} · {CONFIDENCE_LABEL[r.confidence]}
                  {r.amount > 0 ? ` · ${formatVND(r.amount, { compact: true })}` : ""}
                </p>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}

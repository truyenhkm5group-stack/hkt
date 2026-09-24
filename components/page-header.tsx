import { InfoHint } from "@/components/info-hint";
import { RefreshingBadge } from "@/components/nav-progress";
import { RefreshButton } from "@/components/refresh-button";
import { cn } from "@/lib/utils";

/**
 * Tiêu đề trang. `description` chỉ giữ một câu ngắn; phần giải thích dài (định nghĩa, cách tính,
 * quy ước nghiệp vụ) đưa vào `hint` để hiện trong dấu ⓘ cạnh tiêu đề.
 *
 * ─── NÚT LÀM MỚI NẰM Ở ĐÂY, KHÔNG RẢI RA TỪNG TRANG ───
 *
 * Mọi báo cáo đều đi qua tiêu đề này, nên đặt nút ở đây là mọi báo cáo có nút — kể cả báo cáo viết
 * sau. Rải nút vào từng trang thì trang mới luôn quên, và người dùng không bao giờ đoán được trang
 * nào có. Nó cũng luôn đứng ĐÚNG MỘT CHỖ (đầu cụm thao tác, cạnh tiêu đề) thay vì mỗi trang một
 * nơi tuỳ số nút sẵn có.
 *
 * `refresh={false}` cho những trang mà làm mới không có nghĩa gì (biểu mẫu nhập liệu chưa lưu).
 */
export function PageHeader({ title, description, hint, eyebrow, actions, refresh = true, className }: { title: React.ReactNode; description?: React.ReactNode; hint?: React.ReactNode; eyebrow?: string; actions?: React.ReactNode; refresh?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p> : null}
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="truncate text-2xl font-extrabold tracking-[-0.02em] sm:text-[30px] sm:leading-9">{title}</h1>
          {hint ? <InfoHint>{hint}</InfoHint> : null}
          {/* Đang đổi kỳ / bộ lọc: số cũ vẫn hiện (mờ đi), nhãn này nói rõ số mới đang được tính. */}
          <RefreshingBadge />
        </div>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {refresh || actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {refresh ? <RefreshButton /> : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

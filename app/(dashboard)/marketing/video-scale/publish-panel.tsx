import { Badge } from "@/components/ui/badge";
import { VIDEO_POST_STATUS_LABEL, type VideoAutomationState, type VideoPostStatus } from "@/lib/constants/video-scale";
import { formatDateTime } from "@/lib/format";
import type { PageConfigRow, PostRow } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";
import { CancelPostButton, PageConfigRowControls, PauseButton } from "./publishing-controls";

export type PublishReadiness = { writeBlocked: string | null; scopes: { state: "READY" | "MISSING" | "UNKNOWN"; missing: string[]; reason: string } };

/**
 * Tab "Đăng Reel": sẵn sàng ghi Facebook chưa (chốt máy chủ + quyền token), công tắc DỪNG MỌI TỰ ĐỘNG, cấu hình đăng theo
 * fanpage (mặc định chờ người), và danh sách bài.
 */
export function PublishPanel({ readiness, automation, pages, posts, canEngage, canRelease, canConfigure, canEdit }: { readiness: PublishReadiness; automation: VideoAutomationState; pages: PageConfigRow[]; posts: PostRow[]; canEngage: boolean; canRelease: boolean; canConfigure: boolean; canEdit: boolean }) {
  return (
    <div className="space-y-5 text-[13px]">
      <div className="grid gap-2 md:grid-cols-2">
        <div className={cn("rounded-lg border p-3", readiness.writeBlocked || readiness.scopes.state !== "READY" ? "border-amber-500/60 bg-amber-500/5" : "")}>
          <p className="font-medium">Sẵn sàng đăng lên Facebook?</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px]">
            <li>{readiness.writeBlocked ? `Đường ghi Facebook đang ĐÓNG: ${readiness.writeBlocked}` : "Đường ghi Facebook đang mở (ADS_WRITE_ENABLED + COPILOT)."}</li>
            <li>
              {readiness.scopes.state === "READY"
                ? "Token có đủ quyền đăng Reel (pages_show_list · pages_read_engagement · pages_manage_posts)."
                : readiness.scopes.state === "MISSING"
                  ? `Token THIẾU quyền: ${readiness.scopes.missing.join(", ")} — cấp lại token System User có các quyền này.`
                  : `Chưa biết token có quyền gì: ${readiness.scopes.reason}`}
            </li>
            <li>Quyền trên TỪNG fanpage (System User được giao page với quyền Tạo nội dung) chỉ lộ ra ở lượt đăng đầu tiên.</li>
          </ul>
        </div>
        <div className={cn("rounded-lg border p-3", automation.paused ? "border-destructive/60 bg-destructive/5" : "")}>
          <p className="font-medium">{automation.paused ? "Video Scale đang DỪNG mọi tự động" : "Tự động đang chạy"}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {automation.paused
              ? `Không đăng Reel, không tạo / bật quảng cáo mới cho tới khi mở lại.${automation.reason ? ` Lý do: ${automation.reason}` : ""}${automation.by ? ` · ${automation.by}` : ""}${automation.at ? ` · ${automation.at}` : ""}`
              : "Dừng khẩn cấp có hiệu lực ở lượt việc kế tiếp, không cần deploy. Đọc lỗi ⇒ coi như đang dừng."}
          </p>
          <div className="mt-2">
            <PauseButton scope="ALL" id="" paused={automation.paused} reason={automation.reason} canEngage={canEngage} canRelease={canRelease} label="toàn bộ Video Scale" />
          </div>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Cấu hình đăng theo fanpage</h2>
        <p className="text-[12px] text-muted-foreground">Fanpage chưa cấu hình = chờ người bấm đăng từng bài. Mã được gán fanpage ở tab Mã win.</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-2 py-1.5">Fanpage</th>
                <th className="px-2 py-1.5 text-right">Đơn 30 ngày</th>
                <th className="px-2 py-1.5">Chế độ đăng</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.pageId} className="border-t align-middle">
                  <td className="px-2 py-1.5">
                    {p.name}
                    {p.pausedAt ? <Badge variant="destructive" className="ml-1">đang dừng</Badge> : null}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.orders30d}</td>
                  <td className="px-2 py-1.5">
                    <PageConfigRowControls pageId={p.pageId} publishMode={p.publishMode} maxPostsPerDay={p.maxPostsPerDay} disabled={!canConfigure} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <PauseButton scope="PAGE" id={p.pageId} paused={Boolean(p.pausedAt)} reason={p.pausedReason} canEngage={canEngage} canRelease={canRelease} label="fanpage" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Bài Reel ({posts.length})</h2>
        {posts.length === 0 ? (
          <p className="text-muted-foreground">Chưa có bài nào.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-2 py-1.5">Video</th>
                  <th className="px-2 py-1.5">Fanpage</th>
                  <th className="px-2 py-1.5">Trạng thái</th>
                  <th className="px-2 py-1.5">Hẹn / đăng lúc</th>
                  <th className="px-2 py-1.5">Ai cho đăng</th>
                  <th className="px-2 py-1.5">Link / lỗi</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-t align-top">
                    <td className="px-2 py-1.5">
                      {p.productName} #{p.seq}
                    </td>
                    <td className="px-2 py-1.5">{p.pageName}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <Badge variant={p.status === "FAILED" ? "destructive" : p.status === "PUBLISHED" ? "outline" : "secondary"}>{VIDEO_POST_STATUS_LABEL[p.status as VideoPostStatus] ?? p.status}</Badge>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{p.publishedAt ? formatDateTime(p.publishedAt) : p.publishAt ? `hẹn ${formatDateTime(p.publishAt)}` : "đăng ngay"}</td>
                    <td className="px-2 py-1.5">{p.auto ? "Máy (fanpage tự đăng)" : p.authorizedBy}</td>
                    <td className="max-w-[22rem] px-2 py-1.5">
                      {p.permalink ? (
                        <a className="text-primary underline" href={p.permalink} target="_blank" rel="noreferrer">
                          Mở Reel
                        </a>
                      ) : null}
                      {p.fbVideoId ? <span className="ml-1 text-[11px] text-muted-foreground">video {p.fbVideoId}</span> : null}
                      {p.error ? <p className="text-[12px] text-destructive">{p.error}</p> : null}
                    </td>
                    <td className="px-2 py-1.5 text-right">{canEdit && (p.status === "QUEUED" || p.status === "FAILED") ? <CancelPostButton postId={p.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

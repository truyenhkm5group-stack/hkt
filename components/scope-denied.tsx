import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";

/**
 * ═══════════ TỪ CHỐI THÌ PHẢI NÓI ĐƯỢC VÌ SAO ═══════════
 *
 * Màn hình này thay cho hai lối sai:
 *
 *   · trả về danh sách rỗng — người dùng tưởng shop không có dữ liệu, đi hỏi vòng quanh, và kết
 *     cục là có người tắt hẳn phạm vi đi cho xong;
 *   · cho xem hết — lỗ hổng im lặng.
 *
 * Nên nó in đúng hai câu: **vì sao bị chặn** và **ai sửa được, sửa bằng cách nào**. Câu thứ hai
 * quan trọng ngang câu thứ nhất: một lời từ chối không có lối ra thì cũng là một ngõ cụt.
 */
export function ScopeDenied({ title, reason, fix }: { title: string; reason: string; fix: string }) {
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Phạm vi dữ liệu" title={title} description="Bạn không xem được màn hình này với phạm vi hiện tại." />
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/40">
        <p className="flex items-start gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          {reason}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">{fix}</p>
        <p className="mt-2 text-[12px] text-amber-900/70 dark:text-amber-200/70">
          Quản trị viên đổi phạm vi ở <strong>Người dùng → cột Quyền &amp; phạm vi</strong>, và xem trước được hậu quả trước khi lưu.
        </p>
      </div>
    </div>
  );
}

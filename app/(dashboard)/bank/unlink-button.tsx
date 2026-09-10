"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { unlinkBankTransaction } from "@/lib/actions/bank";

/**
 * GỠ LIÊN KẾT giữa một dòng sao kê và chứng từ.
 *
 * Nối nhầm là chuyện có thật — mã trùng, tiền trùng, người bấm vội. Không có đường gỡ thì cách duy
 * nhất để sửa là xoá dòng sao kê, tức là làm mất một giao dịch tiền THẬT khỏi sổ.
 *
 * Gỡ không hỏi lại: nó không mất dữ liệu nào, và nối lại được ngay ở tab Đối khớp.
 */
export function UnlinkButton({ id }: { id: string }) {
  const [dangChay, setDangChay] = React.useState(false);
  const router = useRouter();
  return (
    <button
      type="button"
      title="Gỡ liên kết với chứng từ"
      disabled={dangChay}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDangChay(true);
        const r = await unlinkBankTransaction(id);
        setDangChay(false);
        if ("error" in r) toast.error(r.error);
        else {
          toast.success("Đã gỡ liên kết — dòng này quay lại danh sách chờ đối khớp");
          router.refresh();
        }
      }}
      className="rounded p-0.5 text-emerald-700 transition-colors hover:text-rose-600 dark:text-emerald-300"
    >
      {dangChay ? <Loader2 className="size-3 animate-spin" /> : <Unlink className="size-3" />}
    </button>
  );
}

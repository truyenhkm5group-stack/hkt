"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { requestAgentFixAction } from "@/lib/actions/tech";
import { RERUN_RULE } from "@/lib/constants/agent-rerun";

/**
 * "Giao lại cho agent sửa" — chủ shop tự đóng vòng review, không cần ai chạy script hộ.
 *
 * Trước 23/09/2026 ERP chỉ giao được lượt ĐẦU; mỗi lần review tìm ra lỗi, phải nhờ người có máy
 * chạy script mới giao lại được. Nút này đi qua đúng cửa giao việc (hạn mức, cổng, vai đang bật,
 * trần số lượt) — nó chỉ thêm đúng một thứ: nhánh cũ + phản hồi.
 *
 * Nhánh KHÔNG hiện thành ô nhập: máy chủ đọc nó từ sổ việc.
 */
export function RequestFix({ taskCode, branch, soLuot }: { taskCode: string; branch: string; soLuot: number }) {
  const [pending, start] = useTransition();
  const [mo, setMo] = useState(false);
  const [phanHoi, setPhanHoi] = useState("");

  const n = phanHoi.trim().length;
  const du = n >= RERUN_RULE.minFeedbackChars && n <= RERUN_RULE.maxFeedbackChars;
  const conLuot = RERUN_RULE.maxRunsPerTask - soLuot;

  if (conLuot <= 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Việc này đã dùng hết {RERUN_RULE.maxRunsPerTask}/{RERUN_RULE.maxRunsPerTask} lượt chạy. Quá trần thì vấn đề thường nằm ở
        <b> đề bài</b>, không nằm ở chỗ agent chưa được thử thêm — sửa đề bài hoặc tạo việc mới.
      </p>
    );
  }

  if (!mo) {
    return (
      <Button size="sm" variant="outline" onClick={() => setMo(true)}>
        Giao lại cho agent sửa…
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="text-xs">
        Agent sửa trên <b>chính nhánh</b> <code className="text-[11px]">{branch}</code> — PR cũ được cập nhật, không mở PR mới. Còn{" "}
        <b>{conLuot}</b> lượt cho việc này.
      </div>
      {/*
        CẢNH BÁO CÔNG KHAI — đặt TRƯỚC ô nhập, không giấu sau nút gửi.
        Phản hồi đi vào ô `inputs` của workflow GitHub Actions, và kho mã này PUBLIC.
      */}
      <p className="rounded bg-amber-50 p-2 text-[11px] leading-snug text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        Chữ anh gõ ở đây sẽ <b>hiện công khai</b> trên GitHub Actions (kho mã public). Chỉ viết nhận xét về tài liệu/mã —{" "}
        <b>không</b> ghi tên khách, số điện thoại, số tiền, mật khẩu hay thông tin nội bộ.
      </p>
      <textarea
        value={phanHoi}
        onChange={(e) => setPhanHoi(e.target.value)}
        rows={5}
        placeholder="Chỗ nào sai và phải sửa thế nào? Càng cụ thể (tên tệp, dòng, con số đúng) agent càng sửa đúng và càng rẻ."
        className="w-full rounded-lg border bg-background px-2 py-1.5 text-xs"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={n > RERUN_RULE.maxFeedbackChars ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}>
          {n}/{RERUN_RULE.maxFeedbackChars} ký tự{n < RERUN_RULE.minFeedbackChars ? ` · cần ít nhất ${RERUN_RULE.minFeedbackChars}` : ""}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMo(false)}>
            Huỷ
          </Button>
          <Button
            size="sm"
            disabled={pending || !du}
            onClick={() =>
              start(async () => {
                const res = await requestAgentFixAction({ taskCode, feedback: phanHoi });
                if ("error" in res) {
                  toast.error(res.error);
                  return;
                }
                toast.success(`Đã giao ${res.taskCode} cho agent ${res.agentKey} sửa — còn ${res.conLaiGio} lượt trong giờ này.`);
                setMo(false);
                setPhanHoi("");
              })
            }
          >
            Giao sửa
          </Button>
        </div>
      </div>
    </div>
  );
}

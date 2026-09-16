"use client";

import { useState, useTransition } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { kiemTraQuyenTraCuuVtp, type CapabilityCheck } from "@/lib/actions/vtp-capability";
import { formatNumber, formatDateTime } from "@/lib/format";

/**
 * ═══════════ "TÀI KHOẢN API NÀY CÓ ĐỌC ĐƯỢC VẬN ĐƠN CỦA TÔI KHÔNG" ═══════════
 *
 * Câu hỏi chủ shop cần trả lời NGAY sau khi dán một credential mới. Không có nút này thì cách duy
 * nhất để biết là đợi bộ đối chiếu chạy — và nếu nó vẫn mù thì KHÔNG CÓ GÌ nói ra cả, vì "API
 * không thấy vận đơn nào" là một kết quả im lặng.
 *
 * Màn hình in ĐỦ BỐN CON SỐ chứ không chỉ "thành công / thất bại": "gọi được API" và "đọc được vận
 * đơn" là hai chuyện khác hẳn nhau, và chính sự nhầm lẫn giữa chúng đã giấu vấn đề phạm vi tài
 * khoản suốt 548 lượt đối chiếu liên tiếp.
 */
export function VtpCapabilityCheck() {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<CapabilityCheck | null>(null);

  return (
    <div className="mt-4 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => setRes(await kiemTraQuyenTraCuuVtp()))}>
          <KeyRound className="size-4" /> {pending ? "Đang hỏi Viettel Post…" : "Kiểm tra quyền tra cứu VTP"}
        </Button>
        <span className="text-[11.5px] text-muted-foreground">
          Hỏi thử tối đa 20 vận đơn mới nhất. KHÔNG ghi gì, KHÔNG đổi credential, KHÔNG in token.
        </span>
      </div>

      {res ? (
        "error" in res ? (
          <p className="mt-2 text-xs text-destructive">{res.error}</p>
        ) : (
          <div className="mt-3 space-y-2 text-xs">
            <p className="font-medium text-foreground">{res.verdict}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <So nhan="Đăng nhập API" gia={res.connected ? "được" : "KHÔNG"} />
              <So nhan="Đã hỏi thử" gia={formatNumber(res.sampled)} />
              <So nhan="API đọc được" gia={formatNumber(res.found)} />
              <So nhan="API không thấy" gia={formatNumber(res.notFound)} />
              <So nhan="Lỗi quyền/phiên" gia={formatNumber(res.authError)} />
              <So nhan="Lỗi khác" gia={formatNumber(res.otherError)} />
            </dl>
            {/* Danh tính ĐÃ CHE: đủ để so với tài khoản Pancake, không đủ để ai đó dùng lại. */}
            <p className="text-muted-foreground">
              Tài khoản ERP đang dùng: <span className="font-mono">{res.account}</span>
            </p>
            {res.errors.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {res.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-muted-foreground">Đo lúc {formatDateTime(res.checkedAt)}</p>
          </div>
        )
      ) : null}
    </div>
  );
}

function So({ nhan, gia }: { nhan: string; gia: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-dashed py-0.5">
      <dt className="text-muted-foreground">{nhan}</dt>
      <dd className="numeric font-medium text-foreground">{gia}</dd>
    </div>
  );
}

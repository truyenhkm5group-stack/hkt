"use client";

import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/info-hint";
import { cn } from "@/lib/utils";

const LUA_CHON = [7, 14, 21, 30, 45, 60, 90];

/**
 * Chọn số ngày muốn đủ hàng bán sau khi lô mới về, và có tính hàng đang ở ngoài / chờ hoàn về
 * vào nguồn cung hay không. Ghi lên URL nên chia sẻ được link và bấm quay lại vẫn đúng.
 */
export function CoverPicker({ coverDays, macDinh, countIncoming }: { coverDays: number; macDinh: number; countIncoming: boolean }) {
  const [dangTinh, startTransition] = useNavTransition();
  const [, setState] = useQueryStates(
    { ngay: parseAsInteger, hoan: parseAsString },
    { shallow: false, history: "push", startTransition },
  );
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card p-3 text-[13px] shadow-xs transition-opacity", dangTinh && "pointer-events-none opacity-60")} aria-busy={dangTinh}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">Đặt đủ bán trong</span>
        {LUA_CHON.map((n) => (
          <Button
            key={n}
            type="button"
            size="sm"
            variant={n === coverDays ? "default" : "outline"}
            className="h-7 px-2.5 tabular-nums"
            onClick={() => void setState({ ngay: n === macDinh ? null : n })}
          >
            {n} ngày
          </Button>
        ))}
        <InfoHint>
          Số ngày muốn còn đủ hàng bán <b>sau khi lô mới về kho</b>. Lượng đặt = tốc độ bán × (thời
          gian sản xuất + số ngày này) + tồn an toàn − nguồn cung hiện có. Chọn ở đây chỉ đổi bảng
          đang xem; muốn đổi mặc định thì sửa ở “Giả định”.
        </InfoHint>
      </div>
      <label className="ml-auto flex items-center gap-2">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={countIncoming}
          onChange={(e) => void setState({ hoan: e.target.checked ? null : "0" })}
        />
        <span>Trừ hàng đang ở ngoài &amp; chờ hoàn về</span>
        <InfoHint>
          Hàng đã rời kho nhưng sẽ quay lại: <b>đơn chờ hoàn về</b> (đã xác định hoàn, kho chưa lập
          phiếu tái nhập) và phần <b>hàng đang ở ngoài</b> ước sẽ bị hoàn theo tỷ lệ hoàn thực tế
          của mẫu mã. Cả hai nhân với tỷ lệ hàng hoàn thực sự nhập lại được kho. Bỏ tích để đặt như
          thể không nhận lại được gì.
        </InfoHint>
      </label>
    </div>
  );
}

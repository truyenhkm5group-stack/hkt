"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { setReasonGroup } from "@/lib/actions/return-reason-groups";
import {
  RETURN_REASONS,
  RETURN_REASON_GROUPS,
  RETURN_REASON_GROUP_LABEL,
  RETURN_REASON_GROUP_OF,
  RETURN_REASON_LABEL,
  REASON_NEEDS_HUMAN,
  type ReturnReason,
  type ReturnReasonGroup,
} from "@/lib/constants/return-reason";
import { canRegroup, PINNED_REASON_GROUP, type ReasonGroupOverrides } from "@/lib/constants/return-reason-mapping";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { cn } from "@/lib/utils";

/**
 * ═══════════ XẾP LẠI NHÓM LÝ DO — SỬA CÁCH NHÌN, KHÔNG SỬA LỊCH SỬ ═══════════
 *
 * Bảng này đổi MỘT dòng `settings`. Không một dòng `shipment_return_reasons` nào bị viết lại:
 * quan sát (lý do chi tiết + chữ gốc nguyên văn của ĐVVC) là sự thật và không bao giờ đổi; nhóm
 * là cách shop nhìn, suy lúc ĐỌC, nên đổi ở đây là báo cáo đổi ngay — kể cả với ca ghi từ tháng
 * trước — mà vẫn tra ngược được về chứng từ gốc.
 *
 * Hai dòng bị KHOÁ có chủ đích. Xem `PINNED_REASON_GROUP`.
 */
export function ReasonGroupsPanel({ overrides }: { overrides: ReasonGroupOverrides }) {
  const [pending, start] = useTransition();
  const [hienHet, setHienHet] = useState(false);

  const luu = (reason: ReturnReason, group: ReturnReasonGroup | null) =>
    start(async () => {
      const r = await setReasonGroup({ reason, group });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(group === null ? "Đã trả về cách xếp mặc định" : `“${RETURN_REASON_LABEL[reason]}” nay thuộc nhóm ${RETURN_REASON_GROUP_LABEL[group]}`);
    });

  const daSua = Object.keys(overrides).length;
  // Mặc định chỉ hiện dòng ĐÃ SỬA cho bảng đọc được — 40 ô chọn đổ ra một lúc thì không ai rà nổi.
  const danhSach = (hienHet ? RETURN_REASONS : RETURN_REASONS.filter((r) => overrides[r] !== undefined)) as readonly ReturnReason[];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {daSua ? `${daSua} lý do đang được xếp khác mặc định.` : "Chưa sửa lý do nào — báo cáo đang dùng cách xếp mặc định trong mã."}
        </p>
        <Button size="sm" variant="outline" onClick={() => setHienHet((v) => !v)}>
          {hienHet ? "Chỉ hiện dòng đã sửa" : `Hiện cả ${RETURN_REASONS.length} lý do`}
        </Button>
      </div>

      {danhSach.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Cách xếp mặc định đang được dùng nguyên vẹn. Bấm “Hiện cả {RETURN_REASONS.length} lý do” để đổi một lý do sang nhóm khác — đổi ở đây KHÔNG sửa một dòng lịch sử nào, báo cáo chỉ xếp lại lúc đọc.
        </p>
      ) : (
        <div className={cn(TABLE_SCROLL, "max-h-[520px]")}>
          <Table>
            <TableHeader className={STICKY_HEAD}>
              <TableRow>
                <TableHead>Lý do hoàn</TableHead>
                <TableHead>Mặc định</TableHead>
                <TableHead>Đang xếp vào</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {danhSach.map((r) => {
                const macDinh = RETURN_REASON_GROUP_OF[r];
                const hienTai = overrides[r] ?? macDinh;
                const khoa = PINNED_REASON_GROUP[r] !== undefined;
                return (
                  <TableRow key={r} className={overrides[r] !== undefined ? "bg-primary/5" : undefined}>
                    <TableCell className="text-sm">
                      {RETURN_REASON_LABEL[r]}
                      {REASON_NEEDS_HUMAN[r] ? (
                        <span className="ml-1.5 text-[10.5px] text-amber-600 dark:text-amber-400" title="Lý do này chỉ có khi NGƯỜI của shop hỏi khách rồi ghi — ĐVVC không bao giờ nói vải nóng hay mặc không vừa.">
                          người ghi
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{RETURN_REASON_GROUP_LABEL[macDinh]}</TableCell>
                    <TableCell>
                      {khoa ? (
                        /* Câu VÌ SAO lấy thẳng từ hợp đồng, không viết lại ở màn hình — hai bản chữ là hai lời giải thích sẽ lệch nhau. */
                        <span className="text-xs text-muted-foreground" title={canRegroup(r, "QUALITY").reason ?? ""}>
                          {RETURN_REASON_GROUP_LABEL[hienTai]} · khoá
                        </span>
                      ) : (
                        <Select value={hienTai} onValueChange={(v) => luu(r, v as ReturnReasonGroup)} disabled={pending}>
                          <SelectTrigger className="h-8 w-[190px]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {RETURN_REASON_GROUPS.filter((g) => canRegroup(r, g).ok).map((g) => (
                              <SelectItem key={g} value={g}>{RETURN_REASON_GROUP_LABEL[g]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {overrides[r] !== undefined ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => luu(r, null)} title="Trả về cách xếp mặc định trong mã">
                          <RotateCcw className="size-3.5" /> Mặc định
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

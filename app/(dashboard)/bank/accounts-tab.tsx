"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Pencil, Power } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SectionCard } from "@/components/ui-bits";
import { updateBankAccount } from "@/lib/actions/bank";
import { BANK_ACCOUNT_STATUS_LABEL, BANK_ACCOUNT_STATUS_TONE, maskAccountNumber, type BankAccountStatus } from "@/lib/constants/bank";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import type { BankAccountRow } from "@/lib/queries/bank";
import { cn } from "@/lib/utils";

/**
 * Tài khoản ngân hàng của sổ.
 *
 * ─── VÌ SAO TRANG NÀY TỒN TẠI ───
 *
 * Webhook SePay tự khai tài khoản khi thấy một tài khoản lạ — để KHÔNG MẤT GIAO DỊCH. Nhưng nó
 * không được phép tự kết luận "đúng là tài khoản của shop", nên tài khoản mới luôn ở
 * `UNCONFIRMED` và nằm chờ đúng ở đây. Không có màn hình này thì việc xác nhận không ai làm được,
 * và cảnh báo "chưa xác nhận" sẽ kêu mãi.
 *
 * Tiền vẫn vào sổ đầy đủ trong lúc chờ — xác nhận là việc ĐẶT TÊN và nhận trách nhiệm, không phải
 * việc cứu giao dịch bị chặn.
 */
export function BankAccountsTab({ accounts, canManage }: { accounts: BankAccountRow[]; canManage: boolean }) {
  const [pending, startTransition] = useTransition();
  const [dang, setDang] = useState<BankAccountRow | null>(null);
  const [ten, setTen] = useState("");
  const router = useRouter();

  const chuaXacNhan = accounts.filter((a) => a.status === "UNCONFIRMED");

  const luu = (id: string, values: { label?: string; status?: BankAccountStatus }) =>
    startTransition(async () => {
      const res = await updateBankAccount({ id, ...values });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(values.status === "ACTIVE" ? "Đã xác nhận tài khoản" : values.status === "DISABLED" ? "Đã ngừng dùng tài khoản" : "Đã lưu tên tài khoản");
      setDang(null);
      router.refresh();
    });

  return (
    <SectionCard
      title="Tài khoản ngân hàng"
      description="Các tài khoản đang đổ giao dịch vào sổ — tải sao kê tay hoặc nhận realtime qua SePay."
      hint="Tài khoản mới do webhook phát hiện luôn ở trạng thái CHƯA XÁC NHẬN. Giao dịch của nó VẪN vào sổ đầy đủ; xác nhận chỉ là việc đặt tên và nhận trách nhiệm rằng đúng là tài khoản của shop. ERP không bao giờ tự chuyển sang Đang dùng."
    >
      <div className="space-y-4">
        {chuaXacNhan.length > 0 ? (
          <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">
                {formatNumber(chuaXacNhan.length)} tài khoản chưa xác nhận
              </p>
              <p className="text-amber-800/90 dark:text-amber-200/80">
                Giao dịch của các tài khoản này <b>vẫn được ghi đầy đủ vào sổ</b> — không mất đồng nào.
                {canManage ? " Hãy đặt tên và xác nhận để cảnh báo này tắt đi." : " Chủ shop / quản trị sẽ xác nhận."}
              </p>
            </div>
          </div>
        ) : null}

        {!accounts.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Chưa có tài khoản nào. Tài khoản xuất hiện khi webhook SePay nhận gói tin đầu tiên.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tài khoản</TableHead>
                  <TableHead>Nguồn</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Giao dịch</TableHead>
                  <TableHead className="text-right">Tiền vào / ra</TableHead>
                  <TableHead>Gần nhất</TableHead>
                  {canManage ? <TableHead className="text-right">Thao tác</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => {
                  const status = a.status as BankAccountStatus;
                  return (
                    <TableRow key={a.id} className={cn(status === "UNCONFIRMED" && "bg-amber-50/50 dark:bg-amber-950/20")}>
                      <TableCell>
                        <div className="font-medium">{a.label || "(chưa đặt tên)"}</div>
                        <div className="font-mono text-[11.5px] text-muted-foreground">
                          {a.gateway || "—"} · {maskAccountNumber(a.accountNumber)}
                          {a.subAccount ? ` · VA ${a.subAccount}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-[12.5px]">{a.provider || "Sao kê tay"}</TableCell>
                      <TableCell>
                        <span className={cn("rounded px-1.5 py-0.5 text-[11.5px] font-medium", BANK_ACCOUNT_STATUS_TONE[status])}>
                          {BANK_ACCOUNT_STATUS_LABEL[status]}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(a.soGiaoDich)}</TableCell>
                      <TableCell className="text-right font-mono text-[12px] tabular-nums">
                        <div className="text-emerald-700 dark:text-emerald-400">+{formatVND(a.tienVao, { compact: true })}</div>
                        <div className="text-rose-700 dark:text-rose-400">−{formatVND(a.tienRa, { compact: true })}</div>
                      </TableCell>
                      <TableCell className="text-[11.5px] text-muted-foreground">
                        <div>{a.lastSeenAt ? `gói tin ${formatDateTime(a.lastSeenAt)}` : "chưa nhận gói tin nào"}</div>
                        {a.lanVaoGanNhat ? <div>vào {formatDateTime(a.lanVaoGanNhat)}</div> : null}
                        {a.lanRaGanNhat ? <div>ra {formatDateTime(a.lanRaGanNhat)}</div> : null}
                      </TableCell>
                      {canManage ? (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={pending}
                              onClick={() => {
                                setDang(a);
                                setTen(a.label);
                              }}
                            >
                              <Pencil className="size-3.5" /> Đặt tên
                            </Button>
                            {status !== "ACTIVE" ? (
                              <Button size="sm" disabled={pending} onClick={() => luu(a.id, { status: "ACTIVE" })}>
                                <Check className="size-3.5" /> Xác nhận
                              </Button>
                            ) : (
                              <Button variant="outline" size="sm" disabled={pending} onClick={() => luu(a.id, { status: "DISABLED" })}>
                                <Power className="size-3.5" /> Ngừng dùng
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-[11.5px] text-muted-foreground">
          Ngừng dùng một tài khoản <b>không xoá và không ẩn</b> giao dịch đã có — tiền đã vào sổ là chứng từ, không phải cấu hình.
          Gói tin mới vẫn được ghi để không mất dữ liệu; nhãn chỉ giúp người đọc báo cáo hiểu vì sao dòng tiền dừng lại.
        </p>
      </div>

      <Dialog open={!!dang} onOpenChange={(o) => !o && setDang(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Đặt tên tài khoản</DialogTitle>
            <DialogDescription>
              {dang ? `${dang.gateway || "Ngân hàng"} · ${maskAccountNumber(dang.accountNumber)}${dang.subAccount ? ` · VA ${dang.subAccount}` : ""}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ten-tai-khoan">Tên dễ nhận biết</Label>
            <Input
              id="ten-tai-khoan"
              value={ten}
              onChange={(e) => setTen(e.target.value)}
              placeholder="MB kinh doanh · COD Viettel Post"
              maxLength={120}
            />
            <p className="text-[11.5px] text-muted-foreground">Tên này hiện ở mọi nơi nhắc tới tài khoản, thay cho dãy số tài khoản.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDang(null)} disabled={pending}>
              Huỷ
            </Button>
            <Button onClick={() => dang && luu(dang.id, { label: ten })} disabled={pending || !ten.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu tên
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

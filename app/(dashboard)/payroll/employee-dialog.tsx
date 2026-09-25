"use client";

import { useEffect, useState, useTransition } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { deleteEmployee, saveEmployee } from "@/lib/actions/payroll";
import { DEPARTMENTS, type Employee } from "@/lib/constants/payroll";
import { VN_BANKS } from "@/lib/constants/vn-banks";
import { employeeSchema, type EmployeeInput } from "@/lib/validation/payroll";

export type EmployeePreset = {
  name?: string;
  shortName?: string;
  aliases?: string[];
  accountIds?: string[];
};

function toForm(e?: Employee | null, preset?: EmployeePreset): EmployeeInput {
  return {
    id: e?.id,
    name: e?.name ?? preset?.name ?? "",
    shortName: e?.shortName ?? preset?.shortName ?? "",
    department: (e?.department as EmployeeInput["department"]) ?? "Marketing",
    aliases: (e?.aliases ?? preset?.aliases ?? []).join(", "),
    accountIds: (e?.accountIds ?? preset?.accountIds ?? []).join(", "),
    userEmail: e?.userEmail ?? "",
    fixed: e?.fixed ?? 0,
    percentTotal: e?.percentTotal ?? 0,
    percentPersonal: e?.percentPersonal ?? 0,
    percentRevenue: e?.percentRevenue ?? 0,
    active: e?.active ?? true,
    note: e?.note ?? "",
    startedOn: e?.startedOn ?? "",
    leftOn: e?.leftOn ?? "",
    bankBin: e?.bankBin ?? "",
    bankAccount: e?.bankAccount ?? "",
    bankAccountName: e?.bankAccountName ?? "",
  };
}

const OTHER_BANK = "__other__";

/**
 * Chọn ngân hàng theo TÊN, lưu theo MÃ BIN. Ngân hàng ngoài danh sách thì tự nhập BIN — một lựa chọn
 * có chủ, thay vì để ERP đoán mã của một ngân hàng nó không biết.
 */
function BankBinPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = VN_BANKS.some((b) => b.bin === value);
  const [other, setOther] = useState(Boolean(value) && !known);
  return (
    <>
      <Select
        value={other ? OTHER_BANK : known ? value : ""}
        onValueChange={(v) => {
          setOther(v === OTHER_BANK);
          onChange(v === OTHER_BANK ? "" : v);
        }}
      >
        <FormControl>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Chọn ngân hàng" />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          {VN_BANKS.map((b) => (
            <SelectItem key={b.bin} value={b.bin}>
              {b.name}
            </SelectItem>
          ))}
          <SelectItem value={OTHER_BANK}>Khác — tự nhập mã BIN</SelectItem>
        </SelectContent>
      </Select>
      {other ? <Input placeholder="Mã BIN 6 số" inputMode="numeric" maxLength={6} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))} /> : null}
    </>
  );
}

function DateField({ name, label, hint }: { name: "startedOn" | "leftOn"; label: string; hint?: string }) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input type="date" {...field} value={field.value ?? ""} />
          </FormControl>
          {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function NumberField({
  name,
  label,
  hint,
  step = 1,
}: {
  name: "fixed" | "percentTotal" | "percentPersonal" | "percentRevenue";
  label: string;
  hint?: string;
  step?: number;
}) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step={step}
              className="numeric"
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={
                typeof field.value === "number" && Number.isFinite(field.value)
                  ? field.value
                  : ""
              }
              onChange={(e) =>
                field.onChange(
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
            />
          </FormControl>
          {hint ? (
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          ) : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Thêm / sửa nhân sự và cơ chế lương */
export function EmployeeDialog({
  employee,
  accounts,
  preset,
  triggerLabel,
}: {
  employee?: Employee | null;
  accounts: { id: string; name: string }[];
  preset?: EmployeePreset;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const form = useForm<EmployeeInput>({
    resolver: zodResolver(employeeSchema),
    defaultValues: toForm(employee, preset),
  });
  useEffect(() => {
    if (open) form.reset(toForm(employee, preset));
  }, [open, employee, preset, form]);

  const submit = (values: EmployeeInput) =>
    startTransition(async () => {
      const result = await saveEmployee(values);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(employee ? "Đã cập nhật nhân sự" : "Đã thêm nhân sự");
      setOpen(false);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {employee ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Sửa"
          >
            <Pencil className="size-4" />
          </Button>
        ) : (
          <Button size="sm" variant={preset ? "outline" : "default"}>
            <Plus className="size-4" /> {triggerLabel ?? "Thêm nhân sự"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {employee ? `Sửa: ${employee.name}` : "Thêm nhân sự"}
          </DialogTitle>
          <DialogDescription>
            Cơ chế lương = lương cứng + % lợi nhuận tổng + % lợi nhuận cá nhân +
            % doanh thu cá nhân. Thưởng chỉ tính khi số dương. Marketer được
            nhận diện qua bí danh trong tên chiến dịch hoặc tài khoản quảng cáo
            mặc định.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Họ tên</FormLabel>
                    <FormControl>
                      <Input placeholder="Trần Anh Quân" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="shortName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên ngắn</FormLabel>
                    <FormControl>
                      <Input placeholder="Quân TA" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bộ phận</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DEPARTMENTS.map((d) => (
                          <SelectItem key={d} value={d}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="aliases"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bí danh trong tên chiến dịch</FormLabel>
                    <FormControl>
                      <Input placeholder="QA4, QUAN TA" {...field} />
                    </FormControl>
                    <p className="text-[11px] text-muted-foreground">
                      Cách nhau bằng dấu phẩy
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="userEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email đăng nhập ERP</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="ten@shop.vn" {...field} />
                    </FormControl>
                    <p className="text-[11px] text-muted-foreground">
                      Để người này (quyền “Lương: xem của mình”) chỉ thấy dòng lương của chính mình
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accountIds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tài khoản QC mặc định</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="account_id, cách nhau bằng dấu phẩy"
                        {...field}
                      />
                    </FormControl>
                    {accounts.length ? (
                      <p className="text-[11px] text-muted-foreground">
                        Có:{" "}
                        {accounts.map((a) => `${a.name} = ${a.id}`).join(" · ")}
                      </p>
                    ) : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-4">
              <NumberField
                name="fixed"
                label="Lương cứng (₫/kỳ)"
                step={100000}
              />
              <NumberField
                name="percentTotal"
                label="% lợi nhuận tổng"
                hint="VD Quân TA: 35"
                step={0.5}
              />
              <NumberField
                name="percentPersonal"
                label="% lợi nhuận cá nhân"
                hint="VD Hiếu HM: 30, Nhật LV: 25"
                step={0.5}
              />
              <NumberField
                name="percentRevenue"
                label="% doanh thu cá nhân"
                hint="Tuỳ chọn, cho sale"
                step={0.5}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tình trạng</FormLabel>
                    <Select value={field.value ? "working" : "left"} onValueChange={(v) => field.onChange(v === "working")}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="working">Đang làm</SelectItem>
                        <SelectItem value="left">Đã nghỉ</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DateField name="startedOn" label="Ngày vào làm" hint="Tuỳ chọn. Tháng đầu chỉ tính lương cứng từ ngày này." />
              <DateField
                name="leftOn"
                label="Ngày làm cuối"
                hint={form.watch("active") ? "Để trống nếu chưa nghỉ." : "Bắt buộc khi đã nghỉ: tháng cuối vẫn trả đủ những ngày còn làm."}
              />
            </div>
            <fieldset className="space-y-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Tài khoản nhận lương</legend>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="bankBin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngân hàng</FormLabel>
                      <BankBinPicker value={field.value ?? ""} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bankAccount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số tài khoản</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" placeholder="0123456789" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bankAccountName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên chủ tài khoản</FormLabel>
                      <FormControl>
                        <Input placeholder="TRAN ANH QUAN" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Dùng để dựng mã QR chuyển lương. Đổi tài khoản được ghi nhật ký riêng, và lệnh chuyển lần sau sẽ in đỏ “STK khác lần trả trước”.
              </p>
            </fieldset>
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea rows={1} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Huỷ
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                {employee ? "Lưu" : "Thêm"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteEmployeeButton({ employee }: { employee: Employee }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          aria-label="Xoá"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xoá {employee.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Các chiến dịch đang gán cho người này sẽ về “chưa gán marketer”, và
            người này biến mất khỏi mọi kỳ lương chưa khoá. Nếu chỉ nghỉ việc, hãy
            đặt Tình trạng “Đã nghỉ” kèm ngày làm cuối thay vì xoá.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Huỷ</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              startTransition(async () => {
                const r = await deleteEmployee(employee.id);
                if ("error" in r) toast.error(r.error);
                else {
                  toast.success("Đã xoá");
                }
              })
            }
          >
            Xoá
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

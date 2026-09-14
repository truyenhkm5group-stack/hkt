"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { importBankStatement } from "@/lib/actions/bank";
import { maskAccountNumber } from "@/lib/constants/bank";
import { formatNumber } from "@/lib/format";
import type { BankAccountRow } from "@/lib/queries/bank";

/** Chỉ những gì ô chọn cần — trang truyền `listBankAccounts()` nguyên bản, ở đây thu hẹp lại. */
export type ImportAccountOption = Pick<BankAccountRow, "id" | "label" | "gateway" | "accountNumber" | "status">;

const MAX_BYTES = 5_000_000;

/** Phần mở rộng nhị phân — nội dung không đọc được bằng `file.text()`. */
const BINARY_EXTENSIONS = /\.(xlsx|xls|xlsb|ods)$/i;

/** Tệp nhị phân → base64 để gửi kèm Server Action (cùng cách với luồng nhập tệp Viettel Post). */
async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Nhập sao kê vào sổ giao dịch.
 *
 * KHÔNG có bước "duyệt từng dòng" như luồng nhập chi phí cũ: ở đây mọi giao dịch đều được ghi vào
 * sổ, kể cả tiền vào và các khoản không ảnh hưởng lãi lỗ. Sổ phải PHẢN ÁNH ĐẦY ĐỦ sao kê thì mới
 * đối chiếu được số dư; việc chọn lọc diễn ra sau, ở bước phân loại và bước đẩy sang Chi phí.
 *
 * Tệp Excel KHÔNG đi qua ô dán: `file.text()` trên .xlsx cho ra rác nhị phân, và trước đây nó im
 * lặng rơi vào ô dán rồi máy chủ báo "không nhận ra cột". Tệp nhị phân đi riêng dưới dạng base64,
 * ô dán chỉ dành cho nội dung chữ.
 */
export function BankImportTab({ canWrite, accounts }: { canWrite: boolean; accounts: ImportAccountOption[] }) {
  const [text, setText] = useState("");
  const [upload, setUpload] = useState<{ filename: string; base64: string } | null>(null);
  const [fileName, setFileName] = useState("");
  // Tài khoản mà sao kê thuộc về. Sổ đã có tài khoản thì BẮT BUỘC chọn: dòng không biết mình thuộc
  // tài khoản nào không tra được số dư và không đối chiếu được với SePay. Một tài khoản thì chọn sẵn.
  const usable = accounts.filter((a) => a.status !== "DISABLED");
  const [accountId, setAccountId] = useState<string>(usable.length === 1 ? usable[0].id : "");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const clear = () => {
    setText("");
    setUpload(null);
    setFileName("");
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error("File quá lớn (tối đa 5MB)");
      return;
    }
    setFileName(file.name);
    if (BINARY_EXTENSIONS.test(file.name)) {
      setText("");
      setUpload({ filename: file.name, base64: await fileToBase64(file) });
      return;
    }
    setUpload(null);
    setText(await file.text());
  };

  const submit = () =>
    startTransition(async () => {
      if (usable.length && !accountId) {
        toast.error("Chọn tài khoản ngân hàng mà sao kê này thuộc về");
        return;
      }
      const res = await importBankStatement(upload ?? text, { bankAccountId: accountId || null });
      if ("error" in res) {
        toast.error(res.error, { duration: 12000 });
        return;
      }
      const parts = [`${formatNumber(res.inserted)} giao dịch mới`];
      if (res.updated) parts.push(`${formatNumber(res.updated)} dòng đã có (giữ nguyên số tiền và phân loại)`);
      if (res.duplicates) parts.push(`${formatNumber(res.duplicates)} dòng trùng ngay trong file`);
      if (res.labelled) parts.push(`${formatNumber(res.labelled)} dòng được quy tắc gán nhãn`);
      toast.success(parts.join(" · "), { duration: 8000 });
      // Mâu thuẫn KHÔNG phải thành công một nửa: nêu riêng, để lâu hơn, để người nhập đi xem nhật ký.
      if (res.conflicts) toast.warning(`${formatNumber(res.conflicts)} dòng đã có trong sổ nhưng file nói KHÁC số tiền / tài khoản — đã GIỮ dòng cũ, không ghi đè. Xem chi tiết ở Nhật ký.`, { duration: 15000 });
      for (const w of res.warnings.filter((x) => !x.startsWith(`${res.conflicts} dòng`))) toast.warning(w, { duration: 12000 });
      clear();
      router.refresh();
    });

  return (
    <SectionCard
      title="Nhập sao kê ngân hàng"
      description="Nhận sao kê chính thức của ngân hàng (.xlsx hoặc .csv, giữ nguyên như lúc tải về) và bản xuất của ứng dụng quản lý giao dịch (.csv / .json). Mọi giao dịch đều được ghi vào sổ — kể cả tiền vào và khoản không ảnh hưởng lãi lỗ — để sổ khớp với số dư ngân hàng."
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-medium">Tài khoản ngân hàng của sao kê này</p>
          {usable.length ? (
            <Select value={accountId} onValueChange={setAccountId} disabled={!canWrite || pending}>
              <SelectTrigger className="w-full sm:w-96">
                <SelectValue placeholder="Chọn tài khoản…" />
              </SelectTrigger>
              <SelectContent>
                {usable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label || a.gateway || "Tài khoản"} · {a.gateway} {maskAccountNumber(a.accountNumber)}
                    {a.status === "UNCONFIRMED" ? " · chờ xác nhận" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground">
              Sổ chưa có tài khoản ngân hàng nào (tài khoản tự xuất hiện khi nối SePay, hoặc khai ở tab Tài khoản). Sao kê nhập lúc này sẽ KHÔNG gắn với tài khoản, nên số dư theo tài khoản không tra được.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-dashed p-4 text-sm">
          <div className="flex items-center gap-3">
            <label className="flex flex-1 cursor-pointer items-center gap-3">
              <FileUp className="size-5 text-muted-foreground" />
              <span className="font-medium">{fileName || "Chọn file sao kê (.xlsx / .xls / .csv / .json)"}</span>
              <input
                type="file"
                accept=".xlsx,.xls,.xlsb,.ods,.csv,.json,.txt"
                className="hidden"
                disabled={!canWrite || pending}
                onChange={(e) => void readFile(e.target.files?.[0])}
              />
            </label>
            {fileName ? (
              <Button variant="ghost" size="sm" disabled={pending} onClick={clear}>
                <X className="size-4" /> Bỏ chọn
              </Button>
            ) : null}
          </div>
          {upload ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Tệp Excel được gửi nguyên bản lên máy chủ để đọc — không hiện nội dung ở đây vì đó là dữ liệu nhị phân.
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Hoặc dán thẳng nội dung file CSV/JSON vào đây:</p>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value) setUpload(null);
            }}
            rows={8}
            disabled={!canWrite || pending || !!upload}
            placeholder={"Ngày giao dịch,Ngày hạch toán,Số bút toán,Phát sinh nợ,Phát sinh có,Số dư lũy kế,Nội dung,..."}
            className="font-mono text-xs"
          />
        </div>

        <div className="rounded-md bg-muted px-3 py-2 text-[11.5px] text-muted-foreground">
          <p className="font-medium text-foreground">Nhập lại chồng lấn là an toàn.</p>
          <p>
            Mỗi giao dịch được nhận diện bằng <b>mã giao dịch của ngân hàng</b> (cùng khoá với SePay). Tải lại tháng 8 rồi tải tiếp 08–09 sẽ không nhân đôi dòng tiền:
            dòng đã có chỉ được cập nhật phần mô tả, còn <b>số tiền, mốc giờ, nhóm kế toán và ghi chú bạn đã gán vẫn giữ nguyên</b>. File nói khác số tiền thì dòng cũ được giữ và ERP báo mâu thuẫn để bạn xem.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={submit} disabled={!canWrite || pending || (!upload && !text.trim()) || (usable.length > 0 && !accountId)}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Nhập vào sổ giao dịch
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

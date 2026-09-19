"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { addRegressionCase } from "@/lib/actions/sales-regression";
import { HANDOFF_REASONS, HANDOFF_REASON_LABEL, SALES_ACTIONS, SALES_ACTION_LABEL, SALES_STAGES, SALES_STAGE_LABEL } from "@/lib/constants/sales-agent";

/**
 * THÊM LƯỢT CHẠY NÀY VÀO BỘ CA HỒI QUY.
 *
 * Ô nào để TRỐNG là KHÔNG KIỂM chiều ấy — in thẳng ra màn hình chứ không giấu trong tài liệu. Bắt
 * khai đủ mọi chiều thì người soát khai bừa cho xong, và một ca khai bừa luôn xanh nên không ai
 * đọc lại nó nữa.
 *
 * ĐIỀU QUAN TRỌNG NHẤT, và vì sao form này KHÔNG điền sẵn kết quả thật: kỳ vọng phải là thứ ĐÁNG
 * LẼ máy phải làm, không phải thứ máy ĐÃ làm. Điền sẵn rồi để người soát bấm Lưu là biến bộ hồi
 * quy thành một cái máy chụp ảnh hành vi hiện tại — nó sẽ xanh mãi mãi, kể cả khi hành vi ấy sai.
 * Muốn khoá lại một hành vi ĐÚNG thì vẫn phải tự tay chọn, và đó là một giây suy nghĩ đáng bỏ ra.
 */
export function RegressionForm({ runId, defaultTitle }: { runId: string; defaultTitle: string }) {
  const [mo, setMo] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [stage, setStage] = useState("");
  const [action, setAction] = useState("");
  const [handoff, setHandoff] = useState<"" | "yes" | "no">("");
  const [handoffReason, setHandoffReason] = useState("");
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const [phone, setPhone] = useState("");
  const [mustContain, setMustContain] = useState("");
  const [mustNotContain, setMustNotContain] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<{ caseKey: string; updated: boolean } | null>(null);
  const [pending, start] = useTransition();

  const dong = (raw: string) => raw.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10);

  const luu = () => {
    start(async () => {
      const res = await addRegressionCase({
        runId,
        title: title.trim() || defaultTitle,
        note,
        expected: {
          stage: stage || null,
          action: action || null,
          handoff: handoff === "" ? null : handoff === "yes",
          handoffReason: handoffReason || null,
          state: {
            ...(size.trim() ? { size: size.trim() } : {}),
            ...(color.trim() ? { color: color.trim() } : {}),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
          },
          replyMustContain: dong(mustContain),
          replyMustNotContain: dong(mustNotContain),
        },
      });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setSaved({ caseKey: res.caseKey, updated: res.updated });
      toast.success(res.updated ? "Đã cập nhật ca hồi quy" : "Đã thêm ca hồi quy");
    });
  };

  if (!mo) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => setMo(true)}>
          Thêm vào bộ hồi quy
        </Button>
        <p className="text-xs text-muted-foreground">
          Chụp lại lượt này thành một ca chạy lại được: tin của khách, trạng thái trước và kết quả từng công cụ ERP. Ca KHÔNG đọc
          lại hội thoại gốc, nên nó cho cùng một kết quả kể cả khi khách nhắn tiếp hay kho đổi số.
        </p>
      </div>
    );
  }

  const o = "rounded-md border border-border bg-background px-2 py-1 text-xs";

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          <span className="text-muted-foreground">Tên ca — đọc lên phải biết ngay nó giữ điều gì</span>
          <input className={o} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Giai đoạn ĐÁNG LẼ phải tới</span>
          <select className={o} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">— không kiểm chiều này —</option>
            {SALES_STAGES.map((s) => (
              <option key={s} value={s}>{SALES_STAGE_LABEL[s]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Việc ĐÁNG LẼ phải làm tiếp</span>
          <select className={o} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">— không kiểm chiều này —</option>
            {SALES_ACTIONS.map((a) => (
              <option key={a} value={a}>{SALES_ACTION_LABEL[a]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Có phải chuyển người không</span>
          <select className={o} value={handoff} onChange={(e) => setHandoff(e.target.value as "" | "yes" | "no")}>
            <option value="">— không kiểm chiều này —</option>
            <option value="yes">PHẢI chuyển người</option>
            <option value="no">KHÔNG được chuyển người</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Lý do chuyển người (chỉ kiểm khi có chuyển)</span>
          <select className={o} value={handoffReason} onChange={(e) => setHandoffReason(e.target.value)}>
            <option value="">— không kiểm chiều này —</option>
            {HANDOFF_REASONS.map((r) => (
              <option key={r} value={r}>{HANDOFF_REASON_LABEL[r]}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Size phải giữ được</span>
          <input className={o} value={size} onChange={(e) => setSize(e.target.value)} placeholder="để trống = không kiểm" maxLength={10} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Màu phải giữ được</span>
          <input className={o} value={color} onChange={(e) => setColor(e.target.value)} placeholder="để trống = không kiểm" maxLength={40} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">SĐT phải đọc ra</span>
          <input className={o} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="để trống = không kiểm" maxLength={20} />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Câu trả lời PHẢI chứa (mỗi dòng một thứ)</span>
          <textarea className={`${o} min-h-16`} value={mustContain} onChange={(e) => setMustContain(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">TUYỆT ĐỐI KHÔNG được chứa (mỗi dòng một thứ)</span>
          <textarea className={`${o} min-h-16`} value={mustNotContain} onChange={(e) => setMustNotContain(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          <span className="text-muted-foreground">Ghi chú — vì sao ca này đáng giữ</span>
          <textarea className={`${o} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </label>
      </div>

      <p className="text-[11px] text-muted-foreground">
        So câu chữ theo phép CHỨA, bỏ dấu và không phân biệt hoa thường. Bộ hồi quy KHÔNG khớp từng chữ câu trả lời — chữ nghĩa
        đổi theo mô hình, còn thứ phải giữ nguyên là nghiệp vụ.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={luu} disabled={pending}>
          {pending ? "Đang lưu…" : "Lưu ca hồi quy"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setMo(false)}>
          Đóng
        </Button>
        {saved ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {saved.updated ? "ĐÃ CẬP NHẬT" : "ĐÃ THÊM"} · <code className="font-mono">{saved.caseKey}</code> — chạy lại bằng{" "}
            <code className="font-mono">npm run ai:regression</code>
          </span>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/ui-bits";
import { savePayrollCarryoverConfig, savePayrollRecognitionMode, savePayrollStatutoryConfig } from "@/lib/actions/payroll-policy";
import {
  STATUTORY_STATES,
  STATUTORY_STATE_HINT,
  STATUTORY_STATE_LABEL,
  type StatutoryConfig,
  type StatutoryState,
} from "@/lib/constants/payroll-statutory";

/**
 * ═══ HAI CÔNG TẮC ĐỔI SỐ TIỀN CỦA NGƯỜI THẬT ═══
 *
 * Trước bản này cả hai chỉ đặt được bằng script chạy tay trên máy chủ — nghĩa là hoặc không bao
 * giờ được bật, hoặc được bật bởi người duy nhất biết cách, và không ai khác biết nó đã đổi.
 */
export function PayrollSettingsForm({
  carryover,
  recognitionMode,
  recognitionReasons,
  payrollCovered,
  statutory,
}: {
  carryover: { enabled: boolean; startMonth: string | null; startNote: string };
  recognitionMode: "LEGACY_EXPENSES" | "PAYROLL";
  recognitionReasons: string[];
  payrollCovered: boolean;
  statutory: StatutoryConfig;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [c, setC] = useState({ enabled: carryover.enabled, startMonth: carryover.startMonth ?? "", startNote: carryover.startNote });
  const [mode, setMode] = useState(recognitionMode);
  const [st, setSt] = useState({ state: statutory.state as StatutoryState, legalBasis: statutory.legalBasis, note: statutory.note });

  const luuCarry = () =>
    start(async () => {
      const r = await savePayrollCarryoverConfig(c);
      if ("error" in r) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      toast.success(c.enabled ? `Đã bật sổ lỗ lũy kế từ tháng ${c.startMonth}` : "Đã tắt sổ lỗ lũy kế");
      router.refresh();
    });

  const luuMode = (v: "LEGACY_EXPENSES" | "PAYROLL") =>
    start(async () => {
      const r = await savePayrollRecognitionMode({ mode: v });
      if ("error" in r) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      setMode(v);
      toast.success("Đã đổi nguồn ghi nhận chi phí nhân sự");
      router.refresh();
    });

  const luuStatutory = () =>
    start(async () => {
      const r = await savePayrollStatutoryConfig(st);
      if ("error" in r) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      toast.success(`Đã khai khấu trừ theo luật: ${STATUTORY_STATE_LABEL[st.state]}`);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Sổ lỗ lũy kế"
        description="Lợi nhuận ÂM của một người không bị xoá khi sang kỳ mới: kỳ sau phải bù hết phần âm ấy trước, chỉ phần dương CÒN LẠI mới là cơ sở tính hoa hồng. Bật lên là đổi cơ sở tính tiền của mọi người có thành phần bù lỗ."
      >
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={c.enabled} onCheckedChange={(v) => setC((s) => ({ ...s, enabled: v }))} />
            <span>Bật sổ lỗ lũy kế</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="start-month">Tháng mở sổ (YYYY-MM)</Label>
              <Input id="start-month" value={c.startMonth} onChange={(e) => setC((s) => ({ ...s, startMonth: e.target.value }))} placeholder="2026-09" disabled={!c.enabled} />
              <p className="text-[11px] text-muted-foreground">
                Số dư đầu của CHÍNH tháng này là 0 theo KHAI BÁO của bạn — một lời khẳng định có chủ, có ngày. ERP không tính ngược về quá khứ: lợi nhuận của những tháng ấy được tính bằng công thức
                HÔM NAY trên dữ liệu HÔM NAY, không phải con số đã dùng để trả lương lúc đó. Dựng một chuỗi số dư từ đó rồi gọi nó là nghĩa vụ có thật là tự bịa ra một khoản nợ.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="start-note">Vì sao chọn mốc ấy</Label>
              <Input id="start-note" value={c.startNote} onChange={(e) => setC((s) => ({ ...s, startNote: e.target.value }))} placeholder="vd: tháng đầu tiên có đủ chứng từ COD" disabled={!c.enabled} />
            </div>
          </div>
          <Button size="sm" onClick={luuCarry} disabled={pending}>
            <Save className="size-4" /> Lưu
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Nguồn ghi nhận chi phí nhân sự"
        description="Lương đi vào lợi nhuận qua đường nào. Đổi sai chiều nào cũng hỏng: bảng Lương cầm quyền trong khi bảng Chi phí vẫn ghi lương là TRỪ HAI LẦN; bảng Lương cầm quyền mà chưa phủ đủ là lương BIẾN MẤT khỏi lợi nhuận. Mất hẳn nguy hiểm hơn, vì lợi nhuận cao lên thì không ai đi kiểm."
      >
        <div className="space-y-2">
          {(["LEGACY_EXPENSES", "PAYROLL"] as const).map((v) => (
            <label key={v} className="flex items-start gap-2 rounded-md border p-2 text-[13px]">
              <input type="radio" name="mode" className="mt-1" checked={mode === v} onChange={() => luuMode(v)} disabled={pending} />
              <span>
                <b>{v === "LEGACY_EXPENSES" ? "Bảng Chi phí (đang chạy, mặc định)" : "Bảng Lương"}</b>
                <span className="block text-[11px] text-muted-foreground">
                  {v === "LEGACY_EXPENSES"
                    ? "Chi phí nhân sự vào lợi nhuận qua khoản chi nhóm “Lương”. Đúng như ERP đang chạy."
                    : "Lương cứng lấy từ bảng Lương, chia theo số ngày của kỳ; nhóm “Lương” ở bảng Chi phí bị loại để không trừ hai lần. CHỈ nên bật SAU khi đã ngừng ghi lương vào bảng Chi phí."}
                </span>
              </span>
            </label>
          ))}
          {recognitionReasons.length ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <p className="font-medium">Bảng Lương {payrollCovered ? "ĐANG" : "CHƯA"} đủ điều kiện cầm quyền:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {recognitionReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              {!payrollCovered ? <p className="mt-1">Chưa đủ thì máy chi phí TỰ LÙI về bảng Chi phí kèm cảnh báo — lương không bao giờ bị để thành 0.</p> : null}
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Khấu trừ theo luật (thuế TNCN · BHXH · BHYT · BHTN)"
        description="Ở đây KHÔNG có ô nhập tỷ lệ, và đó là chủ ý: tỷ lệ pháp lý đổi theo năm, theo vùng và theo loại hợp đồng, nên một con số gõ tay sẽ in ra khoản khấu trừ SAI mà trông hoàn toàn hợp lệ. Ô này chỉ khai ERP đang ở trạng thái nào — và phiếu lương in đúng trạng thái ấy thay vì in 0 ₫."
      >
        <div className="space-y-2">
          {STATUTORY_STATES.map((v) => (
            <label key={v} className="flex items-start gap-2 rounded-md border p-2 text-[13px]">
              <input type="radio" name="statutory" className="mt-1" checked={st.state === v} onChange={() => setSt((s) => ({ ...s, state: v }))} disabled={pending} />
              <span>
                <b>{STATUTORY_STATE_LABEL[v]}</b>
                <span className="block text-[11px] text-muted-foreground">{STATUTORY_STATE_HINT[v]}</span>
              </span>
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="legal-basis">Căn cứ pháp lý</Label>
              <Input
                id="legal-basis"
                value={st.legalBasis}
                onChange={(e) => setSt((s) => ({ ...s, legalBasis: e.target.value }))}
                placeholder="vd: Nghị định 143/2018, hoặc quyết định của chủ shop ngày…"
                disabled={st.state === "NOT_CONFIGURED"}
              />
              <p className="text-[11px] text-muted-foreground">Bắt buộc khi rời khỏi “Chưa cấu hình”: một khẳng định về thuế mà không nói dựa trên văn bản nào thì sáu tháng sau không ai kiểm lại được.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="statutory-note">Ghi chú</Label>
              <Input id="statutory-note" value={st.note} onChange={(e) => setSt((s) => ({ ...s, note: e.target.value }))} placeholder="vd: áp dụng cho nhân sự ký hợp đồng chính thức" />
            </div>
          </div>
          {statutory.declaredBy ? (
            <p className="text-[11px] text-muted-foreground">
              Người khai gần nhất: <b>{statutory.declaredBy}</b>
              {statutory.declaredAt ? ` · ${statutory.declaredAt}` : ""}
            </p>
          ) : null}
          <Button size="sm" onClick={luuStatutory} disabled={pending}>
            <Save className="size-4" /> Lưu khai báo
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

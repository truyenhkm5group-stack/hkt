"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { runMarketingDigestNow, saveMarketingAlertConfig, sendTestMarketingLark } from "@/lib/actions/marketing-alerts";
import type { MarketingAlertConfig } from "@/lib/constants/marketing-alerts";

/**
 * ───────────── AI NHẬN BẢN TIN MARKETING ─────────────
 *
 * Mỗi MKTer nhận ĐÚNG bản của mình; quản lý nhận bản tổng. Gửi tất cả vào một nhóm chung thì mỗi
 * người phải tự tìm dòng của mình giữa năm người khác, và con số của người này hiện trước mặt
 * người kia.
 *
 * ─── KHOÁ KÝ KHÔNG BAO GIỜ ĐƯỢC ĐỔ NGƯỢC RA MÀN HÌNH ───
 *
 * Máy chủ gửi xuống chuỗi RỖNG cho mọi `larkSecret`, và ô nhập để trống nghĩa là GIỮ NGUYÊN khoá
 * cũ. Nhờ vậy màn hình sửa được cấu hình mà không bao giờ phải cầm khoá trong tay — kho mã này
 * PUBLIC và một webhook Lark là quyền gửi tin vào nhóm nội bộ.
 */
export function MarketingDigestForm({ config, marketers }: { config: MarketingAlertConfig; marketers: { id: string; label: string }[] }) {
  const [form, setForm] = useState<MarketingAlertConfig>({ ...config, managerSecret: "", recipients: config.recipients.map((r) => ({ ...r, larkSecret: "" })) });
  const [pending, start] = useTransition();
  const router = useRouter();

  const set = <K extends keyof MarketingAlertConfig>(key: K, value: MarketingAlertConfig[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setRecipient = (i: number, patch: Partial<MarketingAlertConfig["recipients"][number]>) =>
    setForm((f) => ({ ...f, recipients: f.recipients.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));

  const save = () =>
    start(async () => {
      // Ô khoá ký để trống ⇒ GIỮ khoá cũ. Gửi chuỗi rỗng đi sẽ xoá mất khoá mà không ai định xoá.
      const payload = {
        ...form,
        managerSecret: form.managerSecret || config.managerSecret,
        recipients: form.recipients.map((r, i) => ({ ...r, larkSecret: r.larkSecret || config.recipients[i]?.larkSecret || "" })),
      };
      const res = await saveMarketingAlertConfig(payload);
      if ("error" in res) toast.error(res.error);
      else {
        toast.success("Đã lưu cấu hình bản tin marketing");
        router.refresh();
      }
    });

  const test = () =>
    start(async () => {
      const res = await sendTestMarketingLark();
      if ("error" in res) toast.error(res.error);
      else toast.success("Đã gửi tin thử vào nhóm quản lý");
    });

  const runNow = () =>
    start(async () => {
      const res = await runMarketingDigestNow();
      if ("error" in res) toast.error(res.error);
      else toast.success(res.detail);
    });

  return (
    <div className="space-y-4 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox checked={form.enabled} onCheckedChange={(v) => set("enabled", v === true)} /> Bật bản tin marketing hằng ngày
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Webhook Lark · nhóm quản lý (bản tổng)</Label>
          <Input value={form.managerWebhookUrl} onChange={(e) => set("managerWebhookUrl", e.target.value)} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…" />
          <p className="text-[11px] text-muted-foreground">Trống ⇒ dùng webhook cảnh báo chung ở phần trên.</p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Khoá ký (Signature) · nhóm quản lý</Label>
          <Input type="password" value={form.managerSecret} onChange={(e) => set("managerSecret", e.target.value)} placeholder={config.managerSecret ? "•••••• (để trống = giữ nguyên)" : "không bắt buộc"} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-xs">Giờ gửi (giờ VN)</Label>
          <Input type="number" min={0} max={23} value={form.digestHour} onChange={(e) => set("digestHour", Number(e.target.value))} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Mức tối thiểu để làm phiền MKTer</Label>
          <Select value={form.minSeverityToSend} onValueChange={(v) => set("minSeverityToSend", v as MarketingAlertConfig["minSeverityToSend"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="INFO">Mọi phát hiện</SelectItem>
              <SelectItem value="WARNING">Từ mức cảnh báo</SelectItem>
              <SelectItem value="CRITICAL">Chỉ mức nghiêm trọng</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Đường dẫn ERP (chèn liên kết vào tin)</Label>
          <Input value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://erp.vnxcommerce.com" />
        </div>
      </div>

      <label className="flex items-center gap-2">
        <Checkbox checked={form.perMarketer} onCheckedChange={(v) => set("perMarketer", v === true)} /> Gửi bản riêng cho từng MKTer
      </label>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Người nhận</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => set("recipients", [...form.recipients, { marketerId: "", larkWebhookUrl: "", larkSecret: "", active: true }])}
          >
            <Plus className="mr-1 size-3.5" /> Thêm người
          </Button>
        </div>
        {form.recipients.length === 0 ? (
          <p className="text-xs text-muted-foreground">Chưa khai ai. Bản tổng vẫn gửi cho quản lý; MKTer sẽ không nhận bản riêng nào.</p>
        ) : null}
        {form.recipients.map((r, i) => (
          <div key={i} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto]">
            <Select value={r.marketerId} onValueChange={(v) => setRecipient(i, { marketerId: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Chọn MKTer" />
              </SelectTrigger>
              <SelectContent>
                {marketers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input className="h-8 text-xs" value={r.larkWebhookUrl} onChange={(e) => setRecipient(i, { larkWebhookUrl: e.target.value })} placeholder="Webhook Lark riêng của người này" />
            <Input
              className="h-8 text-xs"
              type="password"
              value={r.larkSecret}
              onChange={(e) => setRecipient(i, { larkSecret: e.target.value })}
              placeholder={config.recipients[i]?.larkSecret ? "•••••• (giữ nguyên)" : "khoá ký"}
            />
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-1 text-[11px]">
                <Checkbox checked={r.active} onCheckedChange={(v) => setRecipient(i, { active: v === true })} /> Bật
              </label>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => set("recipients", form.recipients.filter((_, idx) => idx !== i))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          Lưu cấu hình
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={test}>
          <Send className="mr-1 size-3.5" /> Gửi thử vào nhóm quản lý
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={runNow}>
          Chạy bản tin ngay
        </Button>
      </div>
      {/* "Chạy ngay" đi qua ĐÚNG sổ chống gửi lại của bộ lập lịch: đã gửi hôm nay thì nó báo bỏ qua,
          chứ không gửi bản thứ hai. Đó là điều làm nút này an toàn để bấm khi đang thắc mắc. */}
      <p className="text-[11px] text-muted-foreground">
        &ldquo;Chạy bản tin ngay&rdquo; dùng chung sổ chống gửi lại với bộ lập lịch — đã gửi cho hôm nay thì nó báo &ldquo;bỏ qua&rdquo; chứ không gửi trùng. Bản tin nói về NGÀY HÔM QUA, kèm kết quả
        cuối của ngày gần nhất đã đủ độ chín.
      </p>
    </div>
  );
}

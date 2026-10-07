"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adjustAiBalanceAction, setAiBalanceEnabledAction } from "@/lib/actions/ai-balance";

/** Mã lượt gửi mới cho mỗi lần mở form — bấm hai lần không ra hai dòng sổ (lõi khoá theo mã này). */
function newRequestKey(): string {
  return `rk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function AiBalanceToggleForm() {
  const [orgCode, setOrgCode] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const submit = (enabled: boolean) =>
    start(async () => {
      const r = await setAiBalanceEnabledAction({ orgCode, enabled, reason });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <Label htmlFor="aib-toggle-org">Mã tổ chức</Label>
        <Input id="aib-toggle-org" value={orgCode} onChange={(e) => setOrgCode(e.target.value)} placeholder="vd hs-thien-nga-test" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="aib-toggle-reason">Lý do</Label>
        <Input id="aib-toggle-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd canary workspace thử" />
      </div>
      <div className="flex gap-2">
        <Button type="button" disabled={pending} onClick={() => submit(true)}>
          Bật
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => submit(false)}>
          Tắt
        </Button>
      </div>
    </div>
  );
}

const KINDS = [
  { value: "PROMO_CREDIT", label: "Tặng (tiền tặng, không phải doanh thu)" },
  { value: "ADJUST_CASH", label: "Điều chỉnh tiền thật (+/−)" },
  { value: "ADJUST_PROMO", label: "Điều chỉnh tiền tặng (+/−)" },
  { value: "REFUND", label: "Hoàn tiền thật cho khách (trừ số dư)" },
] as const;

export function AiBalanceAdjustForm() {
  const [orgCode, setOrgCode] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("PROMO_CREDIT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await adjustAiBalanceAction({ orgCode, kind, amountVnd: amount, reason, requestKey });
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(r.message);
            setAmount("");
            setReason("");
            setRequestKey(newRequestKey());
          }
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="aib-adj-org">Mã tổ chức</Label>
        <Input id="aib-adj-org" value={orgCode} onChange={(e) => setOrgCode(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="aib-adj-kind">Loại</Label>
        <select id="aib-adj-kind" className="h-9 w-full rounded-md border bg-background px-2" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number]["value"])}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="aib-adj-amount">Số tiền (đ)</Label>
        <Input id="aib-adj-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="vd 100000 hoặc -50000" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="aib-adj-reason">Lý do</Label>
        <Input id="aib-adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button type="submit" disabled={pending || !orgCode || !amount || !reason}>
        Ghi vào sổ
      </Button>
    </form>
  );
}

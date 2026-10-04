"use client";

import { useState } from "react";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setPlatformCostsAction } from "@/lib/actions/platform-saas";
import { PILOT_REASON_MIN } from "@/lib/constants/pilot";

/** Khai chi phí nền tảng / tháng — để trống = CHƯA KHAI (biên gộp in «—»), khác 0. */
export function PlatformCostForm({ current }: { current: { infraMonthlyVnd: number | null; supportMonthlyVnd: number | null } }) {
  const [infra, setInfra] = useState(current.infraMonthlyVnd === null ? "" : String(current.infraMonthlyVnd));
  const [support, setSupport] = useState(current.supportMonthlyVnd === null ? "" : String(current.supportMonthlyVnd));
  const same = infra === (current.infraMonthlyVnd === null ? "" : String(current.infraMonthlyVnd)) && support === (current.supportMonthlyVnd === null ? "" : String(current.supportMonthlyVnd));
  return (
    <ConfirmWithReason
      id="platform-costs"
      label="Khai chi phí…"
      title="Lưu chi phí nền tảng / tháng?"
      consequence="Biên lợi nhuận gộp và biên đóng góp của nền tảng tính lại ngay theo số này. Ô để trống nghĩa là CHƯA KHAI — màn hình in «—», không coi là 0 đồng."
      minReason={PILOT_REASON_MIN}
      placeholder="Hoá đơn VPS + sao lưu tháng 10"
      disabled={same}
      run={(reason) => setPlatformCostsAction({ infraMonthlyVnd: infra.trim(), supportMonthlyVnd: support.trim(), reason })}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="cost-infra">Hạ tầng / tháng (VND)</Label>
          <Input id="cost-infra" value={infra} onChange={(e) => setInfra(e.target.value)} inputMode="numeric" placeholder="để trống = chưa khai" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cost-support">Hỗ trợ khách / tháng (VND)</Label>
          <Input id="cost-support" value={support} onChange={(e) => setSupport(e.target.value)} inputMode="numeric" placeholder="để trống = chưa khai" />
        </div>
      </div>
    </ConfirmWithReason>
  );
}

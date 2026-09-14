"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER } from "@/lib/constants/departments";
import { SLA_STATE_LABEL, SLA_STATES, WORK_STATUS_LABEL, WORK_STATUSES } from "@/lib/constants/work";
import { WORK_SOURCES, WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";

/** Bộ lọc nằm trên URL (nuqs) như mọi danh sách khác của ERP — chia sẻ được đường dẫn đã lọc. */
export function WorkFilters() {
  const [f, setF] = useQueryStates(
    { dept: parseAsString.withDefault(""), source: parseAsString.withDefault(""), status: parseAsString.withDefault(""), sla: parseAsString.withDefault(""), unassigned: parseAsString.withDefault(""), q: parseAsString.withDefault("") },
    { shallow: false, throttleMs: 300 },
  );
  const any = Object.values(f).some(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input placeholder="Tìm tiêu đề / mã đơn / mã vận đơn" value={f.q} onChange={(e) => setF({ q: e.target.value || null })} className="h-9 w-full sm:w-64" />
      <Picker label="Phòng ban" value={f.dept} onChange={(v) => setF({ dept: v })} options={DEPARTMENT_ORDER.map((d) => ({ value: d, label: DEPARTMENT_LABEL[d] }))} />
      <Picker label="Nguồn" value={f.source} onChange={(v) => setF({ source: v })} options={WORK_SOURCES.map((s) => ({ value: s, label: WORK_SOURCE_SPEC[s].label }))} />
      <Picker label="Trạng thái" value={f.status} onChange={(v) => setF({ status: v })} options={WORK_STATUSES.map((s) => ({ value: s, label: WORK_STATUS_LABEL[s] }))} />
      <Picker label="Hạn" value={f.sla} onChange={(v) => setF({ sla: v })} options={SLA_STATES.map((s) => ({ value: s, label: SLA_STATE_LABEL[s] }))} />
      <Button variant={f.unassigned ? "default" : "outline"} size="sm" className="h-9" onClick={() => setF({ unassigned: f.unassigned ? null : "1" })}>
        Chưa ai nhận
      </Button>
      {any ? (
        <Button variant="ghost" size="sm" className="h-9" onClick={() => setF({ dept: null, source: null, status: null, sla: null, unassigned: null, q: null })}>
          Xoá lọc
        </Button>
      ) : null}
    </div>
  );
}

function Picker({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string | null) => void; options: { value: string; label: string }[] }) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? null : v)}>
      <SelectTrigger className="h-9 w-auto min-w-[130px]"><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}: tất cả</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

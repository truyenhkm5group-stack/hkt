"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { setDuplicateRule, setDwellThreshold } from "@/lib/actions/logistics-config";
import { DWELL_LEVEL_LABEL } from "@/lib/constants/shipment-status-age";

export type DwellRow = {
  stage: string;
  stageLabel: string;
  why: string;
  /** Đang hiệu lực (mặc định đã áp ghi đè). `null` = chặng này không đặt hạn. */
  watch: number | null;
  warning: number | null;
  exception: number | null;
  overridden: boolean;
  /** Mặc định của mã, để người sửa biết mình đang lệch bao nhiêu so với bộ số đã chạy thật. */
  defaultWatch: number | null;
  defaultWarning: number | null;
  defaultException: number | null;
  /** Số kiện đang ở chặng này trên production — sửa ngưỡng mà không thấy dân số là sửa mù. */
  live: number;
};

/**
 * ═══════ CẤU HÌNH LUẬT GIAO VẬN ═══════
 *
 * Màn hình này cố ý hiện SỐ KIỆN ĐANG Ở MỖI CHẶNG ngay cạnh ô ngưỡng. Sửa một ngưỡng mà không biết
 * nó đang áp lên bao nhiêu kiện là sửa mù — và đó đúng là cách `PENDING` đi tới chỗ hai mức dưới
 * cùng bắt 95% dân số mà không ai nhận ra trong nhiều tháng.
 */
export function LogisticsRulesPanel({ rows, duplicate }: { rows: DwellRow[]; duplicate: { windowHours: number; enabled: boolean } }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(ok);
      router.refresh();
    });

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[38%]">Chặng vận đơn</TableHead>
              <TableHead className="w-[90px]">Đang chạy</TableHead>
              <TableHead className="w-[110px]">{DWELL_LEVEL_LABEL.WATCH}</TableHead>
              <TableHead className="w-[110px]">{DWELL_LEVEL_LABEL.WARNING}</TableHead>
              <TableHead className="w-[110px]">{DWELL_LEVEL_LABEL.EXCEPTION}</TableHead>
              <TableHead>Mặc định</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <DwellRowEditor key={r.stage} row={r} pending={pending} run={run} />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-lg border p-4">
        <p className="text-sm font-semibold">Dò đơn trùng</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Hai đơn cùng SĐT + cùng mẫu mã trong cửa sổ này thì bị NGHI trùng. Đo trên dữ liệu thật 15/09/2026: 28/29 cặp trùng-SKU nằm
          gọn trong <b>6 giờ đầu</b>; mở từ 6h lên 48h chỉ thêm đúng một cặp, còn quá 7 ngày thì hầu hết là khách quay lại. ERP chỉ
          NGHI — không bao giờ tự gộp hay tự huỷ đơn.
        </p>
        <DuplicateEditor rule={duplicate} pending={pending} run={run} />
      </div>
    </div>
  );
}

function DwellRowEditor({
  row,
  pending,
  run,
}: {
  row: DwellRow;
  pending: boolean;
  run: (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) => void;
}) {
  const [w, setW] = useState(row.watch?.toString() ?? "");
  const [wa, setWa] = useState(row.warning?.toString() ?? "");
  const [ex, setEx] = useState(row.exception?.toString() ?? "");

  const luu = () =>
    run(
      () => setDwellThreshold({ stage: row.stage, watch: Number(w) || null, warning: Number(wa) || null, exception: Number(ex) || null }),
      `Đã đổi ngưỡng ${row.stageLabel}`,
    );

  const doi = w !== (row.watch?.toString() ?? "") || wa !== (row.warning?.toString() ?? "") || ex !== (row.exception?.toString() ?? "");

  return (
    <TableRow>
      <TableCell className="align-top">
        <p className="text-sm font-medium">{row.stageLabel}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{row.why}</p>
      </TableCell>
      <TableCell className="align-top numeric text-sm">{row.live}</TableCell>
      {(
        [
          [w, setW],
          [wa, setWa],
          [ex, setEx],
        ] as const
      ).map(([v, set], i) => (
        <TableCell key={i} className="align-top">
          <Input type="number" min={1} max={2160} value={v} onChange={(e) => set(e.target.value)} className="h-8 w-[88px]" disabled={pending} />
        </TableCell>
      ))}
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {row.defaultWatch === null ? "không đặt hạn" : `${row.defaultWatch} / ${row.defaultWarning} / ${row.defaultException} giờ`}
          </span>
          {doi ? (
            <Button size="sm" className="h-7" onClick={luu} disabled={pending}>
              Lưu
            </Button>
          ) : null}
          {row.overridden ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={pending}
              onClick={() => run(() => setDwellThreshold({ stage: row.stage, watch: null, warning: null, exception: null, reset: true }), "Đã trả về mặc định")}
            >
              Trả mặc định
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function DuplicateEditor({
  rule,
  pending,
  run,
}: {
  rule: { windowHours: number; enabled: boolean };
  pending: boolean;
  run: (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) => void;
}) {
  const [h, setH] = useState(rule.windowHours.toString());
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="cua-so-trung" className="text-xs text-muted-foreground">
          Cửa sổ (giờ)
        </label>
        <Input id="cua-so-trung" type="number" min={1} max={720} value={h} onChange={(e) => setH(e.target.value)} className="h-8 w-[110px]" disabled={pending} />
      </div>
      <Button size="sm" className="h-8" disabled={pending || !Number(h)} onClick={() => run(() => setDuplicateRule({ windowHours: Number(h), enabled: rule.enabled }), "Đã đổi cửa sổ dò trùng")}>
        Lưu cửa sổ
      </Button>
      <Button
        size="sm"
        variant={rule.enabled ? "outline" : "default"}
        className="h-8"
        disabled={pending}
        onClick={() => run(() => setDuplicateRule({ windowHours: Number(h) || rule.windowHours, enabled: !rule.enabled }), rule.enabled ? "Đã TẮT luật dò trùng" : "Đã bật lại luật dò trùng")}
      >
        {rule.enabled ? "Tắt luật dò trùng" : "Bật lại"}
      </Button>
      {!rule.enabled ? <span className="text-xs text-rose-600 dark:text-rose-400">Đang TẮT — hàng đợi rỗng vì không ai đang dò, không phải vì không có đơn trùng.</span> : null}
    </div>
  );
}

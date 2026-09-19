"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { testFanpageConnection, type TestConnectionResult } from "@/lib/actions/fanpage-ops";
import { HANDOFF_REASON_LABEL, type HandoffReason } from "@/lib/constants/sales-agent";
import { formatDateTime, formatNumber, formatPercent, pctOrNull } from "@/lib/format";
import type { FanpageOps } from "@/lib/queries/fanpage-ops";
import { cn } from "@/lib/utils";

/**
 * BẢNG ĐIỀU KHIỂN VẬN HÀNH CỦA MỘT FANPAGE — trả lời "đường dữ liệu có đang sống không".
 *
 * Tách khỏi phần khai dữ kiện bán hàng bên dưới vì nó trả lời một câu khác và thuộc về một người
 * khác: "chưa khai giá" là việc của chủ shop, "hai ngày không nhận được tin nào" là việc của người
 * vận hành. Trộn chúng vào một khối thì cả hai đều bị lướt qua.
 *
 * KHÔNG CÓ NÚT GIẢ. Mỗi nút ở đây hoặc gọi một hàm thật, hoặc là một đường dẫn thật. Việc nào chỉ
 * chạy được từ workflow vận hành thì màn hình NÓI RA tên thao tác ấy, chứ không bày một cái nút
 * trông như bấm được rồi không làm gì — một nút như thế còn tệ hơn không có nút, vì nó làm người
 * vận hành tin rằng mình đã làm xong việc.
 */
function Dong({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "bad" | "warn" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right text-sm",
          tone === "ok" && "font-medium text-emerald-700 dark:text-emerald-300",
          tone === "bad" && "font-semibold text-rose-700 dark:text-rose-300",
          tone === "warn" && "font-medium text-amber-700 dark:text-amber-300",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** `null` = CHƯA LẦN NÀO, và nó phải in ra là "chưa lần nào" — không phải một ô trống. */
function moc(d: Date | null, chua = "chưa lần nào") {
  return d ? formatDateTime(d) : chua;
}

export function FanpageOpsCard({ ops }: { ops: FanpageOps }) {
  const [ketQua, setKetQua] = useState<TestConnectionResult | null>(null);
  const [pending, start] = useTransition();

  const thu = () => {
    start(async () => {
      const r = await testFanpageConnection({ pancakePageId: ops.pancakePageId });
      setKetQua(r);
      if (!r.ok) toast.error(r.error);
      else if (!r.seesThisPage) toast.warning("Gọi được Pancake nhưng KHÔNG thấy page này");
      else toast.success(`Đọc được page ${r.pageName || ops.pancakePageId}`);
    });
  };

  const napChet = ops.consecutiveErrors > 0;
  const chuaNapLanNao = !ops.lastRunAt;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">0 · Tình trạng vận hành</h2>
        <span className="text-xs text-muted-foreground">Nấc quyền hạn: {ops.aiMode}</span>
      </div>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <div>
          <Dong label="Tên page" value={ops.name || "(chưa khai)"} />
          <Dong label="Mã page Pancake" value={<code className="font-mono text-xs">{ops.pancakePageId}</code>} />
          <Dong
            label="Mã page Facebook"
            value={ops.facebookPageId ? <code className="font-mono text-xs">{ops.facebookPageId}</code> : "CHƯA KHAI"}
            tone={ops.facebookPageId ? undefined : "warn"}
          />
          <Dong label="Hồ sơ bán hàng" value={ops.hasProfile ? "đã khai" : "CHƯA KHAI"} tone={ops.hasProfile ? "ok" : "warn"} />
          {/* Chứng thư: CHỈ nói có hay không. Kho mã này PUBLIC — không có đường nào ra giá trị thật. */}
          <Dong label="Chứng thư Pancake" value={ops.credential.ok ? "OK" : "LỖI"} tone={ops.credential.ok ? "ok" : "bad"} />
        </div>
        <div>
          <Dong label="Lần đọc GẦN NHẤT" value={moc(ops.lastRunAt)} tone={chuaNapLanNao ? "warn" : undefined} />
          {/* Hai đồng hồ, không gộp: một bộ nạp hỏng liên tục vẫn "chạy" đều đặn. */}
          <Dong label="Lần đọc THÀNH CÔNG gần nhất" value={moc(ops.lastOkAt)} tone={ops.lastOkAt ? undefined : "warn"} />
          <Dong label="Tin khách mới nhất đã đọc" value={moc(ops.lastCustomerMessageAt)} />
          <Dong label="Số vòng hỏng liên tiếp" value={formatNumber(ops.consecutiveErrors)} tone={napChet ? "bad" : "ok"} />
          <Dong label="Lượt chạy AI (7 ngày)" value={`${formatNumber(ops.aiRuns7d)} · lỗi ${formatNumber(ops.aiErrors7d)}`} tone={ops.aiErrors7d > 0 ? "warn" : undefined} />
        </div>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">{ops.credential.note}</p>

      <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
        <div>
          <Dong label="Hội thoại đã nạp" value={formatNumber(ops.conversations)} />
          <Dong label="Tin đã nạp" value={formatNumber(ops.messages)} />
          {/* Tách tin KHÁCH khỏi tin SHOP: một page chỉ toàn tin shop nghĩa là bộ nạp đọc được
              nhưng khách chưa nhắn — khác hẳn một page không đọc được gì. */}
          <Dong label="→ của khách / của shop" value={`${formatNumber(ops.customerMessages)} / ${formatNumber(ops.employeeMessages)}`} />
        </div>
        <div>
          <Dong label="Hoạt động AI gần nhất" value={moc(ops.lastAiRunAt)} />
          <Dong
            label="Danh mục làm nền"
            value={ops.catalogProductCode ? `${ops.catalogProductCode} · ${formatNumber(ops.catalogVariants)} mẫu mã` : "CHƯA KHAI MÃ WIN"}
            tone={ops.catalogProductCode ? undefined : "warn"}
          />
          <Dong label="Giá đã khai" value={ops.catalogPriceDeclared ? "rồi" : "CHƯA — máy không báo giá"} tone={ops.catalogPriceDeclared ? "ok" : "warn"} />
        </div>
      </div>

      {/*
        CHỖ HỔNG DỮ LIỆU TỐN BAO NHIÊU.

        Dòng "Giá đã khai: CHƯA" ở trên là đúng nhưng đọc như một ô cấu hình còn trống. Khối này
        đặt một con số cạnh nó: bao nhiêu lượt máy PHẢI gọi người vì chính chỗ trống ấy. Cùng một
        sự thật, nhưng một bên là ghi chú còn một bên là việc phải làm.

        Mẫu số 0 ⇒ `pctOrNull` ra `null` ⇒ `—`. Một page chưa chạy lượt nào mà in "0% chuyển người"
        là khoe một thành tích chưa ai lập được (luật 42).
      */}
      <div className="mt-3 rounded-lg border border-border/60 p-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-semibold">Chỗ hổng dữ liệu đang tốn gì (14 ngày)</p>
          <span className="text-[11px] text-muted-foreground">
            {formatNumber(ops.handoffTotal14d)}/{formatNumber(ops.runsTotal14d)} lượt phải gọi người ·{" "}
            {formatPercent(pctOrNull(ops.handoffTotal14d, ops.runsTotal14d))}
          </span>
        </div>

        {ops.runsTotal14d === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Chưa có lượt chạy nào trong 14 ngày — chưa đo được gì.</p>
        ) : (
          <div className="mt-1.5 grid gap-x-6 sm:grid-cols-2">
            <div>
              {ops.handoffs14d.length ? (
                ops.handoffs14d.map((h) => (
                  <Dong
                    key={h.reason}
                    label={HANDOFF_REASON_LABEL[h.reason as HandoffReason] ?? h.reason}
                    value={`${formatNumber(h.count)} · ${formatPercent(pctOrNull(h.count, ops.runsTotal14d))}`}
                    tone={h.reason === "SIZE_DATA_MISSING" ? "warn" : undefined}
                  />
                ))
              ) : (
                <p className="text-xs text-muted-foreground">Không lượt nào phải gọi người.</p>
              )}
            </div>
            <div>
              {/* BA CHỖ NỐI VỀ DỮ KIỆN. Máy không nối được về mã hàng thì mọi câu nó nói đều là
                  câu chung chung — đây là thước đo mức độ nó đang NÓI CÓ CĂN CỨ. */}
              <Dong
                label="Chưa nối được về mã hàng"
                value={`${formatNumber(ops.runsWithoutProduct14d)} · ${formatPercent(pctOrNull(ops.runsWithoutProduct14d, ops.runsTotal14d))}`}
                tone={ops.runsWithoutProduct14d > 0 ? "warn" : "ok"}
              />
              <Dong
                label="Chưa chốt được mẫu mã"
                value={`${formatNumber(ops.runsWithoutVariant14d)} · ${formatPercent(pctOrNull(ops.runsWithoutVariant14d, ops.runsTotal14d))}`}
                tone={ops.runsWithoutVariant14d > 0 ? "warn" : "ok"}
              />
              <Dong
                label="Chưa có số tiền máy chủ tính"
                value={`${formatNumber(ops.runsWithoutPrice14d)} · ${formatPercent(pctOrNull(ops.runsWithoutPrice14d, ops.runsTotal14d))}`}
                tone={ops.runsWithoutPrice14d > 0 ? "warn" : "ok"}
              />
            </div>
          </div>
        )}
      </div>

      {ops.lastError ? (
        <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-50/60 p-2.5 text-xs dark:bg-rose-950/20">
          <p className="font-semibold text-rose-700 dark:text-rose-300">Lỗi gần nhất của bộ nạp</p>
          <p className="mt-0.5 break-words">{ops.lastError}</p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={thu} disabled={pending}>
          {pending ? "Đang hỏi Pancake…" : "Thử kết nối"}
        </Button>
        <Link href={`/ai/review?days=30`} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          Mở trang soát
        </Link>
        <Link href="/ai/copilot" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          Mở hàng đợi trợ lý
        </Link>
        <Link href="/ai" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          Lượt chạy &amp; lỗi
        </Link>
      </div>

      {ketQua ? (
        <div
          className={cn(
            "mt-3 rounded-lg border p-2.5 text-xs",
            !ketQua.ok
              ? "border-rose-500/40 bg-rose-50/60 dark:bg-rose-950/20"
              : ketQua.seesThisPage
                ? "border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/20"
                : "border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20",
          )}
        >
          {!ketQua.ok ? (
            <>
              <p className="font-semibold text-rose-700 dark:text-rose-300">KHÔNG GỌI ĐƯỢC PANCAKE</p>
              <p className="mt-0.5 break-words">{ketQua.error}</p>
            </>
          ) : (
            <>
              <p className={cn("font-semibold", ketQua.seesThisPage ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>
                {ketQua.seesThisPage ? `ĐỌC ĐƯỢC page này — ${ketQua.pageName || ops.pancakePageId}` : "Gọi được Pancake nhưng KHÔNG thấy page này"}
              </p>
              <p className="mt-0.5">
                chế độ {ketQua.mode} · thấy {formatNumber(ketQua.pageCount)} page · độ dài token người dùng {ketQua.tokenLength} · độ dài token page{" "}
                {ketQua.pageTokenLength}
              </p>
              {!ketQua.seesThisPage ? (
                <p className="mt-0.5">
                  Kết nối vẫn tốt — thứ sai là MÃ PAGE hoặc phạm vi của token. Token của một page chỉ mở đúng page ấy.
                </p>
              ) : null}
            </>
          )}
          {/* Không bao giờ in giá trị token. Chỉ độ dài — đủ để phân biệt "khai rỗng" với "chưa khai". */}
          <p className="mt-1 text-[11px] text-muted-foreground">Phép thử này CHỈ GỌI GET: không gửi tin, không tạo đơn, không ghi một dòng nào.</p>
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-muted-foreground">
        Nạp hội thoại chạy từ workflow <strong>Vận hành ERP trên VPS</strong> — thao tác <code>ai-staging-ingest</code> (nạp tay một
        mẻ) hoặc <code>ai-staging-live-ingest</code> (bật bộ nạp liên tục). Cố ý KHÔNG có nút nạp ở đây: một lượt nạp kéo dài hàng
        phút và có hạn mức của Pancake, nên nó thuộc về đường vận hành có xếp hàng, không thuộc về một cú bấm trên màn hình.
      </p>
    </Card>
  );
}

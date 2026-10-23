"use client";

import { useState, useTransition } from "react";
import { Copy, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildSourcingQueriesAction, type SourcingQueryResult } from "@/lib/actions/sourcing-query";
import { GLOSSARY_ROLE_LABEL } from "@/lib/constants/sourcing-glossary";
import { SOURCING_INPUT_MAX } from "@/lib/sourcing/query";

type Ok = Extract<SourcingQueryResult, { ok: true }>;

const KIND_LABEL = { FULL: "Cụ thể nhất", SYNONYM: "Từ đồng nghĩa", BROADER: "Nới rộng" } as const;

function copy(text: string) {
  if (!navigator.clipboard) {
    toast.error("Trình duyệt không cho chép — bôi đen và chép tay.");
    return;
  }
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`Đã chép «${text}»`),
    () => toast.error("Không chép được — bôi đen và chép tay."),
  );
}

function QueryRow({ zh, vi, tag }: { zh: string; vi: string; tag: string }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium break-words" lang="zh-CN">
          {zh}
        </p>
        <p className="text-xs text-muted-foreground">
          {tag} — {vi}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => copy(zh)} aria-label={`Chép ${zh}`}>
        <Copy className="size-4" />
        Chép
      </Button>
    </li>
  );
}

export function SourcingQueryBox() {
  const [text, setText] = useState("");
  const [allowAi, setAllowAi] = useState(true);
  const [result, setResult] = useState<Ok | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await buildSourcingQueriesAction({ text, allowAi });
      if (r.ok) setResult(r);
      else toast.error(r.errors[0]?.message ?? "Không sinh được từ khoá.");
    });

  const build = result?.build;
  const ai = result?.ai;
  return (
    <div className="space-y-4 text-sm" data-sourcing-query-box>
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <div className="space-y-1">
          <Label htmlFor="src-query">Mô tả món hàng bằng tiếng Việt</Label>
          <Input
            id="src-query"
            value={text}
            maxLength={SOURCING_INPUT_MAX}
            placeholder="ví dụ: đầm suông che bụng cho mẹ"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !pending) run();
            }}
          />
        </div>
        <Button disabled={pending || text.trim().length < 2} onClick={run}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Sinh từ khoá
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="src-allow-ai" checked={allowAi} onCheckedChange={(v) => setAllowAi(v === true)} />
        <Label htmlFor="src-allow-ai" className="font-normal">
          Cho phép AI thử phần từ điển chưa hiểu (tốn một lượt trong trần / ngày)
        </Label>
      </div>

      {build ? (
        <div className="space-y-3">
          {build.terms.length ? (
            <div className="flex flex-wrap gap-1.5" data-sourcing-terms>
              {build.terms.map((t) => (
                <span key={t.key} className="rounded-md border bg-muted/40 px-2 py-0.5 text-xs" title={t.note ?? undefined}>
                  {GLOSSARY_ROLE_LABEL[t.role]}: {t.text} → <span lang="zh-CN">{t.zh[0]}</span>
                  {t.viaFold ? " (đoán từ chữ không dấu)" : ""}
                </span>
              ))}
            </div>
          ) : null}

          {build.unmatched.length ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" data-sourcing-unmatched>
              Từ điển chưa hiểu: {build.unmatched.map((u) => `«${u}»`).join(", ")} — các từ này KHÔNG có trong truy vấn bên dưới.
            </p>
          ) : null}
          {!build.hasProduct ? <p className="text-amber-700 dark:text-amber-300">Chưa nhận ra loại hàng (đầm, áo, quần…) — thêm loại hàng để truy vấn trúng hơn.</p> : null}
          {build.ignored.length ? <p className="text-xs text-muted-foreground">Bỏ qua từ nối: {build.ignored.join(", ")}.</p> : null}

          {build.queries.length ? (
            <ul className="space-y-2" data-sourcing-queries>
              {build.queries.map((q) => (
                <QueryRow key={q.zh} zh={q.zh} vi={q.vi} tag={KIND_LABEL[q.kind]} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Từ điển chưa đủ để dựng truy vấn.</p>
          )}

          {ai && (ai.queries.length || ai.terms.length) ? (
            <div className="space-y-2" data-sourcing-ai>
              <p className="flex items-center gap-1.5 font-medium">
                <Sparkles className="size-4" />
                AI gợi ý — chưa kiểm
              </p>
              {ai.terms.length ? <p className="text-xs text-muted-foreground">AI dịch: {ai.terms.map((t) => `${t.vi} → ${t.zh}`).join(" · ")}</p> : null}
              <ul className="space-y-2">
                {ai.queries.map((q) => (
                  <QueryRow key={q.zh} zh={q.zh} vi={q.vi} tag="AI" />
                ))}
              </ul>
            </div>
          ) : null}
          {ai?.note ? <p className="text-xs text-muted-foreground">{ai.note}</p> : null}
          {ai && ai.usedToday !== null ? (
            <p className="text-xs text-muted-foreground">
              Lượt AI tìm hàng hôm nay: {ai.usedToday}/{ai.limit}.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">Chép truy vấn rồi tìm trên 1688 bằng tài khoản của bạn — ERP chưa nối nguồn dữ liệu nào và không cào web.</p>
        </div>
      ) : null}
    </div>
  );
}

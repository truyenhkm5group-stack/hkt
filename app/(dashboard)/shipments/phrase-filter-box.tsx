"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { PHRASE_EXAMPLES, parsePhraseFilter, type PhraseFilterResult, type PhraseParam } from "@/lib/care/phrase-filter";

/**
 * Ô LỌC BẰNG CÂU trên bàn care (giao diện Bento).
 *
 * Nó chỉ là một cách GÕ khác cho đúng những chip lọc bên dưới: câu được dịch bằng
 * `parsePhraseFilter` (hàm thuần, có kiểm thử) thành các giá trị lọc có sẵn, rồi đặt lên đường dẫn
 * như một cú bấm chip. Chip tương ứng sáng lên, nên người dùng luôn thấy máy đã hiểu câu thành gì.
 *
 * Phần máy không hiểu được IN RA và KHÔNG áp — một bộ lọc đoán sai là giấu kiện khỏi người trực.
 */
export function PhraseFilterBox({ onApply }: { onApply: (patch: Partial<Record<PhraseParam, string>>) => void }) {
  const [text, setText] = useState("");
  const [last, setLast] = useState<PhraseFilterResult | null>(null);

  const apply = (cau: string) => {
    const r = parsePhraseFilter(cau);
    setLast(r);
    if (r.understood.length) {
      onApply(r.patch);
      setText("");
    }
  };

  return (
    <div className="space-y-1.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) apply(text);
        }}
        className="flex items-center gap-2 rounded-2xl bg-card py-1.5 pl-4 pr-1.5 shadow-[var(--shadow-card)] focus-within:ring-2 focus-within:ring-primary/40"
      >
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Lọc bằng câu, ví dụ: “${PHRASE_EXAMPLES[0]}”`}
          aria-label="Lọc bằng câu tiếng Việt"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
        />
        <InfoHint>
          Máy hiểu: dải COD (không thu hộ · dưới 500k · 500k–600k · 600k–1 triệu · trên 1 triệu), hạn (quá hạn · sắp quá hạn · trong hạn), hẹn (quá hẹn · hẹn hôm nay · hẹn mai · chưa hẹn), chưa ai nhận, số lần phát hụt, số lượt đã xử lý, tên trạng thái Viettel Post, lý do care, &ldquo;chưa quyết định&rdquo;, &ldquo;kết quả phát tiếp&rdquo;, mã vận đơn / SĐT, và chữ trong ngoặc kép. Gõ không dấu cũng được. Phần không hiểu sẽ được báo lại và KHÔNG được áp.
        </InfoHint>
        <button type="submit" className="h-9 rounded-xl bg-ink px-4 text-[13px] font-semibold text-ink-foreground disabled:opacity-50" disabled={!text.trim()}>
          Lọc
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {last && (last.understood.length || last.unknown.length || last.conflicts.length) ? (
          <>
            {last.understood.length ? <span className="text-muted-foreground">Đã hiểu:</span> : null}
            {last.understood.map((h) => (
              <span key={h.param} className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-accent-foreground">
                {h.label}
              </span>
            ))}
            {last.unknown.length ? (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                Chưa hiểu, không áp: “{last.unknown.join(" ")}”
              </span>
            ) : null}
            {last.conflicts.length ? (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                Bỏ vì trùng loại: {last.conflicts.join(" · ")}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Hay dùng:</span>
            {PHRASE_EXAMPLES.map((cau) => (
              <button key={cau} type="button" onClick={() => apply(cau)} className="rounded-full border border-border bg-card px-2.5 py-0.5 text-foreground/80 hover:border-primary/50 hover:text-foreground">
                {cau}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

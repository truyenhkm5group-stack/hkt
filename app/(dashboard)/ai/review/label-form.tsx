"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { saveShadowLabel } from "@/lib/actions/ai-review";
import { Button } from "@/components/ui/button";
import { REVIEW_REASON_TAGS, REVIEW_REASON_TAG_META, REVIEW_VERDICTS, REVIEW_VERDICT_LABEL, type ReviewReasonTag, type ReviewVerdict } from "@/lib/constants/sales-review-tags";

/** Ba trạng thái, KHÔNG phải hai: chưa chấm · đúng · sai. Bỏ trạng thái "chưa chấm" là ép người
 *  soát phải nói dối ở những ô không áp dụng cho lượt đó. */
type Verdict = boolean | null;

const FIELDS: { key: string; label: string }[] = [
  { key: "productOk", label: "Sản phẩm" },
  { key: "colorOk", label: "Màu" },
  { key: "sizeOk", label: "Size" },
  { key: "phoneOk", label: "SĐT" },
  { key: "addressOk", label: "Địa chỉ" },
  { key: "intentOk", label: "Ý định" },
  { key: "purchaseIntentOk", label: "Ý muốn mua" },
  { key: "confirmationOk", label: "Xác nhận chốt" },
  { key: "replyUsable", label: "Câu dùng được" },
];

function Tri({ value, onChange, label }: { value: Verdict; onChange: (v: Verdict) => void; label: string }) {
  const cell = "rounded px-1.5 py-0.5 text-[11px] font-semibold border";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-1">
        <button type="button" onClick={() => onChange(value === true ? null : true)} className={`${cell} ${value === true ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "border-border text-muted-foreground"}`}>
          đúng
        </button>
        <button type="button" onClick={() => onChange(value === false ? null : false)} className={`${cell} ${value === false ? "border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" : "border-border text-muted-foreground"}`}>
          sai
        </button>
      </div>
    </div>
  );
}

export function LabelForm({ suggestionId, initial }: { suggestionId: string; initial: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, Verdict>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, (initial[f.key] as Verdict) ?? null])),
  );
  const [quality, setQuality] = useState<string | null>((initial.nextActionQuality as string) ?? null);
  const [verdict, setVerdict] = useState<ReviewVerdict | null>((initial.verdict as ReviewVerdict) ?? null);
  const [tags, setTags] = useState<ReviewReasonTag[]>(() => {
    const raw = initial.reasonTags;
    return Array.isArray(raw) ? (raw.filter((t): t is ReviewReasonTag => (REVIEW_REASON_TAGS as readonly string[]).includes(String(t)))) : [];
  });
  const [hallucination, setHallucination] = useState<Verdict>((initial.hallucination as Verdict) ?? null);
  const [note, setNote] = useState(String(initial.note ?? ""));
  const [expected, setExpected] = useState(String(initial.expectedBehavior ?? ""));
  const [pending, start] = useTransition();
  const [daLuu, setDaLuu] = useState<{ luc: string; ai: string } | null>(() => {
    const luc = initial.reviewedAt;
    return luc ? { luc: new Date(String(luc)).toLocaleString("vi-VN"), ai: String(initial.reviewerName ?? "") } : null;
  });

  /*
    CHƯA LƯU PHẢI NHÌN THẤY ĐƯỢC.

    Người soát chấm chín ô rồi chuyển sang lượt khác là mất sạch — và mất im lặng, vì màn hình
    trước đó trông y hệt lúc đã lưu. So với ẢNH CHỤP LÚC MỞ chứ không giữ một cờ `dirty` bật tay:
    bấm nhầm rồi bấm lại về chỗ cũ thì đúng là không có gì để lưu, và cờ bật tay sẽ nói dối.
  */
  const hienTai = JSON.stringify({ values, quality, verdict, tags: [...tags].sort(), hallucination, note, expected });
  // `useState` chỉ đọc tham số ở lần dựng ĐẦU, nên đây đúng là ảnh chụp lúc mở — và sau mỗi lần
  // lưu thành công thì dời mốc sang trạng thái vừa lưu.
  const [moc, setMoc] = useState(hienTai);
  const chuaLuu = hienTai !== moc;

  // Rời trang khi còn thay đổi chưa lưu ⇒ trình duyệt hỏi lại. Không cứu được mọi trường hợp,
  // nhưng cứu đúng trường hợp hay gặp nhất: đóng tab giữa chừng.
  useEffect(() => {
    if (!chuaLuu) return;
    const canh = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", canh);
    return () => window.removeEventListener("beforeunload", canh);
  }, [chuaLuu]);

  const submit = () => {
    start(async () => {
      const result = await saveShadowLabel({ suggestionId, ...values, nextActionQuality: quality, verdict, reasonTags: tags, hallucination, note, expectedBehavior: expected });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success("Đã lưu kết quả chấm");
      setDaLuu({ luc: new Date(result.reviewedAt).toLocaleString("vi-VN"), ai: result.reviewerName });
      setMoc(hienTai);
    });
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <p className="text-xs font-semibold">Chấm tay (để trống = chưa chấm)</p>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <Tri key={f.key} label={f.label} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
        ))}
      </div>
      {/*
        KẾT LUẬN CHUNG đứng TRƯỚC, vì đó là câu hỏi người soát trả lời được ngay khi vừa đọc xong
        câu. Nó tách khỏi "hành động kế tiếp" bên dưới có chủ ý: máy chọn đúng việc (hỏi size) mà
        câu chữ vẫn có thể không gửi được, và gộp hai câu hỏi lại là mất đúng một trong hai.
      */}
      {/*
        BA NẤC, NHƯNG CHỈ HAI KẾT CỤC — và màn hình phải nói ra cả hai tầng.

        Báo cáo chỉ đếm ĐẠT / KHÔNG ĐẠT, nên nếu nút chỉ ghi "Sửa nhẹ là gửi được" thì người chấm
        không biết mình vừa bỏ phiếu về phía nào. Nhưng gộp thẳng thành hai nút thì mất nấc giữa —
        mà nấc giữa chính là chỗ nằm của phần lớn câu trả lời thật, và là thứ phân biệt "máy viết
        được, người sửa một chữ" với "máy viết hỏng". Nên: giữ ba nút, ghi kết cục ngay trên nút.
      */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-muted-foreground">Câu này:</span>
        {REVIEW_VERDICTS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVerdict(verdict === v ? null : v)}
            className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${
              verdict === v
                ? v === "GOOD"
                  ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                  : v === "ACCEPTABLE"
                    ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                    : "border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                : "border-border text-muted-foreground"
            }`}
          >
            {v === "BAD" ? "KHÔNG ĐẠT" : "ĐẠT"} · {REVIEW_VERDICT_LABEL[v]}
          </button>
        ))}
      </div>

      {/*
        LÝ DO là một DANH SÁCH ĐÓNG, không phải ô chữ: sau ba mươi lượt chấm, câu hỏi thật sự là
        "máy hay hỏng ở ĐÂU NHẤT", và ô chữ tự do không đếm được. Mỗi nhãn hiện luôn ai phải đi sửa
        — MODEL (sửa luật / mẫu câu) · DỮ LIỆU (việc của chủ shop) · LUẬT (đổi quyết định kinh
        doanh) — vì đó mới là thứ biến một bảng đếm thành một việc. Ghi chú bên dưới vẫn còn: nhãn
        để ĐẾM, ghi chú để HIỂU.
      */}
      <div className="space-y-1 pt-1">
        <span className="text-xs text-muted-foreground">Vì sao (chọn nhiều được):</span>
        <div className="flex flex-wrap gap-1">
          {REVIEW_REASON_TAGS.map((t) => {
            const on = tags.includes(t);
            const meta = REVIEW_REASON_TAG_META[t];
            return (
              <button
                key={t}
                type="button"
                title={meta.owner === "DATA" ? "ERP thiếu dữ liệu — việc của chủ shop" : meta.owner === "POLICY" ? "Luật đang chạy — việc của người ra quyết định" : "Sửa luật / lời dặn / mẫu câu"}
                onClick={() => setTags((s) => (on ? s.filter((x) => x !== t) : [...s, t]))}
                className={`rounded px-2 py-0.5 text-[11px] border ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border text-muted-foreground"}`}
              >
                {meta.label}
                <span className="ml-1 opacity-60">{meta.owner === "DATA" ? "· dữ liệu" : meta.owner === "POLICY" ? "· luật" : ""}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-muted-foreground">Hành động kế tiếp:</span>
        {(["GOOD", "ACCEPTABLE", "WRONG"] as const).map((q) => (
          <button key={q} type="button" onClick={() => setQuality(quality === q ? null : q)} className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${quality === q ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
            {q === "GOOD" ? "tốt" : q === "ACCEPTABLE" ? "tạm được" : "sai"}
          </button>
        ))}
        <Tri label="Bịa / phá luật" value={hallucination} onChange={setHallucination} />
      </div>
      {/*
        HAI Ô CHỮ, KHÔNG MỘT — và đây không phải chuyện gọn gàng.

        "Ghi chú" trả lời *người chấm nghĩ gì*; ô dưới trả lời *đúng ra máy phải làm gì*. Chỉ câu
        thứ hai biến một lượt chấm thành một CA HỒI QUY: muốn khoá một lỗi lại thì phải có kỳ vọng,
        và kỳ vọng ấy chỉ người vừa đọc ca mới nói được. Gộp vào một ô thì lúc dựng ca phải ĐOÁN
        đoạn nào là kỳ vọng — đúng thứ bộ hồi quy sinh ra để khỏi phải đoán.

        Ô này chỉ hiện khi đã chấm KHÔNG ĐẠT: lượt đạt thì không có gì "lẽ ra phải khác", và một ô
        trống luôn hiện ra là một ô người ta học cách bỏ qua.
      */}
      {verdict === "BAD" ? (
        <textarea
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="ĐÚNG RA MÁY PHẢI LÀM GÌ? (câu này sẽ thành kỳ vọng của ca hồi quy)"
          className="w-full rounded-md border border-rose-500/50 bg-background p-2 text-xs"
          rows={2}
        />
      ) : null}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded-md border border-border bg-background p-2 text-xs" rows={2} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? "Đang lưu…" : "Lưu kết quả chấm"}
        </Button>
        {chuaLuu ? (
          <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">CHƯA LƯU</span>
        ) : daLuu ? (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
            ĐÃ LƯU · {daLuu.luc}
            {daLuu.ai ? ` · ${daLuu.ai}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

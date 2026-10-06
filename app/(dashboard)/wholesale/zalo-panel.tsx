"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { logZaloOpenedAction, logZaloResultAction, zaloDraftAction } from "@/lib/actions/wholesale";
import { ZALO_RESULT_ICON, ZALO_RESULT_LABEL, ZALO_RESULTS, type ZaloResult } from "@/lib/wholesale/constants";
import type { ZaloDraft } from "@/lib/wholesale/leads";
import { cn } from "@/lib/utils";

/**
 * NHẮN ZALO TRƯỚC, GỌI SAU (chủ shop 06/10/2026). Một bấm: CHÉP tin chào sỉ đã cá nhân hoá + MỞ `zalo.me/<SĐT>` (app Zalo
 * trên điện thoại / Zalo PC). Link Zalo không điền sẵn được chữ, nên tin nằm sẵn trong bộ nhớ tạm — nhân viên giữ ngón tay
 * vào ô chat → Dán. Ảnh gửi bằng nút chia sẻ của máy (`navigator.share` với tệp) → chọn Zalo → chọn cuộc trò chuyện vừa mở.
 *
 * ERP KHÔNG biết trước số có Zalo hay không — app Zalo tự hiện hồ sơ hoặc báo «không tìm thấy»; nhân viên quay lại bấm
 * một trong ba kết quả. «Không có Zalo» được nhớ và đẩy khách lên hàng «Cần gọi».
 */
export function ZaloPanel({ leadId, initial, onResult, big = false }: { leadId: string; initial?: ZaloDraft | null; onResult?: (r: ZaloResult) => void; big?: boolean }) {
  const [draft, setDraft] = useState<ZaloDraft | null>(initial ?? null);
  const [text, setText] = useState(initial?.text ?? "");
  const [opened, setOpened] = useState(false);
  const [files, setFiles] = useState<File[] | null>(null);
  const [saving, setSaving] = useState<ZaloResult | null>(null);

  useEffect(() => {
    if (initial) return;
    let live = true;
    void zaloDraftAction(leadId).then((r) => {
      if (!live) return;
      if ("error" in r) toast.error(r.error);
      else {
        setDraft(r.draft);
        setText(r.draft.text);
      }
    });
    return () => {
      live = false;
    };
  }, [leadId, initial]);

  // Tải sẵn ảnh: điện thoại chỉ cho mở bảng chia sẻ NGAY trong cú bấm — tải trong cú bấm là mất quyền mở.
  const imageCount = draft?.link ? draft.images : 0;
  useEffect(() => {
    if (!imageCount) return;
    let live = true;
    void Promise.all(
      Array.from({ length: imageCount }, async (_, i) => {
        const res = await fetch(`/api/wholesale/zalo-image/${i}`);
        if (!res.ok) return null;
        const blob = await res.blob();
        const ext = (blob.type.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
        return new File([blob], `san-pham-${i + 1}.${ext}`, { type: blob.type });
      }),
    ).then((fs) => live && setFiles(fs.filter((f): f is File => f !== null)));
    return () => {
      live = false;
    };
  }, [imageCount]);

  if (!draft) return <div className="rounded-xl border bg-card p-3 text-sm text-muted-foreground">Đang soạn tin Zalo…</div>;
  if (!draft.link) return <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">💬 {draft.reason ?? "Không mở được Zalo cho số này."}</p>;

  const openZalo = () => {
    // Chép trước (vẫn trong cú bấm), mở Zalo sau. Lỗi ghi lượt bấm không được chặn việc nhắn.
    void navigator.clipboard?.writeText(text).then(
      () => toast.success("Đã chép tin — vào Zalo giữ ngón tay ở ô chat → Dán"),
      () => toast.error("Máy không cho chép tự động — chép tay ô tin bên dưới"),
    );
    void logZaloOpenedAction(leadId).catch(() => undefined);
    window.open(draft.link!, "_blank", "noopener");
    setOpened(true);
  };
  const shareImages = async () => {
    if (!files?.length) return void toast.error("Ảnh chưa tải xong — thử lại sau vài giây");
    const data: ShareData = { files, text };
    if (typeof navigator.canShare === "function" && navigator.canShare(data)) {
      try {
        await navigator.share(data);
      } catch {
        /* người dùng đóng bảng chia sẻ */
      }
      return;
    }
    for (let i = 0; i < files.length; i++) window.open(`/api/wholesale/zalo-image/${i}`, "_blank", "noopener");
    toast.message("Máy này không chia sẻ ảnh trực tiếp được — ảnh đã mở ở tab mới, lưu rồi gửi trong Zalo");
  };
  const record = async (r: ZaloResult) => {
    if (saving) return;
    setSaving(r);
    const res = await logZaloResultAction(leadId, { result: r, note: "" });
    setSaving(null);
    if ("error" in res) return void toast.error(res.error);
    toast.success(r === "NOT_FOUND" ? "Đã ghi: không có Zalo — gọi điện cho khách" : `Đã ghi: ${ZALO_RESULT_LABEL[r]} — hẹn gọi lại nếu khách chưa trả lời`);
    onResult?.(r);
  };

  return (
    <div className="space-y-2 rounded-xl border-2 border-sky-500/60 bg-sky-50/50 p-3 dark:bg-sky-950/30">
      <div className="flex items-center justify-between gap-2 text-sm font-semibold">
        <span>💬 Bước 1 · Nhắn Zalo chào sỉ</span>
        {draft.zaloStatus === "FOUND" ? <span className="text-xs font-normal text-emerald-700 dark:text-emerald-300">Số này có Zalo</span> : null}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={big ? 7 : 5} className="w-full rounded-lg border bg-background p-2 text-sm" aria-label="Tin nhắn Zalo" />
      <button type="button" onClick={openZalo} className={cn("flex w-full items-center justify-center rounded-xl bg-sky-600 font-semibold text-white shadow-sm active:scale-[0.99]", big ? "min-h-14 text-base" : "min-h-11 text-sm")}>
        💬 Chép tin & mở Zalo · {draft.phoneDisplay}
      </button>
      {draft.images ? (
        <button type="button" onClick={() => void shareImages()} className={cn("flex w-full items-center justify-center rounded-xl border bg-card text-sm font-medium", big ? "min-h-12" : "min-h-10")}>
          🖼 Gửi {draft.images} ảnh sản phẩm qua Zalo {files === null ? "(đang tải…)" : ""}
        </button>
      ) : null}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Zalo hiện hồ sơ ⇒ «Kết bạn» / «Nhắn tin», giữ ngón tay ở ô chat → Dán → Gửi. Zalo báo không tìm thấy ⇒ bấm «Không có Zalo» rồi gọi điện.
      </p>
      <div className={cn("grid grid-cols-3 gap-1.5", !opened && "opacity-90")}>
        {ZALO_RESULTS.map((r) => (
          <button key={r} type="button" disabled={saving !== null} onClick={() => void record(r)} className={cn("flex items-center justify-center gap-1 rounded-lg border bg-card px-1.5 text-xs font-medium active:bg-muted disabled:opacity-60", big ? "min-h-12" : "min-h-10")}>
            <span>{ZALO_RESULT_ICON[r]}</span>
            {saving === r ? "Đang lưu…" : ZALO_RESULT_LABEL[r]}
          </button>
        ))}
      </div>
    </div>
  );
}

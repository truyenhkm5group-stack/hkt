"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Film, ImageIcon, Paperclip, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { finishTopicFileUpload, removeTopicFile, startTopicFileUpload, uploadTopicFileChunk } from "@/lib/actions/production-topic-files";
import { checkTopicFileUpload, formatMb, TOPIC_FILE_ACCEPT, TOPIC_IMAGE_MAX_EDGE, TOPIC_IMAGE_QUALITY, TOPIC_VIDEO_MAX_BYTES, type TopicFileKind } from "@/lib/constants/production-files";
import { formatDateTime } from "@/lib/format";
import { thuNhoAnhTheoCo } from "@/lib/ideas/shrink-image";

/**
 * ẢNH / VIDEO ĐÍNH KÈM TOPIC SẢN XUẤT — phía trình duyệt.
 *
 * `uploadTopicFiles` là đường tải DUY NHẤT (biểu mẫu mở topic và khung trên trang topic cùng gọi): ảnh thu
 * nhỏ sang JPEG trên máy người dùng; video gửi nguyên, chia khúc theo cỡ máy chủ trả về. Mỗi khúc thử lại
 * tối đa 2 lần — mạng 4G chập chờn giữa một video 50 MB không được làm hỏng cả lượt.
 */

const VIDEO_BY_EXT: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

function kindOfLocal(file: File): TopicFileKind | null {
  if (file.type.startsWith("image/")) return "IMAGE";
  if (file.type.startsWith("video/") || VIDEO_BY_EXT[file.name.split(".").pop()?.toLowerCase() ?? ""]) return "VIDEO";
  return null;
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Chuẩn bị một tệp để gửi: ảnh ⇒ JPEG thu nhỏ; video ⇒ nguyên tệp với kiểu đọc được. */
async function prepare(file: File): Promise<{ blob: Blob; type: string; name: string }> {
  const kind = kindOfLocal(file);
  if (kind === "IMAGE") {
    let anh;
    try {
      anh = await thuNhoAnhTheoCo(file, { maxEdge: TOPIC_IMAGE_MAX_EDGE, quality: TOPIC_IMAGE_QUALITY });
    } catch {
      throw new Error(`${file.name}: trình duyệt không đọc được ảnh này (ảnh HEIC?) — chụp màn hình hoặc đổi sang JPG rồi chọn lại`);
    }
    return { blob: base64ToBlob(anh.base64, "image/jpeg"), type: "image/jpeg", name: `${file.name.replace(/\.[^.]+$/, "") || "anh"}.jpg` };
  }
  if (kind === "VIDEO") {
    const type = file.type || VIDEO_BY_EXT[file.name.split(".").pop()?.toLowerCase() ?? ""] || "";
    return { blob: file, type, name: file.name };
  }
  throw new Error(`${file.name}: chỉ nhận ảnh hoặc video`);
}

async function withRetry<T>(fn: () => Promise<T>, times = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("Mất kết nối khi tải tệp");
}

export type UploadProgress = { done: number; total: number; current: string };

export async function uploadTopicFiles(topicId: string, files: File[], onProgress?: (p: UploadProgress) => void): Promise<{ ok: number; errors: string[] }> {
  const errors: string[] = [];
  let ok = 0;
  const total = files.reduce((s, f) => s + f.size, 0) || 1;
  let done = 0;
  for (const file of files) {
    onProgress?.({ done, total, current: file.name });
    try {
      const p = await prepare(file);
      const start = await startTopicFileUpload({ topicId, fileName: p.name, contentType: p.type, bytes: p.blob.size });
      if ("error" in start) throw new Error(`${file.name}: ${start.error}`);
      // Tiến độ tính theo cỡ tệp GỐC (thứ người dùng thấy); ảnh đã thu nhỏ thì mỗi khúc "nặng" hơn tương ứng.
      const heSo = file.size / p.blob.size;
      for (let seq = 0; seq < start.chunkCount; seq++) {
        const chunk = p.blob.slice(seq * start.chunkBytes, (seq + 1) * start.chunkBytes);
        const form = new FormData();
        form.set("fileId", start.fileId);
        form.set("seq", String(seq));
        form.set("chunk", chunk);
        const r = await withRetry(() => uploadTopicFileChunk(form));
        if ("error" in r) throw new Error(`${file.name}: ${r.error}`);
        done += chunk.size * heSo;
        onProgress?.({ done, total, current: file.name });
      }
      const fin = await withRetry(() => finishTopicFileUpload(start.fileId));
      if ("error" in fin) throw new Error(`${file.name}: ${fin.error}`);
      ok++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  onProgress?.({ done: total, total, current: "" });
  return { ok, errors };
}

type Picked = { key: string; file: File; kind: TopicFileKind; url: string };

/**
 * Ô chọn ảnh / video (chưa tải lên). Video vượt trần bị gạt NGAY lúc chọn — đợi tới lúc bấm lưu mới báo là
 * bắt người ta chờ vài phút cho một câu "không nhận".
 */
export function TopicFilePicker({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const picked = useMemo<Picked[]>(
    () => files.map((f, i) => ({ key: `${i}-${f.name}-${f.size}`, file: f, kind: kindOfLocal(f) ?? "IMAGE", url: URL.createObjectURL(f) })),
    [files],
  );
  useEffect(() => () => picked.forEach((p) => URL.revokeObjectURL(p.url)), [picked]);

  const them = (list: FileList | null) => {
    if (!list) return;
    const moi: File[] = [];
    for (const f of Array.from(list)) {
      const kind = kindOfLocal(f);
      if (!kind) {
        toast.error(`${f.name}: chỉ nhận ảnh hoặc video`);
        continue;
      }
      if (kind === "VIDEO") {
        const kiem = checkTopicFileUpload({ contentType: f.type || VIDEO_BY_EXT[f.name.split(".").pop()?.toLowerCase() ?? ""] || "", bytes: f.size, readyCount: 0 });
        if (!kiem.ok) {
          toast.error(`${f.name}: ${kiem.error}`);
          continue;
        }
      }
      moi.push(f);
    }
    if (moi.length) onChange([...files, ...moi]);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()}>
          <Paperclip className="size-4" /> Chọn ảnh / video
        </Button>
        <span className="text-xs text-muted-foreground">Ảnh tự thu nhỏ trước khi tải · video tối đa {formatMb(TOPIC_VIDEO_MAX_BYTES)} mỗi tệp</span>
        <input ref={inputRef} type="file" multiple accept={TOPIC_FILE_ACCEPT} className="hidden" onChange={(e) => them(e.target.files)} />
      </div>
      {picked.length ? (
        <ul className="flex flex-wrap gap-2">
          {picked.map((p, i) => (
            <li key={p.key} className="relative w-28 overflow-hidden rounded-md border bg-muted/40 text-xs">
              {p.kind === "IMAGE" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.url} alt="" className="h-20 w-full object-cover" />
              ) : (
                <video src={p.url} muted preload="metadata" className="h-20 w-full bg-black object-cover" />
              )}
              <div className="truncate px-1.5 py-1" title={p.file.name}>
                {p.kind === "VIDEO" ? <Film className="mr-1 inline size-3" /> : <ImageIcon className="mr-1 inline size-3" />}
                {formatMb(p.file.size)}
              </div>
              {disabled ? null : (
                <button type="button" aria-label={`Bỏ ${p.file.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))} className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 shadow">
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function UploadProgressBar({ p }: { p: UploadProgress | null }) {
  if (!p) return null;
  const pct = Math.min(100, Math.round((p.done / p.total) * 100));
  return (
    <div className="space-y-1">
      <Progress value={pct} />
      <p className="text-xs text-muted-foreground">
        Đang tải {pct}%{p.current ? ` · ${p.current}` : ""} — đừng đóng trang
      </p>
    </div>
  );
}

export type TopicFileView = { id: string; kind: TopicFileKind; fileName: string; bytes: number; uploadedBy: string; createdAt: Date | string };

/** Khung ảnh / video trên trang topic: xem, thêm, gỡ. */
export function TopicFilesPanel({ topicId, files, canWrite }: { topicId: string; files: TopicFileView[]; canWrite: boolean }) {
  const [chon, setChon] = useState<File[]>([]);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);

  const taiLen = async () => {
    setBusy(true);
    try {
      const r = await uploadTopicFiles(topicId, chon, setProgress);
      if (r.ok) toast.success(`Đã đính kèm ${r.ok} tệp`);
      r.errors.forEach((e) => toast.error(e));
      setChon([]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const go = async (f: TopicFileView) => {
    if (!window.confirm(`Gỡ ${f.kind === "VIDEO" ? "video" : "ảnh"} “${f.fileName || f.id}” khỏi topic? Không lấy lại được.`)) return;
    const r = await removeTopicFile(f.id);
    if ("error" in r) toast.error(r.error);
    else toast.success("Đã gỡ tệp");
  };

  return (
    <div className="space-y-3">
      {files.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {files.map((f) => {
            const src = `/api/production/files/${f.id}`;
            return (
              <li key={f.id} className="overflow-hidden rounded-lg border text-xs">
                {f.kind === "VIDEO" ? (
                  <video src={src} controls preload="metadata" playsInline className="aspect-video w-full bg-black" />
                ) : (
                  <a href={src} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={f.fileName} loading="lazy" className="aspect-square w-full object-cover" />
                  </a>
                )}
                <div className="flex items-start justify-between gap-1 p-1.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={f.fileName}>
                      {f.fileName || "—"}
                    </div>
                    <div className="text-muted-foreground">
                      {formatMb(f.bytes)} · {f.uploadedBy || "—"} · {formatDateTime(f.createdAt)}
                    </div>
                  </div>
                  {canWrite ? (
                    <button type="button" aria-label="Gỡ tệp" onClick={() => go(f)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-rose-600">
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Chưa có ảnh / video nào.</p>
      )}
      {canWrite ? (
        <div className="space-y-2 border-t pt-3">
          <TopicFilePicker files={chon} onChange={setChon} disabled={busy} />
          <UploadProgressBar p={progress} />
          {chon.length ? (
            <div className="flex justify-end">
              <Button size="sm" onClick={taiLen} disabled={busy}>
                Tải lên {chon.length} tệp
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

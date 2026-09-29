"use client";

import { finishAdVideoUploadAction, startAdVideoUploadAction, uploadAdVideoChunkAction } from "@/lib/actions/creative-manual";
import { checkAdVideo } from "@/lib/constants/ad-video";

/**
 * Trình duyệt: đọc thông số video, trích MỘT khung hình làm ảnh bìa, tải video theo khúc 2 MB (bước 1 → 2 → 3 ở
 * `lib/creative/ad-video.ts`). Không lưu gì ở trình duyệt; đóng tab giữa chừng thì lượt tải dở tự bị dọn sau vài giờ.
 */

export type VideoMeta = { durationMs: number | null; width: number | null; height: number | null };

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error("Trình duyệt không đọc được video này — đổi sang MP4 (H.264) rồi tải lại."));
    v.src = url;
  });
}

export async function readVideoMeta(url: string): Promise<VideoMeta> {
  const v = await loadVideo(url);
  const ms = Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 1000) : null;
  return { durationMs: ms, width: v.videoWidth || null, height: v.videoHeight || null };
}

/** Khung hình ở giây `atSec` ⇒ tệp JPEG (đưa qua `thuNhoAnh` như ảnh mẫu tự làm). */
export async function grabFrame(url: string, atSec: number): Promise<File> {
  const v = await loadVideo(url);
  await new Promise<void>((resolve, reject) => {
    v.onseeked = () => resolve();
    v.onerror = () => reject(new Error("Không tua được tới khung hình đã chọn."));
    v.currentTime = Math.max(0, Math.min(atSec, Math.max(0, v.duration - 0.05)));
  });
  const canvas = document.createElement("canvas");
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  const g = canvas.getContext("2d");
  if (!g || !canvas.width || !canvas.height) throw new Error("Không vẽ được khung hình của video.");
  g.drawImage(v, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Không lấy được ảnh bìa từ video.");
  return new File([blob], "anh-bia.jpg", { type: "image/jpeg" });
}

/** Tải cả video theo khúc; mỗi khúc thử lại tối đa 3 lần (mạng chập chờn — gửi lại cùng khúc là ghi đè, vô hại). */
export async function uploadAdVideo(file: File, meta: VideoMeta, onProgress: (done: number, total: number) => void): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  const kiem = checkAdVideo({ contentType: file.type, bytes: file.size });
  if (!kiem.ok) return kiem;
  const s = await startAdVideoUploadAction({ contentType: file.type, bytes: file.size, ...meta });
  if ("error" in s) return { ok: false, error: s.error };
  onProgress(0, s.chunkCount);
  for (let seq = 0; seq < s.chunkCount; seq += 1) {
    let loi = "";
    for (let lan = 0; lan < 3; lan += 1) {
      const fd = new FormData();
      fd.set("assetId", s.assetId);
      fd.set("seq", String(seq));
      fd.set("chunk", file.slice(seq * s.chunkBytes, Math.min(file.size, (seq + 1) * s.chunkBytes)));
      const r = await uploadAdVideoChunkAction(fd).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      if (!("error" in r)) {
        loi = "";
        break;
      }
      loi = r.error;
    }
    if (loi) return { ok: false, error: `Tải khúc ${seq + 1}/${s.chunkCount} không được: ${loi}` };
    onProgress(seq + 1, s.chunkCount);
  }
  const f = await finishAdVideoUploadAction(s.assetId);
  if ("error" in f) return { ok: false, error: f.error };
  return { ok: true, assetId: f.assetId };
}

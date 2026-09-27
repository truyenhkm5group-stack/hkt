import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeProviderAllowed } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { fakeClipArgs, runTool } from "@/lib/video-scale/ffmpeg";
import { assertVideoPixelSafe, ProviderError, type ClipRequest, type PollResult, type VideoProvider } from "@/lib/video-scale/providers/types";

/**
 * ═══════════ BỘ SINH GIẢ — CHỈ NGOÀI PRODUCTION ═══════════
 *
 * Dựng clip từ CHÍNH ảnh gốc bằng ffmpeg (phóng chậm + âm câm) để chạy thử toàn luồng trên máy người viết mã mà không tốn
 * tiền Veo. Ranh giới 2: chỉ tồn tại khi `NODE_ENV !== 'production'` VÀ `VIDEO_PROVIDER_FAKE=1`; lượt chạy dùng nó mang
 * `is_test = true` ⇒ màn hình gắn nhãn "DỮ LIỆU THỬ", không đăng, không quảng cáo.
 */
export class FakeVideoProvider implements VideoProvider {
  readonly id = "FAKE" as const;

  private assertAllowed() {
    if (!fakeProviderAllowed(process.env.NODE_ENV, env.videoScale.fakeProviderFlag)) {
      throw new ProviderError("Bộ sinh giả chỉ chạy ngoài production với VIDEO_PROVIDER_FAKE=1.", "BLOCKED");
    }
  }

  async start(req: ClipRequest): Promise<{ ref: string }> {
    this.assertAllowed();
    assertVideoPixelSafe(req.image);
    const dir = await mkdtemp(path.join(tmpdir(), "vs-fake-"));
    const img = path.join(dir, "src.img");
    const out = path.join(dir, "clip.mp4");
    await writeFile(img, req.image.bytes);
    const r = await runTool(env.videoScale.ffmpegPath, fakeClipArgs(img, req.seconds, 720, 1280, out), { timeoutMs: 120_000 });
    if (r.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new ProviderError(`Bộ sinh giả hỏng: ${r.stderr.slice(-300)}`, "PERMANENT");
    }
    return { ref: `fake:${out}` };
  }

  async poll(ref: string): Promise<PollResult> {
    this.assertAllowed();
    return ref.startsWith("fake:") ? { state: "DONE", videoUri: ref.slice(5) } : { state: "FAILED", error: "Mã giả lạ.", kind: "PERMANENT" };
  }

  async download(videoUri: string): Promise<Uint8Array> {
    this.assertAllowed();
    const bytes = await readFile(videoUri);
    await rm(path.dirname(videoUri), { recursive: true, force: true });
    return new Uint8Array(bytes);
  }
}

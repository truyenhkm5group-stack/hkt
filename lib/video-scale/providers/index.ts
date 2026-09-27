import type { VideoProviderId } from "@/lib/constants/video-scale";
import { FakeVideoProvider } from "@/lib/video-scale/providers/fake";
import type { VideoProvider } from "@/lib/video-scale/providers/types";
import { VeoProvider } from "@/lib/video-scale/providers/veo";

/** Nhà cung cấp theo mã. Thêm Seedance = thêm một nhánh ở đây + một tệp adapter. */
export function videoProviderFor(id: VideoProviderId): VideoProvider {
  switch (id) {
    case "VEO":
      return new VeoProvider();
    case "FAKE":
      return new FakeVideoProvider();
  }
}

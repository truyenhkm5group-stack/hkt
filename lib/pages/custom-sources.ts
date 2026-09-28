/**
 * ═══════════ SỔ HIỆU LỰC CỦA TRANG ĐỘNG = SỔ TĨNH + ĐỐI TƯỢNG TUỲ BIẾN (Phase 6 · hợp đồng §7) — CHỈ MÁY CHỦ ═══════════
 *
 * `LIST_SOURCES` / `TIMELINE_SOURCES` (lib/pages/catalog.ts) là sổ TĨNH của đối tượng hệ thống và giữ nguyên. Đối tượng
 * tuỳ biến ACTIVE của TỔ CHỨC HIỆN HÀNH (`getDb()` — khoá `x_…` của tổ chức khác không tồn tại ở đây) được nối thêm mỗi
 * lượt gọi, không đệm trong tiến trình (M13): tạo / lưu trữ đối tượng có hiệu lực ở lượt kế tiếp của mọi tiến trình.
 *
 * Ba nơi dùng CÙNG một sổ hiệu lực: trình soạn (`listDataSources(user, catalog)`), kiểm schema khi lưu nháp / xuất bản /
 * xem trước (`validatePageSchema`, `customRefProblems`), và mẫu trang. Trình phân giải KHÔNG dựa vào sổ này cho đối tượng
 * tuỳ biến: mỗi lượt đọc tự đi qua cổng bản ghi (`recordGate` — tồn tại, chưa lưu trữ, module `apps` + nhóm menu, đủ khoá
 * `objectAccess(def).view`, phạm vi `CUSTOM_RECORDS`), vì sổ chỉ là lời khai, không phải ranh giới an ninh.
 *
 * Module của mục: `apps` khi mọi module đối tượng cần đang bật; không thì module ĐANG TẮT đầu tiên (nhóm menu) — để kiểm
 * schema nói đúng "bật module X" (cảnh báo lúc lưu nháp, chặn lúc xuất bản) thay vì một câu "không có trong sổ" sai sự
 * thật. Nhóm menu mang khoá module lạ ⇒ đối tượng không vào sổ (hỏng về phía hẹp).
 */
import { isModuleKey, type ModuleKey } from "@/lib/constants/platform-modules";
import { objectModuleOff } from "@/lib/metadata/common";
import { CUSTOM_OBJECTS_MODULE } from "@/lib/metadata/custom-object-def";
import { listCustomObjectDefs } from "@/lib/metadata/object-resolver";
import { customObjectListSource, customObjectTimelineSource } from "@/lib/pages/catalog";
import { defaultPageCatalog, type PageCatalog } from "@/lib/pages/components";

export async function effectivePageCatalog(base: PageCatalog = defaultPageCatalog()): Promise<PageCatalog> {
  const defs = await listCustomObjectDefs();
  if (defs.length === 0) return base;
  const lists = [...base.lists];
  const timelines = [...base.timelines];
  const objects = [...(base.objects ?? [])];
  for (const def of defs) {
    if (def.system || def.custom?.status !== "ACTIVE") continue;
    const off = await objectModuleOff(def);
    if (off !== null && !isModuleKey(off)) continue;
    const owner: ModuleKey = off === null ? CUSTOM_OBJECTS_MODULE : (off as ModuleKey);
    lists.push(customObjectListSource(def, owner));
    timelines.push(customObjectTimelineSource(def, owner));
    objects.push(def);
  }
  return { ...base, lists, timelines, objects };
}

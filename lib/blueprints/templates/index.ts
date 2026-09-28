/**
 * SỔ MẪU NGÀNH (Phase 7 · §4) — blueprint do nền tảng soạn sẵn. THUẦN, client-safe.
 *
 * Mẫu KHÔNG tự kích hoạt (luật 23): không mẫu nào được cài lúc cấp tổ chức, lúc deploy hay lúc mở màn hình — chỉ khi
 * người có quyền bấm «Cài» ở `/settings/templates` sau khi xem trước. Mẫu `manufacturing` và `service-business` dùng
 * đối tượng tuỳ biến (Phase 6) — module `apps` tự vào kế hoạch.
 */
import type { Blueprint } from "@/lib/blueprints/types";
import { FASHION_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/fashion-commerce";
import { GENERAL_ECOMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/general-ecommerce";
import { MANUFACTURING_BLUEPRINT } from "@/lib/blueprints/templates/manufacturing";
import { SERVICE_BUSINESS_BLUEPRINT } from "@/lib/blueprints/templates/service-business";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";

export const BLUEPRINT_TEMPLATES: readonly Blueprint[] = [FASHION_COMMERCE_BLUEPRINT, GENERAL_ECOMMERCE_BLUEPRINT, WHOLESALE_BLUEPRINT, MANUFACTURING_BLUEPRINT, SERVICE_BUSINESS_BLUEPRINT];

export function templateBlueprint(key: string): Blueprint | null {
  return BLUEPRINT_TEMPLATES.find((t) => t.key === key) ?? null;
}

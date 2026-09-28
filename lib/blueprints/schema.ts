/**
 * ═══════════ HÌNH DẠNG BLUEPRINT (zod) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Lớp thứ nhất của `validateBlueprint`: chỉ HÌNH (khoá, kiểu, độ dài, tập đóng). Tham chiếu chéo (field trỏ đối
 * tượng có thật, trang qua `validatePageSchema`, luật trỏ field trạng thái có trong gói, vai trò theo luật 31) là
 * lớp thứ hai ở `validate.ts` — tách ra để lỗi tham chiếu gắn đúng MỘT mục và kế hoạch đánh dấu đúng mục đó là
 * BỊ CHẶN, thay vì cả gói "sai hình".
 *
 * Mọi đối tượng là `strictObject`: khoá lạ bị từ chối. Một gói do AI soạn (Phase 8) mang thêm một khoá không ai
 * đọc là một lời hứa không ai giữ — thà từ chối rõ ràng còn hơn cài một phần im lặng.
 */
import { z } from "zod";
import { MODULE_KEYS } from "@/lib/constants/platform-modules";
import { formSchemaZ } from "@/lib/metadata/form-schema";
import { listViewSchemaZ } from "@/lib/metadata/list-schema";
import { FIELD_KEY_PATTERN, FIELD_TYPES } from "@/lib/metadata/types";
import { ROLE_ORDER } from "@/lib/constants/roles";
import { ACCESS_SCOPES } from "@/lib/constants/access-scope";
import { CARE_NOTE_PRESETS_MAX } from "@/lib/constants/care";
import { CARE_ACTION_KINDS } from "@/lib/constants/delivery-tower";
import { CUSTOM_OBJECT_ICONS } from "@/lib/objects/constants";
import {
  BLUEPRINT_FORMAT,
  BLUEPRINT_FORMAT_VERSION,
  BLUEPRINT_KEY_PATTERN,
  BLUEPRINT_ROLE_KEY_PATTERN,
  BLUEPRINT_VERSION_PATTERN,
  SAFE_SETTING_KEYS,
} from "@/lib/blueprints/types";

const text = (max: number) => z.string().trim().min(1).max(max);
const moduleKeyZ = z.enum(MODULE_KEYS);
const permissionKeyZ = z.string().regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/, "Khoá quyền phải dạng <nhóm>:<việc>");
const fieldKeyZ = z.string().regex(FIELD_KEY_PATTERN, "Khoá field: chữ thường không dấu, số, gạch dưới; 2–41 ký tự");
const objectKeyZ = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "Khoá đối tượng không hợp lệ");

const roleZ = z.strictObject({
  key: z.string().regex(BLUEPRINT_ROLE_KEY_PATTERN, "Khoá vai trò: chữ thường không dấu, số, gạch dưới"),
  label: text(100),
  description: z.string().trim().max(300).optional(),
  // Nền ADMIN không nằm trong hình: nền toàn quyền biến mọi giới hạn phía trên thành trang trí (luật 31).
  base: z.enum(ROLE_ORDER.filter((r) => r !== "ADMIN") as [string, ...string[]], { error: "Vai trò nền phải là vai trò hệ thống khác ADMIN" }),
  permissions: z.array(permissionKeyZ).max(200),
  defaultScope: z.enum(ACCESS_SCOPES).optional(),
});

const objectZ = z.strictObject({
  key: z.string().regex(/^x_[a-z][a-z0-9_]{1,40}$/, "Khoá đối tượng tuỳ biến phải bắt đầu bằng x_"),
  label: text(60),
  labelPlural: text(60),
  icon: z.enum(CUSTOM_OBJECT_ICONS, { error: "Biểu tượng không có trong bộ biểu tượng của đối tượng tuỳ biến" }),
  moduleKey: moduleKeyZ,
  titleLabel: text(40),
  description: z.string().trim().max(500).optional(),
  viewPermission: permissionKeyZ.optional(),
  writePermission: permissionKeyZ.optional(),
});

const optionZ = z.strictObject({
  value: text(100),
  label: text(100),
  color: z.string().max(30).optional(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

const fieldZ = z.strictObject({
  objectKey: objectKeyZ,
  key: fieldKeyZ,
  label: text(100),
  type: z.enum(FIELD_TYPES),
  options: z.array(optionZ).max(200).optional(),
  validation: z
    .strictObject({
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(1).optional(),
      pattern: z.string().max(200).optional(),
      patternMessage: z.string().max(200).optional(),
    })
    .optional(),
  transitions: z.record(z.string(), z.array(z.string()).max(200)).optional(),
  relation: z.strictObject({ objectKey: objectKeyZ, unique: z.boolean().optional() }).optional(),
  required: z.boolean().optional(),
  listable: z.boolean().optional(),
  filterable: z.boolean().optional(),
  helpText: z.string().trim().max(500).optional(),
});

const statusZ = z.strictObject({
  objectKey: objectKeyZ,
  field: fieldKeyZ,
  options: z
    .array(z.strictObject({ value: text(100), label: z.string().trim().max(60), color: z.string().max(30).optional(), position: z.number().int().min(0).max(1_000), active: z.boolean() }))
    .min(1)
    .max(200),
});

const formZ = z.strictObject({ objectKey: objectKeyZ, formKey: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), schema: formSchemaZ, publish: z.boolean().optional() });
const listZ = z.strictObject({ objectKey: objectKeyZ, listKey: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), schema: listViewSchemaZ, publish: z.boolean().optional() });

const navZ = z.strictObject({ enabled: z.boolean(), label: z.string().trim().max(60), zone: z.string().nullable(), order: z.number().int().min(0).max(999) });
const pageZ = z.strictObject({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/, "Đường dẫn trang: chữ thường, số, gạch nối"),
  name: text(120),
  moduleKey: moduleKeyZ,
  requiredPermission: permissionKeyZ.nullable().optional(),
  nav: navZ,
  // Nội dung trang kiểm bằng `validatePageSchema` (một câu trả lời cho "trang này hợp lệ không").
  schema: z.unknown(),
  publish: z.boolean().optional(),
});

const triggerZ = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), event: z.string().trim().min(3).max(80), objectKey: objectKeyZ.optional() }),
  z.strictObject({ kind: z.literal("custom_status"), objectKey: objectKeyZ, fieldKey: fieldKeyZ, to: z.array(text(100)).min(1).max(50), from: z.array(text(100)).max(50).optional() }),
]);

const actionZ = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create_task"),
    title: z.string().trim().min(2).max(200),
    summary: z.string().trim().max(2000).optional(),
    departmentCode: z.string().trim().max(40).optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
    dueInHours: z.number().int().min(1).max(24 * 365).optional(),
  }),
  z.strictObject({ kind: z.literal("notify"), message: text(500) }),
  z.strictObject({ kind: z.literal("set_custom_value"), field: fieldKeyZ, value: z.unknown() }),
]);

const workflowZ = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "Khoá luật: chữ thường không dấu, số, gạch dưới"),
  name: text(120),
  description: z.string().trim().max(1000).optional(),
  trigger: triggerZ,
  conditions: z.unknown().optional(),
  actions: z.array(actionZ).min(1).max(10),
  gate: z.strictObject({ kind: z.literal("approval"), reason: z.string().trim().min(3).max(300) }).nullable().optional(),
});

const settingZ = z.strictObject({ key: z.enum(SAFE_SETTING_KEYS, { error: "Khoá cài đặt không nằm trong danh sách an toàn" }), value: z.unknown() });
const integrationZ = z.strictObject({ connectorKey: moduleKeyZ, reason: text(300) });
const aiZ = z.strictObject({
  businessProfile: z.string().trim().min(10, "Hồ sơ doanh nghiệp tối thiểu 10 ký tự").max(4000),
  glossary: z.array(z.strictObject({ term: text(80), meaning: text(300) })).max(100).optional(),
});

export const blueprintZ = z.strictObject({
  format: z.literal(BLUEPRINT_FORMAT),
  formatVersion: z.literal(BLUEPRINT_FORMAT_VERSION),
  key: z.string().regex(BLUEPRINT_KEY_PATTERN, "Khoá gói: chữ thường, số, gạch nối; 2–41 ký tự"),
  version: z.string().regex(BLUEPRINT_VERSION_PATTERN, "Phiên bản gói phải dạng MAJOR.MINOR.PATCH"),
  name: text(120),
  description: z.string().trim().max(2000),
  industry: z.string().trim().max(80).nullable(),
  modules: z.array(moduleKeyZ).min(1).max(40),
  roles: z.array(roleZ).max(30).optional(),
  objects: z.array(objectZ).max(30).optional(),
  fields: z.array(fieldZ).max(300).optional(),
  statuses: z.array(statusZ).max(30).optional(),
  forms: z.array(formZ).max(30).optional(),
  listViews: z.array(listZ).max(30).optional(),
  pages: z.array(pageZ).max(30).optional(),
  workflows: z.array(workflowZ).max(50).optional(),
  settings: z.array(settingZ).max(20).optional(),
  integrations: z.array(integrationZ).max(20).optional(),
  ai: aiZ.optional(),
});

/** Giá trị của từng khoá cài đặt an toàn — hình của đúng thứ màn hình của khoá đó lưu. */
export const SAFE_SETTING_VALUE_Z = {
  "care.notePresets": z.strictObject({
    presets: z
      .array(z.strictObject({ id: z.string().min(1).max(40), kind: z.enum(CARE_ACTION_KINDS), text: z.string().trim().min(1).max(200) }))
      .max(CARE_NOTE_PRESETS_MAX),
  }),
} as const;

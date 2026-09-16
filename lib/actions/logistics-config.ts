"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import {
  DWELL_SLA,
  DWELL_SLA_SETTING_KEY,
  sanitizeDwellOverrides,
  type DwellOverrides,
} from "@/lib/constants/shipment-status-age";
import { DUPLICATE_SETTING_KEY, type DuplicateRule } from "@/lib/constants/order-duplicate";
import {
  FRESHNESS_BY_STAGE,
  FRESHNESS_HOURS_MAX,
  FRESHNESS_HOURS_MIN,
  FRESHNESS_KEY,
  sanitizeFreshness,
  type FreshnessOverrides,
} from "@/lib/constants/logistics-freshness";
import type { ShipmentStage } from "@/db/schema";

/**
 * ═══════════ CẤU HÌNH LUẬT GIAO VẬN & ĐƠN TRÙNG ═══════════
 *
 * KHÔNG dựng một hệ cấu hình thứ hai. Cả hai luật ghi vào bảng `settings` qua `setSettingJson`,
 * đúng đường mà `work.sla`, `work.ownership`, `payroll.config` và mọi cấu hình động khác đang đi.
 *
 * ─── QUYỀN `work:admin`, CÙNG MỘT CỬA VỚI HẠN XỬ LÝ CÔNG VIỆC ───
 *
 * Đổi một ngưỡng SLA là đổi con số mà cả đội bị chấm, và đổi cửa sổ dò trùng là đổi số đơn bị nghi.
 * Đây là cùng hạng quyết định với `setSlaRule` ở `lib/actions/work.ts`, nên dùng CÙNG một quyền —
 * không mở một cửa mới rộng hơn.
 *
 * ─── MỖI LẦN BẤM GỬI MỘT CHẶNG, KHÔNG GỬI CẢ BẢNG ───
 *
 * Gửi cả bảng thì hai người sửa hai ô khác nhau cùng lúc sẽ đè lên nhau. Cùng lý do đã ghi ở
 * `setSlaRule`.
 *
 * ─── GHI XONG PHẢI ĐỌC LẠI ĐƯỢC ───
 *
 * Giá trị ghi xuống đi qua `sanitizeDwellOverrides` TRƯỚC khi lưu, nên một bộ ngưỡng đảo thứ tự bị
 * từ chối NGAY LÚC BẤM kèm lời giải thích — thay vì được lưu rồi âm thầm bị bỏ qua lúc đọc, và
 * người sửa ngồi tự hỏi vì sao không thấy gì đổi.
 */
type Result = { ok: true } | { error: string };

async function authorize() {
  const user = await requireUser();
  if (!can(user, "work:admin")) return { user: null, error: "Không đủ quyền đổi cấu hình luật vận hành" as const };
  return { user, error: null };
}

function revalidate() {
  clearMemo();
  revalidatePath("/operations/dwell");
  revalidatePath("/shipments");
  revalidatePath("/operations/preship");
  revalidatePath("/work/settings");
}

/** Biên giống hệt bảng hạn công việc: 1 giờ tới 90 ngày. Không đặt một thang thứ hai. */
const gio = z.number().int().min(1).max(2160);

export async function setDwellThreshold(input: unknown): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z
    .object({
      stage: z.string().min(2),
      watch: gio.nullable(),
      warning: gio.nullable(),
      exception: gio.nullable(),
      /** `true` = trả chặng này về mặc định của mã, khác hẳn đặt cả ba mức thành `null`. */
      reset: z.boolean().optional(),
      /** `true` = CỐ Ý tắt hạn cho chặng này. Một quyết định có người ký, không phải bỏ trống. */
      disable: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: "Ngưỡng phải là số nguyên từ 1 tới 2160 giờ" };
  const d = parsed.data;

  if (!(d.stage in DWELL_SLA)) return { error: "Không có chặng vận đơn nào mang mã này" };
  const stage = d.stage as ShipmentStage;

  const hienTai = sanitizeDwellOverrides(await getSettingJson<unknown>(DWELL_SLA_SETTING_KEY, {}));
  const next: DwellOverrides = { ...hienTai };

  if (d.reset) {
    delete next[stage];
  } else if (d.disable) {
    next[stage] = null;
  } else {
    if (d.watch === null || d.warning === null || d.exception === null) {
      return { error: "Phải khai đủ ba mức — nửa bộ ngưỡng là bộ ngưỡng sai. Dùng nút “Tắt hạn” nếu muốn bỏ hẳn." };
    }
    if (!(d.watch <= d.warning && d.warning <= d.exception)) {
      return { error: "Ba mức phải tăng dần: để mắt ≤ cảnh báo ≤ ngoại lệ. Đảo thứ tự thì một kiện 10 giờ có thể đỏ hơn kiện 100 giờ." };
    }
    next[stage] = { watch: d.watch, warning: d.warning, exception: d.exception };
  }

  // Lọc lại LẦN NỮA trước khi lưu: thứ ghi xuống phải là thứ đọc lên được.
  const sach = sanitizeDwellOverrides(next);
  if (!d.reset && !d.disable && !sach[stage]) return { error: "Bộ ngưỡng này không hợp lệ nên không được lưu" };

  await setSettingJson(DWELL_SLA_SETTING_KEY, sach);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "LOGISTICS_DWELL_SLA_SET",
    entity: "SETTING",
    entityId: DWELL_SLA_SETTING_KEY,
    before: { [stage]: hienTai[stage] ?? null },
    after: { [stage]: sach[stage] ?? null },
    reason: `${SHIPMENT_STAGE_LABEL[stage]}${d.reset ? " — trả về mặc định" : d.disable ? " — tắt hạn" : ""}`,
  });
  revalidate();
  return { ok: true };
}

/**
 * CỬA SỔ DÒ ĐƠN TRÙNG.
 *
 * Tắt luật là một quyết định có hậu quả: hàng đợi rỗng, và màn hình phải nói rõ "đang tắt" chứ
 * không nói "sạch". Nên nó đi qua đúng đường ghi này và để lại dấu ở nhật ký.
 */
export async function setDuplicateRule(input: unknown): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z
    .object({
      // Trần 30 ngày: xa hơn thế thì mọi khách quay lại đều bị nghi trùng — số đo 15/09 cho thấy
      // phần lớn cặp cùng-SKU quá 7 ngày là mua lại, không phải trùng.
      windowHours: z.number().int().min(1).max(720),
      enabled: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: "Cửa sổ phải là số nguyên từ 1 tới 720 giờ" };

  const truoc = await getSettingJson<Partial<DuplicateRule>>(DUPLICATE_SETTING_KEY, {});
  await setSettingJson(DUPLICATE_SETTING_KEY, { windowHours: parsed.data.windowHours, enabled: parsed.data.enabled });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORDER_DUPLICATE_RULE_SET",
    entity: "SETTING",
    entityId: DUPLICATE_SETTING_KEY,
    before: truoc,
    after: parsed.data,
    reason: parsed.data.enabled ? `Cửa sổ ${parsed.data.windowHours} giờ` : "TẮT luật dò đơn trùng",
  });
  revalidate();
  return { ok: true };
}

/**
 * ═══════════ NGƯỠNG IM LẶNG THEO CHẶNG ═══════════
 *
 * ─── ĐÂY KHÔNG PHẢI CÁI ĐỒNG HỒ Ở TRÊN ───
 *
 * `setDwellThreshold` chỉnh TUỔI CHẶNG: "kiện đứng ở chặng hiện tại bao lâu rồi". Hàm này chỉnh ĐỘ
 * TƯƠI: "bao lâu rồi ERP không nghe tin gì về kiện này". Phân biệt đầy đủ ở đầu
 * `lib/constants/shipment-status-age.ts` — và nó có giá thật: 106 kiện chưa rời kho, 61 triệu COD,
 * mà 0/106 im lặng quá ngưỡng, vì ĐVVC vẫn đều đặn gửi "phân công bưu tá".
 *
 * Nên hai bộ ngưỡng là hai quyết định khác nhau, và gộp chúng lại sẽ làm một trong hai câu hỏi
 * không trả lời được nữa.
 *
 * Cùng quyền, cùng lối gửi-một-chặng, cùng lối lọc-trước-khi-lưu như `setDwellThreshold`.
 */
export async function setFreshnessThreshold(input: unknown): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const gioTuoi = z.number().int().min(FRESHNESS_HOURS_MIN).max(FRESHNESS_HOURS_MAX);
  const parsed = z
    .object({
      stage: z.string().min(2),
      aging: gioTuoi.optional(),
      stale: gioTuoi.optional(),
      critical: gioTuoi.optional(),
      /** `true` = trả chặng này về mặc định của mã. */
      reset: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { error: `Ngưỡng phải là số nguyên từ ${FRESHNESS_HOURS_MIN} tới ${FRESHNESS_HOURS_MAX} giờ` };
  const d = parsed.data;
  if (!FRESHNESS_BY_STAGE[d.stage]) return { error: "Không có chặng vận đơn nào mang mã này" };

  const hienTai = sanitizeFreshness(await getSettingJson<unknown>(FRESHNESS_KEY, {}));
  const next: FreshnessOverrides = { ...hienTai };
  if (d.reset) {
    delete next[d.stage];
  } else {
    if (d.aging === undefined || d.stale === undefined || d.critical === undefined) {
      return { error: "Phải khai đủ ba mức — nửa bộ ngưỡng là bộ ngưỡng sai." };
    }
    if (!(d.aging <= d.stale && d.stale <= d.critical)) {
      return { error: "Ba mức phải tăng dần: bắt đầu cũ ≤ cũ ≤ cũ nghiêm trọng. Đảo thứ tự thì một kiện nhảy thẳng sang “nghiêm trọng” trước khi kịp “bắt đầu cũ”." };
    }
    next[d.stage] = { aging: d.aging, stale: d.stale, critical: d.critical };
  }

  // Lọc lại LẦN NỮA trước khi lưu: thứ ghi xuống phải là thứ đọc lên được. Một bộ ngưỡng bị từ chối
  // lúc đọc mà vẫn nằm trong `settings` là người sửa ngồi tự hỏi vì sao không thấy gì đổi.
  const sach = sanitizeFreshness(next);
  if (!d.reset && !sach[d.stage]) return { error: "Bộ ngưỡng này không hợp lệ nên không được lưu" };

  await setSettingJson(FRESHNESS_KEY, sach);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "LOGISTICS_FRESHNESS_SET",
    entity: "SETTING",
    entityId: FRESHNESS_KEY,
    before: { [d.stage]: hienTai[d.stage] ?? null },
    after: { [d.stage]: sach[d.stage] ?? null },
    reason: `${SHIPMENT_STAGE_LABEL[d.stage as ShipmentStage] ?? d.stage}${d.reset ? " — trả về mặc định" : ""}`,
  });
  revalidate();
  return { ok: true };
}

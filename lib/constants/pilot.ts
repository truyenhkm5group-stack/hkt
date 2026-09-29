/**
 * ═══════════ VÒNG ĐỜI KHÁCH PILOT — HẰNG SỐ + LUẬT THUẦN (docs/platform/pilot-operations.md) ═══════════
 *
 * Client-safe: không import gì. Máy chủ (`lib/platform/pilot.ts`) đo SỰ KIỆN từ dữ liệu thật rồi đưa vào đây; tệp
 * này chỉ quyết "mục nào đạt" và "được chuyển giai đoạn không" — hàm thuần, chạy hai lần ra cùng kết quả.
 *
 * ─── GIAI ĐOẠN ≠ TRẠNG THÁI ───
 * `platform_organizations.status` trả lời "tổ chức có được chạy không" (SUSPENDED là công tắc khẩn). Giai đoạn trả lời
 * "khách đang ở bước nào của lượt nhận vào". Tắt khẩn KHÔNG đổi giai đoạn; chuyển giai đoạn KHÔNG bật / tắt gì.
 *
 * ─── DANH SÁCH KIỂM TÍNH TỪ DỮ LIỆU, KHÔNG PHẢI Ô ĐÁNH DẤU ───
 * Trừ «UAT đã xác nhận» (người vận hành bấm kèm ghi chú), mọi mục đọc từ CSDL của tổ chức / trạng thái sao lưu. Đo
 * không được ⇒ `UNKNOWN` — KHÔNG đạt (không kết luận được thì không cho qua), và không bao giờ in thành "0" (luật 42).
 */

export const PILOT_STAGES = ["CREATED", "CONFIGURING", "READY_FOR_UAT", "ACTIVE"] as const;
export type PilotStage = (typeof PILOT_STAGES)[number];

export const PILOT_STAGE_LABEL: Record<PilotStage, string> = {
  CREATED: "Vừa tạo",
  CONFIGURING: "Đang cấu hình",
  READY_FOR_UAT: "Sẵn sàng UAT",
  ACTIVE: "Đang dùng thật",
};

export const PILOT_STAGE_MEANING: Record<PilotStage, string> = {
  CREATED: "Đã có dòng tổ chức + CSDL; mẫu chưa cài xong.",
  CONFIGURING: "Mẫu đã cài, có quản trị — khách / người vận hành đang khai người dùng, module, trang, luật, kết nối.",
  READY_FOR_UAT: "Cấu hình đủ để khách chạy thử nghiệm thu (UAT) trên dữ liệu thật của họ.",
  ACTIVE: "Khách đã nghiệm thu và có bản sao lưu đêm — tổ chức đang vận hành thật.",
};

export function isPilotStage(v: unknown): v is PilotStage {
  return typeof v === "string" && (PILOT_STAGES as readonly string[]).includes(v);
}

/**
 * Số người dùng ĐANG HOẠT ĐỘNG tối thiểu để sang «Sẵn sàng UAT»: quản trị + ít nhất MỘT người làm việc thật. Một tổ
 * chức chỉ có tài khoản quản trị thì UAT chỉ chứng minh được màn hình của quản trị. Đây là điều kiện của cổng nhận
 * khách, không phải đích KPI (luật 38) — người vận hành ghi đè được, có lý do và nhật ký.
 */
export const PILOT_MIN_USERS = 2;

export const PILOT_CHECK_KEYS = ["TEMPLATE_INSTALLED", "ADMIN_PRESENT", "MODULES_CHOSEN", "USERS_MIN", "CONNECTIONS_READY", "PAGE_PUBLISHED", "RULES_ACTIVE", "BACKUP_FIRST", "UAT_CONFIRMED"] as const;
export type PilotCheckKey = (typeof PILOT_CHECK_KEYS)[number];

export const PILOT_CHECK_LABEL: Record<PilotCheckKey, string> = {
  TEMPLATE_INSTALLED: "Mẫu đã cài",
  ADMIN_PRESENT: "Có ít nhất một quản trị đang hoạt động",
  MODULES_CHOSEN: "Đã chọn module nghiệp vụ",
  USERS_MIN: `Có ít nhất ${PILOT_MIN_USERS} người dùng đang hoạt động`,
  CONNECTIONS_READY: "Kết nối mẫu gợi ý đã khai và kiểm đạt",
  PAGE_PUBLISHED: "Có trang đã xuất bản",
  RULES_ACTIVE: "Luật tự động đã bật (nếu có luật)",
  BACKUP_FIRST: "Đã có bản sao lưu đêm đầu tiên",
  UAT_CONFIRMED: "UAT đã được xác nhận",
};

/** Mục phải ĐẠT (hoặc không áp dụng) để VÀO giai đoạn đó. Tích luỹ: vào giai đoạn sau đòi cả mục của giai đoạn trước. */
export const PILOT_STAGE_REQUIRES: Record<PilotStage, readonly PilotCheckKey[]> = {
  CREATED: [],
  CONFIGURING: ["TEMPLATE_INSTALLED", "ADMIN_PRESENT"],
  READY_FOR_UAT: ["TEMPLATE_INSTALLED", "ADMIN_PRESENT", "MODULES_CHOSEN", "USERS_MIN", "CONNECTIONS_READY", "PAGE_PUBLISHED", "RULES_ACTIVE"],
  ACTIVE: ["TEMPLATE_INSTALLED", "ADMIN_PRESENT", "MODULES_CHOSEN", "USERS_MIN", "CONNECTIONS_READY", "PAGE_PUBLISHED", "RULES_ACTIVE", "BACKUP_FIRST", "UAT_CONFIRMED"],
};

/**
 * SỰ KIỆN đã đo. `null` = CHƯA ĐO ĐƯỢC (CSDL không mở được, thư mục sao lưu không mount…) — khác hẳn 0.
 * Không mang một dòng dữ liệu nghiệp vụ nào: chỉ số đếm và cờ.
 */
export type PilotFacts = {
  doneInstalls: number | null;
  activeAdmins: number | null;
  activeUsers: number | null;
  /** Module KHÔNG lõi đang bật. */
  nonCoreModules: number | null;
  /** Số connector mà mẫu đã cài gợi ý (`integrations` của blueprint). 0 ⇒ mục kết nối không áp dụng. */
  suggestedIntegrations: number | null;
  /** Số kết nối của tổ chức có lần kiểm gần nhất ĐẠT. */
  testedConnections: number | null;
  publishedPages: number | null;
  /** Luật chưa lưu trữ (nháp / bật / tạm dừng). 0 ⇒ mục luật không áp dụng. */
  liveRules: number | null;
  activeRules: number | null;
  /** Đã có bản sao lưu thành công của CSDL tổ chức. `null` = không đọc được trạng thái sao lưu. */
  backupSucceeded: boolean | null;
  uatConfirmed: boolean;
};

export type PilotCheckState = "PASS" | "FAIL" | "NOT_APPLICABLE" | "UNKNOWN";
export type PilotCheck = { key: PilotCheckKey; label: string; state: PilotCheckState; detail: string };

function measured(n: number | null, pass: (v: number) => boolean, detail: (v: number) => string, unknown: string): Pick<PilotCheck, "state" | "detail"> {
  if (n === null) return { state: "UNKNOWN", detail: unknown };
  return { state: pass(n) ? "PASS" : "FAIL", detail: detail(n) };
}

/** Chấm danh sách kiểm từ sự kiện đã đo. Thứ tự = `PILOT_CHECK_KEYS`. */
export function evaluatePilotChecklist(f: PilotFacts): PilotCheck[] {
  const out: Record<PilotCheckKey, Pick<PilotCheck, "state" | "detail">> = {
    TEMPLATE_INSTALLED: measured(f.doneInstalls, (v) => v > 0, (v) => `${v} lượt cài blueprint hoàn tất`, "Chưa đo được sổ cài blueprint."),
    ADMIN_PRESENT: measured(f.activeAdmins, (v) => v > 0, (v) => `${v} quản trị đang hoạt động`, "Chưa đo được bảng người dùng."),
    MODULES_CHOSEN: measured(f.nonCoreModules, (v) => v > 0, (v) => `${v} module nghiệp vụ (ngoài lõi) đang bật`, "Chưa đọc được cấu hình module."),
    USERS_MIN: measured(f.activeUsers, (v) => v >= PILOT_MIN_USERS, (v) => `${v}/${PILOT_MIN_USERS} người dùng đang hoạt động`, "Chưa đo được bảng người dùng."),
    CONNECTIONS_READY:
      f.suggestedIntegrations === 0
        ? { state: "NOT_APPLICABLE", detail: "Mẫu đã cài không gợi ý kết nối nào." }
        : f.suggestedIntegrations === null || f.testedConnections === null
          ? { state: "UNKNOWN", detail: "Chưa đọc được gợi ý kết nối của mẫu hoặc bảng kết nối." }
          : { state: f.testedConnections > 0 ? "PASS" : "FAIL", detail: `Mẫu gợi ý ${f.suggestedIntegrations} kết nối · ${f.testedConnections} kết nối đã kiểm đạt` },
    PAGE_PUBLISHED: measured(f.publishedPages, (v) => v > 0, (v) => `${v} trang đã xuất bản`, "Chưa đo được bảng trang."),
    RULES_ACTIVE:
      f.liveRules === 0
        ? { state: "NOT_APPLICABLE", detail: "Tổ chức chưa khai luật tự động nào." }
        : f.liveRules === null || f.activeRules === null
          ? { state: "UNKNOWN", detail: "Chưa đo được bảng luật." }
          : { state: f.activeRules > 0 ? "PASS" : "FAIL", detail: `${f.activeRules}/${f.liveRules} luật đang bật` },
    BACKUP_FIRST:
      f.backupSucceeded === null
        ? { state: "UNKNOWN", detail: "Không đọc được trạng thái sao lưu của máy này (thư mục chưa mount?) — không kết luận." }
        : { state: f.backupSucceeded ? "PASS" : "FAIL", detail: f.backupSucceeded ? "Đã có bản sao lưu thành công của CSDL tổ chức" : "Chưa có bản sao lưu thành công nào của CSDL tổ chức" },
    UAT_CONFIRMED: { state: f.uatConfirmed ? "PASS" : "FAIL", detail: f.uatConfirmed ? "Người vận hành đã xác nhận UAT" : "Chưa ai xác nhận UAT" },
  };
  return PILOT_CHECK_KEYS.map((key) => ({ key, label: PILOT_CHECK_LABEL[key], ...out[key] }));
}

/** Mục của giai đoạn `stage` chưa đạt (FAIL hoặc UNKNOWN — không đo được thì không cho qua). */
export function missingForStage(stage: PilotStage, checks: readonly PilotCheck[]): PilotCheck[] {
  const need = new Set(PILOT_STAGE_REQUIRES[stage]);
  return checks.filter((c) => need.has(c.key) && (c.state === "FAIL" || c.state === "UNKNOWN"));
}

/** Lý do ghi đè tối thiểu — dài hơn lý do thường vì nó là lời giải thích cho một cổng bị vượt. */
export const PILOT_OVERRIDE_MIN_REASON = 10;
export const PILOT_REASON_MIN = 5;

export type PilotTransitionVerdict =
  | { ok: true; direction: "FORWARD" | "BACKWARD" | "START" | "SAME"; override: boolean; missing: PilotCheck[] }
  | { ok: false; error: string; missing: PilotCheck[] };

/**
 * Được chuyển từ `from` sang `to` không. Luật:
 *  · `from = null` (không theo dõi) ⇒ chỉ bắt đầu được ở `CREATED`.
 *  · TIẾN đúng MỘT bậc; nhảy bậc bị từ chối kể cả khi ghi đè — mỗi cổng phải được nhìn một lần.
 *  · Tiến mà còn mục chưa đạt ⇒ chỉ qua khi `override` + lý do ≥ `PILOT_OVERRIDE_MIN_REASON` ký tự.
 *  · LÙI bậc luôn được, nhưng phải có lý do ≥ `PILOT_REASON_MIN` (người của tổ chức sẽ hỏi vì sao).
 */
export function planPilotTransition(input: { from: PilotStage | null; to: PilotStage; checks: readonly PilotCheck[]; override: boolean; reason: string }): PilotTransitionVerdict {
  const reason = input.reason.trim();
  const toIdx = PILOT_STAGES.indexOf(input.to);
  if (input.from === null) {
    if (input.to !== "CREATED") return { ok: false, error: "Tổ chức chưa được theo dõi vòng đời pilot — chỉ bắt đầu được ở «Vừa tạo».", missing: [] };
    if (reason.length < PILOT_REASON_MIN) return { ok: false, error: `Ghi lý do bắt đầu theo dõi (ít nhất ${PILOT_REASON_MIN} ký tự).`, missing: [] };
    return { ok: true, direction: "START", override: false, missing: [] };
  }
  const fromIdx = PILOT_STAGES.indexOf(input.from);
  if (toIdx === fromIdx) return { ok: true, direction: "SAME", override: false, missing: [] };
  if (toIdx < fromIdx) {
    if (reason.length < PILOT_REASON_MIN) return { ok: false, error: `Lùi giai đoạn cần lý do (ít nhất ${PILOT_REASON_MIN} ký tự).`, missing: [] };
    return { ok: true, direction: "BACKWARD", override: false, missing: [] };
  }
  if (toIdx > fromIdx + 1) return { ok: false, error: `Không nhảy giai đoạn: từ «${PILOT_STAGE_LABEL[input.from]}» chỉ sang được «${PILOT_STAGE_LABEL[PILOT_STAGES[fromIdx + 1]]}».`, missing: [] };
  const missing = missingForStage(input.to, input.checks);
  if (missing.length === 0) return { ok: true, direction: "FORWARD", override: false, missing };
  if (!input.override) return { ok: false, error: `Danh sách kiểm của «${PILOT_STAGE_LABEL[input.to]}» chưa đạt: ${missing.map((m) => m.label).join(" · ")}.`, missing };
  if (reason.length < PILOT_OVERRIDE_MIN_REASON) return { ok: false, error: `Ghi đè danh sách kiểm cần lý do (ít nhất ${PILOT_OVERRIDE_MIN_REASON} ký tự) — nó vào nhật ký nền tảng.`, missing };
  return { ok: true, direction: "FORWARD", override: true, missing };
}

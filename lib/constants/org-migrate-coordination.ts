/**
 * ═══════════ MỘT TỔ CHỨC, MỘT LƯỢT MIGRATE — TIẾN TRÌNH ĐẾN SAU CHỜ VÀ ĐỌC KẾT QUẢ THẬT (chủ shop 18/10/2026) ═══════════
 *
 * Sự cố (deploy 18/10/2026, CSDL `qa`): bước kiểm của deploy (`scripts/verify-migrations.ts`) MỞ từng tổ chức — mở = migrate — đúng lúc
 * ứng dụng vừa khởi động cũng mở (và migrate) chính tổ chức ấy. Cả hai lấy cùng khoá tư vấn của CSDL; bên thua chờ 120 giây rồi BÁO THỜI
 * GIAN CHỜ CỦA CHÍNH NÓ («Tiến trình khác đang migrate…») như thể đó là kết quả migrate của tổ chức, trong khi lượt THẬT đang chạy ở tiến
 * trình kia và không ai ghi lại nó kết thúc ra sao. Lần trước nữa bước kiểm thắng và tự chạy lượt 600 giây — nhãn kết quả phụ thuộc vào
 * AI THẮNG CUỘC ĐUA, không phụ thuộc vào migration.
 *
 * Luật thay thế (db/migrate.ts::coordinateOrgMigration):
 *  1. Ai cầm khoá tư vấn của CSDL thì là NGƯỜI ĐIỀU PHỐI DUY NHẤT của lượt ấy, và GHI trạng thái bền (`platform_org_migration_status`,
 *     CSDL nhà — mỗi tổ chức một dòng): RUNNING · ai (vai trò + pid + máy) · bắt đầu · HẠN tự khai · đích · mục còn thiếu; kết thúc thì
 *     DONE / DEGRADED / FAILED + lý do, ghi TRƯỚC khi nhả khoá. Hạn là thật: quá trần lượt thì người điều phối tự HUỶ câu đang chạy.
 *  2. Tiến trình thấy khoá bận KHÔNG mở lượt thứ hai: nó CHỜ lượt đang chạy tới hạn tự khai + biên, rồi đọc sổ migration và trạng thái —
 *     kết quả nó báo là kết quả của lượt kia, kèm tên người chạy. Lượt kia hỏng ⇒ không chạy lại ngay đúng câu vừa hỏng (lùi như mọi lỗi).
 *  3. Khoá đã nhả mà trạng thái còn RUNNING ⇒ người điều phối đã chết (khoá tư vấn gắn với phiên) ⇒ TIẾP QUẢN, ghi rõ lượt bị tiếp quản.
 *  4. Mọi chờ đều có trần hữu hạn. Ứng dụng (APP) không bắt request đứng chờ cả lượt: quá `orgMigrateLockWaitMs()` thì phục vụ tạm bằng
 *     lược đồ cũ (nếu sổ tương thích cho phép) và thử lại sau ít phút — vẫn KHÔNG chạy lượt thứ hai.
 *
 * Tệp này chỉ chứa phần THUẦN (kiểu, trần, quyết định, nhãn) để bài kiểm khoá được mà không cần Postgres.
 */

export const ORG_MIGRATE_STATES = ["RUNNING", "DONE", "DEGRADED", "FAILED"] as const;
export type OrgMigrateState = (typeof ORG_MIGRATE_STATES)[number];

/** Vai trò của tiến trình đang migrate: ứng dụng (Next.js), bước kiểm của deploy, hay một script vận hành. */
export const ORG_MIGRATE_ROLES = ["APP", "VERIFY", "SCRIPT"] as const;
export type OrgMigrateRole = (typeof ORG_MIGRATE_ROLES)[number];

/** `token` = mã ngẫu nhiên của tiến trình (sinh khi nạp mô-đun) — phân biệt một tiến trình mới với tiến trình cũ cùng pid + tên máy. */
export type OrgMigrateHolder = { role: OrgMigrateRole; osPid: number; host: string; token?: string };

/** Một dòng trạng thái đọc từ CSDL nhà. Mọi mốc là miligiây theo ĐỒNG HỒ CỦA CSDL; `dbNowMs` là `now()` của chính câu đọc. */
export type OrgMigrateStatus = {
  orgCode: string;
  runId: string;
  state: OrgMigrateState;
  holder: OrgMigrateHolder;
  startedAtMs: number;
  deadlineAtMs: number;
  finishedAtMs: number | null;
  targetTag: string | null;
  missing: string[];
  timedOut: boolean;
  reason: string | null;
  takeoverOf: string | null;
  dbNowMs: number;
};

function envMs(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const n = Number((env[name] || "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * TRẦN MỘT LƯỢT MIGRATE (mặc định 660 giây; ghi đè `ORG_MIGRATE_RUN_TIMEOUT_MS`). Phải LỚN HƠN trần câu lệnh lớn nhất mà một migration tự
 * khai (`SET LOCAL statement_timeout`, hôm nay 600 s ở 0245) — để câu ấy tự hỏng với lỗi chính xác của nó trước khi lượt bị huỷ; bài kiểm
 * quét drizzle/*.sql giữ bất biến này. Không phải «tăng trần cho qua»: trước đây lượt KHÔNG có trần nào cả.
 */
export const ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS = 660_000;
/** Sàn của trần lượt: một giá trị ghi đè gõ nhầm (vd «600» tưởng là giây) không được biến mọi lượt migrate thành tự huỷ sau 0,6 giây. */
export const ORG_MIGRATE_RUN_TIMEOUT_MIN_MS = 60_000;
export function orgMigrateRunTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return Math.max(ORG_MIGRATE_RUN_TIMEOUT_MIN_MS, envMs(env, "ORG_MIGRATE_RUN_TIMEOUT_MS", ORG_MIGRATE_RUN_TIMEOUT_DEFAULT_MS));
}

/** Biên sau hạn tự khai của người điều phối: đủ cho rollback + ghi trạng thái + nhả khoá sau lệnh huỷ. */
export const ORG_MIGRATE_HOLDER_MARGIN_MS = 30_000;

/** Nhịp hỏi lại khoá + trạng thái khi đang chờ người điều phối khác. */
export const ORG_MIGRATE_WAIT_POLL_MS = 1_000;

/** Vai trò của tiến trình: đặt tường minh (bước kiểm) > chạy trong Next.js (`NEXT_RUNTIME`) ⇒ APP > còn lại SCRIPT. HÀM THUẦN. */
export function orgMigrateRoleFrom(env: Record<string, string | undefined>, override?: OrgMigrateRole | null): OrgMigrateRole {
  if (override) return override;
  return (env.NEXT_RUNTIME || "").trim() ? "APP" : "SCRIPT";
}

/** «APP pid 123@erp-app» — đủ để tra log của đúng tiến trình, không mang bí mật / dữ liệu người. */
export function holderLabel(h: OrgMigrateHolder): string {
  return `${h.role} pid ${h.osPid}@${h.host || "?"}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Một dòng mô tả trạng thái cho người vận hành (bước kiểm deploy, trang /platform). HÀM THUẦN. */
export function describeOrgMigrateStatus(s: OrgMigrateStatus): string {
  const who = holderLabel(s.holder);
  const take = s.takeoverOf ? ` · tiếp quản lượt bỏ dở của ${s.takeoverOf}` : "";
  if (s.state === "RUNNING") {
    const elapsed = Math.max(0, (s.dbNowMs - s.startedAtMs) / 1000);
    const overdueS = (s.dbNowMs - s.deadlineAtMs - ORG_MIGRATE_HOLDER_MARGIN_MS) / 1000;
    if (overdueS > 0) {
      return `RUNNING QUÁ HẠN · ${who} · bắt đầu ${iso(s.startedAtMs)} · hạn ${iso(s.deadlineAtMs)} đã qua ${overdueS.toFixed(0)} giây (sau biên) — tiến trình có thể đã chết; tiến trình kế tiếp cầm được khoá sẽ tiếp quản · đích ${s.targetTag ?? "?"}${take}`;
    }
    return `RUNNING · ${who} · bắt đầu ${iso(s.startedAtMs)} (${elapsed.toFixed(1)} giây) · hạn ${iso(s.deadlineAtMs)} · đích ${s.targetTag ?? "?"}${take}`;
  }
  const dur = s.finishedAtMs !== null ? `${Math.max(0, (s.finishedAtMs - s.startedAtMs) / 1000).toFixed(1)} giây` : "?";
  const reason = s.reason ? ` · lý do: ${s.reason}` : "";
  const missing = s.state !== "DONE" && s.missing.length ? ` · thiếu ${s.missing.join(", ")}` : "";
  return `${s.state} · ${who} · bắt đầu ${iso(s.startedAtMs)} · ${dur}${missing}${reason}${take}`;
}

/**
 * Lúc khoá BẬN: chờ tiếp, hay thôi? HÀM THUẦN — đồng hồ của tiến trình (`localNowMs`, `waitStartedMs`) và đồng hồ của CSDL (mốc trong
 * `status`) không bao giờ bị trừ lẫn nhau: hạn của người điều phối được đổi sang đồng hồ tiến trình bằng KHOẢNG CÒN LẠI đo trên CSDL.
 *
 *  · người điều phối khai RUNNING ⇒ chờ tới hạn của họ + biên, không quá trần của chính mình (`ownCapMs`);
 *  · không biết ai giữ khoá (tiến trình không ghi được trạng thái) ⇒ chờ tới trần của chính mình;
 *  · APP chờ thêm một trần ngắn (`appCapMs`) — request không đứng chờ cả lượt migrate;
 *  · hết chờ: người điều phối còn trong hạn ⇒ `HOLDER_RUNNING` (lượt kia vẫn đang chạy hợp lệ — APP phục vụ tạm, thử lại sau); quá hạn
 *    tự khai mà vẫn giữ khoá, hoặc không rõ ai giữ ⇒ `OVERDUE`.
 */
export type BusyDecision = { kind: "WAIT" } | { kind: "HOLDER_RUNNING"; holderLimitMs: number } | { kind: "OVERDUE"; holderKnown: boolean };

export function decideWhileBusy(input: {
  status: OrgMigrateStatus | null;
  localNowMs: number;
  waitStartedMs: number;
  ownCapMs: number;
  appCapMs: number | null;
  marginMs?: number;
}): BusyDecision {
  const margin = input.marginMs ?? ORG_MIGRATE_HOLDER_MARGIN_MS;
  const running = input.status?.state === "RUNNING" ? input.status : null;
  const ownLimit = input.waitStartedMs + Math.max(0, input.ownCapMs);
  const holderLimit = running ? input.localNowMs + (running.deadlineAtMs + margin - running.dbNowMs) : null;
  let limit = Math.min(holderLimit ?? ownLimit, ownLimit);
  if (input.appCapMs !== null) limit = Math.min(limit, input.waitStartedMs + Math.max(0, input.appCapMs));
  if (input.localNowMs < limit) return { kind: "WAIT" };
  if (holderLimit !== null && input.localNowMs < holderLimit) return { kind: "HOLDER_RUNNING", holderLimitMs: holderLimit };
  return { kind: "OVERDUE", holderKnown: running !== null };
}

/**
 * Vừa CẦM được khoá: làm gì? HÀM THUẦN.
 *  · lượt của người khác đã KẾT THÚC TRONG LÚC mình đang gọi (`finishedAtMs >= sinceDbMs`, đồng hồ CSDL, `sinceDbMs` đọc TRƯỚC lần thử
 *    khoá đầu tiên), hoặc nằm trong `observed` (lượt mình đã thấy ở lần gọi trước của cùng tiến trình — lượt thử lại nền) ⇒
 *    NHẬN kết quả của nó (`ADOPT_OK` / `ADOPT_FAILURE`), không chạy lượt thứ hai — kể cả khi nó hỏng: chạy lại ngay là chạy lại đúng câu
 *    vừa hỏng (chính sách lùi quyết lúc nào thử lại).
 *    `ADOPT_OK` CHỈ khi sổ của CHÍNH mình đọc được và KHÔNG thiếu gì: DONE của người khác chỉ nói họ áp xong SỔ CỦA HỌ (deploy lẫn hai
 *    phiên bản: tiến trình cũ có sổ tới 0248, mã mới đã có 0249) — DONE mà mình vẫn thiếu / không đọc được sổ ⇒ đi tiếp như chưa nhận.
 *    Mỗi lượt trong `observed` chỉ được nhận MỘT lần — bên gọi bỏ nó khỏi tập sau khi đưa vào (db/index.ts::maybeRetryDegraded).
 *  · không còn gì thiếu (và đọc được sổ) ⇒ `NOTHING` (drizzle cũng chẳng làm gì).
 *  · khoá đã nhả mà dòng vẫn RUNNING ⇒ người điều phối chết giữa lượt ⇒ `TAKEOVER`.
 *  · lượt gần nhất của tiến trình KHÁC hỏng (FAILED / DEGRADED) cho CÙNG đích, kết thúc chưa quá `recentFailureWindowMs` (đồng hồ CSDL)
 *    ⇒ `BACKOFF`: lùi liên tiến trình — một tiến trình mới khởi động không chạy lại ngay đúng câu vừa hỏng ở tiến trình kia. Lượt của
 *    CHÍNH tiến trình này không tính: nhịp thử lại trong tiến trình đã do bên gọi quyết (lùi / DEGRADED).
 *  · còn lại ⇒ `RUN` (lượt thường, hoặc thử lại sau hạn lùi).
 */
export type AcquireDecision =
  | { kind: "ADOPT_OK"; status: OrgMigrateStatus }
  | { kind: "ADOPT_FAILURE"; status: OrgMigrateStatus }
  | { kind: "NOTHING" }
  | { kind: "TAKEOVER"; stale: OrgMigrateStatus }
  | { kind: "BACKOFF"; status: OrgMigrateStatus; retryAtDbMs: number }
  | { kind: "RUN" };

export function decideAfterAcquire(input: {
  status: OrgMigrateStatus | null;
  observed: ReadonlySet<string>;
  sinceDbMs: number | null;
  /** Mục còn thiếu theo sổ của CHÍNH mình; `null` = không đọc được sổ (CHƯA BIẾT — không bao giờ coi là «không thiếu»). */
  missing: readonly string[] | null;
  self: OrgMigrateHolder;
  targetTag: string | null;
  recentFailureWindowMs: number;
}): AcquireDecision {
  const s = input.status;
  const complete = input.missing !== null && input.missing.length === 0;
  const finishedDuringCall = s !== null && s.finishedAtMs !== null && input.sinceDbMs !== null && s.finishedAtMs >= input.sinceDbMs;
  if (s && s.state !== "RUNNING" && (input.observed.has(s.runId) || finishedDuringCall)) {
    if (complete) return { kind: "ADOPT_OK", status: s };
    if (s.state !== "DONE") return { kind: "ADOPT_FAILURE", status: s };
    // DONE nhưng sổ của mình vẫn thiếu / không đọc được ⇒ lượt kia áp sổ của NÓ; đi tiếp xuống dưới.
  }
  if (complete) return { kind: "NOTHING" };
  if (s && s.state === "RUNNING") return { kind: "TAKEOVER", stale: s };
  if (
    s &&
    (s.state === "FAILED" || s.state === "DEGRADED") &&
    s.finishedAtMs !== null &&
    !sameProcess(s.holder, input.self) &&
    s.targetTag === input.targetTag &&
    s.dbNowMs - s.finishedAtMs < input.recentFailureWindowMs
  ) {
    return { kind: "BACKOFF", status: s, retryAtDbMs: s.finishedAtMs + input.recentFailureWindowMs };
  }
  return { kind: "RUN" };
}

/**
 * Cùng một tiến trình? Có mã tiến trình ở cả hai phía ⇒ so mã (container khởi động lại giữ tên máy và thường cả pid). Thiếu mã (dòng cũ /
 * bài kiểm) ⇒ lùi về pid + tên máy. HÀM THUẦN.
 */
export function sameProcess(a: OrgMigrateHolder, b: OrgMigrateHolder): boolean {
  if (a.token && b.token) return a.token === b.token;
  return a.osPid === b.osPid && a.host === b.host;
}

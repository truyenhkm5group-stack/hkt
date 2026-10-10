import { createHash } from "node:crypto";
import {
  REGISTRY_MISSION_STATES,
  REGISTRY_PRIORITIES,
  REGISTRY_RISKS,
  type RegistryEntry,
  type RegistryEvidence,
  type RegistryHandoff,
  type RegistryMissionState,
  type RegistryNeedsOwner,
  type RegistryPriority,
  type RegistryRisk,
} from "@/lib/constants/tech-registry";

/**
 * ═══════════ ĐỌC SỔ TECH ROOM — HÀM THUẦN (không CSDL, không mạng) ═══════════
 *
 * Hình dạng lấy theo `validateEntry` của `scripts/ai-tech.ts`, nhưng KHÔNG import tệp đó vào ứng dụng: nó là
 * CLI 4.000 dòng kéo theo `child_process` và git. Bản đọc ở đây KHOAN DUNG hơn ở chỗ không làm hỏng việc chiếu
 * (một trường lạ thì bỏ trường đó), và CHẶT ở chỗ quyết định nghĩa: mã sứ mệnh, trạng thái, mốc phải đúng dạng,
 * không thì cả dòng bị loại và ĐẾM RIÊNG — không đoán.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MISSION_FILE_RE = /^mission\.([a-z0-9][a-z0-9-]{0,79})\.json$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Tên tệp sứ mệnh trong cây phẳng của sổ → mã sứ mệnh. Không phải tệp sứ mệnh ⇒ `null`. */
export function missionIdFromPath(path: string): string | null {
  const m = MISSION_FILE_RE.exec(path);
  return m ? m[1] : null;
}

export function parseRegistryMission(raw: unknown): { entry: RegistryEntry | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { entry: null, errors: ["dòng sổ không phải object"] };
  const id = str(raw.mission_id);
  if (!id || !SLUG_RE.test(id)) errors.push("mission_id sai dạng");
  const status = str(raw.status);
  if (!status || !(REGISTRY_MISSION_STATES as readonly string[]).includes(status)) errors.push(`status lạ: ${String(raw.status)}`);
  for (const k of ["created_at", "updated_at", "last_heartbeat"] as const) {
    const v = str(raw[k]);
    if (!v || !ISO_RE.test(v)) errors.push(`${k} không phải mốc ISO UTC`);
  }
  if (errors.length) return { entry: null, errors };

  const priority = (REGISTRY_PRIORITIES as readonly string[]).includes(String(raw.priority)) ? (raw.priority as RegistryPriority) : "P2";
  const risk = (REGISTRY_RISKS as readonly string[]).includes(String(raw.risk)) ? (raw.risk as RegistryRisk) : "MEDIUM";

  let needsOwner: RegistryNeedsOwner | null = null;
  if (isObj(raw.needs_owner) && str(raw.needs_owner.category) && str(raw.needs_owner.action)) {
    needsOwner = { category: raw.needs_owner.category as string, action: raw.needs_owner.action as string };
  }

  let evidence: RegistryEvidence | null = null;
  if (isObj(raw.evidence)) {
    const ev: RegistryEvidence = {};
    for (const k of ["merged", "deploy", "verify", "done"] as const) {
      const v = str(raw.evidence[k]);
      if (v !== null) ev[k] = v;
    }
    evidence = Object.keys(ev).length ? ev : null;
  }

  let handoff: RegistryHandoff | null = null;
  if (isObj(raw.handoff) && str(raw.handoff.branch) && str(raw.handoff.sha)) {
    const h = raw.handoff;
    handoff = {
      branch: h.branch as string,
      sha: h.sha as string,
      at: str(h.at) ?? "",
      actor: str(h.actor) ?? "",
      title: str(h.title) ?? "",
      summary: str(h.summary) ?? "",
      tests: strArr(h.tests),
    };
  }

  const prs = Array.isArray(raw.related_prs) ? raw.related_prs.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0) : [];

  return {
    entry: {
      missionId: id as string,
      title: str(raw.title) ?? "",
      businessGoal: str(raw.business_goal) ?? "",
      status: status as RegistryMissionState,
      priority,
      risk,
      owner: str(raw.owner) ?? "",
      worker: str(raw.worker),
      worktree: str(raw.worktree),
      branch: str(raw.branch),
      baseSha: str(raw.base_sha),
      ownedPaths: strArr(raw.owned_paths),
      dependencies: strArr(raw.dependencies),
      blockedBy: strArr(raw.blocked_by),
      relatedPrs: [...new Set(prs)],
      migrationReservations: strArr(raw.migration_reservations),
      definitionOfDone: strArr(raw.definition_of_done),
      createdAt: raw.created_at as string,
      updatedAt: raw.updated_at as string,
      lastHeartbeat: raw.last_heartbeat as string,
      needsOwner,
      evidence,
      handoff,
      intakeVerdict: isObj(raw.intake) ? str(raw.intake.verdict) : null,
    },
    errors,
  };
}

/** Đọc nội dung MỘT tệp sứ mệnh (chuỗi JSON). JSON hỏng ⇒ lỗi đọc được, không ném. */
export function parseRegistryMissionText(text: string): { entry: RegistryEntry | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { entry: null, errors: [`JSON hỏng: ${e instanceof Error ? e.message.slice(0, 120) : "?"}`] };
  }
  return parseRegistryMission(raw);
}

export type RegistryEventLine = {
  /** Khoá ổn định của dòng: băm nội dung + thứ tự xuất hiện của các dòng GIỐNG HỆT nhau trước nó. */
  lineKey: string;
  seq: number;
  at: Date;
  kind: string;
  actor: string;
  missionId: string;
  detail: string;
};

/**
 * `events.ndjson` → danh sách sự kiện. Khoá dòng KHÔNG dựa vào số dòng (sổ có thể được gọn lại), mà vào NỘI DUNG:
 * chạy lại bao nhiêu lần cũng ra cùng khoá ⇒ ghi `ON CONFLICT DO NOTHING` là idempotent. Dòng hỏng bị bỏ và đếm.
 */
export function parseRegistryEvents(text: string): { events: RegistryEventLine[]; invalid: number } {
  const events: RegistryEventLine[] = [];
  const seen = new Map<string, number>();
  let invalid = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    if (!isObj(raw) || !str(raw.at) || !ISO_RE.test(raw.at as string) || !str(raw.kind)) {
      invalid++;
      continue;
    }
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    events.push({
      lineKey: createHash("sha256").update(`${n}\u0000${line}`).digest("hex"),
      seq: i,
      at: new Date(raw.at as string),
      kind: (raw.kind as string).slice(0, 64),
      actor: (str(raw.actor) ?? "").slice(0, 200),
      missionId: (str(raw.mission) ?? "").slice(0, 80),
      detail: (str(raw.detail) ?? "").slice(0, 4000),
    });
  }
  return { events, invalid };
}

/** SHA của một blob theo đúng cách git tính — để biết nội dung đọc qua CDN có đúng phiên bản cây vừa liệt kê không. */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\u0000`).update(buf).digest("hex");
}

/**
 * ═══════════ TÁI DIỄN SAU BẢN SỬA — PHẦN CHẠM CSDL CỦA SỔ THEO DÕI (lib/constants/regression-watch.ts, 22/10/2026) ═══════════
 *
 * Chạy TRONG lượt 2B hằng ngày (lib/sales-quality/daily.ts), trên đúng tập hit mà lượt ấy vừa đếm — không quét lại, không gọi model.
 * Ghi duy nhất `notifications` (đường 2B hiện có: kind SALES_QUALITY ⇒ việc /work của phòng CS), khoá theo (mã, sứ mệnh):
 *  · lọt tới khách SAU `liveAt` mà chưa có việc ⇒ TẠO một việc + gửi MỘT tin qua kênh cảnh báo sẵn có;
 *  · việc đang mở ⇒ cập nhật số đếm, KHÔNG đẻ việc thứ hai, không gửi lại tin;
 *  · việc ĐÃ ĐÓNG mà lại lọt SAU lúc đóng ⇒ MỞ LẠI đúng việc ấy (xoá mốc đóng + mốc đã gửi) + gửi MỘT tin;
 *  · đã đóng và không có lọt mới sau lúc đóng ⇒ không đụng.
 * Không ném: lỗi trả về trong kết quả để lượt 2B ghi tiếp số đếm của ngày.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { deliverNotifications } from "@/lib/alerts/notification-delivery";
import {
  REGRESSION_WATCH,
  countAfterLive,
  regressionDedupeKey,
  regressionVerdict,
  reopenAction,
  watchAppliesTo,
  type RegressionVerdict,
  type RegressionWatchRow,
  type WatchHit,
} from "@/lib/constants/regression-watch";
import { SALES_QUALITY_SAMPLE_HASHES, SALES_QUALITY_SPEC, type SalesQualityCode } from "@/lib/constants/sales-quality";
import { conversationHash } from "@/lib/sales-quality/detectors";

export type RegressionRowResult = {
  mission: string;
  code: SalesQualityCode | null;
  leaked: number | null;
  blocked: number;
  verdict: RegressionVerdict;
  action: "CREATE" | "REFRESH" | "REOPEN" | "KEEP_CLOSED" | null;
};

/** Commit đang chạy trên máy chủ — `null` khi môi trường không khai (in «không đọc được», không đoán). */
export function runningSha(env: Record<string, string | undefined> = process.env): string | null {
  const direct = env.ERP_DEPLOY_SHA?.trim();
  if (direct && /^[0-9a-f]{7,40}$/.test(direct)) return direct;
  const tag = env.ERP_IMAGE?.split(":").pop()?.trim();
  return tag && /^[0-9a-f]{7,40}$/.test(tag) ? tag : null;
}

const vnTime = (iso: string | Date) => {
  const d = new Date(new Date(iso).getTime() + 7 * 3_600_000).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};

/** Chữ của việc tái diễn — số đếm, mã băm, SHA; không chữ tin, không tên, không SĐT. HÀM THUẦN. */
export function regressionText(row: RegressionWatchRow, code: SalesQualityCode, day: string, n: { hits: number; convs: readonly string[] }, blocked: number, sha: string | null): { title: string; body: string } {
  const spec = SALES_QUALITY_SPEC[code];
  const hashes = [...n.convs].map(conversationHash).sort().slice(0, SALES_QUALITY_SAMPLE_HASHES);
  return {
    title: `TÁI DIỄN sau bản sửa · ${spec.label}: ${n.hits} lần lọt tới khách / ${n.convs.length} hội thoại (ngày ${day.slice(8, 10)}/${day.slice(5, 7)}) — sứ mệnh ${row.mission}`,
    body:
      `Bản sửa ${row.mission} (PR #${row.pr}, ${row.sha.slice(0, 9)}) lên production lúc ${vnTime(row.liveAt)} (lượt deploy ${row.deployRun}); ` +
      `sau mốc đó vẫn có ${n.hits} lần ${code} lọt tới khách${row.leakMeasuredFrom ? ` (bộ dò lọt có từ ${vnTime(row.leakMeasuredFrom)} — đo lọt từ mốc ấy)` : ""}. Mã hội thoại băm (≤ ${SALES_QUALITY_SAMPLE_HASHES}): ${hashes.join(" ")}. ` +
      `Commit đang chạy: ${sha ?? "không đọc được"}.` +
      (row.blockedCodes.length ? ` Đã CHẶN trước khi gửi trong cùng kỳ: ${blocked} (bằng chứng hàng rào đang chạy — không phải tái diễn).` : "") +
      ` Việc cần làm: mở lại sứ mệnh ${row.mission}, tra hội thoại băm bằng ops conv-money-trace. Đóng việc này khi đã sửa — còn lọt sau lúc đóng thì việc TỰ MỞ LẠI.`,
  };
}

/** Áp sổ theo dõi lên tập hit của một lượt 2B. `db` của tổ chức NGỮ CẢNH. Không ném. */
export async function applyRegressionWatch(
  db: Db,
  input: { day: string; now: Date; hits: readonly WatchHit[]; orgCode: string | null },
  deps: { deliver?: (ids: { id: string; kind: string }[]) => Promise<void>; sha?: string | null } = {},
): Promise<{ rows: RegressionRowResult[]; regressions: number; error?: string }> {
  const rows: RegressionRowResult[] = [];
  const pushed: { id: string; kind: string }[] = [];
  let regressions = 0;
  try {
    const sha = deps.sha === undefined ? runningSha() : deps.sha;
    const n = schema.notifications;
    for (const row of REGRESSION_WATCH.filter((r) => watchAppliesTo(r, input.orgCode))) {
      const { leaked, blocked } = countAfterLive(row, input.hits);
      if (!row.leakCodes.length) {
        rows.push({ mission: row.mission, code: null, leaked: null, blocked, verdict: regressionVerdict(row, 0, blocked), action: null });
        continue;
      }
      for (const code of row.leakCodes) {
        const e = leaked.get(code);
        const hits = e?.hits ?? 0;
        regressions += hits;
        const verdict = regressionVerdict(row, hits, blocked);
        if (!e) {
          rows.push({ mission: row.mission, code, leaked: 0, blocked, verdict, action: null });
          continue;
        }
        const key = regressionDedupeKey(code, row.mission);
        const [existing] = await db.select({ id: n.id, resolvedAt: n.resolvedAt }).from(n).where(eq(n.dedupeKey, key)).limit(1);
        const action = reopenAction(existing ?? null, e.lastAt);
        const { title, body } = regressionText(row, code, input.day, { hits: e.hits, convs: [...e.convs] }, blocked, sha);
        if (action === "CREATE") {
          const ins = await db
            .insert(n)
            .values({ kind: "SALES_QUALITY", severity: "critical", title, body, href: "/ai/sales-chatbot/inbox", entityType: "SALES_QUALITY", entityId: `${code}:${row.mission}`, dedupeKey: key, occurredAt: input.now })
            .onConflictDoNothing({ target: n.dedupeKey })
            .returning({ id: n.id });
          for (const r of ins) pushed.push({ id: r.id, kind: "SALES_QUALITY" });
        } else if (action === "REFRESH") {
          await db.update(n).set({ title, body }).where(eq(n.dedupeKey, key));
        } else if (action === "REOPEN") {
          // Như luật mở lại việc tổng hợp của lib/alerts/rules.ts: việc chỉ xong khi hết thứ nó đếm. Xoá mốc gửi để kênh cảnh báo báo lại MỘT lần.
          const up = await db
            .update(n)
            .set({ title, body, severity: "critical", occurredAt: input.now, resolvedAt: null, resolvedBy: null, resolution: null, readBy: [], notifiedAt: null, notifyAttempts: null, notifyLastAttemptAt: null, notifyLastError: null })
            .where(eq(n.dedupeKey, key))
            .returning({ id: n.id });
          for (const r of up) pushed.push({ id: r.id, kind: "SALES_QUALITY" });
        }
        rows.push({ mission: row.mission, code, leaked: hits, blocked, verdict, action });
      }
    }
    if (pushed.length) {
      const deliver =
        deps.deliver ??
        (async (ids: { id: string; kind: string }[]) => {
          await deliverNotifications(db, await loadAlertConfig(), { created: ids, now: input.now });
        });
      await deliver(pushed).catch(() => undefined);
    }
    return { rows, regressions };
  } catch (e) {
    return { rows, regressions, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

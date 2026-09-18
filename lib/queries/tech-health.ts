import { desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { aiDisabledReason, MODEL_BY_TIER, resolveProviderName } from "@/lib/ai/router";
import { HEALTH_LABEL, getIntegrationHealth, type HealthState } from "@/lib/queries/integration-health";
import { runningVersion, type RunningVersion } from "@/lib/version";

/**
 * ───────────── SỨC KHOẺ HỆ THỐNG CHO PHÒNG TECH ─────────────
 *
 * ─── LUẬT SỐ MỘT: KHÔNG CÓ BẰNG CHỨNG THÌ KHÔNG ĐƯỢC NÓI "KHOẺ" ───
 *
 * Bốn mức dùng lại nguyên của `lib/queries/integration-health.ts` (`HEALTHY` · `DEGRADED` · `DOWN` ·
 * `UNKNOWN`) chứ không đặt bộ mới: hai thang đo cho cùng một câu hỏi là hai cách để chúng nói khác
 * nhau. `UNKNOWN` KHÔNG BAO GIỜ được hiển thị như một dạng nhẹ của `HEALTHY` — nó là "đi lấy dữ
 * liệu", còn `DEGRADED` là "đi sửa" (AGENTS.md mục 39).
 *
 * ─── KHÔNG NHÂN ĐÔI NGUỒN SỰ THẬT ───
 *
 * · Bốn kết nối ngoài đọc thẳng `getIntegrationHealth()` — trang Kết nối dữ liệu đã đo chúng, và
 *   đo lại bằng luật riêng là mời hai màn hình cãi nhau.
 * · Commit đang chạy đọc `lib/version.ts` — cùng chỗ `/api/health` đọc.
 * · Nhịp scheduler đọc `sync_runs`, là sổ mà chính scheduler ghi.
 *
 * Thứ DUY NHẤT tệp này tự đo là CSDL (một câu `select 1`), vì không ai khác đo nó.
 */

export type TechHealthSignal = {
  key: string;
  label: string;
  state: HealthState;
  /** Luôn phải nói được vì sao xếp vào mức đó. Một ô màu không có câu giải thích là một ô không sửa được. */
  reason: string;
  /** Số đo phụ hiện dưới nhãn (độ trễ, số lượt, tên bản). `null` = KHÔNG ÁP DỤNG. */
  detail?: string | null;
  /** Mốc của bằng chứng gần nhất. `null` = CHƯA CÓ bằng chứng nào — khác "vừa đo xong và thấy trống". */
  measuredAt: Date | null;
  /** Đường dẫn để đi xem chi tiết. Mọi con số phải truy ngược được. */
  href?: string;
};

export type TechSystemHealth = {
  /** Mốc dựng bảng này. Người đọc phải biết mình đang nhìn số của lúc nào. */
  checkedAt: Date;
  version: RunningVersion;
  signals: TechHealthSignal[];
  /** Mức xấu nhất trong các tín hiệu — KHÔNG phải trung bình. Một chỗ hỏng là hệ thống hỏng. */
  worst: HealthState;
};

const MUC_XAU_DAN: Record<HealthState, number> = { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };

/**
 * Mức tổng = mức XẤU NHẤT.
 *
 * Không lấy trung bình và không đếm phiếu: "sáu trên bảy đang khoẻ" là một câu đúng và vô dụng khi
 * cái thứ bảy là CSDL. Và `UNKNOWN` xếp TRÊN `HEALTHY` để một bảng toàn dấu hỏi không bao giờ hiện
 * ra thành màu xanh.
 */
export function worstHealth(states: HealthState[]): HealthState {
  return states.reduce<HealthState>((xau, s) => (MUC_XAU_DAN[s] > MUC_XAU_DAN[xau] ? s : xau), "HEALTHY");
}

/** Nhịp mong đợi của các job có lịch (`scripts/scheduler.mjs`). Quá ngưỡng ⇒ scheduler đã chết. */
const NHIP_JOB: { source: string; job: string; label: string; everyMinutes: number }[] = [
  { source: "PANCAKE", job: "orders_incremental", label: "Đơn Pancake", everyMinutes: 3 },
  { source: "VIETTELPOST", job: "tracking_poll", label: "Hành trình Viettel Post", everyMinutes: 10 },
];

/**
 * SCHEDULER CÓ ĐANG CHẠY KHÔNG.
 *
 * Câu hỏi này KHÔNG trả lời được bằng "có dữ liệu mới không" — shop không nhận đơn lúc 3 giờ sáng,
 * nên một giờ im lặng tự nó không nói gì (AGENTS.md mục 52). Thứ đo được là: job có lịch có ĐƯỢC
 * GỌI hay không, bất kể nó tìm thấy gì. `sync_runs` ghi mọi lượt gọi, kể cả lượt "0 đơn mới".
 *
 * Ngưỡng rộng rãi — gấp SÁU lần nhịp — vì mục đích là bắt "scheduler đã chết", không phải "lượt này
 * chạy trễ hai phút". Một cảnh báo kêu mỗi khi máy chủ bận là một cảnh báo người ta tắt đi.
 */
async function schedulerSignal(): Promise<TechHealthSignal> {
  const db = await getDb();
  const rows = await Promise.all(
    NHIP_JOB.map(async (j) => {
      const row = await db.query.syncRuns.findFirst({
        where: sql`${schema.syncRuns.source} = ${j.source} and ${schema.syncRuns.job} = ${j.job}`,
        orderBy: [desc(schema.syncRuns.startedAt)],
        columns: { startedAt: true, status: true },
      });
      return { ...j, lastAt: row?.startedAt ? new Date(row.startedAt) : null, status: row?.status ?? null };
    }),
  );

  const chuaChay = rows.filter((r) => !r.lastAt);
  const moiNhat = rows.map((r) => r.lastAt).filter((d): d is Date => Boolean(d));
  const measuredAt = moiNhat.length ? new Date(Math.max(...moiNhat.map((d) => d.getTime()))) : null;

  if (chuaChay.length === rows.length) {
    return {
      key: "scheduler",
      label: "Bộ chạy job theo lịch",
      state: "UNKNOWN",
      reason: "Chưa job có lịch nào từng chạy trên máy này — không đủ căn cứ để nói scheduler sống hay chết. (Bình thường với bản chạy thử / máy vừa dựng.)",
      measuredAt: null,
      href: "/integrations",
    };
  }

  const tre = rows.filter((r) => r.lastAt && Date.now() - r.lastAt.getTime() > r.everyMinutes * 6 * 60_000);
  const phut = (d: Date) => Math.floor((Date.now() - d.getTime()) / 60_000);
  if (tre.length) {
    return {
      key: "scheduler",
      label: "Bộ chạy job theo lịch",
      state: "DOWN",
      reason: `${tre.map((r) => `${r.label} lẽ ra ${r.everyMinutes} phút/lượt nhưng lượt gần nhất cách đây ${phut(r.lastAt as Date)} phút`).join(" · ")}. Container scheduler nhiều khả năng đã dừng.`,
      detail: `${rows.length - tre.length}/${rows.length} job còn đúng nhịp`,
      measuredAt,
      href: "/integrations",
    };
  }
  if (chuaChay.length) {
    return {
      key: "scheduler",
      label: "Bộ chạy job theo lịch",
      state: "DEGRADED",
      reason: `${chuaChay.map((r) => r.label).join(" · ")} chưa từng chạy, các job còn lại đúng nhịp.`,
      detail: `${rows.length - chuaChay.length}/${rows.length} job có lượt chạy`,
      measuredAt,
      href: "/integrations",
    };
  }
  return {
    key: "scheduler",
    label: "Bộ chạy job theo lịch",
    state: "HEALTHY",
    reason: `${rows.map((r) => `${r.label} cách đây ${phut(r.lastAt as Date)} phút`).join(" · ")} — đều trong nhịp.`,
    detail: `${rows.length}/${rows.length} job đúng nhịp`,
    measuredAt,
    href: "/integrations",
  };
}

/**
 * CSDL: đo thật bằng một câu `select 1`.
 *
 * Đây là tín hiệu duy nhất mà "trang này dựng được" đã gần như chứng minh. Vẫn đo, vì thứ cần biết
 * không phải "có kết nối không" mà là ĐỘ TRỄ: một CSDL trả lời sau 2 giây vẫn là "kết nối được" và
 * vẫn làm mọi màn hình không dùng nổi.
 */
async function databaseSignal(): Promise<TechHealthSignal> {
  const batDau = Date.now();
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    const ms = Date.now() - batDau;
    // 500ms cho một câu `select 1` là dấu hiệu máy chủ đang nghẽn, không phải một ngưỡng nghiệp vụ.
    const state: HealthState = ms > 500 ? "DEGRADED" : "HEALTHY";
    return {
      key: "database",
      label: "Cơ sở dữ liệu",
      state,
      reason: state === "HEALTHY" ? `Kết nối được, câu \`select 1\` mất ${ms} ms.` : `Kết nối được nhưng chậm bất thường: câu \`select 1\` mất ${ms} ms.`,
      detail: `${ms} ms`,
      measuredAt: new Date(),
    };
  } catch (error) {
    return {
      key: "database",
      label: "Cơ sở dữ liệu",
      state: "DOWN",
      reason: `Không truy vấn được: ${error instanceof Error ? error.message : String(error)}`,
      measuredAt: new Date(),
    };
  }
}

/**
 * NHÀ CUNG CẤP AI.
 *
 * KHÔNG gọi thử API ở đây. Một lượt gọi thật tốn tiền và tốn vài giây MỖI LẦN có người mở trang —
 * `/tech` sẽ thành thứ đắt nhất trong ERP. Cái đo được miễn phí là: đã cấu hình chưa, và lượt gọi
 * thật gần nhất (bảng `ai_interactions`) ra sao. Muốn thử kết nối thật thì bấm nút ở trang Kết nối
 * dữ liệu — một hành động của NGƯỜI, có chủ đích.
 */
async function aiSignal(): Promise<TechHealthSignal> {
  const provider = resolveProviderName();
  const lyDo = aiDisabledReason();
  if (!provider) {
    return {
      key: "ai",
      label: "Nhà cung cấp AI",
      state: "UNKNOWN",
      reason: lyDo ? `Chưa dùng được: ${lyDo}` : "Chưa cấu hình nhà cung cấp AI nào — không phải hỏng, là chưa bật.",
      measuredAt: null,
      href: "/integrations",
    };
  }

  const db = await getDb();
  const [row] = await db
    .select({
      lastAt: sql<Date | null>`max(${schema.aiInteractions.createdAt})`,
      loi24h: sql<number>`count(*) filter (where ${schema.aiInteractions.status} = 'ERROR' and ${schema.aiInteractions.createdAt} >= ${new Date(Date.now() - 24 * 3600_000)})`,
      luot24h: sql<number>`count(*) filter (where ${schema.aiInteractions.createdAt} >= ${new Date(Date.now() - 24 * 3600_000)})`,
    })
    .from(schema.aiInteractions);

  const lastAt = row?.lastAt ? new Date(row.lastAt) : null;
  const loi = Number(row?.loi24h ?? 0);
  const luot = Number(row?.luot24h ?? 0);
  const model = MODEL_BY_TIER[provider].copilot;

  if (!lastAt) {
    return {
      key: "ai",
      label: "Nhà cung cấp AI",
      state: "UNKNOWN",
      reason: `Đã cấu hình (${provider} · ${model}) nhưng CHƯA CÓ lượt gọi nào — không có bằng chứng nào để nói khoẻ hay hỏng.`,
      detail: provider,
      measuredAt: null,
      href: "/integrations",
    };
  }
  if (loi > 0 && loi === luot) {
    return { key: "ai", label: "Nhà cung cấp AI", state: "DOWN", reason: `Cả ${luot} lượt gọi trong 24 giờ qua đều lỗi.`, detail: provider, measuredAt: lastAt, href: "/integrations" };
  }
  if (loi > 0) {
    return { key: "ai", label: "Nhà cung cấp AI", state: "DEGRADED", reason: `${loi}/${luot} lượt gọi trong 24 giờ qua bị lỗi.`, detail: provider, measuredAt: lastAt, href: "/integrations" };
  }
  return {
    key: "ai",
    label: "Nhà cung cấp AI",
    state: "HEALTHY",
    reason: `${provider} · ${model} — ${luot} lượt trong 24 giờ, không lượt nào lỗi.`,
    detail: provider,
    measuredAt: lastAt,
    href: "/integrations",
  };
}

/**
 * ỨNG DỤNG ĐANG CHẠY BẢN NÀO.
 *
 * Trang này chạy BÊN TRONG tiến trình đó, nên "tiến trình sống" là hiển nhiên và không đáng nói.
 * Thứ đáng nói là: có biết mình đang chạy commit nào không. `ERP_COMMIT` rỗng nghĩa là bản này
 * không đối chiếu được với Git — không phải hỏng, nhưng cũng dứt khoát không phải khoẻ.
 */
function versionSignal(version: RunningVersion): TechHealthSignal {
  if (!version.commit) {
    return {
      key: "production",
      label: "Bản đang chạy",
      state: "UNKNOWN",
      reason: "Tiến trình sống (trang này dựng được) nhưng KHÔNG khai `ERP_COMMIT` — không đối chiếu được với Git. Bình thường khi chạy `npm run dev`; trên máy chủ thì nghĩa là lượt deploy chưa ghi biến môi trường.",
      measuredAt: new Date(),
    };
  }
  return {
    key: "production",
    label: "Bản đang chạy",
    state: "HEALTHY",
    reason: `Đang chạy commit ${version.commit.slice(0, 7)}${version.branch ? ` trên nhánh ${version.branch}` : ""}. Đây là lời khai của chính tiến trình đang dựng trang này, không phải của GitHub Actions.`,
    detail: version.commit.slice(0, 7),
    measuredAt: new Date(),
  };
}

export async function getTechSystemHealth(): Promise<TechSystemHealth> {
  const version = runningVersion();
  const [db, scheduler, ai, connectors] = await Promise.all([databaseSignal(), schedulerSignal(), aiSignal(), getIntegrationHealth()]);

  const ketNoi: TechHealthSignal[] = connectors.map((c) => ({
    key: `connector:${c.key}`,
    label: c.label,
    state: c.state,
    reason: c.reason,
    detail: c.lagHours === null ? null : `${HEALTH_LABEL[c.state]} · trễ ${c.lagHours} giờ`,
    measuredAt: c.lastEventAt,
    href: "/integrations",
  }));

  const signals = [versionSignal(version), db, scheduler, ...ketNoi, ai];
  return { checkedAt: new Date(), version, signals, worst: worstHealth(signals.map((s) => s.state)) };
}

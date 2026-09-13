import { and, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import {
  BACKTEST_MONTHS,
  BACKTEST_SNAPSHOT_OFFSETS_DAYS,
  backtestConfidenceOf,
  confidenceOf,
  isModelledSubstate,
  MODELLED_SUBSTATES,
  NOT_SHIPPED_STATE,
  PROJECTED_GTC_VERSION,
  projectedRateOf,
  summarizeBacktest,
  TRAINING_WINDOW,
  type BacktestStats,
  type ProbabilityBasis,
  type ProbabilityConfidence,
  type ProjectedState,
} from "@/lib/constants/projected-delivery";
import { CARRIER_HANDOFF_AT_SQL, FINAL_OUTCOME_AT_SQL, type TimeBasis } from "@/lib/constants/report-time-basis";
import { CARRIER_EVENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ XÁC SUẤT HỌC TỪ LỊCH SỬ THẬT, KHÔNG PHẢI TỪ MỘT CON SỐ AI ĐÓ GÕ VÀO ═══════════
 *
 * Xem `lib/constants/projected-delivery.ts` cho hợp đồng đầy đủ. Ba điều mà tệp này KHÔNG BAO GIỜ làm:
 *
 *  · đọc `shipments.stage` hay mã ĐVVC thô để kết luận "đã giao" / "hoàn" — chỉ `ORDER_OUTCOME`;
 *  · học từ kiện chưa đủ chín (xem `TRAINING_WINDOW`);
 *  · dự báo bằng một trạng thái cuối (xem `MODELLED_SUBSTATES`).
 */

const EVENT_SOURCES = sqlSourceList(CARRIER_EVENT_SOURCES);
const NGAY_MS = 86_400_000;

/** Trạng thái con của một SỰ KIỆN hành trình (không có `stage` để rơi về — sự kiện nói gì thì là nấy). */
const CON_SU_KIEN = carrierSubstateSql(sql`nullif(regexp_replace(e.status, '[^0-9]', '', 'g'), '')::int`, sql`e.status_name`, sql`null::text`);

/**
 * KIỆN ĐÃ KẾT THÚC theo `ORDER_OUTCOME`, kèm mốc ĐVVC nhận và mốc kết cục cuối.
 *
 * Dùng TÊN BẢNG ĐẦY ĐỦ vì `ORDER_OUTCOME` / `PRIMARY_ATTEMPT` / `CARRIER_HANDOFF_AT_SQL` đều phát ra
 * `"shipments"."…"` và `"orders"."…"`; đặt bí danh là hỏng với "missing FROM-clause entry".
 */
function kienDaKetThuc(dk: SQL[]): SQL {
  return sql`
    select "shipments"."id" as id,
           ${ORDER_OUTCOME_FAST} as outcome,
           ${sql.raw(CARRIER_HANDOFF_AT_SQL)} as handoff_at,
           ${sql.raw(FINAL_OUTCOME_AT_SQL)} as final_at
      from "shipments"
      join "orders" on "orders"."id" = "shipments"."order_id" and ${PRIMARY_ATTEMPT}
     where ${and(REPORTABLE_ORDER, ...dk)}
    offset 0`;
}

/* ═══════════════════ KHO DỮ LIỆU HỌC: TẢI MỘT LẦN, DÙNG CHO MỌI MỐC CẮT ═══════════════════ */

type LabelledShipment = { id: string; outcome: string; handoffAt: Date; finalAt: Date | null };
type CarrierEventLite = { at: Date; con: string };
type Corpus = {
  loadedAt: Date;
  /** Kiện có mốc ĐVVC nhận trong cửa sổ nhìn lại, nhãn theo ORDER_OUTCOME. */
  shipments: LabelledShipment[];
  /** Sự kiện ĐVVC của các kiện đó, mỗi kiện một danh sách TĂNG DẦN theo thời gian. */
  events: Map<string, CarrierEventLite[]>;
  /** Đơn chốt trong cửa sổ (cho P(chưa gửi)), nhãn theo ORDER_OUTCOME. */
  orders: { insertedAt: Date; outcome: string }[];
};

/**
 * ─── VÌ SAO TẢI MỘT LẦN ───
 *
 * Huấn luyện sống + thử ngược 3 tháng = 4 lần đo cửa sổ chín + 4 lần học + 3 lần chấm, và bản đầu
 * chạy mỗi lần một câu `kienDaKetThuc` (ORDER_OUTCOME + hai truy vấn con tương quan trên mọi kiện).
 * Đo bằng bench scale 4: câu đó chạy 7 lần, 5,9 giây — trang GTC tải lạnh từ 0,5 s lên 7 s.
 *
 * Nay: MỘT lần gán nhãn cho mọi kiện có mốc ĐVVC nhận trong cửa sổ nhìn lại (cửa sổ học + số tháng
 * thử ngược), MỘT lần kéo sự kiện của đúng các kiện đó, MỘT lần đọc đơn chốt; mọi mốc cắt sau đó
 * là phép lọc trong bộ nhớ. Kết quả từng mốc giống hệt SQL cũ: cùng nhãn, cùng điều kiện lọc.
 */
const CORPUS_LOOKBACK_DAYS = TRAINING_WINDOW.windowDays + BACKTEST_MONTHS * 31 + 7;
const EVENT_ID_CHUNK = 1000;

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function taiKho(): Promise<Corpus> {
  return memo(`projection-corpus:${PROJECTED_GTC_VERSION}:${CORPUS_LOOKBACK_DAYS}`, 600_000, async () => {
    const db = await getDb();
    const loadedAt = new Date();
    const since = new Date(loadedAt.getTime() - CORPUS_LOOKBACK_DAYS * NGAY_MS);
    const kien = rowsOf<{ id: string; outcome: string; handoff_at: unknown; final_at: unknown }>(
      await db.execute(kienDaKetThuc([sql`${sql.raw(CARRIER_HANDOFF_AT_SQL)} >= ${since}`])),
    );
    const shipments: LabelledShipment[] = [];
    for (const r of kien) {
      const handoffAt = toDate(r.handoff_at);
      if (!handoffAt) continue;
      shipments.push({ id: r.id, outcome: r.outcome, handoffAt, finalAt: toDate(r.final_at) });
    }
    const events = new Map<string, CarrierEventLite[]>();
    const ids = shipments.map((s) => s.id);
    for (let i = 0; i < ids.length; i += EVENT_ID_CHUNK) {
      const chunk = ids.slice(i, i + EVENT_ID_CHUNK);
      const rows = rowsOf<{ shipment_id: string; occurred_at: unknown; con: string }>(
        await db.execute(sql`
          select e.shipment_id, e.occurred_at, ${CON_SU_KIEN} as con
            from shipment_events e
           where e.source in (${sql.raw(EVENT_SOURCES)})
             and e.shipment_id in (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
           order by e.shipment_id, e.occurred_at
        `),
      );
      for (const r of rows) {
        const at = toDate(r.occurred_at);
        if (!at) continue;
        const list = events.get(r.shipment_id) ?? [];
        list.push({ at, con: r.con });
        events.set(r.shipment_id, list);
      }
    }
    const donRows = rowsOf<{ inserted_at: unknown; outcome: string }>(
      await db.execute(sql`
        select k.inserted_at, k.outcome
          from (
            select "orders"."inserted_at" as inserted_at, ${ORDER_OUTCOME_FAST} as outcome
              from "orders"
              left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
             where ${REPORTABLE_ORDER} and "orders"."inserted_at" >= ${since}
            offset 0
          ) k
         where k.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')
      `),
    );
    const orders = donRows.flatMap((r) => {
      const insertedAt = toDate(r.inserted_at);
      return insertedAt ? [{ insertedAt, outcome: r.outcome }] : [];
    });
    return { loadedAt, shipments, events, orders };
  });
}

/** `percentile_cont` của PostgreSQL: nội suy tuyến tính giữa hai phần tử kề nhau. */
function percentileCont(values: number[], q: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export type MaturityWindow = {
  /** Số ngày sau khi ĐVVC nhận để một kiện được coi là "đủ chín" để học. */
  maturityDays: number;
  /** `MEASURED` = phân vị đo từ đơn hoàn thật; `DEFAULT` = chưa đủ đơn hoàn để đo. */
  maturitySource: "MEASURED" | "DEFAULT";
  /** Số đơn hoàn đã dùng để đo phân vị. */
  returnedSample: number;
  windowDays: number;
  /** Chỉ học từ kiện ĐVVC nhận trong [trainedFrom, trainedUntil]. */
  trainedFrom: Date;
  trainedUntil: Date;
};

/**
 * H = phân vị 95 của "ĐVVC nhận → kết cục cuối" trên ĐƠN HOÀN — đo từ dữ liệu, chặn trần, có mặc
 * định khi thiếu mẫu. Xem `TRAINING_WINDOW` cho lý do.
 *
 * `cutoff` (thử ngược): chỉ nhìn dữ liệu có TRƯỚC mốc đó, như thể đang đứng ở ngày ấy.
 */
function doCuaSoChin(kho: Corpus, cutoff: Date | null): MaturityWindow {
  const moc = cutoff ?? kho.loadedAt;
  const tu = new Date(moc.getTime() - TRAINING_WINDOW.windowDays * NGAY_MS);
  const ngay: number[] = [];
  for (const k of kho.shipments) {
    if (k.handoffAt < tu || k.handoffAt > moc) continue;
    if (k.outcome !== "RETURNED" && k.outcome !== "RETURNED_BY_RULE") continue;
    if (!k.finalAt || k.finalAt < k.handoffAt) continue;
    if (cutoff && !(k.finalAt < cutoff)) continue;
    ngay.push((k.finalAt.getTime() - k.handoffAt.getTime()) / NGAY_MS);
  }
  const mau = ngay.length;
  const doDuoc = percentileCont(ngay, TRAINING_WINDOW.maturityQuantile);
  const duMau = mau >= TRAINING_WINDOW.minReturnedForMaturity && doDuoc !== null && Number.isFinite(doDuoc);
  const maturityDays = duMau ? Math.min(TRAINING_WINDOW.maturityCapDays, Math.max(1, Math.ceil(doDuoc))) : TRAINING_WINDOW.maturityDefaultDays;
  return {
    maturityDays,
    maturitySource: duMau ? "MEASURED" : "DEFAULT",
    returnedSample: mau,
    windowDays: TRAINING_WINDOW.windowDays,
    trainedFrom: tu,
    trainedUntil: new Date(moc.getTime() - maturityDays * NGAY_MS),
  };
}

export type StateProbability = {
  substate: ProjectedState;
  label: string;
  /** Số vận đơn TỪNG ở trạng thái này và ĐÃ có kết cục cuối (theo ORDER_OUTCOME). */
  sample: number;
  delivered: number;
  /** `null` khi mẫu bằng 0 — CHƯA ĐO ĐƯỢC, không phải 0%. */
  p: number | null;
  confidence: ProbabilityConfidence;
};

export type StateProbabilities = {
  version: string;
  states: StateProbability[];
  /** P(giao thành công │ đơn chốt nhưng chưa gửi) — chỉ dùng cho doanh thu cohort theo ngày chốt. */
  notShipped: StateProbability;
  totalSample: number;
  window: MaturityWindow;
};

/**
 * ─── VÌ SAO `distinct` LÀ PHẦN QUAN TRỌNG NHẤT CỦA CÂU LỆNH NÀY ───
 *
 * Một vận đơn "chờ phát lại" có thể sinh năm sự kiện: Viettel Post thử lại webhook tới 5 lần, và
 * ERP cũng nhận cùng trạng thái qua cả tra API lẫn nhập tệp. Đếm theo SỰ KIỆN nghĩa là để số lần
 * thử lại quyết định xác suất. Mỗi kiện gom trạng thái vào một `Set` — đúng vai của `distinct` cũ.
 *
 * ─── NHÃN LÀ `ORDER_OUTCOME`, KHÔNG PHẢI `stage` ───
 *
 * Bản V2 gán nhãn "giao được" = `stage = 'DELIVERED'` và "đã kết thúc" = `stage in (DELIVERED,
 * RETURNED)`. Hai lỗi đo được: (1) kiện 501 chiều hoàn / thu 30.000đ / thu 50K–100K là ĐƠN HOÀN theo
 * luật nhưng được dạy cho mô hình là "giao được"; (2) kiện 503 tiêu huỷ có `stage = CANCELLED` nên
 * biến mất khỏi mẫu số — mô hình không bao giờ thấy chúng hỏng. Nay nhãn đọc thẳng `ORDER_OUTCOME`.
 */
function hocXacSuat(kho: Corpus, cutoff: Date | null): StateProbabilities {
  const window = doCuaSoChin(kho, cutoff);
  const theoCon = new Map<string, { mau: number; giao: number }>();
  for (const k of kho.shipments) {
    if (k.handoffAt < window.trainedFrom || k.handoffAt > window.trainedUntil) continue;
    if (!FINISHED_SET.has(k.outcome)) continue;
    if (cutoff && !(k.finalAt && k.finalAt < cutoff)) continue;
    // MỘT vận đơn × MỘT trạng thái = MỘT quan sát, bất kể bao nhiêu sự kiện.
    const cons = new Set<string>();
    for (const e of kho.events.get(k.id) ?? []) {
      if (cutoff && !(e.at < cutoff)) continue;
      cons.add(e.con);
    }
    for (const con of cons) {
      const cur = theoCon.get(con) ?? { mau: 0, giao: 0 };
      cur.mau += 1;
      if (k.outcome === "DELIVERED") cur.giao += 1;
      theoCon.set(con, cur);
    }
  }
  const dong = (substate: ProjectedState, label: string, r: { mau: number; giao: number }): StateProbability => ({
    substate,
    label,
    sample: r.mau,
    delivered: r.giao,
    p: r.mau > 0 ? r.giao / r.mau : null,
    confidence: confidenceOf(r.mau),
  });
  const states = MODELLED_SUBSTATES.map((k) => dong(k, CARRIER_SUBSTATE_LABEL[k], theoCon.get(k) ?? { mau: 0, giao: 0 }));

  /*
    ĐƠN CHƯA GỬI: học từ đơn CHỐT trong cửa sổ và đã kết thúc, KỂ CẢ HUỶ — vì đơn chưa gửi vẫn có
    thể bị huỷ, và huỷ thì doanh thu bằng 0. Đây là trạng thái của DOANH THU, không vào tỷ lệ GTC.
  */
  let nsMau = 0;
  let nsGiao = 0;
  for (const o of kho.orders) {
    if (o.insertedAt < window.trainedFrom || o.insertedAt > window.trainedUntil) continue;
    nsMau += 1;
    if (o.outcome === "DELIVERED") nsGiao += 1;
  }
  const notShipped = dong(NOT_SHIPPED_STATE, "Chưa gửi ĐVVC", { mau: nsMau, giao: nsGiao });
  return { version: PROJECTED_GTC_VERSION, states, notShipped, totalSample: states.reduce((a, s) => a + s.sample, 0), window };
}

const FINISHED_SET = new Set(["DELIVERED", "RETURNED", "RETURNED_BY_RULE"]);

export async function getStateDeliveryProbabilities(): Promise<StateProbabilities> {
  return memo(`state-delivery-prob:${PROJECTED_GTC_VERSION}`, 600_000, async () => hocXacSuat(await taiKho(), null));
}

export type ProbabilityLookup = {
  version: string;
  /** Xác suất cho một trạng thái, kèm căn cứ và độ tin cậy. `p === null` ⇒ CHƯA ĐO ĐƯỢC. */
  of: (state: string) => { p: number | null; basis: ProbabilityBasis; confidence: ProbabilityConfidence; sample: number };
  states: StateProbability[];
  notShipped: StateProbability;
  window: MaturityWindow;
};

function dungBangTra(bang: StateProbabilities): ProbabilityLookup {
  const theo = new Map<string, StateProbability>(bang.states.map((s) => [s.substate, s]));
  theo.set(NOT_SHIPPED_STATE, bang.notShipped);
  return {
    version: bang.version,
    states: bang.states,
    notShipped: bang.notShipped,
    window: bang.window,
    of: (state) => {
      const s = theo.get(state);
      if (!s || s.p === null || s.confidence === "INSUFFICIENT_DATA") {
        /*
          TRẢ `null`, KHÔNG trả con số thô. Mẫu 3 kiện vẫn có một tỷ lệ (2/3) — nhưng một con số đoán
          in ra trông Y HỆT một con số đo được. `sample` vẫn trả về để màn hình nói "mới 3 ca".
        */
        return { p: null, basis: "NONE", confidence: s?.confidence ?? "INSUFFICIENT_DATA", sample: s?.sample ?? 0 };
      }
      return { p: s.p, basis: "GLOBAL_STATE", confidence: s.confidence, sample: s.sample };
    },
  };
}

/**
 * Bảng tra xác suất dùng chung cho MỌI báo cáo. Bậc lùi cố ý NGẮN và KHÔNG có bậc "mặc định": hết
 * bậc thì `null`, và nơi gọi phải in "chưa đo được".
 */
export async function getProbabilityLookup(): Promise<ProbabilityLookup> {
  return dungBangTra(await getStateDeliveryProbabilities());
}

/* ═══════════════════ THỬ NGƯỢC: MÔ HÌNH NÀY CÓ ĐÚNG KHÔNG ═══════════════════ */

export type BacktestByState = BacktestStats & { substate: ProjectedState; label: string };

export type ProjectionBacktest = {
  version: string;
  confidence: ProbabilityConfidence;
  overall: BacktestStats;
  byState: BacktestByState[];
  /** Tỷ lệ ảnh chụp mà mô hình dự báo được (%) — phần còn lại là trạng thái chưa đủ mẫu. */
  coverage: number | null;
  /** Số ảnh chụp có trạng thái không phải trạng thái cuối. */
  snapshots: number;
  /** Các tháng đã thử (YYYY-MM), mỗi tháng huấn luyện lại bằng dữ liệu TRƯỚC tháng đó. */
  months: string[];
  offsetsDays: readonly number[];
  maturityDays: number;
};

/**
 * ═══════════ KHÔNG CÔNG BỐ MỘT MÔ HÌNH CHƯA ĐƯỢC THỬ NGƯỢC ═══════════
 *
 * Bản V2 "thử" bằng cách lấy trạng thái có mẫu lớn nhất mà kiện TỪNG đi qua — kể cả `DELIVERED`
 * với P = 1 — rồi so với chính dữ liệu đã học. Đó là chấm bài bằng đáp án: sai số nhỏ giả.
 *
 * Nay:
 *  · TÁCH THEO THỜI GIAN: tháng M chỉ được chấm bằng mô hình học từ dữ liệu có KẾT CỤC TRƯỚC M.
 *  · CHỤP ẢNH ĐÚNG LÚC: với mỗi kiện đã kết thúc và mỗi mốc k ngày sau khi ĐVVC nhận, trạng thái
 *    là của sự kiện ĐVVC MỚI NHẤT có `occurred_at ≤ t`. Ảnh chụp sau mốc kết cục, hoặc rơi vào
 *    trạng thái cuối, bị loại — vì lúc đó không còn gì để dự báo.
 *  · CHỈ KIỆN ĐỦ CHÍN: kiện ĐVVC nhận chưa quá H ngày không được chấm, nếu không tập chấm chỉ gồm
 *    những kiện xong nhanh (giao được) và mô hình bị kết luận là "bi quan" oan.
 */
export async function getProjectionBacktest(): Promise<ProjectionBacktest> {
  return memo(`projection-backtest:${PROJECTED_GTC_VERSION}:${BACKTEST_MONTHS}:${BACKTEST_SNAPSHOT_OFFSETS_DAYS.join(",")}`, 600_000, async () => {
    const kho = await taiKho();
    const now = kho.loadedAt;
    const dauThang = (lui: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - lui, 1));
    const points: { shipmentId: string; p: number; y: 0 | 1; con: ProjectedState }[] = [];
    let snapshots = 0;
    const months: string[] = [];
    let maturityDays: number = TRAINING_WINDOW.maturityDefaultDays;

    for (let lui = BACKTEST_MONTHS - 1; lui >= 0; lui -= 1) {
      const tu = dauThang(lui);
      const den = dauThang(lui - 1);
      const moHinh = dungBangTra(hocXacSuat(kho, tu));
      maturityDays = moHinh.window.maturityDays;
      // Chỉ chấm kiện đã đủ chín tính tới HÔM NAY — nếu không, tập chấm nghiêng về kiện xong nhanh.
      const denChin = new Date(Math.min(den.getTime(), now.getTime() - moHinh.window.maturityDays * NGAY_MS));
      if (denChin.getTime() <= tu.getTime()) continue;
      months.push(`${tu.getUTCFullYear()}-${String(tu.getUTCMonth() + 1).padStart(2, "0")}`);
      for (const x of kho.shipments) {
        if (x.handoffAt < tu || !(x.handoffAt < denChin)) continue;
        if (!FINISHED_SET.has(x.outcome)) continue;
        const suKien = kho.events.get(x.id) ?? [];
        for (const kNgay of BACKTEST_SNAPSHOT_OFFSETS_DAYS) {
          const t = new Date(x.handoffAt.getTime() + kNgay * NGAY_MS);
          if (x.finalAt !== null && !(t < x.finalAt)) continue;
          // Trạng thái = sự kiện ĐVVC MỚI NHẤT có occurred_at ≤ t (danh sách đã tăng dần).
          let con: string | null = null;
          for (const e of suKien) {
            if (e.at <= t) con = e.con;
            else break;
          }
          // Chưa có sự kiện nào tới mốc t, hoặc đang ở trạng thái cuối ⇒ không có gì để dự báo.
          if (!con || !isModelledSubstate(con)) continue;
          snapshots += 1;
          const tra = moHinh.of(con);
          if (tra.p === null) continue;
          points.push({ shipmentId: x.id, p: tra.p, y: x.outcome === "DELIVERED" ? 1 : 0, con });
        }
      }
    }

    const overall = summarizeBacktest(points);
    const theoCon = new Map<ProjectedState, typeof points>();
    for (const x of points) {
      const list = theoCon.get(x.con) ?? [];
      list.push(x);
      theoCon.set(x.con, list);
    }
    const byState: BacktestByState[] = [...theoCon.entries()]
      .map(([substate, list]) => ({ substate, label: substate === NOT_SHIPPED_STATE ? "Chưa gửi ĐVVC" : CARRIER_SUBSTATE_LABEL[substate as CarrierSubstate], ...summarizeBacktest(list) }))
      .sort((a, b) => b.n - a.n);
    return {
      version: PROJECTED_GTC_VERSION,
      confidence: backtestConfidenceOf({ n: overall.n, bias: overall.bias, slope: overall.slope }),
      overall,
      byState,
      coverage: snapshots ? Math.round((points.length / snapshots) * 1000) / 10 : null,
      snapshots,
      months,
      offsetsDays: BACKTEST_SNAPSHOT_OFFSETS_DAYS,
      maturityDays,
    };
  });
}

/** Phần tóm tắt thử ngược gắn kèm mọi con số ước tính, để màn hình in nhãn tin cậy cạnh nó. */
export type BacktestSummary = Pick<ProjectionBacktest, "confidence" | "coverage" | "months"> & Pick<BacktestStats, "n" | "bias" | "brier" | "mae">;

/* ═══════════════════ CHỈ SỐ GIAO VẬN ƯỚC TÍNH — MỘT NGUỒN CHO MỌI BÁO CÁO ═══════════════════ */

export type ActiveBreakdown = Partial<Record<CarrierSubstate, number>>;

/**
 * ═══ GRAIN LÀ THAM SỐ, CÔNG THỨC THÌ KHÔNG ═══
 *
 * `PRODUCT` — gộp theo sản phẩm, khoá là `product_id` (đúng `coalesce(pv.product_id, order_items.
 *             product_id)` mà bảng lợi nhuận dùng); `code` là mã hàng để hiển thị.
 * `VARIANT` — gộp theo mẫu mã, ĐÚNG khoá `VARIANT_KEY` của bảng hiệu quả theo mã.
 */
export const PROJECTED_GRAINS = ["PRODUCT", "VARIANT"] as const;
export type ProjectedGrain = (typeof PROJECTED_GRAINS)[number];

export type ProjectedCounts = {
  /** Đơn đã bàn giao ĐVVC trong cohort = đã giao + không thành công + đang giao. Mẫu số của tỷ lệ. */
  eligibleSent: number;
  deliveredActual: number;
  failedActual: number;
  active: number;
  activeByState: ActiveBreakdown;
  /** Đơn đang giao mà mô hình KHÔNG dự báo được (trạng thái chưa đủ mẫu) — NGOÀI ước tính. */
  unmodelledActive: number;
  /** Đơn huỷ — không ở tử số lẫn mẫu số; đếm riêng để tổng đơn khớp trang khác. */
  cancelled: number;
  /** Đơn có vận đơn nhưng không một dấu vết ĐVVC nào (`UNKNOWN`) — ngoài cohort, đếm riêng. */
  unknown: number;
  /** Đơn chốt nhưng chưa gửi ĐVVC — chỉ có ở cohort theo ngày chốt; KHÔNG vào tỷ lệ GTC. */
  pending: number;
  pendingUnmodelled: number;
  /** Tỷ lệ GTC THỰC TẾ: chỉ trên đơn ĐÃ KẾT THÚC. `null` = chưa đơn nào kết thúc. */
  actualRate: number | null;
  /** Ước tính giao được = đã giao thật + Σ(đang ở trạng thái s × P(s)). */
  projectedDelivered: number;
  /** Xem `projectedRateOf`. `null` = CHƯA ĐO ĐƯỢC. */
  projectedRate: number | null;
  deliveredRevenueActual: number;
  /** DT GTC ước tính cân THEO TỪNG ĐƠN (đã giao + đang giao × P + chưa gửi × P(chưa gửi)). */
  projectedDeliveredRevenue: number;
  /** Doanh số của đơn NGOÀI ước tính (đang giao / chưa gửi ở trạng thái chưa đủ mẫu). */
  unmodelledRevenue: number;
  /** Giá vốn ước tính cân theo từng đơn, cùng cách với doanh thu. */
  projectedCogs: number;
  /** Số sản phẩm không biết giá vốn (không phiếu nhập, không giá Pancake) — giá vốn bị tính là 0. */
  cogsUnknownQty: number;
};

export type ProjectedProductRow = ProjectedCounts & {
  /** Khoá gộp: `product_id` (PRODUCT) hoặc `VARIANT_KEY` (VARIANT). */
  key: string;
  /** Mã hàng hiển thị (`products.custom_id`) hoặc chính khoá mẫu mã. */
  code: string;
  name: string;
};

export type ProjectedMetrics = {
  version: string;
  rows: ProjectedProductRow[];
  /** Đơn chưa lần được về mã hàng nào — CHƯA BIẾT, không gộp vào "mã khác". */
  unmappedOrders: number;
  /** Đơn thuộc nhiều mã: được cộng cho MỌI mã, nên tổng theo mã > tổng đơn thật. */
  multiCodeOrders: number;
  totalOrders: number;
  probabilities: StateProbability[];
  notShipped: StateProbability;
  window: MaturityWindow;
  /**
   * CON SỐ TOÀN SHOP TÍNH Ở GRAIN ĐƠN, không phải bằng cách cộng các dòng theo mã: đơn nhiều mã
   * được cộng cho mọi mã (mẫu số phình), đơn chưa lần được mã bị bỏ (mẫu số hụt). Ở đây mỗi đơn
   * đếm đúng một lần, kể cả đơn chưa lần được mã.
   */
  orderLevel: ProjectedCounts;
  /** Kết quả thử ngược của mô hình đang dùng — in cạnh mọi con số ước tính. `null` khi lỗi. */
  backtest: BacktestSummary | null;
  backtestError: string | null;
};

type Acc = ProjectedCounts;

function accMoi(): Acc {
  return {
    eligibleSent: 0,
    deliveredActual: 0,
    failedActual: 0,
    active: 0,
    activeByState: {},
    unmodelledActive: 0,
    cancelled: 0,
    unknown: 0,
    pending: 0,
    pendingUnmodelled: 0,
    actualRate: null,
    projectedDelivered: 0,
    projectedRate: null,
    deliveredRevenueActual: 0,
    projectedDeliveredRevenue: 0,
    unmodelledRevenue: 0,
    projectedCogs: 0,
    cogsUnknownQty: 0,
  };
}

/**
 * MỘT vòng cân cho MỌI grain. Phân loại theo `ORDER_OUTCOME` TRƯỚC; trạng thái con ĐVVC chỉ dùng để
 * chọn P(s) cho đơn `IN_TRANSIT`. Không có nhánh nào đọc `stage` hay mã ĐVVC để kết luận đã giao.
 */
function canMotDon(acc: Acc, don: { outcome: string; con: string; revenue: number; cogs: number; cogsUnknownQty: number }, lookup: ProbabilityLookup) {
  acc.cogsUnknownQty += don.cogsUnknownQty;
  switch (don.outcome) {
    case "DELIVERED":
      acc.eligibleSent += 1;
      acc.deliveredActual += 1;
      acc.projectedDelivered += 1;
      acc.deliveredRevenueActual += don.revenue;
      acc.projectedDeliveredRevenue += don.revenue;
      acc.projectedCogs += don.cogs;
      return;
    case "RETURNED":
    case "RETURNED_BY_RULE":
      acc.eligibleSent += 1;
      acc.failedActual += 1;
      return;
    case "CANCELLED":
      acc.cancelled += 1;
      return;
    case "UNKNOWN":
      acc.unknown += 1;
      return;
    case "NOT_SHIPPED": {
      acc.pending += 1;
      const tra = lookup.of(NOT_SHIPPED_STATE);
      if (tra.p === null) {
        acc.pendingUnmodelled += 1;
        acc.unmodelledRevenue += don.revenue;
      } else {
        acc.projectedDeliveredRevenue += don.revenue * tra.p;
        acc.projectedCogs += don.cogs * tra.p;
      }
      return;
    }
    default: {
      // IN_TRANSIT — trạng thái con quyết định P; trạng thái cuối / chưa đủ mẫu ⇒ ngoài ước tính.
      acc.eligibleSent += 1;
      acc.active += 1;
      const con = don.con as CarrierSubstate;
      acc.activeByState[con] = (acc.activeByState[con] ?? 0) + 1;
      const tra = isModelledSubstate(con) ? lookup.of(con) : null;
      if (!tra || tra.p === null) {
        acc.unmodelledActive += 1;
        acc.unmodelledRevenue += don.revenue;
      } else {
        acc.projectedDelivered += tra.p;
        acc.projectedDeliveredRevenue += don.revenue * tra.p;
        acc.projectedCogs += don.cogs * tra.p;
      }
    }
  }
}

function chotAcc(a: Acc): ProjectedCounts {
  const ketThuc = a.deliveredActual + a.failedActual;
  return {
    ...a,
    actualRate: ketThuc ? Math.round((a.deliveredActual / ketThuc) * 1000) / 10 : null,
    // KHÔNG làm tròn tử số: dòng gộp và bài kiểm tính lại tỷ lệ từ chính trường này, làm tròn ở đây
    // là để hai phép tính cùng một hàm ra hai số. Làm tròn là việc của màn hình.
    projectedDelivered: a.projectedDelivered,
    projectedRate: projectedRateOf(a),
    projectedDeliveredRevenue: Math.round(a.projectedDeliveredRevenue),
    unmodelledRevenue: Math.round(a.unmodelledRevenue),
    projectedCogs: Math.round(a.projectedCogs),
  };
}

/**
 * ═══════════ DOANH THU GTC ƯỚC TÍNH CÂN THEO TỪNG ĐƠN ═══════════
 *
 *     DT ước tính = DT các đơn ĐÃ GIAO + Σ(DT đơn đang chạy × P(trạng thái của nó))
 *                 + Σ(DT đơn chưa gửi × P(chưa gửi))            ← chỉ cohort theo ngày chốt
 *
 * Đơn ở trạng thái chưa đủ mẫu KHÔNG bị gán một xác suất đoán: nó nằm ngoài phần ước tính và được
 * đếm riêng (`unmodelledActive`, `unmodelledRevenue`).
 *
 * ─── MỐC COHORT LÀ THAM SỐ ───
 *   `SHIPPED` — "lô hàng GỬI ĐI trong khoảng này đã đi tới đâu" (bảng hiệu quả theo mã).
 *   `ORDERED` — "đơn CHỐT trong khoảng này sinh ra bao nhiêu tiền" (bảng lợi nhuận; gồm đơn chưa gửi).
 *   `OUTCOME` — "trong khoảng này chốt xong bao nhiêu ca".
 * Ba mốc dùng lại đúng ba biểu thức của `lib/constants/report-time-basis.ts`.
 *
 * ─── GRAIN ───
 * Đơn có nhiều mã: doanh thu chia theo `line_total` từng dòng hàng; SỐ ĐƠN cộng cho mọi mã (một đơn
 * hỏng thì cả hai mã đều bị ảnh hưởng), nên tổng theo mã > tổng đơn thật — `multiCodeOrders` nói ra.
 */
export async function getProjectedDeliveryMetrics(
  period: { from: Date | null; to: Date | null },
  basis: TimeBasis = "SHIPPED",
  grain: ProjectedGrain = "PRODUCT",
): Promise<ProjectedMetrics> {
  const key = `projected-metrics:${PROJECTED_GTC_VERSION}:${basis}:${grain}:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`;
  return memo(key, 90_000, async () => {
    const db = await getDb();
    const lookup = await getProbabilityLookup();
    const con = carrierSubstateSql(sql`"shipments"."vtp_status"`, sql`"shipments"."vtp_status_name"`, sql`"shipments"."stage"::text`);

    const MOC_THEO_BASIS: Record<TimeBasis, { expr: SQL; coTheRong: boolean }> = {
      ORDERED: { expr: sql`"orders"."inserted_at"`, coTheRong: false },
      SHIPPED: { expr: sql.raw(CARRIER_HANDOFF_AT_SQL), coTheRong: true },
      OUTCOME: { expr: sql.raw(FINAL_OUTCOME_AT_SQL), coTheRong: true },
    };
    const { expr: moc, coTheRong } = MOC_THEO_BASIS[basis];
    // CÙNG phạm vi đơn với trang hiệu quả theo mã và bảng lợi nhuận: đơn "Mới" chưa chốt không vào.
    const dk: SQL[] = [REPORTABLE_ORDER];
    if (period.from) dk.push(sql`${moc} >= ${period.from}`);
    if (period.to) dk.push(sql`${moc} <= ${period.to}`);
    if ((period.from || period.to) && coTheRong) dk.push(sql`${moc} is not null`);

    /*
      Khoá gộp phải là ĐÚNG biểu thức của bảng đích: `VARIANT_KEY` ở `return-rate.ts`, và
      `coalesce(pv.product_id, order_items.product_id)` ở `profit-nominal.ts`. Chép lệch một dấu
      nối thì hai bảng gộp ra hai tập dòng khác nhau.
    */
    const khoa =
      grain === "VARIANT"
        ? sql`coalesce("order_items"."variant_id", 'sku:' || "order_items"."sku" || '|' || "order_items"."product_name" || '|' || "order_items"."variation_detail")`
        : sql`coalesce("product_variants"."product_id", "order_items"."product_id")`;
    const ma = grain === "VARIANT" ? khoa : sql`coalesce("products"."custom_id", '')`;
    const ten = grain === "VARIANT" ? sql`coalesce(nullif("order_items"."sku", ''), "order_items"."product_name")` : sql`coalesce("products"."name", "order_items"."product_name")`;

    const rows = rowsOf<{ order_id: string; key: string | null; code: string | null; name: string | null; line_total: string | number; line_cogs: string | number; cogs_unknown_qty: string | number; order_total: string | number; outcome: string; con: string }>(
      await db.execute(sql`
        with don as (
          select "orders"."id" as order_id,
                 coalesce("orders"."total_price_after_discount", 0) as order_total,
                 ${con} as con,
                 ${ORDER_OUTCOME_FAST} as outcome
            from "orders"
            left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
           where ${and(...dk)}
          offset 0
        )
        select d.order_id, d.order_total, d.con, d.outcome,
               ${khoa} as key,
               ${ma} as code,
               ${ten} as name,
               coalesce(sum("order_items"."line_total"), 0) as line_total,
               coalesce(sum("order_items"."quantity" * ${LINE_UNIT_COST}), 0) as line_cogs,
               coalesce(sum("order_items"."quantity") filter (where ${LINE_UNIT_COST} = 0), 0) as cogs_unknown_qty
          from don d
          left join "order_items" on "order_items"."order_id" = d.order_id and "order_items"."is_bonus" = false
          left join "product_variants" on "product_variants"."id" = "order_items"."variant_id"
          left join "products" on "products"."id" = coalesce("product_variants"."product_id", "order_items"."product_id")
         group by d.order_id, d.order_total, d.con, d.outcome, ${khoa}, ${ma}, ${ten}
      `),
    );

    const theoMa = new Map<string, Acc & { key: string; code: string; name: string }>();
    const maCuaDon = new Map<string, Set<string>>();
    const donThieuMa = new Set<string>();
    // Mỗi đơn ĐÚNG MỘT dòng ở grain đơn: tất cả dòng-mã của cùng đơn mang cùng `con`/`outcome`/`order_total`.
    const donTheoId = new Map<string, { outcome: string; con: string; revenue: number; cogs: number; cogsUnknownQty: number }>();

    for (const r of rows) {
      const cogs = Number(r.line_cogs ?? 0);
      const cu = donTheoId.get(r.order_id) ?? { outcome: r.outcome, con: r.con, revenue: Number(r.order_total ?? 0), cogs: 0, cogsUnknownQty: 0 };
      cu.cogs += cogs;
      cu.cogsUnknownQty += Number(r.cogs_unknown_qty ?? 0);
      donTheoId.set(r.order_id, cu);

      const key = (r.key ?? "").trim();
      if (!key) {
        donThieuMa.add(r.order_id);
        continue;
      }
      const set = maCuaDon.get(r.order_id) ?? new Set<string>();
      set.add(key);
      maCuaDon.set(r.order_id, set);

      let row = theoMa.get(key);
      if (!row) {
        row = { ...accMoi(), key, code: (r.code ?? "").trim() || key, name: r.name ?? "" };
        theoMa.set(key, row);
      }
      // Doanh thu của mã trong đơn = tổng dòng hàng của mã đó; không có dòng nào thì lấy tiền đơn.
      const doanhThu = Number(r.line_total ?? 0) || Number(r.order_total ?? 0);
      canMotDon(row, { outcome: r.outcome, con: r.con, revenue: doanhThu, cogs, cogsUnknownQty: Number(r.cogs_unknown_qty ?? 0) }, lookup);
    }

    let multiCodeOrders = 0;
    for (const set of maCuaDon.values()) if (set.size > 1) multiCodeOrders += 1;
    // Chỉ là "chưa lần được mã" khi đơn KHÔNG có mã nào cả.
    let unmappedOrders = 0;
    for (const id of donThieuMa) if (!maCuaDon.has(id)) unmappedOrders += 1;

    // Cùng một vòng cân, chỉ đổi grain sang ĐƠN — không có công thức thứ hai ở đây.
    const mucDon = accMoi();
    for (const d of donTheoId.values()) canMotDon(mucDon, d, lookup);

    const ket: ProjectedProductRow[] = [...theoMa.values()].map((r) => ({ key: r.key, code: r.code, name: r.name, ...chotAcc(r) }));

    let backtest: BacktestSummary | null = null;
    let backtestError: string | null = null;
    try {
      const b = await getProjectionBacktest();
      backtest = { confidence: b.confidence, coverage: b.coverage, months: b.months, n: b.overall.n, bias: b.overall.bias, brier: b.overall.brier, mae: b.overall.mae };
    } catch (e) {
      // KHÔNG nuốt: lỗi thử ngược phải hiện ra là lỗi, không hiện ra là "chưa đủ dữ liệu".
      backtestError = e instanceof Error ? e.message : String(e);
    }

    return {
      version: lookup.version,
      rows: ket.sort((a, b) => b.eligibleSent - a.eligibleSent || a.code.localeCompare(b.code)),
      unmappedOrders,
      multiCodeOrders,
      totalOrders: maCuaDon.size + unmappedOrders,
      probabilities: lookup.states,
      notShipped: lookup.notShipped,
      window: lookup.window,
      orderLevel: chotAcc(mucDon),
      backtest,
      backtestError,
    };
  });
}

import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { NOT_CARE_CONDITION } from "@/lib/care/lifecycle";
import { rowsOf } from "@/lib/sql-rows";
import { TIMING_MIN_SAMPLE } from "@/lib/constants/care-timing";
import { CARE_OUTCOMES, OUTCOME_IS_FINAL, rescueRates, type CareOutcome, type RescueCounts } from "@/lib/constants/care-outcome";
import type { Period } from "@/lib/search-params";
import type { ShipmentStage } from "@/db/schema";
import { diagnosePending, type PendingDiagnosis, type QueueView } from "@/lib/care/pending-diagnosis";
import { getCareQueue } from "@/lib/queries/care-workbench";

/**
 * ═══════════ TỶ LỆ CỨU ĐƠN, HIỆU SUẤT NGƯỜI, HIỆU SUẤT MÃ HÀNG ═══════════
 *
 * ─── MỘT CA MỘT KẾT QUẢ, KHÔNG NHIỀU HƠN ───
 *
 * Grain của mọi con số ở đây là **ĐỢT CHĂM SÓC** (`shipment_care`, một dòng một đợt). Không phải
 * sự kiện ĐVVC, không phải thao tác, không phải ghi chú, không phải dòng hàng. Nhờ vậy:
 *   · một kiện có 15 sự kiện hành trình vẫn chỉ một kết quả;
 *   · một ca có 6 thao tác của 2 người vẫn chỉ một kết quả;
 *   · một đơn có 3 mã hàng vẫn chỉ một kết quả (báo cáo theo mã cộng ca đó cho CẢ BA mã và nói rõ
 *     điều đó — xem `soCaNhieuMa`).
 *
 * ─── MỐC THỜI GIAN THEO ĐÚNG CÂU HỎI ───
 *
 *   khối lượng việc  → `opened_at`  ("kỳ này có bao nhiêu ca mới")
 *   hiệu suất người  → `outcome_at` ("kỳ này chốt xong bao nhiêu ca")
 *
 * Hai câu khác nhau nên hai mốc khác nhau. Một ca mở tháng trước và chốt tháng này thuộc khối
 * lượng của tháng trước nhưng thuộc hiệu suất của tháng này — và đó là điều đúng.
 *
 * ─── PENDING NGOÀI CẢ TỬ SỐ LẪN MẪU SỐ ───
 *
 * Ca chưa có kết cục thì CHƯA BIẾT cứu được hay không. Đẩy vào mẫu số là ép một câu trả lời chưa
 * tồn tại thành "chưa cứu được", và tỷ lệ tụt xuống chỉ vì hôm nay có nhiều ca mới. Số ca PENDING
 * luôn được trả về cạnh tỷ lệ để người đọc biết phần chưa biết lớn tới đâu.
 *
 * ─── "CHƯA CÓ KẾT QUẢ" ĐẾM TẠI THỜI ĐIỂM CUỐI KỲ ───
 *
 * Ca treo không có `outcome_at`, nên lọc theo cột đó thì với BẤT KỲ kỳ nào thẻ "Chưa có kết quả"
 * cũng ra 0 và cảnh báo thiếu chứng cứ không bao giờ hiện — đúng lỗi của bản trước. Câu hỏi đúng
 * là "tính tới cuối kỳ, bao nhiêu ca đã mở mà chưa chốt": `opened_at <= cuối kỳ` và (`outcome_at`
 * rỗng hoặc sau cuối kỳ). Đợt máy đóng vì `NOT_CARE_CONDITION` không bao giờ vào đây.
 */

const sc = schema.shipmentCare;

function roCounts(): RescueCounts {
  return { direct: 0, exchange: 0, failed: 0, pending: 0, unattributed: 0 };
}

function cong(c: RescueCounts, outcome: string | null, n: number) {
  const key: CareOutcome = (CARE_OUTCOMES as readonly string[]).includes(outcome ?? "") ? (outcome as CareOutcome) : "UNATTRIBUTED";
  if (key === "RESCUED_DIRECT") c.direct += n;
  else if (key === "RESCUED_EXCHANGE") c.exchange += n;
  else if (key === "RESCUE_FAILED") c.failed += n;
  else if (key === "PENDING") c.pending += n;
  else c.unattributed += n;
}

export type RescueSummary = RescueCounts & {
  total: number;
  directRate: number | null;
  rateWithExchange: number | null;
  finished: number;
  /** Ca mở trong kỳ — trả lời câu hỏi KHỐI LƯỢNG, khác hẳn con số hiệu suất. */
  openedInPeriod: number;
};

/** Kỳ áp lên mốc nào. Hai câu hỏi khác nhau nên UI phải nói rõ đang đọc cái nào. */
export type CareTimeBasis = "OPENED" | "OUTCOME";

function trongKy(basis: CareTimeBasis, period: Period) {
  const cot = basis === "OPENED" ? sc.openedAt : sc.outcomeAt;
  return [period.from ? gte(cot, period.from) : undefined, period.to ? lte(cot, period.to) : undefined].filter(Boolean);
}

/**
 * ═══════════ DUNG SAI THỨ TỰ GHI ═══════════
 *
 * Khi người mở ca bằng tay, `opened_at` và `first_response_at` được ghi trong CÙNG một thao tác,
 * nên thứ tự giữa chúng là ngẫu nhiên ở mức mili giây. Đo production 18/09/2026: 36 đợt có mốc
 * phản hồi sớm hơn mốc mở ca, và chênh lệch âm SÂU NHẤT trong cả 36 là dưới 30 giây.
 *
 * Đây KHÔNG phải một ngưỡng nghiệp vụ (mục 7) — nó không đổi kết luận về bất kỳ đơn hàng nào, chỉ
 * nói "hai mốc ghi cùng lúc thì coi là 0 phút". Một phút là rộng gấp đôi chênh lệch lớn nhất quan
 * sát được, và vẫn hẹp hơn mọi khoảng thời gian phản hồi có nghĩa.
 */
const CLOCK_SKEW_TOLERANCE_MIN = 1;

/** Mốc dùng được: có thật, và không sớm hơn mốc mở ca quá dung sai ghi. */
const TRONG_DUNG_SAI = (cot: SQL) =>
  sql`${cot} is not null and ca.opened_at is not null and ${cot} >= ca.opened_at - make_interval(mins => ${CLOCK_SKEW_TOLERANCE_MIN})`;

/** Mâu thuẫn thật: sớm hơn mốc mở ca QUÁ dung sai — ra khỏi phép tính, nhưng phải đếm được. */
const MAU_THUAN = (cot: SQL) =>
  sql`${cot} is not null and ca.opened_at is not null and ${cot} < ca.opened_at - make_interval(mins => ${CLOCK_SKEW_TOLERANCE_MIN})`;

/** Đợt đóng vì không phải điều kiện care (`NOT_CARE_CONDITION`) nằm ngoài mọi thống kê cứu đơn. */
const LA_CA_CARE = or(isNull(sc.resolution), sql`${sc.resolution} <> ${NOT_CARE_CONDITION}`);

const KET_CUC_CUOI = (CARE_OUTCOMES as readonly CareOutcome[]).filter((o) => OUTCOME_IS_FINAL[o]);

/** Ca ĐÃ CHỐT trong kỳ (theo `outcome_at`). */
function daChotTrongKy(period: Period): SQL {
  return and(LA_CA_CARE, inArray(sc.careOutcome, KET_CUC_CUOI), ...trongKy("OUTCOME", period))!;
}

/** Ca CHƯA CHỐT tính tới cuối kỳ: mở trước cuối kỳ, kết cục rỗng hoặc sau cuối kỳ. */
function chuaChotCuoiKy(period: Period): SQL {
  return and(
    LA_CA_CARE,
    or(isNull(sc.careOutcome), inArray(sc.careOutcome, (CARE_OUTCOMES as readonly CareOutcome[]).filter((o) => !OUTCOME_IS_FINAL[o]))),
    period.to ? lte(sc.openedAt, period.to) : undefined,
    period.to ? or(isNull(sc.outcomeAt), gt(sc.outcomeAt, period.to)) : isNull(sc.outcomeAt),
  )!;
}

/** Tập ca của báo cáo hiệu suất: đã chốt trong kỳ ∪ chưa chốt tính tới cuối kỳ. */
function tapCaHieuSuat(period: Period): SQL {
  return or(daChotTrongKy(period), chuaChotCuoiKy(period))!;
}

/**
 * NGƯỜI MÀ MỘT CA ĐƯỢC QUY VỀ — một biểu thức, dùng cho cả con số lẫn danh sách bấm vào con số.
 *
 * Ca đã chốt → người cầm ca LÚC CHỐT (`owner_at_resolution`). Ca chưa chốt → người ĐANG cầm, để
 * cột "Đang treo" của mỗi người nói đúng khối việc họ đang giữ. Danh sách từng lọc theo riêng
 * `owner_at_resolution`: ca treo luôn rỗng cột đó, nên bấm vào "đang treo" của một người sẽ ra
 * DANH SÁCH RỖNG, còn "Chưa nối được người" lại ra MỌI ca treo của cả đội.
 */
const UID_QUY_KET = sql`coalesce(${sc.ownerAtResolution}, case when ${sc.careOutcome} in ${KET_CUC_CUOI} then null else ${sc.ownerId} end)`;

/** Tổng quan tỷ lệ cứu đơn của cả shop. */
export async function getRescueSummary(period: Period, basis: CareTimeBasis = "OUTCOME"): Promise<RescueSummary> {
  return memo(`rescue-summary:${basis}:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();
    const rows = await db
      .select({ outcome: sc.careOutcome, n: sql<number>`count(*)::int` })
      .from(sc)
      .where(basis === "OUTCOME" ? tapCaHieuSuat(period) : and(LA_CA_CARE, ...trongKy("OPENED", period)))
      .groupBy(sc.careOutcome);
    const c = roCounts();
    let total = 0;
    for (const r of rows) {
      cong(c, r.outcome, Number(r.n));
      total += Number(r.n);
    }
    const mo = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sc)
      .where(and(LA_CA_CARE, ...trongKy("OPENED", period)));
    const t = rescueRates(c);
    return { ...c, total: basis === "OUTCOME" ? t.finished : total, directRate: t.direct, rateWithExchange: t.withExchange, finished: t.finished, openedInPeriod: Number(mo[0]?.n ?? 0) };
  });
}

export type PicRow = RescueCounts & {
  userId: string | null;
  name: string;
  /** Ca được GIAO cho người này TRONG KỲ — đếm từ sự kiện ASSIGN (`care_case_events.next_owner_id`), không phải người đang cầm hôm nay. */
  assigned: number;
  finished: number;
  directRate: number | null;
  rateWithExchange: number | null;
  /** Số thao tác nghiệp vụ theo loại — đo VIỆC ĐÃ LÀM, KHÔNG dùng để chấm điểm. */
  actions: Record<string, number>;
  /*
    ═══ HAI MỐC "PHẢN HỒI", VÀ CHÚNG ĐO HAI THỨ KHÁC NHAU ═══

    · `medianFirstTouchMin`  — từ `first_response_at`: lần đầu có NGƯỜI CHẠM VÀO ca (nhận ca, ghi
      note, đổi trạng thái). Trả lời "đội có phản ứng nhanh không". Độ phủ 193/319 ca (đo 16/09).
    · `medianFirstActionMin` — từ `first_action_at`: lần đầu có HÀNH ĐỘNG NGHIỆP VỤ gửi sang ĐVVC
      (Duyệt hoàn · Phát tiếp · Đổi). Trả lời "đội có làm gì với ĐVVC không". Độ phủ 2/319 ca.

    Gộp hai cái làm một là lý do ô cũ in ra một trung vị của HAI DÒNG cạnh tên nhân viên. Chủ shop
    chốt 18/09/2026: hiện CẢ HAI, mỗi cột kèm độ phủ riêng.
  */
  /** Phút. `null` = CHƯA ĐỦ MẪU, không phải 0 và không phải "làm nhanh". */
  medianFirstTouchMin: number | null;
  medianFirstActionMin: number | null;
  medianResolveMin: number | null;
  /** Số ca thật sự có mốc DÙNG ĐƯỢC để tính trung vị — ĐỘ PHỦ, luôn đứng cạnh con số (mục 39). */
  touchSample: number;
  actionSample: number;
  resolveSample: number;
  /*
    ═══ ÂM MỘT PHẦN GIÂY LÀ THỨ TỰ GHI, ÂM MỘT GIỜ LÀ MÂU THUẪN ═══

    Đo production 18/09/2026: 36/232 đợt có `first_response_at` SỚM HƠN `opened_at` — 34 của một
    người, 2 ở nhóm chưa nối được người. Chênh lệch ÂM SÂU NHẤT trong cả 36 đợt là **dưới 30 giây**,
    và cả 36 đều `source_trigger = 'MANUAL'`: người mở ca bằng tay thì hai mốc được ghi trong CÙNG
    một thao tác, thứ tự giữa chúng là ngẫu nhiên ở mức mili giây.

    Nên đó là những ca PHẢN HỒI NGAY, không phải dữ liệu hỏng. Bản vá đầu tiên của tôi loại chúng
    khỏi phép tính — đo lại thì trung vị của người ấy nhảy từ **266 lên 594 phút**, vì phép "làm
    sạch" đó cắt đúng 34 ca nhanh nhất và làm đội trông chậm gấp đôi. Một bộ lọc nghe hợp lý vẫn
    có thể là một lời nói dối.

    Luật thay thế: chênh lệch âm TRONG dung sai ghi (`CLOCK_SKEW_TOLERANCE_MIN`) được KẸP VỀ 0 và
    vẫn tính; âm sâu hơn thế là mâu thuẫn thật — ra khỏi phép tính và đếm riêng ở đây. Hôm nay con
    số thứ hai là 0, và nó phải nói đúng như vậy chứ không được im lặng.
  */
  touchInconsistent: number;
  actionInconsistent: number;
  /** Cỡ mẫu tối thiểu để một trung vị được phát biểu. */
  timingMinSample: number;
};

/**
 * ═══════════ HIỆU SUẤT THEO NGƯỜI ═══════════
 *
 * Quy kết theo `owner_at_resolution` — NGƯỜI ĐANG CẦM CA LÚC CHỐT KẾT QUẢ. Không phải người mở ca,
 * không phải người bấm nhiều nhất.
 *
 * Vì sao chọn khâu chốt: một ca có thể qua tay nhiều người, và cộng kết quả cho tất cả sẽ đếm một
 * ca thành nhiều lần trong tỷ lệ tổng. Số THAO TÁC của từng người vẫn được đếm riêng ở `actions`
 * để thấy ai đã đóng góp — nhưng nó KHÔNG tham gia tỷ lệ cứu đơn.
 *
 * Ca `owner_at_resolution` rỗng ⇒ nhóm "chưa nối được người", hiện ra như một dòng riêng chứ không
 * bị chia đều cho ai. Đó là 70 ca lịch sử và mọi ca chưa có ai nhận.
 */
export async function getCarePerformanceByPic(period: Period): Promise<PicRow[]> {
  return memo(`care-perf-pic:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();

    // Ca đã chốt quy về `owner_at_resolution`; ca còn treo quy về người ĐANG cầm — để cột "đang
    // treo" của mỗi người nói đúng khối việc họ đang giữ. Khoá quy kết tính MỘT LẦN trong CTE:
    // Postgres không nhận ra hai biểu thức có tham số khác số thứ tự là cùng một biểu thức GROUP BY.
    const ketQua = rowsOf<{ user_id: string | null; name: string; outcome: string | null; n: number }>(
      await db.execute(sql`
        with ca as (
          select ${UID_QUY_KET} as uid,
                 ${sc.careOutcome} as outcome
            from ${sc}
           where ${tapCaHieuSuat(period)}
        )
        select ca.uid as user_id, coalesce(max(u.name), '') as name, ca.outcome, count(*)::int as n
          from ca left join users u on u.id = ca.uid
         group by ca.uid, ca.outcome
      `),
    );

    /*
      ═══ TRUNG VỊ THỜI GIAN GOM THEO NGƯỜI, KHÔNG THEO (NGƯỜI × KẾT CỤC) ═══

      Câu đếm ở trên phải nhóm theo kết cục — đó là việc của nó. Nhưng một trung vị nhóm theo
      (người × kết cục) rồi in dưới nhãn của NGƯỜI là trung vị của MỘT nhóm kết cục, và nhóm nào
      thắng thì phụ thuộc thứ tự dòng Postgres trả về. Đúng cái lỗi vòng này đi sửa: con số đo trên
      một tập, cái nhãn nói về một tập khác. Nên nó là một phép gom RIÊNG, theo đúng grain của nhãn.
    */
    const thoiGian = rowsOf<{ user_id: string | null; p_touch: number | null; p_action: number | null; p_resolve: number | null; n_touch: number; n_action: number; n_resolve: number; n_touch_xung_dot: number; n_action_xung_dot: number }>(
      await db.execute(sql`
        with ca as (
          select ${UID_QUY_KET} as uid,
                 ${sc.firstActionAt} as first_action_at, ${sc.firstResponseAt} as first_touch_at,
                 ${sc.openedAt} as opened_at, ${sc.outcomeAt} as outcome_at
            from ${sc}
           where ${tapCaHieuSuat(period)}
        )
        select ca.uid as user_id,
               -- Trung vị, không phải trung bình: một ca treo ba tuần kéo trung bình đi mà không nói gì
               -- về ngày làm việc bình thường của người đó.
               --
               -- KẸP VỀ 0, KHÔNG LOẠI BỎ. Âm dưới dung sai là thứ tự ghi trong cùng một thao tác (ca mở
               -- tay), tức PHẢN HỒI NGAY — loại nó đi là cắt mất đúng những ca nhanh nhất. Âm sâu hơn
               -- dung sai là mâu thuẫn thật: ra khỏi phép tính, và đếm riêng ở cột *_xung_dot bên dưới.
               percentile_cont(0.5) within group (order by greatest(extract(epoch from (ca.first_touch_at - ca.opened_at)) / 60, 0)) filter (where ${TRONG_DUNG_SAI(sql`ca.first_touch_at`)}) as p_touch,
               percentile_cont(0.5) within group (order by greatest(extract(epoch from (ca.first_action_at - ca.opened_at)) / 60, 0)) filter (where ${TRONG_DUNG_SAI(sql`ca.first_action_at`)}) as p_action,
               percentile_cont(0.5) within group (order by greatest(extract(epoch from (ca.outcome_at - ca.opened_at)) / 60, 0)) filter (where ${TRONG_DUNG_SAI(sql`ca.outcome_at`)}) as p_resolve,
               /*
                 ĐẾM SỐ DÒNG THẬT SỰ GÓP VÀO TRUNG VỊ.

                 Thiếu con số này thì không cách nào biết một trung vị dựng trên 2 dòng hay 200.
                 Đo 16/09/2026: cột first_action_at chỉ có ở 2/319 đợt, nên ô "thời gian phản hồi"
                 cạnh tên nhân viên là trung vị của HAI dòng — nói về sự ngẫu nhiên, không nói về họ.
               */
               count(*) filter (where ${TRONG_DUNG_SAI(sql`ca.first_touch_at`)})::int as n_touch,
               count(*) filter (where ${TRONG_DUNG_SAI(sql`ca.first_action_at`)})::int as n_action,
               count(*) filter (where ${TRONG_DUNG_SAI(sql`ca.outcome_at`)})::int as n_resolve,
               -- Chỗ dữ liệu cần sửa, KHÔNG phải một quan sát. Đếm riêng để nó không lặng lẽ biến mất.
               count(*) filter (where ${MAU_THUAN(sql`ca.first_touch_at`)})::int as n_touch_xung_dot,
               count(*) filter (where ${MAU_THUAN(sql`ca.first_action_at`)})::int as n_action_xung_dot
          from ca
         group by ca.uid
      `),
    );

    /*
      "ĐƯỢC GIAO TRONG KỲ" = sự kiện GIAO xảy ra trong kỳ, đếm theo KHOÁ tài khoản người được giao.
      Bản trước đếm `owner_id` hiện tại của ca mở trong kỳ: A nhận rồi chuyển B thì A mất dấu, và ca
      mở tháng trước giao tháng này không tính cho ai. Một ca giao đi giao lại cho cùng người trong
      kỳ đếm một lần.
    */
    const ev = schema.careCaseEvents;
    const giao = await db
      .select({ userId: ev.nextOwnerId, n: sql<number>`count(distinct ${ev.shipmentId})::int` })
      .from(ev)
      .where(and(eq(ev.action, "ASSIGN"), sql`${ev.nextOwnerId} is not null`, ...[period.from ? gte(ev.createdAt, period.from) : undefined, period.to ? lte(ev.createdAt, period.to) : undefined].filter(Boolean)))
      .groupBy(ev.nextOwnerId);

    const thaoTac = await db
      .select({ userId: schema.careBusinessActions.actorUserId, actionType: schema.careBusinessActions.actionType, n: sql<number>`count(*)::int` })
      .from(schema.careBusinessActions)
      .where(and(...[period.from ? gte(schema.careBusinessActions.createdAt, period.from) : undefined, period.to ? lte(schema.careBusinessActions.createdAt, period.to) : undefined].filter(Boolean)))
      .groupBy(schema.careBusinessActions.actorUserId, schema.careBusinessActions.actionType);

    const theoNguoi = new Map<string, PicRow>();
    const lay = (id: string | null, name: string): PicRow => {
      const k = id ?? "__none__";
      const cu = theoNguoi.get(k);
      if (cu) return cu;
      const moi: PicRow = {
        ...roCounts(),
        userId: id,
        name: id ? name || id : "Chưa nối được người",
        assigned: 0,
        finished: 0,
        directRate: null,
        rateWithExchange: null,
        actions: {},
        medianFirstTouchMin: null,
        medianFirstActionMin: null,
        medianResolveMin: null,
        touchSample: 0,
        actionSample: 0,
        resolveSample: 0,
        touchInconsistent: 0,
        actionInconsistent: 0,
        timingMinSample: TIMING_MIN_SAMPLE,
      };
      theoNguoi.set(k, moi);
      return moi;
    };

    for (const r of ketQua) cong(lay(r.user_id, r.name), r.outcome, Number(r.n));

    /*
      NGƯỠNG MẪU ÁP Ở ĐÂY, KHÔNG Ở SQL: `percentile_cont` luôn trả một con số nếu có ít nhất một
      dòng, nên chặn phải nằm sau khi đã biết cỡ mẫu. Dưới ngưỡng ⇒ để TRỐNG, và màn hình hiện
      "chưa đủ mẫu" — một ô trống nói đúng sự thật, một con số từ hai dòng thì nói sai mà trông
      như đúng (mục 39: CHƯA ĐỦ DỮ LIỆU tách hẳn khỏi LÀM KÉM).
    */
    for (const r of thoiGian) {
      const row = lay(r.user_id, "");
      row.touchSample = Number(r.n_touch ?? 0);
      row.actionSample = Number(r.n_action ?? 0);
      row.resolveSample = Number(r.n_resolve ?? 0);
      row.touchInconsistent = Number(r.n_touch_xung_dot ?? 0);
      row.actionInconsistent = Number(r.n_action_xung_dot ?? 0);
      if (r.p_touch !== null && r.p_touch !== undefined && row.touchSample >= TIMING_MIN_SAMPLE) row.medianFirstTouchMin = Math.round(Number(r.p_touch));
      if (r.p_action !== null && r.p_action !== undefined && row.actionSample >= TIMING_MIN_SAMPLE) row.medianFirstActionMin = Math.round(Number(r.p_action));
      if (r.p_resolve !== null && r.p_resolve !== undefined && row.resolveSample >= TIMING_MIN_SAMPLE) row.medianResolveMin = Math.round(Number(r.p_resolve));
    }
    for (const r of giao) lay(r.userId, "").assigned += Number(r.n);
    for (const r of thaoTac) {
      const row = lay(r.userId, "");
      row.actions[r.actionType] = (row.actions[r.actionType] ?? 0) + Number(r.n);
    }
    for (const row of theoNguoi.values()) {
      const t = rescueRates(row);
      row.directRate = t.direct;
      row.rateWithExchange = t.withExchange;
      row.finished = t.finished;
    }
    return [...theoNguoi.values()].sort((a, b) => b.finished - a.finished || b.assigned - a.assigned);
  });
}

export type ProductCareRow = RescueCounts & {
  code: string;
  name: string;
  total: number;
  finished: number;
  directRate: number | null;
  rateWithExchange: number | null;
};

export type ProductCareReport = {
  rows: ProductCareRow[];
  /** Ca thuộc đơn có NHIỀU mã hàng — được cộng cho MỌI mã, nên tổng theo mã > tổng ca thật. */
  multiCodeCases: number;
  /** Ca không lần được về mã nào. CHƯA BIẾT, không phải "mã khác". */
  unmappedCases: number;
  totalCases: number;
};

/**
 * ═══════════ HIỆU SUẤT CHĂM SÓC THEO MÃ HÀNG ═══════════
 *
 * ─── GRAIN LÀ CHỖ DỄ SAI NHẤT ───
 *
 * Ca chăm sóc gắn với VẬN ĐƠN; mã hàng gắn với DÒNG HÀNG. Một đơn hai mã thì ca đó được cộng cho
 * cả hai — và vì thế **tổng theo mã LỚN HƠN tổng ca thật**. Con số chênh không được giấu: nó trả
 * về ở `multiCodeCases` để người đọc biết chính xác phần chồng lấn.
 *
 * KHÔNG chia ca cho từng mã theo tỷ lệ, và KHÔNG gán nguyên nhân cho một mã: không có gì trong dữ
 * liệu nói mã nào gây ra sự cố giao hàng. Chia hay gán đều là bịa ra một thông tin không tồn tại.
 *
 * Mã hàng đi qua QUAN HỆ THẬT (`order_items` → `product_variants` → `products.custom_id`), không
 * qua chuỗi: bốn mã đang bán có bốn quy ước đặt tên SKU khác nhau.
 */
export async function getCarePerformanceByProduct(period: Period): Promise<ProductCareReport> {
  return memo(`care-perf-product:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();

    const cases = await db
      .select({ id: sc.id, shipmentId: sc.shipmentId, outcome: sc.careOutcome })
      .from(sc)
      .where(tapCaHieuSuat(period));
    if (!cases.length) return { rows: [], multiCodeCases: 0, unmappedCases: 0, totalCases: 0 };

    const ma = await db
      .select({ shipmentId: schema.shipments.id, code: schema.products.customId, name: sql<string>`coalesce(max(${schema.products.name}), '')` })
      .from(schema.shipments)
      .innerJoin(schema.orderItems, sql`${schema.orderItems.orderId} = ${schema.shipments.orderId} and ${schema.orderItems.isBonus} = false`)
      .leftJoin(schema.productVariants, sql`${schema.productVariants.id} = ${schema.orderItems.variantId}`)
      .leftJoin(schema.products, sql`${schema.products.id} = ${schema.productVariants.productId}`)
      .where(inArray(schema.shipments.id, cases.map((c) => c.shipmentId)))
      .groupBy(schema.shipments.id, schema.products.customId);

    const theoKien = new Map<string, { code: string; name: string }[]>();
    for (const r of ma) {
      const code = (r.code ?? "").trim();
      if (!code) continue;
      const cur = theoKien.get(r.shipmentId) ?? [];
      if (!cur.some((x) => x.code === code)) cur.push({ code, name: r.name });
      theoKien.set(r.shipmentId, cur);
    }

    const theoMa = new Map<string, ProductCareRow>();
    let multiCodeCases = 0;
    let unmappedCases = 0;
    for (const c of cases) {
      const codes = theoKien.get(c.shipmentId) ?? [];
      if (!codes.length) {
        unmappedCases += 1;
        continue;
      }
      if (codes.length > 1) multiCodeCases += 1;
      for (const { code, name } of codes) {
        const row = theoMa.get(code) ?? { ...roCounts(), code, name, total: 0, finished: 0, directRate: null, rateWithExchange: null };
        cong(row, c.outcome, 1);
        row.total += 1;
        theoMa.set(code, row);
      }
    }
    for (const row of theoMa.values()) {
      const t = rescueRates(row);
      row.directRate = t.direct;
      row.rateWithExchange = t.withExchange;
      row.finished = t.finished;
    }
    return {
      rows: [...theoMa.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
      multiCodeCases,
      unmappedCases,
      totalCases: cases.length,
    };
  });
}

/**
 * Ô nào của bảng hiệu suất người đang được bấm. `FINISHED` = cột "Đã chốt" (ba kết cục cuối gộp lại);
 * `UNATTRIBUTED` = ca lịch sử chưa có kết luận — bảng không có cột riêng cho nó nên trước đây nó
 * biến mất hẳn (một người cầm 4 ca như vậy hiện ra với toàn số 0).
 */
export const CARE_CASE_BUCKETS = ["FINISHED", "RESCUED_DIRECT", "RESCUED_EXCHANGE", "RESCUE_FAILED", "PENDING", "UNATTRIBUTED"] as const;
export type CareCaseBucket = (typeof CARE_CASE_BUCKETS)[number];

function dieuKienO(bucket: CareCaseBucket): SQL {
  if (bucket === "FINISHED") return inArray(sc.careOutcome, KET_CUC_CUOI);
  // Cùng phép quy của `cong()`: mọi giá trị ngoài bộ kết cục — kể cả NULL — là "không đủ chứng cứ".
  if (bucket === "UNATTRIBUTED") return or(isNull(sc.careOutcome), sql`${sc.careOutcome} not in ${CARE_OUTCOMES.filter((o) => o !== "UNATTRIBUTED")}`)!;
  return eq(sc.careOutcome, bucket);
}

export type CareCaseListRow = {
  id: string;
  shipmentId: string;
  tracking: string | null;
  episodeNo: number;
  latestEpisodeNo: number;
  active: boolean;
  careStatus: string;
  careOutcome: string | null;
  ownerName: string | null;
  openedAt: Date | null;
  doneAt: Date | null;
  outcomeAt: Date | null;
  stage: ShipmentStage;
  vtpStatus: number | null;
  vtpStatusName: string | null;
  vtpStatusDate: Date | null;
  codAmount: number | null;
  /** Chỉ có với ca chưa chốt: vì sao nó còn treo. */
  diagnosis: PendingDiagnosis | null;
};

/**
 * Danh sách ca đứng sau MỘT ô của bảng hiệu suất người — bấm vào con số là ra đúng những ca đã sinh
 * ra nó. Cùng tập ca (`tapCaHieuSuat`), cùng phép quy người (`UID_QUY_KET`), cùng phép phân ô
 * (`cong`) với `getCarePerformanceByPic`, nên số dòng BẰNG con số trên ô. `ownerId = null` là dòng
 * "Chưa nối được người".
 */
export async function listCareCases(period: Period, filter: { ownerId: string | null; bucket: CareCaseBucket; limit?: number }): Promise<{ rows: CareCaseListRow[]; total: number }> {
  const db = await getDb();
  const dk = and(tapCaHieuSuat(period), dieuKienO(filter.bucket), filter.ownerId === null ? sql`${UID_QUY_KET} is null` : sql`${UID_QUY_KET} = ${filter.ownerId}`);
  const s = schema.shipments;
  const [rows, dem] = await Promise.all([
    db
      .select({
        id: sc.id,
        shipmentId: sc.shipmentId,
        tracking: sql<string | null>`coalesce(${s.vtpOrderNumber}, ${sc.trackingNumber})`,
        episodeNo: sc.episodeNo,
        latestEpisodeNo: sql<number>`(select max(n.episode_no) from shipment_care n where n.shipment_id = ${sc.shipmentId})::int`,
        active: sc.active,
        careStatus: sc.careStatus,
        careOutcome: sc.careOutcome,
        replacementShipmentId: sc.replacementShipmentId,
        ownerName: schema.users.name,
        openedAt: sc.openedAt,
        doneAt: sc.doneAt,
        outcomeAt: sc.outcomeAt,
        stage: s.stage,
        vtpStatus: s.vtpStatus,
        vtpStatusName: s.vtpStatusName,
        vtpStatusDate: s.vtpStatusDate,
        codAmount: s.codAmount,
      })
      .from(sc)
      .innerJoin(s, eq(s.id, sc.shipmentId))
      .leftJoin(schema.users, sql`${schema.users.id} = ${UID_QUY_KET}`)
      .where(dk)
      .orderBy(desc(sql`coalesce(${sc.outcomeAt}, ${sc.openedAt})`))
      .limit(filter.limit ?? 300),
    db.select({ n: sql<number>`count(*)::int` }).from(sc).where(dk),
  ]);
  /*
    Kiện đang ở tab nào: hỏi CHÍNH hàng đợi (đệm 30 giây), không suy lại. Chỉ cần khi danh sách có
    ca chưa chốt — ô đã chốt không có gì để chẩn đoán. Kiện rơi vào mục "thiếu dữ liệu" không thuộc
    tab nào nên để `null`.
  */
  const canHangDoi = filter.bucket === "PENDING" || filter.bucket === "UNATTRIBUTED";
  const tab = new Map<string, QueueView>();
  if (canHangDoi) for (const c of (await getCareQueue()).cases) tab.set(c.shipmentId, c.view);
  return {
    total: Number(dem[0]?.n ?? 0),
    rows: rows.map(({ replacementShipmentId, ...r }) => ({
      ...r,
      latestEpisodeNo: Number(r.latestEpisodeNo ?? r.episodeNo),
      codAmount: r.codAmount === null ? null : Number(r.codAmount),
      diagnosis:
        r.careOutcome !== null && KET_CUC_CUOI.includes(r.careOutcome as CareOutcome)
          ? null
          : diagnosePending({
              episodeNo: r.episodeNo,
              latestEpisodeNo: Number(r.latestEpisodeNo ?? r.episodeNo),
              stage: r.stage,
              vtpStatus: r.vtpStatus,
              vtpStatusName: r.vtpStatusName,
              hasReplacement: replacementShipmentId !== null,
              queueView: tab.get(r.shipmentId) ?? null,
            }),
    })),
  };
}

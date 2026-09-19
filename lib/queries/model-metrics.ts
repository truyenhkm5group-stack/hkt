/**
 * SỐ ĐO QUAN SÁT ĐƯỢC CỦA TỪNG MÔ HÌNH — độ trễ, tỷ lệ lỗi, lần gọi gần nhất.
 *
 * Đặc tả xếp chúng chung một dòng với `input_price` và `supports_vision` trong sổ mẫu mô hình.
 * Chúng KHÔNG cùng loại: giá và năng lực là thứ NGƯỜI KHAI, còn ba con số dưới đây là thứ ĐO ĐƯỢC
 * từ chính lượt gọi đã chạy. Chép chúng vào một hằng số là dựng nguồn sự thật thứ hai — nó sai
 * ngay sau lượt gọi kế tiếp, và không ai biết nó sai vì trông nó vẫn rất tự tin.
 *
 * Nên chỗ này không khai gì cả. Nó ĐẾM `ai_model_calls`.
 *
 * ─── BA QUYẾT ĐỊNH ĐO LƯỜNG, ĐỀU LÀ CHỖ DỄ NÓI DỐI NHẤT ───
 *
 * 1. ĐỘ TRỄ CHỈ ĐẾM LƯỢT THÀNH CÔNG. Độ trễ của một lượt hết giờ không phải tốc độ của mô hình —
 *    nó là TRẦN THỜI GIAN ta đặt ra. Trộn vào thì một nhà cung cấp hay treo lại hiện ra thành
 *    "hơi chậm", và trần thời gian đặt cao hơn sẽ làm nó trông chậm hơn nữa mà chẳng liên quan gì
 *    tới mô hình. Lượt hỏng đã có số riêng ở `errorRate`.
 * 2. MẪU QUÁ BÉ ⇒ `null`, KHÔNG PHẢI 0. Ba lượt gọi không nói được tỷ lệ lỗi. In "0% lỗi" từ ba
 *    lượt là một lời khẳng định mà dữ liệu không đỡ nổi — đúng thứ luật 42 cấm.
 * 3. CHI PHÍ CÓ MỘT LƯỢT CHƯA KHAI GIÁ ⇒ TỔNG LÀ CHƯA BIẾT. Cộng phần biết được rồi im lặng là
 *    báo rẻ hơn thực tế, và đây là hành vi đã có sẵn ở `ai_runs` — giữ cho hai nơi nói một điều.
 */
import { desc, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";

/**
 * Dưới ngưỡng này thì tỷ lệ lỗi là CHƯA BIẾT. Hai mươi là ngưỡng ERP đã dùng cho mọi tỷ lệ khác
 * (`QUALITY_MIN_SAMPLE`, `MIN_SAMPLE_FOR_RATE`) — không đặt một con số thứ ba cho cùng một câu
 * hỏi "bao nhiêu quan sát thì một tỷ lệ mới có nghĩa".
 */
export const MODEL_METRIC_MIN_SAMPLE = 20;

export type ModelObserved = {
  provider: string;
  model: string;
  /** Tổng lượt gọi đã ghi trong cửa sổ, kể cả lượt hỏng. */
  calls: number;
  okCalls: number;
  /** Độ trễ trung vị của LƯỢT THÀNH CÔNG, ms. `null` = chưa có lượt thành công nào. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Tỷ lệ lượt hỏng, 0–1. `null` = mẫu dưới `MODEL_METRIC_MIN_SAMPLE` ⇒ CHƯA BIẾT. */
  errorRate: number | null;
  /** Tổng chi phí VND trong cửa sổ. `null` = có ít nhất một lượt chưa khai đơn giá. */
  costVnd: number | null;
  /** Lượt gọi gần nhất — đây mới là "last_benchmarked_at" có thật. `null` = chưa gọi bao giờ. */
  lastCallAt: Date | null;
};

/**
 * Đọc số đo của mọi mô hình đã từng được gọi trong `days` ngày gần nhất.
 *
 * Mô hình khai trong sổ mà CHƯA gọi lần nào sẽ KHÔNG có dòng ở đây — và đó là câu trả lời đúng:
 * "chưa đo" khác hẳn "đo được 0". Bên gọi muốn in đủ sổ thì tự nối và để trống phần chưa có.
 */
export async function modelObservedMetrics(days = 30): Promise<ModelObserved[]> {
  return memo(`model-observed:${days}`, 90, async () => {
    const db = await getDb();
    const tu = new Date(Date.now() - days * 86_400_000);
    const rows = await db
      .select({
        provider: schema.aiModelCalls.provider,
        model: schema.aiModelCalls.model,
        calls: sql<number>`count(*)::int`,
        okCalls: sql<number>`count(*) filter (where ${schema.aiModelCalls.ok})::int`,
        // `percentile_cont` bỏ qua NULL, nên lọc bằng CASE để lượt hỏng không vào phép tính.
        p50: sql<number | null>`percentile_cont(0.5) within group (order by case when ${schema.aiModelCalls.ok} then ${schema.aiModelCalls.latencyMs} end)`,
        p95: sql<number | null>`percentile_cont(0.95) within group (order by case when ${schema.aiModelCalls.ok} then ${schema.aiModelCalls.latencyMs} end)`,
        // Một lượt chưa khai giá là đủ làm cả tổng thành CHƯA BIẾT.
        chuaKhaiGia: sql<number>`count(*) filter (where ${schema.aiModelCalls.costVnd} is null)::int`,
        tongTien: sql<number | null>`sum(${schema.aiModelCalls.costVnd})::int`,
        lastCallAt: sql<Date | null>`max(${schema.aiModelCalls.createdAt})`,
      })
      .from(schema.aiModelCalls)
      .where(gte(schema.aiModelCalls.createdAt, tu))
      .groupBy(schema.aiModelCalls.provider, schema.aiModelCalls.model)
      .orderBy(desc(sql`count(*)`));

    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      calls: r.calls,
      okCalls: r.okCalls,
      latencyP50Ms: r.p50 === null ? null : Math.round(Number(r.p50)),
      latencyP95Ms: r.p95 === null ? null : Math.round(Number(r.p95)),
      errorRate: r.calls < MODEL_METRIC_MIN_SAMPLE ? null : (r.calls - r.okCalls) / r.calls,
      costVnd: r.chuaKhaiGia > 0 ? null : Number(r.tongTien ?? 0),
      lastCallAt: r.lastCallAt ? new Date(r.lastCallAt) : null,
    }));
  });
}

/**
 * Số đo của MỘT mô hình. Chưa gọi lần nào ⇒ `null` — bên gọi phải in "chưa đo", không được in một
 * dòng toàn số 0.
 */
export async function modelObserved(provider: string, model: string, days = 30): Promise<ModelObserved | null> {
  const all = await modelObservedMetrics(days);
  return all.find((r) => r.provider === provider && r.model === model) ?? null;
}

/**
 * Chi phí thật của toàn dây chuyền trong cửa sổ — con số "HIỆN TẠI" của bảng so sánh chi phí.
 *
 * Trả về `null` khi có lượt chưa khai giá: một bảng so sánh mà cột HIỆN TẠI báo rẻ hơn thực tế sẽ
 * làm mọi phương án thay thế trông tệ hơn thực tế, tức là đúng chiều sai nguy hiểm nhất.
 */
export async function currentModelSpendVnd(days = 30): Promise<{ costVnd: number | null; calls: number; unpricedCalls: number }> {
  const db = await getDb();
  const tu = new Date(Date.now() - days * 86_400_000);
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      chuaKhaiGia: sql<number>`count(*) filter (where ${schema.aiModelCalls.costVnd} is null)::int`,
      tongTien: sql<number | null>`sum(${schema.aiModelCalls.costVnd})::int`,
    })
    .from(schema.aiModelCalls)
    .where(gte(schema.aiModelCalls.createdAt, tu));
  const calls = row?.calls ?? 0;
  const unpriced = row?.chuaKhaiGia ?? 0;
  return { costVnd: unpriced > 0 ? null : Number(row?.tongTien ?? 0), calls, unpricedCalls: unpriced };
}

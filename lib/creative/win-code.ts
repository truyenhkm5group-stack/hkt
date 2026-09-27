import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CAMPAIGN_WIN_STATES, type ProductWinCode } from "@/lib/constants/campaign-setup";
import { MODEL_STATE_LABELS, MODEL_STATE_UNDECLARED_LABEL, isModelState, normalizeModelCode } from "@/lib/constants/model-lifecycle";
import { extractCodes, matchCampaignToProduct, type ProductCodeEntry } from "@/lib/integrations/facebook/match";
import { loadProductCodeIndex } from "@/lib/integrations/facebook/sync";

/**
 * ═══════════ MÃ WIN TRONG TÊN CHIẾN DỊCH ═══════════
 *
 * Chủ shop 27/09/2026: "camp chạy mã win thì ghi tên mã" — tên `TKQC_MãMKTer_ngày_<MÃ>_fanpage_số` thay cho `..._TEST_...`.
 * Đây không chỉ là nhãn: luật quy tiền ads (`resolveCampaign`) coi mọi chiến dịch có chữ TEST là CHI PHÍ TEST (không thuộc
 * mã nào), còn chiến dịch mang mã hàng thì tiền quy về đúng mã qua `matchCampaignToProduct`. Nên mã ghi vào tên phải là mã mà
 * CHÍNH phép ghép ấy nhận ra cho đúng sản phẩm — chọn mã bằng cách hỏi nó, không đoán.
 */

/**
 * Mã đầu tiên trong `candidates` mà phép ghép tên → mã trả về ĐÚNG `productId` (và không bị mã dài hơn của sản phẩm khác
 * bắt mất). Không mã nào qua ⇒ `null`. Hàm THUẦN.
 */
export function pickWinCode(candidates: readonly string[], productId: string, index: ProductCodeEntry[]): string | null {
  for (const c of candidates) {
    const code = c.trim().toUpperCase();
    if (code && matchCampaignToProduct(`X_${code}_Y`, index) === productId) return code;
  }
  return null;
}

/** Tên chiến dịch có quy tiền ads về ĐÚNG mã không — không mang chữ TEST (luật test thắng mọi mã) và phép ghép ra đúng mã. Hàm THUẦN. */
export function winNameProblem(campaignName: string, win: ProductWinCode, index: ProductCodeEntry[]): string | null {
  const lower = campaignName.toLowerCase();
  const coTest = /(^|[^\p{L}\p{N}])test([^\p{L}\p{N}]|$)/u.test(lower);
  if (coTest) return `Tên chiến dịch "${campaignName}" còn chữ TEST — ERP sẽ tính tiền ads là chi phí test, không quy về mã ${win.code}. Bỏ chữ TEST hoặc chọn loại camp TEST.`;
  if (matchCampaignToProduct(campaignName, index) !== win.productId) return `Tên chiến dịch "${campaignName}" không mang mã ${win.code} — tiền ads sẽ không quy về mã này. Để trống ô tên (máy tự ghép) hoặc gõ thêm ${win.code}.`;
  return null;
}

/**
 * Mã win của từng sản phẩm: mã MẪU (`product_models.code`) → mã tuỳ chỉnh Pancake → mã trong tên sản phẩm, lấy cái đầu tiên
 * mà phép ghép tên → mã nhận đúng. Kèm trạng thái vòng đời NGƯỜI đã khai (mặc định "Mã win" chỉ khi đã khai Thắng test trở
 * đi — máy không tự coi mẫu chưa khai là đã thắng). Sản phẩm không có mã dùng được thì không có trong kết quả.
 */
export async function productWinCodes(db: Db, productIds: readonly string[], indexIn?: ProductCodeEntry[]): Promise<Map<string, ProductWinCode>> {
  const ids = [...new Set(productIds.filter((x) => x))];
  const out = new Map<string, ProductWinCode>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId, modelCode: schema.productModels.code, state: schema.productModels.lifecycleState })
    .from(schema.products)
    .leftJoin(schema.productModels, eq(schema.productModels.productId, schema.products.id))
    .where(inArray(schema.products.id, ids));
  const index = indexIn ?? (await loadProductCodeIndex(db));
  for (const r of rows) {
    const model = normalizeModelCode(r.modelCode);
    const code = pickWinCode([...(model ? [model] : []), ...extractCodes(r.customId ?? ""), ...extractCodes(r.name)], r.id, index);
    if (!code) continue;
    const state = isModelState(r.state) ? r.state : null;
    out.set(r.id, { productId: r.id, code, declaredWin: state !== null && (CAMPAIGN_WIN_STATES as readonly string[]).includes(state), stateLabel: state ? MODEL_STATE_LABELS[state] : MODEL_STATE_UNDECLARED_LABEL });
  }
  return out;
}

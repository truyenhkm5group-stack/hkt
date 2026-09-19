/**
 * KHAI BẢNG GIÁ MÔ HÌNH cho nền tảng AI (ghi vào `settings`, khoá `ai`).
 *
 *   npx tsx scripts/ai-set-pricing.ts --usd-vnd=26000
 *   npx tsx scripts/ai-set-pricing.ts --usd-vnd=26000 --model="gpt-5.6-luna:0.25/2" --model="gpt-5.6-terra:1.5/12"
 *   npx tsx scripts/ai-set-pricing.ts --usd-vnd=26000 --dry-run
 *
 * Tỷ giá KHÔNG có mặc định: đoán tỷ giá là bịa chi phí, và một con số bịa trông y hệt một con số
 * đúng khi đọc lại sau ba tháng.
 */
import "dotenv/config";
import { getDb } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { buildVndPricing, pricingVersionLabel, MODEL_PRICE_SOURCE_DATE, MODEL_USD_PRICES, type VndPrice } from "@/lib/constants/ai-model-pricing";

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const chayThu = process.argv.includes("--dry-run");
  const tyGia = Number(arg("usd-vnd"));
  if (!Number.isFinite(tyGia) || tyGia <= 0) {
    console.error("Thiếu --usd-vnd=<số>. Không có mặc định — tỷ giá là quyết định của chủ shop.");
    process.exit(1);
  }

  await ensureMigrated();
  await getDb();

  /*
    ĐƠN GIÁ CHỦ SHOP KHAI THÊM — cho mô hình chưa có trong bảng chép sẵn.

      --model="gpt-5.6-luna:0.25/2"           (USD vào / USD ra, mỗi TRIỆU token)
      --model="gpt-5.6-luna:0.25/2/0.025"     (thêm USD cho token ĐỌC TỪ ĐỆM)

    Ô thứ ba là ô dễ quên và tốn nhất: `estimateCostVnd()` trả CHƯA BIẾT khi lượt gọi CÓ token đệm
    mà bảng giá chưa khai giá đệm. Khai thiếu nó nghĩa là khai giá xong mà chi phí VẪN chưa biết,
    ở đúng những lượt hay xảy ra nhất.

    Vì sao phải có đường này: bảng trong kho mã chỉ chép giá các mô hình Claude, còn ERP đang chạy
    AI Copilot trên OpenAI (`gpt-5.6-*`). Không có giá thì chi phí mọi lượt gọi là CHƯA BIẾT —
    đúng luật, nhưng vô dụng khi cần biết một hội thoại tốn bao nhiêu.

    Và KHÔNG chép đại một con số vào kho mã: đơn giá là thứ nhà cung cấp công bố và đổi theo thời
    gian. Chủ shop đọc bảng giá hiện hành rồi khai — con số vào CSDL kèm nhãn phiên bản, truy được
    về ngày khai.
  */
  const khaiThem: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number; cacheWriteUsdPerMillion?: number }> = {};
  for (const a of process.argv.filter((x) => x.startsWith("--model="))) {
    const raw = a.slice("--model=".length);
    const m = raw.match(/^(.+):([0-9.]+)\/([0-9.]+)(?:\/([0-9.]+))?(?:\/([0-9.]+))?$/);
    if (!m) { console.error(`--model sai dạng: "${raw}". Đúng dạng: --model="ten-mo-hinh:<usd-vao>/<usd-ra>[/<usd-dem>[/<usd-ghi-dem>]]"`); process.exit(1); }
    const vao = Number(m[2]);
    const ra = Number(m[3]);
    // Hai ô đệm là TUỲ CHỌN và `undefined` ở đây có nghĩa rõ ràng: CHƯA KHAI ⇒ lượt có token đệm
    // sẽ ra chi phí CHƯA BIẾT. Đặt 0 thay cho `undefined` là nói "đệm miễn phí" — một lời khẳng
    // định khác hẳn, và là một lời khẳng định sai.
    const dem = m[4] === undefined ? undefined : Number(m[4]);
    const ghiDem = m[5] === undefined ? undefined : Number(m[5]);
    for (const [ten, v] of [["vào", vao], ["ra", ra], ["đệm", dem], ["ghi đệm", ghiDem]] as const) {
      if (v !== undefined && (!Number.isFinite(v) || v < 0)) { console.error(`Đơn giá ${ten} phải là số không âm: "${raw}"`); process.exit(1); }
    }
    khaiThem[m[1]] = { inputUsdPerMillion: vao, outputUsdPerMillion: ra, cachedInputUsdPerMillion: dem, cacheWriteUsdPerMillion: ghiDem };
  }

  const pricing = buildVndPricing(tyGia);
  for (const [model, usd] of Object.entries(khaiThem)) {
    const dong: VndPrice = {
      inputVndPerMillion: Math.round(usd.inputUsdPerMillion * tyGia),
      outputVndPerMillion: Math.round(usd.outputUsdPerMillion * tyGia),
    };
    if (usd.cachedInputUsdPerMillion !== undefined) dong.cachedReadVndPerMillion = Math.round(usd.cachedInputUsdPerMillion * tyGia);
    if (usd.cacheWriteUsdPerMillion !== undefined) dong.cacheWriteVndPerMillion = Math.round(usd.cacheWriteUsdPerMillion * tyGia);
    // Khai cả khoá CÓ TÊN NHÀ lẫn khoá trần, y như `buildVndPricing()` — vì `estimateCostVnd()`
    // tra `"<nhà>:<mẫu>"` trước. Chủ shop khai tay thì chưa biết nhà nào, nên phủ cả hai nhà đang
    // có đường chạy thật; khoá thừa không gây hại, khoá thiếu thì chi phí là CHƯA BIẾT.
    pricing[model] = dong;
    for (const nha of ["erp", "erp:openai", "openai", "anthropic"]) pricing[`${nha}:${model}`] = dong;
  }
  // Nhãn phiên bản phải ĐỔI khi có giá khai tay, nếu không hai bảng giá khác nhau mang cùng một
  // nhãn và không ai dựng lại được con số cũ.
  const pricingVersion = Object.keys(khaiThem).length
    ? `${pricingVersionLabel(tyGia)}+khai-tay-${new Date().toISOString().slice(0, 10)}`
    : pricingVersionLabel(tyGia);

  console.log(`\nGiá gốc chép ngày ${MODEL_PRICE_SOURCE_DATE} · tỷ giá ${tyGia.toLocaleString("vi-VN")} đ/USD`);
  for (const [model, usd] of Object.entries(MODEL_USD_PRICES)) {
    const v = pricing[model];
    console.log(`  ${model.padEnd(20)} vào ${usd.inputUsdPerMillion}$ → ${v.inputVndPerMillion.toLocaleString("vi-VN")}đ · ra ${usd.outputUsdPerMillion}$ → ${v.outputVndPerMillion.toLocaleString("vi-VN")}đ (mỗi triệu token)`);
  }
  for (const [model, usd] of Object.entries(khaiThem)) {
    const v = pricing[model];
    console.log(`  ${model.padEnd(20)} vào ${usd.inputUsdPerMillion}$ → ${v.inputVndPerMillion.toLocaleString("vi-VN")}đ · ra ${usd.outputUsdPerMillion}$ → ${v.outputVndPerMillion.toLocaleString("vi-VN")}đ  (CHỦ SHOP KHAI)`);
  }
  console.log(`  phiên bản bảng giá: ${pricingVersion}`);

  if (chayThu) {
    console.log("\n--dry-run: KHÔNG ghi gì.");
    return;
  }

  /*
    GHI VÀO ĐÚNG KHOÁ MÀ BỘ ĐỌC ĐỌC — `AI_CONFIG_KEY` ("ai.config"), không phải "ai".

    Bản trước ghi vào khoá `"ai"`. `getAiSettings()` đọc `AI_CONFIG_KEY`. Hai khoá khác nhau, nên
    script này CHẠY XONG, IN RA "đã ghi", và không một lượt gọi nào tính được tiền — im lặng, không
    lỗi, không cảnh báo. Đo trên bản chạy thử 19/09/2026: 660/660 lượt gọi trong 30 ngày đều
    `cost_vnd IS NULL`, và bảng `settings` không có dòng `ai.config` nào.

    Lấy khoá từ hằng số chung thay vì gõ lại chuỗi: gõ lại là mời đúng lỗi này quay lại.
  */
  const hienTai = await getSettingJson<Record<string, unknown>>(AI_CONFIG_KEY, {}).catch(() => ({}) as Record<string, unknown>);
  await setSettingJson(AI_CONFIG_KEY, { ...hienTai, pricing, pricingVersion });

  // ĐỌC LẠI để chứng minh — "đã ghi" mà không đọc lại chính là cách lỗi trên sống sót cả tháng.
  const docLai = await getSettingJson<Record<string, unknown>>(AI_CONFIG_KEY, {}).catch(() => ({}) as Record<string, unknown>);
  const soMau = Object.keys((docLai.pricing ?? {}) as Record<string, unknown>).length;
  console.log(`\nĐã ghi vào settings["${AI_CONFIG_KEY}"] — đọc lại thấy ${soMau} khoá giá, phiên bản "${String(docLai.pricingVersion ?? "")}".`);
  if (soMau === 0) {
    console.error("⛔ ĐỌC LẠI KHÔNG THẤY GIÁ NÀO — đừng tin dòng trên, đi kiểm lại đường ghi settings.");
    process.exit(1);
  }
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });

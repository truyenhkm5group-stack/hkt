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
import { buildVndPricing, pricingVersionLabel, MODEL_PRICE_SOURCE_DATE, MODEL_USD_PRICES } from "@/lib/constants/ai-model-pricing";

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

      --model="gpt-5.6-luna:0.25/2"     (USD vào / USD ra, mỗi TRIỆU token)

    Vì sao phải có đường này: bảng trong kho mã chỉ chép giá các mô hình Claude, còn ERP đang chạy
    AI Copilot trên OpenAI (`gpt-5.6-*`). Không có giá thì chi phí mọi lượt gọi là CHƯA BIẾT —
    đúng luật, nhưng vô dụng khi cần biết một hội thoại tốn bao nhiêu.

    Và KHÔNG chép đại một con số vào kho mã: đơn giá là thứ nhà cung cấp công bố và đổi theo thời
    gian. Chủ shop đọc bảng giá hiện hành rồi khai — con số vào CSDL kèm nhãn phiên bản, truy được
    về ngày khai.
  */
  const khaiThem: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> = {};
  for (const a of process.argv.filter((x) => x.startsWith("--model="))) {
    const raw = a.slice("--model=".length);
    const m = raw.match(/^(.+):([0-9.]+)\/([0-9.]+)$/);
    if (!m) { console.error(`--model sai dạng: "${raw}". Đúng dạng: --model="ten-mo-hinh:<usd-vao>/<usd-ra>"`); process.exit(1); }
    const vao = Number(m[2]);
    const ra = Number(m[3]);
    if (!Number.isFinite(vao) || !Number.isFinite(ra) || vao < 0 || ra < 0) { console.error(`Đơn giá phải là số không âm: "${raw}"`); process.exit(1); }
    khaiThem[m[1]] = { inputUsdPerMillion: vao, outputUsdPerMillion: ra };
  }

  const pricing = buildVndPricing(tyGia);
  for (const [model, usd] of Object.entries(khaiThem)) {
    pricing[model] = {
      inputVndPerMillion: Math.round(usd.inputUsdPerMillion * tyGia),
      outputVndPerMillion: Math.round(usd.outputUsdPerMillion * tyGia),
    };
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

  const hienTai = await getSettingJson<Record<string, unknown>>("ai", {}).catch(() => ({}) as Record<string, unknown>);
  await setSettingJson("ai", { ...hienTai, pricing, pricingVersion });
  console.log("\nĐã ghi vào settings.ai. Từ giờ mọi lượt gọi mô hình đều tính được tiền.");
}

main().catch((e) => { console.error("HỎNG:", (e as Error).message); process.exit(1); });

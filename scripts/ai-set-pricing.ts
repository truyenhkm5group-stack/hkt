/**
 * KHAI BẢNG GIÁ MÔ HÌNH cho nền tảng AI (ghi vào `settings`, khoá `ai`).
 *
 *   npx tsx scripts/ai-set-pricing.ts --usd-vnd=26000
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

  const pricing = buildVndPricing(tyGia);
  const pricingVersion = pricingVersionLabel(tyGia);

  console.log(`\nGiá gốc chép ngày ${MODEL_PRICE_SOURCE_DATE} · tỷ giá ${tyGia.toLocaleString("vi-VN")} đ/USD`);
  for (const [model, usd] of Object.entries(MODEL_USD_PRICES)) {
    const v = pricing[model];
    console.log(`  ${model.padEnd(20)} vào ${usd.inputUsdPerMillion}$ → ${v.inputVndPerMillion.toLocaleString("vi-VN")}đ · ra ${usd.outputUsdPerMillion}$ → ${v.outputVndPerMillion.toLocaleString("vi-VN")}đ (mỗi triệu token)`);
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

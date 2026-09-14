/**
 * NHẬP BẢNG SỐ ĐO THẬT cho máy gợi ý size.
 *
 *   npx tsx scripts/import-size-rules.ts --template        # in mẫu JSON để điền
 *   npx tsx scripts/import-size-rules.ts --stdin           # CHẠY THỬ: kiểm tra rồi in kết quả
 *   npx tsx scripts/import-size-rules.ts --stdin --apply   # ghi thật vào settings["ai.sizeRules"]
 *
 * Vì sao có script riêng thay vì dùng thẳng ops `set-setting`: `set-setting` ghi JSON thô, không
 * kiểm gì. Một bảng số đo sai — khoảng lộn đầu đuôi, hai size chồng nhau toàn phần, phạm vi trỏ vào
 * mã sản phẩm không tồn tại — sẽ không báo lỗi lúc ghi mà báo bằng những gợi ý size sai cho khách
 * thật. Script này kiểm trước, và MẶC ĐỊNH CHẠY THỬ.
 *
 * KHÔNG tự tạo bảng mẫu nào. Không có dữ liệu thật thì máy vẫn trả SIZE_DATA_MISSING và chuyển
 * người — đó là hành vi đúng, không phải một chỗ cần vá cho xong.
 */
import "dotenv/config";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { FABRIC_STRETCH, SIZE_RULES_KEY, SIZE_SCOPES, recommendSize, resolveSizeRule, type SizeRule } from "@/lib/constants/size-engine";
import { getSettingJson, setSettingJson } from "@/lib/settings";

const rangeSchema = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { message: "Khoảng phải là [nhỏ, lớn] — viết ngược là bảng sai" });

const rowSchema = z.object({
  size: z.string().trim().min(1, "Mỗi dòng phải có tên size"),
  heightCm: rangeSchema.optional(),
  weightKg: rangeSchema.optional(),
  bustCm: rangeSchema.optional(),
  waistCm: rangeSchema.optional(),
  hipCm: rangeSchema.optional(),
});

const ruleSchema = z
  .object({
    version: z.string().trim().min(1, "Bảng phải có tên phiên bản"),
    scope: z.enum(SIZE_SCOPES),
    key: z.string().trim().optional(),
    fabricStretch: z.enum(FABRIC_STRETCH).optional(),
    rows: z.array(rowSchema).min(1, "Bảng phải có ít nhất một dòng size"),
    note: z.string().trim().max(300).optional(),
  })
  .refine((rule) => rule.scope === "GLOBAL" || Boolean(rule.key), {
    message: "Phạm vi khác GLOBAL bắt buộc có `key` (mã mẫu mã / mã sản phẩm / tên nhóm hàng)",
  })
  .refine((rule) => rule.rows.some((row) => row.heightCm || row.weightKg || row.bustCm || row.waistCm || row.hipCm), {
    message: "Bảng không có một khoảng số đo nào thì không gợi ý được gì — đó không phải bảng số đo",
  });

const payloadSchema = z.object({ version: z.string().trim().min(1), rules: z.array(ruleSchema).min(1) });

const TEMPLATE = {
  version: "2026-09",
  rules: [
    {
      version: "dam-suong-2026-09",
      scope: "PRODUCT",
      key: "<mã sản phẩm ERP — lấy ở /products>",
      fabricStretch: "LOW",
      note: "Vải không co giãn, khách thích mặc ôm thì lùi một size",
      rows: [
        { size: "M", heightCm: [150, 160], weightKg: [45, 52], bustCm: [82, 86], waistCm: [64, 68], hipCm: [88, 92] },
        { size: "L", heightCm: [158, 168], weightKg: [53, 60], bustCm: [87, 91], waistCm: [69, 73], hipCm: [93, 97] },
      ],
    },
  ],
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (process.argv.includes("--template")) {
    console.log(JSON.stringify(TEMPLATE, null, 2));
    console.log("\n# Phạm vi: VARIANT (mã mẫu mã) · PRODUCT (mã sản phẩm) · FAMILY (chữ đầu mã hàng, vd Q) · GLOBAL");
    console.log("# HẸP THẮNG RỘNG: có bảng theo sản phẩm thì bảng GLOBAL không được dùng cho sản phẩm đó.");
    console.log("# Độ co giãn: NONE · LOW · MEDIUM · HIGH. Mọi khoảng đều là [nhỏ, lớn] và bao gồm hai đầu.");
    return;
  }

  const raw = process.argv.includes("--stdin") ? await readStdin() : "";
  if (!raw.trim()) {
    console.log("Chưa có dữ liệu. Dùng --template để lấy mẫu, rồi truyền JSON qua --stdin.");
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    console.error("✗ JSON không đọc được:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const parsed = payloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.error("✗ Bảng số đo không hợp lệ:");
    for (const issue of parsed.error.issues) console.error(`  · ${issue.path.join(".") || "(gốc)"}: ${issue.message}`);
    process.exit(1);
  }
  const payload = parsed.data as { version: string; rules: SizeRule[] };

  await ensureMigrated();
  const db = await getDb();

  // ĐỐI CHIẾU VỚI DỮ LIỆU THẬT: phạm vi trỏ vào mã không tồn tại là bảng sẽ không bao giờ được dùng.
  const productKeys = payload.rules.filter((r) => r.scope === "PRODUCT").map((r) => r.key ?? "");
  const variantKeys = payload.rules.filter((r) => r.scope === "VARIANT").map((r) => r.key ?? "");
  const warnings: string[] = [];
  if (productKeys.length) {
    const found = await db.select({ id: schema.products.id }).from(schema.products).where(inArray(schema.products.id, productKeys));
    const missing = productKeys.filter((k) => !found.some((f) => f.id === k));
    for (const key of missing) warnings.push(`Phạm vi PRODUCT trỏ vào mã sản phẩm không có trong ERP: ${key}`);
  }
  if (variantKeys.length) {
    const found = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(inArray(schema.productVariants.id, variantKeys));
    const missing = variantKeys.filter((k) => !found.some((f) => f.id === k));
    for (const key of missing) warnings.push(`Phạm vi VARIANT trỏ vào mã mẫu mã không có trong ERP: ${key}`);
  }

  // Hai size chồng nhau TOÀN PHẦN thì mọi số đo rơi vào đó đều ra AMBIGUOUS — bảng vô dụng mà im lặng.
  for (const rule of payload.rules) {
    for (let i = 0; i < rule.rows.length; i += 1) {
      for (let j = i + 1; j < rule.rows.length; j += 1) {
        const a = rule.rows[i];
        const b = rule.rows[j];
        const same = (["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const).every(
          (k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null),
        );
        if (same) warnings.push(`Bảng ${rule.version}: size ${a.size} và ${b.size} có khoảng giống hệt nhau — mọi số đo sẽ ra "nhiều size cùng khớp"`);
      }
    }
  }

  console.log(`\nBảng số đo: phiên bản ${payload.version} · ${payload.rules.length} bảng`);
  for (const rule of payload.rules) {
    console.log(`  · ${rule.version} · phạm vi ${rule.scope}${rule.key ? ` (${rule.key})` : ""} · ${rule.rows.length} size${rule.fabricStretch ? ` · co giãn ${rule.fabricStretch}` : ""}`);
  }

  // Chạy thử chính máy gợi ý trên một bộ số đo lấy từ hàng đầu tiên — bảng phải tự kết luận được.
  const first = payload.rules[0];
  const probe = first.rows[0];
  const sample = {
    heightCm: probe.heightCm ? (probe.heightCm[0] + probe.heightCm[1]) / 2 : null,
    weightKg: probe.weightKg ? (probe.weightKg[0] + probe.weightKg[1]) / 2 : null,
    bustCm: probe.bustCm ? (probe.bustCm[0] + probe.bustCm[1]) / 2 : null,
    waistCm: probe.waistCm ? (probe.waistCm[0] + probe.waistCm[1]) / 2 : null,
    hipCm: probe.hipCm ? (probe.hipCm[0] + probe.hipCm[1]) / 2 : null,
  };
  const check = recommendSize(resolveSizeRule(payload.rules, { productId: first.key, variantId: first.key, family: first.key }), sample);
  console.log(`\nChạy thử giữa dải size ${probe.size}: ra ${check.code}${check.size ? ` → ${check.size}` : ""} (${check.reason})`);
  if (check.code !== "OK") warnings.push(`Số đo giữa dải của chính size ${probe.size} mà không ra OK — bảng nhiều khả năng có lỗi`);

  if (warnings.length) {
    console.log("\n⚠ CẢNH BÁO:");
    for (const w of warnings) console.log(`  · ${w}`);
  }

  if (!process.argv.includes("--apply")) {
    const current = await getSettingJson<{ version: string; rules: SizeRule[] }>(SIZE_RULES_KEY, { version: "", rules: [] });
    console.log(`\nCHẠY THỬ — chưa ghi gì. Hiện tại trong ERP: ${current.rules?.length ?? 0} bảng (phiên bản "${current.version || "chưa có"}").`);
    console.log("Thêm --apply để ghi thật.");
    return;
  }
  if (warnings.length && !process.argv.includes("--force")) {
    console.error("\n✗ DỪNG: có cảnh báo ở trên. Sửa rồi chạy lại, hoặc thêm --force nếu đã đọc và chấp nhận.");
    process.exit(1);
  }

  await setSettingJson(SIZE_RULES_KEY, payload);
  console.log(`\n✓ Đã ghi ${payload.rules.length} bảng vào settings["${SIZE_RULES_KEY}"].`);
  console.log("Từ giờ máy gợi ý size dùng bảng này; mẫu nào không có bảng vẫn trả SIZE_DATA_MISSING và chuyển người.");
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

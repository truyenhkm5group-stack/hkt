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
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { SIZE_RULES_KEY, recommendSize, resolveSizeRule, type SizeRule } from "@/lib/constants/size-engine";
import { allKeysOf, sizePayloadSchema } from "@/lib/constants/size-rules-payload";
import { getSettingJson, setSettingJson } from "@/lib/settings";

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

/** In các tiền tố mã hàng đang có, để người khai biết điền gì vào phạm vi FAMILY. */
async function inPrefixes(db: Awaited<ReturnType<typeof getDb>>) {
  const rows = await db
    .select({ code: schema.products.customId, name: schema.products.name })
    .from(schema.products)
    .where(eq(schema.products.isRemoved, false));
  const nhom = new Map<string, { n: number; vd: string[] }>();
  for (const r of rows) {
    const m = /^([A-Za-z]{1,2})\d{3}$/.exec((r.code ?? "").trim());
    if (!m) continue;
    const k = m[1].toUpperCase();
    const cur = nhom.get(k) ?? { n: 0, vd: [] };
    cur.n += 1;
    if (cur.vd.length < 3) cur.vd.push(`${r.code} ${r.name}`.slice(0, 44));
    nhom.set(k, cur);
  }
  console.error("\nTiền tố mã hàng đang có trong ERP:");
  if (!nhom.size) console.error("    (chưa có mã hàng nào dạng <chữ><3 số> — kiểm tra lại danh mục)");
  for (const [k, v] of [...nhom].sort((a, b) => b[1].n - a[1].n)) {
    console.error(`    ${k} — ${v.n} sản phẩm · ${v.vd.join(" | ")}`);
  }
}

/** Sản phẩm mà một phạm vi thật sự khớp, kèm các tên size đang có của chúng. */
async function sanPhamKhop(
  db: Awaited<ReturnType<typeof getDb>>,
  scope: string,
  keys: string[],
): Promise<{ products: string[]; sizes: string[] }> {
  const all = await db
    .select({ id: schema.products.id, code: schema.products.customId, name: schema.products.name })
    .from(schema.products)
    .where(eq(schema.products.isRemoved, false));
  const ks = keys.map((k) => k.trim().toUpperCase()).filter(Boolean);
  const hit = all.filter((p2) => {
    if (scope === "GLOBAL") return true;
    // PRODUCT khớp id nội bộ HOẶC mã hàng của shop — cùng luật với `resolveSizeRule`.
    if (scope === "PRODUCT") return ks.includes(p2.id.toUpperCase()) || ks.includes((p2.code ?? "").trim().toUpperCase());
    if (scope === "FAMILY") {
      const fam = /^([A-Za-z]{1,2})\d{3}$/.exec((p2.code ?? "").trim())?.[1]?.toUpperCase();
      return Boolean(fam && ks.includes(fam));
    }
    return false; // VARIANT tra ở bảng mẫu mã, đã có phép kiểm riêng bên trên
  });
  if (!hit.length) return { products: [], sizes: [] };
  const sizes = await db
    .select({ size: schema.productVariants.size })
    .from(schema.productVariants)
    .where(inArray(schema.productVariants.productId, hit.map((h) => h.id)));
  const tenSize = [...new Set(sizes.map((r) => (r.size ?? "").trim()).filter(Boolean))].sort();
  return { products: hit.map((h) => `${h.code ?? "?"} ${h.name}`.slice(0, 40)), sizes: tenSize };
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

  const parsed = sizePayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.error("✗ Bảng số đo không hợp lệ:");
    for (const issue of parsed.error.issues) console.error(`  · ${issue.path.join(".") || "(gốc)"}: ${issue.message}`);
    process.exit(1);
  }
  const payload = parsed.data as { version: string; rules: SizeRule[] };

  await ensureMigrated();
  const db = await getDb();

  // ĐỐI CHIẾU VỚI DỮ LIỆU THẬT: phạm vi trỏ vào mã không tồn tại là bảng sẽ không bao giờ được dùng.
  // Đọc CẢ `key` lẫn `keys`: bỏ sót `keys` thì phép đối chiếu với ERP im lặng bỏ qua đúng những
  // bảng khai theo lối mới, tức là bỏ qua tất cả.
  const productKeys = payload.rules.filter((r) => r.scope === "PRODUCT").flatMap(allKeysOf);
  const variantKeys = payload.rules.filter((r) => r.scope === "VARIANT").flatMap(allKeysOf);
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

  /*
    KHOÁ CÒN LÀ CHỖ ĐIỀN ⇒ DỪNG HẲN, không phải cảnh báo.

    Một bảng mang khoá giữ chỗ vẫn qua được mọi phép kiểm khác, vẫn ghi được vào settings, và vẫn
    im lặng không bao giờ khớp mẫu nào — máy tiếp tục trả SIZE_DATA_MISSING y như lúc chưa khai
    bảng. Người khai sẽ tưởng đã xong. Đó là kiểu hỏng tệ nhất: tốn công mà không đổi gì, và không
    có dấu hiệu nào.
  */
  for (const rule of payload.rules) {
    const choDien = allKeysOf(rule).find((k) => k.includes("ĐIỀN"));
    if (choDien) {
      console.error(`✗ Bảng ${rule.version} còn khoá giữ chỗ "${choDien}" — điền mã hàng thật rồi chạy lại.`);
      console.error("  Danh sách tiền tố đang có trong ERP được in ở phần ĐỘ PHỦ bên dưới khi chạy thử một bảng hợp lệ.");
      await inPrefixes(db);
      process.exit(1);
    }
  }

  /*
    CHỒNG MỘT PHẦN — phép kiểm cũ chỉ bắt được khoảng GIỐNG HỆT.

    Bảng nam là ma trận cao × nặng rã thành ô, nên hai dải chiều cao viết liền nhau rất dễ dính
    nhau ở đúng một giá trị (1m78–1m80 và 1m80–1m85 cùng chứa 180). Mọi khách rơi đúng vào giá trị
    ấy sẽ ra AMBIGUOUS và bị chuyển người — an toàn, nhưng im lặng. In ra ĐÚNG khoảng bị chồng để
    người khai quyết định, thay vì tự sửa hộ: 180cm nên là M hay L là quyết định của shop.
  */
  const DIMS = ["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const;
  const giao = (a?: [number, number], b?: [number, number]): [number, number] | null => {
    // Chiều không ràng buộc ở một bên = bên đó phủ mọi giá trị, nên vẫn giao nhau.
    if (!a && !b) return null;
    if (!a || !b) return a ?? b ?? null;
    const lo = Math.max(a[0], b[0]);
    const hi = Math.min(a[1], b[1]);
    return lo <= hi ? [lo, hi] : null;
  };
  for (const rule of payload.rules) {
    for (let i = 0; i < rule.rows.length; i += 1) {
      for (let j = i + 1; j < rule.rows.length; j += 1) {
        const a = rule.rows[i];
        const b = rule.rows[j];
        if (a.size === b.size) continue; // cùng size thì chồng nhau vô hại
        const parts: string[] = [];
        let chongMoiChieu = true;
        for (const k of DIMS) {
          if (!a[k] && !b[k]) continue;
          const g = giao(a[k], b[k]);
          if (!g) { chongMoiChieu = false; break; }
          parts.push(`${k} ${g[0]}–${g[1]}`);
        }
        if (chongMoiChieu && parts.length) {
          warnings.push(`Bảng ${rule.version}: size ${a.size} và ${b.size} chồng nhau tại ${parts.join(" · ")} — mọi khách rơi vào đó sẽ bị chuyển người (AMBIGUOUS)`);
        }
      }
    }
  }

  /*
    ĐỘ PHỦ THẬT: bảng này áp cho SẢN PHẨM NÀO, và những sản phẩm ấy có ĐÚNG các size trong bảng không.

    Đây là phép kiểm đắt giá nhất, vì nó bắt được kiểu hỏng không lộ ra ở đâu khác: bảng ghi "XXL"
    trong khi ERP lưu mẫu mã là "2XL". Máy sẽ kết luận size XXL rất tự tin, rồi bước chốt mẫu mã
    không tìm thấy mẫu nào tên XXL — hội thoại chết ở một chỗ khác hẳn, và không ai lần ngược về
    được tới bảng số đo.
  */
  for (const rule of payload.rules) {
    const matched = await sanPhamKhop(db, rule.scope, allKeysOf(rule));
    const tenSize = [...new Set(rule.rows.map((r) => r.size.trim().toUpperCase()))];
    console.log(`
  ĐỘ PHỦ bảng ${rule.version} (${rule.label || rule.version} · ${rule.scope} · ${allKeysOf(rule).join(", ") || "chưa gán mã nào"}): ${matched.products.length} sản phẩm`);
    if (!matched.products.length) {
      warnings.push(`Bảng ${rule.version} KHÔNG khớp sản phẩm nào trong ERP — nó sẽ không bao giờ được dùng`);
    } else {
      console.log(`    ${matched.products.slice(0, 6).join(" · ")}${matched.products.length > 6 ? ` … +${matched.products.length - 6}` : ""}`);
      console.log(`    size trong ERP: ${matched.sizes.join(" · ") || "(mẫu mã chưa có tên size)"}`);
      console.log(`    size trong bảng: ${tenSize.join(" · ")}`);
      const thieuTrongErp = tenSize.filter((s2) => !matched.sizes.some((e) => e.toUpperCase() === s2));
      const thieuTrongBang = matched.sizes.filter((e) => !tenSize.includes(e.toUpperCase()));
      for (const s2 of thieuTrongErp) {
        warnings.push(`Bảng ${rule.version}: size "${s2}" KHÔNG có mẫu mã nào mang tên đó trong ERP — máy sẽ gợi ý một size không bán được`);
      }
      if (thieuTrongBang.length) {
        console.log(`    ⓘ size có hàng nhưng bảng chưa phủ: ${thieuTrongBang.join(" · ")} — khách hợp size đó sẽ bị chuyển người`);
      }
    }
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

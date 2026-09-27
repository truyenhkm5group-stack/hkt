import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertHomeCredentials, homeCheckNeeded } from "@/lib/platform/credentials";

/**
 * Cầu nối mở PR (`agent-open-pr.yml`) chạy trên GitHub Actions, KHÔNG có CSDL, và gọi
 * `assertHomeCredentials("github")`. Từ #314 hàm ấy hỏi `currentOrganization()` ⇒ đọc tổ chức nhà từ
 * CSDL ⇒ ném "Chưa cấu hình DATABASE_URL" ⇒ MỌI lượt mở PR của kho đỏ (đo 27/09/2026, run 36308583973).
 *
 * Luật: tiến trình không có CSDL không phục vụ được tổ chức nào nên không có gì để chặn — TRỪ khi có
 * ngữ cảnh tường minh. Có CSDL thì luôn kiểm đủ.
 */
export async function testPlatformCredentialsNoDb() {
  const nha = { code: "vnx", isHome: true, source: "EXPLICIT" as const };
  const khac = { code: "b", isHome: false, source: "EXPLICIT" as const };
  assert.equal(homeCheckNeeded(null, false), false, "không CSDL, không ngữ cảnh ⇒ không có tổ chức nào để chặn");
  assert.equal(homeCheckNeeded(null, true), true, "có CSDL ⇒ luôn hỏi ngữ cảnh (request thật của ứng dụng)");
  assert.equal(homeCheckNeeded(khac, false), true, "ngữ cảnh tường minh của tổ chức KHÁC ⇒ vẫn kiểm dù không có CSDL");
  assert.equal(homeCheckNeeded(nha, false), true);

  // Đúng tình huống của CI: bỏ DATABASE_URL ⇒ lời gọi của cầu nối KHÔNG được ném.
  const cu = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    await assertHomeCredentials("github");
  } finally {
    if (cu === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = cu;
  }

  // Mã nguồn: phép miễn đứng TRƯỚC lời hỏi ngữ cảnh, và chỉ dựa trên hàm thuần ở trên.
  const src = readFileSync(path.join(process.cwd(), "lib/platform/credentials.ts"), "utf8");
  const than = src.slice(src.indexOf("export async function assertHomeCredentials"), src.indexOf("export function homeCheckNeeded"));
  assert.ok(than.indexOf("homeCheckNeeded(") >= 0 && than.indexOf("homeCheckNeeded(") < than.indexOf("currentOrganization("), "phép miễn phải đứng trước currentOrganization()");

  console.log("✓ Nền tảng: tiến trình KHÔNG có CSDL (cầu nối mở PR) không bị chặn vì thiếu sổ tổ chức; ngữ cảnh tường minh vẫn kiểm");
}

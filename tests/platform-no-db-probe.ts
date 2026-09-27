/**
 * Chạy trong tiến trình con KHÔNG có `DATABASE_URL` — đúng môi trường của máy GitHub Actions khi cầu
 * nối mở PR (`scripts/agent-open-pr.ts`) gọi client GitHub. Được `tests/platform-no-db.test.ts` gọi;
 * không phải một bài kiểm độc lập.
 */
import { SignJWT } from "jose";
import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { currentOrganization, setSessionTokenSourceForTests } from "@/lib/platform/context";

async function main() {
  if (process.env.DATABASE_URL) throw new Error("probe phải chạy KHÔNG có DATABASE_URL");
  const ctx = await currentOrganization();
  if (!ctx.isHome) throw new Error("không phiên, không ngữ cảnh ⇒ phải là nhà");
  await assertHomeCredentials("github");
  console.log("NHA_OK");

  // Phiên mang claim tổ chức KHÁC: không đọc được sổ ⇒ phải NÉM, không bao giờ rơi về nhà.
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ org: "to-chuc-khac" }).setProtectedHeader({ alg: "HS256" }).setSubject("u").setIssuedAt(now).setExpirationTime(now + 600).sign(new TextEncoder().encode(env.authSecret));
  setSessionTokenSourceForTests(async () => token);
  try {
    await assertHomeCredentials("github");
    console.log("KHAC_LOT");
  } catch {
    console.log("KHAC_CHAN");
  } finally {
    setSessionTokenSourceForTests(null);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

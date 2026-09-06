import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Health check. Ngoài việc chứng minh tiến trình sống và CSDL kết nối được, còn trả về
 * commit đang chạy để đối chiếu Production với Git — "deploy xanh" không chứng minh được
 * máy chủ đang chạy đúng bản nào. ERP_COMMIT do scripts/install-vps.sh ghi vào .env khi deploy.
 */
export async function GET() {
  const version = {
    commit: process.env.ERP_COMMIT || "unknown",
    branch: process.env.ERP_BRANCH_NAME || "unknown",
  };
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, time: new Date().toISOString(), ...version });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error), ...version }, { status: 500 });
  }
}

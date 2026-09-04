import { ensureMigrated } from "@/db/migrate";
import { ensureAdminUser } from "@/lib/auth/bootstrap";

if (process.env.SKIP_AUTO_MIGRATE !== "1") {
  ensureMigrated()
    .then(() => ensureAdminUser())
    .catch((error) => {
      console.error("[startup] Không thể khởi tạo cơ sở dữ liệu:", error instanceof Error ? error.message : error);
    });
}

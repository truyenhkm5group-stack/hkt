/** Tạo tài khoản quản trị từ ADMIN_EMAIL / ADMIN_PASSWORD nếu chưa có người dùng nào. */
import "dotenv/config";
import { ensureMigrated } from "@/db/migrate";
import { ensureAdminUser } from "@/lib/auth/bootstrap";

ensureMigrated()
  .then(() => ensureAdminUser())
  .then((created) => {
    console.log(created ? "Đã tạo tài khoản quản trị." : "Đã có người dùng, bỏ qua.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

/** Chạy một lần khi server khởi động (chỉ runtime Node.js): áp dụng migration và tạo tài khoản quản trị nếu chưa có. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}

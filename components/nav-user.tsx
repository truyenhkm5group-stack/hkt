"use client";

import Link from "next/link";
import { LifeBuoy, LogOut, Moon, ReceiptText, Sun, Monitor, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import type { Role } from "@/db/schema";
import { logoutAction } from "@/lib/actions/auth";
import { initials } from "@/lib/format";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABEL } from "@/lib/constants/roles";

/**
 * Nút tài khoản trên thanh menu viên thuốc: chỉ còn ảnh đại diện tròn. Tên, vai trò và email hiện
 * khi rê chuột (`title`) và ở đầu menu thả xuống — thanh menu nằm ngang không có chỗ cho hai dòng chữ.
 */
export function NavUser({ user, hidePayslip = false }: { user: { name: string; email: string; role: Role }; /** Vỏ app Chốt Đơn: không có Lương, trang phiếu lương bị chặn ở máy chủ — không đặt lối cụt. */ hidePayslip?: boolean }) {
  const { setTheme, theme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${user.name} · ${ROLE_LABEL[user.role]}`}
          aria-label={`Tài khoản: ${user.name}`}
          className="flex size-10 shrink-0 items-center justify-center rounded-full outline-none transition-shadow hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-border"
        >
          <Avatar className="size-9">
            <AvatarFallback className="bg-muted text-xs font-bold text-foreground">{initials(user.name) || "U"}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 rounded-2xl p-1.5" side="bottom" align="end" sideOffset={8}>
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-semibold">{user.name}</p>
          <p className="text-xs text-muted-foreground">{ROLE_LABEL[user.role]} · {user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Mọi tài khoản đều thấy: trang tự phục vụ (đổi mật khẩu) chỉ cần đăng nhập — trước đây chỉ người có
            users:manage mới tới được nó (nút trên trang Người dùng). */}
        <DropdownMenuItem asChild>
          <Link href="/settings/profile">
            <UserRound className="size-4" /> Tài khoản của tôi
          </Link>
        </DropdownMenuItem>
        {/* Mọi tài khoản đều thấy: phiếu lương gửi riêng từng người, cổng là quyền sở hữu phiếu. */}
        {hidePayslip ? null : (
          <DropdownMenuItem asChild>
            <Link href="/my-payslip">
              <ReceiptText className="size-4" /> Phiếu lương của tôi
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href="/help">
            <LifeBuoy className="size-4" /> Hướng dẫn sử dụng
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Giao diện</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="size-4" /> Sáng {theme === "light" ? "✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="size-4" /> Tối {theme === "dark" ? "✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="size-4" /> Theo hệ thống {theme === "system" ? "✓" : ""}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => logoutAction()} className="text-destructive focus:text-destructive">
          <LogOut className="size-4" /> Đăng xuất
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

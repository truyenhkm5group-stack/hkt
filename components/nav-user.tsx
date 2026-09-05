"use client";

import { ChevronsUpDown, LogOut, Moon, Sun, Monitor } from "lucide-react";
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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { ROLE_LABEL } from "@/lib/constants/roles";


export function NavUser({ user }: { user: { name: string; email: string; role: Role } }) {
  const { isMobile } = useSidebar();
  const { setTheme, theme } = useTheme();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="rounded-lg data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-primary text-xs font-bold text-primary-foreground">{initials(user.name) || "U"}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{user.name}</span>
                <span className="truncate text-[11px] text-sidebar-foreground/55">{ROLE_LABEL[user.role]} · {user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/55" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60 rounded-lg" side={isMobile ? "bottom" : "right"} align="end" sideOffset={6}>
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-semibold">{user.name}</p>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </DropdownMenuLabel>
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
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

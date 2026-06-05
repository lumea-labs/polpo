"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Menu } from "@base-ui/react/menu";
import { User, UserCircle, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth-client";

interface UserMenuProps {
  userEmail: string;
  userImage?: string;
}

export function UserMenu({ userEmail, userImage }: UserMenuProps) {
  const router = useRouter();

  const initials = userEmail
    ? userEmail.split("@")[0].slice(0, 2).toUpperCase()
    : "";

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Account menu"
        data-testid="user-menu-trigger"
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary text-xs font-medium text-muted-foreground transition-colors hover:text-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {userImage ? (
          <Image
            src={userImage}
            alt={userEmail || "User"}
            width={32}
            height={32}
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : initials ? (
          initials
        ) : (
          <User className="h-4 w-4" />
        )}
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="isolate z-50">
          <Menu.Popup
            data-testid="user-menu"
            className="min-w-[200px] origin-(--transform-origin) rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <Menu.Item
              render={
                <Link
                  href="/account"
                  data-testid="user-menu-profile"
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none cursor-pointer text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                />
              }
            >
              <UserCircle className="h-4 w-4" strokeWidth={1.5} />
              Profile
            </Menu.Item>

            <Menu.Item
              onClick={handleSignOut}
              data-testid="user-menu-signout"
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none cursor-pointer text-muted-foreground data-highlighted:bg-secondary data-highlighted:text-foreground"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.5} />
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

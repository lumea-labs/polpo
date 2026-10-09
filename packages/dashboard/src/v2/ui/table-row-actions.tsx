"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  CircleNotch,
  DotsThree,
} from "@phosphor-icons/react/dist/ssr";
import { cn } from "../utils.js";

export function TableRowActions({
  label = "Row actions",
  busy = false,
  disabled = false,
  children,
}: {
  label?: string;
  busy?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <span
        onMouseDownCapture={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Menu.Trigger
          aria-label={label}
          title={label}
          disabled={disabled || busy}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 data-popup-open:bg-secondary data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? (
            <CircleNotch size={14} className="animate-spin" />
          ) : (
            <DotsThree size={17} weight="bold" />
          )}
        </Menu.Trigger>
      </span>

      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={4}
          className="isolate z-50"
        >
          <Menu.Popup
            onClick={(event) => event.stopPropagation()}
            className="v2 min-w-36 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function TableRowAction({
  icon,
  children,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  icon?: ReactNode;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] outline-none data-highlighted:bg-secondary data-disabled:pointer-events-none data-disabled:opacity-40",
        destructive
          ? "text-destructive data-highlighted:bg-destructive/10"
          : "text-foreground",
      )}
    >
      {icon ? (
        <span className={destructive ? "text-destructive" : "text-muted-foreground"}>
          {icon}
        </span>
      ) : null}
      {children}
    </Menu.Item>
  );
}

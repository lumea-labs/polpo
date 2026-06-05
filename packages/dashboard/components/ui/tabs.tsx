"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "#/lib/utils";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "relative flex w-full items-center gap-1 overflow-x-auto border-b border-border scrollbar-none",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        // base
        "relative inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm text-muted-foreground transition-colors outline-none cursor-pointer",
        // hover
        "hover:text-foreground",
        // active
        "data-[selected]:text-foreground data-[selected]:font-medium",
        // focus
        "focus-visible:text-foreground",
        // disabled
        "disabled:pointer-events-none disabled:opacity-50",
        // active underline (matches NavTabs — foreground, no layout shift)
        "after:absolute after:-bottom-px after:left-0 after:right-0 after:h-[2px] after:bg-foreground after:opacity-0 data-[selected]:after:opacity-100 after:transition-opacity",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("mt-4 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsPanel };

"use client";

import { createContext, use, useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";

interface MobileSidebarCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

const MobileSidebarContext = createContext<MobileSidebarCtx>({
  open: false,
  setOpen: () => {},
  toggle: () => {},
});

export function MobileSidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const toggle = useCallback(() => setOpen((v) => !v), []);

  // Close sidebar on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <MobileSidebarContext.Provider value={{ open, setOpen, toggle }}>
      {children}
    </MobileSidebarContext.Provider>
  );
}

export function useMobileSidebar() {
  return use(MobileSidebarContext);
}

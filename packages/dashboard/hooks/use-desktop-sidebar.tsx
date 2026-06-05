"use client";

import { createContext, use, useState, useCallback, useEffect } from "react";

interface DesktopSidebarCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

const DesktopSidebarContext = createContext<DesktopSidebarCtx>({
  open: true,
  setOpen: () => {},
  toggle: () => {},
});

const STORAGE_KEY = "polpo:sidebar-open";

export function DesktopSidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(true);

  // Hydrate from localStorage after mount (avoid SSR mismatch)
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) setOpenState(stored === "1");
  }, []);

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  }, []);

  const toggle = useCallback(() => {
    setOpenState((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  return (
    <DesktopSidebarContext.Provider value={{ open, setOpen, toggle }}>
      {children}
    </DesktopSidebarContext.Provider>
  );
}

export function useDesktopSidebar() {
  return use(DesktopSidebarContext);
}

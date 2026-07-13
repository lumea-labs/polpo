import type { Metadata } from "next";
import "@polpo-ai/dashboard/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polpo Dashboard",
  description: "Operate a self-hosted Polpo runtime.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { Suspense } from "react";
import { JsonLd } from "@/components/json-ld";
import { GeoToggle } from "@/components/landing/geo-toggle";
import { MachineMode } from "@/components/landing/machine-mode";
import { organizationJsonLd, webSiteJsonLd } from "@/lib/jsonld";
import "./globals.css";

const sans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://polpo.sh"),
  title: "Polpo: The Agent Layer for AI Apps",
  description:
    "Polpo is the agentic cloud runtime for AI apps. Build agents for chat or long-running tasks with persistent memory, tools, and sandboxed execution — one API, any LLM.",
  openGraph: {
    title: "Polpo: The Agent Layer for AI Apps",
    description:
      "Polpo is the agentic cloud runtime for AI apps. Build agents for chat or long-running tasks with persistent memory, tools, and sandboxed execution — one API, any LLM.",
    url: "https://polpo.sh",
    siteName: "Polpo",
    type: "website",
    images: [{ url: "https://polpo.sh/og.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Polpo: The Agent Layer for AI Apps",
    description:
      "Polpo is the agentic cloud runtime for AI apps. Build agents for chat or long-running tasks with persistent memory, tools, and sandboxed execution — one API, any LLM.",
    images: ["https://polpo.sh/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <JsonLd data={organizationJsonLd()} />
        <JsonLd data={webSiteJsonLd()} />
      </head>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
          {children}
          <Suspense fallback={null}>
            <MachineMode />
            <GeoToggle />
          </Suspense>
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}

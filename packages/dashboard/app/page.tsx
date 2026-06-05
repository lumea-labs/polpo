import type { Metadata } from "next";
import { getSession } from "@/lib/auth-server";
import { Navbar } from "@/components/landing/navbar";
import { Hero } from "@/components/landing/hero";
import { HeroTerminal } from "@/components/landing/hero-terminal";
import { SystemOverview } from "@/components/landing/system-overview";
import { FeatureCardsV2 as FeatureCards } from "@/components/landing/feature-cards-v2";
import { HowItWorks } from "@/components/landing/how-it-works";
// import { TrustedBy } from "@/components/landing/trusted-by"; // hidden until more partners sign off
// import { Frameworks } from "@/components/landing/frameworks";
// Frameworks strip is now merged into <SystemOverview />.
import { UseCases } from "@/components/landing/use-cases";
import { FAQs } from "@/components/landing/faqs";
import { CTA } from "@/components/landing/cta";
import { Footer } from "@/components/landing/footer";
import { JsonLd } from "@/components/json-ld";
import { softwareApplicationJsonLd } from "@/lib/jsonld";

export const metadata: Metadata = {
  title: "Polpo: The Agent Layer for AI Apps",
  description:
    "The agentic cloud runtime for AI apps. Build agents for chat or long-running tasks — persistent memory, tools, sandboxed execution, any LLM via one API.",
};

export default async function Home() {
  const session = await getSession();
  const isAuthenticated = !!session;

  return (
    <div className="relative min-h-screen">
      <JsonLd data={softwareApplicationJsonLd()} />
      <Navbar
        isAuthenticated={isAuthenticated}
        userEmail={session?.user?.email ?? ""}
        userImage={session?.user?.image ?? undefined}
      />
      <main>
        <Hero />
        {/* <TrustedBy /> — hidden until more partners sign off */}
        <FeatureCards />
        <HowItWorks />
        <SystemOverview />

        {/* Terminal in its own section — sits after the three deploy steps
            as the "live demo" closer. Full-width top + bottom borders with
            rulers framing, matching the rest of the layout. */}
        <section className="relative border-y border-border">
          <div className="relative mx-auto max-w-[1440px] border-x border-border">
            <HeroTerminal />
          </div>
        </section>

        {/* <CodingAgents /> — hidden for now, keep component for later */}
        {/* <SocialProof /> — hidden until real testimonials */}
        <UseCases />
        <FAQs />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}

/**
 * Demo scenarios for `polpo create` — optional seeded data so a fresh
 * project lands in the dashboard with a working agent, project + agent
 * memory, a single draft task, and a multi-step draft mission ready to
 * run. Picking "none" keeps the legacy behavior (single blank agent).
 *
 * Every scenario keeps the same shape so callers can iterate the seed:
 *   - agent: name + role; tool palette is the default full palette
 *     (see writeBlankScaffold) so we don't duplicate the list here.
 *   - projectMemory / agentMemory: free-form markdown.
 *   - task: a single, standalone task in draft status (no llm_review —
 *     verification is a file_exists check so the demo is deterministic).
 *   - mission: a 4-step graph — brief → research → (spreadsheet || pdf)
 *     where the last two run in parallel because they share dependsOn.
 *
 * Output paths are all under `.polpo/output/<…>` so the agent's
 * sandboxed write tool can hit them without extra config.
 */

export interface ScenarioTask {
  filename: string;          // .polpo/tasks/<filename>.json
  payload: Record<string, unknown>;
}

export interface ScenarioMission {
  filename: string;          // .polpo/missions/<filename>.json
  payload: Record<string, unknown>;
}

export interface Scenario {
  id: "data-analyst" | "marketing-researcher" | "product-manager";
  label: string;
  hint: string;
  agent: { name: string; role: string };
  projectMemory: string;
  agentMemory: string;
  task: ScenarioTask;
  mission: ScenarioMission;
}

// ─── Shared helpers ────────────────────────────────────────────────

function fileExists(path: string) {
  return { type: "file_exists", path };
}

// ─── Scenario A: Data Analyst ──────────────────────────────────────

const dataAnalyst: Scenario = {
  id: "data-analyst",
  label: "Data Analyst",
  hint: "Quarterly KPI review — brief → benchmarks → spreadsheet + PDF",
  agent: {
    name: "analyst",
    role: "Senior data analyst — turns raw datasets into clear, actionable reports for leadership.",
  },
  projectMemory: `# Project — Quarterly KPI Review

Recurring quarterly KPI review for the leadership team.

- **Stakeholders**: CEO, CFO, COO.
- **Cadence**: end of every fiscal quarter.
- **Data sources**: internal CRM exports, revenue dashboard, customer success logs.
- **Key dimensions**: revenue, churn, NPS, CAC, LTV.
- **Output channel**: monthly leadership meeting (PDF brief + spreadsheet appendix).
`,
  agentMemory: `# analyst — personal memory

Style:
- Numbers first, narrative second.
- Always include a "what changed since last quarter" section.
- Default visuals: bar for absolute values, line for trends, table for raw.

Open questions:
- Confirm whether ARR or MRR is the headline metric.
- Validate CAC payback assumption (currently 14 months).
`,
  task: {
    filename: "draft-q1-summary",
    payload: {
      title: "Draft Q1 highlights summary",
      description:
        "Create `.polpo/output/summary.txt` with 5 bullet points covering Q1: " +
        "revenue movement, churn rate, top customer win, biggest risk, recommended action. " +
        "Plain text only — no markdown, no formatting beyond bullets.",
      assignTo: "analyst",
      draft: true,
      expectations: [fileExists(".polpo/output/summary.txt")],
    },
  },
  mission: {
    filename: "quarterly-review",
    payload: {
      name: "Q1 Review",
      status: "draft",
      prompt: "Quarterly KPI review for the leadership team",
      data: {
        tasks: [
          {
            title: "create_brief",
            description:
              "Write `.polpo/output/brief.md` — one-page brief outlining the Q1 review scope, " +
              "the 3-5 key questions leadership wants answered, and the target audience (CEO/CFO/COO).",
            assignTo: "analyst",
            expectations: [fileExists(".polpo/output/brief.md")],
          },
          {
            title: "research_benchmarks",
            description:
              "Using `search_web`, gather 5-7 SaaS industry benchmarks (median churn, CAC payback, LTV/CAC) " +
              "from public sources. Save to `.polpo/output/benchmarks.md` with cited URLs and access dates.",
            assignTo: "analyst",
            dependsOn: ["create_brief"],
            expectations: [fileExists(".polpo/output/benchmarks.md")],
          },
          {
            title: "build_spreadsheet",
            description:
              "Create `.polpo/output/kpis.xlsx` with two sheets. Sheet 1 ('Our Metrics'): placeholder rows for " +
              "revenue, churn, NPS, CAC, LTV (one row per metric, columns: Q4 prev, Q1 current, Δ). " +
              "Sheet 2 ('Industry Benchmark'): pull from benchmarks.md.",
            assignTo: "analyst",
            dependsOn: ["research_benchmarks"],
            expectations: [fileExists(".polpo/output/kpis.xlsx")],
          },
          {
            title: "build_pdf",
            description:
              "Produce `.polpo/output/Q1-executive-summary.pdf` — 1 page max. Pull narrative from brief.md, " +
              "headline numbers from kpis.xlsx, finish with 2-3 takeaway bullets. Visual style: clean, monochrome.",
            assignTo: "analyst",
            dependsOn: ["research_benchmarks"],
            expectations: [fileExists(".polpo/output/Q1-executive-summary.pdf")],
          },
        ],
      },
    },
  },
};

// ─── Scenario B: Marketing Researcher ──────────────────────────────

const marketingResearcher: Scenario = {
  id: "marketing-researcher",
  label: "Marketing Researcher",
  hint: "Launch prep — brief → competitor research → feature matrix + launch deck",
  agent: {
    name: "researcher",
    role: "Marketing researcher — competitive analysis, audience research, and launch briefs.",
  },
  projectMemory: `# Project — Product Launch Marketing

Launch marketing for a new SaaS product.

- **Launch window**: next quarter.
- **Target audience**: technical founders + early-stage CTOs.
- **Channels**: Product Hunt, Hacker News, X, dev.to, founder podcasts.
- **Voice**: technical, no-fluff, builder-to-builder. No marketing buzzwords.
- **Reference**: keep the Linear, Vercel, and Supabase early-launch docs as North Star.
`,
  agentMemory: `# researcher — personal memory

Workflow:
- Start every launch with audience definition before tactics.
- Competitor research captures: features, pricing, positioning, weaknesses.
- Always cite sources with URL + date accessed.
- Output formats: markdown for briefs, xlsx for comparisons, pdf for decks.

Anti-patterns to avoid:
- Generic positioning ("for everyone, everywhere").
- Counting competitors without contrasting against them.
- PDFs longer than 5 pages.
`,
  task: {
    filename: "draft-audience-profile",
    payload: {
      title: "Draft target audience profile",
      description:
        "Create `.polpo/output/audience-profile.txt` covering: 3-sentence persona, " +
        "top 3 pain points, where they hang out online, what they read. Plain text — no markdown.",
      assignTo: "researcher",
      draft: true,
      expectations: [fileExists(".polpo/output/audience-profile.txt")],
    },
  },
  mission: {
    filename: "launch-research",
    payload: {
      name: "Launch Research",
      status: "draft",
      prompt: "Pre-launch competitive + audience research",
      data: {
        tasks: [
          {
            title: "create_brief",
            description:
              "Write `.polpo/output/launch-brief.md` covering: target persona (1 paragraph), " +
              "top 3 customer pains, value proposition hypothesis, success metrics for launch week.",
            assignTo: "researcher",
            expectations: [fileExists(".polpo/output/launch-brief.md")],
          },
          {
            title: "research_competitors",
            description:
              "Using `search_web` and `browser_*`, identify 5-8 direct competitors. " +
              "For each capture: name, pricing tier, killer feature, weakness, primary audience. " +
              "Save to `.polpo/output/competitors.md` with URLs.",
            assignTo: "researcher",
            dependsOn: ["create_brief"],
            expectations: [fileExists(".polpo/output/competitors.md")],
          },
          {
            title: "build_spreadsheet",
            description:
              "Create `.polpo/output/feature-matrix.xlsx` — single sheet. Rows = features (extracted from " +
              "competitors.md), columns = each competitor + 'Us'. Mark ✓/✗/partial per cell. Add a " +
              "'gap analysis' column on the right summarizing where we differentiate.",
            assignTo: "researcher",
            dependsOn: ["research_competitors"],
            expectations: [fileExists(".polpo/output/feature-matrix.xlsx")],
          },
          {
            title: "build_pdf",
            description:
              "Produce `.polpo/output/launch-deck.pdf` — 3 pages: (1) market overview + audience, " +
              "(2) our positioning + 3 differentiators, (3) initial GTM plan (channel, message, week-1 KPIs). " +
              "Pull from launch-brief.md and competitors.md.",
            assignTo: "researcher",
            dependsOn: ["research_competitors"],
            expectations: [fileExists(".polpo/output/launch-deck.pdf")],
          },
        ],
      },
    },
  },
};

// ─── Scenario C: Product Manager ───────────────────────────────────

const productManager: Scenario = {
  id: "product-manager",
  label: "Product Manager",
  hint: "Feature planning — brief → user-needs research → RICE scoring + spec doc",
  agent: {
    name: "pm",
    role: "Product manager — prioritizes feature work, writes specs, tracks user needs.",
  },
  projectMemory: `# Project — Q1 Feature Planning

Feature prioritization and spec writing for the next quarter.

- **Product stage**: early traction, ~50 paying customers.
- **Engineering capacity**: 3 engineers, ~6 weeks effective per quarter.
- **Prioritization framework**: RICE (Reach × Impact × Confidence / Effort).
- **Decision cadence**: one prioritization cycle per quarter, mid-quarter checkpoint.
- **North star metric**: weekly active teams.
`,
  agentMemory: `# pm — personal memory

Default frame:
- Always start from user need, not solution.
- RICE > intuition. Score every candidate before committing.
- Specs include: problem statement, user story, acceptance criteria, out-of-scope, "why now".
- Every decision needs one-line "why now" rationale.

Confidence calibration:
- 100%: validated with 5+ user interviews + analytics signal.
- 80%: validated with 3+ interviews OR strong analytics signal.
- 50%: hypothesis with only anecdotal evidence — needs more data.
`,
  task: {
    filename: "draft-roadmap-notes",
    payload: {
      title: "Draft Q1 roadmap notes",
      description:
        "Create `.polpo/output/roadmap.txt` listing 3 candidate Q1 features. " +
        "One per line, format: `feature name — one-line user benefit`. Plain text.",
      assignTo: "pm",
      draft: true,
      expectations: [fileExists(".polpo/output/roadmap.txt")],
    },
  },
  mission: {
    filename: "q1-planning",
    payload: {
      name: "Q1 Planning",
      status: "draft",
      prompt: "End-to-end Q1 feature prioritization",
      data: {
        tasks: [
          {
            title: "create_brief",
            description:
              "Write `.polpo/output/q1-brief.md` outlining: Q1 goal, primary success metric, " +
              "engineering capacity constraints, and the 5 candidate features under consideration " +
              "(one paragraph each).",
            assignTo: "pm",
            expectations: [fileExists(".polpo/output/q1-brief.md")],
          },
          {
            title: "research_user_needs",
            description:
              "Using `search_web`, find 3-5 public demand signals per candidate (forum posts, X threads, " +
              "GitHub issues, blog comments). Save to `.polpo/output/user-signals.md` grouped by feature, " +
              "with quoted snippets + URLs.",
            assignTo: "pm",
            dependsOn: ["create_brief"],
            expectations: [fileExists(".polpo/output/user-signals.md")],
          },
          {
            title: "build_spreadsheet",
            description:
              "Create `.polpo/output/rice-scoring.xlsx` — single sheet. Columns: Feature, Reach, Impact, " +
              "Confidence, Effort, RICE Score, Notes. One row per candidate, scored using research from " +
              "user-signals.md. Sort by descending RICE.",
            assignTo: "pm",
            dependsOn: ["research_user_needs"],
            expectations: [fileExists(".polpo/output/rice-scoring.xlsx")],
          },
          {
            title: "build_pdf",
            description:
              "Produce `.polpo/output/q1-spec.pdf` — 2-3 pages covering the top-RICE feature only. " +
              "Sections: problem statement, user story, acceptance criteria, out-of-scope, " +
              "one-line 'why now'.",
            assignTo: "pm",
            dependsOn: ["research_user_needs"],
            expectations: [fileExists(".polpo/output/q1-spec.pdf")],
          },
        ],
      },
    },
  },
};

// ─── Registry ──────────────────────────────────────────────────────

export const SCENARIOS: Scenario[] = [dataAnalyst, marketingResearcher, productManager];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

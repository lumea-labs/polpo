import { V2AgentsView, V2PageBody } from "@polpo-ai/dashboard";

export default function AgentsPage() {
  return <V2PageBody><V2AgentsView projectId="local" initialAgents={[]} initialTeams={[]} /></V2PageBody>;
}

import { redirect } from "next/navigation";

/**
 * Single-tenant self-host root. There is no marketing landing or multi-project
 * list here — that lives only in the cloud. Send `/` straight into the local
 * project's dashboard. `local` is a placeholder project id; the data client is
 * single-tenant and ignores it.
 */
export default function Home() {
  redirect("/projects/local/agents");
}

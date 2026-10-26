import { appendFileSync } from "node:fs";
import { FileSessionStore } from "../../../dist/file-session-store.js";
import { SessionTitleCoordinator } from "@polpo-ai/core/session-titles";
const [directory, sessionId, marker] = process.argv.slice(2);
const store = new FileSessionStore(directory);
const coordinator = new SessionTitleCoordinator({ store, emit: async () => {}, generate: async () => {
  appendFileSync(marker, "call\n");
  await new Promise(resolve => setTimeout(resolve, 100));
  return { text: "Generated in a worker" };
} });
await coordinator.run(sessionId);

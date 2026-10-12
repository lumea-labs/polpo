import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps public MCP client metadata typed and reusable without accepting a returned secret", () => {
  const filename = fileURLToPath(new URL("./mcp-client-consumer.ts", import.meta.url));
  const source = `
    import type { CloudMcpOAuthConfiguration, ConfigureMcpOAuthRequest } from "../client/index.js";
    declare const configuration: CloudMcpOAuthConfiguration;
    if (configuration.registration.mode === "pre_registered") {
      const id: string = configuration.registration.client.client_id;
      const issuedAt: number | undefined = configuration.registration.client.client_id_issued_at;
      const expiresAt: number | undefined = configuration.registration.client.client_secret_expires_at;
      const secret: undefined = configuration.registration.client.client_secret;
      const update: ConfigureMcpOAuthRequest["registration"] = configuration.registration;
    }
    type PublicClient = Extract<CloudMcpOAuthConfiguration["registration"], { mode: "pre_registered" }>["client"];
    // @ts-expect-error A public client still requires the client identifier.
    const missingId: PublicClient = {};
    // @ts-expect-error Public metadata must not declare a returned client secret.
    const leakedSecret: PublicClient = { client_id: "app", client_secret: "private" };
    const replacement: ConfigureMcpOAuthRequest["registration"] = {
      mode: "pre_registered", client: { client_id: "app", client_secret: "replacement" }
    };
  `;
  const options: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...args) => path === filename
    ? ts.createSourceFile(filename, source, languageVersion, true)
    : getSourceFile(path, languageVersion, ...args);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  expect(diagnostics.map(diagnostic => ({ code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") }))).toEqual([]);
}, 30_000);

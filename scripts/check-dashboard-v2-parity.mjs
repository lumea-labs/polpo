import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(repositoryRoot, "packages/dashboard/src/v2");
const cloudRoot = path.resolve(
  process.env.POLPO_CLOUD_DASHBOARD_ROOT ??
    path.join(repositoryRoot, "../../../../oss/polpo-cloud/packages/dashboard"),
);

const sourcePairs = {
  "agents/agent-detail.tsx": "components/v2/agents/agent-detail.tsx",
  "agents/agent-edit-panel.tsx": "components/v2/agents/agent-edit-panel.tsx",
  "agents/agent-quickstart.tsx": "components/v2/agents/agent-quickstart.tsx",
  "agents/agent-run-panel.tsx": "components/v2/agents/agent-run-panel.tsx",
  "agents/create-agent-dialog.tsx": "components/v2/agents/create-agent-dialog.tsx",
  "agents/loops-tab.tsx": "components/v2/agents/loops-tab.tsx",
  "agents/model-select.tsx": "components/v2/agents/model-select.tsx",
  "agents/prompt-preview-dialog.tsx": "components/v2/agents/prompt-preview-dialog.tsx",
  "agents/skills-tab.tsx": "components/v2/agents/skills-tab.tsx",
  "agents/tools-panel.tsx": "components/v2/agents/tools-panel.tsx",
  "agents/tools-tab.tsx": "components/v2/agents/tools-tab.tsx",
  "agents/vault-tab.tsx": "components/v2/agents/vault-tab.tsx",
  "files/file-browser-primitives.tsx": "components/v2/files/file-browser-primitives.tsx",
  "files/file-directory-browser.tsx": "components/v2/files/file-directory-browser.tsx",
  "files/files-browser.tsx": "components/v2/files/files-browser.tsx",
  "playground/chat-canvas.tsx": "app/(playground)/projects/[id]/playground-v2/chat-canvas.tsx",
  "sessions/trace-columns.tsx": "app/v2/(dash)/projects/[id]/sessions/trace-columns.tsx",
  "sessions/trace-detail-view.tsx": "app/v2/(dash)/projects/[id]/sessions/[runId]/trace-detail-view.tsx",
  "sessions/trace-detail.ts": "app/v2/(dash)/projects/[id]/sessions/[runId]/trace-detail.ts",
  "sessions/trace-normalize.ts": "app/v2/(dash)/projects/[id]/sessions/trace-normalize.ts",
  "sessions/trace-table.tsx": "app/v2/(dash)/projects/[id]/sessions/trace-table.tsx",
  "skills/create-skill-dialog.tsx": "components/v2/skills/create-skill-dialog.tsx",
  "ui/bits.tsx": "components/v2/ui/bits.tsx",
  "ui/code-block.tsx": "components/v2/ui/code-block.tsx",
  "ui/code-editor.tsx": "components/v2/ui/code-editor.tsx",
  "ui/copy-button.tsx": "components/v2/ui/copy-button.tsx",
  "ui/data-table.tsx": "components/v2/ui/data-table.tsx",
  "ui/multi-select-filter.tsx": "components/v2/ui/multi-select-filter.tsx",
  "ui/page-header.tsx": "components/v2/ui/page-header.tsx",
  "ui/refresh-button.tsx": "components/v2/ui/refresh-button.tsx",
  "ui/skeleton.tsx": "components/ui/skeleton.tsx",
  "views/agents.tsx": "app/v2/(dash)/projects/[id]/agents/agents-table.tsx",
  "views/memory-project.tsx": "app/v2/(dash)/projects/[id]/memory/project-memory.tsx",
  "views/skills-detail.tsx": "app/v2/(dash)/projects/[id]/skills/[name]/skill-detail.tsx",
  "views/skills.tsx": "app/v2/(dash)/projects/[id]/skills/skills-catalog.tsx",
};

const ignoredHostTags = new Set([
  "EditorLoading",
  "SessionsHostProvider",
  "Suspense",
]);
const hostTagAliases = new Map([
  ["SelfHostCreateAgentDialog", "CreateAgentDialog"],
  ["SelfHostCreateSkillDialog", "CreateSkillDialog"],
]);

function fail(message) {
  console.error(`dashboard v2 parity: ${message}`);
  process.exitCode = 1;
}

function sourceSignature(file) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const signature = { tags: [], classes: [], text: [] };

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const sourceTag = node.tagName.getText(sourceFile);
      if (!ignoredHostTags.has(sourceTag)) {
        signature.tags.push(hostTagAliases.get(sourceTag) ?? sourceTag);
      }
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "className") {
          signature.classes.push(
            attribute.initializer?.getText(sourceFile).replace(/\s+/g, " ") ?? "",
          );
        }
      }
    }
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
      if (text) signature.text.push(text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return signature;
}

if (!fs.existsSync(cloudRoot)) {
  fail(
    `Cloud reference not found at ${cloudRoot}. Set POLPO_CLOUD_DASHBOARD_ROOT to the Cloud packages/dashboard directory.`,
  );
} else {
  const targetCss = path.join(repositoryRoot, "packages/dashboard/src/v2.css");
  const cloudCss = path.join(cloudRoot, "app/v2/(dash)/v2.css");
  if (fs.readFileSync(targetCss, "utf8") !== fs.readFileSync(cloudCss, "utf8")) {
    fail("v2.css differs from the Cloud source");
  }

  for (const [targetRelative, cloudRelative] of Object.entries(sourcePairs)) {
    const target = path.join(targetRoot, targetRelative);
    const cloud = path.join(cloudRoot, cloudRelative);
    if (!fs.existsSync(target)) {
      fail(`missing target file ${targetRelative}`);
      continue;
    }
    if (!fs.existsSync(cloud)) {
      fail(`missing Cloud reference file ${cloudRelative}`);
      continue;
    }

    const targetSignature = sourceSignature(target);
    const cloudSignature = sourceSignature(cloud);
    for (const key of Object.keys(targetSignature)) {
      if (JSON.stringify(targetSignature[key]) !== JSON.stringify(cloudSignature[key])) {
        fail(`${targetRelative} differs from ${cloudRelative} in its JSX ${key}`);
      }
    }
  }
}

if (!process.exitCode) {
  console.log(
    `dashboard v2 parity: ${Object.keys(sourcePairs).length} source mappings and v2.css match Cloud`,
  );
}

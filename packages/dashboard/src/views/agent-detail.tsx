"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ChatCircleText, Trash } from "@phosphor-icons/react";
import { useAgents } from "@polpo-ai/react";
import { Button, Field, LoadingRows, PageHeader } from "../components.js";
import { useDashboardHost } from "../host.js";
import {
  modelSelectionPrimary,
  parseModelSelectionInput,
} from "../model-selection.js";

export function AgentDetailView({ name }: { name: string }) {
  const host = useDashboardHost();
  const { agents, isLoading, updateAgent, isUpdatingAgent, removeAgent, isRemovingAgent } = useAgents();
  const agent = agents.find((item) => item.name === name);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [agent]);

  if (isLoading && !agent) return <LoadingRows rows={6} />;
  if (!agent) return <div className="pd-empty"><strong>Agent not found</strong><Button variant="secondary" onClick={() => host.navigate("/agents")}>Back to agents</Button></div>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent) return;
    const data = new FormData(event.currentTarget);
    const modelInput = String(data.get("model") ?? "");
    const currentModelInput = modelSelectionPrimary(agent.model);
    await updateAgent(name, {
      role: String(data.get("role") ?? ""),
      model: modelInput.trim() === currentModelInput
        ? agent.model
        : parseModelSelectionInput(modelInput),
      systemPrompt: String(data.get("systemPrompt") ?? ""),
    });
    setSaved(true);
  }

  return (
    <div className="pd-view-stack">
      <PageHeader
        title={agent.name}
        description={agent.role || "Agent configuration"}
        actions={<><Button variant="secondary" onClick={() => host.navigate("/agents")}><ArrowLeft size={15} />Agents</Button><Button onClick={() => host.navigate(`/playground?agent=${encodeURIComponent(name)}`)}><ChatCircleText size={15} />Test agent</Button></>}
      />
      <form className="pd-editor" onSubmit={(event) => void submit(event)}>
        <div className="pd-editor-section">
          <h2>Configuration</h2>
          <Field label="Role"><input name="role" defaultValue={agent.role ?? ""} /></Field>
          <Field label="Model"><input name="model" defaultValue={modelSelectionPrimary(agent.model)} placeholder="provider/model or profile:name" /></Field>
          <Field label="Instructions"><textarea name="systemPrompt" defaultValue={agent.systemPrompt ?? ""} rows={16} /></Field>
        </div>
        <div className="pd-editor-footer">
          <Button type="button" variant="danger" disabled={isRemovingAgent} onClick={async () => { if (!confirm(`Delete ${name}?`)) return; await removeAgent(name); host.navigate("/agents"); }}><Trash size={15} />Delete</Button>
          <div>{saved ? <span className="pd-saved">Saved</span> : null}<Button type="submit" disabled={isUpdatingAgent}>{isUpdatingAgent ? "Saving..." : "Save agent"}</Button></div>
        </div>
      </form>
    </div>
  );
}

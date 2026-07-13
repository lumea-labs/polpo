"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Atom, CaretRight, Plus, ArrowClockwise } from "@phosphor-icons/react";
import { useAgents } from "@polpo-ai/react";
import type { AgentConfig, AddAgentRequest } from "@polpo-ai/sdk";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Button,
  DataTable,
  Field,
  IconButton,
  LoadingRows,
  Modal,
  PageHeader,
  type ColumnMeta,
} from "../components.js";

function modelLabel(model?: string) {
  return model?.trim() || "Not assigned";
}

export function AgentsView() {
  const { agents, isLoading, error, addAgent, isAddingAgent, refetch } = useAgents();
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const columns = useMemo<ColumnDef<AgentConfig, unknown>[]>(() => [
    {
      id: "name",
      header: "Agent",
      accessorFn: (agent) => agent.name,
      cell: ({ row }) => (
        <div className="pd-primary-cell">
          <Atom size={18} weight="duotone" />
          <div><strong>{row.original.name}</strong><span>{row.original.role || "Agent"}</span></div>
        </div>
      ),
      meta: { width: 340 } satisfies ColumnMeta,
    },
    {
      id: "model",
      header: "Model",
      accessorFn: (agent) => modelLabel(agent.model),
      cell: ({ getValue }) => <code>{String(getValue())}</code>,
      meta: { width: 260, hideOnMobile: true } satisfies ColumnMeta,
    },
    {
      id: "tools",
      header: "Tools",
      accessorFn: (agent) => agent.allowedTools?.length ?? 0,
      meta: { width: 80, align: "center", hideOnMobile: true } satisfies ColumnMeta,
    },
    {
      id: "skills",
      header: "Skills",
      accessorFn: (agent) => agent.skills?.length ?? 0,
      meta: { width: 80, align: "center", hideOnMobile: true } satisfies ColumnMeta,
    },
    {
      id: "open",
      header: "",
      enableSorting: false,
      cell: () => <CaretRight size={14} />,
      meta: { width: 44, align: "right" } satisfies ColumnMeta,
    },
  ], []);

  async function refresh() {
    setRefreshing(true);
    await refetch().finally(() => setRefreshing(false));
  }

  return (
    <div className="pd-view-stack">
      <PageHeader
        title="Agents"
        description={`${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
        actions={<Button onClick={() => setCreateOpen(true)}><Plus size={15} weight="bold" />New agent</Button>}
      />
      {error ? <div className="pd-error">{error.message}</div> : null}
      {isLoading && agents.length === 0 ? <LoadingRows /> : (
        <DataTable
          columns={columns}
          data={agents}
          getRowId={(agent) => agent.name}
          rowHref={(agent) => `/agents/${encodeURIComponent(agent.name)}`}
          searchPlaceholder="Search agents..."
          searchFn={(agent, query) => [agent.name, agent.role, agent.model].some((value) => value?.toLowerCase().includes(query))}
          rightSlot={<IconButton label="Refresh agents" onClick={() => void refresh()} disabled={refreshing}><ArrowClockwise className={refreshing ? "pd-spin" : ""} size={15} /></IconButton>}
          empty={<div className="pd-empty"><Atom size={24} /><strong>No agents yet</strong><span>Create the first agent for this runtime.</span><Button onClick={() => setCreateOpen(true)}>New agent</Button></div>}
        />
      )}
      <CreateAgentModal
        open={createOpen}
        busy={isAddingAgent}
        onClose={() => setCreateOpen(false)}
        onCreate={async (agent) => {
          await addAgent(agent);
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function CreateAgentModal({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (agent: AddAgentRequest) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    setError(null);
    try {
      await onCreate({
        name,
        role: String(data.get("role") ?? "").trim() || undefined,
        model: String(data.get("model") ?? "").trim() || undefined,
        systemPrompt: String(data.get("systemPrompt") ?? "").trim() || undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create agent");
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="New agent" description="Define a portable agent for this Polpo runtime.">
      <form className="pd-form" onSubmit={(event) => void submit(event)}>
        <Field label="Name" hint="Stable identifier used by API calls."><input name="name" required placeholder="support-agent" pattern="[A-Za-z0-9_-]+" /></Field>
        <Field label="Role"><input name="role" placeholder="Customer support specialist" /></Field>
        <Field label="Model"><input name="model" placeholder="anthropic/claude-sonnet-4-5" /></Field>
        <Field label="Instructions"><textarea name="systemPrompt" rows={7} placeholder="Explain what this agent should do..." /></Field>
        {error ? <div className="pd-error">{error}</div> : null}
        <div className="pd-form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Creating..." : "Create agent"}</Button></div>
      </form>
    </Modal>
  );
}

"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  Position,
  useNodesState,
  useEdgesState,
  Handle,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Task } from "@polpo-ai/core";
import Link from "next/link";

// ── Status config ──

const STATUS_CONFIG: Record<string, { bg: string; border: string; dot: string; text: string }> = {
  done:              { bg: "bg-emerald-500/5",       border: "border-emerald-500/40", dot: "bg-emerald-500",         text: "text-emerald-500" },
  completed:         { bg: "bg-emerald-500/5",       border: "border-emerald-500/40", dot: "bg-emerald-500",         text: "text-emerald-500" },
  in_progress:       { bg: "bg-blue-500/5",          border: "border-blue-500/40",    dot: "bg-blue-500",            text: "text-blue-500" },
  review:            { bg: "bg-amber-500/5",         border: "border-amber-500/40",   dot: "bg-amber-500",           text: "text-amber-500" },
  pending:           { bg: "bg-card/90",             border: "border-border",         dot: "bg-muted-foreground/30", text: "text-muted-foreground" },
  assigned:          { bg: "bg-card/90",             border: "border-border",         dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  draft:             { bg: "bg-card/90",             border: "border-border/60",      dot: "bg-muted-foreground/20", text: "text-muted-foreground/60" },
  failed:            { bg: "bg-red-500/5",           border: "border-red-500/40",     dot: "bg-red-500",             text: "text-red-500" },
  awaiting_approval: { bg: "bg-amber-500/5",         border: "border-amber-500/40",   dot: "bg-amber-500",           text: "text-amber-500" },
};

const DEFAULT_CFG = { bg: "bg-card/90", border: "border-border", dot: "bg-muted-foreground/30", text: "text-muted-foreground" };

// ── Task Node ──

interface TaskNodeData {
  task: Task;
  index: number;
  projectId: string;
  readonly?: boolean;
  [key: string]: unknown;
}

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const { task, index, projectId, readonly: isReadonly } = data;
  const cfg = STATUS_CONFIG[task.status] ?? DEFAULT_CFG;
  const duration = task.result?.duration != null ? `${Math.round(task.result.duration / 1000)}s` : null;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground/40 !border-none !w-2 !h-2" />
      <div className={`rounded-xl border-2 ${cfg.border} ${cfg.bg} px-4 py-3 min-w-[220px] max-w-[280px] shadow-sm backdrop-blur-sm`}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-mono text-muted-foreground/60">#{index + 1}</span>
          <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot} ${task.status === "in_progress" ? "animate-pulse" : ""}`} />
          <span className={`text-[10px] font-medium ${cfg.text}`}>{task.status.replace(/_/g, " ")}</span>
          {task.phase && task.status === "in_progress" && (
            <span className="text-[9px] text-muted-foreground/50">({task.phase})</span>
          )}
          {duration && (
            <span className="text-[9px] text-muted-foreground ml-auto font-mono">{duration}</span>
          )}
        </div>

        {/* Title */}
        {isReadonly ? (
          <span className="text-xs font-semibold leading-tight line-clamp-2 block">{task.title}</span>
        ) : (
          <Link
            href={`/projects/${projectId}/tasks/${task.id}`}
            className="text-xs font-semibold leading-tight line-clamp-2 hover:underline underline-offset-2 block"
            onClick={(e) => e.stopPropagation()}
          >
            {task.title}
          </Link>
        )}

        {/* Footer */}
        <div className="mt-2 flex items-center gap-2">
          <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground">
            {task.assignTo}
          </span>
          {task.dependsOn && task.dependsOn.length > 0 && (
            <span className="text-[9px] text-muted-foreground/50">
              {task.dependsOn.length} dep{task.dependsOn.length > 1 ? "s" : ""}
            </span>
          )}
          {task.result?.assessment?.globalScore != null && (
            <span className={`text-[9px] font-medium ml-auto ${task.result.assessment.globalScore >= 0.7 ? "text-emerald-500" : "text-red-400"}`}>
              {Math.round(task.result.assessment.globalScore * 100)}%
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground/40 !border-none !w-2 !h-2" />
    </>
  );
}

const nodeTypes = { task: TaskNode };

// ── Layout ──

const NODE_WIDTH = 240;
const NODE_HEIGHT = 120;
const H_GAP = 60;
const V_GAP = 80;

function layoutNodes(tasks: Task[], projectId: string): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Compute depth per task
  const depths = new Map<string, number>();

  function getDepth(taskId: string, visited = new Set<string>()): number {
    if (depths.has(taskId)) return depths.get(taskId)!;
    if (visited.has(taskId)) return 0;
    visited.add(taskId);

    const task = taskMap.get(taskId);
    if (!task?.dependsOn?.length) {
      depths.set(taskId, 0);
      return 0;
    }

    const maxParent = Math.max(...task.dependsOn.map(d => getDepth(d, visited)));
    const depth = maxParent + 1;
    depths.set(taskId, depth);
    return depth;
  }

  for (const task of tasks) getDepth(task.id);

  // Group by depth
  const layers = new Map<number, Task[]>();
  for (const task of tasks) {
    const d = depths.get(task.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(task);
  }

  const maxDepth = Math.max(...layers.keys(), 0);
  const nodes: Node<TaskNodeData>[] = [];

  // Track task index globally
  let globalIndex = 0;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const layerTasks = layers.get(depth) ?? [];
    const totalWidth = layerTasks.length * NODE_WIDTH + (layerTasks.length - 1) * H_GAP;
    const startX = -totalWidth / 2;

    layerTasks.forEach((task, i) => {
      nodes.push({
        id: task.id,
        type: "task",
        position: {
          x: startX + i * (NODE_WIDTH + H_GAP),
          y: depth * (NODE_HEIGHT + V_GAP),
        },
        data: { task, index: globalIndex++, projectId },
      });
    });
  }

  // Edges with arrows
  const edges: Edge[] = [];
  for (const task of tasks) {
    if (!task.dependsOn) continue;
    for (const depId of task.dependsOn) {
      const sourceTask = taskMap.get(depId);
      if (!sourceTask) continue;

      const isDone = sourceTask.status === "done";
      const isFailed = sourceTask.status === "failed";
      const isActive = sourceTask.status === "in_progress";

      const edgeColor = "#888";

      edges.push({
        id: `${depId}->${task.id}`,
        source: depId,
        target: task.id,
        type: "smoothstep",
        animated: isActive,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: edgeColor,
        },
        style: {
          stroke: edgeColor,
          strokeWidth: 1.5,
          strokeDasharray: isActive ? undefined : "6 4",
        },
      });
    }
  }

  return { nodes, edges };
}

// ── Component ──

interface MissionGraphProps {
  tasks: Task[];
  projectId: string;
  readonly?: boolean;
}

export function MissionGraph({ tasks, projectId, readonly = false }: MissionGraphProps) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const layout = layoutNodes(tasks, projectId);
    if (readonly) {
      for (const node of layout.nodes) {
        node.data.readonly = true;
      }
    }
    return layout;
  }, [tasks, projectId, readonly]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  return (
    <div className="h-[600px] w-full rounded-xl border border-border overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        defaultEdgeOptions={{ type: "smoothstep" }}
        style={{ background: "hsl(var(--card))" }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.5}
          color="#555"
        />
        <Controls
          showInteractive={false}
          className="!bg-card !border-border !shadow-none [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-muted-foreground [&>button:hover]:!bg-secondary"
        />
      </ReactFlow>
    </div>
  );
}

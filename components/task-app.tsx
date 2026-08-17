"use client";

import {
  addEdge,
  Background,
  Connection,
  Controls,
  Edge,
  Handle,
  MarkerType,
  Node,
  NodeChange,
  NodeProps,
  Position,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, GripIcon, PlusIcon, TrashIcon } from "./icons";

type Point = { x: number; y: number };
type Task = { id: string; title: string; completed: boolean; position: Point };
type Dependency = { id: string; source: string; target: string };
type TaskData = { tasks: Task[]; dependencies: Dependency[] };
type View = "list" | "graph";
type TaskNodeData = {
  title: string;
  completed: boolean;
  blocked: boolean;
  onToggle: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
};
type TaskFlowNode = Node<TaskNodeData, "task">;

const STORAGE_KEY = "tangle-task-data-v1";

const SAMPLE_DATA: TaskData = {
  tasks: [
    { id: "update-resume", title: "Update resume", completed: false, position: { x: 50, y: 80 } },
    { id: "remote-internships", title: "Find remote internships", completed: false, position: { x: 50, y: 210 } },
    { id: "pittsburgh-internships", title: "Find Pittsburgh internships", completed: false, position: { x: 50, y: 340 } },
    { id: "apply-internships", title: "Apply to internships", completed: false, position: { x: 410, y: 210 } },
  ],
  dependencies: [
    { id: "update-resume--apply-internships", source: "update-resume", target: "apply-internships" },
    { id: "remote-internships--apply-internships", source: "remote-internships", target: "apply-internships" },
    { id: "pittsburgh-internships--apply-internships", source: "pittsburgh-internships", target: "apply-internships" },
  ],
};

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nextOpenPosition(tasks: Task[]): Point {
  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const candidate = { x: 70 + column * 280, y: 70 + row * 115 };
      const occupied = tasks.some(
        (task) => Math.abs(task.position.x - candidate.x) < 240 && Math.abs(task.position.y - candidate.y) < 80,
      );
      if (!occupied) return candidate;
    }
  }
  return { x: 70, y: 70 + tasks.length * 115 };
}

function CheckButton({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`check-button nodrag nopan ${checked ? "is-checked" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={label}
      aria-pressed={checked}
    >
      <CheckIcon />
    </button>
  );
}

function InlineTitle({
  title,
  completed,
  onSave,
  className = "",
}: {
  title: string;
  completed: boolean;
  onSave: (title: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(title), [title]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const clean = draft.trim();
    setEditing(false);
    if (clean && clean !== title) onSave(clean);
    else setDraft(title);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`inline-title-input nodrag nopan ${className}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
        aria-label="Task title"
      />
    );
  }

  return (
    <button
      type="button"
      className={`inline-title nodrag nopan ${completed ? "is-completed" : ""} ${className}`}
      onClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
      title="Edit task"
    >
      {title}
    </button>
  );
}

function TaskNode({ id, data }: NodeProps<TaskFlowNode>) {
  return (
    <div className={`task-node ${data.completed ? "is-completed" : ""} ${data.blocked ? "is-blocked" : ""}`}>
      <Handle type="target" position={Position.Left} className="connection-handle connection-target" />
      <div className="task-node-content">
        <CheckButton
          checked={data.completed}
          onClick={() => data.onToggle(id)}
          label={data.completed ? `Mark ${data.title} incomplete` : `Complete ${data.title}`}
        />
        <InlineTitle title={data.title} completed={data.completed} onSave={(title) => data.onRename(id, title)} className="node-title" />
        <button
          type="button"
          className="node-delete nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            data.onDelete(id);
          }}
          aria-label={`Delete ${data.title}`}
        >
          <TrashIcon />
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="connection-handle connection-source" />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function hasPath(from: string, to: string, dependencies: Dependency[]) {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    dependencies.filter((edge) => edge.source === current).forEach((edge) => queue.push(edge.target));
  }
  return false;
}

function ListView({
  tasks,
  blockedIds,
  onToggle,
  onRename,
  onDelete,
  onReorder,
}: {
  tasks: Task[];
  blockedIds: Set<string>;
  onToggle: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onReorder: (draggedId: string, targetId: string) => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const draggedRef = useRef<string | null>(null);

  if (!tasks.length) {
    return (
      <div className="empty-state">
        <div className="empty-check"><CheckIcon /></div>
        <p>Nothing here yet.</p>
        <span>Add a task below to get started.</span>
      </div>
    );
  }

  return (
    <div className="task-list" role="list">
      {tasks.map((task) => (
        <div
          key={task.id}
          role="listitem"
          data-task-id={task.id}
          className={`task-row ${task.completed ? "is-completed" : ""} ${blockedIds.has(task.id) ? "is-blocked" : ""} ${dragged === task.id ? "is-dragging" : ""} ${over === task.id ? "is-drop-target" : ""}`}
          onPointerDown={(event) => {
            if (!(event.target as HTMLElement).closest(".drag-grip")) return;
            if (event.pointerType === "mouse") return;
            event.preventDefault();
            draggedRef.current = task.id;
            setDragged(task.id);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (draggedRef.current !== task.id) return;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".task-row");
            const targetId = target?.dataset.taskId;
            setOver(targetId && targetId !== task.id ? targetId : null);
          }}
          onPointerUp={(event) => {
            if (draggedRef.current !== task.id) return;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".task-row");
            const targetId = target?.dataset.taskId;
            if (targetId && targetId !== task.id) onReorder(task.id, targetId);
            draggedRef.current = null;
            setDragged(null);
            setOver(null);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            draggedRef.current = null;
            setDragged(null);
            setOver(null);
          }}
        >
          <span
            className="drag-grip"
            aria-hidden="true"
            onMouseDown={(event) => {
              event.preventDefault();
              draggedRef.current = task.id;
              setDragged(task.id);
              const handleMove = (moveEvent: MouseEvent) => {
                const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>(".task-row");
                const targetId = target?.dataset.taskId;
                setOver(targetId && targetId !== task.id ? targetId : null);
              };
              const handleUp = (upEvent: MouseEvent) => {
                const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLElement>(".task-row");
                const targetId = target?.dataset.taskId;
                if (targetId && targetId !== task.id) onReorder(task.id, targetId);
                draggedRef.current = null;
                setDragged(null);
                setOver(null);
                window.removeEventListener("mousemove", handleMove);
              };
              window.addEventListener("mousemove", handleMove);
              window.addEventListener("mouseup", handleUp, { once: true });
            }}
          ><GripIcon /></span>
          <CheckButton
            checked={task.completed}
            onClick={() => onToggle(task.id)}
            label={task.completed ? `Mark ${task.title} incomplete` : `Complete ${task.title}`}
          />
          <InlineTitle title={task.title} completed={task.completed} onSave={(title) => onRename(task.id, title)} />
          <button type="button" className="row-delete" onClick={() => onDelete(task.id)} aria-label={`Delete ${task.title}`}>
            <TrashIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function TaskApp() {
  const [view, setView] = useState<View>("list");
  const [data, setData] = useState<TaskData>(SAMPLE_DATA);
  const [hydrated, setHydrated] = useState(false);
  const [newTask, setNewTask] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNodePositions = useRef<Map<string, Point>>(new Map());

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setData(JSON.parse(saved) as TaskData);
    } catch {
      // Keep the sample data if saved data is unavailable or malformed.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, hydrated]);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
  }, []);

  useEffect(() => {
    const handleDelete = (event: globalThis.KeyboardEvent) => {
      if (view !== "graph" || !selectedEdgeId || (event.key !== "Delete" && event.key !== "Backspace")) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      setData((current) => ({
        ...current,
        dependencies: current.dependencies.filter((edge) => edge.id !== selectedEdgeId),
      }));
      setSelectedEdgeId(null);
    };
    window.addEventListener("keydown", handleDelete);
    return () => window.removeEventListener("keydown", handleDelete);
  }, [selectedEdgeId, view]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  }, []);

  const blockedIds = useMemo(() => {
    const completed = new Set(data.tasks.filter((task) => task.completed).map((task) => task.id));
    return new Set(
      data.tasks
        .filter((task) => !task.completed && data.dependencies.some((edge) => edge.target === task.id && !completed.has(edge.source)))
        .map((task) => task.id),
    );
  }, [data]);

  const toggleTask = useCallback((id: string) => {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task),
    }));
  }, []);

  const renameTask = useCallback((id: string, title: string) => {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, title } : task),
    }));
  }, []);

  const deleteTask = useCallback((id: string) => {
    setData((current) => ({
      tasks: current.tasks.filter((task) => task.id !== id),
      dependencies: current.dependencies.filter((edge) => edge.source !== id && edge.target !== id),
    }));
  }, []);

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const title = newTask.trim();
    if (!title) return;
    setData((current) => {
      return {
        ...current,
        tasks: [...current.tasks, {
          id: uid(),
          title,
          completed: false,
          position: nextOpenPosition(current.tasks),
        }],
      };
    });
    setNewTask("");
  };

  const reorderTasks = useCallback((draggedId: string, targetId: string) => {
    setData((current) => {
      const tasks = [...current.tasks];
      const from = tasks.findIndex((task) => task.id === draggedId);
      const to = tasks.findIndex((task) => task.id === targetId);
      if (from < 0 || to < 0) return current;
      const [moved] = tasks.splice(from, 1);
      tasks.splice(to, 0, moved);
      return { ...current, tasks };
    });
  }, []);

  const taskNodes = useMemo<TaskFlowNode[]>(() => data.tasks.map((task) => ({
    id: task.id,
    type: "task",
    position: task.position,
    data: {
      title: task.title,
      completed: task.completed,
      blocked: blockedIds.has(task.id),
      onToggle: toggleTask,
      onRename: renameTask,
      onDelete: deleteTask,
    },
  })), [data.tasks, blockedIds, toggleTask, renameTask, deleteTask]);

  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<TaskFlowNode>(taskNodes);

  useEffect(() => {
    setFlowNodes(taskNodes);
  }, [taskNodes, setFlowNodes]);

  const flowEdges = useMemo<Edge[]>(() => data.dependencies.map((edge) => ({
    ...edge,
    selected: edge.id === selectedEdgeId,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#a4a9b3" },
    style: { stroke: "#a4a9b3", strokeWidth: 1.35 },
    interactionWidth: 22,
  })), [data.dependencies, selectedEdgeId]);

  const flushNodePositions = useCallback(() => {
    if (!pendingNodePositions.current.size) return;
    const positions = new Map(pendingNodePositions.current);
    pendingNodePositions.current.clear();
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
    positionSaveTimer.current = null;
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => positions.has(task.id) ? { ...task, position: positions.get(task.id)! } : task),
    }));
  }, []);

  const handleFlowNodesChange = useCallback((changes: NodeChange<TaskFlowNode>[]) => {
    onFlowNodesChange(changes);
    let positionChanged = false;
    changes.forEach((change) => {
      if (change.type === "position" && change.position) {
        pendingNodePositions.current.set(change.id, change.position);
        positionChanged = true;
      }
    });
    if (positionChanged) {
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = setTimeout(flushNodePositions, 140);
    }
  }, [flushNodePositions, onFlowNodesChange]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const { source, target } = connection;
    setData((current) => {
      if (source === target) {
        showNotice("A task can’t depend on itself.");
        return current;
      }
      if (current.dependencies.some((edge) => edge.source === source && edge.target === target)) {
        showNotice("Those tasks are already connected.");
        return current;
      }
      if (hasPath(target, source, current.dependencies)) {
        showNotice("That connection would create a loop.");
        return current;
      }
      const edge: Dependency = { id: `${source}--${target}--${uid()}`, source, target };
      return { ...current, dependencies: addEdge(edge, current.dependencies) as Dependency[] };
    });
  }, [showNotice]);

  const removeEdges = useCallback((edges: Edge[]) => {
    const ids = new Set(edges.map((edge) => edge.id));
    setData((current) => ({ ...current, dependencies: current.dependencies.filter((edge) => !ids.has(edge.id)) }));
    setSelectedEdgeId(null);
  }, []);

  const countLabel = data.tasks.length === 1 ? "1 task" : `${data.tasks.length} tasks`;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand" aria-label="Tangle home">
          <span className="brand-mark"><CheckIcon /></span>
          <span>Tangle</span>
        </div>
        <div className="view-toggle" role="tablist" aria-label="Choose a view">
          <button type="button" role="tab" aria-selected={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}>List</button>
          <button type="button" role="tab" aria-selected={view === "graph"} className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>Graph</button>
        </div>
        <span className="task-count">{countLabel}</span>
      </header>

      <section className={`workspace ${view === "graph" ? "graph-workspace" : "list-workspace"}`}>
        {view === "list" ? (
          <div className="list-panel">
            <div className="list-heading">
              <h1>Tasks</h1>
              <p>{data.tasks.filter((task) => !task.completed).length} remaining</p>
            </div>
            <ListView
              tasks={data.tasks}
              blockedIds={blockedIds}
              onToggle={toggleTask}
              onRename={renameTask}
              onDelete={deleteTask}
              onReorder={reorderTasks}
            />
            <form className="quick-add" onSubmit={addTask}>
              <PlusIcon />
              <input value={newTask} onChange={(event) => setNewTask(event.target.value)} placeholder="New task" aria-label="New task title" />
              <button type="submit" disabled={!newTask.trim()}>Add</button>
            </form>
          </div>
        ) : (
          <div className="graph-panel">
            {!data.tasks.length ? (
              <div className="graph-empty"><p>Your tasks will appear here.</p><button type="button" onClick={() => setView("list")}>Add a task</button></div>
            ) : (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodesChange={handleFlowNodesChange}
                onNodeDragStop={flushNodePositions}
                onConnect={onConnect}
                onEdgesDelete={removeEdges}
                onEdgeClick={(event, edge) => {
                  event.stopPropagation();
                  setSelectedEdgeId(edge.id);
                }}
                onPaneClick={() => setSelectedEdgeId(null)}
                deleteKeyCode={["Backspace", "Delete"]}
                fitView
                fitViewOptions={{ padding: 0.14, maxZoom: 1.15 }}
                minZoom={0.35}
                maxZoom={1.8}
                nodesConnectable
                nodesDraggable
                panOnScroll
                selectionOnDrag={false}
                proOptions={{ hideAttribution: true }}
                aria-label="Task connections"
              >
                <Background color="#d8d9dc" gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
            )}
            <div className="graph-help">Drag from a dot to connect tasks · Select an arrow and press Delete to remove it</div>
          </div>
        )}
      </section>
      <div className={`notice ${notice ? "is-visible" : ""}`} role="status" aria-live="polite">{notice}</div>
    </main>
  );
}

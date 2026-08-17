"use client";

import {
  addEdge,
  Background,
  BaseEdge,
  Connection,
  Controls,
  Edge,
  EdgeProps,
  EdgeToolbar,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Node,
  NodeChange,
  NodeProps,
  NodeResizeControl,
  Position,
  ReactFlow,
  ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CheckIcon, CloseIcon, GripIcon, InfoIcon, PlusIcon, RedoIcon, TrashIcon, UndoIcon } from "./icons";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Task = { id: string; title: string; completed: boolean; position: Point; size?: Size; notes?: string };
type Dependency = { id: string; source: string; target: string };
type TaskData = { tasks: Task[]; dependencies: Dependency[] };
type HistoryState = { past: TaskData[]; present: TaskData; future: TaskData[] };
type HistoryAction =
  | { type: "reset"; data: TaskData }
  | { type: "update"; update: (current: TaskData) => TaskData }
  | { type: "undo" }
  | { type: "redo" };
type View = "list" | "graph";
type TaskNodeData = {
  title: string;
  completed: boolean;
  blocked: boolean;
  onToggle: (id: string) => void;
  onRename: (id: string, title: string) => void;
};
type TaskFlowNode = Node<TaskNodeData, "task">;
type DependencyEdgeData = { onRemove: (id: string) => void };
type DependencyFlowEdge = Edge<DependencyEdgeData, "dependency">;

const STORAGE_KEY = "tangle-task-data-v1";
const NODE_MIN_WIDTH = 230;
const NODE_MAX_AUTO_WIDTH = 360;
const NODE_MAX_WIDTH = 560;
const NODE_MIN_HEIGHT = 52;
const NODE_MAX_HEIGHT = 320;
const HISTORY_LIMIT = 100;
const EDGE_RECONNECT_RADIUS = 18;
const NODE_CONNECTION_RADIUS = 28;

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

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === "reset") return { past: [], present: action.data, future: [] };

  if (action.type === "update") {
    const next = action.update(state.present);
    if (next === state.present) return state;
    return {
      past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present],
      present: next,
      future: [],
    };
  }

  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
    };
  }

  const next = state.future[0];
  if (!next) return state;
  return {
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present],
    present: next,
    future: state.future.slice(1),
  };
}

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

function estimatedTextWidth(text: string) {
  return [...text].reduce((width, character) => {
    if (/[MW@#%&]/.test(character)) return width + 9;
    if (/[ilI1.,'` ]/.test(character)) return width + 3.6;
    if (/[A-Z]/.test(character)) return width + 7.5;
    return width + 6.6;
  }, 0);
}

function estimatedLineCount(title: string, availableWidth: number) {
  const words = title.trim().split(/\s+/);
  let lines = 1;
  let lineWidth = 0;

  words.forEach((word) => {
    const wordWidth = estimatedTextWidth(word);
    const spacing = lineWidth ? estimatedTextWidth(" ") : 0;
    if (wordWidth > availableWidth) {
      if (lineWidth) lines += 1;
      lines += Math.max(0, Math.ceil(wordWidth / availableWidth) - 1);
      lineWidth = wordWidth % availableWidth;
    } else if (lineWidth + spacing + wordWidth > availableWidth) {
      lines += 1;
      lineWidth = wordWidth;
    } else {
      lineWidth += spacing + wordWidth;
    }
  });

  return lines;
}

function minimumNodeHeight(title: string, width: number) {
  const titleWidth = Math.max(90, width - 58);
  return NODE_MIN_HEIGHT + (estimatedLineCount(title, titleWidth) - 1) * 20;
}

function automaticNodeSize(title: string): Size {
  const width = Math.min(NODE_MAX_AUTO_WIDTH, Math.max(NODE_MIN_WIDTH, Math.ceil(estimatedTextWidth(title) + 58)));
  return { width, height: minimumNodeHeight(title, width) };
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

function TaskNode({ id, data, width }: NodeProps<TaskFlowNode>) {
  const contentHeight = minimumNodeHeight(data.title, width ?? NODE_MIN_WIDTH);
  return (
    <div className={`task-node ${data.completed ? "is-completed" : ""} ${data.blocked ? "is-blocked" : ""}`}>
      <NodeResizeControl
        position="bottom-right"
        className="node-resize-control"
        minWidth={NODE_MIN_WIDTH}
        minHeight={contentHeight}
        maxWidth={NODE_MAX_WIDTH}
        maxHeight={NODE_MAX_HEIGHT}
      />
      <Handle type="target" position={Position.Left} className="connection-handle connection-target" />
      <div className="task-node-content">
        <CheckButton
          checked={data.completed}
          onClick={() => data.onToggle(id)}
          label={data.completed ? `Mark ${data.title} incomplete` : `Complete ${data.title}`}
        />
        <InlineTitle title={data.title} completed={data.completed} onSave={(title) => data.onRename(id, title)} className="node-title" />
      </div>
      <Handle type="source" position={Position.Right} className="connection-handle connection-source" />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
  interactionWidth,
}: EdgeProps<DependencyFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const sourceHandle = offsetPoint(sourceX, sourceY, sourcePosition, EDGE_RECONNECT_RADIUS);
  const targetHandle = offsetPoint(targetX, targetY, targetPosition, EDGE_RECONNECT_RADIUS);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactionWidth}
      />
      {selected && (
        <>
          <circle className="edge-endpoint-indicator" cx={sourceHandle.x} cy={sourceHandle.y} r={5} />
          <circle className="edge-endpoint-indicator" cx={targetHandle.x} cy={targetHandle.y} r={5} />
        </>
      )}
      <EdgeToolbar edgeId={id} x={labelX} y={labelY} isVisible={selected} className="connection-toolbar nodrag nopan">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            data?.onRemove(id);
          }}
          aria-label="Remove connection"
          title="Remove connection"
        >
          <TrashIcon />
        </button>
      </EdgeToolbar>
    </>
  );
}

const edgeTypes = { dependency: DependencyEdge };

function offsetPoint(x: number, y: number, position: Position, distance: number): Point {
  if (position === Position.Left) return { x: x - distance, y };
  if (position === Position.Right) return { x: x + distance, y };
  if (position === Position.Top) return { x, y: y - distance };
  return { x, y: y + distance };
}

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

type DependencyIssue = "self" | "duplicate" | "cycle" | null;

function dependencyIssue(source: string, target: string, dependencies: Dependency[], ignoredEdgeId?: string): DependencyIssue {
  const remaining = ignoredEdgeId ? dependencies.filter((edge) => edge.id !== ignoredEdgeId) : dependencies;
  if (source === target) return "self";
  if (remaining.some((edge) => edge.source === source && edge.target === target)) return "duplicate";
  if (hasPath(target, source, remaining)) return "cycle";
  return null;
}

function dependencyIssueMessage(issue: Exclude<DependencyIssue, null>) {
  if (issue === "self") return "A task can’t depend on itself.";
  if (issue === "duplicate") return "Those tasks are already connected.";
  return "That connection would create a loop.";
}

function ListView({
  tasks,
  blockedIds,
  onToggle,
  onRename,
  onInspect,
  onSelect,
  onReorder,
  inspectedTaskId,
  selectedTaskId,
}: {
  tasks: Task[];
  blockedIds: Set<string>;
  onToggle: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onInspect: (id: string) => void;
  onSelect: (id: string) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  inspectedTaskId: string | null;
  selectedTaskId: string | null;
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
          className={`task-row ${task.completed ? "is-completed" : ""} ${blockedIds.has(task.id) ? "is-blocked" : ""} ${inspectedTaskId === task.id ? "is-inspected" : ""} ${selectedTaskId === task.id ? "is-selected" : ""} ${dragged === task.id ? "is-dragging" : ""} ${over === task.id ? "is-drop-target" : ""}`}
          onPointerDownCapture={() => onSelect(task.id)}
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
          <button type="button" className="row-info" onClick={() => onInspect(task.id)} aria-label={`Show details for ${task.title}`}>
            <InfoIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

function TaskInspector({
  task,
  onSave,
  onDelete,
  onClose,
}: {
  task: Task;
  onSave: (id: string, updates: Pick<Task, "title" | "notes">) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setConfirmingDelete(false);
  }, [task.id, task.title, task.notes]);

  const commit = useCallback(() => {
    const cleanTitle = title.trim();
    onSave(task.id, { title: cleanTitle || task.title, notes: notes.trim() });
  }, [notes, onSave, task.id, task.title, title]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      commit();
      onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [commit, onClose]);

  const close = () => {
    commit();
    onClose();
  };

  return (
    <aside className="task-inspector" aria-label="Task details">
      <div className="inspector-header">
        <h2>Details</h2>
        <button type="button" onClick={close} aria-label="Close details"><CloseIcon /></button>
      </div>
      <div className="inspector-content">
        <label className="inspector-field">
          <span>Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label className="inspector-field inspector-notes">
          <span>Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={commit}
            placeholder="Add notes"
          />
        </label>
      </div>
      <div className="inspector-footer">
        {confirmingDelete ? (
          <div className="delete-confirmation">
            <p>Delete this task and its connections?</p>
            <div>
              <button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button
                type="button"
                className="confirm-delete"
                onClick={() => {
                  onDelete(task.id);
                  onClose();
                }}
              >Delete</button>
            </div>
          </div>
        ) : (
          <button type="button" className="inspector-delete" onClick={() => setConfirmingDelete(true)}>
            <TrashIcon /> Delete task…
          </button>
        )}
      </div>
    </aside>
  );
}

export default function TaskApp() {
  const [view, setView] = useState<View>("list");
  const [history, dispatchHistory] = useReducer(historyReducer, {
    past: [],
    present: SAMPLE_DATA,
    future: [],
  });
  const data = history.present;
  const [hydrated, setHydrated] = useState(false);
  const [newTask, setNewTask] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [inspectedTaskId, setInspectedTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNodePositions = useRef<Map<string, Point>>(new Map());
  const pendingNodeSizes = useRef<Map<string, Size>>(new Map());
  const flowInstance = useRef<ReactFlowInstance<TaskFlowNode, DependencyFlowEdge> | null>(null);
  const updateData = useCallback((update: (current: TaskData) => TaskData) => {
    dispatchHistory({ type: "update", update });
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) dispatchHistory({ type: "reset", data: JSON.parse(saved) as TaskData });
    } catch {
      // Keep the sample data if saved data is unavailable or malformed.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, hydrated]);

  useEffect(() => {
    if (view !== "graph" || !flowInstance.current) return;
    const timer = setTimeout(() => {
      void flowInstance.current?.fitView({ padding: 0.14, maxZoom: 1.15, duration: 180 });
    }, 80);
    return () => clearTimeout(timer);
  }, [inspectedTaskId, view]);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
  }, []);

  useEffect(() => {
    const handleDelete = (event: globalThis.KeyboardEvent) => {
      if (
        (!selectedTaskId && (view !== "graph" || !selectedEdgeId))
        || (event.key !== "Delete" && event.key !== "Backspace")
      ) return;
      const target = event.target as Element | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();

      if (selectedTaskId) {
        updateData((current) => {
          if (!current.tasks.some((task) => task.id === selectedTaskId)) return current;
          return {
            tasks: current.tasks.filter((task) => task.id !== selectedTaskId),
            dependencies: current.dependencies.filter((edge) => edge.source !== selectedTaskId && edge.target !== selectedTaskId),
          };
        });
        setInspectedTaskId((inspected) => inspected === selectedTaskId ? null : inspected);
        setSelectedTaskId(null);
        return;
      }

      updateData((current) => {
        const dependencies = current.dependencies.filter((edge) => edge.id !== selectedEdgeId);
        if (dependencies.length === current.dependencies.length) return current;
        return { ...current, dependencies };
      });
      setSelectedEdgeId(null);
    };
    window.addEventListener("keydown", handleDelete);
    return () => window.removeEventListener("keydown", handleDelete);
  }, [selectedEdgeId, selectedTaskId, updateData, view]);

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
    updateData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task),
    }));
  }, [updateData]);

  const renameTask = useCallback((id: string, title: string) => {
    updateData((current) => {
      const task = current.tasks.find((candidate) => candidate.id === id);
      if (!task || task.title === title) return current;
      return {
        ...current,
        tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, title } : candidate),
      };
    });
  }, [updateData]);

  const saveTaskDetails = useCallback((id: string, updates: Pick<Task, "title" | "notes">) => {
    updateData((current) => {
      const task = current.tasks.find((candidate) => candidate.id === id);
      if (!task || (task.title === updates.title && (task.notes ?? "") === (updates.notes ?? ""))) return current;
      return {
        ...current,
        tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, ...updates } : candidate),
      };
    });
  }, [updateData]);

  const deleteTask = useCallback((id: string) => {
    setInspectedTaskId((inspected) => inspected === id ? null : inspected);
    setSelectedTaskId((selected) => selected === id ? null : selected);
    updateData((current) => ({
      tasks: current.tasks.filter((task) => task.id !== id),
      dependencies: current.dependencies.filter((edge) => edge.source !== id && edge.target !== id),
    }));
  }, [updateData]);

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const title = newTask.trim();
    if (!title) return;
    updateData((current) => {
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
    updateData((current) => {
      const tasks = [...current.tasks];
      const from = tasks.findIndex((task) => task.id === draggedId);
      const to = tasks.findIndex((task) => task.id === targetId);
      if (from < 0 || to < 0) return current;
      const [moved] = tasks.splice(from, 1);
      tasks.splice(to, 0, moved);
      return { ...current, tasks };
    });
  }, [updateData]);

  const taskNodes = useMemo<TaskFlowNode[]>(() => data.tasks.map((task) => ({
    id: task.id,
    type: "task",
    selected: task.id === selectedTaskId,
    position: task.position,
    style: task.size ?? automaticNodeSize(task.title),
    data: {
      title: task.title,
      completed: task.completed,
      blocked: blockedIds.has(task.id),
      onToggle: toggleTask,
      onRename: renameTask,
    },
  })), [data.tasks, blockedIds, selectedTaskId, toggleTask, renameTask]);

  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<TaskFlowNode>(taskNodes);

  useEffect(() => {
    setFlowNodes(taskNodes);
  }, [taskNodes, setFlowNodes]);

  const removeDependency = useCallback((id: string) => {
    updateData((current) => {
      const dependencies = current.dependencies.filter((edge) => edge.id !== id);
      if (dependencies.length === current.dependencies.length) return current;
      return { ...current, dependencies };
    });
    setSelectedEdgeId(null);
  }, [updateData]);

  const flowEdges = useMemo<DependencyFlowEdge[]>(() => data.dependencies.map((edge) => {
    const selected = edge.id === selectedEdgeId;
    return {
      ...edge,
      selected,
      type: "dependency",
      reconnectable: selected,
      data: { onRemove: removeDependency },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: selected ? "#3478f6" : "#a4a9b3" },
      style: { stroke: "#a4a9b3", strokeWidth: 1.35 },
      interactionWidth: 26,
    };
  }), [data.dependencies, removeDependency, selectedEdgeId]);

  const flushNodeLayout = useCallback(() => {
    if (!pendingNodePositions.current.size && !pendingNodeSizes.current.size) return;
    const positions = new Map(pendingNodePositions.current);
    const sizes = new Map(pendingNodeSizes.current);
    pendingNodePositions.current.clear();
    pendingNodeSizes.current.clear();
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
    positionSaveTimer.current = null;
    updateData((current) => {
      let changed = false;
      const tasks = current.tasks.map((task) => {
        const position = positions.get(task.id);
        const size = sizes.get(task.id);
        const positionChanged = Boolean(position && (position.x !== task.position.x || position.y !== task.position.y));
        const sizeChanged = Boolean(size && (size.width !== task.size?.width || size.height !== task.size?.height));
        if (!positionChanged && !sizeChanged) return task;
        changed = true;
        return {
          ...task,
          ...(positionChanged ? { position: position! } : {}),
          ...(sizeChanged ? { size: size! } : {}),
        };
      });
      return changed ? { ...current, tasks } : current;
    });
  }, [updateData]);

  const handleFlowNodesChange = useCallback((changes: NodeChange<TaskFlowNode>[]) => {
    onFlowNodesChange(changes);
    let layoutChanged = false;
    changes.forEach((change) => {
      if (change.type === "position" && change.position && (change.dragging || pendingNodePositions.current.has(change.id))) {
        pendingNodePositions.current.set(change.id, change.position);
        layoutChanged = true;
      }
      if (change.type === "dimensions" && change.dimensions && (change.resizing || pendingNodeSizes.current.has(change.id))) {
        pendingNodeSizes.current.set(change.id, change.dimensions);
        layoutChanged = true;
      }
    });
    if (layoutChanged) {
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = setTimeout(flushNodeLayout, 140);
    }
  }, [flushNodeLayout, onFlowNodesChange]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const { source, target } = connection;
    const issue = dependencyIssue(source, target, data.dependencies);
    if (issue) {
      showNotice(dependencyIssueMessage(issue));
      return;
    }
    updateData((current) => {
      if (dependencyIssue(source, target, current.dependencies)) return current;
      const edge: Dependency = { id: `${source}--${target}--${uid()}`, source, target };
      return { ...current, dependencies: addEdge(edge, current.dependencies) as Dependency[] };
    });
  }, [data.dependencies, showNotice, updateData]);

  const onReconnect = useCallback((oldEdge: DependencyFlowEdge, connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const { source, target } = connection;
    const issue = dependencyIssue(source, target, data.dependencies, oldEdge.id);
    if (issue) {
      showNotice(dependencyIssueMessage(issue));
      return;
    }
    updateData((current) => {
      if (dependencyIssue(source, target, current.dependencies, oldEdge.id)) return current;
      const index = current.dependencies.findIndex((edge) => edge.id === oldEdge.id);
      if (index < 0) return current;
      if (current.dependencies[index].source === source && current.dependencies[index].target === target) return current;
      const dependencies = [...current.dependencies];
      dependencies[index] = { ...dependencies[index], source, target };
      return { ...current, dependencies };
    });
    setSelectedEdgeId(oldEdge.id);
  }, [data.dependencies, showNotice, updateData]);

  const removeEdges = useCallback((edges: Edge[]) => {
    const ids = new Set(edges.map((edge) => edge.id));
    updateData((current) => {
      const dependencies = current.dependencies.filter((edge) => !ids.has(edge.id));
      if (dependencies.length === current.dependencies.length) return current;
      return { ...current, dependencies };
    });
    setSelectedEdgeId(null);
  }, [updateData]);

  const undo = useCallback(() => {
    flushNodeLayout();
    dispatchHistory({ type: "undo" });
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
  }, [flushNodeLayout]);

  const redo = useCallback(() => {
    flushNodeLayout();
    dispatchHistory({ type: "redo" });
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
  }, [flushNodeLayout]);

  useEffect(() => {
    const handleHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as Element | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;

      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;

      event.preventDefault();
      if (isRedo) redo();
      else undo();
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [redo, undo]);

  const countLabel = data.tasks.length === 1 ? "1 task" : `${data.tasks.length} tasks`;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const inspectedTask = data.tasks.find((task) => task.id === inspectedTaskId) ?? null;
  const closeInspector = useCallback(() => {
    setInspectedTaskId(null);
    setSelectedTaskId(null);
  }, []);

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
        <div className="header-actions">
          <div className="history-controls" aria-label="History controls">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              aria-label="Undo"
              aria-keyshortcuts="Meta+Z Control+Z"
              title="Undo (⌘Z / Ctrl+Z)"
            ><UndoIcon /></button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              aria-label="Redo"
              aria-keyshortcuts="Meta+Shift+Z Control+Y"
              title="Redo (⌘⇧Z / Ctrl+Y)"
            ><RedoIcon /></button>
          </div>
          <span className="task-count">{countLabel}</span>
        </div>
      </header>

      <div className="workspace-frame">
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
              onInspect={setInspectedTaskId}
              onSelect={(id) => {
                setSelectedTaskId(id);
                setSelectedEdgeId(null);
              }}
              onReorder={reorderTasks}
              inspectedTaskId={inspectedTaskId}
              selectedTaskId={selectedTaskId}
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
                edgeTypes={edgeTypes}
                onInit={(instance) => { flowInstance.current = instance; }}
                onNodesChange={handleFlowNodesChange}
                onNodeDragStop={flushNodeLayout}
                onConnect={onConnect}
                connectionRadius={NODE_CONNECTION_RADIUS}
                onReconnect={onReconnect}
                reconnectRadius={EDGE_RECONNECT_RADIUS}
                onEdgesDelete={removeEdges}
                onNodeClick={(_, node) => {
                  setSelectedTaskId(node.id);
                  setSelectedEdgeId(null);
                  setInspectedTaskId(node.id);
                }}
                onEdgeClick={(event, edge) => {
                  event.stopPropagation();
                  setSelectedTaskId(null);
                  setSelectedEdgeId(edge.id);
                }}
                onPaneClick={() => {
                  setSelectedTaskId(null);
                  setSelectedEdgeId(null);
                }}
                deleteKeyCode={null}
                fitView
                fitViewOptions={{ padding: 0.14, maxZoom: 1.15 }}
                minZoom={0.35}
                maxZoom={1.8}
                nodesConnectable
                nodesDraggable
                elevateEdgesOnSelect
                panOnScroll
                selectionOnDrag={false}
                proOptions={{ hideAttribution: true }}
                aria-label="Task connections"
              >
                <Background color="#d8d9dc" gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
            )}
            <div className="graph-help">Drag a dot to connect · Click an arrow to adjust it</div>
          </div>
          )}
        </section>
        {inspectedTask && (
          <TaskInspector
            task={inspectedTask}
            onSave={saveTaskDetails}
            onDelete={deleteTask}
            onClose={closeInspector}
          />
        )}
      </div>
      <div className={`notice ${notice ? "is-visible" : ""}`} role="status" aria-live="polite">{notice}</div>
    </main>
  );
}

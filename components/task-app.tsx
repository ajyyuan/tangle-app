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
  ViewportPortal,
} from "@xyflow/react";
import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppearanceIcon, ArrangeIcon, CheckIcon, CloseIcon, GripIcon, InfoIcon, PlusIcon, RedoIcon, SettingsIcon, SidebarIcon, TrashIcon, UndoIcon } from "./icons";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type GraphDraft = { id: string; anchor: Point };
type Task = { id: string; title: string; completed: boolean; position: Point; size?: Size; notes?: string };
type Dependency = { id: string; source: string; target: string };
type TaskData = { tasks: Task[]; dependencies: Dependency[] };
type View = "list" | "graph";
type Appearance = "system" | "light" | "dark";
type LayoutDirection = "vertical" | "horizontal";
type LayoutGuide = { id: string; x: number; y: number; width: number; height: number };
type ArrangementSnapshot = {
  direction: LayoutDirection;
  guides: LayoutGuide[];
  layerByTask: Map<string, number>;
};
type HistoryEntry = { data: TaskData; arrangement: ArrangementSnapshot | null };
type HistoryState = { past: HistoryEntry[]; present: TaskData; future: HistoryEntry[] };
type HistoryAction =
  | { type: "reset"; data: TaskData }
  | { type: "update"; update: (current: TaskData) => TaskData; arrangement: ArrangementSnapshot | null }
  | { type: "undo"; arrangement: ArrangementSnapshot | null }
  | { type: "redo"; arrangement: ArrangementSnapshot | null };
type PersistedTaskNodeData = {
  draft: false;
  title: string;
  completed: boolean;
  blocked: boolean;
  onToggle: (id: string) => void;
  onRename: (id: string, title: string) => void;
};
type DraftTaskNodeData = {
  draft: true;
  title: "";
  completed: false;
  blocked: false;
  onCommit: (title: string) => void;
  onCancel: () => void;
};
type TaskNodeData = PersistedTaskNodeData | DraftTaskNodeData;
type TaskFlowNode = Node<TaskNodeData, "task">;
type DependencyEdgeData = { onRemove: (id: string) => void };
type DependencyFlowEdge = Edge<DependencyEdgeData, "dependency">;
type ConnectionSide = "top" | "right" | "bottom" | "left";

const STORAGE_KEY = "tangle-task-data-v1";
const LAYOUT_DIRECTION_KEY = "tangle-layout-direction-v1";
const APPEARANCE_KEY = "tangle-appearance-v1";
const NODE_MIN_WIDTH = 230;
const NODE_MAX_AUTO_WIDTH = 360;
const NODE_MAX_WIDTH = 560;
const NODE_MIN_HEIGHT = 52;
const NODE_MAX_HEIGHT = 320;
const NODE_TITLE_OFFSET_X = 43;
const HISTORY_LIMIT = 100;
const EDGE_RECONNECT_RADIUS = 18;
const NODE_CONNECTION_RADIUS = 28;
const LAYOUT_START_X = 72;
const LAYOUT_START_Y = 72;
const LAYOUT_LAYER_GAP = 110;
const LAYOUT_SIBLING_GAP = 46;
const LAYOUT_GUIDE_EXTENT = 50_000;
const DESKTOP_WORKSPACE_QUERY = "(min-width: 1180px)";
const CONNECTION_SIDES: { side: ConnectionSide; position: Position }[] = [
  { side: "top", position: Position.Top },
  { side: "right", position: Position.Right },
  { side: "bottom", position: Position.Bottom },
  { side: "left", position: Position.Left },
];

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
      past: [...state.past.slice(-(HISTORY_LIMIT - 1)), { data: state.present, arrangement: action.arrangement }],
      present: next,
      future: [],
    };
  }

  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous.data,
      future: [{ data: state.present, arrangement: action.arrangement }, ...state.future].slice(0, HISTORY_LIMIT),
    };
  }

  const next = state.future[0];
  if (!next) return state;
  return {
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), { data: state.present, arrangement: action.arrangement }],
    present: next.data,
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

function taskLevels(tasks: Task[], dependencies: Dependency[]) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const outgoing = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const level = new Map(tasks.map((task) => [task.id, 0]));

  dependencies.forEach(({ source, target }) => {
    if (!taskIds.has(source) || !taskIds.has(target)) return;
    outgoing.get(source)?.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  });

  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  for (let index = 0; index < ready.length; index += 1) {
    const source = ready[index];
    outgoing.get(source)?.forEach((target) => {
      level.set(target, Math.max(level.get(target) ?? 0, (level.get(source) ?? 0) + 1));
      const nextIndegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) ready.push(target);
    });
  }

  return level;
}

function layeredTasks(tasks: Task[], dependencies: Dependency[]) {
  const level = taskLevels(tasks, dependencies);
  const layers = new Map<number, Task[]>();

  tasks.forEach((task) => {
    const taskLevel = level.get(task.id) ?? 0;
    layers.set(taskLevel, [...(layers.get(taskLevel) ?? []), task]);
  });

  return [...layers.entries()].sort(([a], [b]) => a - b).map(([, layerTasks]) => layerTasks);
}

function arrangeTasks(tasks: Task[], dependencies: Dependency[], direction: LayoutDirection): Task[] {
  if (!tasks.length) return tasks;

  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));

  const orderedLayers = layeredTasks(tasks, dependencies).map((layerTasks) => ({
    tasks: layerTasks.sort((a, b) => {
      const spatialDifference = direction === "vertical" ? a.position.x - b.position.x : a.position.y - b.position.y;
      return spatialDifference || (taskOrder.get(a.id) ?? 0) - (taskOrder.get(b.id) ?? 0);
    }),
  }));
  const positions = new Map<string, Point>();
  if (direction === "vertical") {
    const layerWidths = orderedLayers.map(({ tasks: layerTasks }) => layerTasks.reduce((width, task, index) => {
      const size = task.size ?? automaticNodeSize(task.title);
      return width + size.width + (index ? LAYOUT_SIBLING_GAP : 0);
    }, 0));
    const widestLayer = Math.max(...layerWidths);
    let y = LAYOUT_START_Y;

    orderedLayers.forEach(({ tasks: layerTasks }, layerIndex) => {
      let x = LAYOUT_START_X + (widestLayer - layerWidths[layerIndex]) / 2;
      let tallestNode = 0;
      layerTasks.forEach((task) => {
        const size = task.size ?? automaticNodeSize(task.title);
        positions.set(task.id, { x, y });
        x += size.width + LAYOUT_SIBLING_GAP;
        tallestNode = Math.max(tallestNode, size.height);
      });
      y += tallestNode + LAYOUT_LAYER_GAP;
    });
  } else {
    const layerHeights = orderedLayers.map(({ tasks: layerTasks }) => layerTasks.reduce((height, task, index) => {
      const size = task.size ?? automaticNodeSize(task.title);
      return height + size.height + (index ? LAYOUT_SIBLING_GAP : 0);
    }, 0));
    const tallestLayer = Math.max(...layerHeights);
    let x = LAYOUT_START_X;

    orderedLayers.forEach(({ tasks: layerTasks }, layerIndex) => {
      let y = LAYOUT_START_Y + (tallestLayer - layerHeights[layerIndex]) / 2;
      let widestNode = 0;
      layerTasks.forEach((task) => {
        const size = task.size ?? automaticNodeSize(task.title);
        positions.set(task.id, { x, y });
        y += size.height + LAYOUT_SIBLING_GAP;
        widestNode = Math.max(widestNode, size.width);
      });
      x += widestNode + LAYOUT_LAYER_GAP;
    });
  }

  let changed = false;
  const arranged = tasks.map((task) => {
    const position = positions.get(task.id);
    if (!position || (position.x === task.position.x && position.y === task.position.y)) return task;
    changed = true;
    return { ...task, position };
  });
  return changed ? arranged : tasks;
}

function arrangementGuides(tasks: Task[], dependencies: Dependency[], direction: LayoutDirection): LayoutGuide[] {
  const layers = layeredTasks(tasks, dependencies);
  if (!layers.length) return [];

  const bounds = layers.map((layerTasks) => layerTasks.reduce((layerBounds, task) => {
    const size = task.size ?? automaticNodeSize(task.title);
    return {
      minX: Math.min(layerBounds.minX, task.position.x),
      minY: Math.min(layerBounds.minY, task.position.y),
      maxX: Math.max(layerBounds.maxX, task.position.x + size.width),
      maxY: Math.max(layerBounds.maxY, task.position.y + size.height),
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }));

  return bounds.map((bound, index) => {
    if (direction === "vertical") {
      const y = index === 0 ? -LAYOUT_GUIDE_EXTENT : (bounds[index - 1].maxY + bound.minY) / 2;
      const bottom = index === bounds.length - 1 ? LAYOUT_GUIDE_EXTENT : (bound.maxY + bounds[index + 1].minY) / 2;
      return {
        id: `vertical-${index}`,
        x: -LAYOUT_GUIDE_EXTENT,
        y,
        width: LAYOUT_GUIDE_EXTENT * 2,
        height: bottom - y,
      };
    }

    const x = index === 0 ? -LAYOUT_GUIDE_EXTENT : (bounds[index - 1].maxX + bound.minX) / 2;
    const right = index === bounds.length - 1 ? LAYOUT_GUIDE_EXTENT : (bound.maxX + bounds[index + 1].minX) / 2;
    return {
      id: `horizontal-${index}`,
      x,
      y: -LAYOUT_GUIDE_EXTENT,
      width: right - x,
      height: LAYOUT_GUIDE_EXTENT * 2,
    };
  });
}

function layerMembership(tasks: Task[], dependencies: Dependency[]) {
  const membership = new Map<string, number>();
  layeredTasks(tasks, dependencies).forEach((layerTasks, layerIndex) => {
    layerTasks.forEach((task) => membership.set(task.id, layerIndex));
  });
  return membership;
}

function cloneArrangement(snapshot: ArrangementSnapshot): ArrangementSnapshot {
  return {
    direction: snapshot.direction,
    guides: snapshot.guides.map((guide) => ({ ...guide })),
    layerByTask: new Map(snapshot.layerByTask),
  };
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
      onDoubleClick={(event) => event.stopPropagation()}
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
  editable = true,
}: {
  title: string;
  completed: boolean;
  onSave: (title: string) => void;
  className?: string;
  editable?: boolean;
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

  if (!editable) {
    return (
      <span className={`inline-title is-static ${completed ? "is-completed" : ""} ${className}`}>
        {title}
      </span>
    );
  }

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

function DraftTaskNode({ data }: { data: DraftTaskNodeData }) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    const focusInput = () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    focusInput();
    const timer = window.setTimeout(focusInput, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const finish = (cancel = false) => {
    if (finished.current) return;
    finished.current = true;
    if (cancel || !title.trim()) data.onCancel();
    else data.onCommit(title);
  };

  return (
    <div className="task-node is-draft">
      <div className="draft-task-content">
        <span className="draft-task-check" aria-hidden="true" />
        <input
          ref={inputRef}
          autoFocus
          className="draft-task-input nodrag nopan"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => finish()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              finish();
            } else if (event.key === "Escape") {
              event.preventDefault();
              finish(true);
            }
          }}
          placeholder="Task name"
          aria-label="New task title"
        />
      </div>
    </div>
  );
}

function TaskNode({ id, data, width }: NodeProps<TaskFlowNode>) {
  if (data.draft) return <DraftTaskNode data={data} />;

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
      {CONNECTION_SIDES.map(({ side, position }) => (
        <Handle
          key={`target-${side}`}
          id={`target-${side}`}
          type="target"
          position={position}
          className={`connection-handle connection-target-handle connection-handle-${side}`}
        />
      ))}
      <div className="task-node-content">
        <CheckButton
          checked={data.completed}
          onClick={() => data.onToggle(id)}
          label={data.completed ? `Mark ${data.title} incomplete` : `Complete ${data.title}`}
        />
        <InlineTitle title={data.title} completed={data.completed} onSave={(title) => data.onRename(id, title)} className="node-title" editable={false} />
      </div>
      {CONNECTION_SIDES.map(({ side, position }) => (
        <Handle
          key={`source-${side}`}
          id={`source-${side}`}
          type="source"
          position={position}
          className={`connection-handle connection-source-handle connection-handle-${side}`}
        />
      ))}
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
      <EdgeToolbar
        edgeId={id}
        x={labelX}
        y={labelY}
        isVisible={selected}
        className="connection-toolbar nodrag nopan"
        style={{ zIndex: 2000 }}
      >
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

function nodeDimensions(node: TaskFlowNode): Size {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : Number.parseFloat(String(node.style?.width ?? ""));
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : Number.parseFloat(String(node.style?.height ?? ""));
  return {
    width: node.measured?.width ?? node.width ?? (Number.isFinite(styleWidth) ? styleWidth : NODE_MIN_WIDTH),
    height: node.measured?.height ?? node.height ?? (Number.isFinite(styleHeight) ? styleHeight : NODE_MIN_HEIGHT),
  };
}

function facingHandles(source: TaskFlowNode, target: TaskFlowNode) {
  const sourceSize = nodeDimensions(source);
  const targetSize = nodeDimensions(target);
  const sourceCenter = {
    x: source.position.x + sourceSize.width / 2,
    y: source.position.y + sourceSize.height / 2,
  };
  const targetCenter = {
    x: target.position.x + targetSize.width / 2,
    y: target.position.y + targetSize.height / 2,
  };
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const horizontalScore = Math.abs(dx) / Math.max(1, (sourceSize.width + targetSize.width) / 2);
  const verticalScore = Math.abs(dy) / Math.max(1, (sourceSize.height + targetSize.height) / 2);

  if (horizontalScore > verticalScore) {
    const sourceSide: ConnectionSide = dx >= 0 ? "right" : "left";
    const targetSide: ConnectionSide = dx >= 0 ? "left" : "right";
    return { sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}` };
  }

  const sourceSide: ConnectionSide = dy >= 0 ? "bottom" : "top";
  const targetSide: ConnectionSide = dy >= 0 ? "top" : "bottom";
  return { sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}` };
}

function hasPath(from: string, to: string, dependencies: Dependency[], ignoredEdgeId?: string) {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    dependencies
      .filter((edge) => edge.id !== ignoredEdgeId && edge.source === current)
      .forEach((edge) => queue.push(edge.target));
  }
  return false;
}

function minimalDependencies(dependencies: Dependency[]) {
  const seenPairs = new Set<string>();
  const uniqueDependencies = dependencies.filter((edge) => {
    const pair = `${edge.source}\u0000${edge.target}`;
    if (seenPairs.has(pair)) return false;
    seenPairs.add(pair);
    return true;
  });
  return uniqueDependencies.filter((edge) => !hasPath(edge.source, edge.target, uniqueDependencies, edge.id));
}

type DependencyIssue = "self" | "duplicate" | "cycle" | "implied" | null;

function dependencyIssue(source: string, target: string, dependencies: Dependency[], ignoredEdgeId?: string): DependencyIssue {
  const remaining = ignoredEdgeId ? dependencies.filter((edge) => edge.id !== ignoredEdgeId) : dependencies;
  if (source === target) return "self";
  if (remaining.some((edge) => edge.source === source && edge.target === target)) return "duplicate";
  if (hasPath(target, source, remaining)) return "cycle";
  if (hasPath(source, target, remaining)) return "implied";
  return null;
}

function dependencyIssueMessage(issue: Exclude<DependencyIssue, null>) {
  if (issue === "self") return "A task can’t depend on itself.";
  if (issue === "duplicate") return "Those tasks are already connected.";
  if (issue === "implied") return "Already connected through another task.";
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
          onDoubleClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest(".inline-title, .inline-title-input, .row-info, .check-button, .drag-grip")) return;
            onInspect(task.id);
          }}
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
  tasks,
  dependencies,
  onSave,
  onAddDependency,
  onRemoveDependency,
  onOpenTask,
  onDelete,
  onClose,
}: {
  task: Task;
  tasks: Task[];
  dependencies: Dependency[];
  onSave: (id: string, updates: Pick<Task, "title" | "notes">) => void;
  onAddDependency: (sourceId: string, targetId: string) => boolean;
  onRemoveDependency: (id: string) => void;
  onOpenTask: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [addingRelationship, setAddingRelationship] = useState<"before" | "after" | null>(null);
  const [relationshipSearch, setRelationshipSearch] = useState("");
  const relationshipSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setConfirmingDelete(false);
    setAddingRelationship(null);
    setRelationshipSearch("");
  }, [task.id, task.title, task.notes]);

  useEffect(() => {
    if (addingRelationship) relationshipSearchRef.current?.focus();
  }, [addingRelationship]);

  const commit = useCallback(() => {
    const cleanTitle = title.trim();
    onSave(task.id, { title: cleanTitle || task.title, notes: notes.trim() });
  }, [notes, onSave, task.id, task.title, title]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (addingRelationship) {
        setAddingRelationship(null);
        setRelationshipSearch("");
        return;
      }
      commit();
      onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [addingRelationship, commit, onClose]);

  const close = () => {
    commit();
    onClose();
  };

  const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const prerequisites = dependencies.flatMap((dependency) => {
    if (dependency.target !== task.id) return [];
    const connectedTask = tasksById.get(dependency.source);
    return connectedTask ? [{ dependency, task: connectedTask }] : [];
  });
  const followingTasks = dependencies.flatMap((dependency) => {
    if (dependency.source !== task.id) return [];
    const connectedTask = tasksById.get(dependency.target);
    return connectedTask ? [{ dependency, task: connectedTask }] : [];
  });
  const normalizedSearch = relationshipSearch.trim().toLocaleLowerCase();
  const availableRelationshipTasks = tasks.filter((candidate) => (
    candidate.id !== task.id
    && !dependencyIssue(
      addingRelationship === "after" ? task.id : candidate.id,
      addingRelationship === "after" ? candidate.id : task.id,
      dependencies,
    )
    && (!normalizedSearch || candidate.title.toLocaleLowerCase().includes(normalizedSearch))
  ));

  const relationshipRows = (
    relationships: { dependency: Dependency; task: Task }[],
    emptyMessage: string,
  ) => relationships.length ? (
    <div className="inspector-relationship-list">
      {relationships.map(({ dependency, task: connectedTask }) => (
        <div className={`inspector-relationship ${connectedTask.completed ? "is-completed" : ""}`} key={dependency.id}>
          <button
            type="button"
            className="relationship-open"
            onClick={() => {
              commit();
              onOpenTask(connectedTask.id);
            }}
            aria-label={`Open ${connectedTask.title}`}
          >
            <span className="relationship-status" aria-hidden="true"><CheckIcon /></span>
            <span title={connectedTask.title}>{connectedTask.title}</span>
          </button>
          <button
            type="button"
            className="relationship-remove"
            onClick={() => onRemoveDependency(dependency.id)}
            aria-label={`Remove connection to ${connectedTask.title}`}
            title="Remove"
          ><CloseIcon /></button>
        </div>
      ))}
    </div>
  ) : <p className="inspector-relationship-empty">{emptyMessage}</p>;

  const relationshipPicker = (direction: "before" | "after") => {
    if (addingRelationship !== direction) return null;
    const sourceId = direction === "before" ? undefined : task.id;
    const targetId = direction === "before" ? task.id : undefined;
    return (
      <div className="relationship-picker" id={`${direction}-task-picker`}>
        <input
          ref={relationshipSearchRef}
          value={relationshipSearch}
          onChange={(event) => setRelationshipSearch(event.target.value)}
          placeholder="Search tasks"
          aria-label={`Search tasks to add ${direction} this one`}
        />
        <div className="relationship-options">
          {availableRelationshipTasks.length ? availableRelationshipTasks.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              onClick={() => {
                if (!onAddDependency(sourceId ?? candidate.id, targetId ?? candidate.id)) return;
                setAddingRelationship(null);
                setRelationshipSearch("");
              }}
            >
              <span className={`relationship-status ${candidate.completed ? "is-completed" : ""}`} aria-hidden="true"><CheckIcon /></span>
              <span>{candidate.title}</span>
            </button>
          )) : (
            <p>{normalizedSearch ? "No matching tasks." : "No available tasks."}</p>
          )}
        </div>
      </div>
    );
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
        <section className="inspector-relationships" aria-labelledby="before-this-task">
          <div className="inspector-section-heading">
            <h3 id="before-this-task">Before this task</h3>
            <button
              type="button"
              className="relationship-add"
              onClick={() => {
                setAddingRelationship((open) => open === "before" ? null : "before");
                setRelationshipSearch("");
              }}
              aria-expanded={addingRelationship === "before"}
              aria-controls="before-task-picker"
            ><PlusIcon /> Add</button>
          </div>
          {relationshipPicker("before")}
          {relationshipRows(prerequisites, "Nothing needed first.")}
        </section>
        <section className="inspector-relationships" aria-labelledby="after-this-task">
          <div className="inspector-section-heading">
            <h3 id="after-this-task">After this task</h3>
            <button
              type="button"
              className="relationship-add"
              onClick={() => {
                setAddingRelationship((open) => open === "after" ? null : "after");
                setRelationshipSearch("");
              }}
              aria-expanded={addingRelationship === "after"}
              aria-controls="after-task-picker"
            ><PlusIcon /> Add</button>
          </div>
          {relationshipPicker("after")}
          {relationshipRows(followingTasks, "No tasks follow this one.")}
        </section>
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
  const [isDesktopWorkspace, setIsDesktopWorkspace] = useState(false);
  const [tasksPaneOpen, setTasksPaneOpen] = useState(true);
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
  const inspectorOpen = inspectedTaskId !== null;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [graphDraft, setGraphDraft] = useState<GraphDraft | null>(null);
  const [isArranging, setIsArranging] = useState(false);
  const [arrangedDirection, setArrangedDirection] = useState<LayoutDirection | null>(null);
  const [layoutGuides, setLayoutGuides] = useState<LayoutGuide[]>([]);
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>("vertical");
  const [arrangementOptionsOpen, setArrangementOptionsOpen] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [appearanceOptionsOpen, setAppearanceOptionsOpen] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arrangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arrangeFrame = useRef<number | null>(null);
  const arrangementVersion = useRef(0);
  const arrangedLayerByTask = useRef<Map<string, number>>(new Map());
  const activeArrangement = useRef<ArrangementSnapshot | null>(null);
  const pendingPreviousArrangement = useRef<ArrangementSnapshot | null | undefined>(undefined);
  const arrangementOptionsRef = useRef<HTMLDivElement>(null);
  const appearanceOptionsRef = useRef<HTMLDivElement>(null);
  const lastPaneClick = useRef<{ time: number; point: Point } | null>(null);
  const pendingNodePositions = useRef<Map<string, Point>>(new Map());
  const pendingNodeSizes = useRef<Map<string, Size>>(new Map());
  const flowInstance = useRef<ReactFlowInstance<TaskFlowNode, DependencyFlowEdge> | null>(null);
  const updateData = useCallback((update: (current: TaskData) => TaskData) => {
    const previousArrangement = pendingPreviousArrangement.current !== undefined
      ? pendingPreviousArrangement.current
      : activeArrangement.current;
    pendingPreviousArrangement.current = undefined;
    dispatchHistory({
      type: "update",
      update,
      arrangement: previousArrangement ? cloneArrangement(previousArrangement) : null,
    });
  }, []);
  const clearArrangement = useCallback(() => {
    arrangementVersion.current += 1;
    if (pendingPreviousArrangement.current === undefined) {
      pendingPreviousArrangement.current = activeArrangement.current
        ? cloneArrangement(activeArrangement.current)
        : null;
    }
    activeArrangement.current = null;
    setArrangedDirection(null);
    setLayoutGuides([]);
    arrangedLayerByTask.current.clear();
    if (arrangeFrame.current) {
      cancelAnimationFrame(arrangeFrame.current);
      arrangeFrame.current = null;
    }
    if (arrangeTimer.current) {
      clearTimeout(arrangeTimer.current);
      arrangeTimer.current = null;
    }
    setIsArranging(false);
  }, []);
  const restoreArrangement = useCallback((remembered: ArrangementSnapshot | null | undefined) => {
    arrangementVersion.current += 1;
    pendingPreviousArrangement.current = undefined;
    if (arrangeFrame.current) {
      cancelAnimationFrame(arrangeFrame.current);
      arrangeFrame.current = null;
    }
    if (arrangeTimer.current) {
      clearTimeout(arrangeTimer.current);
      arrangeTimer.current = null;
    }
    if (remembered) {
      const snapshot = cloneArrangement(remembered);
      activeArrangement.current = cloneArrangement(snapshot);
      setArrangedDirection(snapshot.direction);
      setLayoutGuides(snapshot.guides);
      arrangedLayerByTask.current = snapshot.layerByTask;
    } else {
      activeArrangement.current = null;
      setArrangedDirection(null);
      setLayoutGuides([]);
      arrangedLayerByTask.current.clear();
    }
    setIsArranging(false);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_WORKSPACE_QUERY);
    const updateWorkspaceMode = () => setIsDesktopWorkspace(media.matches);
    updateWorkspaceMode();
    media.addEventListener("change", updateWorkspaceMode);
    return () => media.removeEventListener("change", updateWorkspaceMode);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const savedData = JSON.parse(saved) as TaskData;
        dispatchHistory({
          type: "reset",
          data: { ...savedData, dependencies: minimalDependencies(savedData.dependencies) },
        });
      }
      const savedDirection = window.localStorage.getItem(LAYOUT_DIRECTION_KEY);
      if (savedDirection === "vertical" || savedDirection === "horizontal") setLayoutDirection(savedDirection);
      const savedAppearance = window.localStorage.getItem(APPEARANCE_KEY);
      if (savedAppearance === "light" || savedAppearance === "dark" || savedAppearance === "system") {
        setAppearance(savedAppearance);
      }
    } catch {
      // Keep the sample data if saved data is unavailable or malformed.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data, hydrated]);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(LAYOUT_DIRECTION_KEY, layoutDirection);
  }, [hydrated, layoutDirection]);

  useEffect(() => {
    if (!hydrated) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolved = appearance === "system" ? (media.matches ? "dark" : "light") : appearance;
      document.documentElement.dataset.theme = appearance;
      document.documentElement.dataset.resolvedTheme = resolved;
      document.documentElement.style.colorScheme = resolved;
      window.localStorage.setItem(APPEARANCE_KEY, appearance);
    };
    applyAppearance();
    if (appearance !== "system") return;
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [appearance, hydrated]);

  useEffect(() => {
    if (!arrangementOptionsOpen) return;
    const closeOptions = (event: PointerEvent) => {
      if (event.target instanceof Element && arrangementOptionsRef.current?.contains(event.target)) return;
      setArrangementOptionsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setArrangementOptionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOptions);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOptions);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [arrangementOptionsOpen]);

  useEffect(() => {
    if (!appearanceOptionsOpen) return;
    const closeOptions = (event: PointerEvent) => {
      if (event.target instanceof Element && appearanceOptionsRef.current?.contains(event.target)) return;
      setAppearanceOptionsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAppearanceOptionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOptions);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOptions);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [appearanceOptionsOpen]);

  useEffect(() => {
    if ((!isDesktopWorkspace && view !== "graph") || !flowInstance.current) return;
    const timer = setTimeout(() => {
      void flowInstance.current?.fitView({ padding: 0.14, maxZoom: 1.15, duration: 180 });
    }, 80);
    return () => clearTimeout(timer);
  }, [inspectorOpen, isDesktopWorkspace, view]);

  useEffect(() => () => {
    arrangementVersion.current += 1;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
    if (arrangeTimer.current) clearTimeout(arrangeTimer.current);
    if (arrangeFrame.current) cancelAnimationFrame(arrangeFrame.current);
  }, []);

  useEffect(() => {
    const handleDelete = (event: globalThis.KeyboardEvent) => {
      if (
        (!selectedTaskId && ((!isDesktopWorkspace && view !== "graph") || !selectedEdgeId))
        || (event.key !== "Delete" && event.key !== "Backspace")
      ) return;
      const target = event.target as Element | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();

      if (selectedTaskId) {
        clearArrangement();
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

      clearArrangement();
      updateData((current) => {
        const dependencies = current.dependencies.filter((edge) => edge.id !== selectedEdgeId);
        if (dependencies.length === current.dependencies.length) return current;
        return { ...current, dependencies };
      });
      setSelectedEdgeId(null);
    };
    window.addEventListener("keydown", handleDelete);
    return () => window.removeEventListener("keydown", handleDelete);
  }, [clearArrangement, isDesktopWorkspace, selectedEdgeId, selectedTaskId, updateData, view]);

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
    clearArrangement();
    updateData((current) => {
      const task = current.tasks.find((candidate) => candidate.id === id);
      if (!task || task.title === title) return current;
      return {
        ...current,
        tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, title } : candidate),
      };
    });
  }, [clearArrangement, updateData]);

  const saveTaskDetails = useCallback((id: string, updates: Pick<Task, "title" | "notes">) => {
    if (data.tasks.find((task) => task.id === id)?.title !== updates.title) clearArrangement();
    updateData((current) => {
      const task = current.tasks.find((candidate) => candidate.id === id);
      if (!task || (task.title === updates.title && (task.notes ?? "") === (updates.notes ?? ""))) return current;
      return {
        ...current,
        tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, ...updates } : candidate),
      };
    });
  }, [clearArrangement, data.tasks, updateData]);

  const deleteTask = useCallback((id: string) => {
    clearArrangement();
    setInspectedTaskId((inspected) => inspected === id ? null : inspected);
    setSelectedTaskId((selected) => selected === id ? null : selected);
    updateData((current) => ({
      tasks: current.tasks.filter((task) => task.id !== id),
      dependencies: current.dependencies.filter((edge) => edge.source !== id && edge.target !== id),
    }));
  }, [clearArrangement, updateData]);

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const title = newTask.trim();
    if (!title) return;
    clearArrangement();
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

  const beginGraphTask = useCallback((screenPoint: Point) => {
    if (graphDraft || !flowInstance.current) return;
    const flowPoint = flowInstance.current.screenToFlowPosition(screenPoint);
    setGraphDraft({
      id: `draft-${uid()}`,
      anchor: flowPoint,
    });
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
  }, [graphDraft]);

  const cancelGraphTask = useCallback(() => {
    setGraphDraft(null);
  }, []);

  const commitGraphTask = useCallback((title: string) => {
    const clean = title.trim();
    if (!graphDraft || !clean) {
      setGraphDraft(null);
      return;
    }

    const task: Task = {
      id: graphDraft.id,
      title: clean,
      completed: false,
      position: {
        x: graphDraft.anchor.x - NODE_TITLE_OFFSET_X,
        y: graphDraft.anchor.y - NODE_MIN_HEIGHT / 2,
      },
    };
    clearArrangement();
    setGraphDraft(null);
    updateData((current) => ({ ...current, tasks: [...current.tasks, task] }));
    setSelectedTaskId(task.id);
    setSelectedEdgeId(null);
  }, [clearArrangement, graphDraft, updateData]);

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

  const taskNodes = useMemo<TaskFlowNode[]>(() => {
    const nodes: TaskFlowNode[] = data.tasks.map((task) => ({
      id: task.id,
      type: "task",
      selected: task.id === selectedTaskId,
      position: task.position,
      style: task.size ?? automaticNodeSize(task.title),
      data: {
        draft: false,
        title: task.title,
        completed: task.completed,
        blocked: blockedIds.has(task.id),
        onToggle: toggleTask,
        onRename: renameTask,
      },
    }));

    if (graphDraft) {
      nodes.push({
        id: graphDraft.id,
        type: "task",
        position: {
          x: graphDraft.anchor.x - NODE_TITLE_OFFSET_X,
          y: graphDraft.anchor.y - NODE_MIN_HEIGHT / 2,
        },
        style: { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT },
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        data: {
          draft: true,
          title: "",
          completed: false,
          blocked: false,
          onCommit: commitGraphTask,
          onCancel: cancelGraphTask,
        },
      });
    }

    return nodes;
  }, [blockedIds, cancelGraphTask, commitGraphTask, data.tasks, graphDraft, renameTask, selectedTaskId, toggleTask]);

  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<TaskFlowNode>(taskNodes);

  useEffect(() => {
    setFlowNodes(taskNodes);
  }, [taskNodes, setFlowNodes]);

  const removeDependency = useCallback((id: string) => {
    clearArrangement();
    updateData((current) => {
      const dependencies = current.dependencies.filter((edge) => edge.id !== id);
      if (dependencies.length === current.dependencies.length) return current;
      return { ...current, dependencies };
    });
    setSelectedEdgeId(null);
  }, [clearArrangement, updateData]);

  const flowEdges = useMemo<DependencyFlowEdge[]>(() => {
    const nodesById = new Map(flowNodes.map((node) => [node.id, node]));
    return data.dependencies.map((edge) => {
      const selected = edge.id === selectedEdgeId;
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const handles = sourceNode && targetNode ? facingHandles(sourceNode, targetNode) : {};
      return {
        ...edge,
        ...handles,
        selected,
        type: "dependency",
        reconnectable: selected,
        data: { onRemove: removeDependency },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: selected ? "var(--blue)" : "var(--edge)" },
        style: { stroke: "var(--edge)", strokeWidth: 1.35 },
        interactionWidth: 26,
      };
    });
  }, [data.dependencies, flowNodes, removeDependency, selectedEdgeId]);

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
    let sizeChanged = false;
    changes.forEach((change) => {
      if (change.type === "position" && change.position && (change.dragging || pendingNodePositions.current.has(change.id))) {
        pendingNodePositions.current.set(change.id, change.position);
      }
      if (change.type === "dimensions" && change.dimensions && (change.resizing || pendingNodeSizes.current.has(change.id))) {
        pendingNodeSizes.current.set(change.id, change.dimensions);
        sizeChanged = true;
      }
    });
    if (sizeChanged) {
      clearArrangement();
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = setTimeout(flushNodeLayout, 140);
    }
  }, [clearArrangement, flushNodeLayout, onFlowNodesChange]);

  const finishNodeDrag = useCallback((node: TaskFlowNode) => {
    if (arrangedDirection) {
      const layerIndex = arrangedLayerByTask.current.get(node.id);
      const guide = layerIndex === undefined ? undefined : layoutGuides[layerIndex];
      const position = pendingNodePositions.current.get(node.id) ?? node.position;
      const size = pendingNodeSizes.current.get(node.id) ?? nodeDimensions(node);
      const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
      const remainsInAssignedLayer = guide ? (arrangedDirection === "vertical"
        ? center.y >= guide.y && center.y <= guide.y + guide.height
        : center.x >= guide.x && center.x <= guide.x + guide.width) : false;
      if (!remainsInAssignedLayer) clearArrangement();
    }
    flushNodeLayout();
  }, [arrangedDirection, clearArrangement, flushNodeLayout, layoutGuides]);

  const arrangeGraph = useCallback((direction: LayoutDirection = layoutDirection) => {
    flushNodeLayout();
    if (arrangeFrame.current) {
      cancelAnimationFrame(arrangeFrame.current);
      arrangeFrame.current = null;
    }
    if (arrangeTimer.current) {
      clearTimeout(arrangeTimer.current);
      arrangeTimer.current = null;
    }
    const preservesCurrentBands = arrangedDirection === direction && layoutGuides.length > 0;
    if (preservesCurrentBands) return;

    const version = arrangementVersion.current + 1;
    arrangementVersion.current = version;
    if (pendingPreviousArrangement.current === undefined) {
      pendingPreviousArrangement.current = activeArrangement.current
        ? cloneArrangement(activeArrangement.current)
        : null;
    }
    activeArrangement.current = null;
    setArrangedDirection(null);
    setLayoutGuides([]);
    arrangedLayerByTask.current.clear();
    setIsArranging(true);
    arrangeFrame.current = requestAnimationFrame(() => {
      arrangeFrame.current = null;
      updateData((current) => {
        const tasks = arrangeTasks(current.tasks, current.dependencies, direction);
        return tasks === current.tasks ? current : { ...current, tasks };
      });
      arrangeTimer.current = setTimeout(() => {
        arrangeTimer.current = null;
        void (async () => {
          await flowInstance.current?.fitView({ padding: 0.14, maxZoom: 1.15, duration: 320 });
          if (arrangementVersion.current !== version) return;
          const nodesById = new Map(flowInstance.current?.getNodes().map((node) => [node.id, node]) ?? []);
          const settledTasks = data.tasks.map((task) => {
            const node = nodesById.get(task.id);
            return node ? { ...task, position: node.position, size: nodeDimensions(node) } : task;
          });
          const snapshot = {
            direction,
            guides: arrangementGuides(settledTasks, data.dependencies, direction),
            layerByTask: layerMembership(settledTasks, data.dependencies),
          };
          activeArrangement.current = cloneArrangement(snapshot);
          setLayoutGuides(snapshot.guides);
          arrangedLayerByTask.current = snapshot.layerByTask;
          setArrangedDirection(direction);
          setIsArranging(false);
        })();
      }, 360);
    });
  }, [arrangedDirection, data.dependencies, data.tasks, flushNodeLayout, layoutDirection, layoutGuides.length, updateData]);

  const chooseLayoutDirection = useCallback((direction: LayoutDirection) => {
    setLayoutDirection(direction);
    setArrangementOptionsOpen(false);
  }, []);

  const addDependency = useCallback((source: string, target: string) => {
    const issue = dependencyIssue(source, target, data.dependencies);
    if (issue) {
      showNotice(dependencyIssueMessage(issue));
      return false;
    }
    const edge: Dependency = { id: `${source}--${target}--${uid()}`, source, target };
    const preview = [...data.dependencies, edge];
    const simplifiesGraph = minimalDependencies(preview).length < preview.length;
    clearArrangement();
    updateData((current) => {
      if (dependencyIssue(source, target, current.dependencies)) return current;
      const dependencies = addEdge(edge, current.dependencies) as Dependency[];
      return { ...current, dependencies: minimalDependencies(dependencies) };
    });
    if (simplifiesGraph) showNotice("Removed an unnecessary connection.");
    return true;
  }, [clearArrangement, data.dependencies, showNotice, updateData]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    addDependency(connection.source, connection.target);
  }, [addDependency]);

  const onReconnect = useCallback((oldEdge: DependencyFlowEdge, connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const { source, target } = connection;
    const issue = dependencyIssue(source, target, data.dependencies, oldEdge.id);
    if (issue) {
      showNotice(dependencyIssueMessage(issue));
      return;
    }
    const preview = data.dependencies.map((edge) => edge.id === oldEdge.id ? { ...edge, source, target } : edge);
    const simplifiesGraph = minimalDependencies(preview).length < preview.length;
    clearArrangement();
    updateData((current) => {
      if (dependencyIssue(source, target, current.dependencies, oldEdge.id)) return current;
      const index = current.dependencies.findIndex((edge) => edge.id === oldEdge.id);
      if (index < 0) return current;
      if (current.dependencies[index].source === source && current.dependencies[index].target === target) return current;
      const dependencies = [...current.dependencies];
      dependencies[index] = { ...dependencies[index], source, target };
      return { ...current, dependencies: minimalDependencies(dependencies) };
    });
    setSelectedEdgeId(oldEdge.id);
    if (simplifiesGraph) showNotice("Removed an unnecessary connection.");
  }, [clearArrangement, data.dependencies, showNotice, updateData]);

  const removeEdges = useCallback((edges: Edge[]) => {
    const ids = new Set(edges.map((edge) => edge.id));
    clearArrangement();
    updateData((current) => {
      const dependencies = current.dependencies.filter((edge) => !ids.has(edge.id));
      if (dependencies.length === current.dependencies.length) return current;
      return { ...current, dependencies };
    });
    setSelectedEdgeId(null);
  }, [clearArrangement, updateData]);

  const undo = useCallback(() => {
    flushNodeLayout();
    const currentArrangement = activeArrangement.current ? cloneArrangement(activeArrangement.current) : null;
    restoreArrangement(history.past.at(-1)?.arrangement);
    dispatchHistory({ type: "undo", arrangement: currentArrangement });
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
  }, [flushNodeLayout, history.past, restoreArrangement]);

  const redo = useCallback(() => {
    flushNodeLayout();
    const currentArrangement = activeArrangement.current ? cloneArrangement(activeArrangement.current) : null;
    restoreArrangement(history.future[0]?.arrangement);
    dispatchHistory({ type: "redo", arrangement: currentArrangement });
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
  }, [flushNodeLayout, history.future, restoreArrangement]);

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

  const revealTaskOnGraph = useCallback((id: string) => {
    if (!isDesktopWorkspace) return;
    window.requestAnimationFrame(() => {
      const instance = flowInstance.current;
      const panel = document.querySelector<HTMLElement>(".graph-panel");
      const node = panel?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      if (!instance || !panel || !node) return;

      const panelBounds = panel.getBoundingClientRect();
      const nodeBounds = node.getBoundingClientRect();
      const center = {
        x: nodeBounds.left + nodeBounds.width / 2,
        y: nodeBounds.top + nodeBounds.height / 2,
      };
      const margin = 32;
      const isVisible = center.x >= panelBounds.left + margin
        && center.x <= panelBounds.right - margin
        && center.y >= panelBounds.top + margin
        && center.y <= panelBounds.bottom - margin;
      if (isVisible) return;

      const flowCenter = instance.screenToFlowPosition(center);
      void instance.setCenter(flowCenter.x, flowCenter.y, {
        zoom: instance.getZoom(),
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
      });
    });
  }, [isDesktopWorkspace]);

  const revealTaskInList = useCallback((id: string) => {
    if (!isDesktopWorkspace || !tasksPaneOpen) return;
    window.requestAnimationFrame(() => {
      const pane = document.getElementById("tasks-pane");
      const row = pane?.querySelector<HTMLElement>(`.task-row[data-task-id="${CSS.escape(id)}"]`);
      if (!pane || !row) return;

      const paneBounds = pane.getBoundingClientRect();
      const rowBounds = row.getBoundingClientRect();
      const margin = 8;
      const isVisible = rowBounds.top >= paneBounds.top + margin && rowBounds.bottom <= paneBounds.bottom - margin;
      if (isVisible) return;
      row.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  }, [isDesktopWorkspace, tasksPaneOpen]);

  const selectTaskFromList = useCallback((id: string) => {
    setSelectedTaskId(id);
    setSelectedEdgeId(null);
    setInspectedTaskId((inspected) => inspected ? id : null);
    revealTaskOnGraph(id);
  }, [revealTaskOnGraph]);

  const openTaskFromInspector = useCallback((id: string) => {
    setSelectedTaskId(id);
    setSelectedEdgeId(null);
    setInspectedTaskId(id);
    revealTaskOnGraph(id);
    revealTaskInList(id);
  }, [revealTaskInList, revealTaskOnGraph]);

  const listPanel = (
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
        onSelect={selectTaskFromList}
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
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-leading">
          <div className="brand" aria-label="Tangle home">
            <span className="brand-mark"><CheckIcon /></span>
            <span>Tangle</span>
          </div>
          {isDesktopWorkspace && (
            <button
              type="button"
              className={`tasks-pane-toggle ${tasksPaneOpen ? "is-active" : ""}`}
              onClick={() => setTasksPaneOpen((open) => !open)}
              aria-label={tasksPaneOpen ? "Hide tasks" : "Show tasks"}
              aria-controls="tasks-pane"
              aria-expanded={tasksPaneOpen}
              title={tasksPaneOpen ? "Hide tasks" : "Show tasks"}
            ><SidebarIcon /></button>
          )}
        </div>
        {!isDesktopWorkspace && (
          <div className="view-toggle" role="tablist" aria-label="Choose a view">
            <button
              type="button"
              role="tab"
              aria-selected={view === "list"}
              className={view === "list" ? "active" : ""}
              onClick={() => {
                setGraphDraft(null);
                setView("list");
              }}
            >List</button>
            <button type="button" role="tab" aria-selected={view === "graph"} className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>Graph</button>
          </div>
        )}
        <div className="header-actions">
          <div className="appearance-control" ref={appearanceOptionsRef}>
            <button
              type="button"
              className="appearance-button"
              onClick={() => setAppearanceOptionsOpen((open) => !open)}
              aria-label="Appearance"
              aria-expanded={appearanceOptionsOpen}
              aria-haspopup="dialog"
              title="Appearance"
            ><AppearanceIcon /></button>
            {appearanceOptionsOpen && (
              <div className="appearance-popover" role="dialog" aria-label="Appearance">
                <span>Appearance</span>
                <div className="appearance-options">
                  {(["system", "light", "dark"] as Appearance[]).map((option) => (
                    <button
                      type="button"
                      key={option}
                      className={appearance === option ? "is-active" : ""}
                      aria-pressed={appearance === option}
                      onClick={() => {
                        setAppearance(option);
                        setAppearanceOptionsOpen(false);
                      }}
                    >{option[0].toUpperCase() + option.slice(1)}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
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
        <section className={`workspace ${isDesktopWorkspace ? "unified-workspace" : view === "graph" ? "graph-workspace" : "list-workspace"}`}>
          {isDesktopWorkspace && tasksPaneOpen && (
            <aside id="tasks-pane" className="tasks-pane" aria-label="Tasks">
              {listPanel}
            </aside>
          )}
          {!isDesktopWorkspace && view === "list" ? listPanel : (
          <div className={`graph-panel ${isArranging ? "is-arranging" : ""}`}>
            <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => { flowInstance.current = instance; }}
                onNodesChange={handleFlowNodesChange}
                onNodeDragStop={(_event, node) => finishNodeDrag(node)}
                onConnect={onConnect}
                connectionRadius={NODE_CONNECTION_RADIUS}
                onReconnect={onReconnect}
                reconnectRadius={EDGE_RECONNECT_RADIUS}
                onEdgesDelete={removeEdges}
                onNodeClick={(event, node) => {
                  if (node.data.draft) return;
                  if (event.target instanceof Element && event.target.closest(".react-flow__handle")) return;
                  setSelectedTaskId(node.id);
                  setSelectedEdgeId(null);
                  setInspectedTaskId((inspected) => inspected ? node.id : null);
                  revealTaskInList(node.id);
                }}
                onNodeDoubleClick={(event, node) => {
                  if (node.data.draft) return;
                  if (event.target instanceof Element && event.target.closest(".check-button, .react-flow__handle")) return;
                  event.stopPropagation();
                  setSelectedTaskId(node.id);
                  setSelectedEdgeId(null);
                  setInspectedTaskId(node.id);
                  revealTaskInList(node.id);
                }}
                onEdgeClick={(event, edge) => {
                  event.stopPropagation();
                  setSelectedTaskId(null);
                  setSelectedEdgeId(edge.id);
                }}
                onPaneClick={(event) => {
                  setSelectedTaskId(null);
                  setSelectedEdgeId(null);
                  const point = { x: event.clientX, y: event.clientY };
                  const previous = lastPaneClick.current;
                  const elapsed = previous ? event.timeStamp - previous.time : Infinity;
                  const distance = previous ? Math.hypot(point.x - previous.point.x, point.y - previous.point.y) : Infinity;
                  const isDoubleActivation = event.detail === 2 || (elapsed > 0 && elapsed < 360 && distance < 24);
                  lastPaneClick.current = isDoubleActivation ? null : { time: event.timeStamp, point };
                  if (isDoubleActivation) beginGraphTask(point);
                }}
                deleteKeyCode={null}
                zoomOnDoubleClick={false}
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
                aria-label="Task connections. Double-click empty space to add a task."
              >
                {!!layoutGuides.length && (
                  <ViewportPortal>
                    <div className={`layout-guides is-${arrangedDirection}`} aria-hidden="true">
                      {layoutGuides.map((guide, index) => (
                        <div
                          key={guide.id}
                          className={`layout-guide ${index % 2 ? "is-alternate" : ""}`}
                          data-layer={index + 1}
                          style={{
                            width: guide.width,
                            height: guide.height,
                            transform: `translate(${guide.x}px, ${guide.y}px)`,
                          }}
                        />
                      ))}
                    </div>
                  </ViewportPortal>
                )}
                <Background color="var(--grid)" gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
            {!data.tasks.length && !graphDraft && (
              <div className="graph-empty" aria-hidden="true">
                <p>Double-click anywhere to add a task.</p>
              </div>
            )}
            {!!data.tasks.length && (
              <div className="graph-actions" ref={arrangementOptionsRef}>
                <div className="arrange-control">
                  <button
                    className="arrange-button"
                    type="button"
                    onClick={() => {
                      setArrangementOptionsOpen(false);
                      arrangeGraph();
                    }}
                    disabled={isArranging}
                    title={`Arrange ${layoutDirection === "vertical" ? "top to bottom" : "left to right"}`}
                  >
                    <ArrangeIcon /> Arrange
                  </button>
                  <button
                    className="arrange-settings-button"
                    type="button"
                    onClick={() => setArrangementOptionsOpen((open) => !open)}
                    aria-label="Arrangement options"
                    aria-expanded={arrangementOptionsOpen}
                    aria-haspopup="dialog"
                    title="Arrangement options"
                  ><SettingsIcon /></button>
                </div>
                {arrangementOptionsOpen && (
                  <div className="arrange-popover" role="dialog" aria-label="Arrangement options">
                    <span>Direction</span>
                    <div className="layout-direction" aria-label="Arrange direction">
                      <button
                        type="button"
                        className={layoutDirection === "vertical" ? "is-active" : ""}
                        aria-pressed={layoutDirection === "vertical"}
                        onClick={() => chooseLayoutDirection("vertical")}
                      >Vertical</button>
                      <button
                        type="button"
                        className={layoutDirection === "horizontal" ? "is-active" : ""}
                        aria-pressed={layoutDirection === "horizontal"}
                        onClick={() => chooseLayoutDirection("horizontal")}
                      >Horizontal</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!!data.tasks.length && (
              <div className="graph-help">Double-click tasks for details · Double-click space to add · Hover to connect</div>
            )}
          </div>
          )}
        </section>
        {inspectedTask && (
          <TaskInspector
            task={inspectedTask}
            tasks={data.tasks}
            dependencies={data.dependencies}
            onSave={saveTaskDetails}
            onAddDependency={addDependency}
            onRemoveDependency={removeDependency}
            onOpenTask={openTaskFromInspector}
            onDelete={deleteTask}
            onClose={closeInspector}
          />
        )}
      </div>
      <div className={`notice ${notice ? "is-visible" : ""}`} role="status" aria-live="polite">{notice}</div>
    </main>
  );
}

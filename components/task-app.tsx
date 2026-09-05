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
import { ChangeEvent, FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppearanceIcon, ArrangeIcon, CheckIcon, ChevronIcon, CloseIcon, GripIcon, InfoIcon, PlusIcon, RedoIcon, SettingsIcon, SidebarIcon, SortIcon, TrashIcon, UndoIcon } from "./icons";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type GraphDraft = { id: string; anchor: Point };
type Task = { id: string; title: string; completed: boolean; position: Point; size?: Size; notes?: string };
type Dependency = { id: string; source: string; target: string };
type TaskData = { tasks: Task[]; dependencies: Dependency[] };
type PendingImport = { data: TaskData; fileName: string };
type View = "list" | "graph";
type Appearance = "system" | "light" | "dark";
type LayoutDirection = "vertical" | "horizontal";
type ListOrder = "manual" | "up-next";
type DropPlacement = "before" | "after";
type DropTarget = { id: string; placement: DropPlacement };
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
type Rect = { left: number; top: number; right: number; bottom: number };
type DependencyEdgeData = {
  onRemove: (id: string) => void;
  obstacles: Rect[];
  sourceDockOffset: number;
  targetDockOffset: number;
};
type DependencyFlowEdge = Edge<DependencyEdgeData, "dependency">;
type ConnectionSide = "top" | "right" | "bottom" | "left";

const STORAGE_KEY = "carpaccio-task-data-v1";
const LAYOUT_DIRECTION_KEY = "carpaccio-layout-direction-v1";
const APPEARANCE_KEY = "carpaccio-appearance-v1";
const LIST_ORDER_KEY = "carpaccio-list-order-v1";
const SHOW_COMPLETED_GRAPH_KEY = "carpaccio-show-completed-graph-v1";
const BACKUP_FORMAT = "carpaccio-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const COMPLETION_SETTLE_MS = 640;
const NODE_MIN_WIDTH = 230;
const NODE_MAX_AUTO_WIDTH = 360;
const NODE_MAX_WIDTH = 560;
const NODE_MIN_HEIGHT = 52;
const NODE_MAX_HEIGHT = 320;
const NODE_TITLE_OFFSET_X = 43;
const HISTORY_LIMIT = 100;
const EDGE_RECONNECT_RADIUS = 18;
const EDGE_ROUTE_CLEARANCE = 12;
const EDGE_ROUTE_STUB = 20;
const EDGE_MIN_APPROACH = 16;
const EDGE_ROUTE_BEND_PENALTY = 16;
const EDGE_DOCK_SWITCH_THRESHOLD = 24;
const EDGE_CORNER_RADIUS = 5;
const EDGE_DOCK_SPACING = 14;
const EDGE_DOCK_INSET = 12;
const EDGE_HANDLE_OUTSET = 4;
const NODE_CONNECTION_RADIUS = 28;
const NODE_MIN_CLEARANCE = 16;
const LAYOUT_START_X = 72;
const LAYOUT_START_Y = 72;
const LAYOUT_LAYER_GAP = 110;
const LAYOUT_SIBLING_GAP = NODE_MIN_CLEARANCE;
const LAYOUT_GUIDE_EXTENT = 50_000;
const AUTOMATIC_FIT_MIN_ZOOM = 0.7;
const DESKTOP_WORKSPACE_QUERY = "(min-width: 1180px)";
const CONNECTION_SIDES: { side: ConnectionSide; position: Position }[] = [
  { side: "top", position: Position.Top },
  { side: "right", position: Position.Right },
  { side: "bottom", position: Position.Bottom },
  { side: "left", position: Position.Left },
];

const EMPTY_DATA: TaskData = { tasks: [], dependencies: [] };

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

function rectAt(position: Point, size: Size): Rect {
  return {
    left: position.x,
    top: position.y,
    right: position.x + size.width,
    bottom: position.y + size.height,
  };
}

function rectsHaveClearance(left: Rect, right: Rect, clearance = NODE_MIN_CLEARANCE) {
  return left.right + clearance <= right.left
    || right.right + clearance <= left.left
    || left.bottom + clearance <= right.top
    || right.bottom + clearance <= left.top;
}

function positionHasClearance(position: Point, size: Size, obstacles: Rect[]) {
  const rect = rectAt(position, size);
  return obstacles.every((obstacle) => rectsHaveClearance(rect, obstacle));
}

function nearestClearPosition(position: Point, size: Size, obstacles: Rect[]): Point {
  if (positionHasClearance(position, size, obstacles)) return position;

  const xCandidates = new Set([position.x]);
  const yCandidates = new Set([position.y]);
  obstacles.forEach((obstacle) => {
    xCandidates.add(obstacle.left - NODE_MIN_CLEARANCE - size.width);
    xCandidates.add(obstacle.right + NODE_MIN_CLEARANCE);
    yCandidates.add(obstacle.top - NODE_MIN_CLEARANCE - size.height);
    yCandidates.add(obstacle.bottom + NODE_MIN_CLEARANCE);
  });
  const candidates: Point[] = [];
  xCandidates.forEach((x) => candidates.push({ x, y: position.y }));
  yCandidates.forEach((y) => candidates.push({ x: position.x, y }));
  xCandidates.forEach((x) => yCandidates.forEach((y) => candidates.push({ x, y })));

  return candidates
    .filter((candidate) => positionHasClearance(candidate, size, obstacles))
    .sort((left, right) => {
      const leftDistance = (left.x - position.x) ** 2 + (left.y - position.y) ** 2;
      const rightDistance = (right.x - position.x) ** 2 + (right.y - position.y) ** 2;
      return leftDistance - rightDistance
        || Math.abs(left.y - position.y) - Math.abs(right.y - position.y)
        || left.x - right.x
        || left.y - right.y;
    })[0] ?? position;
}

function withSpacingNodeClass(className: string | undefined, state: "invalid" | "snapping" | null) {
  const classes = new Set((className ?? "").split(/\s+/).filter(Boolean));
  classes.delete("spacing-invalid");
  classes.delete("spacing-snapping");
  if (state === "invalid") classes.add("spacing-invalid");
  if (state === "snapping") classes.add("spacing-snapping");
  return [...classes].join(" ") || undefined;
}

function nextOpenPosition(tasks: Task[], size: Size): Point {
  const obstacles = tasks.map((task) => rectAt(task.position, task.size ?? automaticNodeSize(task.title)));
  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const candidate = { x: 70 + column * 280, y: 70 + row * 115 };
      if (positionHasClearance(candidate, size, obstacles)) return candidate;
    }
  }
  return nearestClearPosition({ x: 70, y: 70 + tasks.length * 115 }, size, obstacles);
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

function upNextTaskOrder(tasks: Task[], dependencies: Dependency[]) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const manualIndex = new Map(tasks.map((task, index) => [task.id, index]));
  const outgoing = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));

  dependencies.forEach(({ source, target }) => {
    if (!taskIds.has(source) || !taskIds.has(target)) return;
    outgoing.get(source)?.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  });

  const downstreamReach = new Map<string, number>();
  tasks.forEach((task) => {
    const descendants = new Set<string>();
    const queue = [...(outgoing.get(task.id) ?? [])];
    while (queue.length) {
      const descendant = queue.shift()!;
      if (descendants.has(descendant)) continue;
      descendants.add(descendant);
      queue.push(...(outgoing.get(descendant) ?? []));
    }
    downstreamReach.set(task.id, descendants.size);
  });

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const ordered: Task[] = [];
  const placed = new Set<string>();
  let layer = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const unlockedCount = layer.length;

  while (layer.length) {
    layer.sort((left, right) => {
      const leftUnlocks = (outgoing.get(left) ?? []).filter((target) => indegree.get(target) === 1).length;
      const rightUnlocks = (outgoing.get(right) ?? []).filter((target) => indegree.get(target) === 1).length;
      return rightUnlocks - leftUnlocks
        || (downstreamReach.get(right) ?? 0) - (downstreamReach.get(left) ?? 0)
        || (manualIndex.get(left) ?? 0) - (manualIndex.get(right) ?? 0);
    });
    layer.forEach((id) => {
      const task = taskById.get(id);
      if (task) ordered.push(task);
      placed.add(id);
    });

    const nextLayer: string[] = [];
    layer.forEach((source) => {
      (outgoing.get(source) ?? []).forEach((target) => {
        const nextIndegree = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, nextIndegree);
        if (nextIndegree === 0) nextLayer.push(target);
      });
    });
    layer = nextLayer;
  }

  tasks.forEach((task) => {
    if (!placed.has(task.id)) ordered.push(task);
  });
  return { tasks: ordered, unlockedCount };
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
  activation = "click",
}: {
  title: string;
  completed: boolean;
  onSave: (title: string) => void;
  className?: string;
  activation?: "click" | "double-click";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setDraft(title), [title]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const restoreTitleFocus = () => window.requestAnimationFrame(() => titleButtonRef.current?.focus());

  const commit = (restoreFocus = false) => {
    const clean = draft.trim();
    setEditing(false);
    if (clean && clean !== title) onSave(clean);
    else setDraft(title);
    if (restoreFocus) restoreTitleFocus();
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`inline-title-input nodrag nopan ${className}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(true);
          if (event.key === "Escape") {
            setDraft(title);
            setEditing(false);
            restoreTitleFocus();
          }
        }}
        aria-label="Task title"
      />
    );
  }

  return (
    <button
      ref={titleButtonRef}
      type="button"
      className={`inline-title nodrag nopan ${completed ? "is-completed" : ""} ${className}`}
      onClick={(event) => {
        if (activation === "click") {
          event.stopPropagation();
          setEditing(true);
        }
      }}
      onDoubleClick={(event) => {
        if (activation === "double-click") {
          event.stopPropagation();
          setEditing(true);
        }
      }}
      title={activation === "double-click" ? "Double-click to edit task" : "Edit task"}
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
      if (!input || finished.current) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    };

    focusInput();
    let frame = window.requestAnimationFrame(() => {
      focusInput();
      frame = window.requestAnimationFrame(focusInput);
    });
    const timer = window.setTimeout(() => {
      const activeElement = document.activeElement;
      const focusStayedInCanvas = activeElement instanceof Element
        && activeElement.closest(".react-flow__pane");
      if (
        activeElement === document.body
        || activeElement === document.documentElement
        || activeElement === inputRef.current
        || focusStayedInCanvas
      ) focusInput();
    }, 80);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
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
        <InlineTitle title={data.title} completed={data.completed} onSave={(title) => data.onRename(id, title)} className="node-title" activation="double-click" />
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

type RouteDirection = 0 | 1 | 2;
type RouteResult = { path: string; label: Point };

function inflateRect(rect: Rect, amount: number): Rect {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };
}

function clearanceBeforePointEntersRect(point: Point, rect: Rect) {
  if (pointInsideRect(point, rect)) return 0;
  const horizontalGap = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
  const verticalGap = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
  return Math.max(horizontalGap, verticalGap);
}

function pointInsideRect(point: Point, rect: Rect) {
  const epsilon = 0.001;
  return point.x > rect.left + epsilon
    && point.x < rect.right - epsilon
    && point.y > rect.top + epsilon
    && point.y < rect.bottom - epsilon;
}

function segmentIsClear(start: Point, end: Point, obstacles: Rect[]) {
  const epsilon = 0.001;
  if (Math.abs(start.y - end.y) < epsilon) {
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    return obstacles.every((obstacle) => (
      start.y <= obstacle.top + epsilon
      || start.y >= obstacle.bottom - epsilon
      || right <= obstacle.left + epsilon
      || left >= obstacle.right - epsilon
    ));
  }
  if (Math.abs(start.x - end.x) < epsilon) {
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    return obstacles.every((obstacle) => (
      start.x <= obstacle.left + epsilon
      || start.x >= obstacle.right - epsilon
      || bottom <= obstacle.top + epsilon
      || top >= obstacle.bottom - epsilon
    ));
  }
  return false;
}

function simplifyRoutePoints(points: Point[]) {
  const sameCoordinate = (left: number, right: number) => Math.abs(left - right) < 0.01;
  const deduplicated = points.filter((point, index) => (
    index === 0 || !sameCoordinate(point.x, points[index - 1].x) || !sameCoordinate(point.y, points[index - 1].y)
  ));
  return deduplicated.filter((point, index) => {
    if (index === 0 || index === deduplicated.length - 1) return true;
    const previous = deduplicated[index - 1];
    const next = deduplicated[index + 1];
    return !((sameCoordinate(previous.x, point.x) && sameCoordinate(point.x, next.x))
      || (sameCoordinate(previous.y, point.y) && sameCoordinate(point.y, next.y)));
  });
}

function preferredRoutePoints(
  source: Point,
  sourceStub: Point,
  targetStub: Point,
  target: Point,
  sourcePosition: Position,
  targetPosition: Position,
) {
  const sourceIsHorizontal = sourcePosition === Position.Left || sourcePosition === Position.Right;
  const targetIsHorizontal = targetPosition === Position.Left || targetPosition === Position.Right;
  if (sourceIsHorizontal !== targetIsHorizontal) {
    const direct = simplifyRoutePoints([
      source,
      sourceIsHorizontal
        ? { x: target.x, y: source.y }
        : { x: source.x, y: target.y },
      target,
    ]);
    if (routeHonorsDockDirections(direct, sourcePosition, targetPosition)) return direct;
    return simplifyRoutePoints([
      source,
      sourceStub,
      sourceIsHorizontal
        ? { x: targetStub.x, y: sourceStub.y }
        : { x: sourceStub.x, y: targetStub.y },
      targetStub,
      target,
    ]);
  }

  if (sourceIsHorizontal) {
    if (sourcePosition === targetPosition) {
      const outsideX = sourcePosition === Position.Left
        ? Math.min(sourceStub.x, targetStub.x)
        : Math.max(sourceStub.x, targetStub.x);
      return simplifyRoutePoints([
        source,
        sourceStub,
        { x: outsideX, y: sourceStub.y },
        { x: outsideX, y: targetStub.y },
        targetStub,
        target,
      ]);
    }
    const middleX = (sourceStub.x + targetStub.x) / 2;
    return simplifyRoutePoints([
      source,
      sourceStub,
      { x: middleX, y: sourceStub.y },
      { x: middleX, y: targetStub.y },
      targetStub,
      target,
    ]);
  }
  if (sourcePosition === targetPosition) {
    const outsideY = sourcePosition === Position.Top
      ? Math.min(sourceStub.y, targetStub.y)
      : Math.max(sourceStub.y, targetStub.y);
    return simplifyRoutePoints([
      source,
      sourceStub,
      { x: sourceStub.x, y: outsideY },
      { x: targetStub.x, y: outsideY },
      targetStub,
      target,
    ]);
  }
  const middleY = (sourceStub.y + targetStub.y) / 2;
  return simplifyRoutePoints([
    source,
    sourceStub,
    { x: sourceStub.x, y: middleY },
    { x: targetStub.x, y: middleY },
    targetStub,
    target,
  ]);
}

function routeHonorsDockDirections(points: Point[], sourcePosition: Position, targetPosition: Position) {
  const route = simplifyRoutePoints(points);
  if (route.length < 2) return false;
  const outwardVector = (position: Position): Point => {
    if (position === Position.Left) return { x: -1, y: 0 };
    if (position === Position.Right) return { x: 1, y: 0 };
    if (position === Position.Top) return { x: 0, y: -1 };
    return { x: 0, y: 1 };
  };
  const sourceDirection = {
    x: route[1].x - route[0].x,
    y: route[1].y - route[0].y,
  };
  const targetDirection = {
    x: route.at(-1)!.x - route.at(-2)!.x,
    y: route.at(-1)!.y - route.at(-2)!.y,
  };
  const sourceOutward = outwardVector(sourcePosition);
  const targetOutward = outwardVector(targetPosition);
  return sourceDirection.x * sourceOutward.x + sourceDirection.y * sourceOutward.y > 0.001
    && targetDirection.x * targetOutward.x + targetDirection.y * targetOutward.y < -0.001;
}

function routeIsClear(points: Point[], obstacles: Rect[]) {
  return points.every((point) => obstacles.every((obstacle) => !pointInsideRect(point, obstacle)))
    && points.slice(1).every((point, index) => segmentIsClear(points[index], point, obstacles));
}

function findObstacleRoute(
  start: Point,
  end: Point,
  obstacles: Rect[],
  sourcePosition: Position,
  targetPosition: Position,
): Point[] | null {
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap((obstacle) => [obstacle.left, obstacle.right])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap((obstacle) => [obstacle.top, obstacle.bottom])])].sort((a, b) => a - b);
  const rowSize = ys.length;
  const pointIndex = (xIndex: number, yIndex: number) => xIndex * rowSize + yIndex;
  const pointAt = (index: number): Point => ({ x: xs[Math.floor(index / rowSize)], y: ys[index % rowSize] });
  const validPoints = new Map<number, boolean>();
  const isValidPoint = (index: number) => {
    const cached = validPoints.get(index);
    if (cached !== undefined) return cached;
    const valid = obstacles.every((obstacle) => !pointInsideRect(pointAt(index), obstacle));
    validPoints.set(index, valid);
    return valid;
  };
  const startIndex = pointIndex(xs.indexOf(start.x), ys.indexOf(start.y));
  const endIndex = pointIndex(xs.indexOf(end.x), ys.indexOf(end.y));
  if (!isValidPoint(startIndex) || !isValidPoint(endIndex)) return null;

  type SearchState = {
    point: number;
    direction: RouteDirection;
    cost: number;
    score: number;
    order: number;
    key: string;
  };
  const heap: SearchState[] = [];
  const compare = (left: SearchState, right: SearchState) => (
    left.score - right.score || left.cost - right.cost || left.order - right.order
  );
  const push = (state: SearchState) => {
    heap.push(state);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < heap.length && compare(heap[left], heap[next]) < 0) next = left;
        if (right < heap.length && compare(heap[right], heap[next]) < 0) next = right;
        if (next === index) break;
        [heap[index], heap[next]] = [heap[next], heap[index]];
        index = next;
      }
    }
    return first;
  };
  const axisForPosition = (position: Position): RouteDirection => (
    position === Position.Left || position === Position.Right ? 1 : 2
  );
  const sourceAxis = axisForPosition(sourcePosition);
  const targetAxis = axisForPosition(targetPosition);
  const stateKey = (point: number, direction: RouteDirection) => `${point}:${direction}`;
  const heuristic = (point: Point) => Math.abs(point.x - end.x) + Math.abs(point.y - end.y);
  const costs = new Map<string, number>();
  const previous = new Map<string, string>();
  let order = 0;
  const initialKey = stateKey(startIndex, sourceAxis);
  costs.set(initialKey, 0);
  push({ point: startIndex, direction: sourceAxis, cost: 0, score: heuristic(start), order: order++, key: initialKey });

  while (heap.length) {
    const current = pop();
    if (!current || current.cost !== costs.get(current.key)) continue;
    if (current.point === endIndex) {
      const route: Point[] = [];
      let key: string | undefined = current.key;
      while (key) {
        route.push(pointAt(Number.parseInt(key.split(":")[0], 10)));
        key = previous.get(key);
      }
      return simplifyRoutePoints(route.reverse());
    }

    const xIndex = Math.floor(current.point / rowSize);
    const yIndex = current.point % rowSize;
    const neighborCandidates: { x: number; y: number; direction: RouteDirection }[] = [
      { x: xIndex + 1, y: yIndex, direction: 1 },
      { x: xIndex - 1, y: yIndex, direction: 1 },
      { x: xIndex, y: yIndex + 1, direction: 2 },
      { x: xIndex, y: yIndex - 1, direction: 2 },
    ];

    neighborCandidates.forEach((candidate) => {
      if (candidate.x < 0 || candidate.x >= xs.length || candidate.y < 0 || candidate.y >= ys.length) return;
      const neighborIndex = pointIndex(candidate.x, candidate.y);
      if (!isValidPoint(neighborIndex)) return;
      const currentPoint = pointAt(current.point);
      const neighborPoint = pointAt(neighborIndex);
      if (!segmentIsClear(currentPoint, neighborPoint, obstacles)) return;
      const distance = Math.abs(currentPoint.x - neighborPoint.x) + Math.abs(currentPoint.y - neighborPoint.y);
      const turnCost = current.direction === candidate.direction ? 0 : EDGE_ROUTE_BEND_PENALTY;
      const arrivalCost = neighborIndex === endIndex && candidate.direction !== targetAxis ? EDGE_ROUTE_BEND_PENALTY : 0;
      const nextCost = current.cost + distance + turnCost + arrivalCost;
      const key = stateKey(neighborIndex, candidate.direction);
      if (nextCost >= (costs.get(key) ?? Infinity)) return;
      costs.set(key, nextCost);
      previous.set(key, current.key);
      push({
        point: neighborIndex,
        direction: candidate.direction,
        cost: nextCost,
        score: nextCost + heuristic(neighborPoint),
        order: order++,
        key,
      });
    });
  }
  return null;
}

function roundedRoutePath(points: Point[], radius: number) {
  const route = simplifyRoutePoints(points);
  if (!route.length) return "";
  const number = (value: number) => Number(value.toFixed(3));
  let path = `M${number(route[0].x)} ${number(route[0].y)}`;
  for (let index = 1; index < route.length - 1; index += 1) {
    const previous = route[index - 1];
    const current = route[index];
    const next = route[index + 1];
    const incomingLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const outgoingLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    const cornerRadius = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    const cornerOffset = (delta: number) => Math.abs(delta) < 0.01 ? 0 : Math.sign(delta) * cornerRadius;
    const before = {
      x: current.x + cornerOffset(previous.x - current.x),
      y: current.y + cornerOffset(previous.y - current.y),
    };
    const after = {
      x: current.x + cornerOffset(next.x - current.x),
      y: current.y + cornerOffset(next.y - current.y),
    };
    path += `L${number(before.x)} ${number(before.y)}Q${number(current.x)} ${number(current.y)} ${number(after.x)} ${number(after.y)}`;
  }
  const last = route.at(-1)!;
  return `${path}L${number(last.x)} ${number(last.y)}`;
}

function routeMidpoint(points: Point[]) {
  const route = simplifyRoutePoints(points);
  const lengths = route.slice(1).map((point, index) => (
    Math.abs(point.x - route[index].x) + Math.abs(point.y - route[index].y)
  ));
  const halfway = lengths.reduce((total, length) => total + length, 0) / 2;
  let traveled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (traveled + length >= halfway) {
      const start = route[index];
      const end = route[index + 1];
      const progress = length ? (halfway - traveled) / length : 0;
      return { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress };
    }
    traveled += length;
  }
  return route.at(-1) ?? { x: 0, y: 0 };
}

function dependencyRoute(
  source: Point,
  target: Point,
  sourcePosition: Position,
  targetPosition: Position,
  obstacleRects: Rect[],
): RouteResult {
  const facingGap = sourcePosition === Position.Right && targetPosition === Position.Left
    ? target.x - source.x
    : sourcePosition === Position.Left && targetPosition === Position.Right
      ? source.x - target.x
      : sourcePosition === Position.Bottom && targetPosition === Position.Top
        ? target.y - source.y
        : sourcePosition === Position.Top && targetPosition === Position.Bottom
          ? source.y - target.y
          : null;
  const stubLength = facingGap === null
    ? EDGE_ROUTE_STUB
    : Math.min(EDGE_ROUTE_STUB, Math.max(0, facingGap / 2));
  const sourceStub = offsetPoint(source.x, source.y, sourcePosition, stubLength);
  const targetStub = offsetPoint(target.x, target.y, targetPosition, stubLength);
  const obstacles = obstacleRects.map((obstacle) => {
    const availableClearance = Math.min(
      clearanceBeforePointEntersRect(source, obstacle),
      clearanceBeforePointEntersRect(target, obstacle),
    );
    return inflateRect(obstacle, Math.min(EDGE_ROUTE_CLEARANCE, availableClearance));
  });
  const preferred = preferredRoutePoints(source, sourceStub, targetStub, target, sourcePosition, targetPosition);
  const routeStart = sourceStub;
  const routeEnd = targetStub;
  const detour = routeIsClear(preferred, obstacles)
    ? null
    : findObstacleRoute(routeStart, routeEnd, obstacles, sourcePosition, targetPosition);
  const detourPoints = detour ? simplifyRoutePoints([source, ...detour, target]) : null;
  const points = detourPoints
    && routeHonorsDockDirections(detourPoints, sourcePosition, targetPosition)
    && routeIsClear(detourPoints, obstacles)
    ? detourPoints
    : preferred;
  return { path: roundedRoutePath(points, EDGE_CORNER_RADIUS), label: routeMidpoint(points) };
}

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
  const source = offsetAlongDock({ x: sourceX, y: sourceY }, sourcePosition, data?.sourceDockOffset ?? 0);
  const target = offsetAlongDock({ x: targetX, y: targetY }, targetPosition, data?.targetDockOffset ?? 0);
  const route = dependencyRoute(
    source,
    target,
    sourcePosition,
    targetPosition,
    data?.obstacles ?? [],
  );
  const sourceHandle = offsetPoint(source.x, source.y, sourcePosition, EDGE_RECONNECT_RADIUS);
  const targetHandle = offsetPoint(target.x, target.y, targetPosition, EDGE_RECONNECT_RADIUS);

  return (
    <>
      <BaseEdge
        id={id}
        path={route.path}
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
        x={route.label.x}
        y={route.label.y}
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

function offsetAlongDock(point: Point, position: Position, distance: number): Point {
  if (position === Position.Top || position === Position.Bottom) return { x: point.x + distance, y: point.y };
  return { x: point.x, y: point.y + distance };
}

function nodeDimensions(node: TaskFlowNode): Size {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : Number.parseFloat(String(node.style?.width ?? ""));
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : Number.parseFloat(String(node.style?.height ?? ""));
  return {
    width: node.measured?.width ?? node.width ?? (Number.isFinite(styleWidth) ? styleWidth : NODE_MIN_WIDTH),
    height: node.measured?.height ?? node.height ?? (Number.isFinite(styleHeight) ? styleHeight : NODE_MIN_HEIGHT),
  };
}

function nodeRect(node: TaskFlowNode): Rect {
  return rectAt(node.position, nodeDimensions(node));
}

function facingHandles(
  source: TaskFlowNode,
  target: TaskFlowNode,
  obstacleRects: Rect[],
  previous?: { sourceSide: ConnectionSide; targetSide: ConnectionSide },
) {
  const sourceSize = nodeDimensions(source);
  const targetSize = nodeDimensions(target);
  const sourceRect = nodeRect(source);
  const targetRect = nodeRect(target);
  const sourceCenter = {
    x: source.position.x + sourceSize.width / 2,
    y: source.position.y + sourceSize.height / 2,
  };
  const targetCenter = {
    x: target.position.x + targetSize.width / 2,
    y: target.position.y + targetSize.height / 2,
  };
  const dx = targetCenter.x - sourceCenter.x;
  const positionForSide = (side: ConnectionSide) => {
    if (side === "left") return Position.Left;
    if (side === "right") return Position.Right;
    if (side === "top") return Position.Top;
    return Position.Bottom;
  };
  const pointForSide = (rect: Rect, side: ConnectionSide): Point => {
    if (side === "left") return { x: rect.left - EDGE_HANDLE_OUTSET, y: (rect.top + rect.bottom) / 2 };
    if (side === "right") return { x: rect.right + EDGE_HANDLE_OUTSET, y: (rect.top + rect.bottom) / 2 };
    if (side === "top") return { x: (rect.left + rect.right) / 2, y: rect.top - EDGE_HANDLE_OUTSET };
    return { x: (rect.left + rect.right) / 2, y: rect.bottom + EDGE_HANDLE_OUTSET };
  };

  const routeCandidate = (sourceSide: ConnectionSide, targetSide: ConnectionSide) => {
    const sourcePosition = positionForSide(sourceSide);
    const targetPosition = positionForSide(targetSide);
    const sourcePoint = pointForSide(sourceRect, sourceSide);
    const targetPoint = pointForSide(targetRect, targetSide);
    const facingGap = sourcePosition === Position.Right && targetPosition === Position.Left
      ? targetPoint.x - sourcePoint.x
      : sourcePosition === Position.Left && targetPosition === Position.Right
        ? sourcePoint.x - targetPoint.x
        : sourcePosition === Position.Bottom && targetPosition === Position.Top
          ? targetPoint.y - sourcePoint.y
          : sourcePosition === Position.Top && targetPosition === Position.Bottom
            ? sourcePoint.y - targetPoint.y
            : null;
    const stubLength = facingGap === null
      ? EDGE_ROUTE_STUB
      : Math.min(EDGE_ROUTE_STUB, Math.max(0, facingGap / 2));
    const sourceStub = offsetPoint(sourcePoint.x, sourcePoint.y, sourcePosition, stubLength);
    const targetStub = offsetPoint(targetPoint.x, targetPoint.y, targetPosition, stubLength);
    const points = preferredRoutePoints(
      sourcePoint,
      sourceStub,
      targetStub,
      targetPoint,
      sourcePosition,
      targetPosition,
    );
    const routeObstacles = obstacleRects.map((obstacle) => {
      const availableClearance = Math.min(
        clearanceBeforePointEntersRect(sourcePoint, obstacle),
        clearanceBeforePointEntersRect(targetPoint, obstacle),
      );
      return inflateRect(obstacle, Math.min(EDGE_ROUTE_CLEARANCE, availableClearance));
    });
    const endpointSegmentsAreClear = routeIsClear([sourcePoint, sourceStub], routeObstacles)
      && routeIsClear([targetStub, targetPoint], routeObstacles);
    const routeBlockers = [sourceRect, targetRect, ...routeObstacles];
    const detour = routeIsClear(points, routeBlockers)
      ? null
      : findObstacleRoute(sourceStub, targetStub, routeBlockers, sourcePosition, targetPosition);
    const routedPoints = detour ? simplifyRoutePoints([sourcePoint, ...detour, targetPoint]) : points;
    const length = routedPoints.slice(1).reduce((total, point, index) => (
      total + Math.abs(point.x - routedPoints[index].x) + Math.abs(point.y - routedPoints[index].y)
    ), 0);
    const departureLength = routedPoints.length > 1
      ? Math.abs(routedPoints[1].x - routedPoints[0].x) + Math.abs(routedPoints[1].y - routedPoints[0].y)
      : 0;
    const arrivalLength = routedPoints.length > 1
      ? Math.abs(routedPoints.at(-1)!.x - routedPoints.at(-2)!.x)
        + Math.abs(routedPoints.at(-1)!.y - routedPoints.at(-2)!.y)
      : 0;
    return {
      sourceSide,
      targetSide,
      clear: (facingGap === null || facingGap >= EDGE_MIN_APPROACH * 2)
        && departureLength >= EDGE_MIN_APPROACH
        && arrivalLength >= EDGE_MIN_APPROACH
        && endpointSegmentsAreClear
        && routeHonorsDockDirections(routedPoints, sourcePosition, targetPosition)
        && routeIsClear(routedPoints, routeBlockers),
      score: length + Math.max(0, routedPoints.length - 2) * EDGE_ROUTE_BEND_PENALTY,
    };
  };

  const sides: ConnectionSide[] = ["top", "right", "bottom", "left"];
  const candidates = sides
    .flatMap((sourceSide) => sides.map((targetSide) => routeCandidate(sourceSide, targetSide)))
    .filter((candidate) => candidate.clear)
    .sort((left, right) => left.score - right.score
      || left.sourceSide.localeCompare(right.sourceSide)
      || left.targetSide.localeCompare(right.targetSide));
  const best = candidates[0];
  const previousCandidate = previous
    ? candidates.find((candidate) => (
      candidate.sourceSide === previous.sourceSide && candidate.targetSide === previous.targetSide
    ))
    : null;
  const selected = previousCandidate && best
    && previousCandidate.score <= best.score + EDGE_DOCK_SWITCH_THRESHOLD
    ? previousCandidate
    : best;
  if (selected) {
    return {
      sourceHandle: `source-${selected.sourceSide}`,
      targetHandle: `target-${selected.targetSide}`,
      sourceSide: selected.sourceSide,
      targetSide: selected.targetSide,
    };
  }

  const sourceSide: ConnectionSide = dx >= 0 ? "left" : "right";
  const targetSide = sourceSide;
  return { sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}`, sourceSide, targetSide };
}

function nodeCenter(node: TaskFlowNode): Point {
  const size = nodeDimensions(node);
  return { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
}

function dockOffsetLimit(node: TaskFlowNode, side: ConnectionSide) {
  const size = nodeDimensions(node);
  const sideLength = side === "top" || side === "bottom" ? size.width : size.height;
  return Math.max(0, Math.min(EDGE_RECONNECT_RADIUS - 3, sideLength / 2 - EDGE_DOCK_INSET));
}

function centeredDockOffset(index: number, count: number, limit: number) {
  if (count < 2 || limit <= 0) return 0;
  const spacing = Math.min(EDGE_DOCK_SPACING, (limit * 2) / (count - 1));
  return (index - (count - 1) / 2) * spacing;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidBackup(message = "This backup is incomplete or damaged."): never {
  throw new Error(message);
}

function validatedPoint(value: unknown): Point {
  if (!isRecord(value) || typeof value.x !== "number" || !Number.isFinite(value.x)
    || typeof value.y !== "number" || !Number.isFinite(value.y)) {
    invalidBackup();
  }
  return { x: value.x, y: value.y };
}

function validatedSize(value: unknown): Size {
  if (!isRecord(value) || typeof value.width !== "number" || !Number.isFinite(value.width)
    || typeof value.height !== "number" || !Number.isFinite(value.height)
    || value.width < NODE_MIN_WIDTH || value.width > NODE_MAX_WIDTH
    || value.height < NODE_MIN_HEIGHT || value.height > NODE_MAX_HEIGHT) {
    invalidBackup();
  }
  return { width: value.width, height: value.height };
}

function validatedBackup(value: unknown): TaskData {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    invalidBackup("That file isn’t a Carpaccio backup.");
  }
  if (value.version !== BACKUP_VERSION) {
    invalidBackup("This backup uses an unsupported version.");
  }
  if (typeof value.exportedAt !== "string" || Number.isNaN(Date.parse(value.exportedAt)) || !isRecord(value.data)) {
    invalidBackup();
  }

  const rawTasks = value.data.tasks;
  const rawDependencies = value.data.dependencies;
  if (!Array.isArray(rawTasks) || !Array.isArray(rawDependencies)) invalidBackup();

  const taskIds = new Set<string>();
  const tasks = rawTasks.map((rawTask): Task => {
    if (!isRecord(rawTask) || typeof rawTask.id !== "string" || !rawTask.id
      || typeof rawTask.title !== "string" || !rawTask.title.trim()
      || typeof rawTask.completed !== "boolean") {
      invalidBackup();
    }
    if (taskIds.has(rawTask.id)) invalidBackup("This backup contains duplicate tasks.");
    taskIds.add(rawTask.id);
    if (rawTask.notes !== undefined && typeof rawTask.notes !== "string") invalidBackup();
    return {
      id: rawTask.id,
      title: rawTask.title,
      completed: rawTask.completed,
      position: validatedPoint(rawTask.position),
      ...(rawTask.size === undefined ? {} : { size: validatedSize(rawTask.size) }),
      ...(rawTask.notes === undefined ? {} : { notes: rawTask.notes }),
    };
  });

  const dependencyIds = new Set<string>();
  const dependencyPairs = new Set<string>();
  const dependencies = rawDependencies.map((rawDependency): Dependency => {
    if (!isRecord(rawDependency) || typeof rawDependency.id !== "string" || !rawDependency.id
      || typeof rawDependency.source !== "string" || typeof rawDependency.target !== "string"
      || !taskIds.has(rawDependency.source) || !taskIds.has(rawDependency.target)) {
      invalidBackup("This backup contains an invalid connection.");
    }
    if (rawDependency.source === rawDependency.target) {
      invalidBackup("This backup contains a task connected to itself.");
    }
    if (dependencyIds.has(rawDependency.id)) invalidBackup("This backup contains duplicate connections.");
    dependencyIds.add(rawDependency.id);
    const pair = `${rawDependency.source}\u0000${rawDependency.target}`;
    if (dependencyPairs.has(pair)) invalidBackup("This backup contains duplicate connections.");
    dependencyPairs.add(pair);
    return { id: rawDependency.id, source: rawDependency.source, target: rawDependency.target };
  });

  if (dependencies.some((edge) => hasPath(edge.target, edge.source, dependencies, edge.id))) {
    invalidBackup("This backup contains a dependency loop.");
  }

  return { tasks, dependencies: minimalDependencies(dependencies) };
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
  dependencies,
  listOrder,
  blockedIds,
  settlingCompletedIds,
  completedTasksOpen,
  onCompletedTasksOpenChange,
  showCompletedOnGraph,
  onShowCompletedOnGraphChange,
  onToggle,
  onRename,
  onInspect,
  onSelect,
  onClearSelection,
  onReorder,
  inspectedTaskId,
  selectedTaskId,
  quickAdd,
}: {
  tasks: Task[];
  dependencies: Dependency[];
  listOrder: ListOrder;
  blockedIds: Set<string>;
  settlingCompletedIds: Set<string>;
  completedTasksOpen: boolean;
  onCompletedTasksOpenChange: (open: boolean) => void;
  showCompletedOnGraph: boolean;
  onShowCompletedOnGraphChange: (show: boolean) => void;
  onToggle: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onInspect: (id: string) => void;
  onSelect: (id: string) => void;
  onClearSelection: () => void;
  onReorder: (draggedId: string, targetId: string, placement: DropPlacement) => void;
  inspectedTaskId: string | null;
  selectedTaskId: string | null;
  quickAdd: ReactNode;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const draggedRef = useRef<string | null>(null);
  const keyboardScopeRef = useRef<HTMLDivElement>(null);
  const manuallyOrderedActiveTasks = tasks.filter((task) => !task.completed || settlingCompletedIds.has(task.id));
  const upNextOrder = upNextTaskOrder(manuallyOrderedActiveTasks, dependencies);
  const activeTasks = listOrder === "up-next" ? upNextOrder.tasks : manuallyOrderedActiveTasks;
  const waitingStartsAt = listOrder === "up-next" ? upNextOrder.unlockedCount : -1;
  const completedTasks = tasks.filter((task) => task.completed && !settlingCompletedIds.has(task.id));
  const dropTargetAt = (x: number, y: number, draggedId: string): DropTarget | null => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(".task-row[data-reorderable='true']");
    const id = row?.dataset.taskId;
    if (!row || !id || id === draggedId) return null;
    const bounds = row.getBoundingClientRect();
    return { id, placement: y < bounds.top + bounds.height / 2 ? "before" : "after" };
  };
  const visibleTaskRows = () => Array.from(keyboardScopeRef.current?.querySelectorAll<HTMLElement>(".task-row") ?? []);

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;

    const rows = visibleTaskRows();
    const focusedRow = target.closest<HTMLElement>(".task-row");
    const selectedRow = selectedTaskId
      ? rows.find((row) => row.dataset.taskId === selectedTaskId) ?? null
      : null;
    const currentRow = focusedRow ?? selectedRow;

    if (event.key === "Escape") {
      if (!selectedTaskId) return;
      event.preventDefault();
      onClearSelection();
      target.blur();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!rows.length) return;
      event.preventDefault();
      const currentIndex = currentRow ? rows.indexOf(currentRow) : -1;
      const nextIndex = currentIndex < 0
        ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
        : Math.max(0, Math.min(rows.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const nextRow = rows[nextIndex];
      const nextId = nextRow.dataset.taskId;
      if (!nextId) return;
      onSelect(nextId);
      nextRow.focus({ preventScroll: true });
      nextRow.scrollIntoView({ block: "nearest" });
      return;
    }

    if (!currentRow || !selectedTaskId || currentRow.dataset.taskId !== selectedTaskId) return;

    if (event.key === "Enter") {
      if (target.closest("button")) return;
      event.preventDefault();
      currentRow.querySelector<HTMLButtonElement>(".inline-title")?.click();
      return;
    }

    if (event.key !== " " && event.key !== "Spacebar") return;
    if (target.closest("button:not(.inline-title)")) return;
    if (event.repeat) return;
    event.preventDefault();

    const id = currentRow.dataset.taskId;
    if (!id) return;
    onInspect(id);
  };

  const renderTaskRow = (task: Task, reorderable: boolean) => (
    <div
      key={task.id}
      role="listitem"
      data-task-id={task.id}
      data-reorderable={reorderable}
      tabIndex={selectedTaskId === task.id ? 0 : -1}
      className={`task-row ${task.completed ? "is-completed" : ""} ${settlingCompletedIds.has(task.id) ? "is-settling" : ""} ${blockedIds.has(task.id) ? "is-blocked" : ""} ${inspectedTaskId === task.id ? "is-inspected" : ""} ${selectedTaskId === task.id ? "is-selected" : ""} ${dragged === task.id ? "is-dragging" : ""} ${dropTarget?.id === task.id ? `is-drop-target-${dropTarget.placement}` : ""}`}
      onPointerDownCapture={() => onSelect(task.id)}
      onFocusCapture={() => {
        if (selectedTaskId !== task.id) onSelect(task.id);
      }}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".inline-title, .inline-title-input, .row-info, .check-button, .drag-grip")) return;
        onInspect(task.id);
      }}
      onPointerDown={(event) => {
        if (!reorderable || !(event.target as HTMLElement).closest(".drag-grip")) return;
        if (event.pointerType === "mouse") return;
        event.preventDefault();
        draggedRef.current = task.id;
        setDragged(task.id);
        setDropTarget(null);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (draggedRef.current !== task.id) return;
        setDropTarget(dropTargetAt(event.clientX, event.clientY, task.id));
      }}
      onPointerUp={(event) => {
        if (draggedRef.current !== task.id) return;
        const target = dropTargetAt(event.clientX, event.clientY, task.id);
        if (target) onReorder(task.id, target.id, target.placement);
        draggedRef.current = null;
        setDragged(null);
        setDropTarget(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        draggedRef.current = null;
        setDragged(null);
        setDropTarget(null);
      }}
    >
      <span
        className={`drag-grip ${reorderable ? "" : "is-placeholder"}`}
        aria-hidden="true"
        onMouseDown={reorderable ? (event) => {
          event.preventDefault();
          draggedRef.current = task.id;
          setDragged(task.id);
          setDropTarget(null);
          const handleMove = (moveEvent: MouseEvent) => {
            setDropTarget(dropTargetAt(moveEvent.clientX, moveEvent.clientY, task.id));
          };
          const handleUp = (upEvent: MouseEvent) => {
            const target = dropTargetAt(upEvent.clientX, upEvent.clientY, task.id);
            if (target) onReorder(task.id, target.id, target.placement);
            draggedRef.current = null;
            setDragged(null);
            setDropTarget(null);
            window.removeEventListener("mousemove", handleMove);
          };
          window.addEventListener("mousemove", handleMove);
          window.addEventListener("mouseup", handleUp, { once: true });
        } : undefined}
      >{reorderable && <GripIcon />}</span>
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
  );

  if (!tasks.length) {
    return (
      <>
        <div className="empty-state">
          <div className="empty-check"><CheckIcon /></div>
          <p>Nothing here yet.</p>
          <span>Add a task below to get started.</span>
        </div>
        {quickAdd}
      </>
    );
  }

  return (
    <div
      ref={keyboardScopeRef}
      className="task-list-keyboard-scope"
      role="group"
      aria-label="Task list"
      tabIndex={selectedTaskId ? -1 : 0}
      onKeyDown={handleListKeyDown}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".task-row, button, input, textarea, [contenteditable='true']")) return;
        onClearSelection();
      }}
    >
      <div className="task-list" role="list" aria-label="Incomplete tasks">
        {activeTasks.map((task, index) => (
          <Fragment key={task.id}>
            {index === waitingStartsAt && waitingStartsAt < activeTasks.length && (
              <div className="waiting-divider" role="separator"><span>Waiting</span></div>
            )}
            {renderTaskRow(task, listOrder === "manual" && !task.completed)}
          </Fragment>
        ))}
      </div>
      {quickAdd}
      {completedTasks.length > 0 && (
        <section className={`completed-section ${completedTasksOpen ? "is-open" : ""}`} aria-label="Completed tasks">
          <button
            type="button"
            className="completed-toggle"
            onClick={() => onCompletedTasksOpenChange(!completedTasksOpen)}
            aria-expanded={completedTasksOpen}
            aria-controls="completed-task-list"
          >
            <ChevronIcon />
            <span>Completed</span>
            <span aria-hidden="true">·</span>
            <span>{completedTasks.length}</span>
          </button>
          {completedTasksOpen && (
            <>
              <label className="completed-graph-option">
                <input
                  type="checkbox"
                  checked={showCompletedOnGraph}
                  onChange={(event) => onShowCompletedOnGraphChange(event.currentTarget.checked)}
                />
                <span>Show on graph</span>
              </label>
              <div id="completed-task-list" className="completed-task-list" role="list">
                {completedTasks.map((task) => renderTaskRow(task, false))}
              </div>
            </>
          )}
        </section>
      )}
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
      if (event.key !== "Escape" || !addingRelationship) return;
      setAddingRelationship(null);
      setRelationshipSearch("");
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [addingRelationship]);

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
    present: EMPTY_DATA,
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
  const [invalidDragId, setInvalidDragId] = useState<string | null>(null);
  const [graphDraft, setGraphDraft] = useState<GraphDraft | null>(null);
  const [isArranging, setIsArranging] = useState(false);
  const [arrangedDirection, setArrangedDirection] = useState<LayoutDirection | null>(null);
  const [layoutGuides, setLayoutGuides] = useState<LayoutGuide[]>([]);
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>("horizontal");
  const [arrangementOptionsOpen, setArrangementOptionsOpen] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [appearanceOptionsOpen, setAppearanceOptionsOpen] = useState(false);
  const [listOrder, setListOrder] = useState<ListOrder>("manual");
  const [showCompletedOnGraph, setShowCompletedOnGraph] = useState(false);
  const [completedTasksOpen, setCompletedTasksOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [settlingCompletedIds, setSettlingCompletedIds] = useState<Set<string>>(() => new Set());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spacingSnapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arrangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const arrangeFrame = useRef<number | null>(null);
  const arrangementVersion = useRef(0);
  const arrangedLayerByTask = useRef<Map<string, number>>(new Map());
  const activeArrangement = useRef<ArrangementSnapshot | null>(null);
  const pendingPreviousArrangement = useRef<ArrangementSnapshot | null | undefined>(undefined);
  const arrangementOptionsRef = useRef<HTMLDivElement>(null);
  const appearanceOptionsRef = useRef<HTMLDivElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
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
      const savedListOrder = window.localStorage.getItem(LIST_ORDER_KEY);
      if (savedListOrder === "manual" || savedListOrder === "up-next") setListOrder(savedListOrder);
      const savedShowCompleted = window.localStorage.getItem(SHOW_COMPLETED_GRAPH_KEY);
      if (savedShowCompleted === "true" || savedShowCompleted === "false") {
        setShowCompletedOnGraph(savedShowCompleted === "true");
      }
    } catch {
      // Keep the empty first-run state if saved data is unavailable or malformed.
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
    if (hydrated) window.localStorage.setItem(LIST_ORDER_KEY, listOrder);
  }, [hydrated, listOrder]);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(SHOW_COMPLETED_GRAPH_KEY, String(showCompletedOnGraph));
  }, [hydrated, showCompletedOnGraph]);

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
      void flowInstance.current?.fitView({ padding: 0.14, minZoom: AUTOMATIC_FIT_MIN_ZOOM, maxZoom: 1.15, duration: 180 });
    }, 80);
    return () => clearTimeout(timer);
  }, [inspectorOpen, isDesktopWorkspace, view]);

  useEffect(() => () => {
    arrangementVersion.current += 1;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
    if (spacingSnapTimer.current) clearTimeout(spacingSnapTimer.current);
    if (arrangeTimer.current) clearTimeout(arrangeTimer.current);
    if (arrangeFrame.current) cancelAnimationFrame(arrangeFrame.current);
    completionTimers.current.forEach((timer) => clearTimeout(timer));
  }, []);

  useEffect(() => {
    const completedIds = new Set(data.tasks.filter((task) => task.completed).map((task) => task.id));
    setSettlingCompletedIds((current) => {
      const staleIds = [...current].filter((id) => !completedIds.has(id));
      if (!staleIds.length) return current;
      staleIds.forEach((id) => {
        const timer = completionTimers.current.get(id);
        if (timer) clearTimeout(timer);
        completionTimers.current.delete(id);
      });
      const next = new Set(current);
      staleIds.forEach((id) => next.delete(id));
      return next;
    });
  }, [data.tasks]);

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
    const task = data.tasks.find((candidate) => candidate.id === id);
    if (!task) return;
    if (!showCompletedOnGraph) clearArrangement();

    const existingTimer = completionTimers.current.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    completionTimers.current.delete(id);

    if (task.completed) {
      setSettlingCompletedIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } else {
      setSettlingCompletedIds((current) => new Set(current).add(id));
      const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : COMPLETION_SETTLE_MS;
      const timer = setTimeout(() => {
        setSettlingCompletedIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        completionTimers.current.delete(id);
      }, delay);
      completionTimers.current.set(id, timer);
    }

    updateData((current) => {
      const currentTask = current.tasks.find((candidate) => candidate.id === id);
      if (!currentTask) return current;
      if (!currentTask.completed) {
        return {
          ...current,
          tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, completed: true } : candidate),
        };
      }
      if (showCompletedOnGraph) {
        return {
          ...current,
          tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, completed: false } : candidate),
        };
      }

      const size = currentTask.size ?? automaticNodeSize(currentTask.title);
      const obstacles = current.tasks
        .filter((candidate) => !candidate.completed && candidate.id !== id)
        .map((candidate) => rectAt(candidate.position, candidate.size ?? automaticNodeSize(candidate.title)));
      const position = nearestClearPosition(currentTask.position, size, obstacles);
      return {
        ...current,
        tasks: current.tasks.map((candidate) => candidate.id === id ? { ...candidate, completed: false, position } : candidate),
      };
    });
  }, [clearArrangement, data.tasks, showCompletedOnGraph, updateData]);

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
      const size = automaticNodeSize(title);
      return {
        ...current,
        tasks: [...current.tasks, {
          id: uid(),
          title,
          completed: false,
          position: nextOpenPosition(current.tasks, size),
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
    updateData((current) => {
      const size = automaticNodeSize(clean);
      const obstacles = current.tasks.map((currentTask) => (
        rectAt(currentTask.position, currentTask.size ?? automaticNodeSize(currentTask.title))
      ));
      return {
        ...current,
        tasks: [...current.tasks, {
          ...task,
          position: nearestClearPosition(task.position, size, obstacles),
        }],
      };
    });
    setSelectedTaskId(task.id);
    setSelectedEdgeId(null);
  }, [clearArrangement, graphDraft, updateData]);

  const reorderTasks = useCallback((draggedId: string, targetId: string, placement: DropPlacement) => {
    updateData((current) => {
      const activeTasks = current.tasks.filter((task) => !task.completed);
      const from = activeTasks.findIndex((task) => task.id === draggedId);
      const target = activeTasks.findIndex((task) => task.id === targetId);
      if (from < 0 || target < 0) return current;

      const reordered = [...activeTasks];
      const [moved] = reordered.splice(from, 1);
      const targetAfterRemoval = reordered.findIndex((task) => task.id === targetId);
      const insertionIndex = targetAfterRemoval + (placement === "after" ? 1 : 0);
      reordered.splice(insertionIndex, 0, moved);

      if (reordered.every((task, index) => task.id === activeTasks[index].id)) return current;
      let activeIndex = 0;
      const tasks = current.tasks.map((task) => task.completed ? task : reordered[activeIndex++]);
      return { ...current, tasks };
    });
  }, [updateData]);

  const taskNodes = useMemo<TaskFlowNode[]>(() => {
    const nodes: TaskFlowNode[] = data.tasks
      .filter((task) => showCompletedOnGraph || !task.completed || settlingCompletedIds.has(task.id))
      .map((task) => ({
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
  }, [blockedIds, cancelGraphTask, commitGraphTask, data.tasks, graphDraft, renameTask, selectedTaskId, settlingCompletedIds, showCompletedOnGraph, toggleTask]);

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

  const edgeHandleChoicesRef = useRef(new Map<string, { sourceSide: ConnectionSide; targetSide: ConnectionSide }>());

  const flowEdges = useMemo<DependencyFlowEdge[]>(() => {
    const nodesById = new Map(flowNodes.map((node) => [node.id, node]));
    const layouts = data.dependencies.map((edge) => {
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const obstacleRects = flowNodes
        .filter((node) => node.id !== edge.source && node.id !== edge.target)
        .map(nodeRect);
      const handles = sourceNode && targetNode
        ? facingHandles(sourceNode, targetNode, obstacleRects, edgeHandleChoicesRef.current.get(edge.id))
        : null;
      if (handles) edgeHandleChoicesRef.current.set(edge.id, handles);
      return {
        edge,
        sourceNode,
        targetNode,
        handles,
      };
    });
    const dependencyIds = new Set(data.dependencies.map((edge) => edge.id));
    edgeHandleChoicesRef.current.forEach((_, edgeId) => {
      if (!dependencyIds.has(edgeId)) edgeHandleChoicesRef.current.delete(edgeId);
    });
    type DockUse = {
      layout: (typeof layouts)[number];
      endpoint: "source" | "target";
      owner: TaskFlowNode;
      other: TaskFlowNode;
      side: ConnectionSide;
    };
    const dockGroups = new Map<string, DockUse[]>();
    const addDockUse = (use: DockUse) => {
      const key = `${use.owner.id}:${use.side}`;
      dockGroups.set(key, [...(dockGroups.get(key) ?? []), use]);
    };
    layouts.forEach((layout) => {
      if (!layout.sourceNode || !layout.targetNode || !layout.handles) return;
      addDockUse({
        layout,
        endpoint: "source",
        owner: layout.sourceNode,
        other: layout.targetNode,
        side: layout.handles.sourceSide,
      });
      addDockUse({
        layout,
        endpoint: "target",
        owner: layout.targetNode,
        other: layout.sourceNode,
        side: layout.handles.targetSide,
      });
    });
    const sourceOffsets = new Map<string, number>();
    const targetOffsets = new Map<string, number>();
    dockGroups.forEach((group) => {
      const { owner, side } = group[0];
      const sorted = [...group].sort((left, right) => {
        const leftCenter = nodeCenter(left.other);
        const rightCenter = nodeCenter(right.other);
        const difference = side === "top" || side === "bottom"
          ? leftCenter.x - rightCenter.x
          : leftCenter.y - rightCenter.y;
        return difference
          || left.layout.edge.id.localeCompare(right.layout.edge.id)
          || left.endpoint.localeCompare(right.endpoint);
      });
      const limit = dockOffsetLimit(owner, side);
      sorted.forEach((use, index) => {
        const offsets = use.endpoint === "source" ? sourceOffsets : targetOffsets;
        offsets.set(use.layout.edge.id, centeredDockOffset(index, sorted.length, limit));
      });
    });

    return layouts.filter(({ sourceNode, targetNode }) => sourceNode && targetNode).map(({ edge, handles }) => {
      const selected = edge.id === selectedEdgeId;
      const spacingMuted = invalidDragId === edge.source || invalidDragId === edge.target;
      return {
        ...edge,
        ...(handles ? { sourceHandle: handles.sourceHandle, targetHandle: handles.targetHandle } : {}),
        className: spacingMuted ? "is-spacing-muted" : undefined,
        selected,
        type: "dependency",
        reconnectable: selected,
        data: {
          onRemove: removeDependency,
          obstacles: flowNodes
            .filter((node) => node.id !== edge.source && node.id !== edge.target)
            .map(nodeRect),
          sourceDockOffset: sourceOffsets.get(edge.id) ?? 0,
          targetDockOffset: targetOffsets.get(edge.id) ?? 0,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: selected ? "var(--blue)" : "var(--edge)" },
        style: { stroke: "var(--edge)", strokeWidth: 1.35 },
        interactionWidth: 26,
      };
    });
  }, [data.dependencies, flowNodes, invalidDragId, removeDependency, selectedEdgeId]);

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

  const downloadBackup = useCallback(() => {
    const backupData: TaskData = {
      tasks: data.tasks.map((task) => ({
        ...task,
        ...(pendingNodePositions.current.has(task.id)
          ? { position: pendingNodePositions.current.get(task.id)! }
          : {}),
        ...(pendingNodeSizes.current.has(task.id)
          ? { size: pendingNodeSizes.current.get(task.id)! }
          : {}),
      })),
      dependencies: data.dependencies,
    };
    flushNodeLayout();
    const exportedAt = new Date();
    const contents = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: exportedAt.toISOString(),
      data: backupData,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `carpaccio-backup-${exportedAt.toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    showNotice("Backup downloaded.");
  }, [data, flushNodeLayout, showNotice]);

  const chooseBackupFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setPendingImport(null);
    if (file.size > MAX_BACKUP_BYTES) {
      showNotice("That backup is too large to restore.");
      return;
    }

    let contents: string;
    try {
      contents = await file.text();
    } catch {
      showNotice("Couldn’t read that file.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      showNotice("That file isn’t valid JSON.");
      return;
    }

    try {
      setPendingImport({ data: validatedBackup(parsed), fileName: file.name });
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Couldn’t restore that backup.");
    }
  }, [showNotice]);

  const restoreBackup = useCallback(() => {
    if (!pendingImport) return;
    clearArrangement();
    if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
    positionSaveTimer.current = null;
    pendingNodePositions.current.clear();
    pendingNodeSizes.current.clear();
    completionTimers.current.forEach((timer) => clearTimeout(timer));
    completionTimers.current.clear();
    setSettlingCompletedIds(new Set());
    setGraphDraft(null);
    setInspectedTaskId(null);
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
    setCompletedTasksOpen(false);
    pendingPreviousArrangement.current = undefined;
    dispatchHistory({ type: "reset", data: pendingImport.data });
    setPendingImport(null);
    showNotice(`Restored ${pendingImport.data.tasks.length} ${pendingImport.data.tasks.length === 1 ? "task" : "tasks"}.`);
  }, [clearArrangement, pendingImport, showNotice]);

  const handleFlowNodesChange = useCallback((changes: NodeChange<TaskFlowNode>[]) => {
    onFlowNodesChange(changes);
    let sizeChanged = false;
    let dragSpacingState: { id: string; invalid: boolean } | null = null;
    changes.forEach((change) => {
      if (change.type === "position" && change.position && (change.dragging || pendingNodePositions.current.has(change.id))) {
        pendingNodePositions.current.set(change.id, change.position);
      }
      if (change.type === "position" && change.position && change.dragging) {
        const movingNode = flowNodes.find((node) => node.id === change.id);
        if (movingNode) {
          const obstacles = flowNodes.filter((node) => node.id !== change.id).map(nodeRect);
          dragSpacingState = {
            id: change.id,
            invalid: !positionHasClearance(change.position, nodeDimensions(movingNode), obstacles),
          };
        }
      }
      if (change.type === "dimensions" && change.dimensions && (change.resizing || pendingNodeSizes.current.has(change.id))) {
        pendingNodeSizes.current.set(change.id, change.dimensions);
        sizeChanged = true;
      }
    });
    if (dragSpacingState) {
      const { id, invalid } = dragSpacingState;
      setInvalidDragId(invalid ? id : null);
      setFlowNodes((nodes) => nodes.map((node) => ({
        ...node,
        className: withSpacingNodeClass(node.className, node.id === id && invalid ? "invalid" : null),
      })));
    }
    if (sizeChanged) {
      clearArrangement();
      if (positionSaveTimer.current) clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = setTimeout(flushNodeLayout, 140);
    }
  }, [clearArrangement, flowNodes, flushNodeLayout, onFlowNodesChange, setFlowNodes]);

  const finishNodeDrag = useCallback((node: TaskFlowNode) => {
    const proposedPosition = pendingNodePositions.current.get(node.id) ?? node.position;
    const size = pendingNodeSizes.current.get(node.id) ?? nodeDimensions(node);
    const obstacles = flowNodes.filter((candidate) => candidate.id !== node.id).map(nodeRect);
    const position = nearestClearPosition(proposedPosition, size, obstacles);
    const snapped = position.x !== proposedPosition.x || position.y !== proposedPosition.y;
    pendingNodePositions.current.set(node.id, position);
    setInvalidDragId(null);
    if (spacingSnapTimer.current) clearTimeout(spacingSnapTimer.current);
    const snapDuration = snapped && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 180 : 0;
    setFlowNodes((nodes) => nodes.map((candidate) => candidate.id === node.id ? {
      ...candidate,
      position,
      className: withSpacingNodeClass(candidate.className, snapDuration ? "snapping" : null),
    } : candidate));
    if (snapDuration) {
      spacingSnapTimer.current = setTimeout(() => {
        spacingSnapTimer.current = null;
        setFlowNodes((nodes) => nodes.map((candidate) => candidate.id === node.id ? {
          ...candidate,
          className: withSpacingNodeClass(candidate.className, null),
        } : candidate));
      }, snapDuration);
    }
    if (arrangedDirection) {
      const layerIndex = arrangedLayerByTask.current.get(node.id);
      const guide = layerIndex === undefined ? undefined : layoutGuides[layerIndex];
      const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
      const remainsInAssignedLayer = guide ? (arrangedDirection === "vertical"
        ? center.y >= guide.y && center.y <= guide.y + guide.height
        : center.x >= guide.x && center.x <= guide.x + guide.width) : false;
      if (!remainsInAssignedLayer) clearArrangement();
    }
    flushNodeLayout();
  }, [arrangedDirection, clearArrangement, flowNodes, flushNodeLayout, layoutGuides, setFlowNodes]);

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
        const visibleTasks = current.tasks.filter((task) => showCompletedOnGraph || !task.completed);
        const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
        const visibleDependencies = current.dependencies.filter((dependency) => (
          visibleTaskIds.has(dependency.source) && visibleTaskIds.has(dependency.target)
        ));
        const arrangedTasks = arrangeTasks(visibleTasks, visibleDependencies, direction);
        if (arrangedTasks === visibleTasks) return current;
        const arrangedTasksById = new Map(arrangedTasks.map((task) => [task.id, task]));
        return {
          ...current,
          tasks: current.tasks.map((task) => arrangedTasksById.get(task.id) ?? task),
        };
      });
      arrangeTimer.current = setTimeout(() => {
        arrangeTimer.current = null;
        void (async () => {
          await flowInstance.current?.fitView({ padding: 0.14, minZoom: AUTOMATIC_FIT_MIN_ZOOM, maxZoom: 1.15, duration: 320 });
          if (arrangementVersion.current !== version) return;
          const nodesById = new Map(flowInstance.current?.getNodes().map((node) => [node.id, node]) ?? []);
          const settledTasks = data.tasks.filter((task) => showCompletedOnGraph || !task.completed).map((task) => {
            const node = nodesById.get(task.id);
            return node ? { ...task, position: node.position, size: nodeDimensions(node) } : task;
          });
          const settledTaskIds = new Set(settledTasks.map((task) => task.id));
          const visibleDependencies = data.dependencies.filter((dependency) => (
            settledTaskIds.has(dependency.source) && settledTaskIds.has(dependency.target)
          ));
          const snapshot = {
            direction,
            guides: arrangementGuides(settledTasks, visibleDependencies, direction),
            layerByTask: layerMembership(settledTasks, visibleDependencies),
          };
          activeArrangement.current = cloneArrangement(snapshot);
          setLayoutGuides(snapshot.guides);
          arrangedLayerByTask.current = snapshot.layerByTask;
          setArrangedDirection(direction);
          setIsArranging(false);
        })();
      }, 360);
    });
  }, [arrangedDirection, data.dependencies, data.tasks, flushNodeLayout, layoutDirection, layoutGuides.length, showCompletedOnGraph, updateData]);

  const chooseLayoutDirection = useCallback((direction: LayoutDirection) => {
    setLayoutDirection(direction);
    setArrangementOptionsOpen(false);
  }, []);

  const changeCompletedGraphVisibility = useCallback((showCompleted: boolean) => {
    flushNodeLayout();
    clearArrangement();
    setShowCompletedOnGraph(showCompleted);
  }, [clearArrangement, flushNodeLayout]);

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
  const hasVisibleGraphTasks = data.tasks.some((task) => showCompletedOnGraph || !task.completed) || settlingCompletedIds.size > 0;
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
    if (data.tasks.find((task) => task.id === id)?.completed) setCompletedTasksOpen(true);
    window.requestAnimationFrame(() => {
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
    });
  }, [data.tasks, isDesktopWorkspace, tasksPaneOpen]);

  const selectTaskFromList = useCallback((id: string) => {
    setSelectedTaskId(id);
    setSelectedEdgeId(null);
    setInspectedTaskId((inspected) => inspected ? id : null);
    revealTaskOnGraph(id);
  }, [revealTaskOnGraph]);

  const clearTaskSelection = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedEdgeId(null);
  }, []);

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
        <div className="list-heading-meta">
          <p>{data.tasks.filter((task) => !task.completed).length} remaining</p>
          <button
            type="button"
            className={`list-order-button ${listOrder === "up-next" ? "is-up-next" : ""}`}
            onClick={() => setListOrder((current) => current === "manual" ? "up-next" : "manual")}
            aria-pressed={listOrder === "up-next"}
            aria-label={`List order: ${listOrder === "manual" ? "My order" : "Up next"}. Switch to ${listOrder === "manual" ? "Up next" : "My order"}.`}
            title={`Switch to ${listOrder === "manual" ? "Up next" : "My order"}`}
          >
            <SortIcon />
            <span>{listOrder === "manual" ? "My order" : "Up next"}</span>
          </button>
        </div>
      </div>
      <ListView
        tasks={data.tasks}
        dependencies={data.dependencies}
        listOrder={listOrder}
        blockedIds={blockedIds}
        settlingCompletedIds={settlingCompletedIds}
        completedTasksOpen={completedTasksOpen}
        onCompletedTasksOpenChange={setCompletedTasksOpen}
        showCompletedOnGraph={showCompletedOnGraph}
        onShowCompletedOnGraphChange={changeCompletedGraphVisibility}
        onToggle={toggleTask}
        onRename={renameTask}
        onInspect={setInspectedTaskId}
        onSelect={selectTaskFromList}
        onClearSelection={clearTaskSelection}
        onReorder={reorderTasks}
        inspectedTaskId={inspectedTaskId}
        selectedTaskId={selectedTaskId}
        quickAdd={(
          <form className="quick-add" onSubmit={addTask}>
            <PlusIcon />
            <input value={newTask} onChange={(event) => setNewTask(event.target.value)} placeholder="New task" aria-label="New task title" />
            <button type="submit" disabled={!newTask.trim()}>Add</button>
          </form>
        )}
      />
      <div className="local-data">
        <div className="local-data-note" role="note">
          <InfoIcon />
          <p>Your tasks are stored only in this browser. They aren’t uploaded or synced.</p>
        </div>
        <div className="local-data-actions">
          <button type="button" onClick={downloadBackup} aria-label="Download a Carpaccio backup">Back up</button>
          <button type="button" onClick={() => backupInputRef.current?.click()} aria-label="Restore from a Carpaccio backup">Restore…</button>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json,.json"
            onChange={chooseBackupFile}
            aria-label="Choose a Carpaccio backup"
            hidden
          />
        </div>
        {pendingImport && (
          <div className="restore-confirmation" role="alertdialog" aria-labelledby="restore-confirmation-title">
            <p>
              <strong id="restore-confirmation-title">Replace all tasks?</strong>
              <span>{pendingImport.fileName} contains {pendingImport.data.tasks.length} {pendingImport.data.tasks.length === 1 ? "task" : "tasks"}. Your current tasks will be replaced. This can’t be undone.</span>
            </p>
            <div>
              <button type="button" onClick={() => setPendingImport(null)}>Cancel</button>
              <button type="button" className="confirm-restore" onClick={restoreBackup}>Restore</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <main className={`app-shell ${hydrated ? "" : "is-hydrating"}`}>
      <header className="app-header">
        <div className="header-leading">
          <div className="brand" aria-label="Carpaccio home">
            <span className="brand-mark"><CheckIcon /></span>
            <span>Carpaccio</span>
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
                  if (event.target instanceof Element && event.target.closest(".check-button, .inline-title, .inline-title-input, .react-flow__handle")) return;
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
                fitViewOptions={{ padding: 0.14, minZoom: AUTOMATIC_FIT_MIN_ZOOM, maxZoom: 1.15 }}
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
            {!hasVisibleGraphTasks && !graphDraft && (
              <div className="graph-empty" aria-hidden="true">
                <p>{data.tasks.length ? "All tasks complete." : "Double-click anywhere to add a task."}</p>
              </div>
            )}
            {hasVisibleGraphTasks && (
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
            {hasVisibleGraphTasks && (
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

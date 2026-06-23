import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as THREE from "three";
import { useNavigate } from "react-router";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  BrainCircuit,
  Cpu,
  FileText,
  MessageSquare,
  Network,
  FolderOpen,
  RotateCcw,
  RefreshCw,
  Save,
  Search,
  Settings,
  Box,
  X,
} from "lucide-react";
import {
  API,
  type AgentMapEdge,
  type AgentMapNode,
  type AgentMapResponse,
  type AgentProfileResponse,
  type ModelConfigResponse,
} from "../lib/api";
import { COMPOSED, SNAPPY } from "../lib/motion";

type Point = { x: number; y: number };

const CANVAS_W = 1500;
const CANVAS_H = 900;
const ROOT_ID = "orchestrator";

const STATUS_COLORS: Record<string, string> = {
  live: "var(--servari-green)",
  working: "var(--servari-teal)",
  idle: "var(--servari-dimmed)",
  done: "var(--servari-green)",
  blocked: "var(--servari-amber)",
  error: "var(--servari-red)",
  not_started: "var(--servari-dimmed)",
};

const GROUP_COLORS = [
  "#149C96",
  "#3FB950",
  "#E0A92A",
  "#F85149",
  "#4EA1D3",
  "#D68A3A",
  "#7AC7A7",
  "#E8C45C",
];

function colorForGroup(group: string): string {
  let hash = 0;
  for (const ch of group || "group") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

function statusColor(status: string): string {
  return STATUS_COLORS[status] || "var(--servari-dimmed)";
}

function shortRole(role: string): string {
  return (role || "agent").replace(/-/g, " ");
}

function trim(text: string, max = 120): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "..." : clean;
}

function nodeSize(node: AgentMapNode): number {
  if (node.id === ROOT_ID) return 40;
  if (node.type === "memory") return 16;
  if (node.status === "live" || node.status === "working") return 24;
  return 20;
}

function buildLayout(nodes: AgentMapNode[]): Record<string, Point> {
  const out: Record<string, Point> = {};
  out[ROOT_ID] = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

  const groups = Array.from(new Set(nodes.filter((n) => n.id !== ROOT_ID).map((n) => n.group || "ungrouped")));
  const groupCenters: Record<string, Point> = {};
  groups.forEach((group, index) => {
    const angle = (index / Math.max(groups.length, 1)) * Math.PI * 2 - Math.PI / 2;
    groupCenters[group] = {
      x: CANVAS_W / 2 + Math.cos(angle) * 430,
      y: CANVAS_H / 2 + Math.sin(angle) * 265,
    };
  });

  groups.forEach((group) => {
    const cluster = nodes.filter((node) => node.id !== ROOT_ID && (node.group || "ungrouped") === group);
    const center = groupCenters[group] || out[ROOT_ID];
    cluster.forEach((node, index) => {
      const ring = Math.floor(index / 9);
      const slot = index % 9;
      const angle = (slot / Math.min(cluster.length, 9)) * Math.PI * 2 + ring * 0.42;
      const radius = 72 + ring * 54;
      out[node.id] = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };
    });
  });
  return out;
}

function pathBetween(a: Point, b: Point): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = a.x + dx * 0.5;
  const my = a.y + dy * 0.5;
  const bend = Math.min(90, Math.max(-90, dx * 0.08));
  return `M ${a.x} ${a.y} Q ${mx + bend} ${my - 18}, ${b.x} ${b.y}`;
}

function normalizeRuntime(value: unknown): string {
  const raw = String(value || "").toLowerCase();
  return raw || "api";
}

function HoverCard({ node, point }: { node: AgentMapNode; point: Point }) {
  return (
    <motion.div
      className="pointer-events-none absolute z-30 w-[300px] rounded-lg p-4"
      style={{
        left: `clamp(170px, ${(point.x / CANVAS_W) * 100}%, calc(100% - 170px))`,
        top: `clamp(128px, ${(point.y / CANVAS_H) * 100}%, calc(100% - 128px))`,
        transform: "translate(-50%, -50%)",
        border: "1px solid rgba(20,156,150,0.35)",
        background: "rgba(15,18,24,0.94)",
        boxShadow: "0 18px 55px rgba(0,0,0,0.55)",
        backdropFilter: "blur(22px)",
      }}
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.96 }}
      transition={SNAPPY}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-14)", fontWeight: 750 }}>
            {node.name}
          </div>
          <div className="truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
            {shortRole(node.role)} / {node.group || "ungrouped"}
          </div>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-1"
          style={{
            border: `1px solid ${statusColor(node.status)}`,
            color: statusColor(node.status),
            fontSize: "var(--t-10)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
          }}
        >
          {node.status}
        </span>
      </div>
      <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)", lineHeight: 1.55 }}>
        {trim(node.current_task || node.latest_reply || "No channel activity yet.", 180)}
      </div>
      <div className="mt-3 flex items-center justify-between" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
        <span>{node.turns || 0} turns</span>
        <span>{node.type === "memory" ? "memory" : node.runtime_backend || "api"}</span>
      </div>
      {!!node.memory_files?.length && (
        <div className="mt-2 truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
          {node.memory_files.length} connected file{node.memory_files.length === 1 ? "" : "s"}
        </div>
      )}
    </motion.div>
  );
}

function Inspector({
  node,
  profile,
  model,
  brief,
  saving,
  onClose,
  onBriefChange,
  onProfileField,
  onSave,
  onOpenChat,
}: {
  node: AgentMapNode;
  profile: AgentProfileResponse | null;
  model: ModelConfigResponse | null;
  brief: string;
  saving: boolean;
  onClose: () => void;
  onBriefChange: (text: string) => void;
  onProfileField: (field: string, value: string) => void;
  onSave: () => void;
  onOpenChat: () => void;
}) {
  const form = profile?.profile || node;
  const providers = model?.providers?.filter((p) => p.id !== "auto") || [];
  return (
    <motion.aside
      className="fixed bottom-0 right-0 top-[46px] z-50 flex w-full max-w-[470px] flex-col"
      style={{
        borderLeft: "1px solid rgba(20,156,150,0.25)",
        background: "rgba(15,18,24,0.97)",
        boxShadow: "-24px 0 70px rgba(0,0,0,0.55)",
        backdropFilter: "blur(28px)",
      }}
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--s-edge-subtle)" }}>
        <div className="min-w-0">
          <div className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-16)", fontWeight: 760 }}>
            {form.name || node.name}
          </div>
          <div className="truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
            {node.source_label || "local profile"} / {node.id}
          </div>
        </div>
        <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded" title="Close">
          <X size={18} style={{ color: "var(--s-text-secondary)" }} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Name</span>
            <input
              value={String(form.name || "")}
              onChange={(event) => onProfileField("name", event.target.value)}
              className="rounded-lg px-3 py-2 outline-none"
              style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
            />
          </label>
          <label className="grid gap-1">
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Role</span>
            <input
              value={String(form.role || "")}
              onChange={(event) => onProfileField("role", event.target.value)}
              className="rounded-lg px-3 py-2 outline-none"
              style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
            />
          </label>
          <label className="grid gap-1">
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Group</span>
            <input
              value={String(form.group || "")}
              onChange={(event) => onProfileField("group", event.target.value)}
              className="rounded-lg px-3 py-2 outline-none"
              style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
            />
          </label>
          <label className="grid gap-1">
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Workflow</span>
            <input
              value={String(form.workflow || "")}
              onChange={(event) => onProfileField("workflow", event.target.value)}
              className="rounded-lg px-3 py-2 outline-none"
              style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
            />
          </label>
          <label className="grid gap-1 sm:col-span-2">
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Runtime</span>
            <select
              value={normalizeRuntime(form.runtime_backend || node.runtime_backend)}
              onChange={(event) => onProfileField("runtime_backend", event.target.value)}
              className="rounded-lg px-3 py-2 outline-none"
              style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label} {provider.available ? "ready" : "not installed"}
                </option>
              ))}
              {!providers.length && <option value="api">API</option>}
            </select>
          </label>
        </div>

        {!!node.memory_files?.length && (
          <div className="mt-5 rounded-lg p-3" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <div className="mb-2" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 700 }}>
              Connected memory
            </div>
            <div className="grid gap-2">
              {node.memory_files.map((file, index) => (
                <div key={`${file.path}-${index}`} className="grid grid-cols-[1fr_auto] gap-2" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
                  <span className="min-w-0 truncate">{file.label || "file"} / {file.path || ""}</span>
                  <span style={{ color: file.exists ? "var(--s-status-ok)" : "var(--s-status-warn)" }}>{file.exists ? "present" : "missing"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 700 }}>
            <FileText size={15} style={{ color: "var(--s-text-teal)" }} />
            START.md
          </div>
          <textarea
            value={brief}
            onChange={(event) => onBriefChange(event.target.value)}
            className="h-[360px] w-full resize-none rounded-lg p-3 outline-none"
            spellCheck={false}
            style={{
              background: "rgba(5,8,12,0.72)",
              border: "1px solid var(--s-edge-subtle)",
              color: "var(--s-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-12)",
              lineHeight: 1.55,
            }}
          />
        </div>
      </div>

      <div className="flex gap-2 px-5 py-4" style={{ borderTop: "1px solid var(--s-edge-subtle)" }}>
        <button
          type="button"
          onClick={onOpenChat}
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg"
          style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)", background: "rgba(250,248,243,0.035)" }}
        >
          <MessageSquare size={15} />
          Chat
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || node.id === ROOT_ID || node.editable === false}
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg disabled:opacity-45"
          style={{ border: "1px solid rgba(20,156,150,0.45)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.10)" }}
        >
          <Save size={15} />
          {saving ? "Saving" : "Save"}
        </button>
      </div>
    </motion.aside>
  );
}

function depthForNode(node: AgentMapNode): number {
  if (node.id === ROOT_ID) return 120;
  if (node.type === "memory") return -120;
  let hash = 0;
  for (const ch of `${node.group}:${node.id}`) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return ((hash % 240) - 120) * 0.9;
}

function edgeColor(kind: string): string {
  if (kind === "workflow") return "#E0A92A";
  if (kind === "memory") return "#7AC7A7";
  return "#149C96";
}

function Graph3D({
  nodes,
  edges,
  positions,
  reduce,
  resetSignal,
  onHover,
  onSelect,
}: {
  nodes: AgentMapNode[];
  edges: AgentMapEdge[];
  positions: Record<string, Point>;
  reduce: boolean;
  resetSignal: number;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x081016, 0.00042);
    const camera = new THREE.PerspectiveCamera(52, 1, 1, 5000);
    camera.position.set(0, 0, 980);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.dataset.servariGraph3d = "true";
    mount.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const meshes: THREE.Mesh[] = [];
    const nodePosition = new Map<string, THREE.Vector3>();
    const sphere = new THREE.SphereGeometry(1, 24, 16);

    for (const node of nodes) {
      const point = positions[node.id];
      if (!point) continue;
      const pos = new THREE.Vector3((point.x - CANVAS_W / 2) * 0.82, -(point.y - CANVAS_H / 2) * 0.82, depthForNode(node));
      nodePosition.set(node.id, pos);
      const color = node.id === ROOT_ID ? "#149C96" : node.type === "memory" ? "#7AC7A7" : colorForGroup(node.group);
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: node.status === "blocked" ? 0.72 : 1 });
      const mesh = new THREE.Mesh(sphere, material);
      const size = nodeSize(node) * (node.type === "memory" ? 0.78 : 1.08);
      mesh.scale.setScalar(size);
      mesh.position.copy(pos);
      mesh.userData.nodeId = node.id;
      meshes.push(mesh);
      group.add(mesh);

      const glow = new THREE.Mesh(
        sphere,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: node.id === ROOT_ID ? 0.22 : 0.13, wireframe: true }),
      );
      glow.scale.setScalar(size * 1.55);
      glow.position.copy(pos);
      group.add(glow);
    }

    for (const edge of edges) {
      const a = nodePosition.get(edge.source);
      const b = nodePosition.get(edge.target);
      if (!a || !b) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
      const material = new THREE.LineBasicMaterial({ color: edgeColor(edge.kind), transparent: true, opacity: edge.kind === "memory" ? 0.68 : 0.48 });
      group.add(new THREE.Line(geometry, material));
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    const controls = {
      dragging: false,
      panning: false,
      moved: false,
      lastX: 0,
      lastY: 0,
      vx: 0,
      vy: 0,
    };

    const resetView = () => {
      group.rotation.set(0, 0, 0);
      group.position.set(0, 0, 0);
      camera.position.set(0, 0, 980);
      controls.vx = 0;
      controls.vy = 0;
    };
    resetView();

    const hitTest = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(meshes, false)[0];
    };

    const updateHover = (event: PointerEvent) => {
      const hit = hitTest(event);
      onHover(hit ? String(hit.object.userData.nodeId) : null);
      renderer.domElement.style.cursor = hit ? "pointer" : controls.dragging ? "grabbing" : "grab";
      return hit;
    };

    const onPointerDown = (event: PointerEvent) => {
      controls.dragging = true;
      controls.panning = event.shiftKey || event.button === 1 || event.button === 2;
      controls.moved = false;
      controls.lastX = event.clientX;
      controls.lastY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
      renderer.domElement.style.cursor = "grabbing";
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!controls.dragging) {
        updateHover(event);
        return;
      }
      const dx = event.clientX - controls.lastX;
      const dy = event.clientY - controls.lastY;
      controls.lastX = event.clientX;
      controls.lastY = event.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) controls.moved = true;
      if (controls.panning) {
        group.position.x += dx * 0.78;
        group.position.y -= dy * 0.78;
      } else {
        group.rotation.y += dx * 0.006;
        group.rotation.x = Math.max(-1.25, Math.min(1.25, group.rotation.x + dy * 0.006));
        controls.vx = dx * 0.0009;
        controls.vy = dy * 0.0006;
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const moved = controls.moved;
      controls.dragging = false;
      controls.panning = false;
      try { renderer.domElement.releasePointerCapture(event.pointerId); } catch {}
      const hit = updateHover(event);
      if (!moved && hit) onSelect(String(hit.object.userData.nodeId));
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      camera.position.z = Math.max(360, Math.min(1850, camera.position.z + event.deltaY * 0.72));
    };
    const onDoubleClick = () => resetView();
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onLeave = () => {
      controls.dragging = false;
      onHover(null);
      renderer.domElement.style.cursor = "grab";
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onLeave);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("dblclick", onDoubleClick);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    let raf = 0;
    const animate = () => {
      if (!reduce && !controls.dragging) {
        group.rotation.y += controls.vx;
        group.rotation.x = Math.max(-1.25, Math.min(1.25, group.rotation.x + controls.vy));
        controls.vx *= 0.94;
        controls.vy *= 0.92;
      }
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      mount.removeChild(renderer.domElement);
      sphere.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry && mesh.geometry !== sphere) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else if (material) material.dispose();
      });
      renderer.dispose();
    };
  }, [edges, nodes, onHover, onSelect, positions, reduce, resetSignal]);

  return (
    <div className="relative h-full min-h-[620px] w-full overflow-hidden" title="Drag to rotate. Shift-drag or right-drag to pan. Mouse wheel zooms. Double-click resets.">
      <div ref={mountRef} className="absolute inset-0" />
    </div>
  );
}

export function OrgChart() {
  const navigate = useNavigate();
  const reduce = useReducedMotion() ?? false;
  const [data, setData] = useState<AgentMapResponse | null>(null);
  const [model, setModel] = useState<ModelConfigResponse | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"2d" | "3d">("3d");
  const [graphResetSeq, setGraphResetSeq] = useState(0);
  const [graphMessage, setGraphMessage] = useState("");
  const [obsidianBusy, setObsidianBusy] = useState(false);
  const [profile, setProfile] = useState<AgentProfileResponse | null>(null);
  const [brief, setBrief] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [map, cfg] = await Promise.all([API.agentMap(), API.modelConfig().catch(() => null)]);
      setData(map);
      if (cfg) setModel(cfg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedNode = useMemo(() => data?.agents.find((node) => node.id === selected) || null, [data, selected]);

  useEffect(() => {
    let alive = true;
    if (!selectedNode) {
      setProfile(null);
      setBrief("");
      return;
    }
    if (selectedNode.id === ROOT_ID) {
      setProfile({ ok: true, profile: selectedNode, brief: undefined });
      setBrief("# Orchestrator\n\nCentral SERVARI control plane.");
      return;
    }
    API.agentProfile(selectedNode.id)
      .then((result) => {
        if (!alive) return;
        setProfile(result);
        setBrief(result.brief?.brief || "");
      })
      .catch(() => {
        if (!alive) return;
        setProfile(null);
        setBrief("");
      });
    return () => {
      alive = false;
    };
  }, [selectedNode]);

  const visibleNodes = useMemo(() => {
    const nodes = data?.agents || [];
    const q = query.trim().toLowerCase();
    return nodes.filter((node) => {
      if (node.id === ROOT_ID) return true;
      if (group !== "all" && node.group !== group) return false;
      if (!q) return true;
      return [node.name, node.role, node.group, node.workflow, node.current_task, node.latest_reply].join(" ").toLowerCase().includes(q);
    });
  }, [data, group, query]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const positions = useMemo(() => buildLayout(visibleNodes), [visibleNodes]);
  const edges = useMemo(
    () => (data?.edges || []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).slice(0, 220),
    [data, visibleIds],
  );
  const hoveredNode = hovered ? visibleNodes.find((node) => node.id === hovered) || null : null;
  const groups = data?.groups || [];
  const handleHover = useCallback((id: string | null) => setHovered(id), []);
  const handleSelect = useCallback((id: string) => setSelected(id), []);

  const runObsidianAction = useCallback(async (action: "sync" | "open-folder" | "open-obsidian") => {
    setObsidianBusy(true);
    setGraphMessage("");
    try {
      const result = await API.obsidianAction(action);
      if (result.ok) {
        setGraphMessage(`${result.notes || 0} Obsidian notes at ${result.path}`);
      } else {
        setGraphMessage(result.error || "Obsidian action failed.");
      }
    } catch (error) {
      setGraphMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setObsidianBusy(false);
    }
  }, []);

  const updateProfileField = useCallback((field: string, value: string) => {
    setProfile((current) => {
      if (!current?.profile) return current;
      return { ...current, profile: { ...current.profile, [field]: value } };
    });
  }, []);

  const saveSelected = useCallback(async () => {
    if (!selectedNode || selectedNode.id === ROOT_ID) return;
    setSaving(true);
    try {
      if (profile?.profile) {
        await API.saveAgentProfile({ ...profile.profile, id: selectedNode.id });
      }
      await API.saveAgentBrief(selectedNode.id, brief);
      await load();
    } finally {
      setSaving(false);
    }
  }, [brief, load, profile, selectedNode]);

  return (
    <div className="h-full overflow-hidden p-4 md:p-6 xl:p-8">
      <div className="mx-auto flex h-full max-w-[1600px] flex-col gap-4">
        <motion.header
          className="flex flex-col gap-3 rounded-lg px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
          style={{
            border: "1px solid var(--s-edge-accent)",
            background: "linear-gradient(135deg, rgba(20,156,150,0.13), rgba(18,22,30,0.72))",
          }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={COMPOSED}
        >
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2" style={{ color: "var(--s-text-teal)", fontSize: "var(--t-11)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
              <BrainCircuit size={15} />
              Agent Neural Map
            </div>
            <h1 className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>
              Agent Memory Graph
            </h1>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label
              className="flex h-10 min-w-0 items-center gap-2 rounded-lg px-3"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass)" }}
            >
              <Search size={15} style={{ color: "var(--s-text-secondary)" }} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search agents"
                className="w-full bg-transparent outline-none sm:w-56"
                style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}
              />
            </label>
            <select
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              className="h-10 rounded-lg px-3 outline-none"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass)", color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}
            >
              <option value="all">All groups</option>
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} {item.count ? `(${item.count})` : ""}
                </option>
              ))}
            </select>
            <div className="grid h-10 grid-cols-2 rounded-lg p-1" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass)" }}>
              {(["3d", "2d"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setMode(item)}
                  className="inline-flex items-center justify-center gap-2 rounded-md px-3"
                  style={{
                    background: mode === item ? "rgba(20,156,150,0.16)" : "transparent",
                    color: mode === item ? "var(--s-text-teal)" : "var(--s-text-secondary)",
                    fontSize: "var(--t-12)",
                    minWidth: 52,
                  }}
                >
                  {item === "3d" ? <Box size={14} /> : <Network size={14} />}
                  {item.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setGraphResetSeq((value) => value + 1)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.035)", color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}
            >
              <RotateCcw size={15} />
              Reset
            </button>
            <button
              type="button"
              onClick={() => void runObsidianAction("sync")}
              disabled={obsidianBusy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-50"
              style={{ border: "1px solid rgba(20,156,150,0.38)", background: "rgba(20,156,150,0.08)", color: "var(--s-text-teal)", fontSize: "var(--t-12)" }}
            >
              <Network size={15} />
              Sync Vault
            </button>
            <button
              type="button"
              onClick={() => void runObsidianAction("open-obsidian")}
              disabled={obsidianBusy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-50"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.035)", color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}
            >
              <FolderOpen size={15} />
              Open Vault
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.035)", color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}
            >
              <RefreshCw size={15} />
              {loading ? "Loading" : "Refresh"}
            </button>
          </div>
        </motion.header>

        <div
          className="relative min-h-0 flex-1 overflow-auto rounded-lg"
          style={{
            border: "1px solid var(--s-edge-subtle)",
            background: "radial-gradient(circle at 50% 45%, rgba(20,156,150,0.12), transparent 34%), rgba(9,12,17,0.58)",
          }}
        >
          {mode === "3d" ? (
            <Graph3D
              nodes={visibleNodes}
              edges={edges}
              positions={positions}
              reduce={reduce}
              resetSignal={graphResetSeq}
              onHover={handleHover}
              onSelect={handleSelect}
            />
          ) : (
          <svg width={CANVAS_W} height={CANVAS_H} viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} className="min-h-full min-w-full">
            <defs>
              <filter id="agent-neural-glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <radialGradient id="agent-root-fill" cx="50%" cy="40%" r="70%">
                <stop offset="0%" stopColor="#1d2832" />
                <stop offset="100%" stopColor="#10141c" />
              </radialGradient>
            </defs>

            {edges.map((edge) => {
              const a = positions[edge.source];
              const b = positions[edge.target];
              if (!a || !b) return null;
              const active = hovered === edge.source || hovered === edge.target || selected === edge.source || selected === edge.target;
              return (
                <motion.path
                  key={edge.id}
                  d={pathBetween(a, b)}
                  fill="none"
                  stroke={edge.kind === "workflow" ? "rgba(224,169,42,0.44)" : "rgba(20,156,150,0.40)"}
                  strokeWidth={active ? 2.3 : 1.1}
                  strokeDasharray={edge.kind === "workflow" ? "4 7" : undefined}
                  filter={active ? "url(#agent-neural-glow)" : undefined}
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: active ? 0.95 : 0.36 }}
                  transition={{ duration: reduce ? 0 : 0.55, ease: "easeOut" }}
                />
              );
            })}

            {visibleNodes.map((node) => {
              const point = positions[node.id];
              if (!point) return null;
              const size = nodeSize(node);
              const selectedNow = selected === node.id;
              const hoveredNow = hovered === node.id;
              const stroke = node.id === ROOT_ID ? "var(--servari-teal)" : colorForGroup(node.group);
              return (
                <motion.g
                  key={node.id}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered((current) => (current === node.id ? null : current))}
                  onClick={() => setSelected(node.id)}
                  style={{ cursor: "pointer" }}
                  initial={{ opacity: 0, scale: 0.2 }}
                  animate={{ opacity: 1, scale: selectedNow || hoveredNow ? 1.12 : 1 }}
                  transition={{ type: "spring", stiffness: 260, damping: 20 }}
                >
                  {!reduce && (node.status === "live" || node.status === "working") && (
                    <motion.circle
                      cx={point.x}
                      cy={point.y}
                      r={size + 8}
                      fill="none"
                      stroke={statusColor(node.status)}
                      strokeWidth={1.3}
                      animate={{ opacity: [0.6, 0.05, 0.6], scale: [1, 1.34, 1] }}
                      transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
                      style={{ transformOrigin: `${point.x}px ${point.y}px`, transformBox: "fill-box" } as CSSProperties}
                    />
                  )}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={size}
                    fill={node.id === ROOT_ID ? "url(#agent-root-fill)" : "rgba(18,22,30,0.96)"}
                    stroke={selectedNow ? "var(--servari-ivory)" : stroke}
                    strokeWidth={selectedNow ? 3 : hoveredNow ? 2.5 : 1.6}
                    filter={selectedNow || hoveredNow || node.id === ROOT_ID ? "url(#agent-neural-glow)" : undefined}
                  />
                  <circle cx={point.x + size * 0.52} cy={point.y - size * 0.52} r={4.5} fill={statusColor(node.status)} />
                  {node.id === ROOT_ID ? (
                    <image href="/raven.png" x={point.x - 24} y={point.y - 24} width={48} height={48} preserveAspectRatio="xMidYMid meet" />
                  ) : (
                    <text
                      x={point.x}
                      y={point.y + 4}
                      textAnchor="middle"
                      fill="var(--s-text-primary)"
                      fontFamily="var(--font-mono)"
                      fontSize={Math.max(9, Math.min(12, 110 / Math.max(node.name.length, 6)))}
                      style={{ pointerEvents: "none" }}
                    >
                      {node.name.split(" ")[0].slice(0, 9)}
                    </text>
                  )}
                  {(hoveredNow || selectedNow) && (
                    <text
                      x={point.x}
                      y={point.y + size + 18}
                      textAnchor="middle"
                      fill="var(--s-text-secondary)"
                      fontFamily="var(--font-mono)"
                      fontSize={10}
                      style={{ pointerEvents: "none" }}
                    >
                      {trim(node.name, 24)}
                    </text>
                  )}
                </motion.g>
              );
            })}
          </svg>
          )}

          {graphMessage && (
            <div className="absolute left-4 top-4 z-20 max-w-[min(560px,calc(100%-2rem))] rounded-lg px-3 py-2" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(15,18,24,0.92)", color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
              {graphMessage}
            </div>
          )}
          <AnimatePresence>
            {hoveredNode && positions[hoveredNode.id] && <HoverCard node={hoveredNode} point={positions[hoveredNode.id]} />}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {selectedNode && (
          <Inspector
            node={selectedNode}
            profile={profile}
            model={model}
            brief={brief}
            saving={saving}
            onClose={() => setSelected(null)}
            onBriefChange={setBrief}
            onProfileField={updateProfileField}
            onSave={() => void saveSelected()}
            onOpenChat={() => navigate(`/shell/chat?agent=${encodeURIComponent(selectedNode.id)}`)}
          />
        )}
      </AnimatePresence>

      <div
        className="pointer-events-none fixed bottom-20 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-4 rounded-lg px-4 py-2 md:flex"
        style={{ border: "1px solid var(--s-edge-accent)", background: "rgba(15,18,24,0.96)", color: "var(--s-text-secondary)", fontSize: "var(--t-11)", boxShadow: "0 18px 48px rgba(0,0,0,0.45)" }}
      >
        <span className="inline-flex items-center gap-2">
          <BrainCircuit size={14} style={{ color: "var(--s-text-teal)" }} />
          {visibleNodes.length} nodes
        </span>
        <span className="inline-flex items-center gap-2">
          <Cpu size={14} style={{ color: "var(--s-status-ok)" }} />
          {model?.effective_backend || "backend pending"}
        </span>
        <span className="inline-flex items-center gap-2">
          <Settings size={14} />
select node
        </span>
      </div>
    </div>
  );
}

export default OrgChart;

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Share2, X } from "lucide-react";
import { API } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// --- Server shapes (the org registry via /api/org). Typed loosely because the
//     api client returns `unknown` for these fields; we read defensively. ---
interface RawOrgNode {
  name: string;
  role?: string;
  reports_to?: string | null;
  manages?: string[];
  dir?: string | null;
  peer?: string;
  staged?: boolean;
  is_human?: boolean;
  skills?: string;
}

interface OrgNode {
  id: string; // lowercased key derived from name
  label: string; // short display label
  fullName: string; // original name for tooltip
  role: string;
  level: number;
  isHuman: boolean;
  isRoot: boolean;
  parentId: string | null;
  live: boolean; // has recent channel activity
  turns: number;
}

interface OrgEdge {
  from: string;
  to: string;
}

interface CommsRow {
  agent: string;
  talksTo: string[];
}

// The neutral id the chart uses for the always-present orchestrator root.
const ROOT_ID = "root";

// Turn a node name ("Engineering Lead (Codename)", "R1 Backend & Security",
// "Operator") into a short chart label + a stable id for edge-matching against
// reports_to values.
function shortLabel(name: string): string {
  const paren = name.replace(/\s*\(.*\)\s*$/, "").trim();
  const rMatch = paren.match(/^(R\d+|Lead|Head)\b/i);
  if (rMatch) return rMatch[1].toUpperCase();
  const first = paren.split(/\s+/)[0];
  return first.length > 7 ? first.slice(0, 7) : first;
}

function idFor(name: string): string {
  return name.toLowerCase().replace(/\s*\(.*\)\s*$/, "").trim().replace(/\s+/g, "-");
}

// Strip any internal codename in parentheses ("Engineering Lead (Codename)" ->
// "Engineering Lead") BEFORE the seal maps the residual role to its outward
// title. Whatever the seal can't map to a clean outward word it hides.
function sealName(name: string): string {
  const noParen = name.replace(/\s*\(.*\)\s*$/, "").trim();
  return sealLabel(noParen) || sealLabel(name) || noParen;
}

// Match a chart node to a live channel key from API.state().channels.
// Channel keys are kebab ("r1-backend-security"); our ids match.
function channelTurnsFor(id: string, channels: Record<string, { turns?: number }>): number {
  if (channels[id]) return Number(channels[id].turns ?? 0);
  // some channels are prefixed (e.g. "team:lead") — try suffix match.
  for (const [k, v] of Object.entries(channels)) {
    if (k === id || k.endsWith(":" + id)) return Number(v?.turns ?? 0);
  }
  return 0;
}

// The always-present root. When the org registry is empty or unreachable, the
// chart still renders this single node (the orchestrator is the always-present
// root) rather than going blank — per the screen contract. It carries the root
// flag so it draws with the raven mark + ORCHESTRATOR label, exactly like the
// root node in a fully-populated chart. No sample data is invented.
function orchestratorOnlyNode(): OrgNode {
  return {
    id: ROOT_ID,
    label: "ORCHESTRATOR",
    fullName: "orchestrator",
    role: "",
    level: 0,
    isHuman: false,
    isRoot: true,
    parentId: null,
    live: false,
    turns: 0,
  };
}

export function OrgChart() {
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [edges, setEdges] = useState<OrgEdge[]>([]);
  const [comms, setComms] = useState<CommsRow[]>([]);
  const [chainRule, setChainRule] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showComms, setShowComms] = useState(false);
  const reduce = useReducedMotion();
  const uid = useRef(`og-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    let alive = true;
    Promise.all([API.org(), API.state().catch(() => null)])
      .then(([d, st]) => {
        if (!alive) return;
        const rawChart = (d.org_chart as RawOrgNode[] | undefined) || [];
        if (!rawChart.length) {
          const noteVal =
            (d._note as string | undefined) ||
            (d.org_note as string | undefined) ||
            "Org registry not available yet.";
          setNote(noteVal);
          // Per the screen contract: never go blank — render the single
          // orchestrator node (the always-present root) so the chart still shows
          // the orchestrator identity while the honest note states why no further
          // chart loaded. No fabricated data.
          setNodes([orchestratorOnlyNode()]);
          setEdges([]);
          return;
        }

        const channels =
          (st?.channels as Record<string, { turns?: number }> | undefined) || {};

        const byId = new Map<string, RawOrgNode>();
        rawChart.forEach((n) => byId.set(idFor(n.name), n));

        const levelOf = (id: string, seen = new Set<string>()): number => {
          const n = byId.get(id);
          if (!n || n.reports_to == null) return 0;
          if (seen.has(id)) return 0; // cycle guard
          seen.add(id);
          const parentId = idFor(n.reports_to);
          if (!byId.has(parentId)) return 1;
          return 1 + levelOf(parentId, seen);
        };

        const orgNodes: OrgNode[] = rawChart.map((n) => {
          const id = idFor(n.name);
          const parentId =
            n.reports_to != null && byId.has(idFor(n.reports_to))
              ? idFor(n.reports_to)
              : null;
          const turns = channelTurnsFor(id, channels);
          // DISPLAY SEAL: never surface codenames or internal vocab. A human
          // node keeps its real name; everything else is sealed to a clean
          // outward label. The root is any node with no parent at the top level.
          const isHuman = Boolean(n.is_human);
          const isRoot = id === ROOT_ID || (parentId === null && n.reports_to == null);
          const sealedFull = isHuman ? n.name : sealName(n.name);
          const sealedRole = sealLabel(n.role || "");
          return {
            id,
            label: isHuman ? shortLabel(n.name) : sealLabel(shortLabel(n.name)) || shortLabel(n.name),
            fullName: sealedFull || shortLabel(n.name),
            role: sealedRole,
            level: levelOf(id),
            isHuman,
            isRoot,
            parentId,
            live: turns > 0,
            turns,
          };
        });

        const orgEdges: OrgEdge[] = [];
        orgNodes.forEach((n) => {
          if (n.parentId) orgEdges.push({ from: n.parentId, to: n.id });
        });

        setNodes(orgNodes);
        setEdges(orgEdges);

        const cm = (d.comms_matrix as Record<string, { talks_to?: string[] }> | undefined) || {};
        const commsRows: CommsRow[] = Object.entries(cm)
          .filter(([k]) => !k.startsWith("_"))
          .map(([agent, v]) => ({
            // seal the comms-matrix labels too (these are channel keys / names).
            agent: sealLabel(agent) || agent,
            talksTo: (Array.isArray(v?.talks_to) ? v.talks_to : []).map((t) => sealLabel(t) || t),
          }))
          .filter((r) => r.talksTo.length > 0);
        setComms(commsRows);

        const rc = d.reporting_chain as { rule?: string } | undefined;
        if (rc?.rule) setChainRule(sealLabel(rc.rule));
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        // Even on a hard failure, keep the orchestrator on screen (contract:
        // single root node) so the view never collapses to nothing.
        setNodes([orchestratorOnlyNode()]);
        setEdges([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // --- Layout: root at top center, heads fanned in a row, members fanned under
  //     each head. Width scales to the widest level so nothing collides. ---
  const layout = useMemo(() => {
    const byLevel: Record<number, OrgNode[]> = {};
    nodes.forEach((n) => {
      (byLevel[n.level] = byLevel[n.level] || []).push(n);
    });
    const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
    const maxCount = levels.reduce((m, l) => Math.max(m, byLevel[l].length), 1);

    const colW = 132; // horizontal slot per node on the widest row
    const rowH = 168; // vertical gap between levels
    const padX = 80;
    const padTop = 90;
    const width = Math.max(960, maxCount * colW + padX * 2);

    // Group children under their parent's horizontal center where possible so
    // the fan reads as a real tree, not a generic grid.
    const pos: Record<string, { x: number; y: number }> = {};

    // Level 0 + 1 (human + root): center them.
    levels.forEach((lvl) => {
      const row = byLevel[lvl];
      const y = padTop + lvl * rowH;
      if (lvl <= 1) {
        const spacing = (width - padX * 2) / (row.length + 1);
        row.forEach((n, i) => {
          pos[n.id] = { x: padX + spacing * (i + 1), y };
        });
      }
    });

    // Heads (level 2) — even fan across the canvas.
    const heads = (byLevel[2] || []);
    if (heads.length) {
      const spacing = (width - padX * 2) / (heads.length + 1);
      heads.forEach((h, i) => {
        pos[h.id] = { x: padX + spacing * (i + 1), y: padTop + 2 * rowH };
      });
    }

    // Members (level 3+) — clustered under their parent head, fanned symmetrically.
    levels.filter((l) => l >= 3).forEach((lvl) => {
      const row = byLevel[lvl];
      const y = padTop + lvl * rowH;
      // bucket members by parent
      const buckets: Record<string, OrgNode[]> = {};
      row.forEach((n) => {
        const p = n.parentId || "_orphan";
        (buckets[p] = buckets[p] || []).push(n);
      });
      Object.entries(buckets).forEach(([pid, members]) => {
        const center = pos[pid]?.x ?? width / 2;
        const fanW = Math.min(colW, (width - padX * 2) / Math.max(row.length, 1));
        const total = (members.length - 1) * fanW;
        members.forEach((s, i) => {
          let x = center - total / 2 + i * fanW;
          x = Math.max(padX + 28, Math.min(width - padX - 28, x));
          pos[s.id] = { x, y };
        });
      });
    });

    const maxLevel = levels.length ? Math.max(...levels) : 0;
    const height = padTop + maxLevel * rowH + 110;
    return { pos, width, height };
  }, [nodes]);

  const { pos, width: svgWidth, height: svgHeight } = layout;

  // True when the chart is the lone-orchestrator fallback (empty/unreachable
  // registry): one node, the root, no edges. The honest note still shows in
  // this case so the screen states WHY the rest of the chart is absent.
  const orchestratorOnly =
    nodes.length === 1 && nodes[0]?.isRoot && edges.length === 0;

  // Quadratic-bezier path parent->child with a gentle downward bow.
  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y + 38} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y - 38}`;
  };

  // Edges touching the hovered node light up; its sub-tree stays bright.
  const edgeActive = (e: OrgEdge) =>
    hovered != null && (e.from === hovered || e.to === hovered);

  const hoveredNode = hovered ? nodes.find((n) => n.id === hovered) : null;

  // Stagger timing: root wave first, heads next, members last — by level.
  const nodeDelay = (n: OrgNode) => {
    if (reduce) return 0;
    if (n.level <= 1) return 0.05 * n.level;
    if (n.level === 2) return 0.35 + 0.12 * 0; // heads handled per-index below
    return 0.9;
  };
  const indexInLevel = (n: OrgNode) =>
    nodes.filter((m) => m.level === n.level).indexOf(n);

  const entranceDelay = (n: OrgNode) => {
    if (reduce) return 0;
    const i = indexInLevel(n);
    if (n.level <= 1) return 0.05 * n.level;
    if (n.level === 2) return 0.35 + i * 0.12;
    return 0.85 + i * 0.06;
  };
  const lineDelay = (e: OrgEdge) => {
    const child = nodes.find((n) => n.id === e.to);
    return child ? Math.max(0, entranceDelay(child) - 0.1) : 0.3;
  };

  return (
    <div className="h-full p-8 overflow-auto relative">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8 flex items-center justify-between">
          <div
            style={{
              color: "var(--servari-ivory)",
              fontSize: "1.5rem",
              letterSpacing: "1px",
            }}
          >
            ORG CHART
          </div>

          {comms.length > 0 && (
            <motion.button
              onClick={() => setShowComms((v) => !v)}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg"
              style={{
                background: showComms
                  ? "rgba(20, 156, 150, 0.16)"
                  : "var(--servari-glass)",
                backdropFilter: "blur(20px)",
                border: showComms
                  ? "1px solid rgba(20, 156, 150, 0.45)"
                  : "1px solid rgba(250, 248, 243, 0.1)",
                color: showComms ? "var(--servari-teal-soft)" : "var(--servari-dimmed)",
                fontSize: "0.8125rem",
                letterSpacing: "0.5px",
              }}
            >
              <Share2 size={14} />
              connections
            </motion.button>
          )}
        </div>

        {error && (
          <div
            className="mb-6 p-4 rounded-xl"
            style={{
              background: "var(--servari-glass)",
              border: "1px solid rgba(248, 81, 73, 0.2)",
              color: "var(--servari-dimmed)",
              fontSize: "0.8125rem",
            }}
          >
            Org chart unavailable: {error}
          </div>
        )}

        {note && (!nodes.length || orchestratorOnly) && (
          <div
            className="mb-6 p-4 rounded-xl"
            style={{
              background: "var(--servari-glass)",
              border: "1px solid rgba(250, 248, 243, 0.08)",
              color: "var(--servari-dimmed)",
              fontSize: "0.875rem",
              lineHeight: "1.6",
            }}
          >
            {note}
          </div>
        )}

        {nodes.length > 0 && (
          <div className="relative">
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full"
              style={{ overflow: "visible" }}
            >
              <defs>
                <filter id={`${uid}-glow`} x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="3.2" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <radialGradient id={`${uid}-rootFill`} cx="50%" cy="38%" r="75%">
                  <stop offset="0%" stopColor="#1b2230" />
                  <stop offset="100%" stopColor="var(--servari-panel)" />
                </radialGradient>
                <radialGradient id={`${uid}-ripple`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="rgba(20,156,150,0.35)" />
                  <stop offset="70%" stopColor="rgba(20,156,150,0.10)" />
                  <stop offset="100%" stopColor="rgba(20,156,150,0)" />
                </radialGradient>
              </defs>

              {/* Self-drawing connection lines */}
              {edges.map((edge) => {
                const start = pos[edge.from];
                const end = pos[edge.to];
                if (!start || !end) return null;
                const active = edgeActive(edge);
                return (
                  <motion.path
                    key={`${edge.from}-${edge.to}`}
                    d={edgePath(start, end)}
                    fill="none"
                    stroke="var(--servari-teal)"
                    strokeWidth={active ? 2.4 : 1.5}
                    strokeLinecap="round"
                    filter={`url(#${uid}-glow)`}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{
                      pathLength: 1,
                      opacity: active ? 0.95 : 0.34,
                    }}
                    transition={{
                      pathLength: {
                        duration: reduce ? 0 : 0.5,
                        delay: lineDelay(edge),
                        ease: "easeInOut",
                      },
                      opacity: { duration: 0.3 },
                      strokeWidth: { duration: 0.25 },
                    }}
                  />
                );
              })}

              {/* Nodes */}
              {nodes.map((node) => {
                const p = pos[node.id];
                if (!p) return null;
                const r = node.isRoot ? 46 : node.level <= 2 ? 38 : 32;
                const isHover = hovered === node.id;
                const ringColor = node.isHuman
                  ? "var(--servari-amber)"
                  : "var(--servari-teal)";
                return (
                  <motion.g
                    key={node.id}
                    style={{ cursor: "default" }}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      delay: entranceDelay(node),
                      type: "spring",
                      stiffness: 220,
                      damping: 16,
                    }}
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered((h) => (h === node.id ? null : h))}
                  >
                    {/* hover lift wrapper */}
                    <motion.g
                      animate={{ scale: isHover ? 1.08 : 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 18 }}
                      style={{ transformOrigin: `${p.x}px ${p.y}px`, transformBox: "fill-box" } as React.CSSProperties}
                    >
                      {/* ENTRANCE ripple — one soft teal pulse on arrival */}
                      <motion.circle
                        cx={p.x}
                        cy={p.y}
                        r={r}
                        fill={`url(#${uid}-ripple)`}
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: [0.6, 2.1], opacity: [0.7, 0] }}
                        transition={{
                          delay: entranceDelay(node) + 0.05,
                          duration: reduce ? 0 : 1.1,
                          ease: "easeOut",
                        }}
                        style={{ transformOrigin: `${p.x}px ${p.y}px`, transformBox: "fill-box" } as React.CSSProperties}
                      />

                      {/* LIVE pulse — slow teal breathing ring for active agents */}
                      {node.live && !reduce && (
                        <motion.circle
                          cx={p.x}
                          cy={p.y}
                          r={r + 5}
                          fill="none"
                          stroke="var(--servari-teal)"
                          strokeWidth={1.4}
                          animate={{ opacity: [0.5, 0.05, 0.5], scale: [1, 1.14, 1] }}
                          transition={{
                            duration: 3.2,
                            repeat: Infinity,
                            ease: "easeInOut",
                            delay: entranceDelay(node) + 1,
                          }}
                          style={{ transformOrigin: `${p.x}px ${p.y}px`, transformBox: "fill-box" } as React.CSSProperties}
                        />
                      )}

                      {/* node body */}
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={r}
                        fill={node.isRoot ? `url(#${uid}-rootFill)` : "var(--servari-panel)"}
                        stroke={ringColor}
                        strokeWidth={node.isRoot ? 2.6 : isHover ? 2.2 : 1.6}
                        filter={isHover || node.isRoot ? `url(#${uid}-glow)` : undefined}
                        opacity={node.isRoot ? 1 : node.live ? 1 : 0.92}
                      />

                      {/* the root carries the raven mark */}
                      {node.isRoot ? (
                        <>
                          <clipPath id={`${uid}-clip`}>
                            <circle cx={p.x} cy={p.y} r={r - 4} />
                          </clipPath>
                          <image
                            href="/raven.png"
                            x={p.x - (r - 4)}
                            y={p.y - (r - 4)}
                            width={(r - 4) * 2}
                            height={(r - 4) * 2}
                            clipPath={`url(#${uid}-clip)`}
                            preserveAspectRatio="xMidYMid slice"
                            opacity={0.95}
                          />
                          <text
                            x={p.x}
                            y={p.y + r + 16}
                            textAnchor="middle"
                            fill="var(--servari-teal-soft)"
                            fontSize="11"
                            letterSpacing="2"
                            fontFamily="var(--font-mono)"
                          >
                            ORCHESTRATOR
                          </text>
                        </>
                      ) : (
                        <text
                          x={p.x}
                          y={p.y}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill={node.isHuman ? "var(--servari-amber)" : "var(--servari-ivory)"}
                          fontSize={node.level <= 2 ? 13 : 11}
                          fontFamily="var(--font-mono)"
                          style={{ pointerEvents: "none" }}
                        >
                          {node.label}
                        </text>
                      )}
                    </motion.g>
                  </motion.g>
                );
              })}
            </svg>

            {/* Hover tooltip card — absolutely positioned over the SVG via % */}
            <AnimatePresence>
              {hoveredNode && pos[hoveredNode.id] && (
                <motion.div
                  key={hoveredNode.id}
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.97 }}
                  transition={{ type: "spring", stiffness: 320, damping: 24 }}
                  className="pointer-events-none absolute z-30 w-64 p-4 rounded-xl"
                  style={{
                    left: `${(pos[hoveredNode.id].x / svgWidth) * 100}%`,
                    top: `${(pos[hoveredNode.id].y / svgHeight) * 100}%`,
                    transform: "translate(-50%, -118%)",
                    background: "rgba(18, 22, 30, 0.92)",
                    backdropFilter: "blur(24px)",
                    border: "1px solid rgba(20, 156, 150, 0.35)",
                    boxShadow: "0 18px 48px -12px rgba(0,0,0,0.7)",
                  }}
                >
                  <div
                    className="mb-1 flex items-center gap-2"
                    style={{
                      color: hoveredNode.isHuman
                        ? "var(--servari-amber)"
                        : "var(--servari-teal-soft)",
                      fontSize: "0.9375rem",
                      fontWeight: 500,
                    }}
                  >
                    {hoveredNode.fullName}
                    {hoveredNode.live && (
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: "var(--servari-green)" }}
                      />
                    )}
                  </div>
                  {hoveredNode.role && (
                    <div
                      style={{
                        color: "var(--servari-dimmed)",
                        fontSize: "0.78rem",
                        lineHeight: "1.45",
                      }}
                    >
                      {hoveredNode.role}
                    </div>
                  )}
                  <div
                    className="mt-2 pt-2 flex items-center justify-between"
                    style={{
                      borderTop: "1px solid rgba(250,248,243,0.08)",
                      fontSize: "0.72rem",
                    }}
                  >
                    <span style={{ color: "var(--servari-dimmed)" }}>
                      {hoveredNode.isHuman
                        ? "human"
                        : hoveredNode.live
                          ? `${hoveredNode.turns} turns`
                          : "standby"}
                    </span>
                    <span
                      style={{
                        color: hoveredNode.live
                          ? "var(--servari-green)"
                          : "var(--servari-dimmed)",
                      }}
                    >
                      {hoveredNode.live ? "live" : "idle"}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Comms-matrix slide-in panel */}
      <AnimatePresence>
        {showComms && comms.length > 0 && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="fixed inset-0 z-40"
              style={{ background: "rgba(8, 10, 14, 0.4)", backdropFilter: "blur(2px)" }}
              onClick={() => setShowComms(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 260, damping: 30 }}
              className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-sm p-6 overflow-y-auto"
              style={{
                background: "rgba(15, 18, 24, 0.96)",
                backdropFilter: "blur(28px)",
                borderLeft: "1px solid rgba(20, 156, 150, 0.22)",
                boxShadow: "-24px 0 60px -20px rgba(0,0,0,0.8)",
              }}
            >
              <div className="flex items-center justify-between mb-5">
                <div
                  style={{
                    color: "var(--servari-ivory)",
                    fontSize: "0.9375rem",
                    letterSpacing: "1px",
                    textTransform: "uppercase",
                  }}
                >
                  Communications Matrix
                </div>
                <button
                  onClick={() => setShowComms(false)}
                  className="p-1.5 rounded hover:bg-white/5 transition-colors"
                  style={{ color: "var(--servari-dimmed)" }}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-2">
                {comms.map((row, index) => (
                  <motion.div
                    key={row.agent}
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.08 + index * 0.035, type: "spring", stiffness: 260, damping: 24 }}
                    className="py-2.5 px-3 rounded-lg"
                    style={{
                      background: "rgba(20, 156, 150, 0.05)",
                      border: "1px solid rgba(20, 156, 150, 0.1)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    <div style={{ color: "var(--servari-teal)", marginBottom: "0.2rem" }}>
                      {row.agent}
                    </div>
                    <div style={{ color: "var(--servari-dimmed)", lineHeight: "1.4" }}>
                      {"-> "}
                      {row.talksTo.join(", ")}
                    </div>
                  </motion.div>
                ))}
              </div>

              {chainRule && (
                <div
                  className="mt-6 pt-4"
                  style={{ borderTop: "1px solid rgba(250, 248, 243, 0.1)" }}
                >
                  <div
                    className="mb-2"
                    style={{
                      color: "var(--servari-ivory)",
                      fontSize: "0.8125rem",
                      letterSpacing: "1px",
                      textTransform: "uppercase",
                    }}
                  >
                    Reporting Chain
                  </div>
                  <div
                    style={{
                      fontSize: "0.8125rem",
                      color: "var(--servari-dimmed)",
                      lineHeight: "1.5",
                    }}
                  >
                    {chainRule}
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

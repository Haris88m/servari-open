import { useEffect, useState } from "react";
import { motion } from "motion/react";
import * as Slider from "@radix-ui/react-slider";
import { API, type AutonomyResponse } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

interface Agent {
  id: string; // raw agent key — used as the setAutonomy() target, never rendered
  name: string; // sealed, human-readable display name (safe to render)
  currentLevel: number;
}

// One ladder entry per level. `label` (L0..L5) is structural chrome and stays
// static; `description` is overridden per render from the live backend
// definitions (definitions["0"].name etc.) when available — the static text is
// only the honest fallback when the autonomy module ships no definitions.
const STATIC_LEVELS = [
  { value: 0, label: "L0", description: "Suggest only" },
  { value: 1, label: "L1", description: "On approval" },
  { value: 2, label: "L2", description: "Act + report each" },
  { value: 3, label: "L3", description: "Act + report batch" },
  { value: 4, label: "L4", description: "Silent low-risk" },
  { value: 5, label: "L5", description: "Full auto" },
];

type LadderLevel = { value: number; label: string; description: string };

// Build the L0-L5 ladder, preferring the REAL backend level definitions
// (definitions is keyed by level string "0".."5", each { name, ... }). The
// keys carry no display vocabulary here, but the names pass the seal anyway as a
// fail-closed guard. Falls back to STATIC_LEVELS when a definition is absent.
function toLadder(d: AutonomyResponse): LadderLevel[] {
  const defs = d.definitions || {};
  return STATIC_LEVELS.map((lvl) => {
    const def = defs[String(lvl.value)];
    const rawName =
      def && typeof def.name === "string" && def.name.trim() ? def.name : "";
    const sealed = rawName ? sealLabel(rawName) : "";
    return { ...lvl, description: sealed || lvl.description };
  });
}

// Turn a raw agent key (e.g. "agent-1") into a sealed, human-readable display
// name. Prettify the key first (hyphens -> spaces, title-case) THEN pass the
// whole label through sealLabel so any internal code-name is mapped and any
// denied term is hidden. Falls back to the prettified key when the seal returns
// empty so a row never renders blank.
function sealedAgentName(key: string): string {
  const pretty = key
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return sealLabel(pretty) || pretty;
}

// Build the agent rows from the live autonomy surface: one row per seeded agent,
// sorted by key, level falling back to the backend default_level when an agent
// has no explicit level yet.
function toAgents(d: AutonomyResponse): Agent[] {
  const levelsMap = d.levels || {};
  const defRaw = d.default_level;
  const def =
    defRaw === undefined || defRaw === null ? 2 : parseInt(String(defRaw), 10) || 0;
  return Object.keys(levelsMap)
    .sort()
    .map((key) => {
      const raw = levelsMap[key];
      const lv = raw === undefined || raw === null ? def : parseInt(String(raw), 10);
      const clamped = Math.max(0, Math.min(5, Number.isNaN(lv) ? def : lv));
      return { id: key, name: sealedAgentName(key), currentLevel: clamped };
    });
}

export function AutonomyDials() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [ladder, setLadder] = useState<LadderLevel[]>(STATIC_LEVELS);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const d = await API.autonomy();
      if (d.error) {
        setError(d.error);
        setAgents([]);
        setLadder(STATIC_LEVELS);
      } else {
        setError(null);
        setAgents(toAgents(d));
        setLadder(toLadder(d));
      }
    } catch {
      setError("autonomy unavailable");
      setAgents([]);
      setLadder(STATIC_LEVELS);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleLevelChange = (agentId: string, newLevel: number) => {
    // Optimistic update so the dial moves with the drag, then persist + refetch
    // so the row reflects what the backend actually stored.
    setAgents((prev) =>
      prev.map((agent) =>
        agent.id === agentId ? { ...agent, currentLevel: newLevel } : agent
      )
    );
  };

  const handleLevelCommit = async (agentId: string, newLevel: number) => {
    try {
      await API.setAutonomy(agentId, newLevel);
    } catch {
      /* server degrades gracefully; refetch reconciles truth */
    }
    load();
  };

  const getWarningLevel = (level: number) => {
    if (level >= 5) return 'high';
    if (level >= 4) return 'medium';
    return 'none';
  };

  const getSliderColor = (level: number) => {
    if (level >= 5) return 'var(--servari-red)';
    if (level >= 4) return 'var(--servari-amber)';
    return 'var(--servari-teal)';
  };

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div
          className="mb-8"
          style={{
            color: 'var(--servari-ivory)',
            fontSize: '1.5rem',
            letterSpacing: '1px'
          }}
        >
          AUTONOMY DIALS
        </div>

        <div
          className="mb-6 p-4 rounded-xl"
          style={{
            background: 'rgba(20, 156, 150, 0.05)',
            border: '1px solid rgba(20, 156, 150, 0.2)',
            color: 'var(--servari-dimmed)',
            fontSize: '0.875rem',
            lineHeight: '1.6'
          }}
        >
          Control how much autonomy each agent has. Lower levels require more approval, higher levels operate independently. Use with caution.
        </div>

        {error ? (
          <div
            className="text-center py-20"
            style={{ color: 'var(--servari-dimmed)', fontSize: '0.9375rem' }}
          >
            {error}
          </div>
        ) : loaded && agents.length === 0 ? (
          <div
            className="text-center py-20"
            style={{ color: 'var(--servari-dimmed)', fontSize: '0.9375rem' }}
          >
            No agents seeded.
          </div>
        ) : (
        <div className="space-y-8">
          {agents.map((agent, index) => {
            const warning = getWarningLevel(agent.currentLevel);
            const currentLevelInfo = ladder[agent.currentLevel];

            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.1 }}
                className="p-6 rounded-xl"
                style={{
                  background: 'var(--servari-glass)',
                  backdropFilter: 'blur(24px)',
                  border: warning === 'high'
                    ? '1px solid rgba(248, 81, 73, 0.3)'
                    : warning === 'medium'
                    ? '1px solid rgba(224, 169, 42, 0.3)'
                    : '1px solid rgba(250, 248, 243, 0.08)',
                }}
              >
                {/* Agent name and current level */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <div
                      style={{
                        color: 'var(--servari-ivory)',
                        fontSize: '1.125rem',
                        fontWeight: 500,
                        marginBottom: '0.25rem'
                      }}
                    >
                      {agent.name}
                    </div>
                    <div
                      style={{
                        color: getSliderColor(agent.currentLevel),
                        fontSize: '0.8125rem'
                      }}
                    >
                      {currentLevelInfo.label}: {currentLevelInfo.description}
                    </div>
                  </div>

                  {warning !== 'none' && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="px-3 py-1 rounded-full text-xs"
                      style={{
                        background: warning === 'high'
                          ? 'rgba(248, 81, 73, 0.2)'
                          : 'rgba(224, 169, 42, 0.2)',
                        color: warning === 'high'
                          ? 'var(--servari-red)'
                          : 'var(--servari-amber)',
                        border: warning === 'high'
                          ? '1px solid var(--servari-red)'
                          : '1px solid var(--servari-amber)',
                      }}
                    >
                      {warning === 'high' ? 'High Autonomy' : 'Elevated'}
                    </motion.div>
                  )}
                </div>

                {/* Slider */}
                <Slider.Root
                  className="relative flex items-center select-none touch-none w-full h-5"
                  value={[agent.currentLevel]}
                  onValueChange={(value) => handleLevelChange(agent.id, value[0])}
                  onValueCommit={(value) => handleLevelCommit(agent.id, value[0])}
                  max={5}
                  step={1}
                >
                  <Slider.Track
                    className="relative grow rounded-full h-2"
                    style={{ background: 'rgba(250, 248, 243, 0.1)' }}
                  >
                    <Slider.Range
                      className="absolute h-full rounded-full"
                      style={{ background: getSliderColor(agent.currentLevel) }}
                    />
                  </Slider.Track>
                  <Slider.Thumb
                    className="block w-5 h-5 rounded-full focus:outline-none cursor-grab active:cursor-grabbing"
                    style={{
                      background: getSliderColor(agent.currentLevel),
                      boxShadow: `0 0 12px ${getSliderColor(agent.currentLevel)}`,
                    }}
                  />
                </Slider.Root>

                {/* Level labels */}
                <div className="flex justify-between mt-3">
                  {ladder.map((level) => (
                    <div
                      key={level.value}
                      className="text-center"
                      style={{
                        color: agent.currentLevel === level.value
                          ? getSliderColor(agent.currentLevel)
                          : 'var(--servari-dimmed)',
                        fontSize: '0.75rem',
                        opacity: agent.currentLevel === level.value ? 1 : 0.5,
                      }}
                    >
                      {level.label}
                    </div>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}

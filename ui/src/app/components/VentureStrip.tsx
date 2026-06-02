export interface ProjectDef {
  key: string;
  name: string;
  match: string[];
}

// Demo ventures — the public shell ships with a generic, illustrative set.
// `match` strings are the channel-key substrings that mark a venture "live"
// (a venture lights up when any active channel name contains one of them).
// Drive this from your own data (e.g. demo-data/ventures.json) to reflect a
// real portfolio.
export const PROJECTS: ProjectDef[] = [
  { key: "platform", name: "Platform", match: ["platform", "core", "shell"] },
  { key: "crm", name: "Demo CRM", match: ["crm", "sales", "lead", "business"] },
  { key: "studio", name: "Studio", match: ["studio", "design", "content"] },
  { key: "retail", name: "Retail", match: ["retail", "store", "pos"] },
  { key: "labs", name: "Labs", match: ["labs", "research"] },
];

export function projectActivity(
  channels: Record<string, { turns?: number; owes?: number; [k: string]: unknown }>,
  match: string[]
): boolean {
  for (const [name, summary] of Object.entries(channels)) {
    const lower = name.toLowerCase();
    if (match.some((m) => lower.includes(m))) {
      if (Number(summary?.turns) > 0 || Number(summary?.owes) > 0) return true;
    }
  }
  return false;
}

interface VentureStripProps {
  channels: Record<string, { turns?: number; owes?: number; [k: string]: unknown }>;
}

export function VentureStrip({ channels }: VentureStripProps) {
  return (
    <div
      className="flex items-stretch shrink-0"
      style={{
        height: 48,
        background: "var(--s-glass)",
        borderTop: "1px solid var(--s-edge-subtle)",
      }}
    >
      {PROJECTS.map((proj, i) => {
        const live = projectActivity(channels, proj.match);
        const dotColor = live ? "var(--s-status-ok)" : "var(--s-text-secondary)";
        const textColor = live ? "var(--s-text-teal)" : "var(--s-text-secondary)";
        const isLast = i === PROJECTS.length - 1;

        return (
          <div
            key={proj.key}
            className="flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            style={{
              flex: "1 1 0",
              borderRight: isLast ? "none" : "1px solid var(--s-edge-subtle)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = "var(--s-hover-bg)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
            }}
          >
            {/* Status dot */}
            <span
              className="rounded-full shrink-0"
              style={{
                width: 5,
                height: 5,
                background: dotColor,
                boxShadow: live ? "var(--s-glow-green)" : "none",
              }}
            />

            {/* Name */}
            <span
              style={{
                fontSize: "var(--t-12)",
                fontWeight: 600,
                color: textColor,
                letterSpacing: "0.01em",
              }}
            >
              {proj.name}
            </span>

            {/* LIVE badge */}
            {live && (
              <span
                style={{
                  fontSize: "var(--t-10)",
                  color: "var(--s-status-ok)",
                  border: "1px solid rgba(63,185,80,0.3)",
                  borderRadius: 4,
                  padding: "0 4px",
                  letterSpacing: "var(--ls-wide)",
                  lineHeight: "1.4",
                }}
              >
                LIVE
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

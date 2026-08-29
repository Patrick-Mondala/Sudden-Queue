import { useState, useEffect, useRef, useCallback } from "react";
import { Crosshair, Swords, Users, Trophy, User, MessageSquare, Send, X, Check, Shield, Star, Wifi, Timer, Copy, ChevronRight, LogOut, Bell, Filter, Plus, Minus, AlertTriangle, CircleDot, Lock, Unlock } from "lucide-react";
import { signIn } from "./api/auth.js";
import { api as server, bus as liveBus, getToken } from "./api/client.js";

/**
 * Pulls the window forward when a match is found.
 *
 * Loaded on demand rather than imported, so the app also runs in a plain
 * browser -- which matters when the Tauri shell cannot be launched at all,
 * as under Smart App Control. Everything else here is ordinary web code; this
 * was the only part that was not.
 */
async function demandAttention() {
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.unminimize().catch(() => {});
    await win.setFocus().catch(() => {});
    await win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  } catch {
    // Not in the desktop shell. A browser tab cannot demand focus, and the
    // accept prompt is on screen either way.
  }
}
import "./App.css";

/* ─────────────────────────────────────────────────────────────
   TOKENS
   ───────────────────────────────────────────────────────────── */
const T = {
  bg: "#0D1014", panel: "#151A21", raised: "#1C232C", line: "#29323D", line2: "#343E4B",
  text: "#E4E7EB", muted: "#7C8794", dim: "#4E5966",
  accent: "#2FC8BF", accentDim: "rgba(47,200,191,0.14)",
  captain: "#F2A93B", captainDim: "rgba(242,169,59,0.14)",
  danger: "#E05A4E", dangerDim: "rgba(224,90,78,0.14)",
  ok: "#5DBE7B",
  display: '"Bahnschrift", "Segoe UI Variable Display", "Segoe UI", "Inter", system-ui, sans-serif',
  body: '"Segoe UI Variable Text", "Segoe UI", "Inter", system-ui, sans-serif',
  mono: '"Cascadia Mono", "Consolas", ui-monospace, "SF Mono", Menlo, monospace',
};

const REGIONS = [
  { id: "na", label: "NA", name: "North America" },
  { id: "sa", label: "SA", name: "South America" },
  { id: "eu", label: "EU", name: "Europe" },
  { id: "asia", label: "ASIA", name: "Asia" },
];

/* letter ranks, percentile buckets, F- .. S+ (17 tiers) */
/**
 * Colour for a tier letter. Tolerates null, which is what an unplaced player
 * legitimately has — rank stays hidden until placements are done, and a crash
 * here takes the whole app down with it.
 */
/** Ladder order, lowest first. Mirrors TIERS in @suddenqueue/core. */
const TIER_ORDER = ["F-","F","F+","D-","D","D+","C-","C","C+","B-","B","B+","A-","A","A+","G-","G","G+","S-","S","S+"];
const tierColor = (t) => {
  if (!t) return "#4E5966";
  if (t.startsWith("S")) return "#F2A93B";
  if (t.startsWith("G")) return "#FF5C8A";
  if (t.startsWith("A")) return "#C77DFF";
  if (t.startsWith("B")) return "#2FC8BF";
  if (t.startsWith("C")) return "#5DBE7B";
  if (t.startsWith("D")) return "#9AA5B1";
  return "#7C8794";
};
/** Win percentage, or a dash when nobody has played yet. */
const winRate = (wins = 0, losses = 0) => {
  const total = wins + losses;
  return total === 0 ? "—" : `${Math.round((100 * wins) / total)}%`;
};

/* ─────────────────────────────────────────────────────────────
   ADAPTERS  (server payloads -> the shapes the screens render)
   ───────────────────────────────────────────────────────────── */
const AV_COLORS = ["#4C6EF5","#B23A48","#2A9D8F","#8E44AD","#D97706","#0EA5E9","#DC2626","#65A30D","#7C3AED","#DB2777"];

/** Stable colour pick for a server-issued id, so avatars do not change per render. */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
/**
 * Server match view -> the player shape the screens render.
 *
 * The server has no opinion about avatar colour, so it is derived from the id
 * here: same input, same colour, on every client and every render.
 *
 * Returns null for anything that is not a full match, because the roster
 * components index into team1/team2 unconditionally and a partial payload takes
 * the whole tree down rather than degrading.
 */
function adaptMatch(m) {
  if (!m || !Array.isArray(m.team1) || !Array.isArray(m.team2)) return null;
  if (m.team1.length === 0 || m.team2.length === 0) return null;

  const player = (p) => ({
    ...p,
    avatarColor: AV_COLORS[Math.abs(hashString(p.id)) % AV_COLORS.length],
  });

  return {
    id: m.id,
    type: m.type,
    region: m.region,
    state: m.state,
    captain1: m.captain1,
    captain2: m.captain2,
    team1Tier: m.team1Tier,
    team2Tier: m.team2Tier,
    team1: m.team1.map(player),
    team2: m.team2.map(player),
    acceptDeadline: m.acceptDeadline,
    partyUpDeadline: m.partyUpDeadline,
  };
}

/**
 * Server profile -> the player shape the screens render.
 *
 * No rating field: rank is the only strength the UI shows, so carrying the
 * number would just be inviting something to display it again.
 */
function profileToPlayer(profile) {
  return {
    id: profile.userId,
    discordName: profile.discordName,
    inGameName: profile.inGameName ?? profile.discordName,
    avatarColor: AV_COLORS[Math.abs(hashString(profile.userId)) % AV_COLORS.length],
    tier: profile.tier,
    isGameMaster: profile.isGameMaster ?? false,
    placementsRemaining: profile.placementsRemaining,
    // An absolute moment rather than a duration, so it keeps counting down
    // correctly across re-renders and reconnects.
    cooldownUntil: profile.queueCooldownSeconds
      ? Date.now() + profile.queueCooldownSeconds * 1000
      : 0,
    gamesPlayed: profile.gamesPlayed,
    wins: profile.wins,
    losses: profile.losses,
    disputes: 0,
    live: true,
  };
}


/* ─────────────────────────────────────────────────────────────
   PRIMITIVES
   ───────────────────────────────────────────────────────────── */
const css = `
  @keyframes sqPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  @keyframes sqRise { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
  @keyframes sqIn { from { opacity: 0; transform: scale(.98) } to { opacity: 1; transform: none } }
  @keyframes sqSweep { from { background-position: 0% 0 } to { background-position: 200% 0 } }
  @keyframes sqGlow { 0%,100% { box-shadow: 0 0 0 0 rgba(93,190,123,0.45) } 50% { box-shadow: 0 0 0 8px rgba(93,190,123,0) } }
  @keyframes sqSpotlight { 0%,100% { box-shadow: 0 0 0 0 rgba(47,200,191,0.55) } 50% { box-shadow: 0 0 0 10px rgba(47,200,191,0) } }
  .sq * { box-sizing: border-box; min-width: 0; }
  .sq ::-webkit-scrollbar { width: 8px; height: 8px }
  .sq ::-webkit-scrollbar-thumb { background: #29323D; border-radius: 4px }
  .sq button { font-family: inherit; cursor: pointer; }
  .sq button:disabled { cursor: not-allowed; opacity: .5 }
  .sq button:focus-visible, .sq input:focus-visible { outline: 2px solid ${T.accent}; outline-offset: 2px }
  .sq input { font-family: inherit }
  .sq .row-hover:hover { background: ${T.raised} }
  @media (prefers-reduced-motion: reduce) { .sq * { animation: none !important; transition: none !important } }
`;

const Eyebrow = ({ children, color = T.muted, style }) => (
  <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color, ...style }}>{children}</div>
);
const H = ({ children, size = 22, style }) => (
  <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: size, letterSpacing: "-0.01em", textTransform: "uppercase", lineHeight: 1.05, color: T.text, ...style }}>{children}</div>
);
const Panel = ({ children, style, pad = 16, ...rest }) => (
  <div {...rest} style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6, padding: pad, ...style }}>{children}</div>
);
const Btn = ({ children, kind = "ghost", size = "md", style, ...rest }) => {
  const base = { display: "inline-flex", alignItems: "center", gap: 8, border: `1px solid ${T.line2}`, borderRadius: 4, fontWeight: 600, fontSize: size === "sm" ? 12 : 13, padding: size === "sm" ? "6px 10px" : "9px 14px", background: T.raised, color: T.text, transition: "background .12s, border-color .12s", whiteSpace: "nowrap" };
  const kinds = {
    ghost: {},
    primary: { background: T.accent, borderColor: T.accent, color: "#07110F" },
    danger: { background: T.dangerDim, borderColor: T.danger, color: T.danger },
    captain: { background: T.captain, borderColor: T.captain, color: "#160E00" },
    quiet: { background: "transparent", borderColor: "transparent", color: T.muted },
  };
  return <button style={{ ...base, ...kinds[kind], ...style }} {...rest}>{children}</button>;
};
const Avatar = ({ p, size = 32, ring }) => (
  <div title={p?.discordName} style={{ width: size, height: size, borderRadius: "50%", background: p?.avatarColor || T.line, display: "grid", placeItems: "center", fontFamily: T.display, fontWeight: 700, fontSize: size * 0.42, color: "#fff", boxShadow: ring ? `0 0 0 2px ${T.bg}, 0 0 0 4px ${ring}` : "none", flexShrink: 0 }}>
    {(p?.discordName || "?")[0].toUpperCase()}
  </div>
);
/**
 * A player's name, with the GM prefix when they carry one.
 *
 * Every surface that shows a name goes through this rather than reading
 * discordName directly, so a Game Master is marked in the roster, the ladder,
 * a chat line and an invite alike -- and adding a surface later cannot quietly
 * miss it.
 */
const PlayerName = ({ name, isGameMaster, style, suffix }) => (
  <span style={{ whiteSpace: "nowrap", ...style }}>
    {isGameMaster && (
      <span style={{ fontFamily: T.display, fontWeight: 800, fontSize: "0.85em", letterSpacing: "0.04em", color: T.captain, marginRight: 5 }}>GM</span>
    )}
    {name}
    {suffix}
  </span>
);

/** Renders a rank.
 *
 * Rank is the only strength a player is ever shown -- the rating behind it is
 * deliberately not published -- so an unranked player needs to read as
 * "no rank yet", not as a missing value.
 */
const Tier = ({ tier, size = 12 }) => (
  <span style={{ fontFamily: T.display, fontWeight: 800, fontSize: size, color: tierColor(tier), letterSpacing: "0.02em", minWidth: size * 1.6, display: "inline-block", textAlign: "center" }}>{tier ?? "—"}</span>
);
/** Rank, or how many placement games are left before there is one. */
const Rank = ({ tier, placementsRemaining, size = 12 }) => {
  if (tier) return <Tier tier={tier} size={size} />;
  const left = placementsRemaining;
  return (
    <span style={{ fontFamily: T.mono, fontSize: size * 0.85, color: T.dim, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
      {typeof left === "number" && left > 0 ? `${left} to rank` : "unranked"}
    </span>
  );
};
const Tag = ({ children, color = T.muted, bg }) => (
  <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color, background: bg || "transparent", border: `1px solid ${bg ? "transparent" : T.line2}`, borderRadius: 3, padding: "2px 6px" }}>{children}</span>
);
const Dot = ({ color = T.accent, pulse }) => (
  <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", animation: pulse ? "sqPulse 1.6s infinite" : "none" }} />
);
const RegionPicker = ({ value, onChange, multi = true }) => (
  <div style={{ display: "flex", gap: 6 }}>
    {REGIONS.map((r) => {
      const on = multi ? value.includes(r.id) : value === r.id;
      return (
        <button key={r.id} onClick={() => multi ? onChange(on ? value.filter((v) => v !== r.id) : [...value, r.id]) : onChange(r.id)}
          title={r.name}
          style={{ fontFamily: T.mono, fontSize: 11.5, letterSpacing: "0.1em", padding: "6px 10px", borderRadius: 4, border: `1px solid ${on ? T.accent : T.line2}`, background: on ? T.accentDim : "transparent", color: on ? T.accent : T.muted }}>
          {r.label}
        </button>
      );
    })}
  </div>
);
/**
 * State that survives navigation and restarts.
 *
 * Screen-local useState resets whenever the screen unmounts, so region filters
 * silently reverted every time you switched tabs. These are preferences, not
 * view state, so they belong in storage.
 */
function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return initial;
      const parsed = JSON.parse(stored);
      // Guard against a stored shape that no longer matches, e.g. after a
      // region is renamed — fall back rather than rendering something broken.
      if (Array.isArray(initial) && !Array.isArray(parsed)) return initial;
      return parsed;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable; the preference just will not persist.
    }
  }, [key, value]);

  return [value, setValue];
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s % 60)).padStart(2, "0")}`;
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
const useTick = (active) => { const [, s] = useState(0); useEffect(() => { if (!active) return; const i = setInterval(() => s((n) => n + 1), 500); return () => clearInterval(i); }, [active]); };

/* ─────────────────────────────────────────────────────────────
   LOGIN
   ───────────────────────────────────────────────────────────── */
function Login({ onSignedIn }) {
  const [phase, setPhase] = useState("idle"); // idle | waiting
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const startDiscord = async () => {
    setError(null);
    setPhase("waiting");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await signIn({ signal: controller.signal });
      await onSignedIn();
    } catch (err) {
      setPhase("idle");
      setError(
        err?.code === "NETWORK"
          ? err.message
          : err?.code === "LOGIN_TIMEOUT"
          ? "Sign-in timed out. Try again."
          : err?.code === "BANNED"
          ? "This account is suspended."
          : err?.message || "Sign-in failed.",
      );
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase("idle");
  };

  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: `radial-gradient(1200px 600px at 50% -10%, rgba(47,200,191,0.08), transparent 60%), ${T.bg}` }}>
      <div style={{ width: 380, animation: "sqIn .3s ease" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <div style={{ width: 34, height: 34, borderRadius: 6, background: T.accent, display: "grid", placeItems: "center" }}><Crosshair size={20} color="#07110F" strokeWidth={2.5} /></div>
          <div>
            <H size={18}>Sudden Queue</H>
            <Eyebrow>Sudden Attack Zero Point · PUGs & scrims</Eyebrow>
          </div>
        </div>
        <Panel pad={20}>
          <Eyebrow style={{ marginBottom: 12 }}>Sign in</Eyebrow>

          {phase === "waiting" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 5, padding: "12px 14px", marginBottom: 12 }}>
                <Dot pulse />
                <div style={{ fontSize: 13, lineHeight: 1.45 }}>
                  <div style={{ fontWeight: 600 }}>Waiting for Discord…</div>
                  <div style={{ color: T.muted, fontSize: 12 }}>Finish signing in in your browser, then come back.</div>
                </div>
              </div>
              <Btn style={{ width: "100%", justifyContent: "center" }} onClick={cancel}>Cancel</Btn>
            </>
          ) : (
            <Btn
              kind="ghost"
              style={{ width: "100%", justifyContent: "center", marginBottom: 16, background: "#5865F2", borderColor: "#5865F2", color: "#fff" }}
              onClick={startDiscord}
            >
              Continue with Discord
            </Btn>
          )}

          {error && (
            <div style={{ background: T.dangerDim, border: `1px solid ${T.danger}`, borderRadius: 4, padding: "8px 10px", fontSize: 12.5, color: T.danger, marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.5 }}>Discord is the only sign-in. Your rank, record and match history follow the account.</div>
        </Panel>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   PUG QUEUE
   ───────────────────────────────────────────────────────────── */
function PlayScreen({ me, party, setParty, queue, setQueue, cooldownUntil, history, notify, onViewMatch, onView, onInvite }) {
  const [regions, setRegions] = usePersistentState("sq.pug.regions", ["na", "eu"]);
  useTick(queue.state === "queued" || cooldownUntil > Date.now());
  const elapsed = queue.state === "queued" ? Math.floor((Date.now() - queue.since) / 1000) : 0;
  const cooling = cooldownUntil > Date.now();
  const coolLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);

  // search radius: fast-widening ramp, plateaus at ~3 min. Same curve the backend will use.
  const radius = Math.round(Math.min(600, 60 + elapsed * 6));

  const start = async () => {
    if (!regions.length) return;

    // Only flip the UI once the server has actually accepted the ticket, so a
    // rejection cannot leave the screen claiming you are queued.
    try {
      await server.joinQueue(regions);
      setQueue({ state: "queued", since: Date.now(), regions });
    } catch (err) {
      notify(err?.message ?? "Could not join the queue");
    }
  };

  const stop = async () => {
    try {
      await server.leaveQueue();
    } catch (err) {
      notify(err?.message ?? "Could not leave the queue");
    }
    setQueue({ state: "idle" });
  };
  const kick = (id) => setParty(party.filter((p) => p.id !== id));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        {/* queue control */}
        <Panel pad={20} style={{ position: "relative", overflow: "hidden", borderColor: queue.state === "queued" ? T.accent : T.line }}>
          {queue.state === "queued" && <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, transparent, ${T.accentDim}, transparent)`, backgroundSize: "200% 100%", animation: "sqSweep 2.4s linear infinite", pointerEvents: "none" }} />}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>PUG · 5v5 · rated</Eyebrow>
              <H size={26}>{queue.state === "queued" ? "Searching" : cooling ? "On cooldown" : "Ready to queue"}</H>
              <div style={{ color: T.muted, fontSize: 13, marginTop: 6 }}>
                {queue.state === "queued"
                  ? <span>Search radius <span style={{ fontFamily: T.mono, color: T.text }}>±{radius}</span> · widens with time</span>
                  : cooling
                  ? <span>You left a match short. The queue reopens in <span style={{ fontFamily: T.mono, color: T.danger }}>{fmt(coolLeft)}</span></span>
                  : <span>Pick regions, then queue. Any region you select can pop first.</span>}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 34, fontWeight: 600, color: queue.state === "queued" ? T.accent : T.dim, lineHeight: 1 }}>{fmt(elapsed)}</div>
              <Eyebrow style={{ marginTop: 4 }}>{queue.state === "queued" ? "in queue" : "elapsed"}</Eyebrow>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20, position: "relative", gap: 12, flexWrap: "wrap" }}>
            <div><RegionPicker value={queue.state === "queued" ? queue.regions : regions} onChange={queue.state === "queued" ? () => {} : setRegions} /></div>
            {queue.state === "queued"
              ? <Btn kind="danger" onClick={stop}><X size={14} /> Leave queue</Btn>
              : <Btn kind="primary" onClick={start} disabled={cooling || !regions.length}><Crosshair size={14} /> Queue {party.length > 1 ? `as ${party.length}` : "solo"}</Btn>}
          </div>
        </Panel>

        {/* party */}
        <Panel>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Eyebrow>Party · {party.length}/5</Eyebrow>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn
                size="sm"
                onClick={onInvite}
                disabled={party.length >= 5 || queue.state === "queued"}
                title={queue.state === "queued" ? "Leave the queue to change your party" : undefined}
              >
                <Plus size={13} /> Invite
              </Btn>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
            {Array.from({ length: 5 }).map((_, i) => {
              const p = party[i];
              return (
                <div key={i} onClick={() => p && onView?.(p)} style={{ border: `1px dashed ${p ? T.line2 : T.line}`, borderStyle: p ? "solid" : "dashed", borderRadius: 5, padding: 10, minHeight: 92, background: p ? T.raised : "transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, position: "relative", cursor: p && onView ? "pointer" : "default" }}>
                  {p ? <>
                    <Avatar p={p} size={34} ring={i === 0 ? T.captain : null} />
                    <div style={{ fontSize: 12, fontWeight: 600, maxWidth: "100%", textAlign: "center", whiteSpace: "nowrap" }}><PlayerName name={p.discordName} isGameMaster={p.isGameMaster} /></div>
                    <Rank tier={p.tier} placementsRemaining={p.placementsRemaining} size={11} />
                    {i > 0 && queue.state !== "queued" && <button onClick={(e) => { e.stopPropagation(); kick(p.id); }} title="Remove" style={{ position: "absolute", top: 4, right: 4, background: "transparent", border: "none", color: T.dim, padding: 2 }}><X size={12} /></button>}
                    {i === 0 && <span style={{ position: "absolute", top: 4, left: 6 }}><Star size={11} color={T.captain} fill={T.captain} /></span>}
                  </> : <div style={{ color: T.dim, fontSize: 12, margin: "auto" }}>Open slot</div>}
                </div>
              );
            })}
          </div>
        </Panel>

        {/* recent matches */}
        <Panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>Recent matches</Eyebrow>
          <div style={{ overflow: "auto", flex: 1 }}>
            {history.map((m) => (
              <div key={m.id} className="row-hover" onClick={() => (m.team1 || m.openable) && onViewMatch(m)} style={{ display: "grid", gridTemplateColumns: "60px 60px 1fr 90px 60px", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 4, fontSize: 13, cursor: m.team1 || m.openable ? "pointer" : "default" }}>
                <Tag>{m.type}</Tag>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{m.region.toUpperCase()}</span>
                <span style={{ color: T.muted }}>{ago(m.ts)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: m.state === "in dispute" ? T.captain : m.state === "in progress" ? T.accent : T.muted }}>{m.state}</span>
                <span style={{ fontFamily: T.mono, fontWeight: 600, textAlign: "right", color: m.result === "win" ? T.ok : m.result === "loss" ? T.danger : T.muted }}>{m.result === "win" ? "W" : m.result === "loss" ? "L" : "—"}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* right column: me + how it works */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Panel>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Avatar p={me} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}><PlayerName name={me.discordName} isGameMaster={me.isGameMaster} /></div>
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{me.inGameName}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <Tier tier={me.tier} size={22} />
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{me.tier ? `Rank ${me.tier}` : me.placementsRemaining > 0 ? `${me.placementsRemaining} placement${me.placementsRemaining === 1 ? "" : "s"} left` : "Unranked"}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
            {[["Record", `${me.wins}–${me.losses}`], ["Win rate", winRate(me.wins, me.losses)], ["Disputes", me.disputes]].map(([k, v]) => (
              <div key={k} style={{ background: T.raised, borderRadius: 4, padding: "8px 10px" }}>
                <Eyebrow style={{ fontSize: 9.5 }}>{k}</Eyebrow>
                <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 600, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <Eyebrow style={{ marginBottom: 10 }}>How a PUG works</Eyebrow>
          {[
            ["Queue", "Solo or with a party of up to 5. Pick every region you're willing to play."],
            ["Accept", "When 10 players are found you get 20 seconds to accept. Missing it puts you on cooldown."],
            ["Party up", "The match screen shows both rosters. Add the highlighted captain in-game and join their party."],
            ["Queue together", "Both captains hit Casual queue on the same countdown. Empty queues mean you land in the same lobby."],
            ["Report", "Captains report the result. Disagreements go to dispute and are resolved by a mod."],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 8, padding: "7px 0", borderTop: `1px solid ${T.line}`, fontSize: 12.5 }}>
              <span style={{ fontWeight: 700 }}>{k}</span><span style={{ color: T.muted, lineHeight: 1.45 }}>{v}</span>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   PROFILE
   ───────────────────────────────────────────────────────────── */
/**
 * Scrims: teams looking for practice, and whoever is asking after yours.
 *
 * Everything here needs a team, so the screen says so rather than showing a
 * board you cannot act on.
 */
/** Refusals that are about the team rather than the request. */
const SCRIM_BLOCKERS = {
  CAPTAIN_OFFLINE: "Your captain is offline",
  NOT_ENOUGH_ONLINE: "Not enough of your team is online",
};

function ScrimsScreen({ notify }) {
  const [state, setState] = useState(null); // { listings, myListing, incoming }
  const [myTeam, setMyTeam] = useState(undefined); // undefined = still loading
  const [regions, setRegions] = usePersistentState("sq.scrims.filter", ["na", "sa", "eu", "asia"]);
  const [note, setNote] = useState("");
  const [postRegion, setPostRegion] = useState(["na"]);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null);

  const load = useCallback(async () => {
    try {
      const [board, mine] = await Promise.all([server.scrims(), server.myTeam()]);
      setState(board);
      setMyTeam(mine);
    } catch (err) {
      notify(err?.message ?? "Could not load scrims");
      setState({ listings: [], myListing: null, incoming: [] });
      setMyTeam({ team: null, role: null });
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  // A listing can be taken down, or answered, while you are looking at it.
  useEffect(() => {
    return liveBus.on((e) => {
      if (e.type?.startsWith("scrim.") || e.type?.startsWith("team.")) load();
    });
  }, [load]);

  const act = async (fn, after) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (after) notify(after);
    } catch (err) {
      // Why a team cannot scrim is worth stopping for; everything else is a
      // toast.
      const title = SCRIM_BLOCKERS[err?.code];
      if (title) setBlocked({ title, message: err.message });
      else notify(err?.message ?? "That did not work");
    } finally {
      setBusy(false);
    }
  };

  if (state === null || myTeam === undefined) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  if (!myTeam.team) {
    return (
      <ComingSoon
        eyebrow="Scrims"
        title="Scrims are for teams"
        body="Register a team or join one, and its captain and officers can list it here for practice matches — unrated, but the same accept and report flow as a PUG."
      />
    );
  }

  const canManage = myTeam.role === "captain" || myTeam.role === "officer";
  const roster = myTeam.team.members.length;
  const tooSmall = roster < 5;
  const listings = state.listings.filter((l) => regions.includes(l.region));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, height: "100%", minHeight: 0 }}>
      {blocked && (
        <AlertModal title={blocked.title} message={blocked.message} onClose={() => setBlocked(null)} />
      )}

      <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
          <Eyebrow style={{ flex: 1 }}>Teams looking to scrim</Eyebrow>
          <RegionPicker value={regions} onChange={setRegions} />
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
          {listings.length === 0 ? (
            <div style={{ color: T.dim, fontSize: 12.5, padding: 24, textAlign: "center", lineHeight: 1.5 }}>
              Nobody is listed in these regions. Put your own team up and wait for an ask.
            </div>
          ) : (
            listings.map((l) => (
              <div key={l.id} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 8px", borderRadius: 4 }}>
                <div style={{ width: 32, height: 32, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 10.5, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{l.tag}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>
                    {l.region.toUpperCase()} · {ago(Date.parse(l.postedAt))}{l.note ? ` · ${l.note}` : ""}
                  </div>
                </div>
                <Tier tier={l.tier} size={12} />
                {l.requested ? (
                  <Btn size="sm" disabled style={{ minWidth: 92, justifyContent: "center" }}><Dot pulse /> Asked</Btn>
                ) : (
                  <Btn
                    size="sm"
                    kind="primary"
                    disabled={busy || !canManage || tooSmall}
                    title={!canManage ? "Only the captain and officers arrange scrims" : tooSmall ? "You need five players" : undefined}
                    onClick={() => act(() => server.requestScrim(l.id), `Asked ${l.name} for a scrim`)}
                    style={{ minWidth: 92, justifyContent: "center" }}
                  >
                    Request
                  </Btn>
                )}
              </div>
            ))
          )}
        </div>
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel>
          <Eyebrow style={{ marginBottom: 10 }}>Your listing</Eyebrow>
          {!canManage ? (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
              Only the captain and officers can list {myTeam.team.name} for scrims.
            </div>
          ) : tooSmall ? (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
              A scrim is five a side. {myTeam.team.name} has {roster}.
            </div>
          ) : state.myListing ? (
            <>
              <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, marginBottom: 12 }}>
                Listed in {state.myListing.region.toUpperCase()}
                {state.myListing.note ? ` — ${state.myListing.note}` : ""}.
              </div>
              <Btn kind="danger" style={{ width: "100%", justifyContent: "center" }} disabled={busy} onClick={() => act(() => server.removeListing(), "Listing removed")}>
                Remove listing
              </Btn>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <RegionPicker value={postRegion} onChange={(v) => setPostRegion(v.slice(-1))} multi={false} />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 200))}
                placeholder="Note — format, times, voice"
                aria-label="Listing note"
                style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }}
              />
              <Btn
                kind="primary"
                style={{ width: "100%", justifyContent: "center" }}
                disabled={busy || postRegion.length === 0}
                onClick={() => act(async () => {
                  await server.postListing(postRegion[0], note.trim() || null);
                  setNote("");
                }, "Your team is listed")}
              >
                Post to scrim list
              </Btn>
            </div>
          )}
        </Panel>

        <Panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>
            Requests{state.incoming.length ? ` (${state.incoming.length})` : ""}
          </Eyebrow>
          <div style={{ flex: 1, overflow: "auto" }}>
            {!canManage ? (
              <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
                Captains and officers answer these.
              </div>
            ) : state.incoming.length === 0 ? (
              <div style={{ fontSize: 12.5, color: T.dim, lineHeight: 1.5 }}>
                Nobody has asked yet. Requests from other teams land here.
              </div>
            ) : (
              state.incoming.map((r) => (
                <div key={r.id} style={{ padding: "10px 0", borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 26, height: 26, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 9.5, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{r.tag}</div>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{r.name}</div>
                    <Tier tier={r.tier} size={11} />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Btn size="sm" kind="primary" style={{ flex: 1, justifyContent: "center" }} disabled={busy} onClick={() => act(() => server.decideScrimRequest(r.id, true))}>
                      Accept
                    </Btn>
                    <Btn size="sm" style={{ flex: 1, justifyContent: "center" }} disabled={busy} onClick={() => act(() => server.decideScrimRequest(r.id, false), "Request declined")}>
                      Decline
                    </Btn>
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ fontSize: 11.5, color: T.dim, lineHeight: 1.5, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.line}` }}>
            Accepting sends all ten players the same accept prompt as a PUG. Scrims never move
            your rank.
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * Teams: the one you are on, or the directory if you are not on one.
 *
 * A player has exactly one team, so this is two screens sharing a route rather
 * than one screen with a lot of conditionals -- which is also how it reads.
 */
function TeamsScreen({ me, notify, onView }) {
  const [state, setState] = useState(null); // { team, role, applications, myApplication }
  const [directory, setDirectory] = useState(null);
  const [regions, setRegions] = usePersistentState("sq.teams.filter", ["na", "sa", "eu", "asia"]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mine, list] = await Promise.all([server.myTeam(), server.listTeams()]);
      setState(mine);
      setDirectory(list.teams ?? []);
    } catch (err) {
      notify(err?.message ?? "Could not load teams");
      setState({ team: null, role: null, applications: [], myApplication: null });
      setDirectory([]);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  // The roster changes under you: someone is accepted, promoted, or the whole
  // thing is disbanded while you are looking at it.
  useEffect(() => {
    return liveBus.on((e) => {
      if (e.type?.startsWith("team.")) load();
    });
  }, [load]);

  /** Runs a team action, reloads, and reports whatever the server said. */
  const act = async (fn, after) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (after) notify(after);
    } catch (err) {
      notify(err?.message ?? "That did not work");
    } finally {
      setBusy(false);
    }
  };

  if (state === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  return state.team ? (
    <MyTeamPanel me={me} state={state} busy={busy} act={act} onView={onView} />
  ) : (
    <TeamDirectory
      teams={(directory ?? []).filter((t) => regions.includes(t.region))}
      regions={regions}
      setRegions={setRegions}
      myApplication={state.myApplication}
      busy={busy}
      act={act}
    />
  );
}

/** The roster you are on, with whatever powers your role carries. */
function MyTeamPanel({ me, state, busy, act, onView }) {
  const [tab, setTab] = useState("roster");
  const [confirmDisband, setConfirmDisband] = useState(false);
  const team = state.team;
  const isCaptain = state.role === "captain";
  const canManage = isCaptain || state.role === "officer";
  const starters = team.members.filter((m) => m.isStarter).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", minHeight: 0 }}>
      <Panel pad={20}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 6, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 13, color: T.text, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{team.tag}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <H size={22}>{team.name}</H>
            <Eyebrow>{team.region.toUpperCase()} · {team.members.length}/{10} players · {starters}/5 starting</Eyebrow>
          </div>
          {canManage && (
            <Btn size="sm" disabled={busy} onClick={() => act(() => server.setApplicationsOpen(!team.applicationsOpen))}>
              {team.applicationsOpen ? <Unlock size={13} color={T.ok} /> : <Lock size={13} color={T.danger} />}
              Applications {team.applicationsOpen ? "open" : "closed"}
            </Btn>
          )}
          {!isCaptain && (
            <Btn size="sm" disabled={busy} onClick={() => act(() => server.leaveTeam(), "You left the team")}>Leave</Btn>
          )}
          {isCaptain && !confirmDisband && (
            <Btn size="sm" kind="danger" disabled={busy} onClick={() => setConfirmDisband(true)}>Disband</Btn>
          )}
          {isCaptain && confirmDisband && (
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" kind="danger" disabled={busy} onClick={() => act(() => server.disbandTeam(), `${team.name} disbanded`)}>Confirm</Btn>
              <Btn size="sm" disabled={busy} onClick={() => setConfirmDisband(false)}>Cancel</Btn>
            </div>
          )}
        </div>
        {isCaptain && (
          <div style={{ fontSize: 11.5, color: T.dim, marginTop: 10 }}>
            A captain cannot simply leave. Hand the team to someone else first, or disband it.
          </div>
        )}
      </Panel>

      <Panel pad={0} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}` }}>
          {[["roster", "Roster"], ["applications", `Applications${state.applications.length ? ` (${state.applications.length})` : ""}`]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `2px solid ${tab === id ? T.accent : "transparent"}`, color: tab === id ? T.text : T.muted, padding: "11px 4px", fontSize: 12.5, fontWeight: 600 }}>{label}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
          {tab === "roster"
            ? team.members.map((m) => (
                <div key={m.userId} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px", borderRadius: 4 }}>
                  <div onClick={() => onView?.({ id: m.userId, discordName: m.discordName, inGameName: m.inGameName, tier: m.tier, placementsRemaining: m.placementsRemaining, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] })} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, cursor: "pointer" }}>
                    <Avatar p={{ discordName: m.discordName, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] }} size={30} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                        <PlayerName name={m.discordName} isGameMaster={m.isGameMaster} suffix={m.userId === me.id ? <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span> : null} />
                      </div>
                      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{m.inGameName ?? m.discordName}</div>
                    </div>
                  </div>
                  <Tag color={m.isStarter ? T.ok : T.dim}>{m.isStarter ? "Starter" : "Sub"}</Tag>
                  <Tag color={m.role === "captain" ? T.captain : m.role === "officer" ? T.accent : T.muted}>{m.role}</Tag>
                  <Rank tier={m.tier} placementsRemaining={m.placementsRemaining} size={11} />
                  {isCaptain && (
                    <button
                      title={m.isStarter ? "Move to the bench" : "Move into the starting five"}
                      disabled={busy}
                      onClick={() => act(() => server.setStarter(m.userId, !m.isStarter))}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: m.isStarter ? T.ok : T.dim, flexShrink: 0 }}
                    >
                      <CircleDot size={13} />
                    </button>
                  )}
                  {isCaptain && m.userId !== me.id && (
                    <button
                      title={m.role === "officer" ? "Demote to member" : "Make officer"}
                      disabled={busy}
                      onClick={() => act(() => server.setTeamRole(m.userId, m.role === "officer" ? "member" : "officer"))}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: m.role === "officer" ? T.accent : T.muted, flexShrink: 0 }}
                    >
                      <Shield size={13} />
                    </button>
                  )}
                  {isCaptain && m.userId !== me.id && (
                    <button
                      title="Hand over the team"
                      disabled={busy}
                      onClick={() => act(() => server.transferCaptaincy(m.userId), `${m.discordName} now captains ${team.name}`)}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: T.captain, flexShrink: 0 }}
                    >
                      <Star size={13} />
                    </button>
                  )}
                  {canManage && m.userId !== me.id && m.role !== "captain" && (
                    <button
                      title="Remove from team"
                      disabled={busy}
                      onClick={() => act(() => server.removeTeamMember(m.userId), `${m.discordName} removed`)}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.dangerDim, border: `1px solid ${T.danger}`, borderRadius: 4, color: T.danger, flexShrink: 0 }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))
            : !canManage ? (
              <div style={{ color: T.muted, fontSize: 12.5, padding: 20, textAlign: "center" }}>Only the captain and officers review applications.</div>
            ) : state.applications.length === 0 ? (
              <div style={{ color: T.dim, fontSize: 12.5, padding: 20, textAlign: "center", lineHeight: 1.5 }}>
                {team.applicationsOpen ? "Nobody has applied yet." : "Applications are closed."}
              </div>
            ) : (
              state.applications.map((a) => (
                <div key={a.id} style={{ padding: "10px 8px", borderRadius: 4, borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: a.note ? 8 : 0 }}>
                    <Avatar p={{ discordName: a.discordName, avatarColor: AV_COLORS[Math.abs(hashString(a.userId)) % AV_COLORS.length] }} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}><PlayerName name={a.discordName} isGameMaster={a.isGameMaster} /></div>
                      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{a.inGameName ?? a.discordName}</div>
                    </div>
                    <Rank tier={a.tier} placementsRemaining={a.placementsRemaining} size={11} />
                    <Btn size="sm" kind="primary" disabled={busy} onClick={() => act(() => server.decideApplication(a.id, true), `${a.discordName} joined ${team.name}`)}>Accept</Btn>
                    <Btn size="sm" disabled={busy} onClick={() => act(() => server.decideApplication(a.id, false), "Application denied")}>Deny</Btn>
                  </div>
                  {a.note && <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.45, paddingLeft: 38 }}>{a.note}</div>}
                </div>
              ))
            )}
        </div>
      </Panel>
    </div>
  );
}

/** No team yet: browse for one, or start your own. */
function TeamDirectory({ teams, regions, setRegions, myApplication, busy, act }) {
  const [creating, setCreating] = useState(false);
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [region, setRegion] = useState(["na"]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, height: "100%", minHeight: 0 }}>
      <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
          <Eyebrow style={{ flex: 1 }}>Teams</Eyebrow>
          <RegionPicker value={regions} onChange={setRegions} />
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
          {teams.length === 0 ? (
            <div style={{ color: T.dim, fontSize: 12.5, padding: 24, textAlign: "center", lineHeight: 1.5 }}>
              No teams in these regions yet. Register the first one.
            </div>
          ) : (
            teams.map((t) => (
              <div key={t.id} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 8px", borderRadius: 4 }}>
                <div style={{ width: 32, height: 32, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 10.5, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{t.tag}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>{t.region.toUpperCase()} · {t.memberCount} player{t.memberCount === 1 ? "" : "s"}</div>
                </div>
                <Tier tier={t.tier} size={12} />
                <Tag color={t.applicationsOpen ? T.ok : T.dim}>{t.applicationsOpen ? "Open" : "Closed"}</Tag>
                {myApplication?.teamId === t.id ? (
                  <Btn size="sm" disabled={busy} onClick={() => act(() => server.withdrawApplication(), "Application withdrawn")} style={{ minWidth: 88, justifyContent: "center" }}>
                    <Dot pulse /> Withdraw
                  </Btn>
                ) : (
                  <Btn
                    size="sm"
                    kind={t.applicationsOpen ? "primary" : "ghost"}
                    disabled={busy || !t.applicationsOpen || !!myApplication || t.memberCount >= 10}
                    title={myApplication ? "Withdraw your other application first" : undefined}
                    onClick={() => act(() => server.applyToTeam(t.id, null), `Applied to ${t.name}`)}
                    style={{ minWidth: 88, justifyContent: "center" }}
                  >
                    Apply
                  </Btn>
                )}
              </div>
            ))
          )}
        </div>
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel>
          <Eyebrow style={{ marginBottom: 10 }}>Start a team</Eyebrow>
          {!creating ? (
            <>
              <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, marginBottom: 12 }}>
                You become captain, and can appoint officers and review applications.
              </div>
              <Btn kind="primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => setCreating(true)}>
                <Plus size={13} /> Register a team
              </Btn>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase().slice(0, 4))} placeholder="Tag (max 4)" aria-label="Team tag" style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13, fontFamily: T.mono }} />
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} placeholder="Team name" aria-label="Team name" style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }} />
              <RegionPicker value={region} onChange={(v) => setRegion(v.slice(-1))} multi={false} />
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <Btn
                  kind="primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={busy || !tag.trim() || !name.trim() || region.length === 0}
                  onClick={() =>
                    act(async () => {
                      await server.createTeam({ tag: tag.trim(), name: name.trim(), region: region[0] });
                      setCreating(false);
                      setTag("");
                      setName("");
                    }, "Team registered")
                  }
                >
                  Register
                </Btn>
                <Btn onClick={() => setCreating(false)}>Cancel</Btn>
              </div>
            </div>
          )}
        </Panel>

        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>How teams work</Eyebrow>
          <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.55 }}>
            One team per player. Any number of officers. Captains and officers review applications
            and manage the roster. You can only have one application out at a time.
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** Shown where a real feature will go, instead of inventing data for it. */
function ComingSoon({ eyebrow, title, body }) {
  return (
    <Panel style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ marginBottom: 12 }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <H size={20}>{title}</H>
      </div>
      <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
        <div style={{ maxWidth: 420, textAlign: "center", color: T.muted, fontSize: 13, lineHeight: 1.6 }}>
          {body}
        </div>
      </div>
    </Panel>
  );
}

/** How many rungs a page of the ladder shows. */
const LADDER_PAGE = 50;

/**
 * The ladder: everyone who has finished placements, best first.
 *
 * Your own standing is shown whether or not it falls on the page you are
 * looking at, so being 300th does not mean paging down to find yourself.
 */
/**
 * The dispute queue. Game Masters only.
 *
 * A dispute means two captains claimed opposite results and no rating has
 * moved, so nothing here is being undone -- it is being decided for the first
 * time. That is why a ruling needs a note: the ten people it lands on deserve a
 * reason, and the next Game Master to look deserves to know what was seen.
 */
function DisputesScreen({ me, notify, onView }) {
  const [disputes, setDisputes] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [winner, setWinner] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDisputes(await server.disputes());
    } catch (err) {
      notify(err?.message ?? "Could not load disputes");
      setDisputes([]);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  // Opening one pulls the rosters, which the list deliberately does not carry.
  useEffect(() => {
    if (!openId) { setDetail(null); return undefined; }
    let cancelled = false;
    setDetail(null);

    server
      .getMatch(openId)
      .then((m) => { if (!cancelled) setDetail(adaptMatch(m)); })
      .catch((err) => { if (!cancelled) notify(err?.message ?? "Could not load that match"); });

    return () => { cancelled = true; };
  }, [openId, notify]);

  const open = disputes?.find((d) => d.matchId === openId) ?? null;

  const rule = async () => {
    if (!winner || note.trim().length === 0) return;
    setBusy(true);
    try {
      await server.resolveDispute(openId, winner, note.trim());
      notify(`Ruled for ${winner === "TEAM1" ? "Team 1" : "Team 2"}`);
      setOpenId(null);
      setWinner(null);
      setNote("");
      await load();
    } catch (err) {
      notify(err?.message ?? "Could not record that ruling");
    } finally {
      setBusy(false);
    }
  };

  if (disputes === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, height: "100%", minHeight: 0 }}>
      <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
          <Eyebrow>Open disputes</Eyebrow>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 4 }}>
            {disputes.length === 0 ? "Nothing waiting" : `${disputes.length} waiting`}
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
          {disputes.length === 0 ? (
            <div style={{ color: T.dim, fontSize: 12.5, padding: 20, textAlign: "center", lineHeight: 1.5 }}>
              No disputes. They arrive when two captains report different results.
            </div>
          ) : (
            disputes.map((d) => (
              <div
                key={d.disputeId}
                className="row-hover"
                onClick={() => { setOpenId(d.matchId); setWinner(null); setNote(""); }}
                style={{ padding: "10px 8px", borderRadius: 4, cursor: "pointer", background: d.matchId === openId ? T.raised : "transparent" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Tag>{d.type}</Tag>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{d.region.toUpperCase()}</span>
                  <span style={{ flex: 1, textAlign: "right", fontSize: 11, color: T.dim }}>{ago(Date.parse(d.openedAt))}</span>
                </div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 6, lineHeight: 1.4 }}>{d.reason}</div>
              </div>
            ))
          )}
        </div>
      </Panel>

      {!open ? (
        <Panel style={{ display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>
          Pick a dispute to see both claims.
        </Panel>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
          <Panel pad={20}>
            <Eyebrow style={{ marginBottom: 6 }}>{open.type} · {open.region.toUpperCase()} · played {ago(Date.parse(open.playedAt))}</Eyebrow>
            <H size={22}>Two captains disagree</H>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
              {[1, 2].map((team) => {
                const claim = open.reports.find((r) => r.reportingTeam === team);
                return (
                  <div key={team} style={{ background: T.raised, borderRadius: 5, padding: "10px 12px", border: `1px solid ${T.line2}` }}>
                    <Eyebrow style={{ fontSize: 9.5 }}>Team {team}&apos;s captain</Eyebrow>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{claim?.discordName ?? "never reported"}</div>
                    <div style={{ fontSize: 12, color: claim ? T.text : T.dim, marginTop: 4 }}>
                      {claim ? `claims Team ${claim.claimedWinner === "TEAM1" ? 1 : 2} won` : "no report"}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Nothing has moved yet: rating only applies on agreement, so this
                is the first ruling rather than an overturned one. */}
            <div style={{ fontSize: 11.5, color: T.dim, marginTop: 12, lineHeight: 1.5 }}>
              No rating has moved on this match. Your ruling is what applies it.
            </div>
          </Panel>

          {detail && (
            <Panel pad={20} style={{ flexShrink: 0, maxHeight: "40%", overflow: "auto" }}>
              <Roster team={detail.team1} captainId={detail.captain1} me={me} side={1} label="Team 1" phase="completed" onView={onView} tier={detail.team1Tier} />
              <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "18px 0" }}>
                <div style={{ flex: 1, height: 1, background: T.line }} />
                <span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 16, color: T.dim, letterSpacing: "0.1em" }}>VS</span>
                <div style={{ flex: 1, height: 1, background: T.line }} />
              </div>
              <Roster team={detail.team2} captainId={detail.captain2} me={me} side={2} label="Team 2" phase="completed" onView={onView} tier={detail.team2Tier} />
            </Panel>
          )}

          <Panel pad={20}>
            <Eyebrow style={{ marginBottom: 10 }}>Ruling</Eyebrow>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              {[["TEAM1", "Team 1 won"], ["TEAM2", "Team 2 won"]].map(([value, label]) => (
                <Btn
                  key={value}
                  kind={winner === value ? "primary" : "ghost"}
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={() => setWinner(value)}
                >
                  {label}
                </Btn>
              ))}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              placeholder="What decided it — screenshots, who admitted what, anything the next GM should know"
              aria-label="Ruling note"
              rows={3}
              style={{ width: "100%", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13, fontFamily: T.body, resize: "none", boxSizing: "border-box" }}
            />
            <Btn
              kind="primary"
              style={{ width: "100%", justifyContent: "center", marginTop: 10 }}
              disabled={busy || !winner || note.trim().length === 0}
              title={!winner ? "Pick a winner" : note.trim().length === 0 ? "A ruling needs a reason" : undefined}
              onClick={rule}
            >
              Settle this match
            </Btn>
          </Panel>
        </div>
      )}
    </div>
  );
}

function LadderScreen({ me, onView, notify }) {
  const [state, setState] = useState(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;

    server
      .ladder(LADDER_PAGE, offset)
      .then((res) => { if (!cancelled) setState(res); })
      .catch((err) => {
        if (cancelled) return;
        notify(err?.message ?? "Could not load the ladder");
        setState({ rows: [], total: 0, myPosition: null });
      });

    return () => { cancelled = true; };
  }, [offset, notify]);

  if (state === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  const pageEnd = offset + state.rows.length;

  return (
    <Panel pad={0} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
        <Eyebrow style={{ flex: 1 }}>Ladder</Eyebrow>
        <span style={{ fontSize: 11.5, color: T.muted }}>
          {state.total} placed player{state.total === 1 ? "" : "s"}
          {state.myPosition ? ` · you are #${state.myPosition}` : ""}
        </span>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {state.rows.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 12.5, padding: 24, textAlign: "center", lineHeight: 1.5 }}>
            Nobody has finished placements yet. Play five matches to appear here.
          </div>
        ) : (
          state.rows.map((r) => {
            const isMe = r.userId === me.id;
            return (
              <div
                key={r.userId}
                className="row-hover"
                onClick={() => onView?.({ id: r.userId })}
                style={{ display: "grid", gridTemplateColumns: "48px 1fr 64px 90px 44px", alignItems: "center", gap: 10, padding: "8px 16px", cursor: "pointer", background: isMe ? T.accentDim : "transparent" }}
              >
                <span style={{ fontFamily: T.mono, fontSize: 12, color: r.position <= 3 ? T.captain : T.muted }}>#{r.position}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <Avatar p={{ discordName: r.discordName, avatarColor: AV_COLORS[Math.abs(hashString(r.userId)) % AV_COLORS.length] }} size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                      <PlayerName name={r.discordName} isGameMaster={r.isGameMaster} suffix={isMe ? <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span> : null} />
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>
                      {r.inGameName ?? r.discordName}{r.teamTag ? ` · ${r.teamTag}` : ""}
                    </div>
                  </div>
                </div>
                <Tier tier={r.tier} size={13} />
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, textAlign: "right" }}>{r.wins}–{r.losses}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.dim, textAlign: "right" }}>{winRate(r.wins, r.losses)}</span>
              </div>
            );
          })
        )}
      </div>

      {state.total > LADDER_PAGE && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: `1px solid ${T.line}` }}>
          <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LADDER_PAGE))}>Previous</Btn>
          <span style={{ flex: 1, textAlign: "center", fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>
            {offset + 1}–{pageEnd} of {state.total}
          </span>
          <Btn size="sm" disabled={pageEnd >= state.total} onClick={() => setOffset(offset + LADDER_PAGE)}>Next</Btn>
        </div>
      )}
    </Panel>
  );
}

function ProfileScreen({ p, me, history, onBack, onViewMatch }) {
  const isMe = p.id === me.id;

  /**
   * Whatever we were handed, filled in from the server.
   *
   * A profile is reached from several places -- a roster, a chat name, a rung
   * of the ladder -- and each carries a different amount. Rather than render
   * the thinnest of them, the id is the only part that has to arrive and the
   * rest is fetched.
   */
  const [full, setFull] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setFull(null);

    server
      .playerProfile(p.id)
      .then((res) => { if (!cancelled) setFull(res); })
      .catch(() => {
        // Fall back to what we arrived with; it is thinner, not wrong.
      });

    return () => { cancelled = true; };
  }, [p.id]);

  const view = { ...p, ...(full ?? {}) };
  const total = (view.wins ?? 0) + (view.losses ?? 0);
  // Only your own history is loaded in this client; theirs is not published.
  const ownHistory = isMe ? history : [];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel pad={20}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Avatar p={view} size={64} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><H size={26}><PlayerName name={view.discordName ?? "Player"} isGameMaster={view.isGameMaster} /></H>{isMe && <Tag color={T.accent}>You</Tag>}</div>
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, marginTop: 4 }}>{view.inGameName ?? view.discordName} · Discord linked</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <Tier tier={view.tier} size={40} />
              {view.position && (
                <Eyebrow style={{ marginTop: 2 }}>#{view.position} on the ladder</Eyebrow>
              )}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginTop: 20 }}>
            {[["Rank", view.tier ?? (view.placementsRemaining > 0 ? `${view.placementsRemaining} to go` : "—")], ["Peak", view.peakTier ?? "—"], ["Matches", view.gamesPlayed ?? total], ["Record", `${view.wins ?? 0}–${view.losses ?? 0}`], ["Win rate", winRate(view.wins ?? 0, view.losses ?? 0)]].map(([k, v]) => (
              <div key={k} style={{ background: T.raised, borderRadius: 4, padding: "10px 12px" }}><Eyebrow style={{ fontSize: 9.5 }}>{k}</Eyebrow><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 600, marginTop: 4 }}>{v}</div></div>
            ))}
          </div>
        </Panel>
        <Panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>Match history</Eyebrow>
          {!isMe && (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
              Another player's match history isn't available yet.
            </div>
          )}
          <div style={{ overflow: "auto", flex: 1 }}>
            {ownHistory.map((m) => (
              <div key={m.id} className="row-hover" onClick={() => (m.team1 || m.openable) && onViewMatch(m)} style={{ display: "grid", gridTemplateColumns: "60px 60px 1fr 100px 60px", alignItems: "center", gap: 10, padding: "8px", borderRadius: 4, fontSize: 13, cursor: m.team1 || m.openable ? "pointer" : "default" }}>
                <Tag>{m.type}</Tag><span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{m.region.toUpperCase()}</span><span style={{ color: T.muted }}>{ago(m.ts)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: m.state === "in dispute" ? T.captain : m.state === "in progress" ? T.accent : T.muted }}>{m.state}</span>
                <span style={{ fontFamily: T.mono, fontWeight: 600, textAlign: "right", color: m.result === "win" ? T.ok : m.result === "loss" ? T.danger : T.muted }}>{m.result === "win" ? "W" : m.result === "loss" ? "L" : "—"}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>Reliability</Eyebrow>
          {full ? (
            [["Disputes", full.disputesInvolved, full.disputesInvolved ? T.captain : T.ok], ["Missed accepts", full.missedAccepts, full.missedAccepts ? T.captain : T.ok], ["Longest streak", full.longestWinStreak, T.muted]].map(([k, v, c]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderTop: `1px solid ${T.line}`, fontSize: 13 }}>
                <span style={{ color: T.muted }}>{k}</span>
                <span style={{ fontFamily: T.mono, color: c, fontWeight: 600 }}>{v}</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12.5, color: T.dim }}>Loading…</div>
          )}
        </Panel>
        {full?.team && (
          <Panel>
            <Eyebrow style={{ marginBottom: 6 }}>Team</Eyebrow>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 10, color: T.muted, border: `1px solid ${T.line2}` }}>{full.team.tag}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{full.team.name}</div>
                <div style={{ fontSize: 11, color: T.muted }}>{full.team.role}</div>
              </div>
            </div>
          </Panel>
        )}
        {!isMe && <Btn onClick={onBack} style={{ justifyContent: "center" }}>← Back</Btn>}
        <Panel><Eyebrow style={{ marginBottom: 6 }}>Public profile</Eyebrow><div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>This same record is visible on the public profile page. Only matchmaker data is shown — no in-game stats.</div></Panel>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   MATCH FLOW: accept overlay → match screen
   ───────────────────────────────────────────────────────────── */
function AcceptOverlay({ match, onAccepted, onFail }) {
  const ACCEPT_S = 20;
  const [left, setLeft] = useState(ACCEPT_S);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const [mine, setMine] = useState(false);
  const all = [...match.team1, ...match.team2];
  const done = useRef(false);

  // The server stamps the deadline at creation, so counting down to it keeps
  // the clock honest even if the event took a moment to arrive.
  const endsAt = useRef(
    match.acceptDeadline ? Date.parse(match.acceptDeadline) : Date.now() + ACCEPT_S * 1000,
  );

  useEffect(() => {
    const tick = () => setLeft(Math.ceil((endsAt.current - Date.now()) / 1000));
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, []);

  /**
   * The server is the authority on who has accepted and on whether the match
   * survives, so progress is pushed rather than guessed.
   */
  useEffect(() => {
    return liveBus.on((e) => {
      if (e.matchId && e.matchId !== match.id) return;
      if (e.type === "match.accept.progress") setAcceptedCount(e.accepted);
      // PARTY_UP means all ten are in; that is the real "everyone accepted".
      if (e.type === "match.state" && e.state === "PARTY_UP" && !done.current) {
        done.current = true;
        setAcceptedCount(all.length);
        onAccepted();
      }
    });
    // Resubscribing whenever the parent re-renders would drop events between
    // teardown and setup, so this keeps the socket handler for the life of the
    // overlay. onAccepted closes over the match this was mounted for, which is
    // the only one it can ever be asked about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id]);

  // Nothing happens when the clock runs out: the server owns what a missed
  // accept costs and pushes match.cancelled.
  const count = Math.max(acceptedCount, mine ? 1 : 0);
  const pct = left / ACCEPT_S;
  const R = 54, C = 2 * Math.PI * R;
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 50, animation: "sqIn .2s ease" }}>
      <div style={{ width: 520, textAlign: "center" }}>
        <Eyebrow color={T.accent} style={{ marginBottom: 8 }}>{match.type} · {match.region.toUpperCase()} · 5v5</Eyebrow>
        <H size={34}>Match found</H>
        <div style={{ position: "relative", width: 140, height: 140, margin: "24px auto" }}>
          <svg width="140" height="140" viewBox="0 0 140 140" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="70" cy="70" r={R} stroke={T.line2} strokeWidth="6" fill="none" />
            <circle cx="70" cy="70" r={R} stroke={left <= 5 ? T.danger : T.accent} strokeWidth="6" fill="none" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s linear, stroke .3s" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <div><div style={{ fontFamily: T.mono, fontSize: 40, fontWeight: 600, lineHeight: 1, color: left <= 5 ? T.danger : T.text }}>{Math.max(0, left)}</div><Eyebrow style={{ marginTop: 4 }}>seconds</Eyebrow></div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 20 }}>
          {/* The server reports how many accepted, not which, so these fill in order. */}
          {all.map((p, i) => <div key={p.id} style={{ width: 34, height: 6, borderRadius: 3, background: i < count ? T.accent : T.line2, transition: "background .25s" }} />)}
        </div>
        <div style={{ color: T.muted, fontSize: 13, marginBottom: 18 }}><span style={{ fontFamily: T.mono, color: T.text }}>{count}/{all.length}</span> accepted</div>
        {!mine ? (
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Btn kind="primary" style={{ padding: "12px 34px", fontSize: 15 }} onClick={async () => { setMine(true); try { await server.accept(match.id); } catch { setMine(false); } }}><Check size={16} strokeWidth={3} /> Accept</Btn>
            <Btn kind="ghost" style={{ padding: "12px 20px" }} onClick={async () => { try { await server.decline(match.id); } catch { /* the sweeper cancels it regardless */ } done.current = true; onFail(); }}>Decline</Btn>
          </div>
        ) : <div style={{ color: T.accent, fontSize: 13, display: "inline-flex", gap: 8, alignItems: "center" }}><Dot pulse /> Waiting for others…</div>}
        <div style={{ marginTop: 18, fontSize: 12, color: T.dim }}>Not accepting in time puts you on a queue cooldown. Everyone else goes back to the front of the queue.</div>
      </div>
    </div>
  );
}

function Roster({ team, captainId, me, side, label, phase, onView, tier }) {
  const isMySide = team.some((x) => x.id === me.id); // copy-name only makes sense for YOUR captain
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <Eyebrow color={side === 1 ? T.accent : T.muted}>{label}</Eyebrow>
        {tier && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>avg {tier}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
        {team.map((p) => {
          const cap = p.id === captainId; const isMe = p.id === me.id;
          return (
            <div key={p.id} onClick={() => onView?.(p)} style={{ background: cap ? T.captainDim : T.raised, border: `1px solid ${cap ? T.captain : isMe ? T.accent : T.line}`, borderRadius: 6, padding: "12px 8px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, position: "relative", animation: "sqRise .35s ease both", cursor: onView ? "pointer" : "default" }}>
              {cap && <div style={{ position: "absolute", top: -9, left: "50%", transform: "translateX(-50%)", background: T.captain, color: "#160E00", fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.1em", padding: "2px 7px", borderRadius: 3, fontWeight: 700 }}>CAPTAIN</div>}
              <Avatar p={p} size={40} ring={cap ? T.captain : isMe ? T.accent : null} />
              <div style={{ fontFamily: T.mono, fontSize: 11.5, fontWeight: 600, letterSpacing: "0.02em", textAlign: "center", maxWidth: "100%", whiteSpace: "nowrap" }}>{p.inGameName}</div>
              <div style={{ fontSize: 11, color: T.muted, textAlign: "center", maxWidth: "100%" }}><PlayerName name={p.discordName} isGameMaster={p.isGameMaster} suffix={isMe ? " (you)" : ""} /></div>
              <Rank tier={p.tier} placementsRemaining={p.placementsRemaining} size={11} />
              {cap && phase === "party" && isMySide && !isMe && <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(p.inGameName); }} title="Copy your captain's in-game name" style={{ marginTop: 2, background: "transparent", border: `1px solid ${T.captain}`, color: T.captain, borderRadius: 3, fontSize: 10.5, padding: "3px 8px", display: "inline-flex", gap: 4, alignItems: "center", fontFamily: T.mono }}><Copy size={10} /> copy name</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchHistoryModal({ m, me, onClose, onView }) {
  const onTeam1 = m.team1.some((p) => p.id === me.id);
  const resultLabel = m.result === "win" ? "Victory" : m.result === "loss" ? "Defeat" : m.state === "in dispute" ? "In dispute" : "Match";
  const resultColor = m.result === "win" ? T.ok : m.result === "loss" ? T.danger : T.captain;
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 70, animation: "sqIn .2s ease" }} onClick={onClose}>
      <div style={{ width: 640, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <Panel pad={20}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>{m.type} · {m.region.toUpperCase()} · {ago(m.ts)} · match {m.id.slice(-5)}</Eyebrow>
              <H size={24} style={{ color: resultColor }}>{resultLabel}</H>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={18} /></button>
          </div>
          <Roster team={m.team1} captainId={m.captain1} me={me} side={1} label={onTeam1 ? "Your team" : "Team 1"} phase="completed" onView={onView} tier={m.team1Tier} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "22px 0" }}><div style={{ flex: 1, height: 1, background: T.line }} /><span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 18, color: T.dim, letterSpacing: "0.1em" }}>VS</span><div style={{ flex: 1, height: 1, background: T.line }} /></div>
          <Roster team={m.team2} captainId={m.captain2} me={me} side={2} label={onTeam1 ? "Opponents" : "Your team"} phase="completed" onView={onView} tier={m.team2Tier} />
        </Panel>
      </div>
    </div>
  );
}

/**
 * Match chat: your five, or all ten.
 *
 * Two channels rather than one with a filter, because the server decides who
 * hears a message and cannot un-send one posted to the wrong tab.
 */
/** Matches the server's buffer, so scrollback does not grow without bound. */
const CHAT_KEPT = 100;

/**
 * One chat channel: its backlog, its live messages, and how to add to it.
 *
 * Sending goes over the socket rather than a POST per line. Nothing is echoed
 * locally -- a message appears when the server sends it back, so what you see
 * is what everyone else saw, and a refusal is simply nothing appearing plus
 * the notice the server sends.
 */
function useChannel(channel) {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    if (!channel) return undefined;
    let cancelled = false;
    setMessages([]);

    server
      .chatHistory(channel)
      .then((res) => { if (!cancelled) setMessages(res.messages ?? []); })
      .catch(() => {
        // Not a channel we may read, or the server is down. An empty panel is
        // the honest state for both.
      });

    const off = liveBus.on((e) => {
      if (e.type !== "chat.message" || e.channel !== channel) return;
      setMessages((all) => [...all, e.message].slice(-CHAT_KEPT));
    });

    return () => { cancelled = true; off(); };
  }, [channel]);

  const send = useCallback(
    (text) => {
      const trimmed = text.trim();
      if (!channel || !trimmed) return;
      liveBus.send({ type: "chat.send", channel, text: trimmed });
    },
    [channel],
  );

  return { messages, send };
}

/** The messages themselves, shared by both panels. */
function ChatLog({ messages, me, empty, onView }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);

  if (messages.length === 0) {
    return (
      <div style={{ margin: "auto", color: T.dim, fontSize: 12.5, textAlign: "center", padding: 16, lineHeight: 1.5 }}>
        {empty}
      </div>
    );
  }

  return (
    <>
      {messages.map((m) => {
        const mine = m.userId === me.id;
        const who = { discordName: m.discordName, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] };
        return (
          <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", animation: "sqRise .2s ease" }}>
            <div onClick={() => onView?.({ id: m.userId })} style={{ cursor: onView ? "pointer" : "default", flexShrink: 0 }}>
              <Avatar p={who} size={22} />
            </div>
            <div style={{ minWidth: 0 }}>
              <span onClick={() => onView?.({ id: m.userId })} style={{ fontSize: 12, fontWeight: 700, color: mine ? T.accent : T.text, cursor: onView ? "pointer" : "default" }}><PlayerName name={m.discordName} isGameMaster={m.isGameMaster} /></span>{" "}
              <span style={{ fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.4, wordBreak: "break-word" }}>{m.text}</div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </>
  );
}

/** A one-line composer. */
function ChatComposer({ onSend, placeholder }) {
  const [text, setText] = useState("");

  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };

  return (
    <div style={{ padding: 8, borderTop: `1px solid ${T.line}`, display: "flex", gap: 6 }}>
      <input
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }}
      />
      <Btn size="sm" kind="primary" onClick={submit} disabled={!text.trim()}><Send size={13} /></Btn>
    </div>
  );
}

function MatchChat({ match, me, onView }) {
  const [tab, setTab] = useState("team");
  const myTeam = match.team1.some((p) => p.id === me.id) ? 1 : 2;
  const channel = tab === "team" ? `match:${match.id}:t${myTeam}` : `match:${match.id}`;
  const { messages, send } = useChannel(channel);

  return (
    <Panel pad={0} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 220 }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}` }}>
        {[["team", "Team"], ["match", "Match"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `2px solid ${tab === id ? T.accent : "transparent"}`, color: tab === id ? T.text : T.muted, padding: "10px 4px", fontSize: 12, fontWeight: 600 }}>{label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <ChatLog
          messages={messages}
          me={me}
          onView={onView}
          empty={tab === "team" ? "Nothing said yet. Only your five can read this." : "Nothing said yet. All ten can read this."}
        />
      </div>
      <ChatComposer onSend={send} placeholder={tab === "team" ? "Message your team…" : "Message the match…"} />
      <div style={{ padding: "4px 10px 8px", fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>chat is not saved</div>
    </Panel>
  );
}

function MatchScreen({ match, me, onFinished, notify, onView }) {
  const PARTY_S = 120;
  const [phase, setPhase] = useState("party"); // party → queue → live → reported → completed | dispute
  const [left, setLeft] = useState(PARTY_S);
  const [rankMove, setRankMove] = useState(null); // { tierBefore, tierAfter, placementsRemaining }
  const [myReport, setMyReport] = useState(null);
  const [theirReport, setTheirReport] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const myTeamIsOne = match.team1.some((p) => p.id === me.id);
  const myCapId = myTeamIsOne ? match.captain1 : match.captain2; // YOUR team's captain — never the opponent's
  const iAmCaptain = myCapId === me.id;
  const cap = [...match.team1, ...match.team2].find((p) => p.id === myCapId);

  // The server stamped the party-up deadline; counting down to it keeps this
  // clock and the server's sweeper talking about the same moment.
  const partyEndsAt = useRef(
    match.partyUpDeadline ? Date.parse(match.partyUpDeadline) : Date.now() + PARTY_S * 1000,
  );

  useEffect(() => {
    if (phase !== "party") return;
    const tick = () => setLeft(Math.ceil((partyEndsAt.current - Date.now()) / 1000));
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [phase]);

  /**
   * Re-reads the match on entry.
   *
   * The object we arrive with was captured when the match was found, before
   * anyone accepted -- so its party-up deadline is still null and its state is
   * stale. Asking once here also recovers the right phase for anyone who
   * reloaded mid-match.
   */
  useEffect(() => {
    let cancelled = false;

    server
      .getMatch(match.id)
      .then((fresh) => {
        if (cancelled || !fresh) return;
        if (fresh.partyUpDeadline) partyEndsAt.current = Date.parse(fresh.partyUpDeadline);
        if (fresh.state === "LIVE") setPhase("live");
        if (fresh.state === "DISPUTED") setPhase("dispute");
        if (fresh.state === "COMPLETED") {
          const iWon =
            (fresh.result === "TEAM1" && myTeamIsOne) || (fresh.result === "TEAM2" && !myTeamIsOne);
          setOutcome(iWon ? "win" : "loss");
          setPhase("completed");
        }
      })
      .catch(() => {
        // Not fatal: the push events still drive the screen, and the fallback
        // deadline is within a second or two of the real one.
      });

    return () => { cancelled = true; };
    // myTeamIsOne is derived from this match and cannot change while mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id]);

  /**
   * On a live match the server owns every transition: the sweeper decides when
   * party-up becomes LIVE, and the second captain's report is a real person
   * arriving whenever they arrive. Nothing here may guess at either.
   */
  useEffect(() => {
    return liveBus.on((e) => {
      if (e.matchId !== match.id) return;
      if (e.type === "match.state") {
        if (e.state === "LIVE") setPhase("live");
        if (e.state === "DISPUTED") setPhase("dispute");
        // REPORTED only means the first captain is in; the reporter is already
        // showing "waiting", and the other side has nothing to wait for yet.
      }
      if (e.type === "match.resolved") {
        const iWon =
          (e.result === "TEAM1" && myTeamIsOne) || (e.result === "TEAM2" && !myTeamIsOne);
        setRankMove({
          tierBefore: e.tierBefore ?? null,
          tierAfter: e.tierAfter ?? null,
          placementsRemaining: e.placementsRemaining ?? 0,
        });
        setOutcome(iWon ? "win" : "loss");
        setTheirReport(iWon ? "loss" : "win");
        setPhase("completed");
      }
    });
  }, [match.id, myTeamIsOne]);

  const report = async (r) => {
    // The server speaks in sides, not in who is asking.
    const winner = (r === "win") === myTeamIsOne ? "TEAM1" : "TEAM2";
    setMyReport(r);
    setPhase("reported");
    try {
      await server.reportResult(match.id, winner);
    } catch (err) {
      setMyReport(null);
      setPhase("live");
      notify(err?.message ?? "Could not send that report");
    }
  };

  /**
   * What the result did to your rank.
   *
   * Most matches move a rating without crossing a threshold, and saying
   * "rank unchanged" is the honest version of that -- the alternative is
   * quoting the points that moved, which is the thing we do not publish.
   */
  const rankSummary = (() => {
    if (!rankMove) return "Both captains agree. Your rank has been updated.";
    const { tierBefore, tierAfter, placementsRemaining } = rankMove;
    if (!tierAfter) {
      return placementsRemaining > 0
        ? `Both captains agree. ${placementsRemaining} placement match${placementsRemaining === 1 ? "" : "es"} to go before you are ranked.`
        : "Both captains agree.";
    }
    if (!tierBefore) return `Both captains agree. Placements complete — you are ${tierAfter}.`;
    if (tierBefore === tierAfter) return `Both captains agree. You are still ${tierAfter}.`;
    return `Both captains agree. ${TIER_ORDER.indexOf(tierAfter) > TIER_ORDER.indexOf(tierBefore) ? "Promoted" : "Demoted"} to ${tierAfter}.`;
  })();

  const banner = {
    party: { color: T.captain, title: "Party up", sub: iAmCaptain ? "You're the captain — your teammates add you in-game and join your party. Queue starts in" : `Add ${cap?.inGameName ?? "your captain"} — your captain — in-game and join their party. Queue starts in` },
    queue: { color: T.accent, title: "Queue casual now", sub: "Both captains hit Casual queue on this signal. Stay in party." },
    live: { color: T.accent, title: "Match in progress", sub: iAmCaptain ? "When it ends, report the result below." : "Your captain reports the result when the match ends." },
    reported: { color: T.muted, title: "Waiting for the other captain", sub: `You reported a ${myReport}. Awaiting the other side's report.` },
    completed: { color: T.ok, title: outcome === "win" ? "Victory" : "Defeat", sub: match.type === "SCRIM" ? "Both captains agree. Scrims are unrated — no rank change." : rankSummary },
    dispute: { color: T.captain, title: "In dispute", sub: "Captains reported different results. A mod will resolve this with both teams — this stays open until then." },
  }[phase];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", animation: "sqIn .25s ease" }}>
      <Panel pad={20} style={{ borderColor: banner.color, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: banner.color }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20 }}>
          <div>
            <Eyebrow style={{ marginBottom: 6 }}>{match.type} · {match.region.toUpperCase()} · match {match.id.slice(-5)}</Eyebrow>
            <H size={28} style={{ color: banner.color }}>{banner.title}</H>
            <div style={{ color: T.muted, fontSize: 13, marginTop: 6 }}>{banner.sub}{phase === "party" && <span style={{ fontFamily: T.mono, color: T.text }}> {fmt(Math.max(0, left))}</span>}</div>
          </div>
          {phase === "party" && <div style={{ fontFamily: T.mono, fontSize: 44, fontWeight: 600, color: T.captain, lineHeight: 1 }}>{fmt(Math.max(0, left))}</div>}
          {phase === "queue" && <div style={{ fontFamily: T.display, fontWeight: 800, fontSize: 30, color: T.accent, textTransform: "uppercase", animation: "sqPulse 1s infinite" }}>Queue</div>}
          {phase === "live" && !iAmCaptain && <Tag>Captain reports</Tag>}
          {phase === "reported" && <Dot pulse color={T.muted} />}
          {(phase === "completed" || phase === "dispute") && <Btn kind="primary" onClick={() => onFinished({ outcome, disputed: phase === "dispute" })}>Back to lobby <ChevronRight size={14} /></Btn>}
        </div>
        {phase === "live" && iAmCaptain && (
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <button onClick={() => report("win")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: T.ok, color: "#07110F", border: "none", borderRadius: 6, padding: "16px 20px", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", animation: "sqGlow 1.8s ease-in-out infinite" }}><Trophy size={20} /> We won</button>
            <button onClick={() => report("loss")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: T.dangerDim, color: T.danger, border: `2px solid ${T.danger}`, borderRadius: 6, padding: "16px 20px", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em" }}>We lost</button>
          </div>
        )}
      </Panel>

      <Panel pad={20} style={{ flexShrink: 0, maxHeight: "60%", overflow: "auto" }}>
        <Roster team={match.team1} captainId={match.captain1} me={me} side={1} label={myTeamIsOne ? "Your team" : "Team 1"} phase={phase} onView={onView} tier={match.team1Tier} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "22px 0" }}><div style={{ flex: 1, height: 1, background: T.line }} /><span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 18, color: T.dim, letterSpacing: "0.1em" }}>VS</span><div style={{ flex: 1, height: 1, background: T.line }} /></div>
        <Roster team={match.team2} captainId={match.captain2} me={me} side={2} label={myTeamIsOne ? "Opponents" : "Your team"} phase={phase} onView={onView} tier={match.team2Tier} />
        {(phase === "reported" || phase === "completed" || phase === "dispute") && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 20 }}>
            {[["Your captain reported", myReport], ["Their captain reported", theirReport]].map(([k, v]) => (
              <div key={k} style={{ background: T.raised, borderRadius: 4, padding: "10px 12px", display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 12.5, color: T.muted }}>{k}</span><span style={{ fontFamily: T.mono, fontWeight: 600, color: !v ? T.dim : v === "win" ? T.ok : T.danger }}>{v ? v.toUpperCase() : "…"}</span></div>
            ))}
          </div>
        )}
      </Panel>
      <MatchChat match={match} me={me} onView={onView} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   CHAT DOCK  (ephemeral — nothing persists)
   ───────────────────────────────────────────────────────────── */
/**
 * Party chat, in a dock that stays out of the way.
 */
/**
 * Who's online, and an Invite next to each.
 *
 * The list is fetched once and filtered here as you type. It is bounded by who
 * is actually connected, so a request per keystroke to re-filter something
 * already in hand would cost more than it saves.
 *
 * Players who cannot be invited are shown anyway, greyed with the reason.
 * Hiding them reads as "they're offline" when they are sitting in someone
 * else's party.
 */
/** How many invites are shown at once before the rest are counted instead. */
const INVITE_STACK_LIMIT = 3;

/**
 * A refusal that deserves reading.
 *
 * Most failures here are toasts, which is right for something you can shrug
 * at. This is for the ones that explain why an action you meant to take will
 * not happen -- a toast slides away while you are still looking at the button
 * you pressed, and leaves you pressing it again.
 */
function AlertModal({ title, message, onClose }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 74, animation: "sqIn .2s ease" }} onClick={onClose}>
      <div role="alertdialog" aria-label={title} style={{ width: 380, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <Panel pad={20}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.dangerDim, border: `1px solid ${T.danger}`, display: "grid", placeItems: "center", flexShrink: 0 }}>
              <AlertTriangle size={15} color={T.danger} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <H size={19}>{title}</H>
              <div style={{ fontSize: 13, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>{message}</div>
            </div>
          </div>
          <Btn kind="primary" style={{ width: "100%", justifyContent: "center", marginTop: 18 }} onClick={onClose}>
            Got it
          </Btn>
        </Panel>
      </div>
    </div>
  );
}

/**
 * Who plays this scrim.
 *
 * Only reached by a captain whose roster runs deeper than five -- a team of
 * exactly five is never asked, because there is nothing to choose. Starters are
 * preselected, and that is a default rather than a rule: any five of the roster
 * will do.
 *
 * Blocking on purpose, unlike an invite toast. Ten people are waiting on this
 * answer and the window is thirty seconds.
 */
function LineupModal({ pending, notify, onDone }) {
  const [picked, setPicked] = useState(() =>
    pending.roster.filter((r) => r.isStarter).map((r) => r.userId),
  );
  const [busy, setBusy] = useState(false);
  useTick(true);

  const left = Math.max(0, Math.ceil((Date.parse(pending.confirmDeadline) - Date.now()) / 1000));
  const full = picked.length === 5;

  const toggle = (userId) =>
    setPicked((all) =>
      all.includes(userId)
        ? all.filter((id) => id !== userId)
        : all.length >= 5
          ? all
          : [...all, userId],
    );

  const confirm = async () => {
    if (!full) return;
    setBusy(true);
    try {
      await server.confirmLineup(pending.requestId, picked);
      onDone();
    } catch (err) {
      notify(err?.message ?? "Could not confirm that lineup");
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 72, animation: "sqIn .2s ease" }}>
      <div role="dialog" aria-modal="true" aria-label="Confirm your lineup" style={{ width: 460, maxWidth: "90vw" }}>
        <Panel pad={20}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Eyebrow style={{ marginBottom: 6 }}>Scrim vs {pending.opponentTag}</Eyebrow>
              <H size={22}>Who is playing?</H>
              <div style={{ fontSize: 12.5, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
                Five of {pending.roster.length}. Your starters are picked already — change them if
                you like.
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 30, fontWeight: 600, lineHeight: 1, color: left <= 10 ? T.danger : T.accent }}>{left}</div>
              <Eyebrow style={{ marginTop: 2 }}>seconds</Eyebrow>
            </div>
          </div>

          <div style={{ maxHeight: "42vh", overflow: "auto", marginBottom: 14 }}>
            {pending.roster.map((r) => {
              const on = picked.includes(r.userId);
              const blocked = !on && picked.length >= 5;
              return (
                <button
                  key={r.userId}
                  onClick={() => toggle(r.userId)}
                  disabled={blocked || busy}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginBottom: 4, borderRadius: 5, textAlign: "left", background: on ? T.accentDim : T.raised, border: `1px solid ${on ? T.accent : T.line}`, color: T.text, opacity: blocked ? 0.45 : 1 }}
                >
                  <div style={{ width: 16, height: 16, borderRadius: 3, border: `1px solid ${on ? T.accent : T.line2}`, background: on ? T.accent : "transparent", display: "grid", placeItems: "center", flexShrink: 0 }}>
                    {on && <Check size={11} strokeWidth={3} color="#07110F" />}
                  </div>
                  <Avatar p={{ discordName: r.discordName, avatarColor: AV_COLORS[Math.abs(hashString(r.userId)) % AV_COLORS.length] }} size={26} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      <PlayerName name={r.discordName} isGameMaster={r.isGameMaster} />
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{r.inGameName ?? r.discordName}</div>
                  </div>
                  {r.isStarter && <Tag color={T.ok}>Starter</Tag>}
                  <Rank tier={r.tier} placementsRemaining={r.placementsRemaining} size={11} />
                </button>
              );
            })}
          </div>

          <Btn
            kind="primary"
            style={{ width: "100%", justifyContent: "center" }}
            disabled={!full || busy}
            title={full ? undefined : `Pick ${5 - picked.length} more`}
            onClick={confirm}
          >
            {full ? "Confirm these five" : `${picked.length}/5 picked`}
          </Btn>
          <div style={{ fontSize: 11.5, color: T.dim, marginTop: 10, lineHeight: 1.5 }}>
            Both captains confirm before anyone is asked to accept. If the clock runs out the scrim
            is dropped — nobody is penalised.
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * Incoming party invites.
 *
 * Several can be open at once -- being invited by four people the moment you
 * come online is ordinary -- so this is a stack rather than one banner, oldest
 * first, with the overflow counted rather than hidden silently.
 *
 * Non-blocking on purpose: the container ignores pointer events and only the
 * cards themselves take clicks, so an invite arriving mid-queue cannot swallow
 * a click meant for the app underneath.
 */
function InviteToasts({ invites, onAccept, onDecline }) {
  useTick(invites.length > 0); // drives the expiry countdown

  if (invites.length === 0) return null;
  const shown = invites.slice(0, INVITE_STACK_LIMIT);
  const hidden = invites.length - shown.length;

  return (
    <div style={{ position: "absolute", top: 54, right: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 65, pointerEvents: "none", width: 280 }}>
      {shown.map((inv) => {
        const left = Math.max(0, Math.ceil((Date.parse(inv.expiresAt) - Date.now()) / 1000));
        return (
          <div key={inv.inviteId} style={{ pointerEvents: "auto", background: T.panel, border: `1px solid ${T.line2}`, borderLeft: `3px solid ${T.captain}`, borderRadius: 5, padding: "10px 12px", boxShadow: "0 10px 30px rgba(0,0,0,.45)", animation: "sqRise .2s ease" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Avatar p={{ discordName: inv.fromName, avatarColor: AV_COLORS[Math.abs(hashString(inv.fromUserId)) % AV_COLORS.length] }} size={24} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}><PlayerName name={inv.fromName} isGameMaster={inv.fromIsGameMaster} /></div>
                <div style={{ fontSize: 11, color: T.muted }}>invited you to their party</div>
              </div>
              <Tier tier={inv.fromTier} size={12} />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Btn size="sm" kind="primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => onAccept(inv)}>Join</Btn>
              <Btn size="sm" style={{ justifyContent: "center" }} onClick={() => onDecline(inv)}>Decline</Btn>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: left <= 5 ? T.danger : T.dim, minWidth: 24, textAlign: "right" }}>{left}s</span>
            </div>
          </div>
        );
      })}
      {hidden > 0 && (
        <div style={{ pointerEvents: "none", background: T.raised, border: `1px solid ${T.line}`, borderRadius: 4, padding: "6px 10px", fontSize: 11.5, color: T.muted, textAlign: "center" }}>
          +{hidden} more invite{hidden === 1 ? "" : "s"} waiting
        </div>
      )}
    </div>
  );
}

function InviteModal({ party, onClose, notify }) {
  const [players, setPlayers] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [sent, setSent] = useState({}); // userId -> epoch ms when invitable again
  const [busy, setBusy] = useState(null);
  useTick(true); // keeps the per-player cooldowns counting down

  const load = useCallback(async () => {
    try {
      const res = await server.onlinePlayers();
      setPlayers(res.players ?? []);
      setError(null);
    } catch (err) {
      setError(err?.message ?? "Could not load the player list");
      setPlayers([]);
    }
  }, []);

  useEffect(() => {
    load();
    // People come and go while the modal is open; a slow poll keeps it honest
    // without turning the list into a flicker.
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const partyIds = new Set(party.map((p) => p.id));
  const partyFull = party.length >= 5;

  const matches = (players ?? []).filter((p) => {
    if (partyIds.has(p.id)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      p.discordName.toLowerCase().includes(q) || (p.inGameName ?? "").toLowerCase().includes(q)
    );
  });

  const invite = async (p) => {
    setBusy(p.id);
    try {
      await server.invite(p.id);
      // Mirror the server's cooldown so the button explains itself rather than
      // waiting to be refused.
      setSent((s) => ({ ...s, [p.id]: Date.now() + 60000 }));
      notify(`Invited ${p.discordName}`);
    } catch (err) {
      if (err?.status === 429) {
        const seconds = Number(/(\d+)s/.exec(err.message ?? "")?.[1] ?? 60);
        setSent((s) => ({ ...s, [p.id]: Date.now() + seconds * 1000 }));
      }
      notify(err?.message ?? "Could not send that invite");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 70, animation: "sqIn .2s ease" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Invite to party" style={{ width: 520, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Eyebrow>Invite to party</Eyebrow>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>
                {party.length}/5 in your party
                {partyFull ? " — full" : ""}
              </div>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={18} /></button>
          </div>

          <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.line}` }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search players…"
              aria-label="Search players"
              style={{ width: "100%", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }}
            />
          </div>

          <div style={{ flex: 1, overflow: "auto", minHeight: 120, maxHeight: "48vh", padding: 8 }}>
            {players === null ? (
              <div style={{ margin: "auto", color: T.dim, fontSize: 12.5, textAlign: "center", padding: 24 }}>Loading…</div>
            ) : error ? (
              <div style={{ color: T.danger, fontSize: 12.5, textAlign: "center", padding: 24 }}>{error}</div>
            ) : matches.length === 0 ? (
              <div style={{ color: T.dim, fontSize: 12.5, textAlign: "center", padding: 24, lineHeight: 1.5 }}>
                {query.trim() ? `Nobody online matches “${query.trim()}”.` : "Nobody else is online right now."}
              </div>
            ) : (
              matches.map((p) => {
                const until = sent[p.id] ?? 0;
                const cooling = until > Date.now();
                const left = Math.ceil((until - Date.now()) / 1000);
                const blocked = p.unavailable || partyFull;

                return (
                  <div key={p.id} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 4, opacity: p.unavailable ? 0.55 : 1 }}>
                    <Avatar p={{ ...p, avatarColor: AV_COLORS[Math.abs(hashString(p.id)) % AV_COLORS.length] }} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}><PlayerName name={p.discordName} isGameMaster={p.isGameMaster} /></div>
                      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{p.inGameName}</div>
                    </div>
                    <Rank tier={p.tier} placementsRemaining={p.placementsRemaining} size={11} />
                    {p.unavailable ? (
                      <span style={{ fontSize: 11, color: T.dim, minWidth: 74, textAlign: "right" }}>{p.unavailable}</span>
                    ) : (
                      <Btn
                        size="sm"
                        kind={cooling ? "ghost" : "primary"}
                        disabled={blocked || cooling || busy === p.id}
                        onClick={() => invite(p)}
                        style={{ minWidth: 74, justifyContent: "center" }}
                      >
                        {cooling ? `${left}s` : busy === p.id ? "…" : "Invite"}
                      </Btn>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ChatDock({ me, partyId, open, setOpen, onView }) {
  const { messages, send } = useChannel(partyId ? `party:${partyId}` : null);
  const [seen, setSeen] = useState(0);

  // The count only means anything while the dock is shut, which is the whole
  // reason it is a dock rather than a panel.
  useEffect(() => { if (open) setSeen(messages.length); }, [open, messages.length]);
  const unread = open ? 0 : Math.max(0, messages.length - seen);

  if (!open)
    return (
      <button onClick={() => setOpen(true)} style={{ position: "absolute", right: 16, bottom: 16, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 6, padding: "8px 12px", color: T.text, display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 600 }}>
        <MessageSquare size={14} /> Chat
        {unread > 0 && <span style={{ background: T.accent, color: "#07110F", borderRadius: 10, fontSize: 10.5, padding: "1px 6px", fontFamily: T.mono }}>{unread}</span>}
      </button>
    );

  return (
    <div style={{ position: "absolute", right: 16, bottom: 16, width: 300, height: 380, background: T.panel, border: `1px solid ${T.line2}`, borderRadius: 8, boxShadow: "0 16px 40px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", zIndex: 55, animation: "sqRise .2s ease", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}`, padding: "10px 12px" }}>
        <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.text }}>Party chat</div>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <ChatLog messages={messages} me={me} onView={onView} empty="Nothing said yet. Only your party can read this." />
      </div>
      <ChatComposer onSend={send} placeholder="Message your party…" />
      <div style={{ padding: "4px 10px 8px", fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>chat is not saved</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   APP SHELL
   ───────────────────────────────────────────────────────────── */
export default function App() {
  const [me, setMe] = useState(null);
  const [nav, setNav] = useState("play");
  const [pop, setPop] = useState({ online: 0, inQueue: 0, inMatch: 0 });
  const [party, setParty] = useState([]);
  const [queue, setQueue] = useState({ state: "idle" });
  const [pendingMatch, setPendingMatch] = useState(null);
  const [match, setMatch] = useState(null);
  const [history, setHistory] = useState([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [viewProfile, setViewProfile] = useState(null);
  const [viewMatch, setViewMatch] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [invites, setInvites] = useState([]);
  // Chat needs the id, not the roster: a channel is named after the party.
  const [partyId, setPartyId] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  // A scrim waiting on this captain's five. Held here rather than on the
  // scrims screen, because it has to interrupt wherever they happen to be.
  const [pendingLineup, setPendingLineup] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const notify = useCallback((text) => { const id = Date.now() + Math.random(); setToasts((t) => [...t, { id, text }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800); }, []);

  /**
   * Loads match history.
   *
   * Called on sign-in and again whenever a match closes, so the row you just
   * played is the server's record of it rather than a local guess at what it
   * wrote.
   */
  /**
   * Drops an invite from the stack.
   *
   * Used on accept, decline and expiry alike -- there is nothing different to
   * do in each case beyond what the caller already did.
   */
  const dismissInvite = useCallback((inviteId) => {
    setInvites((list) => list.filter((i) => i.inviteId !== inviteId));
  }, []);

  const acceptInvite = useCallback(async (inv) => {
    try {
      await server.acceptInvite(inv.inviteId);
      // Joining someone settles every other invite: they were all offers to be
      // in a party, and now you are in one.
      setInvites([]);
      notify(`Joined ${inv.fromName}'s party`);
    } catch (err) {
      dismissInvite(inv.inviteId);
      notify(err?.message ?? "That invite is no longer valid");
    }
  }, [dismissInvite, notify]);

  const declineInvite = useCallback(async (inv) => {
    dismissInvite(inv.inviteId);
    try {
      await server.declineInvite(inv.inviteId);
    } catch {
      // Already gone or expired; it is off the screen either way.
    }
  }, [dismissInvite]);

  // Expired invites disappear on their own, so a stack left alone drains
  // rather than filling up with dead cards.
  useEffect(() => {
    if (invites.length === 0) return;
    const iv = setInterval(() => {
      setInvites((list) => list.filter((i) => Date.parse(i.expiresAt) > Date.now()));
    }, 1000);
    return () => clearInterval(iv);
  }, [invites.length]);

  const refreshLineup = useCallback(async () => {
    try {
      const board = await server.scrims();
      setPendingLineup(board.pendingLineup ?? null);
    } catch {
      // Not fatal: the next event or poll picks it up.
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const rows = await server.history();
      setHistory(
        rows.map((r) => ({
          id: r.matchId,
          ts: new Date(r.resolvedAt ?? r.createdAt).getTime(),
          region: r.region,
          type: r.type,
          result: r.result === null ? "—" : (r.result === "TEAM1") === (r.team === 1) ? "win" : "loss",
          state: r.state === "DISPUTED" ? "in dispute" : "completed",
          // Rosters are fetched when a row is opened rather than shipped with
          // every row; this flag is what makes the row clickable without them.
          openable: true,
        })),
      );
    } catch {
      // History is not essential to signing in; an empty list is honest.
    }
  }, []);


  /**
   * Re-reads the profile after a match resolves.
   *
   * Rank, record and the placement countdown all move at that moment, and the
   * lobby would otherwise keep showing the pre-match ones until a restart.
   */
  const refreshProfile = useCallback(async () => {
    try {
      const profile = await server.me();
      setMe((prev) => (prev?.live ? { ...prev, ...profileToPlayer(profile) } : prev));
    } catch {
      // Cosmetic refresh; the next one will pick it up.
    }
  }, []);

  /**
   * Opens a match from a history row.
   *
   * The list endpoint returns results, not rosters -- ten players per row for
   * twenty-five rows is a lot of payload for something most rows never show --
   * so a live row fetches its own when clicked. Only the rosters are taken from
   * the fetch: the row already phrases the result from our own side, and the
   * match record states it as a winning team.
   */
  const openMatch = useCallback(async (m) => {
    if (m.team1) { setViewMatch(m); return; }

    try {
      const full = adaptMatch(await server.getMatch(m.id));
      if (!full) { notify("Couldn't load that match"); return; }
      setViewMatch({
        ...m,
        team1: full.team1,
        team2: full.team2,
        captain1: full.captain1,
        captain2: full.captain2,
        team1Tier: full.team1Tier,
        team2Tier: full.team2Tier,
      });
    } catch (err) {
      notify(err?.message ?? "Couldn't load that match");
    }
  }, [notify]);


  const adoptServerSession = useCallback(async () => {
    const profile = await server.me();

    const mapped = profileToPlayer(profile);
    setMe(mapped);
    setCooldownUntil(mapped.cooldownUntil);

    setPartyId(profile.party?.partyId ?? null);
    setParty(
      (profile.party?.members ?? []).map((m) => ({
        id: m.userId,
        discordName: m.discordName,
        inGameName: m.inGameName ?? m.discordName,
        avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length],
        isGameMaster: m.isGameMaster ?? false,
        tier: m.tier ?? null,
        placementsRemaining: m.placementsRemaining ?? 0,
        wins: 0,
        losses: 0,
      })),
    );

    // Anything sent while we were still connecting is waiting on the server.
    try {
      setInvites(await server.getInvites());
    } catch {
      // Not worth blocking sign-in; the socket carries the next one.
    }

    await refreshHistory();
    await refreshLineup();
    setChatOpen(false);
  }, [refreshHistory, refreshLineup]);


  useEffect(() => { if (me) setParty([me]); }, [me]);
  useEffect(() => {
    if (!me) return;
    const f = async () => {
      try {
        const stats = await server.queueStats();
        setPop({ online: stats.online, inQueue: stats.inQueue, inMatch: stats.inMatch ?? 0 });
      } catch {
        // Server unreachable; leave the last known counts rather than showing
        // zeroes that look like an empty playerbase.
      }
    };
    f();
    const iv = setInterval(f, 8000);
    return () => clearInterval(iv);
  }, [me]);
  /** Server events that the whole shell reacts to, rather than one screen. */
  useEffect(() => {
    if (!me) return;

    const off = liveBus.on((e) => {
      switch (e.type) {
        case "match.found": {
          const found = adaptMatch(e.match);
          // A roster we cannot draw is worse than no match screen: rendering
          // one blanks the app. Surface it instead of taking the UI down.
          if (!found) {
            notify("Match found, but its details could not be loaded");
            break;
          }
          setQueue({ state: "idle" });
          setPendingMatch(found);
          break;
        }
        case "queue.left":
          setQueue({ state: "idle" });
          if (e.reason === "CONNECTION_LOST") notify("Connection dropped — you left the queue");
          break;
        case "match.cancelled": {
          setPendingMatch(null);
          setQueue({ state: "idle" });
          if (!e.atFault) {
            notify("A player didn't accept — the match was cancelled");
            break;
          }
          // The server owns the penalty and states it; this only displays it.
          const seconds = e.cooldownSeconds ?? 0;
          if (seconds > 0) setCooldownUntil(Date.now() + seconds * 1000);
          notify(
            seconds > 0
              ? `You left a match short — queue locked for ${fmt(seconds)}`
              : "You left a match short",
          );
          break;
        }
        case "match.resolved":
          notify(
            e.tierAfter && e.tierBefore && e.tierAfter !== e.tierBefore
              ? `Match complete · now ${e.tierAfter}`
              : "Match complete",
          );
          // Rank, record and placement count all just moved.
          void refreshProfile();
          break;
        case "party.invite.received":
          // Guard against a duplicate arriving over a reconnect.
          setInvites((list) =>
            list.some((i) => i.inviteId === e.invite.inviteId) ? list : [...list, e.invite],
          );
          break;
        case "party.updated":
          setPartyId(e.party?.partyId ?? null);
          setParty(
            (e.party?.members ?? []).map((m) => ({
              id: m.userId,
              discordName: m.discordName,
              inGameName: m.inGameName ?? m.discordName,
              avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length],
              tier: m.tier ?? null,
              placementsRemaining: m.placementsRemaining ?? 0,
              wins: 0,
              losses: 0,
            })),
          );
          break;
        case "party.invite.declined":
          dismissInvite(e.inviteId);
          break;
        case "scrim.lineup.required":
          void refreshLineup();
          break;
        case "scrim.lineup.expired":
          setPendingLineup(null);
          notify("The scrim was dropped — nobody confirmed a lineup");
          break;
        case "notification":
          notify(e.text);
          break;
        case "auth.expired":
          notify("Session expired — sign in again");
          setMe(null);
          break;
        default:
          break;
      }
    });

    liveBus.connect();
    return () => {
      off();
      liveBus.disconnect();
    };
  }, [me, notify, refreshProfile, dismissInvite, refreshLineup]);

  // Restore an existing session on launch rather than making the user sign in
  // again every time the app opens. Deliberately mount-only: re-running it when
  // `me` changes would re-adopt the session on every sign-in.
  useEffect(() => {
    if (me || !getToken()) return;
    let cancelled = false;

    server
      .me()
      .then(() => {
        if (!cancelled) void adoptServerSession();
      })
      .catch(() => {
        // Token is stale or the server is down; the login screen handles both.
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pendingMatch) return;
    void demandAttention();
  }, [pendingMatch]);


  if (!me)
    return (
      <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", fontFamily: T.body, color: T.text }}>
        <style>{css}</style>
        <Login onSignedIn={adoptServerSession} />
      </div>
    );

  const NAV = [["play", "PUG", Crosshair], ["scrims", "Scrims", Swords], ["teams", "Teams", Users], ["ladder", "Ladder", Trophy], ["profile", "Profile", User]];
  // Shown only to Game Masters. The server refuses everyone else anyway; this
  // keeps a tab off the rail that would only ever answer 403.
  if (me.isGameMaster) NAV.push(["disputes", "Disputes", Shield]);
  const go = (id) => { setNav(id); setViewProfile(null); };

  let content;
  if (match) content = <MatchScreen key={match.id} match={match} me={me} notify={notify} onView={setViewProfile} onFinished={() => {
    // The server already recorded it; re-reading is what makes the row real
    // rather than a local guess at what it wrote.
    setMatch(null);
    void refreshHistory();
  }} />;
  else if (viewProfile) content = <ProfileScreen p={viewProfile} me={me} history={history} onBack={() => setViewProfile(null)} onViewMatch={openMatch} />;
  else if (nav === "play") content = <PlayScreen me={me} party={party} setParty={setParty} queue={queue} setQueue={setQueue} cooldownUntil={cooldownUntil} history={history} notify={notify} onViewMatch={openMatch} onView={setViewProfile} onInvite={() => setInviteOpen(true)} />;
  // These three have no server endpoints yet, so they say so rather than
  // standing in for them.
  else if (nav === "scrims") content = <ScrimsScreen notify={notify} />;
  else if (nav === "teams") content = <TeamsScreen me={me} notify={notify} onView={setViewProfile} />;
  else if (nav === "disputes")
    content = me.isGameMaster ? (
      <DisputesScreen me={me} notify={notify} onView={setViewProfile} />
    ) : (
      <ComingSoon
        eyebrow="Disputes"
        title="Game Masters only"
        body="Disputed matches are settled by a Game Master."
      />
    );
  else if (nav === "ladder") content = <LadderScreen me={me} onView={setViewProfile} notify={notify} />;
  else content = <ProfileScreen p={me} me={me} history={history} onBack={() => {}} onViewMatch={openMatch} />;

  return (
    <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", background: T.bg, color: T.text, fontFamily: T.body, fontSize: 13, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      <style>{css}</style>
      {/* title bar */}
      <div style={{ height: 44, display: "flex", alignItems: "center", padding: "0 14px", borderBottom: `1px solid ${T.line}`, background: T.panel, gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}><div style={{ width: 22, height: 22, borderRadius: 4, background: T.accent, display: "grid", placeItems: "center" }}><Crosshair size={14} color="#07110F" strokeWidth={2.5} /></div><span style={{ fontFamily: T.display, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.02em" }}>Sudden Queue</span></div>
        {/* population strip */}
        <div style={{ display: "flex", gap: 14, marginLeft: 6 }}>
          {/* Server counts, already inclusive of you. */}
          {[["Online", pop.online, T.ok], ["In queue", pop.inQueue, T.accent], ["In match", pop.inMatch, T.captain]].map(([k, v, c]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={c} /><span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 600 }}>{v}</span><span style={{ fontSize: 11.5, color: T.muted }}>{k}</span></div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {queue.state === "queued" && !match && <button onClick={() => go("play")} style={{ background: T.accentDim, border: `1px solid ${T.accent}`, color: T.accent, borderRadius: 4, padding: "4px 10px", fontFamily: T.mono, fontSize: 11.5, display: "flex", gap: 6, alignItems: "center" }}><Dot pulse /> IN QUEUE</button>}
        {match && <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.captain, display: "flex", gap: 6, alignItems: "center" }}><Dot color={T.captain} pulse /> IN MATCH</span>}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}><Avatar p={me} size={24} /><PlayerName name={me.discordName} isGameMaster={me.isGameMaster} style={{ fontWeight: 600 }} /><Tier tier={me.tier} size={12} /></div>
        <button onClick={() => setMe(null)} title="Sign out" style={{ background: "transparent", border: "none", color: T.dim, padding: 4 }}><LogOut size={14} /></button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* nav rail */}
        <div style={{ width: 72, borderRight: `1px solid ${T.line}`, background: T.panel, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 10, gap: 4 }}>
          {NAV.map(([id, label, Icon]) => { const on = nav === id && !match && !viewProfile; return (
            <button key={id} onClick={() => go(id)} disabled={!!match} style={{ width: 58, height: 54, borderRadius: 6, border: "none", background: on ? T.raised : "transparent", color: on ? T.accent : T.muted, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 10.5, fontWeight: 600, position: "relative" }}>
              {on && <span style={{ position: "absolute", left: 0, top: 12, bottom: 12, width: 2, background: T.accent, borderRadius: 2 }} />}
              <Icon size={18} />{label}
            </button>); })}
          <div style={{ flex: 1 }} />
          <div style={{ padding: 10, textAlign: "center" }}><Eyebrow style={{ fontSize: 9 }}>v0.1</Eyebrow><Eyebrow style={{ fontSize: 9, color: T.dim }}>preview</Eyebrow></div>
        </div>
        {/* main */}
        <div style={{ flex: 1, minWidth: 0, padding: 16, overflow: "auto", position: "relative" }}>{content}</div>
      </div>

      {pendingMatch && <AcceptOverlay match={pendingMatch}
        onAccepted={() => { setMatch(pendingMatch); setPendingMatch(null); go("play"); }}
        // The server decides the penalty and whether anyone is re-queued, and
        // says so over the socket; guessing here would contradict it.
        onFail={() => { setPendingMatch(null); setQueue({ state: "idle" }); }} />}

      {pendingLineup && (
        <LineupModal
          pending={pendingLineup}
          notify={notify}
          onDone={() => setPendingLineup(null)}
        />
      )}

      <InviteToasts invites={invites} onAccept={acceptInvite} onDecline={declineInvite} />

      {inviteOpen && <InviteModal party={party} notify={notify} onClose={() => setInviteOpen(false)} />}

      {viewMatch && <MatchHistoryModal m={viewMatch} me={me} onClose={() => setViewMatch(null)} onView={(p) => { setViewMatch(null); setViewProfile(p); }} />}


      <ChatDock me={me} partyId={partyId} open={chatOpen} setOpen={setChatOpen} onView={setViewProfile} />


      {/* toasts */}
      <div style={{ position: "absolute", top: 54, right: 16, display: "flex", flexDirection: "column", gap: 6, zIndex: 60, pointerEvents: "none" }}>
        {toasts.map((t) => <div key={t.id} style={{ background: T.raised, border: `1px solid ${T.line2}`, borderLeft: `3px solid ${T.accent}`, borderRadius: 4, padding: "8px 12px", fontSize: 12.5, animation: "sqRise .2s ease", boxShadow: "0 6px 20px rgba(0,0,0,.35)", display: "flex", gap: 8, alignItems: "center" }}><Bell size={12} color={T.accent} />{t.text}</div>)}
      </div>
    </div>
  );
}

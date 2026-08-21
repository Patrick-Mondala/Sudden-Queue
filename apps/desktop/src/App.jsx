import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Crosshair, Swords, Users, Trophy, User, MessageSquare, Send, X, Check, Shield, Star, Wifi, Timer, Copy, ChevronRight, LogOut, Bell, Filter, Plus, Minus, AlertTriangle, CircleDot, Lock, Unlock } from "lucide-react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { signIn } from "./api/auth.js";
import { api as server, bus as liveBus, getToken } from "./api/client.js";
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
    placementsRemaining: profile.placementsRemaining,
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
 * Renders a rank.
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
function PlayScreen({ me, party, setParty, queue, setQueue, cooldownUntil, history, notify, onViewMatch, onView }) {
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
                  : cooling ? <span>You didn't accept a match. Queue unlocks in <span style={{ fontFamily: T.mono, color: T.danger }}>{fmt(coolLeft)}</span></span>
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
              {/* Inviting needs a player search the server does not expose
                  yet, so the control is present but says so. */}
              <Btn size="sm" title="Player search isn't wired up yet" disabled>
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
                    <div style={{ fontSize: 12, fontWeight: 600, maxWidth: "100%", textAlign: "center", whiteSpace: "nowrap" }}>{p.discordName}</div>
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
            {history.map((m, i) => (
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
              <div style={{ fontWeight: 700, fontSize: 15 }}>{me.discordName}</div>
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

function ProfileScreen({ p, me, history, onBack, onViewMatch }) {
  const isMe = p.id === me.id;
  const total = (p.wins ?? 0) + (p.losses ?? 0);

  // There is no endpoint for another player's profile yet, so what we know is
  // whatever the roster we clicked through carried. A match history is our own,
  // not theirs.
  const ownHistory = isMe ? history : [];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel pad={20}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Avatar p={p} size={64} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><H size={26}>{p.discordName}</H>{isMe && <Tag color={T.accent}>You</Tag>}</div>
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, marginTop: 4 }}>{p.inGameName} · Discord linked</div>
            </div>
            <div style={{ textAlign: "right" }}><Tier tier={p.tier} size={40} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 20 }}>
            {[["Rank", p.tier ?? (p.placementsRemaining > 0 ? `${p.placementsRemaining} to go` : "—")], ["Matches", p.gamesPlayed ?? total], ["Record", `${p.wins ?? 0}–${p.losses ?? 0}`], ["Win rate", winRate(p.wins ?? 0, p.losses ?? 0)]].map(([k, v]) => (
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
          <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
            Disputes, missed accepts and abandons aren't published yet.
          </div>
        </Panel>
        {!isMe && <Btn onClick={onBack} style={{ justifyContent: "center" }}>← Back to ladder</Btn>}
        <Panel><Eyebrow style={{ marginBottom: 6 }}>Public profile</Eyebrow><div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>This same record is visible on the public profile page. Only matchmaker data is shown — no in-game stats.</div></Panel>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   MATCH FLOW: accept overlay → match screen
   ───────────────────────────────────────────────────────────── */
function AcceptOverlay({ match, me, onAccepted, onFail }) {
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
              <div style={{ fontSize: 11, color: T.muted, textAlign: "center", maxWidth: "100%", whiteSpace: "nowrap" }}>{p.discordName}{isMe ? " (you)" : ""}</div>
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

function MatchChat({ match, me, onView }) {
  const [tab, setTab] = useState("team");
  const [msgs] = useState({ team: [], match: [] });
  const [text, setText] = useState("");
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [tab, msgs]);

  return (
    <Panel pad={0} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 220 }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}` }}>
        {[["team", "Team"], ["match", "Match"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `2px solid ${tab === id ? T.accent : "transparent"}`, color: tab === id ? T.text : T.muted, padding: "10px 4px", fontSize: 12, fontWeight: 600 }}>{label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {msgs[tab].length === 0 ? <div style={{ margin: "auto", color: T.dim, fontSize: 12.5, textAlign: "center", padding: 16, lineHeight: 1.5 }}>Chat isn't wired up yet — use your captain's in-game party.</div>
          : msgs[tab].map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", animation: "sqRise .2s ease" }}>
              <div onClick={() => onView?.(m.from)} style={{ cursor: onView ? "pointer" : "default", flexShrink: 0 }}><Avatar p={m.from} size={22} /></div>
              <div style={{ minWidth: 0 }}><span onClick={() => onView?.(m.from)} style={{ fontSize: 12, fontWeight: 700, color: m.me ? T.accent : T.text, cursor: onView ? "pointer" : "default" }}>{m.from.discordName}</span> <span style={{ fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><div style={{ fontSize: 13, color: T.text, lineHeight: 1.4, wordBreak: "break-word" }}>{m.text}</div></div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <div style={{ padding: 8, borderTop: `1px solid ${T.line}`, display: "flex", gap: 6 }}>
        <input value={text} disabled onChange={(e) => setText(e.target.value)} placeholder="Chat isn't wired up yet" style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.dim, fontSize: 13 }} />
        <Btn size="sm" kind="primary" disabled><Send size={13} /></Btn>
      </div>
    </Panel>
  );
}

function MatchScreen({ match, me, onFinished, notify, onView, onPhaseChange }) {
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
  useEffect(() => { onPhaseChange?.(phase); }, [phase]);

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
function ChatDock({ me, party, open, setOpen, onView }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [unread, setUnread] = useState(0);
  const endRef = useRef(null);
  const push = (m) => { setMsgs((s) => [...s, m].slice(-80)); if (!open) setUnread((u) => u + 1); };

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  useEffect(() => { if (open) setUnread(0); }, [open]);



  if (!open) return (
    <button onClick={() => setOpen(true)} style={{ position: "absolute", right: 16, bottom: 16, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 6, padding: "8px 12px", color: T.text, display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 600 }}>
      <MessageSquare size={14} /> Chat {unread > 0 && <span style={{ background: T.accent, color: "#07110F", borderRadius: 10, fontSize: 10.5, padding: "1px 6px", fontFamily: T.mono }}>{unread}</span>}
    </button>
  );
  // Nothing carries a message to the other end yet, so the box stays shut
  // rather than swallowing what you type.
  // Nothing carries a message to the other end yet, so the box stays shut
  // rather than swallowing what you type.
  const disabled = true;
  return (
    <div style={{ position: "absolute", right: 16, bottom: 16, width: 300, height: 380, background: T.panel, border: `1px solid ${T.line2}`, borderRadius: 8, boxShadow: "0 16px 40px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", zIndex: 55, animation: "sqRise .2s ease", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}`, padding: "10px 12px" }}>
        <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.text }}>Party chat</div>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {disabled ? <div style={{ margin: "auto", color: T.dim, fontSize: 12.5, textAlign: "center", padding: 20, lineHeight: 1.5 }}>Chat isn't wired up yet.</div>
          : msgs.length === 0 ? <div style={{ margin: "auto", color: T.dim, fontSize: 12.5 }}>No messages yet.</div>
          : msgs.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", animation: "sqRise .2s ease" }}>
              <div onClick={() => onView?.(m.from)} style={{ cursor: onView ? "pointer" : "default", flexShrink: 0 }}><Avatar p={m.from} size={22} /></div>
              <div style={{ minWidth: 0 }}><span onClick={() => onView?.(m.from)} style={{ fontSize: 12, fontWeight: 700, color: m.me ? T.accent : T.text, cursor: onView ? "pointer" : "default" }}>{m.from.discordName}</span> <span style={{ fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><div style={{ fontSize: 13, color: T.text, lineHeight: 1.4, wordBreak: "break-word" }}>{m.text}</div></div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <div style={{ padding: 8, borderTop: `1px solid ${T.line}`, display: "flex", gap: 6 }}>
        <input value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={disabled ? "" : "Message party…"} style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }} />
        <Btn size="sm" kind="primary" onClick={send} disabled={disabled || !text.trim()}><Send size={13} /></Btn>
      </div>
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
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [pendingMatch, setPendingMatch] = useState(null);
  const [match, setMatch] = useState(null);
  const [history, setHistory] = useState([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [viewProfile, setViewProfile] = useState(null);
  const [viewMatch, setViewMatch] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [matchPhase, setMatchPhase] = useState(null);
  const notify = useCallback((text) => { const id = Date.now() + Math.random(); setToasts((t) => [...t, { id, text }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800); }, []);

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
        case "match.cancelled":
          setPendingMatch(null);
          notify(e.atFault ? "You missed the accept — cooldown applied" : "A player didn't accept");
          break;
        case "match.resolved":
          notify(
            e.tierAfter && e.tierBefore && e.tierAfter !== e.tierBefore
              ? `Match complete · now ${e.tierAfter}`
              : "Match complete",
          );
          // Rank, record and placement count all just moved.
          void refreshProfile();
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
  }, [me, notify]);

  // Restore an existing session on launch rather than making the user sign in
  // again every time the app opens.
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
  }, []);
  useEffect(() => {
    if (!pendingMatch) return;
    const win = getCurrentWindow();
    win.unminimize().catch(() => {});
    win.setFocus().catch(() => {});
    win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }, [pendingMatch]);
  useEffect(() => { if (!match) setMatchPhase(null); }, [match]);

  /**
   * Re-reads the profile after a match resolves.
   *
   * Rank, record and the placement countdown all move at that moment, and the
   * lobby would otherwise keep showing the pre-match ones until a restart.
   */
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

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await server.me();
      setMe((prev) => (prev?.live ? { ...prev, ...profileToPlayer(profile) } : prev));
    } catch {
      // Cosmetic refresh; the next one will pick it up.
    }
  }, []);

  /**
   * Loads match history.
   *
   * Called on sign-in and again whenever a match closes, so the row you just
   * played is the server's record of it rather than a local guess at what it
   * wrote.
   */
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

  const adoptServerSession = useCallback(async () => {
    const profile = await server.me();

    setMe(profileToPlayer(profile));

    setParty(
      (profile.party?.members ?? []).map((m) => ({
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

    await refreshHistory();
    setChatOpen(false);
  }, [refreshHistory]);

  if (!me)
    return (
      <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", fontFamily: T.body, color: T.text }}>
        <style>{css}</style>
        <Login onSignedIn={adoptServerSession} />
      </div>
    );

  const NAV = [["play", "PUG", Crosshair], ["scrims", "Scrims", Swords], ["teams", "Teams", Users], ["ladder", "Ladder", Trophy], ["profile", "Profile", User]];
  const go = (id) => { setNav(id); setViewProfile(null); };

  let content;
  if (match) content = <MatchScreen key={match.id} match={match} me={me} notify={notify} onView={setViewProfile} onPhaseChange={setMatchPhase} onFinished={() => {
    // The server already recorded it; re-reading is what makes the row real
    // rather than a local guess at what it wrote.
    setMatch(null);
    void refreshHistory();
  }} />;
  else if (viewProfile) content = <ProfileScreen p={viewProfile} me={me} history={history} onBack={() => setViewProfile(null)} onViewMatch={openMatch} />;
  else if (nav === "play") content = <PlayScreen me={me} party={party} setParty={setParty} queue={queue} setQueue={setQueue} cooldownUntil={cooldownUntil} history={history} notify={notify} onViewMatch={openMatch} onView={setViewProfile} />;
  // These three have no server endpoints yet, so they say so rather than
  // standing in for them.
  else if (nav === "scrims")
    content = (
      <ComingSoon
        eyebrow="Scrim list"
        title="Teams looking to scrim"
        body="Scrims aren't wired up yet. Once teams exist, captains will list here for practice matches — unrated, but running the same accept and report flow as a PUG."
      />
    );
  else if (nav === "teams")
    content = (
      <ComingSoon
        eyebrow="Teams"
        title="Find a team"
        body="Teams aren't wired up yet. Once they are, you'll be able to register one, appoint officers, review applications, and list for scrims."
      />
    );
  else if (nav === "ladder")
    content = (
      <ComingSoon
        eyebrow="Ladder"
        title="Active players"
        body="The ladder isn't wired up yet. Once it is, every placed player appears here by rank, and you can open anyone's profile from it."
      />
    );
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}><Avatar p={me} size={24} /><span style={{ fontWeight: 600 }}>{me.discordName}</span><Tier tier={me.tier} size={12} /></div>
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

      {pendingMatch && <AcceptOverlay match={pendingMatch} me={me}
        onAccepted={() => { setMatch(pendingMatch); setPendingMatch(null); go("play"); }}
        // The server decides the penalty and whether anyone is re-queued, and
        // says so over the socket; guessing here would contradict it.
        onFail={() => { setPendingMatch(null); setQueue({ state: "idle" }); }} />}

      {viewMatch && <MatchHistoryModal m={viewMatch} me={me} onClose={() => setViewMatch(null)} onView={(p) => { setViewMatch(null); setViewProfile(p); }} />}


      <ChatDock me={me} party={party} open={chatOpen} setOpen={setChatOpen} onView={setViewProfile} />


      {/* toasts */}
      <div style={{ position: "absolute", top: 54, right: 16, display: "flex", flexDirection: "column", gap: 6, zIndex: 60, pointerEvents: "none" }}>
        {toasts.map((t) => <div key={t.id} style={{ background: T.raised, border: `1px solid ${T.line2}`, borderLeft: `3px solid ${T.accent}`, borderRadius: 4, padding: "8px 12px", fontSize: 12.5, animation: "sqRise .2s ease", boxShadow: "0 6px 20px rgba(0,0,0,.35)", display: "flex", gap: 8, alignItems: "center" }}><Bell size={12} color={T.accent} />{t.text}</div>)}
      </div>
    </div>
  );
}

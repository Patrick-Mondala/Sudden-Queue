import { useState, useEffect, useRef, useCallback, useContext, createContext } from "react";
import { Crosshair, Swords, Users, Trophy, User, MessageSquare, Send, X, Check, Shield, Star, Wifi, Timer, Copy, ChevronRight, LogOut, Bell, Filter, Plus, Minus, AlertTriangle, CircleDot, Lock, Unlock, RefreshCw } from "lucide-react";
import { signIn } from "./api/auth.js";
import { api as server, bus as liveBus, getToken, CLIENT_VERSION } from "./api/client.js";
import { checkForUpdate, installUpdate } from "./api/updates.js";
import { t, tn, errorText, currentLocale, onLocaleChange } from "./i18n/index.js";

/**
 * Pulls the window forward when a match is found.
 *
 * Loaded on demand rather than imported, so the app also runs in a plain
 * browser -- which matters when the Tauri shell cannot be launched at all,
 * as under Smart App Control. Everything else here is ordinary web code; this
 * was the only part that was not.
 */
/**
 * The sound a found match makes.
 *
 * Synthesised rather than shipped as a file: two short notes through the Web
 * Audio API weigh nothing, need no asset in the bundle, and cannot be the
 * thing that fails to load. The interval is a rising fourth because it has to
 * read as "come back" from another room and through a game's own audio, which
 * a single beep does not.
 *
 * Everything here is best-effort. A machine with no audio device, a webview
 * that refuses to start an AudioContext without a gesture, a muted output --
 * none of them are reasons to fail the accept prompt, which is the thing that
 * actually matters and is already on screen.
 */
function playQueuePop() {
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const at = ctx.currentTime;

    for (const [i, hz] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "triangle";
      osc.frequency.value = hz;

      // Shaped rather than switched: an envelope with no ramp clicks, and a
      // click is what a cheap notification sounds like.
      const start = at + i * 0.13;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);

      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.14);
    }

    // Let the device go once the sound has finished rather than holding an
    // audio context open for the rest of the session.
    setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    // No audio is not a failure worth reporting; the prompt is on screen.
  }
}

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

/**
 * What this deployment looks like, until the server says otherwise.
 *
 * The same binary can be pointed at anyone's server, so none of this is
 * knowable at build time -- a deployment might run 3v3 with different regions
 * and ranks called something else entirely. These are the values the first
 * deployment uses, and they are what renders in the moment before /config
 * answers, and if it never does.
 */
const DEFAULT_CONFIG = {
  appName: "Sudden Queue",
  gameName: "Sudden Attack Zero Point",
  teamSize: 5,
  matchSize: 10,
  maxPartySize: 5,
  maxTeamSize: 10,
  regions: [
    { id: "na", label: "NA", name: "North America" },
    { id: "sa", label: "SA", name: "South America" },
    { id: "eu", label: "EU", name: "Europe" },
    { id: "asia", label: "ASIA", name: "Asia" },
  ],
  tiers: ["F-","F","F+","D-","D","D+","C-","C","C+","B-","B","B+","A-","A","A+","G-","G","G+","S-","S","S+"],
  tierFloors: [620,675,730,785,840,895,950,1005,1060,1115,1170,1225,1280,1335,1390,1445,1500,1555,1610,1665,1720],
  defaultRating: 1200,
  placementGames: 5,
};

const ConfigContext = createContext(DEFAULT_CONFIG);
const useConfig = () => useContext(ConfigContext);

/* letter ranks, percentile buckets, F- .. S+ (17 tiers) */
/**
 * Colour for a tier letter. Tolerates null, which is what an unplaced player
 * legitimately has — rank stays hidden until placements are done, and a crash
 * here takes the whole app down with it.
 */

const tierColor = (tier) => {
  if (!tier) return "#4E5966";
  if (tier.startsWith("S")) return "#F2A93B";
  if (tier.startsWith("G")) return "#FF5C8A";
  if (tier.startsWith("A")) return "#C77DFF";
  if (tier.startsWith("B")) return "#2FC8BF";
  if (tier.startsWith("C")) return "#5DBE7B";
  if (tier.startsWith("D")) return "#9AA5B1";
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
/** What the server will accept, so a control can say so before the round trip. */
const IGN_MIN = 2;
const IGN_MAX = 16;
/** Matches TEAM_NOTE_MAX_LENGTH on the server, which is the one that refuses. */
const TEAM_NOTE_MAX = 240;
/** Matches REPORT_REASON_MAX_LENGTH on the server, which is the one that refuses. */
const REPORT_REASON_MAX = 500;

/**
 * How often a running client asks whether it is still current.
 *
 * Fifteen minutes because the deployment publishes within a minute of a
 * release and then refuses this client on its next call anyway -- so this is
 * not a race to be won, only a way to find out from the updater, which can
 * install, rather than from a refusal, which cannot.
 */
const UPDATE_RECHECK_MS = 15 * 60 * 1000;

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
    avatarUrl: profile.avatarUrl ?? null,
    inGameName: profile.inGameName ?? null,
    avatarColor: AV_COLORS[Math.abs(hashString(profile.userId)) % AV_COLORS.length],
    tier: profile.tier,
    isGameMaster: profile.isGameMaster ?? false,
    // Kept because "is staff" and "is an admin" are different questions, and
    // only the second decides who may act on a Game Master.
    role: profile.role ?? "player",
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
/**
 * What to call somebody.
 *
 * The in-game name, because that is the one that does any work: it is what you
 * type to add them in the game, what you look for on a scoreboard, and what
 * people recognise each other by. The Discord name is how they signed in --
 * near enough irrelevant to playing -- so it is the fallback for anyone who
 * has not set an in-game name yet, and nothing else.
 */
/**
 * Server history rows into what a row on screen needs.
 *
 * Shared because there are two callers now -- your own history and somebody
 * else's -- and the second one originally set the raw rows straight into
 * state. The result was a list of "NaNd ago" with no result and nothing
 * clickable, because every field the row draws is computed here rather than
 * sent: the id is called matchId over the wire, the timestamp is one of two
 * columns, and win or loss is a comparison between the result and which side
 * you were on.
 */
const toHistoryRows = (rows) =>
  (rows ?? []).map((r) => ({
    id: r.matchId,
    ts: new Date(r.resolvedAt ?? r.createdAt).getTime(),
    region: r.region,
    type: r.type,
    result: r.result === null ? "—" : (r.result === "TEAM1") === (r.team === 1) ? "win" : "loss",
    state: r.state === "DISPUTED" ? "in dispute" : "completed",
    // Rosters are fetched when a row is opened rather than shipped with every
    // row; this flag is what makes the row clickable without them.
    openable: true,
  }));

const displayName = (p) => p?.inGameName?.trim() || p?.discordName || null;

/**
 * The other name, where showing both earns its place.
 *
 * Null when it would only repeat what is already on screen, so a player who
 * has not set an in-game name gets one name rather than the same one twice.
 * Compared rather than inferred from which field was set: several payloads
 * arrive with inGameName already filled in from the Discord name, and a rule
 * that trusted the field would print both lines identically.
 */
const altName = (p) => {
  const shown = displayName(p);
  return p?.discordName && p.discordName !== shown ? p.discordName : null;
};

/**
 * Asks Discord for an avatar near the size it will be drawn at.
 *
 * The stored URL has no size on it, and Discord then serves whatever was
 * uploaded -- often a 1024px png for a 22px circle in a chat line. Doubled for
 * high-density screens, then rounded up to a power of two, which is all the CDN
 * accepts.
 */
function sizedAvatar(url, px) {
  if (!url || !url.startsWith("https://cdn.discordapp.com/")) return url;
  const want = Math.max(16, Math.min(256, 2 ** Math.ceil(Math.log2(Math.max(1, px * 2)))));
  return `${url}${url.includes("?") ? "&" : "?"}size=${want}`;
}

/**
 * Someone's face, or the initial standing in for it.
 *
 * The picture is not load-bearing: an account with no avatar set, a CDN having
 * a bad day, or someone offline all have to render as something, so the
 * coloured initial stays underneath and the image sits on top of it. A broken
 * image is the one outcome not allowed, because it appears in every roster.
 */
const Avatar = ({ p, size = 32, ring }) => {
  const url = p?.avatarUrl ?? null;
  const [failed, setFailed] = useState(false);

  // A recycled row can be handed a different person; a failure belongs to the
  // URL that failed, not to the slot it was drawn in.
  useEffect(() => { setFailed(false); }, [url]);

  return (
    <div
      title={displayName(p) ?? undefined}
      style={{ width: size, height: size, borderRadius: "50%", background: p?.avatarColor || T.line, display: "grid", placeItems: "center", fontFamily: T.display, fontWeight: 700, fontSize: size * 0.42, color: "#fff", boxShadow: ring ? `0 0 0 2px ${T.bg}, 0 0 0 4px ${ring}` : "none", flexShrink: 0, overflow: "hidden", position: "relative" }}
    >
      {(displayName(p) || "?")[0].toUpperCase()}
      {url && !failed && (
        <img
          src={sizedAvatar(url, size)}
          alt=""
          onError={() => setFailed(true)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}
    </div>
  );
};
/**
 * A player's name, with the GM prefix when they carry one.
 *
 * Every surface that shows a name goes through this rather than reading a
 * field directly, so a Game Master is marked in the roster, the ladder, a chat
 * line and an invite alike -- and adding a surface later cannot quietly miss
 * it. It takes the player rather than a string for the same reason: which of
 * their two names to show is one decision, made here, and not fourteen
 * decisions made wherever somebody happened to be writing markup.
 */
const PlayerName = ({ p, name, isGameMaster, style, suffix }) => (
  <span style={{ whiteSpace: "nowrap", ...style }}>
    {(isGameMaster ?? p?.isGameMaster) && (
      <span style={{ fontFamily: T.display, fontWeight: 800, fontSize: "0.85em", letterSpacing: "0.04em", color: T.captain, marginRight: 5 }}>{t("GM")}</span>
    )}
    {displayName(p) ?? name ?? t("Player")}
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
const RegionPicker = ({ value, onChange, multi = true }) => {
  const { regions } = useConfig();
  return (
  <div style={{ display: "flex", gap: 6 }}>
    {regions.map((r) => {
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
};
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
  const config = useConfig();
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
          ? t("Sign-in timed out. Try again.")
          : err?.code === "BANNED"
          ? t("This account is suspended.")
          : err?.message || t("Sign-in failed."),
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
            <H size={18}>{config.appName}</H>
            <Eyebrow>{config.gameName} · PUGs & scrims</Eyebrow>
          </div>
        </div>
        <Panel pad={20}>
          <Eyebrow style={{ marginBottom: 12 }}>{t("Sign in")}</Eyebrow>

          {phase === "waiting" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 5, padding: "12px 14px", marginBottom: 12 }}>
                <Dot pulse />
                <div style={{ fontSize: 13, lineHeight: 1.45 }}>
                  <div style={{ fontWeight: 600 }}>Waiting for Discord…</div>
                  <div style={{ color: T.muted, fontSize: 12 }}>{t("Finish signing in in your browser, then come back.")}</div>
                </div>
              </div>
              <Btn style={{ width: "100%", justifyContent: "center" }} onClick={cancel}>{t("Cancel")}</Btn>
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

          <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.5 }}>{t("Discord is the only sign-in. Your rank, record and match history follow the account.")}</div>
        </Panel>
      </div>

    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   PUG QUEUE
   ───────────────────────────────────────────────────────────── */
function PlayScreen({ me, party, queue, setQueue, cooldownUntil, history, notify, onViewMatch, onView, onInvite, onSetName }) {
  const config = useConfig();
  // The server says who leads; the first slot is only where they are drawn.
  const iLeadTheParty = party.some((p) => p.id === me.id && p.isLeader);
  // Defaults to every region this deployment has: a saved filter naming
  // regions that no longer exist would leave nobody able to queue.
  const [regions, setRegions] = usePersistentState(
    "sq.pug.regions",
    config.regions.map((r) => r.id),
  );
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
      notify(errorText(err, "Could not join the queue"));
    }
  };

  const stop = async () => {
    try {
      await server.leaveQueue();
    } catch (err) {
      notify(errorText(err, "Could not leave the queue"));
    }
    setQueue({ state: "idle" });
  };
  /**
   * Leaving, and removing somebody else.
   *
   * Both go to the server. The X used to filter the row out of this array and
   * stop there, which meant a party only ever changed on the screen of whoever
   * clicked: the server still had everyone together, so they queued together,
   * were matched together, and got the same two teams every time -- while each
   * client drew whatever its own clicking had left behind.
   *
   * Nothing is removed locally on the way out, either. The server broadcasts
   * the new roster to everyone who needs it, including whoever just left, and
   * a local guess would only be a second answer to disagree with.
   */
  const leaveParty = async () => {
    try {
      await server.leaveParty();
    } catch (err) {
      notify(errorText(err, "Could not leave the party"));
    }
  };

  const removeFromParty = async (id) => {
    try {
      await server.kick(id);
    } catch (err) {
      notify(errorText(err, "Could not remove them"));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        {me.inGameName === null && (
          <Panel pad={12} style={{ borderColor: T.captain, background: T.raised }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={15} color={T.captain} />
              <div style={{ flex: 1, fontSize: 12.5, color: T.muted, lineHeight: 1.4 }}>
                Your team will be looking for your <strong style={{ color: T.text }}>{t("in-game name")}</strong>, and you have not set one.
              </div>
              <Btn size="sm" onClick={onSetName}>{t("Set it")}</Btn>
            </div>
          </Panel>
        )}

        {/* queue control */}
        <Panel pad={20} style={{ position: "relative", overflow: "hidden", borderColor: queue.state === "queued" ? T.accent : T.line }}>
          {queue.state === "queued" && <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, transparent, ${T.accentDim}, transparent)`, backgroundSize: "200% 100%", animation: "sqSweep 2.4s linear infinite", pointerEvents: "none" }} />}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>PUG · {config.teamSize}v{config.teamSize} · rated</Eyebrow>
              <H size={26}>{queue.state === "queued" ? "Searching" : cooling ? "On cooldown" : t("Ready to queue")}</H>
              <div style={{ color: T.muted, fontSize: 13, marginTop: 6 }}>
                {queue.state === "queued"
                  ? <span>Search radius <span style={{ fontFamily: T.mono, color: T.text }}>±{radius}</span> · widens with time</span>
                  : cooling
                  ? <span>You left a match short. The queue reopens in <span style={{ fontFamily: T.mono, color: T.danger }}>{fmt(coolLeft)}</span></span>
                  : <span>{t("Pick regions, then queue. Any region you select can pop first.")}</span>}
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
            <Eyebrow>Party · {party.length}/{config.maxPartySize}</Eyebrow>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn
                size="sm"
                onClick={onInvite}
                disabled={party.length >= config.maxPartySize || queue.state === "queued"}
                title={queue.state === "queued" ? t("Leave the queue to change your party") : undefined}
              >
                <Plus size={13} /> Invite
              </Btn>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
            {Array.from({ length: config.maxPartySize }).map((_, i) => {
              const p = party[i];
              return (
                <div key={i} onClick={() => p && onView?.(p)} style={{ border: `1px dashed ${p ? T.line2 : T.line}`, borderStyle: p ? "solid" : "dashed", borderRadius: 5, padding: 10, minHeight: 92, background: p ? T.raised : "transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, position: "relative", cursor: p && onView ? "pointer" : "default" }}>
                  {p ? <>
                    <Avatar p={p} size={34} ring={i === 0 ? T.captain : null} />
                    <div style={{ fontSize: 12, fontWeight: 600, maxWidth: "100%", textAlign: "center", whiteSpace: "nowrap" }}><PlayerName p={p} /></div>
                    <Rank tier={p.tier} placementsRemaining={p.placementsRemaining} size={11} />
                    {/* Your own slot offers to leave; everyone else's offers to
                        remove them, and only to whoever leads the party. The
                        one X did both jobs badly before: a non-leader could
                        click it on somebody else, and nobody could use it on
                        themselves. */}
                    {queue.state !== "queued" && party.length > 1 && (p.id === me.id || iLeadTheParty) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void (p.id === me.id ? leaveParty() : removeFromParty(p.id)); }}
                        title={p.id === me.id ? t("Leave the party") : t("Remove from the party")}
                        aria-label={p.id === me.id ? t("Leave the party") : t("Remove from the party")}
                        style={{ position: "absolute", top: 4, right: 4, background: "transparent", border: "none", color: p.id === me.id ? T.captain : T.dim, padding: 2 }}
                      >
                        <X size={12} />
                      </button>
                    )}
                    {i === 0 && <span style={{ position: "absolute", top: 4, left: 6 }}><Star size={11} color={T.captain} fill={T.captain} /></span>}
                  </> : <div style={{ color: T.dim, fontSize: 12, margin: "auto" }}>{t("Open slot")}</div>}
                </div>
              );
            })}
          </div>
        </Panel>

        {/* recent matches */}
        <Panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>{t("Recent matches")}</Eyebrow>
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
              <div style={{ fontWeight: 700, fontSize: 15 }}><PlayerName p={me} /></div>
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{altName(me)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <Tier tier={me.tier} size={22} />
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{me.tier ? `Rank ${me.tier}` : me.placementsRemaining > 0 ? tn("{count} placement left", "{count} placements left", me.placementsRemaining) : t("Unranked")}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
            {[[t("Record"), `${me.wins}–${me.losses}`], [t("Win rate"), winRate(me.wins, me.losses)], [t("Disputes"), me.disputes]].map(([k, v]) => (
              <div key={k} style={{ background: T.raised, borderRadius: 4, padding: "8px 10px" }}>
                <Eyebrow style={{ fontSize: 9.5 }}>{k}</Eyebrow>
                <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 600, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <Eyebrow style={{ marginBottom: 10 }}>{t("How a PUG works")}</Eyebrow>
          {[
            [t("Queue"), t("Solo or with a party of up to {max}. Pick every region you're willing to play.", { max: config.maxPartySize })],
            [t("Accept"), t("When {n} players are found you get 20 seconds to accept. Missing it puts you on cooldown.", { n: config.matchSize })],
            [t("Party up"), t("The match screen shows both rosters. Add the highlighted captain in-game and join their party.")],
            [t("Queue together"), t("Both captains hit Casual queue on the same countdown. Empty queues mean you land in the same lobby.")],
            [t("Report"), t("Captains report the result. Disagreements go to dispute and are resolved by a mod.")],
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
  CAPTAIN_OFFLINE: t("Your captain is offline"),
  NOT_ENOUGH_ONLINE: t("Not enough of your team is online"),
};

function ScrimsScreen({ notify }) {
  const [state, setState] = useState(null); // { listings, myListing, incoming }
  const [myTeam, setMyTeam] = useState(undefined); // undefined = still loading
  const [regions, setRegions] = usePersistentState("sq.scrims.filter", ["na", "sa", "eu", "asia"]);
  const [note, setNote] = useState("");
  const [postRegion, setPostRegion] = useState("na");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null);

  const load = useCallback(async () => {
    try {
      const [board, mine] = await Promise.all([server.scrims(), server.myTeam()]);
      setState(board);
      setMyTeam(mine);
    } catch (err) {
      notify(errorText(err, "Could not load scrims"));
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
      else notify(errorText(err, "That did not work"));
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
        eyebrow={t("Scrims")}
        title={t("Scrims are for teams")}
        body={t("Register a team or join one, and its captain can list it here for practice matches — unrated, but the same accept and report flow as a PUG.")}
      />
    );
  }

  // A scrim commits ten people to a time, so it is the captain's call. The
  // server refuses everyone else; this keeps a button off the screen that
  // would only ever answer 403.
  const canManage = myTeam.role === "captain";
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
          <Eyebrow style={{ flex: 1 }}>{t("Teams looking to scrim")}</Eyebrow>
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
                    title={!canManage ? t("Only the captain arranges scrims") : tooSmall ? t("You need five players") : undefined}
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
          <Eyebrow style={{ marginBottom: 10 }}>{t("Your listing")}</Eyebrow>
          {!canManage ? (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
              {t("Only the captain can list {team} for scrims.", { team: myTeam.team.name })}
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
              <Btn kind="danger" style={{ width: "100%", justifyContent: "center" }} disabled={busy} onClick={() => act(() => server.removeListing(), t("Listing removed"))}>
                Remove listing
              </Btn>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <RegionPicker value={postRegion} onChange={setPostRegion} multi={false} />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 200))}
                placeholder={t("Note — format, times, voice")}
                aria-label={t("Listing note")}
                style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }}
              />
              <Btn
                kind="primary"
                style={{ width: "100%", justifyContent: "center" }}
                disabled={busy || !postRegion}
                onClick={() => act(async () => {
                  await server.postListing(postRegion, note.trim() || null);
                  setNote("");
                }, t("Your team is listed"))}
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
                {t("The captain answers these.")}
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
  const [openTeam, setOpenTeam] = useState(null);
  const [tab, setTab] = useState("mine");

  const load = useCallback(async () => {
    try {
      const [mine, list] = await Promise.all([server.myTeam(), server.listTeams()]);
      setState(mine);
      setDirectory(list.teams ?? []);
    } catch (err) {
      notify(errorText(err, "Could not load teams"));
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
      notify(errorText(err, "That did not work"));
    } finally {
      setBusy(false);
    }
  };

  if (state === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  /**
   * Your team and everyone else's, rather than one or the other.
   *
   * Joining a team used to remove the directory from the app entirely, which
   * is precisely backwards: being on a team is when you most want to look at
   * the others -- scouting a scrim opponent, or seeing who is recruiting when
   * you are thinking about leaving.
   *
   * Only shown when there is a choice to make. Somebody without a team has one
   * screen, and a tab strip with a single tab is furniture.
   */
  const onATeam = Boolean(state.team);
  const showing = onATeam ? tab : "directory";

  const directoryPanel = (
    <TeamDirectory
      teams={(directory ?? []).filter((team) => regions.includes(team.region))}
      regions={regions}
      setRegions={setRegions}
      myApplication={state.myApplication}
      busy={busy}
      act={act}
      onRefresh={load}
      onOpenTeam={setOpenTeam}
      onATeam={onATeam}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      {onATeam && (
        <div style={{ display: "flex", gap: 6 }}>
          {[["mine", t("My team")], ["directory", t("All teams")]].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{ background: showing === id ? T.raised : "transparent", border: `1px solid ${showing === id ? T.line2 : "transparent"}`, color: showing === id ? T.text : T.muted, borderRadius: 4, padding: "7px 14px", fontSize: 12.5, fontWeight: 600 }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {showing === "mine" ? (
          <MyTeamPanel me={me} state={state} busy={busy} act={act} onView={onView} onRefresh={load} />
        ) : (
          directoryPanel
        )}
      </div>

      {openTeam && (
        <TeamDetail
          teamId={openTeam}
          me={me}
          myApplication={state.myApplication}
          busy={busy}
          onView={onView}
          onClose={() => setOpenTeam(null)}
          onApply={(team) => {
            setOpenTeam(null);
            void act(() => server.applyToTeam(team.id, null), `Applied to ${team.name}`);
          }}
        />
      )}
    </div>
  );
}

/** The roster you are on, with whatever powers your role carries. */
function MyTeamPanel({ me, state, busy, act, onView, onRefresh }) {
  const config = useConfig();
  const [tab, setTab] = useState("roster");
  const [confirmDisband, setConfirmDisband] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
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
            <Eyebrow>{team.region.toUpperCase()} · {team.members.length}/{config.maxTeamSize} players · {starters}/{config.teamSize} starting</Eyebrow>

            {/* What the directory shows people deciding whether to apply.
                Managers edit it, because the officer fielding applications is
                the one who knows what it should say. */}
            {editingNote ? (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  value={noteDraft}
                  autoFocus
                  onChange={(e) => setNoteDraft(e.target.value.slice(0, TEAM_NOTE_MAX))}
                  onKeyDown={(e) => { if (e.key === "Escape") setEditingNote(false); }}
                  placeholder={t("When you play, what you need, where your voice comms are")}
                  aria-label={t("Team note")}
                  style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "6px 9px", color: T.text, fontSize: 12.5 }}
                />
                <Btn size="sm" kind="primary" disabled={busy} onClick={async () => { await act(() => server.setTeamNote(noteDraft.trim() || null), t("Note saved")); setEditingNote(false); }}>{t("Save")}</Btn>
                <Btn size="sm" disabled={busy} onClick={() => setEditingNote(false)}>{t("Cancel")}</Btn>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: 12.5, color: team.note ? "#C3CAD4" : T.dim, lineHeight: 1.5 }}>
                  {team.note ?? t("No note yet")}
                </span>
                {canManage && (
                  <button
                    onClick={() => { setNoteDraft(team.note ?? ""); setEditingNote(true); }}
                    aria-label={t("Change the team note")}
                    style={{ background: "transparent", border: `1px solid ${T.line2}`, borderRadius: 4, color: T.muted, fontSize: 11, fontWeight: 600, padding: "2px 7px", whiteSpace: "nowrap" }}
                  >
                    {team.note ? t("Edit") : t("Add a note")}
                  </button>
                )}
              </div>
            )}
          </div>
          <Btn size="sm" disabled={busy} onClick={onRefresh} title={t("Refresh")} aria-label={t("Refresh")}>
            <RefreshCw size={13} />
          </Btn>
          {isCaptain && (
            <Btn size="sm" disabled={busy} onClick={() => act(() => server.setApplicationsOpen(!team.applicationsOpen))}>
              {team.applicationsOpen ? <Unlock size={13} color={T.ok} /> : <Lock size={13} color={T.danger} />}
              Applications {team.applicationsOpen ? "open" : "closed"}
            </Btn>
          )}
          {!isCaptain && (
            <Btn size="sm" disabled={busy} onClick={() => act(() => server.leaveTeam(), "You left the team")}>{t("Leave")}</Btn>
          )}
          {isCaptain && !confirmDisband && (
            <Btn size="sm" kind="danger" disabled={busy} onClick={() => setConfirmDisband(true)}>{t("Disband")}</Btn>
          )}
          {isCaptain && confirmDisband && (
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" kind="danger" disabled={busy} onClick={() => act(() => server.disbandTeam(), `${team.name} disbanded`)}>{t("Confirm")}</Btn>
              <Btn size="sm" disabled={busy} onClick={() => setConfirmDisband(false)}>{t("Cancel")}</Btn>
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
                  <div onClick={() => onView?.({ id: m.userId, discordName: m.discordName, avatarUrl: m.avatarUrl, inGameName: m.inGameName, tier: m.tier, placementsRemaining: m.placementsRemaining, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] })} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, cursor: "pointer" }}>
                    <Avatar p={{ ...m, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] }} size={30} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                        <PlayerName p={m} suffix={m.userId === me.id ? <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span> : null} />
                      </div>
                      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{altName(m)}</div>
                    </div>
                  </div>
                  <Tag color={m.isStarter ? T.ok : T.dim}>{m.isStarter ? t("Starter") : t("Sub")}</Tag>
                  <Tag color={m.role === "captain" ? T.captain : m.role === "officer" ? T.accent : T.muted}>{m.role}</Tag>
                  <Rank tier={m.tier} placementsRemaining={m.placementsRemaining} size={11} />
                  {isCaptain && (
                    <button
                      title={m.isStarter ? t("Move to the bench") : t("Move into the starting five")}
                      disabled={busy}
                      onClick={() => act(() => server.setStarter(m.userId, !m.isStarter))}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: m.isStarter ? T.ok : T.dim, flexShrink: 0 }}
                    >
                      <CircleDot size={13} />
                    </button>
                  )}
                  {isCaptain && m.userId !== me.id && (
                    <button
                      title={m.role === "officer" ? t("Demote to member") : t("Make officer")}
                      disabled={busy}
                      onClick={() => act(() => server.setTeamRole(m.userId, m.role === "officer" ? "member" : "officer"))}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: m.role === "officer" ? T.accent : T.muted, flexShrink: 0 }}
                    >
                      <Shield size={13} />
                    </button>
                  )}
                  {isCaptain && m.userId !== me.id && (
                    <button
                      title={t("Hand over the team")}
                      disabled={busy}
                      onClick={() => act(() => server.transferCaptaincy(m.userId), `${displayName(m)} now captains ${team.name}`)}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: T.captain, flexShrink: 0 }}
                    >
                      <Star size={13} />
                    </button>
                  )}
                  {/* An officer clears out members; only the captain removes an officer. */}
                  {canManage && m.userId !== me.id && m.role !== "captain" && (isCaptain || m.role !== "officer") && (
                    <button
                      title={t("Remove from team")}
                      disabled={busy}
                      onClick={() => act(() => server.removeTeamMember(m.userId), `${displayName(m)} removed`)}
                      style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.dangerDim, border: `1px solid ${T.danger}`, borderRadius: 4, color: T.danger, flexShrink: 0 }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))
            : !canManage ? (
              <div style={{ color: T.muted, fontSize: 12.5, padding: 20, textAlign: "center" }}>{t("Only the captain and officers review applications.")}</div>
            ) : state.applications.length === 0 ? (
              <div style={{ color: T.dim, fontSize: 12.5, padding: 20, textAlign: "center", lineHeight: 1.5 }}>
                {team.applicationsOpen ? t("Nobody has applied yet.") : t("Applications are closed.")}
              </div>
            ) : (
              state.applications.map((a) => (
                <div key={a.id} style={{ padding: "10px 8px", borderRadius: 4, borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: a.note ? 8 : 0 }}>
                    <Avatar p={{ ...a, avatarColor: AV_COLORS[Math.abs(hashString(a.userId)) % AV_COLORS.length] }} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}><PlayerName p={a} /></div>
                      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{altName(a)}</div>
                    </div>
                    <Rank tier={a.tier} placementsRemaining={a.placementsRemaining} size={11} />
                    <Btn size="sm" kind="primary" disabled={busy} onClick={() => act(() => server.decideApplication(a.id, true), `${displayName(a)} joined ${team.name}`)}>{t("Accept")}</Btn>
                    <Btn size="sm" disabled={busy} onClick={() => act(() => server.decideApplication(a.id, false), "Application denied")}>{t("Deny")}</Btn>
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
function TeamDirectory({ teams, regions, setRegions, myApplication, busy, act, onOpenTeam, onRefresh, onATeam }) {
  const [creating, setCreating] = useState(false);
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("na");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, height: "100%", minHeight: 0 }}>
      <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
          <Eyebrow style={{ flex: 1 }}>{t("Teams")}</Eyebrow>
          <RegionPicker value={regions} onChange={setRegions} />
          {/* Rosters change without an event reaching you -- somebody else's
              team accepting somebody else's application is not something you
              are told about. */}
          <Btn size="sm" disabled={busy} onClick={onRefresh} title={t("Refresh")} aria-label={t("Refresh")}>
            <RefreshCw size={13} />
          </Btn>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
          {teams.length === 0 ? (
            <div style={{ color: T.dim, fontSize: 12.5, padding: 24, textAlign: "center", lineHeight: 1.5 }}>
              No teams in these regions yet. Register the first one.
            </div>
          ) : (
            teams.map((team) => (
              <div key={team.id} className="row-hover" onClick={() => onOpenTeam(team.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 8px", borderRadius: 4, cursor: "pointer" }}>
                <div style={{ width: 32, height: 32, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 10.5, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{team.tag}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{team.name}</div>
                  <div style={{ fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>{team.region.toUpperCase()} · {tn("{count} player", "{count} players", team.memberCount)}</div>
                </div>
                <Tier tier={team.tier} size={12} />
                <Tag color={team.applicationsOpen ? T.ok : T.dim}>{team.applicationsOpen ? t("Open") : t("Closed")}</Tag>
                {myApplication?.teamId === team.id ? (
                  <Btn size="sm" disabled={busy} onClick={(e) => { e.stopPropagation(); act(() => server.withdrawApplication(), "Application withdrawn"); }} style={{ minWidth: 88, justifyContent: "center" }}>
                    <Dot pulse /> Withdraw
                  </Btn>
                ) : (
                  <Btn
                    size="sm"
                    kind={team.applicationsOpen ? "primary" : "ghost"}
                    disabled={busy || onATeam || !team.applicationsOpen || !!myApplication || team.memberCount >= 10}
                    title={onATeam ? t("Leave your team first") : myApplication ? t("Withdraw your other application first") : undefined}
                    onClick={(e) => { e.stopPropagation(); act(() => server.applyToTeam(team.id, null), `Applied to ${team.name}`); }}
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
        {/* One team per player, so somebody already on one is not offered a
            second. The server refuses it either way; this stops the offer
            being made. */}
        {!onATeam && (
        <Panel>
          <Eyebrow style={{ marginBottom: 10 }}>{t("Start a team")}</Eyebrow>
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
              <input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase().slice(0, 4))} placeholder={t("Tag (max 4)")} aria-label={t("Team tag")} style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13, fontFamily: T.mono }} />
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} placeholder={t("Team name")} aria-label={t("Team name")} style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }} />
              <RegionPicker value={region} onChange={setRegion} multi={false} />
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <Btn
                  kind="primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={busy || !tag.trim() || !name.trim() || !region}
                  onClick={() =>
                    act(async () => {
                      await server.createTeam({ tag: tag.trim(), name: name.trim(), region });
                      setCreating(false);
                      setTag("");
                      setName("");
                    }, t("Team registered"))
                  }
                >
                  Register
                </Btn>
                <Btn onClick={() => setCreating(false)}>{t("Cancel")}</Btn>
              </div>
            </div>
          )}
        </Panel>
        )}

        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>{t("How teams work")}</Eyebrow>
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
/** How long a suspension can run for, offered as the durations a GM reaches for. */
const SUSPENSION_OPTIONS = [
  ["1 hour", 1],
  ["24 hours", 24],
  ["3 days", 72],
  ["1 week", 168],
  ["30 days", 720],
  ["1 year", 8760],
];

/** Renders a suspension end as something a person reads, not a timestamp. */
function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

/**
 * Acting on an account.
 *
 * A Game Master could already judge a dispute but not touch the person who
 * caused it, which left the only remedy as hand-written SQL. Every action here
 * is recorded and reversible; nothing on this panel is permanent.
 */
function PlayersPanel({ me, notify }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [everybody, setEverybody] = useState([]);
  const [target, setTarget] = useState(null);
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [delta, setDelta] = useState("");

  /**
   * Everybody, before anything is typed.
   *
   * This used to open on the suspended list, which answers "who is in
   * trouble" -- but the question a Game Master usually arrives with is "find
   * me this person", and somebody who has never been suspended was
   * unreachable without already knowing their name well enough to search it.
   *
   * Most recently seen first, because the account you want is nearly always
   * one that was playing when the thing happened.
   */
  const loadEverybody = useCallback(async () => {
    try {
      const res = await server.findPlayers("");
      setEverybody(res.users ?? []);
    } catch (err) {
      notify(errorText(err, "Could not load players"));
    }
  }, [notify]);

  useEffect(() => { loadEverybody(); }, [loadEverybody]);

  // Typing is not a search. Waiting a beat keeps a five-letter name from being
  // five queries against every account on the server.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) { setResults(null); return undefined; }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await server.findPlayers(q);
        if (!cancelled) setResults(res.users ?? []);
      } catch (err) {
        if (!cancelled) notify(errorText(err, "Search failed"));
      }
    }, 250);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, notify]);

  const open = useCallback(async (user) => {
    setTarget(user);
    setReason("");
    setHours(24);
    try {
      const res = await server.moderationHistory(user.userId);
      setHistory(res.entries ?? []);
    } catch {
      // The history is context, not the action. Losing it should not stop a
      // Game Master from acting on what they already know.
      setHistory([]);
    }
  }, []);

  const refresh = async (userId) => {
    await loadEverybody();
    if (query.trim()) {
      try {
        const res = await server.findPlayers(query.trim());
        setResults(res.users ?? []);
        const fresh = (res.users ?? []).find((u) => u.userId === userId);
        if (fresh) setTarget(fresh);
      } catch {
        // Leave the list as it was; the action itself already succeeded.
      }
    }
    try {
      const res = await server.moderationHistory(userId);
      setHistory(res.entries ?? []);
    } catch {
      setHistory([]);
    }
  };

  const doSuspend = async () => {
    if (!target || reason.trim().length === 0) return;
    setBusy(true);
    try {
      const res = await server.suspend(target.userId, hours, reason.trim());
      notify(`${displayName(res)} suspended`);
      setReason("");
      await refresh(target.userId);
    } catch (err) {
      notify(errorText(err, "Could not suspend"));
    } finally {
      setBusy(false);
    }
  };

  const doReinstate = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await server.reinstate(target.userId, reason.trim());
      notify(`${displayName(target)} reinstated`);
      setReason("");
      await refresh(target.userId);
    } catch (err) {
      notify(errorText(err, "Could not reinstate"));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Runs one of the repair powers against whoever is selected.
   *
   * Refreshes afterwards rather than guessing at the new state: these change
   * things this panel is displaying -- a cooldown, a name, a rating -- and a
   * local guess would be a second answer free to disagree with the server's.
   */
  const runOnTarget = async (fn, said) => {
    if (!target) return;
    setBusy(true);
    try {
      await fn();
      notify(said);
      setAdjusting(false);
      setDelta("");
      await refresh(target.userId);
    } catch (err) {
      notify(errorText(err, "That did not work"));
    } finally {
      setBusy(false);
    }
  };

  const listed = results ?? everybody;
  const serving = target && Date.parse(target.bannedUntil ?? 0) > Date.now();
  const cooling = target && Date.parse(target.queueCooldownUntil ?? 0) > Date.now();

  /**
   * Whether this account is one a Game Master may suspend.
   *
   * The same rule the server enforces, mirrored here so it is not discovered by
   * clicking: an admin may act on a Game Master, nobody may act on an admin
   * from this screen, and two Game Masters suspending each other is not a
   * dispute the system should be able to have.
   */
  const maySuspend = target && !(target.role === "admin" || (target.role === "game_master" && me.role !== "admin"));

  const row = (u) => (
    <div
      key={u.userId}
      className="row-hover"
      onClick={() => open(u)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 4, cursor: "pointer", background: u.userId === target?.userId ? T.raised : "transparent" }}
    >
      <Avatar p={{ ...u, avatarColor: AV_COLORS[Math.abs(hashString(u.userId)) % AV_COLORS.length] }} size={26} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <PlayerName p={u} isGameMaster={u.role !== "player"} style={{ fontWeight: 600, fontSize: 13 }} />
        <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {altName(u)}
        </div>
      </div>
      {Date.parse(u.bannedUntil ?? 0) > Date.now() && <Tag color={T.danger} bg={T.dangerDim}>{until(u.bannedUntil)}</Tag>}
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, height: "100%", minHeight: 0 }}>
      <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
          <Eyebrow>{results ? t("Search") : t("All players")}</Eyebrow>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Discord name, in-game name, or Discord ID")}
            aria-label={t("Find a player")}
            style={{ width: "100%", boxSizing: "border-box", marginTop: 8, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 12.5 }}
          />
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
          {listed.length === 0 ? (
            <div style={{ color: T.dim, fontSize: 12.5, padding: 20, textAlign: "center", lineHeight: 1.5 }}>
              {results ? t("Nobody by that name.") : t("No accounts yet.")}
            </div>
          ) : listed.map(row)}
        </div>
      </Panel>

      {!target ? (
        <Panel style={{ display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>
          Pick a player to act on.
        </Panel>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
          <Panel pad={20}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Avatar p={{ ...target, avatarColor: AV_COLORS[Math.abs(hashString(target.userId)) % AV_COLORS.length] }} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <PlayerName p={target} isGameMaster={target.role !== "player"} style={{ fontWeight: 700, fontSize: 16 }} />
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                  {target.discordName} · {target.discordId}
                </div>
              </div>
            </div>

            {serving && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: T.dangerDim, border: `1px solid ${T.danger}`, borderRadius: 5 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: T.danger }}>
                  Suspended — {until(target.bannedUntil)}
                </div>
                {target.banReason && (
                  <div style={{ fontSize: 12, color: T.muted, marginTop: 4, lineHeight: 1.4 }}>{target.banReason}</div>
                )}
              </div>
            )}

            {/* The queue cooldown, which is a different thing from a
                suspension: it comes from missing accepts rather than from
                anybody's decision, and it is what the Lift cooldown button
                below is about. Shown whenever there is one to see, so the
                control is not a guess about what it will change. */}
            {(cooling || target.recentMissedAccepts > 0) && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 5 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: cooling ? T.captain : T.muted }}>
                  {cooling ? `Queue cooldown — ${until(target.queueCooldownUntil)}` : t("No cooldown running")}
                </div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 4, lineHeight: 1.4 }}>
                  {tn(
                    "{count} recent missed accept, so the next one escalates.",
                    "{count} recent missed accepts, so the next one escalates.",
                    target.recentMissedAccepts,
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <Eyebrow style={{ marginBottom: 8 }}>{serving ? t("Note (optional)") : t("Reason")}</Eyebrow>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, 500))}
                placeholder={serving ? t("Why it is being lifted") : t("What they did — they are shown this")}
                aria-label={serving ? t("Note") : t("Reason")}
                style={{ width: "100%", boxSizing: "border-box", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }}
              />
            </div>

            {/* The powers that used to mean opening psql. Separated from the
                suspension controls above by a rule, because these are repairs
                rather than punishments and reading them as a menu of
                escalations would be the wrong impression. */}
            <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 14, paddingTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Btn size="sm" disabled={busy} onClick={() => runOnTarget(() => server.clearCooldown(target.userId), t("Cooldown lifted"))}>
                <Timer size={12} /> {t("Lift cooldown")}
              </Btn>
              <Btn size="sm" disabled={busy} onClick={() => runOnTarget(() => server.clearInGameName(target.userId), t("In-game name cleared"))}>
                <X size={12} /> {t("Clear in-game name")}
              </Btn>
              <Btn size="sm" disabled={busy} onClick={() => setAdjusting((v) => !v)}>
                <Star size={12} /> {t("Correct rating")}
              </Btn>
            </div>

            {adjusting && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  value={delta}
                  onChange={(e) => setDelta(e.target.value.replace(/[^-\d]/g, "").slice(0, 5))}
                  placeholder={t("±points")}
                  aria-label={t("Rating adjustment")}
                  style={{ width: 90, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "6px 8px", color: T.text, fontSize: 12, fontFamily: T.mono }}
                />
                <Btn
                  size="sm"
                  kind="primary"
                  disabled={busy || !Number(delta) || !reason.trim()}
                  title={reason.trim() ? undefined : t("Say why in the box above")}
                  onClick={() => runOnTarget(
                    () => server.adjustRating(target.userId, Number(delta), reason.trim()),
                    t("Rating corrected"),
                  )}
                >
                  {t("Apply")}
                </Btn>
                <span style={{ fontSize: 11.5, color: T.dim, alignSelf: "center" }}>
                  {t("Uses the reason above, and is kept in the ledger.")}
                </span>
              </div>
            )}

            {/* Staff are not suspendable from here, and saying so beats
                offering the controls and refusing the click. The repairs
                above stay available: lifting a cooldown or clearing a name
                is not a punishment, and a Game Master can miss an accept
                like anybody. */}
            {!maySuspend ? (
              <div style={{ marginTop: 14, padding: "10px 12px", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 5, fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
                {target.role === "admin"
                  ? t("Admins cannot be suspended from here.")
                  : t("A Game Master cannot be suspended by another Game Master. An admin can.")}
              </div>
            ) : serving ? (
              <Btn kind="primary" disabled={busy} onClick={doReinstate} style={{ marginTop: 14 }}>
                Lift the suspension
              </Btn>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
                  {SUSPENSION_OPTIONS.map(([label, value]) => (
                    <button
                      key={value}
                      onClick={() => setHours(value)}
                      style={{ background: hours === value ? T.accentDim : "transparent", border: `1px solid ${hours === value ? T.accent : T.line2}`, color: hours === value ? T.accent : T.muted, borderRadius: 4, padding: "5px 10px", fontSize: 11.5, fontFamily: T.mono }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Btn
                  kind="danger"
                  disabled={busy || reason.trim().length === 0 || target.userId === me.id}
                  onClick={doSuspend}
                  style={{ marginTop: 14 }}
                >
                  Suspend
                </Btn>
                {target.userId === me.id && (
                  <div style={{ fontSize: 11.5, color: T.dim, marginTop: 8 }}>{t("You cannot suspend yourself.")}</div>
                )}
              </>
            )}
          </Panel>

          <Panel pad={0} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.line}` }}>
              <Eyebrow>{t("Record")}</Eyebrow>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
              {history.length === 0 ? (
                <div style={{ color: T.dim, fontSize: 12.5, padding: 20, textAlign: "center" }}>
                  Nothing on record.
                </div>
              ) : history.map((h) => (
                <div key={h.id} style={{ padding: "9px 10px", borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Tag color={h.eventType === "user.suspended" ? T.danger : T.ok}>
                      {h.eventType === "user.suspended" ? "suspended" : "reinstated"}
                    </Tag>
                    <span style={{ fontSize: 11.5, color: T.muted }}>by {h.actorName ?? "unknown"}</span>
                    <span style={{ flex: 1, textAlign: "right", fontSize: 11, color: T.dim }}>{ago(Date.parse(h.createdAt))}</span>
                  </div>
                  {(h.payload?.reason || h.payload?.note) && (
                    <div style={{ fontSize: 12, color: T.muted, marginTop: 5, lineHeight: 1.4 }}>
                      {h.payload.reason ?? h.payload.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

/**
 * The Game Master screen: judging matches, and acting on people.
 *
 * Two tabs rather than two rail entries -- a Game Master looking at a dispute
 * is usually one step from wanting the person who caused it, and making that
 * a different destination makes it feel like a different job.
 */
/**
 * The wall.
 *
 * Everyone sees this, which is the whole point of it existing: a consequence
 * nobody watches is a consequence nobody weighs, and a community that cannot
 * see what gets you banned has to guess. Newest first, because the question it
 * answers is "what just happened", not "who is still out".
 *
 * Spent bans stay. It is a record of what has been done rather than a list of
 * who is currently serving, and dropping a ban the moment it expired would
 * quietly rewrite the second into the first.
 *
 * The Game Master who issued it is not shown to players. The server leaves it
 * out rather than the client hiding it -- naming a person beside a punishment
 * turns a decision about a player into a grievance against a moderator.
 */
function BansScreen({ notify }) {
  const [bans, setBans] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await server.bans();
      setBans(res.bans ?? []);
    } catch (err) {
      notify(errorText(err, "Could not load the bans"));
      setBans([]);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  if (bans === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  return (
    <Panel pad={0} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
        <Eyebrow style={{ flex: 1 }}>{t("Bans")}</Eyebrow>
        <Btn size="sm" onClick={load} aria-label={t("Refresh")}><RefreshCw size={13} /></Btn>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {bans.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 12.5, padding: 28, textAlign: "center", lineHeight: 1.6 }}>
            Nobody has been banned. Long may it last.
          </div>
        ) : (
          bans.map((b) => (
            <div key={b.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 10px", borderBottom: `1px solid ${T.line}` }}>
              <div style={{ width: 6, alignSelf: "stretch", borderRadius: 3, background: b.active ? T.danger : T.line2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {b.inGameName || b.discordName || t("a deleted account")}
                  </span>
                  {b.active
                    ? <Tag color={T.danger}>{t("Banned")}</Tag>
                    : <Tag color={T.dim}>{t("Served")}</Tag>}
                </div>
                {b.reason && (
                  <div style={{ fontSize: 12.5, color: "#B4BCC7", marginTop: 4, lineHeight: 1.5 }}>{b.reason}</div>
                )}
                <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.dim, marginTop: 4 }}>
                  {new Date(b.at).toLocaleString()}
                  {b.hours ? ` · ${b.hours}h` : ""}
                  {b.byName ? ` · ${b.byName}` : ""}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

/**
 * What players have asked a Game Master to look at.
 *
 * Grouped by who was reported, not by report: five people complaining about
 * one player is one problem, and a flat list of five rows buries the number
 * that decides where to look first.
 */
function ReportsPanel({ notify, onView }) {
  const [players, setPlayers] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({});

  const load = useCallback(async () => {
    try {
      const res = await server.reports(showClosed);
      setPlayers(res.players ?? []);
    } catch (err) {
      notify(errorText(err, "Could not load reports"));
      setPlayers([]);
    }
  }, [notify, showClosed]);

  useEffect(() => { load(); }, [load]);

  const review = async (reportId, status) => {
    setBusy(true);
    try {
      await server.reviewReport(reportId, status, note[reportId]?.trim() || null);
      notify(status === "actioned" ? t("Marked as actioned") : t("Dismissed"));
      await load();
    } catch (err) {
      notify(errorText(err, "Could not close that report"));
    } finally {
      setBusy(false);
    }
  };

  if (players === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  return (
    <Panel pad={0} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${T.line}` }}>
        <Eyebrow style={{ flex: 1 }}>{showClosed ? t("All reports") : t("Open reports")}</Eyebrow>
        <Btn size="sm" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? t("Open only") : t("Show closed")}
        </Btn>
        <Btn size="sm" onClick={load} aria-label={t("Refresh")}><RefreshCw size={13} /></Btn>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
        {players.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 12.5, padding: 28, textAlign: "center" }}>
            {showClosed ? t("No reports at all.") : t("Nothing waiting. Nobody has reported anybody.")}
          </div>
        ) : (
          players.map((p) => (
            <Panel key={p.userId} pad={12} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, cursor: "pointer" }} onClick={() => onView?.({ id: p.userId })}>
                    <PlayerName p={p} />
                  </div>
                  {altName(p) && <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{altName(p)}</div>}
                </div>
                {/* How many separate people bothered, which is the number that
                    decides where to look first. */}
                <Tag color={p.openCount > 2 ? T.danger : T.captain}>
                  {tn("{count} report", "{count} reports", p.openCount)}
                </Tag>
              </div>

              {p.reports.map((r) => (
                <div key={r.id} style={{ borderTop: `1px solid ${T.line}`, paddingTop: 9, marginTop: 9 }}>
                  <div style={{ fontSize: 12.5, color: "#C3CAD4", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{r.reason}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.dim, marginTop: 5 }}>
                    {r.reporter.inGameName || r.reporter.discordName} · {new Date(r.updatedAt).toLocaleString()}
                    {r.status !== "open" ? ` · ${r.status}` : ""}
                  </div>

                  {r.status === "open" ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <input
                        value={note[r.id] ?? ""}
                        onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))}
                        placeholder={t("What you decided (optional)")}
                        aria-label={t("Review note")}
                        style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "5px 8px", color: T.text, fontSize: 12 }}
                      />
                      <Btn size="sm" kind="danger" disabled={busy} onClick={() => review(r.id, "actioned")}>{t("Actioned")}</Btn>
                      <Btn size="sm" disabled={busy} onClick={() => review(r.id, "dismissed")}>{t("Dismiss")}</Btn>
                    </div>
                  ) : (
                    r.reviewNote && (
                      <div style={{ fontSize: 12, color: T.muted, marginTop: 5, fontStyle: "italic" }}>{r.reviewNote}</div>
                    )
                  )}
                </div>
              ))}
            </Panel>
          ))
        )}
      </div>
    </Panel>
  );
}

/** Striking a match out, by id, when it should never have counted. */
function MatchesPanel({ notify }) {
  const [matchId, setMatchId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const voidIt = async () => {
    setBusy(true);
    try {
      const res = await server.voidMatch(matchId.trim(), reason.trim());
      notify(
        res.reversed
          ? `Match voided. Rating reversed for ${res.reversed} players.`
          : t("Match voided."),
      );
      setMatchId("");
      setReason("");
    } catch (err) {
      notify(errorText(err, "Could not void that match"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel style={{ height: "100%", overflow: "auto" }}>
      <Eyebrow style={{ marginBottom: 10 }}>{t("Void a match")}</Eyebrow>
      <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.55, marginBottom: 14, maxWidth: "60ch" }}>
        For a match that should never have counted — the wrong lineup, a bug, a
        game nobody played. Rating that was applied is reversed through the
        ledger, so the reversal is as visible as the award. To say the other
        side won instead, resolve it as a dispute.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
        <input
          value={matchId}
          onChange={(e) => setMatchId(e.target.value)}
          placeholder={t("Match id")}
          aria-label={t("Match id")}
          style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 12.5, fontFamily: T.mono }}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 200))}
          placeholder={t("Why — this is kept")}
          aria-label={t("Reason")}
          style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 12.5 }}
        />
        <Btn kind="danger" disabled={busy || !matchId.trim() || !reason.trim()} onClick={voidIt} style={{ justifyContent: "center" }}>
          {t("Void this match")}
        </Btn>
      </div>
    </Panel>
  );
}

/** Renaming a team that named itself something nobody can leave up. */
function TeamsPanel({ notify }) {
  const [teams, setTeams] = useState(null);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ name: "", tag: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await server.listTeams();
      setTeams(res.teams ?? []);
    } catch (err) {
      notify(errorText(err, "Could not load teams"));
      setTeams([]);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const save = async (teamId) => {
    setBusy(true);
    try {
      await server.renameTeam(teamId, { name: draft.name.trim(), tag: draft.tag.trim() });
      notify(t("Team renamed"));
      setEditing(null);
      await load();
    } catch (err) {
      notify(errorText(err, "Could not rename that team"));
    } finally {
      setBusy(false);
    }
  };

  if (teams === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  return (
    <Panel pad={0} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${T.line}` }}>
        <Eyebrow style={{ flex: 1 }}>{t("Teams")}</Eyebrow>
        <Btn size="sm" onClick={load} aria-label={t("Refresh")}><RefreshCw size={13} /></Btn>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {teams.map((team) => (
          <div key={team.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderBottom: `1px solid ${T.line}` }}>
            {editing === team.id ? (
              <>
                <input
                  value={draft.tag}
                  onChange={(e) => setDraft((d) => ({ ...d, tag: e.target.value.toUpperCase().slice(0, 4) }))}
                  aria-label={t("Team tag")}
                  style={{ width: 70, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "6px 8px", color: T.text, fontSize: 12, fontFamily: T.mono }}
                />
                <input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.slice(0, 24) }))}
                  aria-label={t("Team name")}
                  style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "6px 8px", color: T.text, fontSize: 12.5 }}
                />
                <Btn size="sm" kind="primary" disabled={busy} onClick={() => save(team.id)}>{t("Save")}</Btn>
                <Btn size="sm" disabled={busy} onClick={() => setEditing(null)}>{t("Cancel")}</Btn>
              </>
            ) : (
              <>
                <div style={{ width: 44, fontFamily: T.mono, fontSize: 11, color: T.muted }}>{team.tag}</div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{team.name}</div>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.dim }}>{team.region.toUpperCase()}</span>
                <Btn size="sm" onClick={() => { setDraft({ name: team.name, tag: team.tag }); setEditing(team.id); }}>{t("Rename")}</Btn>
              </>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * Everything staff have done, newest first.
 *
 * Here because the tab it lives in can rewrite results and move rating, and a
 * power that leaves no visible trace is the kind that gets used quietly. It is
 * as much for the Game Masters as about them: it is the only place to see what
 * a colleague already did about the thing you are looking at.
 */
function AuditPanel({ notify }) {
  const [entries, setEntries] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await server.auditLog(200);
      setEntries(res.entries ?? []);
    } catch (err) {
      notify(errorText(err, "Could not load the log"));
      setEntries([]);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  if (entries === null) {
    return <Panel style={{ height: "100%", display: "grid", placeItems: "center", color: T.dim, fontSize: 12.5 }}>Loading…</Panel>;
  }

  return (
    <Panel pad={0} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${T.line}` }}>
        <Eyebrow style={{ flex: 1 }}>{t("Audit log")}</Eyebrow>
        <Btn size="sm" onClick={load} aria-label={t("Refresh")}><RefreshCw size={13} /></Btn>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {entries.length === 0 ? (
          <div style={{ color: T.dim, fontSize: 12.5, padding: 28, textAlign: "center" }}>Nothing yet.</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 10, padding: "7px 8px", borderBottom: `1px solid ${T.line}`, fontSize: 12 }}>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.dim, whiteSpace: "nowrap", width: 130, flexShrink: 0 }}>
                {new Date(e.createdAt).toLocaleString()}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, width: 150, flexShrink: 0 }}>{e.eventType}</span>
              <span style={{ color: T.muted, width: 110, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.actorName ?? "—"}</span>
              <span style={{ flex: 1, minWidth: 0, color: T.dim, fontFamily: T.mono, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {JSON.stringify(e.payload)}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function ModerationScreen({ me, notify, onView }) {
  const [tab, setTab] = useState("disputes");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {[
          ["disputes", t("Disputes")],
          ["reports", t("Reports")],
          ["players", t("Players")],
          ["matches", t("Matches")],
          ["teams", t("Teams")],
          ["audit", t("Audit")],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{ background: tab === id ? T.raised : "transparent", border: `1px solid ${tab === id ? T.line2 : "transparent"}`, color: tab === id ? T.text : T.muted, borderRadius: 4, padding: "7px 14px", fontSize: 12.5, fontWeight: 600 }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "disputes" && <DisputesScreen me={me} notify={notify} onView={onView} />}
        {tab === "reports" && <ReportsPanel notify={notify} onView={onView} />}
        {tab === "players" && <PlayersPanel me={me} notify={notify} />}
        {tab === "matches" && <MatchesPanel notify={notify} />}
        {tab === "teams" && <TeamsPanel notify={notify} />}
        {tab === "audit" && <AuditPanel notify={notify} />}
      </div>
    </div>
  );
}

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
      notify(errorText(err, "Could not load disputes"));
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
      .catch((err) => { if (!cancelled) notify(errorText(err, "Could not load that match")); });

    return () => { cancelled = true; };
  }, [openId, notify]);

  const open = disputes?.find((d) => d.matchId === openId) ?? null;

  const rule = async () => {
    if (!winner || note.trim().length === 0) return;
    setBusy(true);
    try {
      await server.resolveDispute(openId, winner, note.trim());
      notify(`Ruled for ${winner === "TEAM1" ? "Team 1" : t("Team 2")}`);
      setOpenId(null);
      setWinner(null);
      setNote("");
      await load();
    } catch (err) {
      notify(errorText(err, "Could not record that ruling"));
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
          <Eyebrow>{t("Open disputes")}</Eyebrow>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 4 }}>
            {disputes.length === 0 ? t("Nothing waiting") : `${disputes.length} waiting`}
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
            <H size={22}>{t("Two captains disagree")}</H>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
              {[1, 2].map((team) => {
                const claim = open.reports.find((r) => r.reportingTeam === team);
                return (
                  <div key={team} style={{ background: T.raised, borderRadius: 5, padding: "10px 12px", border: `1px solid ${T.line2}` }}>
                    <Eyebrow style={{ fontSize: 9.5 }}>Team {team}&apos;s captain</Eyebrow>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{displayName(claim) ?? t("never reported")}</div>
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
              <Roster team={detail.team1} captainId={detail.captain1} me={me} side={1} label={t("Team 1")} phase="completed" onView={onView} tier={detail.team1Tier} />
              <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "18px 0" }}>
                <div style={{ flex: 1, height: 1, background: T.line }} />
                <span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 16, color: T.dim, letterSpacing: "0.1em" }}>{t("VS")}</span>
                <div style={{ flex: 1, height: 1, background: T.line }} />
              </div>
              <Roster team={detail.team2} captainId={detail.captain2} me={me} side={2} label={t("Team 2")} phase="completed" onView={onView} tier={detail.team2Tier} />
            </Panel>
          )}

          <Panel pad={20}>
            <Eyebrow style={{ marginBottom: 10 }}>{t("Ruling")}</Eyebrow>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              {[["TEAM1", "Team 1 won"], ["TEAM2", t("Team 2 won")]].map(([value, label]) => (
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
              placeholder={t("What decided it — screenshots, who admitted what, anything the next GM should know")}
              aria-label={t("Ruling note")}
              rows={3}
              style={{ width: "100%", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13, fontFamily: T.body, resize: "none", boxSizing: "border-box" }}
            />
            <Btn
              kind="primary"
              style={{ width: "100%", justifyContent: "center", marginTop: 10 }}
              disabled={busy || !winner || note.trim().length === 0}
              title={!winner ? t("Pick a winner") : note.trim().length === 0 ? t("A ruling needs a reason") : undefined}
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
        notify(errorText(err, "Could not load the ladder"));
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
        <Eyebrow style={{ flex: 1 }}>{t("Ladder")}</Eyebrow>
        <span style={{ fontSize: 11.5, color: T.muted }}>
          {tn("{count} placed player", "{count} placed players", state.total)}
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
                  <Avatar p={{ ...r, avatarColor: AV_COLORS[Math.abs(hashString(r.userId)) % AV_COLORS.length] }} size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                      <PlayerName p={r} suffix={isMe ? <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span> : null} />
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>
                      {[altName(r), r.teamTag].filter(Boolean).join(" · ")}
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
          <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LADDER_PAGE))}>{t("Previous")}</Btn>
          <span style={{ flex: 1, textAlign: "center", fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>
            {offset + 1}–{pageEnd} of {state.total}
          </span>
          <Btn size="sm" disabled={pageEnd >= state.total} onClick={() => setOffset(offset + LADDER_PAGE)}>{t("Next")}</Btn>
        </div>
      )}
    </Panel>
  );
}

/**
 * A new version is out, and there is no way past it.
 *
 * Updates are required rather than offered. Two clients disagreeing about a
 * rule is worse than a restart is inconvenient: the server is the only thing
 * that decides a match, but an old client can misread what it is told, show a
 * rank that no longer means what it says, or keep calling a route that has
 * moved. A version that can be declined is one that stays in the field.
 *
 * It covers the window, starts on its own and has no dismiss. That it can be
 * this blunt is a consequence of when it runs: the check happens once at
 * launch and this renders ahead of the sign-in screen, so there is never a
 * queue, an accept window or a match underneath it to interrupt.
 *
 * Not knowing counts as not current. A check that cannot be made leaves the
 * gate up and retries, rather than letting the app open on a version nothing
 * has vouched for -- otherwise "required" would mean "required unless you can
 * arrange for the check to fail", which is a lower bar than it sounds: an
 * offline machine clears it, and so does one line in a hosts file.
 *
 * The cost is a real dependency, and it should be understood before this is
 * shipped: the app is now unusable while the update endpoint is unreachable,
 * even though matches are served by an entirely different host. A GitHub
 * outage stops play on a server that is up. That is the trade this design
 * makes, and it is only defensible because there is nothing worth reaching
 * here offline -- every screen behind the gate needs the server anyway.
 */
function UpdateGate({ check, onRetry }) {
  const [progress, setProgress] = useState(null);
  const [installError, setInstallError] = useState(null);
  // StrictMode runs effects twice in development. Downloading and running an
  // installer twice is not a harmless repeat, so the start is guarded rather
  // than left to be idempotent.
  const started = useRef(false);

  const update = check.update ?? null;

  const install = useCallback(async () => {
    if (!update) return;
    setInstallError(null);
    setProgress(null);
    try {
      // Normally never returns -- the relaunch replaces this process.
      await installUpdate(update, setProgress);
    } catch (err) {
      setInstallError(errorText(err, "The update could not be installed"));
    }
  }, [update]);

  useEffect(() => {
    if (!update || started.current) return;
    started.current = true;
    void install();
  }, [update, install]);

  const pct = progress === null ? null : Math.round(progress * 100);
  const stalled = check.phase === "failed" || check.phase === "rejected" || installError !== null;
  const required = check.phase === "found" || check.phase === "rejected";

  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: T.bg, padding: 24, boxSizing: "border-box" }}>
      <div style={{ width: 430, maxWidth: "100%", background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: "22px 24px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 13 }}>
          <Dot color={stalled ? T.danger : T.accent} pulse={!stalled} />
          <span style={{ fontFamily: T.display, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.02em" }}>
            {required ? t("Update required") : t("Checking for updates")}
          </span>
        </div>

        {check.phase === "checking" && (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: T.muted }}>
            {t("Making sure this copy is current.")}
          </p>
        )}

        {check.phase === "failed" && (
          <>
            <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.5, color: T.text }}>
              {t("Cannot reach the update service, so there is no way to tell whether this copy is current. It will keep trying.")}
            </p>
            <p style={{ margin: "0 0 16px", fontSize: 12.5, lineHeight: 1.5, color: T.danger }}>{check.error}</p>
            <Btn kind="primary" onClick={onRetry}>{t("Try again")}</Btn>
          </>
        )}

        {check.phase === "rejected" && (
          <>
            <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: T.text }}>
              {check.minimum
                ? t("The server is serving version {minimum} and will not accept version {current}. There is nothing to do here but update.", { minimum: check.minimum, current: CLIENT_VERSION ?? "unknown" })
                : t("The server will not accept this version. There is nothing to do here but update.")}
            </p>
            <Btn kind="primary" onClick={onRetry}>{t("Check for update")}</Btn>
          </>
        )}

        {check.phase === "found" && (
          <>
            <p style={{ margin: "0 0 18px", fontSize: 13, lineHeight: 1.5, color: T.text }}>
              {t("Version {version} has to be installed before you can play. The app restarts itself when it is done.", { version: update.version })}
            </p>

            {installError ? (
              <>
                <p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.5, color: T.danger }}>{installError}</p>
                <Btn kind="primary" onClick={install}>{t("Try again")}</Btn>
              </>
            ) : (
              <>
                <div style={{ height: 6, borderRadius: 3, background: T.raised, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: pct === null ? "100%" : `${pct}%`, background: T.accent, opacity: pct === null ? 0.4 : 1, transition: "width 160ms linear" }} />
                </div>
                <div style={{ marginTop: 9, fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>
                  {pct === null
                    ? t("Downloading {version}…", { version: update.version })
                    : t("Downloading {version} — {pct}%", { version: update.version, pct })}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Asked once a launch, until it is answered.
 *
 * The name is how nine other people find you once the match starts, so an
 * account without one is a party-up screen telling everybody to add a name
 * that does not exist in the game. Dismissable, because interrupting someone
 * on their way to a queue is not the way to make them like the app -- the
 * banner on the play screen carries it from here.
 */
function NamePrompt({ onSaved, onLater, notify }) {
  const config = useConfig();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = draft.trim();
  const valid = trimmed.length >= IGN_MIN && trimmed.length <= IGN_MAX;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await server.setInGameName(trimmed);
      await onSaved?.();
    } catch (err) {
      notify?.(errorText(err, "Could not save that name"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 76, animation: "sqIn .2s ease" }}>
      <div role="dialog" aria-label={t("Set your in-game name")} style={{ width: 400, maxWidth: "90vw" }}>
        <Panel pad={20}>
          <Eyebrow style={{ marginBottom: 6 }}>{t("One thing first")}</Eyebrow>
          <H size={21}>{t("What are you called in-game?")}</H>
          <div style={{ fontSize: 13, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
            This is the name your team looks for once a match starts. It is not
            checked against the game, so type it exactly as it appears there.
          </div>

          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, IGN_MAX))}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            aria-label={t("In-game name")}
            placeholder={`Your name in ${config.gameName}`}
            style={{ width: "100%", boxSizing: "border-box", marginTop: 16, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "9px 11px", color: T.text, fontFamily: T.mono, fontSize: 13.5 }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
            <Btn kind="primary" disabled={!valid || busy} onClick={save} style={{ flex: 1, justifyContent: "center" }}>{t("Save it")}</Btn>
            <Btn kind="quiet" disabled={busy} onClick={onLater}>{t("Later")}</Btn>
          </div>
          <div style={{ fontSize: 11.5, color: T.dim, marginTop: 8 }}>
            {IGN_MIN}–{IGN_MAX} characters. You can change it any time on your profile.
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * Your in-game name, which only you can set.
 *
 * Nothing verifies this against the game -- it is how teammates find you
 * once they are in the game, not an identity. Which is exactly why it has to be
 * easy to fix: a typo here means nine people looking for a name that does not
 * exist.
 */
function InGameNameField({ value, onSaved, notify }) {
  const config = useConfig();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(value ?? ""); }, [value]);

  const trimmed = draft.trim();
  const valid = trimmed.length >= IGN_MIN && trimmed.length <= IGN_MAX;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await server.setInGameName(trimmed);
      await onSaved?.();
      setEditing(false);
    } catch (err) {
      notify?.(errorText(err, "Could not save that name"));
    } finally {
      setBusy(false);
    }
  };

  // Not editing: nothing but the way in. The name itself is the heading this
  // sits beside -- printing it again here, under a Discord name, was three
  // lines to say one thing.
  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        aria-label={t("Change your in-game name")}
        style={{ background: "transparent", border: `1px solid ${T.line2}`, borderRadius: 4, color: value ? T.muted : T.captain, fontSize: 11.5, fontWeight: 600, padding: "3px 8px", whiteSpace: "nowrap" }}
      >
        {value ? t("Change") : t("Set in-game name")}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, IGN_MAX))}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); }
        }}
        aria-label={t("In-game name")}
        placeholder={`Your name in ${config.gameName}`}
        style={{ background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "6px 9px", color: T.text, fontFamily: T.mono, fontSize: 12.5, width: 190 }}
      />
      <Btn size="sm" kind="primary" disabled={!valid || busy} onClick={save}>{t("Save")}</Btn>
      <Btn size="sm" kind="quiet" disabled={busy} onClick={() => { setDraft(value ?? ""); setEditing(false); }}>{t("Cancel")}</Btn>
      {!valid && draft.length > 0 && (
        <span style={{ fontSize: 11, color: T.dim }}>{IGN_MIN}–{IGN_MAX} characters</span>
      )}
    </div>
  );
}

function ProfileScreen({ p, me, history, onBack, onViewMatch, onSaved, notify }) {
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

  /**
   * Re-reads the fetched half.
   *
   * Needed on save as well as on arrival, because what is on screen is the
   * handed-in player with this spread over the top -- so a name changed here
   * stays hidden behind the copy fetched a moment ago until something
   * remounts the screen. Refreshing the player alone was not enough, and the
   * symptom was a rename that only appeared after switching tabs.
   */
  const loadFull = useCallback(
    (id) =>
      server
        .playerProfile(id)
        .then(setFull)
        .catch(() => {
          // Fall back to what we arrived with; it is thinner, not wrong.
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setFull(null);
    void server
      .playerProfile(p.id)
      .then((res) => { if (!cancelled) setFull(res); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [p.id]);

  const view = { ...p, ...(full ?? {}) };
  const total = (view.wins ?? 0) + (view.losses ?? 0);

  /**
   * Their matches, or yours.
   *
   * Yours is already loaded by the shell, so it is passed straight through.
   * Theirs is fetched, and carries no more than yours does: the result and the
   * side, never a rating delta -- a run of point swings reconstructs the
   * number a rank is there to stand in for.
   */
  const [theirHistory, setTheirHistory] = useState([]);
  const [openTeam, setOpenTeam] = useState(null);

  useEffect(() => {
    if (isMe) return;
    let cancelled = false;
    setTheirHistory([]);
    server
      .playerHistory(p.id)
      .then((rows) => { if (!cancelled) setTheirHistory(toHistoryRows(rows)); })
      .catch(() => {
        // The profile is still worth showing without it.
      });
    return () => { cancelled = true; };
  }, [p.id, isMe]);

  const ownHistory = isMe ? history : theirHistory;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel pad={20}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Avatar p={view} size={64} />
            <div style={{ flex: 1 }}>
              {/* The name, and next to it the one control that changes it.
                  Both live on the same line because they are the same subject:
                  reading your name and correcting it is one thought. */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <H size={26}><PlayerName p={view} /></H>
                {isMe && <Tag color={T.accent}>{t("You")}</Tag>}
                {!isMe && <ReportPlayer player={{ id: p.id }} notify={notify} />}
                {isMe && (
                  <InGameNameField
                    value={view.inGameName ?? null}
                    onSaved={async () => {
                      // Both halves: the player this screen was handed, and the
                      // profile fetched over the top of it. Refreshing one alone
                      // leaves the other to overwrite it with the old name.
                      await onSaved?.();
                      await loadFull(p.id);
                    }}
                    notify={notify}
                  />
                )}
              </div>

              {/* Both names, on your own profile as much as anyone else's.
                  The heading is what people call you; this is the account it
                  is attached to, and a profile is the one screen where how you
                  signed in is worth knowing. It is omitted only when it would
                  repeat the heading, which is the case for somebody who has
                  not set an in-game name yet. */}
              {altName(view) && (
                <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, marginTop: 4 }}>{altName(view)} · Discord</div>
              )}

            </div>
            <div style={{ textAlign: "right" }}>
              <Tier tier={view.tier} size={40} />
              {view.position && (
                <Eyebrow style={{ marginTop: 2 }}>#{view.position} on the ladder</Eyebrow>
              )}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginTop: 20 }}>
            {[[t("Rank"), view.tier ?? (view.placementsRemaining > 0 ? `${view.placementsRemaining} to go` : "—")], [t("Peak"), view.peakTier ?? "—"], [t("Matches"), view.gamesPlayed ?? total], [t("Record"), `${view.wins ?? 0}–${view.losses ?? 0}`], [t("Win rate"), winRate(view.wins ?? 0, view.losses ?? 0)]].map(([k, v]) => (
              <div key={k} style={{ background: T.raised, borderRadius: 4, padding: "10px 12px" }}><Eyebrow style={{ fontSize: 9.5 }}>{k}</Eyebrow><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 600, marginTop: 4 }}>{v}</div></div>
            ))}
          </div>
        </Panel>
        <Panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>{t("Match history")}</Eyebrow>
          {ownHistory.length === 0 && (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
              {isMe ? t("No finished matches yet.") : t("They have no finished matches yet.")}
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
          <Eyebrow style={{ marginBottom: 8 }}>{t("Reliability")}</Eyebrow>
          {full ? (
            [[t("Disputes"), full.disputesInvolved, full.disputesInvolved ? T.captain : T.ok], [t("Missed accepts"), full.missedAccepts, full.missedAccepts ? T.captain : T.ok], [t("Longest streak"), full.longestWinStreak, T.muted]].map(([k, v, c]) => (
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
            <Eyebrow style={{ marginBottom: 6 }}>{t("Team")}</Eyebrow>
            {/* Opens the same roster the directory does. Somebody looking at a
                player and wondering who they play with should not have to go
                to another tab and find the team by name. */}
            <div
              className="row-hover"
              onClick={() => setOpenTeam(full.team.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", borderRadius: 4, padding: 4, margin: -4 }}
            >
              <div style={{ width: 30, height: 30, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 10, color: T.muted, border: `1px solid ${T.line2}` }}>{full.team.tag}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{full.team.name}</div>
                <div style={{ fontSize: 11, color: T.muted }}>{full.team.role}</div>
              </div>
            </div>
          </Panel>
        )}
        {!isMe && <Btn onClick={onBack} style={{ justifyContent: "center" }}>← Back</Btn>}
        <Panel><Eyebrow style={{ marginBottom: 6 }}>{t("Public profile")}</Eyebrow><div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>{t("This same record is visible on the public profile page. Only matchmaker data is shown — no in-game stats.")}</div></Panel>
      </div>

      {openTeam && (
        <TeamDetail
          teamId={openTeam}
          me={me}
          myApplication={null}
          busy={false}
          onClose={() => setOpenTeam(null)}
          onApply={() => setOpenTeam(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   MATCH FLOW: accept overlay → match screen
   ───────────────────────────────────────────────────────────── */
function AcceptOverlay({ match, onAccepted, onFail }) {
  const config = useConfig();
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
        <Eyebrow color={T.accent} style={{ marginBottom: 8 }}>{match.type} · {match.region.toUpperCase()} · {config.teamSize}v{config.teamSize}</Eyebrow>
        <H size={34}>{t("Match found")}</H>
        <div style={{ position: "relative", width: 140, height: 140, margin: "24px auto" }}>
          <svg width="140" height="140" viewBox="0 0 140 140" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="70" cy="70" r={R} stroke={T.line2} strokeWidth="6" fill="none" />
            <circle cx="70" cy="70" r={R} stroke={left <= 5 ? T.danger : T.accent} strokeWidth="6" fill="none" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s linear, stroke .3s" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <div><div style={{ fontFamily: T.mono, fontSize: 40, fontWeight: 600, lineHeight: 1, color: left <= 5 ? T.danger : T.text }}>{Math.max(0, left)}</div><Eyebrow style={{ marginTop: 4 }}>{t("seconds")}</Eyebrow></div>
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
            <Btn kind="ghost" style={{ padding: "12px 20px" }} onClick={async () => { try { await server.decline(match.id); } catch { /* the sweeper cancels it regardless */ } done.current = true; onFail(); }}>{t("Decline")}</Btn>
          </div>
        ) : <div style={{ color: T.accent, fontSize: 13, display: "inline-flex", gap: 8, alignItems: "center" }}><Dot pulse /> Waiting for others…</div>}
        <div style={{ marginTop: 18, fontSize: 12, color: T.dim }}>{t("Not accepting in time puts you on a queue cooldown. Everyone else goes back to the front of the queue.")}</div>
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
              {cap && <div style={{ position: "absolute", top: -9, left: "50%", transform: "translateX(-50%)", background: T.captain, color: "#160E00", fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.1em", padding: "2px 7px", borderRadius: 3, fontWeight: 700 }}>{t("CAPTAIN")}</div>}
              <Avatar p={p} size={40} ring={cap ? T.captain : isMe ? T.accent : null} />
              {/* Monospaced because this is a string you retype into another
                  program, and a proportional font makes l and 1 an argument. */}
              <div style={{ fontFamily: T.mono, fontSize: 11.5, fontWeight: 600, letterSpacing: "0.02em", textAlign: "center", maxWidth: "100%" }}><PlayerName p={p} suffix={isMe ? " (you)" : ""} /></div>
              {altName(p) && <div style={{ fontSize: 11, color: T.muted, textAlign: "center", maxWidth: "100%", whiteSpace: "nowrap" }}>{altName(p)}</div>}
              <Rank tier={p.tier} placementsRemaining={p.placementsRemaining} size={11} />
              {cap && phase === "party" && isMySide && !isMe && <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(p.inGameName); }} title={t("Copy your captain's in-game name")} style={{ marginTop: 2, background: "transparent", border: `1px solid ${T.captain}`, color: T.captain, borderRadius: 3, fontSize: 10.5, padding: "3px 8px", display: "inline-flex", gap: 4, alignItems: "center", fontFamily: T.mono }}><Copy size={10} /> copy name</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchHistoryModal({ m, me, onClose, onView }) {
  const onTeam1 = m.team1.some((p) => p.id === me.id);
  const resultLabel = m.result === "win" ? "Victory" : m.result === "loss" ? "Defeat" : m.state === "in dispute" ? t("In dispute") : t("Match");
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
          <Roster team={m.team1} captainId={m.captain1} me={me} side={1} label={onTeam1 ? t("Your team") : "Team 1"} phase="completed" onView={onView} tier={m.team1Tier} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "22px 0" }}><div style={{ flex: 1, height: 1, background: T.line }} /><span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 18, color: T.dim, letterSpacing: "0.1em" }}>{t("VS")}</span><div style={{ flex: 1, height: 1, background: T.line }} /></div>
          <Roster team={m.team2} captainId={m.captain2} me={me} side={2} label={onTeam1 ? t("Opponents") : "Your team"} phase="completed" onView={onView} tier={m.team2Tier} />
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
        const who = { discordName: m.discordName, inGameName: m.inGameName, avatarUrl: m.avatarUrl, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] };
        return (
          <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", animation: "sqRise .2s ease" }}>
            <div onClick={() => onView?.({ id: m.userId })} style={{ cursor: onView ? "pointer" : "default", flexShrink: 0 }}>
              <Avatar p={who} size={22} />
            </div>
            <div style={{ minWidth: 0 }}>
              <span onClick={() => onView?.({ id: m.userId })} style={{ fontSize: 12, fontWeight: 700, color: mine ? T.accent : T.text, cursor: onView ? "pointer" : "default" }}><PlayerName p={m} /></span>{" "}
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
        {[["team", t("Team")], ["match", t("Match")]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `2px solid ${tab === id ? T.accent : "transparent"}`, color: tab === id ? T.text : T.muted, padding: "10px 4px", fontSize: 12, fontWeight: 600 }}>{label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <ChatLog
          messages={messages}
          me={me}
          onView={onView}
          empty={tab === "team" ? t("Nothing said yet. Only your five can read this.") : t("Nothing said yet. All ten can read this.")}
        />
      </div>
      <ChatComposer onSend={send} placeholder={tab === "team" ? t("Message your team…") : t("Message the match…")} />
      <div style={{ padding: "4px 10px 8px", fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>{t("chat is not saved")}</div>
    </Panel>
  );
}

function MatchScreen({ match, me, onFinished, notify, onView }) {
  const config = useConfig();
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
      notify(errorText(err, "Could not send that report"));
    }
  };

  /**
   * Takes it back, while there is still something to take back.
   *
   * Reporting the wrong way round could already be corrected by reporting
   * again, but reporting the wrong *match* -- or reporting while the other
   * side is still playing -- had no way out. The server refuses once both
   * captains have spoken, because by then the result is agreed or disputed and
   * neither is one captain's to undo.
   */
  const cancelReport = async () => {
    try {
      await server.withdrawReport(match.id);
      setMyReport(null);
      setPhase("live");
    } catch (err) {
      notify(errorText(err, "Could not cancel that report"));
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
    if (!rankMove) return t("Both captains agree. Your rank has been updated.");
    const { tierBefore, tierAfter, placementsRemaining } = rankMove;
    if (!tierAfter) {
      return placementsRemaining > 0
        ? tn(
          "Both captains agree. {count} placement match to go before you are ranked.",
          "Both captains agree. {count} placement matches to go before you are ranked.",
          placementsRemaining,
        )
        : t("Both captains agree.");
    }
    if (!tierBefore) return `Both captains agree. Placements complete — you are ${tierAfter}.`;
    if (tierBefore === tierAfter) return `Both captains agree. You are still ${tierAfter}.`;
    const order = config.tiers;
    return `Both captains agree. ${order.indexOf(tierAfter) > order.indexOf(tierBefore) ? t("Promoted") : t("Demoted")} to ${tierAfter}.`;
  })();

  const banner = {
    party: { color: T.captain, title: t("Party up"), sub: iAmCaptain ? t("You're the captain — your teammates add you in-game and join your party. Queue starts in") : `Add ${cap?.inGameName ?? "your captain"} — your captain — in-game and join their party. Queue starts in` },
    queue: { color: T.accent, title: t("Queue casual now"), sub: t("Both captains hit Casual queue on this signal. Stay in party.") },
    live: { color: T.accent, title: t("Match in progress"), sub: iAmCaptain ? t("When it ends, report the result below.") : t("Your captain reports the result when the match ends.") },
    reported: { color: T.muted, title: t("Waiting for the other captain"), sub: `You reported a ${myReport}. Awaiting the other side's report.` },
    completed: { color: T.ok, title: outcome === "win" ? "Victory" : t("Defeat"), sub: match.type === "SCRIM" ? t("Both captains agree. Scrims are unrated — no rank change.") : rankSummary },
    dispute: { color: T.captain, title: t("In dispute"), sub: "Captains reported different results. A mod will resolve this with both teams — this stays open until then." },
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
          {phase === "queue" && <div style={{ fontFamily: T.display, fontWeight: 800, fontSize: 30, color: T.accent, textTransform: "uppercase", animation: "sqPulse 1s infinite" }}>{t("Queue")}</div>}
          {phase === "live" && !iAmCaptain && <Tag>{t("Captain reports")}</Tag>}
          {phase === "reported" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Dot pulse color={T.muted} />
              {/* Only the captain who sent it, and only while the other side
                  has not answered -- which is exactly when the server will
                  still allow it. */}
              {iAmCaptain && myReport && (
                <Btn size="sm" onClick={cancelReport}>{t("Cancel report")}</Btn>
              )}
            </div>
          )}
          {(phase === "completed" || phase === "dispute") && <Btn kind="primary" onClick={() => onFinished({ outcome, disputed: phase === "dispute" })}>Back to lobby <ChevronRight size={14} /></Btn>}
        </div>
        {phase === "live" && iAmCaptain && (
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <button onClick={() => report("win")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: T.ok, color: "#07110F", border: "none", borderRadius: 6, padding: "16px 20px", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", animation: "sqGlow 1.8s ease-in-out infinite" }}><Trophy size={20} /> We won</button>
            <button onClick={() => report("loss")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: T.dangerDim, color: T.danger, border: `2px solid ${T.danger}`, borderRadius: 6, padding: "16px 20px", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em" }}>{t("We lost")}</button>
          </div>
        )}
      </Panel>

      <Panel pad={20} style={{ flexShrink: 0, maxHeight: "60%", overflow: "auto" }}>
        <Roster team={match.team1} captainId={match.captain1} me={me} side={1} label={myTeamIsOne ? t("Your team") : t("Team 1")} phase={phase} onView={onView} tier={match.team1Tier} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "22px 0" }}><div style={{ flex: 1, height: 1, background: T.line }} /><span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 18, color: T.dim, letterSpacing: "0.1em" }}>{t("VS")}</span><div style={{ flex: 1, height: 1, background: T.line }} /></div>
        <Roster team={match.team2} captainId={match.captain2} me={me} side={2} label={myTeamIsOne ? t("Opponents") : t("Your team")} phase={phase} onView={onView} tier={match.team2Tier} />
        {(phase === "reported" || phase === "completed" || phase === "dispute") && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 20 }}>
            {[[t("Your captain reported"), myReport], [t("Their captain reported"), theirReport]].map(([k, v]) => (
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
  const config = useConfig();
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
        : all.length >= config.teamSize
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
      notify(errorText(err, "Could not confirm that lineup"));
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 72, animation: "sqIn .2s ease" }}>
      <div role="dialog" aria-modal="true" aria-label={t("Confirm your lineup")} style={{ width: 460, maxWidth: "90vw" }}>
        <Panel pad={20}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Eyebrow style={{ marginBottom: 6 }}>Scrim vs {pending.opponentTag}</Eyebrow>
              <H size={22}>{t("Who is playing?")}</H>
              <div style={{ fontSize: 12.5, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
                Five of {pending.roster.length}. Your starters are picked already — change them if
                you like.
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 30, fontWeight: 600, lineHeight: 1, color: left <= 10 ? T.danger : T.accent }}>{left}</div>
              <Eyebrow style={{ marginTop: 2 }}>{t("seconds")}</Eyebrow>
            </div>
          </div>

          <div style={{ maxHeight: "42vh", overflow: "auto", marginBottom: 14 }}>
            {pending.roster.map((r) => {
              const on = picked.includes(r.userId);
              const blocked = !on && picked.length >= config.teamSize;
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
                  <Avatar p={{ ...r, avatarColor: AV_COLORS[Math.abs(hashString(r.userId)) % AV_COLORS.length] }} size={26} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      <PlayerName p={r} />
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{altName(r)}</div>
                  </div>
                  {r.isStarter && <Tag color={T.ok}>{t("Starter")}</Tag>}
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
            {full ? t("Confirm the lineup") : `${picked.length}/${config.teamSize} picked`}
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
              <Avatar p={{ discordName: inv.fromName, avatarUrl: inv.fromAvatarUrl, avatarColor: AV_COLORS[Math.abs(hashString(inv.fromUserId)) % AV_COLORS.length] }} size={24} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}><PlayerName name={inv.fromName} isGameMaster={inv.fromIsGameMaster} /></div>
                <div style={{ fontSize: 11, color: T.muted }}>{t("invited you to their party")}</div>
              </div>
              <Tier tier={inv.fromTier} size={12} />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Btn size="sm" kind="primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => onAccept(inv)}>{t("Join")}</Btn>
              <Btn size="sm" style={{ justifyContent: "center" }} onClick={() => onDecline(inv)}>{t("Decline")}</Btn>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: left <= 5 ? T.danger : T.dim, minWidth: 24, textAlign: "right" }}>{left}s</span>
            </div>
          </div>
        );
      })}
      {hidden > 0 && (
        <div style={{ pointerEvents: "none", background: T.raised, border: `1px solid ${T.line}`, borderRadius: 4, padding: "6px 10px", fontSize: 11.5, color: T.muted, textAlign: "center" }}>
          {tn("+{count} more invite waiting", "+{count} more invites waiting", hidden)}
        </div>
      )}
    </div>
  );
}

/**
 * Reporting somebody, from their profile.
 *
 * One per player and rewritable, so this opens filled in with whatever you
 * said last time rather than pretending you have not been here before. The
 * point of allowing the edit is that the useful version of a report is usually
 * the second one -- written once you have stopped being angry and can say what
 * actually happened.
 *
 * Nothing here punishes anybody, and the copy says so. A report that reads as
 * a punish button gets used as one.
 */
function ReportPlayer({ player, notify }) {
  const [existing, setExisting] = useState(undefined); // undefined = still asking
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setExisting(undefined);
    server
      .myReportOf(player.id)
      .then((res) => { if (!cancelled) setExisting(res?.report ?? null); })
      .catch(() => { if (!cancelled) setExisting(null); });
    return () => { cancelled = true; };
  }, [player.id]);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await server.reportPlayer(player.id, draft.trim());
      setExisting(saved);
      setOpen(false);
      notify(t("Reported. A Game Master will look."));
    } catch (err) {
      notify(errorText(err, "Could not send that report"));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    try {
      await server.withdrawPlayerReport(player.id);
      setExisting(null);
      setOpen(false);
      notify(t("Report withdrawn"));
    } catch (err) {
      notify(errorText(err, "Could not withdraw that report"));
    } finally {
      setBusy(false);
    }
  };

  if (existing === undefined) return null;

  if (!open) {
    return (
      <Btn
        size="sm"
        onClick={() => { setDraft(existing?.reason ?? ""); setOpen(true); }}
        style={existing ? { borderColor: T.captain, color: T.captain } : undefined}
      >
        <AlertTriangle size={12} /> {existing ? t("Reported") : t("Report")}
      </Btn>
    );
  }

  // A modal, not a panel that shoves the profile down the page. Reporting is a
  // deliberate act with a decision at the end of it, and a form that appears
  // inline reads as another field on the page rather than something to finish.
  return (
    <div
      style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 70, animation: "sqIn .2s ease" }}
      onClick={() => setOpen(false)}
    >
    <Panel pad={16} style={{ width: 460, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <Eyebrow style={{ flex: 1 }}>
          {existing ? t("Your report") : t("Report this player")}
        </Eyebrow>
        <button onClick={() => setOpen(false)} aria-label={t("Close")} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}>
          <X size={15} />
        </button>
      </div>
      <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, marginBottom: 8 }}>
        {t("Say what happened. This goes to a Game Master to read; it does nothing on its own.")}
      </div>
      <textarea
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value.slice(0, REPORT_REASON_MAX))}
        aria-label={t("What happened")}
        rows={3}
        style={{ width: "100%", boxSizing: "border-box", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 12.5, fontFamily: T.body, resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <Btn size="sm" kind="primary" disabled={busy || draft.trim().length < 3} onClick={save}>
          {existing ? t("Update report") : t("Send report")}
        </Btn>
        <Btn size="sm" disabled={busy} onClick={() => setOpen(false)}>{t("Cancel")}</Btn>
        <div style={{ flex: 1 }} />
        {existing && (
          <Btn size="sm" kind="danger" disabled={busy} onClick={withdraw}>{t("Withdraw")}</Btn>
        )}
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.dim }}>
          {draft.trim().length}/{REPORT_REASON_MAX}
        </span>
      </div>
    </Panel>
    </div>
  );
}

/**
 * A team, opened from the directory.
 *
 * The list could say a tag, a name and a headcount, and that is not enough to
 * decide whether to apply to somewhere -- who is on it, what ranks, and what
 * they say about themselves are the things you actually want. Fetched rather
 * than passed down, because the row carries a summary and this needs the
 * roster.
 */
function TeamDetail({ teamId, me, onClose, onView, onApply, myApplication, busy }) {
  const [team, setTeam] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    server
      .team(teamId)
      .then((res) => { if (!cancelled) setTeam(res); })
      .catch((err) => { if (!cancelled) setError(errorText(err, "Could not load that team")); });
    return () => { cancelled = true; };
  }, [teamId]);

  const mine = team?.members?.some((m) => m.userId === me.id);

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 70, animation: "sqIn .2s ease" }} onClick={onClose}>
      <Panel pad={0} style={{ width: 560, maxWidth: "92vw", maxHeight: "84vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
          <div style={{ width: 36, height: 36, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 11, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{team?.tag ?? "…"}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 17 }}>{team?.name ?? t("Loading…")}</div>
            {team && <Eyebrow>{team.region.toUpperCase()} · {tn("{count} player", "{count} players", team.members.length)}</Eyebrow>}
          </div>
          <button onClick={onClose} aria-label={t("Close")} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={16} /></button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
          {error && <div style={{ color: T.danger, fontSize: 12.5 }}>{error}</div>}

          {team?.note && (
            <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 5, padding: "10px 12px", marginBottom: 14, fontSize: 12.5, lineHeight: 1.55, color: "#C3CAD4", whiteSpace: "pre-wrap" }}>
              {team.note}
            </div>
          )}

          {team?.members?.map((m) => (
            <div key={m.userId} className="row-hover" onClick={() => onView?.({ id: m.userId })} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 4, cursor: "pointer" }}>
              <Avatar p={{ ...m, id: m.userId, avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length] }} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  <PlayerName p={m} suffix={m.userId === me.id ? <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span> : null} />
                </div>
                {altName(m) && <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{altName(m)}</div>}
              </div>
              {m.isStarter && <Tag color={T.accent}>{t("Starter")}</Tag>}
              {m.role !== "member" && <Tag color={m.role === "captain" ? T.captain : T.muted}>{m.role === "captain" ? t("Captain") : t("Officer")}</Tag>}
              <Rank tier={m.tier} placementsRemaining={m.placementsRemaining} size={11} />
            </div>
          ))}
        </div>

        {team && !mine && (
          <div style={{ padding: 14, borderTop: `1px solid ${T.line}` }}>
            <Btn
              kind={team.applicationsOpen ? "primary" : "ghost"}
              style={{ width: "100%", justifyContent: "center" }}
              disabled={busy || !team.applicationsOpen || !!myApplication}
              title={myApplication ? t("Withdraw your other application first") : undefined}
              onClick={() => onApply(team)}
            >
              {team.applicationsOpen ? t("Apply to this team") : t("Applications closed")}
            </Btn>
          </div>
        )}
      </Panel>
    </div>
  );
}

function InviteModal({ party, onClose, notify }) {
  const config = useConfig();
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
      setError(errorText(err, "Could not load the player list"));
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
  const partyFull = party.length >= config.maxPartySize;

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
      notify(`Invited ${displayName(p)}`);
    } catch (err) {
      if (err?.status === 429) {
        const seconds = Number(/(\d+)s/.exec(err.message ?? "")?.[1] ?? 60);
        setSent((s) => ({ ...s, [p.id]: Date.now() + seconds * 1000 }));
      }
      notify(errorText(err, "Could not send that invite"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 70, animation: "sqIn .2s ease" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("Invite to party")} style={{ width: 520, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <Panel pad={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${T.line}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Eyebrow>{t("Invite to party")}</Eyebrow>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>
                {party.length}/{config.maxPartySize} in your party
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
              placeholder={t("Search players…")}
              aria-label={t("Search players")}
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
                {query.trim() ? `Nobody online matches “${query.trim()}”.` : t("Nobody else is online right now.")}
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
                      <div style={{ fontWeight: 600, fontSize: 13 }}><PlayerName p={p} /></div>
                      <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{altName(p)}</div>
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
        <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.text }}>{t("Party chat")}</div>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <ChatLog messages={messages} me={me} onView={onView} empty={t("Nothing said yet. Only your party can read this.")} />
      </div>
      <ChatComposer onSend={send} placeholder={t("Message your party…")} />
      <div style={{ padding: "4px 10px 8px", fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>{t("chat is not saved")}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   APP SHELL
   ───────────────────────────────────────────────────────────── */
export default function App() {
  /**
   * Redraw everything when the language changes.
   *
   * t() is a plain function, so React has no idea its output depends on
   * anything -- which is what keeps call sites readable. The trade is that
   * something has to force the tree to render again, and this is it. Changing
   * language is rare enough that redrawing wholesale costs nothing.
   */
  const [, setLocaleTick] = useState(currentLocale());
  useEffect(() => onLocaleChange(setLocaleTick), []);

  /**
   * What this deployment is, asked for once on start.
   *
   * The binary is the same wherever it is pointed, so the shape of a match,
   * the regions and the rank names are the server's to state. Until it
   * answers -- or if it never does -- the defaults render, which is the
   * difference between a first paint and a blank window.
   */
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  useEffect(() => {
    let cancelled = false;
    server
      .config()
      .then((c) => { if (!cancelled && c) setConfig({ ...DEFAULT_CONFIG, ...c }); })
      .catch(() => {
        // Unreachable server: the sign-in screen is about to say so anyway,
        // and guessing wrong here is better than rendering nothing.
      });
    return () => { cancelled = true; };
  }, []);

  const [me, setMe] = useState(null);
  const [nav, setNav] = useState("play");
  // Null until the socket says otherwise: zeroes would read as an empty
  // playerbase during the moment before the first push lands.
  const [pop, setPop] = useState(null);
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
  // Deliberately not persisted. Putting it off should last until the app is
  // next opened, not for ever -- the banner is the gentle version, this is the
  // one that gets seen.
  const [namePutOff, setNamePutOff] = useState(false);
  // "checking" until the answer is known, then "clear" to open the app,
  // "found" to install, or "failed" to keep trying. Everything but "clear"
  // holds the gate up.
  const [updateCheck, setUpdateCheck] = useState({ phase: "checking" });
  const [recheck, setRecheck] = useState(0);

  // The check at launch. The retry inside it runs only while the answer is
  // still unknown, and stops for good the moment one arrives; the periodic
  // re-check further down is a separate thing.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let attempt = 0;

    const ask = async () => {
      try {
        const found = await checkForUpdate();
        if (cancelled) return;
        setUpdateCheck(found ? { phase: "found", update: found } : { phase: "clear" });
      } catch (err) {
        if (cancelled) return;
        attempt += 1;
        setUpdateCheck({ phase: "failed", error: errorText(err, "Could not reach the update service") });
        // Backing off rather than hammering: the usual cause is a network that
        // is not there yet, and a laptop opening its lid should not spend its
        // first minute making a request a second.
        timer = setTimeout(ask, Math.min(30_000, 2_000 * 2 ** (attempt - 1)));
      }
    };

    void ask();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [recheck]);

  // The button on the gate, for someone who has just fixed their connection
  // and would rather not wait out the backoff.
  const retryUpdateCheck = useCallback(() => {
    setUpdateCheck({ phase: "checking" });
    setRecheck((n) => n + 1);
  }, []);

  /**
   * And again while it runs, because a client left open for a week is exactly
   * the one most likely to be out of date.
   *
   * This was once-a-launch on the reasoning that a timer could only raise the
   * gate over a live match. That reasoning does not survive the server having
   * a version floor: an out-of-date client is refused on its next call
   * whatever it is doing, so the interruption happens regardless. The only
   * question is whether it arrives as a gate that can install the update, or
   * as an app that has stopped working -- and the first is plainly better.
   *
   * Quiet in both directions it can be quiet. It never shows "checking", so a
   * routine look does not blank a working app; and unlike at launch, a check
   * that fails is dropped rather than gating. Not knowing is a reason not to
   * open, but it is not a reason to close something already open and working.
   */
  useEffect(() => {
    if (updateCheck.phase !== "clear") return;

    const id = setInterval(() => {
      checkForUpdate()
        .then((found) => { if (found) setUpdateCheck({ phase: "found", update: found }); })
        .catch(() => {});
    }, UPDATE_RECHECK_MS);

    return () => clearInterval(id);
  }, [updateCheck.phase]);

  /**
   * No reloading the shipped app.
   *
   * A webview reload is a page refresh, and the app is not a page: it drops
   * the socket, throws away everything the session had learned, and comes back
   * mid-flight while the server is still deciding whether that disconnect
   * meant anything. Nothing here is fixed by a reload that is not better fixed
   * by reopening the app, so the shortcut only ever finds bugs on the way past.
   *
   * Dev keeps it, because the whole point there is reloading.
   */
  useEffect(() => {
    if (import.meta.env?.DEV) return;

    const swallow = (e) => {
      const reload = e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r");
      if (reload) e.preventDefault();
    };

    /**
     * And the webview's own right-click menu.
     *
     * It offers Back, Refresh, Save as, Print and Share -- a browser's menu on
     * something that is not a browser. Every entry is either meaningless here
     * or actively unhelpful: Back and Refresh are the reload problem again
     * with a different shortcut, and the rest save or print a page nobody
     * wants a copy of.
     *
     * Blanket for now. When there is a menu of our own worth showing -- copy a
     * name, open a profile -- this is where it hangs.
     */
    const noMenu = (e) => e.preventDefault();

    window.addEventListener("keydown", swallow);
    window.addEventListener("contextmenu", noMenu);
    return () => {
      window.removeEventListener("keydown", swallow);
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  /**
   * Re-read the party whenever the socket comes back.
   *
   * Events are only true for someone who was listening. A client that was away
   * -- a reload, a dropped connection, a laptop lid -- missed whatever changed
   * while it was gone and would otherwise go on drawing the roster it left
   * with. That is not hypothetical: the server drops a disconnected player out
   * of their party after a grace period, so the state most likely to be stale
   * on reconnect is exactly the state that changed because you disconnected.
   */
  useEffect(() => {
    if (!me) return;

    return liveBus.on((e) => {
      if (e?.type !== "connection.status" || e.status !== "connected") return;

      void server
        .getParty()
        .then((fresh) => {
          setPartyId(fresh?.partyId ?? null);
          setParty(
            (fresh?.members ?? []).map((m) => ({
              id: m.userId,
              discordName: m.discordName,
              avatarUrl: m.avatarUrl ?? null,
              inGameName: m.inGameName ?? null,
              avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length],
              isGameMaster: m.isGameMaster ?? false,
              isLeader: m.isLeader ?? false,
              tier: m.tier ?? null,
              placementsRemaining: m.placementsRemaining ?? 0,
              wins: 0,
              losses: 0,
            })),
          );
        })
        .catch(() => {
          // The socket is up but the call failed; the next event or the next
          // reconnect will put it right rather than blanking what is on screen.
        });
    });
  }, [me]);

  // The server's half of the same rule, which can arrive in answer to any call
  // and so is listened for outside the signed-in shell. It is not a check that
  // could be retried into success: the deployment serves a newer version than
  // this one, and will keep saying so until this copy is replaced.
  //
  // An install already under way is left alone. It is doing the only thing
  // that resolves this, and replacing a progress bar with an explanation of
  // why the progress bar is needed would be a step backwards.
  useEffect(
    () =>
      liveBus.on((e) => {
        if (e?.type !== "client.tooOld") return;
        setUpdateCheck((current) =>
          current.phase === "found" ? current : { phase: "rejected", minimum: e.minimum ?? null },
        );
      }),
    [],
  );
  const notify = useCallback((text) => { const id = Date.now() + Math.random(); setToasts((list) => [...list, { id, text }]); setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 3800); }, []);

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
      notify(errorText(err, "That invite is no longer valid"));
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
      setHistory(toHistoryRows(await server.history()));
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
      if (!full) { notify(t("Couldn't load that match")); return; }
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
      notify(errorText(err, "Couldn't load that match"));
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
        avatarUrl: m.avatarUrl ?? null,
        inGameName: m.inGameName ?? m.discordName,
        avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length],
        isGameMaster: m.isGameMaster ?? false,
        isLeader: m.isLeader ?? false,
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


  // Deliberately not seeded here any more. This used to reset the party to
  // [me] whenever `me` changed, and `me` changes on every profile refresh --
  // so a cosmetic reload of your own profile silently emptied the party on
  // screen, and the next server event was the only thing that put it back.
  // Sign-in loads the real party from /me, and events keep it current.
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
            notify(t("Match found, but its details could not be loaded"));
            break;
          }
          setQueue({ state: "idle" });
          setPendingMatch(found);
          break;
        }
        case "queue.counts":
          // Pushed whenever they move, and once on connect. Nothing asks.
          setPop({ online: e.online, inQueue: e.inQueue, inMatch: e.inMatch });
          break;
        case "queue.left":
          setQueue({ state: "idle" });
          if (e.reason === "CONNECTION_LOST") notify(t("Connection dropped — you left the queue"));
          break;
        case "match.cancelled": {
          setPendingMatch(null);
          setQueue({ state: "idle" });
          if (!e.atFault) {
            notify(t("A player didn't accept — the match was cancelled"));
            break;
          }
          // The server owns the penalty and states it; this only displays it.
          const seconds = e.cooldownSeconds ?? 0;
          if (seconds > 0) setCooldownUntil(Date.now() + seconds * 1000);
          notify(
            seconds > 0
              ? `You left a match short — queue locked for ${fmt(seconds)}`
              : t("You left a match short"),
          );
          break;
        }
        case "match.resolved":
          notify(
            e.tierAfter && e.tierBefore && e.tierAfter !== e.tierBefore
              ? `Match complete · now ${e.tierAfter}`
              : t("Match complete"),
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
              avatarUrl: m.avatarUrl ?? null,
              inGameName: m.inGameName ?? m.discordName,
              avatarColor: AV_COLORS[Math.abs(hashString(m.userId)) % AV_COLORS.length],
              isGameMaster: m.isGameMaster ?? false,
              isLeader: m.isLeader ?? false,
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
          notify(t("The scrim was dropped — nobody confirmed a lineup"));
          break;
        case "notification":
          notify(e.text);
          break;
        case "auth.expired":
          notify(t("Session expired — sign in again"));
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
    playQueuePop();
  }, [pendingMatch]);


  // Ahead of the sign-in screen on purpose. An update that can be walked
  // around by not signing in is not required, and there is nothing worth
  // reaching on an old version anyway.
  if (updateCheck.phase !== "clear")
    return (
      <ConfigContext.Provider value={config}>
        <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", fontFamily: T.body, color: T.text }}>
          <style>{css}</style>
          <UpdateGate check={updateCheck} onRetry={retryUpdateCheck} />
        </div>
      </ConfigContext.Provider>
    );

  if (!me)
    return (
      <ConfigContext.Provider value={config}>
        <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", fontFamily: T.body, color: T.text }}>
          <style>{css}</style>
          <Login onSignedIn={adoptServerSession} />
        </div>
      </ConfigContext.Provider>
    );

  const NAV = [["play", "PUG", Crosshair], ["scrims", "Scrims", Swords], ["teams", "Teams", Users], ["ladder", "Ladder", Trophy], ["bans", t("Bans"), AlertTriangle], ["profile", t("Profile"), User]];
  // Shown only to Game Masters. The server refuses everyone else anyway; this
  // keeps a tab off the rail that would only ever answer 403.
  if (me.isGameMaster) NAV.push(["manage", t("Manage"), Shield]);
  const go = (id) => { setNav(id); setViewProfile(null); };

  let content;
  if (match) content = <MatchScreen key={match.id} match={match} me={me} notify={notify} onView={setViewProfile} onFinished={() => {
    // The server already recorded it; re-reading is what makes the row real
    // rather than a local guess at what it wrote.
    setMatch(null);
    void refreshHistory();
  }} />;
  else if (viewProfile) content = <ProfileScreen p={viewProfile} me={me} history={history} onBack={() => setViewProfile(null)} onViewMatch={openMatch} onSaved={refreshProfile} notify={notify} />;
  else if (nav === "play") content = <PlayScreen me={me} party={party} queue={queue} setQueue={setQueue} cooldownUntil={cooldownUntil} history={history} notify={notify} onViewMatch={openMatch} onView={setViewProfile} onInvite={() => setInviteOpen(true)} onSetName={() => go("profile")} />;
  // These three have no server endpoints yet, so they say so rather than
  // standing in for them.
  else if (nav === "scrims") content = <ScrimsScreen notify={notify} />;
  else if (nav === "teams") content = <TeamsScreen me={me} notify={notify} onView={setViewProfile} />;
  else if (nav === "bans") content = <BansScreen notify={notify} />;
  else if (nav === "manage")
    content = me.isGameMaster ? (
      <ModerationScreen me={me} notify={notify} onView={setViewProfile} />
    ) : (
      <ComingSoon
        eyebrow={t("Manage")}
        title={t("Game Masters only")}
        body={t("Disputes, reports and the rest are settled by a Game Master.")}
      />
    );
  else if (nav === "ladder") content = <LadderScreen me={me} onView={setViewProfile} notify={notify} />;
  else content = <ProfileScreen p={me} me={me} history={history} onBack={() => {}} onViewMatch={openMatch} onSaved={refreshProfile} notify={notify} />;

  return (
    <ConfigContext.Provider value={config}>
    <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", background: T.bg, color: T.text, fontFamily: T.body, fontSize: 13, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      <style>{css}</style>
      {/* title bar */}
      <div style={{ height: 44, display: "flex", alignItems: "center", padding: "0 14px", borderBottom: `1px solid ${T.line}`, background: T.panel, gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}><div style={{ width: 22, height: 22, borderRadius: 4, background: T.accent, display: "grid", placeItems: "center" }}><Crosshair size={14} color="#07110F" strokeWidth={2.5} /></div><span style={{ fontFamily: T.display, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.02em" }}>{config.appName}</span></div>
        {/* population strip */}
        <div style={{ display: "flex", gap: 14, marginLeft: 6 }}>
          {/* Server counts, already inclusive of you. */}
          {[[t("Online"), pop?.online, T.ok], [t("In queue"), pop?.inQueue, T.accent], [t("In match"), pop?.inMatch, T.captain]].map(([k, v, c]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={c} /><span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 600 }}>{v ?? "–"}</span><span style={{ fontSize: 11.5, color: T.muted }}>{k}</span></div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {queue.state === "queued" && !match && <button onClick={() => go("play")} style={{ background: T.accentDim, border: `1px solid ${T.accent}`, color: T.accent, borderRadius: 4, padding: "4px 10px", fontFamily: T.mono, fontSize: 11.5, display: "flex", gap: 6, alignItems: "center" }}><Dot pulse /> IN QUEUE</button>}
        {match && <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.captain, display: "flex", gap: 6, alignItems: "center" }}><Dot color={T.captain} pulse /> IN MATCH</span>}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}><Avatar p={me} size={24} /><PlayerName p={me} style={{ fontWeight: 600 }} /><Tier tier={me.tier} size={12} /></div>
        <button onClick={() => setMe(null)} title={t("Sign out")} style={{ background: "transparent", border: "none", color: T.dim, padding: 4 }}><LogOut size={14} /></button>
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
          {/* The build's own version, not a literal. It is the number the
              server checks this client against, so a label that could drift
              from it would be worse than no label -- the one moment anybody
              reads this is when they are working out which version they are
              on. */}
          <div style={{ padding: 10, textAlign: "center" }}><Eyebrow style={{ fontSize: 9 }}>{CLIENT_VERSION ? `v${CLIENT_VERSION}` : t("dev")}</Eyebrow><Eyebrow style={{ fontSize: 9, color: T.dim }}>{t("preview")}</Eyebrow></div>
        </div>
        {/* main */}
        <div style={{ flex: 1, minWidth: 0, padding: 16, overflow: "auto", position: "relative" }}>{content}</div>
      </div>

      {me.inGameName === null && !namePutOff && !pendingMatch && !match && (
        <NamePrompt
          notify={notify}
          onSaved={refreshProfile}
          onLater={() => setNamePutOff(true)}
        />
      )}

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
        {toasts.map((toast) => <div key={toast.id} style={{ background: T.raised, border: `1px solid ${T.line2}`, borderLeft: `3px solid ${T.accent}`, borderRadius: 4, padding: "8px 12px", fontSize: 12.5, animation: "sqRise .2s ease", boxShadow: "0 6px 20px rgba(0,0,0,.35)", display: "flex", gap: 8, alignItems: "center" }}><Bell size={12} color={T.accent} />{toast.text}</div>)}
      </div>
    </div>
    </ConfigContext.Provider>
  );
}

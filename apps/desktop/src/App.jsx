import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Crosshair, Swords, Users, Trophy, User, MessageSquare, Send, X, Check, Shield, Star, Wifi, Timer, Copy, ChevronRight, LogOut, Bell, Filter, Plus, Minus, AlertTriangle, CircleDot, Lock, Unlock } from "lucide-react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
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
const TIERS = ["F-","F","F+","D-","D","D+","C-","C","C+","B-","B","B+","A-","A","A+","S","S+"];
const tierColor = (t) => {
  if (t.startsWith("S")) return "#F2A93B";
  if (t.startsWith("A")) return "#C77DFF";
  if (t.startsWith("B")) return "#2FC8BF";
  if (t.startsWith("C")) return "#5DBE7B";
  if (t.startsWith("D")) return "#9AA5B1";
  return "#7C8794";
};
const rankFromPercentile = (p) => TIERS[Math.min(TIERS.length - 1, Math.floor(p * TIERS.length))];

/* ─────────────────────────────────────────────────────────────
   MOCK DATA  (everything below the API boundary is fake)
   ───────────────────────────────────────────────────────────── */
const NAMES = ["vexlyn","kuroba","Nyx_","dartel","s0lace","Marrow","tenshi","ovrkill","Halcyon","riftwalk","zeroKelvin","pale","Ashgrove","tinsel","Kotone","brk","Wraithe","dyad","Fennec","lowsky","yuzuha","gnash","Cinder","Orbital","hush","Vantablk","reiko","Quell","Nomad_","sable"];
const AV_COLORS = ["#4C6EF5","#B23A48","#2A9D8F","#8E44AD","#D97706","#0EA5E9","#DC2626","#65A30D","#7C3AED","#DB2777"];
const mkPlayer = (i, over = {}) => ({
  id: `p${i}`,
  discordName: NAMES[i % NAMES.length],
  inGameName: (NAMES[i % NAMES.length] + (i > 29 ? i : "")).toUpperCase().slice(0, 12),
  avatarColor: AV_COLORS[i % AV_COLORS.length],
  rating: 1200 + ((i * 137) % 900),
  wins: 10 + ((i * 7) % 60), losses: 8 + ((i * 11) % 50),
  disputes: (i * 3) % 4 === 0 ? 1 : 0,
  ...over,
});
const POOL = Array.from({ length: 30 }, (_, i) => mkPlayer(i));
const DEMO = mkPlayer(99, { id: "demo", discordName: "demo", inGameName: "DEMO_ACCT", avatarColor: "#2FC8BF", rating: 1610, wins: 34, losses: 27, disputes: 0 });

const withPercentiles = (players) => {
  const sorted = [...players].sort((a, b) => a.rating - b.rating);
  return players.map((p) => {
    const idx = sorted.findIndex((s) => s.id === p.id);
    const pct = idx / Math.max(1, sorted.length - 1);
    return { ...p, percentile: pct, tier: rankFromPercentile(pct) };
  });
};
let LADDER = withPercentiles([...POOL, DEMO]);
const byId = (id) => LADDER.find((p) => p.id === id);

const TEAMS_SEED = [
  { id: "t1", tag: "NSHF", name: "Nightshift", region: "na", captain: "demo", officers: ["p2"], members: ["demo","p2","p5","p9","p14","p21"], applicationsOpen: true, applications: [{ playerId: "p7", note: "IGL for 3 yrs, main entry." }, { playerId: "p12", note: "" }] },
  { id: "t2", tag: "PALE", name: "Pale Horse", region: "eu", captain: "p1", officers: [], members: ["p1","p3","p4","p6","p8"], applicationsOpen: true, applications: [] },
  { id: "t3", tag: "KOTN", name: "Kotone Esports", region: "asia", captain: "p10", officers: ["p11"], members: ["p10","p11","p13","p15","p16","p17"], applicationsOpen: false, applications: [] },
  { id: "t4", tag: "ORB", name: "Orbital", region: "na", captain: "p18", officers: [], members: ["p18","p19","p20","p22","p23"], applicationsOpen: true, applications: [] },
  { id: "t5", tag: "SBL", name: "Sable", region: "sa", captain: "p24", officers: ["p25"], members: ["p24","p25","p26","p27","p28"], applicationsOpen: true, applications: [] },
];

const SCRIMS_SEED = [
  { id: "s1", teamId: "t2", region: "eu", note: "Bo1, casual, no subs", postedAt: Date.now() - 6 * 60000, status: "open" },
  { id: "s2", teamId: "t3", region: "asia", note: "looking for A- and up", postedAt: Date.now() - 14 * 60000, status: "open" },
  { id: "s3", teamId: "t4", region: "na", note: "Bo3 tonight, we host vc", postedAt: Date.now() - 2 * 60000, status: "open" },
  { id: "s4", teamId: "t5", region: "sa", note: "", postedAt: Date.now() - 41 * 60000, status: "open" },
];

const HISTORY_SEED = [
  { id: "m1", ts: Date.now() - 3600e3 * 2, region: "na", type: "PUG", result: "win", state: "completed", delta: +18,
    captain1: "demo", captain2: "p3", team1: ["demo","p1","p6","p11","p16"].map(byId), team2: ["p3","p8","p13","p18","p23"].map(byId) },
  { id: "m2", ts: Date.now() - 3600e3 * 26, region: "na", type: "PUG", result: "loss", state: "completed", delta: -14,
    captain1: "demo", captain2: "p2", team1: ["demo","p4","p9","p14","p19"].map(byId), team2: ["p2","p7","p12","p17","p22"].map(byId) },
  { id: "m3", ts: Date.now() - 3600e3 * 27, region: "eu", type: "SCRIM", result: "win", state: "completed", delta: 0, teamId: "t1", teamId2: "t2",
    captain1: "demo", captain2: "p1", team1: ["demo","p2","p5","p9","p14"].map(byId), team2: ["p1","p3","p4","p6","p8"].map(byId) },
  { id: "m4", ts: Date.now() - 3600e3 * 50, region: "na", type: "PUG", result: "—", state: "in dispute", delta: 0,
    captain1: "p5", captain2: "demo", team1: ["p5","p10","p15","p20","p25"].map(byId), team2: ["demo","p0","p6","p11","p16"].map(byId) },
  { id: "m5", ts: Date.now() - 3600e3 * 74, region: "na", type: "PUG", result: "win", state: "completed", delta: +20,
    captain1: "demo", captain2: "p9", team1: ["demo","p3","p8","p13","p18"].map(byId), team2: ["p9","p14","p19","p24","p29"].map(byId) },
  { id: "m6", ts: Date.now() - 3600e3 * 100, region: "na", type: "SCRIM", result: "loss", state: "completed", delta: 0, teamId: "t1", teamId2: "t4",
    captain1: "demo", captain2: "p18", team1: ["demo","p2","p5","p9","p14"].map(byId), team2: ["p18","p19","p20","p22","p23"].map(byId) },
  { id: "m7", ts: Date.now() - 3600e3 * 150, region: "sa", type: "SCRIM", result: "win", state: "completed", delta: 0, teamId: "t1", teamId2: "t5",
    captain1: "demo", captain2: "p24", team1: ["demo","p2","p5","p9","p14"].map(byId), team2: ["p24","p25","p26","p27","p28"].map(byId) },
];

/* ─────────────────────────────────────────────────────────────
   MOCK API + PUSH BUS
   Everything the real backend will do lives behind `api` and `bus`.
   Replace these two objects when wiring up; the UI never talks
   to anything else.
   ───────────────────────────────────────────────────────────── */
const listeners = new Set();
const bus = {
  on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  emit: (evt) => listeners.forEach((fn) => fn(evt)),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr, n, exclude = []) => {
  const c = arr.filter((p) => !exclude.includes(p.id));
  const out = [];
  while (out.length < n && c.length) out.push(c.splice(rnd(0, c.length - 1), 1)[0]);
  return out;
};

let queueTimer = null;
const buildMatch = (regions, partyIds) => {
  const region = regions[rnd(0, regions.length - 1)];
  const teammates = pick(POOL, 5 - partyIds.length, partyIds);
  const opp = pick(POOL, 5, [...partyIds, ...teammates.map((t) => t.id)]);
  const team1 = [...partyIds.map(byId), ...teammates.map((t) => byId(t.id))];
  const team2 = opp.map((t) => byId(t.id));
  return { id: "m" + Date.now(), type: "PUG", region, team1, team2, captain1: team1[0].id, captain2: team2[0].id };
};
const fireScrimMatch = (scrimId, myTeamId) => {
  const scrim = SCRIMS_SEED.find((s) => s.id === scrimId);
  const host = TEAMS_SEED.find((t) => t.id === scrim.teamId);
  const mine = TEAMS_SEED.find((t) => t.id === myTeamId);
  const team1 = mine.members.slice(0, 5).map(byId);
  const team2 = host.members.slice(0, 5).map(byId);
  bus.emit({ type: "scrim_accepted", scrimId });
  bus.emit({ type: "match_found", match: { id: "sc" + Date.now(), type: "SCRIM", region: scrim.region, team1, team2, captain1: mine.captain, captain2: host.captain } });
};
const api = {
  async login() { await sleep(600); return byId("demo"); },
  async population() {
    await sleep(120);
    return { online: rnd(38, 52), inQueue: rnd(4, 14), inMatch: rnd(1, 3) * 10 };
  },
  async joinQueue({ regions, partyIds, auto = true }) {
    await sleep(200);
    clearTimeout(queueTimer);
    const wait = rnd(3500, 6500);
    // during the tutorial the pop is user-paced (the tour emits it), not on a timer
    if (auto) queueTimer = setTimeout(() => bus.emit({ type: "match_found", match: buildMatch(regions, partyIds) }), wait);
    return { ok: true, eta: Math.round(wait / 1000) };
  },
  async leaveQueue() { clearTimeout(queueTimer); await sleep(120); return { ok: true }; },
  async accept(matchId) { await sleep(150); return { ok: true }; },
  async reportResult(matchId, result) { await sleep(250); return { ok: true }; },
  async requestScrim(scrimId, myTeamId, auto = true) {
    await sleep(300);
    // during the tutorial the pop is user-paced (the tour fires it), not on a timer
    if (auto) setTimeout(() => fireScrimMatch(scrimId, myTeamId), rnd(2500, 4500));
    return { ok: true };
  },
  async postScrim(teamId, region, note) { await sleep(200); return { id: "s" + Date.now(), teamId, region, note, postedAt: Date.now(), status: "open" }; },
  async removeScrim(id) { await sleep(120); return { ok: true }; },
  async sendChat(channel, text) { await sleep(60); return { ok: true }; },
};

/* fake incoming chat so the dock isn't dead */
const CANNED = {
  party: ["ready when u are", "queue na + eu?", "brb 1 min", "gg last one"],
  matchTeam: ["add me pls", "inviting now", "who's cap again?", "omw", "ready when u are"],
  match: ["gl hf", "everyone ready?", "who's missing", "cap invite pls", "brb 1 min"],
};

/* guided tutorial — every flow in the app, user-paced.
   type "info": read + Next (Next may also drive the simulation via `advance`).
   type "action": the spotlit control is live and the user must actually use it;
   the step advances only when `when(state)` proves they did. Nothing is timed. */
const TOUR_STEPS = [
  { id: "welcome", type: "info", nav: "play", target: null, title: "Welcome to Sudden Queue", body: "This tutorial covers every flow in the app, hands-on — you'll build a party, queue, play a full match, report it, request and play a scrim, then run through teams and chat. Every highlighted control is live; where a step asks you to click something, that's the only way forward. There's no skipping — it's short, and it's the whole product." },
  { id: "nav", type: "info", nav: "play", target: "nav-rail", title: "The five tabs", body: "PUG is rated solo/party matchmaking. Scrims is unrated team practice. Teams manages rosters, Ladder ranks everyone, Profile is your record." },
  { id: "invite", type: "action", nav: "play", target: "invite-btn", title: "Build a party", body: "You can queue with up to 4 friends. Invite one now — in this demo a player joins instantly.", hint: "Click Invite", when: (c) => c.party.length > 1 },
  { id: "party-slots", type: "info", nav: "play", target: "party-panel", title: "Your party", body: "Five slots. The starred slot is the party captain — that's you. The ✕ on a card removes a player any time you're not queued." },
  { id: "regions", type: "action", nav: "play", target: "region-picker", title: "Pick your regions", body: "Every region you select is fair game — whichever match pops first wins. Toggle any region now to see how it works.", hint: "Toggle a region", when: (c) => c.evt?.evt === "pug-region-changed" && c.evt.n > 0 },
  { id: "queue", type: "action", nav: "play", target: "queue-btn", title: "Queue up", body: "That's all the setup there is.", hint: "Click the queue button", when: (c) => c.queue.state === "queued" },
  { id: "searching", type: "info", nav: "play", target: "queue-panel", title: "Searching", body: "The search radius starts tight around your party's rating and widens the longer you wait, trading match quality for speed. Hit Next when you're ready to see it pop.", advance: "pop-match" },
  { id: "accept", type: "action", nav: null, target: "accept-btn", title: "20 seconds to accept", body: "All 10 players get this prompt. Decline or miss it and you eat a queue cooldown while the other nine go back to the front of the line.", hint: "Click Accept", when: (c) => !!c.match },
  { id: "partyup", type: "info", nav: null, target: "match-rosters", title: "Party up", body: "Both rosters, captains marked in gold. You're the captain here, so your teammates add YOU in-game and join YOUR party. When you're not the captain, you add your own team's captain instead — there's a copy-name button on their card. The timer is 2 minutes live.", advance: "skip-party" },
  { id: "queue-casual", type: "info", nav: null, target: "match-banner", title: "Queue Casual together", body: "On this signal, both captains hit Casual queue in-game at the same moment. Empty queues mean the two parties land in the same lobby.", advance: "go-live" },
  { id: "report", type: "action", nav: null, target: "report-bar", title: "Report the result", body: "The match is live. When it ends, each captain reports the result — honestly. This is what moves ratings. Report either result now.", hint: "Report a result", when: (c) => ["reported", "completed", "dispute"].includes(c.matchPhase) },
  { id: "reported", type: "info", nav: null, target: "match-banner", title: "Waiting on the other captain", body: "Your report is in. If the other captain's report agrees, ratings update and the match closes. If they disagree, the match goes to dispute and a mod settles it with both teams.", advance: "confirm-report" },
  { id: "completed", type: "info", nav: null, target: "match-banner", title: "Match closed", body: "Both reports agree — rating updated." },
  { id: "lobby", type: "action", nav: null, target: "back-lobby", title: "Back to the lobby", body: "The result is locked in.", hint: "Click Back to lobby", when: (c) => !c.match },
  { id: "history-row", type: "action", nav: "play", target: "history-row", title: "Match history", body: "There's the match you just played, rating change and all. Every match is clickable.", hint: "Click the match", when: (c) => !!c.viewMatch },
  { id: "match-modal", type: "info", nav: "play", target: "match-modal", title: "Full match detail", body: "Both rosters exactly as they were. From here you can click any player to open their profile. Disputed matches stay marked until a mod resolves them." , advance: "close-modal" },
  { id: "ladder-row", type: "action", nav: "ladder", target: "ladder-row", title: "The ladder", body: "Every active player, ranked. The letter tiers are percentile buckets — F- to S+ — so every tier stays populated whatever the playerbase size. Open the top player.", hint: "Click the top player", when: (c) => !!c.viewProfile },
  { id: "profile", type: "info", nav: null, target: "profile-card", title: "Player profiles", body: "Rating, record, streak — plus reliability: disputes, missed accepts, abandons. Only matchmaker data is public, never in-game stats.", advance: "close-profile" },
  { id: "scrims-list", type: "info", nav: "scrims", target: "scrims-list-panel", title: "The scrim list", body: "Teams looking for practice list themselves here. Requesting one sends all 10 players the same 20-second accept prompt you just used — but scrims never touch rating." },
  { id: "scrim-filter", type: "action", nav: "scrims", target: "scrim-filter", title: "Filter by region", body: "Same region controls as the queue — narrow the list to where your team actually plays.", hint: "Toggle a region filter", when: (c) => c.evt?.evt === "scrim-filter-changed" },
  { id: "post-scrim", type: "action", nav: "scrims", target: "post-scrim-btn", title: "List your team", body: "You're a captain, so you can put your team on the list. The note field is for details like format or who hosts voice.", hint: "Click Post to scrim list", when: (c) => c.scrims.some((x) => x.teamId === c.myTeam?.id) },
  { id: "your-listing", type: "info", nav: "scrims", target: "scrims-list-panel", title: "You're listed", body: "That's your team, visible to every captain filtering your region. When another team requests you, all 10 players get the accept prompt — you're about to see that from the other side." },
  { id: "unlist", type: "action", nav: "scrims", target: "unlist-btn", title: "Take it down", body: "First, pull your own listing — you're about to request someone else's instead.", hint: "Click Remove listing", when: (c) => !c.scrims.some((x) => x.teamId === c.myTeam?.id) },
  { id: "request-scrim", type: "action", nav: "scrims", target: "request-scrim-btn", title: "Request a scrim", body: "Now do what any captain browsing this list would do — request a practice match against one of these teams.", hint: "Click Request scrim", when: (c) => c.evt?.evt === "scrim-requested" && !!c.evt.scrimId },
  { id: "scrim-searching", type: "info", nav: "scrims", target: "scrims-list-panel", title: "Waiting on the other captain", body: "Your request went out. In a real session you'd wait for them to accept it — hit Next when you're ready to see that happen.", advance: "pop-scrim-match" },
  { id: "scrim-accept", type: "action", nav: null, target: "accept-btn", title: "Same accept prompt", body: "The other team accepted your request, so this scrim match got built — all 10 players get the identical 20-second prompt you saw for the PUG.", hint: "Click Accept", when: (c) => !!c.match },
  { id: "scrim-partyup", type: "info", nav: null, target: "match-rosters", title: "Party up, scrim edition", body: "Same party-up screen, same 2-minute timer. Add your captain in-game and join their party.", advance: "skip-party" },
  { id: "scrim-live", type: "info", nav: null, target: "match-banner", title: "Queue Casual together", body: "Both captains hit Casual queue on this signal, same as before.", advance: "go-live" },
  { id: "scrim-report", type: "action", nav: null, target: "report-bar", title: "Report it — no rating on the line", body: "Report the result. This time watch the banner: it'll tell you rating doesn't move for scrims, win or lose.", hint: "Report a result", when: (c) => ["reported", "completed", "dispute"].includes(c.matchPhase) },
  { id: "scrim-confirm", type: "info", nav: null, target: "match-banner", title: "Confirmed, unrated", body: "Both reports agree and the scrim closes — no rating change either way.", advance: "confirm-report" },
  { id: "scrim-lobby", type: "action", nav: null, target: "back-lobby", title: "Back to the lobby", body: "That's the full scrim loop: list, get requested, accept, play, report — all separate from your PUG rating.", hint: "Click Back to lobby", when: (c) => !c.match },
  { id: "teams-roster", type: "info", nav: "teams", target: "teams-panel", title: "Your team", body: "The roster with roles, ranks and records. As captain you can promote officers (the shield), remove players (the ✕), toggle applications open or closed, or disband the team entirely." },
  { id: "apps-tab", type: "action", nav: "teams", target: "apps-tab", title: "Applications", body: "Players apply to join your team; captains and officers review them.", hint: "Click the Applications tab", when: (c) => c.evt?.evt === "teams-tab-applications" },
  { id: "applications", type: "info", nav: "teams", target: "teams-panel", title: "Reviewing applications", body: "Accept or deny each applicant — the tab badge counts how many are waiting. The open/closed toggle up top controls whether new applications can come in at all." },
  { id: "team-history", type: "info", nav: "teams", target: "team-history-panel", title: "Team match history", body: "Both scrims you just played are logged here, clickable like your personal history. Anyone can open any team from the team or scrim lists to see its roster and record." },
  { id: "chat-open", type: "action", nav: "play", target: "chat-toggle", title: "Open chat", body: "Party chat starts closed — a badge on this button counts unread messages while it's shut. Open it.", hint: "Click Chat", when: (c) => c.chatOpen },
  { id: "chat-close", type: "action", nav: "play", target: "chat-toggle", title: "Close it back up", body: "In a live match you also get separate team and match channels under the rosters. For now, close this one.", hint: "Click the ✕", when: (c) => !c.chatOpen },
  { id: "done", type: "info", nav: null, target: null, title: "You're set", body: "That was every flow: party, regions, queue, accept, party-up, reporting, history, the ladder, scrims both directions, and teams. Replay this any time with the ? button in the title bar." },
];

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
const Tier = ({ tier, size = 12 }) => (
  <span style={{ fontFamily: T.display, fontWeight: 800, fontSize: size, color: tierColor(tier), letterSpacing: "0.02em", minWidth: size * 1.6, display: "inline-block", textAlign: "center" }}>{tier}</span>
);
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
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s % 60)).padStart(2, "0")}`;
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
const useTick = (active) => { const [, s] = useState(0); useEffect(() => { if (!active) return; const i = setInterval(() => s((n) => n + 1), 500); return () => clearInterval(i); }, [active]); };

/* ─────────────────────────────────────────────────────────────
   LOGIN
   ───────────────────────────────────────────────────────────── */
function Login({ onLogin }) {
  const [busy, setBusy] = useState(false);
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
          <Btn kind="ghost" style={{ width: "100%", justifyContent: "center", marginBottom: 16, background: "#5865F2", borderColor: "#5865F2", color: "#fff" }} disabled>Continue with Discord</Btn>
          <div style={{ height: 1, background: T.line, margin: "4px 0 16px" }} />
          <Eyebrow style={{ marginBottom: 8 }}>Preview build</Eyebrow>
          <Btn kind="primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy} onClick={async () => { setBusy(true); const u = await api.login(); onLogin(u); }}>
            {busy ? "Signing in…" : "Start tutorial"}
          </Btn>
          <div style={{ marginTop: 12, fontSize: 12, color: T.dim, lineHeight: 1.5 }}>Discord OAuth is wired up later. This drops you into a demo account — captain on a registered team, with a short guided tour of how queueing, scrims, and teams work. Skip it any time.</div>
        </Panel>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   PUG QUEUE
   ───────────────────────────────────────────────────────────── */
function PlayScreen({ me, party, setParty, queue, setQueue, cooldownUntil, history, notify, onViewMatch, onView, tutorial }) {
  const [regions, setRegions] = useState(["na", "eu"]);
  useTick(queue.state === "queued" || cooldownUntil > Date.now());
  const elapsed = queue.state === "queued" ? Math.floor((Date.now() - queue.since) / 1000) : 0;
  const cooling = cooldownUntil > Date.now();
  const coolLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
  // search radius: fast-widening ramp, plateaus at ~3 min. Same curve the backend will use.
  const radius = Math.round(Math.min(600, 60 + elapsed * 6));

  const start = async () => {
    if (!regions.length) return;
    setQueue({ state: "queued", since: Date.now(), regions });
    await api.joinQueue({ regions, partyIds: party.map((p) => p.id), auto: !tutorial });
  };
  const stop = async () => { setQueue({ state: "idle" }); await api.leaveQueue(); };
  const addBot = () => { if (party.length >= 5) return; const c = pick(POOL, 1, party.map((p) => p.id))[0]; setParty([...party, byId(c.id)]); notify(`${c.discordName} joined your party`); };
  const kick = (id) => setParty(party.filter((p) => p.id !== id));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        {/* queue control */}
        <Panel pad={20} data-tour="queue-panel" style={{ position: "relative", overflow: "hidden", borderColor: queue.state === "queued" ? T.accent : T.line }}>
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
            <div data-tour="region-picker"><RegionPicker value={queue.state === "queued" ? queue.regions : regions} onChange={queue.state === "queued" ? () => {} : (v) => { setRegions(v); bus.emit({ type: "tour_evt", evt: "pug-region-changed", n: v.length }); }} /></div>
            {queue.state === "queued"
              ? <Btn kind="danger" onClick={stop}><X size={14} /> Leave queue</Btn>
              : <Btn kind="primary" data-tour="queue-btn" onClick={start} disabled={cooling || !regions.length}><Crosshair size={14} /> Queue {party.length > 1 ? `as ${party.length}` : "solo"}</Btn>}
          </div>
        </Panel>

        {/* party */}
        <Panel data-tour="party-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Eyebrow>Party · {party.length}/5</Eyebrow>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" data-tour="invite-btn" onClick={addBot} disabled={party.length >= 5 || queue.state === "queued"}><Plus size={13} /> Invite</Btn>
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
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}><Tier tier={p.tier} size={11} /><span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{p.rating}</span></div>
                    {i > 0 && queue.state !== "queued" && <button onClick={(e) => { e.stopPropagation(); kick(p.id); }} title="Remove" style={{ position: "absolute", top: 4, right: 4, background: "transparent", border: "none", color: T.dim, padding: 2 }}><X size={12} /></button>}
                    {i === 0 && <span style={{ position: "absolute", top: 4, left: 6 }}><Star size={11} color={T.captain} fill={T.captain} /></span>}
                  </> : <div style={{ color: T.dim, fontSize: 12, margin: "auto" }}>Open slot</div>}
                </div>
              );
            })}
          </div>
        </Panel>

        {/* recent matches */}
        <Panel data-tour="recent-matches-panel" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>Recent matches</Eyebrow>
          <div style={{ overflow: "auto", flex: 1 }}>
            {history.map((m, i) => (
              <div key={m.id} data-tour={i === 0 ? "history-row" : undefined} className="row-hover" onClick={() => m.team1 && onViewMatch(m)} style={{ display: "grid", gridTemplateColumns: "60px 60px 1fr 90px 60px", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 4, fontSize: 13, cursor: m.team1 ? "pointer" : "default" }}>
                <Tag>{m.type}</Tag>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{m.region.toUpperCase()}</span>
                <span style={{ color: T.muted }}>{ago(m.ts)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: m.state === "in dispute" ? T.captain : m.state === "in progress" ? T.accent : T.muted }}>{m.state}</span>
                <span style={{ fontFamily: T.mono, fontWeight: 600, textAlign: "right", color: m.result === "win" ? T.ok : m.result === "loss" ? T.danger : T.muted }}>{m.result === "win" ? "W" : m.result === "loss" ? "L" : "—"} {m.delta ? (m.delta > 0 ? `+${m.delta}` : m.delta) : ""}</span>
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
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{me.rating}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
            {[["Record", `${me.wins}–${me.losses}`], ["Win rate", `${Math.round(100 * me.wins / (me.wins + me.losses))}%`], ["Disputes", me.disputes]].map(([k, v]) => (
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
   SCRIMS
   ───────────────────────────────────────────────────────────── */
function ScrimsScreen({ me, myTeam, teams, scrims, setScrims, notify, queue, onViewTeam, tutorial }) {
  const [filter, setFilter] = useState(["na", "sa", "eu", "asia"]);
  const [note, setNote] = useState("");
  const [postRegion, setPostRegion] = useState(myTeam?.region || "na");
  const [pending, setPending] = useState(null);
  const canManage = myTeam && (myTeam.captain === me.id || myTeam.officers.includes(me.id));
  const mine = scrims.find((s) => s.teamId === myTeam?.id);
  useTick(true);

  useEffect(() => bus.on((e) => { if (e.type === "scrim_accepted") { setPending(null); notify("Scrim request accepted — match found"); } }), []);

  const request = async (s) => { setPending(s.id); bus.emit({ type: "tour_evt", evt: "scrim-requested", scrimId: s.id }); await api.requestScrim(s.id, myTeam.id, !tutorial); };
  const post = async () => { const s = await api.postScrim(myTeam.id, postRegion, note); setScrims([s, ...scrims]); setNote(""); notify("Your team is listed"); };
  const unlist = async () => { await api.removeScrim(mine.id); setScrims(scrims.filter((s) => s.id !== mine.id)); };

  const list = scrims.filter((s) => filter.includes(s.region));
  const firstRequestableId = list.find((s) => myTeam && s.teamId !== myTeam.id)?.id;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <Panel data-tour="scrims-list-panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12 }}>
          <div><Eyebrow>Scrim list</Eyebrow><H size={20}>Teams looking to scrim</H></div>
          <div data-tour="scrim-filter" style={{ display: "flex", alignItems: "center", gap: 8 }}><Filter size={13} color={T.muted} /><RegionPicker value={filter} onChange={(v) => { setFilter(v); bus.emit({ type: "tour_evt", evt: "scrim-filter-changed", n: v.length }); }} /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "48px minmax(140px, 1fr) 60px minmax(110px, 1fr) 72px 148px", gap: 10, padding: "6px 8px", borderBottom: `1px solid ${T.line}` }}>
          {["Region", "Team", "Rank", "Note", "Posted", ""].map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5 }}>{h}</Eyebrow>)}
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {list.length === 0 && <div style={{ padding: 32, textAlign: "center", color: T.dim, fontSize: 13 }}>No teams listed in these regions. Widen the filter or list your own team.</div>}
          {list.map((s) => {
            const t = teams.find((x) => x.id === s.teamId);
            const avg = Math.round(t.members.slice(0, 5).reduce((a, id) => a + byId(id).rating, 0) / 5);
            const tier = rankFromPercentile(Math.min(0.999, Math.max(0, (avg - 1200) / 900)));
            const isMine = t.id === myTeam?.id;
            const isFirstRequestable = !isMine && myTeam && canManage && s.id === firstRequestableId;
            return (
              <div key={s.id} className="row-hover" style={{ display: "grid", gridTemplateColumns: "48px minmax(140px, 1fr) 60px minmax(110px, 1fr) 72px 148px", gap: 10, alignItems: "center", padding: "10px 8px", borderRadius: 4, fontSize: 13 }}>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent }}>{s.region.toUpperCase()}</span>
                <div onClick={() => onViewTeam(t)} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, cursor: "pointer" }}>
                  <div style={{ width: 26, height: 26, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 9.5, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{t.tag}</div>
                  <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{t.name}</div><div style={{ fontSize: 11, color: T.muted }}>{t.members.length} players</div></div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}><Tier tier={tier} size={12} /><span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{avg}</span></div>
                <span style={{ color: s.note ? T.text : T.dim, fontSize: 12.5, whiteSpace: "nowrap" }}>{s.note || "—"}</span>
                <span style={{ color: T.muted, fontSize: 12 }}>{ago(s.postedAt)}</span>
                <div style={{ textAlign: "right" }}>
                  {isMine ? <Tag color={T.accent}>Your listing</Tag>
                    : !myTeam ? <Tag>Need a team</Tag>
                    : !canManage ? <Tag>Captain/officer only</Tag>
                    : pending === s.id ? <Btn size="sm" disabled><Dot pulse /> Requested</Btn>
                    : <Btn size="sm" kind="primary" data-tour={isFirstRequestable ? "request-scrim-btn" : undefined} onClick={() => request(s)} disabled={queue.state !== "idle" || pending}>Request scrim <ChevronRight size={13} /></Btn>}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>Your team</Eyebrow>
          {!myTeam ? <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.5 }}>You're not on a team. Register or apply to one under <b style={{ color: T.text }}>Teams</b> to use the scrim list.</div> : <>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 5, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 11, color: T.muted, border: `1px solid ${T.line2}` }}>{myTeam.tag}</div>
              <div><div style={{ fontWeight: 700 }}>{myTeam.name}</div><div style={{ fontSize: 11.5, color: T.muted }}>{myTeam.region.toUpperCase()} · {myTeam.captain === me.id ? "You are captain" : canManage ? "You are an officer" : "Member"}</div></div>
            </div>
            <div style={{ height: 1, background: T.line, margin: "14px 0" }} />
            {mine ? <>
              <div style={{ fontSize: 13, color: T.muted, marginBottom: 10 }}>Listed in <b style={{ color: T.accent }}>{mine.region.toUpperCase()}</b> {ago(mine.postedAt)}. Requests from other teams show up here.</div>
              {canManage && <Btn kind="danger" size="sm" data-tour="unlist-btn" onClick={unlist}><X size={13} /> Remove listing</Btn>}
            </> : canManage ? <>
              <Eyebrow style={{ marginBottom: 6 }}>List your team</Eyebrow>
              <RegionPicker value={postRegion} onChange={setPostRegion} multi={false} />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) — e.g. Bo3, we host vc" style={{ width: "100%", marginTop: 8, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }} />
              <Btn kind="primary" data-tour="post-scrim-btn" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} onClick={post}><Plus size={14} /> Post to scrim list</Btn>
            </> : <div style={{ fontSize: 13, color: T.muted }}>Only the captain and officers can list the team or request scrims.</div>}
          </>}
        </Panel>
        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>Scrim rules</Eyebrow>
          {["Requests are accepted or denied by the hosting team.", "Once accepted, all 10 players get the same 20-second accept prompt as a PUG.", "Scrims are unrated — captains still report the result for the record, but it never moves your rating."].map((s, i) => (
            <div key={i} style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, padding: "6px 0", borderTop: i ? `1px solid ${T.line}` : "none" }}>{s}</div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   TEAMS
   ───────────────────────────────────────────────────────────── */
function TeamsScreen({ me, teams, setTeams, myTeam, notify, history, onViewMatch, onViewTeam, onView }) {
  const [pendingApp, setPendingApp] = useState(null);
  const [regFilter, setRegFilter] = useState(["na", "sa", "eu", "asia"]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(""); const [newTag, setNewTag] = useState(""); const [newRegion, setNewRegion] = useState("na");
  const [leftTab, setLeftTab] = useState("roster");
  const [confirmDisband, setConfirmDisband] = useState(false);
  const isCap = myTeam?.captain === me.id;
  const isOff = myTeam?.officers.includes(me.id);
  const canManage = isCap || isOff;
  const update = (id, fn) => setTeams(teams.map((t) => (t.id === id ? fn(t) : t)));
  const teamHistory = myTeam ? history.filter((m) => m.teamId === myTeam.id) : [];

  const decide = (pid, ok) => { update(myTeam.id, (t) => ({ ...t, applications: t.applications.filter((a) => a.playerId !== pid), members: ok ? [...t.members, pid] : t.members })); notify(ok ? `${byId(pid).discordName} joined ${myTeam.name}` : "Application denied"); };
  const toggleOfficer = (pid) => update(myTeam.id, (t) => ({ ...t, officers: t.officers.includes(pid) ? t.officers.filter((o) => o !== pid) : [...t.officers, pid] }));
  const kick = (pid) => update(myTeam.id, (t) => ({ ...t, members: t.members.filter((m) => m !== pid), officers: t.officers.filter((o) => o !== pid) }));
  const leave = () => { update(myTeam.id, (t) => ({ ...t, members: t.members.filter((m) => m !== me.id), officers: t.officers.filter((o) => o !== me.id) })); notify("You left the team"); };
  const disband = () => { setTeams(teams.filter((t) => t.id !== myTeam.id)); setConfirmDisband(false); notify(`${myTeam.name} disbanded`); };
  const apply = (t) => { setPendingApp(t.id); update(t.id, (x) => ({ ...x, applications: [...x.applications, { playerId: me.id, note: "" }] })); notify(`Applied to ${t.name}`); setTimeout(() => { setPendingApp(null); update(t.id, (x) => ({ ...x, applications: x.applications.filter((a) => a.playerId !== me.id), members: [...x.members, me.id] })); notify(`${t.name} accepted your application`); }, 4000); };
  const create = () => { if (!newName || !newTag) return; setTeams([{ id: "t" + Date.now(), tag: newTag.toUpperCase().slice(0, 4), name: newName, region: newRegion, captain: me.id, officers: [], members: [me.id], applicationsOpen: true, applications: [] }, ...teams]); setCreating(false); setNewName(""); setNewTag(""); notify("Team registered"); };

  if (myTeam) return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 460px", gap: 16, height: "100%" }}>
      <Panel data-tour="teams-panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 6, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 12, color: T.text, border: `1px solid ${T.line2}` }}>{myTeam.tag}</div>
            <div><H size={22}>{myTeam.name}</H><Eyebrow>{myTeam.region.toUpperCase()} · {myTeam.members.length} players · {myTeam.officers.length} officers</Eyebrow></div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {canManage && <Btn size="sm" onClick={() => update(myTeam.id, (t) => ({ ...t, applicationsOpen: !t.applicationsOpen }))}>{myTeam.applicationsOpen ? <Unlock size={13} color={T.ok} /> : <Lock size={13} color={T.danger} />} Applications {myTeam.applicationsOpen ? "open" : "closed"}</Btn>}
            {isCap && (confirmDisband ? <>
              <Btn size="sm" kind="danger" onClick={disband}>Confirm disband</Btn>
              <Btn size="sm" onClick={() => setConfirmDisband(false)}>Cancel</Btn>
            </> : <Btn size="sm" kind="danger" onClick={() => setConfirmDisband(true)}><LogOut size={13} /> Disband team</Btn>)}
            {!isCap && <Btn size="sm" kind="danger" onClick={leave}><LogOut size={13} /> Leave</Btn>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 10, borderBottom: `1px solid ${T.line}` }}>
          {[["roster", "Roster"], ["applications", "Applications"]].map(([id, label]) => (
            <button key={id} data-tour={id === "applications" ? "apps-tab" : undefined} onClick={() => { setLeftTab(id); bus.emit({ type: "tour_evt", evt: "teams-tab-" + id }); }} style={{ background: "transparent", border: "none", borderBottom: `2px solid ${leftTab === id ? T.accent : "transparent"}`, color: leftTab === id ? T.text : T.muted, padding: "8px 12px", fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>{label}{id === "applications" && myTeam.applications.length > 0 && <Tag color={T.captain} bg={T.captainDim}>{myTeam.applications.length}</Tag>}</button>
          ))}
        </div>
        {leftTab === "roster" ? <>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 76px 68px 66px 64px", gap: 10, padding: "6px 8px", borderBottom: `1px solid ${T.line}` }}>
          {["Player", "Role", "Rank", "Record", ""].map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5 }}>{h}</Eyebrow>)}
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {myTeam.members.map((id) => {
            const p = byId(id); const role = id === myTeam.captain ? "Captain" : myTeam.officers.includes(id) ? "Officer" : "Member";
            return (
              <div key={id} className="row-hover" onClick={() => onView?.(p)} style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 76px 68px 66px 64px", gap: 10, alignItems: "center", padding: "8px", borderRadius: 4, fontSize: 13, cursor: onView ? "pointer" : "default" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><Avatar p={p} size={28} ring={role === "Captain" ? T.captain : null} /><div style={{ minWidth: 0 }}><div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{p.discordName}{id === me.id && <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span>}</div><div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{p.inGameName}</div></div></div>
                <span style={{ color: role === "Captain" ? T.captain : role === "Officer" ? T.accent : T.muted, fontSize: 12, display: "flex", gap: 5, alignItems: "center", whiteSpace: "nowrap" }}>{role === "Captain" ? <Star size={12} fill={T.captain} /> : role === "Officer" ? <Shield size={12} /> : null}{role}</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}><Tier tier={p.tier} /><span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{p.rating}</span></div>
                <span style={{ fontFamily: T.mono, fontSize: 12, whiteSpace: "nowrap" }}>{p.wins}–{p.losses}</span>
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  {isCap && id !== me.id && <button title={myTeam.officers.includes(id) ? "Demote" : "Make officer"} onClick={(e) => { e.stopPropagation(); toggleOfficer(id); }} style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, color: T.muted, flexShrink: 0 }}><Shield size={13} /></button>}
                  {canManage && id !== me.id && id !== myTeam.captain && <button title="Remove" onClick={(e) => { e.stopPropagation(); kick(id); }} style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: T.dangerDim, border: `1px solid ${T.danger}`, borderRadius: 4, color: T.danger, flexShrink: 0 }}><X size={13} /></button>}
                </div>
              </div>
            );
          })}
        </div>
        </> : <div style={{ overflow: "auto", flex: 1 }}>
          {!canManage ? <div style={{ fontSize: 12.5, color: T.muted, padding: "20px 0" }}>Only the captain and officers review applications.</div>
            : myTeam.applications.length === 0 ? <div style={{ fontSize: 12.5, color: T.dim, padding: "20px 0", textAlign: "center" }}>{myTeam.applicationsOpen ? "No pending applications." : "Applications are closed."}</div>
            : myTeam.applications.map((a) => { const p = byId(a.playerId); return (
              <div key={a.playerId} style={{ background: T.raised, borderRadius: 5, padding: 10, marginBottom: 8 }}>
                <div onClick={() => onView?.(p)} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: onView ? "pointer" : "default" }}><Avatar p={p} size={30} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{p.discordName}</div><div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, whiteSpace: "nowrap" }}><Tier tier={p.tier} size={11} /><span style={{ fontFamily: T.mono, color: T.muted }}>{p.rating} · {p.wins}–{p.losses}</span></div></div></div>
                {a.note && <div style={{ fontSize: 12, color: T.muted, marginTop: 8, fontStyle: "italic" }}>“{a.note}”</div>}
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}><Btn size="sm" kind="primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => decide(a.playerId, true)}><Check size={13} /> Accept</Btn><Btn size="sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => decide(a.playerId, false)}><X size={13} /> Deny</Btn></div>
              </div>); })}
        </div>}
      </Panel>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel data-tour="team-history-panel" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>Match history</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "54px 44px minmax(130px, 1fr) 76px 48px", gap: 10, padding: "6px 8px", borderBottom: `1px solid ${T.line}` }}>
            {["Type", "Region", "Opponent", "State", "Result"].map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5 }}>{h}</Eyebrow>)}
          </div>
          <div style={{ overflow: "auto", flex: 1 }}>
            {teamHistory.length === 0 && <div style={{ padding: 32, textAlign: "center", color: T.dim, fontSize: 13 }}>No scrims played yet. Requests you accept from the Scrims tab will show up here.</div>}
            {teamHistory.map((m) => {
              const oppCaptainId = myTeam.members.includes(m.captain1) ? m.captain2 : m.captain1;
              const oppTeam = teams.find((t) => t.captain === oppCaptainId);
              return (
                <div key={m.id} className="row-hover" onClick={() => onViewMatch(m)} style={{ display: "grid", gridTemplateColumns: "54px 44px minmax(130px, 1fr) 76px 48px", alignItems: "center", gap: 10, padding: "8px", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
                  <Tag>{m.type}</Tag>
                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{m.region.toUpperCase()}</span>
                  <span style={{ color: T.muted, whiteSpace: "nowrap" }}>vs {oppTeam?.name || byId(oppCaptainId)?.discordName || "—"}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: m.state === "in dispute" ? T.captain : T.muted }}>{m.state}</span>
                  <span style={{ fontFamily: T.mono, fontWeight: 600, textAlign: "right", color: m.result === "win" ? T.ok : m.result === "loss" ? T.danger : T.muted }}>{m.result === "win" ? "W" : m.result === "loss" ? "L" : "—"}</span>
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel>
          <Eyebrow style={{ marginBottom: 6 }}>Team rules</Eyebrow>
          <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.55 }}>One team per player. Any number of officers. Captains and officers can list the team for scrims, accept requests, and review applications. Players can only have one pending application at a time.</div>
        </Panel>
      </div>
    </div>
  );

  /* not on a team */
  const list = teams.filter((t) => regFilter.includes(t.region));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <Panel style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div><Eyebrow>Teams</Eyebrow><H size={20}>Find a team</H></div>
          <RegionPicker value={regFilter} onChange={setRegFilter} />
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          {list.map((t) => (
            <div key={t.id} className="row-hover" onClick={() => onViewTeam(t)} style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 56px 64px 104px", gap: 10, alignItems: "center", padding: "10px 8px", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><div style={{ width: 30, height: 30, borderRadius: 4, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 10, color: T.muted, border: `1px solid ${T.line2}`, flexShrink: 0 }}>{t.tag}</div><div style={{ minWidth: 0 }}><div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{t.name}</div><div style={{ fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>Captain {byId(t.captain).discordName} · {t.members.length} players</div></div></div>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent }}>{t.region.toUpperCase()}</span>
              <Tag color={t.applicationsOpen ? T.ok : T.dim}>{t.applicationsOpen ? "Open" : "Closed"}</Tag>
              <div style={{ textAlign: "right" }}>{pendingApp === t.id ? <Btn size="sm" disabled><Dot pulse /> Pending</Btn> : <Btn size="sm" kind={t.applicationsOpen ? "primary" : "ghost"} disabled={!t.applicationsOpen || !!pendingApp} onClick={(e) => { e.stopPropagation(); apply(t); }}>Apply</Btn>}</div>
            </div>
          ))}
        </div>
      </Panel>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>Register a team</Eyebrow>
          {!creating ? <>
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, marginBottom: 10 }}>You become captain. You'll be able to list the team for scrims and appoint officers.</div>
            <Btn kind="primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => setCreating(true)} disabled={!!pendingApp}><Plus size={14} /> New team</Btn>
          </> : <>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Team name" style={{ width: "100%", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13, marginBottom: 8 }} />
            <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Tag (max 4)" maxLength={4} style={{ width: "100%", background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13, marginBottom: 8, fontFamily: T.mono }} />
            <RegionPicker value={newRegion} onChange={setNewRegion} multi={false} />
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}><Btn kind="primary" style={{ flex: 1, justifyContent: "center" }} onClick={create}>Register</Btn><Btn onClick={() => setCreating(false)}>Cancel</Btn></div>
          </>}
        </Panel>
        {pendingApp && <Panel><Eyebrow style={{ marginBottom: 6 }}>Pending application</Eyebrow><div style={{ fontSize: 12.5, color: T.muted }}>Waiting on <b style={{ color: T.text }}>{teams.find((t) => t.id === pendingApp)?.name}</b>. You can't apply elsewhere until they decide.</div></Panel>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   LADDER + PROFILE
   ───────────────────────────────────────────────────────────── */
function LadderScreen({ me, onView }) {
  const rows = useMemo(() => [...LADDER].sort((a, b) => b.rating - a.rating), []);
  return (
    <Panel style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
        <div><Eyebrow>Ladder</Eyebrow><H size={20}>Active players</H></div>
        <div style={{ fontSize: 12, color: T.muted, maxWidth: 420, textAlign: "right", lineHeight: 1.45 }}>Letter ranks are percentile buckets over the active population — F- to S+ — so every tier stays populated whatever the playerbase size.</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 70px 80px 90px 90px 70px", gap: 10, padding: "6px 8px", borderBottom: `1px solid ${T.line}` }}>
        {["#", "Player", "Rank", "Rating", "Record", "Win rate", "Disputes"].map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5, textAlign: i > 2 ? "right" : "left" }}>{h}</Eyebrow>)}
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {rows.map((p, i) => (
          <div key={p.id} data-tour={i === 0 ? "ladder-row" : undefined} className="row-hover" onClick={() => onView(p)} style={{ display: "grid", gridTemplateColumns: "44px 1fr 70px 80px 90px 90px 70px", gap: 10, alignItems: "center", padding: "7px 8px", borderRadius: 4, fontSize: 13, cursor: "pointer", background: p.id === me.id ? T.accentDim : "transparent" }}>
            <span style={{ fontFamily: T.mono, color: T.muted, fontSize: 12 }}>{i + 1}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><Avatar p={p} size={26} /><div style={{ minWidth: 0, whiteSpace: "nowrap" }}><span style={{ fontWeight: 600 }}>{p.discordName}</span> <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, marginLeft: 6 }}>{p.inGameName}</span></div></div>
            <Tier tier={p.tier} size={14} />
            <span style={{ fontFamily: T.mono, textAlign: "right" }}>{p.rating}</span>
            <span style={{ fontFamily: T.mono, textAlign: "right", fontSize: 12 }}>{p.wins}–{p.losses}</span>
            <span style={{ fontFamily: T.mono, textAlign: "right", fontSize: 12 }}>{Math.round(100 * p.wins / (p.wins + p.losses))}%</span>
            <span style={{ fontFamily: T.mono, textAlign: "right", fontSize: 12, color: p.disputes ? T.captain : T.dim }}>{p.disputes}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ProfileScreen({ p, me, history, onBack, onViewMatch }) {
  const isMe = p.id === me.id;
  const total = p.wins + p.losses;
  const streak = 3;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <Panel pad={20} data-tour="profile-card">
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Avatar p={p} size={64} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><H size={26}>{p.discordName}</H>{isMe && <Tag color={T.accent}>You</Tag>}</div>
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, marginTop: 4 }}>{p.inGameName} · Discord linked</div>
            </div>
            <div style={{ textAlign: "right" }}><Tier tier={p.tier} size={40} /><Eyebrow>Top {Math.max(1, Math.round((1 - p.percentile) * 100))}%</Eyebrow></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginTop: 20 }}>
            {[["Rating", p.rating], ["Matches", total], ["Record", `${p.wins}–${p.losses}`], ["Win rate", `${Math.round(100 * p.wins / total)}%`], ["Streak", `W${streak}`]].map(([k, v]) => (
              <div key={k} style={{ background: T.raised, borderRadius: 4, padding: "10px 12px" }}><Eyebrow style={{ fontSize: 9.5 }}>{k}</Eyebrow><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 600, marginTop: 4 }}>{v}</div></div>
            ))}
          </div>
        </Panel>
        <Panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Eyebrow style={{ marginBottom: 10 }}>Match history</Eyebrow>
          <div style={{ overflow: "auto", flex: 1 }}>
            {history.map((m) => (
              <div key={m.id} className="row-hover" onClick={() => m.team1 && onViewMatch(m)} style={{ display: "grid", gridTemplateColumns: "60px 60px 1fr 100px 60px", alignItems: "center", gap: 10, padding: "8px", borderRadius: 4, fontSize: 13, cursor: m.team1 ? "pointer" : "default" }}>
                <Tag>{m.type}</Tag><span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{m.region.toUpperCase()}</span><span style={{ color: T.muted }}>{ago(m.ts)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: m.state === "in dispute" ? T.captain : m.state === "in progress" ? T.accent : T.muted }}>{m.state}</span>
                <span style={{ fontFamily: T.mono, fontWeight: 600, textAlign: "right", color: m.result === "win" ? T.ok : m.result === "loss" ? T.danger : T.muted }}>{m.result === "win" ? "W" : m.result === "loss" ? "L" : "—"} {m.delta ? (m.delta > 0 ? `+${m.delta}` : m.delta) : ""}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Panel>
          <Eyebrow style={{ marginBottom: 8 }}>Reliability</Eyebrow>
          {[["Disputes", p.disputes, p.disputes ? T.captain : T.ok], ["Missed accepts (30d)", isMe ? 1 : 0, T.muted], ["Abandons", 0, T.ok]].map(([k, v, c]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderTop: `1px solid ${T.line}`, fontSize: 13 }}><span style={{ color: T.muted }}>{k}</span><span style={{ fontFamily: T.mono, color: c, fontWeight: 600 }}>{v}</span></div>
          ))}
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
function TutorialOverlay({ step, onNext, onFinish }) {
  const [rect, setRect] = useState(null);
  const [ready, setReady] = useState(false);
  const vw = window.innerWidth || 1320, vh = window.innerHeight || 940;
  const [cardPos, setCardPos] = useState({ left: vw / 2 - 165, top: vh / 2 - 80 }); // always a real position — never null, so the blocker can never outlive its own visibility
  const cardRef = useRef(null);
  const s = TOUR_STEPS[step];
  const isLast = step === TOUR_STEPS.length - 1;

  // Track the target continuously: screens mount late, panels scroll, phases swap
  // elements out. Re-measure until found, keep re-measuring after, and if the
  // element vanishes mid-step (e.g. the button we spotlit just got clicked away),
  // keep the last box until the step advances.
  useEffect(() => {
    setRect(null); setReady(false);
    if (!s.target) { setReady(true); return; }
    let alive = true, found = false;
    const measure = () => {
      if (!alive) return;
      const el = document.querySelector(`[data-tour="${s.target}"]`);
      if (!el) return;
      if (!found) { found = true; el.scrollIntoView({ block: "nearest" }); }
      const r = el.getBoundingClientRect();
      setRect((prev) => prev && Math.abs(prev.left - r.left) < 1 && Math.abs(prev.top - r.top) < 1 && Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1 ? prev : r);
      setReady(true);
    };
    measure();
    const iv = setInterval(measure, 150);
    const fallback = setTimeout(() => { if (alive) setReady(true); }, 1500);
    return () => { alive = false; clearInterval(iv); clearTimeout(fallback); };
  }, [step]);

  const pad = 10, dim = "rgba(8,10,13,0.85)";
  const hole = rect ? { l: Math.max(0, rect.left - pad), t: Math.max(0, rect.top - pad), r: Math.min(vw, rect.right + pad), b: Math.min(vh, rect.bottom + pad) } : null;

  // Refine the card's position from its REAL measured size once mounted — this is what
  // kept pushing the card (and its text) off-screen next to wide panels before. If this
  // never fires for any reason, cardPos already holds a safe centered fallback above,
  // so the overlay is never stuck invisible while still blocking clicks.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth || 330, h = el.offsetHeight || 140;
    let left, top;
    if (!hole) { left = vw / 2 - w / 2; top = vh / 2 - h / 2; }
    else if (vh - hole.b >= h + 24) { left = hole.l; top = hole.b + 16; }
    else if (vw - hole.r >= w + 24) { left = hole.r + 16; top = hole.t; }
    else if (hole.t >= h + 24) { left = hole.l; top = hole.t - h - 16; }
    else { left = hole.l; top = hole.b + 16; }
    left = Math.min(Math.max(left, 16), Math.max(16, vw - w - 16));
    top = Math.min(Math.max(top, 16), Math.max(16, vh - h - 16));
    setCardPos({ left, top });
  }, [hole?.l, hole?.t, hole?.r, hole?.b, s.title, s.body, ready]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, pointerEvents: "none", opacity: ready ? 1 : 0, transition: "opacity .15s ease" }}>
      {hole ? <>
        {/* four dimmer slabs around the hole — the hole itself is always left open so the real control underneath stays clickable */}
        <div style={{ position: "fixed", left: 0, top: 0, width: vw, height: hole.t, background: dim, pointerEvents: "auto" }} />
        <div style={{ position: "fixed", left: 0, top: hole.b, width: vw, height: Math.max(0, vh - hole.b), background: dim, pointerEvents: "auto" }} />
        <div style={{ position: "fixed", left: 0, top: hole.t, width: hole.l, height: hole.b - hole.t, background: dim, pointerEvents: "auto" }} />
        <div style={{ position: "fixed", left: hole.r, top: hole.t, width: Math.max(0, vw - hole.r), height: hole.b - hole.t, background: dim, pointerEvents: "auto" }} />
        <div style={{ position: "fixed", left: hole.l, top: hole.t, width: hole.r - hole.l, height: hole.b - hole.t, borderRadius: 10, border: `2px solid ${T.accent}`, animation: "sqSpotlight 1.6s ease-in-out infinite", pointerEvents: "none" }} />
      </> : <div style={{ position: "fixed", inset: 0, background: dim, pointerEvents: "auto" }} />}
      <div ref={cardRef} style={{ position: "fixed", left: cardPos.left, top: cardPos.top, width: 330, background: T.panel, border: `1px solid ${T.line2}`, borderRadius: 8, padding: 18, boxShadow: "0 16px 40px rgba(0,0,0,.55)", pointerEvents: "auto", animation: "sqRise .2s ease" }}>
        <Eyebrow color={T.accent} style={{ marginBottom: 8 }}>Tutorial · {step + 1}/{TOUR_STEPS.length}</Eyebrow>
        <div style={{ fontFamily: T.display, fontWeight: 700, fontSize: 16, marginBottom: 8, color: T.text, textTransform: "uppercase" }}>{s.title}</div>
        <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.5, marginBottom: 14 }}>{s.body}</div>
        {s.type === "action" && rect && <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: T.accentDim, border: `1px solid ${T.accent}`, borderRadius: 4, padding: "6px 10px", fontFamily: T.mono, fontSize: 11.5, color: T.accent, marginBottom: 14 }}><CircleDot size={12} /> {s.hint}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
          {s.type === "info" && ready && <Btn size="sm" kind="primary" onClick={isLast ? onFinish : onNext}>{isLast ? "Finish" : "Next"}{!isLast && <ChevronRight size={13} />}</Btn>}
          {s.type === "action" && !rect && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.dim }}>{ready ? "waiting…" : "locating…"}</span>}
        </div>
      </div>
    </div>
  );
}

function AcceptOverlay({ match, me, onAccepted, onFail, fast }) {
  const ACCEPT_S = 20;
  const [left, setLeft] = useState(ACCEPT_S);
  const [accepted, setAccepted] = useState({});
  const [mine, setMine] = useState(false);
  const all = [...match.team1, ...match.team2];
  const done = useRef(false);

  useEffect(() => {
    // other players trickle in over 1–9s
    const timers = all.filter((p) => p.id !== me.id).map((p) => setTimeout(() => setAccepted((a) => ({ ...a, [p.id]: true })), fast ? rnd(500, 2200) : rnd(900, 9000)));
    const iv = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => { timers.forEach(clearTimeout); clearInterval(iv); };
  }, []);
  useEffect(() => { if (left <= 0 && !done.current) { done.current = true; onFail(mine ? "someone" : "you"); } }, [left]);
  useEffect(() => {
    const n = Object.keys(accepted).length + (mine ? 1 : 0);
    if (n === all.length && !done.current) { done.current = true; setTimeout(onAccepted, 500); }
  }, [accepted, mine]);

  const count = Object.keys(accepted).length + (mine ? 1 : 0);
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
          {all.map((p) => { const ok = p.id === me.id ? mine : accepted[p.id]; return <div key={p.id} title={p.discordName} style={{ width: 34, height: 6, borderRadius: 3, background: ok ? T.accent : T.line2, transition: "background .25s" }} />; })}
        </div>
        <div style={{ color: T.muted, fontSize: 13, marginBottom: 18 }}><span style={{ fontFamily: T.mono, color: T.text }}>{count}/10</span> accepted</div>
        {!mine ? (
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Btn kind="primary" data-tour="accept-btn" style={{ padding: "12px 34px", fontSize: 15 }} onClick={async () => { setMine(true); await api.accept(match.id); }}><Check size={16} strokeWidth={3} /> Accept</Btn>
            <Btn kind="ghost" style={{ padding: "12px 20px" }} onClick={() => { done.current = true; onFail("you"); }}>Decline</Btn>
          </div>
        ) : <div style={{ color: T.accent, fontSize: 13, display: "inline-flex", gap: 8, alignItems: "center" }}><Dot pulse /> Waiting for others…</div>}
        <div style={{ marginTop: 18, fontSize: 12, color: T.dim }}>Not accepting in time puts you on a queue cooldown. Everyone else goes back to the front of the queue.</div>
      </div>
    </div>
  );
}

function Roster({ team, captainId, me, side, label, phase, onView }) {
  const isMySide = team.some((x) => x.id === me.id); // copy-name only makes sense for YOUR captain
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <Eyebrow color={side === 1 ? T.accent : T.muted}>{label}</Eyebrow>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>avg {Math.round(team.reduce((a, p) => a + p.rating, 0) / team.length)}</span>
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
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}><Tier tier={p.tier} size={11} /><span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.dim }}>{p.rating}</span></div>
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
        <Panel pad={20} data-tour="match-modal">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>{m.type} · {m.region.toUpperCase()} · {ago(m.ts)} · match {m.id.slice(-5)}</Eyebrow>
              <H size={24} style={{ color: resultColor }}>{resultLabel}{m.delta ? <span style={{ fontFamily: T.mono, fontSize: 15, marginLeft: 10, color: resultColor }}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span> : null}</H>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={18} /></button>
          </div>
          <Roster team={m.team1} captainId={m.captain1} me={me} side={1} label={onTeam1 ? "Your team" : "Team 1"} phase="completed" onView={onView} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "22px 0" }}><div style={{ flex: 1, height: 1, background: T.line }} /><span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 18, color: T.dim, letterSpacing: "0.1em" }}>VS</span><div style={{ flex: 1, height: 1, background: T.line }} /></div>
          <Roster team={m.team2} captainId={m.captain2} me={me} side={2} label={onTeam1 ? "Opponents" : "Your team"} phase="completed" onView={onView} />
        </Panel>
      </div>
    </div>
  );
}

function TeamDetailModal({ team, teams, history, me, onClose, onViewMatch, onView }) {
  const roster = team.members.map(byId);
  const teamHistory = history.filter((m) => m.teamId === team.id || m.teamId2 === team.id);
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(13,16,20,0.86)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 70, animation: "sqIn .2s ease" }} onClick={onClose}>
      <div style={{ width: 680, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <Panel pad={20} style={{ maxHeight: "85vh", overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 6, background: T.raised, display: "grid", placeItems: "center", fontFamily: T.mono, fontSize: 12, color: T.text, border: `1px solid ${T.line2}` }}>{team.tag}</div>
              <div><H size={22}>{team.name}</H><Eyebrow>{team.region.toUpperCase()} · {team.members.length} players · {team.officers.length} officers</Eyebrow></div>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={18} /></button>
          </div>

          <Eyebrow style={{ marginBottom: 8 }}>Roster</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 76px 68px 66px", gap: 10, padding: "6px 8px", borderBottom: `1px solid ${T.line}` }}>
            {["Player", "Role", "Rank", "Record"].map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5 }}>{h}</Eyebrow>)}
          </div>
          {roster.map((p) => {
            const role = p.id === team.captain ? "Captain" : team.officers.includes(p.id) ? "Officer" : "Member";
            return (
              <div key={p.id} className="row-hover" onClick={() => onView?.(p)} style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 76px 68px 66px", gap: 10, alignItems: "center", padding: "8px", borderRadius: 4, fontSize: 13, cursor: onView ? "pointer" : "default" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><Avatar p={p} size={28} ring={role === "Captain" ? T.captain : null} /><div style={{ minWidth: 0 }}><div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{p.discordName}{me && p.id === me.id && <span style={{ color: T.muted, fontWeight: 400 }}> (you)</span>}</div><div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, whiteSpace: "nowrap" }}>{p.inGameName}</div></div></div>
                <span style={{ color: role === "Captain" ? T.captain : role === "Officer" ? T.accent : T.muted, fontSize: 12, display: "flex", gap: 5, alignItems: "center", whiteSpace: "nowrap" }}>{role === "Captain" ? <Star size={12} fill={T.captain} /> : role === "Officer" ? <Shield size={12} /> : null}{role}</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}><Tier tier={p.tier} /><span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{p.rating}</span></div>
                <span style={{ fontFamily: T.mono, fontSize: 12, whiteSpace: "nowrap" }}>{p.wins}–{p.losses}</span>
              </div>
            );
          })}

          <Eyebrow style={{ margin: "22px 0 8px" }}>Match history</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "54px 44px minmax(130px, 1fr) 76px 48px", gap: 10, padding: "6px 8px", borderBottom: `1px solid ${T.line}` }}>
            {["Type", "Region", "Opponent", "State", "Result"].map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5 }}>{h}</Eyebrow>)}
          </div>
          {teamHistory.length === 0 && <div style={{ padding: 24, textAlign: "center", color: T.dim, fontSize: 13 }}>No scrims played yet.</div>}
          {teamHistory.map((m) => {
            const isHome = m.teamId === team.id;
            const oppId = isHome ? m.teamId2 : m.teamId;
            const oppTeam = teams.find((t) => t.id === oppId);
            const result = isHome ? m.result : (m.result === "win" ? "loss" : m.result === "loss" ? "win" : m.result);
            return (
              <div key={m.id} className="row-hover" onClick={() => onViewMatch(m)} style={{ display: "grid", gridTemplateColumns: "54px 44px minmax(130px, 1fr) 76px 48px", alignItems: "center", gap: 10, padding: "8px", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
                <Tag>{m.type}</Tag>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>{m.region.toUpperCase()}</span>
                <span style={{ color: T.muted, whiteSpace: "nowrap" }}>vs {oppTeam?.name || "—"}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: m.state === "in dispute" ? T.captain : T.muted }}>{m.state}</span>
                <span style={{ fontFamily: T.mono, fontWeight: 600, textAlign: "right", color: result === "win" ? T.ok : result === "loss" ? T.danger : T.muted }}>{result === "win" ? "W" : result === "loss" ? "L" : "—"}</span>
              </div>
            );
          })}
        </Panel>
      </div>
    </div>
  );
}

function MatchChat({ match, me, onView }) {
  const myTeam = match.team1.some((p) => p.id === me.id) ? match.team1 : match.team2;
  const allPlayers = [...match.team1, ...match.team2];
  const [tab, setTab] = useState("team");
  const [msgs, setMsgs] = useState({ team: [], match: [] });
  const [text, setText] = useState("");
  const endRef = useRef(null);
  const push = (ch, m) => setMsgs((s) => ({ ...s, [ch]: [...s[ch], m].slice(-80) }));

  useEffect(() => {
    const iv = setInterval(() => {
      if (Math.random() < 0.55) return;
      const ch = Math.random() < 0.6 ? "team" : "match";
      const pool = ch === "team" ? myTeam : allPlayers;
      const pool2 = pool.filter((p) => p.id !== me.id);
      const from = pick(pool2, 1)[0]; if (!from) return;
      const cannedKey = ch === "team" ? "matchTeam" : "match";
      push(ch, { from, text: CANNED[cannedKey][rnd(0, CANNED[cannedKey].length - 1)], ts: Date.now() });
    }, 4000);
    return () => clearInterval(iv);
  }, [match.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [tab, msgs]);

  const send = async () => { if (!text.trim()) return; push(tab, { from: me, text: text.trim(), ts: Date.now(), me: true }); setText(""); await api.sendChat(tab, text); };

  return (
    <Panel pad={0} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 220 }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}` }}>
        {[["team", "Team"], ["match", "Match"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `2px solid ${tab === id ? T.accent : "transparent"}`, color: tab === id ? T.text : T.muted, padding: "10px 4px", fontSize: 12, fontWeight: 600 }}>{label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {msgs[tab].length === 0 ? <div style={{ margin: "auto", color: T.dim, fontSize: 12.5 }}>No messages yet.</div>
          : msgs[tab].map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", animation: "sqRise .2s ease" }}>
              <div onClick={() => onView?.(m.from)} style={{ cursor: onView ? "pointer" : "default", flexShrink: 0 }}><Avatar p={m.from} size={22} /></div>
              <div style={{ minWidth: 0 }}><span onClick={() => onView?.(m.from)} style={{ fontSize: 12, fontWeight: 700, color: m.me ? T.accent : T.text, cursor: onView ? "pointer" : "default" }}>{m.from.discordName}</span> <span style={{ fontSize: 10.5, color: T.dim, fontFamily: T.mono }}>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><div style={{ fontSize: 13, color: T.text, lineHeight: 1.4, wordBreak: "break-word" }}>{m.text}</div></div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <div style={{ padding: 8, borderTop: `1px solid ${T.line}`, display: "flex", gap: 6 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Message ${tab === "team" ? "team" : "match"}…`} style={{ flex: 1, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 4, padding: "8px 10px", color: T.text, fontSize: 13 }} />
        <Btn size="sm" kind="primary" onClick={send} disabled={!text.trim()}><Send size={13} /></Btn>
      </div>
    </Panel>
  );
}

function MatchScreen({ match, me, onFinished, notify, onView, tutorial, onPhaseChange }) {
  const PARTY_S = 120;
  const [phase, setPhase] = useState("party"); // party → queue → live → reported → completed | dispute
  const [left, setLeft] = useState(PARTY_S);
  const [myReport, setMyReport] = useState(null);
  const [theirReport, setTheirReport] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const myTeamIsOne = match.team1.some((p) => p.id === me.id);
  const myCapId = myTeamIsOne ? match.captain1 : match.captain2; // YOUR team's captain — never the opponent's
  const iAmCaptain = myCapId === me.id;
  const cap = byId(myCapId);

  useEffect(() => {
    if (phase !== "party") return;
    const iv = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(iv);
  }, [phase]);
  // live mode runs on timers; in the tutorial every transition is driven by the tour's Next button (cues below)
  useEffect(() => { if (tutorial) return; if (phase === "party" && left <= 0) { setPhase("queue"); notify("Queue Casual now — both captains are queuing"); setTimeout(() => setPhase("live"), 6000); } }, [left, phase, tutorial]);
  useEffect(() => { onPhaseChange?.(phase); }, [phase]);
  useEffect(() => {
    if (!tutorial) return;
    return bus.on((e) => {
      if (e.type !== "tour_cue") return;
      if (e.cue === "skip-party" && phase === "party") { setPhase("queue"); notify("Queue Casual now — both captains are queuing"); }
      if (e.cue === "go-live" && phase === "queue") setPhase("live");
      if (e.cue === "confirm-report" && phase === "reported") {
        setTheirReport(myReport === "win" ? "loss" : "win");
        setOutcome(myReport);
        setPhase("completed");
        notify(match.type === "SCRIM" ? "Match completed — scrims are unrated" : myReport === "win" ? "Match completed · +17" : "Match completed · −13");
      }
    });
  }, [tutorial, phase, myReport]);

  const report = async (r) => {
    setMyReport(r); setPhase("reported"); await api.reportResult(match.id, r);
    if (tutorial) return; // the tutorial resolves the other captain's report from its own Next step
    setTimeout(() => {
      const agree = Math.random() < 0.75;
      const theirs = agree ? (r === "win" ? "loss" : "win") : r; // they report their own result
      setTheirReport(theirs);
      if (agree) { setOutcome(r); setPhase("completed"); notify(match.type === "SCRIM" ? "Match completed — scrims are unrated" : r === "win" ? "Match completed · +17" : "Match completed · −13"); }
      else { setPhase("dispute"); notify("Reports disagree — match is in dispute"); }
    }, 2500);
  };

  const banner = {
    party: { color: T.captain, title: "Party up", sub: iAmCaptain ? "You're the captain — your teammates add you in-game and join your party. Queue starts in" : `Add ${cap.inGameName} — your captain — in-game and join their party. Queue starts in` },
    queue: { color: T.accent, title: "Queue casual now", sub: "Both captains hit Casual queue on this signal. Stay in party." },
    live: { color: T.accent, title: "Match in progress", sub: iAmCaptain ? "When it ends, report the result below." : "Your captain reports the result when the match ends." },
    reported: { color: T.muted, title: "Waiting for the other captain", sub: `You reported a ${myReport}. Awaiting the other side's report.` },
    completed: { color: T.ok, title: outcome === "win" ? "Victory" : "Defeat", sub: match.type === "SCRIM" ? "Both captains agree. Scrims are unrated — no rating change." : `Both captains agree. Rating updated ${outcome === "win" ? "+17" : "−13"}.` },
    dispute: { color: T.captain, title: "In dispute", sub: "Captains reported different results. A mod will resolve this with both teams — this stays open until then." },
  }[phase];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", animation: "sqIn .25s ease" }}>
      <Panel pad={20} data-tour="match-banner" style={{ borderColor: banner.color, position: "relative", overflow: "hidden" }}>
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
          {(phase === "completed" || phase === "dispute") && <Btn kind="primary" data-tour="back-lobby" onClick={() => onFinished({ outcome, disputed: phase === "dispute" })}>Back to lobby <ChevronRight size={14} /></Btn>}
        </div>
        {phase === "live" && iAmCaptain && (
          <div data-tour="report-bar" style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <button onClick={() => report("win")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: T.ok, color: "#07110F", border: "none", borderRadius: 6, padding: "16px 20px", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", animation: "sqGlow 1.8s ease-in-out infinite" }}><Trophy size={20} /> We won</button>
            <button onClick={() => report("loss")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: T.dangerDim, color: T.danger, border: `2px solid ${T.danger}`, borderRadius: 6, padding: "16px 20px", fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em" }}>We lost</button>
          </div>
        )}
      </Panel>

      <Panel pad={20} data-tour="match-rosters" style={{ flexShrink: 0, maxHeight: "60%", overflow: "auto" }}>
        <Roster team={match.team1} captainId={match.captain1} me={me} side={1} label={myTeamIsOne ? "Your team" : "Team 1"} phase={phase} onView={onView} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "22px 0" }}><div style={{ flex: 1, height: 1, background: T.line }} /><span style={{ fontFamily: T.display, fontWeight: 800, fontSize: 18, color: T.dim, letterSpacing: "0.1em" }}>VS</span><div style={{ flex: 1, height: 1, background: T.line }} /></div>
        <Roster team={match.team2} captainId={match.captain2} me={me} side={2} label={myTeamIsOne ? "Opponents" : "Your team"} phase={phase} onView={onView} />
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

  // fake incoming traffic
  useEffect(() => {
    const iv = setInterval(() => {
      if (party.length < 2 || Math.random() < 0.6) return;
      const from = pick(party.filter((p) => p.id !== me.id), 1)[0]; if (!from) return;
      push({ from, text: CANNED.party[rnd(0, CANNED.party.length - 1)], ts: Date.now() });
    }, 4000);
    return () => clearInterval(iv);
  }, [party, open]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  useEffect(() => { if (open) setUnread(0); }, [open]);

  const send = async () => { if (!text.trim()) return; push({ from: me, text: text.trim(), ts: Date.now(), me: true }); setText(""); await api.sendChat("party", text); };

  if (!open) return (
    <button data-tour="chat-toggle" onClick={() => setOpen(true)} style={{ position: "absolute", right: 16, bottom: 16, background: T.raised, border: `1px solid ${T.line2}`, borderRadius: 6, padding: "8px 12px", color: T.text, display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 600 }}>
      <MessageSquare size={14} /> Chat {unread > 0 && <span style={{ background: T.accent, color: "#07110F", borderRadius: 10, fontSize: 10.5, padding: "1px 6px", fontFamily: T.mono }}>{unread}</span>}
    </button>
  );
  const disabled = party.length < 2;
  return (
    <div data-tour="chat-toggle" style={{ position: "absolute", right: 16, bottom: 16, width: 300, height: 380, background: T.panel, border: `1px solid ${T.line2}`, borderRadius: 8, boxShadow: "0 16px 40px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", zIndex: 55, animation: "sqRise .2s ease", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${T.line}`, padding: "10px 12px" }}>
        <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.text }}>Party chat</div>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: T.muted, padding: 4 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {disabled ? <div style={{ margin: "auto", color: T.dim, fontSize: 12.5, textAlign: "center", padding: 20, lineHeight: 1.5 }}>Invite someone to your party to chat.</div>
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
  const [teams, setTeams] = useState(TEAMS_SEED);
  const [scrims, setScrims] = useState(SCRIMS_SEED);
  const [history, setHistory] = useState(HISTORY_SEED);
  const [chatOpen, setChatOpen] = useState(true);
  const [viewProfile, setViewProfile] = useState(null);
  const [viewMatch, setViewMatch] = useState(null);
  const [viewTeam, setViewTeam] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [tourStep, setTourStep] = useState(-1);
  const [preTourNav, setPreTourNav] = useState("play");
  const startTour = () => { setPreTourNav(nav); setChatOpen(false); setTourStep(0); };
  const [matchPhase, setMatchPhase] = useState(null);
  const [tourEvt, setTourEvt] = useState(null);
  const [tourScrimId, setTourScrimId] = useState(null);
  const notify = useCallback((text) => { const id = Date.now() + Math.random(); setToasts((t) => [...t, { id, text }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800); }, []);

  useEffect(() => { if (me) setParty([me]); }, [me]);
  useEffect(() => { if (!me) return; const f = async () => setPop(await api.population()); f(); const iv = setInterval(f, 8000); return () => clearInterval(iv); }, [me]);
  useEffect(() => bus.on((e) => { if (e.type === "match_found") { setQueue({ state: "idle" }); setPendingMatch(e.match); } }), []);
  useEffect(() => {
    if (!pendingMatch) return;
    const win = getCurrentWindow();
    win.unminimize().catch(() => {});
    win.setFocus().catch(() => {});
    win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }, [pendingMatch]);
  useEffect(() => {
    if (tourStep < 0) return;
    const step = TOUR_STEPS[tourStep];
    if (step.nav && step.nav !== nav) { setNav(step.nav); setViewProfile(null); }
  }, [tourStep]);
  // tour engine: action steps advance only when their condition proves the user did the real thing
  useEffect(() => {
    if (tourStep < 0) return;
    const s = TOUR_STEPS[tourStep];
    const myTeamNow = me ? teams.find((t) => t.members.includes(me.id)) : null;
    if (!s.when || !s.when({ queue, pendingMatch, match, matchPhase, party, viewMatch, viewProfile, scrims, myTeam: myTeamNow, evt: tourEvt, chatOpen })) return;
    const t = setTimeout(() => setTourStep((cur) => (cur === tourStep ? cur + 1 : cur)), 400);
    return () => clearTimeout(t);
  }, [tourStep, queue, pendingMatch, match, matchPhase, party, viewMatch, viewProfile, scrims, teams, tourEvt, chatOpen]);
  useEffect(() => { if (!match) setMatchPhase(null); }, [match]);
  useEffect(() => bus.on((e) => { if (e.type === "tour_evt") { setTourEvt(e); if (e.evt === "scrim-requested") setTourScrimId(e.scrimId); } }), []);
  useEffect(() => { setTourEvt(null); }, [tourStep]);

  // Next on info steps can also drive the simulation forward, so the user reads at their own pace
  const tourNext = () => {
    const s = TOUR_STEPS[tourStep];
    if (s?.advance === "pop-match") bus.emit({ type: "match_found", match: buildMatch(queue.regions || ["na", "eu"], party.map((p) => p.id)) });
    else if (s?.advance === "pop-scrim-match" && tourScrimId && myTeam) fireScrimMatch(tourScrimId, myTeam.id);
    else if (s?.advance === "skip-party" || s?.advance === "go-live" || s?.advance === "confirm-report") bus.emit({ type: "tour_cue", cue: s.advance });
    else if (s?.advance === "close-modal") setViewMatch(null);
    else if (s?.advance === "close-profile") setViewProfile(null);
    setTourStep((x) => Math.min(TOUR_STEPS.length - 1, x + 1));
  };

  const myTeam = me ? teams.find((t) => t.members.includes(me.id)) : null;

  if (!me) return <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", fontFamily: T.body, color: T.text }}><style>{css}</style><Login onLogin={(u) => { setMe(u); setChatOpen(false); setTourStep(0); }} /></div>;

  const NAV = [["play", "PUG", Crosshair], ["scrims", "Scrims", Swords], ["teams", "Teams", Users], ["ladder", "Ladder", Trophy], ["profile", "Profile", User]];
  const go = (id) => { setNav(id); setViewProfile(null); };

  let content;
  if (match) content = <MatchScreen key={match.id} match={match} me={me} notify={notify} onView={setViewProfile} tutorial={tourStep >= 0} onPhaseChange={setMatchPhase} onFinished={({ outcome, disputed }) => {
    const result = disputed ? "—" : outcome;
    const delta = disputed || match.type === "SCRIM" ? 0 : (outcome === "win" ? 17 : -13);
    setHistory([{ id: match.id, ts: Date.now(), region: match.region, type: match.type, result, state: disputed ? "in dispute" : "completed", delta, teamId: match.type === "SCRIM" ? myTeam?.id : undefined, teamId2: match.type === "SCRIM" ? teams.find((t) => t.captain === match.captain2)?.id : undefined, captain1: match.captain1, captain2: match.captain2, team1: match.team1, team2: match.team2 }, ...history]);
    setMatch(null);
  }} />;
  else if (viewProfile) content = <ProfileScreen p={viewProfile} me={me} history={history} onBack={() => setViewProfile(null)} onViewMatch={setViewMatch} />;
  else if (nav === "play") content = <PlayScreen me={me} party={party} setParty={setParty} queue={queue} setQueue={setQueue} cooldownUntil={cooldownUntil} history={history} notify={notify} onViewMatch={setViewMatch} onView={setViewProfile} tutorial={tourStep >= 0} />;
  else if (nav === "scrims") content = <ScrimsScreen me={me} myTeam={myTeam} teams={teams} scrims={scrims} setScrims={setScrims} notify={notify} queue={queue} onViewTeam={setViewTeam} tutorial={tourStep >= 0} />;
  else if (nav === "teams") content = <TeamsScreen me={me} teams={teams} setTeams={setTeams} myTeam={myTeam} notify={notify} history={history} onViewMatch={setViewMatch} onViewTeam={setViewTeam} onView={setViewProfile} />;
  else if (nav === "ladder") content = <LadderScreen me={me} onView={setViewProfile} />;
  else content = <ProfileScreen p={me} me={me} history={history} onBack={() => {}} onViewMatch={setViewMatch} />;

  return (
    <div className="sq" style={{ height: "100vh", width: "100vw", boxSizing: "border-box", background: T.bg, color: T.text, fontFamily: T.body, fontSize: 13, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      <style>{css}</style>
      {/* title bar */}
      <div style={{ height: 44, display: "flex", alignItems: "center", padding: "0 14px", borderBottom: `1px solid ${T.line}`, background: T.panel, gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}><div style={{ width: 22, height: 22, borderRadius: 4, background: T.accent, display: "grid", placeItems: "center" }}><Crosshair size={14} color="#07110F" strokeWidth={2.5} /></div><span style={{ fontFamily: T.display, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.02em" }}>Sudden Queue</span></div>
        {/* population strip */}
        <div style={{ display: "flex", gap: 14, marginLeft: 6 }}>
          {[["Online", pop.online, T.ok], ["In queue", pop.inQueue + (queue.state === "queued" ? party.length : 0), T.accent], ["In match", pop.inMatch + (match ? 10 : 0), T.captain]].map(([k, v, c]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={c} /><span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 600 }}>{v}</span><span style={{ fontSize: 11.5, color: T.muted }}>{k}</span></div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {queue.state === "queued" && !match && <button onClick={() => go("play")} style={{ background: T.accentDim, border: `1px solid ${T.accent}`, color: T.accent, borderRadius: 4, padding: "4px 10px", fontFamily: T.mono, fontSize: 11.5, display: "flex", gap: 6, alignItems: "center" }}><Dot pulse /> IN QUEUE</button>}
        {match && <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.captain, display: "flex", gap: 6, alignItems: "center" }}><Dot color={T.captain} pulse /> IN MATCH</span>}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}><Avatar p={me} size={24} /><span style={{ fontWeight: 600 }}>{me.discordName}</span><Tier tier={me.tier} size={12} /></div>
        <button onClick={startTour} title="Replay tutorial" style={{ background: "transparent", border: `1px solid ${T.line2}`, borderRadius: "50%", width: 22, height: 22, display: "grid", placeItems: "center", color: T.muted, fontSize: 12, fontWeight: 700, fontFamily: T.mono, padding: 0 }}>?</button>
        <button onClick={() => setMe(null)} title="Sign out" style={{ background: "transparent", border: "none", color: T.dim, padding: 4 }}><LogOut size={14} /></button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* nav rail */}
        <div data-tour="nav-rail" style={{ width: 72, borderRight: `1px solid ${T.line}`, background: T.panel, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 10, gap: 4 }}>
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

      {pendingMatch && <AcceptOverlay match={pendingMatch} me={me} fast={tourStep >= 0}
        onAccepted={() => { setMatch(pendingMatch); setPendingMatch(null); go("play"); }}
        onFail={(who) => { setPendingMatch(null);
          if (tourStep >= 0) { setQueue({ state: "idle" }); setTourStep(TOUR_STEPS.findIndex((x) => x.id === "queue")); notify("No cooldown during the tutorial — queue again"); return; }
          if (who === "you") { setCooldownUntil(Date.now() + 30000); notify("You didn't accept — 30s cooldown (5 min in production)"); } else { notify("A player didn't accept. You're back in queue with priority."); setQueue({ state: "queued", since: Date.now() - 20000, regions: ["na", "eu"] }); api.joinQueue({ regions: ["na", "eu"], partyIds: party.map((p) => p.id) }); } }} />}

      {viewMatch && <MatchHistoryModal m={viewMatch} me={me} onClose={() => setViewMatch(null)} onView={(p) => { setViewMatch(null); setViewProfile(p); }} />}

      {viewTeam && <TeamDetailModal team={viewTeam} teams={teams} history={history} me={me} onClose={() => setViewTeam(null)} onViewMatch={(m) => { setViewTeam(null); setViewMatch(m); }} onView={(p) => { setViewTeam(null); setViewProfile(p); }} />}

      <ChatDock me={me} party={party} open={chatOpen} setOpen={setChatOpen} onView={setViewProfile} />

      {tourStep >= 0 && <TutorialOverlay step={tourStep}
        onNext={tourNext}
        onFinish={() => { setTourStep(-1); setNav(preTourNav); setViewProfile(null); }} />}

      {/* toasts */}
      <div style={{ position: "absolute", top: 54, right: 16, display: "flex", flexDirection: "column", gap: 6, zIndex: 60, pointerEvents: "none" }}>
        {toasts.map((t) => <div key={t.id} style={{ background: T.raised, border: `1px solid ${T.line2}`, borderLeft: `3px solid ${T.accent}`, borderRadius: 4, padding: "8px 12px", fontSize: 12.5, animation: "sqRise .2s ease", boxShadow: "0 6px 20px rgba(0,0,0,.35)", display: "flex", gap: 8, alignItems: "center" }}><Bell size={12} color={T.accent} />{t.text}</div>)}
      </div>
    </div>
  );
}

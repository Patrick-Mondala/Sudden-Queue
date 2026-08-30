
/** Small delay used by the login poll and the reconnect backoff. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Server client.
 *
 * Drop-in replacement for the prototype's mock `api` object and `bus`. The
 * prototype was written with this boundary in mind: the UI never touched
 * anything except those two, so wiring the real backend is a swap rather than a
 * rewrite.
 *
 *   api  -> HTTP calls, same method names and shapes as before
 *   bus  -> WebSocket, same on/emit surface the UI already subscribes to
 */

const DEFAULT_BASE = "http://127.0.0.1:3000";

/** Where the server lives. Overridable for a hosted deployment. */
export const BASE_URL = import.meta.env?.VITE_API_URL ?? DEFAULT_BASE;

/**
 * What this build calls itself, sent with every request.
 *
 * Defined by the build from `tauri.conf.json`, so it is the version of the
 * installer this copy came from rather than a number maintained beside it. A
 * deployment that publishes releases refuses anything below the one it serves,
 * and a client that cannot say what it is counts as below.
 *
 * Null only when something has built this without the define -- which is not a
 * version, and is treated as one that fails the floor rather than one that
 * passes it.
 */
export const CLIENT_VERSION = import.meta.env?.VITE_APP_VERSION ?? null;

const TOKEN_KEY = "sq_session_token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable; the session simply will not survive a restart.
  }
}

/** Error carrying the server's machine-readable code, not just a message. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (CLIENT_VERSION) headers["X-Client-Version"] = CLIENT_VERSION;

  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A rejected fetch is opaque by design: the browser refuses to tell JS
    // whether the server was unreachable or the response failed a CORS check,
    // because leaking that would itself be a cross-origin information leak.
    // So the message names both rather than asserting the wrong one.
    throw new ApiError(
      0,
      "NETWORK",
      `Could not reach ${BASE_URL}. The server may be down, or blocking this origin.`,
    );
  }

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    // The one refusal no screen can work around and no retry can clear: the
    // server serves a newer version than this one. Announced on the bus as
    // well as thrown, because it can arrive in answer to any call and only one
    // part of the app can do anything about it -- a caller that merely showed
    // the message would leave someone reading "out of date" on a screen that
    // still looks usable.
    if (response.status === 426) announceVersionRefusal(payload?.minimum ?? null);

    throw new ApiError(
      response.status,
      payload?.error ?? "HTTP_ERROR",
      payload?.message ?? response.statusText,
    );
  }

  return payload;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────
   AUTH
   ───────────────────────────────────────────────────────────── */

/**
 * Starts a desktop login: asks for a handoff, opens the browser, then polls
 * until the session lands.
 *
 * `openUrl` is injected so this works in Tauri (shell opener) and in a plain
 * browser during development without branching here.
 */
export async function loginWithDiscord({ openUrl, signal, pollIntervalMs = 1500 } = {}) {
  const start = await request("/auth/desktop/start", { method: "POST", auth: false });

  if (openUrl) await openUrl(start.url);
  else window.open(start.url, "_blank", "noopener");

  const deadline = Date.now() + start.expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ApiError(0, "CANCELLED", "Login cancelled");

    await sleep(pollIntervalMs);

    let result;
    try {
      result = await request(`/auth/desktop/poll/${start.handoffId}`, { auth: false });
    } catch (err) {
      // A rejected or expired handoff is terminal; anything else is likely a
      // blip while the browser is still on Discord, so keep waiting.
      if (err.status === 401 || err.status === 410) throw err;
      continue;
    }

    if (result?.status === "ready") {
      setToken(result.token);
      return result.token;
    }
  }

  throw new ApiError(0, "LOGIN_TIMEOUT", "Login timed out");
}

export async function logout() {
  try {
    await request("/auth/logout", { method: "POST" });
  } finally {
    setToken(null);
  }
}


/* ─────────────────────────────────────────────────────────────
   API — mirrors the prototype's mock surface
   ───────────────────────────────────────────────────────────── */

export const api = {
  me: () => request("/me"),
  history: (limit = 25) => request(`/me/history?limit=${limit}`),
  setInGameName: (name) => request("/me/in-game-name", { method: "PATCH", body: { name } }),

  getParty: () => request("/party"),
  getInvites: () => request("/party/invites"),
  onlinePlayers: () => request("/players/online"),
  invite: (userId) => request("/party/invite", { method: "POST", body: { userId } }),
  acceptInvite: (inviteId) => request(`/party/invite/${inviteId}/accept`, { method: "POST" }),
  declineInvite: (inviteId) => request(`/party/invite/${inviteId}/decline`, { method: "POST" }),
  leaveParty: () => request("/party/leave", { method: "POST" }),
  kick: (userId) => request("/party/kick", { method: "POST", body: { userId } }),

  disputes: () => request("/mod/disputes"),
  resolveDispute: (matchId, winner, note) =>
    request(`/mod/disputes/${matchId}/resolve`, { method: "POST", body: { winner, note } }),

  findPlayers: (q) => request(`/mod/users?q=${encodeURIComponent(q)}`),
  suspensions: () => request("/mod/suspensions"),
  moderationHistory: (userId) => request(`/mod/users/${userId}/history`),
  suspend: (userId, hours, reason) =>
    request(`/mod/users/${userId}/suspend`, { method: "POST", body: { hours, reason } }),
  reinstate: (userId, note) =>
    request(`/mod/users/${userId}/reinstate`, { method: "POST", body: { note } }),

  chatHistory: (channel) => request(`/chat/${channel}`),

  ladder: (limit, offset) => request(`/ladder?limit=${limit}&offset=${offset}`),
  playerProfile: (userId) => request(`/players/${userId}`),

  scrims: (region) => request(region ? `/scrims?region=${region}` : "/scrims"),
  postListing: (region, note) => request("/scrims", { method: "POST", body: { region, note } }),
  removeListing: () => request("/scrims/mine", { method: "DELETE" }),
  requestScrim: (listingId) => request(`/scrims/${listingId}/request`, { method: "POST" }),
  withdrawScrimRequest: (requestId) =>
    request(`/scrims/requests/${requestId}/withdraw`, { method: "POST" }),
  decideScrimRequest: (requestId, accept) =>
    request(`/scrims/requests/${requestId}/decide`, { method: "POST", body: { accept } }),

  listTeams: (region) => request(region ? `/teams?region=${region}` : "/teams"),
  getTeam: (teamId) => request(`/teams/${teamId}`),
  myTeam: () => request("/me/team"),
  createTeam: (body) => request("/teams", { method: "POST", body }),
  applyToTeam: (teamId, note) => request(`/teams/${teamId}/apply`, { method: "POST", body: { note } }),
  withdrawApplication: () => request("/me/application/withdraw", { method: "POST" }),
  decideApplication: (applicationId, accept) =>
    request(`/team/applications/${applicationId}/decide`, { method: "POST", body: { accept } }),
  setApplicationsOpen: (open) =>
    request("/team/applications-open", { method: "PATCH", body: { open } }),
  setStarter: (userId, starting) =>
    request(`/team/members/${userId}/starter`, { method: "POST", body: { starting } }),
  confirmLineup: (requestId, userIds) =>
    request(`/scrims/requests/${requestId}/lineup`, { method: "POST", body: { userIds } }),

  setTeamRole: (userId, role) =>
    request(`/team/members/${userId}/role`, { method: "POST", body: { role } }),
  transferCaptaincy: (userId) => request("/team/captain", { method: "POST", body: { userId } }),
  removeTeamMember: (userId) => request(`/team/members/${userId}`, { method: "DELETE" }),
  leaveTeam: () => request("/team/leave", { method: "POST" }),
  disbandTeam: () => request("/team", { method: "DELETE" }),

  joinQueue: (regions) => request("/queue/join", { method: "POST", body: { regions } }),
  leaveQueue: () => request("/queue/leave", { method: "POST" }),
  // Unauthenticated: the sign-in screen needs the deployment's name before
  // anyone has signed in.
  config: () => request("/config", { auth: false }),
  queueStats: () => request("/queue/stats", { auth: false }),

  getMatch: (matchId) => request(`/match/${matchId}`),
  accept: (matchId) => request(`/match/${matchId}/accept`, { method: "POST" }),
  decline: (matchId) => request(`/match/${matchId}/decline`, { method: "POST" }),
  reportResult: (matchId, winner) =>
    request(`/match/${matchId}/report`, { method: "POST", body: { winner } }),
};

/* ─────────────────────────────────────────────────────────────
   BUS — WebSocket with the prototype's on/emit surface
   ───────────────────────────────────────────────────────────── */

const HEARTBEAT_MS = 5000;
const MAX_BACKOFF_MS = 15000;

/**
 * Live connection to the server.
 *
 * Keeps the prototype's `bus.on(fn)` contract so existing subscribers work
 * unchanged. Reconnects with backoff, and sends the heartbeat the server uses
 * as queue liveness — without it a queued party is pruned as a dead client.
 */
export class RealtimeBus {
  constructor(baseUrl = BASE_URL) {
    this.baseUrl = baseUrl;
    this.listeners = new Set();
    this.socket = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.attempts = 0;
    this.closedByUs = false;
    this.status = "disconnected";
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (err) {
        console.error("bus listener threw", err);
      }
    }
  }

  connect() {
    const token = getToken();
    if (!token) return;

    this.closedByUs = false;
    this._clearReconnect();

    // Whatever was open is being replaced. Without this the previous socket
    // stays open with its handlers attached and its registration alive on the
    // server, so every event arrives down both and the app renders each
    // message, each party update and each invite twice.
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closing; the identity check below covers the rest.
      }
      this.socket = null;
    }

    const url = new URL(this.baseUrl.replace(/^http/, "ws"));
    url.pathname = "/ws";
    url.searchParams.set("token", token);
    // In the URL rather than a header: nothing lets script set headers on a
    // WebSocket handshake, so this is the only request that has to say its
    // version another way.
    if (CLIENT_VERSION) url.searchParams.set("v", CLIENT_VERSION);

    this._setStatus("connecting");
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this._setStatus("connected");
      this._startHeartbeat();
    };

    socket.onmessage = (raw) => {
      // An orphan we have already replaced still delivers whatever the server
      // sent before it noticed. Emitting that would be a duplicate of what the
      // live socket is about to hand us.
      if (this.socket !== socket) return;

      const event = safeParse(raw.data);
      if (event?.type) this.emit(event);
    };

    socket.onclose = (ev) => {
      // A close belonging to a socket that has since been replaced says
      // nothing about the current one. Acting on it schedules a reconnect for
      // a connection that is already healthy, and that second connect leaves
      // the healthy one orphaned -- which is how one blip became two live
      // sockets and every event arriving twice.
      if (this.socket !== socket) return;

      this._stopHeartbeat();
      this._setStatus("disconnected");

      // 4401 means the token was rejected; retrying with it is pointless.
      if (this.closedByUs || ev.code === 4401) {
        if (ev.code === 4401) this.emit({ type: "auth.expired" });
        return;
      }
      this._scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows, so reconnection is handled there.
    };
  }

  disconnect() {
    this.closedByUs = true;
    this._clearReconnect();
    this._stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closing.
      }
      this.socket = null;
    }
    this._setStatus("disconnected");
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: "connection.status", status });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_MS);
    this.send({ type: "heartbeat" });
  }

  _stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  _scheduleReconnect() {
    this.attempts += 1;
    // Exponential backoff with jitter, so a server restart does not get
    // hammered by every client reconnecting on the same tick.
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempts - 1));
    const delay = base * (0.5 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const bus = new RealtimeBus();

/**
 * Says on the bus that the server has refused this version.
 *
 * A function rather than a call to `bus` inside `request`, because the calls
 * are written above the bus that carries the news and a const cannot be used
 * before it exists. Hoisting makes this legal where referencing `bus` directly
 * would not be.
 */
function announceVersionRefusal(minimum) {
  bus.emit({ type: "client.tooOld", minimum });
}

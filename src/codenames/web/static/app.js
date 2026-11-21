import { emblem, logoMark, spyGlyph } from "./art.js";
import { copyText, h, openDialog, toast } from "./dom.js";
import { getVolume, isMuted, setMuted, setVolume, sfx, unlockAudio } from "./sound.js";

const TEAMS = ["red", "blue"];
const TEAM_NAME = { red: "Red", blue: "Blue" };
const KIND_NAME = { red: "Red agent", blue: "Blue agent", civilian: "Civilian", assassin: "Assassin" };
const TIMER_LABEL = { 0: "Off", 60: "1 min", 90: "1½ min", 120: "2 min", 180: "3 min", 300: "5 min" };
const OVERLAY_DELAY = 1400;
const NARROW_SIDE = "(max-width: 1399px)";

const app = document.getElementById("app");
const fx = document.getElementById("fx");

const URL_TOKEN = takeTokenFromUrl();

const S = {
  config: { public_url: null, lan_url: null, decks: [], timers: [0], reactions: [] },
  token: URL_TOKEN || localStorage.getItem("codenames.token") || newToken(),
  name: localStorage.getItem("codenames.name") || "",
  code: null,
  ws: null,
  retry: 0,
  reconnectTimer: null,
  connected: false,
  fatal: null,
  me: null,
  log: [],
  state: null,
  dom: null, // the game screen, kept between renders so cards can animate
  ui: freshUi(),
  timer: { endAt: 0, total: 0, lastTick: 0 },
};
localStorage.setItem("codenames.token", S.token);

function freshUi() {
  return {
    sideOpen: false,
    unread: 0,
    menu: false,
    clueNumber: null,
    overlayHidden: false,
    overlayAt: 0,
    pending: false,
  };
}

// "Continue on another device" links carry the player's token: /r/CODE?me=TOKEN.
function takeTokenFromUrl() {
  const params = new URLSearchParams(location.search);
  const token = params.get("me");
  if (!token || !/^[0-9a-f]{16,64}$/.test(token)) return null;
  history.replaceState({}, "", location.pathname);
  return token;
}

function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ADJECTIVES = ["Silent", "Secret", "Shady", "Sly", "Masked", "Midnight", "Velvet", "Hidden", "Covert", "Rogue"];
const NOUNS = ["Fox", "Owl", "Falcon", "Raven", "Cobra", "Panther", "Shadow", "Cipher", "Ghost", "Lynx"];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const suggestName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`;

function saveName(name) {
  name = (name || "").trim().slice(0, 20);
  if (!name) return S.name;
  S.name = name;
  localStorage.setItem("codenames.name", name);
  return name;
}

const $ = (sel) => document.querySelector(sel);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const member = (st, id) => st?.members.find((m) => m.member === id);
const teamOf = (st, t) => st.members.filter((m) => m.team === t);
const spymasterOf = (st, t) => st.members.find((m) => m.team === t && m.role === "spymaster");
const initials = (name) =>
  (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ routing
function go(path) {
  history.pushState({}, "", path);
  router();
}

function router() {
  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})\/?$/);
  if (match) enterRoom(match[1].toUpperCase());
  else showHome();
}
window.addEventListener("popstate", router);

// ------------------------------------------------------------------ home
function showHome() {
  closeSocket();
  S.code = null;
  S.state = null;
  S.dom = null;
  document.title = "Codenames";
  const nameInput = h("input", { class: "text", value: S.name, placeholder: suggestName(), maxlength: 20, "aria-label": "Your name" });
  const codeInput = h("input", { class: "text", placeholder: "CODE", maxlength: 8, autocapitalize: "characters", "aria-label": "Table code" });
  const create = async () => {
    saveName(nameInput.value || nameInput.placeholder);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).detail || "Could not create a table");
      go(`/r/${(await res.json()).room}`);
    } catch (e) {
      toast(e.message, true);
    }
  };
  const join = async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return codeInput.focus();
    saveName(nameInput.value || nameInput.placeholder);
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    if (!res.ok) return toast("No table with that code", true);
    go(`/r/${code}`);
  };
  codeInput.addEventListener("keydown", (e) => e.key === "Enter" && join());
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && create());
  const demo = ["red", "civilian", "blue", "assassin", "blue", "red"];
  const words = ["MOON", "PIANO", "SPY", "NIGHT", "ROBOT", "FOX"];
  app.replaceChildren(
    h(
      "div",
      { class: "home" },
      h(
        "div",
        { class: "home-bg", "aria-hidden": "true" },
        demo.map((kind, i) =>
          h(
            "div",
            { class: `float-card k-${kind}`, style: { "--i": i } },
            h("div", { class: "card-in" }, h("div", { class: "face front" }, h("span", { class: "word" }, words[i])), h("div", { class: "face back" }, emblem(kind))),
          ),
        ),
      ),
      h(
        "div",
        { class: "home-card" },
        logo(),
        h("p", { class: "tagline" }, "Two teams, one grid, a secret key. Spymasters give one-word clues, operatives hunt for their agents, and nobody wants to meet the assassin."),
        h(
          "div",
          { class: "home-form" },
          h("label", {}, "Your code name", nameInput),
          h("button", { class: "btn primary big", onclick: create }, "Create a table"),
          h("div", { class: "or" }, "or join with a code"),
          h("div", { class: "join-row" }, codeInput, h("button", { class: "btn", onclick: join }, "Join")),
        ),
        h("div", { class: "home-links" }, h("button", { class: "linklike", onclick: showRules }, "How to play")),
      ),
    ),
  );
}

function logo(small = false) {
  return h("div", { class: `logo${small ? " small" : ""}` }, logoMark(), h("span", { class: "logo-text" }, h("span", { class: "lt-red" }, "Word"), " ", h("span", { class: "lt-blue" }, "Spies")));
}

// ------------------------------------------------------------------ room / socket
async function enterRoom(code) {
  closeSocket();
  Object.assign(S, { code, state: null, log: [], fatal: null, me: null, connected: false, retry: 0, dom: null });
  S.ui = freshUi();
  document.title = `Codenames · ${code}`;
  if (!S.name && !URL_TOKEN) await askName(`Join table ${code}`);
  buildShell();
  connect();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/${S.code}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: S.token, name: S.name }));
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false;
    renderConn();
    if (S.fatal) return;
    const delay = Math.min(8000, 400 * 2 ** S.retry++);
    S.reconnectTimer = setTimeout(connect, delay);
  };
}

function closeSocket() {
  clearTimeout(S.reconnectTimer);
  const ws = S.ws;
  S.ws = null;
  if (ws) ws.close();
}

function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
  else toast("Not connected, reconnecting…", true);
}

function onMessage(msg) {
  switch (msg.type) {
    case "welcome":
      S.me = msg.you;
      S.log = msg.log;
      S.connected = true;
      S.retry = 0;
      renderConn();
      renderFeed();
      break;
    case "state":
      applyState(msg);
      break;
    case "log":
      S.log.push(msg.entry);
      appendFeed(msg.entry);
      if (msg.entry.kind === "chat" && msg.entry.member !== S.me) {
        sfx.chat();
        if (!S.ui.sideOpen && window.matchMedia(NARROW_SIDE).matches) {
          S.ui.unread++;
          renderTop();
        }
      }
      break;
    case "react":
      showReaction(msg);
      break;
    case "error":
      S.ui.pending = false;
      toast(msg.message, true);
      sfx.error();
      if (S.state) render();
      break;
    case "fatal":
      S.fatal = msg.message;
      closeSocket();
      showFatal(msg.message);
      break;
  }
}

function showFatal(message) {
  S.dom = null;
  app.replaceChildren(
    h(
      "div",
      { class: "center-msg" },
      h("div", {}, logo(), h("h2", {}, message), h("p", {}, "Tables close a while after everyone has left."), h("button", { class: "btn primary big", onclick: () => go("/") }, "Start a new table")),
    ),
  );
}

// ------------------------------------------------------------------ state
function applyState(next) {
  const prev = S.state;
  S.state = next;
  S.ui.pending = false;
  if (!prev) renderFeed();
  const g = next.game;
  if (g && g.time_left != null && next.status === "playing") {
    S.timer.endAt = performance.now() + g.time_left * 1000;
    S.timer.total = g.time_total;
  } else S.timer.endAt = 0;
  if (next.status !== prev?.status || next.game_no !== prev?.game_no) {
    S.ui.overlayHidden = false;
    S.ui.overlayAt = next.status === "game_over" && prev?.status === "playing" ? performance.now() + OVERLAY_DELAY : 0;
    if (S.ui.overlayAt) setTimeout(renderOverlay, OVERLAY_DELAY + 20);
  }
  const fresh = prev && next.seq === prev.seq + 1 && !document.hidden;
  render({ deal: fresh && next.event?.kind === "game_start" });
  if (fresh) playEffects(prev, next);
  notifyTurn(prev, next);
}

// What this viewer is expected to do right now ("clue", "guess" or null).
function myJob(st) {
  const g = st?.game;
  if (!g || st.status !== "playing") return null;
  if (g.can_clue) return "clue";
  if (g.can_guess) return "guess";
  return null;
}

function notifyTurn(prev, next) {
  const job = myJob(next);
  if (job && job !== myJob(prev)) {
    setTimeout(() => sfx.yourTurn(), 500);
    if (document.hidden) document.title = job === "clue" ? "🔔 Give a clue! · Codenames" : "🔔 Your turn to guess! · Codenames";
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.code) document.title = `Codenames · ${S.code}`;
});

// ------------------------------------------------------------------ shell
function buildShell() {
  const input = h("input", { class: "text", placeholder: "Say something…", maxlength: 240, enterkeyhint: "send", "aria-label": "Chat message" });
  const form = h(
    "form",
    {
      class: "chat-form",
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        send({ type: "chat", text });
        input.value = "";
      },
    },
    input,
    h("button", { class: "btn small" }, "Send"),
  );
  S.dom = null;
  app.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h("header", { class: "topbar", id: "topbar" }),
      h("main", { class: "main", id: "main" }, h("div", { class: "center-msg" }, h("p", { class: "connecting" }, "Connecting"))),
      h(
        "aside",
        { class: "side", id: "side" },
        h("div", { class: "side-head" }, "Mission log", h("button", { class: "icon-btn only-narrow", onclick: toggleSide, title: "Close" }, "✕")),
        h("div", { class: "feed", id: "feed" }),
        h(
          "div",
          { class: "reactions" },
          (S.config.reactions || []).map((emoji) => h("button", { title: "React", onclick: () => send({ type: "react", emoji }) }, emoji)),
        ),
        form,
      ),
      h("div", { class: "side-scrim", onclick: toggleSide }),
    ),
    h("div", { id: "conn", class: "conn-banner hidden" }, "Reconnecting…"),
  );
  renderTop();
}

function renderConn() {
  $("#conn")?.classList.toggle("hidden", S.connected || !!S.fatal || !S.code);
}

function toggleSide() {
  S.ui.sideOpen = !S.ui.sideOpen;
  if (S.ui.sideOpen) S.ui.unread = 0;
  $(".shell")?.classList.toggle("side-open", S.ui.sideOpen);
  renderTop();
  if (S.ui.sideOpen) {
    const feed = $("#feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
  }
}

function teamDot(team) {
  return team ? h("span", { class: `dot t-${team}` }) : null;
}

function feedEntry(entry) {
  const time = new Date(entry.ts * 1000).toLocaleTimeString();
  if (entry.kind === "chat") return h("div", { class: "entry chat", title: time }, h("b", { class: entry.team ? `tc-${entry.team}` : "" }, entry.name), " ", entry.text);
  if (entry.kind === "clue")
    return h(
      "div",
      { class: `entry clue t-${entry.team}`, title: time },
      h("span", { class: "who" }, entry.name),
      h("span", { class: "clue-chip" }, entry.word ? h("span", { class: "cw" }, entry.word) : h("span", { class: "cw spoken" }, "(spoken)"), h("span", { class: "cn" }, entry.number)),
    );
  const thumb = entry.card ? h("img", { class: "thumb", src: entry.card, alt: "" }) : null;
  return h("div", { class: `entry log${entry.as ? ` as-${entry.as}` : ""}`, title: time }, teamDot(entry.team), thumb, entry.text);
}

function renderFeed() {
  const feed = $("#feed");
  if (!feed) return;
  feed.replaceChildren(...S.log.map(feedEntry));
  feed.scrollTop = feed.scrollHeight;
}

function appendFeed(entry) {
  const feed = $("#feed");
  if (!feed) return;
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.append(feedEntry(entry));
  while (feed.children.length > 400) feed.firstChild.remove();
  if (atBottom || entry.member === S.me) feed.scrollTop = feed.scrollHeight;
}

function iconBtn(icon, title, onclick, cls = "", badge = 0) {
  return h("button", { class: `icon-btn ${cls}`, title, "aria-label": title, onclick }, icon, badge ? h("span", { class: "badge-dot" }, badge) : null);
}

// Speaker button with a volume slider on hover. Built once and kept in place, so re-rendering the top bar
// never interrupts a drag on the slider.
const volumeControl = (() => {
  const btn = h("button", { class: "icon-btn" });
  const range = h("input", { type: "range", min: 0, max: 100, step: 1, class: "vol-range", "aria-label": "Volume" });
  const pct = h("span", { class: "vol-pct" });
  const sync = () => {
    const vol = getVolume();
    const off = isMuted() || vol === 0;
    btn.textContent = off ? "🔇" : vol < 0.4 ? "🔉" : "🔊";
    btn.title = off ? "Sound off: click to turn on" : "Click to mute";
    btn.setAttribute("aria-label", btn.title);
    range.value = String(Math.round(vol * 100));
    pct.textContent = off ? "off" : `${Math.round(vol * 100)}%`;
  };
  btn.addEventListener("click", () => {
    unlockAudio();
    if (isMuted() || getVolume() === 0) {
      setMuted(false);
      if (getVolume() === 0) setVolume(0.8);
      sync();
      sfx.pop();
    } else {
      setMuted(true);
      sync();
    }
  });
  range.addEventListener("input", () => {
    setVolume(Number(range.value) / 100);
    if (isMuted()) setMuted(false);
    sync();
  });
  range.addEventListener("change", () => sfx.pop());
  sync();
  const place = () => {
    const r = btn.getBoundingClientRect();
    wrap.style.setProperty("--vol-top", `${r.bottom + 4}px`);
    wrap.style.setProperty("--vol-right", `${Math.max(8, window.innerWidth - r.right - 60)}px`);
  };
  const wrap = h("div", { class: "vol", onpointerenter: place, onfocusin: place }, btn, h("div", { class: "vol-pop" }, h("span", { class: "vol-ico" }, "🔈"), range, pct));
  return wrap;
})();

function roleChip(st) {
  const { team, role } = st.you;
  if (!team) return h("span", { class: "chip role watch" }, "👁️ Watching");
  return h("span", { class: `chip role t-${team}` }, role === "spymaster" ? spyGlyph() : "🔎", `${TEAM_NAME[team]} ${role}`);
}

function renderTop() {
  const top = $("#topbar");
  if (!top) return;
  const st = S.state;
  const scored = st && st.game_no > 0;
  const before = [
    h("span", { class: "brand", title: "Home", onclick: leaveTable }, logo(true)),
    h("button", { class: "chip invite-chip", title: "Copy the invite link", onclick: copyInvite }, h("span", { class: "ic-ico" }, "🔗"), h("span", { class: "ic-label" }, "Invite"), h("b", {}, S.code)),
    st ? roleChip(st) : null,
    scored
      ? h("span", { class: "chip score", title: "Games won this session" }, h("b", { class: "tc-red" }, st.score.red), h("span", { class: "sep" }, ":"), h("b", { class: "tc-blue" }, st.score.blue))
      : null,
    h("span", { class: "spacer" }),
    iconBtn("❓", "How to play", showRules),
  ].filter(Boolean);
  const after = [iconBtn("💬", "Log & chat", toggleSide, "only-narrow", S.ui.unread), iconBtn("⋯", "Menu", toggleMenu)];
  if (volumeControl.parentNode !== top) top.append(volumeControl);
  for (const el of [...top.children]) if (el !== volumeControl) el.remove();
  volumeControl.before(...before);
  volumeControl.after(...after);
  document.getElementById("menu")?.remove();
  if (S.ui.menu) document.body.append(renderMenu());
}

function toggleMenu() {
  S.ui.menu = !S.ui.menu;
  renderTop();
}

function renderMenu() {
  const st = S.state;
  const isHost = st?.host === S.me;
  const item = (label, fn) =>
    h(
      "button",
      {
        onclick: () => {
          S.ui.menu = false;
          renderTop();
          fn();
        },
      },
      label,
    );
  return h(
    "div",
    { class: "menu", id: "menu" },
    item("🔗 Copy invite link", copyInvite),
    item("📱 Continue on another device", async () => {
      const url = `${inviteUrl()}?me=${S.token}`;
      const ok = await copyText(url);
      toast(ok ? "Personal link copied. Open it on your other device (don't share it!)" : url, !ok);
    }),
    item("✏️ Change my name", async () => {
      const name = await askName("Change your name", true);
      if (name) send({ type: "rename", name });
    }),
    st && st.you.team ? item("👁️ Just watch", () => send({ type: "join_team", team: null })) : null,
    isHost && st?.status !== "lobby"
      ? item("⏹ End game, back to lobby", () => {
          if (st.status === "game_over" || confirm("End the current game for everyone?")) send({ type: "to_lobby" });
        })
      : null,
    item("🚪 Leave table", leaveTable),
  );
}

document.addEventListener("click", (e) => {
  if (S.ui.menu && !e.target.closest(".menu") && !e.target.closest('[title="Menu"]')) {
    S.ui.menu = false;
    renderTop();
  }
});

function leaveTable() {
  S.ui.menu = false;
  document.getElementById("menu")?.remove();
  closeSocket();
  go("/");
}

function inviteUrl() {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const base = S.config.public_url || (local && S.config.lan_url) || location.origin;
  return `${base.replace(/\/$/, "")}/r/${S.code}`;
}

async function copyInvite() {
  const ok = await copyText(inviteUrl());
  toast(ok ? "Invite link copied. Send it to your friends!" : inviteUrl(), !ok);
}

// ------------------------------------------------------------------ dialogs
function askName(title, dismissable = false) {
  return new Promise((resolve) => {
    const suggestion = S.name || suggestName();
    const input = h("input", { class: "text", value: S.name, placeholder: suggestion, maxlength: 20, style: { width: "100%" } });
    let close = null;
    const done = (e) => {
      e?.preventDefault();
      const name = saveName(input.value || suggestion);
      close();
      resolve(name);
    };
    close = openDialog(
      h(
        "div",
        { class: "modal" },
        h("h2", {}, title),
        h("p", { class: "sub" }, "Pick a code name the other players will see."),
        h("form", { onsubmit: done }, input, h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit" }, "Enter"))),
      ),
      { dismissable, onClose: () => resolve(null) },
    );
    input.focus();
  });
}

function showRules() {
  let close = null;
  const kinds = ["red", "blue", "civilian", "assassin"].map((k) => h("div", { class: `rule-kind k-${k}` }, emblem(k), h("span", {}, KIND_NAME[k])));
  close = openDialog(
    h(
      "div",
      { class: "modal wide rules" },
      h("h2", {}, "How to play"),
      h(
        "div",
        { class: "rules-text" },
        h("p", {}, "Two teams, ", h("b", { class: "tc-red" }, "Red"), " and ", h("b", { class: "tc-blue" }, "Blue"), ", race to find all their secret agents hidden among the cards. Play over voice chat (Discord, a call, the same room); the game keeps track of everything else."),
        h("div", { class: "rule-kinds" }, kinds),
        h("h4", {}, "Roles"),
        h(
          "ul",
          {},
          h("li", {}, h("b", {}, "Spymaster"), " (one per team) sees the secret key: who every card belongs to."),
          h("li", {}, h("b", {}, "Operatives"), " see only the cards and guess from their spymaster's clues."),
        ),
        h("h4", {}, "A turn"),
        h(
          "ol",
          {},
          h("li", {}, "The spymaster says ", h("b", {}, "one word and a number"), ", e.g. “ocean 2”, and enters it in the game. The word should connect that many of the team's cards. It can't be a word on the table, and no hints by gesture or tone!"),
          h("li", {}, "Operatives discuss and reveal cards one at a time. Click a card to point at it (your team sees it), click it again to reveal it."),
          h(
            "li",
            {},
            "Your own agent: keep going. A ",
            h("b", {}, "civilian"),
            " or an ",
            h("b", {}, "enemy agent"),
            ": the turn ends (an enemy agent also helps them). The ",
            h("b", {}, "assassin"),
            ": your team loses on the spot.",
          ),
        ),
        h("h4", {}, "How many guesses?"),
        h(
          "ul",
          {},
          h("li", {}, "With clue number ", h("b", {}, "N"), " the team may reveal up to ", h("b", {}, "N + 1"), " cards; the extra one can catch up on an earlier clue. The game enforces this."),
          h("li", {}, "A clue of ", h("b", {}, "0"), " (“none of these”) or ", h("b", {}, "∞"), " allows any number of guesses."),
          h("li", {}, "You must reveal at least one card each turn, then you may ", h("b", {}, "end the turn"), " whenever you like."),
        ),
        h("h4", {}, "Winning"),
        h(
          "ul",
          {},
          h("li", {}, "The team that starts has 9 agents to find (8 with pictures), the other 8 (7). The first team with all its agents revealed wins, even if the other team revealed the last one."),
          h("li", {}, "Revealing the assassin loses immediately."),
        ),
        h("h4", {}, "Decks"),
        h("p", {}, "English or Polish words on a 5×5 grid, or pictures on a 5×4 grid. The host picks in the lobby and can set a turn timer: when it runs out, the guessing team's turn ends."),
      ),
      h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => close() }, "Got it")),
    ),
  );
}

// ------------------------------------------------------------------ rendering
function render(opts = {}) {
  renderTop();
  const st = S.state;
  const main = $("#main");
  if (!st || !main) return;
  if (st.status === "lobby") {
    S.dom = null;
    renderLobby(st, main);
  } else renderGame(st, main, opts);
  renderOverlay();
}

function avatar(m, extra = "") {
  const cls = `avatar ${m.team ? `t-${m.team}` : "t-none"} ${m.connected ? "online" : "offline"} ${extra}`;
  return h("span", { class: cls, title: m.connected ? m.name : `${m.name} (offline)` }, initials(m.name), m.role === "spymaster" && m.team ? h("span", { class: "shades" }, spyGlyph()) : null);
}

// ------------------------------------------------------------------ lobby
function renderLobby(st, main) {
  const scroll = main.querySelector(".lobby")?.scrollTop || 0;
  const isHost = st.host === S.me;
  const hostName = member(st, st.host)?.name || "the host";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  let note = null;
  if (!S.config.public_url) {
    if (local && !S.config.lan_url) note = "This link only works on this computer. Restart with `uv run codenames serve --tunnel` to invite people over the internet.";
    else if (!location.hostname.endsWith("trycloudflare.com")) note = "Works for people on the same network. For friends elsewhere, run `uv run codenames serve --tunnel`.";
  }
  const linkInput = h("input", { class: "text", readonly: true, value: inviteUrl(), onclick: (e) => e.target.select(), "aria-label": "Invite link" });
  const invite = h(
    "div",
    { class: "invite" },
    h("div", { class: "invite-text" }, h("h2", {}, "Invite your agents"), h("p", {}, "Anyone who opens the link joins this table. You need 4+ players: a spymaster and at least one operative per team."), note ? h("p", { class: "note" }, "ℹ️ ", note) : null),
    h(
      "div",
      { class: "link-box" },
      linkInput,
      h("button", { class: "btn primary", onclick: copyInvite }, "Copy link"),
      navigator.share ? h("button", { class: "btn", onclick: () => navigator.share({ title: "Play Codenames with me", url: inviteUrl() }).catch(() => {}) }, "Share") : null,
    ),
  );
  const watchers = st.members.filter((m) => !m.team && (m.connected || m.member === S.me));
  const watchPanel = h(
    "div",
    { class: "panel watchers" },
    h("h3", {}, "Watching", h("small", {}, watchers.length ? `${watchers.length}` : "")),
    watchers.length ? h("div", { class: "member-list" }, watchers.map((m) => memberRow(st, m))) : h("p", { class: "muted" }, "Nobody. Everyone picked a side."),
    h(
      "div",
      { class: "row-actions" },
      st.you.team ? h("button", { class: "btn small ghost", onclick: () => send({ type: "join_team", team: null }) }, "👁️ Just watch") : null,
      isHost ? h("button", { class: "btn small", onclick: () => send({ type: "randomize" }) }, "🎲 Shuffle teams") : null,
    ),
  );
  const decks = S.config.decks.map((d) => deckTile(d, st.settings.deck === d.key, isHost));
  const settings = h(
    "div",
    { class: "panel settings" },
    h("h3", {}, "Mission settings", isHost ? null : h("small", {}, "the host decides")),
    h("div", { class: "deck-grid", role: "radiogroup", "aria-label": "Deck" }, decks),
    h(
      "label",
      { class: "setting" },
      h("span", { class: "label" }, "Turn timer", h("small", {}, "When it runs out, the guessing team's turn ends")),
      h(
        "select",
        {
          class: "select",
          disabled: !isHost,
          onchange: (e) => send({ type: "settings", changes: { timer: Number(e.target.value) } }),
        },
        S.config.timers.map((t) => h("option", { value: t, selected: st.settings.timer === t }, TIMER_LABEL[t] || `${t}s`)),
      ),
    ),
  );
  const problems = st.problems || [];
  const actions = h(
    "div",
    { class: "lobby-actions" },
    isHost
      ? [
          h("button", { class: "btn primary big start", disabled: problems.length > 0, onclick: () => send({ type: "start" }) }, st.game_no ? "Start next game" : "Start the mission"),
          problems.length ? h("p", { class: "problems" }, problems.join(" · ")) : null,
        ]
      : h("p", { class: "waiting" }, problems.length ? problems.join(" · ") : `Waiting for ${hostName} to start…`),
  );
  const teams = h("div", { class: "lobby-teams" }, lobbyTeam(st, "red", isHost), h("div", { class: "vs" }, "VS"), lobbyTeam(st, "blue", isHost));
  const section = h("section", { class: "lobby" }, invite, teams, h("div", { class: "lobby-grid" }, settings, watchPanel), actions);
  main.replaceChildren(section);
  section.scrollTop = scroll;
}

function deckTile(d, active, isHost) {
  const preview = d.words
    ? d.sample.map((w) => h("span", { class: "mini-card" }, w))
    : d.sample.map((src) => h("span", { class: "mini-card pic" }, h("img", { src, alt: "", loading: "lazy" })));
  return h(
    "button",
    {
      class: `deck-tile${active ? " active" : ""}`,
      role: "radio",
      "aria-checked": active ? "true" : "false",
      disabled: !isHost && !active,
      onclick: () => isHost && !active && send({ type: "settings", changes: { deck: d.key } }),
    },
    h("span", { class: "deck-preview" }, preview),
    h("span", { class: "deck-name" }, d.label),
    h("span", { class: "deck-desc" }, d.description),
  );
}

function lobbyTeam(st, team, isHost) {
  const spy = spymasterOf(st, team);
  const ops = teamOf(st, team).filter((m) => m.role === "operative");
  const you = st.you;
  const join = (role) => send({ type: "join_team", team, role });
  return h(
    "div",
    { class: `lteam t-${team}` },
    h("div", { class: "lteam-head" }, h("h2", {}, `${TEAM_NAME[team]} team`), h("span", { class: "count" }, plural(teamOf(st, team).length, "agent"))),
    h(
      "div",
      { class: "slot" },
      h("div", { class: "slot-label" }, spyGlyph(), "Spymaster"),
      spy ? memberRow(st, spy, isHost) : h("button", { class: "slot-empty", onclick: () => join("spymaster") }, "Become the spymaster"),
    ),
    h(
      "div",
      { class: "slot" },
      h("div", { class: "slot-label" }, "🔎", "Operatives"),
      h("div", { class: "member-list" }, ops.map((m) => memberRow(st, m, isHost))),
      you.team === team && you.role === "operative" ? null : h("button", { class: "slot-empty", onclick: () => join("operative") }, ops.length ? "Join as operative" : "Be the first operative"),
    ),
  );
}

function memberRow(st, m, isHost = false) {
  const isMe = m.member === S.me;
  const controls = [];
  if (isHost && m.team) {
    const otherTeam = m.team === "red" ? "blue" : "red";
    controls.push(
      h("button", { class: "icon-btn tiny", title: `Move to ${TEAM_NAME[otherTeam]}`, onclick: () => send({ type: "assign", member: m.member, team: otherTeam, role: "operative" }) }, "⇄"),
      m.role === "spymaster"
        ? h("button", { class: "icon-btn tiny", title: "Make operative", onclick: () => send({ type: "assign", member: m.member, team: m.team, role: "operative" }) }, "🔎")
        : h("button", { class: "icon-btn tiny", title: "Make spymaster", onclick: () => send({ type: "assign", member: m.member, team: m.team, role: "spymaster" }) }, spyGlyph()),
      isMe ? null : h("button", { class: "icon-btn tiny", title: "Move to watchers", onclick: () => send({ type: "assign", member: m.member, team: null }) }, "✕"),
    );
  } else if (isHost && !m.team && !isMe) {
    for (const t of TEAMS) controls.push(h("button", { class: `icon-btn tiny tc-${t}`, title: `Put on ${TEAM_NAME[t]}`, onclick: () => send({ type: "assign", member: m.member, team: t, role: "operative" }) }, "●"));
  }
  return h(
    "div",
    { class: `member${isMe ? " me" : ""}` },
    avatar(m),
    h("span", { class: "name" }, m.name),
    isMe ? h("span", { class: "tag you" }, "You") : null,
    m.member === st.host ? h("span", { class: "tag host" }, "Host") : null,
    m.connected ? null : h("span", { class: "tag" }, "offline"),
    controls.length ? h("span", { class: "controls" }, controls) : null,
  );
}

// ------------------------------------------------------------------ game screen
function renderGame(st, main, opts) {
  const g = st.game;
  let fresh = false;
  if (!S.dom || S.dom.gameNo !== st.game_no || !main.contains(S.dom.root)) {
    buildGame(st, main);
    fresh = true;
  }
  const d = S.dom;
  d.root.classList.toggle("over", st.status === "game_over");
  d.root.dataset.turn = g.turn;
  updateTeam(st, "red");
  updateTeam(st, "blue");
  updateStatus(st);
  updateBoard(st, fresh, opts.deal);
  updateClueBar(st);
}

function buildGame(st, main) {
  const g = st.game;
  const board = h("div", { class: `board ${g.words ? "words" : "pictures"}`, style: { "--cols": g.cols, "--rows": g.rows } });
  const cards = g.cards.map((c, i) => {
    const front = h(
      "div",
      { class: "face front" },
      h("span", { class: "serial" }, `№${String(i + 1).padStart(2, "0")}`),
      g.words ? h("span", { class: "word" }, c.text) : h("img", { class: "pic", src: c.text, alt: `Picture ${i + 1}`, draggable: "false" }),
    );
    const back = h("div", { class: "face back" });
    const marks = h("div", { class: "marks" });
    const el = h(
      "div",
      {
        class: "card",
        role: "button",
        tabindex: "0",
        style: { "--i": i },
        onclick: () => onCardClick(i),
        onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onCardClick(i)),
      },
      h("div", { class: "card-in" }, front, back),
      marks,
      h("span", { class: "tap-hint" }, "Click again to reveal"),
    );
    board.append(el);
    return { el, front, back, marks, word: front.querySelector(".word"), kind: null, revealed: c.revealed };
  });
  const wrap = h("div", { class: "board-wrap" }, board);
  const root = h(
    "div",
    { class: "game" },
    h("section", { class: "team t-red", id: "team-red" }),
    h(
      "div",
      { class: "center" },
      h("div", { class: "status", id: "status" }, h("span", { class: "status-text" }), h("span", { class: "clock hidden" }), h("div", { class: "timer-track" }, h("div", { class: "timer-bar", id: "timer" }))),
      wrap,
      h("div", { class: "cluebar", id: "cluebar" }),
    ),
    h("section", { class: "team t-blue", id: "team-blue" }),
    h("div", { class: "overlay-host", id: "overlay" }),
  );
  main.replaceChildren(root);
  S.dom = { gameNo: st.game_no, root, board, wrap, cards, clueMode: null, cw: 0, ch: 0 };
  const ro = new ResizeObserver(() => fitBoard());
  ro.observe(wrap);
  S.dom.ro = ro;
  fitBoard();
  document.fonts?.ready.then(() => fitWords());
}

// Size the cards so the whole grid fits the space we have, at any window size.
function fitBoard() {
  const d = S.dom;
  const g = S.state?.game;
  if (!d || !g) return;
  const W = d.wrap.clientWidth;
  const H = d.wrap.clientHeight;
  if (!W || !H) return;
  // Card width / height: words prefer wide cards but grow taller when the space is tall (phones).
  const ratio = g.words ? Math.min(1.6, Math.max(1.05, (W / g.cols) / (H / g.rows))) : 1;
  const gap = Math.max(4, Math.min(14, Math.min(W, H) * 0.016));
  let cw = (W - gap * (g.cols - 1)) / g.cols;
  let ch = cw / ratio;
  const maxCh = (H - gap * (g.rows - 1)) / g.rows;
  if (ch > maxCh) {
    ch = maxCh;
    cw = ch * ratio;
  }
  cw = Math.floor(Math.max(30, cw));
  ch = Math.floor(Math.max(20, ch));
  d.board.style.setProperty("--cw", `${cw}px`);
  d.board.style.setProperty("--ch", `${ch}px`);
  d.board.style.setProperty("--gap", `${gap}px`);
  if (cw !== d.cw || ch !== d.ch) {
    d.cw = cw;
    d.ch = ch;
    fitWords();
  }
}

const measureCtx = document.createElement("canvas").getContext("2d");
function textWidth(text, px) {
  measureCtx.font = `600 ${px}px Oswald, "Arial Narrow", sans-serif`;
  return measureCtx.measureText(text).width;
}

// The largest font size that fits each word on its card, on two lines for long multi-word cards.
function fitWords() {
  const d = S.dom;
  if (!d || !d.cw) return;
  const avail = d.cw * 0.84;
  const maxFs = Math.min(d.ch * 0.3, d.cw * 0.2);
  for (const c of d.cards) {
    if (!c.word) continue;
    const text = c.word.dataset.text || c.word.textContent;
    c.word.dataset.text = text;
    let fs = Math.min(maxFs, (avail / textWidth(text, 100)) * 100);
    let shown = text;
    const parts = text.split(" ");
    if (parts.length > 1 && fs < maxFs * 0.8) {
      let best = null;
      for (let i = 1; i < parts.length; i++) {
        const a = parts.slice(0, i).join(" ");
        const b = parts.slice(i).join(" ");
        const w = Math.max(textWidth(a, 100), textWidth(b, 100));
        if (!best || w < best.w) best = { w, text: `${a}\n${b}` };
      }
      const fs2 = Math.min(maxFs * 0.85, (avail / best.w) * 100, d.ch * 0.26);
      if (fs2 > fs) {
        fs = fs2;
        shown = best.text;
      }
    }
    c.word.textContent = shown;
    c.word.style.fontSize = `${Math.max(7, fs).toFixed(1)}px`;
    for (const cover of c.back.querySelectorAll(".cover-word")) cover.style.fontSize = `${Math.max(7, Math.min(fs * 0.55, d.ch * 0.13)).toFixed(1)}px`;
  }
}

function buildBack(c, card, kind, words) {
  c.back.replaceChildren(
    emblem(kind),
    words ? h("span", { class: "cover-word" }, card.text) : h("img", { class: "cover-pic", src: card.text, alt: "" }),
    h("span", { class: "cover-kind" }, KIND_NAME[kind]),
  );
  c.kind = kind;
  for (const k of ["red", "blue", "civilian", "assassin"]) c.el.classList.toggle(`k-${k}`, k === kind);
}

function updateBoard(st, fresh, deal) {
  const d = S.dom;
  const g = st.game;
  const board = d.board;
  if (fresh) {
    board.classList.add("instant");
    requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove("instant")));
    if (deal && !reduceMotion()) {
      board.classList.add("dealing");
      sfx.deal(g.cards.length);
      setTimeout(() => board.classList.remove("dealing"), 1800);
    }
  }
  board.classList.toggle("keyed", g.sees_key);
  board.classList.toggle("can-guess", g.can_guess);
  g.cards.forEach((card, i) => {
    const c = d.cards[i];
    if (card.kind && c.kind !== card.kind) {
      buildBack(c, card, card.kind, g.words);
      fitWords();
    }
    c.el.classList.toggle("revealed", card.revealed);
    c.el.classList.toggle("unrevealed-key", !card.revealed && !!card.kind);
    c.el.classList.toggle("by-red", card.by === "red");
    c.el.classList.toggle("by-blue", card.by === "blue");
    const guessable = g.can_guess && !card.revealed;
    c.el.classList.toggle("guessable", guessable);
    const marks = (g.marks[String(i)] || []).map((id) => member(st, id)).filter(Boolean);
    const mine = marks.some((m) => m.member === S.me);
    c.el.classList.toggle("mine", mine && guessable);
    c.el.classList.toggle("pointed", marks.length > 0 && !card.revealed);
    const key = marks.map((m) => m.member).join(",");
    if (c.marks.dataset.key !== key) {
      c.marks.dataset.key = key;
      c.marks.replaceChildren(...marks.map((m) => h("span", { class: `mark t-${m.team || "none"}`, title: `${m.name} points here` }, initials(m.name))));
    }
    const label = g.words ? card.text : `Picture ${i + 1}`;
    c.el.setAttribute("aria-label", card.kind ? `${label}: ${KIND_NAME[card.kind]}${card.revealed ? " (revealed)" : ""}` : label);
    c.el.tabIndex = guessable ? 0 : -1;
    c.revealed = card.revealed;
  });
}

function onCardClick(i) {
  const st = S.state;
  const g = st?.game;
  if (!g || st.status !== "playing" || S.ui.pending) return;
  const card = g.cards[i];
  if (card.revealed) return;
  if (!g.can_guess) {
    if (st.you.team === g.turn && st.you.role === "operative" && g.phase === "clue") toast("Wait for your spymaster's clue");
    else if (st.you.role === "spymaster" && st.you.team) toast("Spymasters don't guess. Give clues!");
    return;
  }
  const c = S.dom.cards[i];
  if (c.el.classList.contains("mine")) {
    S.ui.pending = true;
    c.el.classList.add("revealing");
    send({ type: "guess", card: i });
  } else {
    for (const other of S.dom.cards) other.el.classList.remove("mine");
    c.el.classList.add("mine");
    sfx.mark();
    send({ type: "mark", card: i });
  }
}

function updateTeam(st, team) {
  const el = document.getElementById(`team-${team}`);
  if (!el) return;
  const g = st.game;
  const left = g.remaining[team];
  const total = g.total[team];
  const prevLeft = Number(el.dataset.left ?? left);
  el.dataset.left = left;
  const active = st.status === "playing" && g.turn === team;
  const won = g.winner === team;
  el.classList.toggle("active", active);
  el.classList.toggle("won", won);
  const spy = spymasterOf(st, team);
  const ops = teamOf(st, team).filter((m) => m.role === "operative");
  const pips = [];
  for (let i = 0; i < total; i++) pips.push(h("span", { class: `pip${i < total - left ? " found" : ""}` }));
  const clues = g.history.filter((c) => c.team === team);
  const you = st.you;
  const canJoin = st.status === "playing" && you.team !== team && !(you.saw_key && you.team);
  const parts = [
    h(
      "div",
      { class: "team-head" },
      h("div", { class: "team-name" }, TEAM_NAME[team], active ? h("span", { class: "turn-flag" }, g.phase === "clue" ? "Clue" : "Guessing") : null, won ? h("span", { class: "turn-flag win" }, "Winner") : null),
      h("div", { class: `team-count${left !== prevLeft ? " bump" : ""}` }, h("b", {}, left), h("small", {}, left === 1 ? "agent left" : "agents left")),
    ),
    h("div", { class: "pips", title: `${total - left} of ${total} found` }, pips),
    h(
      "div",
      { class: "roster" },
      h("div", { class: "roster-label" }, "Spymaster"),
      h("div", { class: "roster-row spy" }, spy ? [avatar(spy, "sm"), h("span", { class: "rn" }, spy.name, spy.member === S.me ? h("small", {}, " (you)") : null)] : h("span", { class: "rn muted" }, "nobody")),
      h("div", { class: "roster-label" }, ops.length === 1 ? "Operative" : "Operatives"),
      ops.map((m) => h("div", { class: "roster-row" }, avatar(m, "sm"), h("span", { class: "rn" }, m.name, m.member === S.me ? h("small", {}, " (you)") : null))),
    ),
    clues.length
      ? h(
          "div",
          { class: "history" },
          h("div", { class: "history-label" }, "Clues"),
          clues.map((c) =>
            h(
              "div",
              { class: "hclue" },
              h("span", { class: "hw" }, c.word || "(spoken)"),
              h("span", { class: "hn" }, c.number == null ? "∞" : c.number),
              h(
                "span",
                { class: "hres" },
                c.results.map((r) => h("span", { class: `res r-${r}${r === team ? " ok" : ""}`, title: KIND_NAME[r] })),
              ),
            ),
          ),
        )
      : null,
    canJoin && !you.team ? h("button", { class: "btn small join-btn", onclick: () => send({ type: "join_team", team, role: "operative" }) }, `Join ${TEAM_NAME[team]}`) : null,
    canJoin && !you.team && !spy ? h("button", { class: "btn small join-btn", onclick: () => send({ type: "join_team", team, role: "spymaster" }) }, "Be spymaster") : null,
  ];
  el.replaceChildren(...parts.filter(Boolean));
}

function statusInfo(st) {
  const g = st.game;
  const team = g.turn;
  const T = TEAM_NAME[team];
  if (st.status === "game_over") {
    const loser = g.winner === "red" ? "blue" : "red";
    const how = g.reason === "assassin" ? `${TEAM_NAME[loser]} found the assassin` : "all agents found";
    return { cls: `t-${g.winner}`, text: [h("b", {}, `${TEAM_NAME[g.winner]} team wins`), ` · ${how}`] };
  }
  const spy = spymasterOf(st, team);
  if (g.phase === "clue") {
    if (g.can_clue) return { cls: `t-${team} mine`, text: [h("b", {}, "Your turn, spymaster:"), " give your team a clue"] };
    return { cls: `t-${team}`, text: [h("b", {}, `${T} spymaster`), spy ? ` ${spy.name}` : "", " is thinking of a clue", h("span", { class: "dots" }, h("i"), h("i"), h("i"))] };
  }
  const left = g.guesses_left;
  const leftText = left == null ? "unlimited guesses" : `${left} ${left === 1 ? "guess" : "guesses"} left`;
  if (g.can_guess) return { cls: `t-${team} mine`, text: [h("b", {}, "Your turn to guess!"), ` ${leftText}`] };
  return { cls: `t-${team}`, text: [h("b", {}, `${T} operatives`), ` are guessing · ${leftText}`] };
}

function updateStatus(st) {
  const el = $("#status");
  if (!el) return;
  const info = statusInfo(st);
  el.className = `status ${info.cls}`;
  el.querySelector(".status-text").replaceChildren(...info.text);
}

function clueChip(clue, big = false) {
  return h(
    "span",
    { class: `clue-chip t-${clue.team}${big ? " big" : ""}` },
    clue.word ? h("span", { class: "cw" }, clue.word) : h("span", { class: "cw spoken" }, "spoken clue"),
    h("span", { class: "cn" }, clue.number == null ? "∞" : clue.number),
  );
}

function updateClueBar(st) {
  const bar = $("#cluebar");
  if (!bar) return;
  const g = st.game;
  const isHost = st.host === S.me;
  let mode;
  if (st.status === "game_over") mode = `over|${isHost}`;
  else if (g.can_clue) mode = "compose";
  else if (g.phase === "guess") mode = `clue|${g.turn}|${g.guesses_made}|${g.guesses_left}|${g.can_guess}|${g.can_end}`;
  else mode = `wait|${g.turn}|${spymasterOf(st, g.turn)?.name}`;
  if (S.dom.clueMode === mode) return;
  const was = S.dom.clueMode || "";
  S.dom.clueMode = mode;
  if (mode === "compose") {
    S.ui.clueNumber = null;
    bar.replaceChildren(composer(st));
    if (!was.startsWith("compose") && window.matchMedia("(pointer: fine)").matches) bar.querySelector("input")?.focus();
    return;
  }
  if (mode.startsWith("over")) {
    bar.replaceChildren(
      h(
        "div",
        { class: "bar-row" },
        h("span", { class: "muted" }, "Mission over. Every card is now shown."),
        isHost ? h("button", { class: "btn", onclick: () => send({ type: "to_lobby" }) }, "Lobby") : null,
        isHost ? h("button", { class: "btn primary", onclick: () => send({ type: "play_again" }) }, "Play again ↻") : h("span", { class: "muted" }, "Waiting for the host…"),
      ),
    );
    return;
  }
  if (mode.startsWith("wait")) {
    const spy = spymasterOf(st, g.turn);
    bar.replaceChildren(h("div", { class: "bar-row" }, h("span", { class: `waiting-clue t-${g.turn}` }, "Waiting for ", h("b", {}, spy ? spy.name : `the ${TEAM_NAME[g.turn]} spymaster`), "'s clue", h("span", { class: "dots" }, h("i"), h("i"), h("i")))));
    return;
  }
  const clue = g.clue;
  const left = g.guesses_left;
  const used = g.guesses_made;
  const total = left == null ? null : used + left;
  const slots = [];
  if (total != null) for (let i = 0; i < total; i++) slots.push(h("span", { class: `gslot${i < used ? " used" : ""}${i === total - 1 ? " bonus" : ""}`, title: i === total - 1 ? "Bonus guess" : "Guess" }));
  bar.replaceChildren(
    h(
      "div",
      { class: "bar-row" },
      h("span", { class: "clue-label" }, "Clue"),
      clueChip(clue, true),
      h("span", { class: "guesses", title: left == null ? "Unlimited guesses" : `${left} left` }, total == null ? h("span", { class: "inf" }, "∞ guesses") : slots, h("small", {}, total == null ? `${used} made` : `${left} left`)),
      g.can_guess
        ? h(
            "button",
            {
              class: "btn end-turn",
              disabled: !g.can_end,
              title: g.can_end ? "Stop guessing and pass the turn" : "Reveal at least one card first",
              onclick: () => send({ type: "end_turn" }),
            },
            "End turn ⏭",
          )
        : null,
    ),
  );
}

function composer(st) {
  const g = st.game;
  const input = h("input", { class: "text clue-input", maxlength: 32, placeholder: "Clue word (optional)", autocomplete: "off", spellcheck: "false", "aria-label": "Clue word" });
  const submit = h("button", { class: "btn primary give", disabled: true }, "Give clue");
  const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "inf"].map((n) =>
    h(
      "button",
      {
        class: "num",
        type: "button",
        "data-n": n,
        title: n === "inf" ? "Unlimited guesses" : n === 0 ? "Zero: none of these words (unlimited guesses)" : `${n}: up to ${n + 1} guesses`,
        onclick: () => {
          S.ui.clueNumber = n;
          for (const b of numbers) b.classList.toggle("on", b.dataset.n === String(n));
          submit.disabled = false;
          sfx.mark();
        },
      },
      n === "inf" ? "∞" : n,
    ),
  );
  const go = (e) => {
    e?.preventDefault();
    if (S.ui.clueNumber == null) {
      toast("Pick a number too");
      return;
    }
    send({ type: "clue", word: input.value.trim(), number: S.ui.clueNumber });
  };
  submit.addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(e);
    else if (/^[0-9]$/.test(e.key) && input.value === "") {
      e.preventDefault();
      numbers[Number(e.key)].click();
    }
  });
  const left = g.remaining[g.turn];
  return h(
    "form",
    { class: "composer", onsubmit: go },
    h("div", { class: "compose-word" }, input),
    h("div", { class: "numbers", role: "group", "aria-label": "Number" }, numbers),
    submit,
    h("span", { class: "compose-note" }, `Say it aloud and/or type it · ${plural(left, "agent")} to go`),
  );
}

// ------------------------------------------------------------------ effects
function playEffects(prev, next) {
  const ev = next.event;
  if (!ev || !S.dom) return;
  if (ev.kind === "mark" && ev.member !== S.me && ev.card != null) {
    sfx.mark();
    return;
  }
  if (ev.kind !== "move") return;
  for (const e of ev.events) {
    switch (e.kind) {
      case "clue":
        sfx.clue();
        flash(clueChip({ team: e.team, word: e.word, number: e.number }, true), `t-${e.team}`, "Clue");
        break;
      case "reveal":
        revealFx(e, next);
        break;
      case "turn":
        setTimeout(() => {
          sfx.turn();
          flash(h("span", { class: "turn-text" }, `${TEAM_NAME[e.team]} team's turn`), `t-${e.team}`, null, true);
        }, 650);
        break;
      case "win": {
        const mine = next.you.team === e.team;
        setTimeout(() => {
          if (!next.you.team || mine) sfx.win();
          else sfx.lose();
          confetti(e.team);
          revealRest();
        }, 800);
        break;
      }
    }
  }
}

function revealFx(e) {
  const c = S.dom.cards[e.card];
  if (!c) return;
  c.el.classList.remove("revealing");
  c.el.classList.add("just");
  setTimeout(() => c.el.classList.remove("just"), 1400);
  const kind = e.as;
  if (kind === "assassin") {
    sfx.assassin();
    setTimeout(() => {
      S.dom.root.classList.add("shake");
      document.body.classList.add("doom");
      setTimeout(() => {
        S.dom?.root.classList.remove("shake");
        document.body.classList.remove("doom");
      }, 1200);
    }, 350);
  } else if (kind === e.team) {
    sfx.agent();
    setTimeout(() => burst(c.el, kind), 380);
  } else if (kind === "civilian") sfx.civilian();
  else {
    sfx.enemy();
    setTimeout(() => burst(c.el, kind, 10), 380);
  }
}

// Cards nobody revealed turn over one by one at the end.
function revealRest() {
  if (!S.dom || reduceMotion()) return;
  S.dom.cards
    .filter((c) => !c.revealed)
    .forEach((c, n) => {
      setTimeout(() => {
        c.el.classList.add("peek");
        setTimeout(() => c.el.classList.remove("peek"), 700);
      }, n * 70);
    });
}

function burst(el, team, count = 18) {
  if (reduceMotion()) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const dist = 40 + Math.random() * Math.max(60, r.width * 0.7);
    const p = h("i", { class: `spark t-${team}`, style: { left: `${cx}px`, top: `${cy}px` } });
    fx.append(p);
    p.animate(
      [
        { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0.2)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
    ).finished.then(
      () => p.remove(),
      () => p.remove(),
    );
  }
}

// A big announcement sweeping across the board.
function flash(content, cls, label = null, sweep = false) {
  if (!S.dom) return;
  const el = h("div", { class: `flash ${cls}${sweep ? " sweep" : ""}` }, label ? h("span", { class: "flash-label" }, label) : null, content);
  S.dom.wrap.append(el);
  setTimeout(() => el.remove(), sweep ? 1500 : 1900);
}

function confetti(team) {
  if (reduceMotion()) return;
  const layer = h("div", { class: "confetti" });
  const colors = team === "red" ? ["#ff4d61", "#ff8a95", "#ffd166", "#ffffff"] : ["#3d8bff", "#8fc1ff", "#ffd166", "#ffffff"];
  for (let i = 0; i < 110; i++) {
    layer.append(
      h("i", {
        style: {
          left: `${Math.random() * 100}%`,
          background: pick(colors),
          animationDuration: `${2.2 + Math.random() * 2}s`,
          animationDelay: `${Math.random() * 0.8}s`,
          transform: `rotate(${Math.random() * 360}deg)`,
          width: `${6 + Math.random() * 6}px`,
        },
      }),
    );
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 5200);
}

function showReaction(msg) {
  const st = S.state;
  const m = member(st, msg.member);
  let rect = m?.team ? document.getElementById(`team-${m.team}`)?.getBoundingClientRect() : null;
  if (!rect) rect = $("#main")?.getBoundingClientRect();
  if (!rect) return;
  const bubble = h(
    "div",
    { class: "bubble", style: { left: `${rect.left + rect.width / 2 + (Math.random() - 0.5) * 60}px`, top: `${rect.top + Math.min(rect.height - 60, 80)}px` } },
    msg.emoji,
    h("small", {}, m?.name || ""),
  );
  document.body.append(bubble);
  setTimeout(() => bubble.remove(), 2300);
}

// ------------------------------------------------------------------ game over overlay
function renderOverlay() {
  const host = $("#overlay");
  if (!host) return;
  const st = S.state;
  if (!st?.game || st.status !== "game_over" || performance.now() < S.ui.overlayAt || S.ui.overlayHidden) {
    host.replaceChildren();
    return;
  }
  if (host.firstChild) return;
  const g = st.game;
  const loser = g.winner === "red" ? "blue" : "red";
  const isHost = st.host === S.me;
  const mine = st.you.team === g.winner;
  const title = st.you.team ? (mine ? "Mission accomplished!" : "Mission failed") : `${TEAM_NAME[g.winner]} team wins!`;
  const why = g.reason === "assassin" ? `${TEAM_NAME[loser]} contacted the assassin.` : `${TEAM_NAME[g.winner]} found all ${g.total[g.winner]} agents.`;
  host.replaceChildren(
    h(
      "div",
      { class: "result-scrim" },
      h(
        "div",
        { class: `result t-${g.winner}` },
        h("div", { class: "result-emblem" }, emblem(g.reason === "assassin" ? "assassin" : g.winner)),
        h("div", { class: "result-team" }, `${TEAM_NAME[g.winner]} team wins`),
        h("h2", {}, title),
        h("p", {}, why),
        h(
          "div",
          { class: "result-score" },
          h("span", { class: "tc-red" }, "Red ", h("b", {}, st.score.red)),
          h("span", { class: "sep" }, "–"),
          h("span", { class: "tc-blue" }, h("b", {}, st.score.blue), " Blue"),
        ),
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            {
              class: "btn ghost",
              onclick: () => {
                S.ui.overlayHidden = true;
                renderOverlay();
              },
            },
            "👀 See the board",
          ),
          isHost ? h("button", { class: "btn", onclick: () => send({ type: "to_lobby" }) }, "Change teams") : null,
          isHost ? h("button", { class: "btn primary", onclick: () => send({ type: "play_again" }) }, "Play again ↻") : h("span", { class: "muted" }, "Waiting for the host…"),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ timer + keyboard
function fmtClock(ms) {
  const sec = Math.ceil(Math.abs(ms) / 1000);
  return `${ms < 0 ? "+" : ""}${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function tickTimer() {
  const bar = $("#timer");
  const clock = $("#status .clock");
  if (bar && clock) {
    const st = S.state;
    if (S.timer.endAt && st?.status === "playing" && S.timer.total) {
      const left = S.timer.endAt - performance.now();
      const frac = Math.max(0, left / (S.timer.total * 1000));
      bar.style.width = `${(frac * 100).toFixed(2)}%`;
      bar.classList.toggle("low", left < 10000);
      clock.classList.remove("hidden");
      clock.classList.toggle("over", left < 0);
      clock.classList.toggle("low", left >= 0 && left < 10000);
      clock.textContent = `⏱ ${fmtClock(left)}`;
      if (left > 0 && left < 5000 && myJob(st)) {
        const sec = Math.ceil(left / 1000);
        if (sec !== S.timer.lastTick) {
          S.timer.lastTick = sec;
          sfx.tick();
        }
      }
    } else {
      bar.style.width = "0";
      clock.classList.add("hidden");
    }
  }
  requestAnimationFrame(tickTimer);
}
requestAnimationFrame(tickTimer);

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const g = S.state?.game;
  if (e.key === "Escape" && g?.can_guess && S.dom?.cards.some((c) => c.el.classList.contains("mine"))) {
    for (const c of S.dom.cards) c.el.classList.remove("mine");
    send({ type: "mark", card: null });
  }
  if (g?.can_clue && /^[0-9]$/.test(e.key)) $(`.composer .num[data-n="${e.key}"]`)?.click();
});

for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { capture: true });

// ------------------------------------------------------------------ boot
async function boot() {
  S.config = await fetch("/api/config").then((r) => r.json());
  router();
}
boot().catch((e) => {
  console.error(e);
  app.replaceChildren(h("div", { class: "center-msg" }, h("p", {}, "Could not load the game. Is the server running?")));
});

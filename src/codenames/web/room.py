"""A multiplayer table: members, teams and roles, lobby settings and the game.

All mutations are synchronous and run on the event loop thread. Every change is pushed to each
listener as a full per-viewer snapshot (`Room.state_for`) tagged with the event that caused it, so
clients can animate it. The key (which card is whose) only goes to spymasters until the game is over.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import random
import secrets
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Protocol

from codenames.game.decks import Deck, load_decks
from codenames.game.engine import TEAMS, Event, Game, IllegalMove, Phase, parse_number

log = logging.getLogger(__name__)

MAX_NAME = 20
MAX_CHAT = 240
MAX_MEMBERS = 40
CHAT_INTERVAL = 0.4
HOST_GRACE = 20.0
REACTIONS = ("👍", "😂", "😱", "🤯", "🎉", "🤔", "😭", "🔥", "👏", "🙈")
TIMERS = (0, 60, 90, 120, 180, 300)
ROLES = ("operative", "spymaster")
TEAM_NAMES = {"red": "Red", "blue": "Blue"}
KIND_TEXT = {"red": "a red agent", "blue": "a blue agent", "civilian": "a civilian", "assassin": "the ASSASSIN"}


class RoomError(Exception):
    """A rejected request; the message is shown to the user."""


class Listener(Protocol):
    member_id: str

    def send(self, message: dict[str, Any]) -> None: ...


@dataclass
class Settings:
    deck: str = "en"
    timer: int = 0  # seconds per clue and per guessing phase, 0 = off

    def update(self, changes: dict[str, Any], decks: dict[str, Deck]) -> None:
        for key, value in changes.items():
            if key == "deck" and value in decks:
                self.deck = str(value)
            elif key == "timer" and value in TIMERS and not isinstance(value, bool):
                self.timer = int(value)
            else:
                raise RoomError(f"invalid setting {key}={value!r}")


@dataclass
class Member:
    id: str
    token: str
    name: str
    team: str | None = None  # None: watching
    role: str = "operative"
    connections: int = 0
    disconnected_at: float | None = None
    last_chat: float = 0.0
    saw_key: bool = False  # was a spymaster during the current game


def clean_text(text: object, limit: int) -> str:
    if not isinstance(text, str):
        return ""
    return " ".join(text.split())[:limit]


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


class Room:
    def __init__(
        self,
        room_id: str,
        seed: int | None = None,
        decks: dict[str, Deck] | None = None,
    ) -> None:
        self.id = room_id
        self.rng = random.Random(seed)
        self.decks = decks or load_decks()
        self.members: dict[str, Member] = {}
        self.host_id: str | None = None
        self.settings = Settings()
        self.status = "lobby"  # lobby | playing | game_over
        self.game: Game | None = None
        self.game_no = 0
        self.score = dict.fromkeys(TEAMS, 0)
        self.marks: dict[int, list[str]] = {}  # card -> members pointing at it
        self.clue_by: list[str] = []  # name of the spymaster behind each clue in game.history
        self.log: deque[dict[str, Any]] = deque(maxlen=400)
        self.listeners: set[Listener] = set()
        self.seq = 0
        self.last_activity = time.monotonic()
        self.closed = False
        self._wake = asyncio.Event()
        self._deadline: tuple[tuple[Any, ...], float] | None = None

    # ------------------------------------------------------------------ members
    def join(self, token: str, name: object, origin: str = "") -> Member:
        name = clean_text(name, MAX_NAME)
        member = next((m for m in self.members.values() if m.token == token), None)
        if member is None:
            if len(self.members) >= MAX_MEMBERS:
                raise RoomError("This table is full")
            member = Member(id=secrets.token_hex(4), token=token, name=name or f"Agent {len(self.members) + 1}")
            self.members[member.id] = member
            where = f" from {origin}" if origin else ""
            if self.host_id is None:
                self.host_id = member.id
                log.info("table %s opened by %s%s", self.id, member.name, where)
            else:
                log.info("table %s: %s joined%s", self.id, member.name, where)
            self._say(f"{member.name} joined the table")
            if self.status == "lobby":
                member.team = self._smaller_team()
        elif name and name != member.name:
            self._rename(member, name)
        return member

    def _smaller_team(self) -> str:
        sizes = {t: sum(1 for m in self.members.values() if m.team == t) for t in TEAMS}
        if sizes["red"] == sizes["blue"]:
            return self.rng.choice(TEAMS)
        return min(TEAMS, key=lambda t: sizes[t])

    def connect(self, listener: Listener) -> None:
        member = self.members[listener.member_id]
        if member.connections == 0 and member.disconnected_at is not None:
            log.info("table %s: %s is back", self.id, member.name)
        member.connections += 1
        member.disconnected_at = None
        self.listeners.add(listener)
        self.last_activity = time.monotonic()
        listener.send({"type": "welcome", "you": member.id, "log": list(self.log)})
        self._emit({"kind": "presence"})

    def disconnect(self, listener: Listener) -> None:
        self.listeners.discard(listener)
        member = self.members.get(listener.member_id)
        if member is None:
            return
        member.connections = max(0, member.connections - 1)
        if member.connections == 0:
            member.disconnected_at = time.monotonic()
            log.info("table %s: %s left", self.id, member.name)
        self.last_activity = time.monotonic()
        self._emit({"kind": "presence"})

    def check_host(self) -> None:
        """Hand the host role to a connected member once the host has been gone a while."""
        host = self.members.get(self.host_id or "")
        if host is not None and host.connections:
            return
        if host is not None and host.disconnected_at and time.monotonic() - host.disconnected_at < HOST_GRACE:
            return
        online = [m for m in self.members.values() if m.connections]
        if not online:
            return
        playing = [m for m in online if m.team]
        new = (playing or online)[0]
        self.host_id = new.id
        log.info("table %s: %s is now the host", self.id, new.name)
        self._say(f"{new.name} is now the host")
        self._emit({"kind": "presence"})

    def spymaster(self, team: str) -> Member | None:
        return next((m for m in self.members.values() if m.team == team and m.role == "spymaster"), None)

    def operatives(self, team: str) -> list[Member]:
        return [m for m in self.members.values() if m.team == team and m.role == "operative"]

    def describe(self) -> str:
        """One line for the server console: who is at this table and what it's doing."""
        host = self.members.get(self.host_id or "")
        teams = []
        for t in TEAMS:
            names = [f"{m.name}{'*' if m.role == 'spymaster' else ''}" for m in self.members.values() if m.team == t]
            teams.append(f"{t}: {', '.join(names) or '-'}")
        online = sum(1 for m in self.members.values() if m.connections)
        host_name = host.name if host else "-"
        parts = [self.id, self.status.replace("_", " "), f"host {host_name}", *teams, f"{online} online"]
        return " · ".join(parts)

    @property
    def idle_for(self) -> float:
        return 0.0 if self.listeners else time.monotonic() - self.last_activity

    # ------------------------------------------------------------------ requests
    def handle(self, member_id: str, msg: dict[str, Any]) -> dict[str, Any] | None:
        member = self.members[member_id]
        kind = msg.get("type")
        self.last_activity = time.monotonic()
        host_only = {"assign", "randomize", "settings", "start", "play_again", "to_lobby"}
        if kind in host_only and member_id != self.host_id:
            raise RoomError("Only the host can do that")
        match kind:
            case "rename":
                name = clean_text(msg.get("name"), MAX_NAME)
                if name:
                    self._rename(member, name)
                    self._emit({"kind": "presence"})
            case "chat":
                self._chat(member, msg.get("text"))
            case "react":
                self._react(member, msg.get("emoji"))
            case "join_team":
                self._set_role(member, msg.get("team"), msg.get("role"), by_host=False)
            case "assign":
                target = self.members.get(str(msg.get("member")))
                if target is None:
                    raise RoomError("No such player")
                self._set_role(target, msg.get("team"), msg.get("role"), by_host=True)
            case "randomize":
                self._randomize()
            case "settings":
                if self.status == "playing":
                    raise RoomError("Change the settings between games")
                changes = msg.get("changes")
                if not isinstance(changes, dict):
                    raise RoomError("invalid settings")
                self.settings.update(changes, self.decks)
                self._emit({"kind": "lobby"})
            case "start" | "play_again":
                self.start()
            case "to_lobby":
                self._to_lobby()
            case "clue":
                self._clue(member, msg.get("word"), msg.get("number"))
            case "guess":
                self._guess(member, msg.get("card"))
            case "end_turn":
                self._end_turn(member)
            case "mark":
                self._mark(member, msg.get("card"))
            case _:
                raise RoomError(f"unknown request {kind!r}")
        return None

    def _rename(self, member: Member, name: str) -> None:
        log.info("table %s: %s is now called %s", self.id, member.name, name)
        self._say(f"{member.name} is now called {name}")
        member.name = name

    def _chat(self, member: Member, text: object) -> None:
        text = clean_text(text, MAX_CHAT)
        if not text:
            return
        now = time.monotonic()
        if now - member.last_chat < CHAT_INTERVAL:
            raise RoomError("Slow down a little")
        member.last_chat = now
        self._append_log({"kind": "chat", "member": member.id, "name": member.name, "team": member.team, "text": text})

    def _react(self, member: Member, emoji: object) -> None:
        if emoji not in REACTIONS:
            raise RoomError("unknown reaction")
        message = {"type": "react", "member": member.id, "emoji": emoji}
        for listener in list(self.listeners):
            listener.send(message)

    def _set_role(self, member: Member, team: object, role: object, by_host: bool) -> None:
        if team is not None and team not in TEAMS:
            raise RoomError("No such team")
        role = role if role in ROLES else "operative"
        assert isinstance(role, str)
        in_game = self.status == "playing"
        if team is None:
            if member.team is None:
                return
            member.team, member.role = None, "operative"
            self._say(f"{member.name} is now watching")
            self._emit({"kind": "teams"})
            return
        assert isinstance(team, str)
        if member.team == team and member.role == role:
            return
        current = self.spymaster(team)
        if role == "spymaster" and current is not None and current is not member:
            if not by_host:
                raise RoomError(f"{TEAM_NAMES[team]} already has a spymaster")
            current.role = "operative"
        if in_game and role == "operative" and member.saw_key and not by_host:
            raise RoomError("You've seen the key, so you can't guess in this game")
        member.team, member.role = team, role
        if role == "spymaster" and in_game:
            member.saw_key = True
        what = "spymaster" if role == "spymaster" else "operative"
        self._say(f"{member.name} is now the {TEAM_NAMES[team]} {what}", team=team)
        self._emit({"kind": "teams"})

    def _randomize(self) -> None:
        if self.status == "playing":
            raise RoomError("Shuffle the teams between games")
        people = [m for m in self.members.values() if m.connections and m.team is not None]
        if len(people) < 2:
            people = [m for m in self.members.values() if m.connections]
        self.rng.shuffle(people)
        for i, m in enumerate(people):
            m.team = TEAMS[i % 2]
            m.role = "operative"
        for t in TEAMS:
            team = [m for m in people if m.team == t]
            if len(team) >= 2 or (team and len(people) < 4):
                team[0].role = "spymaster"
        self._say("🎲 Teams shuffled")
        self._emit({"kind": "teams"})

    # ------------------------------------------------------------------ game flow
    def problems(self) -> list[str]:
        """Why the game can't start yet (empty when it can)."""
        out = []
        for t in TEAMS:
            if self.spymaster(t) is None:
                out.append(f"{TEAM_NAMES[t]} needs a spymaster")
            if not self.operatives(t):
                out.append(f"{TEAM_NAMES[t]} needs at least one operative")
        return out

    def start(self) -> None:
        if self.status == "playing":
            raise RoomError("A game is already running")
        if problems := self.problems():
            raise RoomError(problems[0])
        deck = self.decks.get(self.settings.deck) or self.decks["en"]
        first = self.rng.choice(TEAMS)
        seed = self.rng.randrange(2**63)
        self.game = Game(deck.deal(self.rng), deck.layout, first=first, seed=seed, words=deck.words)
        self.game_no += 1
        self.status = "playing"
        self.marks = {}
        self.clue_by = []
        for m in self.members.values():
            m.saw_key = m.team is not None and m.role == "spymaster"
        teams = "; ".join(f"{t}: {', '.join(m.name for m in self.members.values() if m.team == t)}" for t in TEAMS)
        log.info("table %s: game %d started (%s deck) · %s", self.id, self.game_no, deck.key, teams)
        name = TEAM_NAMES[first]
        self._say(f"Game {self.game_no} begins! {name} goes first and has 1 extra agent to find.", team=first)
        self._emit({"kind": "game_start"})

    def _to_lobby(self) -> None:
        if self.status == "lobby":
            return
        self.status = "lobby"
        self.game = None
        self.marks = {}
        self._say("Back to the lobby")
        self._emit({"kind": "lobby"})

    def _game(self) -> Game:
        if self.game is None or self.status != "playing":
            raise RoomError("No game in progress")
        return self.game

    def _active(self, member: Member, role: str) -> tuple[Game, str]:
        game = self._game()
        if member.team is None:
            raise RoomError("You are watching this game")
        if member.role != role:
            raise RoomError("Only the spymaster gives clues" if role == "spymaster" else "Only operatives guess")
        if member.team != game.turn:
            raise RoomError("It's not your team's turn")
        return game, member.team

    def _clue(self, member: Member, word: object, number: object) -> None:
        game, team = self._active(member, "spymaster")
        try:
            events = game.give_clue(team, clean_text(word, 40), parse_number(number))
        except IllegalMove as e:
            raise RoomError(str(e)) from None
        self.clue_by.append(member.name)
        self._apply(member, events)

    def _guess(self, member: Member, card: object) -> None:
        game, team = self._active(member, "operative")
        if not isinstance(card, int) or isinstance(card, bool):
            raise RoomError("No such card")
        try:
            events = game.guess(team, card)
        except IllegalMove as e:
            raise RoomError(str(e)) from None
        self.marks.pop(card, None)
        self._apply(member, events)

    def _end_turn(self, member: Member) -> None:
        game, team = self._active(member, "operative")
        try:
            events = game.end_turn(team)
        except IllegalMove as e:
            raise RoomError(str(e)) from None
        self._apply(member, events)

    def _mark(self, member: Member, card: object) -> None:
        """Point at a card (each operative points at one card at a time); None takes the pointer back."""
        game, _ = self._active(member, "operative")
        if game.phase != Phase.GUESS:
            raise RoomError("Wait for the clue")
        if card is not None and (
            not isinstance(card, int) or isinstance(card, bool) or not 0 <= card < len(game.cards)
        ):
            raise RoomError("No such card")
        for c in list(self.marks):
            if member.id in self.marks[c]:
                self.marks[c].remove(member.id)
                if not self.marks[c]:
                    del self.marks[c]
        if card is not None and not game.revealed[card]:
            self.marks.setdefault(card, []).append(member.id)
        self._emit({"kind": "mark", "card": card, "member": member.id})

    def _apply(self, member: Member | None, events: list[Event]) -> None:
        game = self.game
        assert game is not None
        if game.phase == Phase.OVER:
            self.status = "game_over"
            assert game.winner is not None
            self.score[game.winner] += 1
            log.info(
                "table %s: game %d won by %s (%s) · score red %d – blue %d",
                self.id,
                self.game_no,
                game.winner,
                game.reason,
                self.score["red"],
                self.score["blue"],
            )
        for ev in events:
            self._narrate(member, ev)
            if ev["kind"] in ("turn", "win"):
                self.marks = {}
        self._emit({"kind": "move", "member": member.id if member else None, "events": events})

    def _card_label(self, card: int) -> str:
        game = self.game
        assert game is not None
        return game.cards[card] if game.words else "a picture"

    def _narrate(self, member: Member | None, ev: Event) -> None:
        name = member.name if member else ""
        team = ev.get("team")
        match ev["kind"]:
            case "clue":
                number = "∞" if ev["number"] is None else ev["number"]
                self._append_log(
                    {"kind": "clue", "team": team, "name": name, "word": ev["word"], "number": number},
                )
            case "reveal":
                game = self.game
                assert game is not None
                kind = ev["as"]
                good = kind == team
                mark = "✓" if good else ("☠" if kind == "assassin" else "✗")
                self._append_log(
                    {
                        "kind": "game",
                        "team": team,
                        "text": f"{mark} {name} revealed {self._card_label(ev['card'])}: {KIND_TEXT[kind]}",
                        "card": None if game.words else game.cards[ev["card"]],
                        "as": kind,
                    }
                )
            case "turn":
                why = {
                    "miss": "",
                    "limit": f"{TEAM_NAMES[ev['from']]} used all their guesses. ",
                    "stop": f"{TEAM_NAMES[ev['from']]} stopped guessing. ",
                    "timeout": f"⏱ {TEAM_NAMES[ev['from']]} ran out of time. ",
                }[ev["reason"]]
                self._say(f"{why}{TEAM_NAMES[team]}'s turn", team=team)
            case "win":
                how = (
                    "the other team found the assassin" if ev["reason"] == "assassin" else "all their agents were found"
                )
                score = f"Red {self.score['red']} – Blue {self.score['blue']}"
                self._say(f"🏆 {TEAM_NAMES[team]} wins: {how}! Score: {score}", team=team)

    # ------------------------------------------------------------------ timer
    def _refresh_deadline(self) -> None:
        timer = self.settings.timer
        game = self.game
        key: tuple[Any, ...] | None = None
        if timer and self.status == "playing" and game is not None and game.phase != Phase.OVER:
            key = (self.game_no, game.turns, game.phase.value)
        if key is None:
            self._deadline = None
        elif self._deadline is None or self._deadline[0] != key:
            self._deadline = (key, time.monotonic() + timer)

    def plan(self) -> tuple[float, Any] | None:
        """The next timed step as (seconds to wait, callable), or None to wait for players."""
        game = self.game
        if self._deadline is None or game is None or self.status != "playing" or game.phase != Phase.GUESS:
            return None
        return max(0.0, self._deadline[1] - time.monotonic()), self._timeout

    def _timeout(self) -> None:
        game = self._game()
        events = game.timeout()
        if events:
            self._apply(None, events)

    async def drive(self) -> None:
        """Run turn timeouts until the room is closed."""
        while not self.closed:
            self._wake.clear()
            plan = self.plan()
            if plan is None:
                await self._wake.wait()
                continue
            delay, step = plan
            if delay > 0:
                try:
                    await asyncio.wait_for(self._wake.wait(), delay)
                    continue
                except TimeoutError:
                    pass
            try:
                step()
            except Exception:
                log.exception("room %s: timed step failed", self.id)
            await asyncio.sleep(0)

    def close(self) -> None:
        self.closed = True
        self._wake.set()

    # ------------------------------------------------------------------ output
    def _append_log(self, entry: dict[str, Any]) -> None:
        entry["ts"] = time.time()
        self.log.append(entry)
        for listener in list(self.listeners):
            listener.send({"type": "log", "entry": entry})

    def _say(self, text: str, team: str | None = None) -> None:
        self._append_log({"kind": "game", "text": text, "team": team})

    def _emit(self, event: dict[str, Any]) -> None:
        self._refresh_deadline()
        self.seq += 1
        event["seq"] = self.seq
        for listener in list(self.listeners):
            listener.send(self.state_for(listener.member_id, event))
        self._wake.set()

    def state_for(self, member_id: str, event: dict[str, Any] | None = None) -> dict[str, Any]:
        me = self.members[member_id]
        members = [
            {"member": m.id, "name": m.name, "team": m.team, "role": m.role, "connected": m.connections > 0}
            for m in self.members.values()
        ]
        return {
            "type": "state",
            "seq": self.seq,
            "event": event,
            "room": self.id,
            "status": self.status,
            "host": self.host_id,
            "game_no": self.game_no,
            "you": {"member": member_id, "team": me.team, "role": me.role, "saw_key": me.saw_key},
            "settings": dataclasses.asdict(self.settings),
            "members": members,
            "score": dict(self.score),
            "problems": self.problems(),
            "game": self._game_state(me),
        }

    def _game_state(self, me: Member) -> dict[str, Any] | None:
        game = self.game
        if game is None:
            return None
        over = game.phase == Phase.OVER
        sees_key = over or (me.team is not None and me.role == "spymaster")
        cards = []
        for i, text in enumerate(game.cards):
            shown = game.revealed[i] or sees_key
            cards.append(
                {
                    "text": text,
                    "revealed": game.revealed[i],
                    "kind": game.key[i].value if shown else None,
                    "by": game.revealed_by[i],
                }
            )
        history = []
        for n, clue in enumerate(game.history):
            entry = clue.to_json()
            entry["by"] = self.clue_by[n] if n < len(self.clue_by) else ""
            entry["results"] = [game.key[c].value for c in clue.guesses]
            history.append(entry)
        my_turn = me.team == game.turn and not over and self.status == "playing"
        state: dict[str, Any] = {
            "deck": self.settings.deck,
            "words": game.words,
            "cols": game.layout.cols,
            "rows": game.layout.rows,
            "cards": cards,
            "first": game.first,
            "turn": game.turn,
            "phase": game.phase.value,
            "clue": game.clue.to_json() if game.clue else None,
            "guesses_made": game.guesses_made,
            "guesses_left": game.guesses_left,
            "can_end": game.can_end_turn,
            "remaining": {t: game.remaining(t) for t in TEAMS},
            "total": {t: game.total(t) for t in TEAMS},
            "marks": {str(c): list(ms) for c, ms in self.marks.items()},
            "winner": game.winner,
            "reason": game.reason,
            "history": history,
            "sees_key": sees_key,
            "can_clue": my_turn and me.role == "spymaster" and game.phase == Phase.CLUE,
            "can_guess": my_turn and me.role == "operative" and game.phase == Phase.GUESS,
            "time_left": None,
            "time_total": self.settings.timer,
        }
        if self._deadline is not None:
            state["time_left"] = round(self._deadline[1] - time.monotonic(), 2)
        return state

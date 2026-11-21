"""The rules: a pure state machine with no I/O.

Two teams, red and blue. Each has a spymaster, who sees the secret key, and operatives, who don't.
The team that starts has one more agent to find. On its turn a team's spymaster gives a clue (a word
and a number), then the operatives reveal cards one at a time:

* their own agent: correct, they may keep guessing;
* a civilian or an enemy agent: the turn ends at once;
* the assassin: their team loses immediately.

With a clue number N the operatives may make at most N + 1 guesses (the extra one lets them catch up on
an earlier clue). A clue of 0 or "unlimited" allows any number of guesses. At least one guess is
required before a team may stop. A team wins when all its agents are revealed, even when the other
team revealed the last one.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

TEAMS = ("red", "blue")
MAX_CLUE_NUMBER = 9
MAX_CLUE_WORD = 32

Event = dict[str, Any]


class IllegalMove(Exception):
    """A move the rules don't allow; the message is shown to the player."""


class Kind(StrEnum):
    RED = "red"
    BLUE = "blue"
    CIVILIAN = "civilian"
    ASSASSIN = "assassin"


class Phase(StrEnum):
    CLUE = "clue"
    GUESS = "guess"
    OVER = "over"


@dataclass(frozen=True)
class Layout:
    cols: int
    rows: int
    first: int  # agents of the starting team
    second: int
    assassins: int = 1

    @property
    def size(self) -> int:
        return self.cols * self.rows

    @property
    def civilians(self) -> int:
        return self.size - self.first - self.second - self.assassins


WORDS = Layout(cols=5, rows=5, first=9, second=8)
PICTURES = Layout(cols=5, rows=4, first=8, second=7)


def other(team: str) -> str:
    return "blue" if team == "red" else "red"


@dataclass
class Clue:
    team: str
    word: str
    number: int | None  # None: unlimited
    guesses: list[int] = field(default_factory=list)  # card indices, in order

    @property
    def max_guesses(self) -> int | None:
        if self.number is None or self.number == 0:
            return None
        return self.number + 1

    def to_json(self) -> dict[str, Any]:
        return {"team": self.team, "word": self.word, "number": self.number, "guesses": list(self.guesses)}


def parse_number(value: object) -> int | None:
    """A clue number from the client: 0–9, or "inf" / None for unlimited."""
    if value is None or value == "inf":
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_CLUE_NUMBER:
        raise IllegalMove(f"The number must be 0–{MAX_CLUE_NUMBER} or unlimited")
    return value


def _norm(word: str) -> str:
    return "".join(word.casefold().split())


class Game:
    def __init__(
        self,
        cards: list[str],
        layout: Layout,
        first: str = "red",
        seed: int | None = None,
        words: bool = True,
    ) -> None:
        if len(cards) != layout.size:
            raise ValueError(f"need {layout.size} cards, got {len(cards)}")
        if first not in TEAMS:
            raise ValueError(f"unknown team {first!r}")
        rng = random.Random(seed)
        self.cards = list(cards)
        self.layout = layout
        self.words = words  # word cards (clues may not be a word on the table) or pictures
        self.first = first
        key = (
            [Kind(first)] * layout.first
            + [Kind(other(first))] * layout.second
            + [Kind.CIVILIAN] * layout.civilians
            + [Kind.ASSASSIN] * layout.assassins
        )
        rng.shuffle(key)
        self.key: list[Kind] = key
        self.revealed: list[bool] = [False] * layout.size
        self.revealed_by: list[str | None] = [None] * layout.size  # team that turned the card
        self.turn = first
        self.phase = Phase.CLUE
        self.clue: Clue | None = None
        self.history: list[Clue] = []
        self.winner: str | None = None
        self.reason: str | None = None  # "agents" | "assassin"
        self.turns = 0

    # ------------------------------------------------------------------ queries
    def total(self, team: str) -> int:
        return sum(1 for k in self.key if k == team)

    def remaining(self, team: str) -> int:
        return sum(1 for k, r in zip(self.key, self.revealed, strict=True) if k == team and not r)

    @property
    def guesses_made(self) -> int:
        return len(self.clue.guesses) if self.clue else 0

    @property
    def guesses_left(self) -> int | None:
        """Guesses still allowed this turn; None means unlimited."""
        if self.clue is None or self.phase != Phase.GUESS:
            return 0
        limit = self.clue.max_guesses
        return None if limit is None else limit - self.guesses_made

    @property
    def can_end_turn(self) -> bool:
        return self.phase == Phase.GUESS and self.guesses_made >= 1

    # ------------------------------------------------------------------ moves
    def _check_turn(self, team: str, phase: Phase) -> None:
        if self.phase == Phase.OVER:
            raise IllegalMove("The game is over")
        if team != self.turn:
            raise IllegalMove("It's not your team's turn")
        if self.phase != phase:
            raise IllegalMove("Wait for the clue" if phase == Phase.GUESS else "The clue has already been given")

    def give_clue(self, team: str, word: str, number: int | None) -> list[Event]:
        self._check_turn(team, Phase.CLUE)
        word = " ".join(str(word).split())[:MAX_CLUE_WORD]
        if number is not None and not 0 <= number <= MAX_CLUE_NUMBER:
            raise IllegalMove(f"The number must be 0–{MAX_CLUE_NUMBER} or unlimited")
        if word and self.words:
            w = _norm(word)
            for i, card in enumerate(self.cards):
                if not self.revealed[i] and _norm(card) == w:
                    raise IllegalMove("The clue can't be a word that is on the table")
        self.clue = Clue(team=team, word=word, number=number)
        self.history.append(self.clue)
        self.phase = Phase.GUESS
        return [{"kind": "clue", "team": team, "word": word, "number": number}]

    def guess(self, team: str, card: int) -> list[Event]:
        self._check_turn(team, Phase.GUESS)
        if not isinstance(card, int) or isinstance(card, bool) or not 0 <= card < len(self.cards):
            raise IllegalMove("No such card")
        if self.revealed[card]:
            raise IllegalMove("That card is already revealed")
        if self.guesses_left == 0:
            raise IllegalMove("No guesses left this turn")
        assert self.clue is not None
        kind = self.key[card]
        self.revealed[card] = True
        self.revealed_by[card] = team
        self.clue.guesses.append(card)
        events: list[Event] = [{"kind": "reveal", "card": card, "as": kind.value, "team": team}]
        if kind == Kind.ASSASSIN:
            return events + self._win(other(team), "assassin")
        if kind.value in TEAMS and self.remaining(kind.value) == 0:
            return events + self._win(kind.value, "agents")
        if kind != team:
            return events + self._pass_turn("miss")
        if self.guesses_left == 0:
            return events + self._pass_turn("limit")
        return events

    def end_turn(self, team: str) -> list[Event]:
        self._check_turn(team, Phase.GUESS)
        if not self.can_end_turn:
            raise IllegalMove("Make at least one guess first")
        return self._pass_turn("stop")

    def timeout(self) -> list[Event]:
        """The turn timer ran out: the guessing team's turn ends (a spymaster just gets nagged)."""
        if self.phase != Phase.GUESS:
            return []
        return self._pass_turn("timeout")

    def _pass_turn(self, reason: str) -> list[Event]:
        done = self.turn
        self.turn = other(done)
        self.phase = Phase.CLUE
        self.clue = None
        self.turns += 1
        return [{"kind": "turn", "from": done, "team": self.turn, "reason": reason}]

    def _win(self, team: str, reason: str) -> list[Event]:
        self.phase = Phase.OVER
        self.winner = team
        self.reason = reason
        return [{"kind": "win", "team": team, "reason": reason}]

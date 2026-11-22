import pytest

from codenames.game.decks import builtin_decks, load_decks
from codenames.game.engine import PICTURES, WORDS, Game, IllegalMove, Kind, Phase, parse_number


def _game(first: str = "red", seed: int = 1) -> Game:
    return Game([f"W{i}" for i in range(25)], WORDS, first=first, seed=seed)


def _cards(game: Game, kind: str) -> list[int]:
    return [i for i, k in enumerate(game.key) if k == kind and not game.revealed[i]]


def test_layout_counts() -> None:
    g = _game("blue")
    assert g.total("blue") == 9 and g.total("red") == 8
    assert g.key.count(Kind.CIVILIAN) == 7 and g.key.count(Kind.ASSASSIN) == 1
    p = Game([f"P{i}" for i in range(20)], PICTURES, first="red", seed=2, words=False)
    assert p.total("red") == 8 and p.total("blue") == 7
    assert p.key.count(Kind.CIVILIAN) == 4 and p.key.count(Kind.ASSASSIN) == 1


def test_clue_number_limits_guesses_to_n_plus_one() -> None:
    g = _game()
    g.give_clue("red", "ocean", 1)
    assert g.guesses_left == 2
    reds = _cards(g, "red")
    g.guess("red", reds[0])
    assert g.turn == "red" and g.guesses_left == 1
    events = g.guess("red", reds[1])
    assert events[-1] == {"kind": "turn", "from": "red", "team": "blue", "reason": "limit"}
    assert g.turn == "blue" and g.phase == Phase.CLUE


@pytest.mark.parametrize("number", [0, None])
def test_zero_and_unlimited_allow_any_number_of_guesses(number: int | None) -> None:
    g = _game()
    g.give_clue("red", "sea", number)
    assert g.guesses_left is None
    for card in _cards(g, "red")[:5]:
        g.guess("red", card)
    assert g.turn == "red" and g.guesses_made == 5


def test_wrong_guess_ends_turn_and_must_guess_before_stopping() -> None:
    g = _game()
    g.give_clue("red", "sea", 3)
    with pytest.raises(IllegalMove):
        g.end_turn("red")
    g.guess("red", _cards(g, "civilian")[0])
    assert g.turn == "blue"
    g.give_clue("blue", "sky", 2)
    g.guess("blue", _cards(g, "blue")[0])
    g.end_turn("blue")
    assert g.turn == "red"


def test_assassin_loses_and_last_agent_wins_for_its_owner() -> None:
    g = _game()
    g.give_clue("red", "sea", 2)
    events = g.guess("red", _cards(g, "assassin")[0])
    assert g.phase == Phase.OVER and g.winner == "blue" and g.reason == "assassin"
    assert events[-1]["kind"] == "win"

    g = _game()
    for card in _cards(g, "blue")[:-1]:
        g.revealed[card] = True
    g.give_clue("red", "sea", None)
    g.guess("red", _cards(g, "blue")[0])  # red reveals blue's last agent: blue wins
    assert g.winner == "blue" and g.reason == "agents"


def test_rules_reject_bad_moves() -> None:
    g = _game()
    with pytest.raises(IllegalMove):
        g.give_clue("blue", "x", 1)
    with pytest.raises(IllegalMove):
        g.guess("red", 0)
    with pytest.raises(IllegalMove):
        g.give_clue("red", "w3", 1)  # a word on the table
    g.give_clue("red", "", 2)  # spoken aloud: the word is optional
    card = _cards(g, "red")[0]
    g.guess("red", card)
    with pytest.raises(IllegalMove):
        g.guess("red", card)
    for bad in (-1, 10, True, "3"):
        with pytest.raises(IllegalMove):
            parse_number(bad)
    assert parse_number("inf") is None and parse_number(0) == 0


def test_bundled_decks() -> None:
    decks = {d.key: d for d in builtin_decks()}
    assert len(decks["en"].cards) == 400
    assert len(decks["pl"].cards) == 400
    assert all("_" not in w for w in decks["pl"].cards)
    assert len(decks["pictures"].cards) >= 200
    assert set(load_decks()) == {"en", "pl", "pictures"}

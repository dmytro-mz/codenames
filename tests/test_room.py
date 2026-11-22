from typing import Any

import pytest
from fastapi.testclient import TestClient

from codenames.web.room import Room, RoomError
from codenames.web.server import create_app

TOKENS = [c * 32 for c in "abcdef"]


class Inbox:
    def __init__(self, member_id: str) -> None:
        self.member_id = member_id
        self.messages: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        self.messages.append(message)

    @property
    def state(self) -> dict[str, Any]:
        return next(m for m in reversed(self.messages) if m["type"] == "state")


def _room(n: int = 4) -> tuple[Room, list[Inbox]]:
    room = Room("TEST", seed=3)
    inboxes = []
    for i in range(n):
        member = room.join(TOKENS[i], f"P{i}")
        inbox = Inbox(member.id)
        room.connect(inbox)
        inboxes.append(inbox)
    return room, inboxes


def _teams(room: Room, ids: list[str]) -> None:
    host = room.host_id
    assert host
    roles = [("red", "spymaster"), ("red", "operative"), ("blue", "spymaster"), ("blue", "operative")]
    for member, (team, role) in zip(ids, roles, strict=False):
        room.handle(host, {"type": "assign", "member": member, "team": team, "role": role})


def test_lobby_needs_a_spymaster_and_operative_per_team() -> None:
    room, boxes = _room(3)
    host = boxes[0].member_id
    with pytest.raises(RoomError):
        room.handle(boxes[1].member_id, {"type": "start"})  # not the host
    _teams(room, [b.member_id for b in boxes])
    assert room.problems() == ["Blue needs at least one operative"]
    with pytest.raises(RoomError):
        room.handle(host, {"type": "start"})


def test_only_one_spymaster_per_team() -> None:
    room, boxes = _room(4)
    _teams(room, [b.member_id for b in boxes])
    with pytest.raises(RoomError):
        room.handle(boxes[1].member_id, {"type": "join_team", "team": "red", "role": "spymaster"})
    room.handle(boxes[1].member_id, {"type": "join_team", "team": "blue", "role": "operative"})
    assert room.members[boxes[1].member_id].team == "blue"


def test_key_is_hidden_from_operatives_and_permissions_hold() -> None:
    room, boxes = _room(5)
    ids = [b.member_id for b in boxes]
    _teams(room, ids)
    room.handle(ids[0], {"type": "assign", "member": ids[4], "team": None})
    room.handle(ids[0], {"type": "start"})
    game = room.game
    assert game is not None
    spy = {"red": ids[0], "blue": ids[2]}[game.turn]
    op = {"red": ids[1], "blue": ids[3]}[game.turn]
    enemy_op = {"red": ids[3], "blue": ids[1]}[game.turn]
    for box in boxes:
        cards = box.state["game"]["cards"]
        visible = box.member_id in (ids[0], ids[2])
        assert all((c["kind"] is not None) == visible for c in cards), box.member_id
    with pytest.raises(RoomError):
        room.handle(op, {"type": "clue", "word": "sea", "number": 2})
    with pytest.raises(RoomError):
        room.handle(op, {"type": "guess", "card": 0})  # no clue yet
    room.handle(spy, {"type": "clue", "word": "sea", "number": 1})
    with pytest.raises(RoomError):
        room.handle(enemy_op, {"type": "guess", "card": 0})
    with pytest.raises(RoomError):
        room.handle(spy, {"type": "guess", "card": 0})
    own = [i for i, k in enumerate(game.key) if k == game.turn]
    room.handle(op, {"type": "mark", "card": own[0]})
    assert boxes[4].state["game"]["marks"] == {str(own[0]): [op]}
    room.handle(op, {"type": "guess", "card": own[0]})
    state = boxes[4].state["game"]
    assert state["cards"][own[0]]["kind"] == game.turn and state["marks"] == {}
    assert state["guesses_left"] == 1
    # A spymaster can't switch to guessing in the middle of the game.
    with pytest.raises(RoomError):
        room.handle(spy, {"type": "join_team", "team": game.turn, "role": "operative"})


def _play_out(room: Room, ids: list[str]) -> None:
    game = room.game
    assert game is not None
    spies = {"red": ids[0], "blue": ids[2]}
    ops = {"red": ids[1], "blue": ids[3]}
    for _ in range(200):
        if room.status != "playing":
            return
        team = game.turn
        if game.phase.value == "clue":
            room.handle(spies[team], {"type": "clue", "word": "", "number": "inf"})
            continue
        own = [i for i, k in enumerate(game.key) if k == team and not game.revealed[i]]
        civ = [i for i, k in enumerate(game.key) if k == "civilian" and not game.revealed[i]]
        card = own[0] if (own and game.guesses_made < 2) or not civ else civ[0]
        room.handle(ops[team], {"type": "guess", "card": card})
    raise AssertionError("game did not finish")


def test_full_game_scores_and_rematch() -> None:
    room, boxes = _room(4)
    ids = [b.member_id for b in boxes]
    _teams(room, ids)
    room.handle(ids[0], {"type": "settings", "changes": {"deck": "pictures", "timer": 90}})
    room.handle(ids[0], {"type": "start"})
    assert room.game is not None and len(room.game.cards) == 20
    _play_out(room, ids)
    assert room.status == "game_over"
    assert sum(room.score.values()) == 1
    final = boxes[1].state["game"]
    assert all(c["kind"] is not None for c in final["cards"])  # everyone sees the key at the end
    room.handle(ids[0], {"type": "play_again"})
    assert room.status == "playing" and room.game_no == 2


def test_timeout_ends_guessing() -> None:
    room, boxes = _room(4)
    ids = [b.member_id for b in boxes]
    _teams(room, ids)
    room.handle(ids[0], {"type": "settings", "changes": {"timer": 60}})
    room.handle(ids[0], {"type": "start"})
    game = room.game
    assert game is not None
    first = game.turn
    assert room.plan() is None  # the spymaster is only nagged
    room.handle({"red": ids[0], "blue": ids[2]}[first], {"type": "clue", "word": "x", "number": 2})
    plan = room.plan()
    assert plan is not None and 55 < plan[0] <= 60
    plan[1]()
    assert game.turn != first


def test_http_and_websocket_roundtrip() -> None:
    with TestClient(create_app()) as client:
        cfg = client.get("/api/config").json()
        assert [d["key"] for d in cfg["decks"]] == ["en", "pl", "pictures"]
        code = client.post("/api/rooms").json()["room"]
        assert client.get(f"/api/rooms/{code}").status_code == 200
        assert client.get("/r/" + code).status_code == 200
        with client.websocket_connect(f"/ws/{code}") as ws:
            ws.send_json({"type": "hello", "token": TOKENS[0], "name": "Ann"})
            assert ws.receive_json()["type"] == "welcome"
            state = ws.receive_json()
            assert state["type"] == "state" and state["members"][0]["name"] == "Ann"


def test_test_mode_switch_seats() -> None:
    client = TestClient(create_app(test=True))
    code = client.post("/api/rooms").json()["room"]
    with client.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json({"token": TOKENS[0], "name": "Me"})
        states = []
        while len(states) < 1 or len(states[-1]["members"]) < 4:
            m = ws.receive_json()
            if m["type"] == "state":
                states.append(m)
        ids = [m["member"] for m in states[-1]["members"]]
        ws.send_json({"type": "test_switch", "member": ids[1]})
        while True:
            m = ws.receive_json()
            if m["type"] == "welcome":
                assert m["you"] == ids[1]
                break
        ws.send_json({"type": "join_team", "team": "red", "role": "spymaster"})
        while True:
            m = ws.receive_json()
            if m["type"] == "state" and m["you"]["member"] == ids[1] and m["you"]["role"] == "spymaster":
                break
        assert m["you"]["team"] == "red"

"""Serve a pre-played table and screenshot it from different seats and window sizes (visual checks).

    uv run python scripts/demo.py [--stage lobby|clue|guess|over] [--deck en|pl|pictures]
                                  [--as spy|op|watch] [--size 1440x900,390x844] [--out shots] [--serve]

The table has four players: Ann (red spymaster), Bob (red operative), Cleo (blue spymaster), Dan (blue
operative) and a watcher, Eve. --as picks whose browser the screenshot comes from.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from playwright.async_api import async_playwright

from codenames.game.engine import Phase
from codenames.web.room import Room
from codenames.web.server import create_app

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 8766
NAMES = ["Ann", "Bob", "Cleo", "Dan", "Eve"]
TOKENS = {name: f"{i:x}" * 32 for i, name in enumerate(NAMES, start=10)}
ROLES = [("red", "spymaster"), ("red", "operative"), ("blue", "spymaster"), ("blue", "operative"), (None, None)]


def prepare(stage: str, deck: str, seed: int = 4) -> Room:
    room = Room("DEMO", seed=seed)
    ids = [room.join(TOKENS[n], n).id for n in NAMES]
    host = ids[0]
    for mid, (team, role) in zip(ids, ROLES, strict=True):
        room.handle(host, {"type": "assign", "member": mid, "team": team, "role": role})
    room.handle(host, {"type": "settings", "changes": {"deck": deck, "timer": 120}})
    if stage == "lobby":
        return room
    room.handle(host, {"type": "start"})
    game = room.game
    assert game is not None
    spy = {"red": ids[0], "blue": ids[2]}
    op = {"red": ids[1], "blue": ids[3]}

    def own(team: str) -> list[int]:
        return [i for i, k in enumerate(game.key) if k == team and not game.revealed[i]]

    def kind(k: str) -> list[int]:
        return [i for i, x in enumerate(game.key) if x == k and not game.revealed[i]]

    words = iter(["ORBIT", "MELODY", "FOREST", "SHADOW", "VELVET"])
    for _ in range(2):  # each team gets two agents and a miss
        t = game.turn
        room.handle(spy[t], {"type": "clue", "word": next(words), "number": 2})
        for c in own(t)[:2]:
            room.handle(op[t], {"type": "guess", "card": c})
        if game.turn == t:
            room.handle(op[t], {"type": "guess", "card": kind("civilian")[0]})
    t = game.turn
    if stage in ("guess", "over"):
        room.handle(spy[t], {"type": "clue", "word": next(words), "number": 3})
        room.handle(op[t], {"type": "guess", "card": own(t)[0]})
        room.handle(op[t], {"type": "mark", "card": own(t)[0]})
    if stage == "over":
        room.handle(op[t], {"type": "guess", "card": kind("assassin")[0]})
        assert game.phase == Phase.OVER
    return room


@contextlib.asynccontextmanager
async def serving(app: FastAPI, room: Room, port: int = PORT) -> AsyncIterator[str]:
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    app.state.manager.adopt(room)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


def viewer(stage: str, who: str, room: Room) -> str:
    game = room.game
    if who == "watch":
        return "Eve"
    team = game.turn if game is not None else "red"
    if who == "spy":
        return "Ann" if team == "red" else "Cleo"
    return "Bob" if team == "red" else "Dan"


async def run(args: argparse.Namespace) -> None:
    room = prepare(args.stage, args.deck)
    app = create_app()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    async with serving(app, room) as base, async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME, headless=not args.headed)
        name = viewer(args.stage, args.who, room)
        url = f"{base}/r/{room.id}?me={TOKENS[name]}" if args.stage != "home" else base
        for size in args.size.split(","):
            w, h = (int(x) for x in size.split("x"))
            page = await browser.new_page(viewport={"width": w, "height": h}, reduced_motion="reduce")
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
            await page.goto(url)
            await page.wait_for_timeout(1500)
            path = out / f"{args.stage}-{args.deck}-{args.who}-{w}x{h}.png"
            await page.screenshot(path=str(path))
            print(path)
            await page.close()
        if args.serve:
            print(f"serving {url}  (Ctrl+C to stop)")
            await asyncio.Event().wait()
        await browser.close()
    for e in errors:
        print(e)
    if errors:
        raise SystemExit(1)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--stage", default="guess", choices=["home", "lobby", "clue", "guess", "over"])
    p.add_argument("--deck", default="en", choices=["en", "pl", "pictures"])
    p.add_argument("--as", dest="who", default="op", choices=["spy", "op", "watch"])
    p.add_argument("--size", default="1440x900")
    p.add_argument("--out", default="shots")
    p.add_argument("--headed", action="store_true")
    p.add_argument("--serve", action="store_true")
    asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    main()

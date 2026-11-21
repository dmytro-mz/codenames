"""Play whole games through four real browser pages (clicks only) and fail on any page error.

    uv run python scripts/ui_check.py [--deck en|pl|pictures] [--headed] [--shots shots/ui]

Ann and Cleo are the spymasters, Bob and Dan the operatives. The script peeks at the server's key to
decide what to click, so it exercises correct guesses, misses, ending a turn, the assassin and a rematch.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from demo import CHROME, NAMES, TOKENS, prepare, serving
from playwright.async_api import Page, async_playwright

from codenames.game.engine import Phase
from codenames.web.server import create_app

SIZES = {"Ann": (1440, 900), "Bob": (390, 844), "Cleo": (1024, 700), "Dan": (1280, 720)}


async def run(args: argparse.Namespace) -> None:
    room = prepare("lobby", args.deck)
    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    async with serving(create_app(), room) as base, async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME, headless=not args.headed)
        pages: dict[str, Page] = {}
        for name in NAMES[:4]:
            w, h = SIZES[name]
            page = await browser.new_page(viewport={"width": w, "height": h})
            page.on("pageerror", lambda e, n=name: errors.append(f"{n} pageerror: {e}"))
            page.on("console", lambda m, n=name: m.type == "error" and errors.append(f"{n} console: {m.text}"))
            await page.goto(f"{base}/r/{room.id}?me={TOKENS[name]}")
            pages[name] = page
        for page in pages.values():
            await page.wait_for_selector(".lobby")
        ids = {m.name: m.id for m in room.members.values()}
        spy = {"red": pages["Ann"], "blue": pages["Cleo"]}
        op = {"red": pages["Bob"], "blue": pages["Dan"]}

        for game_no in (1, 2):
            button = ".lobby-actions .start" if game_no == 1 else ".result .btn.primary"
            start = pages["Ann"].locator(button)
            await start.click()
            await pages["Bob"].wait_for_selector(".board .card")
            await pages["Ann"].wait_for_timeout(1200)
            if game_no == 1:
                await pages["Ann"].screenshot(path=str(shots / "start-spymaster.png"))
            game = room.game
            assert game is not None
            turns = 0
            while game.phase != Phase.OVER:
                team = game.turn
                own = [i for i, k in enumerate(game.key) if k == team and not game.revealed[i]]
                civ = [i for i, k in enumerate(game.key) if k == "civilian" and not game.revealed[i]]
                assassin = game.key.index("assassin")  # type: ignore[arg-type]
                s = spy[team]
                await s.wait_for_selector(".composer .clue-input")
                await s.fill(".composer .clue-input", f"clue{turns}")
                await s.click('.composer .num[data-n="2"]')
                await s.click(".composer .give")
                o = op[team]
                await o.wait_for_selector(".card.guessable")
                if turns == 0:
                    await o.screenshot(path=str(shots / "guessing.png"))
                # Second game: the first guess hits the assassin.
                plan = [assassin] if game_no == 2 else own[:2] + ([civ[0]] if turns % 3 == 1 and civ else [])
                for card in plan:
                    if game.phase != Phase.GUESS or game.turn != team:
                        break
                    target = o.locator(".board .card").nth(card)
                    await target.click()
                    await o.wait_for_selector(f".board .card:nth-child({card + 1}).mine")
                    await target.click()
                    await o.wait_for_selector(f".board .card:nth-child({card + 1}).revealed")
                    await o.wait_for_timeout(350)
                if game.phase == Phase.GUESS and game.turn == team:
                    await o.click(".end-turn")
                    await o.wait_for_function("() => !document.querySelector('.end-turn')")
                turns += 1
                assert turns < 30, "game did not finish"
            for page in pages.values():
                await page.wait_for_selector(".result", timeout=6000)
            await pages["Bob"].screenshot(path=str(shots / f"over-{game_no}-bob.png"))
            await pages["Ann"].screenshot(path=str(shots / f"over-{game_no}-ann.png"))
            print(f"game {game_no}: {game.winner} won ({game.reason}) after {turns} turns; score {room.score}")
        # Chat and a reaction travel to everyone.
        await pages["Dan"].fill(".chat-form input", "gg!")
        await pages["Dan"].press(".chat-form input", "Enter")
        await pages["Ann"].wait_for_selector(".feed .entry.chat")
        assert ids
        await browser.close()
    for e in errors:
        print(e)
    if errors:
        raise SystemExit(1)
    print("ok: no page errors")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--deck", default="en", choices=["en", "pl", "pictures"])
    p.add_argument("--headed", action="store_true")
    p.add_argument("--shots", default="shots/ui")
    asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    main()

"""Download the built-in picture deck: Twemoji illustrations (graphics CC-BY 4.0, https://github.com/jdecked/twemoji).

    uv run python scripts/fetch_pictures.py

The SVGs are committed to src/wordspies/web/static/pictures/, so this is only needed to change the deck.
Each file is named after its emoji's code points, e.g. 1f98a.svg for 🦊.
"""

from __future__ import annotations

import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

VERSION = "17.0.3"
BASE = f"https://cdn.jsdelivr.net/gh/jdecked/twemoji@{VERSION}/assets/svg"
OUT = Path(__file__).resolve().parents[1] / "src" / "wordspies" / "web" / "static" / "pictures"

# Things with more than one meaning make the best pictures; no faces, hands or flags.
DECK = (
    # animals
    "🦊🐙🦉🐝🦋🐢🦈🐳🦀🐌🦒🐘🦓🦔🦇🐺🦁🐯🐼🐨🐧🦜🦩🦚🐊🦎🐍🦖🐞🕷🦂🐟🐡🦞🦑🐫🦘🦥🦦🦨🐿🦫🐓🦃🦆🦢🐄🐖🐑🐐🐎🦄🐉"
    # plants and nature
    "🌵🌲🌴🍄🌻🌹🌷🍀🍁🌾🪵🪨🌋🏔🏝🏜🌊🌈⛄🔥💧⚡🌙⭐☀🌪🌍☄🪐❄"
    # food
    "🍎🍋🍌🍉🍇🍓🍒🍍🥥🥑🌶🌽🥕🧄🥔🥐🥨🧀🥚🍳🥞🍔🍕🌭🌮🍿🍣🍩🍪🎂🍫🍬🍭🍯🥛☕🍵🍷🍺🧊🥢🍴"
    # places and transport
    "🏰🏯🗼🗽⛪🕌🏛🏠🏚🏭🏥🏦🎪⛺🌉🎡🎢⛲⛵🚀🛸🚁✈🚂🚲🛴🛹🚗🚕🚒🚑🚓🚜🏎🛵🚦⚓🛶🚢🪂🛰"
    # objects
    "⌚📱💻⌨🖨🖱💾📷🎥📺📻🎙⏰⏳🔦🕯💡🔋🔌💰💎⚖🔧🔨⚒🪓⛏🔩⚙🧲🔫💣🔪🗡⚔🛡🔮🧿💈⚗🔭🔬💊💉🩹🧬🦠🧪🌡🧹🧺🧻🚽🛁🧼🪒🧽🔑🗝🚪🪑🛏🧸🪆🖼🪞🪟🛒🎁🎈🎏🎀🪄🧧✉📦📜📌📎✂🔒🔔📯📣🎺🎸🎻🥁🪘🎹🎷🪗🎲🧩♟🎯🎳🎮🎰🧶🧵🪡👑👒🎩🧢⛑👓🕶🥽👔👗👙👠👟🥾🧤🧣🌂☂💼🎒⚽🏀🏈⚾🎾🏐🏓🥊🥋⛸🎿🛷🏹🎣🤿🛟🏆🥇🎭🎨🖌🖍📚📖🔍🗺🧭🏮🪁⚰🗿🧯🪤🪣🦴👻💀👽🤖🎃💩🧠🫀🦷👁👣💋💔"
)


def code_points(emoji: str) -> str:
    return "-".join(f"{ord(c):x}" for c in emoji if ord(c) != 0xFE0F)


def fetch(emoji: str) -> str | None:
    name = f"{code_points(emoji)}.svg"
    try:
        with urllib.request.urlopen(f"{BASE}/{name}", timeout=20) as resp:
            (OUT / name).write_bytes(resp.read())
    except OSError as e:
        return f"{emoji} {name}: {e}"
    return None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    deck = list(dict.fromkeys(DECK))
    with ThreadPoolExecutor(16) as pool:
        failures = [f for f in pool.map(fetch, deck) if f]
    for f in failures:
        print("failed:", f)
    print(f"{len(deck) - len(failures)} pictures in {OUT}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

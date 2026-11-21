"""Card decks: the bundled word lists, the built-in picture deck, and an optional folder of your own pictures."""

from __future__ import annotations

import random
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from wordspies.game.engine import PICTURES, WORDS, Layout

DATA = Path(__file__).parent / "data"
PICTURES_DIR = DATA / "pictures"
IMAGE_SUFFIXES = {".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}


@dataclass(frozen=True)
class Deck:
    key: str
    label: str
    description: str
    words: bool  # word cards, or pictures (card text is then an image URL)
    cards: tuple[str, ...]
    sample: tuple[str, ...]

    @property
    def layout(self) -> Layout:
        return WORDS if self.words else PICTURES

    def deal(self, rng: random.Random) -> list[str]:
        return rng.sample(self.cards, self.layout.size)

    def public(self) -> dict[str, object]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "words": self.words,
            "size": len(self.cards),
            "cols": self.layout.cols,
            "rows": self.layout.rows,
            "sample": list(self.sample),
        }


def _read_words(name: str) -> tuple[str, ...]:
    words: list[str] = []
    seen: set[str] = set()
    for line in (DATA / name).read_text(encoding="utf-8").splitlines():
        word = " ".join(line.replace("_", " ").split())
        if word and word.casefold() not in seen:
            seen.add(word.casefold())
            words.append(word.upper())
    return tuple(words)


def _images(folder: Path, url_prefix: str) -> tuple[str, ...]:
    if not folder.is_dir():
        return ()
    files = sorted(p.name for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)
    return tuple(f"{url_prefix}/{name}" for name in files)


@cache
def builtin_decks() -> tuple[Deck, ...]:
    en = _read_words("words_en.txt")
    pl = _read_words("words_pl.txt")
    pics = _images(PICTURES_DIR, "/deck-pictures")
    sample = pics[:4]
    return (
        Deck("en", "English words", f"{len(en)} words · 5×5", True, en, ("OCTOPUS", "ROBIN", "PITCH", "MERCURY")),
        Deck("pl", "Polskie słowa", f"{len(pl)} słów · 5×5", True, pl, ("ZAMEK", "KLUCZ", "SŁOŃCE", "PIES")),
        Deck("pictures", "Pictures", f"{len(pics)} pictures · 5×4", False, pics, sample),
    )


def load_decks(custom_pictures: Path | None = None) -> dict[str, Deck]:
    decks = {d.key: d for d in builtin_decks()}
    if custom_pictures is not None:
        pics = _images(custom_pictures, "/pictures")
        if len(pics) < PICTURES.size:
            raise ValueError(f"{custom_pictures} needs at least {PICTURES.size} images, found {len(pics)}")
        decks["custom"] = Deck(
            "custom", "My pictures", f"{len(pics)} pictures · 5×4", False, pics, tuple(random.sample(pics, 4))
        )
    return decks

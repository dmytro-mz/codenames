from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

app = typer.Typer(add_completion=False, help="Codenames — a team word-association spy game for the browser")
console = Console()


def _lan_ip() -> str | None:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))  # no packet is sent; picks the outbound interface
            ip = s.getsockname()[0]
        except OSError:
            return None
    return None if ip.startswith("127.") else ip


def _start_tunnel(port: int) -> tuple[subprocess.Popen[str], str]:
    import re
    import shutil

    exe = shutil.which("cloudflared")
    if exe is None:
        raise typer.BadParameter("--tunnel needs cloudflared: `brew install cloudflared`")
    proc = subprocess.Popen(
        [exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stderr is not None
    pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    deadline = time.time() + 30
    for line in proc.stderr:
        if match := pattern.search(line):
            return proc, match.group(0)
        if time.time() > deadline:
            break
    proc.terminate()
    raise typer.BadParameter("cloudflared did not report a public URL")


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Interface to bind; 0.0.0.0 lets your LAN join")] = "0.0.0.0",
    port: int = 8000,
    public_url: Annotated[str | None, typer.Option(help="Base URL used in invite links")] = None,
    tunnel: Annotated[bool, typer.Option(help="Open a public cloudflared tunnel and invite through it")] = False,
    test: Annotated[
        bool,
        typer.Option("--test", help="Solo testing: fake players you can switch between to take every seat yourself"),
    ] = False,
    pictures: Annotated[
        Path | None,
        typer.Option(help="Folder of your own images (at least 20), offered as an extra picture deck in the lobby"),
    ] = None,
) -> None:
    """Host the multiplayer web game. Share the table link; friends join from their browser."""
    import uvicorn

    from codenames.game.decks import load_decks
    from codenames.web.server import create_app

    if pictures is not None:
        pictures = pictures.expanduser().resolve()
        try:
            load_decks(pictures)
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
    ip = _lan_ip() if host == "0.0.0.0" else None
    lan_url = f"http://{ip}:{port}" if ip else None
    proc = None
    if tunnel:
        proc, public_url = _start_tunnel(port)
    console.print("[bold red]Word[/] [bold blue]Spies[/] [bold]server[/]")
    console.print(f"  local:   http://localhost:{port}")
    if lan_url:
        console.print(f"  network: {lan_url}   (same Wi-Fi / LAN)")
    if public_url:
        console.print(f"  public:  {public_url}")
    elif not lan_url:
        console.print("[dim]  bind --host 0.0.0.0 or use --tunnel to invite people from other machines")
    if test:
        console.print("  [yellow]test mode[/]: fake players join your table; switch seats in the bar at the bottom")
    if pictures is not None:
        console.print(f"  pictures: {pictures}")
    console.print("[dim]  table activity is logged below (Ctrl+C to stop)\n")
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s  %(message)s", datefmt="%H:%M:%S"))
    web_log = logging.getLogger("codenames.web")
    web_log.addHandler(handler)
    web_log.setLevel(logging.INFO)
    web_log.propagate = False
    try:
        uvicorn.run(
            create_app(public_url=public_url, lan_url=lan_url, pictures=pictures, test=test),
            host=host,
            port=port,
            log_level="warning",
        )
    finally:
        if proc is not None:
            proc.terminate()


@app.callback()
def _root() -> None:
    """Codenames — a team word-association spy game for the browser."""


def main() -> None:
    app()

// Hand-drawn SVG art: the emblems on revealed cards and the logo mark.

import { s } from "./dom.js";

// A spy in a fedora and dark glasses, collar up.
function agent() {
  return [
    s("path", { class: "e-coat", d: "M14 100 C16 80 30 70 50 70 C70 70 84 80 86 100 Z" }),
    s("path", { class: "e-collar", d: "M50 72 L38 70 L44 92 Z M50 72 L62 70 L56 92 Z" }),
    s("path", { class: "e-face", d: "M33 46 C33 64 40 72 50 72 C60 72 67 64 67 46 Z" }),
    s("rect", { class: "e-glasses", x: 32, y: 49, width: 15, height: 8, rx: 3.5 }),
    s("rect", { class: "e-glasses", x: 53, y: 49, width: 15, height: 8, rx: 3.5 }),
    s("rect", { class: "e-glasses", x: 46, y: 51, width: 8, height: 2.4 }),
    s("ellipse", { class: "e-hat", cx: 50, cy: 45, rx: 36, ry: 6.5 }),
    s("path", { class: "e-hat", d: "M29 45 C28 26 35 17 44 19 C47 20 49 23 50 23 C51 23 53 20 56 19 C65 17 72 26 71 45 Z" }),
    s("rect", { class: "e-band", x: 29.5, y: 36, width: 41, height: 6, rx: 1 }),
  ];
}

// An innocent passer-by with a newspaper.
function civilian() {
  return [
    s("circle", { class: "e-face", cx: 50, cy: 33, r: 14 }),
    s("path", { class: "e-coat", d: "M20 100 C20 70 32 56 50 56 C68 56 80 70 80 100 Z" }),
    s("rect", { class: "e-paper", x: 52, y: 66, width: 24, height: 30, rx: 2, transform: "rotate(-8 64 81)" }),
    s("path", { class: "e-lines", d: "M57 73 L71 71 M57 78 L72 76 M58 83 L72 81 M58 88 L68 87", transform: "rotate(-8 64 81)" }),
  ];
}

// Crosshairs over a skull.
function assassin() {
  return [
    s("path", { class: "e-skull", d: "M50 24 C34 24 26 35 26 48 C26 57 31 62 36 64 L36 74 L64 74 L64 64 C69 62 74 57 74 48 C74 35 66 24 50 24 Z" }),
    s("circle", { class: "e-eye", cx: 40, cy: 49, r: 7 }),
    s("circle", { class: "e-eye", cx: 60, cy: 49, r: 7 }),
    s("path", { class: "e-eye", d: "M50 55 L46 63 L54 63 Z" }),
    s("path", { class: "e-teeth", d: "M43 66 V74 M50 66 V74 M57 66 V74" }),
    s("circle", { class: "e-ring", cx: 50, cy: 50, r: 42 }),
    s("path", { class: "e-cross", d: "M50 2 V20 M50 80 V98 M2 50 H20 M80 50 H98" }),
  ];
}

const ART = { red: agent, blue: agent, civilian, assassin };

export function emblem(kind) {
  return s("svg", { class: `emblem em-${kind}`, viewBox: "0 0 100 100", "aria-hidden": "true" }, ART[kind]());
}

export function logoMark() {
  return s(
    "svg",
    { class: "logo-mark", viewBox: "0 0 100 100", "aria-hidden": "true" },
    s("rect", { x: 6, y: 18, width: 54, height: 66, rx: 8, class: "lm-red", transform: "rotate(-12 33 51)" }),
    s("rect", { x: 40, y: 16, width: 54, height: 66, rx: 8, class: "lm-blue", transform: "rotate(10 67 49)" }),
    s("g", { transform: "translate(26 22) scale(0.5)" }, agent()),
  );
}

// A tiny hat-and-glasses glyph that marks spymasters (inherits the text colour).
export function spyGlyph() {
  return s(
    "svg",
    { class: "spy-glyph", viewBox: "0 0 100 70", "aria-hidden": "true" },
    s("ellipse", { cx: 50, cy: 30, rx: 46, ry: 8 }),
    s("path", { d: "M24 30 C23 10 31 2 42 4 C46 5 48 8 50 8 C52 8 54 5 58 4 C69 2 77 10 76 30 Z" }),
    s("rect", { x: 22, y: 44, width: 24, height: 13, rx: 5 }),
    s("rect", { x: 54, y: 44, width: 24, height: 13, rx: 5 }),
    s("rect", { x: 44, y: 47, width: 12, height: 3.5 }),
  );
}

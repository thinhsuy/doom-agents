# Third-party assets — Pixel Agents

The pixel-art sprites in this folder (`characters/`, `furniture/`, `floors/`,
`walls/`, `carpets/`) are reused from **Pixel Agents** by Pablo De Lucca:

- Source: https://github.com/pixel-agents-hq/pixel-agents
- License: **MIT** (see `LICENSE-pixel-agents.txt` in this folder)
- Copyright (c) 2026 Pablo De Lucca

We use them under the MIT License, which permits reuse provided the copyright
notice and license text are retained — hence `LICENSE-pixel-agents.txt` sits
alongside the assets. Our Office renderer (`company/ui/src/office/`) is our own
code; only these image assets are vendored.

Characters use their original colours. Each department is mapped to one of the 6
base character types (see `DIVISION_CHAR` in `src/office/engine.ts`), so everyone
in a room looks like the same kind of staff.

## Sprite-sheet layout (for the renderer)

`characters/char_N.png` — 112×96, a grid of **16×32** frames:
- rows = direction: `0=DOWN, 1=UP, 2=RIGHT` (LEFT = RIGHT flipped horizontally)
- 7 columns = frames per direction:
  - walk: `[f0, f1, f2, f1]`
  - typing: `[f3, f4]`
  - reading: `[f5, f6]`

`furniture/DESK/DESK_FRONT.png` — 48×32. `furniture/PC/*` — desk monitor
(ON while an agent is working, OFF when idle).

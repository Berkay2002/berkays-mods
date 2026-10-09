// Terminal crabs: the costume's own pixel data (COSTUMES in register.tsx), drawn into a grid,
// shrunk, and printed as half-blocks (top pixel = foreground, bottom pixel = background).

export type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

/** A pixel: a `#rrggbb` color, or null for transparent. */
export type Px = string | null
export type Grid = Px[][]

/** One run of cells that share colors: what a `<Text color backgroundColor>` draws. */
export type Run = { text: string; fg?: string; bg?: string }

export const GRID_W = 30
export const GRID_H = 28
/** The terminal sprite: 10 columns by 3 lines of two pixels each, as tall as a row's three lines of text. */
export const SPRITE_W = 10
export const SPRITE_H = 6

// '#rgb', '#rrggbb' or 'rgba(r,g,b,a)'. A mostly see-through color (the astronaut's glass) is transparent.
const solid = (c: string): Px => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)?.[1]
  if (hex) return '#' + (hex.length === 3 ? [...hex].map(h => h + h).join('') : hex).toLowerCase()
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(c)
  if (!m || Number(m[4] ?? 1) < 0.5) return null
  return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
}

/** Runs a costume against a grid instead of the SVG; later fills paint over earlier ones. */
export const rasterize = (draw: (f: Fill) => void): Grid => {
  const grid: Grid = Array.from({ length: GRID_H }, () => Array<Px>(GRID_W).fill(null))
  draw((x, y, w, h, c) => {
    const color = solid(c)
    if (color === null) return
    for (let j = Math.max(0, y); j < Math.min(GRID_H, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(GRID_W, x + w); i++) grid[j]![i] = color
  })
  return grid
}

/** The smallest rectangle holding every drawn pixel of every grid: crabs of all tiers crop alike, so they stay one size. */
export const boundsOf = (grids: Grid[]): { x0: number; y0: number; x1: number; y1: number } => {
  const b = { x0: GRID_W, y0: GRID_H, x1: 0, y1: 0 }
  for (const g of grids)
    g.forEach((row, y) =>
      row.forEach((c, x) => {
        if (c === null) return
        b.x0 = Math.min(b.x0, x)
        b.y0 = Math.min(b.y0, y)
        b.x1 = Math.max(b.x1, x + 1)
        b.y1 = Math.max(b.y1, y + 1)
      }),
    )
  return b
}

const BODY = '#d97757'
const EYE = '#1f1e1d'

/**
 * Shrinks the cropped grid to `cols` by `rows` (the sprite's size by default). A block is drawn when at least a third of it is;
 * its color is the commonest one, except that anything but the body counts 1.5 times, the eyes' ink 4 times, so that they,
 * hat bands and props survive the shrink.
 */
export const downsample = (grid: Grid, box: ReturnType<typeof boundsOf>, cols = SPRITE_W, rows = SPRITE_H): Grid => {
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  return Array.from({ length: rows }, (_, j) =>
    Array.from({ length: cols }, (_, i): Px => {
      const xs = box.x0 + Math.floor((i * w) / cols)
      const xe = Math.max(xs + 1, box.x0 + Math.floor(((i + 1) * w) / cols))
      const ys = box.y0 + Math.floor((j * h) / rows)
      const ye = Math.max(ys + 1, box.y0 + Math.floor(((j + 1) * h) / rows))
      const votes = new Map<string, number>()
      let drawn = 0
      for (let y = ys; y < ye; y++)
        for (let x = xs; x < xe; x++) {
          const c = grid[y]?.[x]
          if (!c) continue
          drawn++
          votes.set(c, (votes.get(c) ?? 0) + (c === BODY ? 1 : c === EYE ? 4 : 1.5))
        }
      if (drawn * 3 < (xe - xs) * (ye - ys)) return null
      return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    }),
  )
}

/** One terminal line per two pixel rows: `▀` top only, `▄` bottom only, `█` both alike, or top over bottom. */
export const toRuns = (grid: Grid): Run[][] =>
  Array.from({ length: Math.ceil(grid.length / 2) }, (_, line) => {
    const runs: Run[] = []
    for (let i = 0; i < (grid[0]?.length ?? 0); i++) {
      const top = grid[line * 2]?.[i] ?? null
      const bottom = grid[line * 2 + 1]?.[i] ?? null
      const cell: Run =
        top === null && bottom === null
          ? { text: ' ' }
          : bottom === null
            ? { text: '▀', fg: top! }
            : top === null
              ? { text: '▄', fg: bottom }
              : top === bottom
                ? { text: '█', fg: top }
                : { text: '▀', fg: top, bg: bottom }
      const last = runs[runs.length - 1]
      if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text
      else runs.push(cell)
    }
    return runs
  })

/** The grid as plain text, for tests and a quick look: color-blind, one glyph per cell. */
export const toText = (grid: Grid): string =>
  toRuns(grid)
    .map(line => line.map(r => r.text).join(''))
    .join('\n')

// Terminal crabs: Claude Code's own mascot, Clawd, in quadrant blocks as the CLI draws it (2.1.295),
// with the tier's prop in the tier's color just right of it. The desktop SVG crabs (COSTUMES in register.tsx) are separate.

export type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

/** One run of cells in one color: what a `<Text color>` draws. */
export type Run = { text: string; fg: string }

/** Clawd's 9 columns and the prop's 2, by 3 lines: as tall as a row's three lines of text. */
export const SPRITE_W = 11
export const SPRITE_H = 3

const BODY = '#D97757'
// Clawd's default pose (eyes open, arms down); frame 1 swings the feet half a cell, so it walks.
const CLAWD = [' ▐▛███▛█ ', '▝▜██████▀']
const FEET = [' ▝▝   ▝▝ ', ' ▘▘   ▘▘ ']

// What each tier holds, per frame: three lines of two columns. Line 1 is the arm's, so a prop there sits in Clawd's hand.
const PROPS: Record<string, [string[], string[]]> = {
  // Binoculars up to the eyes, then down.
  scout: [['◉◉', '  ', '  '], ['  ', '◉◉', '  ']],
  // A hammer raised, then struck.
  builder: [['▜▀', '▝ ', '  '], [' ▄', '▀█', '  ']],
  // A check mark that blinks.
  reviewer: [['✓ ', '  ', '  '], ['  ', '  ', '  ']],
  // A baton up, then down.
  orchestrator: [['╱ ', '  ', '  '], ['  ', '╲ ', '  ']],
}
const EMPTY = ['  ', '  ', '  ']

/** Clawd holding `tier`'s prop, in `color`; frame 1 is the second pose of a running crab. */
export const clawd = (tier: string, color: string, frame = 0): Run[][] => {
  const prop = PROPS[tier]?.[frame ? 1 : 0] ?? EMPTY
  return [...CLAWD, FEET[frame ? 1 : 0]!].map((body, y) => [
    { text: body, fg: BODY },
    { text: prop[y]!, fg: color },
  ])
}

/** The sprite as plain text, for tests and a quick look. */
export const toText = (lines: Run[][]): string => lines.map(l => l.map(r => r.text).join('')).join('\n')

// Types for what hooks/mod.ts (Claude Code's mod) imports; rows.mjs is the source.
export type Seg = [text: string, style?: string, bg?: string]
export type Line = { segs: Seg[]; right?: Seg[] | null; indent?: number; hang?: number; wrap?: boolean }
export type Block = { key: string; source: unknown; flags: string; lines: () => Line[]; focus?: string }
export type Pending = { at: number; label: string; style: string; text?: string; hint: string }
export function clean(text: unknown): string
export function one(text: unknown): string
export function width(text: string): number
export function cut(text: string, w: number): string
export function segsWidth(segs: readonly Seg[]): number
export function fitSegs(segs: readonly Seg[], w: number, padStyle?: string): Seg[]
export function layoutLine(line: Line, w: number): Seg[][]
export function clock(ms: number): string
export function cardHead(job: { status: string; startedAt: number; finishedAt?: number | null }, title: string, now: number, w: number, bg?: string): Seg[]
export function outcomeLabel(job: { execution: any; result: any }): [text: string, style: string]
export function liveLines(job: { execution: any }, options: { now: number; lastText?: string | null; activeAt?: number | null }): Line[]
export function pendingInputs(execution: any, taken: ReadonlySet<string>): Pending[]
export function pendingLine(pending: Pending): Line
export function jobBlocks(job: { status: string; execution: any; result?: any }, view: {
  list: readonly any[]; preamble?: readonly any[]; labels?: ReadonlyMap<string, string>; located: boolean
  format?: { version?: unknown; detail?: string } | null; now: number; expanded?: (id: string) => boolean
  showPreamble?: boolean; pending?: readonly Line[]
}): Block[]
export class Pane {
  layout(blocks: Block[], w: number): number
  readonly total: number
  slice(top: number, height: number): { block: number; row: Seg[]; first: boolean }[]
}
export const COMPANION_NAMES: Record<string, string>
export const MODE_HINTS: Record<string, string>
export function supportedModes(execution: any): string[]

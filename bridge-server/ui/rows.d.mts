// Types for what hooks/mod.ts (Claude Code's mod) imports; rows.mjs is the source.
export type Seg = [text: string, style?: string, bg?: string]
export type Line = { segs: Seg[]; right?: Seg[] | null; indent?: number; hang?: number; wrap?: boolean }
export function clean(text: unknown): string
export function width(text: string): number
export function cut(text: string, w: number): string
export function segsWidth(segs: readonly Seg[]): number
export function fitSegs(segs: readonly Seg[], w: number, padStyle?: string): Seg[]
export function clock(ms: number): string
export function outcomeLabel(job: { execution: any; result: any }): [text: string, style: string]
export function liveLines(job: { execution: any }, options: { now: number; lastText?: string | null; activeAt?: number | null }): Line[]

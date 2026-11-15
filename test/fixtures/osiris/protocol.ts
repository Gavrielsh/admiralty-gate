// Minimal type stubs copied in shape from simplifaisoul/osiris (MIT) src/lib/oi/assist/protocol.ts,
// so the vendored agent loop type-checks without pulling in the Next.js app.
export type ToolName = 'go_to' | 'layers' | 'find' | 'scan' | 'camera' | 'highlight' | 'show' | 'markets' | 'open' | 'map_view' | 'recon' | 'forecast' | 'workspace' | 'select' | 'terrain' | 'clear';
export type Mode = 'auto' | 'navigate' | 'research' | 'forecast';
export interface Call { tool: ToolName; args: Record<string, unknown> }
export interface CallResult { tool: ToolName; ok: boolean; summary: string; data?: unknown }
export type AssistMessage =
  | { role: 'user'; text: string; mode: Mode }
  | { role: 'assistant'; say: string; calls: Call[] }
  | { role: 'tool'; results: CallResult[] };
export interface Step { say: string; calls: Call[]; done: boolean }
export interface AssistContext { now: string; [k: string]: unknown }

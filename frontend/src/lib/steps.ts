/**
 * Agent step display order. These labels are driven by real `agent_status`
 * events emitted by the backend loop, never by a client-side timer.
 */
export const AGENT_STEPS = [
  { key: 'analyzing', label: 'ANALYZING' },
  { key: 'planning', label: 'PLANNING' },
  { key: 'reading', label: 'READING FILES' },
  { key: 'editing', label: 'EDITING' },
  { key: 'running', label: 'RUNNING COMMAND' },
  { key: 'testing', label: 'TESTING' },
  { key: 'building', label: 'BUILDING' },
  { key: 'inspecting', label: 'INSPECTING APK' },
  { key: 'fixing', label: 'FIXING' },
] as const;

export type AgentStepKey = (typeof AGENT_STEPS)[number]['key'];

export function stepIndex(phase: string | null | undefined): number {
  if (!phase) return -1;
  return AGENT_STEPS.findIndex((s) => s.key === phase);
}

export const TERMINAL_STATUS_PILL = {
  succeeded: 'ok',
  failed: 'err',
  timeout: 'err',
  rejected: 'err',
} as const;

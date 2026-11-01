/** Idle inspections of local and remote panes both scan the host process table. */
export function isAgentProcessInspectionCostly(ptyId: string | null): boolean {
  return ptyId !== null
}

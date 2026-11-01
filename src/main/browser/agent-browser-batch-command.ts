/** Every snapshot form answers with `snapshot`; annotated screenshots with `annotations`. */
export function agentBrowserResultMintsRefs(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false
  }
  return 'snapshot' in data || ('annotations' in data && Array.isArray(data.annotations))
}

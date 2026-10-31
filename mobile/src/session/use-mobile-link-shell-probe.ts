export type MobileLinkShellProbe = {
  granted: () => boolean
  read: () => Promise<{ heldOutputBytes: number }>
}

/** Only the page has a shell hop; a native screen has nothing between it and the transport. */
export function useMobileLinkShellProbe(): MobileLinkShellProbe | null {
  return null
}

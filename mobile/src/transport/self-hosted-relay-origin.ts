export function isAllowedSelfHostedRelayCell(directorUrl: string, cellUrl: string): boolean {
  return process.env.EXPO_PUBLIC_ORCA_SELF_HOSTED_BUILD !== '1' || cellUrl === directorUrl
}

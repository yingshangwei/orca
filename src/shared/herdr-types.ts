export type HerdrSyncResult = {
  total: number
  added: number
  connected: number
  reused: number
  issues: { paneId: string; message: string }[]
}

export type HerdrApi = {
  openTerminal: () => Promise<void>
  sync: () => Promise<HerdrSyncResult>
}

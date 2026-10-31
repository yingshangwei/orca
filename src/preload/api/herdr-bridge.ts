import { ipcRenderer } from 'electron'
import type { HerdrApi } from '../../shared/herdr-types'

export const herdrApi: HerdrApi = {
  openTerminal: () => ipcRenderer.invoke('herdr:openTerminal'),
  sync: () => ipcRenderer.invoke('herdr:sync')
}

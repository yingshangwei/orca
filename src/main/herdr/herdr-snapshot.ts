import { z } from 'zod'

const ProviderSession = z.object({ kind: z.string(), value: z.string() })
const Pane = z.object({
  pane_id: z.string().min(1),
  terminal_id: z.string().regex(/^term_[a-zA-Z0-9_-]+$/),
  workspace_id: z.string().min(1),
  tab_id: z.string().min(1),
  cwd: z
    .string()
    .nullish()
    .transform((cwd) => cwd ?? ''),
  foreground_cwd: z.string().nullish(),
  agent: z.string().nullish(),
  agent_status: z.string().optional(),
  agent_session: ProviderSession.nullish(),
  terminal_title_stripped: z.string().nullish()
})

export const HerdrSnapshotSchema = z
  .object({
    workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string() })),
    tabs: z.array(z.object({ tab_id: z.string(), label: z.string(), pane_count: z.number() })),
    panes: z.array(Pane)
  })
  .refine(
    (snapshot) =>
      new Set(snapshot.panes.map((pane) => pane.terminal_id)).size === snapshot.panes.length,
    'Herdr returned duplicate terminal identities'
  )

export type HerdrSnapshot = z.infer<typeof HerdrSnapshotSchema>
export type HerdrPane = HerdrSnapshot['panes'][number]

export function parseHerdrSnapshot(value: unknown): HerdrSnapshot {
  return z.object({ result: z.object({ snapshot: HerdrSnapshotSchema }) }).parse(value).result
    .snapshot
}

import React from 'react'
import Markdown from 'react-markdown'
import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import type { CommentMarkdownExtension } from './CommentMarkdown'
import {
  splitMarkdownTopLevelBlocks,
  type MarkdownBlock,
  type MarkdownBlockSplit
} from './markdown-top-level-blocks'

type RemarkPlugins = NonNullable<React.ComponentProps<typeof Markdown>['remarkPlugins']>

/** One render of the pipeline; memoized so an unchanged block is not parsed again. */
export const MemoizedMarkdown = React.memo(function DeferredMarkdown({
  block,
  ...props
}: React.ComponentProps<typeof Markdown> & {
  block?: MarkdownBlock
}) {
  const parsedPlugins = React.useMemo<RemarkPlugins>(() => {
    if (!block?.tree) {
      return props.remarkPlugins ?? []
    }
    const tree = block.tree
    const source = block.text
    // Transforms mutate mdast; each render owns a fresh copy of the pristine parse.
    function reuseParsedBlock(this: Processor): void {
      const parse = this.parser
      if (!parse) {
        return
      }
      this.parser = (value, file) => (value === source ? structuredClone(tree) : parse(value, file))
    }
    return [...(props.remarkPlugins ?? []), reuseParsedBlock]
  }, [block, props.remarkPlugins])
  return <Markdown {...props} remarkPlugins={parsedPlugins} />
})

/** The content as the blocks to render. Cut into blocks from the first time it is growing, and
 *  from then on, so the stream ending does not redraw what is already there. */
export function useMarkdownBlocks(
  content: string,
  growing: boolean,
  plugins: RemarkPlugins,
  extension?: CommentMarkdownExtension
): readonly MarkdownBlock[] {
  const parser = React.useMemo(() => unified().use(remarkParse).use(plugins), [plugins])
  const [state, setState] = React.useState<{
    parser: typeof parser
    split: MarkdownBlockSplit
  } | null>(null)
  if (state && state.parser !== parser) {
    const split = {
      ...state.split,
      blocks: state.split.blocks.map(
        ({ tree: _tree, closedFence: _closedFence, ...block }) => block
      )
    }
    setState({ parser, split })
    return split.blocks
  }
  const previous = state?.split ?? null
  if (!growing && state === null) {
    return [{ start: 0, line: 1, text: content }]
  }
  if (previous?.source === content) {
    return previous.blocks
  }
  const markers = extension?.extraFlowSyntaxMarkers
  const knownGrammar = !extension?.remarkPlugins.length || markers !== undefined
  const next = splitMarkdownTopLevelBlocks(
    content,
    previous,
    knownGrammar ? (source) => parser.parse(source) : undefined,
    (tail) => !content.includes('\uFEFF') && !markers?.some((marker) => tail.includes(marker))
  )
  setState({ parser, split: next })
  return next.blocks
}

import { blockMarkdown } from './html-block-markdown'
import { markdownToHtml } from './markdown-to-html'
import { post } from './host-bridge'
import { editorElement } from './editor-surface'
import type { RichMarkdownEditorScope } from './document-scope'

/** What the surface holds right now, as markdown: every block, blank ones dropped. */
export function currentMarkdown(scope: RichMarkdownEditorScope): string {
  return Array.from(editorElement(scope).childNodes)
    .map((node) => blockMarkdown(node))
    .filter((block) => block.trim().length > 0)
    .join('\n\n')
    .trimEnd()
}

// A task's own words: its checkbox label, nested lists and code blocks are not part of its name.
function ownTaskText(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) {
    return node.nodeValue ?? ''
  }
  if (!(node instanceof Element) || node.matches('label, ul, ol, pre')) {
    return ''
  }
  if (node.matches('br')) {
    return ' '
  }
  const text = Array.from(node.childNodes, ownTaskText).join('')
  return node.matches('p, div') ? ` ${text} ` : text
}

/** Keep task controls named from their own live text and unavailable in read-only documents. */
export function syncTaskCheckboxes(scope: RichMarkdownEditorScope) {
  editorElement(scope)
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((input) => {
      input.disabled = !scope.editable
      const item = input.closest('li')
      const label = (item ? ownTaskText(item).replace(/\s+/g, ' ').trim() : '') || 'Task'
      if (input.getAttribute('aria-label') !== label) {
        input.setAttribute('aria-label', label)
      }
    })
}

/**
 * Tells the host what the surface now holds, under the generation it was given.
 *
 * The generation goes back out untouched so the host can drop a change that crossed with content
 * it had already replaced. The document's own rewrites are not changes, which is what
 * `suppressInput` says.
 */
export function emitChange(scope: RichMarkdownEditorScope) {
  if (scope.suppressInput || !scope.editable) {
    return
  }
  scope.clearTimer(scope.inputTimer)
  syncTaskCheckboxes(scope)
  const pendingGeneration = scope.documentGeneration
  scope.lastMarkdown = currentMarkdown(scope)
  post(scope, { type: 'change', markdown: scope.lastMarkdown, generation: pendingGeneration })
}

export function setMarkdown(scope: RichMarkdownEditorScope, markdown: string, generation: number) {
  scope.clearTimer(scope.inputTimer)
  scope.documentGeneration = Number(generation) || 0
  scope.suppressInput = true
  // Why: replacing innerHTML detaches the remembered caret's nodes.
  scope.savedSelectionRange = null
  scope.selectionDroppedOnBlur = false
  scope.lastMarkdown = String(markdown || '')
  editorElement(scope).innerHTML = markdownToHtml(scope, scope.lastMarkdown)
  syncTaskCheckboxes(scope)
  scope.suppressInput = false
}

/**
 * Takes back the pending input timer, which is the one thing the document owns that outlives it.
 *
 * A listener comes off with the element it was on, but a scheduled callback holds the scope and
 * fires into a document nobody is looking at any more — posting a change to a host that has
 * unmounted the editor, under the generation of content it has replaced. Nothing schedules the
 * handle today; it is cancelled here because the day something does, this is where the cancel has
 * to already be.
 */
export function stopEditorContent(scope: RichMarkdownEditorScope) {
  scope.clearTimer(scope.inputTimer)
  scope.inputTimer = null
}

export function setEditable(scope: RichMarkdownEditorScope, editable: boolean) {
  scope.editable = Boolean(editable)
  editorElement(scope).setAttribute('contenteditable', scope.editable ? 'true' : 'false')
  syncTaskCheckboxes(scope)
}

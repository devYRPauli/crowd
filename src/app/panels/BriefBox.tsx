/**
 * Describing an event in words.
 *
 * Nothing here is applied until the user says so. The parser lists what it
 * understood and the phrase each reading came from, and says plainly what it
 * could not read — a tool that quietly guesses half a sentence is a tool you
 * cannot trust with a plan.
 */

import { useMemo, useState } from 'react'
import { useEditor } from '../../state/editorStore'
import { BRIEF_EXAMPLES, readBrief } from '../../core/analysis/brief'

export const BriefBox = () => {
  const document = useEditor((state) => state.document)
  const apply = useEditor((state) => state.apply)
  const toast = useEditor((state) => state.toast)
  const [text, setText] = useState('')
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())

  const result = useMemo(() => readBrief(text, document), [text, document])
  const keep = result.assumptions.filter((entry) => !dismissed.has(entry.id))

  const example = useMemo(
    // Rotate the placeholder by document so it is stable while typing.
    () => BRIEF_EXAMPLES[Math.abs(hash(document.id)) % BRIEF_EXAMPLES.length],
    [document.id],
  )

  return (
    <div className="section">
      <div className="section-title">Describe the event</div>
      <textarea
        className="input"
        style={{ height: 66, padding: 7, resize: 'vertical', lineHeight: 1.4 }}
        placeholder={example}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Describe the event in plain words"
      />

      {text.trim().length > 0 && keep.length === 0 && result.unread.length === 0 ? (
        <p className="hint">
          Nothing recognised yet. Try a headcount, an arrival window, how many staff, and how long
          each person takes — for example “{example}”.
        </p>
      ) : null}

      {keep.length > 0 ? (
        <>
          <div className="list" style={{ margin: '0 -12px' }}>
            {keep.map((assumption) => (
              <div className="list-row" key={assumption.id} style={{ cursor: 'default' }}>
                <span className="label">
                  {assumption.label}
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                    {' '}
                    — “{assumption.source}”
                  </span>
                </span>
                <button
                  className="btn is-ghost"
                  style={{ height: 20, padding: '0 6px', fontSize: 11 }}
                  onClick={() => setDismissed(new Set([...dismissed, assumption.id]))}
                  title="Ignore this reading"
                >
                  Skip
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn is-primary"
            onClick={() => {
              apply(
                (doc) => keep.reduce((next, assumption) => assumption.apply(next), doc),
                'Apply brief',
              )
              toast(
                `Applied ${keep.length} ${keep.length === 1 ? 'change' : 'changes'} from the brief.`,
                'success',
              )
              setText('')
              setDismissed(new Set())
            }}
          >
            Apply {keep.length} {keep.length === 1 ? 'change' : 'changes'}
          </button>
        </>
      ) : null}

      {result.unread.length > 0 ? (
        <p className="hint">
          Not understood: {result.unread.map((phrase) => `“${phrase}”`).join(', ')}. Set those in
          the fields below.
        </p>
      ) : null}
    </div>
  )
}

const hash = (value: string): number => {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0
  return h
}

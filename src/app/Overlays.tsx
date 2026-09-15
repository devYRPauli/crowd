/**
 * Modal overlays: the template picker, the shortcut sheet, and the welcome.
 */

import { TEMPLATES } from '../library/templates'
import { Modal } from './components/ui'
import { useEditor } from '../state/editorStore'
import { useSimulation } from '../state/simulationStore'
import { planBounds } from '../core/model/planGeometry'
import type { ViewportHandle } from './ViewportHost'

export const TemplatePicker = ({
  onClose,
  viewportRef,
}: {
  onClose: () => void
  viewportRef: React.MutableRefObject<ViewportHandle>
}) => {
  const replaceDocument = useEditor((state) => state.replaceDocument)
  const toast = useEditor((state) => state.toast)
  const stop = useSimulation((state) => state.stop)

  return (
    <Modal title="Start from a venue" onClose={onClose}>
      <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
        Each of these is a complete plan with a scenario attached — walls, furniture, entrances,
        counters and a crowd — so you can press Run immediately and change things from there.
      </p>
      <div className="template-grid">
        {TEMPLATES.map((template) => (
          <button
            key={template.id}
            className="template-card"
            onClick={() => {
              const doc = template.build()
              stop()
              replaceDocument(doc, `Open ${template.name}`)
              viewportRef.current.viewport?.frame(planBounds(doc.plan, 3))
              toast(`Opened ${template.name}. Press Run to see it work.`, 'success')
              onClose()
            }}
          >
            <span className="name">{template.name}</span>
            <span className="summary">{template.summary}</span>
            <span className="teaches">{template.teaches}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

const SHORTCUTS: Array<{ group: string; items: Array<[string, string[]]> }> = [
  {
    group: 'Tools',
    items: [
      ['Select and move', ['V']],
      ['Draw walls', ['W']],
      ['Draw a room', ['R']],
      ['Add a doorway', ['D']],
      ['Add a window', ['N']],
      ['Place furniture', ['F']],
      ['Draw an area', ['Z']],
      ['Place a service point', ['S']],
      ['Reshape a queue', ['Q']],
      ['Tape measure', ['M']],
    ],
  },
  {
    group: 'Navigate',
    items: [
      ['Orbit', ['right-drag']],
      ['Pan', ['middle-drag']],
      ['Pan', ['Space', 'drag']],
      ['Zoom to the cursor', ['wheel']],
      ['Fit the plan in view', ['.']],
      ['Plan / 3D view', ['Tab']],
      ['Density heat map', ['H']],
    ],
  },
  {
    group: 'Edit',
    items: [
      ['Undo', ['⌘', 'Z']],
      ['Redo', ['⌘', '⇧', 'Z']],
      ['Select everything', ['⌘', 'A']],
      ['Duplicate', ['⌘', 'D']],
      ['Delete', ['Delete']],
      ['Nudge', ['arrows']],
      ['Nudge further', ['⇧', 'arrows']],
      ['Rotate by 15°', ['[', ']']],
      ['Rotate by 1°', ['⇧', '[', ']']],
      ['Duplicate while dragging', ['Alt', 'drag']],
      ['Constrain to an axis', ['⇧', 'drag']],
      ['Cancel the current action', ['Esc']],
    ],
  },
  {
    group: 'Run',
    items: [
      ['Run, pause or resume', ['Space']],
      ['Stop and clear', ['⇧', 'Space']],
      ['Save the project', ['⌘', 'S']],
      ['This list', ['?']],
    ],
  },
]

export const ShortcutSheet = ({ onClose }: { onClose: () => void }) => (
  <Modal title="Keyboard shortcuts" onClose={onClose}>
    <div className="shortcut-grid">
      {SHORTCUTS.map((group) => (
        <div className="shortcut-group" key={group.group}>
          <h3>{group.group}</h3>
          {group.items.map(([label, keys]) => (
            <div className="shortcut-row" key={label}>
              <span>{label}</span>
              <span>
                {keys.map((key) => (
                  <span className="kbd" key={key}>
                    {key}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  </Modal>
)

export const Welcome = ({
  onClose,
  onTemplates,
}: {
  onClose: () => void
  onTemplates: () => void
}) => (
  <Modal
    title="CROWD"
    onClose={onClose}
    footer={
      <>
        <button className="btn" onClick={onClose}>
          Start with an empty plan
        </button>
        <button
          className="btn is-primary"
          onClick={() => {
            onClose()
            onTemplates()
          }}
        >
          Open a venue
        </button>
      </>
    }
  >
    <p style={{ marginTop: 0, fontSize: 14, lineHeight: 1.6 }}>
      <b>Constraint-aware Rehearsal and Optimisation of Walking Dynamics.</b> Draw a venue, describe
      who turns up, and watch them move through it — then read what went wrong and change the room.
    </p>
    <div className="shortcut-grid" style={{ marginTop: 18 }}>
      <div className="shortcut-group">
        <h3>Draw the space</h3>
        <p className="hint">
          Walls snap to each other and to the grid, and you can type an exact length while drawing.
          Doors cut into the wall they land on. Furniture turns to face the room when you place it
          against a wall.
        </p>
      </div>
      <div className="shortcut-group">
        <h3>Say who comes</h3>
        <p className="hint">
          Populations arrive on a profile — evenly, in waves, or around a peak — and follow an
          itinerary: queue here, sit there, leave by that door. Counters can be grouped so people
          join whichever line is quickest.
        </p>
      </div>
      <div className="shortcut-group">
        <h3>Read what happened</h3>
        <p className="hint">
          Density is classified against Fruin&rsquo;s level-of-service bands, queues report their
          own waits, and the findings list says what to change. Save a run and compare the next one
          against it: same seed, same people, so the difference is the layout.
        </p>
      </div>
    </div>
  </Modal>
)

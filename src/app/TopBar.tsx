/**
 * Document actions and view controls.
 */

import { useRef } from 'react'
import { useEditor, type PanelId } from '../state/editorStore'
import { useSimulation } from '../state/simulationStore'
import { renameDocument } from '../core/document/mutations'
import { documentFileName, parseDocumentJson, serializeDocument } from '../core/document/serialize'
import { downloadText, readFileAsText, saveProject } from '../core/document/storage'
import { planBounds } from '../core/model/planGeometry'
import {
  CameraIcon,
  ChartIcon,
  FolderIcon,
  GridIcon,
  HeatIcon,
  HelpIcon,
  LayersIcon,
  PeopleIcon,
  RedoIcon,
  SaveIcon,
  SettingsIcon,
  UndoIcon,
} from './components/icons'
import type { ViewPreset } from '../render/CameraRig'
import type { ViewportHandle } from './ViewportHost'

const PANELS: Array<{ id: PanelId; label: string; Icon: typeof LayersIcon }> = [
  { id: 'library', label: 'Library', Icon: GridIcon },
  { id: 'scenario', label: 'Scenario', Icon: PeopleIcon },
  { id: 'results', label: 'Results', Icon: ChartIcon },
  { id: 'layers', label: 'View and layers', Icon: LayersIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
]

export const TopBar = ({
  viewportRef,
  showHeatmap,
  onToggleHeatmap,
  onOpenTemplates,
  onOpenProjects,
  onOpenShortcuts,
}: {
  viewportRef: React.MutableRefObject<ViewportHandle>
  showHeatmap: boolean
  onToggleHeatmap: () => void
  onOpenTemplates: () => void
  onOpenProjects: () => void
  onOpenShortcuts: () => void
}) => {
  const document = useEditor((state) => state.document)
  const apply = useEditor((state) => state.apply)
  const undo = useEditor((state) => state.undo)
  const redo = useEditor((state) => state.redo)
  const canUndo = useEditor((state) => state.canUndo())
  const canRedo = useEditor((state) => state.canRedo())
  const undoLabel = useEditor((state) => state.undoLabel())
  const redoLabel = useEditor((state) => state.redoLabel())
  const panel = useEditor((state) => state.panel)
  const setPanel = useEditor((state) => state.setPanel)
  const view = useEditor((state) => state.view)
  const setView = useEditor((state) => state.setView)
  const sealHistory = useEditor((state) => state.sealHistory)
  const replaceDocument = useEditor((state) => state.replaceDocument)
  const toast = useEditor((state) => state.toast)
  const markSaved = useEditor((state) => state.markSaved)
  const dirty = useEditor((state) => state.dirty)
  const stop = useSimulation((state) => state.stop)

  const fileInput = useRef<HTMLInputElement>(null)

  const onOpenFile = async (file: File) => {
    try {
      const result = parseDocumentJson(await readFileAsText(file))
      stop()
      replaceDocument(result.document, 'Open project')
      viewportRef.current.viewport?.frame(planBounds(result.document.plan, 3))
      for (const warning of result.warnings) toast(warning, 'warn')
      toast(`Opened ${result.document.name}.`, 'success')
    } catch {
      toast('That file could not be opened.', 'error')
    }
  }

  return (
    <header className="topbar">
      <div className="wordmark">
        <span className="mark">CROWD</span>
      </div>

      <input
        className="doc-name"
        value={document.name}
        aria-label="Project name"
        onChange={(event) =>
          apply(
            (doc) => renameDocument(doc, event.target.value),
            'Rename project',
            // Typing is one gesture. Without a key every character is its own
            // undo step, so undoing a renamed venue spells the name backwards
            // a letter at a time and the edit before it is thirty presses away.
            `rename:${document.id}`,
          )
        }
        onBlur={sealHistory}
      />
      {dirty ? <span className="badge">Unsaved</span> : null}

      <span style={{ width: 8 }} />

      <button
        className="btn is-ghost is-icon"
        onClick={undo}
        disabled={!canUndo}
        title={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
      >
        <UndoIcon width={16} height={16} />
      </button>
      <button
        className="btn is-ghost is-icon"
        onClick={redo}
        disabled={!canRedo}
        title={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
      >
        <RedoIcon width={16} height={16} />
      </button>

      <span className="rail-separator" style={{ width: 1, height: 20, margin: '0 4px' }} />

      <button className="btn is-ghost" onClick={onOpenTemplates} title="Start from a template">
        <FolderIcon width={15} height={15} /> Templates
      </button>
      <button className="btn is-ghost" onClick={onOpenProjects} title="Saved projects">
        Projects
      </button>
      <button
        className="btn is-ghost is-icon"
        title="Open a .crowd.json file"
        onClick={() => fileInput.current?.click()}
      >
        <FolderIcon width={15} height={15} />
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onOpenFile(file)
          event.target.value = ''
        }}
      />
      <button
        className="btn is-ghost is-icon"
        title="Download this project"
        onClick={() => {
          downloadText(documentFileName(document), serializeDocument(document))
          void saveProject(document)
            .then(markSaved)
            .catch(() => undefined)
          toast('Project downloaded.', 'success')
        }}
      >
        <SaveIcon width={15} height={15} />
      </button>

      <div className="spacer" />

      <div className="segmented" role="group" aria-label="Camera">
        {(
          [
            ['plan', 'Plan'],
            ['iso', '3D'],
            ['front', 'Front'],
            ['eye', 'Eye'],
          ] as Array<[ViewPreset, string]>
        ).map(([preset, label]) => (
          <button
            key={preset}
            className={view.preset === preset ? 'is-active' : ''}
            onClick={() => setView({ preset })}
            title={`${label} view`}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        className={`btn is-ghost is-icon${showHeatmap ? ' is-active' : ''}`}
        onClick={onToggleHeatmap}
        title="Density heat map (H)"
      >
        <HeatIcon width={16} height={16} />
      </button>
      <button
        className="btn is-ghost is-icon"
        title="Fit the plan in view (.)"
        onClick={() => viewportRef.current.viewport?.frame(planBounds(document.plan, 3))}
      >
        <CameraIcon width={16} height={16} />
      </button>

      <span className="rail-separator" style={{ width: 1, height: 20, margin: '0 4px' }} />

      <div className="segmented" role="group" aria-label="Panels">
        {PANELS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={panel === id ? 'is-active' : ''}
            onClick={() => setPanel(id)}
            title={label}
            aria-label={label}
          >
            <Icon width={15} height={15} />
          </button>
        ))}
      </div>

      <button
        className="btn is-ghost is-icon"
        onClick={onOpenShortcuts}
        title="Keyboard shortcuts (?)"
      >
        <HelpIcon width={16} height={16} />
      </button>
    </header>
  )
}

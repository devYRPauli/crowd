/**
 * The application.
 *
 * Holds the pieces that do not belong to any one panel: which overlay is open,
 * what the crowd is coloured by, whether the heat map is on, and the handle to
 * the imperative viewport. Everything else lives in the two stores.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ViewportHost, type ViewportHandle } from './ViewportHost'
import { ToolRail } from './ToolRail'
import { TopBar } from './TopBar'
import { PlaybackBar } from './PlaybackBar'
import { Toasts } from './Toasts'
import { ShortcutSheet, TemplatePicker, Welcome } from './Overlays'
import { LibraryPanel } from './panels/LibraryPanel'
import { ScenarioPanel } from './panels/ScenarioPanel'
import { ResultsPanel } from './panels/ResultsPanel'
import { LayersPanel } from './panels/LayersPanel'
import { SettingsPanel } from './panels/SettingsPanel'
import { InspectorPanel } from './panels/InspectorPanel'
import { ProjectsModal } from './panels/ProjectsModal'
import { useKeyboard } from './useKeyboard'
import { useEditor } from '../state/editorStore'
import { useSimulation } from '../state/simulationStore'
import { getTemplate, DEFAULT_TEMPLATE_ID } from '../library/templates'
import { planBounds } from '../core/model/planGeometry'
import {
  loadProject,
  rememberLastProject,
  recallLastProject,
  saveProject,
} from '../core/document/storage'
import { Segmented } from './components/ui'
import type { CrowdColorMode } from '../render/crowd/CrowdRenderer'
import type { FacilityType } from '../sim/metrics/los'
import { AGENT_FIELD, AGENT_STRIDE, AGENT_STATE_ORDER } from '../sim/types'
import { formatDuration, formatNumber } from '../core/model/units'
import { losFor } from '../sim/metrics/los'

const STATE_LABELS: Record<string, string> = {
  walking: 'Walking',
  queuing: 'Queueing',
  waiting: 'Waiting',
  served: 'Being served',
  seated: 'Seated',
  dwelling: 'Spending time here',
  done: 'Left',
}

/** Details of the person the user clicked on. */
const PersonCard = ({ index, onClear }: { index: number; onClear: () => void }) => {
  const frame = useSimulation((state) => state.frame)
  const profiles = useEditor((state) => state.document.scenario.profiles)
  const populations = useEditor((state) => state.document.scenario.populations)

  if (!frame || index >= frame.count) {
    return (
      <div className="empty">
        That person has left the venue.
        <button className="btn" style={{ marginTop: 12 }} onClick={onClear}>
          Back to the inspector
        </button>
      </div>
    )
  }

  const base = index * AGENT_STRIDE
  const state = AGENT_STATE_ORDER[frame.agents[base + AGENT_FIELD.state] | 0] ?? 'walking'
  const profile = profiles[frame.agents[base + AGENT_FIELD.profile] | 0]
  const population = populations[frame.agents[base + AGENT_FIELD.population] | 0]
  const speed = frame.agents[base + AGENT_FIELD.speed]
  const waited = frame.agents[base + AGENT_FIELD.waited]

  return (
    <>
      <div className="stat-grid">
        <div className="stat">
          <div className="value">{formatNumber(speed, 2)}</div>
          <div className="label">m/s right now</div>
        </div>
        <div className="stat">
          <div className="value">{formatDuration(waited)}</div>
          <div className="label">Queued so far</div>
        </div>
      </div>
      <table className="table">
        <tbody>
          <tr>
            <td>Doing</td>
            <td className="num">{STATE_LABELS[state] ?? state}</td>
          </tr>
          <tr>
            <td>Group</td>
            <td className="num">{population?.name ?? '—'}</td>
          </tr>
          <tr>
            <td>Kind of person</td>
            <td className="num">{profile?.name ?? '—'}</td>
          </tr>
          <tr>
            <td>Free-flow speed</td>
            <td className="num">{profile ? `${profile.speed.mean.toFixed(2)} m/s` : '—'}</td>
          </tr>
        </tbody>
      </table>
      <button className="btn" onClick={onClear}>
        Back to the inspector
      </button>
    </>
  )
}

export const App = () => {
  const viewportRef = useRef<ViewportHandle>({ viewport: null, controller: null })
  const [showTemplates, setShowTemplates] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [showSafety, setShowSafety] = useState(true)
  const [heatmapFacility, setHeatmapFacility] = useState<FacilityType>('walkway')
  const [colorMode, setColorMode] = useState<CrowdColorMode>('state')
  const [inspectedPerson, setInspectedPerson] = useState<number | null>(null)

  const panel = useEditor((state) => state.panel)
  const theme = useEditor((state) => state.view.theme)
  const hint = useEditor((state) => state.hint)
  const document = useEditor((state) => state.document)
  const replaceDocument = useEditor((state) => state.replaceDocument)
  const dirty = useEditor((state) => state.dirty)
  const markSaved = useEditor((state) => state.markSaved)
  const phase = useSimulation((state) => state.phase)
  const error = useSimulation((state) => state.error)
  const clearError = useSimulation((state) => state.clearError)
  const warnings = useSimulation((state) => state.warnings)

  const toggleHeatmap = useCallback(() => setShowHeatmap((value) => !value), [])

  const exportImage = useCallback(() => {
    const viewport = viewportRef.current.viewport
    if (!viewport) return
    const url = viewport.captureImage(2)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = 'crowd-plan.png'
    window.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    useEditor.getState().toast('Image downloaded.', 'success')
  }, [])
  const openShortcuts = useCallback(() => setShowShortcuts(true), [])
  const overlayOpen = showTemplates || showShortcuts || showWelcome || showProjects
  useKeyboard({
    viewportRef,
    onToggleHeatmap: toggleHeatmap,
    onShowShortcuts: openShortcuts,
    overlayOpen,
  })

  // Theme lives on the root element so CSS variables cascade everywhere.
  useEffect(() => {
    window.document.documentElement.dataset.theme = theme
  }, [theme])

  // First run: recover the last project, or open a venue so the app is never
  // an empty grid with no way in.
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      const lastId = recallLastProject()
      if (lastId) {
        try {
          const restored = await loadProject(lastId)
          if (restored && !cancelled) {
            replaceDocument(restored, 'Reopen project')
            viewportRef.current.viewport?.frame(planBounds(restored.plan, 3))
            return
          }
        } catch {
          // Fall through to the starter venue.
        }
      }
      if (cancelled) return
      const template = getTemplate(DEFAULT_TEMPLATE_ID)
      if (template) {
        const doc = template.build()
        replaceDocument(doc, 'Open Coffee bar')
        viewportRef.current.viewport?.frame(planBounds(doc.plan, 3), false)
      }
      setShowWelcome(true)
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [replaceDocument])

  // Autosave, quietly, a couple of seconds after the last edit.
  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => {
      void saveProject(document)
        .then(() => {
          rememberLastProject(document.id)
          markSaved()
        })
        .catch(() => undefined)
    }, 2000)
    return () => clearTimeout(timer)
  }, [document, dirty, markSaved])

  useEffect(() => {
    if (error) {
      useEditor.getState().toast(error, 'error')
      clearError()
    }
  }, [error, clearError])

  useEffect(() => {
    for (const warning of warnings) useEditor.getState().toast(warning, 'warn')
  }, [warnings])

  useEffect(() => {
    if (phase === 'running' || phase === 'preparing') useEditor.getState().setPanel('results')
  }, [phase])

  const activePanel = useMemo(() => {
    switch (panel) {
      case 'scenario':
        return <ScenarioPanel />
      case 'results':
        return (
          <ResultsPanel
            heatmapFacility={heatmapFacility}
            onHeatmapFacility={setHeatmapFacility}
            onExportImage={exportImage}
          />
        )
      case 'layers':
        return <LayersPanel />
      case 'settings':
        return <SettingsPanel />
      case 'library':
      default:
        return <LibraryPanel />
    }
  }, [panel, heatmapFacility, exportImage])

  const frame = useSimulation((state) => state.frame)
  const los = frame ? losFor(frame.stats.peakDensity, heatmapFacility) : null

  return (
    <div className="app">
      <TopBar
        viewportRef={viewportRef}
        showHeatmap={showHeatmap}
        onToggleHeatmap={toggleHeatmap}
        onOpenTemplates={() => setShowTemplates(true)}
        onOpenProjects={() => setShowProjects(true)}
        onOpenShortcuts={openShortcuts}
      />
      <ToolRail />
      <aside className="side-panel">{activePanel}</aside>

      <main className="stage">
        <ViewportHost
          handleRef={viewportRef}
          colorMode={colorMode}
          showHeatmap={showHeatmap}
          heatmapFacility={heatmapFacility}
          showSafety={showSafety}
          onPickPerson={setInspectedPerson}
        />

        <div className="stage-overlay stage-top-right">
          {frame ? (
            <div
              className="card is-compact"
              style={{ display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <span className="field-label" style={{ textTransform: 'none' }}>
                Colour by
              </span>
              <Segmented
                value={colorMode}
                onChange={setColorMode}
                options={[
                  { value: 'state', label: 'Doing', title: 'What each person is doing' },
                  { value: 'population', label: 'Group' },
                  { value: 'speed', label: 'Speed' },
                  { value: 'wait', label: 'Wait' },
                ]}
              />
            </div>
          ) : null}
          {showHeatmap && frame ? (
            <div
              className="card is-compact"
              style={{ display: 'flex', gap: 10, alignItems: 'center' }}
            >
              <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Density</span>
              {los ? (
                <span
                  title={los.description}
                  style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                >
                  <span className="los-swatch" style={{ background: los.color }} />
                  <b style={{ fontFamily: 'var(--font-mono)' }}>{los.level}</b>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                    {frame.stats.peakDensity.toFixed(1)}/m²
                  </span>
                </span>
              ) : null}
              <label className="checkbox" style={{ padding: 0 }}>
                <input
                  type="checkbox"
                  checked={showSafety}
                  onChange={(event) => setShowSafety(event.target.checked)}
                />
                <span style={{ fontSize: 11.5 }}>Crush risk</span>
              </label>
            </div>
          ) : null}
        </div>

        {hint ? (
          <div className="stage-overlay stage-bottom-left">
            <div className="card is-compact status-strip">{hint}</div>
          </div>
        ) : null}
      </main>

      <aside className="inspector">
        <InspectorPanel
          inspectedPerson={
            inspectedPerson !== null ? (
              <PersonCard index={inspectedPerson} onClear={() => setInspectedPerson(null)} />
            ) : null
          }
        />
      </aside>

      <PlaybackBar />
      <Toasts />

      {showTemplates ? (
        <TemplatePicker onClose={() => setShowTemplates(false)} viewportRef={viewportRef} />
      ) : null}
      {showProjects ? (
        <ProjectsModal onClose={() => setShowProjects(false)} viewportRef={viewportRef} />
      ) : null}
      {showShortcuts ? <ShortcutSheet onClose={() => setShowShortcuts(false)} /> : null}
      {showWelcome ? (
        <Welcome onClose={() => setShowWelcome(false)} onTemplates={() => setShowTemplates(true)} />
      ) : null}
    </div>
  )
}

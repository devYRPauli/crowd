/**
 * The bridge between React and the 3D viewport.
 *
 * React owns the panels; this component owns the imperative world — the
 * renderer, the tools, the crowd and the overlays — and pushes state into it
 * through effects. Nothing inside the viewport re-renders React, and React
 * never reaches into the scene graph, which keeps a 60 fps render loop out of
 * the reconciler's way entirely.
 */

import { useEffect, useRef } from 'react'
import { Viewport } from '../render/Viewport'
import type { ViewPreset } from '../render/CameraRig'
import { ToolController } from '../editor/ToolController'
import { CrowdRenderer, type CrowdColorMode } from '../render/crowd/CrowdRenderer'
import { DensityOverlay } from '../render/overlays/DensityOverlay'
import { useEditor } from '../state/editorStore'
import { useSimulation } from '../state/simulationStore'
import { planBounds } from '../core/model/planGeometry'
import { formatArea } from '../core/model/units'
import type { FacilityType } from '../sim/metrics/los'

/**
 * Where the camera was left, if the browser will say.
 *
 * Reading storage that has been blocked throws rather than returning nothing,
 * and this ran bare while the viewport was being built: a browser set to block
 * site data got the crash screen instead of an editor with the default view.
 */
const storedCamera = (): string | null => {
  try {
    return localStorage.getItem('crowd:camera')
  } catch {
    return null
  }
}

export interface ViewportHandle {
  viewport: Viewport | null
  controller: ToolController | null
}

export const ViewportHost = ({
  handleRef,
  colorMode,
  showHeatmap,
  heatmapFacility,
  showSafety,
  onPickPerson,
}: {
  handleRef: React.MutableRefObject<ViewportHandle>
  colorMode: CrowdColorMode
  showHeatmap: boolean
  heatmapFacility: FacilityType
  showSafety: boolean
  onPickPerson: (index: number | null) => void
}) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<Viewport | null>(null)
  const crowdRef = useRef<CrowdRenderer | null>(null)
  const densityRef = useRef<DensityOverlay | null>(null)
  const controllerRef = useRef<ToolController | null>(null)
  const appliedPreset = useRef<ViewPreset | null>(null)

  const document = useEditor((state) => state.document)
  const selection = useEditor((state) => state.selection)
  const tool = useEditor((state) => state.tool)
  const view = useEditor((state) => state.view)

  const frame = useSimulation((state) => state.frame)
  const grid = useSimulation((state) => state.grid)
  const phase = useSimulation((state) => state.phase)

  // --- create and destroy -------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const viewport = new Viewport(host, useEditor.getState().view.theme)
    const crowd = new CrowdRenderer()
    const density = new DensityOverlay()
    viewport.crowdLayer.add(crowd.group)
    viewport.overlayLayer.add(density.mesh)

    viewportRef.current = viewport
    crowdRef.current = crowd
    densityRef.current = density
    controllerRef.current = new ToolController(viewport)
    handleRef.current = { viewport, controller: controllerRef.current }

    // A turned camera is in no named view. The lit button said it was, and
    // asking for that view again changed nothing, so Plan did nothing after an
    // orbit until another view had been picked first.
    const leavePreset = () => {
      if (useEditor.getState().view.preset !== null) useEditor.getState().setView({ preset: null })
    }
    viewport.onOrbit = leavePreset
    // The viewport starts in the 3D view. A camera restored from the last visit
    // is wherever it was left, and the preset effect used to swing it back.
    appliedPreset.current = 'iso'
    const stored = storedCamera()
    if (stored) {
      viewport.restoreCamera(stored)
      leavePreset()
    } else viewport.frame(planBounds(useEditor.getState().document.plan, 3), false)

    const saveCamera = () => {
      try {
        localStorage.setItem('crowd:camera', viewport.cameraSnapshot())
      } catch {
        // Camera persistence is a convenience; losing it is not worth an error.
      }
    }
    const timer = setInterval(saveCamera, 4000)

    return () => {
      clearInterval(timer)
      saveCamera()
      crowd.dispose()
      density.dispose()
      viewport.dispose()
      viewportRef.current = null
      handleRef.current = { viewport: null, controller: null }
    }
  }, [handleRef])

  // --- document, selection, tools ----------------------------------------
  useEffect(() => {
    viewportRef.current?.setDocument(document)
    controllerRef.current?.refresh()
  }, [document])

  // The tool redraws on a selection change as well: its handles are drawn from
  // the selection, and after Cmd-A or a pick in Layers the rotate ring did not
  // appear until the pointer moved.
  useEffect(() => {
    viewportRef.current?.setSelection([...selection])
    controllerRef.current?.refresh()
  }, [selection])

  useEffect(() => {
    controllerRef.current?.setTool(tool)
  }, [tool])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.setTheme(view.theme)
    viewport.setGridVisible(view.showGrid)
    viewport.setPlanOptions({
      showZones: view.showZones,
      showSeats: view.showSeats,
      showQueues: view.showQueues,
      showFurniture: view.showFurniture,
      wallCutHeight: view.wallCutHeight,
    })
  }, [view])

  useEffect(() => {
    if (view.preset && view.preset !== appliedPreset.current)
      viewportRef.current?.setView(view.preset)
    appliedPreset.current = view.preset
  }, [view.preset])

  // --- room labels --------------------------------------------------------
  // An effect, not a memo over the render: the rooms are the viewport's, and
  // they only follow the document once the effect above has handed it over.
  // Read during render they were the previous plan's, so an area lagged one
  // edit behind and an emptied venue kept the old room's floor area on it.
  useEffect(() => {
    const viewport = viewportRef.current
    // Only publish room labels when no tool is mid-gesture and using the layer.
    if (!viewport || tool !== 'select') return
    if (!view.showRoomLabels) {
      viewport.setLabels([])
      return
    }
    viewport.setLabels(
      viewport.rooms
        .filter((room) => room.area > 4)
        .map((room) => ({
          id: `room-${room.id}`,
          text: formatArea(room.area, document.settings.units),
          x: room.center.x,
          y: 0.04,
          z: room.center.y,
          variant: 'area' as const,
          maxDistance: 90,
        })),
    )
  }, [document, view.showRoomLabels, tool])

  // --- simulation ---------------------------------------------------------
  useEffect(() => {
    if (grid) densityRef.current?.setGrid(grid)
  }, [grid])

  useEffect(() => {
    densityRef.current?.setFacility(heatmapFacility)
  }, [heatmapFacility])

  useEffect(() => {
    densityRef.current?.setSafetyOverlay(showSafety)
  }, [showSafety])

  useEffect(() => {
    densityRef.current?.setVisible(showHeatmap && Boolean(grid))
    viewportRef.current?.invalidate()
  }, [showHeatmap, grid])

  useEffect(() => {
    const viewport = viewportRef.current
    const crowd = crowdRef.current
    if (!viewport || !crowd) return
    if (!frame) {
      crowd.clear()
      viewport.setContinuous(false)
      viewport.invalidate()
      return
    }
    const state = useEditor.getState().document.scenario
    crowd.update({
      agents: frame.agents,
      count: frame.count,
      profiles: state.profiles,
      populationColors: state.populations.map((p) => p.color),
      colorMode,
      time: frame.time,
    })
    if (showHeatmap) densityRef.current?.update(frame.density)
    viewport.invalidate()
  }, [frame, colorMode, showHeatmap])

  useEffect(() => {
    viewportRef.current?.setContinuous(phase === 'running')
  }, [phase])

  // --- click to inspect a person -----------------------------------------
  useEffect(() => {
    const viewport = viewportRef.current
    const crowd = crowdRef.current
    if (!viewport || !crowd) return
    const canvas = viewport.canvas
    const onClick = (event: MouseEvent) => {
      const current = useSimulation.getState().frame
      if (!current || useEditor.getState().tool !== 'select') return
      const rect = canvas.getBoundingClientRect()
      const picked = crowd.pick(
        current.agents,
        current.count,
        viewport.rig.camera,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
      )
      onPickPerson(picked)
    }
    canvas.addEventListener('click', onClick)
    return () => canvas.removeEventListener('click', onClick)
  }, [onPickPerson])

  return <div className="stage-canvas" ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
}

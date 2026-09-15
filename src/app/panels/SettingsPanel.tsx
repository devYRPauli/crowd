/**
 * Document settings and drawing aids.
 */

import { useEditor } from '../../state/editorStore'
import { updateSettings } from '../../core/document/mutations'
import { Checkbox, Field, LengthInput, Segmented, Slider } from '../components/ui'
import type { UnitSystem } from '../../core/model/types'
import { readFileAsDataUrl } from '../../core/document/storage'
import { setBackdrop } from '../../core/document/mutations'

export const SettingsPanel = () => {
  const document = useEditor((state) => state.document)
  const apply = useEditor((state) => state.apply)
  const view = useEditor((state) => state.view)
  const setView = useEditor((state) => state.setView)
  const toast = useEditor((state) => state.toast)
  const settings = document.settings

  const patch = (changes: Parameters<typeof updateSettings>[1], label: string) =>
    apply((doc) => updateSettings(doc, changes), label)

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Settings</span>
      </div>
      <div className="panel-body">
        <div className="section">
          <div className="section-title">Units</div>
          <Segmented
            value={settings.units}
            onChange={(units: UnitSystem) => patch({ units }, 'Change units')}
            options={[
              { value: 'metric', label: 'Metric' },
              { value: 'imperial', label: 'Imperial' },
            ]}
          />
          <p className="hint">
            The plan is always stored in metres; this only changes how lengths are shown and typed.
          </p>
        </div>

        <div className="section">
          <div className="section-title">Appearance</div>
          <Segmented
            value={view.theme}
            onChange={(theme) => setView({ theme })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>

        <div className="section">
          <div className="section-title">Snapping</div>
          <Checkbox
            label="Snap to the grid"
            checked={settings.snapToGrid}
            onChange={(snapToGrid) => patch({ snapToGrid }, 'Change snapping')}
          />
          <Checkbox
            label="Snap to walls and objects"
            checked={settings.snapToObjects}
            onChange={(snapToObjects) => patch({ snapToObjects }, 'Change snapping')}
          />
          <Field label="Grid spacing">
            <LengthInput
              value={settings.gridSize}
              units={settings.units}
              min={0.05}
              max={10}
              onCommit={(gridSize) => patch({ gridSize }, 'Change grid')}
            />
          </Field>
          <Slider
            label="Angle snap"
            min={0}
            max={45}
            step={5}
            value={settings.angleSnapDeg}
            format={(v) => (v === 0 ? 'off' : `${v}°`)}
            onChange={(angleSnapDeg) => patch({ angleSnapDeg }, 'Change angle snap')}
          />
          <p className="hint">
            Hold <span className="kbd">Alt</span> while drawing to ignore snapping for one move.
          </p>
        </div>

        <div className="section">
          <div className="section-title">New wall defaults</div>
          <div className="row">
            <Field label="Thickness">
              <LengthInput
                value={settings.defaultWallThickness}
                units={settings.units}
                min={0.02}
                max={2}
                onCommit={(defaultWallThickness) =>
                  patch({ defaultWallThickness }, 'Change defaults')
                }
              />
            </Field>
            <Field label="Height">
              <LengthInput
                value={settings.defaultWallHeight}
                units={settings.units}
                min={0.5}
                max={12}
                onCommit={(defaultWallHeight) => patch({ defaultWallHeight }, 'Change defaults')}
              />
            </Field>
          </div>
        </div>

        <div className="section">
          <div className="section-title">Trace a floor plan</div>
          <p className="hint">
            Drop in a scan or a screenshot of an existing plan, scale it against a known dimension,
            and draw over it. The image is stored inside the project.
          </p>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Choose an image…
            <input
              type="file"
              accept="image/*"
              className="visually-hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                try {
                  const src = await readFileAsDataUrl(file)
                  apply(
                    (doc) =>
                      setBackdrop(doc, {
                        src,
                        position: { x: 0, y: 0 },
                        rotation: 0,
                        width: 20,
                        depth: 14,
                        opacity: 0.55,
                        visible: true,
                      }),
                    'Add reference image',
                  )
                  toast(
                    'Image added. Select it to set its size against a known dimension.',
                    'success',
                  )
                } catch {
                  toast('That image could not be read.', 'error')
                }
                event.target.value = ''
              }}
            />
          </label>
        </div>
      </div>
    </>
  )
}

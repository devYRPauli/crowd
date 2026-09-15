/**
 * Run controls and the live readout.
 *
 * The numbers shown while a run is in flight are deliberately the ones that
 * change the decision — how many are inside, how fast they are actually
 * walking, how long the queue is — rather than a frame counter.
 */

import { useSimulation } from '../state/simulationStore'
import { useEditor } from '../state/editorStore'
import { formatClock, formatNumber } from '../core/model/units'
import { PauseIcon, PlayIcon, StopIcon } from './components/icons'
import { Sparkline } from './components/ui'
import { losFor } from '../sim/metrics/los'
import { useMemo } from 'react'

export const PlaybackBar = () => {
  const document = useEditor((state) => state.document)
  const phase = useSimulation((state) => state.phase)
  const frame = useSimulation((state) => state.frame)
  const progress = useSimulation((state) => state.progress)
  const speed = useSimulation((state) => state.speed)
  const series = useSimulation((state) => state.series)
  const run = useSimulation((state) => state.run)
  const pause = useSimulation((state) => state.pause)
  const resume = useSimulation((state) => state.resume)
  const stop = useSimulation((state) => state.stop)
  const setSpeed = useSimulation((state) => state.setSpeed)

  const stats = frame?.stats
  const los = stats ? losFor(stats.peakDensity) : null

  const spark = useMemo(
    () => (series ? Array.from(series.time, (t, i) => ({ x: t, y: series.active[i] })) : []),
    [series],
  )

  const running = phase === 'running'
  const busy = phase === 'preparing'

  return (
    <div className="playbar">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {phase === 'idle' || phase === 'done' || phase === 'error' ? (
          <button
            className="btn is-primary"
            onClick={() => run(document, document.name)}
            disabled={busy}
          >
            <PlayIcon width={14} height={14} />
            {phase === 'done' ? 'Run again' : 'Run'}
          </button>
        ) : (
          <>
            <button
              className="btn is-primary"
              onClick={() => (running ? pause() : resume())}
              aria-label={running ? 'Pause' : 'Resume'}
            >
              {running ? <PauseIcon width={14} height={14} /> : <PlayIcon width={14} height={14} />}
              {running ? 'Pause' : 'Resume'}
            </button>
            <button className="btn is-icon" onClick={stop} title="Stop and clear" aria-label="Stop">
              <StopIcon width={13} height={13} />
            </button>
          </>
        )}
        {busy ? <span className="progress-ring" aria-label="Preparing" /> : null}
      </div>

      <div className="clock">{formatClock(frame?.time ?? 0)}</div>

      <div className="timeline">
        <div className="timeline-track">
          <div className="timeline-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
          {spark.length > 2 ? (
            <div className="timeline-spark">
              <Sparkline
                series={spark}
                height={26}
                fill
                color="var(--accent)"
                label="People inside"
              />
            </div>
          ) : null}
          <div className="timeline-head" style={{ left: `${Math.min(100, progress * 100)}%` }} />
        </div>
        <div className="timeline-meta">
          <span>0:00</span>
          <span>
            {document.scenario.populations.reduce((sum, p) => sum + p.count, 0)} people ·{' '}
            {formatClock(document.scenario.durationS)}
          </span>
        </div>
      </div>

      <div className="live-stats">
        <span>
          <b>{stats?.active ?? 0}</b> inside
        </span>
        <span>
          <b>{stats?.completed ?? 0}</b> left
        </span>
        <span>
          <b>{formatNumber(stats?.meanWalkingSpeed ?? 0, 2)}</b> m/s
        </span>
        {los ? (
          <span title={los.description}>
            LOS <b style={{ color: los.color }}>{los.level}</b>
          </span>
        ) : null}
      </div>

      <div className="segmented" role="group" aria-label="Playback speed">
        {[1, 4, 16, 60].map((value) => (
          <button
            key={value}
            className={speed === value ? 'is-active' : ''}
            onClick={() => setSpeed(value)}
            title={`${value}× real time`}
          >
            {value}×
          </button>
        ))}
      </div>
    </div>
  )
}

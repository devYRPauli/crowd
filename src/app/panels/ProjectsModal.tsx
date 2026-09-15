/**
 * Saved projects.
 *
 * Everything is stored locally in the browser — there is no account and no
 * server — so the list has to be honest about that, and about the fact that
 * clearing site data takes it all with it. The download button beside each
 * project is the answer to that, and it is deliberately prominent.
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../components/ui'
import {
  deleteProject,
  downloadText,
  listProjects,
  loadProject,
  rememberLastProject,
  saveProject,
  type StoredProject,
} from '../../core/document/storage'
import { documentFileName, serializeDocument } from '../../core/document/serialize'
import { useEditor } from '../../state/editorStore'
import { useSimulation } from '../../state/simulationStore'
import { planBounds } from '../../core/model/planGeometry'
import { createDocument } from '../../core/model/defaults'
import { SaveIcon, TrashIcon } from '../components/icons'
import type { ViewportHandle } from '../ViewportHost'

const formatWhen = (iso: string): string => {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString()
}

const formatBytes = (bytes: number): string =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`

export const ProjectsModal = ({
  onClose,
  viewportRef,
}: {
  onClose: () => void
  viewportRef: React.MutableRefObject<ViewportHandle>
}) => {
  const [projects, setProjects] = useState<StoredProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const document = useEditor((state) => state.document)
  const replaceDocument = useEditor((state) => state.replaceDocument)
  const markSaved = useEditor((state) => state.markSaved)
  const toast = useEditor((state) => state.toast)
  const stop = useSimulation((state) => state.stop)

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects())
      setError(null)
    } catch {
      setProjects([])
      setError(
        'This browser will not let CROWD store projects locally — private browsing usually causes that. Everything still works, but nothing is kept between visits. Use Download to keep a copy.',
      )
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const open = async (id: string) => {
    const restored = await loadProject(id)
    if (!restored) {
      toast('That project could not be read.', 'error')
      return
    }
    stop()
    replaceDocument(restored, 'Open project')
    rememberLastProject(restored.id)
    viewportRef.current.viewport?.frame(planBounds(restored.plan, 3))
    onClose()
  }

  return (
    <Modal
      title="Projects"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              const fresh = createDocument('Untitled venue')
              stop()
              replaceDocument(fresh, 'New project')
              rememberLastProject(fresh.id)
              onClose()
            }}
          >
            New empty project
          </button>
          <button
            className="btn is-primary"
            onClick={async () => {
              try {
                await saveProject(document)
                rememberLastProject(document.id)
                markSaved()
                toast(`Saved “${document.name}”.`, 'success')
                void refresh()
              } catch {
                toast(
                  'This browser will not let CROWD save locally. Download the file instead.',
                  'warn',
                )
              }
            }}
          >
            Save this project
          </button>
        </>
      }
    >
      {error ? <p className="hint">{error}</p> : null}

      <p className="hint" style={{ marginTop: 0 }}>
        Projects are stored in this browser only. Nothing is uploaded anywhere, which also means
        clearing site data removes them — download anything you want to keep.
      </p>

      {projects === null ? (
        <div className="empty">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="empty">
          No saved projects yet.
          <br />
          Save this one, or start from a template.
        </div>
      ) : (
        <div
          className="list"
          style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}
        >
          {projects.map((project) => (
            <div
              key={project.id}
              className={`list-row${project.id === document.id ? ' is-active' : ''}`}
              onClick={() => void open(project.id)}
            >
              <span className="label">
                {project.name}
                {project.id === document.id ? <span className="badge is-accent"> open</span> : null}
              </span>
              <span className="meta">{formatBytes(project.bytes)}</span>
              <span className="meta">{formatWhen(project.updatedAt)}</span>
              <button
                className="btn is-ghost is-icon"
                title="Download a copy"
                onClick={async (event) => {
                  event.stopPropagation()
                  const full = await loadProject(project.id)
                  if (!full) return
                  downloadText(documentFileName(full), serializeDocument(full))
                }}
              >
                <SaveIcon width={14} height={14} />
              </button>
              <button
                className="btn is-ghost is-icon"
                title="Delete this project"
                onClick={async (event) => {
                  event.stopPropagation()
                  await deleteProject(project.id)
                  toast(`Deleted “${project.name}”.`, 'info')
                  void refresh()
                }}
              >
                <TrashIcon width={14} height={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

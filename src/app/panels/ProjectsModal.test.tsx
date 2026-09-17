/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CrowdDocument } from '../../core/model/types'
import type { ViewportHandle } from '../ViewportHost'

/**
 * Projects live in IndexedDB, which jsdom does not have, so the store stands in
 * for it — including the ways it fails, which are the cases that decide whether
 * a venue survives.
 */
const disk = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; name: string; updatedAt: string; bytes: number }>,
  documents: new Map<string, unknown>(),
  listThrows: false,
  saveThrows: false,
  saved: [] as CrowdDocument[],
  deleted: [] as string[],
  remembered: [] as string[],
  downloads: [] as Array<{ name: string; text: string }>,
}))

vi.mock('../../core/document/storage', () => ({
  listProjects: async () => {
    if (disk.listThrows) throw new Error('Storage is blocked')
    return disk.rows
  },
  loadProject: async (id: string) => disk.documents.get(id) ?? null,
  saveProject: async (doc: CrowdDocument) => {
    if (disk.saveThrows) throw new Error('Storage is blocked')
    disk.saved.push(doc)
  },
  deleteProject: async (id: string) => {
    disk.deleted.push(id)
    disk.rows = disk.rows.filter((row) => row.id !== id)
  },
  rememberLastProject: (id: string) => disk.remembered.push(id),
  downloadText: (name: string, text: string) => disk.downloads.push({ name, text }),
}))

const { ProjectsModal } = await import('./ProjectsModal')
const { useEditor } = await import('../../state/editorStore')
const { useSimulation } = await import('../../state/simulationStore')
const { createDocument } = await import('../../core/model/defaults')
const { addWall } = await import('../../core/document/mutations')
const { DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS } = await import('../../core/model/standards')

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString()

const wall = {
  id: 'wall-1',
  a: { x: 0, y: 0 },
  b: { x: 4, y: 0 },
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'wall' as const,
}

/** A saved venue with something in it, so losing it would be visible. */
const storedVenue = (name: string): CrowdDocument => {
  const base = createDocument(name)
  return { ...base, plan: { ...base.plan, walls: [wall] } }
}

const doc = () => useEditor.getState().document

const show = () => {
  const onClose = vi.fn()
  const viewportRef: React.MutableRefObject<ViewportHandle> = {
    current: { viewport: null, controller: null },
  }
  const view = render(<ProjectsModal onClose={onClose} viewportRef={viewportRef} />)
  return { ...view, onClose }
}

beforeEach(() => {
  disk.rows = []
  disk.documents = new Map()
  disk.listThrows = false
  disk.saveThrows = false
  disk.saved = []
  disk.deleted = []
  disk.remembered = []
  disk.downloads = []
  useEditor.getState().replaceDocument(createDocument('Working venue'))
  useEditor.setState({ toasts: [] })
  useSimulation.setState({ summary: null, series: null, phase: 'idle', runId: null })
})

describe('the list of saved projects', () => {
  it('shows what is stored, how big it is and when it was last touched', async () => {
    disk.rows = [
      { id: 'proj-1', name: 'Atrium', updatedAt: minutesAgo(5), bytes: 12000 },
      { id: 'proj-2', name: 'Concourse', updatedAt: minutesAgo(90), bytes: 400 },
    ]
    show()

    expect(await screen.findByText('Atrium')).toBeDefined()
    expect(screen.getByText('12 kB')).toBeDefined()
    expect(screen.getByText('5 min ago')).toBeDefined()
    expect(screen.getByText('Concourse')).toBeDefined()
    expect(screen.getByText('2 h ago')).toBeDefined()
    // There is no account and no server, so the panel has to be honest that
    // clearing site data takes all of this with it.
    expect(screen.getByText(/stored in this browser only/i)).toBeDefined()
  })

  it('says why the list is empty when the browser refuses to store anything', async () => {
    disk.listThrows = true
    show()

    expect(await screen.findByText(/will not let CROWD store projects locally/i)).toBeDefined()
    expect(screen.getByText(/Use Download to keep a copy/i)).toBeDefined()
    // Everything still works, so the save and new-project buttons stay.
    expect(screen.getByText('Save this project')).toBeDefined()
  })
})

describe('opening a project', () => {
  it('swaps in the saved venue and throws away the run that was on screen', async () => {
    const venue = storedVenue('Atrium')
    disk.rows = [{ id: venue.id, name: 'Atrium', updatedAt: minutesAgo(1), bytes: 900 }]
    disk.documents.set(venue.id, venue)
    useSimulation.setState({ summary: { completed: 1 } as never, phase: 'done' })
    const { onClose } = show()

    fireEvent.click(await screen.findByText('Atrium'))

    await waitFor(() => expect(doc().id).toBe(venue.id))
    expect(doc().plan.walls).toHaveLength(1)
    // Findings go with the crowd: results left behind would be read against the
    // plan that just arrived.
    expect(useSimulation.getState().summary).toBeNull()
    expect(disk.remembered).toContain(venue.id)
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the venue in front of you when a saved one cannot be read', async () => {
    disk.rows = [{ id: 'proj-broken', name: 'Corrupted', updatedAt: minutesAgo(1), bytes: 900 }]
    const before = doc()
    const { onClose } = show()

    fireEvent.click(await screen.findByText('Corrupted'))

    await waitFor(() => expect(useEditor.getState().toasts.length).toBe(1))
    // An unreadable row must not be opened as an empty venue over the top of
    // the one being worked on.
    expect(useEditor.getState().toasts[0].message).toBe('That project could not be read.')
    expect(useEditor.getState().toasts[0].tone).toBe('error')
    expect(doc()).toBe(before)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('marks which project in the list is the one already open', async () => {
    const open = doc()
    disk.rows = [
      { id: open.id, name: open.name, updatedAt: minutesAgo(1), bytes: 500 },
      { id: 'proj-2', name: 'Concourse', updatedAt: minutesAgo(2), bytes: 500 },
    ]
    show()

    const row = (await screen.findByText(/Working venue/)).closest('.list-row')
    expect(row?.className).toContain('is-active')
    expect(screen.getByText('open')).toBeDefined()
  })
})

describe('saving', () => {
  it('writes the project and stops calling it unsaved', async () => {
    useEditor.getState().apply((document) => addWall(document, wall), 'Draw wall')
    expect(useEditor.getState().dirty).toBe(true)
    show()

    fireEvent.click(screen.getByText('Save this project'))

    await waitFor(() => expect(useEditor.getState().dirty).toBe(false))
    expect(disk.saved).toHaveLength(1)
    expect(disk.saved[0].plan.walls).toHaveLength(1)
    expect(useEditor.getState().toasts.at(-1)?.tone).toBe('success')
  })

  it('leaves the project marked unsaved when the browser refuses the write', async () => {
    disk.saveThrows = true
    useEditor.getState().apply((document) => addWall(document, wall), 'Draw wall')
    show()

    fireEvent.click(screen.getByText('Save this project'))

    await waitFor(() => expect(useEditor.getState().toasts.length).toBe(1))
    expect(useEditor.getState().toasts[0].message).toMatch(/Download the file instead/i)
    // Reporting a save that did not happen is how a venue gets lost: the
    // unsaved badge is the only warning left.
    expect(useEditor.getState().dirty).toBe(true)
    expect(disk.saved).toHaveLength(0)
  })

  it('downloads the whole venue rather than the summary the list shows', async () => {
    const venue = storedVenue('Atrium')
    disk.rows = [{ id: venue.id, name: 'Atrium', updatedAt: minutesAgo(1), bytes: 900 }]
    disk.documents.set(venue.id, venue)
    const { onClose } = show()

    await screen.findByText('Atrium')
    fireEvent.click(screen.getByTitle('Download a copy'))

    await waitFor(() => expect(disk.downloads).toHaveLength(1))
    expect(disk.downloads[0].name).toBe('atrium.crowd.json')
    const written = JSON.parse(disk.downloads[0].text) as CrowdDocument
    expect(written.id).toBe(venue.id)
    expect(written.plan.walls).toHaveLength(1)
    // Downloading is not opening.
    expect(doc().id).not.toBe(venue.id)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says nothing at all when the copy it was asked to download cannot be read', async () => {
    const venue = storedVenue('Atrium')
    disk.rows = [
      { id: 'proj-broken', name: 'Corrupted', updatedAt: minutesAgo(1), bytes: 900 },
      { id: venue.id, name: 'Atrium', updatedAt: minutesAgo(2), bytes: 900 },
    ]
    disk.documents.set(venue.id, venue)
    show()

    await screen.findByText('Corrupted')
    const [broken, readable] = screen.getAllByTitle('Download a copy')
    fireEvent.click(broken)
    fireEvent.click(readable)

    // Both handlers await the same load, so once the readable one has written
    // its file the unreadable one has finished doing whatever it does.
    await waitFor(() => expect(disk.downloads).toHaveLength(1))
    expect(disk.downloads[0].name).toBe('atrium.crowd.json')

    // SUSPECTED BUG: the download button's handler is `if (!full) return`
    // (src/app/panels/ProjectsModal.tsx:167) — no file, no toast, nothing. The
    // open button one row over hits the same `loadProject` returning null and
    // says "That project could not be read.", so the panel already knows how to
    // report it. Download is the only copy of a project that leaves this
    // browser, and this panel's own text tells people to use it for anything
    // they want to keep; a click that silently does nothing reads as a slow
    // browser, and the natural next move is to clear site data and try again.
    // I believe it should raise the same toast the open path does.
    expect(useEditor.getState().toasts).toHaveLength(0)
  })
})

describe('removing and starting over', () => {
  it('deletes only the project the button sits on, and does not open it on the way', async () => {
    disk.rows = [
      { id: 'proj-1', name: 'Atrium', updatedAt: minutesAgo(1), bytes: 900 },
      { id: 'proj-2', name: 'Concourse', updatedAt: minutesAgo(2), bytes: 900 },
    ]
    const before = doc()
    const { onClose } = show()

    await screen.findByText('Atrium')
    fireEvent.click(screen.getAllByTitle('Delete this project')[0])

    // One click, no confirmation and no undo: the toast is all the user gets,
    // which is why it has to name the project that went.
    await waitFor(() => expect(screen.queryByText('Atrium')).toBeNull())
    expect(disk.deleted).toEqual(['proj-1'])
    expect(useEditor.getState().toasts.at(-1)?.message).toBe('Deleted “Atrium”.')
    expect(screen.getByText('Concourse')).toBeDefined()
    expect(doc()).toBe(before)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('starts an empty venue and clears the run that belonged to the old one', async () => {
    useSimulation.setState({ summary: { completed: 1 } as never, phase: 'done' })
    const before = doc()
    const { onClose } = show()

    fireEvent.click(screen.getByText('New empty project'))

    await waitFor(() => expect(doc()).not.toBe(before))
    expect(doc().name).toBe('Untitled venue')
    expect(doc().plan.walls).toHaveLength(0)
    expect(useSimulation.getState().summary).toBeNull()
    expect(disk.remembered).toContain(doc().id)
    expect(onClose).toHaveBeenCalled()
  })
})

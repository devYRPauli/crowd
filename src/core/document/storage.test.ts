import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocument } from '../model/defaults'
import { parseDocument } from './serialize'
import { PlanBuilder } from '../../library/planBuilder'
import type { CrowdDocument } from '../model/types'
import type * as StorageModule from './storage'

/**
 * The module is IndexedDB-backed; localStorage only holds the pointer to the
 * last project. The test environment has neither, so both are stood up here.
 *
 * `dbPromise` is cached for the life of the module, so every test takes a fresh
 * import — otherwise the first test to open a database would hand its
 * connection, and its failures, to all the others.
 */

interface StoredRow {
  id: string
  name: string
  updatedAt: string
  payload: string
}

/**
 * What the browser is refusing to do at this moment. `'silent'` is the browser
 * that fails without filling in `request.error`, which several do.
 */
type Fault = Error | 'silent' | null

interface Faults {
  open: Fault
  read: Fault
  write: Fault
}

class FakeRequest<T> {
  result: T | undefined
  error: Error | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
}

const installIndexedDb = () => {
  const rows = new Map<string, StoredRow>()
  const faults: Faults = { open: null, read: null, write: null }
  const storeNames = new Set<string>()
  const modes: IDBTransactionMode[] = []
  let opens = 0

  // Requests settle on a later microtask, as real ones do: the module attaches
  // its handlers after the call returns, so a synchronous answer would be lost.
  const settle = <T>(compute: () => T): FakeRequest<T> => {
    const request = new FakeRequest<T>()
    queueMicrotask(() => {
      try {
        request.result = compute()
        request.onsuccess?.()
      } catch (thrown) {
        request.error = thrown instanceof Error ? thrown : null
        request.onerror?.()
      }
    })
    return request
  }

  const reads = {
    get: (id: string) =>
      settle(() => {
        if (faults.read) throw faults.read
        const row = rows.get(id)
        return row ? { ...row } : undefined
      }),
    getAll: () =>
      settle(() => {
        if (faults.read) throw faults.read
        return [...rows.values()].map((row) => ({ ...row }))
      }),
  }

  const writes = {
    put: (row: StoredRow) =>
      settle(() => {
        if (faults.write) throw faults.write
        rows.set(row.id, { ...row })
        return row.id
      }),
    delete: (id: string) =>
      settle(() => {
        if (faults.write) throw faults.write
        rows.delete(id)
        return undefined
      }),
  }

  const refuse = () => {
    throw new Error('ReadOnlyError: the transaction is read-only.')
  }

  const db = {
    objectStoreNames: { contains: (name: string) => storeNames.has(name) },
    createObjectStore: (name: string) => {
      storeNames.add(name)
      return { ...reads, ...writes, createIndex: () => undefined }
    },
    // A store the upgrade never created is not there to be opened, which is what
    // keeps the `onupgradeneeded` path load-bearing rather than decorative. Real
    // IndexedDB also refuses a write through a read-only transaction.
    transaction: (name: string, mode: IDBTransactionMode) => {
      if (!storeNames.has(name)) throw new Error(`No object store named ${name}.`)
      modes.push(mode)
      const store =
        mode === 'readwrite' ? { ...reads, ...writes } : { ...reads, put: refuse, delete: refuse }
      return { objectStore: () => store }
    },
  }

  const factory = {
    open: () => {
      opens += 1
      const request = new FakeRequest<typeof db>()
      queueMicrotask(() => {
        if (faults.open) {
          request.error = faults.open instanceof Error ? faults.open : null
          request.onerror?.()
          return
        }
        request.result = db
        if (storeNames.size === 0) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }

  Object.defineProperty(globalThis, 'indexedDB', {
    value: factory,
    configurable: true,
    writable: true,
  })

  return {
    rows,
    faults,
    opens: () => opens,
    /** The lock each call took, in the order the calls took them. */
    modes: () => [...modes],
    /** Take the database away, as a private window or an embedded webview does. */
    uninstall: () => Reflect.deleteProperty(globalThis, 'indexedDB'),
  }
}

const installLocalStorage = (faults: { read?: boolean; write?: boolean } = {}) => {
  const entries = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => {
        if (faults.read) throw new Error('SecurityError: access to storage is denied.')
        return entries.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (faults.write) throw new Error('QuotaExceededError')
        entries.set(key, value)
      },
    },
    configurable: true,
    writable: true,
  })
  return entries
}

interface FakeAnchor {
  href: string
  download: string
  clicks: number
  attached: boolean
  click: () => void
  remove: () => void
}

const installDocument = () => {
  const anchors: FakeAnchor[] = []
  Object.defineProperty(globalThis, 'document', {
    value: {
      body: {
        appendChild: (node: FakeAnchor) => {
          node.attached = true
          return node
        },
      },
      createElement: (tag: string) => {
        if (tag !== 'a') throw new Error(`Downloads should use an anchor, not <${tag}>.`)
        const anchor: FakeAnchor = {
          href: '',
          download: '',
          clicks: 0,
          attached: false,
          click: () => {
            anchor.clicks += 1
          },
          remove: () => {
            anchor.attached = false
          },
        }
        anchors.push(anchor)
        return anchor
      },
    },
    configurable: true,
    writable: true,
  })
  return anchors
}

/** Captures the blobs handed to the browser, which the module never returns. */
const trackObjectUrls = () => {
  const created: Blob[] = []
  const revoked: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    created.push(blob as Blob)
    return `blob:crowd/${created.length}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url)
  })
  return { created, revoked }
}

const installFileReader = (outcome: { result?: string | null; error?: Error | null }) => {
  const calls: Array<'text' | 'data-url'> = []
  class FakeFileReader {
    result: string | null = outcome.result ?? null
    error: Error | null = outcome.error ?? null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private finish() {
      queueMicrotask(() => {
        if ('error' in outcome) this.onerror?.()
        else this.onload?.()
      })
    }
    readAsText() {
      calls.push('text')
      this.finish()
    }
    readAsDataURL() {
      calls.push('data-url')
      this.finish()
    }
  }
  Object.defineProperty(globalThis, 'FileReader', {
    value: FakeFileReader,
    configurable: true,
    writable: true,
  })
  return calls
}

/** A small but real venue: four walls and a door hung on one of them. */
const venue = (name: string, updatedAt: string): CrowdDocument => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 12, 8)
  b.door(room.south, 3, 1.0, 'door', 'both')
  return {
    ...createDocument(name),
    plan: b.build(),
    createdAt: '2023-11-02T08:00:00.000Z',
    updatedAt,
  }
}

let db!: ReturnType<typeof installIndexedDb>
let storage!: typeof StorageModule

beforeEach(async () => {
  db = installIndexedDb()
  vi.resetModules()
  storage = await import('./storage')
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'indexedDB')
  Reflect.deleteProperty(globalThis, 'localStorage')
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'FileReader')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('keeping a venue on this machine', () => {
  it('brings the venue back exactly as it was drawn', async () => {
    const original = venue('Atrium', '2024-05-01T10:00:00.000Z')
    await storage.saveProject(original)

    const restored = await storage.loadProject(original.id)
    expect(restored?.id).toBe(original.id)
    expect(restored?.name).toBe('Atrium')
    expect(restored?.plan).toEqual(original.plan)
    expect(restored?.scenario).toEqual(original.scenario)
    expect(restored?.settings).toEqual(original.settings)
    // The only durable record of when somebody started this venue.
    expect(restored?.createdAt).toBe('2023-11-02T08:00:00.000Z')
    // Opening restamps the document, the way opening a file does; the time the
    // project list shows is the row's, written when the venue was last saved.
    expect(Date.parse(restored?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse('2024-05-01T10:00:00.000Z'),
    )
    expect((await storage.listProjects())[0].updatedAt).toBe('2024-05-01T10:00:00.000Z')
  })

  it('lists the venue somebody touched most recently at the top', async () => {
    const stale = venue('Warehouse', '2024-01-02T09:00:00.000Z')
    const middling = venue('Foyer', '2024-06-11T18:30:00.000Z')
    const fresh = venue('Main hall', '2025-02-20T07:15:00.000Z')
    for (const doc of [middling, fresh, stale]) await storage.saveProject(doc)

    const listed = await storage.listProjects()
    expect(listed.map((project) => project.name)).toEqual(['Main hall', 'Foyer', 'Warehouse'])
    expect(listed.map((project) => project.id)).toEqual([fresh.id, middling.id, stale.id])
    expect(listed[0].updatedAt).toBe('2025-02-20T07:15:00.000Z')
  })

  it('sizes each row by what that venue actually costs to keep', async () => {
    const plain = venue('Main hall', '2024-03-01T10:00:00.000Z')
    const traced = venue('Traced hall', '2024-03-02T10:00:00.000Z')
    traced.plan = {
      ...traced.plan,
      backdrop: {
        src: `data:image/png;base64,${'A'.repeat(4096)}`,
        position: { x: 0, y: 0 },
        rotation: 0,
        width: 20,
        depth: 14,
        opacity: 0.6,
        visible: true,
      },
    }
    for (const doc of [plain, traced]) await storage.saveProject(doc)

    const bytes = new Map((await storage.listProjects()).map((p) => [p.name, p.bytes]))
    expect(bytes.get('Main hall')).toBe(JSON.stringify(plain).length)
    // A traced floor plan is the one thing that makes a project big enough to
    // matter, so the figure on the card has to move when somebody adds one.
    expect(bytes.get('Traced hall')).toBeGreaterThan((bytes.get('Main hall') ?? 0) + 4096)
  })

  it('saving a renamed venue replaces it instead of leaving two of it', async () => {
    const doc = venue('Foyer', '2024-06-11T18:30:00.000Z')
    await storage.saveProject(doc)
    await storage.saveProject({
      ...doc,
      name: 'Foyer — north end',
      updatedAt: '2024-06-12T09:00:00.000Z',
    })

    const listed = await storage.listProjects()
    expect(listed).toHaveLength(1)
    // The list row carries its own copy of the name; a rename that reached only
    // the payload would leave the old name on the card for good.
    expect(listed[0].name).toBe('Foyer — north end')
    expect(listed[0].updatedAt).toBe('2024-06-12T09:00:00.000Z')
    expect((await storage.loadProject(doc.id))?.name).toBe('Foyer — north end')
  })

  it('deletes the one venue it was asked for and nothing beside it', async () => {
    const warehouse = venue('Warehouse', '2024-01-02T09:00:00.000Z')
    const foyer = venue('Foyer', '2024-06-11T18:30:00.000Z')
    const hall = venue('Main hall', '2025-02-20T07:15:00.000Z')
    for (const doc of [warehouse, foyer, hall]) await storage.saveProject(doc)

    await storage.deleteProject(foyer.id)

    expect((await storage.listProjects()).map((project) => project.id)).toEqual([
      hall.id,
      warehouse.id,
    ])
    expect(await storage.loadProject(foyer.id)).toBeNull()
    expect((await storage.loadProject(warehouse.id))?.name).toBe('Warehouse')
  })

  it('shrugs off deleting or opening a venue that was never there', async () => {
    expect(await storage.listProjects()).toEqual([])

    const hall = venue('Main hall', '2025-02-20T07:15:00.000Z')
    await storage.saveProject(hall)

    await expect(storage.deleteProject('doc_neverexisted')).resolves.toBeUndefined()
    expect(await storage.loadProject('doc_neverexisted')).toBeNull()
    expect(await storage.listProjects()).toHaveLength(1)
  })

  it('opens the database once however much the editor saves', async () => {
    const hall = venue('Main hall', '2025-02-20T07:15:00.000Z')
    const foyer = venue('Foyer', '2024-06-11T18:30:00.000Z')

    await Promise.all([storage.saveProject(hall), storage.saveProject(foyer)])
    await storage.listProjects()
    await storage.loadProject(hall.id)
    await storage.deleteProject(foyer.id)

    // Autosave fires every couple of seconds. A connection per call would leave
    // the tab holding dozens of them, and any one of them blocks a future
    // schema upgrade for every other tab.
    expect(db.opens()).toBe(1)
    // Opening the projects panel must not take a write lock: reading the list
    // would then queue behind autosave, and hold every other tab up with it.
    expect(db.modes()).toEqual(['readwrite', 'readwrite', 'readonly', 'readonly', 'readwrite'])
  })
})

describe('a stored venue that cannot be read back', () => {
  it('gives up on an entry that is not JSON without taking the others down', async () => {
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    await storage.saveProject(hall)
    db.rows.set('doc_truncated', {
      id: 'doc_truncated',
      name: 'Half-written venue',
      updatedAt: '2024-04-01T10:00:00.000Z',
      payload: '{"plan":{"walls":[',
    })

    expect(await storage.loadProject('doc_truncated')).toBeNull()
    expect((await storage.loadProject(hall.id))?.name).toBe('Main hall')

    // The damaged entry still has to appear in the list: a project the user
    // cannot see is a project they cannot delete, and it keeps its bytes.
    const listed = await storage.listProjects()
    expect(listed.map((project) => project.name)).toEqual(['Half-written venue', 'Main hall'])
    await storage.deleteProject('doc_truncated')
    expect((await storage.listProjects()).map((project) => project.id)).toEqual([hall.id])
  })

  it('says it cannot read an entry that is not a venue at all', async () => {
    const payload = '[1,2,3]'
    db.rows.set('doc_notavenue', {
      id: 'doc_notavenue',
      name: 'Shopping list',
      updatedAt: '2024-04-01T10:00:00.000Z',
      payload,
    })

    // `parseDocument` never fails — it says what it could not read and starts
    // empty — so a row of junk would otherwise open as a blank venue wearing a
    // brand-new id: an empty grid with no warning, the editor remembering an id
    // that has never been saved, and the next autosave writing a second row
    // beside the one nobody can read. Null is what ProjectsModal turns into
    // "That project could not be read."
    expect(parseDocument(JSON.parse(payload)).warnings).toContain(
      'The file did not contain a CROWD document; started empty.',
    )
    expect(await storage.loadProject('doc_notavenue')).toBeNull()

    // Refusing it does not lose it: the row is still listed, so it can still be
    // downloaded away or deleted.
    const listed = await storage.listProjects()
    expect(listed.map((project) => project.name)).toEqual(['Shopping list'])
    expect(listed[0].id).toBe('doc_notavenue')

    // A venue this store actually wrote comes back as itself.
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    await storage.saveProject(hall)
    expect((await storage.loadProject(hall.id))?.id).toBe(hall.id)
  })

  it('loads a venue with its only door missing without saying so', async () => {
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    const doorWall = hall.plan.openings[0].wallId
    const damaged = {
      ...hall,
      plan: {
        ...hall.plan,
        walls: hall.plan.walls.map((wall) => (wall.id === doorWall ? 'not a wall' : wall)),
      },
    }
    const payload = JSON.stringify(damaged)
    db.rows.set(hall.id, { id: hall.id, name: hall.name, updatedAt: hall.updatedAt, payload })

    const restored = await storage.loadProject(hall.id)

    // Recorded decision: a partly damaged row is repaired and opened, and the
    // repairs are not reported. `parseDocument` counts everything it dropped,
    // but `loadProject` answers `CrowdDocument | null` and keeps only the
    // document, so this venue comes back sealed shut — the wall went and the
    // only way in or out went with it — and looks intact. Opening it beats
    // refusing it: the plan is otherwise whole, and a row this app wrote itself
    // is the user's own work. The cost is that the next run reports an
    // evacuation failure with no stated cause, and the next autosave writes the
    // sealed plan over the copy that still had the door. Telling them means
    // widening the return to carry warnings, which is a change in App.tsx and
    // ProjectsModal.tsx — the file-import path in TopBar already toasts exactly
    // these strings, so the wording is ready if it is ever worth it.
    expect(parseDocument(JSON.parse(payload)).warnings).toEqual([
      '1 wall(s) had no length or could not be read and were dropped.',
      '1 opening(s) referenced a missing wall or could not be read and were dropped.',
    ])
    expect(restored?.plan.walls).toHaveLength(3)
    expect(restored?.plan.openings).toEqual([])
    expect(restored?.name).toBe('Main hall')
  })
})

describe('when the browser will not store anything', () => {
  it('refuses a save that ran out of room rather than losing the copy on disk', async () => {
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    await storage.saveProject(hall)

    db.faults.write = new Error('QuotaExceededError')
    const expanded = {
      ...hall,
      name: 'Main hall + mezzanine',
      updatedAt: '2024-03-02T10:00:00.000Z',
    }
    await expect(storage.saveProject(expanded)).rejects.toThrow('QuotaExceededError')

    // The editor clears its dirty flag only when this promise resolves, so a
    // failure that resolved quietly would tell somebody their venue was safe
    // while the only copy on disk was still the old one.
    expect((await storage.loadProject(hall.id))?.name).toBe('Main hall')
    expect(await storage.listProjects()).toHaveLength(1)

    // One refused write must not cost the connection: the editor stays dirty
    // and tries again a couple of seconds later, and that attempt has to land.
    db.faults.write = null
    await expect(storage.saveProject(expanded)).resolves.toBeUndefined()
    expect((await storage.loadProject(hall.id))?.name).toBe('Main hall + mezzanine')
    expect(db.opens()).toBe(1)
  })

  it('reports a store it cannot read instead of calling it empty', async () => {
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    await storage.saveProject(hall)
    expect(await storage.listProjects()).toHaveLength(1)

    db.faults.read = new Error('UnknownError: internal error')
    // An empty array is what a first visit looks like, and the projects panel
    // would tell somebody with saved venues that they have none.
    await expect(storage.listProjects()).rejects.toThrow('internal error')
    await expect(storage.loadProject(hall.id)).rejects.toThrow('internal error')
  })

  it('still gives a reason when the browser refuses without giving one', async () => {
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    db.faults.write = 'silent'

    await expect(storage.saveProject(hall)).rejects.toThrow('Local storage request failed.')

    // A rejection carrying a null reason reaches the console, and any caller
    // that reports `err.message` shows the word "null" as the explanation.
    db.faults.open = 'silent'
    vi.resetModules()
    const coldStart = await import('./storage')
    await expect(coldStart.listProjects()).rejects.toThrow('Could not open local storage.')
  })

  it('says every way in is shut when there is no local database at all', async () => {
    db.uninstall()
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')

    const reason = 'IndexedDB is not available in this browser context.'
    await expect(storage.saveProject(hall)).rejects.toThrow(reason)
    await expect(storage.loadProject(hall.id)).rejects.toThrow(reason)
    await expect(storage.listProjects()).rejects.toThrow(reason)
    await expect(storage.deleteProject(hall.id)).rejects.toThrow(reason)
  })

  it('tries the database again once the browser stops blocking it', async () => {
    db.faults.open = new Error('Storage is blocked for this site.')
    const hall = venue('Main hall', '2024-03-01T10:00:00.000Z')
    await expect(storage.saveProject(hall)).rejects.toThrow('Storage is blocked for this site.')
    expect(db.rows.size).toBe(0)

    // A blocked open is usually a prompt the user has not answered yet, or a
    // moment of storage pressure. Caching the failed connection for the life of
    // the tab would leave autosave off after the condition clears, with the
    // "Save this project" button the UI offers as the way out unable to ever
    // succeed.
    db.faults.open = null
    await expect(storage.saveProject(hall)).resolves.toBeUndefined()
    expect((await storage.loadProject(hall.id))?.name).toBe('Main hall')
    expect(db.opens()).toBe(2)

    // The connection that did open is the one that is kept.
    await storage.listProjects()
    expect(db.opens()).toBe(2)
  })
})

describe('the project the editor had open last', () => {
  it('is there again on the next visit', () => {
    const entries = installLocalStorage()
    // A first visit remembers nothing, and the editor opens the starter venue.
    expect(storage.recallLastProject()).toBeNull()

    storage.rememberLastProject('doc_9fk20aq1zc')
    expect(storage.recallLastProject()).toBe('doc_9fk20aq1zc')
    // The key is a compatibility surface: change it and everyone's next visit
    // opens the starter venue instead of what they were working on.
    expect(entries.get('crowd:last-project')).toBe('doc_9fk20aq1zc')

    storage.rememberLastProject('doc_0ba7712z9k')
    expect(storage.recallLastProject()).toBe('doc_0ba7712z9k')
  })

  it('is forgotten quietly when the browser has blocked storage', () => {
    installLocalStorage({ read: true, write: true })

    expect(() => storage.rememberLastProject('doc_9fk20aq1zc')).not.toThrow()
    expect(storage.recallLastProject()).toBeNull()
  })

  it('costs nothing in a browser that has no local storage at all', () => {
    // Nothing is installed: naming `localStorage` throws a ReferenceError here,
    // exactly as it does in a locked-down webview. The editor boots through this
    // on its very first statement, so a throw would be a blank page.
    expect(() => storage.rememberLastProject('doc_9fk20aq1zc')).not.toThrow()
    expect(storage.recallLastProject()).toBeNull()
  })
})

describe('handing the venue over as a file', () => {
  beforeEach(() => {
    // The blob is released on a timer; without control of it the revocation
    // lands after the test, against a mock that has already been restored.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('offers the venue under its own name and lets go of it afterwards', async () => {
    const anchors = installDocument()
    const urls = trackObjectUrls()

    storage.downloadText('main-hall.crowd.json', '{"name":"Main hall"}')

    expect(anchors).toHaveLength(1)
    expect(anchors[0].download).toBe('main-hall.crowd.json')
    expect(anchors[0].href).toBe('blob:crowd/1')
    expect(anchors[0].clicks).toBe(1)
    // An anchor left in the page accumulates one per export for the session.
    expect(anchors[0].attached).toBe(false)
    expect(await urls.created[0].text()).toBe('{"name":"Main hall"}')
    expect(urls.created[0].type).toBe('application/json')

    // The blob has to outlive the click: revoke it early and a browser that
    // starts the download asynchronously saves an empty file.
    expect(urls.revoked).toEqual([])
    vi.advanceTimersByTime(999)
    expect(urls.revoked).toEqual([])
    vi.advanceTimersByTime(1)
    expect(urls.revoked).toEqual(['blob:crowd/1'])
  })

  it('sends a report out under the type it was asked for', async () => {
    installDocument()
    const urls = trackObjectUrls()

    storage.downloadText('main-hall.csv', 'name,count\nMain hall,240\n', 'text/csv')

    // A CSV handed over as application/json opens in the wrong app, or as a
    // download the browser warns about.
    expect(urls.created[0].type).toBe('text/csv')
    expect(await urls.created[0].text()).toBe('name,count\nMain hall,240\n')
  })

  it('passes a rendered image straight through rather than rewrapping it', () => {
    const anchors = installDocument()
    const urls = trackObjectUrls()
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

    storage.downloadBlob('main-hall.png', png)

    // Identity, not equality: re-encoding binary through a string would corrupt
    // every snapshot the results panel exports.
    expect(urls.created[0]).toBe(png)
    expect(anchors[0].download).toBe('main-hall.png')
    expect(anchors[0].clicks).toBe(1)
    expect(anchors[0].attached).toBe(false)
  })

  it('never hands the import dialog the word "null" to work with', async () => {
    const reads = installFileReader({ result: null })
    await expect(storage.readFileAsText(new File([], 'venue.crowd.json'))).resolves.toBe('')
    expect(reads).toEqual(['text'])

    // Some browsers fire onerror with `reader.error` still unset; without the
    // fallback the import dialog would show "null" as the reason.
    installFileReader({ error: null })
    await expect(storage.readFileAsText(new File([], 'venue.crowd.json'))).rejects.toThrow(
      'Could not read that file.',
    )
  })

  it('reads a traced floor plan as a data URL, not as text', async () => {
    const src = 'data:image/png;base64,iVBORw0KGgo='
    const reads = installFileReader({ result: src })

    // The backdrop is stored in the document as its own `src`, so a bitmap read
    // as text would be saved into the plan as mojibake and never render.
    await expect(storage.readFileAsDataUrl(new File([], 'floor.png'))).resolves.toBe(src)
    expect(reads).toEqual(['data-url'])

    installFileReader({ error: null })
    await expect(storage.readFileAsDataUrl(new File([], 'floor.png'))).rejects.toThrow(
      'Could not read that image.',
    )
  })
})

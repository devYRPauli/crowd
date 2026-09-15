/**
 * Local project storage.
 *
 * Projects live in IndexedDB so a plan with a traced floor-plan bitmap still
 * fits comfortably. Everything degrades: if IndexedDB is unavailable (private
 * browsing, an embedded webview) the app keeps working in memory and simply
 * reports that autosave is off.
 */

import type { CrowdDocument } from '../model/types'
import { parseDocument } from './serialize'

const DB_NAME = 'crowd'
const DB_VERSION = 1
const STORE = 'documents'

export interface StoredProject {
  id: string
  name: string
  updatedAt: string
  /** Rough size on disk, for the project list. */
  bytes: number
}

let dbPromise: Promise<IDBDatabase> | null = null

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser context.'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'))
  })
  return dbPromise
}

const tx = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'))
  })
}

interface Row {
  id: string
  name: string
  updatedAt: string
  payload: string
}

export const saveProject = async (doc: CrowdDocument): Promise<void> => {
  const payload = JSON.stringify(doc)
  const row: Row = { id: doc.id, name: doc.name, updatedAt: doc.updatedAt, payload }
  await tx('readwrite', (store) => store.put(row) as IDBRequest<IDBValidKey>)
}

export const loadProject = async (id: string): Promise<CrowdDocument | null> => {
  const row = await tx<Row | undefined>(
    'readonly',
    (store) => store.get(id) as IDBRequest<Row | undefined>,
  )
  if (!row) return null
  try {
    return parseDocument(JSON.parse(row.payload)).document
  } catch {
    return null
  }
}

export const listProjects = async (): Promise<StoredProject[]> => {
  const rows = await tx<Row[]>('readonly', (store) => store.getAll() as IDBRequest<Row[]>)
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt,
      bytes: row.payload.length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export const deleteProject = async (id: string): Promise<void> => {
  await tx('readwrite', (store) => store.delete(id) as IDBRequest<undefined>)
}

const LAST_KEY = 'crowd:last-project'

export const rememberLastProject = (id: string): void => {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    // Storage can be blocked; remembering the last project is a convenience.
  }
}

export const recallLastProject = (): string | null => {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

/** Trigger a browser download of arbitrary text. */
export const downloadText = (filename: string, text: string, mime = 'application/json'): void => {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const downloadBlob = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Read a user-picked file as text. */
export const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'))
    reader.readAsText(file)
  })

export const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that image.'))
    reader.readAsDataURL(file)
  })

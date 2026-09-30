import { useEditor } from '../state/editorStore'
import { documentFileName, serializeDocument } from '../core/document/serialize'
import { downloadText, rememberLastProject, saveProject } from '../core/document/storage'

/**
 * Download the venue and bank the same version in the browser, then say which
 * of the two happened. The toast used to go up before the write had settled,
 * so a browser that refused it still reported the project saved.
 */
export const downloadProject = async (): Promise<void> => {
  const { document, markSaved, toast } = useEditor.getState()
  downloadText(documentFileName(document), serializeDocument(document))
  try {
    await saveProject(document)
  } catch {
    toast('Project downloaded, but this browser would not keep a copy.', 'warn')
    return
  }
  // Marking it saved cancels the autosave that would have remembered it, and
  // a reload after a save reopened whichever venue was remembered before.
  rememberLastProject(document.id)
  markSaved(document)
  toast('Project downloaded and saved.', 'success')
}

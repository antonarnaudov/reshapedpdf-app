import { FilePlus2, FileText, FolderOpen } from 'lucide-react'
import { newBlankDoc, openFilePicker, openSample } from '../core/actions'
import { BrandMark } from './TopBar'

export function EmptyState(): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-brand">
        <BrandMark size={46} />
        <span className="empty-word">Reshaped<em>PDF</em></span>
      </div>
      <div className="empty-tag">Every PDF is just material. Reshape it — edits that look like they were printed that way.</div>

      <div
        className="drop-ring"
        onClick={() => void openFilePicker()}
        onDragOver={(e) => {
          e.preventDefault()
          e.currentTarget.classList.add('armed')
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('armed')}
      >
        <h3>Drop a PDF on the bench</h3>
        <p>…or click to browse. Images become PDFs too. Everything stays on your machine.</p>
      </div>

      <div className="empty-actions">
        <button className="btn primary" onClick={() => void openFilePicker()}>
          <FolderOpen size={15} /> Open PDF
        </button>
        <button className="btn outline" onClick={() => void openSample()}>
          <FileText size={15} /> Try the sample
        </button>
        <button className="btn outline" onClick={() => void newBlankDoc()}>
          <FilePlus2 size={15} /> New blank
        </button>
      </div>

      <div className="empty-hints">
        <span><span className="kbd">⌘K</span> command palette</span>
        <span><span className="kbd">⌘O</span> open</span>
        <span><span className="kbd">?</span> shortcuts</span>
      </div>
    </div>
  )
}

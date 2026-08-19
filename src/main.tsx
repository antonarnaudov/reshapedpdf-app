import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/spline-sans-mono'
import './styles/app.css'
import { App } from './components/App'
import { useStore } from './core/store'

document.documentElement.dataset.theme = useStore.getState().theme

class Foundry extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ReshapedPDF crashed:', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <div className="empty-brand"><span className="empty-word">Sparks flew.</span></div>
        <div className="empty-tag" style={{ maxWidth: 460, textAlign: 'center' }}>
          Something broke on the bench. Your files on disk are untouched — reload to keep working.
        </div>
        <div className="empty-actions">
          <button className="btn primary" onClick={() => window.location.reload()}>Reload ReshapedPDF</button>
        </div>
        <pre style={{ marginTop: 18, fontSize: 11, color: 'var(--ink-faint)', maxWidth: 560, overflow: 'auto', userSelect: 'text' }}>
          {String(this.state.error)}
        </pre>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Foundry>
      <App />
    </Foundry>
  </React.StrictMode>,
)

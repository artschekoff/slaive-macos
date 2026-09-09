import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  copyText,
  hideOverlay,
  openPrivacyPane,
  pasteText,
  startRecording,
  stopRecording,
  type PrivacyPane,
} from './api'

type Phase = 'idle' | 'recording' | 'transcribing' | 'ready' | 'error'

const LABEL: Record<Phase, string> = {
  idle: 'Hold the hotkey and speak',
  recording: 'Recording…',
  transcribing: 'Transcribing…',
  ready: 'Done — Paste sends the text back to where you were',
  error: 'Error',
}

type AccessibilityErrorPayload = { message: string; pane: PrivacyPane }

export function Overlay() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [permissionPane, setPermissionPane] = useState<PrivacyPane | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const subs = [
      listen('rec:start', () => {
        setPhase('recording')
        setText('')
        setError('')
        setPermissionPane(null)
      }),
      listen('rec:stop', () => setPhase('transcribing')),
      listen<string>('transcript', (e) => {
        setText(e.payload)
        setPhase('ready')
      }),
      listen<string>('error', (e) => {
        setError(e.payload)
        setPhase('error')
        // Обычная ошибка может прийти после отказа в правах — флаг из того
        // случая не должен пережить её и оставить лишнюю кнопку в панели.
        setPermissionPane(null)
      }),
      listen<AccessibilityErrorPayload>('error:accessibility', (e) => {
        setError(e.payload.message)
        setPermissionPane(e.payload.pane)
        setPhase('error')
      }),
    ]
    return () => {
      subs.forEach((p) => p.then((un) => un()))
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleMic = () => {
    // Во время расшифровки микрофон неактивен: предыдущая запись ещё
    // обрабатывается, и вторая перетёрла бы её результат.
    if (phase === 'transcribing') return
    if (phase === 'recording') stopRecording()
    else startRecording()
  }

  // I6: провал вставки/копирования раньше не производил вообще ничего —
  // успех и отказ были неотличимы. Отказ идёт в уже существующую
  // поверхность ошибок, успех копирования — во временное подтверждение.
  const onPaste = () => {
    pasteText(text).catch((e) => {
      setError(String(e))
      setPhase('error')
      setPermissionPane(null)
    })
  }

  const onCopy = () => {
    copyText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((e) => {
        setError(String(e))
        setPhase('error')
        setPermissionPane(null)
      })
  }

  return (
    <div className="overlay">
      <div className="row">
        <div
          className={`mic ${phase === 'recording' ? 'live' : ''} ${phase === 'transcribing' ? 'busy' : ''}`}
          onClick={toggleMic}
        >
          🎤
        </div>
        <div className="status">{phase === 'error' ? error : LABEL[phase]}</div>
      </div>
      <div className="transcript">{text || <span className="dim">—</span>}</div>
      <div className="actions">
        <button className="primary" disabled={!text} onClick={onPaste}>
          Paste
        </button>
        <button disabled={!text} onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={() => hideOverlay()}>Close</button>
        {permissionPane && (
          <button onClick={() => openPrivacyPane(permissionPane)}>Open Settings</button>
        )}
      </div>
    </div>
  )
}

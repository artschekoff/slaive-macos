import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { hideOverlay, startRecording, stopRecording } from './api'

type Phase = 'idle' | 'recording' | 'transcribing' | 'ready' | 'error'

const LABEL: Record<Phase, string> = {
  idle: 'Зажми хоткей и говори',
  recording: 'Записываю…',
  transcribing: 'Расшифровываю…',
  ready: 'Готово',
  error: 'Ошибка',
}

export function Overlay() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const subs = [
      listen('rec:start', () => {
        setPhase('recording')
        setText('')
        setError('')
      }),
      listen('rec:stop', () => setPhase('transcribing')),
      listen<string>('transcript', (e) => {
        setText(e.payload)
        setPhase('ready')
      }),
      listen<string>('error', (e) => {
        setError(e.payload)
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
    if (phase === 'recording') stopRecording()
    else startRecording()
  }

  return (
    <div className="overlay">
      <div className="row">
        <div className={`mic ${phase === 'recording' ? 'live' : ''}`} onClick={toggleMic}>
          🎤
        </div>
        <div className="status">{phase === 'error' ? error : LABEL[phase]}</div>
      </div>
      <div className="transcript">{text || <span className="dim">—</span>}</div>
      <div className="actions">
        <button onClick={() => hideOverlay()}>Закрыть</button>
      </div>
    </div>
  )
}

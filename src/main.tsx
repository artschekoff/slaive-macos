import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Settings } from './Settings'
import './styles.css'

const label = getCurrentWebviewWindow().label

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {label === 'settings' ? <Settings /> : <div className="placeholder">Slaive</div>}
  </React.StrictMode>
)

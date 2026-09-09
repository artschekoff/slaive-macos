import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Settings } from './Settings'
import { Overlay } from './Overlay'
import './styles.css'

const label = getCurrentWebviewWindow().label

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {label === 'settings' ? <Settings /> : <Overlay />}
  </React.StrictMode>
)

import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Settings } from './Settings'
import { Overlay } from './Overlay'
import { MainWindow } from './MainWindow'
import './styles.css'

const label = getCurrentWebviewWindow().label

function routeByLabel() {
  if (label === 'settings') return <Settings />
  if (label === 'main') return <MainWindow />
  return <Overlay />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{routeByLabel()}</React.StrictMode>
)

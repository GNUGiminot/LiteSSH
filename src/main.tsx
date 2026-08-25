import React from 'react'
import ReactDOM from 'react-dom/client'
// Встроенные шрифты (бандлятся в приложение, без обращения к сети)
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource-variable/jetbrains-mono'
import App from './App'
import './index.css'
import '@xterm/xterm/css/xterm.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

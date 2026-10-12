import { StrictMode } from 'react'
import { BrowserRouter } from 'react-router'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initializeWallpaper } from './preferences/wallpaper'
import App from './App.tsx'

void initializeWallpaper()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter useTransitions={false}><App /></BrowserRouter>
  </StrictMode>,
)

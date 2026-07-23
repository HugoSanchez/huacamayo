import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './Toaster';
import { installWindowDrag } from './window-drag';
import './styles.css';
import 'highlight.js/styles/github-dark.min.css';

// Let the native shell drag the window from `[data-window-drag]` regions
// (e.g. the chat header) — no-op in the browser shell.
installWindowDrag();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

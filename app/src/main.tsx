import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

import { initWebBridge } from './lib/web-bridge';
import { FALLBACK_STATE } from './hooks/useSharedState';

if (typeof window !== 'undefined' && !window.desktopBridge) {
  window.desktopBridge = initWebBridge(FALLBACK_STATE);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);


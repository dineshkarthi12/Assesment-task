import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

// Last line of defence: App has narrower boundaries around the list and the
// detail panel, so this only shows if the frame itself fails to render.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={() => (
        <div className="state state--error" role="alert">
          <p className="state__title">MediaVault hit a problem it couldn’t recover from</p>
          <p className="state__detail">Reloading keeps your search and filters, which are in the address.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { type Deps } from './App.tsx';
import { createApi } from './api.ts';
import { browserEventSource } from './events.ts';
import './styles.css';

async function loadDeps(): Promise<Deps> {
  // Dev-only fake backend. import.meta.env.DEV is statically false in production builds, so
  // the fake module is dropped from the bundle.
  if (import.meta.env.DEV && import.meta.env.VITE_FAKE_API === 'true') {
    const { createFakeDeps } = await import('./fake/fakeApi.ts');
    return createFakeDeps();
  }
  return { api: createApi(), eventSource: browserEventSource };
}

void loadDeps().then((deps) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App deps={deps} />
    </StrictMode>,
  );
});

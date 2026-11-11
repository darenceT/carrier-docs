import { useEffect, useState } from 'react';

type Health = 'checking' | 'ok' | 'down';

export default function App() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    fetch('/healthz')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { ok?: boolean }) => setHealth(body.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
  }, []);

  return (
    <main>
      <h1>Carrier Docs</h1>
      <p>Hello. Policy document retrieval is coming in Phase 3.</p>
      <p data-testid="health">Server: {health}</p>
    </main>
  );
}

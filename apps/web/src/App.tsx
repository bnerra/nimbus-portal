import { useState } from 'react';
import { FeedCatalog } from './components/FeedCatalog';
import { FeedLatencyChart } from './components/FeedLatencyChart';
import { SystemHealth } from './components/SystemHealth';
import { FeedStatusGrid } from './components/FeedStatusGrid';

export function App() {
  // Chart code state lives here, in the closest common parent: the grid SETS it, the chart READS it.
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">Nimbus Market Data</div>
            <div className="brand-sub">Client Portal</div>
          </div>
        </div>
        <span className="env-badge">Local dev</span>
      </header>

      <main className="content">
        <SystemHealth />
        <FeedStatusGrid selectedCode={selectedCode} onSelect={setSelectedCode} />
        <FeedLatencyChart code={selectedCode} />
        <FeedCatalog />
      </main>
    </div>
  );
}

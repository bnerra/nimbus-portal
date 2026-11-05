import { useState } from 'react';
import { FeedCatalog } from './components/FeedCatalog';
import { FeedLatencyChart } from './components/FeedLatencyChart';
import { SystemHealth } from './components/SystemHealth';
import { FeedStatusGrid } from './components/FeedStatusGrid';
import { useLiveFeedStatus } from './useLiveFeedStatus';

export function App() {
  // Chart code state lives here, in the closest common parent: the grid SETS it, the chart READS it.
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  // The live stream, opened ONCE here because both the grid and the chart
  // need to know whether it's connected (lifting state up, again).
  const liveState = useLiveFeedStatus();

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
        <FeedStatusGrid
          liveState={liveState}
          selectedCode={selectedCode}
          onSelect={setSelectedCode}
        />
        <FeedLatencyChart code={selectedCode} liveState={liveState} />
        <FeedCatalog />
      </main>
    </div>
  );
}

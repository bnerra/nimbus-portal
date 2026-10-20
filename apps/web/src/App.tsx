import { FeedCatalog } from './components/FeedCatalog';
import { SystemHealth } from './components/SystemHealth';
import { FeedStatusGrid } from './components/FeedStatusGrid';

export function App() {
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
        <FeedStatusGrid />
        <FeedCatalog />
      </main>
    </div>
  );
}

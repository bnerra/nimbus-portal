import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

// StrictMode runs extra checks in development (including running effects
// twice) to surface bugs like missing cleanup. It does nothing in production.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

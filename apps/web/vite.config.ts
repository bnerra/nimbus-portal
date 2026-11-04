import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // loadEnv with an empty prefix reads every environment variable (and any
  // .env file in this folder). Used below to point the proxy at a different
  // API, e.g. a second instance on port 4001 for the Phase 4 Redis demo.
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    server: {
      // If 5173 is taken (e.g. a second dev server), Vite moves to 5174.
      port: 5173,
      // The dev proxy: the browser calls http://localhost:5173/api/..., and
      // Vite forwards it to the API. To the browser it's all one origin, so
      // there are no CORS headaches. In production a reverse proxy (Nginx, a
      // load balancer) plays the same role.
      proxy: {
        '/api': env.API_PROXY_TARGET || 'http://localhost:4000',
      },
    },
  };
});

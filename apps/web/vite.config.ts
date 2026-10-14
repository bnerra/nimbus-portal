import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dev proxy: the browser calls http://localhost:5173/api/..., and
    // Vite forwards it to the API on port 4000. To the browser it's all one
    // origin, so there are no CORS headaches. In production a reverse proxy
    // (Nginx, a load balancer) plays the same role.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});

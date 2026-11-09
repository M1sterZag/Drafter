import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Адрес backend для dev-прокси (переопределяется в e2e-тестах)
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Проксирование запросов к backend
    proxy: {
      '/api': {
        target: backendUrl,
        changeOrigin: true,
      },
      '/socket.io': {
        target: backendUrl,
        changeOrigin: true,
        ws: true, // Важно для WebSocket!
      }
    }
  }
});
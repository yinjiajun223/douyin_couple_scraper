import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '^/(ai-connections|audit-events|auth|campaign-templates|campaigns|candidates|collector|dashboard|devices|health|invitations|media|members|runs)(/|\\?|$)':
        {
          changeOrigin: true,
          secure: false,
          target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
        },
    },
  },
});

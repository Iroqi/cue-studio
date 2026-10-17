import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // The heavy static libs get their own chunks: a redeploy that only touches app code
        // keeps the cached copies of three/katex/pi-ai/react instead of re-downloading one
        // 2 MB blob, and the per-chunk size warning stops being a real signal.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three'
          if (id.includes('node_modules/katex')) return 'katex'
          if (id.includes('node_modules/@earendil-works')) return 'pi-ai'
          if (id.includes('node_modules/react')) return 'react'
          if (id.includes('node_modules/dompurify')) return 'dompurify'
        },
      },
    },
    // three (~566 kB) and pi-ai (~683 kB) are monolithic SDKs that cannot be split further
    // without dynamic imports; the app code now ships as its own small chunk, so the old
    // single-2 MB-blob signal is gone. 700 leaves the two irreducible vendors below the bell.
    chunkSizeWarningLimit: 700,
  },
})

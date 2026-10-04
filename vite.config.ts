import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const mainnetRpcProxy = {
  '/arc-rpc': {
    target: 'https://rpc.mainnet.arc.io',
    changeOrigin: true,
    rewrite: () => '/',
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      ...mainnetRpcProxy,
      '/arc-testnet-rpc': {
        target: 'https://rpc.testnet.arc.io',
        changeOrigin: true,
        rewrite: () => '/',
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: mainnetRpcProxy,
  },
})

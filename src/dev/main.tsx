import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import DeployLab from './DeployLab'
import './lab.css'

const network = new URLSearchParams(window.location.search).get('network') === 'mainnet' ? 'mainnet' : 'testnet'
const root = document.getElementById('root')
if (!root) throw new Error('Local deployment lab root is missing')
createRoot(root).render(
  <StrictMode>
    <DeployLab network={network} />
  </StrictMode>,
)

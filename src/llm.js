export const WEBLLM_MODELS = [
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B (Recommended, ~2 GB)' },
  { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B (Fast/Light, ~0.9 GB)' },
  { id: 'Qwen2.5-3B-Instruct-q4f32_1-MLC',   label: 'Qwen 2.5 3B (~2 GB)' },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 Mini (~2.2 GB)' },
  { id: 'gemma-2-2b-it-q4f32_1-MLC',         label: 'Gemma 2 2B (~1.5 GB)' },
]

let _worker      = null
let _status      = 'idle'   // idle | loading | ready | error
let _loadResolve = null
let _loadReject  = null
let _pendingChats = {}
let _onProgress  = null
let _genCounter  = 0

function _ensureWorker() {
  if (_worker) return
  // import.meta.url is resolved by Vite at build time — always correct path on GitHub Pages
  _worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  _worker.onmessage = _handleMessage
  _worker.onerror   = (e) => {
    _status = 'error'
    const msg = e.message ?? 'Worker crashed'
    if (_loadReject) { _loadReject(new Error(msg)); _loadResolve = _loadReject = null }
  }
}

function _handleMessage({ data: msg }) {
  switch (msg.status) {
    case 'device_detected':
      _onProgress?.({ type: 'device' })
      break
    case 'phase':
      _onProgress?.({ type: 'phase', phase: msg.phase, note: msg.note })
      break
    case 'downloading':
      _onProgress?.({ type: 'downloading', file: msg.file, progress: msg.progress })
      break
    case 'ready':
      _status = 'ready'
      _onProgress?.({ type: 'ready' })
      if (_loadResolve) { _loadResolve(); _loadResolve = _loadReject = null }
      break
    case 'chat_result':
      if (_pendingChats[msg.id]) { _pendingChats[msg.id].resolve(msg.text); delete _pendingChats[msg.id] }
      break
    case 'chat_error':
      if (_pendingChats[msg.id]) { _pendingChats[msg.id].reject(new Error(msg.error)); delete _pendingChats[msg.id] }
      break
    case 'error':
      _status = 'error'
      _onProgress?.({ type: 'error', error: msg.error })
      if (_loadReject) { _loadReject(new Error(msg.error)); _loadResolve = _loadReject = null }
      Object.values(_pendingChats).forEach(p => p.reject(new Error(msg.error)))
      _pendingChats = {}
      break
  }
}

export function loadModel(modelId, onProgress) {
  _ensureWorker()
  _status     = 'loading'
  _onProgress = onProgress ?? null
  _genCounter++
  return new Promise((resolve, reject) => {
    _loadResolve = resolve
    _loadReject  = reject
    _worker.postMessage({ action: 'load', modelId, gen: _genCounter })
  })
}

export function callLLM(messages) {
  if (_status !== 'ready' || !_worker)
    return Promise.reject(new Error('Model not loaded. Load a WebLLM model first.'))
  const id = ++_genCounter
  return new Promise((resolve, reject) => {
    _pendingChats[id] = { resolve, reject }
    _worker.postMessage({ action: 'chat', id, messages })
  })
}

export function isReady() { return _status === 'ready' }

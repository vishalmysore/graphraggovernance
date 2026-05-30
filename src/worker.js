import { CreateMLCEngine } from '@mlc-ai/web-llm'

let engine        = null
let loadAborted   = false
let currentGen    = -1

function post(msg) {
  self.postMessage({ gen: currentGen, ...msg })
}

async function disposeCurrent() {
  if (engine) {
    try { await engine.unload() } catch (_) {}
    engine = null
  }
}

self.onmessage = async (e) => {
  const { action, modelId, messages, id, gen } = e.data

  // ── Load ─────────────────────────────────────────────────────────
  if (action === 'load') {
    loadAborted = false
    currentGen  = gen ?? 0
    await disposeCurrent()

    if (!modelId) { post({ status: 'error', error: 'No model ID provided.' }); return }

    try {
      const adapter = await navigator.gpu?.requestAdapter()
      if (!adapter) {
        post({ status: 'error', error: 'WebGPU not available. Use Chrome 113+ on a machine with a GPU.' })
        return
      }
      post({ status: 'device_detected', device: 'webgpu' })
    } catch (err) {
      post({ status: 'error', error: `WebGPU check failed: ${err?.message ?? err}` })
      return
    }

    post({ status: 'phase', phase: 'download', note: 'Downloading model weights…' })

    try {
      engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (progress) => {
          if (loadAborted) return
          const text = progress.text ?? ''
          const pct  = Math.round((progress.progress ?? 0) * 100)
          post({ status: 'downloading', file: text, progress: pct })
        },
      })

      if (loadAborted) { await disposeCurrent(); return }
      post({ status: 'ready', modelId })

    } catch (err) {
      if (loadAborted) return
      post({ status: 'error', error: err?.message ?? String(err) })
    }

  // ── Chat ──────────────────────────────────────────────────────────
  } else if (action === 'chat') {
    if (!engine) { post({ status: 'error', error: 'No model loaded.' }); return }
    try {
      const resp = await engine.chat.completions.create({
        messages,
        max_tokens: 4096,
        temperature: 0,
      })
      self.postMessage({ status: 'chat_result', id, text: resp.choices[0].message.content })
    } catch (err) {
      self.postMessage({ status: 'chat_error', id, error: err?.message ?? String(err) })
    }

  // ── Cancel ────────────────────────────────────────────────────────
  } else if (action === 'cancel') {
    loadAborted = true
    await disposeCurrent()
    self.postMessage({ status: 'cancelled' })
  }
}

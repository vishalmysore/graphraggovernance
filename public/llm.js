const WEBLLM_MODELS = [
    { id: 'Llama-3.2-3B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 3B (Recommended)' },
    { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B (Fast/Light)' },
    { id: 'Qwen2.5-3B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 3B' },
    { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 Mini' },
    { id: 'gemma-2-2b-it-q4f32_1-MLC', label: 'Gemma 2 2B' },
];

// Resolve worker path relative to this script's location (handles GitHub Pages subpaths)
const _SCRIPT_BASE = (() => {
    const src = document.currentScript?.src || '';
    return src ? src.substring(0, src.lastIndexOf('/') + 1) : './';
})();

let worker = null;
let workerReady = false;
let pendingRequests = {};
let requestCounter = 0;

function initWorker(onProgress) {
    return new Promise((resolve, reject) => {
        worker = new Worker(_SCRIPT_BASE + 'worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') {
                if (onProgress) onProgress(data.text, data.progress);
            } else if (data.type === 'ready') {
                workerReady = true;
                resolve();
            } else if (data.type === 'error') {
                if (data.id && pendingRequests[data.id]) {
                    pendingRequests[data.id].reject(new Error(data.message));
                    delete pendingRequests[data.id];
                } else {
                    reject(new Error(data.message));
                }
            } else if (data.type === 'chat_result') {
                if (pendingRequests[data.id]) {
                    pendingRequests[data.id].resolve(data.text);
                    delete pendingRequests[data.id];
                }
            } else if (data.type === 'chat_error') {
                if (pendingRequests[data.id]) {
                    pendingRequests[data.id].reject(new Error(data.message));
                    delete pendingRequests[data.id];
                }
            }
        };
        worker.onerror = (e) => reject(new Error(e.message));
    });
}

async function loadModel(modelId, onProgress) {
    workerReady = false;
    if (worker) { worker.terminate(); worker = null; }
    await initWorker(onProgress);
    worker.postMessage({ type: 'load', modelId });
    // initWorker promise resolves on 'ready'
    return new Promise((resolve, reject) => {
        const orig = worker.onmessage;
        worker.onmessage = ({ data }) => {
            orig({ data });
            if (data.type === 'ready') resolve();
            else if (data.type === 'error' && !data.id) reject(new Error(data.message));
        };
    });
}

function callLLM(messages) {
    if (!workerReady) return Promise.reject(new Error('Model not loaded'));
    const id = ++requestCounter;
    return new Promise((resolve, reject) => {
        pendingRequests[id] = { resolve, reject };
        worker.postMessage({ type: 'chat', id, messages });
    });
}

function isReady() { return workerReady; }

window.LLM = { WEBLLM_MODELS, loadModel, callLLM, isReady };

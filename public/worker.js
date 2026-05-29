import { CreateMLCEngine } from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm";

let engine = null;

self.onmessage = async ({ data }) => {
    if (data.type === 'load') {
        try {
            engine = await CreateMLCEngine(data.modelId, {
                initProgressCallback: (p) => {
                    self.postMessage({ type: 'progress', text: p.text, progress: p.progress });
                }
            });
            self.postMessage({ type: 'ready' });
        } catch (e) {
            self.postMessage({ type: 'error', message: e.message });
        }

    } else if (data.type === 'chat') {
        if (!engine) {
            self.postMessage({ type: 'chat_error', id: data.id, message: 'Model not loaded' });
            return;
        }
        try {
            const resp = await engine.chat.completions.create({
                messages: data.messages,
                max_tokens: 4096,
                temperature: 0
            });
            self.postMessage({ type: 'chat_result', id: data.id, text: resp.choices[0].message.content });
        } catch (e) {
            self.postMessage({ type: 'chat_error', id: data.id, message: e.message });
        }
    }
};

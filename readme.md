# GraphRAG Governance

A tool for comparing AI governance frameworks side-by-side using knowledge graphs.

## What's this about?

If you've ever tried to figure out how the EU AI Act stacks up against Singapore's Model AI Governance Framework, you know it's a nightmare. Different terminology, different structures, different regulatory philosophies — one is legally binding with steep fines, the other is voluntary guidance. Trying to map concepts across these documents manually is tedious and error-prone.

This project tackles that problem by turning each governance framework into a knowledge graph — nodes representing concepts like "risk classification" or "human oversight," connected by typed relationships like *requires*, *defines*, *prohibits*. Once you have both frameworks as graphs, you can align them programmatically and see exactly where they overlap, where they diverge, and where one framework covers something the other doesn't touch.

## How it works

1. **Upload or use sample data** — Drop in a PDF of a governance framework, or flip on Mock Mode to use the pre-built EU AI Act and Singapore samples.
2. **Graph extraction** — The system parses the document and builds a JSON-LD knowledge graph with entities (regulations, risk categories, requirements, principles) and their relationships.
3. **Canonical alignment** — Each concept gets a `canonical_id` so that "Human Oversight" in the EU AI Act can be matched to "Human Oversight of AI" in Singapore's framework, even though the names differ.
4. **4-way comparison** — The engine classifies every concept into one of four buckets:
   - **Match** — Same concept exists in both frameworks
   - **Missing** — Exists in the base framework but not the variant
   - **Extension** — Exists in the variant but not the base
   - **Conflict** — Same concept, but the attributes differ (e.g., mandatory vs. voluntary)
5. **Visual exploration** — An interactive graph visualization lets you click through nodes, inspect relationships, and drill into conflicts.

## Quick start

```bash
npm install
node server.mjs
```

Open `http://localhost:3002` in your browser. Toggle **Mock Mode** to load the EU AI Act vs Singapore comparison without needing an API key.

To use with your own documents, configure an OpenAI-compatible API endpoint in the control panel and upload a PDF.

## Project structure

```
server.mjs                  → Express backend (port 3002)
services/
  graphEngine.mjs            → Comparison engine (canonical matching, diff)
  openai.mjs                 → LLM integration for graph extraction
public/
  index.html                 → UI shell
  app.js                     → Vis.js graph rendering + interaction
  style.css                  → Dark glass-morphism theme
samples/
  eu_ai_act.jsonld           → Pre-built EU AI Act knowledge graph (40 entities)
  singapore_model_ai_governance.jsonld → Pre-built Singapore framework (34 entities)
```

## What the comparison actually reveals

Running the EU AI Act against Singapore's framework surfaces some interesting findings:

- **Matches** — Both frameworks share concepts like risk classification, human oversight, transparency, bias detection, and incident reporting. The philosophical alignment is real.
- **Conflicts** — The big one: the EU mandates most requirements by law, while Singapore recommends them voluntarily. Same concept, fundamentally different enforcement.
- **EU-only concepts** — Prohibited practices (social scoring, biometric bans), CE marking, conformity assessment, GPAI rules, penalties up to 7% of global turnover. The regulatory teeth are unique to the EU.
- **Singapore-only concepts** — AI Verify testing toolkit, sector-specific guidance (finance, healthcare), ethics review boards, the three-tier human oversight model (in-the-loop, over-the-loop, out-of-the-loop). More nuanced on implementation.

## Tech stack

- **Backend**: Node.js, Express
- **Frontend**: Vis.js (graph visualization), vanilla JS
- **LLM**: Any OpenAI-compatible API (tested with NVIDIA endpoints)
- **Data format**: JSON-LD with typed relationships

## License

MIT

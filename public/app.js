/**
 * GraphRAG Governance — Frontend Logic
 * AI Framework Alignment & Knowledge Graph Comparison
 * Uses WebLLM for local in-browser inference (no API key required)
 */

/* ========== TAB SWITCHING ========== */

function switchTab(tab) {
    document.getElementById('tabFramework').style.display = tab === 'framework' ? '' : 'none';
    document.getElementById('tabSearch').style.display = tab === 'search' ? '' : 'none';
    document.getElementById('tabBtnFramework').classList.toggle('active', tab === 'framework');
    document.getElementById('tabBtnSearch').classList.toggle('active', tab === 'search');
}

function switchToFrameworkTab() {
    switchTab('framework');
}

/* ========== WEB SEARCH ========== */

let searchCombinedText = null;
let searchNetwork = null;

function setSearchStatus(msg, type = '') {
    const el = document.getElementById('searchStatus');
    el.innerText = msg;
    el.className = 'status-bar ' + type;
}

function setSearchProgress(text, pct) {
    const div = document.getElementById('searchProgress');
    const bar = document.getElementById('searchProgressBar');
    const label = document.getElementById('searchProgressText');
    if (text === null) { div.style.display = 'none'; return; }
    div.style.display = '';
    label.innerText = text;
    if (pct !== undefined) bar.style.width = Math.round(pct * 100) + '%';
}

async function runWebSearch() {
    const query = document.getElementById('searchQuery').value.trim();
    if (!query) { setSearchStatus('Enter a search query.', 'error'); return; }

    setSearchStatus(`Searching for "${query}"...`, 'loading');
    document.getElementById('searchResults').style.display = 'none';
    document.getElementById('searchGraphArea').style.display = 'none';
    searchCombinedText = null;

    try {
        const resp = await axios.post('/api/web-search', { query, maxPages: 3 });
        const { pages, combinedText } = resp.data;

        searchCombinedText = combinedText;

        // Show source chips
        const list = document.getElementById('searchResultsList');
        list.innerHTML = '';
        pages.forEach(p => {
            const a = document.createElement('a');
            a.className = 'search-chip';
            a.href = p.url;
            a.target = '_blank';
            a.title = p.url;
            a.textContent = '🔗 ' + (p.title || p.url).substring(0, 40);
            list.appendChild(a);
        });

        document.getElementById('searchResults').style.display = '';
        setSearchStatus(`Found ${pages.length} source(s). Load a model then build a graph.`, 'success');
    } catch (e) {
        setSearchStatus('Search failed: ' + (e.response?.data?.error || e.message), 'error');
    }
}

async function buildSearchGraph(role) {
    if (!searchCombinedText) { setSearchStatus('Run a search first.', 'error'); return; }
    if (!LLM.isReady()) { setSearchStatus('Please load a local model first (Framework Analysis tab).', 'error'); return; }

    const query = document.getElementById('searchQuery').value.trim();
    document.getElementById('btnSearchBase').disabled = true;
    document.getElementById('btnSearchVariant').disabled = true;
    setSearchProgress('Inferring schema from search results...', 0.1);

    try {
        const schema = await inferSchemaLocal(query, searchCombinedText);
        setSearchProgress('Building knowledge graph...', 0.5);

        const graph = await generateGraphLocal(searchCombinedText, schema, {
            country: 'Web',
            source: `Web Search: ${query}`
        });
        setSearchProgress(null);

        // Render in search graph area
        const nodes = (graph['@graph'] || []);
        document.getElementById('searchGraphLabel').textContent =
            role === 'base' ? '📊 Base Graph (from web search)' : '🔀 Variant Graph (from web search)';
        document.getElementById('searchNodeCount').textContent = nodes.length;
        document.getElementById('searchGraphArea').style.display = '';
        renderSearchGraph(nodes);

        // Load into framework tab state
        if (role === 'base') {
            graphBase = graph;
            setSearchStatus(`Graph loaded as Base (${nodes.length} nodes). Switch to Framework Analysis to compare.`, 'success');
        } else {
            graphVariant = graph;
            setSearchStatus(`Graph loaded as Variant (${nodes.length} nodes). Switch to Framework Analysis to compare.`, 'success');
        }
    } catch (e) {
        setSearchProgress(null);
        setSearchStatus('Graph build failed: ' + e.message, 'error');
    } finally {
        document.getElementById('btnSearchBase').disabled = false;
        document.getElementById('btnSearchVariant').disabled = false;
    }
}

function renderSearchGraph(rawNodes) {
    const flat = flattenGraph(rawNodes);
    const nodes = flat.map(n => ({
        id: n.id,
        label: `${n.name || n.id}\n[${n.type || 'Req'}]`,
        title: `Type: ${n.type}\nCanonical: ${n.canonical_id || 'N/A'}`,
        color: { background: '#06b6d4', border: '#ffffff' },
        font: { color: '#ffffff', size: 13 },
        shadow: { enabled: true }
    }));

    const nodeIdSet = new Set(nodes.map(n => n.id));
    const edgeSet = new Set();
    const edges = [];
    flat.forEach(n => {
        (n.relationships || []).forEach(rel => {
            const key = `${n.id}->${rel.target}`;
            if (!edgeSet.has(key) && nodeIdSet.has(rel.target)) {
                edgeSet.add(key);
                edges.push({ from: n.id, to: rel.target, arrows: 'to', label: rel.label,
                    color: { color: getRelationshipColor(rel.label), opacity: 0.7 }, width: 1.5,
                    font: { size: 10, color: '#999', strokeWidth: 0 } });
            }
        });
        (n.hasField || []).forEach(c => {
            const key = `${n.id}->${c}`;
            if (!edgeSet.has(key) && nodeIdSet.has(c)) {
                edgeSet.add(key);
                edges.push({ from: n.id, to: c, arrows: 'to', label: 'contains',
                    color: { color: '#8b5cf6', opacity: 0.7 }, width: 1.5 });
            }
        });
    });

    if (searchNetwork) searchNetwork.destroy();
    searchNetwork = new vis.Network(
        document.getElementById('searchGraphContainer'),
        { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
        {
            nodes: { shape: 'dot', size: 18, font: { size: 13, color: '#ffffff' } },
            edges: { smooth: { type: 'cubicBezier', roundness: 0.4 }, arrows: { to: { scaleFactor: 0.7 } } },
            layout: { hierarchical: { enabled: edges.length > 0, direction: 'UD', sortMethod: 'hubsize', levelSeparation: 120, nodeSpacing: 180 } },
            physics: { enabled: edges.length === 0 }
        }
    );
    setTimeout(() => searchNetwork.fit(), 500);
}

let network = null;
let graphBase = null;
let graphVariant = null;
let lastResults = null;
let staticMode = false;

/* ========== CLIENT-SIDE COMPARISON ENGINE ========== */

function canonicalize(name) {
    if (!name) return '';
    return name.toString()
        .toLowerCase()
        .replace(/[\s\-_]/g, '')
        .replace(/organisation/g, 'organization')
        .replace(/governance/g, 'gov');
}

function flattenForCompare(nodes) {
    const flat = [];
    const seen = new Set();

    const traverse = (node, parentId) => {
        if (!node || typeof node !== 'object') return null;
        let rawId = node['@id'] || node.id || node.requirement_id || node.name || node.label;
        if (!rawId) return null;

        const looksFlat = /^(node_|req_|REQ)/i.test(rawId);
        let id = (!looksFlat && parentId) ? `${parentId}.${rawId}` : rawId;
        if (seen.has(id)) return id;
        seen.add(id);

        const childIds = [];
        const semanticArrayKeys = ['components', 'fields', 'rules', 'requirements', 'constraints', 'obligations'];
        for (const key of semanticArrayKeys) {
            if (Array.isArray(node[key])) {
                node[key].forEach(item => {
                    if (typeof item === 'object') {
                        const cid = traverse(item, id);
                        if (cid) childIds.push(cid);
                    }
                });
            }
        }

        const depends_on = [];
        if (Array.isArray(node.depends_on)) node.depends_on.forEach(ref => { if (typeof ref === 'string') depends_on.push(ref); });
        const refines = [];
        if (Array.isArray(node.refines)) node.refines.forEach(ref => { if (typeof ref === 'string') refines.push(ref); });
        if (Array.isArray(node.hasField)) node.hasField.forEach(ref => { if (typeof ref === 'string' && !childIds.includes(ref)) childIds.push(ref); });

        const relationships = [];
        if (Array.isArray(node.relationships)) {
            node.relationships.forEach(rel => {
                if (rel && typeof rel === 'object' && rel.target) relationships.push({ target: rel.target, label: rel.label || 'related_to' });
            });
        }

        let canonical_id = node.canonical_id;
        if (!canonical_id && node.type !== 'Ontology' && node.type !== 'Relationship') {
            canonical_id = canonicalize(node.name || rawId);
        }

        flat.push({ ...node, id, name: node.name || rawId, type: node.type || 'Requirement', canonical_id, depends_on, refines, relationships, hasField: childIds, parentId: node.parentId || parentId || null });
        return id;
    };

    (Array.isArray(nodes) ? nodes : [nodes]).forEach(n => traverse(n, null));
    return flat;
}

function buildCanonicalMap(nodes) {
    const map = {};
    nodes.forEach(node => { const key = node.canonical_id || canonicalize(node.name || node.id); if (key) map[key] = node; });
    return map;
}

function buildNormalizedMap(nodes) {
    const map = {};
    nodes.forEach(node => { const key = canonicalize(node.name || node.label || node.id); if (key) map[key] = node; });
    return map;
}

function computeRuleDiff(nodeA, nodeB) {
    const changes = [];
    const props = ['mandatory', 'required', 'is_mandatory', 'format', 'pattern', 'condition', 'type', 'category'];
    props.forEach(prop => {
        const valA = nodeA[prop] !== undefined ? nodeA[prop].toString().toLowerCase() : null;
        const valB = nodeB[prop] !== undefined ? nodeB[prop].toString().toLowerCase() : null;
        if (valA !== valB) changes.push({ property: prop, baseValue: nodeA[prop], targetValue: nodeB[prop] });
    });
    return { isConflict: changes.length > 0, changes };
}

function compareGraphsLocal(graphBaseData, graphVariantData) {
    const rawBase = graphBaseData['@graph'] || (Array.isArray(graphBaseData) ? graphBaseData : []);
    const rawVariant = graphVariantData['@graph'] || (Array.isArray(graphVariantData) ? graphVariantData : []);

    const nodesBase = flattenForCompare(rawBase);
    const nodesVariant = flattenForCompare(rawVariant);

    const mapBaseCanonical = buildCanonicalMap(nodesBase);
    const mapVariantCanonical = buildCanonicalMap(nodesVariant);
    const mapBase = buildNormalizedMap(nodesBase);
    const mapVariant = buildNormalizedMap(nodesVariant);

    const matches = [], missing = [], extensions = [], conflicts = [];
    const matchedVariantIds = new Set();

    for (const baseNode of nodesBase) {
        if (baseNode.type === 'Ontology' || baseNode.type === 'Relationship') continue;
        const cid = baseNode.canonical_id || canonicalize(baseNode.name || baseNode.id);
        if (!cid) continue;

        let variantMatch = mapVariantCanonical[cid];
        if (!variantMatch) variantMatch = mapVariant[cid];
        if (!variantMatch) { const rawKey = canonicalize(baseNode.id); variantMatch = mapVariantCanonical[rawKey] || mapVariant[rawKey]; }

        if (variantMatch) {
            matchedVariantIds.add(variantMatch.id);
            const diff = computeRuleDiff(baseNode, variantMatch);
            if (diff.isConflict) {
                conflicts.push({ canonicalId: cid, baseNode, variantNode: variantMatch, diff: diff.changes, type: 'CONFLICT' });
            } else {
                matches.push({ canonicalId: cid, node: baseNode, variantNode: variantMatch, matchedWith: variantMatch.id, type: 'MATCH' });
            }
        } else {
            missing.push({ canonicalId: cid, node: baseNode, type: 'MISSING' });
        }
    }

    for (const variantNode of nodesVariant) {
        if (variantNode.type === 'Ontology' || variantNode.type === 'Relationship') continue;
        if (!matchedVariantIds.has(variantNode.id)) extensions.push({ node: variantNode, type: 'EXTENSION' });
    }

    const totalBase = nodesBase.filter(n => n.type !== 'Ontology' && n.type !== 'Relationship').length;
    const compliancePercent = totalBase > 0 ? Math.round((matches.length / totalBase) * 100) : 0;

    return {
        matches, missing, extensions, conflicts,
        summary: { matches: matches.length, missing: missing.length, extensions: extensions.length, conflicts: conflicts.length, compliancePercent, totalBaseNodes: totalBase, totalVariantNodes: nodesVariant.length }
    };
}

/* ========== LOCAL LLM INFERENCE ========== */

function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) return text.substring(start, end + 1);
    return text;
}

async function inferSchemaLocal(standardName, documentText) {
    const systemPrompt = `You are an AI governance regulatory analyst specializing in AI governance frameworks.
Given the AI governance framework text, extract entities and relationships as a JSON-LD knowledge graph.

ENTITY TYPES TO EXTRACT:
- Regulation: The framework/act itself
- RiskCategory: Risk classification levels (e.g., High Risk, Unacceptable Risk)
- Requirement: Specific obligations or mandates
- Principle: Guiding principles (e.g., Transparency, Fairness, Accountability)
- Entity: Specific concepts or systems (e.g., AI System, Biometric ID)
- Concept: Abstract concepts (e.g., Risk Classification, Human-in-the-Loop)
- RegulatoryBody: Organizations responsible for enforcement/guidance
- Process: Procedures or assessment processes

EACH NODE MUST HAVE:
- id: unique identifier (lowercase, underscore-separated)
- name: human-readable name
- type: one of the entity types above
- category: domain group (Risk, Governance, Transparency, Fairness, Data, Compliance, Enforcement, etc.)
- canonical_id: normalized key for cross-framework matching
- description: clear description of the entity
- source: reference to the source section/article
- mandatory: true/false (if applicable)

RELATIONSHIPS (in a "relationships" array on each node):
- Each relationship: {"target": "target_node_id", "label": "relationship_type"}

Return ONLY valid JSON: { "@context": {}, "@graph": [{entity1}, {entity2}, ...] }`;

    const userPrompt = `Framework: ${standardName}\nContent:\n${documentText.substring(0, 6000)}`;

    const text = await LLM.callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);

    return JSON.parse(extractJson(text));
}

const CANONICAL_DEFAULTS = [
    'risk_classification (type: Concept)',
    'high_risk_ai (type: Entity)',
    'unacceptable_risk (type: RiskCategory)',
    'minimal_risk (type: RiskCategory)',
    'transparency (type: Principle)',
    'explainability (type: Principle)',
    'human_oversight (type: Requirement)',
    'human_in_the_loop (type: Concept)',
    'risk_management_system (type: Requirement)',
    'data_governance (type: Requirement)',
    'bias_detection (type: Requirement)',
    'testing_procedures (type: Requirement)',
    'conformity_assessment (type: Requirement)',
    'post_market_monitoring (type: Requirement)',
    'incident_reporting (type: Requirement)',
    'provider_obligations (type: Requirement)',
    'deployer_obligations (type: Requirement)',
    'quality_management (type: Requirement)',
    'ai_governance_body (type: RegulatoryBody)',
    'penalties (type: Requirement)',
    'accountability (type: Principle)',
    'fairness (type: Principle)',
    'ai_literacy (type: Requirement)',
    'prohibited_practices (type: Requirement)'
];

async function generateGraphLocal(documentText, masterSchema, contextMetadata) {
    const concepts = new Set(CANONICAL_DEFAULTS);
    if (masterSchema && masterSchema['@graph']) {
        masterSchema['@graph'].forEach(node => {
            if (node.canonical_id) concepts.add(`${node.canonical_id} (type: ${node.type || 'Requirement'})`);
        });
    }
    const canonicalRef = [...concepts].map(c => `- ${c}`).join('\n');

    const systemPrompt = `You are an AI governance analyst building knowledge graphs from regulatory documents.
Extract entities and relationships from the document and map each to canonical governance concepts.

ENTITY TYPES: Regulation, RiskCategory, Requirement, Principle, Entity, Concept, RegulatoryBody, Process

EACH NODE MUST HAVE:
- id: unique identifier
- name: short human-readable name
- type: one of the entity types above
- category: domain group
- canonical_id: normalized key matching base framework concepts (see list below). Set to null if new concept.
- description: clear description
- source: "${contextMetadata.source}"
- mandatory: true/false
- is_extension: true ONLY if this concept does NOT exist in the base framework

RELATIONSHIPS array: [{"target": "node_id", "label": "relationship_type"}]

CANONICAL IDs to match against:
${canonicalRef}

OUTPUT ONLY valid JSON: { "@context": {}, "@graph": [{entity1}, {entity2}, ...] }`;

    const userPrompt = `Extract governance entities from:
Document: ${contextMetadata.source}
Region: ${contextMetadata.country}

TEXT:
${documentText.substring(0, 5000)}`;

    const text = await LLM.callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);

    let result = JSON.parse(extractJson(text));
    if (!result['@graph']) {
        result = {
            "@context": masterSchema['@context'] || {},
            "@graph": result.graph || result.nodes || (Array.isArray(result) ? result : [result])
        };
    }

    if (Array.isArray(result['@graph'])) {
        result['@graph'] = result['@graph'].map(node => {
            if (!node.hasOwnProperty('canonical_id')) { node.canonical_id = null; node.is_extension = true; }
            return node;
        });
    }

    return result;
}

/* ========== UI HELPERS ========== */

function setStatus(msg, type = '') {
    const el = document.getElementById('status');
    el.innerText = msg;
    el.className = 'status-bar ' + type;
}

function setModelProgress(text, pct) {
    const div = document.getElementById('modelProgress');
    const bar = document.getElementById('modelProgressBar');
    const label = document.getElementById('modelProgressText');
    if (text === null) { div.style.display = 'none'; return; }
    div.style.display = '';
    label.innerText = text;
    if (pct !== undefined) bar.style.width = Math.round(pct * 100) + '%';
}

/* ========== INITIALIZATION ========== */

document.addEventListener('DOMContentLoaded', () => {
    // Populate model selector
    const sel = document.getElementById('modelSelect');
    LLM.WEBLLM_MODELS.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        sel.appendChild(opt);
    });

    initDropZone();
});

function initDropZone() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload({ target: { files: [file] } });
    });
}

/* ========== MODEL LOADING ========== */

async function loadLocalModel() {
    const modelId = document.getElementById('modelSelect').value;
    const btn = document.getElementById('btnLoadModel');
    btn.disabled = true;
    setStatus(`Loading ${modelId}... (first load downloads the model)`, 'loading');
    setModelProgress('Initializing...', 0);

    try {
        await LLM.loadModel(modelId, (text, progress) => {
            setModelProgress(text, progress);
        });
        setModelProgress(null);
        btn.disabled = false;
        setStatus('Model ready. You can now load a base framework.', 'success');
    } catch (e) {
        setModelProgress(null);
        btn.disabled = false;
        setStatus('Model load failed: ' + e.message, 'error');
    }
}

/* ========== MAIN ACTIONS ========== */

async function loadBaseGraph() {
    if (!LLM.isReady()) {
        setStatus('Please load a local model first.', 'error');
        return;
    }

    const standard = document.getElementById('standardSelect').value;
    setStatus(`Loading base framework: ${standard}...`, 'loading');

    try {
        // Fetch spec text from backend (no LLM on server)
        const resp = await axios.get('/api/get-spec', { params: { standard } });
        const { specText, cached, graph: cachedGraph, schema: cachedSchema } = resp.data;

        if (cached) {
            graphBase = cachedGraph;
            setStatus(`Base framework loaded (cached).`, 'success');
        } else {
            setStatus(`Inferring schema for ${standard}...`, 'loading');
            const schema = await inferSchemaLocal(standard, specText);

            setStatus(`Building base graph for ${standard}...`, 'loading');
            const graph = await generateGraphLocal(specText, schema, { country: 'Base', source: `Spec: ${standard}` });

            // Cache on server
            await axios.post('/api/cache-graph', { standard, graph, schema });

            graphBase = graph;
            setStatus(`Base framework loaded.`, 'success');
        }

        if (graphVariant) {
            runComparison();
        } else {
            lastResults = null;
            renderStandaloneGraph(graphBase['@graph'] || [], 'BASE', '#8b5cf6');
        }
    } catch (e) {
        setStatus('Failed: ' + e.message, 'error');
    }
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!LLM.isReady()) {
        setStatus('Please load a local model first.', 'error');
        return;
    }

    const standard = document.getElementById('standardSelect').value;
    const country = document.getElementById('country').value || 'Variant';
    const source = document.getElementById('source').value || file.name;

    setStatus(`Parsing ${file.name}...`, 'loading');

    try {
        // Upload PDF for text extraction only (no LLM on server)
        const formData = new FormData();
        formData.append('file', file);
        const parseResp = await axios.post('/api/parse-pdf', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
        });
        const extractedText = parseResp.data.text;

        setStatus(`Generating variant graph for ${country}...`, 'loading');

        const safeName = standard.toLowerCase().replace(/\s/g, '_');
        let schema = { "@context": {}, "@graph": [], name: standard };
        try {
            const schemaResp = await axios.get('/api/get-schema', { params: { standard } });
            if (schemaResp.data.schema) schema = schemaResp.data.schema;
        } catch (_) {}

        graphVariant = await generateGraphLocal(extractedText, schema, { country, source });
        setStatus('Variant processed successfully.', 'success');

        if (graphBase) {
            runComparison();
        } else {
            lastResults = null;
            renderStandaloneGraph(graphVariant['@graph'] || [], 'VARIANT', '#06b6d4');
        }
    } catch (e) {
        setStatus('Processing failed: ' + e.message, 'error');
    }
}

function toggleMockMode() {
    const on = document.getElementById('mockModeToggle').checked;
    if (on) loadMockGraphs();
}

async function loadMockGraphs() {
    setStatus('Loading mock governance graphs...', 'loading');

    try {
        let base, variant;
        try {
            const [baseResp, variantResp] = await Promise.all([
                axios.post('/api/mock/base'),
                axios.post('/api/mock/variant')
            ]);
            base = baseResp.data.graph;
            variant = variantResp.data.graph;
        } catch (_) {
            staticMode = true;
            const [baseResp, variantResp] = await Promise.all([
                axios.get('data/eu_ai_act.jsonld'),
                axios.get('data/singapore_model_ai_governance.jsonld')
            ]);
            base = baseResp.data;
            variant = variantResp.data;
        }

        graphBase = base;
        graphVariant = variant;
        setStatus('Mock graphs loaded (EU AI Act + Singapore).' + (staticMode ? ' [Static mode]' : ''), 'success');
        runComparison();
    } catch (e) {
        setStatus('Mock load failed: ' + (e.response?.data?.error || e.message), 'error');
    }
}

async function runComparison() {
    if (!graphBase || !graphVariant) return;
    setStatus('Comparing governance frameworks...', 'loading');

    try {
        let results;
        if (staticMode) {
            results = compareGraphsLocal(graphBase, graphVariant);
        } else {
            try {
                const resp = await axios.post('/api/compare', { graphBase, graphVariant });
                results = resp.data.results;
            } catch (_) {
                staticMode = true;
                results = compareGraphsLocal(graphBase, graphVariant);
            }
        }
        setStatus('Comparison complete.' + (staticMode ? ' [Client-side]' : ''), 'success');
        renderResults(results);
    } catch (e) {
        setStatus('Comparison failed: ' + e.message, 'error');
    }
}

async function exportComparison() {
    if (!lastResults) return;
    try {
        const resp = await axios.post('/api/export-comparison', {
            graphBase, graphVariant, comparisonResults: lastResults
        });
        const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'governance_comparison.json';
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        setStatus('Export failed: ' + e.message, 'error');
    }
}

function switchView() {
    if (lastResults) {
        renderResults(lastResults);
    } else if (graphBase) {
        renderStandaloneGraph(graphBase['@graph'] || [], 'BASE', '#8b5cf6');
    }
}

/* ========== GRAPH UTILITIES ========== */

function flattenGraph(nodes) {
    const flat = [];
    const seen = new Set();

    const traverse = (node, parentId, depth = 0) => {
        if (!node || typeof node !== 'object' || depth > 10) return null;
        let rawId = node['@id'] || node.id || node.name;
        if (!rawId) return null;

        const looksFlat = /^(node_|req_|REQ)/i.test(rawId);
        let id = (!looksFlat && parentId) ? `${parentId}.${rawId}` : rawId;
        if (seen.has(id)) return id;
        seen.add(id);

        const depends_on = [];
        if (Array.isArray(node.depends_on)) node.depends_on.forEach(r => { if (typeof r === 'string') depends_on.push(r); });
        const refines = [];
        if (Array.isArray(node.refines)) node.refines.forEach(r => { if (typeof r === 'string') refines.push(r); });
        const hasField = [];
        if (Array.isArray(node.hasField)) node.hasField.forEach(r => { if (typeof r === 'string') hasField.push(r); });

        const relationships = [];
        if (Array.isArray(node.relationships)) {
            node.relationships.forEach(rel => {
                if (rel && typeof rel === 'object' && rel.target) {
                    relationships.push({ target: rel.target, label: rel.label || 'related_to' });
                }
            });
        }

        const nestedKeys = ['obligations', 'components', 'requirements', 'rules'];
        for (const key of nestedKeys) {
            if (Array.isArray(node[key])) {
                node[key].forEach(item => {
                    if (typeof item === 'object' && item.id) {
                        const cid = traverse(item, id, depth + 1);
                        if (cid && !hasField.includes(cid)) hasField.push(cid);
                    }
                });
            }
        }

        flat.push({
            ...node, id,
            label: node.name || rawId,
            type: node.type || 'Requirement',
            depends_on, refines, hasField, relationships,
            canonical_id: node.canonical_id || null,
            parentId: node.parentId || parentId || null
        });
        return id;
    };

    (Array.isArray(nodes) ? nodes : [nodes]).forEach(n => traverse(n, null));
    return flat;
}

function getRelationshipColor(label) {
    const colorMap = {
        defines: '#8b5cf6', contains: '#8b5cf6', includes: '#8b5cf6', has_field: '#a78bfa',
        requires: '#f59e0b', mandates: '#f59e0b', prohibits: '#ef4444', restricts: '#ef4444',
        governs: '#f59e0b', governed_by: '#f59e0b', must_comply_with: '#f59e0b', constrains: '#f59e0b',
        subject_to: '#06b6d4', leads_to: '#06b6d4', may_involve: '#06b6d4', conformity: '#06b6d4',
        maps_to: '#10b981', similar_to: '#10b981', broader_than: '#22d3ee', narrower_than: '#22d3ee',
        established_by: '#3b82f6', published_by: '#3b82f6', enforced_by: '#3b82f6', complemented_by: '#3b82f6',
        enables: '#a78bfa', supports: '#a78bfa', triggers: '#ec4899',
        applies_to: '#f97316', classified_as: '#f97316', regulates: '#f97316',
        ensures: '#14b8a6', must_address: '#14b8a6', must_register_in: '#14b8a6',
        tests: '#10b981', considers: '#94a3b8',
        related_to: '#666', references: '#94a3b8'
    };
    return colorMap[label] || '#666';
}

/* ========== RENDERING ========== */

function renderStandaloneGraph(rawNodes, graphLabel, defaultColor) {
    const flat = flattenGraph(rawNodes);
    document.getElementById('graphArea').style.display = '';
    updateStats(flat.length, '—', '—', '—', '—');

    const nodes = [];
    const edges = [];

    flat.forEach(n => {
        const nodeId = n.id;
        if (!nodeId) return;
        nodes.push({
            id: nodeId,
            label: `${n.name || nodeId}\n[${n.type || 'Req'}]`,
            title: `Type: ${n.type}\nCanonical: ${n.canonical_id || 'N/A'}\nCategory: ${n.category || 'N/A'}`,
            color: { background: defaultColor, border: '#ffffff' },
            font: { color: '#ffffff', size: 13 },
            data: n,
            shadow: { enabled: true }
        });
    });

    const nodeIdSet = new Set(nodes.map(n => n.id));
    const edgeSet = new Set();
    const addEdge = (from, to, label, color) => {
        const key = `${from}->${to}`;
        if (edgeSet.has(key) || !nodeIdSet.has(from) || !nodeIdSet.has(to)) return;
        edgeSet.add(key);
        edges.push({ from, to, arrows: 'to', label, color: { color, opacity: 0.7 }, width: 1.5, font: { size: 10, color: '#999', strokeWidth: 0 } });
    };

    flat.forEach(n => {
        if (n.relationships && n.relationships.length > 0) {
            n.relationships.forEach(rel => addEdge(n.id, rel.target, rel.label, getRelationshipColor(rel.label)));
        }
        (n.depends_on || []).forEach(d => addEdge(n.id, d, 'depends_on', '#f59e0b'));
        (n.refines || []).forEach(r => addEdge(n.id, r, 'refines', '#10b981'));
        (n.hasField || []).forEach(c => addEdge(n.id, c, 'contains', '#8b5cf6'));
    });

    renderNetwork(nodes, edges);
}

function renderResults(results) {
    lastResults = results;
    const mode = document.getElementById('viewMode').value;

    if (mode === 'base' && graphBase) {
        renderStandaloneGraph(graphBase['@graph'] || [], 'BASE', '#8b5cf6');
        return;
    }

    if (results && results.matches !== undefined) {
        renderComparisonGraph(results, mode);
        return;
    }

    if (graphBase) {
        renderStandaloneGraph(graphBase['@graph'] || [], 'BASE', '#8b5cf6');
    }
}

function renderComparisonGraph(results, mode) {
    const { matches, missing, extensions, conflicts, summary } = results;
    document.getElementById('graphArea').style.display = '';

    updateStats(summary.matches, summary.missing, summary.extensions, summary.conflicts, summary.compliancePercent + '%');

    const compEl = document.getElementById('statCompliance');
    if (summary.compliancePercent >= 80) compEl.style.color = '#10b981';
    else if (summary.compliancePercent >= 60) compEl.style.color = '#f59e0b';
    else compEl.style.color = '#ef4444';

    const nodes = [];
    const edges = [];

    const addNode = (item, category, prefix = '') => {
        const node = item.node || item.baseNode;
        if (!node) return;
        const nodeId = node.id || node['@id'];
        if (!nodeId) return;

        const colors = { MATCH: '#10b981', MISSING: '#ef4444', EXTENSION: '#06b6d4', CONFLICT: '#f59e0b' };
        nodes.push({
            id: nodeId,
            label: `${prefix}${node.name || nodeId}\n[${category}]`,
            title: `${category}\nCanonical: ${node.canonical_id || 'N/A'}\nSource: ${node.source || 'N/A'}`,
            color: { background: colors[category] || '#8b5cf6', border: '#ffffff' },
            font: { color: '#ffffff', size: 13 },
            data: item,
            category,
            shadow: { enabled: true }
        });
    };

    matches.forEach(m => addNode(m, 'MATCH'));
    missing.forEach(m => addNode(m, 'MISSING', '❌ '));
    extensions.forEach(e => addNode(e, 'EXTENSION', '🔵 '));
    conflicts.forEach(c => addNode(c, 'CONFLICT', '⚠️ '));

    const nodeIdSet = new Set(nodes.map(n => n.id));
    const edgeSet = new Set();
    const addEdge = (from, to, label, color) => {
        const key = `${from}->${to}`;
        if (edgeSet.has(key) || !nodeIdSet.has(from) || !nodeIdSet.has(to)) return;
        edgeSet.add(key);
        edges.push({ from, to, arrows: 'to', label, color: { color, opacity: 0.7 }, width: 1.5, font: { size: 10, color: '#999', strokeWidth: 0 } });
    };

    const variantToDisplayId = {};
    matches.forEach(m => { if (m.matchedWith && m.node) variantToDisplayId[m.matchedWith] = m.node.id; });
    conflicts.forEach(c => { if (c.variantNode && c.baseNode) variantToDisplayId[c.variantNode.id] = c.baseNode.id; });
    const resolveId = (id) => variantToDisplayId[id] || id;

    const allItems = [...matches, ...missing, ...extensions];
    conflicts.forEach(c => { if (c.baseNode) allItems.push({ node: c.baseNode }); });

    allItems.forEach(item => {
        const node = item.node || item.baseNode;
        if (!node) return;
        const displayId = resolveId(node.id);
        if (Array.isArray(node.relationships)) {
            node.relationships.forEach(rel => {
                if (rel && rel.target) addEdge(displayId, resolveId(rel.target), rel.label, getRelationshipColor(rel.label));
            });
        }
        (node.depends_on || []).forEach(d => { if (typeof d === 'string') addEdge(displayId, resolveId(d), 'depends_on', '#f59e0b'); });
        (node.refines || []).forEach(r => { if (typeof r === 'string') addEdge(displayId, resolveId(r), 'refines', '#10b981'); });
        (node.hasField || []).forEach(c => { if (typeof c === 'string') addEdge(displayId, resolveId(c), 'contains', '#8b5cf6'); });
    });

    matches.forEach(m => {
        if (m.variantNode) {
            const displayId = m.node.id;
            if (Array.isArray(m.variantNode.relationships)) {
                m.variantNode.relationships.forEach(rel => {
                    if (rel && rel.target) addEdge(displayId, resolveId(rel.target), rel.label, getRelationshipColor(rel.label));
                });
            }
        }
    });

    extensions.forEach(e => {
        if (Array.isArray(e.node.relationships)) {
            e.node.relationships.forEach(rel => {
                if (rel && rel.target) addEdge(e.node.id, resolveId(rel.target), rel.label, getRelationshipColor(rel.label));
            });
        }
    });

    renderNetwork(nodes, edges);
}

function renderNetwork(nodes, edges) {
    const dataset = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
    const options = {
        nodes: { shape: 'dot', size: 18, font: { size: 13, color: '#ffffff' } },
        edges: {
            font: { size: 10, color: '#aaa', strokeWidth: 0, align: 'middle' },
            smooth: { type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.4 },
            arrows: { to: { scaleFactor: 0.7 } }
        },
        layout: {
            hierarchical: {
                enabled: edges.length > 0,
                direction: 'UD',
                sortMethod: 'hubsize',
                shakeTowards: 'roots',
                levelSeparation: 120,
                nodeSpacing: 180
            }
        },
        physics: { enabled: edges.length === 0, stabilization: { iterations: 150 } }
    };

    network = new vis.Network(document.getElementById('graphContainer'), dataset, options);

    network.on('click', (params) => {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            const matchingNode = nodes.find(n => n.id === nodeId);
            if (matchingNode) {
                const viewMode = document.getElementById('viewMode').value;
                const isComparisonMode = viewMode === 'diff' || viewMode === 'overlay';
                const conflictData = isComparisonMode ? lastResults?.conflicts?.find(c => c.baseNode?.id === nodeId) : null;
                showInspector(matchingNode.data, conflictData);
            }
        }
    });

    if (nodes.length > 0) setTimeout(() => network.fit(), 500);
}

/* ========== INSPECTOR ========== */

function showInspector(data, conflictData) {
    const inspector = document.getElementById('inspector');
    inspector.style.display = '';

    const node = data.node || data.baseNode || data;
    document.getElementById('inspectorTitle').innerText = node.name || node.id || 'Node';

    let html = '';
    const row = (label, value) => `<div class="detail-row"><div class="detail-label">${label}</div><div class="detail-value">${value || 'N/A'}</div></div>`;

    html += row('ID', node.id);
    html += row('Type', node.type);
    html += row('Category', node.category);
    html += row('Canonical ID', node.canonical_id ? `<span style="color:#10b981">${node.canonical_id}</span>` : 'N/A');
    html += row('Source', node.source);
    html += row('Description', node.description || node.requirement_text || 'No description');
    html += row('Mandatory', node.mandatory !== undefined ? (node.mandatory ? '✅ Yes' : '❌ No') : 'N/A');

    if (node.relationships && node.relationships.length > 0) {
        html += `<div class="detail-row"><div class="detail-label">Relationships</div><div class="detail-value">`;
        node.relationships.forEach(r => {
            html += `<div style="margin:2px 0;"><span style="color:${getRelationshipColor(r.label)}">${r.label}</span> → ${r.target}</div>`;
        });
        html += `</div></div>`;
    }

    if (conflictData) {
        html += `<div class="conflict-diff"><h4>⚠️ Attribute Conflicts</h4>`;
        (conflictData.diff || []).forEach(d => {
            html += `<div class="diff-item">
                <strong>${d.property}:</strong><br>
                <span class="diff-base">Base: ${d.baseValue ?? 'undefined'}</span><br>
                <span class="diff-variant">Variant: ${d.targetValue ?? 'undefined'}</span>
            </div>`;
        });
        html += `</div>`;
    }

    document.getElementById('inspectorContent').innerHTML = html;
}

/* ========== HELPERS ========== */

function updateStats(matches, missing, extensions, conflicts, compliance) {
    document.getElementById('statMatches').innerText = matches;
    document.getElementById('statMissing').innerText = missing;
    document.getElementById('statExtensions').innerText = extensions;
    document.getElementById('statConflicts').innerText = conflicts;
    document.getElementById('statCompliance').innerText = compliance;
}

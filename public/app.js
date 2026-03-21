/**
 * GraphRAG Governance — Frontend Logic
 * AI Framework Alignment & Knowledge Graph Comparison
 */

let network = null;
let graphBase = null;
let graphVariant = null;
let lastResults = null;
let staticMode = false; // true when running on GitHub Pages (no backend)

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

function getConfig() {
    return {
        apiLink: document.getElementById('apiLink').value,
        apiKey: document.getElementById('apiKey').value,
        model: document.getElementById('model').value,
        temperature: 0
    };
}

function setStatus(msg, type = '') {
    const el = document.getElementById('status');
    el.innerText = msg;
    el.className = 'status-bar ' + type;
}

/* ========== INITIALIZATION ========== */

document.addEventListener('DOMContentLoaded', () => {
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

/* ========== API ACTIONS ========== */

async function testApiConnection() {
    setStatus('Testing API connection...', 'loading');
    try {
        const resp = await axios.post('/api/test-api', {
            openaiConfig: JSON.stringify(getConfig())
        });
        setStatus('API Connected: ' + resp.data.message, 'success');
    } catch (e) {
        setStatus('API Failed: ' + (e.response?.data?.error || e.message), 'error');
    }
}

async function loadBaseGraph() {
    const standard = document.getElementById('standardSelect').value;
    setStatus(`Loading base framework: ${standard}...`, 'loading');

    try {
        const resp = await axios.post('/api/standard-base-graph', {
            standard,
            openaiConfig: JSON.stringify(getConfig())
        });

        graphBase = resp.data.graph;
        setStatus(`Base framework loaded${resp.data.cached ? ' (cached)' : ''}.`, 'success');

        if (graphVariant) {
            runComparison();
        } else {
            lastResults = null;
            renderStandaloneGraph(graphBase['@graph'] || [], 'BASE', '#8b5cf6');
        }
    } catch (e) {
        setStatus('Failed: ' + (e.response?.data?.error || e.message), 'error');
    }
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const standard = document.getElementById('standardSelect').value;
    const country = document.getElementById('country').value || 'Variant';
    const source = document.getElementById('source').value || file.name;

    setStatus(`Processing ${file.name}...`, 'loading');

    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('standard', standard);
        formData.append('country', country);
        formData.append('source', source);
        formData.append('openaiConfig', JSON.stringify(getConfig()));

        const resp = await axios.post('/api/process-variant', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
        });

        graphVariant = resp.data.graph;
        setStatus('Variant processed successfully.', 'success');

        if (graphBase) {
            runComparison();
        } else {
            lastResults = null;
            renderStandaloneGraph(graphVariant['@graph'] || [], 'VARIANT', '#06b6d4');
        }
    } catch (e) {
        setStatus('Processing failed: ' + (e.response?.data?.error || e.message), 'error');
    }
}

function toggleMockMode() {
    const on = document.getElementById('mockModeToggle').checked;
    if (on) {
        loadMockGraphs();
    }
}

async function loadMockGraphs() {
    setStatus('Loading mock governance graphs...', 'loading');

    try {
        // Try backend API first, fall back to static files (GitHub Pages)
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
        // Structural
        defines: '#8b5cf6', contains: '#8b5cf6', includes: '#8b5cf6', has_field: '#a78bfa',
        // Regulatory action
        requires: '#f59e0b', mandates: '#f59e0b', prohibits: '#ef4444', restricts: '#ef4444',
        governs: '#f59e0b', governed_by: '#f59e0b', must_comply_with: '#f59e0b', constrains: '#f59e0b',
        // Compliance
        subject_to: '#06b6d4', leads_to: '#06b6d4', may_involve: '#06b6d4', conformity: '#06b6d4',
        // Mapping/equivalence
        maps_to: '#10b981', similar_to: '#10b981', broader_than: '#22d3ee', narrower_than: '#22d3ee',
        // Organizational
        established_by: '#3b82f6', published_by: '#3b82f6', enforced_by: '#3b82f6', complemented_by: '#3b82f6',
        // Flow
        enables: '#a78bfa', supports: '#a78bfa', triggers: '#ec4899',
        // Risk
        applies_to: '#f97316', classified_as: '#f97316', regulates: '#f97316',
        // Data
        ensures: '#14b8a6', must_address: '#14b8a6', must_register_in: '#14b8a6',
        // Testing
        tests: '#10b981', considers: '#94a3b8',
        // Default
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

    // Build variant→display ID mapping
    const variantToDisplayId = {};
    matches.forEach(m => { if (m.matchedWith && m.node) variantToDisplayId[m.matchedWith] = m.node.id; });
    conflicts.forEach(c => { if (c.variantNode && c.baseNode) variantToDisplayId[c.variantNode.id] = c.baseNode.id; });
    const resolveId = (id) => variantToDisplayId[id] || id;

    // Build edges from all items
    const allItems = [...matches, ...missing, ...extensions];
    conflicts.forEach(c => { if (c.baseNode) allItems.push({ node: c.baseNode }); });

    allItems.forEach(item => {
        const node = item.node || item.baseNode;
        if (!node) return;
        const sourceId = node.id;
        if (!sourceId) return;
        const displayId = resolveId(sourceId);

        if (Array.isArray(node.relationships)) {
            node.relationships.forEach(rel => {
                if (rel && rel.target) addEdge(displayId, resolveId(rel.target), rel.label, getRelationshipColor(rel.label));
            });
        }
        (node.depends_on || []).forEach(d => { if (typeof d === 'string') addEdge(displayId, resolveId(d), 'depends_on', '#f59e0b'); });
        (node.refines || []).forEach(r => { if (typeof r === 'string') addEdge(displayId, resolveId(r), 'refines', '#10b981'); });
        (node.hasField || []).forEach(c => { if (typeof c === 'string') addEdge(displayId, resolveId(c), 'contains', '#8b5cf6'); });
    });

    // Variant relationships from matched nodes
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

    // Extension node relationships
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
        physics: {
            enabled: edges.length === 0,
            stabilization: { iterations: 150 }
        }
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

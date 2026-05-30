/**
 * GraphRAG Governance — Frontend
 * Local WebLLM inference (no API key). Same pattern as advancedRagDemo.
 */
import { WEBLLM_MODELS, loadModel, callLLM, isReady } from './llm.js'
import axios from 'axios'

// ── Expose onclick handlers to window ────────────────────────────────
window._loadLocalModel   = loadLocalModel
window._loadBaseGraph    = loadBaseGraph
window._handleFileUpload = handleFileUpload
window._toggleMockMode   = toggleMockMode
window._switchView       = switchView
window._exportComparison = exportComparison

// ── State ─────────────────────────────────────────────────────────────
let network      = null
let graphBase    = null
let graphVariant = null
let lastResults  = null
let staticMode   = false

// ── Init ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('modelSelect')
  WEBLLM_MODELS.forEach(m => {
    const opt = document.createElement('option')
    opt.value   = m.id
    opt.textContent = m.label
    sel.appendChild(opt)
  })
  initDropZone()
})

function initDropZone() {
  const dropZone  = document.getElementById('dropZone')
  const fileInput = document.getElementById('fileInput')
  dropZone.addEventListener('click', () => fileInput.click())
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleFileUpload({ target: { files: [file] } })
  })
}

// ── Model loading (advancedRag progress protocol) ─────────────────────
async function loadLocalModel() {
  const modelId = document.getElementById('modelSelect').value
  const btn     = document.getElementById('btnLoadModel')
  btn.disabled  = true
  setStatus(`Loading ${modelId}… (first load downloads the model)`, 'loading')
  showProgressBanner(true)
  setProgressBar(0, 'Initializing WebGPU…', '')

  try {
    await loadModel(modelId, (evt) => {
      if (evt.type === 'device') {
        setProgressBar(2, 'WebGPU detected — fetching model weights…', '')
      } else if (evt.type === 'phase') {
        setProgressBar(5, evt.note || 'Loading…', '')
      } else if (evt.type === 'downloading') {
        setProgressBar(evt.progress ?? 0, `${evt.progress ?? 0}%`, evt.file || '')
      } else if (evt.type === 'ready') {
        setProgressBar(100, 'Model ready ✓', '')
      } else if (evt.type === 'error') {
        setStatus('Model load failed: ' + evt.error, 'error')
      }
    })
    showProgressBanner(false)
    btn.disabled = false
    setStatus('Model ready. You can now load a base framework.', 'success')
  } catch (e) {
    showProgressBanner(false)
    btn.disabled = false
    setStatus('Model load failed: ' + e.message, 'error')
  }
}

function showProgressBanner(visible) {
  document.getElementById('modelProgressBanner').style.display = visible ? '' : 'none'
}
function setProgressBar(pct, title, file) {
  document.getElementById('progressBarFill').style.width  = Math.round(pct) + '%'
  document.getElementById('progressTitle').textContent    = title
  document.getElementById('progressFileName').textContent = file
}

// ── LLM helpers ───────────────────────────────────────────────────────
function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  return (s !== -1 && e !== -1) ? text.substring(s, e + 1) : text
}

async function inferSchemaLocal(standardName, documentText) {
  const system = `You are an AI governance regulatory analyst. Given an AI governance framework text, extract entities and relationships as a JSON-LD knowledge graph.

ENTITY TYPES: Regulation, RiskCategory, Requirement, Principle, Entity, Concept, RegulatoryBody, Process

EACH NODE: id (lowercase_underscore), name, type, category, canonical_id, description, source, mandatory (bool)
RELATIONSHIPS array on each node: [{"target":"id","label":"type"}]

Return ONLY valid JSON: { "@context": {}, "@graph": [...] }`

  const text = await callLLM([
    { role: 'system', content: system },
    { role: 'user',   content: `Framework: ${standardName}\n\n${documentText.substring(0, 6000)}` }
  ])
  return JSON.parse(extractJson(text))
}

const CANONICAL_DEFAULTS = [
  'risk_classification','high_risk_ai','unacceptable_risk','minimal_risk',
  'transparency','explainability','human_oversight','human_in_the_loop',
  'risk_management_system','data_governance','bias_detection','testing_procedures',
  'conformity_assessment','post_market_monitoring','incident_reporting',
  'provider_obligations','deployer_obligations','quality_management',
  'ai_governance_body','penalties','accountability','fairness',
  'ai_literacy','prohibited_practices'
]

async function generateGraphLocal(documentText, masterSchema, contextMetadata) {
  const canonicalRef = CANONICAL_DEFAULTS.map(c => `- ${c}`).join('\n')

  const system = `You are an AI governance analyst building knowledge graphs from regulatory documents.
Extract entities and map each to canonical governance concepts.

ENTITY TYPES: Regulation, RiskCategory, Requirement, Principle, Entity, Concept, RegulatoryBody, Process

EACH NODE: id, name, type, category, canonical_id (null if new), description, source: "${contextMetadata.source}", mandatory, is_extension (true if new concept)
RELATIONSHIPS array: [{"target":"id","label":"type"}]

CANONICAL IDs to match:\n${canonicalRef}

OUTPUT ONLY valid JSON: { "@context": {}, "@graph": [...] }`

  const text = await callLLM([
    { role: 'system', content: system },
    { role: 'user',   content: `Region: ${contextMetadata.country}\nSource: ${contextMetadata.source}\n\n${documentText.substring(0, 5000)}` }
  ])

  let result = JSON.parse(extractJson(text))
  if (!result['@graph']) {
    result = { "@context": {}, "@graph": result.graph || result.nodes || (Array.isArray(result) ? result : [result]) }
  }
  result['@graph'] = (result['@graph'] || []).map(n => {
    if (!n.hasOwnProperty('canonical_id')) { n.canonical_id = null; n.is_extension = true }
    return n
  })
  return result
}

// ── UI helpers ────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  const el = document.getElementById('status')
  el.textContent = msg
  el.className   = 'status-bar ' + type
}
function updateStats(matches, missing, extensions, conflicts, compliance) {
  document.getElementById('statMatches').textContent    = matches
  document.getElementById('statMissing').textContent    = missing
  document.getElementById('statExtensions').textContent = extensions
  document.getElementById('statConflicts').textContent  = conflicts
  document.getElementById('statCompliance').textContent = compliance
}

// ── Actions ───────────────────────────────────────────────────────────
async function loadBaseGraph() {
  if (!isReady()) { setStatus('Please load a local model first.', 'error'); return }
  const standard = document.getElementById('standardSelect').value
  setStatus(`Loading base framework: ${standard}…`, 'loading')

  try {
    const resp = await axios.get('/api/get-spec', { params: { standard } })
    const { specText, cached, graph: cachedGraph } = resp.data

    if (cached) {
      graphBase = cachedGraph
      setStatus('Base framework loaded (cached).', 'success')
    } else {
      setStatus(`Inferring schema for ${standard}…`, 'loading')
      const schema = await inferSchemaLocal(standard, specText)
      setStatus(`Building base graph…`, 'loading')
      graphBase = await generateGraphLocal(specText, schema, { country: 'Base', source: `Spec: ${standard}` })
      await axios.post('/api/cache-graph', { standard, graph: graphBase, schema })
      setStatus('Base framework loaded.', 'success')
    }

    graphVariant ? runComparison() : renderStandaloneGraph(graphBase['@graph'] || [], '#8b5cf6')
  } catch (e) {
    setStatus('Failed: ' + e.message, 'error')
  }
}

async function handleFileUpload(event) {
  const file = event.target.files[0]
  if (!file) return
  if (!isReady()) { setStatus('Please load a local model first.', 'error'); return }

  const standard = document.getElementById('standardSelect').value
  const country  = document.getElementById('country').value  || 'Variant'
  const source   = document.getElementById('source').value   || file.name
  setStatus(`Parsing ${file.name}…`, 'loading')

  try {
    const formData = new FormData()
    formData.append('file', file)
    const parseResp = await axios.post('/api/parse-pdf', formData)
    const extractedText = parseResp.data.text

    let schema = { '@context': {}, '@graph': [], name: standard }
    try {
      const sr = await axios.get('/api/get-schema', { params: { standard } })
      if (sr.data.schema) schema = sr.data.schema
    } catch (_) {}

    setStatus(`Generating variant graph for ${country}…`, 'loading')
    graphVariant = await generateGraphLocal(extractedText, schema, { country, source })
    setStatus('Variant processed.', 'success')
    graphBase ? runComparison() : renderStandaloneGraph(graphVariant['@graph'] || [], '#06b6d4')
  } catch (e) {
    setStatus('Processing failed: ' + e.message, 'error')
  }
}

function toggleMockMode() {
  if (document.getElementById('mockModeToggle').checked) loadMockGraphs()
}

async function loadMockGraphs() {
  setStatus('Loading mock graphs…', 'loading')
  try {
    let base, variant
    try {
      const [br, vr] = await Promise.all([axios.post('/api/mock/base'), axios.post('/api/mock/variant')])
      base = br.data.graph; variant = vr.data.graph
    } catch (_) {
      staticMode = true
      const [br, vr] = await Promise.all([axios.get('data/eu_ai_act.jsonld'), axios.get('data/singapore_model_ai_governance.jsonld')])
      base = br.data; variant = vr.data
    }
    graphBase = base; graphVariant = variant
    setStatus('Mock graphs loaded.' + (staticMode ? ' [Static]' : ''), 'success')
    runComparison()
  } catch (e) { setStatus('Mock load failed: ' + e.message, 'error') }
}

async function runComparison() {
  if (!graphBase || !graphVariant) return
  setStatus('Comparing frameworks…', 'loading')
  try {
    let results
    if (staticMode) {
      results = compareGraphsLocal(graphBase, graphVariant)
    } else {
      try {
        const r = await axios.post('/api/compare', { graphBase, graphVariant })
        results = r.data.results
      } catch (_) { staticMode = true; results = compareGraphsLocal(graphBase, graphVariant) }
    }
    setStatus('Comparison complete.' + (staticMode ? ' [Client-side]' : ''), 'success')
    renderResults(results)
  } catch (e) { setStatus('Comparison failed: ' + e.message, 'error') }
}

async function exportComparison() {
  if (!lastResults) return
  try {
    const r = await axios.post('/api/export-comparison', { graphBase, graphVariant, comparisonResults: lastResults })
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'governance_comparison.json' })
    a.click(); URL.revokeObjectURL(url)
  } catch (e) { setStatus('Export failed: ' + e.message, 'error') }
}

function switchView() {
  if (lastResults) renderResults(lastResults)
  else if (graphBase) renderStandaloneGraph(graphBase['@graph'] || [], '#8b5cf6')
}

// ── Client-side comparison ────────────────────────────────────────────
function canonicalize(name) {
  return (name || '').toString().toLowerCase().replace(/[\s\-_]/g, '').replace(/organisation/g,'organization').replace(/governance/g,'gov')
}

function flattenForCompare(nodes) {
  const flat = [], seen = new Set()
  const traverse = (node, parentId) => {
    if (!node || typeof node !== 'object') return null
    let rawId = node['@id'] || node.id || node.name; if (!rawId) return null
    let id = /^(node_|req_|REQ)/i.test(rawId) ? rawId : (parentId ? `${parentId}.${rawId}` : rawId)
    if (seen.has(id)) return id; seen.add(id)
    const childIds = []
    for (const key of ['components','fields','rules','requirements','constraints','obligations']) {
      if (Array.isArray(node[key])) node[key].forEach(item => { if (typeof item === 'object') { const cid = traverse(item, id); if (cid) childIds.push(cid) } })
    }
    const relationships = (Array.isArray(node.relationships) ? node.relationships : []).filter(r => r?.target).map(r => ({ target: r.target, label: r.label || 'related_to' }))
    let canonical_id = node.canonical_id || (node.type !== 'Ontology' && node.type !== 'Relationship' ? canonicalize(node.name || rawId) : null)
    flat.push({ ...node, id, name: node.name || rawId, type: node.type || 'Requirement', canonical_id, relationships, hasField: childIds, parentId: parentId || null })
    return id
  }
  ;(Array.isArray(nodes) ? nodes : [nodes]).forEach(n => traverse(n, null))
  return flat
}

function compareGraphsLocal(graphBaseData, graphVariantData) {
  const nodesBase    = flattenForCompare(graphBaseData['@graph'] || [])
  const nodesVariant = flattenForCompare(graphVariantData['@graph'] || [])
  const mapVC = {}, mapV = {}
  nodesVariant.forEach(n => { const k = n.canonical_id || canonicalize(n.name||n.id); if (k) { mapVC[k] = n; mapV[canonicalize(n.name||n.id)] = n } })
  const matches = [], missing = [], extensions = [], conflicts = []
  const matchedIds = new Set()
  for (const base of nodesBase) {
    if (base.type === 'Ontology' || base.type === 'Relationship') continue
    const cid = base.canonical_id || canonicalize(base.name||base.id); if (!cid) continue
    const vMatch = mapVC[cid] || mapV[cid]
    if (vMatch) {
      matchedIds.add(vMatch.id)
      const diff = ['mandatory','type','category'].filter(p => (base[p]?.toString()||'') !== (vMatch[p]?.toString()||'')).map(p => ({ property:p, baseValue:base[p], targetValue:vMatch[p] }))
      diff.length ? conflicts.push({ canonicalId:cid, baseNode:base, variantNode:vMatch, diff, type:'CONFLICT' }) : matches.push({ canonicalId:cid, node:base, variantNode:vMatch, matchedWith:vMatch.id, type:'MATCH' })
    } else { missing.push({ canonicalId:cid, node:base, type:'MISSING' }) }
  }
  nodesVariant.filter(n => n.type!=='Ontology' && n.type!=='Relationship' && !matchedIds.has(n.id)).forEach(n => extensions.push({ node:n, type:'EXTENSION' }))
  const totalBase = nodesBase.filter(n => n.type!=='Ontology'&&n.type!=='Relationship').length
  return { matches, missing, extensions, conflicts, summary: { matches:matches.length, missing:missing.length, extensions:extensions.length, conflicts:conflicts.length, compliancePercent: totalBase ? Math.round(matches.length/totalBase*100) : 0, totalBaseNodes:totalBase, totalVariantNodes:nodesVariant.length } }
}

// ── Graph rendering ───────────────────────────────────────────────────
function flattenGraph(nodes) {
  const flat = [], seen = new Set()
  const traverse = (node, parentId, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 10) return null
    let rawId = node['@id'] || node.id || node.name; if (!rawId) return null
    let id = /^(node_|req_|REQ)/i.test(rawId) ? rawId : (parentId ? `${parentId}.${rawId}` : rawId)
    if (seen.has(id)) return id; seen.add(id)
    const hasField = [], relationships = (Array.isArray(node.relationships) ? node.relationships : []).filter(r => r?.target).map(r => ({ target:r.target, label:r.label||'related_to' }))
    for (const key of ['obligations','components','requirements','rules']) {
      if (Array.isArray(node[key])) node[key].forEach(item => { if (typeof item==='object'&&item.id) { const cid = traverse(item,id,depth+1); if (cid&&!hasField.includes(cid)) hasField.push(cid) } })
    }
    flat.push({ ...node, id, label:node.name||rawId, type:node.type||'Requirement', relationships, hasField, canonical_id:node.canonical_id||null, parentId:parentId||null })
    return id
  }
  ;(Array.isArray(nodes)?nodes:[nodes]).forEach(n=>traverse(n,null))
  return flat
}

const REL_COLORS = { defines:'#8b5cf6',contains:'#8b5cf6',includes:'#8b5cf6',requires:'#f59e0b',mandates:'#f59e0b',prohibits:'#ef4444',restricts:'#ef4444',governed_by:'#f59e0b',must_comply_with:'#f59e0b',subject_to:'#06b6d4',maps_to:'#10b981',similar_to:'#10b981',established_by:'#3b82f6',enforced_by:'#3b82f6',enables:'#a78bfa',supports:'#a78bfa',applies_to:'#f97316',classified_as:'#f97316',ensures:'#14b8a6',related_to:'#666',references:'#94a3b8' }
const relColor = l => REL_COLORS[l] || '#666'

function renderStandaloneGraph(rawNodes, color) {
  const flat = flattenGraph(rawNodes)
  document.getElementById('graphArea').style.display = ''
  updateStats(flat.length,'—','—','—','—')
  const nodes = flat.map(n => ({ id:n.id, label:`${n.name||n.id}\n[${n.type||'Req'}]`, title:`Type:${n.type}\nCanonical:${n.canonical_id||'N/A'}`, color:{background:color,border:'#fff'}, font:{color:'#fff',size:13}, data:n, shadow:{enabled:true} }))
  const nodeIds = new Set(nodes.map(n=>n.id)), edgeSet = new Set(), edges = []
  const addEdge = (f,t,l,c) => { const k=`${f}->${t}`; if(!edgeSet.has(k)&&nodeIds.has(f)&&nodeIds.has(t)){edgeSet.add(k);edges.push({from:f,to:t,arrows:'to',label:l,color:{color:c,opacity:0.7},width:1.5,font:{size:10,color:'#999',strokeWidth:0}})} }
  flat.forEach(n => { n.relationships.forEach(r=>addEdge(n.id,r.target,r.label,relColor(r.label))); (n.hasField||[]).forEach(c=>addEdge(n.id,c,'contains','#8b5cf6')) })
  renderNetwork(nodes, edges)
}

function renderResults(results) {
  lastResults = results
  const mode = document.getElementById('viewMode').value
  if (mode==='base'&&graphBase) { renderStandaloneGraph(graphBase['@graph']||[],'#8b5cf6'); return }
  if (results?.matches!==undefined) { renderComparisonGraph(results); return }
  if (graphBase) renderStandaloneGraph(graphBase['@graph']||[],'#8b5cf6')
}

function renderComparisonGraph({ matches,missing,extensions,conflicts,summary }) {
  document.getElementById('graphArea').style.display = ''
  updateStats(summary.matches,summary.missing,summary.extensions,summary.conflicts,summary.compliancePercent+'%')
  const compEl = document.getElementById('statCompliance')
  compEl.style.color = summary.compliancePercent>=80?'#10b981':summary.compliancePercent>=60?'#f59e0b':'#ef4444'

  const COLORS = { MATCH:'#10b981',MISSING:'#ef4444',EXTENSION:'#06b6d4',CONFLICT:'#f59e0b' }
  const nodes = [], edges = [], nodeIds = new Set(), edgeSet = new Set()
  const addN = (item,cat,prefix='') => {
    const node=item.node||item.baseNode; if(!node) return
    const nodeId=node.id||node['@id']; if(!nodeId) return
    nodeIds.add(nodeId)
    nodes.push({ id:nodeId, label:`${prefix}${node.name||nodeId}\n[${cat}]`, title:`${cat}\nCanonical:${node.canonical_id||'N/A'}`, color:{background:COLORS[cat]||'#8b5cf6',border:'#fff'}, font:{color:'#fff',size:13}, data:item, category:cat, shadow:{enabled:true} })
  }
  matches.forEach(m=>addN(m,'MATCH')); missing.forEach(m=>addN(m,'MISSING','❌ ')); extensions.forEach(e=>addN(e,'EXTENSION','🔵 ')); conflicts.forEach(c=>addN(c,'CONFLICT','⚠️ '))
  const vToD = {}; matches.forEach(m=>{if(m.matchedWith&&m.node) vToD[m.matchedWith]=m.node.id}); conflicts.forEach(c=>{if(c.variantNode&&c.baseNode) vToD[c.variantNode.id]=c.baseNode.id})
  const rid = id => vToD[id]||id
  const addEdge = (f,t,l,c) => { const k=`${f}->${t}`; if(!edgeSet.has(k)&&nodeIds.has(f)&&nodeIds.has(t)){edgeSet.add(k);edges.push({from:f,to:t,arrows:'to',label:l,color:{color:c,opacity:0.7},width:1.5,font:{size:10,color:'#999',strokeWidth:0}})} }
  ;[...matches,...missing,...extensions,...conflicts.map(c=>({node:c.baseNode}))].forEach(item => {
    const node=item.node||item.baseNode; if(!node) return
    const dId=rid(node.id)
    ;(node.relationships||[]).forEach(r=>addEdge(dId,rid(r.target),r.label,relColor(r.label)))
    ;(node.hasField||[]).forEach(c=>addEdge(dId,rid(c),'contains','#8b5cf6'))
  })
  renderNetwork(nodes, edges)
}

function renderNetwork(nodes, edges) {
  if (network) network.destroy()
  network = new vis.Network(document.getElementById('graphContainer'),
    { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
    { nodes:{shape:'dot',size:18,font:{size:13,color:'#fff'}}, edges:{smooth:{type:'cubicBezier',forceDirection:'vertical',roundness:0.4},arrows:{to:{scaleFactor:0.7}},font:{size:10,color:'#aaa',strokeWidth:0}},
      layout:{hierarchical:{enabled:edges.length>0,direction:'UD',sortMethod:'hubsize',levelSeparation:120,nodeSpacing:180}},
      physics:{enabled:edges.length===0,stabilization:{iterations:150}} })
  network.on('click', params => {
    if (!params.nodes.length) return
    const n = nodes.find(x=>x.id===params.nodes[0]); if (!n) return
    const cd = (document.getElementById('viewMode').value!=='base') ? lastResults?.conflicts?.find(c=>c.baseNode?.id===params.nodes[0]) : null
    showInspector(n.data, cd)
  })
  if (nodes.length) setTimeout(()=>network.fit(),500)
}

function showInspector(data, conflictData) {
  document.getElementById('inspector').style.display = ''
  const node = data.node||data.baseNode||data
  document.getElementById('inspectorTitle').textContent = node.name||node.id||'Node'
  const row = (l,v) => `<div class="detail-row"><div class="detail-label">${l}</div><div class="detail-value">${v||'N/A'}</div></div>`
  let html = row('ID',node.id)+row('Type',node.type)+row('Category',node.category)+row('Canonical ID',node.canonical_id?`<span style="color:#10b981">${node.canonical_id}</span>`:null)+row('Source',node.source)+row('Description',node.description||'No description')+row('Mandatory',node.mandatory!==undefined?(node.mandatory?'✅ Yes':'❌ No'):null)
  if (node.relationships?.length) {
    html += `<div class="detail-row"><div class="detail-label">Relationships</div><div class="detail-value">${node.relationships.map(r=>`<div><span style="color:${relColor(r.label)}">${r.label}</span> → ${r.target}</div>`).join('')}</div></div>`
  }
  if (conflictData?.diff?.length) {
    html += `<div class="conflict-diff"><h4>⚠️ Conflicts</h4>${conflictData.diff.map(d=>`<div class="diff-item"><strong>${d.property}:</strong><br><span class="diff-base">Base: ${d.baseValue??'—'}</span><br><span class="diff-variant">Variant: ${d.targetValue??'—'}</span></div>`).join('')}</div>`
  }
  document.getElementById('inspectorContent').innerHTML = html
}

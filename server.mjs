import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pdf = require('pdf-parse/lib/pdf-parse.js');

import { OpenAiService } from './services/openai.mjs';
import { GraphEngineService } from './services/graphEngine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store'); } }));

const upload = multer({ dest: 'uploads/' });

// Directories
const SCHEMA_DIR = path.join(__dirname, 'registry', 'schemas');
const GRAPH_DIR = path.join(__dirname, 'registry', 'graphs');
const SPEC_DIR = path.join(__dirname, 'specs');
const SAMPLES_DIR = path.join(__dirname, 'samples');

[SCHEMA_DIR, GRAPH_DIR, SPEC_DIR, SAMPLES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/**
 * 1. Initialize Framework Base Graph from Spec
 */
app.post('/api/standard-base-graph', async (req, res) => {
    try {
        const { standard, openaiConfig } = req.body;
        const config = JSON.parse(openaiConfig || '{}');
        const openai = new OpenAiService(config);

        const safeName = standard.toLowerCase().replace(/\s/g, '_');
        const graphPath = path.join(GRAPH_DIR, `${safeName}_base.json`);
        const schemaPath = path.join(SCHEMA_DIR, `${safeName}_schema.json`);

        // Check Cache
        if (fs.existsSync(graphPath)) {
            const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
            const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
            return res.json({ success: true, graph, schema, cached: true });
        }

        // Search for Spec file
        const specFile = path.join(SPEC_DIR, `${safeName}.txt`);
        if (!fs.existsSync(specFile)) {
            return res.status(404).json({ success: false, error: `No spec found for framework ${standard} in /specs folder.` });
        }

        const specText = fs.readFileSync(specFile, 'utf8');

        // Step A: Infer Schema
        const schema = await openai.inferSchema(standard, specText);
        fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

        // Step B: Build Base Graph
        const graph = await openai.generateGraph(specText, schema, { country: "Base", source: `Spec: ${standard}` });
        fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));

        res.json({ success: true, graph, schema, cached: false });
    } catch (error) {
        console.error('Error initializing base graph:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 2. Process Variant PDF (User Document)
 */
app.post('/api/process-variant', upload.single('file'), async (req, res) => {
    try {
        const { standard, country, source, openaiConfig } = req.body;
        const config = JSON.parse(openaiConfig || '{}');
        console.log(`📑 Processing Document for Framework: ${standard}, Region: ${country}`);
        const openai = new OpenAiService(config);

        const safeName = standard.toLowerCase().replace(/\s/g, '_');
        const schemaPath = path.join(SCHEMA_DIR, `${safeName}_schema.json`);

        let schema = { "@context": {}, "@graph": [], name: standard };
        if (fs.existsSync(schemaPath)) {
            schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        }

        // Parse PDF
        const dataBuffer = fs.readFileSync(req.file.path);
        const pdfData = await pdf(dataBuffer);
        const extractedText = pdfData.text;
        console.log(`📄 PDF Parsing complete. Extracted ${extractedText?.length || 0} characters.`);

        // Generate Variant Graph
        const graph = await openai.generateGraph(extractedText, schema, { country, source });

        fs.unlinkSync(req.file.path);
        res.json({ success: true, graph });
    } catch (error) {
        console.error('Error processing variant:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 3. Compare Base with Variant
 */
app.post('/api/compare', (req, res) => {
    try {
        const { graphBase, graphVariant } = req.body;
        const engine = new GraphEngineService();
        const results = engine.compareGraphs(graphBase, graphVariant);
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 4. Export Comparison Results
 */
app.post('/api/export-comparison', (req, res) => {
    try {
        const { graphBase, graphVariant, comparisonResults, format = 'jsonld' } = req.body;
        
        const exportData = {
            metadata: {
                generated: new Date().toISOString(),
                version: '1.0'
            },
            comparison: {
                summary: comparisonResults.summary,
                matches: comparisonResults.matches || [],
                missing: comparisonResults.missing || [],
                extensions: comparisonResults.extensions || [],
                conflicts: comparisonResults.conflicts || []
            },
            "@context": {
                "@vocab": "https://governance.ai/ontology/",
                "matches": "https://governance.ai/schema#matches",
                "missing": "https://governance.ai/schema#missing",
                "extensions": "https://governance.ai/schema#extensions",
                "conflicts": "https://governance.ai/schema#conflicts"
            }
        };

        if (format === 'csv') {
            const csv = convertToCSV(comparisonResults);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="comparison.csv"');
            res.send(csv);
        } else {
            res.json(exportData);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 5. Generate Metrics Report
 */
app.post('/api/metrics', (req, res) => {
    try {
        const { comparisonResults } = req.body;
        const { summary } = comparisonResults;

        const totalElements = summary.matches + summary.missing + summary.extensions;
        const metrics = {
            compliancePercent: summary.compliancePercent || 0,
            totalBaseElements: summary.totalBaseNodes || 0,
            implementedElements: summary.matches,
            missingElements: summary.missing,
            extensionElements: summary.extensions,
            conflictingRules: summary.conflicts,
            totalVariantElements: summary.totalVariantNodes || 0,
            coverageRatio: totalElements > 0 ? (summary.matches / totalElements * 100).toFixed(2) : 0
        };

        res.json({ success: true, metrics });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function convertToCSV(comparisonResults) {
    const rows = [
        ['Category', 'Name', 'Canonical ID', 'Type', 'Source', 'Details']
    ];

    (comparisonResults.matches || []).forEach(m => {
        rows.push(['MATCH', m.node.name, m.canonicalId, m.node.type, m.node.source, m.node.description || '']);
    });
    (comparisonResults.missing || []).forEach(m => {
        rows.push(['MISSING', m.node.name, m.canonicalId, m.node.type, m.node.source, 'Not implemented in variant']);
    });
    (comparisonResults.extensions || []).forEach(e => {
        rows.push(['EXTENSION', e.node.name, 'N/A', e.node.type, e.node.source, 'Outside base framework']);
    });
    (comparisonResults.conflicts || []).forEach(c => {
        const details = (c.diff || []).map(d => `${d.property}: ${d.baseValue} → ${d.targetValue}`).join('; ');
        rows.push(['CONFLICT', c.baseNode.name, c.canonicalId, c.baseNode.type, c.baseNode.source, details]);
    });

    return rows.map(row => row.map(cell => `"${(cell || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
}

/**
 * 6. Test API Connection
 */
app.post('/api/test-api', async (req, res) => {
    try {
        const { openaiConfig } = req.body;
        const config = JSON.parse(openaiConfig || '{}');
        const openai = new OpenAiService(config);

        const response = await openai._callOpenAI([
            { role: 'user', content: 'Say "Connection Successful" in 2 words.' }
        ], false);

        const message = response.choices[0].message.content;
        res.json({ success: true, message });
    } catch (error) {
        console.error('Test API failed:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/standards', (req, res) => {
    const files = fs.readdirSync(SPEC_DIR);
    res.json(files.map(f => f.replace('.txt', '').replace(/_/g, ' ').toUpperCase()));
});

/**
 * Mock Mode: Load base graph (EU AI Act)
 */
app.post('/api/mock/base', (req, res) => {
    try {
        const basePath = path.join(SAMPLES_DIR, 'eu_ai_act.jsonld');
        if (!fs.existsSync(basePath)) {
            return res.status(404).json({ success: false, error: 'Sample base JSONLD not found in samples/' });
        }
        const graph = JSON.parse(fs.readFileSync(basePath, 'utf8'));
        const schema = { "@context": graph["@context"] || {}, "@graph": [], name: "EU AI Act (Mock)" };
        res.json({ success: true, graph, schema, cached: true, mock: true });
    } catch (error) {
        console.error('Mock base load failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Mock Mode: Load variant graph (Singapore Model AI Governance)
 */
app.post('/api/mock/variant', (req, res) => {
    try {
        const variantPath = path.join(SAMPLES_DIR, 'singapore_model_ai_governance.jsonld');
        if (!fs.existsSync(variantPath)) {
            return res.status(404).json({ success: false, error: 'Sample variant JSONLD not found in samples/' });
        }
        const graph = JSON.parse(fs.readFileSync(variantPath, 'utf8'));
        res.json({ success: true, graph, mock: true });
    } catch (error) {
        console.error('Mock variant load failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = 3002;
app.listen(PORT, () => console.log(`🏛️  GraphRAG Governance Engine running on http://localhost:${PORT}`));

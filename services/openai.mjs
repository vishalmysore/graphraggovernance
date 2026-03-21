import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

/**
 * Service for AI API interactions — adapted for AI governance framework analysis.
 */
export class OpenAiService {
    constructor(config = {}) {
        this.config = {
            apiLink: config.apiLink || 'https://api.openai.com/v1',
            apiKey: config.apiKey || '',
            model: config.model || 'gpt-4o-mini',
            temperature: config.temperature !== undefined ? config.temperature : 0,
        };
    }

    async _callOpenAI(messages, responseFormatJson = true) {
        const url = `${this.config.apiLink.replace(/\/$/, '')}/chat/completions`;
        const headers = {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
        };

        const payload = {
            model: this.config.model,
            messages,
            temperature: this.config.temperature,
            max_tokens: 4096,
            ...(responseFormatJson ? { response_format: { type: "json_object" } } : {})
        };

        console.log(`📤 Sending AI Request to ${this.config.model}... Payload size: ${JSON.stringify(payload).length} chars`);

        try {
            const response = await axios.post(url, payload, { headers, timeout: 120000 });
            return response.data;
        } catch (error) {
            console.error('AI API Call failed:', error.response?.data || error.message);

            if (responseFormatJson && (error.response?.status === 400 || error.response?.data?.error?.message?.includes('format'))) {
                console.warn('Falling back to non-JSON response format...');
                return this._callOpenAI(messages, false);
            }
            throw error;
        }
    }

    async inferSchema(standardName, documentText) {
        console.log(`Inferring governance schema for framework: ${standardName}...`);

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
- Relationship types: defines, requires, applies_to, classified_as, governed_by, must_comply_with, includes, prohibits, restricts, establishes, mandates, enforced_by, subject_to, enables, supports, maps_to

Return: { "@context": {}, "@graph": [{entity1}, {entity2}, ...] }`;

        const userPrompt = `Framework: ${standardName}\nContent:\n${documentText.substring(0, 10000)}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const data = await this._callOpenAI(messages);
        let content = data.choices[0].message.content;

        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            content = content.substring(jsonStart, jsonEnd + 1);
        }

        return JSON.parse(content);
    }

    async generateGraph(documentText, masterSchema, contextMetadata) {
        console.log(`Generating governance knowledge graph for ${contextMetadata.country}...`);

        const systemPrompt = `You are an AI governance analyst building knowledge graphs from regulatory documents.
Extract entities and relationships from the document and map each to canonical governance concepts.

ENTITY TYPES:
- Regulation, RiskCategory, Requirement, Principle, Entity, Concept, RegulatoryBody, Process

EACH NODE MUST HAVE:
- id: unique identifier
- name: short human-readable name
- type: one of the entity types above
- category: domain group (Risk, Governance, Transparency, Fairness, Data, Compliance, etc.)
- canonical_id: normalized key matching base framework concepts (see list below). Set to null if new concept.
- description: clear description
- source: "${contextMetadata.source}"
- mandatory: true/false (if applicable)
- is_extension: true ONLY if this concept does NOT exist in the base framework

RELATIONSHIPS array on each node:
- {"target": "target_node_id", "label": "relationship_type"}
- Types: defines, requires, applies_to, classified_as, governed_by, must_comply_with, includes, prohibits, restricts, establishes, mandates, enforced_by, subject_to, enables, supports, maps_to, similar_to, broader_than, narrower_than

CANONICAL ID MAPPING — use these base framework canonical IDs where concepts overlap:
${this._generateCanonicalReference(masterSchema)}

OUTPUT: { "@context": {}, "@graph": [{entity1}, {entity2}, ...] }`;

        const userPrompt = `Extract governance entities and relationships from:
        
Document Source: ${contextMetadata.source}
Region: ${contextMetadata.country}
Framework Reference: ${masterSchema.name || 'AI Governance'}

TEXT:
${documentText.substring(0, 6000)}

Return complete JSON-LD with canonical_id mapping.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        try {
            const data = await this._callOpenAI(messages);
            let content = data.choices[0].message.content;

            const jsonStart = content.indexOf('{');
            const jsonEnd = content.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                content = content.substring(jsonStart, jsonEnd + 1);
            }

            let result = JSON.parse(content);
            if (!result['@graph']) {
                result = {
                    "@context": masterSchema['@context'] || {},
                    "@graph": result.graph || result.nodes || (Array.isArray(result) ? result : [result])
                };
            }

            if (Array.isArray(result['@graph'])) {
                result['@graph'] = result['@graph'].map(node => {
                    if (!node.hasOwnProperty('canonical_id')) {
                        node.canonical_id = null;
                        node.is_extension = true;
                    }
                    return node;
                });
            }

            return result;
        } catch (error) {
            console.error('AI Processing Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    _generateCanonicalReference(masterSchema) {
        const concepts = new Set();

        const extractIds = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (obj.canonical_id && obj.type !== 'Ontology' && obj.type !== 'Relationship') {
                const label = `${obj.canonical_id} (type: ${obj.type || 'Requirement'}, id: ${obj.id || 'unknown'})`;
                concepts.add(label);
            } else if (obj.id && obj.type !== 'Ontology' && obj.type !== 'Relationship') {
                const normalized = obj.id.toString().toLowerCase().replace(/[\s\-_]/g, '');
                concepts.add(`${normalized} (type: ${obj.type || 'Requirement'}, id: ${obj.id})`);
            }
            for (const key of ['components', 'obligations', 'rules', 'requirements', '@graph']) {
                if (Array.isArray(obj[key])) {
                    obj[key].forEach(item => extractIds(item));
                }
            }
        };

        if (masterSchema) {
            extractIds(masterSchema);
            if (masterSchema['@graph']) {
                masterSchema['@graph'].forEach(node => extractIds(node));
            }
        }

        // Core AI governance canonical IDs as fallback
        const coreDefaults = [
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

        coreDefaults.forEach(c => {
            const key = c.split(' ')[0];
            if (![...concepts].some(existing => existing.startsWith(key))) {
                concepts.add(c);
            }
        });

        return [...concepts].map(c => `- ${c}`).join('\n');
    }
}

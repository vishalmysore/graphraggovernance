import crypto from 'crypto';

/**
 * Service for graph normalization, comparison and diffing.
 * Adapted for AI governance framework comparison.
 */
export class GraphEngineService {
    constructor() { }

    /**
     * Canonicalizes node names for deterministic matching.
     */
    canonicalize(name) {
        if (!name) return "";
        return name.toString()
            .toLowerCase()
            .replace(/[\s\-_]/g, '')
            .replace(/organisation/g, 'organization')
            .replace(/governance/g, 'gov');
    }

    _flattenNodes(nodes) {
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
            if (Array.isArray(node.depends_on)) {
                node.depends_on.forEach(ref => {
                    if (typeof ref === 'string') depends_on.push(ref);
                });
            }
            const refines = [];
            if (Array.isArray(node.refines)) {
                node.refines.forEach(ref => {
                    if (typeof ref === 'string') refines.push(ref);
                });
            }

            if (Array.isArray(node.hasField)) {
                node.hasField.forEach(ref => {
                    if (typeof ref === 'string' && !childIds.includes(ref)) {
                        childIds.push(ref);
                    }
                });
            }

            // GraphRAG: typed relationships array
            const relationships = [];
            if (Array.isArray(node.relationships)) {
                node.relationships.forEach(rel => {
                    if (rel && typeof rel === 'object' && rel.target) {
                        relationships.push({ target: rel.target, label: rel.label || 'related_to' });
                    }
                });
            }

            let canonical_id = node.canonical_id;
            if (!canonical_id && node.type !== 'Ontology' && node.type !== 'Relationship') {
                canonical_id = this.canonicalize(node.name || rawId);
            }

            flat.push({
                ...node,
                id,
                name: node.name || rawId,
                type: node.type || 'Requirement',
                canonical_id,
                depends_on,
                refines,
                relationships,
                hasField: childIds,
                parentId: node.parentId || parentId || null
            });

            return id;
        };

        const inputArr = Array.isArray(nodes) ? nodes : [nodes];
        inputArr.forEach(n => traverse(n, null));

        // Second pass: build hasField from parentId references
        const idToNode = {};
        flat.forEach(n => { idToNode[n.id] = n; });
        flat.forEach(n => {
            if (n.parentId && idToNode[n.parentId]) {
                const parent = idToNode[n.parentId];
                if (!parent.hasField.includes(n.id)) {
                    parent.hasField.push(n.id);
                }
            }
        });

        console.log(`✅ Extraction complete: Total unique entities: ${flat.length}`);
        return flat;
    }

    /**
     * CANONICAL COMPARISON ENGINE
     * 1. MATCH — Same canonical_id, no attribute conflicts
     * 2. MISSING — In base framework, not in variant
     * 3. EXTENSION — In variant, not in base framework
     * 4. CONFLICT — Same canonical_id, attributes differ
     */
    compareGraphs(graphBase, graphVariant) {
        console.log('🔍 Comparing governance frameworks...');

        const rawNodesBase = graphBase['@graph'] || (Array.isArray(graphBase) ? graphBase : []);
        const rawNodesVariant = graphVariant['@graph'] || (Array.isArray(graphVariant) ? graphVariant : []);

        const nodesBase = this._flattenNodes(rawNodesBase);
        const nodesVariant = this._flattenNodes(rawNodesVariant);

        const mapBaseCanonical = this._buildCanonicalMap(nodesBase);
        const mapVariantCanonical = this._buildCanonicalMap(nodesVariant);
        
        const mapBase = this.buildNormalizedMap(nodesBase);
        const mapVariant = this.buildNormalizedMap(nodesVariant);

        const matches = [];
        const missing = [];
        const extensions = [];
        const conflicts = [];

        const matchedVariantIds = new Set();

        // STEP 1: Scan base nodes
        for (const baseNode of nodesBase) {
            if (baseNode.type === 'Ontology' || baseNode.type === 'Relationship') continue;

            const canonicalId = baseNode.canonical_id || this.canonicalize(baseNode.name || baseNode.id);
            if (!canonicalId) continue;

            // Try canonical_id match first
            let variantMatch = mapVariantCanonical[canonicalId];

            // Fallback: normalized name
            if (!variantMatch) {
                variantMatch = mapVariant[canonicalId];
            }

            // Fallback: raw id
            if (!variantMatch) {
                const rawIdKey = this.canonicalize(baseNode.id);
                variantMatch = mapVariantCanonical[rawIdKey] || mapVariant[rawIdKey];
            }

            if (variantMatch) {
                matchedVariantIds.add(variantMatch.id);
                const diff = this.computeRuleDiff(baseNode, variantMatch);
                if (diff.isConflict) {
                    conflicts.push({
                        canonicalId,
                        baseNode,
                        variantNode: variantMatch,
                        diff: diff.changes,
                        type: 'CONFLICT'
                    });
                } else {
                    matches.push({
                        canonicalId,
                        node: baseNode,
                        variantNode: variantMatch,
                        matchedWith: variantMatch.id,
                        type: 'MATCH'
                    });
                }
            } else {
                missing.push({
                    canonicalId,
                    node: baseNode,
                    type: 'MISSING'
                });
            }
        }

        // STEP 2: Scan variant nodes for EXTENSIONS
        for (const variantNode of nodesVariant) {
            if (variantNode.type === 'Ontology' || variantNode.type === 'Relationship') continue;
            const wasMatched = matchedVariantIds.has(variantNode.id);
            
            if (!wasMatched) {
                extensions.push({
                    node: variantNode,
                    type: 'EXTENSION'
                });
            }
        }

        const totalBaseNodes = nodesBase.filter(n => n.type !== 'Ontology' && n.type !== 'Relationship').length;
        const compliancePercent = totalBaseNodes > 0 ? Math.round((matches.length / totalBaseNodes) * 100) : 0;

        const summary = {
            matches: matches.length,
            missing: missing.length,
            extensions: extensions.length,
            conflicts: conflicts.length,
            compliancePercent,
            totalBaseNodes,
            totalVariantNodes: nodesVariant.length
        };

        console.log(`📊 Comparison Summary:`, summary);

        return { matches, missing, extensions, conflicts, summary };
    }

    _buildCanonicalMap(nodes) {
        const map = {};
        nodes.forEach(node => {
            const key = node.canonical_id || this.canonicalize(node.name || node.id);
            if (key) map[key] = node;
        });
        return map;
    }

    buildNormalizedMap(nodes) {
        const map = {};
        nodes.forEach(node => {
            const nameKey = this.canonicalize(node.name || node.label || node.id);
            if (nameKey) map[nameKey] = node;
        });
        return map;
    }

    computeRuleDiff(nodeA, nodeB) {
        const changes = [];
        const propsToCompare = ['mandatory', 'required', 'is_mandatory', 'format', 'pattern', 'condition', 'type', 'category'];

        propsToCompare.forEach(prop => {
            const valA = nodeA[prop] !== undefined ? nodeA[prop].toString().toLowerCase() : null;
            const valB = nodeB[prop] !== undefined ? nodeB[prop].toString().toLowerCase() : null;
            if (valA !== valB) {
                changes.push({
                    property: prop,
                    baseValue: nodeA[prop],
                    targetValue: nodeB[prop]
                });
            }
        });

        return { isConflict: changes.length > 0, changes };
    }
}

/**
 * Memory Tool — Unified interface to Blair's memory systems
 *
 * Wraps: memory.js (JSON), vector-memory.js (pgvector), brain/loader.js
 *
 * Actions:
 *   search         — Semantic search across all memory layers
 *   store          — Store content in vector memory
 *   recall         — Keyword search in JSON memories
 *   remember       — Add a JSON memory entry
 *   daily_note     — Read/write daily notes
 *   project_file   — Read/write project-specific files
 *   memory_md      — Read/update MEMORY.md sections
 *   decision       — Record a decision
 *   stats          — Get memory system stats
 */

const memory = require('../memory');
const vectorMemory = require('../vector-memory');
const brain = require('../brain/loader');
const logger = require('../runtime/logger');

const description = 'Unified memory system (JSON + pgvector + brain)';
const actions = ['search', 'store', 'recall', 'remember', 'daily_note', 'project_file', 'memory_md', 'decision', 'stats'];

/**
 * @param {object} input - { action, ...params }
 * @param {object} ctx - { wsSend, projectId }
 */
async function execute(input, ctx = {}) {
  const { action = 'search' } = input;

  switch (action) {
    case 'search': {
      const { query, limit = 5, type, projectId } = input;
      if (!query) throw new Error('Missing required field: query');

      // Search both vector and JSON memories in parallel
      const [vectorResults, jsonResults] = await Promise.all([
        vectorMemory.search(query, { limit, type, projectId }).catch(() => []),
        Promise.resolve(memory.searchMemories(query, limit)),
      ]);

      return {
        vector: vectorResults,
        json: jsonResults.map(m => ({
          id: m.id,
          content: m.content,
          category: m.category,
          tags: m.tags,
          importance: m.importance,
          score: m.score,
        })),
        totalResults: vectorResults.length + jsonResults.length,
      };
    }

    case 'store': {
      const { content, type = 'memory', projectId, tags = [] } = input;
      if (!content) throw new Error('Missing required field: content');
      const result = await vectorMemory.store(content, { type, projectId, tags });
      return result;
    }

    case 'recall': {
      const { query, limit = 10 } = input;
      if (!query) throw new Error('Missing required field: query');
      return memory.searchMemories(query, limit);
    }

    case 'remember': {
      const { content, tags = [], importance = 5, category = 'general' } = input;
      if (!content) throw new Error('Missing required field: content');
      const mem = memory.addMemory(content, tags, importance, category);
      // Also store in vector memory for semantic search
      vectorMemory.store(content, {
        type: category,
        tags,
      }).catch(() => {});
      return mem;
    }

    case 'daily_note': {
      const { operation = 'read', date, section, content } = input;
      if (operation === 'read') {
        return { content: memory.readDailyNote(date), date: date || new Date().toISOString().split('T')[0] };
      }
      if (operation === 'write' || operation === 'append') {
        if (!section || !content) throw new Error('Missing required fields: section, content');
        memory.appendDailyNote(section, content, date);
        memory.autoCurate('append-daily-note', { section, content: content.slice(0, 100) });
        return { written: true, section };
      }
      if (operation === 'list') {
        return memory.listDailyNotes(input.limit || 30);
      }
      throw new Error(`Unknown daily_note operation: ${operation}`);
    }

    case 'project_file': {
      const { operation = 'read', slug, file, content } = input;
      if (!slug) throw new Error('Missing required field: slug');
      if (operation === 'read') {
        return { content: memory.readProjectFile(slug, file || 'notes.md') };
      }
      if (operation === 'write') {
        if (!content) throw new Error('Missing required field: content');
        memory.writeProjectFile(slug, file || 'notes.md', content);
        return { written: true };
      }
      if (operation === 'append') {
        if (!content) throw new Error('Missing required field: content');
        memory.appendProjectFile(slug, file || 'notes.md', content);
        return { appended: true };
      }
      if (operation === 'list') {
        return memory.listProjectFiles(slug);
      }
      throw new Error(`Unknown project_file operation: ${operation}`);
    }

    case 'memory_md': {
      const { operation = 'read', section, content } = input;
      if (operation === 'read') {
        return { content: memory.readMemoryMd() };
      }
      if (operation === 'update') {
        if (!section || !content) throw new Error('Missing required fields: section, content');
        const check = memory.isSafeAutoCuration('update-memory-section', 'MEMORY.md');
        if (!check.safe) throw new Error(check.reason);
        memory.updateMemoryMdSection(section, content);
        brain.invalidateMemoryCache();
        memory.autoCurate('update-memory-section', { section });
        return { updated: true, section };
      }
      throw new Error(`Unknown memory_md operation: ${operation}`);
    }

    case 'decision': {
      const { title, content, projectSlug } = input;
      if (!title || !content) throw new Error('Missing required fields: title, content');
      const filePath = memory.recordDecision(title, content, projectSlug);
      // Also store in vector memory
      vectorMemory.store(`Decision: ${title}\n${content}`, {
        type: 'decision', projectId: projectSlug, tags: ['decision'],
      }).catch(() => {});
      return { recorded: true, path: filePath };
    }

    case 'stats': {
      const jsonStats = memory.getMemoryStats();
      const vecStats = vectorMemory.getStats();
      const dailyNotes = memory.listDailyNotes(5);
      const smartMem = brain.getSmartMemory();
      return {
        json: jsonStats,
        vector: vecStats,
        dailyNotes: dailyNotes.length,
        hasMemoryMd: !!smartMem.memoryMd,
        hasProjectsMd: !!smartMem.projectsMd,
      };
    }

    default:
      throw new Error(`Unknown memory action: ${action}`);
  }
}

module.exports = { execute, description, actions };

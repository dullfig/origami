#!/usr/bin/env node
/**
 * MCP stdio server for context folding.
 * Zero dependencies — implements the MCP JSON-RPC protocol directly.
 *
 * Provides five tools that Opus calls during conversation:
 *   origami_guide   – get the context folding guide
 *   unfold_section  – expand a folded section to full detail
 *   fold_section    – collapse a section back to summary-only
 *   list_folds      – show the fold index
 *   write_summary   – create/update a self-compressed fold summary
 *
 * All state lives on disk at .claude/context-folding/ relative to cwd.
 */

const fs = require("fs");
const path = require("path");

// ── plugin guide (returned by origami_guide tool) ───────────────────

const PLUGIN_ROOT = path.dirname(__dirname);
let _guideCache = null;

function loadGuide() {
  if (_guideCache) return _guideCache;
  const skillPath = path.join(PLUGIN_ROOT, "skills", "context-folding", "SKILL.md");
  try {
    _guideCache = fs.readFileSync(skillPath, "utf-8");
  } catch {
    _guideCache =
      "Origami context folding is active. Use unfold_section to expand " +
      "folded sections, fold_section to collapse them, list_folds to see " +
      "all sections, and write_summary to update fold summaries.";
  }
  return _guideCache;
}

// ── paths ────────────────────────────────────────────────────────────

const FOLD_DIR = path.join(process.cwd(), ".claude", "context-folding");
const STATE_FILE = path.join(FOLD_DIR, "state.json");
const FOLDS_DIR = path.join(FOLD_DIR, "folds");

// ── state helpers ────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { version: 1, session_id: null, total_summary_tokens: 0, folds: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(FOLD_DIR, { recursive: true });
  fs.mkdirSync(FOLDS_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function estimateTokens(text) {
  return Math.max(1, Math.round((text || "").length / 3.75));
}

function findFold(state, foldId) {
  return state.folds.find((f) => f.id === foldId) || null;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// ── tool definitions ────────────────────────────────────────────────

const TOOLS = [
  {
    name: "origami_guide",
    description:
      "Get the full Origami context folding guide. " +
      "CALL THIS FIRST when you see [CONTEXT FOLDING] or fold IDs (F001, F002...) in your context.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "unfold_section",
    description:
      "Expand a folded conversation section to see its full detail. " +
      "Use when you need specific code, errors, or decisions from an earlier section.",
    inputSchema: {
      type: "object",
      properties: {
        fold_id: { type: "string", description: "Fold ID, e.g. 'fold-001'" },
      },
      required: ["fold_id"],
    },
  },
  {
    name: "fold_section",
    description:
      "Collapse a section back to summary-only. " +
      "Use when you no longer need the full detail to free context space.",
    inputSchema: {
      type: "object",
      properties: {
        fold_id: { type: "string", description: "Fold ID, e.g. 'fold-001'" },
      },
      required: ["fold_id"],
    },
  },
  {
    name: "list_folds",
    description:
      "List all fold sections with their status, summary, token count, and relevance score.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "write_summary",
    description:
      "Write or update the self-compressed summary for a fold. " +
      "Use the dense format: topic>action: key.details | outcome | D:files",
    inputSchema: {
      type: "object",
      properties: {
        fold_id: { type: "string", description: "Fold ID, e.g. 'fold-001'" },
        summary: { type: "string", description: "Self-compressed summary text" },
      },
      required: ["fold_id", "summary"],
    },
  },
];

// ── tool dispatch ───────────────────────────────────────────────────

function callTool(name, args) {
  switch (name) {
    case "origami_guide":
      return textResult(loadGuide());

    case "unfold_section": {
      const foldId = args.fold_id;
      const detailPath = path.join(FOLDS_DIR, `${foldId}.md`);
      if (!fs.existsSync(detailPath)) {
        return textResult(`Error: fold '${foldId}' not found on disk.`);
      }
      const detail = fs.readFileSync(detailPath, "utf-8");
      const state = loadState();
      const fold = findFold(state, foldId);
      if (fold) {
        fold.status = "unfolded";
        saveState(state);
      }
      return textResult(
        `[${foldId} UNFOLDED - ${estimateTokens(detail)} tokens]\n\n${detail}`
      );
    }

    case "fold_section": {
      const foldId = args.fold_id;
      const state = loadState();
      const fold = findFold(state, foldId);
      if (!fold) {
        return textResult(`Error: fold '${foldId}' not found in state.`);
      }
      fold.status = "folded";
      saveState(state);
      return textResult(`[${foldId} FOLDED]\nSummary: ${fold.summary}`);
    }

    case "list_folds": {
      const state = loadState();
      if (!state.folds.length) {
        return textResult("No folds stored yet.");
      }
      const totalStored = state.folds.reduce(
        (s, f) => s + (f.detail_tokens || 0),
        0
      );
      let out =
        `[FOLD INDEX - ${state.folds.length} sections, ` +
        `${totalStored} tokens stored]\n\n`;
      for (const fold of state.folds) {
        const fid = fold.id.toUpperCase().replace("FOLD-", "F");
        const status = fold.status.toUpperCase();
        const rel = (fold.relevance_score || 0).toFixed(2);
        out += `${fid} | ${status} | ${fold.detail_tokens || 0} tok | rel:${rel}\n`;
        out += `  ${fold.summary}\n`;
        if (fold.files_touched && fold.files_touched.length) {
          out += `  files: ${fold.files_touched.join(", ")}\n`;
        }
        out += "\n";
      }
      return textResult(out);
    }

    case "write_summary": {
      const { fold_id: foldId, summary } = args;
      const state = loadState();
      const fold = findFold(state, foldId);
      if (!fold) {
        return textResult(`Error: fold '${foldId}' not found in state.`);
      }
      fold.summary = summary;
      fold.summary_tokens = estimateTokens(summary);
      state.total_summary_tokens = state.folds.reduce(
        (s, f) => s + (f.summary_tokens || 0),
        0
      );
      saveState(state);
      return textResult(
        `Summary updated for ${foldId} (${fold.summary_tokens} tokens)`
      );
    }

    default:
      return textResult(`Unknown tool: ${name}`);
  }
}

// ── minimal MCP JSON-RPC stdio transport ────────────────────────────

const SERVER_INFO = { name: "context-folding", version: "1.0.0" };

function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — nothing to respond to
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: callTool(params.name, params.arguments || {}),
      };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

// Read MCP messages (Content-Length framed) from stdin
let buf = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;

  while (true) {
    // Look for Content-Length header
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buf.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Malformed — skip past this header
      buf = buf.slice(headerEnd + 4);
      continue;
    }

    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break; // need more data

    const body = buf.slice(bodyStart, bodyStart + len);
    buf = buf.slice(bodyStart + len);

    try {
      const msg = JSON.parse(body);
      const response = handleMessage(msg);
      if (response) send(response);
    } catch (err) {
      // Parse error — send JSON-RPC error if we can
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
  }
});

process.stdin.on("end", () => process.exit(0));

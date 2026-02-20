#!/usr/bin/env node
/**
 * MCP stdio server for context folding.
 *
 * Provides four tools that Opus calls during conversation:
 *   unfold_section  – expand a folded section to full detail
 *   fold_section    – collapse a section back to summary-only
 *   list_folds      – show the fold index
 *   write_summary   – create/update a self-compressed fold summary
 *
 * All state lives on disk at .claude/context-folding/ relative to cwd.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");

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

// ── MCP server ───────────────────────────────────────────────────────

const server = new Server(
  { name: "context-folding", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── list tools ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "unfold_section",
      description:
        "Expand a folded conversation section to see its full detail. " +
        "Use when you need specific code, errors, or decisions from an earlier section.",
      inputSchema: {
        type: "object",
        properties: {
          fold_id: {
            type: "string",
            description: "Fold ID, e.g. 'fold-001'",
          },
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
          fold_id: {
            type: "string",
            description: "Fold ID, e.g. 'fold-001'",
          },
        },
        required: ["fold_id"],
      },
    },
    {
      name: "list_folds",
      description:
        "List all fold sections with their status, summary, token count, and relevance score.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "write_summary",
      description:
        "Write or update the self-compressed summary for a fold. " +
        "Use the dense format: topic>action: key.details | outcome | D:files",
      inputSchema: {
        type: "object",
        properties: {
          fold_id: {
            type: "string",
            description: "Fold ID, e.g. 'fold-001'",
          },
          summary: {
            type: "string",
            description: "Self-compressed summary text",
          },
        },
        required: ["fold_id", "summary"],
      },
    },
  ],
}));

// ── call tool ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── unfold ─────────────────────────────────────────────────────
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

    // ── fold ───────────────────────────────────────────────────────
    case "fold_section": {
      const foldId = args.fold_id;
      const state = loadState();
      const fold = findFold(state, foldId);

      if (!fold) {
        return textResult(`Error: fold '${foldId}' not found in state.`);
      }

      fold.status = "folded";
      saveState(state);

      return textResult(
        `[${foldId} FOLDED]\nSummary: ${fold.summary}`
      );
    }

    // ── list ───────────────────────────────────────────────────────
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

    // ── write summary ──────────────────────────────────────────────
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
});

// ── start ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("context-folding MCP server error:", err);
  process.exit(1);
});

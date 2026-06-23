// Shared helpers for parsing Copilot/agent tool_call inputs.

// Pull the line range out of a tool_call input. Returns { start, end } as raw
// values (number-or-null); callers apply their own display formatting/defaults.
//
// Only the line-range extraction is shared: the two callers (prompt-inspect's
// display and prompt-supervisor's view-loop key) deliberately select the file
// path differently (inspect includes `input.file` and trim-skips empty
// candidates; the supervisor excludes `input.file`), so each resolves the path
// itself rather than through this helper.
export function parseToolLineRange(input = {}) {
  const inp = input || {};
  let start = null;
  let end = null;
  if (Array.isArray(inp.view_range) && inp.view_range.length >= 1) {
    start = inp.view_range[0] ?? null;
    end = inp.view_range[1] ?? null;
  } else {
    start = inp.line ?? inp.offset ?? inp.start_line ?? null;
    end = inp.limit ?? inp.end_line ?? inp.line_limit ?? null;
  }
  return { start, end };
}

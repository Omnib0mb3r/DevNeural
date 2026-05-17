/**
 * Tiny in-house markdown renderer.
 *
 * Handles the subset DevNeural's docs actually use: headings (h1-h3),
 * paragraphs, ordered + unordered lists, bold + italic, inline code,
 * fenced code blocks, hyperlinks, and pipe tables. Deliberately tiny:
 * a full remark/marked pipeline would pull megabytes of deps into the
 * dashboard bundle for a strictly read-only Help surface.
 *
 * Extracted from the original renderer in DailyBrief.tsx + extended
 * with code-block + table support so the help/voice-commands.md
 * content renders correctly.
 *
 * Lifecycle: pure function over `markdown` props. No state, no DOM
 * effects. Callers can wrap in their own panel chrome.
 */
"use client";

import * as React from "react";

interface MarkdownPanelProps {
  markdown: string;
}

export function MarkdownPanel({ markdown }: MarkdownPanelProps): React.ReactElement {
  return <div className="prose-tight">{renderMarkdown(markdown)}</div>;
}

function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let listBuf: string[] = [];
  let listOrdered = false;
  const flushList = () => {
    if (listBuf.length === 0) return;
    const Tag = listOrdered ? "ol" : "ul";
    out.push(
      <Tag
        key={out.length}
        className={`${listOrdered ? "list-decimal" : "list-disc"} pl-5 space-y-1 my-2`}
      >
        {listBuf.map((item, idx) => (
          <li key={idx} className="text-sm text-txt2">
            {inline(item)}
          </li>
        ))}
      </Tag>,
    );
    listBuf = [];
  };

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();

    /* Fenced code block. Captures every line until the matching
     * closing ``` (or end of input). The body renders as a pre+code
     * with whitespace preserved. */
    if (/^```/.test(line)) {
      flushList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // skip closing fence
      out.push(
        <pre
          key={out.length}
          className="my-3 rounded-card bg-surface2 hairline px-3 py-2 overflow-x-auto"
        >
          <code className="text-[12px] font-mono text-txt2 whitespace-pre">
            {body.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }

    /* Pipe table. Header row + separator + body rows until a blank
     * line. The separator line (---|---|---) is required by the
     * markdown spec and is what we use to detect the table. */
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?\s*[-:|\s]+\|/.test(lines[i + 1] ?? "")
    ) {
      flushList();
      const headerCells = splitTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      out.push(
        <div
          key={out.length}
          className="my-3 rounded-card bg-surface2/40 hairline overflow-x-auto"
        >
          <table className="w-full text-sm">
            <thead>
              <tr>
                {headerCells.map((c, idx) => (
                  <th
                    key={idx}
                    className="text-left text-nano uppercase tracking-wider text-txt3 px-3 py-2 border-b border-border2"
                  >
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border2 last:border-b-0">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-3 py-2 text-txt2 align-top">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^# /.test(line)) {
      flushList();
      out.push(
        <h2
          key={out.length}
          className="font-display text-lg font-emphasized mt-5 mb-2 text-txt1"
        >
          {line.replace(/^# /, "")}
        </h2>,
      );
    } else if (/^## /.test(line)) {
      flushList();
      out.push(
        <h3
          key={out.length}
          className="font-display text-md font-emphasized mt-4 mb-2 text-txt1"
        >
          {line.replace(/^## /, "")}
        </h3>,
      );
    } else if (/^### /.test(line)) {
      flushList();
      out.push(
        <h4
          key={out.length}
          className="font-display text-sm font-emphasized mt-3 mb-1 text-txt1"
        >
          {line.replace(/^### /, "")}
        </h4>,
      );
    } else if (/^\s*[-*] /.test(line)) {
      if (listBuf.length > 0 && listOrdered) flushList();
      listOrdered = false;
      listBuf.push(line.replace(/^\s*[-*] /, ""));
    } else if (/^\s*\d+\. /.test(line)) {
      if (listBuf.length > 0 && !listOrdered) flushList();
      listOrdered = true;
      listBuf.push(line.replace(/^\s*\d+\. /, ""));
    } else if (/^>\s?/.test(line)) {
      flushList();
      out.push(
        <blockquote
          key={out.length}
          className="my-2 border-l-2 border-brand/40 pl-3 text-sm text-txt3 italic"
        >
          {inline(line.replace(/^>\s?/, ""))}
        </blockquote>,
      );
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      out.push(
        <p key={out.length} className="text-sm text-txt2 mb-2 leading-relaxed">
          {inline(line)}
        </p>,
      );
    }
    i += 1;
  }
  flushList();
  return out;
}

function splitTableRow(line: string): string[] {
  /* Strip leading + trailing pipes then split. Trim cells so the
   * markdown source can pad columns for readability without affecting
   * render. */
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/* Inline span renderer: bold, italic, inline code, links. Order
 * matters - code spans win over the rest so a backtick around
 * **bold** stays literal. */
function inline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      parts.push(
        <code
          key={key++}
          className="px-1 rounded bg-surface2 text-[12px] font-mono text-txt2"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      parts.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      parts.push(
        <a
          key={key++}
          href={lm[2]}
          className="text-brandSoft hover:underline"
        >
          {lm[1]}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

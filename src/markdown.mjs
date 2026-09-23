export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderMarkdown(md) {
  if (!md) return "";

  // 1. Normalize line endings to LF
  const text = String(md).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 2. Extract fenced code blocks line-by-line so comments (# ...) are never treated as headings
  const lines = text.split("\n");
  let inCodeBlock = false;
  let codeFence = "";
  let codeLang = "";
  let codeLines = [];
  const proseLines = [];
  const codeBlocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inCodeBlock) {
      const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})([a-zA-Z0-9_+#.-]*)[^\n]*$/);
      if (fenceMatch) {
        inCodeBlock = true;
        codeFence = fenceMatch[1];
        codeLang = (fenceMatch[2] || "code").trim();
        codeLines = [];
        continue;
      }
      proseLines.push(line);
    } else {
      const closeMatch = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
      if (closeMatch && closeMatch[1][0] === codeFence[0] && closeMatch[1].length >= codeFence.length) {
        inCodeBlock = false;
        const cleanCode = codeLines.join("\n");
        const escapedCode = escapeHtml(cleanCode);
        const blockHtml = `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang">${escapeHtml(codeLang || "code")}</span>
    <button class="copy-code-btn" onclick="copyCode(this)">Copy</button>
  </div>
  <pre><code>${escapedCode}</code></pre>
</div>`;
        const idx = codeBlocks.length;
        codeBlocks.push(blockHtml);
        proseLines.push(`\x00AMQ_BLOCK_${idx}_\x00`);
        continue;
      }
      codeLines.push(line);
    }
  }

  // Handle unclosed fenced code block at end of input
  if (inCodeBlock) {
    const cleanCode = codeLines.join("\n");
    const escapedCode = escapeHtml(cleanCode);
    const blockHtml = `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang">${escapeHtml(codeLang || "code")}</span>
    <button class="copy-code-btn" onclick="copyCode(this)">Copy</button>
  </div>
  <pre><code>${escapedCode}</code></pre>
</div>`;
    const idx = codeBlocks.length;
    codeBlocks.push(blockHtml);
    proseLines.push(`\x00AMQ_BLOCK_${idx}_\x00`);
  }

  let prose = proseLines.join("\n");

  // 3. Extract inline code so inline snippets are not affected by prose formatting
  const inlineCodes = [];
  prose = prose.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (match, fence, code) => {
    const escaped = escapeHtml(code);
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="inline-code">${escaped}</code>`);
    return `\x00AMQ_INLINE_${idx}_\x00`;
  });

  // 4. Escape remaining HTML in prose for injection protection
  let html = escapeHtml(prose);

  // 5. Blockquotes (handling both escaped &gt; and unescaped >)
  html = html.replace(/^(?:&gt;|>)[ \t]?(.*$)/gm, '<blockquote class="md-quote">$1</blockquote>');
  html = html.replace(/<\/blockquote>\n<blockquote class="md-quote">/g, "<br>");

  // 6. Headings in prose (requiring whitespace after # to avoid false matches on tags or includes)
  html = html.replace(/^######[ \t]+(.*$)/gm, '<h6 class="md-h6">$1</h6>');
  html = html.replace(/^#####[ \t]+(.*$)/gm, '<h5 class="md-h5">$1</h5>');
  html = html.replace(/^####[ \t]+(.*$)/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^###[ \t]+(.*$)/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^##[ \t]+(.*$)/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^#[ \t]+(.*$)/gm, '<h1 class="md-h1">$1</h1>');

  // 7. Markdown tables in prose
  const tableRegex = /((?:^[ \t]*\|?[^\n\r|]+(?:\|[^\n\r|]+)+\|?[ \t]*\n)(?:^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)\|?[ \t]*\n)(?:^[ \t]*\|?[^\n\r|]+(?:\|[^\n\r|]+)+\|?[ \t]*(?:\n|$))+)/gm;
  html = html.replace(tableRegex, (match) => {
    const tableLines = match.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (tableLines.length < 2) return match;
    const parseRow = (line) => {
      let clean = line;
      if (clean.startsWith("|")) clean = clean.slice(1);
      if (clean.endsWith("|")) clean = clean.slice(0, -1);
      return clean.split("|").map((c) => c.trim());
    };
    const headerCols = parseRow(tableLines[0]);
    const alignLine = parseRow(tableLines[1]);
    const aligns = alignLine.map((col) => {
      const left = col.startsWith(":");
      const right = col.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return "left";
    });
    let tableHtml = '<div class="table-container"><table class="md-table"><thead><tr>';
    headerCols.forEach((col, idx) => {
      const align = aligns[idx] || "left";
      tableHtml += `<th style="text-align: ${align}">${col}</th>`;
    });
    tableHtml += "</tr></thead><tbody>";
    for (let j = 2; j < tableLines.length; j++) {
      const rowCols = parseRow(tableLines[j]);
      tableHtml += "<tr>";
      headerCols.forEach((_, idx) => {
        const cell = rowCols[idx] !== undefined ? rowCols[idx] : "";
        const align = aligns[idx] || "left";
        tableHtml += `<td style="text-align: ${align}">${cell}</td>`;
      });
      tableHtml += "</tr>";
    }
    tableHtml += "</tbody></table></div>\n";
    return tableHtml;
  });

  // 8. Bold, Italic, Strikethrough in prose
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 9. Lists in prose
  html = html.replace(/^([0-9]+\.|\([0-9]+\))[ \t]+(.*$)/gm, '<div class="md-list-item"><span class="md-list-num">$1</span> <span>$2</span></div>');
  html = html.replace(/^[-*+][ \t]+(.*$)/gm, '<div class="md-bullet-item">• $1</div>');

  // 10. Links in prose: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');

  // 11. Paragraph breaks in prose
  html = html.replace(/\n{2,}/g, '<div class="md-para-break"></div>');

  // 12. Restore inline code
  for (let k = 0; k < inlineCodes.length; k++) {
    html = html.replace(`\x00AMQ_INLINE_${k}_\x00`, () => inlineCodes[k]);
  }

  // 13. Restore code blocks
  for (let b = 0; b < codeBlocks.length; b++) {
    html = html.replace(`\x00AMQ_BLOCK_${b}_\x00`, () => codeBlocks[b]);
  }

  return html;
}

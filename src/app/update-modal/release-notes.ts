/**
 * Renders the Markdown subset GitHub release notes use (# headings, "- "/"* "
 * bullets, **bold**, `code`) as HTML. Everything is HTML-escaped first, so
 * the notes can never inject markup; Angular's [innerHTML] sanitizer then
 * checks the result once more.
 */
export function renderReleaseNotes(markdown: string): string {
  const html: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };

  for (const raw of (markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flushList();
      flushParagraph();
    } else if (heading) {
      flushList();
      flushParagraph();
      const tag = heading[1].length <= 2 ? "h5" : "h6";
      html.push(`<${tag}>${inline(heading[2])}</${tag}>`);
    } else if (bullet) {
      flushParagraph();
      list.push(inline(bullet[1]));
    } else {
      flushList();
      paragraph.push(inline(line));
    }
  }
  flushList();
  flushParagraph();
  return html.join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/// `code` spans stay literal; **bold** applies outside of them.
function inline(text: string): string {
  return text
    .split("`")
    .map((part, i, parts) => {
      const escaped = escapeHtml(part);
      // An unpaired last backtick is kept as text.
      if (i % 2 === 1 && i < parts.length - 1) return `<code>${escaped}</code>`;
      const prefix = i % 2 === 1 ? "`" : "";
      return prefix + escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    })
    .join("");
}

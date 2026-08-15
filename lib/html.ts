/**
 * Small, deliberately non-validating HTML scanner.
 *
 * Retailer markup is untrusted. Regexes such as `<[^>]*>` become quadratic on
 * a long string of unterminated `<` characters, which can block the Node event
 * loop for seconds. These helpers advance monotonically and therefore stay
 * linear even when the document is malformed.
 */

export interface HtmlElementBlock {
  start: number;
  end: number;
  attributes: string;
  content: string;
}

function isTagDelimiter(char: string | undefined): boolean {
  return char === undefined || /[\s/>]/.test(char);
}

function findTagEnd(html: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

/** Yield complete, non-nested blocks for a specific tag name. */
export function* elementBlocks(
  html: string,
  tagName: string
): Generator<HtmlElementBlock> {
  const lower = html.toLowerCase();
  const openNeedle = `<${tagName.toLowerCase()}`;
  const closeNeedle = `</${tagName.toLowerCase()}`;
  let cursor = 0;

  while (cursor < html.length) {
    const start = lower.indexOf(openNeedle, cursor);
    if (start === -1) return;
    const nameEnd = start + openNeedle.length;
    if (!isTagDelimiter(lower[nameEnd])) {
      cursor = nameEnd;
      continue;
    }

    const openEnd = findTagEnd(html, nameEnd);
    if (openEnd === -1) return;
    const closeStart = lower.indexOf(closeNeedle, openEnd + 1);
    if (closeStart === -1) return;
    const closeNameEnd = closeStart + closeNeedle.length;
    if (!isTagDelimiter(lower[closeNameEnd])) {
      cursor = closeNameEnd;
      continue;
    }
    const closeEnd = findTagEnd(html, closeNameEnd);
    if (closeEnd === -1) return;

    yield {
      start,
      end: closeEnd + 1,
      attributes: html.slice(nameEnd, openEnd),
      content: html.slice(openEnd + 1, closeStart),
    };
    cursor = closeEnd + 1;
  }
}

/** Strip tags in one forward pass. An unterminated tag safely consumes the EOF. */
export function stripHtmlTags(html: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) {
      chunks.push(html.slice(cursor));
      break;
    }
    chunks.push(html.slice(cursor, start), ' ');
    const end = findTagEnd(html, start + 1);
    if (end === -1) break;
    cursor = end + 1;
  }

  return chunks.join('');
}

/** Replace complete tags with spaces while preserving every source offset. */
export function maskHtmlTags(html: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) {
      chunks.push(html.slice(cursor));
      break;
    }
    chunks.push(html.slice(cursor, start));
    const end = findTagEnd(html, start + 1);
    if (end === -1) {
      chunks.push(' '.repeat(html.length - start));
      break;
    }
    chunks.push(' '.repeat(end - start + 1));
    cursor = end + 1;
  }

  return chunks.join('');
}

/** Remove whole script/style/chrome blocks without backtracking regexes. */
export function removeHtmlElementBlocks(html: string, tagName: string): string {
  const blocks = [...elementBlocks(html, tagName)];
  if (blocks.length === 0) return html;

  const chunks: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    chunks.push(html.slice(cursor, block.start), ' ');
    cursor = block.end;
  }
  chunks.push(html.slice(cursor));
  return chunks.join('');
}

export const __testing = { findTagEnd };

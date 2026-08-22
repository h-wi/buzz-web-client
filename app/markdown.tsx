import type { ReactNode } from "react";
import type { Profile } from "./profiles";
import { segmentMentions } from "./mentions";

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(https?:\/\/[^\s<>()[\]]+)/;

function renderInline(text: string, profiles: Record<string, Profile>, keyPrefix: string): ReactNode[] {
  const segments = segmentMentions(text, profiles);
  const nodes: ReactNode[] = [];
  let key = 0;
  for (const segment of segments) {
    if (segment.mention) {
      nodes.push(<span key={`${keyPrefix}-m${key++}`} className="mention-token">{segment.text}</span>);
      continue;
    }
    let rest = segment.text;
    while (rest) {
      const match = INLINE_PATTERN.exec(rest);
      if (!match || match.index === undefined) {
        nodes.push(<span key={`${keyPrefix}-t${key++}`}>{rest}</span>);
        break;
      }
      if (match.index > 0) {
        nodes.push(<span key={`${keyPrefix}-t${key++}`}>{rest.slice(0, match.index)}</span>);
      }
      const token = match[0];
      const tokenKey = `${keyPrefix}-f${key++}`;
      if (token.startsWith("`")) {
        nodes.push(<code key={tokenKey}>{token.slice(1, -1)}</code>);
      } else if (token.startsWith("**")) {
        nodes.push(<strong key={tokenKey}>{renderInline(token.slice(2, -2), profiles, tokenKey)}</strong>);
      } else if (token.startsWith("~~")) {
        nodes.push(<del key={tokenKey}>{renderInline(token.slice(2, -2), profiles, tokenKey)}</del>);
      } else if (token.startsWith("*")) {
        nodes.push(<em key={tokenKey}>{renderInline(token.slice(1, -1), profiles, tokenKey)}</em>);
      } else {
        nodes.push(<a key={tokenKey} href={token} target="_blank" rel="noopener noreferrer">{token}</a>);
      }
      rest = rest.slice(match.index + token.length);
    }
  }
  return nodes;
}

/// Minimal safe markdown renderer: fenced code blocks, headings, lists,
/// blockquotes, inline code, bold, italic, strikethrough, links. Renders to
/// React elements only — no dangerouslySetInnerHTML.
export function renderMarkdown(content: string, profiles: Record<string, Profile>): ReactNode[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: { ordered: boolean; text: string }[] | null = null;
  let quote: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={`p${key++}`} className="msg-md-p">
        {paragraph.map((line, index) => (
          <span key={index}>{index > 0 && <br />}{renderInline(line, profiles, `p${key}-${index}`)}</span>
        ))}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems) return;
    const items = listItems.map((item, index) => <li key={index}>{renderInline(item.text, profiles, `li${key}-${index}`)}</li>);
    blocks.push(listItems[0].ordered ? <ol key={`l${key++}`}>{items}</ol> : <ul key={`l${key++}`}>{items}</ul>);
    listItems = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(
      <blockquote key={`q${key++}`}>
        {quote.map((line, index) => (
          <span key={index}>{index > 0 && <br />}{renderInline(line, profiles, `q${key}-${index}`)}</span>
        ))}
      </blockquote>,
    );
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  for (const line of lines) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (code) {
      if (fence) {
        blocks.push(
          <pre key={`c${key++}`} data-lang={code.lang || undefined}><code>{code.lines.join("\n")}</code></pre>,
        );
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (fence) {
      flushAll();
      code = { lang: fence[1], lines: [] };
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const text = renderInline(heading[2], profiles, `h${key}`);
      const Heading = (`h${Math.min(level + 2, 6)}` as "h3" | "h4" | "h5" | "h6");
      blocks.push(<Heading key={`h${key++}`} className="msg-md-h">{text}</Heading>);
      continue;
    }
    const bullet = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const itemText = (bullet ?? ordered)![1];
      const isOrdered = Boolean(ordered);
      if (!listItems || listItems[0].ordered !== isOrdered) {
        flushList();
        listItems = [];
      }
      listItems.push({ ordered: isOrdered, text: itemText });
      continue;
    }
    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }
  if (code) {
    blocks.push(
      <pre key={`c${key++}`} data-lang={code.lang || undefined}><code>{code.lines.join("\n")}</code></pre>,
    );
  }
  flushAll();
  return blocks.length ? blocks : [<p key="empty" className="msg-md-p" />];
}

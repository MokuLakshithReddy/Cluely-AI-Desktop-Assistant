import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  const [copiedCodeIdx, setCopiedCodeIdx] = useState<number | null>(null);

  const copyCode = (codeText: string, idx: number) => {
    navigator.clipboard.writeText(codeText);
    setCopiedCodeIdx(idx);
    setTimeout(() => {
      setCopiedCodeIdx(null);
    }, 2000);
  };

  // Helper to render inline elements (bold, italic, inline code)
  const renderInline = (text: string): React.ReactNode => {
    // Split by inline code `...`
    const parts = text.split(/(`[^`]+`)/g);
    return parts.map((part, i) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code
            key={i}
            className="px-1.5 py-0.5 rounded bg-slate-950/70 border border-slate-700/60 font-mono text-[11px] text-cyan-300"
          >
            {part.slice(1, -1)}
          </code>
        );
      }

      // Format bold and italic inside non-code fragments
      const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
      return boldParts.map((bPart, j) => {
        if (bPart.startsWith('**') && bPart.endsWith('**') && bPart.length > 4) {
          return (
            <strong key={`${i}-${j}`} className="font-semibold text-slate-100">
              {bPart.slice(2, -2)}
            </strong>
          );
        }
        return bPart;
      });
    });
  };

  // Split into code and non-code blocks
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  const blocks: Array<{ type: 'code' | 'text'; lang?: string; content: string }> = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      });
    }
    blocks.push({
      type: 'code',
      lang: match[1]?.trim() || 'code',
      content: match[2]?.trimEnd() || '',
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    blocks.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }

  return (
    <div className="space-y-2 font-sans text-slate-200 text-xs leading-relaxed">
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          const isCopied = copiedCodeIdx === idx;
          return (
            <div
              key={idx}
              className="my-2 rounded-lg border border-slate-700/70 bg-slate-950/90 overflow-hidden shadow-sm"
            >
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[10px] text-slate-400 font-mono">
                <span className="uppercase tracking-wider text-cyan-400 font-semibold">
                  {block.lang}
                </span>
                <button
                  type="button"
                  onClick={() => copyCode(block.content, idx)}
                  className="flex items-center gap-1 hover:text-slate-200 transition-colors"
                  title="Copy code snippet"
                >
                  {isCopied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400 font-sans">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span className="font-sans">Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3 overflow-x-auto font-mono text-[11px] text-slate-300 leading-normal select-text">
                <code>{block.content}</code>
              </pre>
            </div>
          );
        }

        // Render text lines/paragraphs
        const lines = block.content.split('\n');
        return (
          <div key={idx} className="space-y-1.5">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim();

              if (!trimmed) {
                return <div key={lineIdx} className="h-1" />;
              }

              // Headers
              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={lineIdx} className="font-bold text-slate-100 text-xs mt-2 pt-1">
                    {renderInline(trimmed.slice(4))}
                  </h4>
                );
              }
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lineIdx} className="font-bold text-cyan-300 text-xs mt-2.5 pt-1">
                    {renderInline(trimmed.slice(3))}
                  </h3>
                );
              }
              if (trimmed.startsWith('# ')) {
                return (
                  <h2 key={lineIdx} className="font-bold text-cyan-400 text-sm mt-3 pt-1">
                    {renderInline(trimmed.slice(2))}
                  </h2>
                );
              }

              // Blockquotes
              if (trimmed.startsWith('> ')) {
                return (
                  <blockquote
                    key={lineIdx}
                    className="border-l-2 border-cyan-500/70 pl-2.5 my-1 text-slate-300 italic text-[11px]"
                  >
                    {renderInline(trimmed.slice(2))}
                  </blockquote>
                );
              }

              // Bullet lists
              if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
                return (
                  <div key={lineIdx} className="flex items-start gap-1.5 pl-1.5">
                    <span className="text-cyan-400 font-bold leading-none select-none mt-1">•</span>
                    <span className="flex-1">{renderInline(trimmed.slice(2))}</span>
                  </div>
                );
              }

              // Standard text paragraph line
              return (
                <p key={lineIdx} className="leading-relaxed">
                  {renderInline(line)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

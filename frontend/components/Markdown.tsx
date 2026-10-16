"use client";
import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";

/* Model output and RAG snippets are untrusted: raw HTML stays disabled (never add rehype-raw),
   react-markdown drops javascript: URLs, and images from model output are not loaded. */

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(code).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); });
  return (
    <div className="code-block">
      <div className="cb-head">
        <span>{lang || "code"}</span>
        <button type="button" className="cb-copy" onClick={copy}><Icon name={done ? "check" : "copy"} />{done ? "Đã chép" : "Sao chép"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

const plain = (n: ReactNode): string => {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(plain).join("");
  if (isValidElement(n)) return plain((n.props as { children?: ReactNode }).children);
  return "";
};

const components: Components = {
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const cls = isValidElement(child) ? (child.props as { className?: string }).className || "" : "";
    return <CodeBlock lang={cls.replace(/^language-/, "")} code={plain(child).replace(/\n$/, "")} />;
  },
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ alt }) => <span className="muted">[{alt || "hình"}]</span>,
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
};

/** Closes a code fence that is still streaming so half-written code already renders as code. */
const closeFence = (s: string) => ((s.match(/```/g) || []).length % 2 ? s + "\n```" : s);

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{closeFence(source)}</ReactMarkdown>;
});

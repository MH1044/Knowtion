import { useState } from 'react';

import type { PageNode } from './api.js';

interface PageTreeProps {
  nodes: PageNode[];
  selectedId: string | undefined;
  depth?: number;
  onSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
}

export function PageTree({
  nodes,
  selectedId,
  depth = 0,
  onSelect,
  onCreateChild,
}: PageTreeProps): React.JSX.Element {
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => (
        <PageTreeItem
          key={node.id}
          node={node}
          selectedId={selectedId}
          depth={depth}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
        />
      ))}
    </ul>
  );
}

function PageTreeItem({
  node,
  selectedId,
  depth,
  onSelect,
  onCreateChild,
}: { node: PageNode; depth: number } & Omit<PageTreeProps, 'nodes' | 'depth'>): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={`row${node.id === selectedId ? ' selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <button
          type="button"
          className="twisty"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => setExpanded((v) => !v)}
          // Kept in the layout even with no children so titles do not shift
          // horizontally as a page gains its first child.
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button type="button" className="title" onClick={() => onSelect(node.id)}>
          {node.title || 'Untitled'}
        </button>
        <button
          type="button"
          className="add"
          title="Add a page inside"
          aria-label={`Add a page inside ${node.title}`}
          onClick={() => onCreateChild(node.id)}
        >
          +
        </button>
      </div>
      {hasChildren && expanded && (
        <PageTree
          nodes={node.children}
          selectedId={selectedId}
          depth={depth + 1}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
        />
      )}
    </li>
  );
}

import { useState } from 'react';

import type { PageNode } from './api.js';
import { canDrop, moveForDrop, zoneAt, type DropTargetPage, type PageMove } from './tree-dnd.js';

/**
 * The tree leaves a database's rows out on purpose — ten thousand rows would be ten
 * thousand sidebar nodes — so it says how many there are instead. Without this the page
 * looks empty and the rows look lost.
 */
function RowCount({ node }: { node: PageNode }): React.JSX.Element | null {
  if (node.rowCount === undefined) return null;
  return (
    <span className="row-count" title={`${String(node.rowCount)} rows in this database`}>
      {node.rowCount}
    </span>
  );
}

/** Shared drag state, owned above the tree so every row sees the same one. */
export interface TreeDrag {
  draggingId: string | undefined;
  target: { id: string; zone: 'before' | 'inside' | 'after' } | undefined;
  start: (page: DropTargetPage) => void;
  over: (target: DropTargetPage, ancestry: string[], box: DOMRect, y: number) => void;
  leave: (id: string) => void;
  drop: () => void;
  end: () => void;
}

/**
 * Dragging a page onto another page.
 *
 * A page could be created anywhere and then never moved: the engine has always had
 * `movePage`, and nothing ever called it, so the shape of a workspace was fixed at the
 * moment each page was made.
 *
 * The middle half of a row nests, the edges reorder. The arithmetic lives in tree-dnd.ts
 * so the awkward part — what a position means once the dragged page is lifted out of its
 * own list — is tested without a DOM.
 */
export function useTreeDrag(onMove: (id: string, move: PageMove) => void): TreeDrag {
  const [dragging, setDragging] = useState<DropTargetPage>();
  const [target, setTarget] = useState<{ id: string; zone: 'before' | 'inside' | 'after' }>();
  const [pending, setPending] = useState<{ id: string; move: PageMove }>();

  const clear = (): void => {
    setDragging(undefined);
    setTarget(undefined);
    setPending(undefined);
  };

  return {
    draggingId: dragging?.id,
    target,
    start: (page) => {
      setDragging(page);
    },
    over: (over, ancestry, box, y) => {
      if (dragging === undefined || !canDrop(dragging.id, over, ancestry)) return;
      const zone = zoneAt(box.top, box.bottom, y);
      if (target?.id !== over.id || target.zone !== zone) setTarget({ id: over.id, zone });
      setPending({ id: dragging.id, move: moveForDrop(dragging, over, zone) });
    },
    leave: (id) => {
      setTarget((current) => (current?.id === id ? undefined : current));
    },
    drop: () => {
      if (pending !== undefined) onMove(pending.id, pending.move);
      clear();
    },
    end: clear,
  };
}

interface PageTreeProps {
  nodes: PageNode[];
  selectedId: string | undefined;
  depth?: number;
  /** The ids from the root down to this level, so a page is never dropped inside itself. */
  ancestry?: string[];
  onSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  drag: TreeDrag;
}

export function PageTree({
  nodes,
  selectedId,
  depth = 0,
  ancestry = [],
  onSelect,
  onCreateChild,
  drag,
}: PageTreeProps): React.JSX.Element {
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node, index) => (
        <PageTreeItem
          key={node.id}
          node={node}
          index={index}
          selectedId={selectedId}
          depth={depth}
          ancestry={ancestry}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
          drag={drag}
        />
      ))}
    </ul>
  );
}

function PageTreeItem({
  node,
  index,
  selectedId,
  depth,
  ancestry,
  onSelect,
  onCreateChild,
  drag,
}: { node: PageNode; index: number; depth: number; ancestry: string[] } & Omit<
  PageTreeProps,
  'nodes' | 'depth' | 'ancestry'
>): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const here: DropTargetPage = { id: node.id, parentId: node.parentId, index };
  const dropping = drag.target?.id === node.id ? drag.target.zone : undefined;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={[
          'row',
          node.id === selectedId ? 'selected' : '',
          drag.draggingId === node.id ? 'dragging' : '',
          dropping === undefined ? '' : `drop-${dropping}`,
        ]
          .filter((c) => c !== '')
          .join(' ')}
        style={{ paddingLeft: `${String(depth * 14 + 8)}px` }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          // Something must be set for a drag to start at all; the id is read from state.
          e.dataTransfer.setData('text/plain', node.id);
          drag.start(here);
        }}
        onDragOver={(e) => {
          if (drag.draggingId === undefined) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          drag.over(here, ancestry, e.currentTarget.getBoundingClientRect(), e.clientY);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drag.leave(node.id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          drag.drop();
        }}
        onDragEnd={drag.end}
      >
        <button
          type="button"
          className="twisty"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => {
            setExpanded((v) => !v);
          }}
          // Kept in the layout even with no children so titles do not shift
          // horizontally as a page gains its first child.
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="title"
          onClick={() => {
            onSelect(node.id);
          }}
        >
          {node.icon !== undefined && (
            <span className="row-icon" aria-hidden="true">
              {node.icon}
            </span>
          )}
          {node.title || 'Untitled'}
        </button>
        <RowCount node={node} />
        <button
          type="button"
          className="add"
          title="Add a page inside"
          aria-label={`Add a page inside ${node.title}`}
          onClick={() => {
            onCreateChild(node.id);
          }}
        >
          +
        </button>
      </div>
      {hasChildren && expanded && (
        <PageTree
          nodes={node.children}
          selectedId={selectedId}
          depth={depth + 1}
          ancestry={[...ancestry, node.id]}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
          drag={drag}
        />
      )}
    </li>
  );
}

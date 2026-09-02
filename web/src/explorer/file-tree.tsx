import { ChevronRight, File, FilePlus, Folder, FolderPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ArchiveNoteRequest, DeleteFolderRequest, FolderDeleteConfirmationSchema } from "@nxt/contracts";
import type { CompleteVault } from "../api/vault";
import { FolderActions } from "./folder-actions";
import { NoteActions } from "./note-actions";

export interface NoteExplorerNode {
  readonly kind: "note";
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly version: string;
  readonly attachmentCount: number;
}

export interface FolderExplorerNode {
  readonly kind: "folder";
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly version: string;
  readonly protected: boolean;
  readonly deleteConfirmation: ReturnType<typeof FolderDeleteConfirmationSchema.parse> | null;
  readonly children: readonly ExplorerNode[];
}

export type ExplorerNode = NoteExplorerNode | FolderExplorerNode;

export const buildExplorerTree = (vault: CompleteVault): readonly ExplorerNode[] => {
  const folders = new Map<string, FolderExplorerNode>();
  for (const folder of vault.folders) {
    if (folders.has(folder.id)) throw new Error("Duplicate folder projection.");
    folders.set(folder.id, {
      kind: "folder",
      id: folder.id,
      name: folder.name,
      path: folder.path,
      version: folder.version,
      protected: folder.protected,
      deleteConfirmation: folder.deleteConfirmation ?? null,
      children: []
    });
  }
  const mutableChildren = new Map<string, ExplorerNode[]>();
  for (const folder of folders.values()) mutableChildren.set(folder.id, []);
  const roots: ExplorerNode[] = [];
  const folderByPath = new Map([...folders.values()].map((folder) => [folder.path, folder]));
  if (folderByPath.size !== folders.size) throw new Error("Ambiguous folder path projection.");

  for (const folder of folders.values()) {
    const separator = folder.path.lastIndexOf("/");
    const parent = separator < 0 ? undefined : folderByPath.get(folder.path.slice(0, separator));
    if (parent === undefined) roots.push(folder);
    else mutableChildren.get(parent.id)?.push(folder);
  }
  for (const note of vault.entries) {
    const separator = note.path.lastIndexOf("/");
    const parent = separator < 0 ? undefined : folderByPath.get(note.path.slice(0, separator));
    if (parent === undefined) throw new Error("A note has no exact projected folder.");
    mutableChildren.get(parent.id)?.push({
      kind: "note",
      id: note.id,
      name: note.title,
      path: note.path,
      version: note.driveVersion,
      attachmentCount: note.attachments.length
    });
  }
  const populate = (node: ExplorerNode, ancestors: ReadonlySet<string>): ExplorerNode => {
    if (node.kind === "note") return node;
    if (ancestors.has(node.id)) throw new Error("Folder projection contains a cycle.");
    const nextAncestors = new Set(ancestors).add(node.id);
    const children = [...(mutableChildren.get(node.id) ?? [])]
      .sort((first, second) => first.name.localeCompare(second.name, "tr-TR") || first.id.localeCompare(second.id))
      .map((child) => populate(child, nextAncestors));
    return { ...node, children };
  };
  return roots.sort((first, second) => first.name.localeCompare(second.name, "tr-TR") || first.id.localeCompare(second.id)).map((root) => populate(root, new Set()));
};

interface FlatNode {
  readonly node: ExplorerNode;
  readonly level: number;
  readonly parentId: string | null;
}

export interface FileTreeProps {
  readonly tree: readonly ExplorerNode[];
  readonly selectedId?: string | undefined;
  readonly onSelect?: ((node: ExplorerNode) => void) | undefined;
  readonly onRenameFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMoveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchiveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrashFolder?: ((folder: FolderExplorerNode, input: DeleteFolderRequest) => Promise<void>) | undefined;
  readonly onRenameNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onMoveNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onArchiveNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onTrashNote?: ((note: NoteExplorerNode, input: ArchiveNoteRequest) => Promise<void>) | undefined;
  readonly onNewNote?: ((parentId: string | null) => void) | undefined;
  readonly onNewFolder?: ((parentId: string | null) => void) | undefined;
  readonly newActionsDisabledReason?: string | null | undefined;
  readonly now?: (() => Date) | undefined;
}

const flattenVisible = (
  nodes: readonly ExplorerNode[],
  expanded: ReadonlySet<string>,
  level = 1,
  parentId: string | null = null,
  output: FlatNode[] = []
): FlatNode[] => {
  for (const node of nodes) {
    output.push({ node, level, parentId });
    if (node.kind === "folder" && expanded.has(node.id)) {
      flattenVisible(node.children, expanded, level + 1, node.id, output);
    }
  }
  return output;
};

const allIds = (nodes: readonly ExplorerNode[], output = new Set<string>()): Set<string> => {
  for (const node of nodes) {
    output.add(node.id);
    if (node.kind === "folder") allIds(node.children, output);
  }
  return output;
};

const ancestorFolderIds = (
  nodes: readonly ExplorerNode[],
  targetId: string | undefined,
  ancestors: readonly string[] = []
): readonly string[] => {
  if (targetId === undefined) return [];
  for (const node of nodes) {
    if (node.id === targetId) return ancestors;
    if (node.kind !== "folder") continue;
    const result = ancestorFolderIds(node.children, targetId, [...ancestors, node.id]);
    if (result.length > 0) return result;
  }
  return [];
};

const findFirstFolderId = (nodes: readonly ExplorerNode[]): string | null => {
  for (const node of nodes) {
    if (node.kind === "folder") return node.id;
  }
  return null;
};

export const FileTree = ({
  tree,
  selectedId,
  onSelect,
  onRenameFolder,
  onMoveFolder,
  onArchiveFolder,
  onTrashFolder,
  onRenameNote,
  onMoveNote,
  onArchiveNote,
  onTrashNote,
  onNewNote,
  onNewFolder,
  newActionsDisabledReason,
  now
}: FileTreeProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(ancestorFolderIds(tree, selectedId))
  );
  const [focusedId, setFocusedId] = useState<string | null>(() => selectedId ?? tree[0]?.id ?? null);
  const [activeSelectedId, setActiveSelectedId] = useState<string | null>(() => selectedId ?? null);
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const treeOwnedFocus = useRef(false);
  const visible = useMemo(() => flattenVisible(tree, expanded), [expanded, tree]);
  const effectiveFocusedId = visible.some(({ node }) => node.id === focusedId)
    ? focusedId
    : visible.find(({ node }) => node.id === selectedId)?.node.id ?? visible[0]?.node.id ?? null;

  useLayoutEffect(() => {
    const visibleIds = new Set(visible.map(({ node }) => node.id));
    if (focusedId !== null && visibleIds.has(focusedId)) return;
    const next = selectedId !== undefined && visibleIds.has(selectedId) ? selectedId : visible[0]?.node.id ?? null;
    setFocusedId(next);
    if (treeOwnedFocus.current && next !== null) itemRefs.current.get(next)?.focus();
  }, [focusedId, selectedId, visible]);

  useEffect(() => {
    if (selectedId !== undefined) setActiveSelectedId(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const validIds = allIds(tree);
    setActiveSelectedId((current) => current !== null && validIds.has(current)
      ? current
      : selectedId !== undefined && validIds.has(selectedId) ? selectedId : null);
  }, [selectedId, tree]);

  useEffect(() => {
    const ancestors = ancestorFolderIds(tree, selectedId);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of ancestors) next.add(id);
      return next.size === current.size ? current : next;
    });
  }, [selectedId, tree]);

  const focusAt = (index: number): void => {
    const item = visible[index];
    if (item === undefined) return;
    setFocusedId(item.node.id);
    itemRefs.current.get(item.node.id)?.focus();
  };

  const toggle = (id: string, open?: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current);
      const shouldOpen = open ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const select = (node: ExplorerNode): void => {
    setActiveSelectedId(node.id);
    onSelect?.(node);
  };

  const rootFolderId = tree.length > 0 && tree[0]?.kind === "folder" ? tree[0].id : findFirstFolderId(tree);
  const newActionsDisabled = newActionsDisabledReason !== null && newActionsDisabledReason !== undefined;
  const newNoteTitle = newActionsDisabledReason ?? undefined;

  return (
    <div className="file-tree-layout">
      {(onNewNote !== undefined || onNewFolder !== undefined) ? (
        <div className="file-tree-toolbar" role="toolbar" aria-label="New file actions">
          {onNewNote !== undefined ? (
            <button
              type="button"
              className="file-tree-toolbar-action touch-target"
              disabled={newActionsDisabled}
              title={newNoteTitle}
              aria-label="New note"
              onClick={() => onNewNote(rootFolderId)}
            >
              <FilePlus size={16} strokeWidth={1.75} aria-hidden />
              <span>New note</span>
            </button>
          ) : null}
          {onNewFolder !== undefined ? (
            <button
              type="button"
              className="file-tree-toolbar-action touch-target"
              disabled={newActionsDisabled}
              title={newNoteTitle}
              aria-label="New folder"
              onClick={() => onNewFolder(rootFolderId)}
            >
              <FolderPlus size={16} strokeWidth={1.75} aria-hidden />
              <span>New folder</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={root}
        className="file-tree"
        role="tree"
        aria-label="Files"
        onFocusCapture={() => { treeOwnedFocus.current = true; }}
        onBlurCapture={() => {
          queueMicrotask(() => {
            if (root.current?.contains(document.activeElement) !== true) treeOwnedFocus.current = false;
          });
        }}
      >
        {visible.map(({ node, level, parentId }, index) => {
          const isFolder = node.kind === "folder";
          const isExpanded = isFolder && expanded.has(node.id);
          return (
            <button
              key={node.id}
              ref={(element) => {
                if (element === null) itemRefs.current.delete(node.id);
                else itemRefs.current.set(node.id, element);
              }}
              className={`tree-row touch-target${activeSelectedId === node.id ? " selected" : ""}`}
              style={{ "--tree-level": level } as React.CSSProperties}
              type="button"
              role="treeitem"
              aria-level={level}
              aria-selected={activeSelectedId === node.id}
              {...(isFolder ? { "aria-expanded": isExpanded } : {})}
              tabIndex={effectiveFocusedId === node.id ? 0 : -1}
              onFocus={() => setFocusedId(node.id)}
              onClick={() => select(node)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuNodeId(node.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  setMenuNodeId(node.id);
                } else if (event.key === "ArrowDown") focusAt(Math.min(index + 1, visible.length - 1));
                else if (event.key === "ArrowUp") focusAt(Math.max(index - 1, 0));
                else if (event.key === "Home") focusAt(0);
                else if (event.key === "End") focusAt(visible.length - 1);
                else if (event.key === "ArrowRight" && isFolder) {
                  if (!isExpanded) toggle(node.id, true);
                  else if (visible[index + 1]?.parentId === node.id) focusAt(index + 1);
                } else if (event.key === "ArrowLeft") {
                  if (isFolder && isExpanded) toggle(node.id, false);
                  else if (parentId !== null) {
                    const parentIndex = visible.findIndex(({ node: candidate }) => candidate.id === parentId);
                    focusAt(parentIndex);
                  }
                } else if (event.key === "Enter" || event.key === " ") {
                  select(node);
                } else return;
                event.preventDefault();
              }}
            >
              {isFolder ? <ChevronRight className={isExpanded ? "disclosure disclosure-open" : "disclosure"} size={16} aria-hidden /> : <span className="tree-disclosure-spacer" />}
              {isFolder ? <Folder size={18} strokeWidth={1.75} aria-hidden /> : <File size={18} strokeWidth={1.75} aria-hidden />}
              <span>{node.name}</span>
            </button>
          );
        })}
      </div>
      <div className="file-tree-actions">
        {visible.map(({ node }) => (
          <div className="tree-action-row" key={node.id}>
            {node.kind === "folder" ? (
              <FolderActions
                folder={node}
                onRename={onRenameFolder}
                onMove={onMoveFolder}
                onArchive={onArchiveFolder}
                onTrash={onTrashFolder}
                now={now}
                menuOpen={menuNodeId === node.id}
                onMenuOpenChange={(open) => {
                  setMenuNodeId(open ? node.id : null);
                  if (!open) queueMicrotask(() => itemRefs.current.get(node.id)?.focus());
                }}
              />
            ) : (
              <NoteActions
                note={node}
                onRename={onRenameNote}
                onMove={onMoveNote}
                onArchive={onArchiveNote}
                onTrash={onTrashNote}
                menuOpen={menuNodeId === node.id}
                onMenuOpenChange={(open) => {
                  setMenuNodeId(open ? node.id : null);
                  if (!open) queueMicrotask(() => itemRefs.current.get(node.id)?.focus());
                }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

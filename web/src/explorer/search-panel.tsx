import { Search } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createSearchClient, StaleSearchResponseError, type SearchClient } from "./search-client";
import type { SearchRecord, SearchResultItem } from "./search-worker";

export interface SearchPanelProps {
  readonly records: readonly SearchRecord[];
  readonly onOpenNote: (noteId: string) => void;
  readonly query?: string | undefined;
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly requestedQuery?: string | undefined;
  readonly createClient?: ((records: readonly SearchRecord[]) => Promise<SearchClient>) | undefined;
}

export const SearchPanel = ({
  records,
  onOpenNote,
  query: controlledQuery,
  onQueryChange,
  requestedQuery,
  createClient = createSearchClient
}: SearchPanelProps): React.JSX.Element => {
  const [internalQuery, setInternalQuery] = useState("");
  const appliedRequestedQuery = useRef<string | undefined>(undefined);
  const isQueryControlled = controlledQuery !== undefined;
  const query = controlledQuery ?? internalQuery;
  const setQuery = useCallback((next: string): void => {
    if (!isQueryControlled) setInternalQuery(next);
    onQueryChange?.(next);
  }, [isQueryControlled, onQueryChange]);
  const deferredQuery = useDeferredValue(query);
  const [client, setClient] = useState<SearchClient | null>(null);
  const [results, setResults] = useState<readonly SearchResultItem[]>([]);
  const [answeredQuery, setAnsweredQuery] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();
  const recordKey = useMemo(() => records.map((record) => `${record.id}:${record.favorite ? 1 : 0}:${record.title}:${record.path}`).join("\u0000"), [records]);

  useEffect(() => {
    if (requestedQuery === undefined) {
      appliedRequestedQuery.current = undefined;
      return;
    }
    if (appliedRequestedQuery.current === requestedQuery) return;
    appliedRequestedQuery.current = requestedQuery;
    setQuery(requestedQuery);
  }, [requestedQuery, setQuery]);

  useEffect(() => {
    let active = true;
    let created: SearchClient | null = null;
    setClient(null);
    setError(false);
    setAnsweredQuery(null);
    void createClient(records).then((value) => {
      created = value;
      if (active) setClient(value);
      else value.terminate();
    }).catch(() => active && setError(true));
    return () => {
      active = false;
      created?.terminate();
    };
  }, [createClient, recordKey, records]);

  useEffect(() => {
    if (client === null || deferredQuery.trim().length === 0) {
      setResults([]);
      setAnsweredQuery(deferredQuery.trim().length === 0 ? deferredQuery : null);
      return;
    }
    let active = true;
    setAnsweredQuery(null);
    void client.query(deferredQuery).then((next) => {
      if (active) startTransition(() => {
        setResults(next);
        setAnsweredQuery(deferredQuery);
      });
    }).catch((reason: unknown) => {
      if (active && !(reason instanceof StaleSearchResponseError)) setError(true);
    });
    return () => {
      active = false;
    };
  }, [client, deferredQuery]);

  const hasCurrentAnswer = answeredQuery === deferredQuery && query === deferredQuery;

  return (
    <div className="vault-search">
      <div className="search-row">
        <Search size={18} strokeWidth={1.75} aria-hidden />
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files…"
          value={query}
          maxLength={512}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      {error ? <p className="explorer-error" role="alert">Search is unavailable.</p> : null}
      {query.trim().length > 0 ? (
        <div className="search-results" aria-label="Search results" aria-busy={client === null || isPending || !hasCurrentAnswer}>
          {hasCurrentAnswer ? results.map((result) => (
            <button className="tree-row touch-target" type="button" key={result.id} onClick={() => onOpenNote(result.id)}>
              <span>{result.title}</span>
              <small>{result.folder}</small>
            </button>
          )) : null}
          {client !== null && !isPending && hasCurrentAnswer && results.length === 0 ? (
            <div className="search-empty">
              <p>No matching notes</p>
              <button type="button" className="secondary-action touch-target" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

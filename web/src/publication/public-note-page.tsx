import { PublicIdSchema, type PublicNoteResponse } from "@nxt/contracts";
import { useEffect, useRef, useState } from "react";
import { publicClient, type PublicClient } from "../api/public";
import { useNoIndex } from "./noindex";
import { PublicAttachment } from "./public-attachment";

export interface PublicNotePageProps {
  readonly publicId: string;
  readonly client?: PublicClient;
}

export const PublicNotePage = ({ publicId, client = publicClient }: PublicNotePageProps): React.JSX.Element => {
  useNoIndex();
  const requestRef = useRef(0);
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "not-found" }
    | { readonly kind: "ready"; readonly note: PublicNoteResponse }
  >({ kind: "loading" });

  useEffect(() => {
    const request = ++requestRef.current;
    const parsed = PublicIdSchema.safeParse(publicId);
    if (!parsed.success) {
      setState({ kind: "not-found" });
      return;
    }
    setState({ kind: "loading" });
    void client.getNote(parsed.data).then((note) => {
      if (requestRef.current !== request) return;
      setState(note === null ? { kind: "not-found" } : { kind: "ready", note });
    }).catch(() => {
      if (requestRef.current === request) setState({ kind: "not-found" });
    });
    return () => { requestRef.current += 1; };
  }, [client, publicId]);

  if (state.kind === "loading") {
    return (
      <main className="public-note-page">
        <div className="public-note-brand">NXT</div>
        <div role="status" aria-label="Loading published note" aria-busy="true" />
      </main>
    );
  }
  if (state.kind === "not-found") {
    return (
      <main className="public-note-page public-note-not-found">
        <div className="public-note-brand">NXT</div>
        <h1>Not found</h1>
      </main>
    );
  }

  return (
    <main className="public-note-page">
      <header className="public-note-header">
        <span className="public-note-brand">NXT</span>
        <time dateTime={state.note.publishedAt}>Published {new Date(state.note.publishedAt).toLocaleDateString()}</time>
      </header>
      <article className="public-note-document">
        <h1>{state.note.title}</h1>
        <div className="rendered-markdown" dangerouslySetInnerHTML={{ __html: state.note.html }} />
        {state.note.assets.length === 0 ? null : (
          <section className="public-assets" aria-label="Attachments">
            {state.note.assets.map((asset) => (
              <PublicAttachment publicId={publicId} asset={asset} key={asset.assetId} />
            ))}
          </section>
        )}
      </article>
    </main>
  );
};

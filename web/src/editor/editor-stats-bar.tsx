import { formatStatNumber, formatReadingTime, type NoteStats } from "./note-stats";

export interface EditorStatsBarProps {
  readonly stats: NoteStats;
}

/**
 * Slim footer rendered directly under the editor canvas. Mirrors the
 * conventional Obsidian word/char/reading-time strip without competing for
 * toolbar real estate.
 */
export const EditorStatsBar = ({ stats }: EditorStatsBarProps): React.JSX.Element => (
  <div
    className="editor-stats-bar"
    role="group"
    aria-label="Editor statistics"
    data-testid="editor-stats-bar"
  >
    <span className="editor-stats-cell" title="Words in the note body">
      <span className="editor-stats-value">{formatStatNumber(stats.words)}</span>
      <span className="editor-stats-label">words</span>
    </span>
    <span className="editor-stats-sep" aria-hidden>·</span>
    <span className="editor-stats-cell" title="Characters in the note body">
      <span className="editor-stats-value">{formatStatNumber(stats.chars)}</span>
      <span className="editor-stats-label">chars</span>
    </span>
    <span className="editor-stats-sep" aria-hidden>·</span>
    <span className="editor-stats-cell" title="Estimated reading time at 220 wpm">
      <span className="editor-stats-value">{formatReadingTime(stats.readingMinutes)}</span>
    </span>
  </div>
);

import { type NoteStats, formatNoteStatsForCard } from "../editor/note-stats";

export interface NoteStatsCardProps {
  readonly stats: NoteStats;
}

interface StatRow {
  readonly label: string;
  readonly value: string;
}

const formatStatRows = (stats: NoteStats): readonly StatRow[] => {
  const formatted = formatNoteStatsForCard(stats);
  const rows: StatRow[] = [
    { label: "Words", value: formatted.words },
    { label: "Characters", value: formatted.chars },
    { label: "Reading time", value: formatted.readingTime },
    { label: "Headings", value: formatted.headings },
    { label: "Code blocks", value: formatted.codeBlocks },
    { label: "Wiki links", value: formatted.links },
    { label: "Attachments", value: formatted.attachments }
  ];
  if (formatted.createdLabel !== null) rows.push({ label: "Created", value: formatted.createdLabel });
  if (formatted.updatedLabel !== null) rows.push({ label: "Updated", value: formatted.updatedLabel });
  return rows;
};

/** Sidebar card with the same metrics the footer shows, plus timestamps. */
export const NoteStatsCard = ({ stats }: NoteStatsCardProps): React.JSX.Element => {
  const rows = formatStatRows(stats);
  return (
    <section className="info-stats-card" aria-label="Note statistics">
      <table className="info-stats-table">
        <caption className="info-stats-caption">Note</caption>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

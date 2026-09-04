import { Eye, FilePenLine, Folder, Info, type LucideIcon } from "lucide-react";

export type Destination = "files" | "editor" | "preview" | "info";

export interface MobileDestinationNavProps {
  readonly activeDestination: Destination;
  readonly onSelect: (destination: Destination) => void;
}

interface DestinationItem {
  readonly id: Destination;
  readonly label: "Files" | "Editor" | "Preview" | "Info";
  readonly icon: LucideIcon;
}

const DESTINATIONS: readonly DestinationItem[] = [
  { id: "files", label: "Files", icon: Folder },
  { id: "editor", label: "Editor", icon: FilePenLine },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "info", label: "Info", icon: Info }
];

export const MobileDestinationNav = ({
  activeDestination,
  onSelect
}: MobileDestinationNavProps): React.JSX.Element => (
  <nav className="mobile-destinations" aria-label="Mobile destinations">
    {DESTINATIONS.map(({ id, label, icon: Icon }) => (
      <button
        className="destination-button touch-target"
        type="button"
        aria-label={label}
        aria-pressed={activeDestination === id}
        onClick={() => onSelect(id)}
        key={id}
      >
        <Icon size={24} strokeWidth={1.75} aria-hidden />
        <span>{label}</span>
      </button>
    ))}
  </nav>
);

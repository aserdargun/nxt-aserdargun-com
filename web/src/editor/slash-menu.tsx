import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  computeSlashMenuAnchor,
  type SlashMenuController,
  type SlashMenuItem,
  type SlashMenuSnapshot
} from "./slash-menu-extension";

export interface SlashMenuProps {
  readonly controller: SlashMenuController;
}

const noAnchor = { left: 0, top: 0, bottom: 0 };

export const SlashMenu = ({ controller }: SlashMenuProps): React.JSX.Element | null => {
  const [snapshot, setSnapshot] = useState<SlashMenuSnapshot>(() => controller.getSnapshot());
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeItemRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      setSnapshot(controller.getSnapshot());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [controller]);

  useEffect(() => {
    setActiveIndex(0);
  }, [snapshot.filter, snapshot.open]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!snapshot.open) return null;
  const view = controller.getView();
  if (view === null) return null;
  const anchor = computeSlashMenuAnchor(view, snapshot) ?? noAnchor;
  const matches = controller.match(snapshot);
  if (matches.length === 0) return null;
  const active = matches[Math.min(activeIndex, matches.length - 1)] ?? matches[0];
  if (active === undefined) return null;

  const onMouseDown = (item: SlashMenuItem) => (): void => {
    controller.accept(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      controller.accept(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      controller.close();
    }
  };

  return (
    <div
      ref={containerRef}
      className="slash-menu"
      role="dialog"
      aria-label="Slash menu"
      style={{
        position: "fixed",
        left: `${anchor.left}px`,
        top: `${anchor.bottom + 4}px`,
        zIndex: 50
      }}
      onKeyDown={onKeyDown as unknown as React.KeyboardEventHandler<HTMLDivElement>}
      tabIndex={-1}
    >
      <ul role="listbox" aria-label="Insert block" aria-activedescendant={`slash-item-${active.id}`}>
        {matches.map((item, index) => (
          <li
            key={item.id}
            id={`slash-item-${item.id}`}
            role="option"
            aria-selected={index === activeIndex}
            ref={index === activeIndex ? activeItemRef : null}
            className={`slash-menu-item touch-target${index === activeIndex ? " active" : ""}`}
            onMouseDown={(event) => { event.preventDefault(); onMouseDown(item)(); }}
          >
            <span className="slash-menu-label">{item.label}</span>
            <span className="slash-menu-hint">{item.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

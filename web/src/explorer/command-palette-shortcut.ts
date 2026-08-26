import { useEffect } from "react";

const subscribers = new Set<() => void>();
let listening = false;

const listener = (event: KeyboardEvent): void => {
  if (event.key.toLocaleLowerCase("en-US") !== "k" || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
  event.preventDefault();
  for (const subscriber of subscribers) subscriber();
};

export const useCommandPaletteShortcut = (open: () => void): void => {
  useEffect(() => {
    subscribers.add(open);
    if (!listening) {
      window.addEventListener("keydown", listener);
      listening = true;
    }
    return () => {
      subscribers.delete(open);
      if (listening && subscribers.size === 0) {
        window.removeEventListener("keydown", listener);
        listening = false;
      }
    };
  }, [open]);
};

import { useLayoutEffect } from "react";

export const useNoIndex = (): void => {
  useLayoutEffect(() => {
    const existing = [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="robots"]')];
    const primary = existing[0] ?? document.createElement("meta");
    const created = existing.length === 0;
    const priorContent = primary.getAttribute("content");
    const removed = existing.slice(1).map((element) => ({
      element,
      parent: element.parentNode,
      next: element.nextSibling
    }));
    if (created) {
      primary.name = "robots";
      document.head.append(primary);
    }
    primary.content = "noindex,nofollow";
    for (const { element } of removed) element.remove();
    return () => {
      if (created) primary.remove();
      else if (priorContent === null) primary.removeAttribute("content");
      else primary.setAttribute("content", priorContent);
      for (const { element, parent, next } of removed) {
        if (parent !== null) parent.insertBefore(element, next?.parentNode === parent ? next : null);
      }
    };
  }, []);
};

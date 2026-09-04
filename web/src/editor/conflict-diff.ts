export type ConflictDiffKind = "unchanged" | "addition" | "removal";

export interface ConflictDiffLine {
  readonly kind: ConflictDiffKind;
  readonly text: string;
}

export interface ConflictDiffProjection {
  readonly local: readonly ConflictDiffLine[];
  readonly drive: readonly ConflictDiffLine[];
  readonly counts: {
    readonly additions: number;
    readonly removals: number;
  };
  readonly strategy: "bounded-lcs" | "whole-middle-fallback";
}

const DIFF_MATRIX_CELL_BUDGET = 10_000;

const splitSourceLines = (source: string): readonly string[] => source === "" ? [] : source.split(/\r\n?|\n/u);

const line = (text: string, kind: ConflictDiffKind): ConflictDiffLine => ({ text, kind });

const appendLines = (
  target: ConflictDiffLine[],
  source: readonly string[],
  kind: ConflictDiffKind
): void => {
  for (const text of source) target.push(line(text, kind));
};

export const projectConflictDiff = (
  localSource: string,
  driveSource: string
): ConflictDiffProjection => {
  const localLines = splitSourceLines(localSource);
  const driveLines = splitSourceLines(driveSource);
  let prefixLength = 0;
  while (
    prefixLength < localLines.length
    && prefixLength < driveLines.length
    && localLines[prefixLength] === driveLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < localLines.length - prefixLength
    && suffixLength < driveLines.length - prefixLength
    && localLines[localLines.length - suffixLength - 1] === driveLines[driveLines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const localMiddle = localLines.slice(prefixLength, localLines.length - suffixLength);
  const driveMiddle = driveLines.slice(prefixLength, driveLines.length - suffixLength);
  const localProjection: ConflictDiffLine[] = localLines
    .slice(0, prefixLength)
    .map((text) => line(text, "unchanged"));
  const driveProjection: ConflictDiffLine[] = driveLines
    .slice(0, prefixLength)
    .map((text) => line(text, "unchanged"));
  let strategy: ConflictDiffProjection["strategy"] = "bounded-lcs";

  if (localMiddle.length === 0) {
    appendLines(driveProjection, driveMiddle, "addition");
  } else if (driveMiddle.length === 0) {
    appendLines(localProjection, localMiddle, "removal");
  } else {
    const matrixCells = (localMiddle.length + 1) * (driveMiddle.length + 1);
    if (matrixCells > DIFF_MATRIX_CELL_BUDGET) {
      strategy = "whole-middle-fallback";
      appendLines(localProjection, localMiddle, "removal");
      appendLines(driveProjection, driveMiddle, "addition");
    } else {
      const lcs = Array.from(
        { length: localMiddle.length + 1 },
        () => new Uint16Array(driveMiddle.length + 1)
      );

      for (let localIndex = localMiddle.length - 1; localIndex >= 0; localIndex -= 1) {
        for (let driveIndex = driveMiddle.length - 1; driveIndex >= 0; driveIndex -= 1) {
          lcs[localIndex]![driveIndex] = localMiddle[localIndex] === driveMiddle[driveIndex]
            ? lcs[localIndex + 1]![driveIndex + 1]! + 1
            : Math.max(lcs[localIndex + 1]![driveIndex]!, lcs[localIndex]![driveIndex + 1]!);
        }
      }

      let localIndex = 0;
      let driveIndex = 0;
      while (localIndex < localMiddle.length && driveIndex < driveMiddle.length) {
        if (localMiddle[localIndex] === driveMiddle[driveIndex]) {
          localProjection.push(line(localMiddle[localIndex]!, "unchanged"));
          driveProjection.push(line(driveMiddle[driveIndex]!, "unchanged"));
          localIndex += 1;
          driveIndex += 1;
        } else if (lcs[localIndex + 1]![driveIndex]! >= lcs[localIndex]![driveIndex + 1]!) {
          localProjection.push(line(localMiddle[localIndex]!, "removal"));
          localIndex += 1;
        } else {
          driveProjection.push(line(driveMiddle[driveIndex]!, "addition"));
          driveIndex += 1;
        }
      }
      while (localIndex < localMiddle.length) {
        localProjection.push(line(localMiddle[localIndex]!, "removal"));
        localIndex += 1;
      }
      while (driveIndex < driveMiddle.length) {
        driveProjection.push(line(driveMiddle[driveIndex]!, "addition"));
        driveIndex += 1;
      }
    }
  }

  const suffix = localLines.slice(localLines.length - suffixLength);
  appendLines(localProjection, suffix, "unchanged");
  appendLines(driveProjection, suffix, "unchanged");

  return {
    local: localProjection,
    drive: driveProjection,
    counts: {
      additions: driveProjection.filter(({ kind }) => kind === "addition").length,
      removals: localProjection.filter(({ kind }) => kind === "removal").length
    },
    strategy
  };
};

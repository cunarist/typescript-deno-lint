/** A fixture the tests read type information out of. */

export async function fetchName(): Promise<string> {
  return await Promise.resolve("name");
}

/** A value whose declared type is wider than its initializer. */
export const count: number | undefined = 1;

/** Korean and emoji, so offsets are exercised outside the ASCII range. */
export const 이름 = "한글🎉";

export function use(): number {
  fetchName();
  const length = 이름.length;
  return Math.max(length, count ?? 0);
}

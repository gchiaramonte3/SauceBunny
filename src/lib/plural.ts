/** "1 person", "2 people": a count with the word that agrees with it. */
export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

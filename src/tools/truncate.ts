/**
 * Keep the beginning and end of a large text, dropping the middle.
 *
 * Error tails and success markers often live at the bottom of a shell or
 * subagent output; a pure head truncation silently loses them.
 *
 * By default splits ~70% head / 30% tail of the total budget.
 */
export function headAndTail(text: string, max: number, headRatio = 0.7): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * headRatio);
  const tailLen = max - headLen;
  const dropped = text.length - headLen - tailLen;
  return (
    text.slice(0, headLen) +
    `\n...[truncated ${dropped} chars]...\n` +
    text.slice(text.length - tailLen)
  );
}

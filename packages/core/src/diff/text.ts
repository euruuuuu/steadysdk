/** Markdown inline code, or `none` for a missing value. */
export function code(value: string | undefined): string {
  return value === undefined || value === '' ? 'none' : `\`${value}\``;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lower-cases a leading capital unless it starts an acronym (`API`) or identifier (`GET`). */
export function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

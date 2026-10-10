import pluralize from 'pluralize';

export interface PluralizerOptions {
  enabled: boolean;
  irregular: Record<string, string>;
  uncountable: readonly string[];
}

/** Singular/plural forms of a single lower-case word, with per-config rules layered over `pluralize`. */
export class Pluralizer {
  private readonly enabled: boolean;
  private readonly toPlural: Map<string, string>;
  private readonly toSingular: Map<string, string>;
  private readonly uncountable: Set<string>;

  constructor(options: PluralizerOptions) {
    this.enabled = options.enabled;
    const pairs = Object.entries(options.irregular).map(([one, many]) => [one.toLowerCase(), many.toLowerCase()] as const);
    this.toPlural = new Map(pairs);
    this.toSingular = new Map(pairs.map(([one, many]) => [many, one]));
    this.uncountable = new Set(options.uncountable.map((word) => word.toLowerCase()));
  }

  plural(word: string): string {
    if (!this.enabled || this.uncountable.has(word)) return word;
    if (this.toSingular.has(word)) return word;
    return this.toPlural.get(word) ?? pluralize.plural(word);
  }

  singular(word: string): string {
    if (!this.enabled || this.uncountable.has(word)) return word;
    if (this.toPlural.has(word)) return word;
    return this.toSingular.get(word) ?? pluralize.singular(word);
  }
}

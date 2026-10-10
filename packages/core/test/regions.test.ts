import { describe, expect, it } from 'vitest';
import { mergeRegions, parseRegions, regionsWithCode, stripRegions } from '../src/output/regions.js';

const generated = [
  'import { a } from "./a.js";',
  '// <sdkgen:custom imports>',
  '// </sdkgen:custom>',
  '',
  'export class Api {',
  '  method() {}',
  '',
  '  // <sdkgen:custom members>',
  '  // </sdkgen:custom>',
  '}',
  '',
].join('\n');

const edited = generated
  .replace('// <sdkgen:custom imports>\n', '// <sdkgen:custom imports>\nimport { b } from "./b.js";\n')
  .replace('  // <sdkgen:custom members>\n', '  // <sdkgen:custom members>\n  helper() {\n    return b;\n  }\n');

describe('custom regions', () => {
  it('parses region bodies by name', () => {
    const parsed = parseRegions(edited);
    expect(parsed).toEqual({
      ok: true,
      regions: new Map([
        ['imports', ['import { b } from "./b.js";']],
        ['members', ['  helper() {', '    return b;', '  }']],
      ]),
    });
    expect(regionsWithCode(new Map([['a', ['  ']], ['b', ['x']]]))).toEqual(['b']);
  });

  it('strips bodies back to what the generator wrote', () => {
    expect(stripRegions(edited)).toBe(generated);
    expect(stripRegions(generated)).toBe(generated);
  });

  it('carries bodies into fresh output, and reports regions with nowhere to go', () => {
    const fresh = generated.replace('  method() {}', '  method() {}\n  other() {}');
    const parsed = parseRegions(edited);
    if (!parsed.ok) throw new Error(parsed.error);
    const merged = mergeRegions(fresh, parsed.regions);
    expect(merged.orphaned).toEqual([]);
    expect(merged.content).toContain('  other() {}');
    expect(merged.content).toContain('  helper() {\n    return b;\n  }\n  // </sdkgen:custom>');
    expect(stripRegions(merged.content)).toBe(fresh);

    const withoutMembers = fresh.replace('  // <sdkgen:custom members>\n  // </sdkgen:custom>\n', '');
    expect(mergeRegions(withoutMembers, parsed.regions).orphaned).toEqual(['members']);
    // Empty regions can disappear without losing anything.
    expect(mergeRegions(withoutMembers, new Map([['members', ['']]])).orphaned).toEqual([]);
  });

  it.each([
    ['// <sdkgen:custom a>\n// <sdkgen:custom b>\n// </sdkgen:custom>\n// </sdkgen:custom>', 'region "a" (line 1) is not closed before line 2'],
    ['// <sdkgen:custom a>\nx', 'region "a" (line 1) is never closed'],
    ['x\n// </sdkgen:custom>', 'line 2 closes a region that was never opened'],
    ['// <sdkgen:custom a>\n// </sdkgen:custom>\n// <sdkgen:custom a>\n// </sdkgen:custom>', 'region "a" appears twice'],
  ])('rejects broken markers %#', (content, error) => {
    expect(parseRegions(content)).toEqual({ ok: false, error });
  });
});

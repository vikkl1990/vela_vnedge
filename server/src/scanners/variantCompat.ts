import {createHash} from 'node:crypto';

/** Compatibility work must not rewrite the source that an existing scanner earned evidence on. */
export function variantCompatibleSource(id: string, source: string): {source: string; patch?: string} {
  if(id!=='breaker-blocks-with-signals-author-retests')return {source};
  if(createHash('sha256').update(source).digest('hex')!=='13cfc9afd6666b2183afc89ea94ed78f6b82745f2764db876c15d42b4e86a6d8')
    throw new Error('Breaker Blocks source changed: review its drawing compatibility adapter');
  // Pine's namespace calls are equivalent to its drawing methods. PineTS cannot dispatch methods
  // on these nullable UDT fields reliably: delete throws and getters silently return na. Geometry
  // drives this script's retests, so suppressing the exception alone would silently lose signals.
  const patched=source
    .replaceAll('aZZ.l.pop().delete()','line.delete(aZZ.l.pop())')
    .replaceAll('aB.pop().delete()','box.delete(aB.pop())')
    .replaceAll('BB.aLabels.pop().delete()','label.delete(BB.aLabels.pop())')
    .replaceAll('BB.PDa_boxA.delete()','box.delete(BB.PDa_boxA)')
    .replaceAll('BB.PDa_boxB.delete()','box.delete(BB.PDa_boxB)')
    .replace(/BB\.(\w+)\.(set_\w+|get_\w+)\s*\(\s*(\))?/g,(_m,field,method,end)=>{
      const namespace=/box/i.test(field)?'box':/line/i.test(field)?'line':'label';
      return `${namespace}.${method}(BB.${field}${end?')':', '}`;
    });
  return {source:patched,patch:'breaker-drawing-methods-v1'};
}

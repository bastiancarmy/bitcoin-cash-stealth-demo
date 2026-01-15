export function getPath(obj: Record<string, any>, path: string): any {
  const parts = path.split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

export function setPath(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) throw new Error('setPath: empty key');
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

export function deletePath(obj: Record<string, any>, path: string): void {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return;
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[p];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}
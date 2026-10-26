// Small text helpers shared by the rule-based stand-ins.

export const words = (s: string) =>
  s
    .replace(/#/g, ' number ')
    .replace(/\bno\.?(?=\s|$)/gi, ' number ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

export const camel = (s: string) => {
  const w = words(s).map((x) => x.toLowerCase());
  const out = w.map((x, i) => (i ? x[0]!.toUpperCase() + x.slice(1) : x)).join('');
  return /^[a-z]/.test(out) ? out : `x${out}`;
};

export const snake = (s: string) => words(s).map((x) => x.toLowerCase()).join('_');

// "Customer #:" -> "Customer #"
export const caption = (s: string | undefined) => (s ?? '').replace(/[:*]+$/, '').replace(/^[«»<>\s]+|[«»<>\s]+$/g, '').trim();

/** Utilità per durate espresse in secondi. */
export const toSeconds = (hhmmss: string | null | undefined): number => {
  if (!hhmmss) return 0;
  const [h = '0', m = '0', s = '0'] = hhmmss.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

export const formatDuration = (seconds: number | null | undefined): string => {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const diffSeconds = (from: Date | null | undefined, to: Date | null | undefined): number => {
  if (!from || !to) return 0;
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
};

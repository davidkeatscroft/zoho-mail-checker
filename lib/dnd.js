// Do-not-disturb periods offered on the toolbar button's right-click menu.
export const DND_CHOICES = [
  { id: '30m', title: '30 minutes', minutes: 30 },
  { id: '1h', title: '1 hour', minutes: 60 },
  { id: '2h', title: '2 hours', minutes: 120 },
  { id: '4h', title: '4 hours', minutes: 240 },
  { id: 'today', title: 'Today' },
  { id: 'forever', title: 'Indefinitely' },
];

export const DND_ALARM = 'dnd-end';

// When a period chosen now should end, or null if it has no end. "Today" runs to local midnight.
export function dndEnd(choiceId, now = new Date()) {
  if (choiceId === 'forever') return null;
  if (choiceId === 'today') {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
  }
  const choice = DND_CHOICES.find((c) => c.id === choiceId);
  if (!choice) throw new Error(`Unknown do-not-disturb period: ${choiceId}`);
  return now.getTime() + choice.minutes * 60000;
}

export function isDndOn(dnd, now = Date.now()) {
  return Boolean(dnd) && (dnd.until === null || dnd.until > now);
}

export function dndStatus(dnd) {
  if (dnd.until === null) return 'on';
  if (dnd.choice === 'today') return 'on for the rest of today';
  return `on until ${new Date(dnd.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

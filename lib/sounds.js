// Notification sounds. The built-in ones are synthesised here rather than shipped as
// recordings, so there are no third-party audio licences to track.
export const SOUNDS = [
  { id: 'chime', label: 'Chime' },
  { id: 'bell', label: 'Bell' },
  { id: 'ring', label: 'Phone ring' },
  { id: 'marimba', label: 'Marimba' },
  { id: 'custom', label: 'My own sound file' },
];

function tone(context, { frequency, start, duration, peak = 0.18, type = 'sine', attack = 0.01 }) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const at = context.currentTime + start;
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
  return start + duration;
}

const SYNTHS = {
  chime: (c) => Math.max(
    tone(c, { frequency: 660, start: 0, duration: 0.35, attack: 0.02 }),
    tone(c, { frequency: 880, start: 0.14, duration: 0.35, attack: 0.02 }),
  ),
  // A struck bell: a fundamental plus the inharmonic partials that make it sound like metal.
  bell: (c) => Math.max(...[[1, 0.16, 1.6], [2, 0.08, 1.2], [2.76, 0.06, 0.9], [5.4, 0.03, 0.5]]
    .map(([ratio, peak, duration]) => tone(c, { frequency: 784 * ratio, start: 0, duration, peak, attack: 0.004 }))),
  // Two bursts of a fast warble, like an old desk telephone.
  ring: (c) => {
    let end = 0;
    for (const burst of [0, 0.5]) {
      for (let i = 0; i < 8; i += 1) {
        end = tone(c, { frequency: i % 2 ? 1180 : 940, start: burst + i * 0.045, duration: 0.05, peak: 0.08, type: 'triangle', attack: 0.005 });
      }
    }
    return end;
  },
  marimba: (c) => Math.max(...[523.25, 659.25, 783.99].flatMap((frequency, i) => [
    tone(c, { frequency, start: i * 0.11, duration: 0.45, peak: 0.2, attack: 0.004 }),
    tone(c, { frequency: frequency * 4, start: i * 0.11, duration: 0.08, peak: 0.04, attack: 0.002 }),
  ])),
};

// Plays a sound by ID. 'custom' plays the stored file, falling back to the chime if there is none.
export async function playSound(id, customSound) {
  if (id === 'custom' && customSound?.dataUrl) {
    const audio = new Audio(customSound.dataUrl);
    await audio.play();
    return;
  }
  const context = new AudioContext();
  const end = (SYNTHS[id] || SYNTHS.chime)(context);
  setTimeout(() => context.close(), (end + 0.3) * 1000);
}

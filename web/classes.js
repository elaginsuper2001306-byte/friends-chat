// Единый список игровых классов: ключ (латиницей), название и цвет ника.
// Используется и сервером (валидация), и интерфейсом (цвета).
export const CLASSES = [
  { key: 'warrior', name: 'Воин', color: '#ef5350' },
  { key: 'mage', name: 'Маг', color: '#5b8cff' },
  { key: 'sorcerer', name: 'Чародей', color: '#5ac8f5' },
  { key: 'archer', name: 'Лучник', color: '#8bd17c' },
  { key: 'priest', name: 'Жрец', color: '#a6c0d6' },
  { key: 'occultist', name: 'Оккультист', color: '#f27ac8' },
  { key: 'werewolf', name: 'Оборотень', color: '#f2c94c' },
  { key: 'druid', name: 'Друид', color: '#f2994a' },
  { key: 'assassin', name: 'Убийца', color: '#b98cf0' },
  { key: 'reaper', name: 'Жнец', color: '#dfe4ec' },
  { key: 'guardian', name: 'Страж', color: '#c0506a' },
  { key: 'shooter', name: 'Стрелок', color: '#dd8197' },
  { key: 'astrologer', name: 'Астролог', color: '#d3a6ff' },
];

export const CLASS_BY_KEY = new Map(CLASSES.map((item) => [item.key, item]));
export const CLASS_KEYS = new Set(CLASSES.map((item) => item.key));

export function classColor(key) {
  return CLASS_BY_KEY.get(key)?.color ?? null;
}

export function className(key) {
  return CLASS_BY_KEY.get(key)?.name ?? '';
}

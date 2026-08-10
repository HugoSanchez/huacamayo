export function displayToolkitName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase().replace(/_/g, ' ');

  switch (normalized) {
    case 'google calendar':
    case 'googlecalendar':
      return 'Calendar';
    case 'granola mcp':
      return 'Granola';
    default:
      return trimmed || name;
  }
}
